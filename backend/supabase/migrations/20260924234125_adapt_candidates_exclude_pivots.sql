-- A pivot-protected day is NOT a missed day. Spending a pivot is the product's own
-- "adapt, don't reset" move, so it must not trigger an adapt-agent suggestion.
-- A day now counts as missed only if there's no log, or the log is MISS without a pivot.

create or replace function public.adapt_agent_candidates()
returns table (user_id uuid)
language sql
stable
security definer
set search_path = public
as $$
  with days as (
    select (current_date - n)::date as d from generate_series(1, 3) as n
  ),
  active as (
    select distinct l.user_id from public.daily_logs l
    where l.log_date >= current_date - 14
  )
  select a.user_id
  from active a
  where (
    select count(*) from days
    where not exists (
      select 1 from public.daily_logs l
      where l.user_id = a.user_id and l.log_date = days.d
        and (l.status <> 'MISS' or l.is_pivot)
    )
  ) >= 2
  and not exists (
    select 1 from public.rule_adaptations r
    where r.user_id = a.user_id and r.created_at > now() - interval '7 days'
  );
$$;

-- create or replace keeps existing grants; restated so this file stands on its own.
revoke execute on function public.adapt_agent_candidates() from anon, authenticated, public;
grant execute on function public.adapt_agent_candidates() to service_role;
