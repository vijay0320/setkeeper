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
