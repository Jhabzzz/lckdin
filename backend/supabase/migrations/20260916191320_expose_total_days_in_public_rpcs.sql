drop function if exists public.get_leaderboard();
drop function if exists public.get_public_profile(text);

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
  order by perfect_days desc, current_day desc
  limit 50;
$$;

create function public.get_public_profile(p_username text)
returns table(id uuid, username text, total_days int)
language sql
stable
security definer
set search_path = public
as $$
  select p.id, p.username, p.total_days
  from public.profiles p
  where p.username = p_username
  limit 1;
$$;

grant execute on function public.get_leaderboard() to anon, authenticated;
grant execute on function public.get_public_profile(text) to anon, authenticated;
