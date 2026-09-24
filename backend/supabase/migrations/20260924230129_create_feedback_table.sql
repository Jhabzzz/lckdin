-- Backs frontend/feedback-widget.js. Insert-only from the API: there are no
-- select/update/delete policies, so rows are only readable in the dashboard.
create table public.feedback (
  id uuid primary key default gen_random_uuid(),
  message text not null check (length(message) between 1 and 2000),
  rating smallint check (rating between 1 and 5),
  user_id uuid references auth.users(id) on delete set null,
  page text check (length(page) <= 200),
  user_agent text check (length(user_agent) <= 300),
  created_at timestamptz not null default now()
);

alter table public.feedback enable row level security;

-- user_id must be null (anonymous) or the caller's own id — no spoofing others.
create policy "anyone can send feedback"
  on public.feedback for insert
  to anon, authenticated
  with check (user_id is null or user_id = (select auth.uid()));

grant insert on public.feedback to anon, authenticated;
