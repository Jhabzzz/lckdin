alter table public.profiles
  add column total_days integer not null default 120 check (total_days > 0 and total_days <= 999);

comment on column public.profiles.total_days is 'User-chosen protocol length in days (e.g. 30, 75, 120). Default 120.';
