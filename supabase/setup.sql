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
-- read or write the table. Signed-in collectors get just the newest snapshot per set
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

create or replace function public.latest_listings(p_set text) returns jsonb
language sql stable security definer set search_path = public as $$
  select snapshot from public.price_snapshots where set_id = p_set order by fetched_at desc limit 1
$$;
revoke execute on function public.latest_listings(text) from public;
grant execute on function public.latest_listings(text) to authenticated;
