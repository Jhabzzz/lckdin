-- Feature scrapped before any real user touched it (SMS sending would require
-- a paid Twilio account, which the user decided not to set up right now).
-- No real data existed in these columns (checked before dropping).
alter table public.profiles
  drop constraint if exists profiles_phone_e164_check,
  drop column if exists phone,
  drop column if exists sms_updates_enabled;
