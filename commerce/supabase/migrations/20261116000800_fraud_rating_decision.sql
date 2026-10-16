-- =============================================================================
-- Courier rating → automatic advance payment: decision fixes
--
-- * A courier lookup that failed (or was not allowed) is no longer scored as a
--   high-risk customer and no longer relabels the customer. "Unavailable" is its
--   own case: the "Check failed" action of the delivery success check decides,
--   or, with that check off, the store's provider-error policy, which can now
--   also ask for the advance (ALLOW / REVIEW / ADVANCE).
-- * Every decision carries a reason for staff (fraud_checks.metrics.decision_reason).
-- * An order placed while no check could be recorded follows the same policy.
-- * WooCommerce order shield: the decision is worked out for the order being
--   placed (its total and shipping), so the advance is the real amount instead
--   of 0, and a failed or still-running lookup follows the store's policy
--   instead of letting cash on delivery through.
-- * Checkout lookups started from the storefront are limited per visitor and per
--   store (they spend the store's courier lookups).
-- =============================================================================

CREATE OR REPLACE FUNCTION public.record_fraud_check(p_input jsonb)
 RETURNS fraud_checks
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
declare
  v_phone text := public.clean_phone(p_input ->> 'phone');
  v_order_id uuid := nullif(p_input ->> 'order_id', '')::uuid;
  v_internal jsonb;
  v_counts jsonb := coalesce(p_input -> 'provider_counts', '{}'::jsonb);
  v_m jsonb;
  v_delivered int;
  v_cancelled int;
  v_returned int;
  v_failed int;
  v_completed int;
  v_score numeric;
  v_level public.risk_level;
  v_courier numeric;
  v_eval jsonb;
  v_context jsonb := coalesce(p_input -> 'context', '{}'::jsonb);
  v_check public.fraud_checks;
  v_status text := coalesce(p_input ->> 'status', 'SUCCESS');
begin
  if not (public.is_system_context() or public.has_permission('fraud.review')) then
    raise exception 'PERMISSION_DENIED: fraud.review is required' using errcode = '42501';
  end if;
  if v_phone is null then
    raise exception 'VALIDATION: phone is required for a fraud check' using errcode = '22023';
  end if;

  v_internal := public.fraud_customer_metrics(v_phone, v_order_id);

  -- Merge own history with provider (courier network) counts.
  v_delivered := greatest((v_internal ->> 'delivered_orders')::int, coalesce((v_counts ->> 'delivered')::int, 0));
  v_cancelled := greatest((v_internal ->> 'cancelled_orders')::int, coalesce((v_counts ->> 'cancelled')::int, 0));
  v_returned := greatest((v_internal ->> 'returned_orders')::int, coalesce((v_counts ->> 'returned')::int, 0));
  v_failed := greatest((v_internal ->> 'failed_delivery_orders')::int, coalesce((v_counts ->> 'failed')::int, 0));
  v_completed := v_delivered + v_cancelled + v_returned + v_failed;

  v_courier := coalesce((p_input ->> 'provider_courier_score')::numeric,
    public.outcome_rate(v_delivered, v_delivered + v_returned + v_failed));

  v_m := v_internal || jsonb_build_object(
    'previous_orders', greatest((v_internal ->> 'previous_orders')::int, coalesce((v_counts ->> 'total')::int, 0)),
    'delivered_orders', v_delivered,
    'cancelled_orders', v_cancelled,
    'returned_orders', v_returned,
    'failed_delivery_orders', v_failed,
    'cancellation_rate', public.outcome_rate(v_cancelled, v_completed),
    'return_rate', public.outcome_rate(v_returned, v_completed),
    'failed_delivery_rate', public.outcome_rate(v_failed, v_completed),
    'courier_score', v_courier,
    'provider_risk_score', (p_input ->> 'provider_risk_score')::numeric,
    'provider_parcels', coalesce((p_input ->> 'provider_parcel_floor')::int, 0),
    'provider_status', case when (p_input ->> 'provider') = 'internal' then 'SUCCESS' else v_status end
  );
  v_m := v_m || public._receive_rate_facts(v_m);

  -- The score comes from the history that was actually read. A courier lookup that failed
  -- says nothing about the customer: it is not scored as risky (nor as safe); the store's
  -- policy for an unavailable check decides instead (evaluate_fraud_rules, tier ERROR).
  v_score := public.compute_risk_score(v_m);
  v_level := public.risk_level_for_score(v_score);
  v_m := v_m || jsonb_build_object('risk_score', v_score, 'risk_level', v_level);

  v_eval := public.evaluate_fraud_rules(v_m, v_context);
  v_m := v_m || jsonb_build_object('decision_reason', v_eval ->> 'reason');

  insert into public.fraud_checks(
    order_id, customer_id, phone, provider, providers, status, risk_score, risk_level, courier_score,
    previous_orders, delivered_orders, cancelled_orders, returned_orders, failed_delivery_orders,
    cancellation_rate, return_rate, failed_delivery_rate, recommendation, decision, advance_type, advance_amount,
    matched_rules, metrics, context, provider_response, error, created_by
  ) values (
    v_order_id, (v_internal ->> 'customer_id')::uuid, v_phone, coalesce(p_input ->> 'provider', 'internal'),
    coalesce(array(select jsonb_array_elements_text(coalesce(p_input -> 'providers', '[]'::jsonb))), '{}'),
    v_status, v_score, v_level, v_courier,
    (v_m ->> 'previous_orders')::int, v_delivered, v_cancelled, v_returned, v_failed,
    (v_m ->> 'cancellation_rate')::numeric, (v_m ->> 'return_rate')::numeric, (v_m ->> 'failed_delivery_rate')::numeric,
    coalesce(nullif(p_input ->> 'recommendation', ''), initcap(replace(v_eval ->> 'decision', '_', ' '))),
    (v_eval ->> 'decision')::public.fraud_decision, (v_eval ->> 'advance_type')::public.advance_type,
    (v_eval ->> 'advance_amount')::numeric, v_eval -> 'matched_rules', v_m, v_context,
    p_input -> 'provider_response', nullif(p_input ->> 'error', ''), auth.uid()
  ) returning * into v_check;

  -- A check whose courier lookups all failed does not relabel the customer.
  if v_check.customer_id is not null and v_status <> 'ERROR' then
    update public.customers set risk_level = v_level, last_fraud_score = v_score, last_fraud_check_at = now()
    where id = v_check.customer_id;
    perform public.refresh_customer_stats(v_check.customer_id);
  end if;
  return v_check;
end;
$function$;

CREATE OR REPLACE FUNCTION public.evaluate_fraud_rules(p_metrics jsonb, p_context jsonb)
 RETURNS jsonb
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
declare
  v_facts jsonb := coalesce(p_metrics, '{}'::jsonb) || coalesce(p_context, '{}'::jsonb);
  v_rule record;
  v_matched boolean;
  v_decision public.fraud_decision := 'ALLOW';
  v_advance numeric := 0;
  v_advance_type public.advance_type := 'NONE';
  v_message text;
  v_matched_rules jsonb := '[]'::jsonb;
  v_amount numeric;
  v_cfg jsonb := coalesce(public.get_setting('fraud') -> 'receive_rate', '{}'::jsonb);
  v_tier text;
  v_action text;
  v_rr_decision public.fraud_decision;
  v_rr_type public.advance_type;
  v_reason text;
begin
  v_facts := v_facts || public._receive_rate_facts(v_facts);

  if coalesce((v_cfg ->> 'enabled')::boolean, false) then
    v_tier := v_facts ->> 'receive_rate_tier';
    v_action := upper(coalesce(v_cfg -> 'actions' ->> v_tier,
      case when v_tier in ('MID', 'LOW', 'ERROR') then 'ADVANCE' else 'COD' end));
    v_rr_decision := case v_action
      when 'ADVANCE' then 'ADVANCE_REQUIRED' when 'REVIEW' then 'REVIEW' when 'BLOCK' then 'BLOCK' else 'ALLOW' end;
    v_rr_type := case when v_rr_decision in ('ADVANCE_REQUIRED', 'REVIEW')
      then coalesce(nullif(v_cfg ->> 'advance_type', ''), 'FIXED')::public.advance_type else 'NONE' end;
    v_amount := case when v_rr_type = 'NONE' then 0 else public.compute_advance_amount(v_rr_type,
      coalesce((v_cfg ->> 'advance_amount')::numeric, 55),
      (v_facts ->> 'order_value')::numeric, (v_facts ->> 'delivery_charge')::numeric, (v_facts ->> 'return_charge')::numeric) end;
    v_matched_rules := v_matched_rules || jsonb_build_object(
      'rule_id', null, 'policy', 'receive_rate', 'tier', v_tier, 'rate', v_facts -> 'receive_rate',
      'name', case v_tier when 'ERROR' then 'Courier history unavailable' when 'NEW' then 'New customer (no delivery history)'
              else 'Delivery success ' || initcap(v_tier) || coalesce(' (' || round((v_facts ->> 'receive_rate')::numeric) || '%)', '') end,
      'decision', v_rr_decision, 'advance_type', v_rr_type, 'advance_amount', v_amount);
    if public.decision_severity(v_rr_decision) > public.decision_severity(v_decision) then
      v_decision := v_rr_decision;
      v_message := case when v_rr_decision = 'ADVANCE_REQUIRED' then nullif(v_cfg ->> 'message', '') end;
    end if;
    if v_rr_decision in ('ADVANCE_REQUIRED', 'REVIEW') and v_amount > v_advance then
      v_advance := v_amount;
      v_advance_type := v_rr_type;
    end if;
  end if;

  -- Courier history could not be read (service down, every courier sign-in failing, lookup
  -- not allowed) and there is no history of our own to judge by. That is not a bad customer
  -- and not a good one: with the delivery success check on, its "Check failed" action decides
  -- (above); otherwise the store's provider-error policy: continue, manual review, or advance.
  if not coalesce((v_cfg ->> 'enabled')::boolean, false) and v_facts ->> 'receive_rate_tier' = 'ERROR' then
    v_action := upper(public.setting_text('fraud', array['on_provider_error'], 'REVIEW'));
    v_rr_decision := case v_action when 'ADVANCE' then 'ADVANCE_REQUIRED' when 'ALLOW' then 'ALLOW' else 'REVIEW' end;
    v_matched_rules := v_matched_rules || jsonb_build_object(
      'rule_id', null, 'policy', 'provider_error', 'tier', 'ERROR', 'name', 'Courier history unavailable',
      'decision', v_rr_decision, 'advance_type', 'NONE', 'advance_amount', 0);
    if public.decision_severity(v_rr_decision) > public.decision_severity(v_decision) then
      v_decision := v_rr_decision;
    end if;
  end if;

  for v_rule in
    select r.id, r.name, r.match_mode, r.conditions, r.priority,
           a.decision, a.advance_type, a.advance_value, a.customer_message, a.stop_processing
    from public.fraud_rules r
    join public.fraud_rule_actions a on a.rule_id = r.id
    where r.is_active
    order by r.priority, r.created_at, a.created_at
  loop
    if jsonb_array_length(v_rule.conditions) = 0 then
      v_matched := true;
    elsif v_rule.match_mode = 'ANY' then
      select bool_or(public.fraud_condition_matches(v_facts, c)) into v_matched from jsonb_array_elements(v_rule.conditions) c;
    else
      select bool_and(public.fraud_condition_matches(v_facts, c)) into v_matched from jsonb_array_elements(v_rule.conditions) c;
    end if;

    if coalesce(v_matched, false) then
      v_amount := public.compute_advance_amount(v_rule.advance_type, v_rule.advance_value,
        (v_facts ->> 'order_value')::numeric, (v_facts ->> 'delivery_charge')::numeric, (v_facts ->> 'return_charge')::numeric);
      v_matched_rules := v_matched_rules || jsonb_build_object(
        'rule_id', v_rule.id, 'name', v_rule.name, 'decision', v_rule.decision,
        'advance_type', v_rule.advance_type, 'advance_amount', v_amount);

      if public.decision_severity(v_rule.decision) > public.decision_severity(v_decision) then
        v_decision := v_rule.decision;
        v_message := v_rule.customer_message;
      end if;
      if v_rule.decision in ('ADVANCE_REQUIRED', 'REVIEW') and v_amount > v_advance then
        v_advance := v_amount;
        v_advance_type := v_rule.advance_type;
      end if;
      exit when v_rule.stop_processing;
    end if;
  end loop;

  -- An advance-required decision without an amount falls back to the default.
  if v_decision = 'ADVANCE_REQUIRED' and v_advance <= 0 then
    v_advance_type := coalesce(public.setting_text('fraud', array['default_advance', 'type'], 'DELIVERY_CHARGE'), 'DELIVERY_CHARGE')::public.advance_type;
    v_advance := public.compute_advance_amount(v_advance_type,
      public.setting_numeric('fraud', array['default_advance', 'value'], 0),
      (v_facts ->> 'order_value')::numeric, (v_facts ->> 'delivery_charge')::numeric, (v_facts ->> 'return_charge')::numeric);
  end if;

  -- Why: the first policy or rule that asked for the final decision (shown to staff, never to customers).
  select m ->> 'name' into v_reason from jsonb_array_elements(v_matched_rules) m where m ->> 'decision' = v_decision::text limit 1;

  return jsonb_build_object(
    'decision', v_decision,
    'reason', coalesce(v_reason, case when v_decision = 'ALLOW' then 'No rule asked for an advance' end),
    'advance_type', case when v_decision in ('ADVANCE_REQUIRED', 'REVIEW') then v_advance_type else 'NONE' end,
    'advance_amount', case when v_decision in ('ADVANCE_REQUIRED', 'REVIEW') then v_advance else 0 end,
    'customer_message', v_message,
    'matched_rules', v_matched_rules,
    'receive_rate_tier', v_facts ->> 'receive_rate_tier'
  );
end;
$function$;

CREATE OR REPLACE FUNCTION public._apply_fraud_decision(p_order_id uuid, p_fraud_check_id uuid)
 RETURNS orders
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
declare
  v_order public.orders;
  v_check public.fraud_checks;
  v_eval jsonb;
  v_req jsonb;
  v_decision public.fraud_decision := 'ALLOW';
  v_target public.order_status;
  v_fraud_enabled boolean := public.setting_bool('fraud', array['enabled'], true);
begin
  select * into v_order from public.orders where id = p_order_id for update;
  if v_order.status not in ('PENDING', 'FRAUD_CHECK', 'FRAUD_REVIEW', 'CONFIRMATION_REQUIRED', 'ADVANCE_REQUIRED') then
    raise exception 'VALIDATION: fraud decisions cannot be applied to % orders', v_order.status using errcode = '22023';
  end if;

  if v_order.status <> 'FRAUD_CHECK' then
    v_order := public._transition_order(p_order_id, 'FRAUD_CHECK', 'Risk check started');
  end if;

  if p_fraud_check_id is not null and v_fraud_enabled then
    select * into v_check from public.fraud_checks where id = p_fraud_check_id;
    if v_check.order_id is null then
      update public.fraud_checks set order_id = p_order_id, customer_id = coalesce(customer_id, v_order.customer_id)
      where id = p_fraud_check_id;
    end if;
    v_eval := public.evaluate_fraud_rules(v_check.metrics, jsonb_build_object(
      'order_value', v_order.total_amount, 'subtotal', v_order.subtotal,
      'delivery_charge', v_order.delivery_charge, 'return_charge', v_order.return_charge,
      'district', v_order.shipping_district, 'area', v_order.shipping_area,
      'payment_method', v_order.payment_method, 'source', v_order.source,
      'item_count', (select sum(quantity) from public.order_items where order_id = p_order_id)));
    v_decision := (v_eval ->> 'decision')::public.fraud_decision;
  elsif v_fraud_enabled then
    -- Checks are on but none could be recorded (provider or service outage): never fail
    -- open. The same policy as a failed lookup decides (the "Check failed" action of the
    -- delivery success check, else the store's provider-error policy).
    v_eval := public.evaluate_fraud_rules(jsonb_build_object('provider_status', 'ERROR', 'check_unavailable', true), jsonb_build_object(
      'order_value', v_order.total_amount, 'subtotal', v_order.subtotal,
      'delivery_charge', v_order.delivery_charge, 'return_charge', v_order.return_charge,
      'district', v_order.shipping_district, 'area', v_order.shipping_area,
      'payment_method', v_order.payment_method, 'source', v_order.source));
    v_decision := (v_eval ->> 'decision')::public.fraud_decision;
  else
    v_eval := jsonb_build_object('decision', 'ALLOW', 'advance_amount', 0, 'advance_type', 'NONE', 'matched_rules', '[]'::jsonb);
  end if;

  v_req := public.payment_requirement_for(v_decision, (v_eval ->> 'advance_amount')::numeric,
    v_order.total_amount, v_order.payment_method, v_eval ->> 'customer_message');

  update public.orders set
    fraud_check_id = coalesce(p_fraud_check_id, fraud_check_id),
    risk_level = coalesce(v_check.risk_level, risk_level),
    fraud_decision = v_decision,
    fraud_status = case v_decision
      when 'ALLOW' then 'PASSED' when 'ADVANCE_REQUIRED' then 'ADVANCE_REQUIRED'
      when 'REVIEW' then 'REVIEW' else 'REJECTED' end::public.fraud_status,
    -- For REVIEW the rule's advance is kept as the reviewer's recommendation.
    advance_required = case when v_decision = 'REVIEW' then coalesce((v_eval ->> 'advance_amount')::numeric, 0)
                            else coalesce((v_req ->> 'amount')::numeric, 0) end,
    advance_type = case when v_decision = 'REVIEW' then coalesce((v_eval ->> 'advance_type')::public.advance_type, 'NONE')
      when coalesce((v_req ->> 'amount')::numeric, 0) > 0
      then case when v_req ->> 'mode' = 'FULL' then 'FULL'::public.advance_type
                else coalesce((v_eval ->> 'advance_type')::public.advance_type, 'FIXED') end
      else 'NONE' end
  where id = p_order_id
  returning * into v_order;

  perform public._order_log(p_order_id, 'FRAUD_EVALUATED',
    case when v_check.id is null and v_fraud_enabled then 'Risk check unavailable'
         when v_check.id is null then 'Risk check skipped'
         else format('Risk %s (score %s) → %s', v_check.risk_level, v_check.risk_score, v_decision) end,
    null, null, jsonb_build_object('fraud_check_id', p_fraud_check_id, 'decision', v_decision,
      'advance_amount', v_req -> 'amount', 'matched_rules', v_eval -> 'matched_rules'));

  v_target := case
    when v_decision = 'BLOCK' then
      case when public.setting_text('fraud', array['block_mode'], 'REJECT') = 'REVIEW' then 'FRAUD_REVIEW' else 'REJECTED_FRAUD' end
    when v_decision = 'REVIEW' then 'FRAUD_REVIEW'
    when coalesce((v_req ->> 'amount')::numeric, 0) > v_order.amount_paid then 'ADVANCE_REQUIRED'
    when public.setting_bool('orders', array['require_confirmation'], false) then 'CONFIRMATION_REQUIRED'
    else 'CONFIRMED'
  end::public.order_status;

  return public._transition_order(p_order_id, v_target,
    case v_target
      when 'REJECTED_FRAUD' then 'Blocked by fraud rules'
      when 'FRAUD_REVIEW' then 'Sent to manual fraud review'
      when 'ADVANCE_REQUIRED' then format('Advance payment of %s required', v_req ->> 'amount')
      when 'CONFIRMATION_REQUIRED' then 'Awaiting confirmation call'
      else 'Passed risk check'
    end,
    jsonb_build_object('decision', v_decision));
end;
$function$;

-- WooCommerce order shield: the decision for the order being placed. Replaces the
-- five-argument version (whose advance came from a check recorded without the order's
-- total, so it was 0, and which let cash on delivery through when the lookup failed).
drop function if exists public.channel_checkout_decision(uuid, text, text, text, uuid);

create or replace function public.channel_checkout_decision(
  p_channel_id uuid, p_phone text, p_ip text default null, p_address text default null, p_check_id uuid default null,
  p_total numeric default null, p_shipping numeric default null, p_unavailable boolean default false)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_block jsonb;
  v_check public.fraud_checks;
  v_cfg jsonb := coalesce(public.get_setting('fraud') -> 'receive_rate', '{}'::jsonb);
  v_levels jsonb;
  v_level jsonb;
  v_eval jsonb;
  v_decision text;
  v_amount numeric;
  v_message text;
  v_reason text;
  v_blocked text := public.setting_text('fraud', array['messages', 'blocked'], 'We are unable to accept this order online. Please contact us to complete your purchase.');
  v_ctx jsonb := jsonb_strip_nulls(jsonb_build_object('order_value', p_total, 'subtotal', p_total, 'delivery_charge', p_shipping, 'source', 'WOOCOMMERCE'));
begin
  perform public._require_system();
  v_levels := jsonb_build_object(
    'good_min', coalesce((v_cfg ->> 'good_min')::numeric, 80),
    'mid_min', coalesce((v_cfg ->> 'mid_min')::numeric, 50),
    'min_parcels', coalesce((v_cfg ->> 'min_parcels')::int, 1));
  v_block := public.order_block_match(p_phone, p_ip, p_address);
  if v_block is not null then
    return jsonb_build_object('decision', 'block', 'reason', 'BLOCK_LIST', 'levels', v_levels, 'message', v_blocked);
  end if;
  if not public.setting_bool('fraud', array['enabled'], true) then
    return jsonb_build_object('decision', 'allow', 'reason', 'OFF', 'levels', v_levels);
  end if;
  if p_check_id is not null then
    select * into v_check from public.fraud_checks where id = p_check_id;
  end if;
  if v_check.id is null and p_check_id is null and not p_unavailable then
    -- First pass (block list only); the courier record follows.
    return jsonb_build_object('decision', 'allow', 'reason', 'NO_CHECK', 'levels', v_levels);
  end if;

  if v_check.id is null or public._receive_rate_facts(coalesce(v_check.metrics, '{}'::jsonb)) ->> 'receive_rate_tier' = 'ERROR' then
    -- The lookup failed, is still running past the plugin's time budget, or is missing:
    -- the store's policy for an unavailable check decides, never a silent "allow".
    v_eval := public.evaluate_fraud_rules(coalesce(v_check.metrics, '{}'::jsonb) || jsonb_build_object('provider_status', 'ERROR'), v_ctx);
    v_reason := 'CHECK_UNAVAILABLE';
    v_level := jsonb_build_object('tier', 'ERROR', 'rate', null, 'parcels', null);
  else
    v_eval := public.evaluate_fraud_rules(v_check.metrics, v_ctx);
    v_level := jsonb_build_object(
      'tier', coalesce(v_check.metrics ->> 'receive_rate_tier', 'ERROR'),
      'rate', v_check.metrics -> 'receive_rate',
      'parcels', v_check.metrics -> 'parcel_count');
  end if;
  v_decision := v_eval ->> 'decision';
  v_amount := nullif((v_eval ->> 'advance_amount')::numeric, 0);

  if v_decision = 'BLOCK' then
    return jsonb_build_object('decision', 'block', 'reason', coalesce(v_reason, 'RULE'), 'levels', v_levels, 'level', v_level,
      'message', coalesce(nullif(v_eval ->> 'customer_message', ''), v_blocked), 'why', v_eval ->> 'reason');
  end if;
  if v_decision = 'ADVANCE_REQUIRED' then
    v_message := coalesce(nullif(v_eval ->> 'customer_message', ''), nullif(v_cfg ->> 'message', ''),
      'To confirm this order, please pay {amount} in advance.');
    return jsonb_build_object('decision', 'advance', 'reason', coalesce(v_reason, 'ADVANCE'), 'advance_amount', v_amount,
      'levels', v_levels, 'level', v_level, 'why', v_eval ->> 'reason',
      'message', replace(v_message, '{amount}', coalesce(public.money(v_amount)::text || ' tk', 'the delivery charge')));
  end if;
  -- ALLOW, or REVIEW (the order is taken and held for the team in Fullfilio).
  return jsonb_build_object('decision', 'allow', 'reason', coalesce(v_reason, case when v_decision = 'REVIEW' then 'REVIEW' else 'ALLOW' end),
    'levels', v_levels, 'level', v_level, 'why', v_eval ->> 'reason');
end;
$$;

grant execute on function public.channel_checkout_decision(uuid, text, text, text, uuid, numeric, numeric, boolean) to service_role;
alter function public.channel_checkout_decision(uuid, text, text, text, uuid, numeric, numeric, boolean) owner to app_owner;

-- An advance with no order total known yet (a check recorded before the order exists)
-- is the configured amount, not 0: the cap at the order total applies once it is known.
create or replace function public.compute_advance_amount(p_type public.advance_type, p_value numeric, p_order_total numeric, p_delivery_charge numeric, p_return_charge numeric)
returns numeric
language sql
immutable
set search_path = public, pg_temp
as $$
  select least(
    ceil(case p_type
      when 'NONE' then 0
      when 'FIXED' then coalesce(p_value, 0)
      when 'DELIVERY_CHARGE' then coalesce(p_delivery_charge, 0)
      when 'DELIVERY_PLUS_RETURN' then coalesce(p_delivery_charge, 0) + coalesce(p_return_charge, 0)
      when 'PERCENTAGE' then coalesce(p_order_total, 0) * coalesce(p_value, 0) / 100
      when 'FULL' then coalesce(p_order_total, 0)
    end),
    coalesce(p_order_total, 'Infinity'::numeric)
  )::numeric(12,2)
$$;

-- Courier lookups started by a storefront checkout (before the order is placed) spend the
-- store's lookups, and the page is public: at most 10 an hour per visitor and, by default,
-- 300 an hour per store (Settings → Fraud: checkout_lookups). A visitor over the limit
-- still gets a decision when the order is placed.
create or replace function public.checkout_lookup_allowed(p_ip text)
returns boolean
language plpgsql
stable
security definer
set search_path = public, pg_temp
as $$
declare
  v_hash text := encode(sha256(convert_to(coalesce(nullif(p_ip, ''), 'unknown'), 'UTF8')), 'hex');
begin
  perform public._require_system();
  return (select count(*) from public.fraud_checks
          where created_at > now() - interval '1 hour' and context ->> 'origin' = 'checkout' and context ->> 'ip_hash' = v_hash)
           < public.setting_numeric('fraud', array['checkout_lookups', 'per_visitor'], 10)
     and (select count(*) from public.fraud_checks
          where created_at > now() - interval '1 hour' and context ->> 'origin' = 'checkout')
           < public.setting_numeric('fraud', array['checkout_lookups', 'per_hour'], 300);
end;
$$;

alter function public.checkout_lookup_allowed(text) owner to app_owner;
