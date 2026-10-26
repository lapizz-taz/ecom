-- =============================================================================
-- The fee for each approved order never stops an order the system approves by itself.
--
-- Found by the round-4 audit (order-fee-automatic.test.ts). With the fee on and the "refuse when
-- the balance is empty" policy (the default), an empty balance made every approval fail, including
-- the ones nobody makes by hand:
--   * a shopper's checkout that is approved at once failed, so the order was never placed;
--   * a ৳55 advance the gateway reported was not recorded (the order moves to Confirmed in the same
--     step), although the shopper had paid;
--   * a customer's Confirm tap left the order waiting.
-- Those approvals now go through and the fee is recorded as owed (UNPAID), as with the "let it
-- through" policy. Staff approving orders in the admin are still refused until the balance is
-- topped up.
--
-- Also:
--   * the month's free orders were counted before this store's approvals waited for each other,
--     so two orders approved at the same moment could both be free; they are counted after;
--   * "orders this month" on Plan & Billing started at midnight UTC (6 AM in Bangladesh); it starts
--     at midnight in the store's time zone.
--
-- Patched in place (CREATE OR REPLACE keeps owner and grants), every line written as a one-line E''
-- string so the script still matches when it is pasted into the SQL Editor by hand. Safe to re-run.
-- =============================================================================

do $$
declare
  v_old text := replace(pg_get_functiondef('public._order_fee_charge(uuid,uuid,text)'::regprocedure), E'\r', '');
  v_lock text := E'  perform pg_advisory_xact_lock(hashtextextended(''order-fee:'' || p_merchant, 0));\n';
  v_allow text := E'  elsif v_t ->> ''on_empty'' = ''ALLOW'' then\n';
  v_new text;
begin
  if position('nobody approves by hand' in v_old) > 0 then
    return; -- already patched
  end if;
  if (length(v_old) - length(replace(v_old, v_lock, ''))) / length(v_lock) <> 1
     or (length(v_old) - length(replace(v_old, v_allow, ''))) / length(v_allow) <> 1 then
    raise exception 'order fee: _order_fee_charge has changed';
  end if;
  v_new := replace(v_old, v_lock, v_lock
    || E'  -- Read the terms again now that this store''s approvals wait for each other (the month''s free orders).\n'
    || E'  v_t := public._order_fee_terms(p_merchant);\n'
    || E'  v_fee := (v_t ->> ''fee'')::numeric;\n'
    || E'  v_poisha := round((v_t ->> ''fee'')::numeric * 100)::int;\n');
  v_new := replace(v_new, v_allow,
    E'  -- An approval nobody approves by hand (a checkout, a payment, a customer''s reply) is never refused: the fee is owed.\n'
    || E'  elsif v_t ->> ''on_empty'' = ''ALLOW'' or public.is_system_context() then\n');
  execute v_new;
end $$;

-- When this month began for a store: midnight on the 1st in the store's time zone.
create or replace function public._merchant_month_start(p_merchant uuid)
returns timestamptz
language plpgsql
stable
security definer
set search_path = public, pg_temp
as $$
declare
  v_tz text := coalesce((select timezone from public.merchants where id = p_merchant), 'Asia/Dhaka');
begin
  return date_trunc('month', now() at time zone v_tz) at time zone v_tz;
end;
$$;
revoke execute on function public._merchant_month_start(uuid) from public, anon, authenticated;

do $$
declare
  v_old text := replace(pg_get_functiondef('public.merchant_usage(uuid)'::regprocedure), E'\r', '');
  v_month text := E'o.created_at >= date_trunc(''month'', now())';
begin
  if position('_merchant_month_start' in v_old) > 0 then
    return; -- already patched
  end if;
  if (length(v_old) - length(replace(v_old, v_month, ''))) / length(v_month) <> 1 then
    raise exception 'order fee: merchant_usage has changed';
  end if;
  execute replace(v_old, v_month, E'o.created_at >= public._merchant_month_start(m.id)');
end $$;

select public._tenancy_own_functions();
