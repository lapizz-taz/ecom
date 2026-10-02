-- =============================================================================
-- 1400 · Checkout & fulfilment:
--   * delivery-success ("receive rate") policy for the phone check at checkout
--   * automatic merge of repeat checkouts and duplicate-order detection
--   * shipping labels (print tracking) and parcel scanning (RTS / shipped / returned)
--   * courier API credentials kept in Supabase Vault, never in readable tables
-- =============================================================================

-- -----------------------------------------------------------------------------
-- Permission and settings
-- -----------------------------------------------------------------------------
insert into public.permissions(code, module, name) values
  ('orders.fulfill', 'orders', 'Print labels and scan parcels')
on conflict (code) do nothing;

insert into public.role_permissions(role_id, permission_id)
select r.id, p.id
from public.roles r
join public.permissions p on p.code = 'orders.fulfill'
-- Packing needs to see orders, so only roles with orders.view get it.
where r.code in ('ADMIN', 'MANAGER', 'ORDER_MANAGER', 'PRODUCTION_MANAGER')
on conflict do nothing;

-- Delivery-success policy: the customer's courier receive rate decides
-- between cash on delivery and an advance. Off until enabled in Settings.
update public.settings set value = value || jsonb_build_object('receive_rate', jsonb_build_object(
  'enabled', false,
  'good_min', 80,
  'mid_min', 50,
  'min_parcels', 1,
  'actions', jsonb_build_object('GOOD', 'COD', 'MID', 'ADVANCE', 'LOW', 'ADVANCE', 'NEW', 'COD', 'ERROR', 'ADVANCE'),
  'advance_type', 'FIXED',
  'advance_amount', 55,
  'message', 'To confirm this order, please pay the {amount} delivery charge in advance with bKash or Nagad.'
))
where key = 'fraud' and not (value ? 'receive_rate');

update public.settings set value = value || jsonb_build_object(
  'auto_merge_enabled', true,
  'auto_merge_minutes', 3,
  'duplicate_check_enabled', true,
  'duplicate_window_hours', 24
)
where key = 'orders' and not (value ? 'auto_merge_enabled');

insert into public.settings(key, is_public, description, value) values
('fulfillment', false, 'Shipping labels and parcel scanning', jsonb_build_object(
  'label_size', '100x150',
  'require_label_before_rts', false,
  'show_cod_on_label', true,
  'show_items_on_label', true,
  'label_note', ''
))
on conflict (key) do nothing;

-- -----------------------------------------------------------------------------
-- Order columns
-- -----------------------------------------------------------------------------
alter table public.orders
  add column duplicate_of uuid references public.orders(id) on delete set null,
  add column duplicate_status text check (duplicate_status in ('SUSPECTED', 'DISMISSED', 'MERGED')),
  add column merged_into uuid references public.orders(id) on delete set null,
  add column merged_count int not null default 0 check (merged_count >= 0),
  add column label_printed_at timestamptz,
  add column label_last_printed_at timestamptz,
  add column label_printed_by uuid,
  add column label_print_count int not null default 0 check (label_print_count >= 0);

create index orders_duplicate_suspected_idx on public.orders(created_at desc) where duplicate_status = 'SUSPECTED';
create index orders_label_unprinted_idx on public.orders(status) where label_printed_at is null;
create index orders_shipped_at_idx on public.orders(shipped_at) where shipped_at is not null;

-- Every merge (automatic or by staff), kept as evidence.
create table public.order_merges (
  id uuid primary key default gen_random_uuid(),
  order_id uuid not null references public.orders(id) on delete cascade,
  source_order_id uuid references public.orders(id) on delete set null,
  kind text not null check (kind in ('AUTO', 'MANUAL')),
  idempotency_key text unique,
  items jsonb not null default '[]'::jsonb,
  amount numeric(12,2) not null default 0,
  created_by uuid,
  created_at timestamptz not null default now()
);
create index order_merges_order_idx on public.order_merges(order_id, created_at);
create trigger order_merges_immutable before update or delete on public.order_merges
  for each row execute function public.prevent_mutation();

-- Every scan at the packing desk, including failed ones.
create table public.parcel_scans (
  id uuid primary key default gen_random_uuid(),
  code text not null,
  action text not null check (action in ('READY_TO_SHIP', 'SHIPPED', 'RETURNED', 'LOOKUP')),
  order_id uuid references public.orders(id) on delete set null,
  order_number text,
  result text not null check (result in ('OK', 'ALREADY', 'ERROR', 'NOT_FOUND')),
  message text,
  from_status public.order_status,
  to_status public.order_status,
  courier_id uuid references public.couriers(id) on delete set null,
  scanned_by uuid,
  scanned_by_name text,
  created_at timestamptz not null default now()
);
create index parcel_scans_created_idx on public.parcel_scans(created_at desc);
create index parcel_scans_order_idx on public.parcel_scans(order_id, created_at desc);
create trigger parcel_scans_immutable before update or delete on public.parcel_scans
  for each row execute function public.prevent_mutation();

-- Courier API credentials: the secret itself lives in Vault (encrypted);
-- this table only links a courier to its secret. No API role can read it.
create table public.courier_credentials (
  courier_id uuid primary key references public.couriers(id) on delete cascade,
  provider text not null,
  secret_id uuid,
  hint text,
  connected_by uuid,
  connected_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

-- -----------------------------------------------------------------------------
-- Delivery-success ("receive rate") policy
-- -----------------------------------------------------------------------------
-- Facts derived from the check: success rate %, parcel count and tier.
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

-- Same engine as before, plus the receive-rate policy (when enabled) and the
-- receive_rate / receive_rate_tier / parcel_count facts for custom rules.
create or replace function public.evaluate_fraud_rules(p_metrics jsonb, p_context jsonb)
returns jsonb
language plpgsql
stable
security definer
set search_path = public, pg_temp
as $$
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
      'name', 'Delivery success ' || initcap(v_tier) || coalesce(' (' || round((v_facts ->> 'receive_rate')::numeric) || '%)', ''),
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

  return jsonb_build_object(
    'decision', v_decision,
    'advance_type', case when v_decision in ('ADVANCE_REQUIRED', 'REVIEW') then v_advance_type else 'NONE' end,
    'advance_amount', case when v_decision in ('ADVANCE_REQUIRED', 'REVIEW') then v_advance else 0 end,
    'customer_message', v_message,
    'matched_rules', v_matched_rules,
    'receive_rate_tier', v_facts ->> 'receive_rate_tier'
  );
end;
$$;

-- record_fraud_check now keeps the provider status and receive-rate facts in
-- the stored metrics (so a failed provider lookup is never mistaken for a new
-- customer later).
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

-- -----------------------------------------------------------------------------
-- Duplicate detection and merging
-- -----------------------------------------------------------------------------
create or replace function public.normalize_address(p_address text)
returns text
language sql
immutable
set search_path = public, pg_temp
as $$
  select nullif(trim(regexp_replace(lower(coalesce(p_address, '')), '[[:space:],.#/\\-]+', ' ', 'g')), '')
$$;

-- Flags a new order that looks like a repeat of another open order (same
-- phone, or same address in the same district) within the duplicate window.
create or replace function public._flag_possible_duplicate(p_order_id uuid)
returns uuid
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_order public.orders;
  v_dup public.orders;
  v_reason text;
begin
  if not public.setting_bool('orders', array['duplicate_check_enabled'], true) then
    return null;
  end if;
  select * into v_order from public.orders where id = p_order_id;
  if not found or v_order.status in ('CANCELLED', 'REJECTED_FRAUD') then
    return null;
  end if;

  select d.* into v_dup
  from public.orders d
  where d.id <> v_order.id
    and d.created_at <= v_order.created_at
    and d.created_at >= v_order.created_at
        - make_interval(hours => public.setting_numeric('orders', array['duplicate_window_hours'], 24)::int)
    and d.status not in ('CANCELLED', 'REJECTED_FRAUD')
    and d.merged_into is null
    and (d.customer_phone = v_order.customer_phone
         or (public.normalize_address(d.shipping_address) = public.normalize_address(v_order.shipping_address)
             and lower(d.shipping_district) = lower(v_order.shipping_district)))
  order by d.created_at desc
  limit 1;
  if not found then
    return null;
  end if;

  v_reason := case when v_dup.customer_phone = v_order.customer_phone then 'same phone number' else 'same delivery address' end;
  update public.orders set duplicate_of = v_dup.id, duplicate_status = 'SUSPECTED' where id = v_order.id;
  perform public._order_log(v_order.id, 'DUPLICATE_SUSPECTED',
    format('Possible duplicate of %s (%s)', v_dup.order_number, v_reason), null, null,
    jsonb_build_object('duplicate_of', v_dup.id, 'order_number', v_dup.order_number, 'reason', v_reason));
  perform public._order_log(v_dup.id, 'DUPLICATE_SUSPECTED',
    format('%s may be a duplicate of this order (%s)', v_order.order_number, v_reason), null, null,
    jsonb_build_object('duplicate', v_order.id, 'order_number', v_order.order_number, 'reason', v_reason));
  return v_dup.id;
end;
$$;

-- Finds a recent open storefront order that a new checkout should be added to:
-- same phone, same address and district, same payment and delivery method,
-- placed within the auto-merge window, not yet labelled or handed to a courier,
-- and where the merged order would not need a stricter risk decision.
create or replace function public._find_merge_target(p_payload jsonb, p_fraud_check_id uuid)
returns public.orders
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_target public.orders;
  v_phone text := public.clean_phone(p_payload #>> '{customer,phone}');
  v_check public.fraud_checks;
  v_quote jsonb;
  v_eval jsonb;
  v_fraud_enabled boolean := public.setting_bool('fraud', array['enabled'], true);
begin
  if not public.setting_bool('orders', array['auto_merge_enabled'], true)
     or v_phone is null
     or nullif(trim(coalesce(p_payload ->> 'coupon_code', '')), '') is not null then
    return null;
  end if;

  select o.* into v_target
  from public.orders o
  join public.customers c on c.id = o.customer_id
  where o.customer_phone = v_phone
    and o.source = 'STOREFRONT'
    and o.merged_into is null
    and c.status <> 'BLOCKED'
    and o.created_at >= now() - make_interval(mins => public.setting_numeric('orders', array['auto_merge_minutes'], 3)::int)
    and o.status in ('PENDING', 'FRAUD_CHECK', 'ADVANCE_REQUIRED', 'FRAUD_REVIEW', 'CONFIRMATION_REQUIRED', 'CONFIRMED')
    and o.payment_method = coalesce(nullif(p_payload ->> 'payment_method', ''), 'COD')::public.payment_method
    and o.delivery_method = coalesce(nullif(p_payload ->> 'delivery_method', ''), 'standard')
    and lower(o.shipping_district) = lower(trim(coalesce(p_payload #>> '{shipping,district}', '')))
    and public.normalize_address(o.shipping_address) = public.normalize_address(p_payload #>> '{shipping,address}')
    and o.label_printed_at is null
    and not exists (select 1 from public.shipments s where s.order_id = o.id and s.is_active)
  order by o.created_at desc
  limit 1
  for update of o;
  if not found then
    return null;
  end if;

  -- The merged order must not deserve a stricter decision than it already got.
  if v_fraud_enabled then
    select * into v_check from public.fraud_checks where id = p_fraud_check_id;
    if not found then
      return null;
    end if;
    v_quote := public.calculate_order_quote(p_payload -> 'items', v_target.shipping_district, v_target.shipping_area,
      v_target.delivery_method, null, v_phone, false, false);
    v_eval := public.evaluate_fraud_rules(v_check.metrics, jsonb_build_object(
      'order_value', v_target.total_amount + coalesce((v_quote ->> 'subtotal')::numeric, 0),
      'subtotal', v_target.subtotal + coalesce((v_quote ->> 'subtotal')::numeric, 0),
      'delivery_charge', v_target.delivery_charge, 'return_charge', v_target.return_charge,
      'district', v_target.shipping_district, 'area', v_target.shipping_area,
      'payment_method', v_target.payment_method, 'source', v_target.source));
    if public.decision_severity((v_eval ->> 'decision')::public.fraud_decision)
         > public.decision_severity(coalesce(v_target.fraud_decision, 'ALLOW'))
       or coalesce((v_eval ->> 'advance_amount')::numeric, 0) > v_target.advance_required then
      return null;
    end if;
  end if;
  return v_target;
end;
$$;

-- Adds priced lines to an order and reserves their stock.
create or replace function public._add_order_lines(p_order public.orders, p_lines jsonb)
returns int
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_line jsonb;
  v_item public.order_items;
  v_count int := 0;
begin
  for v_line in select * from jsonb_array_elements(coalesce(p_lines, '[]'::jsonb)) loop
    insert into public.order_items(
      order_id, product_id, variant_id, product_name, variant_title, sku, image_url, unit_price, unit_cost,
      quantity, line_subtotal, discount_amount, line_total, track_inventory, requires_production
    ) values (
      p_order.id, (v_line ->> 'product_id')::uuid, (v_line ->> 'variant_id')::uuid, v_line ->> 'product_name',
      nullif(v_line ->> 'variant_title', 'Default'), v_line ->> 'sku', v_line ->> 'image_url',
      (v_line ->> 'unit_price')::numeric, (v_line ->> 'unit_cost')::numeric, (v_line ->> 'quantity')::int,
      (v_line ->> 'line_subtotal')::numeric, 0, (v_line ->> 'line_subtotal')::numeric,
      coalesce((v_line ->> 'track_inventory')::boolean, true), coalesce((v_line ->> 'requires_production')::boolean, false)
    ) returning * into v_item;
    perform public._reserve_order_item(v_item, p_order.order_number);
    v_count := v_count + v_item.quantity;
  end loop;
  return v_count;
end;
$$;

-- Adds a repeat checkout to an existing order (one parcel, one delivery charge).
create or replace function public._merge_checkout_into(p_target_id uuid, p_payload jsonb)
returns public.orders
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_target public.orders;
  v_quote jsonb;
  v_qty int;
  v_before numeric;
  v_note text := nullif(trim(coalesce(p_payload ->> 'customer_note', '')), '');
begin
  select * into v_target from public.orders where id = p_target_id for update;
  v_before := v_target.total_amount;
  v_quote := public.calculate_order_quote(p_payload -> 'items', v_target.shipping_district, v_target.shipping_area,
    v_target.delivery_method, null, v_target.customer_phone, false, false);
  v_qty := public._add_order_lines(v_target, v_quote -> 'lines');

  update public.orders set
    merged_count = merged_count + 1,
    customer_note = case when v_note is null then customer_note else concat_ws(E'\n', customer_note, v_note) end
  where id = p_target_id;
  v_target := public.recalculate_order_totals(p_target_id);

  insert into public.order_merges(order_id, kind, idempotency_key, items, amount)
  values (p_target_id, 'AUTO', nullif(p_payload ->> 'idempotency_key', ''), v_quote -> 'lines',
          v_target.total_amount - v_before);

  perform public._order_log(p_target_id, 'ORDER_MERGED',
    format('Customer checked out again within %s min — %s item(s) added to this order',
      public.setting_numeric('orders', array['auto_merge_minutes'], 3), v_qty),
    null, null, jsonb_build_object('added_items', v_quote -> 'lines', 'added_amount', v_target.total_amount - v_before,
      'idempotency_key', p_payload ->> 'idempotency_key'), true);
  perform public.log_audit('order.auto_merged', 'order', p_target_id::text,
    jsonb_build_object('total', v_before), jsonb_build_object('total', v_target.total_amount),
    jsonb_build_object('order_number', v_target.order_number, 'added_items', v_qty));
  perform public.refresh_customer_stats(v_target.customer_id);
  return v_target;
end;
$$;

-- Storefront checkout: a retry or a repeat checkout within the merge window
-- returns the existing order; anything else creates a new order, applies the
-- risk decision and checks for duplicates — all in one transaction.
create or replace function public.place_storefront_order(p_payload jsonb, p_fraud_check_id uuid default null)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_order public.orders;
  v_target public.orders;
  v_key text := nullif(p_payload ->> 'idempotency_key', '');
  v_is_new boolean;
  v_merged boolean := false;
begin
  if not public.is_system_context() then
    raise exception 'PERMISSION_DENIED' using errcode = '42501';
  end if;

  if v_key is not null then
    select o.* into v_order from public.order_merges m join public.orders o on o.id = m.order_id
    where m.idempotency_key = v_key;
    v_merged := found;
  end if;

  if not v_merged then
    v_is_new := v_key is null or not exists (select 1 from public.orders where idempotency_key = v_key);
    if v_is_new then
      v_target := public._find_merge_target(p_payload, p_fraud_check_id);
      if v_target.id is not null then
        v_order := public._merge_checkout_into(v_target.id, p_payload);
        v_merged := true;
      end if;
    end if;
  end if;

  if not v_merged then
    v_order := public._create_order(p_payload, 'STOREFRONT');
    if v_is_new then
      v_order := public._apply_fraud_decision(v_order.id, p_fraud_check_id);
      perform public._flag_possible_duplicate(v_order.id);
    end if;
  end if;

  return public._order_public_json(v_order) || jsonb_build_object(
    'merged', v_merged,
    'payment_requirement', public.payment_requirement_for(
      coalesce(v_order.fraud_decision, 'ALLOW'), v_order.advance_required, v_order.total_amount, v_order.payment_method));
end;
$$;

create or replace function public.admin_create_order(p_payload jsonb, p_confirm boolean default false)
returns public.orders
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_order public.orders;
  v_is_new boolean := nullif(p_payload ->> 'idempotency_key', '') is null
    or not exists (select 1 from public.orders where idempotency_key = p_payload ->> 'idempotency_key');
begin
  perform public.require_permission('orders.create');
  v_order := public._create_order(p_payload, 'ADMIN');
  if p_confirm then
    v_order := public._transition_order(v_order.id, 'CONFIRMED', 'Confirmed by staff when the order was created');
  end if;
  if v_is_new then
    perform public._flag_possible_duplicate(v_order.id);
    select * into v_order from public.orders where id = v_order.id;
  end if;
  perform public.log_audit('order.created', 'order', v_order.id::text, null,
    jsonb_build_object('order_number', v_order.order_number, 'total', v_order.total_amount));
  return v_order;
end;
$$;

-- Staff: merge a duplicate into another order. Items (and their stock
-- reservations) move to the target; the duplicate is cancelled as merged.
create or replace function public.admin_merge_orders(p_order_id uuid, p_into_order_id uuid)
returns public.orders
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_source public.orders;
  v_target public.orders;
  v_lines jsonb;
  v_before numeric;
  v_qty int;
  v_mergeable public.order_status[] := array['PENDING', 'FRAUD_CHECK', 'ADVANCE_REQUIRED', 'FRAUD_REVIEW',
    'CONFIRMATION_REQUIRED', 'CONFIRMED']::public.order_status[];
begin
  perform public.require_permission('orders.update');
  if p_order_id = p_into_order_id then
    raise exception 'VALIDATION: choose a different order to merge into' using errcode = '22023';
  end if;
  -- Lock in a fixed order so two staff merging the same pair cannot deadlock.
  perform 1 from public.orders where id in (p_order_id, p_into_order_id) order by id for update;
  select * into v_source from public.orders where id = p_order_id;
  select * into v_target from public.orders where id = p_into_order_id;
  if v_source.id is null or v_target.id is null then
    raise exception 'NOT_FOUND: order not found' using errcode = 'P0002';
  end if;
  if not (v_source.status = any(v_mergeable)) or not (v_target.status = any(v_mergeable)) then
    raise exception 'VALIDATION: only orders that have not started processing can be merged' using errcode = '22023';
  end if;
  if v_source.merged_into is not null or v_target.merged_into is not null then
    raise exception 'VALIDATION: this order was already merged' using errcode = '22023';
  end if;
  if v_source.amount_paid > 0 or exists (select 1 from public.payments where order_id = v_source.id
                                          and status = 'REQUIRES_VERIFICATION') then
    raise exception 'VALIDATION: % has a payment — verify or refund it before merging', v_source.order_number
      using errcode = '22023';
  end if;
  if exists (select 1 from public.shipments where order_id in (v_source.id, v_target.id) and is_active) then
    raise exception 'VALIDATION: remove the courier assignment before merging' using errcode = '22023';
  end if;

  select coalesce(jsonb_agg(jsonb_build_object(
      'product_id', product_id, 'variant_id', variant_id, 'product_name', product_name,
      'variant_title', coalesce(variant_title, 'Default'), 'sku', sku, 'image_url', image_url,
      'unit_price', unit_price, 'unit_cost', unit_cost, 'quantity', quantity, 'line_subtotal', line_subtotal,
      'track_inventory', track_inventory, 'requires_production', requires_production) order by created_at), '[]'::jsonb)
  into v_lines from public.order_items where order_id = v_source.id;

  v_before := v_target.total_amount;
  perform public._release_order_stock(v_source.id, format('Released: merged into %s', v_target.order_number));
  v_qty := public._add_order_lines(v_target, v_lines);
  update public.orders set merged_count = merged_count + 1,
    duplicate_status = case when duplicate_of = v_source.id then 'MERGED' else duplicate_status end
  where id = v_target.id;
  v_target := public.recalculate_order_totals(v_target.id);

  update public.orders set merged_into = v_target.id, duplicate_status = 'MERGED' where id = v_source.id;
  perform public._transition_order(v_source.id, 'CANCELLED', format('Merged into %s', v_target.order_number),
    jsonb_build_object('merged_into', v_target.id));
  -- A merge is not a cancellation for the customer: drop that message.
  update public.notification_logs set status = 'SKIPPED', error = 'Order merged'
  where order_id = v_source.id and event = 'ORDER_CANCELLED' and status = 'QUEUED';

  insert into public.order_merges(order_id, source_order_id, kind, items, amount, created_by)
  values (v_target.id, v_source.id, 'MANUAL', v_lines, v_target.total_amount - v_before, auth.uid());
  perform public._order_log(v_target.id, 'ORDER_MERGED',
    format('%s merged into this order (%s item(s))', v_source.order_number, v_qty), null, null,
    jsonb_build_object('source_order_id', v_source.id, 'order_number', v_source.order_number,
      'added_amount', v_target.total_amount - v_before));
  perform public.log_audit('order.merged', 'order', v_target.id::text,
    jsonb_build_object('total', v_before), jsonb_build_object('total', v_target.total_amount),
    jsonb_build_object('order_number', v_target.order_number, 'merged_order', v_source.order_number));
  perform public.refresh_customer_stats(v_target.customer_id);
  return v_target;
end;
$$;

create or replace function public.admin_dismiss_duplicate(p_order_id uuid)
returns public.orders
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_order public.orders;
begin
  perform public.require_permission('orders.update');
  update public.orders set duplicate_status = 'DISMISSED'
  where id = p_order_id and duplicate_status = 'SUSPECTED'
  returning * into v_order;
  if not found then
    raise exception 'NOT_FOUND: no duplicate warning on this order' using errcode = 'P0002';
  end if;
  perform public._order_log(p_order_id, 'DUPLICATE_DISMISSED', 'Marked as not a duplicate');
  perform public.log_audit('order.duplicate_dismissed', 'order', p_order_id::text, null, null,
    jsonb_build_object('order_number', v_order.order_number));
  return v_order;
end;
$$;

-- -----------------------------------------------------------------------------
-- Shipping labels
-- -----------------------------------------------------------------------------
create or replace function public.mark_labels_printed(p_order_ids uuid[], p_format text default null)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_order public.orders;
  v_first int := 0;
  v_reprint int := 0;
  v_skipped jsonb := '[]'::jsonb;
begin
  perform public.require_permission('orders.fulfill');
  if coalesce(array_length(p_order_ids, 1), 0) = 0 then
    raise exception 'VALIDATION: choose at least one order' using errcode = '22023';
  end if;
  if array_length(p_order_ids, 1) > 500 then
    raise exception 'VALIDATION: print at most 500 labels at a time' using errcode = '22023';
  end if;

  for v_order in select * from public.orders where id = any(p_order_ids) order by created_at for update loop
    if v_order.status in ('CANCELLED', 'REJECTED_FRAUD') then
      v_skipped := v_skipped || jsonb_build_object('order_number', v_order.order_number, 'reason', 'cancelled');
      continue;
    end if;
    update public.orders set
      label_printed_at = coalesce(label_printed_at, now()),
      label_last_printed_at = now(),
      label_printed_by = auth.uid(),
      label_print_count = label_print_count + 1
    where id = v_order.id;
    if v_order.label_printed_at is null then
      v_first := v_first + 1;
      perform public._order_log(v_order.id, 'LABEL_PRINTED', 'Shipping label printed', null, null,
        jsonb_build_object('format', p_format));
    else
      v_reprint := v_reprint + 1;
      perform public._order_log(v_order.id, 'LABEL_REPRINTED',
        format('Shipping label reprinted (print #%s)', v_order.label_print_count + 1), null, null,
        jsonb_build_object('format', p_format, 'print_count', v_order.label_print_count + 1));
    end if;
  end loop;

  perform public.log_audit('order.labels_printed', 'order', null, null, null,
    jsonb_build_object('order_ids', to_jsonb(p_order_ids), 'printed', v_first, 'reprinted', v_reprint, 'format', p_format));
  return jsonb_build_object('printed', v_first, 'reprinted', v_reprint, 'skipped', v_skipped);
end;
$$;

-- -----------------------------------------------------------------------------
-- Parcel scanning (packing desk): READY_TO_SHIP, SHIPPED, RETURNED, LOOKUP
-- -----------------------------------------------------------------------------
create or replace function public._scan_summary(p_order_id uuid)
returns jsonb
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  select jsonb_build_object(
    'id', o.id, 'order_number', o.order_number, 'status', o.status, 'customer_name', o.customer_name,
    'customer_phone', o.customer_phone, 'shipping_district', o.shipping_district, 'cod_amount', o.cod_amount,
    'total_amount', o.total_amount, 'label_printed_at', o.label_printed_at,
    'item_count', (select coalesce(sum(quantity), 0) from public.order_items where order_id = o.id),
    'courier_name', (select c.name from public.shipments s join public.couriers c on c.id = s.courier_id
                     where s.order_id = o.id and s.is_active limit 1),
    'tracking_number', (select s.tracking_number from public.shipments s where s.order_id = o.id and s.is_active limit 1))
  from public.orders o where o.id = p_order_id
$$;

-- Moves a confirmed order forward to READY_TO_SHIP (through PROCESSING when needed).
create or replace function public._scan_to_ready(p_order public.orders, p_note text)
returns public.orders
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_order public.orders := p_order;
begin
  if v_order.status in ('PENDING', 'FRAUD_CHECK', 'ADVANCE_REQUIRED', 'FRAUD_REVIEW', 'CONFIRMATION_REQUIRED') then
    raise exception 'VALIDATION: not confirmed yet (%) — do not pack this parcel', replace(lower(v_order.status::text), '_', ' ')
      using errcode = '22023';
  end if;
  if v_order.status in ('PRODUCTION', 'QUALITY_CHECK') then
    raise exception 'VALIDATION: still in production' using errcode = '22023';
  end if;
  if v_order.status not in ('CONFIRMED', 'PROCESSING', 'PACKING') then
    raise exception 'VALIDATION: a % order cannot be marked ready to ship', replace(lower(v_order.status::text), '_', ' ')
      using errcode = '22023';
  end if;
  if exists (select 1 from public.order_items where order_id = v_order.id and requires_production)
     and not exists (select 1 from public.production_orders where order_id = v_order.id and status = 'READY') then
    raise exception 'VALIDATION: made-to-order items are not ready yet' using errcode = '22023';
  end if;
  if public.setting_bool('fulfillment', array['require_label_before_rts'], false) and v_order.label_printed_at is null then
    raise exception 'VALIDATION: print the shipping label first' using errcode = '22023';
  end if;
  if v_order.status = 'CONFIRMED' then
    v_order := public._transition_order(v_order.id, 'PROCESSING', p_note);
  end if;
  return public._transition_order(v_order.id, 'READY_TO_SHIP', p_note);
end;
$$;

create or replace function public.scan_parcel(p_code text, p_action text, p_courier_id uuid default null)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_code text := upper(regexp_replace(coalesce(p_code, ''), '\s', '', 'g'));
  v_action text := upper(coalesce(p_action, 'LOOKUP'));
  v_order public.orders;
  v_from public.order_status;
  v_result text := 'OK';
  v_message text;
  v_note text;
begin
  perform public.require_permission('orders.fulfill');
  if v_action not in ('READY_TO_SHIP', 'SHIPPED', 'RETURNED', 'LOOKUP') then
    raise exception 'VALIDATION: unknown scan action' using errcode = '22023';
  end if;
  if length(v_code) < 3 or length(v_code) > 64 then
    raise exception 'VALIDATION: scan a valid order or tracking barcode' using errcode = '22023';
  end if;

  select * into v_order from public.orders where upper(order_number) = v_code for update;
  if not found then
    select o.* into v_order from public.shipments s join public.orders o on o.id = s.order_id
    where s.is_active and (upper(s.tracking_number) = v_code or upper(s.consignment_id) = v_code)
    order by s.created_at desc limit 1;
    if found then
      select * into v_order from public.orders where id = v_order.id for update;
    end if;
  end if;

  if v_order.id is null then
    insert into public.parcel_scans(code, action, result, message, courier_id, scanned_by, scanned_by_name)
    values (v_code, v_action, 'NOT_FOUND', 'No order matches this barcode', p_courier_id, auth.uid(), public.actor_display_name());
    return jsonb_build_object('result', 'NOT_FOUND', 'message', 'No order matches this barcode', 'code', v_code);
  end if;

  v_from := v_order.status;
  v_note := 'Scanned at packing desk';
  begin
    if v_action = 'LOOKUP' then
      v_message := 'Found';
    elsif v_order.status in ('CANCELLED', 'REJECTED_FRAUD') then
      v_result := 'ERROR';
      v_message := 'Order is cancelled — do not ship';
    elsif v_action = 'READY_TO_SHIP' then
      if v_order.status = 'READY_TO_SHIP' then
        v_result := 'ALREADY';
        v_message := 'Already ready to ship';
      elsif v_order.status in ('SHIPPED', 'DELIVERED', 'FAILED_DELIVERY', 'RETURN_REQUESTED', 'RETURNED') then
        v_result := 'ALREADY';
        v_message := 'Already ' || replace(lower(v_order.status::text), '_', ' ');
      else
        v_order := public._scan_to_ready(v_order, v_note);
        v_message := 'Ready to ship';
      end if;
    elsif v_action = 'SHIPPED' then
      if v_order.status = 'SHIPPED' then
        v_result := 'ALREADY';
        v_message := 'Already shipped';
      elsif v_order.status in ('DELIVERED', 'FAILED_DELIVERY', 'RETURN_REQUESTED', 'RETURNED') then
        v_result := 'ALREADY';
        v_message := 'Already ' || replace(lower(v_order.status::text), '_', ' ');
      else
        if v_order.status <> 'READY_TO_SHIP' then
          v_order := public._scan_to_ready(v_order, v_note);
        end if;
        if p_courier_id is not null
           and not exists (select 1 from public.shipments where order_id = v_order.id and is_active) then
          perform public.assign_courier(v_order.id, p_courier_id, null, null, 'Assigned at packing desk');
        end if;
        v_order := public._transition_order(v_order.id, 'SHIPPED', 'Handed to courier (scanned)');
        v_message := 'Shipped';
      end if;
    elsif v_action = 'RETURNED' then
      if v_order.status = 'RETURNED' then
        v_result := 'ALREADY';
        v_message := 'Already received back';
      elsif v_order.status = 'SHIPPED' then
        v_order := public._transition_order(v_order.id, 'FAILED_DELIVERY', 'Parcel came back (scanned)');
        v_order := public._transition_order(v_order.id, 'RETURNED', 'Returned parcel received (scanned)');
        v_message := 'Returned to stock';
      elsif v_order.status = 'DELIVERED' then
        v_order := public._transition_order(v_order.id, 'RETURN_REQUESTED', 'Customer return arrived (scanned)');
        v_order := public._transition_order(v_order.id, 'RETURNED', 'Returned parcel received (scanned)');
        v_message := 'Returned to stock';
      elsif v_order.status in ('FAILED_DELIVERY', 'RETURN_REQUESTED') then
        v_order := public._transition_order(v_order.id, 'RETURNED', 'Returned parcel received (scanned)');
        v_message := 'Returned to stock';
      else
        v_result := 'ERROR';
        v_message := 'This order has not been shipped';
      end if;
    end if;
  exception when others then
    -- Undo any partial status change but keep the scan in the log.
    v_result := 'ERROR';
    v_message := regexp_replace(sqlerrm, '^[A-Z_]+: ', '');
    select * into v_order from public.orders where id = v_order.id;
  end;

  insert into public.parcel_scans(code, action, order_id, order_number, result, message, from_status, to_status,
                                  courier_id, scanned_by, scanned_by_name)
  values (v_code, v_action, v_order.id, v_order.order_number, v_result, v_message, v_from,
          case when v_order.status <> v_from then v_order.status end, p_courier_id, auth.uid(), public.actor_display_name());
  if v_action <> 'LOOKUP' then
    perform public._order_log(v_order.id, 'PARCEL_SCANNED',
      format('Scanned for %s: %s', replace(lower(v_action), '_', ' '), v_message), null, null,
      jsonb_build_object('action', v_action, 'result', v_result, 'code', v_code));
  end if;

  return jsonb_build_object('result', v_result, 'message', v_message, 'code', v_code,
    'from_status', v_from, 'order', public._scan_summary(v_order.id));
end;
$$;

-- Counts for the fulfilment bar at the top of the orders page.
create or replace function public.admin_fulfillment_summary()
returns jsonb
language plpgsql
stable
security definer
set search_path = public, pg_temp
as $$
declare
  v_today timestamptz := (public._local_date(now())::timestamp at time zone public.store_timezone());
begin
  perform public.require_permission('orders.view');
  return (
    select jsonb_build_object(
      'to_confirm', count(*) filter (where status in ('CONFIRMATION_REQUIRED', 'FRAUD_REVIEW')),
      'advance_pending', count(*) filter (where status = 'ADVANCE_REQUIRED'),
      'to_print', count(*) filter (where status in ('CONFIRMED', 'PROCESSING', 'PACKING', 'READY_TO_SHIP')
                                     and label_printed_at is null),
      'printed', count(*) filter (where status in ('CONFIRMED', 'PROCESSING', 'PACKING') and label_printed_at is not null),
      'ready_to_ship', count(*) filter (where status = 'READY_TO_SHIP'),
      'shipped_today', count(*) filter (where shipped_at >= v_today),
      'duplicates', count(*) filter (where duplicate_status = 'SUSPECTED' and status not in ('CANCELLED', 'REJECTED_FRAUD')),
      'merged_today', count(*) filter (where merged_count > 0 and updated_at >= v_today)
    )
    from public.orders
    where status not in ('DELIVERED', 'RETURNED', 'CANCELLED', 'REJECTED_FRAUD') or shipped_at >= v_today
       or (merged_count > 0 and updated_at >= v_today)
  );
end;
$$;

-- -----------------------------------------------------------------------------
-- Order search: new filters (duplicates, label printed) and list fields
-- -----------------------------------------------------------------------------
create or replace function public.admin_search_orders(
  p_filters jsonb default '{}'::jsonb,
  p_sort text default 'created_at',
  p_direction text default 'desc',
  p_limit int default 25,
  p_offset int default 0
)
returns jsonb
language plpgsql
stable
security definer
set search_path = public, pg_temp
as $$
declare
  v_q text := nullif(trim(coalesce(p_filters ->> 'q', '')), '');
  v_phone text := public.clean_phone(p_filters ->> 'q');
  v_tz text := public.store_timezone();
  v_result jsonb;
  v_statuses public.order_status[];
  v_label text := nullif(p_filters ->> 'label', '');
begin
  perform public.require_permission('orders.view');
  if p_filters ? 'statuses' then
    select array_agg(s::public.order_status) into v_statuses from jsonb_array_elements_text(p_filters -> 'statuses') s;
  elsif nullif(p_filters ->> 'status', '') is not null then
    v_statuses := array[(p_filters ->> 'status')::public.order_status];
  end if;

  with filtered as (
    select o.*
    from public.orders o
    where (v_statuses is null or o.status = any(v_statuses))
      and (nullif(p_filters ->> 'payment_status', '') is null or o.payment_status = (p_filters ->> 'payment_status')::public.payment_status)
      and (nullif(p_filters ->> 'payment_method', '') is null or o.payment_method = (p_filters ->> 'payment_method')::public.payment_method)
      and (nullif(p_filters ->> 'fraud_status', '') is null or o.fraud_status = (p_filters ->> 'fraud_status')::public.fraud_status)
      and (nullif(p_filters ->> 'risk_level', '') is null or o.risk_level = (p_filters ->> 'risk_level')::public.risk_level)
      and (nullif(p_filters ->> 'source', '') is null or o.source = (p_filters ->> 'source')::public.order_source)
      and (nullif(p_filters ->> 'customer_id', '') is null or o.customer_id = (p_filters ->> 'customer_id')::uuid)
      and (nullif(p_filters ->> 'district', '') is null or lower(o.shipping_district) = lower(p_filters ->> 'district'))
      and (nullif(p_filters ->> 'date_from', '') is null or o.created_at >= ((p_filters ->> 'date_from')::date::timestamp at time zone v_tz))
      and (nullif(p_filters ->> 'date_to', '') is null or o.created_at < (((p_filters ->> 'date_to')::date + 1)::timestamp at time zone v_tz))
      and (nullif(p_filters ->> 'courier_id', '') is null or exists (
            select 1 from public.shipments s where s.order_id = o.id and s.is_active and s.courier_id = (p_filters ->> 'courier_id')::uuid))
      and (not coalesce((p_filters ->> 'has_due')::boolean, false) or o.cod_amount > 0)
      and (not coalesce((p_filters ->> 'duplicates')::boolean, false)
           or (o.duplicate_status = 'SUSPECTED' and o.status not in ('CANCELLED', 'REJECTED_FRAUD')))
      and (v_label is null or (v_label = 'printed' and o.label_printed_at is not null)
                           or (v_label = 'not_printed' and o.label_printed_at is null))
      and (v_q is null
        or o.order_number ilike '%' || v_q || '%'
        or (v_phone is not null and length(v_phone) >= 4 and o.customer_phone like '%' || v_phone || '%')
        or o.customer_name ilike '%' || v_q || '%'
        or o.shipping_address ilike '%' || v_q || '%'
        or exists (select 1 from public.shipments s where s.order_id = o.id and (s.tracking_number ilike v_q || '%' or s.consignment_id ilike v_q || '%'))
        or exists (select 1 from public.order_items oi where oi.order_id = o.id and oi.sku ilike v_q || '%'))
  ), counted as (
    select count(*) as total from filtered
  ), page as (
    select f.* from filtered f
    order by
      case when p_direction = 'asc' and p_sort = 'created_at' then f.created_at end asc,
      case when p_direction <> 'asc' and p_sort = 'created_at' then f.created_at end desc,
      case when p_direction = 'asc' and p_sort = 'total_amount' then f.total_amount end asc,
      case when p_direction <> 'asc' and p_sort = 'total_amount' then f.total_amount end desc,
      case when p_direction = 'asc' and p_sort = 'order_number' then f.order_number end asc,
      case when p_direction <> 'asc' and p_sort = 'order_number' then f.order_number end desc,
      case when p_direction = 'asc' and p_sort = 'status' then f.status end asc,
      case when p_direction <> 'asc' and p_sort = 'status' then f.status end desc,
      f.created_at desc
    limit least(greatest(p_limit, 1), 200) offset greatest(p_offset, 0)
  )
  select jsonb_build_object(
    'total', (select total from counted),
    'items', coalesce((select jsonb_agg(jsonb_build_object(
      'id', p.id, 'order_number', p.order_number, 'status', p.status, 'payment_status', p.payment_status,
      'payment_method', p.payment_method, 'fraud_status', p.fraud_status, 'risk_level', p.risk_level,
      'source', p.source, 'customer_id', p.customer_id, 'customer_name', p.customer_name,
      'customer_phone', p.customer_phone, 'shipping_district', p.shipping_district,
      'total_amount', p.total_amount, 'amount_paid', p.amount_paid, 'cod_amount', p.cod_amount,
      'advance_required', p.advance_required, 'created_at', p.created_at,
      'label_printed_at', p.label_printed_at, 'label_print_count', p.label_print_count,
      'duplicate_status', p.duplicate_status, 'merged_count', p.merged_count,
      'duplicate_of_number', (select d.order_number from public.orders d where d.id = p.duplicate_of),
      'merged_into_number', (select d.order_number from public.orders d where d.id = p.merged_into),
      'item_count', (select coalesce(sum(quantity), 0) from public.order_items oi where oi.order_id = p.id),
      'courier_name', (select c.name from public.shipments s join public.couriers c on c.id = s.courier_id
                       where s.order_id = p.id and s.is_active limit 1),
      'tracking_number', (select s.tracking_number from public.shipments s where s.order_id = p.id and s.is_active limit 1)
    )) from page p), '[]'::jsonb)
  ) into v_result;
  return v_result;
end;
$$;

-- -----------------------------------------------------------------------------
-- Courier credentials (service role only; the frontend never sees them)
-- -----------------------------------------------------------------------------
create or replace function public.courier_credentials_store(
  p_courier_id uuid, p_provider text, p_credentials jsonb, p_hint text, p_actor uuid
)
returns void
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_secret uuid;
  v_name text := 'courier:' || p_courier_id::text;
begin
  if not public.is_system_context() then
    raise exception 'PERMISSION_DENIED' using errcode = '42501';
  end if;
  if p_credentials is null or jsonb_typeof(p_credentials) <> 'object' then
    raise exception 'VALIDATION: credentials must be an object' using errcode = '22023';
  end if;
  select secret_id into v_secret from public.courier_credentials where courier_id = p_courier_id;
  if v_secret is null then
    select id into v_secret from vault.secrets where name = v_name;
  end if;
  if v_secret is null then
    v_secret := vault.create_secret(p_credentials::text, v_name, 'Courier API credentials');
  else
    perform vault.update_secret(v_secret, p_credentials::text);
  end if;

  insert into public.courier_credentials(courier_id, provider, secret_id, hint, connected_by, connected_at, updated_at)
  values (p_courier_id, p_provider, v_secret, p_hint, p_actor, now(), now())
  on conflict (courier_id) do update set provider = excluded.provider, secret_id = excluded.secret_id,
    hint = excluded.hint, connected_by = excluded.connected_by, updated_at = now();

  update public.couriers set provider = p_provider, api_enabled = true, api_status = 'CONNECTED', api_checked_at = now(),
    config = config || jsonb_build_object('credential_hint', p_hint, 'connected_at', now())
  where id = p_courier_id;
  insert into public.audit_logs(actor_id, actor_email, action, entity_type, entity_id, metadata)
  values (p_actor, (select email from public.profiles where id = p_actor), 'courier.connected', 'couriers',
          p_courier_id::text, jsonb_build_object('provider', p_provider, 'hint', p_hint));
end;
$$;

create or replace function public.courier_credentials_get(p_courier_id uuid)
returns jsonb
language plpgsql
stable
security definer
set search_path = public, pg_temp
as $$
declare
  v_secret uuid;
  v_value text;
begin
  if not public.is_system_context() then
    raise exception 'PERMISSION_DENIED' using errcode = '42501';
  end if;
  select secret_id into v_secret from public.courier_credentials where courier_id = p_courier_id;
  if v_secret is null then
    return null;
  end if;
  select decrypted_secret into v_value from vault.decrypted_secrets where id = v_secret;
  return nullif(nullif(v_value, ''), '{}')::jsonb;
end;
$$;

create or replace function public.courier_credentials_clear(p_courier_id uuid, p_actor uuid)
returns void
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_secret uuid;
begin
  if not public.is_system_context() then
    raise exception 'PERMISSION_DENIED' using errcode = '42501';
  end if;
  select secret_id into v_secret from public.courier_credentials where courier_id = p_courier_id;
  if v_secret is not null then
    perform vault.update_secret(v_secret, '{}');
  end if;
  update public.courier_credentials set hint = null, updated_at = now() where courier_id = p_courier_id;
  update public.couriers set api_enabled = false, api_status = 'NOT_CONFIGURED',
    config = config - 'credential_hint' - 'connected_at'
  where id = p_courier_id;
  insert into public.audit_logs(actor_id, actor_email, action, entity_type, entity_id, metadata)
  values (p_actor, (select email from public.profiles where id = p_actor), 'courier.disconnected', 'couriers',
          p_courier_id::text, '{}'::jsonb);
end;
$$;

-- -----------------------------------------------------------------------------
-- RLS and grants
-- -----------------------------------------------------------------------------
alter table public.order_merges enable row level security;
alter table public.parcel_scans enable row level security;
alter table public.courier_credentials enable row level security;

create policy order_merges_read on public.order_merges for select to authenticated
  using ((select public.has_permission('orders.view')));
create policy parcel_scans_read on public.parcel_scans for select to authenticated
  using ((select public.has_permission('orders.view')) or (select public.has_permission('orders.fulfill')));
-- courier_credentials: no policies — not readable through the API at all.

revoke all on public.order_merges, public.parcel_scans, public.courier_credentials from anon, authenticated;
grant select on public.order_merges, public.parcel_scans to authenticated;
grant all on public.order_merges, public.parcel_scans, public.courier_credentials to service_role;

revoke execute on function
  public._receive_rate_facts(jsonb), public.evaluate_fraud_rules(jsonb, jsonb), public.record_fraud_check(jsonb),
  public.normalize_address(text), public._flag_possible_duplicate(uuid), public._find_merge_target(jsonb, uuid),
  public._add_order_lines(public.orders, jsonb), public._merge_checkout_into(uuid, jsonb),
  public.place_storefront_order(jsonb, uuid), public.admin_create_order(jsonb, boolean),
  public.admin_merge_orders(uuid, uuid), public.admin_dismiss_duplicate(uuid), public.mark_labels_printed(uuid[], text),
  public._scan_summary(uuid), public._scan_to_ready(public.orders, text), public.scan_parcel(text, text, uuid),
  public.admin_fulfillment_summary(), public.admin_search_orders(jsonb, text, text, int, int),
  public.courier_credentials_store(uuid, text, jsonb, text, uuid), public.courier_credentials_get(uuid),
  public.courier_credentials_clear(uuid, uuid)
from public, anon, authenticated;

grant execute on function
  public._receive_rate_facts(jsonb), public.evaluate_fraud_rules(jsonb, jsonb), public.record_fraud_check(jsonb),
  public.normalize_address(text), public._flag_possible_duplicate(uuid), public._find_merge_target(jsonb, uuid),
  public._add_order_lines(public.orders, jsonb), public._merge_checkout_into(uuid, jsonb),
  public.place_storefront_order(jsonb, uuid), public.admin_create_order(jsonb, boolean),
  public.admin_merge_orders(uuid, uuid), public.admin_dismiss_duplicate(uuid), public.mark_labels_printed(uuid[], text),
  public._scan_summary(uuid), public._scan_to_ready(public.orders, text), public.scan_parcel(text, text, uuid),
  public.admin_fulfillment_summary(), public.admin_search_orders(jsonb, text, text, int, int),
  public.courier_credentials_store(uuid, text, jsonb, text, uuid), public.courier_credentials_get(uuid),
  public.courier_credentials_clear(uuid, uuid)
to service_role;

-- Staff entry points (each checks its own permission).
grant execute on function
  public.record_fraud_check(jsonb), public.admin_create_order(jsonb, boolean),
  public.admin_merge_orders(uuid, uuid), public.admin_dismiss_duplicate(uuid), public.mark_labels_printed(uuid[], text),
  public.scan_parcel(text, text, uuid), public.admin_fulfillment_summary(), public.admin_search_orders(jsonb, text, text, int, int)
to authenticated;

-- Realtime: the scanner screen follows scans made on other devices.
do $$
begin
  if exists (select 1 from pg_publication where pubname = 'supabase_realtime') then
    alter publication supabase_realtime add table public.parcel_scans;
  end if;
end $$;
