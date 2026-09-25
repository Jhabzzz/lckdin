-- One AI coach briefing per user per day. ai-coach (service role) writes it; the
-- dashboard reads today's row directly and only calls ai-coach when there is none, or
-- when the user presses Refresh. `day` is the user's local date, sent by the dashboard.

create table if not exists public.ai_coach_briefings (
  user_id    uuid not null references auth.users(id) on delete cascade,
  day        date not null,
  briefing   jsonb not null check (jsonb_typeof(briefing) = 'object' and pg_column_size(briefing) <= 16000),
  created_at timestamptz not null default now(),
  primary key (user_id, day)
);
alter table public.ai_coach_briefings enable row level security;

-- Users can read their own briefings. Nobody writes through the API; ai-coach uses the service role.
drop policy if exists "Users read own briefings" on public.ai_coach_briefings;
create policy "Users read own briefings" on public.ai_coach_briefings
  for select to authenticated using ((select auth.uid()) = user_id);

revoke all on public.ai_coach_briefings from anon, authenticated;
grant select on public.ai_coach_briefings to authenticated;
grant select, insert, update on public.ai_coach_briefings to service_role;
