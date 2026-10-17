-- =============================================================================
-- Billing & Payments, round two: buying any number of SMS credits at a set
-- price per credit, topping up the balance with any amount, every state a
-- payment can end in, a log of every check made with the gateway, refunds,
-- and the Super Admin's billing dashboard.
--
--   * Prices live in platform_settings 'billing_controls' (Super Admin →
--     Subscriptions → Payment setup). The database works the total out from the
--     quantity; the browser never sends a price. SMS starts at 36 poisha per
--     credit (one credit = one SMS part).
--   * A payment is SUCCEEDED only after the gateway confirmed it server to
--     server (billing_gateway_confirm) or a second person verified a manual one.
--     A trigger keeps the states honest: a succeeded payment can only go on to
--     a refund, never back to failed, and its amount never changes.
--   * Every check (the browser coming back, the reconcile job, a re-check from
--     the panel, a refund) is written to billing_payment_checks.
--   * Refunds go through billing_refunds; bought credits are taken back with a
--     ledger entry, never by editing a balance.
-- =============================================================================

create or replace function pg_temp.lf(p text) returns text
language sql immutable as $$ select replace(p, E'\r', '') $$;
create or replace function pg_temp.lf_replace(p text, p_from text, p_to text) returns text
language sql immutable as $$ select replace(pg_temp.lf(p), pg_temp.lf(p_from), pg_temp.lf(p_to)) $$;

-- -----------------------------------------------------------------------------
-- 1. What can be bought online, at what price, within which limits
-- -----------------------------------------------------------------------------
insert into public.platform_settings (key, value, description) values
  ('billing_controls', jsonb_build_object(
     'purposes', jsonb_build_object('SUBSCRIPTION', true, 'SMS', true, 'COURIER', true, 'BALANCE', true),
     'max_payment_tk', 100000,
     'pricing', jsonb_build_object(
       'SMS', jsonb_build_object('enabled', true, 'unit_poisha', 36, 'min', 100, 'max', 100000, 'presets', jsonb_build_array(500, 1000, 5000, 10000)),
       'COURIER', jsonb_build_object('enabled', false, 'unit_poisha', 100, 'min', 50, 'max', 20000, 'presets', jsonb_build_array(100, 500, 1000)),
       'BALANCE', jsonb_build_object('enabled', true, 'min_tk', 100, 'max_tk', 50000, 'presets', jsonb_build_array(200, 500, 1000, 5000)))),
   'Online payments to the platform: what can be bought, prices per credit and limits')
on conflict (key) do nothing;

-- The controls, with defaults filled in.
create or replace function public._billing_controls()
returns jsonb
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  select coalesce((select value from public.platform_settings where key = 'billing_controls'), '{}'::jsonb)
$$;

-- Is this kind of purchase switched on?
create or replace function public._billing_purpose_on(p_purpose text)
returns boolean
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  select coalesce((public._billing_controls() -> 'purposes' ->> p_purpose)::boolean, true)
$$;

-- What an invoice pays for: SUBSCRIPTION, SMS, COURIER, BALANCE, ADDON or OTHER.
create or replace function public._billing_invoice_purpose(p_inv public.billing_invoices)
returns text
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  select case
    when p_inv.kind = 'SUBSCRIPTION' or p_inv.plan_change is not null then 'SUBSCRIPTION'
    when p_inv.kind = 'CREDITS' then case p_inv.lines -> 0 ->> 'credit_type' when 'SMS' then 'SMS' when 'COURIER' then 'COURIER' when 'BALANCE' then 'BALANCE' else 'OTHER' end
    when p_inv.kind = 'ADDON' then 'ADDON'
    else 'OTHER' end
$$;

-- The setting has its own validated page, like the gateways.
do $$
declare
  v_old text := pg_temp.lf(pg_get_functiondef('public.platform_setting_save(text, jsonb, text)'::regprocedure));
  v_new text;
begin
  v_new := pg_temp.lf_replace(v_old, $x$if p_key in ('sms', 'bd_courier', 'billing_gateways') then$x$,
    $x$if p_key in ('sms', 'bd_courier', 'billing_gateways', 'billing_controls') then$x$);
  if v_new = v_old then
    raise exception 'billing v2: platform_setting_save has changed';
  end if;
  execute v_new;
end $$;

-- -----------------------------------------------------------------------------
-- 2. Payments: every state, what each one paid for, refunds and review flags
-- -----------------------------------------------------------------------------
alter table public.billing_payments drop constraint billing_payments_status_check;
alter table public.billing_payments add constraint billing_payments_status_check
  check (status in ('PENDING', 'SUCCEEDED', 'FAILED', 'REJECTED', 'CANCELLED', 'EXPIRED', 'REFUND_PENDING', 'REFUNDED'));
alter table public.billing_payments
  add column purpose text check (purpose in ('SUBSCRIPTION', 'SMS', 'COURIER', 'BALANCE', 'ADDON', 'OTHER')),
  add column currency text not null default 'BDT',
  add column refunded_amount numeric(12, 2) not null default 0 check (refunded_amount >= 0),
  add column status_reason text,
  add column needs_review boolean not null default false,
  add column review_note text,
  add column updated_at timestamptz not null default now();
alter table public.billing_payments add constraint billing_payments_refund_le_amount check (refunded_amount <= amount);

update public.billing_payments p set purpose = public._billing_invoice_purpose(i), currency = i.currency
from public.billing_invoices i where i.id = p.invoice_id and p.purpose is null;

create index billing_payments_created_idx on public.billing_payments (created_at desc);
create index billing_payments_status_idx on public.billing_payments (status, created_at desc);
create index billing_payments_review_idx on public.billing_payments (created_at desc) where needs_review;

-- Purpose and currency come from the invoice; nobody sends them.
create or replace function public._billing_payment_defaults()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_inv public.billing_invoices;
begin
  select * into v_inv from public.billing_invoices where id = new.invoice_id;
  new.purpose := public._billing_invoice_purpose(v_inv);
  new.currency := coalesce(v_inv.currency, 'BDT');
  return new;
end;
$$;
create trigger billing_payments_defaults before insert on public.billing_payments
  for each row execute function public._billing_payment_defaults();

-- The states a payment can move through. Money that arrived stays arrived: a
-- succeeded payment can only go on to a refund, and its amount, store,
-- invoice and reference never change.
create or replace function public._billing_payment_guard()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
begin
  if new.amount <> old.amount or new.merchant_id <> old.merchant_id or new.invoice_id <> old.invoice_id
     or new.method <> old.method or new.reference is distinct from old.reference or new.purpose is distinct from old.purpose
     or new.currency <> old.currency then
    raise exception 'IMMUTABLE_RECORD: a payment''s amount, store, invoice and reference cannot change' using errcode = 'P0001';
  end if;
  if new.provider_txn_id is distinct from old.provider_txn_id and old.provider_txn_id is not null then
    raise exception 'IMMUTABLE_RECORD: the gateway transaction of a payment cannot change' using errcode = 'P0001';
  end if;
  if new.refunded_amount < old.refunded_amount then
    raise exception 'IMMUTABLE_RECORD: a refund cannot be undone' using errcode = 'P0001';
  end if;
  if new.status <> old.status then
    if old.status in ('SUCCEEDED', 'REFUND_PENDING') and new.status not in ('SUCCEEDED', 'REFUND_PENDING', 'REFUNDED') then
      raise exception 'INVALID_TRANSITION: a confirmed payment can only be refunded (% → %)', old.status, new.status using errcode = 'P0001';
    end if;
    if old.status in ('REFUNDED', 'REJECTED') then
      raise exception 'INVALID_TRANSITION: a % payment is final', lower(old.status) using errcode = 'P0001';
    end if;
    if new.status = 'SUCCEEDED' and old.status not in ('REFUND_PENDING') and new.verified_at is null then
      raise exception 'INVALID_TRANSITION: a payment succeeds only when it is verified' using errcode = 'P0001';
    end if;
    if new.status in ('REFUND_PENDING', 'REFUNDED') and old.status not in ('SUCCEEDED', 'REFUND_PENDING') then
      raise exception 'INVALID_TRANSITION: only a confirmed payment can be refunded' using errcode = 'P0001';
    end if;
  end if;
  new.updated_at := now();
  return new;
end;
$$;
create trigger billing_payments_guard before update on public.billing_payments
  for each row execute function public._billing_payment_guard();

-- -----------------------------------------------------------------------------
-- 3. Every check made with the gateway
-- -----------------------------------------------------------------------------
create table public.billing_payment_checks (
  id bigint generated always as identity primary key,
  payment_id uuid not null references public.billing_payments(id),
  merchant_id uuid not null references public.merchants(id),
  source text not null check (source in ('RETURN', 'IPN', 'RECONCILE', 'RECHECK', 'REFUND', 'MANUAL')),
  -- succeeded, already_succeeded, failed, cancelled, expired, pending, amount_mismatch,
  -- currency_mismatch, reference_mismatch, duplicate_transaction, gateway_mismatch, error
  outcome text not null check (outcome ~ '^[a-z_]{2,40}$'),
  gateway_status text,
  amount numeric(12, 2),
  txn text,
  -- What the gateway said, with phone numbers and tokens removed before it is stored.
  detail jsonb not null default '{}'::jsonb,
  actor_id uuid,
  created_at timestamptz not null default now()
);
create index billing_payment_checks_payment_idx on public.billing_payment_checks (payment_id, id desc);
create trigger billing_payment_checks_immutable before update or delete on public.billing_payment_checks
  for each row execute function public.prevent_mutation();

create or replace function public._billing_check(p_payment public.billing_payments, p_source text, p_outcome text, p_gateway_status text,
  p_amount numeric, p_txn text, p_detail jsonb)
returns void
language plpgsql
security definer
set search_path = public, pg_temp
as $$
begin
  insert into public.billing_payment_checks (payment_id, merchant_id, source, outcome, gateway_status, amount, txn, detail, actor_id)
  values (p_payment.id, p_payment.merchant_id,
          case when p_source in ('RETURN', 'IPN', 'RECONCILE', 'RECHECK', 'REFUND', 'MANUAL') then p_source else 'RETURN' end,
          p_outcome, left(p_gateway_status, 60), p_amount, left(p_txn, 100),
          coalesce(p_detail, '{}'::jsonb), auth.uid());
end;
$$;

-- For the edge function: a check that did not reach the database another way
-- (the gateway could not be reached, or still says "in progress").
create or replace function public.billing_payment_check_log(p_reference text, p_provider text, p_source text, p_outcome text,
  p_gateway_status text default null, p_detail jsonb default '{}'::jsonb)
returns void
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v public.billing_payments;
begin
  if not public.is_system_context() then
    raise exception 'PERMISSION_DENIED' using errcode = '42501';
  end if;
  select * into v from public.billing_payments where reference = p_reference and provider = p_provider and method = 'GATEWAY';
  if v.id is not null then
    perform public._billing_check(v, p_source, p_outcome, p_gateway_status, null, null, p_detail);
  end if;
end;
$$;

-- A payment whose gateway record disagrees with ours: kept as it is, flagged for a person.
create or replace function public.billing_payment_flag(p_payment uuid, p_source text, p_note text, p_gateway_status text default null, p_detail jsonb default '{}'::jsonb)
returns void
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v public.billing_payments;
begin
  if not public.is_system_context() then
    raise exception 'PERMISSION_DENIED' using errcode = '42501';
  end if;
  update public.billing_payments set needs_review = true, review_note = left(p_note, 500) where id = p_payment returning * into v;
  if v.id is not null then
    perform public._billing_check(v, p_source, 'gateway_mismatch', p_gateway_status, null, null, p_detail || jsonb_build_object('note', p_note));
    perform public._platform_log('billing.payment_flagged', v.merchant_id, 'billing_payment', v.id::text, p_note, null, null, 'FAILED');
  end if;
end;
$$;

-- -----------------------------------------------------------------------------
-- 4. Confirmation from the gateway (same call as before, now with every state,
--    the currency, the check log and safe handling of a racing duplicate)
-- -----------------------------------------------------------------------------
create or replace function public.billing_gateway_confirm(p_reference text, p_provider text, p_txn text, p_amount numeric, p_success boolean, p_payload jsonb)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v public.billing_payments;
  v_inv public.billing_invoices;
  v_source text := coalesce(p_payload ->> 'source', 'RETURN');
  v_hint text := lower(coalesce(p_payload ->> 'outcome', ''));
  v_gw text := p_payload ->> 'gateway_status';
  v_fail text;
begin
  if not public.is_system_context() then
    raise exception 'PERMISSION_DENIED' using errcode = '42501';
  end if;
  select * into v from public.billing_payments where reference = p_reference and provider = p_provider and method = 'GATEWAY' for update;
  if v.id is null or (public.current_merchant_id() is not null and v.merchant_id <> public.current_merchant_id()) then
    return jsonb_build_object('status', 'unknown_payment');
  end if;
  if v.status in ('SUCCEEDED', 'REFUND_PENDING', 'REFUNDED') then
    perform public._billing_check(v, v_source, 'already_succeeded', v_gw, p_amount, p_txn, p_payload);
    return jsonb_build_object('status', 'already_succeeded', 'invoice_id', v.invoice_id, 'payment_status', v.status);
  end if;
  if not p_success then
    v_fail := case when v_hint in ('cancelled', 'expired') then upper(v_hint) else 'FAILED' end;
    if v.status = 'PENDING' then
      update public.billing_payments set status = v_fail, status_reason = left(p_payload ->> 'reason', 300), raw = p_payload
      where id = v.id returning * into v;
    end if;
    perform public._billing_check(v, v_source, lower(v_fail), v_gw, p_amount, p_txn, p_payload);
    return jsonb_build_object('status', lower(v_fail), 'invoice_id', v.invoice_id, 'payment_status', v.status);
  end if;
  if p_amount is null or round(p_amount, 2) <> round(v.amount, 2) then
    update public.billing_payments set raw = p_payload, needs_review = true,
      review_note = format('The gateway reported %s, expected %s', p_amount, v.amount),
      note = coalesce(note || ' · ', '') || format('gateway reported %s, expected %s', p_amount, v.amount)
    where id = v.id returning * into v;
    perform public._billing_check(v, v_source, 'amount_mismatch', v_gw, p_amount, p_txn, p_payload);
    perform public._platform_log('billing.gateway_amount_mismatch', v.merchant_id, 'billing_payment', v.id::text, null, null,
      jsonb_build_object('expected', v.amount, 'reported', p_amount, 'txn', p_txn), 'FAILED');
    return jsonb_build_object('status', 'amount_mismatch', 'invoice_id', v.invoice_id);
  end if;
  if nullif(p_payload ->> 'currency', '') is not null and upper(p_payload ->> 'currency') <> upper(v.currency) then
    update public.billing_payments set raw = p_payload, needs_review = true,
      review_note = format('The gateway reported currency %s, expected %s', p_payload ->> 'currency', v.currency)
    where id = v.id returning * into v;
    perform public._billing_check(v, v_source, 'currency_mismatch', v_gw, p_amount, p_txn, p_payload);
    return jsonb_build_object('status', 'currency_mismatch', 'invoice_id', v.invoice_id);
  end if;
  if p_txn is null or exists (select 1 from public.billing_payments where provider = p_provider and provider_txn_id = p_txn and id <> v.id) then
    update public.billing_payments set needs_review = true,
      review_note = case when p_txn is null then 'The gateway confirmed without a transaction id' else format('Transaction %s already paid another payment', p_txn) end
    where id = v.id returning * into v;
    perform public._billing_check(v, v_source, 'duplicate_transaction', v_gw, p_amount, p_txn, p_payload);
    return jsonb_build_object('status', 'duplicate_transaction', 'invoice_id', v.invoice_id);
  end if;
  begin
    update public.billing_payments set status = 'SUCCEEDED', provider_txn_id = p_txn, verified_at = now(), raw = p_payload,
      status_reason = null where id = v.id returning * into v;
  exception when unique_violation then
    -- Another payment took this transaction at the same moment.
    return jsonb_build_object('status', 'duplicate_transaction', 'invoice_id', v.invoice_id);
  end;
  v_inv := public._billing_apply_payment(v);
  perform public._billing_check(v, v_source, 'succeeded', v_gw, p_amount, p_txn, p_payload);
  update public.platform_settings set value = jsonb_set(value, array[p_provider, 'last_verified_at'], to_jsonb(now()))
  where key = 'billing_gateways' and value ? p_provider;
  perform public._platform_log('billing.gateway_payment_succeeded', v.merchant_id, 'billing_payment', v.id::text, null, null,
    jsonb_build_object('amount', v.amount, 'provider', p_provider, 'txn', p_txn, 'invoice', v_inv.number, 'invoice_status', v_inv.status, 'purpose', v.purpose));
  if v_inv.status <> 'PAID' or v_inv.amount_paid > v_inv.total then
    -- Paid twice (two attempts both went through): flagged for the team to refund or credit.
    update public.billing_payments set needs_review = true, review_note = format('Invoice %s was already paid: refund or credit this payment', v_inv.number)
    where id = v.id;
    perform public._platform_log('billing.overpayment', v.merchant_id, 'billing_invoice', v_inv.id::text, null, null,
      jsonb_build_object('invoice', v_inv.number, 'payment', v.reference), 'FAILED');
  end if;
  return jsonb_build_object('status', 'succeeded', 'invoice_id', v.invoice_id, 'invoice_status', v_inv.status, 'kind', v_inv.kind, 'purpose', v.purpose);
end;
$$;

-- Attempts nobody finished: never started at the gateway within an hour, or
-- not confirmed within two days (bKash reverses an unexecuted payment itself).
create or replace function public.billing_gateway_expire()
returns int
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v public.billing_payments;
  n int := 0;
begin
  if not public.is_system_context() then
    raise exception 'PERMISSION_DENIED' using errcode = '42501';
  end if;
  for v in
    select * from public.billing_payments
    where method = 'GATEWAY' and status = 'PENDING'
      and ((provider_session is null and created_at < now() - interval '1 hour') or created_at < now() - interval '2 days')
    order by created_at limit 500 for update skip locked
  loop
    update public.billing_payments set status = 'EXPIRED', status_reason = 'Not completed in time' where id = v.id returning * into v;
    perform public._billing_check(v, 'RECONCILE', 'expired', null, null, null, '{}'::jsonb);
    n := n + 1;
  end loop;
  return n;
end;
$$;

-- -----------------------------------------------------------------------------
-- 5. Buying: any number of credits, any balance amount, and the limits on
--    every online payment
-- -----------------------------------------------------------------------------
create or replace function public.credits_buy(p_type text, p_quantity int)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_merchant uuid := public.current_merchant_id();
  c jsonb := public._billing_controls();
  pr jsonb := c -> 'pricing' -> p_type;
  v_credits int;
  v_total numeric(12, 2);
  v_unit numeric(12, 4);
  v_label text;
  v_inv public.billing_invoices;
begin
  if not public.billing_can_pay() then
    raise exception 'PERMISSION_DENIED: only the owner or staff who manage settings can buy credits' using errcode = '42501';
  end if;
  if p_type not in ('SMS', 'COURIER', 'BALANCE') or pr is null or not coalesce((pr ->> 'enabled')::boolean, false) or not public._billing_purpose_on(p_type) then
    raise exception 'VALIDATION: this purchase is not available' using errcode = '22023';
  end if;
  if p_quantity is null or p_quantity <= 0 then
    raise exception 'VALIDATION: enter how many to buy' using errcode = '22023';
  end if;
  if p_type = 'BALANCE' then
    -- The quantity is taka; the balance is kept in poisha.
    if p_quantity < coalesce((pr ->> 'min_tk')::int, 1) or p_quantity > coalesce((pr ->> 'max_tk')::int, 50000) then
      raise exception 'VALIDATION: top up between % and % Tk', pr ->> 'min_tk', pr ->> 'max_tk' using errcode = '22023';
    end if;
    v_credits := p_quantity * 100;
    v_total := p_quantity;
    v_unit := 1;
    v_label := format('Balance top-up %s Tk', to_char(p_quantity, 'FM999,999,990'));
  else
    if p_quantity < coalesce((pr ->> 'min')::int, 1) or p_quantity > coalesce((pr ->> 'max')::int, 100000) then
      raise exception 'VALIDATION: buy between % and % credits', pr ->> 'min', pr ->> 'max' using errcode = '22023';
    end if;
    if coalesce((pr ->> 'unit_poisha')::int, 0) <= 0 then
      raise exception 'VALIDATION: this purchase has no price yet' using errcode = '22023';
    end if;
    v_credits := p_quantity;
    -- Whole poisha: quantity × price per credit, then taka with two decimals. No floating point.
    v_total := ((p_quantity::bigint * (pr ->> 'unit_poisha')::int)::numeric / 100)::numeric(12, 2);
    v_unit := ((pr ->> 'unit_poisha')::int)::numeric / 100;
    v_label := format('%s %s credits', to_char(p_quantity, 'FM999,999,990'), case p_type when 'SMS' then 'SMS' else 'courier check' end);
  end if;
  if v_total <= 0 then
    raise exception 'VALIDATION: the total must be more than 0 Tk' using errcode = '22023';
  end if;
  if v_total > coalesce((c ->> 'max_payment_tk')::numeric, 100000) then
    raise exception 'VALIDATION: one online payment can be at most % Tk', c ->> 'max_payment_tk' using errcode = '22023';
  end if;
  -- The same open purchase is reused for 30 minutes (a second click, a back button).
  select * into v_inv from public.billing_invoices
  where merchant_id = v_merchant and kind = 'CREDITS' and status = 'OPEN' and amount_paid = 0 and created_at > now() - interval '30 minutes'
    and lines -> 0 ->> 'credit_type' = p_type and (lines -> 0 ->> 'custom')::boolean is true
    and (lines -> 0 ->> 'credits')::int = v_credits and total = v_total
  order by created_at desc limit 1;
  if v_inv.id is null then
    if (select count(*) from public.billing_invoices where merchant_id = v_merchant and kind = 'CREDITS' and created_at > now() - interval '1 hour') >= 10 then
      raise exception 'VALIDATION: too many recharge attempts; try again in an hour' using errcode = '22023';
    end if;
    insert into public.billing_invoices (merchant_id, kind, lines, total, currency, due_at, created_by)
    values (v_merchant, 'CREDITS',
            jsonb_build_array(jsonb_build_object('kind', 'credits', 'label', v_label, 'amount', v_total, 'credit_type', p_type,
              'credits', v_credits, 'quantity', p_quantity, 'unit_price', v_unit, 'custom', true)),
            v_total, 'BDT', now() + interval '1 day', auth.uid())
    returning * into v_inv;
  end if;
  return jsonb_build_object('id', v_inv.id, 'number', v_inv.number, 'total', v_inv.total, 'currency', v_inv.currency, 'lines', v_inv.lines,
    'gateways', (select coalesce(jsonb_agg(g.key order by g.key), '[]'::jsonb) from public.platform_settings ps, jsonb_each(ps.value) g
                 where ps.key = 'billing_gateways' and (g.value ->> 'enabled')::boolean));
end;
$$;

-- Packages honour the purchase switches too.
create or replace function public.credits_start_recharge(p_package uuid)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_merchant uuid := public.current_merchant_id();
  k public.credit_packages;
  v_inv public.billing_invoices;
begin
  if not public.billing_can_pay() then
    raise exception 'PERMISSION_DENIED: only the owner or staff who manage settings can buy credits' using errcode = '42501';
  end if;
  select * into k from public.credit_packages where id = p_package and status = 'ACTIVE';
  if k.id is null then
    raise exception 'NOT_FOUND: package not available' using errcode = 'P0002';
  end if;
  if not public._billing_purpose_on(k.credit_type) then
    raise exception 'VALIDATION: this purchase is not available' using errcode = '22023';
  end if;
  select * into v_inv from public.billing_invoices
  where merchant_id = v_merchant and kind = 'CREDITS' and status = 'OPEN' and amount_paid = 0 and created_at > now() - interval '30 minutes'
    and lines -> 0 ->> 'package_id' = k.id::text
  order by created_at desc limit 1;
  if v_inv.id is null then
    if (select count(*) from public.billing_invoices where merchant_id = v_merchant and kind = 'CREDITS' and created_at > now() - interval '1 hour') >= 10 then
      raise exception 'VALIDATION: too many recharge attempts; try again in an hour' using errcode = '22023';
    end if;
    insert into public.billing_invoices (merchant_id, kind, lines, total, currency, due_at, created_by)
    values (v_merchant, 'CREDITS',
            jsonb_build_array(jsonb_build_object('kind', 'credits', 'label', k.name, 'amount', k.price, 'package_id', k.id,
              'credit_type', k.credit_type, 'credits', k.credits + k.bonus_credits, 'bonus', k.bonus_credits)),
            k.price, k.currency, now() + interval '1 day', auth.uid())
    returning * into v_inv;
  end if;
  return jsonb_build_object('id', v_inv.id, 'number', v_inv.number, 'total', v_inv.total, 'currency', v_inv.currency, 'lines', v_inv.lines,
    'gateways', (select coalesce(jsonb_agg(g.key order by g.key), '[]'::jsonb) from public.platform_settings ps, jsonb_each(ps.value) g
                 where ps.key = 'billing_gateways' and (g.value ->> 'enabled')::boolean));
end;
$$;

-- Starting a gateway attempt: also checks the purchase switch and the payment limit.
create or replace function public.billing_gateway_payment_create(p_invoice uuid, p_provider text)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_merchant uuid := public.current_merchant_id();
  v_inv public.billing_invoices;
  v public.billing_payments;
  m public.merchants;
  v_purpose text;
begin
  if not public.is_system_context() then
    raise exception 'PERMISSION_DENIED' using errcode = '42501';
  end if;
  select * into v_inv from public.billing_invoices where id = p_invoice and merchant_id = v_merchant for update;
  if v_inv.id is null then
    raise exception 'NOT_FOUND: invoice not found' using errcode = 'P0002';
  end if;
  if v_inv.status <> 'OPEN' or v_inv.total - v_inv.amount_paid <= 0 then
    raise exception 'VALIDATION: this invoice is already %', lower(v_inv.status) using errcode = '22023';
  end if;
  if not coalesce((select (value -> p_provider ->> 'enabled')::boolean from public.platform_settings where key = 'billing_gateways'), false) then
    raise exception 'VALIDATION: this payment method is not available' using errcode = '22023';
  end if;
  v_purpose := public._billing_invoice_purpose(v_inv);
  if not public._billing_purpose_on(v_purpose) then
    raise exception 'VALIDATION: online payment for this is switched off; contact the platform team' using errcode = '22023';
  end if;
  if v_inv.total - v_inv.amount_paid > coalesce((public._billing_controls() ->> 'max_payment_tk')::numeric, 100000) then
    raise exception 'VALIDATION: this is more than one online payment can be; contact the platform team' using errcode = '22023';
  end if;
  if (select count(*) from public.billing_payments where invoice_id = v_inv.id and method = 'GATEWAY' and created_at > now() - interval '1 hour') >= 10 then
    raise exception 'VALIDATION: too many payment attempts for this invoice; try again later' using errcode = '22023';
  end if;
  select * into m from public.merchants where id = v_merchant;
  insert into public.billing_payments (merchant_id, invoice_id, amount, method, provider, reference, status, note)
  values (v_merchant, v_inv.id, v_inv.total - v_inv.amount_paid, 'GATEWAY', p_provider,
          'BP-' || upper(substr(replace(gen_random_uuid()::text, '-', ''), 1, 14)), 'PENDING', 'Paid online by the merchant')
  returning * into v;
  return jsonb_build_object('payment_id', v.id, 'reference', v.reference, 'amount', v.amount, 'currency', v_inv.currency,
    'invoice_number', v_inv.number, 'kind', v_inv.kind, 'purpose', v.purpose,
    'merchant', jsonb_build_object('name', m.name, 'phone', coalesce(m.phone, ''), 'email', m.owner_email, 'address', coalesce(m.address, '')));
end;
$$;

-- -----------------------------------------------------------------------------
-- 6. Refunds
-- -----------------------------------------------------------------------------
create table public.billing_refunds (
  id uuid primary key default gen_random_uuid(),
  payment_id uuid not null references public.billing_payments(id),
  merchant_id uuid not null references public.merchants(id),
  amount numeric(12, 2) not null check (amount > 0),
  reason text not null check (length(trim(reason)) between 5 and 500),
  -- GATEWAY: sent to the gateway from here. MANUAL: returned another way, recorded here.
  method text not null check (method in ('GATEWAY', 'MANUAL')),
  status text not null default 'PROCESSING' check (status in ('PROCESSING', 'SUCCEEDED', 'FAILED')),
  reverse_credits boolean not null default true,
  credits_reversed int not null default 0,
  credits_short int not null default 0,
  provider_refund_id text,
  error text,
  raw jsonb,
  requested_by uuid,
  created_at timestamptz not null default now(),
  completed_at timestamptz
);
create index billing_refunds_payment_idx on public.billing_refunds (payment_id);
-- One refund at a time per payment.
create unique index billing_refunds_one_open_uq on public.billing_refunds (payment_id) where status = 'PROCESSING';

-- RLS: the store's own rows only; read through the functions below.
do $$
declare
  t text;
begin
  foreach t in array array['billing_payment_checks', 'billing_refunds'] loop
    execute format('alter table public.%I enable row level security', t);
    execute format($p$create policy tenant_isolation on public.%I as restrictive for all to public
      using (merchant_id = (select public.current_merchant_id())) with check (merchant_id = (select public.current_merchant_id()))$p$, t);
    execute format('create policy app_owner_read on public.%I for select to app_owner using (true)', t);
  end loop;
end $$;

-- Takes back the credits an invoice granted, as far as the balance allows.
create or replace function public._billing_refund_reverse(r public.billing_refunds, p public.billing_payments)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_inv public.billing_invoices;
  l record;
  v_want int;
  v_take int;
  v_rev int := 0;
  v_short int := 0;
begin
  select * into v_inv from public.billing_invoices where id = p.invoice_id;
  if not r.reverse_credits or v_inv.kind <> 'CREDITS' then
    return jsonb_build_object('reversed', 0, 'short', 0);
  end if;
  for l in select x.line, x.n from jsonb_array_elements(v_inv.lines) with ordinality as x(line, n) where x.line ->> 'kind' = 'credits' loop
    -- In proportion to what is refunded of this payment.
    v_want := floor((l.line ->> 'credits')::int * least(r.amount / nullif(v_inv.total, 0), 1))::int;
    v_take := least(v_want, public.credit_available(p.merchant_id, l.line ->> 'credit_type'));
    if v_take > 0 then
      perform public._credit_post(p.merchant_id, l.line ->> 'credit_type', -v_take, 'ADJUSTMENT',
        format('Refund of %s (%s)', v_inv.number, coalesce(l.line ->> 'label', 'credits')), r.requested_by, 'PLATFORM',
        'billing_refund', r.id::text, 'refund:' || r.id || ':' || l.n, null, jsonb_build_object('payment', p.reference));
    end if;
    v_rev := v_rev + greatest(v_take, 0);
    v_short := v_short + greatest(v_want - greatest(v_take, 0), 0);
  end loop;
  return jsonb_build_object('reversed', v_rev, 'short', v_short);
end;
$$;

create or replace function public._billing_refund_finish(p_refund uuid, p_success boolean, p_provider_refund_id text, p_error text, p_payload jsonb)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  r public.billing_refunds;
  p public.billing_payments;
  v_rev jsonb;
begin
  select * into r from public.billing_refunds where id = p_refund for update;
  if r.id is null then
    raise exception 'NOT_FOUND: refund not found' using errcode = 'P0002';
  end if;
  if r.status <> 'PROCESSING' then
    return jsonb_build_object('status', lower(r.status), 'refund_id', r.id);
  end if;
  select * into p from public.billing_payments where id = r.payment_id for update;
  if not p_success then
    update public.billing_refunds set status = 'FAILED', error = left(p_error, 500), raw = p_payload, completed_at = now() where id = r.id;
    update public.billing_payments set status = 'SUCCEEDED' where id = p.id and status = 'REFUND_PENDING' returning * into p;
    perform public._billing_check(p, 'REFUND', 'refund_failed', null, r.amount, null, coalesce(p_payload, '{}'::jsonb) || jsonb_build_object('error', p_error));
    perform public._platform_log('billing.refund_failed', p.merchant_id, 'billing_payment', p.id::text, p_error, null,
      jsonb_build_object('refund', r.id, 'amount', r.amount), 'FAILED');
    return jsonb_build_object('status', 'failed', 'refund_id', r.id, 'error', p_error);
  end if;
  update public.billing_payments set refunded_amount = refunded_amount + r.amount,
    status = case when refunded_amount + r.amount >= amount then 'REFUNDED' else 'SUCCEEDED' end
  where id = p.id returning * into p;
  v_rev := public._billing_refund_reverse(r, p);
  update public.billing_refunds set status = 'SUCCEEDED', provider_refund_id = left(p_provider_refund_id, 100), raw = p_payload, completed_at = now(),
    credits_reversed = (v_rev ->> 'reversed')::int, credits_short = (v_rev ->> 'short')::int
  where id = r.id returning * into r;
  if r.credits_short > 0 then
    update public.billing_payments set needs_review = true,
      review_note = format('Refunded, but %s credits were already spent and could not be taken back', r.credits_short)
    where id = p.id;
  end if;
  perform public._billing_check(p, 'REFUND', 'refunded', null, r.amount, p_provider_refund_id, coalesce(p_payload, '{}'::jsonb));
  perform public._platform_log('billing.refunded', p.merchant_id, 'billing_payment', p.id::text, r.reason, null,
    jsonb_build_object('refund', r.id, 'amount', r.amount, 'method', r.method, 'credits_reversed', r.credits_reversed, 'credits_short', r.credits_short));
  return jsonb_build_object('status', 'succeeded', 'refund_id', r.id, 'payment_status', p.status,
    'credits_reversed', r.credits_reversed, 'credits_short', r.credits_short);
end;
$$;

-- Super Admin starts a refund. A gateway refund is then sent by the edge
-- function, which reports back through billing_refund_finish().
create or replace function public.platform_billing_refund_start(p_payment uuid, p_amount numeric, p_reason text, p_manual boolean default false,
  p_reverse_credits boolean default true)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  p public.billing_payments;
  r public.billing_refunds;
  v_left numeric;
begin
  perform public._platform_require('subscriptions', 'manage');
  perform public._platform_require('credits', 'manage');
  select * into p from public.billing_payments where id = p_payment for update;
  if p.id is null or p.merchant_id not in (select public._platform_merchant_ids()) then
    raise exception 'NOT_FOUND: payment not found' using errcode = 'P0002';
  end if;
  if p.status <> 'SUCCEEDED' then
    raise exception 'VALIDATION: only a confirmed payment can be refunded (this one is %)', lower(p.status) using errcode = '22023';
  end if;
  if length(trim(coalesce(p_reason, ''))) < 5 then
    raise exception 'VALIDATION: give a reason (at least 5 characters)' using errcode = '22023';
  end if;
  v_left := p.amount - p.refunded_amount;
  if p_amount is null or p_amount <= 0 or round(p_amount, 2) <> p_amount or p_amount > v_left then
    raise exception 'VALIDATION: refund between 0.01 and % Tk', v_left using errcode = '22023';
  end if;
  if not coalesce(p_manual, false) and (p.method <> 'GATEWAY' or p.provider <> 'bkash' or p.provider_txn_id is null or p.provider_session is null) then
    raise exception 'VALIDATION: this payment cannot be refunded through the gateway from here; refund it another way and record it as a manual refund' using errcode = '22023';
  end if;
  insert into public.billing_refunds (payment_id, merchant_id, amount, reason, method, reverse_credits, requested_by)
  values (p.id, p.merchant_id, p_amount, trim(p_reason), case when coalesce(p_manual, false) then 'MANUAL' else 'GATEWAY' end,
          coalesce(p_reverse_credits, true), auth.uid())
  returning * into r;
  update public.billing_payments set status = 'REFUND_PENDING' where id = p.id;
  perform public._platform_log('billing.refund_started', p.merchant_id, 'billing_payment', p.id::text, r.reason, null,
    jsonb_build_object('refund', r.id, 'amount', r.amount, 'method', r.method));
  if r.method = 'MANUAL' then
    return public._billing_refund_finish(r.id, true, null, null, jsonb_build_object('manual', true)) || jsonb_build_object('manual', true);
  end if;
  return jsonb_build_object('status', 'processing', 'refund_id', r.id, 'manual', false, 'provider', p.provider,
    'session', p.provider_session, 'txn', p.provider_txn_id, 'amount', r.amount, 'reference', p.reference);
end;
$$;

-- The gateway's answer to a refund (edge function).
create or replace function public.billing_refund_finish(p_refund uuid, p_success boolean, p_provider_refund_id text, p_error text, p_payload jsonb)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
begin
  if not public.is_system_context() then
    raise exception 'PERMISSION_DENIED' using errcode = '42501';
  end if;
  return public._billing_refund_finish(p_refund, p_success, p_provider_refund_id, p_error, p_payload);
end;
$$;

-- A refund the gateway has not answered yet, for "Check refund" (edge function).
create or replace function public.billing_refund_get(p_refund uuid)
returns jsonb
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  select case when public.is_system_context() then (
    select jsonb_build_object('refund_id', r.id, 'status', r.status, 'amount', r.amount, 'provider', p.provider, 'session', p.provider_session,
      'txn', p.provider_txn_id, 'reference', p.reference, 'merchant_id', p.merchant_id)
    from public.billing_refunds r join public.billing_payments p on p.id = r.payment_id where r.id = p_refund) end
$$;

-- -----------------------------------------------------------------------------
-- 7. The store: what can be bought, its payments and receipts
-- -----------------------------------------------------------------------------
create or replace function public.my_billing()
returns jsonb
language plpgsql
stable
security definer
set search_path = public, pg_temp
as $$
declare
  v_merchant uuid := public.current_merchant_id();
  c jsonb := public._billing_controls();
begin
  if not (public.billing_can_pay() or public.has_permission('settings.view')) then
    raise exception 'PERMISSION_DENIED' using errcode = '42501';
  end if;
  return jsonb_build_object(
    'can_pay', public.billing_can_pay(),
    'gateways', (select coalesce(jsonb_agg(g.key order by g.key), '[]'::jsonb) from public.platform_settings ps, jsonb_each(ps.value) g
                 where ps.key = 'billing_gateways' and (g.value ->> 'enabled')::boolean),
    'purposes', coalesce(c -> 'purposes', '{}'::jsonb),
    'max_payment_tk', coalesce((c ->> 'max_payment_tk')::numeric, 100000),
    'pricing', jsonb_build_object(
      'SMS', (select jsonb_build_object('enabled', coalesce((x ->> 'enabled')::boolean, false) and public._billing_purpose_on('SMS'),
                'unit_price', coalesce((x ->> 'unit_poisha')::numeric, 0) / 100, 'min', (x ->> 'min')::int, 'max', (x ->> 'max')::int,
                'presets', coalesce(x -> 'presets', '[]'::jsonb)) from (select c -> 'pricing' -> 'SMS' as x) s),
      'COURIER', (select jsonb_build_object('enabled', coalesce((x ->> 'enabled')::boolean, false) and public._billing_purpose_on('COURIER'),
                'unit_price', coalesce((x ->> 'unit_poisha')::numeric, 0) / 100, 'min', (x ->> 'min')::int, 'max', (x ->> 'max')::int,
                'presets', coalesce(x -> 'presets', '[]'::jsonb)) from (select c -> 'pricing' -> 'COURIER' as x) s),
      'BALANCE', (select jsonb_build_object('enabled', coalesce((x ->> 'enabled')::boolean, false) and public._billing_purpose_on('BALANCE'),
                'min', (x ->> 'min_tk')::int, 'max', (x ->> 'max_tk')::int, 'presets', coalesce(x -> 'presets', '[]'::jsonb))
                from (select c -> 'pricing' -> 'BALANCE' as x) s)),
    'payments', coalesce((select jsonb_agg(jsonb_build_object('id', p.id, 'reference', p.reference, 'amount', p.amount, 'currency', p.currency,
        'status', p.status, 'purpose', p.purpose, 'method', p.method, 'provider', p.provider, 'refunded_amount', p.refunded_amount,
        'status_reason', p.status_reason, 'transaction', p.provider_txn_id, 'created_at', p.created_at, 'verified_at', p.verified_at,
        'invoice', jsonb_build_object('id', i.id, 'number', i.number, 'kind', i.kind, 'status', i.status,
          'description', (select string_agg(l ->> 'label', ', ') from jsonb_array_elements(i.lines) l)))
      order by p.created_at desc)
      from (select * from public.billing_payments where merchant_id = v_merchant order by created_at desc limit 100) p
      join public.billing_invoices i on i.id = p.invoice_id), '[]'::jsonb));
end;
$$;

-- A receipt for a confirmed payment of this store.
create or replace function public.billing_receipt(p_payment uuid)
returns jsonb
language plpgsql
stable
security definer
set search_path = public, pg_temp
as $$
declare
  v_merchant uuid := public.current_merchant_id();
  p public.billing_payments;
  i public.billing_invoices;
  m public.merchants;
begin
  if not (public.billing_can_pay() or public.has_permission('settings.view')) then
    raise exception 'PERMISSION_DENIED' using errcode = '42501';
  end if;
  select * into p from public.billing_payments where id = p_payment and merchant_id = v_merchant;
  if p.id is null or p.status not in ('SUCCEEDED', 'REFUND_PENDING', 'REFUNDED') then
    raise exception 'NOT_FOUND: no receipt for this payment' using errcode = 'P0002';
  end if;
  select * into i from public.billing_invoices where id = p.invoice_id;
  select * into m from public.merchants where id = v_merchant;
  return jsonb_build_object(
    'payment', jsonb_build_object('reference', p.reference, 'amount', p.amount, 'currency', p.currency, 'status', p.status,
      'method', p.method, 'provider', p.provider, 'transaction', p.provider_txn_id, 'paid_at', coalesce(p.verified_at, p.created_at),
      'refunded_amount', p.refunded_amount, 'purpose', p.purpose),
    'invoice', jsonb_build_object('number', i.number, 'kind', i.kind, 'lines', i.lines, 'total', i.total, 'period_start', i.period_start,
      'period_end', i.period_end),
    'store', jsonb_build_object('name', m.name, 'number', m.number, 'email', m.owner_email, 'phone', m.phone),
    'issuer', 'Fullfilio');
end;
$$;

-- -----------------------------------------------------------------------------
-- 8. Super Admin: billing dashboard, one payment, review, controls
-- -----------------------------------------------------------------------------
create or replace function public.platform_billing_dashboard(p jsonb default '{}'::jsonb)
returns jsonb
language plpgsql
stable
security definer
set search_path = public, pg_temp
as $$
declare
  v_from timestamptz := coalesce((p ->> 'from')::date, current_date - 29)::timestamptz;
  v_to timestamptz := (coalesce((p ->> 'to')::date, current_date) + 1)::timestamptz;
  v_q text := nullif(trim(coalesce(p ->> 'q', '')), '');
  v_status text := nullif(p ->> 'status', '');
  v_purpose text := nullif(p ->> 'purpose', '');
  v_provider text := nullif(p ->> 'provider', '');
  v_review boolean := coalesce((p ->> 'review')::boolean, false);
  v_limit int := least(greatest(coalesce((p ->> 'limit')::int, 50), 1), 200);
  v_offset int := greatest(coalesce((p ->> 'offset')::int, 0), 0);
begin
  perform public._platform_require('subscriptions', 'view');
  return (
    with base as (
      select bp.*, m.name as merchant_name, m.number as merchant_number, i.number as invoice_number
      from public.billing_payments bp join public.merchants m on m.id = bp.merchant_id join public.billing_invoices i on i.id = bp.invoice_id
      where bp.created_at >= v_from and bp.created_at < v_to and bp.merchant_id in (select public._platform_merchant_ids())
    ), filtered as (
      select * from base
      where (v_status is null or status = v_status) and (v_purpose is null or purpose = v_purpose)
        and (v_provider is null or coalesce(provider, lower(method)) = v_provider) and (not v_review or needs_review)
        and (v_q is null or merchant_name ilike '%' || v_q || '%' or merchant_number::text = v_q or reference ilike '%' || v_q || '%'
             or provider_txn_id ilike '%' || v_q || '%' or invoice_number ilike '%' || v_q || '%')
    )
    select jsonb_build_object(
      'range', jsonb_build_object('from', v_from::date, 'to', (v_to - interval '1 day')::date),
      'totals', (select jsonb_build_object(
          'collected', coalesce(sum(amount - refunded_amount) filter (where status in ('SUCCEEDED', 'REFUND_PENDING', 'REFUNDED')), 0),
          'succeeded_count', count(*) filter (where status in ('SUCCEEDED', 'REFUND_PENDING', 'REFUNDED')),
          'pending', coalesce(sum(amount) filter (where status = 'PENDING'), 0), 'pending_count', count(*) filter (where status = 'PENDING'),
          'failed', coalesce(sum(amount) filter (where status in ('FAILED', 'REJECTED')), 0), 'failed_count', count(*) filter (where status in ('FAILED', 'REJECTED')),
          'cancelled_count', count(*) filter (where status = 'CANCELLED'), 'expired_count', count(*) filter (where status = 'EXPIRED'),
          'refunded', coalesce(sum(refunded_amount), 0), 'refunded_count', count(*) filter (where refunded_amount > 0),
          'review_count', count(*) filter (where needs_review)) from base),
      'by_purpose', coalesce((select jsonb_object_agg(purpose, collected) from (
          select coalesce(purpose, 'OTHER') as purpose, sum(amount - refunded_amount) as collected from base
          where status in ('SUCCEEDED', 'REFUND_PENDING', 'REFUNDED') group by 1) x), '{}'::jsonb),
      'by_day', coalesce((select jsonb_agg(jsonb_build_object('day', d, 'collected', collected) order by d) from (
          select (created_at at time zone 'Asia/Dhaka')::date as d, sum(amount - refunded_amount) as collected from base
          where status in ('SUCCEEDED', 'REFUND_PENDING', 'REFUNDED') group by 1) x), '[]'::jsonb),
      'count', (select count(*) from filtered),
      'rows', coalesce((select jsonb_agg(jsonb_build_object('id', id, 'reference', reference, 'amount', amount, 'currency', currency, 'status', status,
          'purpose', purpose, 'method', method, 'provider', provider, 'transaction', provider_txn_id, 'refunded_amount', refunded_amount,
          'needs_review', needs_review, 'review_note', review_note, 'invoice_number', invoice_number, 'created_at', created_at, 'verified_at', verified_at,
          'merchant', jsonb_build_object('id', merchant_id, 'name', merchant_name, 'number', merchant_number)) order by created_at desc)
        from (select * from filtered order by created_at desc limit v_limit offset v_offset) f), '[]'::jsonb),
      'can_manage', public.platform_can('subscriptions', 'manage'),
      'can_refund', public.platform_can('subscriptions', 'manage') and public.platform_can('credits', 'manage'))
  );
end;
$$;

create or replace function public.platform_billing_payment(p_payment uuid)
returns jsonb
language plpgsql
stable
security definer
set search_path = public, pg_temp
as $$
declare
  p public.billing_payments;
  i public.billing_invoices;
begin
  perform public._platform_require('subscriptions', 'view');
  select * into p from public.billing_payments where id = p_payment and merchant_id in (select public._platform_merchant_ids());
  if p.id is null then
    raise exception 'NOT_FOUND: payment not found' using errcode = 'P0002';
  end if;
  select * into i from public.billing_invoices where id = p.invoice_id;
  return jsonb_build_object(
    'payment', to_jsonb(p) - 'raw',
    'gateway_answer', p.raw,
    'merchant', (select jsonb_build_object('id', m.id, 'name', m.name, 'number', m.number) from public.merchants m where m.id = p.merchant_id),
    'invoice', jsonb_build_object('id', i.id, 'number', i.number, 'kind', i.kind, 'status', i.status, 'lines', i.lines, 'total', i.total,
      'amount_paid', i.amount_paid, 'period_start', i.period_start, 'period_end', i.period_end, 'paid_at', i.paid_at),
    'checks', coalesce((select jsonb_agg(jsonb_build_object('id', c.id, 'source', c.source, 'outcome', c.outcome, 'gateway_status', c.gateway_status,
        'amount', c.amount, 'txn', c.txn, 'detail', c.detail, 'created_at', c.created_at) order by c.id desc)
      from public.billing_payment_checks c where c.payment_id = p.id), '[]'::jsonb),
    'refunds', coalesce((select jsonb_agg(jsonb_build_object('id', r.id, 'amount', r.amount, 'reason', r.reason, 'method', r.method, 'status', r.status,
        'credits_reversed', r.credits_reversed, 'credits_short', r.credits_short, 'provider_refund_id', r.provider_refund_id, 'error', r.error,
        'requested_by', (select coalesce(nullif(s.full_name, ''), s.email) from public.platform_staff s where s.user_id = r.requested_by),
        'created_at', r.created_at, 'completed_at', r.completed_at) order by r.created_at desc)
      from public.billing_refunds r where r.payment_id = p.id), '[]'::jsonb),
    'credits', coalesce((select jsonb_agg(jsonb_build_object('id', l.id, 'credit_type', l.credit_type, 'kind', l.kind, 'amount', l.amount,
        'balance_after', l.balance_after, 'reason', l.reason, 'created_at', l.created_at) order by l.id)
      from public.credit_ledger l where l.merchant_id = p.merchant_id
        and ((l.reference_type = 'billing_invoice' and l.reference_id = i.id::text)
             or (l.reference_type = 'billing_refund' and l.reference_id in (select r.id::text from public.billing_refunds r where r.payment_id = p.id)))), '[]'::jsonb),
    'subscription_events', coalesce((select jsonb_agg(jsonb_build_object('event', e.event, 'created_at', e.created_at) order by e.created_at)
      from public.subscription_events e where e.subscription_id = i.subscription_id and e.detail ->> 'invoice' = i.number), '[]'::jsonb),
    'can_manage', public.platform_can('subscriptions', 'manage'),
    'can_refund', public.platform_can('subscriptions', 'manage') and public.platform_can('credits', 'manage'));
end;
$$;

-- A person looked at a flagged payment and settled it.
create or replace function public.platform_billing_review_resolve(p_payment uuid, p_note text)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  p public.billing_payments;
begin
  perform public._platform_require('subscriptions', 'manage');
  if length(trim(coalesce(p_note, ''))) < 5 then
    raise exception 'VALIDATION: write what was done (at least 5 characters)' using errcode = '22023';
  end if;
  update public.billing_payments set needs_review = false, review_note = trim(p_note)
  where id = p_payment and needs_review and merchant_id in (select public._platform_merchant_ids()) returning * into p;
  if p.id is null then
    raise exception 'NOT_FOUND: no flagged payment' using errcode = 'P0002';
  end if;
  perform public._billing_check(p, 'MANUAL', 'review_resolved', null, null, null, jsonb_build_object('note', trim(p_note)));
  perform public._platform_log('billing.review_resolved', p.merchant_id, 'billing_payment', p.id::text, trim(p_note), null, null);
  return to_jsonb(p) - 'raw';
end;
$$;

create or replace function public.platform_billing_controls()
returns jsonb
language plpgsql
stable
security definer
set search_path = public, pg_temp
as $$
begin
  perform public._platform_require('subscriptions', 'view');
  return jsonb_build_object('controls', public._billing_controls(),
    'can_manage', public.platform_can('subscriptions', 'manage') and public.platform_can('settings', 'manage'));
end;
$$;

create or replace function public.platform_billing_controls_save(p jsonb, p_reason text)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_before jsonb := public._billing_controls();
  t text;
  pr jsonb;
begin
  perform public._platform_require('subscriptions', 'manage');
  perform public._platform_require('settings', 'manage');
  if length(trim(coalesce(p_reason, ''))) < 5 then
    raise exception 'VALIDATION: give a reason (at least 5 characters)' using errcode = '22023';
  end if;
  if jsonb_typeof(p -> 'purposes') <> 'object' or jsonb_typeof(p -> 'pricing') <> 'object' then
    raise exception 'VALIDATION: purposes and pricing are required' using errcode = '22023';
  end if;
  if exists (select 1 from jsonb_each(p -> 'purposes') e where e.key not in ('SUBSCRIPTION', 'SMS', 'COURIER', 'BALANCE') or jsonb_typeof(e.value) <> 'boolean') then
    raise exception 'VALIDATION: each purchase type is on or off' using errcode = '22023';
  end if;
  if coalesce((p ->> 'max_payment_tk')::numeric, 0) < 1 or (p ->> 'max_payment_tk')::numeric > 10000000 then
    raise exception 'VALIDATION: the largest payment is between 1 and 10,000,000 Tk' using errcode = '22023';
  end if;
  foreach t in array array['SMS', 'COURIER'] loop
    pr := p -> 'pricing' -> t;
    if pr is null or coalesce((pr ->> 'unit_poisha')::int, -1) < 1 or (pr ->> 'unit_poisha')::int > 100000
       or coalesce((pr ->> 'min')::int, 0) < 1 or coalesce((pr ->> 'max')::int, 0) < (pr ->> 'min')::int or (pr ->> 'max')::int > 10000000
       or jsonb_typeof(coalesce(pr -> 'presets', '[]'::jsonb)) <> 'array' or jsonb_typeof(pr -> 'enabled') <> 'boolean' then
      raise exception 'VALIDATION: % pricing needs a price per credit in poisha (1 or more), a minimum and a maximum', t using errcode = '22023';
    end if;
  end loop;
  pr := p -> 'pricing' -> 'BALANCE';
  if pr is null or coalesce((pr ->> 'min_tk')::int, 0) < 1 or coalesce((pr ->> 'max_tk')::int, 0) < (pr ->> 'min_tk')::int
     or jsonb_typeof(coalesce(pr -> 'presets', '[]'::jsonb)) <> 'array' or jsonb_typeof(pr -> 'enabled') <> 'boolean' then
    raise exception 'VALIDATION: balance top-up needs a minimum and maximum in Tk' using errcode = '22023';
  end if;
  insert into public.platform_settings (key, value, updated_by) values ('billing_controls', p, auth.uid())
  on conflict (key) do update set value = excluded.value, updated_by = excluded.updated_by;
  perform public._config_version('platform_setting', 'billing_controls', p, trim(p_reason));
  perform public._platform_log('billing.controls_changed', null, 'platform_setting', 'billing_controls', trim(p_reason), v_before, p);
  return p;
end;
$$;

-- Gateway payments in a period, for the reconciliation report (edge function).
create or replace function public.billing_gateway_recheck_list(p_from date, p_to date, p_limit int default 100)
returns jsonb
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  select case when public.is_system_context() then coalesce((
    select jsonb_agg(jsonb_build_object('payment_id', id, 'merchant_id', merchant_id, 'provider', provider, 'reference', reference,
      'session', provider_session, 'status', status, 'amount', amount, 'txn', provider_txn_id,
      'age_minutes', floor(extract(epoch from now() - created_at) / 60)) order by created_at)
    from (select * from public.billing_payments
          where method = 'GATEWAY' and provider_session is not null and status <> 'REFUNDED'
            and created_at >= p_from::timestamptz and created_at < (p_to + 1)::timestamptz
          order by created_at limit least(greatest(p_limit, 1), 200)) x), '[]'::jsonb) end
$$;

-- One payment, for "Re-check with the gateway" (edge function).
create or replace function public.billing_payment_get(p_payment uuid)
returns jsonb
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  select case when public.is_system_context() then (
    select jsonb_build_object('payment_id', id, 'merchant_id', merchant_id, 'provider', provider, 'reference', reference, 'session', provider_session,
      'status', status, 'amount', amount, 'txn', provider_txn_id, 'method', method, 'age_minutes', floor(extract(epoch from now() - created_at) / 60))
    from public.billing_payments where id = p_payment) end
$$;

-- -----------------------------------------------------------------------------
-- 9. Who may call what
-- -----------------------------------------------------------------------------
grant execute on function public.credits_buy(text, int), public.my_billing(), public.billing_receipt(uuid) to authenticated;
grant execute on function public.platform_billing_dashboard(jsonb), public.platform_billing_payment(uuid), public.platform_billing_review_resolve(uuid, text),
  public.platform_billing_controls(), public.platform_billing_controls_save(jsonb, text),
  public.platform_billing_refund_start(uuid, numeric, text, boolean, boolean) to authenticated;
grant execute on function public.billing_payment_check_log(text, text, text, text, text, jsonb), public.billing_payment_flag(uuid, text, text, text, jsonb),
  public.billing_gateway_expire(), public.billing_refund_finish(uuid, boolean, text, text, jsonb), public.billing_refund_get(uuid),
  public.billing_gateway_recheck_list(date, date, int), public.billing_payment_get(uuid) to service_role;

-- Like the billing functions before them (billing_gateway_confirm and the rest),
-- these work on one named store at a time — current_merchant_id() for a store,
-- _platform_merchant_ids() for the platform team, or the payment's own store
-- for the gateway jobs — filter by it explicitly, and read platform settings.
-- The rest (purchase switch, invoice purpose, the state guard, receipts) run as
-- app_owner like every other function.
insert into public.tenancy_exempt_functions (name, reason)
select f, 'Billing: works on one named store at a time, or on the platform team''s stores, and reads platform settings'
from unnest(array['_billing_controls', '_billing_payment_defaults', '_billing_check', 'billing_payment_check_log', 'billing_payment_flag',
  'billing_gateway_expire', 'credits_buy', 'my_billing', '_billing_refund_reverse', '_billing_refund_finish', 'billing_refund_finish',
  'billing_refund_get', 'billing_gateway_recheck_list', 'billing_payment_get',
  'platform_billing_refund_start', 'platform_billing_dashboard', 'platform_billing_payment', 'platform_billing_review_resolve',
  'platform_billing_controls', 'platform_billing_controls_save']) f
on conflict (name) do nothing;

select public._tenancy_own_functions();
