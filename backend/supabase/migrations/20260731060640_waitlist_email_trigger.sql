create extension if not exists pg_net;

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
      'x-internal-secret', current_setting('app.settings.internal_webhook_secret', true)
    ),
    body := jsonb_build_object('email', new.email)
  );
  return new;
end;
$$;

drop trigger if exists on_waitlist_signup on public.waitlist_emails;
create trigger on_waitlist_signup
  after insert on public.waitlist_emails
  for each row execute function public.notify_waitlist_signup();
