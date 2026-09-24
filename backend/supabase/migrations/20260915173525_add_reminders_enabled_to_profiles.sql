ALTER TABLE public.profiles ADD COLUMN IF NOT EXISTS reminders_enabled boolean NOT NULL DEFAULT true;
