-- SetKeeper: one row per signed-in collector holding their synced data.
-- Run once in Supabase: Dashboard → SQL Editor → New query → paste → Run.

create table if not exists public.collections (
  user_id    uuid primary key references auth.users (id) on delete cascade,
  data       jsonb not null default '{"v":1,"keys":{}}'::jsonb,
  updated_at timestamptz not null default now()
);

-- Row-level security: every request is checked against the signed-in user.
-- Nobody, including other signed-in users, can read or change someone else's row.
alter table public.collections enable row level security;

drop policy if exists "read own"   on public.collections;
drop policy if exists "insert own" on public.collections;
drop policy if exists "update own" on public.collections;
drop policy if exists "delete own" on public.collections;
create policy "read own"   on public.collections for select using (auth.uid() = user_id);
create policy "insert own" on public.collections for insert with check (auth.uid() = user_id);
create policy "update own" on public.collections for update using (auth.uid() = user_id) with check (auth.uid() = user_id);
create policy "delete own" on public.collections for delete using (auth.uid() = user_id);

-- Keep a single collection under 5 MB so one account can't fill the free database.
alter table public.collections drop constraint if exists collections_size;
alter table public.collections add constraint collections_size check (pg_column_size(data) < 5000000);

-- Called by the daily GitHub Action so the free project never pauses for inactivity.
-- It reveals nothing: it only returns the current time.
create or replace function public.keepalive() returns timestamptz
language sql stable security invoker as $$ select now() $$;
grant execute on function public.keepalive() to anon;

-- Lets a signed-in collector delete their own account from the app (Data → Delete my account).
-- Deleting the auth user also deletes their collections row (on delete cascade).
create or replace function public.delete_my_account() returns void
language plpgsql security definer set search_path = public, auth as $$
begin
  if auth.uid() is null then raise exception 'not signed in'; end if;
  delete from auth.users where id = auth.uid();
end $$;
revoke execute on function public.delete_my_account() from public, anon;
grant execute on function public.delete_my_account() to authenticated;

-- ---------------------------------------------------------------------------
-- Price history (the scout's daily snapshots). Private: row-level security is on
-- and there are no policies, so only the service role used by the GitHub Action can
-- read or write the table. (Older days' full copies live here; new runs save changes only,
-- see listing_changes below. After the first changes-only run you can free the space with:
--   delete from public.price_snapshots;)
-- Signed-in collectors get just the newest snapshot per set
-- through latest_listings(); the history itself is never exposed, and requiring sign-in
-- stops anonymous scripts from rebuilding the history by polling every day.
create table if not exists public.price_snapshots (
  id          bigserial primary key,
  set_id      text not null,
  fetched_at  timestamptz not null default now(),
  snapshot    jsonb not null
);
create index if not exists price_snapshots_set_time on public.price_snapshots (set_id, fetched_at desc);
alter table public.price_snapshots enable row level security;
revoke all on public.price_snapshots from anon, authenticated;

-- Today's listings: one snapshot per set, replaced by each scout run (what the app reads).
create table if not exists public.latest_snapshots (
  set_id     text primary key,
  fetched_at timestamptz not null,
  snapshot   jsonb not null
);
alter table public.latest_snapshots enable row level security;
revoke all on public.latest_snapshots from anon, authenticated;

-- Shop price history, stored as changes only: a row when a card's price or stock changes at a
-- shop (per printing and condition), not a full copy every day. listing_state holds the last
-- known state so each run can tell what changed; listing_changes is the history.
create table if not exists public.listing_state (
  seller    text not null,
  card_id   text not null,
  printing  text not null default '',
  condition text not null default '',
  set_id    text not null,
  price     numeric,
  in_stock  boolean not null,
  qty       int,              -- copies the shop shows (when it says)
  seen      date not null,
  primary key (seller, card_id, printing, condition)
);
alter table public.listing_state add column if not exists qty int;
create table if not exists public.listing_changes (
  id        bigserial primary key,
  day       date not null,
  seller    text not null,
  set_id    text not null,
  card_id   text not null,
  printing  text not null default '',
  condition text not null default '',
  price     numeric,          -- null when the listing disappeared from the shop
  in_stock  boolean not null,
  qty       int               -- copies in stock; a drop between rows means copies sold
);
alter table public.listing_changes add column if not exists qty int;
create index if not exists listing_changes_card on public.listing_changes (card_id, day);
create index if not exists listing_changes_set_day on public.listing_changes (set_id, day);
alter table public.listing_state enable row level security;
alter table public.listing_changes enable row level security;
revoke all on public.listing_state, public.listing_changes from anon, authenticated;

-- Called by the scout (service role) with one shop's listings, in chunks. A row is recorded
-- when price, stock or quantity changes. Returns how many changed.
create or replace function public.record_listings(p_seller text, p_day date, p_rows jsonb) returns int
language plpgsql security definer set search_path = public as $$
declare n int;
begin
  -- one row per card / printing / condition: cheapest price in stock, total copies
  create temp table _in on commit drop as
    select set_id, card_id, printing, condition, bool_or(in_stock) as in_stock,
      coalesce(min(price) filter (where in_stock), min(price)) as price,
      case when bool_or(in_stock) then sum(qty) filter (where in_stock) else 0 end as qty
    from (select set_id, card_id, coalesce(printing, '') as printing, coalesce(condition, '') as condition, price, in_stock, qty
          from jsonb_to_recordset(p_rows) as x(set_id text, card_id text, printing text, condition text, price numeric, in_stock boolean, qty int)) r
    group by set_id, card_id, printing, condition;
  insert into listing_changes (day, seller, set_id, card_id, printing, condition, price, in_stock, qty)
    select p_day, p_seller, i.set_id, i.card_id, i.printing, i.condition, i.price, i.in_stock, i.qty from _in i
    left join listing_state s on s.seller = p_seller and s.card_id = i.card_id and s.printing = i.printing and s.condition = i.condition
    where s.card_id is null or s.price is distinct from i.price or s.in_stock is distinct from i.in_stock or s.qty is distinct from i.qty;
  get diagnostics n = row_count;
  -- a sold-out product (no condition known) also sells out every condition of that card and printing
  with gone as (
    update listing_state s set in_stock = false, qty = 0, seen = p_day
    from _in i
    where i.in_stock = false and i.condition = '' and s.seller = p_seller and s.card_id = i.card_id and s.printing = i.printing
      and s.condition <> '' and s.in_stock
      -- only copies from an earlier run: another product for the same card in stock today stays in stock
      and s.seen < p_day
      and not exists (select 1 from _in j where j.card_id = i.card_id and j.printing = i.printing and j.condition = s.condition and j.in_stock)
    returning s.set_id, s.card_id, s.printing, s.condition, s.price
  )
  insert into listing_changes (day, seller, set_id, card_id, printing, condition, price, in_stock, qty)
    select p_day, p_seller, set_id, card_id, printing, condition, price, false, 0 from gone;
  insert into listing_state (seller, card_id, printing, condition, set_id, price, in_stock, qty, seen)
    select p_seller, card_id, printing, condition, set_id, price, in_stock, qty, p_day from _in
    on conflict (seller, card_id, printing, condition) do update
      set price = excluded.price, in_stock = excluded.in_stock, qty = excluded.qty, set_id = excluded.set_id, seen = excluded.seen;
  return n;
end $$;

-- After a shop was read completely: listings it no longer shows are recorded once as gone.
create or replace function public.close_listings(p_seller text, p_day date) returns int
language plpgsql security definer set search_path = public as $$
declare n int;
begin
  insert into listing_changes (day, seller, set_id, card_id, printing, condition, price, in_stock)
    select p_day, seller, set_id, card_id, printing, condition, null, false from listing_state
    where seller = p_seller and seen < p_day and (in_stock or price is not null);
  get diagnostics n = row_count;
  update listing_state set in_stock = false, price = null, qty = 0 where seller = p_seller and seen < p_day and (in_stock or price is not null);
  return n;
end $$;
revoke execute on function public.record_listings(text, date, jsonb) from public, anon, authenticated;
revoke execute on function public.close_listings(text, date) from public, anon, authenticated;

-- Copies sold, estimated from drops in a shop's stock between one change and the next
-- (a restock shows as a rise and isn't counted). Run in the SQL editor, e.g.
--   select card_id, sum(sold) from public.card_sales where day > current_date - 30 group by 1 order by 2 desc limit 20;
create or replace view public.card_sales as
  select day, seller, set_id, card_id, printing, condition, price,
    greatest(coalesce(lag(qty) over w, 0) - coalesce(qty, 0), 0) as sold
  from public.listing_changes
  window w as (partition by seller, card_id, printing, condition order by day, id);
revoke all on public.card_sales from anon, authenticated;


-- Raw daily archive: each scout run's full data, gzipped, in a private storage bucket
-- (Supabase file storage, separate from the database's 500 MB). Proof of what was collected.
do $$ begin
  if exists (select 1 from information_schema.tables where table_schema = 'storage' and table_name = 'buckets') then
    insert into storage.buckets (id, name, public) values ('scout-archive', 'scout-archive', false) on conflict (id) do nothing;
  end if;
end $$;

create or replace function public.latest_listings(p_set text) returns jsonb
language sql stable security definer set search_path = public as $$
  select coalesce(
    (select snapshot from public.latest_snapshots where set_id = p_set),
    (select snapshot from public.price_snapshots where set_id = p_set order by fetched_at desc limit 1))
$$;
revoke execute on function public.latest_listings(text) from public;
grant execute on function public.latest_listings(text) to authenticated;

-- ---------------------------------------------------------------------------
-- Daily card prices: SetKeeper's own price history, written by the daily scout
-- (scripts/price-history.ts). One row per card, per printing (normal, holofoil,
-- reverse-holofoil, 1st-edition…), per day, with every figure the source gives:
--   TCGplayer (USD): low = cheapest listing in any condition, mid, market = recent sales, high
--   Cardmarket (EUR): low, trend, 30-day average
-- Private like price_snapshots: only the service role reads or writes the table;
-- signed-in collectors get one card's history or a list's daily total through the
-- functions below.
-- an early draft of this table (one price per card per day) is replaced; it held no history yet
do $$ begin
  if exists (select 1 from information_schema.columns where table_schema = 'public' and table_name = 'card_prices' and column_name in ('usd', 'tcgplayer_usd'))
  then drop table public.card_prices; end if;
end $$;
drop function if exists public.price_history(text, int);
drop function if exists public.cards_total_by_day(text[], int);
drop function if exists public.cards_cost_history(text[], int);
create table if not exists public.card_prices (
  card_id    text not null,   -- TCGdex card id, e.g. sv03.5-199
  printing   text not null,   -- TCGdex/TCGplayer printing name
  set_id     text not null,
  day        date not null,
  is_default boolean not null default false,  -- the printing the card is usually priced as
  tcg_low numeric, tcg_mid numeric, tcg_market numeric, tcg_high numeric,
  cm_low numeric, cm_trend numeric, cm_avg30 numeric,
  primary key (card_id, printing, day)
);
create index if not exists card_prices_set_day on public.card_prices (set_id, day);
alter table public.card_prices enable row level security;
revoke all on public.card_prices from anon, authenticated;

-- One card's daily prices, every printing, up to a year back.
create or replace function public.price_history(p_card text, p_days int default 90)
returns table (day date, printing text, is_default boolean, tcg_low numeric, tcg_market numeric, cm_trend numeric, cm_avg30 numeric)
language sql stable security definer set search_path = public as $$
  select day, printing, is_default, tcg_low, coalesce(tcg_market, tcg_mid), cm_trend, cm_avg30 from public.card_prices
  where card_id = p_card and day >= current_date - least(greatest(p_days, 1), 365)
  order by day, printing
$$;

-- Daily total fair Near Mint value (CAD) of a list of cards (e.g. a collector's missing
-- cards → "cost to finish" trend), in each card's usual printing. Fair value is the same
-- rule as src/lib/prices.ts: the mean of TCGplayer market (USD→CAD) and Cardmarket's
-- trend / 30-day average (EUR→CAD), whichever exist. Rates come from the caller.
create or replace function public.cards_total_by_day(p_cards text[], p_days int default 90, p_usdcad numeric default 1.38, p_eurcad numeric default 1.6)
returns table (day date, total_cad numeric, priced int)
language sql stable security definer set search_path = public as $$
  with v as (
    select day,
      coalesce(tcg_market, tcg_mid) * p_usdcad as t,
      coalesce((cm_trend + cm_avg30) / 2, cm_trend, cm_avg30) * p_eurcad as c
    from public.card_prices
    where is_default and card_id = any(p_cards[1:400]) and day >= current_date - least(greatest(p_days, 1), 365)
  )
  select day, round(sum(case when t is not null and c is not null then (t + c) / 2 else coalesce(t, c) end), 2),
    count(coalesce(t, c))::int
  from v group by day order by day
$$;
revoke execute on function public.price_history(text, int) from public;
revoke execute on function public.cards_total_by_day(text[], int, numeric, numeric) from public;
grant execute on function public.price_history(text, int) to authenticated;
grant execute on function public.cards_total_by_day(text[], int, numeric, numeric) to authenticated;

-- ---------------------------------------------------------------------------
-- The dataset at a glance: run  select * from public.dataset_stats;  in the SQL editor.
create or replace view public.dataset_stats as
  select
    (select count(distinct seller) from public.listing_state) as shops,
    (select count(distinct card_id) from public.listing_state) as cards_listed,
    (select count(distinct set_id) from public.listing_state) as sets_listed,
    (select count(*) from public.listing_state where in_stock) as listings_in_stock_now,
    (select coalesce(sum(qty), 0) from public.listing_state where in_stock) as copies_in_stock_now,
    (select min(day) from public.listing_changes) as shop_history_from,
    (select count(distinct day) from public.listing_changes) as shop_history_days,
    (select count(*) from public.listing_changes) as shop_history_rows,
    (select coalesce(sum(sold), 0) from public.card_sales where day > current_date - 30) as copies_sold_last_30_days,
    (select count(distinct card_id) from public.card_prices) as cards_with_market_prices,
    (select min(day) from public.card_prices) as market_history_from,
    (select count(*) from public.card_prices) as market_history_rows,
    pg_size_pretty(pg_database_size(current_database())) as database_size;
revoke all on public.dataset_stats from anon, authenticated;
