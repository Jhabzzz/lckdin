drop policy if exists "anyone can join waitlist" on public.waitlist_emails;
create policy "anyone can join waitlist"
  on public.waitlist_emails for insert
  to anon, authenticated
  with check (true);
