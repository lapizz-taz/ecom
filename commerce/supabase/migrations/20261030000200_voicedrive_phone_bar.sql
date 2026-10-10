-- VoiceDrive PBX, round 2: the Micro package is no longer sold (existing
-- subscriptions keep running until they expire), and the phone bar shows the
-- agent's recent calls next to the business's missed calls.

update public.pbx_packages set active = false where code = 'MICRO' and active;

create or replace function public.pbx_get_my_recent_calls(p_limit int default 30)
returns jsonb
language plpgsql
stable
security definer
set search_path = public, pg_temp
as $$
declare
  a public.pbx_agents;
  v_business uuid;
begin
  perform public.require_permission('pbx.call');
  a := public._vd_my_agent();
  v_business := public._vd_my_business();
  return jsonb_build_object('items', coalesce((select jsonb_agg(public._vd_call_json(c) order by c.requested_at desc)
    from (select * from public.pbx_call_records c
          where c.business_id = v_business
            and c.requested_at > now() - interval '7 days'
            and c.status not in ('REQUESTED', 'CANCELLED')
            and (c.agent_id = a.id
                 or (c.direction = 'INBOUND' and c.status in ('NO_ANSWER', 'REJECTED', 'BUSY', 'FAILED')))
          order by c.requested_at desc
          limit greatest(1, least(coalesce(p_limit, 30), 100))) c), '[]'::jsonb));
end;
$$;

revoke all on function public.pbx_get_my_recent_calls(int) from public, anon;
grant execute on function public.pbx_get_my_recent_calls(int) to authenticated, service_role;
