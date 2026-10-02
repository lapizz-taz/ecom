-- =============================================================================
-- 0500 · Fraud detection: provider results, configurable rules, decisions,
--        risk-based advance payment and the review queue
-- =============================================================================

create table public.fraud_checks (
  id uuid primary key default gen_random_uuid(),
  order_id uuid references public.orders(id),
  customer_id uuid references public.customers(id),
  phone text not null,
  provider text not null,
  providers text[] not null default '{}',
  status text not null default 'SUCCESS' check (status in ('SUCCESS', 'PARTIAL', 'ERROR')),
  risk_score numeric(5,2) check (risk_score between 0 and 100),
  risk_level public.risk_level,
  courier_score numeric(5,2),
  previous_orders int not null default 0,
  delivered_orders int not null default 0,
  cancelled_orders int not null default 0,
  returned_orders int not null default 0,
  failed_delivery_orders int not null default 0,
  cancellation_rate numeric(5,2),
  return_rate numeric(5,2),
  failed_delivery_rate numeric(5,2),
  recommendation text,
  decision public.fraud_decision,
  advance_type public.advance_type not null default 'NONE',
  advance_amount numeric(12,2) not null default 0,
  matched_rules jsonb not null default '[]'::jsonb,
  metrics jsonb not null default '{}'::jsonb,
  context jsonb not null default '{}'::jsonb,
  provider_response jsonb,
  error text,
  created_by uuid,
  created_at timestamptz not null default now()
);
create index fraud_checks_phone_idx on public.fraud_checks(phone, created_at desc);
create index fraud_checks_order_idx on public.fraud_checks(order_id);
create index fraud_checks_customer_idx on public.fraud_checks(customer_id, created_at desc);
create index fraud_checks_created_idx on public.fraud_checks(created_at desc);

-- Fraud checks are evidence: only attaching a check to its order is allowed.
create or replace function public.fraud_checks_guard()
returns trigger
language plpgsql
set search_path = public, pg_temp
as $$
begin
  if tg_op = 'DELETE' then
    raise exception 'IMMUTABLE_RECORD: fraud checks cannot be deleted' using errcode = 'P0001';
  end if;
  if old.order_id is null and new.order_id is not null
     and (to_jsonb(new) - 'order_id' - 'customer_id') = (to_jsonb(old) - 'order_id' - 'customer_id') then
    return new;
  end if;
  raise exception 'IMMUTABLE_RECORD: fraud checks cannot be modified' using errcode = 'P0001';
end;
$$;
create trigger fraud_checks_guard before update or delete on public.fraud_checks
  for each row execute function public.fraud_checks_guard();

alter table public.orders
  add column fraud_decision public.fraud_decision,
  add constraint orders_fraud_check_fk foreign key (fraud_check_id) references public.fraud_checks(id);

create table public.fraud_rules (
  id uuid primary key default gen_random_uuid(),
  name text not null,
  description text,
  priority int not null default 100,
  match_mode text not null default 'ALL' check (match_mode in ('ALL', 'ANY')),
  conditions jsonb not null default '[]'::jsonb check (jsonb_typeof(conditions) = 'array'),
  is_active boolean not null default true,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index fraud_rules_priority_idx on public.fraud_rules(priority) where is_active;
create trigger fraud_rules_updated_at before update on public.fraud_rules
  for each row execute function public.set_updated_at();
create trigger fraud_rules_audit after insert or update or delete on public.fraud_rules
  for each row execute function public.audit_row_change();

create table public.fraud_rule_actions (
  id uuid primary key default gen_random_uuid(),
  rule_id uuid not null references public.fraud_rules(id) on delete cascade,
  decision public.fraud_decision not null,
  advance_type public.advance_type not null default 'NONE',
  advance_value numeric(12,2) not null default 0 check (advance_value >= 0),
  customer_message text,
  stop_processing boolean not null default false,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint fraud_rule_actions_percentage check (advance_type <> 'PERCENTAGE' or advance_value between 0 and 100)
);
create index fraud_rule_actions_rule_idx on public.fraud_rule_actions(rule_id);
create trigger fraud_rule_actions_updated_at before update on public.fraud_rule_actions
  for each row execute function public.set_updated_at();
create trigger fraud_rule_actions_audit after insert or update or delete on public.fraud_rule_actions
  for each row execute function public.audit_row_change();

create table public.fraud_reviews (
  id uuid primary key default gen_random_uuid(),
  order_id uuid not null references public.orders(id),
  fraud_check_id uuid references public.fraud_checks(id),
  action text not null check (action in ('APPROVE', 'REQUEST_ADVANCE', 'REJECT')),
  decision public.fraud_decision not null,
  advance_amount numeric(12,2) not null default 0,
  note text,
  decided_by uuid,
  decided_by_name text,
  created_at timestamptz not null default now()
);
create index fraud_reviews_order_idx on public.fraud_reviews(order_id, created_at desc);
create trigger fraud_reviews_immutable before update or delete on public.fraud_reviews
  for each row execute function public.prevent_mutation();

-- -----------------------------------------------------------------------------
-- Scoring helpers
-- -----------------------------------------------------------------------------
create or replace function public.risk_level_for_score(p_score numeric)
returns public.risk_level
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  select case
    when p_score is null then null
    when p_score >= public.setting_numeric('fraud', array['thresholds', 'critical'], 80) then 'CRITICAL'
    when p_score >= public.setting_numeric('fraud', array['thresholds', 'high'], 60) then 'HIGH'
    when p_score >= public.setting_numeric('fraud', array['thresholds', 'medium'], 30) then 'MEDIUM'
    else 'LOW'
  end::public.risk_level
$$;

-- Percent rate of an outcome among finished orders; null without history.
create or replace function public.outcome_rate(p_count numeric, p_completed numeric)
returns numeric
language sql
immutable
set search_path = public, pg_temp
as $$
  select case when coalesce(p_completed, 0) > 0 then round(100 * coalesce(p_count, 0) / p_completed, 2) end
$$;

-- Risk score 0..100 from order-outcome history (own store + provider data).
create or replace function public.compute_risk_score(p_metrics jsonb)
returns numeric
language plpgsql
stable
security definer
set search_path = public, pg_temp
as $$
declare
  v_delivered numeric := coalesce((p_metrics ->> 'delivered_orders')::numeric, 0);
  v_cancelled numeric := coalesce((p_metrics ->> 'cancelled_orders')::numeric, 0);
  v_returned numeric := coalesce((p_metrics ->> 'returned_orders')::numeric, 0);
  v_failed numeric := coalesce((p_metrics ->> 'failed_delivery_orders')::numeric, 0);
  v_completed numeric := v_delivered + v_cancelled + v_returned + v_failed;
  v_rate numeric;
  v_score numeric;
begin
  if v_completed = 0 then
    v_score := public.setting_numeric('fraud', array['new_customer_score'], 20);
  else
    v_rate := (v_returned + v_failed + 0.5 * v_cancelled) / v_completed;
    v_score := v_rate * 100;
    -- Established customers with a clean record are trusted more.
    if v_delivered >= 5 and v_rate < 0.2 then
      v_score := v_score * 0.5;
    end if;
  end if;
  if coalesce((p_metrics ->> 'phone_flagged')::boolean, false) then
    v_score := greatest(v_score, 90);
  end if;
  if (p_metrics ->> 'provider_risk_score') is not null then
    v_score := greatest(v_score, (p_metrics ->> 'provider_risk_score')::numeric);
  end if;
  return round(least(greatest(v_score, 0), 100), 2);
end;
$$;

create or replace function public.compute_advance_amount(
  p_type public.advance_type,
  p_value numeric,
  p_order_total numeric,
  p_delivery_charge numeric,
  p_return_charge numeric
)
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
    coalesce(p_order_total, 0)
  )::numeric(12,2)
$$;

-- Order-outcome history for a phone number from our own orders.
create or replace function public.fraud_customer_metrics(p_phone text, p_exclude_order_id uuid default null)
returns jsonb
language plpgsql
stable
security definer
set search_path = public, pg_temp
as $$
declare
  v_phone text := public.clean_phone(p_phone);
  v_customer public.customers;
  v_m jsonb;
begin
  if not (public.is_system_context() or public.has_permission('fraud.view')) then
    raise exception 'PERMISSION_DENIED: fraud.view is required' using errcode = '42501';
  end if;
  select * into v_customer from public.customers where phone = v_phone;
  select jsonb_build_object(
    'phone', v_phone,
    'customer_id', v_customer.id,
    'previous_orders', count(*),
    'delivered_orders', count(*) filter (where o.delivered_at is not null and o.status in ('DELIVERED', 'RETURN_REQUESTED')),
    'cancelled_orders', count(*) filter (where o.status = 'CANCELLED'),
    'returned_orders', count(*) filter (where o.status = 'RETURNED' and o.delivered_at is not null),
    'failed_delivery_orders', count(*) filter (where o.status = 'FAILED_DELIVERY' or (o.status = 'RETURNED' and o.delivered_at is null)),
    'rejected_fraud_orders', count(*) filter (where o.status = 'REJECTED_FRAUD'),
    'cod_orders', count(*) filter (where o.payment_method = 'COD'),
    'failed_cod_orders', count(*) filter (where o.payment_method = 'COD'
        and (o.status = 'FAILED_DELIVERY' or (o.status = 'RETURNED' and o.delivered_at is null))),
    'open_orders', count(*) filter (where o.status in ('PENDING', 'FRAUD_CHECK', 'ADVANCE_REQUIRED', 'FRAUD_REVIEW',
        'CONFIRMATION_REQUIRED', 'CONFIRMED', 'PROCESSING', 'PRODUCTION', 'QUALITY_CHECK', 'PACKING', 'READY_TO_SHIP', 'SHIPPED')),
    'lifetime_value', coalesce(v_customer.total_spent, 0),
    'last_fraud_score', v_customer.last_fraud_score,
    'customer_status', coalesce(v_customer.status::text, 'NEW'),
    'customer_segment', coalesce(v_customer.segment::text, 'NEW'),
    'is_new_customer', v_customer.id is null or coalesce(v_customer.delivered_orders, 0) = 0,
    'phone_flagged', coalesce(v_customer.status = 'BLOCKED', false)
  ) into v_m
  from public.orders o
  where o.customer_phone = v_phone and (p_exclude_order_id is null or o.id <> p_exclude_order_id);
  return v_m;
end;
$$;

-- -----------------------------------------------------------------------------
-- Rule engine
-- A condition: {"field": "...", "op": "eq|neq|gt|gte|lt|lte|in|not_in|is_true|is_false", "value": ...}
-- Fields are keys of the facts object (metrics || order context), e.g.
--   risk_score, risk_level, courier_score, cancellation_rate, return_rate,
--   failed_delivery_rate, previous_orders, delivered_orders, failed_cod_orders,
--   is_new_customer, phone_flagged, order_value, district, payment_method
-- -----------------------------------------------------------------------------
create or replace function public.fraud_condition_matches(p_facts jsonb, p_condition jsonb)
returns boolean
language plpgsql
immutable
set search_path = public, pg_temp
as $$
declare
  v_fact jsonb := p_facts -> (p_condition ->> 'field');
  v_op text := lower(coalesce(p_condition ->> 'op', 'eq'));
  v_val jsonb := p_condition -> 'value';
  v_num numeric;
  v_cmp numeric;
begin
  if v_fact is null or jsonb_typeof(v_fact) = 'null' then
    return false;
  end if;

  if v_op in ('is_true', 'is_false') then
    return (v_fact::text = 'true') = (v_op = 'is_true');
  end if;

  if v_op in ('in', 'not_in') then
    if jsonb_typeof(v_val) <> 'array' then
      return false;
    end if;
    return (exists (select 1 from jsonb_array_elements_text(v_val) x
                    where lower(trim(x)) = lower(trim(v_fact #>> '{}')))) = (v_op = 'in');
  end if;

  if jsonb_typeof(v_fact) = 'number' or (v_fact #>> '{}') ~ '^-?[0-9]+(\.[0-9]+)?$' then
    v_num := (v_fact #>> '{}')::numeric;
    begin
      v_cmp := (v_val #>> '{}')::numeric;
    exception when others then
      v_cmp := null;
    end;
  end if;

  if v_num is not null and v_cmp is not null then
    return case v_op
      when 'eq' then v_num = v_cmp
      when 'neq' then v_num <> v_cmp
      when 'gt' then v_num > v_cmp
      when 'gte' then v_num >= v_cmp
      when 'lt' then v_num < v_cmp
      when 'lte' then v_num <= v_cmp
      else false end;
  end if;

  return case v_op
    when 'eq' then lower(v_fact #>> '{}') = lower(v_val #>> '{}')
    when 'neq' then lower(v_fact #>> '{}') <> lower(v_val #>> '{}')
    else false end;
end;
$$;

create or replace function public.decision_severity(p_decision public.fraud_decision)
returns int
language sql
immutable
set search_path = public, pg_temp
as $$
  select case p_decision when 'ALLOW' then 1 when 'ADVANCE_REQUIRED' then 2 when 'REVIEW' then 3 when 'BLOCK' then 4 else 0 end
$$;

-- Evaluates active rules (by priority). Most severe decision wins; the
-- advance is the largest advance among matched actions.
-- p_context: { order_value, delivery_charge, return_charge, district, payment_method, ... }
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
begin
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
    'matched_rules', v_matched_rules
  );
end;
$$;

-- Customer-facing payment requirement (never includes scores or rule names).
create or replace function public.payment_requirement_for(
  p_decision public.fraud_decision,
  p_advance numeric,
  p_total numeric,
  p_payment_method public.payment_method,
  p_custom_message text default null
)
returns jsonb
language plpgsql
stable
security definer
set search_path = public, pg_temp
as $$
declare
  v_symbol text := public.setting_text('store', array['currency_symbol'], '৳');
  v_voluntary numeric;
  v_amount numeric := coalesce(p_advance, 0);
  v_mode text;
  v_message text;
begin
  if p_decision = 'BLOCK' then
    return jsonb_build_object('mode', 'BLOCKED', 'amount', 0, 'cod_allowed', false,
      'message', coalesce(p_custom_message, public.setting_text('fraud', array['messages', 'blocked'],
        'We are unable to accept this order online. Please contact us to complete your purchase.')));
  end if;
  if p_decision = 'REVIEW' then
    return jsonb_build_object('mode', 'REVIEW', 'amount', 0, 'cod_allowed', false,
      'message', coalesce(p_custom_message, public.setting_text('fraud', array['messages', 'review'],
        'Your order needs a quick confirmation. Our team will contact you shortly.')));
  end if;

  if p_payment_method = 'FULL_PAYMENT' then
    v_amount := p_total;
  elsif p_payment_method = 'ADVANCE' then
    v_voluntary := public.compute_advance_amount(
      public.setting_text('payments', array['voluntary_advance', 'type'], 'DELIVERY_CHARGE')::public.advance_type,
      public.setting_numeric('payments', array['voluntary_advance', 'value'], 0),
      p_total, null, null);
    v_amount := greatest(v_amount, v_voluntary);
  end if;
  v_amount := least(ceil(v_amount), p_total);

  if v_amount <= 0 then
    return jsonb_build_object('mode', 'COD', 'amount', 0, 'cod_allowed', true, 'message', null);
  end if;

  v_mode := case when v_amount >= p_total then 'FULL' else 'ADVANCE' end;
  v_message := coalesce(p_custom_message,
    case when p_decision = 'ADVANCE_REQUIRED'
      then public.setting_text('fraud', array['messages', 'advance'], 'To confirm this order, a {amount} advance payment is required.')
      else case when v_mode = 'FULL' then 'Complete the payment of {amount} to confirm your order.'
                else 'Pay {amount} in advance to confirm your order.' end
    end);
  v_message := replace(v_message, '{amount}', v_symbol || trim(to_char(v_amount, 'FM999,999,990')));
  return jsonb_build_object('mode', v_mode, 'amount', v_amount, 'cod_allowed', v_mode = 'ADVANCE',
    'remaining_cod', greatest(p_total - v_amount, 0), 'message', v_message);
end;
$$;

-- -----------------------------------------------------------------------------
-- Recording a check. Called by the fraud edge function (service role) with the
-- provider's normalised result, or by staff re-running a check.
-- p_input: { phone, order_id?, provider, providers[], status, error,
--   provider_risk_score?, provider_courier_score?, provider_counts: {...},
--   provider_response, recommendation?, context: {order_value, ...} }
-- -----------------------------------------------------------------------------
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
    'provider_risk_score', (p_input ->> 'provider_risk_score')::numeric
  );

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

-- A reusable recent check for this phone (avoids paying the provider twice
-- between checkout quote and order placement).
create or replace function public.recent_fraud_check(p_phone text)
returns public.fraud_checks
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  select * from public.fraud_checks
  where phone = public.clean_phone(p_phone)
    and status <> 'ERROR'
    and created_at > now() - make_interval(mins => public.setting_numeric('fraud', array['cache_minutes'], 30)::int)
  order by created_at desc
  limit 1
$$;

-- Evaluates a phone + order context for checkout (no order yet).
create or replace function public.checkout_risk_preview(p_fraud_check_id uuid, p_context jsonb, p_payment_method public.payment_method)
returns jsonb
language plpgsql
stable
security definer
set search_path = public, pg_temp
as $$
declare
  v_check public.fraud_checks;
  v_eval jsonb;
begin
  if not public.is_system_context() then
    raise exception 'PERMISSION_DENIED' using errcode = '42501';
  end if;
  select * into v_check from public.fraud_checks where id = p_fraud_check_id;
  if not found or not public.setting_bool('fraud', array['enabled'], true) then
    return public.payment_requirement_for('ALLOW', 0, (p_context ->> 'order_value')::numeric, p_payment_method);
  end if;
  v_eval := public.evaluate_fraud_rules(v_check.metrics, p_context);
  return public.payment_requirement_for((v_eval ->> 'decision')::public.fraud_decision,
    (v_eval ->> 'advance_amount')::numeric, (p_context ->> 'order_value')::numeric, p_payment_method,
    v_eval ->> 'customer_message');
end;
$$;

-- -----------------------------------------------------------------------------
-- Applying a decision to an order (moves the order through FRAUD_CHECK).
-- -----------------------------------------------------------------------------
create or replace function public._apply_fraud_decision(p_order_id uuid, p_fraud_check_id uuid)
returns public.orders
language plpgsql
security definer
set search_path = public, pg_temp
as $$
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
    case when v_check.id is null then 'Risk check skipped'
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
$$;

-- Storefront checkout: create order + apply the decision in one transaction.
create or replace function public.place_storefront_order(p_payload jsonb, p_fraud_check_id uuid default null)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_order public.orders;
  v_is_new boolean;
begin
  if not public.is_system_context() then
    raise exception 'PERMISSION_DENIED' using errcode = '42501';
  end if;
  v_is_new := not exists (select 1 from public.orders where idempotency_key = nullif(p_payload ->> 'idempotency_key', ''));
  v_order := public._create_order(p_payload, 'STOREFRONT');
  if v_is_new then
    v_order := public._apply_fraud_decision(v_order.id, p_fraud_check_id);
  end if;
  return public._order_public_json(v_order) || jsonb_build_object(
    'payment_requirement', public.payment_requirement_for(
      coalesce(v_order.fraud_decision, 'ALLOW'), v_order.advance_required, v_order.total_amount, v_order.payment_method));
end;
$$;

-- Staff: run the decision for an order with an existing/new check.
create or replace function public.apply_fraud_decision(p_order_id uuid, p_fraud_check_id uuid)
returns public.orders
language plpgsql
security definer
set search_path = public, pg_temp
as $$
begin
  perform public.require_permission('fraud.review');
  return public._apply_fraud_decision(p_order_id, p_fraud_check_id);
end;
$$;

-- -----------------------------------------------------------------------------
-- Manual review decisions (Fraud Review queue)
-- -----------------------------------------------------------------------------
create or replace function public.fraud_review_decide(
  p_order_id uuid,
  p_action text,
  p_advance_amount numeric default null,
  p_note text default null,
  p_block_customer boolean default false
)
returns public.orders
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_order public.orders;
  v_action text := upper(coalesce(p_action, ''));
  v_amount numeric;
begin
  perform public.require_permission('fraud.review');
  select * into v_order from public.orders where id = p_order_id for update;
  if not found then
    raise exception 'NOT_FOUND: order not found' using errcode = 'P0002';
  end if;
  if v_order.status not in ('PENDING', 'FRAUD_CHECK', 'FRAUD_REVIEW', 'ADVANCE_REQUIRED', 'CONFIRMATION_REQUIRED', 'REJECTED_FRAUD') then
    raise exception 'VALIDATION: % orders are not in fraud review', v_order.status using errcode = '22023';
  end if;

  if v_action = 'APPROVE' then
    insert into public.fraud_reviews(order_id, fraud_check_id, action, decision, advance_amount, note, decided_by, decided_by_name)
    values (p_order_id, v_order.fraud_check_id, 'APPROVE', 'ALLOW', 0, p_note, auth.uid(), public.actor_display_name());
    update public.orders set fraud_status = 'APPROVED', fraud_decision = 'ALLOW',
      advance_required = least(advance_required, amount_paid)
    where id = p_order_id;
    if v_order.status = 'REJECTED_FRAUD' then
      perform public._transition_order(p_order_id, 'FRAUD_REVIEW', 'Reopened for review');
    end if;
    if v_order.status = 'PENDING' then
      perform public._transition_order(p_order_id, 'FRAUD_CHECK', 'Manual review');
    end if;
    v_order := public._transition_order(p_order_id, 'CONFIRMED', coalesce(p_note, 'Approved after fraud review'));

  elsif v_action = 'REQUEST_ADVANCE' then
    v_amount := ceil(coalesce(p_advance_amount, 0));
    if v_amount <= 0 or v_amount > v_order.total_amount then
      raise exception 'VALIDATION: advance must be between 1 and the order total (%)', v_order.total_amount using errcode = '22023';
    end if;
    insert into public.fraud_reviews(order_id, fraud_check_id, action, decision, advance_amount, note, decided_by, decided_by_name)
    values (p_order_id, v_order.fraud_check_id, 'REQUEST_ADVANCE', 'ADVANCE_REQUIRED', v_amount, p_note, auth.uid(), public.actor_display_name());
    update public.orders set fraud_status = 'ADVANCE_REQUIRED', fraud_decision = 'ADVANCE_REQUIRED',
      advance_required = v_amount, advance_type = case when v_amount >= total_amount then 'FULL' else 'FIXED' end::public.advance_type
    where id = p_order_id;
    if v_order.status = 'REJECTED_FRAUD' then
      perform public._transition_order(p_order_id, 'FRAUD_REVIEW', 'Reopened for review');
    elsif v_order.status = 'PENDING' then
      perform public._transition_order(p_order_id, 'FRAUD_CHECK', 'Manual review');
    end if;
    if v_order.status = 'ADVANCE_REQUIRED' then
      update public.orders set advance_due_at = now() + make_interval(
        hours => public.setting_numeric('orders', array['advance_payment_timeout_hours'], 24)::int)
      where id = p_order_id;
      perform public._order_log(p_order_id, 'ADVANCE_UPDATED', format('Advance changed to %s', v_amount), null, null,
        jsonb_build_object('advance_required', v_amount), true);
      perform public._enqueue_order_notification(p_order_id, 'ADVANCE_REQUIRED');
    elsif v_order.amount_paid >= v_amount then
      perform public._transition_order(p_order_id, 'CONFIRMED', 'Advance already paid');
    else
      perform public._transition_order(p_order_id, 'ADVANCE_REQUIRED', coalesce(p_note, format('Advance of %s requested', v_amount)));
    end if;

  elsif v_action = 'REJECT' then
    insert into public.fraud_reviews(order_id, fraud_check_id, action, decision, advance_amount, note, decided_by, decided_by_name)
    values (p_order_id, v_order.fraud_check_id, 'REJECT', 'BLOCK', 0, p_note, auth.uid(), public.actor_display_name());
    update public.orders set fraud_status = 'REJECTED', fraud_decision = 'BLOCK' where id = p_order_id;
    if v_order.status = 'PENDING' then
      perform public._transition_order(p_order_id, 'FRAUD_CHECK', 'Manual review');
    end if;
    if v_order.status <> 'REJECTED_FRAUD' then
      perform public._transition_order(p_order_id, 'REJECTED_FRAUD', coalesce(p_note, 'Rejected after fraud review'));
    end if;
    if p_block_customer then
      update public.customers set status = 'BLOCKED', blocked_reason = coalesce(p_note, 'Rejected in fraud review')
      where id = v_order.customer_id;
      perform public.refresh_customer_stats(v_order.customer_id);
    end if;
  else
    raise exception 'VALIDATION: action must be APPROVE, REQUEST_ADVANCE or REJECT' using errcode = '22023';
  end if;

  perform public.log_audit('fraud.review_' || lower(v_action), 'order', p_order_id::text,
    jsonb_build_object('status', v_order.status, 'advance_required', v_order.advance_required),
    jsonb_build_object('advance_required', v_amount, 'block_customer', p_block_customer),
    jsonb_build_object('note', p_note));
  select * into v_order from public.orders where id = p_order_id;
  return v_order;
end;
$$;

-- Fraud review queue with the check metrics joined in.
create or replace function public.admin_fraud_queue(
  p_statuses public.order_status[] default array['FRAUD_REVIEW', 'ADVANCE_REQUIRED']::public.order_status[],
  p_risk_level public.risk_level default null,
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
  v_result jsonb;
begin
  perform public.require_permission('fraud.view');
  with q as (
    select o.*, fc.risk_score, fc.courier_score, fc.cancellation_rate, fc.return_rate, fc.failed_delivery_rate,
           fc.recommendation, fc.previous_orders, fc.delivered_orders, fc.provider, fc.matched_rules, fc.status as check_status
    from public.orders o
    left join public.fraud_checks fc on fc.id = o.fraud_check_id
    where o.status = any(p_statuses) and (p_risk_level is null or o.risk_level = p_risk_level)
  )
  select jsonb_build_object(
    'total', (select count(*) from q),
    'items', coalesce((select jsonb_agg(jsonb_build_object(
      'id', id, 'order_number', order_number, 'status', status, 'created_at', created_at,
      'customer_id', customer_id, 'customer_name', customer_name, 'customer_phone', customer_phone,
      'shipping_district', shipping_district, 'total_amount', total_amount, 'payment_method', payment_method,
      'risk_level', risk_level, 'risk_score', risk_score, 'courier_score', courier_score,
      'cancellation_rate', cancellation_rate, 'return_rate', return_rate, 'failed_delivery_rate', failed_delivery_rate,
      'previous_orders', previous_orders, 'delivered_orders', delivered_orders,
      'recommendation', recommendation, 'fraud_decision', fraud_decision, 'fraud_status', fraud_status,
      'advance_required', advance_required, 'amount_paid', amount_paid, 'advance_due_at', advance_due_at,
      'provider', provider, 'check_status', check_status, 'matched_rules', matched_rules
    ) order by created_at desc) from (select * from q order by created_at desc
        limit least(greatest(p_limit, 1), 100) offset greatest(p_offset, 0)) page), '[]'::jsonb)
  ) into v_result;
  return v_result;
end;
$$;

-- Atomic save of a rule + its actions (Settings → Fraud rules).
create or replace function public.admin_save_fraud_rule(p_rule jsonb)
returns public.fraud_rules
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_rule public.fraud_rules;
  v_id uuid := nullif(p_rule ->> 'id', '')::uuid;
  v_action jsonb;
  v_cond jsonb;
begin
  perform public.require_permission('fraud.rules');
  if length(trim(coalesce(p_rule ->> 'name', ''))) = 0 then
    raise exception 'VALIDATION: rule name is required' using errcode = '22023';
  end if;
  for v_cond in select * from jsonb_array_elements(coalesce(p_rule -> 'conditions', '[]'::jsonb)) loop
    if coalesce(v_cond ->> 'field', '') = '' or lower(coalesce(v_cond ->> 'op', '')) not in
       ('eq', 'neq', 'gt', 'gte', 'lt', 'lte', 'in', 'not_in', 'is_true', 'is_false') then
      raise exception 'VALIDATION: invalid rule condition %', v_cond using errcode = '22023';
    end if;
  end loop;
  if jsonb_array_length(coalesce(p_rule -> 'actions', '[]'::jsonb)) = 0 then
    raise exception 'VALIDATION: a rule needs an action' using errcode = '22023';
  end if;

  if v_id is null then
    insert into public.fraud_rules(name, description, priority, match_mode, conditions, is_active)
    values (trim(p_rule ->> 'name'), p_rule ->> 'description', coalesce((p_rule ->> 'priority')::int, 100),
            coalesce(nullif(p_rule ->> 'match_mode', ''), 'ALL'), coalesce(p_rule -> 'conditions', '[]'::jsonb),
            coalesce((p_rule ->> 'is_active')::boolean, true))
    returning * into v_rule;
  else
    update public.fraud_rules set name = trim(p_rule ->> 'name'), description = p_rule ->> 'description',
      priority = coalesce((p_rule ->> 'priority')::int, priority),
      match_mode = coalesce(nullif(p_rule ->> 'match_mode', ''), match_mode),
      conditions = coalesce(p_rule -> 'conditions', conditions),
      is_active = coalesce((p_rule ->> 'is_active')::boolean, is_active)
    where id = v_id returning * into v_rule;
    if not found then
      raise exception 'NOT_FOUND: rule not found' using errcode = 'P0002';
    end if;
    delete from public.fraud_rule_actions where rule_id = v_id;
  end if;

  for v_action in select * from jsonb_array_elements(p_rule -> 'actions') loop
    insert into public.fraud_rule_actions(rule_id, decision, advance_type, advance_value, customer_message, stop_processing)
    values (v_rule.id, (v_action ->> 'decision')::public.fraud_decision,
            coalesce(nullif(v_action ->> 'advance_type', ''), 'NONE')::public.advance_type,
            coalesce((v_action ->> 'advance_value')::numeric, 0), nullif(v_action ->> 'customer_message', ''),
            coalesce((v_action ->> 'stop_processing')::boolean, false));
  end loop;
  return v_rule;
end;
$$;

-- -----------------------------------------------------------------------------
-- RLS
-- -----------------------------------------------------------------------------
alter table public.fraud_checks enable row level security;
alter table public.fraud_rules enable row level security;
alter table public.fraud_rule_actions enable row level security;
alter table public.fraud_reviews enable row level security;

create policy fraud_checks_read on public.fraud_checks for select to authenticated
  using ((select public.has_permission('fraud.view')));
create policy fraud_rules_read on public.fraud_rules for select to authenticated
  using ((select public.has_permission('fraud.view')) or (select public.has_permission('fraud.rules')));
create policy fraud_rules_delete on public.fraud_rules for delete to authenticated
  using ((select public.has_permission('fraud.rules')));
create policy fraud_rules_toggle on public.fraud_rules for update to authenticated
  using ((select public.has_permission('fraud.rules')))
  with check ((select public.has_permission('fraud.rules')));
create policy fraud_rule_actions_read on public.fraud_rule_actions for select to authenticated
  using ((select public.has_permission('fraud.view')) or (select public.has_permission('fraud.rules')));
create policy fraud_reviews_read on public.fraud_reviews for select to authenticated
  using ((select public.has_permission('fraud.view')));
