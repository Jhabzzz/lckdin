-- Rough patch: the user picks up to 3 focus rules on the card; accept saves the picks
-- to focus_rules. Adds p_focus_rules to accept_rule_adaptation (the old 2-arg version is
-- dropped so PostgREST has exactly one function to resolve).

drop function if exists public.accept_rule_adaptation(uuid, jsonb);

create or replace function public.accept_rule_adaptation(
  p_id uuid,
  p_current_rules jsonb default null,
  p_focus_rules jsonb default null
)
returns json
language plpgsql
security definer
set search_path = public
as $$
declare
  v_user   uuid := auth.uid();
  v_row    public.rule_adaptations;
  v_base   jsonb;
  v_new    jsonb;
  v_focus  jsonb;
  v_bad    int;
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

  if v_row.type = 'rough_patch' then
    -- Picks default to what the agent suggested; if given, they must be 1-3 of the
    -- user's own rules ({index, t}). Never touches profiles.rules.
    v_focus := coalesce(p_focus_rules, v_row.focus_rules);
    -- CASE, not OR: SQL doesn't guarantee short-circuiting, and jsonb_array_length /
    -- the numeric cast below would throw on the wrong JSON type.
    if (case when jsonb_typeof(v_focus) = 'array'
             then jsonb_array_length(v_focus) between 1 and 3 else false end) is not true then
      return json_build_object('success', false, 'error', 'pick_1_to_3');
    end if;
    select count(*) into v_bad from jsonb_array_elements(v_focus) f
      where (case when jsonb_typeof(f) = 'object'
                   and jsonb_typeof(f -> 't') = 'string'
                   and jsonb_typeof(f -> 'index') = 'number'
                  then length(f ->> 't') between 1 and 140
                   and (f ->> 'index')::numeric between 0 and 99
                   and (f ->> 'index')::numeric = trunc((f ->> 'index')::numeric)
                  else false end) is not true;
    if v_bad > 0 then
      return json_build_object('success', false, 'error', 'bad_focus_rules');
    end if;
    select rules into v_base from public.profiles where id = v_user;
    if (case when jsonb_typeof(v_base) = 'array' then jsonb_array_length(v_base) > 0 else false end) then
      -- stored custom list: every pick must be one of those rules
      select count(*) into v_bad from jsonb_array_elements(v_focus) f
        where not exists (select 1 from jsonb_array_elements(v_base) r where r ->> 't' = f ->> 't');
      if v_bad > 0 then
        return json_build_object('success', false, 'error', 'rule_changed');
      end if;
    end if;
    -- normalize to exactly {index, t}
    select jsonb_agg(jsonb_build_object('index', (f ->> 'index')::int, 't', f ->> 't'))
      into v_focus from jsonb_array_elements(v_focus) f;

    update public.rule_adaptations
      set status = 'accepted', decided_at = now(), focus_rules = v_focus
      where id = v_row.id;
    return json_build_object('success', true, 'type', 'rough_patch',
                             'focus_days', v_row.focus_days, 'focus_rules', v_focus);
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

  return json_build_object('success', true, 'type', 'rule_change', 'rule_index', v_row.rule_index,
                           'old_rule', v_row.old_rule, 'new_rule', v_row.proposed_rule);
end;
$$;

revoke execute on function public.accept_rule_adaptation(uuid, jsonb, jsonb) from anon, public;
grant execute on function public.accept_rule_adaptation(uuid, jsonb, jsonb) to authenticated;


-- Candidacy uses the same "never the user's today" base date as the edge function:
-- the UTC date 12h ago is never later than anyone's local date (UTC-12..UTC+14), so
-- base-1..base-3 are always completed days. At the 13:00 UTC cron this equals the old
-- current_date-based window; it only differs for runs at other hours.
create or replace function public.adapt_agent_candidates()
returns table (user_id uuid)
language sql
stable
security definer
set search_path = public
as $$
  with base as (
    select (now() - interval '12 hours')::date as d
  ),
  days as (
    select (base.d - n)::date as d from base, generate_series(1, 3) as n
  ),
  active as (
    select distinct l.user_id from public.daily_logs l, base
    where l.log_date >= base.d - 14
  )
  select a.user_id
  from active a
  where (
    select count(*) from days
    where not exists (
      select 1 from public.daily_logs l
      where l.user_id = a.user_id and l.log_date = days.d
        and (l.status <> 'MISS' or l.is_pivot)
    )
  ) >= 2
  and not exists (
    select 1 from public.rule_adaptations r
    where r.user_id = a.user_id and r.created_at > now() - interval '7 days'
  );
$$;

revoke execute on function public.adapt_agent_candidates() from anon, authenticated, public;
grant execute on function public.adapt_agent_candidates() to service_role;
