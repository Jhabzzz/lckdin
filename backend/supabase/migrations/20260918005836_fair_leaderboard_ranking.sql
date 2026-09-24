-- Previously ordered by perfect_days desc, current_day desc — both raw counts that
-- unfairly favor whoever picked a longer protocol (more days logged = more chances
-- at both). Now that total_days is per-user (7/30/75/120/custom), rank by avg_score
-- first since it's already a 0-100 rate, fair regardless of protocol length someone
-- chose. perfect_days/current_day stay as tiebreakers.
drop function if exists public.get_leaderboard();

create function public.get_leaderboard()
returns table(username text, current_day integer, perfect_days bigint, avg_score numeric, total_days integer)
language sql
stable security definer
set search_path to 'public'
as $$
  select
    p.username,
    max(d.day_number)::int as current_day,
    count(*) filter (where d.status = 'PERFECT') as perfect_days,
    round(avg(d.score))::numeric as avg_score,
    p.total_days
  from profiles p
  join daily_logs d on d.user_id = p.id
  where p.username is not null
  group by p.username, p.total_days
  order by avg_score desc, perfect_days desc, current_day desc
  limit 50;
$$;

grant execute on function public.get_leaderboard() to anon, authenticated;
