-- Prevent malformed/malicious data even from authenticated users writing their own rows,
-- and block garbage inserted directly via the REST API (bypassing client-side JS checks).

-- profiles.username: safe for use in a public URL (lckd-in.com/<username>)
alter table public.profiles
  add constraint username_format check (username ~ '^[a-zA-Z0-9_-]{3,30}$');

-- waitlist_emails.email: basic email shape, reasonable length cap
alter table public.waitlist_emails
  add constraint email_format check (email ~ '^[^@\s]+@[^@\s]+\.[^@\s]+$' and length(email) <= 254);

-- daily_logs: keep numeric fields within sane bounds
alter table public.daily_logs
  add constraint day_number_range check (day_number between 1 and 999),
  add constraint score_range check (score between 0 and 100),
  add constraint status_values check (status in ('PERFECT','PARTIAL','MISS'));
