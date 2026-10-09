-- =============================================================================
-- Courier history: couriers that report only a rate
--   BD Courier returns some couriers (Steadfast) as a success rate and a parcel
--   range such as "50+" with no counts, and works out its overall rate as the
--   average of each courier's rate. The edge function now sends that overall
--   rate as provider_courier_score and the lower end of the ranges as
--   provider_parcel_floor, so a "50+" history is not mistaken for a new
--   customer by the delivery-success policy.
-- =============================================================================

create or replace function public._receive_rate_facts(p_facts jsonb)
returns jsonb
language plpgsql
stable
security definer
set search_path = public, pg_temp
as $$
declare
  v_cfg jsonb := coalesce(public.get_setting('fraud') -> 'receive_rate', '{}'::jsonb);
  v_rate numeric := nullif(p_facts ->> 'courier_score', '')::numeric;
  v_parcels int := coalesce((p_facts ->> 'delivered_orders')::int, 0) + coalesce((p_facts ->> 'cancelled_orders')::int, 0)
                 + coalesce((p_facts ->> 'returned_orders')::int, 0) + coalesce((p_facts ->> 'failed_delivery_orders')::int, 0);
  v_tier text;
begin
  -- A courier that only reports a range ("50+") still proves history.
  v_parcels := greatest(v_parcels, coalesce((p_facts ->> 'provider_parcels')::int, 0));
  if v_rate is null or v_parcels < coalesce((v_cfg ->> 'min_parcels')::int, 1) then
    -- No usable history: a failed provider lookup is not the same as a new customer.
    v_tier := case when p_facts ->> 'provider_status' = 'ERROR' then 'ERROR' else 'NEW' end;
  elsif v_rate >= coalesce((v_cfg ->> 'good_min')::numeric, 80) then
    v_tier := 'GOOD';
  elsif v_rate >= coalesce((v_cfg ->> 'mid_min')::numeric, 50) then
    v_tier := 'MID';
  else
    v_tier := 'LOW';
  end if;
  return jsonb_build_object('receive_rate', v_rate, 'receive_rate_tier', v_tier, 'parcel_count', v_parcels);
end;
$$;

create or replace function public.record_fraud_check(p_input jsonb)
returns public.fraud_checks
language plpgsql
security definer
set search_path = public, pg_temp
as $$
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

  v_score := public.compute_risk_score(v_m);
  if v_status = 'ERROR' and public.setting_text('fraud', array['on_provider_error'], 'REVIEW') = 'REVIEW'
     and (p_input ->> 'provider') <> 'internal' then
    -- Provider unavailable: never silently pass a check that did not run.
    v_score := greatest(v_score, public.setting_numeric('fraud', array['thresholds', 'high'], 60));
  end if;
  v_level := public.risk_level_for_score(v_score);
  v_m := v_m || jsonb_build_object('risk_score', v_score, 'risk_level', v_level);

  v_eval := public.evaluate_fraud_rules(v_m, v_context);

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

  if v_check.customer_id is not null then
    update public.customers set risk_level = v_level, last_fraud_score = v_score, last_fraud_check_at = now()
    where id = v_check.customer_id;
    perform public.refresh_customer_stats(v_check.customer_id);
  end if;
  return v_check;
end;
$$;
