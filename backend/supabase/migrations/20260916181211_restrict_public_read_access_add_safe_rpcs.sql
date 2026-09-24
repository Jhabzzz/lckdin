-- Previously "Public profiles/logs are viewable by everyone" (qual: true) let ANY
-- anon/authenticated caller select every column of every row directly from the
-- REST API — including profiles.rules (personal habit list) and daily_logs.rules
-- (per-day habit text + completion), not just the aggregated leaderboard/public-grid
-- stats the app is meant to expose. Restrict both to owner-only reads, and add
-- narrow SECURITY DEFINER RPCs for the two legitimate public use cases (username
-- availability check, public /u/:username grid page) that expose only the specific
-- fields those pages actually render.

drop policy if exists "Public profiles are viewable by everyone" on public.profiles;
create policy "Users can view their own profile"
  on public.profiles for select
  using ((select auth.uid()) = id);

drop policy if exists "Public logs are viewable by everyone" on public.daily_logs;
create policy "Users can view their own logs"
  on public.daily_logs for select
  using ((select auth.uid()) = user_id);

create or replace function public.check_username_available(p_username text)
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select not exists (
    select 1 from public.profiles where username ilike p_username
  );
$$;

create or replace function public.get_public_profile(p_username text)
returns table(id uuid, username text)
language sql
stable
security definer
set search_path = public
as $$
  select p.id, p.username
  from public.profiles p
  where p.username = p_username
  limit 1;
$$;

create or replace function public.get_public_grid_logs(p_user_id uuid)
returns table(day_number int, score int, is_pivot boolean, done_count int, rule_count int)
language sql
stable
security definer
set search_path = public
as $$
  select
    d.day_number,
    d.score,
    d.is_pivot,
    (select count(*)::int from jsonb_array_elements(d.rules) r where (r->>'done')::boolean) as done_count,
    jsonb_array_length(d.rules) as rule_count
  from public.daily_logs d
  where d.user_id = p_user_id
  order by d.day_number asc;
$$;

grant execute on function public.check_username_available(text) to anon, authenticated;
grant execute on function public.get_public_profile(text) to anon, authenticated;
grant execute on function public.get_public_grid_logs(uuid) to anon, authenticated;
