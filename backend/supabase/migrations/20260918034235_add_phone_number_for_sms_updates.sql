alter table public.profiles
  add column phone text,
  add column sms_updates_enabled boolean not null default true;

alter table public.profiles
  add constraint profiles_phone_e164_check
  check (phone is null or phone ~ '^\+[1-9]\d{6,14}$');

comment on column public.profiles.phone is 'Optional phone number in E.164 format (+15551234567) for SMS reminders/updates. Nullable — most users will not have one.';
comment on column public.profiles.sms_updates_enabled is 'Whether the user wants SMS updates (reminders, launch/feature announcements). Only relevant if phone is set.';
