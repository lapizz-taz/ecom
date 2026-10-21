-- =============================================================================
-- Security audit (run 4) fixes.
--
-- 1. Super Edit (admin_override_order) returned the whole order row, cost_total
--    included, to staff who may not see costs; the order edit log copied
--    cost_total into the audit log when a caller named it.
-- 2. Inbox: an agent without customers.view could link a chat to any store
--    customer by phone (learning whether the number is a customer, and whether
--    they have orders), and clear a link with an empty value.
-- 3. Billing: a business past due could "change" to the plan it is already on
--    and pay the bare plan price; the payment voided the open renewal with the
--    one-time setup fee, so the fee was never collected and the TRIAL_ENDED
--    block was lifted. A plan change that replaces that renewal now carries the fee.
-- 4. A store's phone pattern could still backtrack badly: bounded repeats of an
--    open-ended group (((\d*){10}){10}) or many open-ended repeats in a row.
--
-- Functions are patched in place (CREATE OR REPLACE keeps owner and grants).
-- Safe to re-run.
-- =============================================================================

create or replace function pg_temp.patch_fn(p_fn text, p_marker text, p_pairs text[])
returns void
language plpgsql as $$
declare
  v_old text := replace(pg_get_functiondef(p_fn::regprocedure), E'\r', '');
  v_new text;
  v_hits int;
  i int;
begin
  if position(p_marker in v_old) > 0 then
    return; -- already patched
  end if;
  v_new := v_old;
  for i in 1 .. array_length(p_pairs, 1) by 2 loop
    v_hits := (length(v_old) - length(replace(v_old, p_pairs[i], ''))) / length(p_pairs[i]);
    if v_hits <> 1 then
      raise exception 'audit run 4: % has changed (% matches for "%")', p_fn, v_hits, left(p_pairs[i], 60);
    end if;
    v_new := replace(v_new, p_pairs[i], p_pairs[i + 1]);
  end loop;
  execute v_new;
end $$;

-- -----------------------------------------------------------------------------
-- 1. Order costs stay with staff who may see costs.
-- -----------------------------------------------------------------------------

select pg_temp.patch_fn('public.admin_override_order(uuid,jsonb,text,boolean,boolean)', 'costs only for staff who may see them', array[
$a$  return jsonb_build_object('order', to_jsonb(v_order), 'mode'$a$,
$b$  -- costs only for staff who may see them (as order_cost_total and the order RPCs)
  return jsonb_build_object('order', case when public._can_see_costs() then to_jsonb(v_order) else to_jsonb(v_order) - 'cost_total' end, 'mode'$b$]);

select pg_temp.patch_fn('public._raw_admin_update_order(uuid,jsonb)', 'the log never copies costs', array[
$a$    (select jsonb_object_agg(k, to_jsonb(v_old) -> k) from jsonb_object_keys(p_changes) k),
    (select jsonb_object_agg(k, to_jsonb(v_order) -> k) from jsonb_object_keys(p_changes) k));$a$,
$b$    -- the log never copies costs (cost_total is not editable here)
    (select jsonb_object_agg(k, to_jsonb(v_old) -> k) from jsonb_object_keys(p_changes) k where k <> 'cost_total'),
    (select jsonb_object_agg(k, to_jsonb(v_order) -> k) from jsonb_object_keys(p_changes) k where k <> 'cost_total'));$b$]);

-- -----------------------------------------------------------------------------
-- 2. Inbox: any change to the chat's customer needs customers.view.
-- -----------------------------------------------------------------------------

select pg_temp.patch_fn('public.inbox_update(uuid,jsonb)', 'customers.view for any customer link', array[
$a$  if p ? 'customer_id' and nullif(p ->> 'customer_id', '') is not null then
    perform public.require_permission('customers.view');
  end if;
  if p ? 'linked_order_id' and nullif(p ->> 'linked_order_id', '') is not null then
    perform public.require_permission('orders.view');
  end if;$a$,
$b$  -- customers.view for any customer link (set or cleared), orders.view for any order link
  if p ? 'customer_id' then
    perform public.require_permission('customers.view');
  end if;
  if p ? 'linked_order_id' then
    perform public.require_permission('orders.view');
  end if;$b$,
$a$                       when p ? 'customer_phone' then coalesce(customer_id, public._inbox_customer_for_phone(p ->> 'customer_phone')) else customer_id end,$a$,
$b$                       when p ? 'customer_phone' and public.has_permission('customers.view')
                         then coalesce(customer_id, public._inbox_customer_for_phone(p ->> 'customer_phone')) else customer_id end,$b$]);

-- -----------------------------------------------------------------------------
-- 3. Billing: the plan you are on is renewed by its invoice; a pending setup fee
--    is charged on a plan change too.
-- -----------------------------------------------------------------------------

-- The one-time setup fee a plan change takes over: when the plan change replaces an open renewal
-- that carries the fee, and no other live invoice has charged it (else every plan change would
-- push the fee to the next renewal, and the next plan change would push it again). A plan change
-- during the offer period replaces nothing: the first renewal at the plan price has the fee.
create or replace function public._billing_pending_setup_fee(p_subscription uuid, p_except uuid default null)
returns numeric
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  select case when coalesce(s.setup_fee, 0) > 0
      and exists (select 1 from public.billing_invoices i where i.subscription_id = s.id and i.kind = 'SUBSCRIPTION'
                    and i.status = 'OPEN' and i.amount_paid = 0 and i.lines @> '[{"kind": "setup_fee"}]'::jsonb)
      and not exists (select 1 from public.billing_invoices i where i.subscription_id = s.id and i.status <> 'VOID'
                    and i.id is distinct from p_except
                    and not (i.status = 'OPEN' and i.amount_paid = 0 and (i.kind = 'SUBSCRIPTION' or i.plan_change is not null))
                    and i.lines @> '[{"kind": "setup_fee"}]'::jsonb)
    then s.setup_fee else 0 end
  from public.subscriptions s where s.id = p_subscription
$$;
revoke all on function public._billing_pending_setup_fee(uuid, uuid) from public, anon, authenticated;

select pg_temp.patch_fn('public.billing_choose_plan(text)', 'pay the open renewal invoice instead', array[
$a$  if s.id is not null and s.status in ('PAUSED') then$a$,
$b$  if s.id is not null and s.plan_id = v_plan.id and s.status = 'PAST_DUE' and exists (
       select 1 from public.billing_invoices i where i.subscription_id = s.id and i.kind = 'SUBSCRIPTION' and i.status = 'OPEN') then
    raise exception 'VALIDATION: you are already on the % plan; pay the open renewal invoice instead', v_plan.name using errcode = '22023';
  end if;
  if s.id is not null and s.status in ('PAUSED') then$b$,
$a$                                               'amount', v_plan.price, 'kind', 'plan')),
          v_plan.price, v_plan.currency,$a$,
$b$                                               'amount', v_plan.price, 'kind', 'plan'))
            || case when coalesce(public._billing_pending_setup_fee(s.id), 0) > 0
                    then jsonb_build_array(jsonb_build_object('label', 'One-time setup fee', 'amount', public._billing_pending_setup_fee(s.id), 'kind', 'setup_fee'))
                    else '[]'::jsonb end,
          v_plan.price + coalesce(public._billing_pending_setup_fee(s.id), 0), v_plan.currency,$b$]);

-- A plan change carrying the fee cannot be paid once the fee was paid another way (the renewal).
select pg_temp.patch_fn('public.billing_gateway_payment_create(uuid,text)', 'the setup fee is already paid', array[
$a$  v_purpose := public._billing_invoice_purpose(v_inv);$a$,
$b$  if v_inv.plan_change is not null and v_inv.lines @> '[{"kind": "setup_fee"}]'::jsonb
     and coalesce(public._billing_pending_setup_fee(v_inv.subscription_id, v_inv.id), 0) = 0 then
    raise exception 'VALIDATION: the setup fee is already paid; choose the plan again' using errcode = '22023';
  end if;
  v_purpose := public._billing_invoice_purpose(v_inv);$b$]);

-- The subscription's price is the plan's, not the invoice total (which may carry the fee).
select pg_temp.patch_fn('public._billing_apply_plan_change(public.billing_invoices)', 'price = v_plan.price', array[
$a$    values (p_inv.merchant_id, v_plan.id, 'ACTIVE', p_inv.total, p_inv.currency,$a$,
$b$    values (p_inv.merchant_id, v_plan.id, 'ACTIVE', v_plan.price, p_inv.currency,$b$,
$a$    update public.subscriptions set plan_id = v_plan.id, price = p_inv.total,$a$,
$b$    update public.subscriptions set plan_id = v_plan.id, price = v_plan.price,$b$]);

-- -----------------------------------------------------------------------------
-- 4. Phone patterns: no repeated group around an open-ended repeat, at most three
--    open-ended repeats in a row (the same rule as nestedQuantifier() in worker/db/pg/builtins.ts).
-- -----------------------------------------------------------------------------

-- True when a pattern repeats a group that holds an open-ended quantifier, like (\d+)+,
-- (.*a){20} or ((\d*){10}){10}; repeats an alternation without bound, like (a|a)*; or has
-- more than three open-ended quantifiers in a row, like \d*\d*\d*\d*x. Backtracking engines
-- (the browser's, and the Cloudflare database's) can take exponential or high polynomial time on those.
create or replace function public._regex_nested_repetition(p text)
returns boolean
language plpgsql
immutable
set search_path = public, pg_temp
as $$
declare
  n int := length(coalesce(p, ''));
  i int := 1;
  e int;
  c text;
  inner_q boolean[] := '{}';
  alt boolean[] := '{}';
  depth int := 0;
  g_inner boolean;
  g_alt boolean;
  q_unbounded boolean;
  q_max numeric;
  m text[];
  run int := 0;
begin
  while i <= n loop
    c := substr(p, i, 1);
    if c = '(' then
      depth := depth + 1;
      inner_q[depth] := false;
      alt[depth] := false;
      i := i + 1;
      continue;
    end if;
    if c = '|' then
      if depth > 0 then alt[depth] := true; end if;
      i := i + 1;
      continue;
    end if;
    if c in ('*', '+', '?', '{') and (c <> '{' or substr(p, i) ~ '^\{\d*,?\d*\}') then
      i := i + 1; -- read with its atom
      continue;
    end if;
    if c in ('^', '$') then
      run := 0;
      i := i + 1;
      continue;
    end if;
    -- One atom (an escape, a class, a character, or a closing parenthesis), then its quantifier.
    e := i;
    if c = '\' then
      e := i + 1;
    elsif c = '[' then
      e := i + 1;
      if substr(p, e, 1) = '^' then e := e + 1; end if;
      if substr(p, e, 1) = ']' then e := e + 1; end if;
      while e <= n and substr(p, e, 1) <> ']' loop
        e := e + case when substr(p, e, 1) = '\' then 2 else 1 end;
      end loop;
    end if;
    q_unbounded := false;
    q_max := null;
    c := substr(p, e + 1, 1);
    if c in ('*', '+') then
      q_unbounded := true; q_max := 'Infinity'::numeric;
    elsif c = '?' then
      q_max := 1;
    elsif c = '{' then
      m := regexp_match(substr(p, e + 1), '^\{(\d*)(,?)(\d*)\}');
      if m is not null then
        q_unbounded := m[2] = ',' and m[3] = '';
        q_max := case when q_unbounded then 'Infinity'::numeric else coalesce(nullif(m[3], ''), nullif(m[1], ''), '0')::numeric end;
      end if;
    end if;
    if substr(p, i, 1) = ')' then
      if depth > 0 then
        g_inner := inner_q[depth];
        g_alt := alt[depth];
        depth := depth - 1;
        if q_max is not null and g_inner and (q_unbounded or q_max > 1) then return true; end if;
        if g_alt and q_unbounded then return true; end if;
        if depth > 0 and (g_inner or q_unbounded) then inner_q[depth] := true; end if;
        if q_max is not null then
          if q_unbounded then
            run := run + 1;
            if run > 3 then return true; end if;
          elsif q_max <> 1 then
            run := 0;
          end if;
        end if;
      end if;
    else
      if q_unbounded and depth > 0 then inner_q[depth] := true; end if;
      if q_unbounded then
        run := run + 1;
        if run > 3 then return true; end if;
      elsif q_max is null or q_max <> 1 then
        run := 0;
      end if;
    end if;
    i := e + 1;
  end loop;
  return false;
end;
$$;

-- New definer functions run as app_owner, under row-level security.
select public._tenancy_own_functions();
