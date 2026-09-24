-- Public leaderboard: only exposes username + aggregate counts, never raw rows/emails.
-- SECURITY DEFINER is required because daily_logs RLS restricts reads to auth.uid() = user_id;
-- this function bypasses that at the DB level but only returns safe, aggregated columns.
create or replace function public.get_leaderboard()
returns table(
  username text,
  current_day int,
  perfect_days bigint,
  avg_score numeric
)
language sql
security definer
set search_path = public
stable
as $$
  select
    p.username,
    max(d.day_number)::int as current_day,
    count(*) filter (where d.status = 'PERFECT') as perfect_days,
    round(avg(d.score))::numeric as avg_score
  from profiles p
  join daily_logs d on d.user_id = p.id
  where p.username is not null
  group by p.username
  order by perfect_days desc, current_day desc
  limit 50;
$$;

revoke all on function public.get_leaderboard() from public;
grant execute on function public.get_leaderboard() to anon, authenticated;
