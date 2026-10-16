-- =============================================================================
-- WooCommerce plugin: risk-based advance payment
--   The plugin's order shield already asks Fullfilio for allow / block /
--   advance. It now also gets the customer's delivery level (GOOD, MID, LOW,
--   NEW or ERROR, worked out with this store's receive-rate thresholds), the
--   success rate and parcel count behind it, and the thresholds themselves,
--   so the plugin can apply the advance rule the merchant set for that level
--   (cash on delivery, full delivery charge, a fixed amount or a percentage
--   of the order or of the delivery charge).
--   The level is reported only; nothing here allows an order the old answer
--   refused.
-- =============================================================================

create or replace function public.channel_checkout_decision(p_channel_id uuid, p_phone text, p_ip text default null, p_address text default null, p_check_id uuid default null)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_block jsonb;
  v_check public.fraud_checks;
  v_message text;
  v_cfg jsonb := coalesce(public.get_setting('fraud') -> 'receive_rate', '{}'::jsonb);
  v_levels jsonb;
  v_level jsonb;
begin
  perform public._require_system();
  v_levels := jsonb_build_object(
    'good_min', coalesce((v_cfg ->> 'good_min')::numeric, 80),
    'mid_min', coalesce((v_cfg ->> 'mid_min')::numeric, 50),
    'min_parcels', coalesce((v_cfg ->> 'min_parcels')::int, 1));
  v_block := public.order_block_match(p_phone, p_ip, p_address);
  if v_block is not null then
    return jsonb_build_object('decision', 'block', 'reason', 'BLOCK_LIST', 'levels', v_levels,
      'message', public.setting_text('fraud', array['messages', 'blocked'], 'We are unable to accept this order online. Please contact us to complete your purchase.'));
  end if;
  if p_check_id is null then
    return jsonb_build_object('decision', 'allow', 'reason', 'NO_CHECK', 'levels', v_levels);
  end if;
  select * into v_check from public.fraud_checks where id = p_check_id;
  if v_check.id is null or v_check.status = 'ERROR' then
    return jsonb_build_object('decision', 'allow', 'reason', 'CHECK_UNAVAILABLE', 'levels', v_levels,
      'level', jsonb_build_object('tier', 'ERROR', 'rate', null, 'parcels', null));
  end if;
  v_level := jsonb_build_object(
    'tier', coalesce(v_check.metrics ->> 'receive_rate_tier', 'ERROR'),
    'rate', v_check.metrics -> 'receive_rate',
    'parcels', v_check.metrics -> 'parcel_count');
  if v_check.decision = 'BLOCK' then
    return jsonb_build_object('decision', 'block', 'reason', 'RULE', 'levels', v_levels, 'level', v_level,
      'message', public.setting_text('fraud', array['messages', 'blocked'], 'We are unable to accept this order online. Please contact us to complete your purchase.'));
  end if;
  if v_check.decision = 'ADVANCE_REQUIRED' then
    v_message := coalesce(nullif(public.get_setting('fraud') #>> '{receive_rate,message}', ''),
      'To confirm this order, please pay {amount} in advance.');
    return jsonb_build_object('decision', 'advance', 'reason', 'ADVANCE', 'advance_amount', v_check.advance_amount, 'levels', v_levels, 'level', v_level,
      'message', replace(v_message, '{amount}', coalesce(public.money(v_check.advance_amount)::text || ' tk', 'the delivery charge')));
  end if;
  return jsonb_build_object('decision', 'allow', 'reason', coalesce(v_check.decision::text, 'ALLOW'), 'levels', v_levels, 'level', v_level);
end;
$$;

revoke all on function public.channel_checkout_decision(uuid, text, text, text, uuid) from public, anon, authenticated;
grant execute on function public.channel_checkout_decision(uuid, text, text, text, uuid) to service_role;
alter function public.channel_checkout_decision(uuid, text, text, text, uuid) owner to app_owner;
