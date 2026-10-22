-- =============================================================================
-- Security audit (run 5) fixes.
--
-- 1. Billing: the run-4 setup-fee fix only covered a plan change raised while a
--    renewal with the fee was open. A plan change chosen before the period ends
--    (no renewal yet) carried no fee: paid each period, the one-time setup fee
--    was never charged; left open, it later replaced the fee-bearing renewal and
--    lifted the TRIAL_ENDED block at the cheaper plan's price. The fee is now
--    pending while the subscription has one and no live invoice charged it, and a
--    plan change without it cannot be paid while it is pending.
-- 2. Store phone patterns: a{0}, \d? or \d{0,2} between open-ended repeats reset
--    the "three in a row" counter, so 45 x \d* passed. Only a fixed-width atom now
--    separates them, and a pattern may have at most 8 variable repeats in all
--    (the same rule as nestedQuantifier() in worker/db/pg/builtins.ts).
-- 3. Inbox: the thread view resolved the customer from a phone the agent typed and
--    used it for "other conversations" even without customers.view.
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
  v_from text;
  v_to text;
  v_hits int;
  i int;
begin
  if position(p_marker in v_old) > 0 then
    return; -- already patched
  end if;
  v_new := v_old;
  for i in 1 .. array_length(p_pairs, 1) by 2 loop
    v_from := replace(p_pairs[i], E'\r', '');
    v_to := replace(p_pairs[i + 1], E'\r', '');
    v_hits := (length(v_old) - length(replace(v_old, v_from, ''))) / length(v_from);
    if v_hits <> 1 then
      raise exception 'audit run 5: % has changed (% matches for "%")', p_fn, v_hits, left(v_from, 60);
    end if;
    v_new := replace(v_new, v_from, v_to);
  end loop;
  execute v_new;
end $$;

-- -----------------------------------------------------------------------------
-- 1. The one-time setup fee is pending until a live invoice charges it.
-- -----------------------------------------------------------------------------

-- Pending while the subscription has a fee and no invoice charged it: a paid one, or one already
-- being paid. Open unpaid renewals and plan changes don't count (any of them may be the one that
-- is paid). p_except leaves out the invoice being checked.
create or replace function public._billing_pending_setup_fee(p_subscription uuid, p_except uuid default null)
returns numeric
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  select case when coalesce(s.setup_fee, 0) > 0
      and not exists (select 1 from public.billing_invoices i where i.subscription_id = s.id and i.status <> 'VOID'
                    and i.id is distinct from p_except
                    and not (i.status = 'OPEN' and i.amount_paid = 0 and (i.kind = 'SUBSCRIPTION' or i.plan_change is not null))
                    and i.lines @> '[{"kind": "setup_fee"}]'::jsonb)
    then s.setup_fee else 0 end
  from public.subscriptions s where s.id = p_subscription
$$;
revoke all on function public._billing_pending_setup_fee(uuid, uuid) from public, anon, authenticated;

-- A plan change without the fee cannot be paid while the fee is pending (one raised before this
-- fix, or before the fee was set): the owner chooses the plan again and gets it with the fee.
select pg_temp.patch_fn('public.billing_gateway_payment_create(uuid,text)', 'the setup fee is still due', array[
$a$  v_purpose := public._billing_invoice_purpose(v_inv);$a$,
$b$  if v_inv.plan_change is not null and not (v_inv.lines @> '[{"kind": "setup_fee"}]'::jsonb)
     and coalesce(public._billing_pending_setup_fee(v_inv.subscription_id, v_inv.id), 0) > 0 then
    raise exception 'VALIDATION: the setup fee is still due; choose the plan again' using errcode = '22023';
  end if;
  v_purpose := public._billing_invoice_purpose(v_inv);$b$]);

-- -----------------------------------------------------------------------------
-- 2. Phone patterns: fixed-width separators only, at most 8 variable repeats.
-- -----------------------------------------------------------------------------
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
  q_present boolean;
  q_unbounded boolean;
  q_min numeric;
  q_max numeric;
  m text[];
  run int := 0;
  variable int := 0;
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
    q_present := false;
    q_unbounded := false;
    q_min := null;
    q_max := null;
    c := substr(p, e + 1, 1);
    if c in ('*', '+') then
      q_present := true; q_unbounded := true; q_min := case when c = '+' then 1 else 0 end; q_max := 'Infinity'::numeric;
    elsif c = '?' then
      q_present := true; q_min := 0; q_max := 1;
    elsif c = '{' then
      m := regexp_match(substr(p, e + 1), '^\{(\d*)(,?)(\d*)\}');
      if m is not null then
        q_present := true;
        q_min := coalesce(nullif(m[1], ''), '0')::numeric;
        q_unbounded := m[2] = ',' and m[3] = '';
        q_max := case when q_unbounded then 'Infinity'::numeric when m[2] = ',' then m[3]::numeric else q_min end;
      end if;
    end if;
    if substr(p, i, 1) = ')' then
      if depth > 0 then
        g_inner := inner_q[depth];
        g_alt := alt[depth];
        depth := depth - 1;
        if q_present and g_inner and (q_unbounded or q_max > 1) then return true; end if;
        if g_alt and q_unbounded then return true; end if;
        if depth > 0 and (g_inner or q_unbounded) then inner_q[depth] := true; end if;
      end if;
    elsif q_unbounded and depth > 0 then
      inner_q[depth] := true;
    end if;
    -- Repeats in a row: a{0} matches nothing (neither a repeat nor a separator); a variable
    -- repeat counts; only a fixed-width atom (no quantifier, or {n} with n >= 1) separates.
    -- (A closing parenthesis without a quantifier is neither: its inside was counted already.)
    if not (q_present and q_max = 0) and (q_present or substr(p, i, 1) <> ')') then
      if q_present and q_max > q_min then
        variable := variable + 1;
        if variable > 8 then return true; end if;
      end if;
      if q_unbounded then
        run := run + 1;
        if run > 3 then return true; end if;
      elsif not q_present or q_min = q_max then
        run := 0;
      end if;
    end if;
    i := e + 1;
  end loop;
  return false;
end;
$$;

-- -----------------------------------------------------------------------------
-- 3. Inbox thread: the customer behind a typed phone only for staff who may see customers.
-- -----------------------------------------------------------------------------
select pg_temp.patch_fn('public.inbox_thread(uuid,timestamptz,integer)', 'audit run 5: typed phone', array[
$a$  v_customer := coalesce(v_conv.customer_id, public._inbox_customer_for_phone(v_conv.customer_phone));$a$,
$b$  -- audit run 5: typed phone -> customer only for staff who may see customers.
  v_customer := coalesce(v_conv.customer_id,
    case when public.has_permission('customers.view') then public._inbox_customer_for_phone(v_conv.customer_phone) end);$b$]);

-- New definer functions run as app_owner, under row-level security.
select public._tenancy_own_functions();
