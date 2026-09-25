-- Per-user daily cap on the user-facing Gemini features (ai-coach, analyze-journal),
-- so one user can't drain the shared free-tier quota (20 req/day, 5/min per project).
-- Days are UTC. Only the edge functions (service role) touch this; no API access.

create table if not exists public.ai_daily_usage (
  user_id uuid not null references auth.users(id) on delete cascade,
  day     date not null default (now() at time zone 'utc')::date,
  kind    text not null check (kind in ('coach', 'snap')),
  count   int  not null default 0 check (count >= 0),
  primary key (user_id, day, kind)
);
alter table public.ai_daily_usage enable row level security;
-- No policies: anon/authenticated can't read or write it.
revoke all on public.ai_daily_usage from anon, authenticated;

-- Atomically take one call from today's allowance. true = allowed, false = limit reached.
create or replace function public.ai_quota_take(p_user_id uuid, p_kind text, p_limit int)
returns boolean
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_count int;
begin
  insert into public.ai_daily_usage as u (user_id, day, kind, count)
  values (p_user_id, (now() at time zone 'utc')::date, p_kind, 1)
  on conflict (user_id, day, kind)
    do update set count = u.count + 1
    where u.count < p_limit
  returning u.count into v_count;
  return v_count is not null;
end;
$$;

-- Give a call back when the model failed, so errors don't eat the user's allowance.
create or replace function public.ai_quota_refund(p_user_id uuid, p_kind text)
returns void
language sql
security definer
set search_path = ''
as $$
  update public.ai_daily_usage
     set count = greatest(count - 1, 0)
   where user_id = p_user_id and day = (now() at time zone 'utc')::date and kind = p_kind;
$$;

revoke execute on function public.ai_quota_take(uuid, text, int) from public, anon, authenticated;
revoke execute on function public.ai_quota_refund(uuid, text) from public, anon, authenticated;
grant execute on function public.ai_quota_take(uuid, text, int) to service_role;
grant execute on function public.ai_quota_refund(uuid, text) to service_role;
