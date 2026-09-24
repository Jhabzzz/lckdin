-- adapt-agent: AI-suggested rule adjustments (backend/supabase/functions/adapt-agent).
-- The agent NEVER edits rules. It inserts a pending row here (service role only);
-- the user accepts or rejects it from the dashboard via the two RPCs below.

create table public.rule_adaptations (
  id            uuid primary key default gen_random_uuid(),
  user_id       uuid not null references public.profiles(id) on delete cascade,
  rule_index    int  not null check (rule_index between 0 and 99),
  old_rule      text not null check (length(old_rule) between 1 and 140),     -- kept for a future undo
  proposed_rule text not null check (length(proposed_rule) between 1 and 140),
  reason        text not null check (length(reason) between 1 and 600),
  status        text not null default 'pending' check (status in ('pending', 'accepted', 'rejected')),
  created_at    timestamptz not null default now(),
  decided_at    timestamptz,
  check (proposed_rule <> old_rule)
);

-- At most one open suggestion per user.
create unique index rule_adaptations_one_pending on public.rule_adaptations (user_id) where status = 'pending';
create index rule_adaptations_user_created on public.rule_adaptations (user_id, created_at desc);

alter table public.rule_adaptations enable row level security;

-- Users can only read their own rows. No insert/update/delete policies: inserts come
-- from the edge function (service role); decisions go through the RPCs below.
create policy "Users can view their own rule adaptations"
  on public.rule_adaptations for select
  to authenticated
  using ((select auth.uid()) = user_id);

-- Supabase default privileges grant anon/authenticated ALL on new tables; strip them so
-- RLS isn't the only thing standing between the API and writes.
revoke all on public.rule_adaptations from anon, authenticated;
grant select on public.rule_adaptations to authenticated;
grant select, insert, update on public.rule_adaptations to service_role;


-- Who the daily run looks at: active users (logged in the last 14 days) who missed
-- 2+ of the last 3 completed days (no log, or status MISS), with no suggestion in the
-- last 7 days. Dates are the users' own log_date values vs. the server's current_date.
create or replace function public.adapt_agent_candidates()
returns table (user_id uuid)
language sql
stable
security definer
set search_path = public
as $$
  with days as (
    select (current_date - n)::date as d from generate_series(1, 3) as n
  ),
  active as (
    select distinct l.user_id from public.daily_logs l
    where l.log_date >= current_date - 14
  )
  select a.user_id
  from active a
  where (
    select count(*) from days
    where not exists (
      select 1 from public.daily_logs l
      where l.user_id = a.user_id and l.log_date = days.d and l.status <> 'MISS'
    )
  ) >= 2
  and not exists (
    select 1 from public.rule_adaptations r
    where r.user_id = a.user_id and r.created_at > now() - interval '7 days'
  );
$$;

revoke execute on function public.adapt_agent_candidates() from anon, authenticated, public;
grant execute on function public.adapt_agent_candidates() to service_role;


-- Accept: replaces exactly ONE rule's text, atomically. Either both the rule and the
-- suggestion's status change, or nothing does.
-- p_current_rules is only used when profiles.rules is null (user still on the app's
-- default list, which lives in the frontend); otherwise the stored list is the source.
create or replace function public.accept_rule_adaptation(p_id uuid, p_current_rules jsonb default null)
returns json
language plpgsql
security definer
set search_path = public
as $$
declare
  v_user  uuid := auth.uid();
  v_row   public.rule_adaptations;
  v_base  jsonb;
  v_new   jsonb;
begin
  if v_user is null then
    return json_build_object('success', false, 'error', 'not_authenticated');
  end if;

  select * into v_row from public.rule_adaptations
    where id = p_id and user_id = v_user
    for update;
  if v_row.id is null then
    return json_build_object('success', false, 'error', 'not_found');
  end if;
  if v_row.status <> 'pending' then
    return json_build_object('success', false, 'error', 'already_decided');
  end if;

  select rules into v_base from public.profiles where id = v_user for update;
  if v_base is null or jsonb_typeof(v_base) <> 'array' or jsonb_array_length(v_base) = 0 then
    v_base := p_current_rules;
  end if;
  if v_base is null or jsonb_typeof(v_base) <> 'array'
     or v_row.rule_index >= jsonb_array_length(v_base)
     or jsonb_array_length(v_base) > 100 then
    return json_build_object('success', false, 'error', 'rules_unavailable');
  end if;

  -- The rule must still be what the suggestion was made for.
  if (v_base -> v_row.rule_index ->> 't') is distinct from v_row.old_rule then
    return json_build_object('success', false, 'error', 'rule_changed');
  end if;

  -- Same {t, label} shape the dashboard's saveCustomRules() writes; only index
  -- rule_index gets the new text, every other rule is carried over untouched.
  select jsonb_agg(
           jsonb_build_object(
             't', case when e.ord - 1 = v_row.rule_index then v_row.proposed_rule
                       else left(coalesce(e.val ->> 't', ''), 140) end,
             'label', coalesce(e.val ->> 'label', case when (e.val ->> 'flag')::boolean then '!!!' end)
           ) order by e.ord)
    into v_new
    from jsonb_array_elements(v_base) with ordinality as e(val, ord);

  update public.profiles set rules = v_new where id = v_user;
  update public.rule_adaptations set status = 'accepted', decided_at = now() where id = v_row.id;

  return json_build_object('success', true, 'rule_index', v_row.rule_index,
                           'old_rule', v_row.old_rule, 'new_rule', v_row.proposed_rule);
end;
$$;

create or replace function public.reject_rule_adaptation(p_id uuid)
returns json
language plpgsql
security definer
set search_path = public
as $$
declare
  v_user uuid := auth.uid();
  v_n    int;
begin
  if v_user is null then
    return json_build_object('success', false, 'error', 'not_authenticated');
  end if;
  update public.rule_adaptations set status = 'rejected', decided_at = now()
    where id = p_id and user_id = v_user and status = 'pending';
  get diagnostics v_n = row_count;
  if v_n = 0 then
    return json_build_object('success', false, 'error', 'not_found_or_decided');
  end if;
  return json_build_object('success', true);
end;
$$;

revoke execute on function public.accept_rule_adaptation(uuid, jsonb) from anon, public;
revoke execute on function public.reject_rule_adaptation(uuid) from anon, public;
grant execute on function public.accept_rule_adaptation(uuid, jsonb) to authenticated;
grant execute on function public.reject_rule_adaptation(uuid) to authenticated;
