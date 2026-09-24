create or replace function public.use_pivot(p_day_number integer)
returns json
language plpgsql
security definer
set search_path to 'public'
as $function$
declare
  v_user uuid := auth.uid();
  v_log public.daily_logs;
  v_pivot_count int;
begin
  if v_user is null then
    return json_build_object('success', false, 'error', 'Not authenticated');
  end if;

  select * into v_log from public.daily_logs
    where user_id = v_user and day_number = p_day_number;

  if v_log.id is null then
    return json_build_object('success', false, 'error', 'No log found for that day');
  end if;

  if v_log.score <> 0 then
    return json_build_object('success', false, 'error', 'Pivot only applies to a fully missed day');
  end if;

  select count(*) into v_pivot_count from public.daily_logs
    where user_id = v_user and is_pivot = true;

  if v_log.is_pivot then
    return json_build_object('success', true, 'already_pivoted', true, 'pivots_used', v_pivot_count, 'pivots_max', 5);
  end if;

  if v_pivot_count >= 5 then
    return json_build_object('success', false, 'error', 'No pivots remaining', 'pivots_used', v_pivot_count, 'pivots_max', 5);
  end if;

  update public.daily_logs set is_pivot = true
    where user_id = v_user and day_number = p_day_number;

  return json_build_object('success', true, 'pivots_used', v_pivot_count + 1, 'pivots_max', 5);
end;
$function$;
