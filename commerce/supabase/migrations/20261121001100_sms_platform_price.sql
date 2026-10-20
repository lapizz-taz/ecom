-- SMS: the price of a credit is the platform's, and SSLCommerz for paying the platform.
--
-- 1. Each business typed its own "cost per SMS credit" (and Finance used that number). The
--    price of an SMS credit is the platform's (Super Admin → Billing → prices), the same one
--    the business pays when it buys SMS credits, so SMS costs now use that price and a business
--    can no longer set it.
-- 2. SSLCommerz can be connected for payments to the platform (credits, invoices), next to
--    bKash and PayStation.
-- 3. The test message is the SMS page's "Quick SMS" (one message to any number).

create or replace function pg_temp.lf(p text) returns text
language sql immutable as $$ select replace(p, E'\r', '') $$;

-- What one SMS credit costs a business: the platform's price per SMS credit (taka).
create or replace function public._sms_credit_price()
returns numeric
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  select coalesce(nullif((public._billing_controls() -> 'pricing' -> 'SMS' ->> 'unit_poisha')::numeric, 0) / 100, 0.35)
$$;
revoke execute on function public._sms_credit_price() from public, anon, authenticated;

-- Every place that priced a message from the business's own number.
do $$
declare
  r record;
  v_old text;
  v_new text;
begin
  for r in
    select p.oid::regprocedure as sig from pg_proc p
    where p.pronamespace = 'public'::regnamespace
      and p.proname in ('_enqueue_order_notification', '_sms_reserve', 'sms_log_test', 'sms_overview')
  loop
    v_old := pg_temp.lf(pg_get_functiondef(r.sig));
    v_new := replace(replace(replace(v_old,
      'public.setting_numeric(''sms'', array[''cost_per_sms''], 0.35)', 'public._sms_credit_price()'),
      'coalesce((v_settings ->> ''cost_per_sms'')::numeric, 0)', 'public._sms_credit_price()'),
      -- The test message is the SMS page's Quick SMS now.
      '20 test messages were sent in the last hour', '20 quick SMS were sent in the last hour');
    if position('array[''cost_per_sms'']' in v_new) > 0 or position('->> ''cost_per_sms''' in v_new) > 0 then
      raise exception 'sms price: % still reads the business''s own SMS cost', r.sig;
    end if;
    if v_new <> v_old then
      execute v_new;
    end if;
  end loop;
end $$;

-- A business no longer sets the price of SMS.
do $$
declare
  v_old text := pg_temp.lf(pg_get_functiondef('public.sms_update_settings(boolean,text,numeric,text)'::regprocedure));
  v_from text := '  if p_cost_per_sms is not null then
    if p_cost_per_sms < 0 or p_cost_per_sms > 20 then
      raise exception ''VALIDATION: the cost per SMS must be between 0 and 20'' using errcode = ''22023'';
    end if;
    v_patch := v_patch || jsonb_build_object(''cost_per_sms'', round(p_cost_per_sms, 4));
  end if;';
  v_new text;
begin
  if position('the price of SMS is set by the platform' in v_old) > 0 then
    return;
  end if;
  v_new := replace(v_old, v_from, '  if p_cost_per_sms is not null then
    raise exception ''VALIDATION: the price of SMS is set by the platform'' using errcode = ''22023'';
  end if;');
  if v_new = v_old then
    raise exception 'sms price: sms_update_settings has changed';
  end if;
  execute v_new;
end $$;

-- SSLCommerz for payments to the platform.
do $$
declare
  v_old text := pg_temp.lf(pg_get_functiondef('public.platform_billing_gateway_set(text,boolean,text,boolean,uuid)'::regprocedure));
  v_new text;
begin
  if position('''sslcommerz''' in v_old) > 0 then
    return;
  end if;
  v_new := replace(v_old, 'if p_provider not in (''bkash'', ''paystation'') then', 'if p_provider not in (''bkash'', ''paystation'', ''sslcommerz'') then');
  if v_new = v_old then
    raise exception 'sms price: platform_billing_gateway_set has changed';
  end if;
  execute v_new;
end $$;

update public.platform_settings set value = value || jsonb_build_object('sslcommerz', jsonb_build_object('enabled', false, 'sandbox', true))
where key = 'billing_gateways' and not value ? 'sslcommerz';

select public._tenancy_own_functions();
