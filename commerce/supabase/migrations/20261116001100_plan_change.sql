-- Choosing a plan from Plan & Billing (upgrade, downgrade or a first paid plan).
--
-- The merchant picks a public plan; Fullfilio raises an invoice for one period of it,
-- marked with the plan it buys. Nothing changes until that invoice is paid through the
-- verified payment path (bKash / PayStation callback, or a payment the platform team
-- records and verifies). On payment the subscription moves to that plan and a new period
-- starts from the payment, so the merchant gets exactly the plan and features they paid
-- for. A free plan is switched to straight away. A plan-change invoice that is never paid
-- does nothing (it is not a renewal, so it never makes the account overdue).

alter table public.billing_invoices add column if not exists plan_change jsonb;

-- Plans a merchant can pick, their current plan and any plan change waiting for payment.
create or replace function public.billing_plan_options()
returns jsonb
language plpgsql
stable
security definer
set search_path = public, pg_temp
as $$
declare
  v_merchant uuid := public.current_merchant_id();
  s public.subscriptions;
begin
  if v_merchant is null or not public.is_staff() then
    raise exception 'PERMISSION_DENIED: staff access required' using errcode = '42501';
  end if;
  select * into s from public.subscriptions where merchant_id = v_merchant and ended_at is null;
  return jsonb_build_object(
    'current', case when s.id is null then null else jsonb_build_object(
      'code', (select code from public.plans where id = s.plan_id), 'status', s.status, 'price', s.price,
      'billing_interval', s.billing_interval, 'current_period_end', s.current_period_end, 'trial_ends_at', s.trial_ends_at) end,
    'can_pay', public.billing_can_pay(),
    'plans', coalesce((select jsonb_agg(jsonb_build_object(
        'code', pl.code, 'name', pl.name, 'description', pl.description, 'price', pl.price, 'currency', pl.currency,
        'billing_interval', pl.billing_interval, 'trial_days', pl.trial_days, 'limits', pl.limits,
        'features', coalesce((select jsonb_agg(jsonb_build_object('code', f.code, 'name', f.name) order by f.sort_order, f.name)
                              from public.features f
                              where not f.is_core and f.globally_enabled and coalesce((pl.features ->> f.code)::boolean, false)), '[]'::jsonb))
      order by pl.sort_order, pl.price)
      from public.plans pl where pl.status = 'ACTIVE' and pl.is_public), '[]'::jsonb),
    'all_features', coalesce((select jsonb_agg(jsonb_build_object('code', f.code, 'name', f.name) order by f.sort_order, f.name)
                              from public.features f where not f.is_core and f.globally_enabled), '[]'::jsonb),
    'pending', (select jsonb_build_object('invoice_id', i.id, 'number', i.number, 'total', i.total, 'amount_paid', i.amount_paid,
                                          'plan', i.plan_change ->> 'code', 'plan_name', i.plan_change ->> 'name')
                from public.billing_invoices i
                where i.merchant_id = v_merchant and i.plan_change is not null and i.status = 'OPEN'
                order by i.created_at desc limit 1)
  );
end;
$$;

-- Picks a plan: a free plan applies now; a paid one returns the invoice to pay.
create or replace function public.billing_choose_plan(p_code text)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_merchant uuid := public.current_merchant_id();
  v_plan public.plans;
  s public.subscriptions;
  v_inv public.billing_invoices;
  v_due int := coalesce((select (value ->> 'invoice_due_days')::int from public.platform_settings where key = 'billing'), 7);
begin
  if not public.billing_can_pay() then
    raise exception 'PERMISSION_DENIED: only the owner or staff who manage settings can change the plan' using errcode = '42501';
  end if;
  select * into v_plan from public.plans where code = upper(trim(p_code)) and status = 'ACTIVE' and is_public;
  if v_plan.id is null then
    raise exception 'NOT_FOUND: that plan is not available' using errcode = 'P0001';
  end if;
  select * into s from public.subscriptions where merchant_id = v_merchant and ended_at is null for update;
  if s.id is not null and s.plan_id = v_plan.id and s.status in ('ACTIVE', 'TRIALING') then
    raise exception 'VALIDATION: you are already on the % plan; use Renew to pay the next period', v_plan.name using errcode = '22023';
  end if;
  if s.id is not null and s.status in ('PAUSED') then
    raise exception 'VALIDATION: your plan is paused by the platform team; contact them to change it' using errcode = '22023';
  end if;

  if v_plan.price = 0 then
    if s.id is null then
      raise exception 'VALIDATION: contact the platform team to start on the free plan' using errcode = '22023';
    end if;
    update public.subscriptions set plan_id = v_plan.id, price = 0, currency = v_plan.currency, billing_interval = v_plan.billing_interval,
      status = 'ACTIVE', grace_until = null, cancel_at_period_end = false,
      current_period_start = now(), current_period_end = now() + public._billing_interval(v_plan.billing_interval)
    where id = s.id returning * into s;
    perform public._subscription_event(s, 'plan.changed', jsonb_build_object('plan', v_plan.code, 'via', 'merchant'));
    return jsonb_build_object('applied', true, 'plan', v_plan.code);
  end if;

  if (select count(*) from public.billing_invoices
      where merchant_id = v_merchant and plan_change is not null and created_at > now() - interval '1 hour') >= 10 then
    raise exception 'RATE_LIMITED: too many plan changes in an hour; try again later' using errcode = 'P0001';
  end if;
  -- Only the latest choice waits for payment.
  update public.billing_invoices set status = 'VOID', void_reason = 'Another plan was chosen'
  where merchant_id = v_merchant and plan_change is not null and status = 'OPEN' and amount_paid = 0;

  insert into public.billing_invoices (merchant_id, subscription_id, kind, lines, total, currency, due_at, created_by, plan_change)
  values (v_merchant, s.id, 'OTHER',
          jsonb_build_array(jsonb_build_object('label', format('%s plan, one %s from payment', v_plan.name, lower(v_plan.billing_interval)),
                                               'amount', v_plan.price, 'kind', 'plan')),
          v_plan.price, v_plan.currency, now() + make_interval(days => v_due), auth.uid(),
          jsonb_build_object('plan_id', v_plan.id, 'code', v_plan.code, 'name', v_plan.name, 'interval', v_plan.billing_interval))
  returning * into v_inv;
  return jsonb_build_object('applied', false, 'id', v_inv.id, 'number', v_inv.number, 'total', v_inv.total,
                            'amount_paid', v_inv.amount_paid, 'currency', v_inv.currency, 'status', v_inv.status);
end;
$$;

-- On payment: the subscription moves to the plan the invoice bought, from now.
create or replace function public._billing_apply_plan_change(p_inv public.billing_invoices)
returns void
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_plan public.plans;
  s public.subscriptions;
begin
  select * into v_plan from public.plans where id = (p_inv.plan_change ->> 'plan_id')::uuid;
  if v_plan.id is null then
    return;
  end if;
  select * into s from public.subscriptions where merchant_id = p_inv.merchant_id and ended_at is null for update;
  if s.id is null then
    insert into public.subscriptions (merchant_id, plan_id, status, price, currency, billing_interval, current_period_start, current_period_end)
    values (p_inv.merchant_id, v_plan.id, 'ACTIVE', p_inv.total, p_inv.currency, v_plan.billing_interval, now(),
            now() + public._billing_interval(v_plan.billing_interval))
    returning * into s;
  else
    update public.subscriptions set plan_id = v_plan.id, price = p_inv.total, currency = p_inv.currency, billing_interval = v_plan.billing_interval,
      status = 'ACTIVE', grace_until = null, cancel_at_period_end = false,
      trial_ends_at = case when status = 'TRIALING' then now() else trial_ends_at end,
      current_period_start = now(), current_period_end = now() + public._billing_interval(v_plan.billing_interval)
    where id = s.id returning * into s;
    -- Renewal invoices still open for the old plan are replaced by this payment.
    update public.billing_invoices set status = 'VOID', void_reason = format('Replaced by the plan change %s', p_inv.number)
    where subscription_id = s.id and kind = 'SUBSCRIPTION' and status = 'OPEN' and amount_paid = 0;
  end if;
  update public.billing_invoices set subscription_id = s.id where id = p_inv.id and subscription_id is null;
  perform public._subscription_event(s, 'plan.changed', jsonb_build_object('plan', v_plan.code, 'invoice', p_inv.number, 'via', 'payment'));
  if public._activation_complete(p_inv.merchant_id, 'payment') then
    perform public._subscription_event(s, 'subscription.activated', jsonb_build_object('via', 'payment', 'invoice', p_inv.number));
  end if;
end;
$$;

do $$
declare
  v_old text := replace(pg_get_functiondef('public._billing_apply_payment(public.billing_payments)'::regprocedure), E'\r', '');
  v_from text := $a$  elsif v_inv.status = 'PAID' and v_inv.kind = 'CREDITS' then$a$;
  v_to text := $b$  elsif v_inv.status = 'PAID' and v_inv.plan_change is not null then
    perform public._billing_apply_plan_change(v_inv);
  elsif v_inv.status = 'PAID' and v_inv.kind = 'CREDITS' then$b$;
begin
  if position('_billing_apply_plan_change' in v_old) > 0 then
    return;
  end if;
  if (length(v_old) - length(replace(v_old, v_from, ''))) / length(v_from) <> 1 then
    raise exception 'plan change: _billing_apply_payment has changed';
  end if;
  execute replace(v_old, v_from, v_to);
end $$;

revoke all on function public.billing_plan_options(), public.billing_choose_plan(text), public._billing_apply_plan_change(public.billing_invoices)
  from public, anon, authenticated;
grant execute on function public.billing_plan_options(), public.billing_choose_plan(text) to authenticated;

insert into public.tenancy_exempt_functions (name, reason) values
  ('billing_plan_options', 'The caller''s own business only (current merchant): public plans and its own pending plan change'),
  ('billing_choose_plan', 'The caller''s own business only (current merchant, billing_can_pay): raises the plan-change invoice'),
  ('_billing_apply_plan_change', 'Applies a paid plan-change invoice to its own merchant; called by _billing_apply_payment only')
on conflict (name) do nothing;

select public._tenancy_own_functions();
