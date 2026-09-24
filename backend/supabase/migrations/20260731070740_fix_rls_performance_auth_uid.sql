-- profiles
drop policy if exists "Users can insert their own profile" on public.profiles;
create policy "Users can insert their own profile"
  on public.profiles for insert
  with check ((select auth.uid()) = id);

drop policy if exists "Users can update their own profile" on public.profiles;
create policy "Users can update their own profile"
  on public.profiles for update
  using ((select auth.uid()) = id);

-- daily_logs
drop policy if exists "Users can insert their own logs" on public.daily_logs;
create policy "Users can insert their own logs"
  on public.daily_logs for insert
  with check ((select auth.uid()) = user_id);

drop policy if exists "Users can update their own logs" on public.daily_logs;
create policy "Users can update their own logs"
  on public.daily_logs for update
  using ((select auth.uid()) = user_id);
