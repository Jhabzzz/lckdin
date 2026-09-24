-- Spam protection for public.feedback (see frontend/feedback-widget.js).
--
-- Per-sender limit: 3 rows / 10 min, keyed by user_id when logged in, or by a
-- sha256 hash of the client IP when logged out (the raw IP is never stored).
-- Global limit: 50 anonymous rows / hour.
-- Rejections raise SQLSTATE PT429, which PostgREST returns as HTTP 429.
--
-- Client IP source (verified on this project 2026-09-24):
--   cf-connecting-ip  — set by Cloudflare, cannot be spoofed (forged values are rejected)
--   x-forwarded-for   — clients can PREPEND fake entries; only the RIGHTMOST entry is
--                       the real IP, so it is used as a fallback from the right.

alter table public.feedback add column ip_hash text;

create index feedback_user_recent_idx on public.feedback (user_id, created_at) where user_id is not null;
create index feedback_ip_recent_idx   on public.feedback (ip_hash, created_at) where ip_hash is not null;
create index feedback_anon_recent_idx on public.feedback (created_at) where user_id is null;

create or replace function public.feedback_rate_limit()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  v_headers json := coalesce(nullif(current_setting('request.headers', true), '')::json, '{}'::json);
  v_ip      text;
  v_uid     uuid := auth.uid();
  v_recent  int;
begin
  -- Server-controlled fields: never trust client-supplied values for these,
  -- or back-dated created_at / fake ip_hash could dodge the counts below.
  new.created_at := now();

  v_ip := nullif(trim(coalesce(
    v_headers->>'cf-connecting-ip',
    (select trim(x) from unnest(string_to_array(v_headers->>'x-forwarded-for', ',')) with ordinality as t(x, n)
       order by n desc limit 1)
  )), '');
  new.ip_hash := case when v_ip is null then null else encode(sha256(convert_to(v_ip, 'UTF8')), 'hex') end;

  if v_uid is not null then
    perform pg_advisory_xact_lock(hashtext('feedback:user:' || v_uid::text));
    select count(*) into v_recent from public.feedback
      where user_id = v_uid and created_at > now() - interval '10 minutes';
    if v_recent >= 3 then
      raise exception 'rate_limited' using errcode = 'PT429', detail = 'per_user';
    end if;
  else
    if new.ip_hash is not null then
      perform pg_advisory_xact_lock(hashtext('feedback:ip:' || new.ip_hash));
      select count(*) into v_recent from public.feedback
        where ip_hash = new.ip_hash and created_at > now() - interval '10 minutes';
      if v_recent >= 3 then
        raise exception 'rate_limited' using errcode = 'PT429', detail = 'per_ip';
      end if;
    end if;

    select count(*) into v_recent from public.feedback
      where user_id is null and created_at > now() - interval '1 hour';
    if v_recent >= 50 then
      raise exception 'rate_limited' using errcode = 'PT429', detail = 'global_anon';
    end if;
  end if;

  return new;
end;
$$;

revoke execute on function public.feedback_rate_limit() from anon, authenticated, public;

create trigger feedback_rate_limit
  before insert on public.feedback
  for each row execute function public.feedback_rate_limit();
