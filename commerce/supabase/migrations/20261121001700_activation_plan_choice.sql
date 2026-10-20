-- New business, "Activate your account": choose another plan before the first payment.
--
-- billing_choose_plan, while the business waits for its first payment (onboarding activation
-- awaiting_payment): the unpaid first invoice is voided, the subscription moves to the new plan
-- with the new-business offer applied again, and the new first invoice is raised (instead of a
-- plan-change invoice at the full price). Not while a payment for the open invoice was started
-- in the last 30 minutes; a payment that still lands on the voided invoice is flagged for the
-- team to refund, as for any payment on a closed invoice.

-- Text is compared without carriage returns (a script pasted on Windows has CRLF line ends).
create or replace function pg_temp.lf(p text) returns text
language sql immutable as $$ select replace(p, E'\r', '') $$;

do $$
declare
  v_old text := pg_temp.lf(pg_get_functiondef('public.billing_choose_plan(text)'::regprocedure));
  v_from text := pg_temp.lf($a$    raise exception 'VALIDATION: your plan is paused by the platform team; contact them to change it' using errcode = '22023';
  end if;$a$);
  v_to text := pg_temp.lf($b$    raise exception 'VALIDATION: your plan is paused by the platform team; contact them to change it' using errcode = '22023';
  end if;

  -- A new business still waiting for its first payment: switch the plan, the offer and the first invoice.
  if v_plan.price > 0 and s.id is not null
     and (select onboarding ->> 'activation' from public.merchants where id = v_merchant) = 'awaiting_payment' then
    if exists (select 1 from public.billing_invoices i where i.subscription_id = s.id and i.status <> 'VOID' and i.amount_paid > 0) then
      raise exception 'VALIDATION: a payment was already made; contact the team to change the plan' using errcode = '22023';
    end if;
    if exists (select 1 from public.billing_payments p join public.billing_invoices i on i.id = p.invoice_id
               where i.subscription_id = s.id and i.status = 'OPEN' and p.status = 'PENDING' and p.created_at > now() - interval '30 minutes') then
      raise exception 'VALIDATION: a payment for this plan was started; finish it, or choose another plan in a few minutes' using errcode = '22023';
    end if;
    update public.billing_invoices set status = 'VOID', void_reason = format('Plan changed to %s before the first payment', v_plan.name)
    where subscription_id = s.id and kind = 'SUBSCRIPTION' and status = 'OPEN' and amount_paid = 0;
    update public.subscriptions set
      plan_id = v_plan.id, price = v_plan.price, currency = v_plan.currency, billing_interval = v_plan.billing_interval,
      status = 'ACTIVE', trial_ends_at = null, grace_until = null, current_period_start = now(), current_period_end = now(),
      intro_price = null, intro_until = null, intro_trial = false, setup_fee = null
    where id = s.id
    returning * into s;
    s := public._signup_offer_apply(s.id, v_plan.price);
    if s.status = 'TRIALING' then
      -- A free trial (an offer without a price): nothing to pay now.
      perform public._activation_complete(v_merchant, 'trial');
    else
      v_inv := public._billing_invoice_for(s, s.current_period_start,
        least(s.current_period_start + public._billing_interval(s.billing_interval), coalesce(s.intro_until, 'infinity'::timestamptz)));
    end if;
    perform public._subscription_event(s, 'plan.changed', jsonb_build_object('plan', v_plan.code, 'via', 'activation', 'invoice', v_inv.number));
    return jsonb_build_object('applied', true, 'plan', v_plan.code, 'activation_invoice_id', v_inv.id);
  end if;$b$);
begin
  if position('activation_invoice_id' in v_old) > 0 then
    return;
  end if;
  if (length(v_old) - length(replace(v_old, v_from, ''))) / length(v_from) <> 1 then
    raise exception 'activation plan choice: billing_choose_plan has changed';
  end if;
  execute replace(v_old, v_from, v_to);
end $$;

select public._tenancy_own_functions();
