-- Project-wide daily cap on Gemini calls from ai-coach + analyze-journal combined, so
-- the shared free-tier key (20 req/day) never runs out for everyone. The day is
-- America/Los_Angeles, matching when Gemini's daily quota resets (midnight Pacific).
-- Only the edge functions (service role) touch this; no API access.

create table if not exists public.ai_global_usage (
  day   date primary key,
  count int not null default 0 check (count >= 0)
);
alter table public.ai_global_usage enable row level security;
-- No policies: anon/authenticated can't read or write it.
revoke all on public.ai_global_usage from anon, authenticated;
grant select, insert, update on public.ai_global_usage to service_role;

-- Atomically take one call from today's (Pacific) budget. Returns the day it was
-- counted against, or null when the budget is spent. Pass that day to the refund.
create or replace function public.ai_global_take(p_limit int)
returns date
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_day date := (now() at time zone 'America/Los_Angeles')::date;
  v_count int;
begin
  if p_limit is null or p_limit < 1 then
    return null;
  end if;
  insert into public.ai_global_usage as g (day, count)
  values (v_day, 1)
  on conflict (day)
    do update set count = g.count + 1
    where g.count < p_limit
  returning g.count into v_count;
  return case when v_count is null then null else v_day end;
end;
$$;

-- Give a call back when the model failed (or the per-user cap refused it afterwards).
create or replace function public.ai_global_refund(p_day date)
returns void
language sql
security definer
set search_path = ''
as $$
  update public.ai_global_usage set count = greatest(count - 1, 0) where day = p_day;
$$;

revoke execute on function public.ai_global_take(int) from public, anon, authenticated;
revoke execute on function public.ai_global_refund(date) from public, anon, authenticated;
grant execute on function public.ai_global_take(int) to service_role;
grant execute on function public.ai_global_refund(date) to service_role;
