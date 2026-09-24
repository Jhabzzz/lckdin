ALTER TABLE public.profiles ADD COLUMN IF NOT EXISTS last_reminder_sent_at timestamptz;
