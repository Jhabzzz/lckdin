-- Two kinds of suggestion from adapt-agent:
--   rule_change  – replace one rule's text (existing behaviour)
--   rough_patch  – most rules failed together; suggest focusing on a short list of rules
--                  (the user's !!! rules) for a few days. Never changes the rule list.

alter table public.rule_adaptations
  add column if not exists type        text  not null default 'rule_change' check (type in ('rule_change', 'rough_patch')),
  add column if not exists focus_rules jsonb,                                  -- rough_patch: [{ "index": 3, "t": "..." }, …]
  add column if not exists focus_days  int   check (focus_days between 1 and 14);

alter table public.rule_adaptations
  alter column rule_index drop not null,
  alter column old_rule   drop not null;

alter table public.rule_adaptations drop constraint if exists rule_adaptations_type_shape;
alter table public.rule_adaptations add constraint rule_adaptations_type_shape check (
  (type = 'rule_change' and rule_index is not null and old_rule is not null
     and focus_rules is null and focus_days is null)
  or
  (type = 'rough_patch' and rule_index is null and old_rule is null
     and jsonb_typeof(focus_rules) = 'array' and jsonb_array_length(focus_rules) between 1 and 100
     and focus_days is not null)
);


-- Accept: rough_patch just records the commitment (nothing about the rule list changes);
-- rule_change is unchanged — swaps exactly one rule atomically or changes nothing.
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

  if v_row.type = 'rough_patch' then
    update public.rule_adaptations set status = 'accepted', decided_at = now() where id = v_row.id;
    return json_build_object('success', true, 'type', 'rough_patch',
                             'focus_days', v_row.focus_days,
                             'focus_until', (now() + make_interval(days => v_row.focus_days))::date);
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

-- create or replace keeps grants; restated so this file stands on its own.
revoke execute on function public.accept_rule_adaptation(uuid, jsonb) from anon, public;
grant execute on function public.accept_rule_adaptation(uuid, jsonb) to authenticated;
