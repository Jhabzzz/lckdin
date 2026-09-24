-- NOTE: the live function embeds the real INTERNAL_WEBHOOK_SECRET value here.
-- It is redacted in this repo (public on GitHub). Substitute it when re-applying.
create or replace function public.notify_waitlist_signup()
returns trigger
language plpgsql
security definer
set search_path = public, extensions
as $$
begin
  perform net.http_post(
    url := 'https://qtlhpaqsmbyneivdsiei.supabase.co/functions/v1/send-waitlist-email',
    headers := jsonb_build_object(
      'Content-Type', 'application/json',
      'x-internal-secret', '<INTERNAL_WEBHOOK_SECRET>'
    ),
    body := jsonb_build_object('email', new.email)
  );
  return new;
end;
$$;
