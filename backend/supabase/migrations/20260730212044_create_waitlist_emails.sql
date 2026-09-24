create table if not exists public.waitlist_emails (
  id uuid primary key default gen_random_uuid(),
  email text not null unique,
  created_at timestamptz not null default now()
);

alter table public.waitlist_emails enable row level security;

drop policy if exists "anyone can join waitlist" on public.waitlist_emails;
create policy "anyone can join waitlist"
  on public.waitlist_emails for insert
  to anon
  with check (true);
