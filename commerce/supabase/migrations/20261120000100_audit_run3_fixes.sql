-- =============================================================================
-- Security audit (run 3) fixes.
--
-- 1. Custom domains: a store could claim a platform-owned name (the store root
--    domain, another store's <slug>.<root> address, the platform host) or the
--    www/apex twin of another store's domain, and the storefront resolver served
--    the claim before the slug and platform branches.
-- 2. Super Admin Income & Expenses and the Ads report ignored ASSIGNED merchant
--    scope, so scoped platform staff saw every merchant's payments and sign-up
--    contacts.
-- 3. Inbox RPCs returned customer profiles and order details to staff without
--    customers.view / orders.view.
-- 4. A plan-change invoice raised before a platform pause could still be paid,
--    and paying it re-activated the paused subscription (or granted a plan that
--    was archived since).
-- 5. Order RPCs returning public.orders sent cost_total to staff who may not
--    see costs (the Call role).
-- 6. A WhatsApp sign-up request could be overwritten by anyone who knew the
--    phone number; each submission is now its own request, a few per hour.
--
-- Functions with earlier patches are patched in place (CREATE OR REPLACE keeps
-- owner and grants). Safe to re-run.
-- =============================================================================

create or replace function pg_temp.patch_fn(p_fn text, p_marker text, p_from text, p_to text)
returns void
language plpgsql as $$
declare
  v_old text := replace(pg_get_functiondef(p_fn::regprocedure), E'\r', '');
  v_hits int;
begin
  if position(p_marker in v_old) > 0 then
    return; -- already patched
  end if;
  v_hits := (length(v_old) - length(replace(v_old, p_from, ''))) / length(p_from);
  if v_hits <> 1 then
    raise exception 'audit run 3: % has changed (% matches for "%")', p_fn, v_hits, left(p_from, 60);
  end if;
  execute replace(v_old, p_from, p_to);
end $$;

-- Several replacements in one function, applied together (p_pairs = from, to, from, to, ...).
create or replace function pg_temp.patch_fn_many(p_fn text, p_marker text, p_pairs text[])
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
      raise exception 'audit run 3: % has changed (% matches for "%")', p_fn, v_hits, left(p_pairs[i], 60);
    end if;
    v_new := replace(v_new, p_pairs[i], p_pairs[i + 1]);
  end loop;
  execute v_new;
end $$;

-- -----------------------------------------------------------------------------
-- 1. Custom domains: platform-owned names can never be claimed or served.
-- -----------------------------------------------------------------------------

-- True for the store root domain and anything under it, and for the platform's
-- own hosts (platform_settings.store_domains.reserved_hosts, default fullfilio.com).
create or replace function public._store_domain_reserved(p_domain text)
returns boolean
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  with d as (select lower(trim(coalesce(p_domain, ''))) as v),
  hosts as (
    select public._store_root_domain() as h
    union all
    select lower(trim(x)) from jsonb_array_elements_text(coalesce(
      (select case when jsonb_typeof(value -> 'reserved_hosts') = 'array' then value -> 'reserved_hosts' end
         from public.platform_settings where key = 'store_domains'),
      '["fullfilio.com"]'::jsonb)) x
  )
  select exists (select 1 from d, hosts where hosts.h is not null and hosts.h <> '' and (d.v = hosts.h or d.v like '%.' || hosts.h))
$$;
revoke all on function public._store_domain_reserved(text) from public, anon, authenticated;

-- Whether another store holds this exact name (store_domains rows of other stores are
-- hidden from tenant functions by row security, so this one is exempt).
create or replace function public._store_domain_taken(p_domain text, p_merchant uuid)
returns boolean
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  select exists (select 1 from public.store_domains
                 where domain = lower(trim(coalesce(p_domain, ''))) and merchant_id <> p_merchant and status <> 'REMOVED')
$$;
revoke all on function public._store_domain_taken(text, uuid) from public, anon, authenticated;

create or replace function public.store_domain_guard(p_domain text, p_action text)
returns void
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_mid uuid := public.current_merchant_id();
  v_d text := lower(trim(coalesce(p_domain, '')));
  v_twin text;
begin
  if not public.is_system_context() then
    perform public.require_permission('settings.manage');
  end if;
  if v_mid is null then
    raise exception 'No merchant in context' using errcode = '42501';
  end if;
  if p_action = 'add' then
    perform public.require_feature('custom_domains');
    if public._store_domain_reserved(v_d) then
      raise exception 'DOMAIN_REJECTED: That is the platform''s own domain; use your store address or a domain you own' using errcode = 'P0001';
    end if;
    -- www.example.com and example.com serve the same store, so both belong to one store.
    v_twin := case when v_d like 'www.%' then substr(v_d, 5) else 'www.' || v_d end;
    if public._store_domain_taken(v_twin, v_mid) then
      raise exception 'DUPLICATE: That domain is already connected to another store' using errcode = 'P0001';
    end if;
    insert into public.store_domains(domain, status)
    values (v_d, 'PENDING')
    on conflict (domain) do nothing;
    -- Removed earlier by this store: bring it back.
    update public.store_domains
       set status = 'PENDING', is_primary = false
     where domain = v_d and merchant_id = v_mid and status = 'REMOVED';
    if not exists (select 1 from public.store_domains
                   where domain = v_d and merchant_id = v_mid and status <> 'REMOVED') then
      raise exception 'DUPLICATE: That domain is already connected to another store' using errcode = 'P0001';
    end if;
  else
    if not exists (select 1 from public.store_domains
                   where domain = v_d and merchant_id = v_mid and status <> 'REMOVED') then
      raise exception 'NOT_FOUND: That domain is not on this store' using errcode = 'P0001';
    end if;
  end if;
end;
$$;

-- The resolver never lets a custom-domain row stand in for a platform-owned host.
select pg_temp.patch_fn('public.storefront_resolve(text)', '_store_domain_reserved',
$a$    where domain in (v_host, regexp_replace(v_host, '^www\.', ''), 'www.' || v_host) and status <> 'REMOVED'
$a$,
$b$    where domain in (v_host, regexp_replace(v_host, '^www\.', ''), 'www.' || v_host) and status <> 'REMOVED'
      and not public._store_domain_reserved(domain)
$b$);

-- The root proxy asks this before requesting a certificate: never for a platform name.
do $$
begin
  if to_regprocedure('public.store_domain_known(text)') is not null then
    perform pg_temp.patch_fn('public.store_domain_known(text)', '_store_domain_reserved',
      $a$status <> 'REMOVED'$a$,
      $b$status <> 'REMOVED' and not public._store_domain_reserved(domain)$b$);
  end if;
end $$;

-- -----------------------------------------------------------------------------
-- 2. Super Admin finance and ads report: merchant rows only within the caller's scope.
-- -----------------------------------------------------------------------------

create or replace function public._platform_finance_rows(p_from date, p_to date)
returns table(id text, type text, category_id uuid, sub_category text, txn_date date, amount numeric, foreign_amount numeric,
              foreign_currency text, exchange_rate numeric, notes text, reference text, source text, txn_number text,
              created_by text, created_at timestamptz, editable boolean, voided boolean, merchant text)
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  with bounds as (
    select (p_from::timestamp at time zone 'Asia/Dhaka') as t_from, ((p_to + 1)::timestamp at time zone 'Asia/Dhaka') as t_to
  ), cat as (
    select c.type, c.code, c.id from public.platform_finance_categories c
  ), scope as (
    select public._platform_merchant_ids() as id
  )
  select e.id::text, e.type, e.category_id, e.sub_category, e.txn_date, e.amount, e.foreign_amount, e.foreign_currency, e.exchange_rate,
         e.notes, e.reference, e.source, e.txn_number, e.created_by_email, e.created_at,
         e.source = 'MANUAL' and e.voided_at is null, e.voided_at is not null, null::text
  from public.platform_finance_entries e
  where e.txn_date between p_from and p_to
  union all
  -- Verified payments from merchants, by what the invoice was for.
  select 'billing:' || p.id, 'INCOME', c.id, null, (coalesce(p.verified_at, p.created_at) at time zone 'Asia/Dhaka')::date, p.amount, null, null, null,
         m.name || ' · ' || i.number, p.reference, 'BILLING', i.number, null, p.created_at, false, false, m.name
  from public.billing_payments p
  join public.billing_invoices i on i.id = p.invoice_id
  join public.merchants m on m.id = p.merchant_id and not m.is_demo and m.id in (select id from scope)
  join cat c on c.type = 'INCOME' and c.code = case i.kind when 'SUBSCRIPTION' then 'SUBSCRIPTIONS' when 'CREDITS' then 'CREDITS'
                                                           when 'ADDON' then 'ADDONS' else 'OTHER_BILLING' end
  cross join bounds b
  where p.status = 'SUCCEEDED' and coalesce(p.verified_at, p.created_at) >= b.t_from and coalesce(p.verified_at, p.created_at) < b.t_to
  union all
  -- VoiceDrive packages and call top-ups paid with bKash.
  select 'pbx:' || t.id, 'INCOME', c.id, initcap(t.type), (t.completed_at at time zone 'Asia/Dhaka')::date, t.amount_tk, null, null, null,
         m.name || ' · ' || case t.type when 'PACKAGE' then 'PBX package' else 'PBX top-up' end, t.trx_id, 'BILLING', t.reference, null, t.created_at,
         false, false, m.name
  from public.pbx_bkash_transactions t
  join public.merchants m on m.id = t.merchant_id and not m.is_demo and m.id in (select id from scope)
  join cat c on c.type = 'INCOME' and c.code = 'PBX'
  cross join bounds b
  where t.status = 'COMPLETED' and t.completed_at >= b.t_from and t.completed_at < b.t_to
  union all
  -- Money sent back to merchants.
  select 'refund:' || r.id, 'EXPENSE', c.id, initcap(r.method), (r.completed_at at time zone 'Asia/Dhaka')::date, r.amount, null, null, null,
         m.name || ' · ' || r.reason, r.provider_refund_id, 'BILLING', i.number, null, r.created_at, false, false, m.name
  from public.billing_refunds r
  join public.billing_payments p on p.id = r.payment_id
  join public.billing_invoices i on i.id = p.invoice_id
  join public.merchants m on m.id = r.merchant_id and not m.is_demo and m.id in (select id from scope)
  join cat c on c.type = 'EXPENSE' and c.code = 'MERCHANT_REFUNDS'
  cross join bounds b
  where r.status = 'SUCCEEDED' and r.completed_at >= b.t_from and r.completed_at < b.t_to
$$;

-- True when the signed-in platform staff member sees every merchant (super role or ALL scope).
create or replace function public._platform_scope_all()
returns boolean
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  select exists (select 1 from public.platform_staff s join public.platform_roles r on r.id = s.role_id
                 where s.user_id = auth.uid() and s.is_active and (r.is_super or s.merchant_scope = 'ALL'))
$$;
revoke all on function public._platform_scope_all() from public, anon, authenticated;

-- Leads tied to a merchant show only within scope; leads not tied to any merchant
-- (WhatsApp requests not yet converted, contact messages) only to ALL-scope staff.
select pg_temp.patch_fn('public._platform_leads(date,date)', '_platform_scope_all',
$a$                     where bp.merchant_id = x.merchant_id and bp.status = 'SUCCEEDED') pay on x.merchant_id is not null
$a$,
$b$                     where bp.merchant_id = x.merchant_id and bp.status = 'SUCCEEDED') pay on x.merchant_id is not null
  where (x.merchant_id is null and public._platform_scope_all())
     or x.merchant_id in (select public._platform_merchant_ids())
$b$);

insert into public.tenancy_exempt_functions (name, reason)
values ('_platform_scope_all', 'Super Admin: whether the signed-in platform staff member sees every merchant'),
       ('_store_domain_reserved', 'Custom domains: platform-owned host names, read from platform settings'),
       ('_store_domain_taken', 'Custom domains: whether another store holds a name (the www/apex twin check)')
on conflict (name) do nothing;

-- -----------------------------------------------------------------------------
-- 3. Inbox: customer profiles need customers.view, order details need orders.view.
-- -----------------------------------------------------------------------------

select pg_temp.patch_fn('public.inbox_update(uuid,jsonb)', 'linking a customer needs customers.view',
$a$  perform public.require_permission('inbox.reply');
$a$,
$b$  perform public.require_permission('inbox.reply');
  -- linking a customer needs customers.view; linking an order needs orders.view.
  if p ? 'customer_id' and nullif(p ->> 'customer_id', '') is not null then
    perform public.require_permission('customers.view');
  end if;
  if p ? 'linked_order_id' and nullif(p ->> 'linked_order_id', '') is not null then
    perform public.require_permission('orders.view');
  end if;
$b$);

select pg_temp.patch_fn_many('public.inbox_thread(uuid,timestamptz,integer)', $m$'customer', case when public.has_permission('customers.view')$m$, array[
$a$    'customer', (select jsonb_build_object($a$,
$b$    'customer', case when public.has_permission('customers.view') then (select jsonb_build_object($b$,
$a$      from public.customers c where c.id = v_customer),
$a$,
$b$      from public.customers c where c.id = v_customer) end,
$b$,
$a$    'orders', coalesce((select jsonb_agg($a$,
$b$    'orders', case when not public.has_permission('orders.view') then '[]'::jsonb else coalesce((select jsonb_agg($b$,
$a$            order by o.created_at desc limit 10) o), '[]'::jsonb),
$a$,
$b$            order by o.created_at desc limit 10) o), '[]'::jsonb) end,
$b$]);

select pg_temp.patch_fn('public.inbox_order_message(uuid,text)', $m$require_permission('orders.view')$m$,
$a$  perform public.require_permission('inbox.reply');
$a$,
$b$  perform public.require_permission('inbox.reply');
  perform public.require_permission('orders.view');
$b$);

-- -----------------------------------------------------------------------------
-- 4. Plan changes follow billing_choose_plan's rules at payment time too.
-- -----------------------------------------------------------------------------

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
  select * into s from public.subscriptions where merchant_id = p_inv.merchant_id and ended_at is null for update;
  -- Paused by the platform team, or the plan is no longer on offer: keep the money, flag it, change nothing.
  if v_plan.id is null or v_plan.status <> 'ACTIVE' or not v_plan.is_public or (s.id is not null and s.status = 'PAUSED') then
    update public.billing_payments set needs_review = true,
      review_note = left(format('Plan change %s was paid but not applied (subscription %s, plan %s): refund it or apply it by hand',
                                p_inv.number, coalesce(s.status, 'none'), coalesce(v_plan.status, 'missing')), 500)
    where invoice_id = p_inv.id and status = 'SUCCEEDED';
    return;
  end if;
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

select pg_temp.patch_fn('public.billing_gateway_payment_create(uuid,text)', 'this plan change can no longer be paid',
$a$  v_purpose := public._billing_invoice_purpose(v_inv);
$a$,
$b$  if v_inv.plan_change is not null and (
       exists (select 1 from public.subscriptions where merchant_id = v_merchant and ended_at is null and status = 'PAUSED')
       or not exists (select 1 from public.plans where id = (v_inv.plan_change ->> 'plan_id')::uuid and status = 'ACTIVE' and is_public)) then
    raise exception 'VALIDATION: this plan change can no longer be paid; contact the platform team' using errcode = '22023';
  end if;
  v_purpose := public._billing_invoice_purpose(v_inv);
$b$);

select pg_temp.patch_fn('public.platform_subscription_action(uuid,text,jsonb)', 'Plan change cancelled: the subscription was paused',
$a$      update public.subscriptions set status = 'PAUSED', paused_at = now() where id = s.id returning * into s;
$a$,
$b$      update public.subscriptions set status = 'PAUSED', paused_at = now() where id = s.id returning * into s;
      update public.billing_invoices set status = 'VOID', void_reason = 'Plan change cancelled: the subscription was paused'
      where merchant_id = p_merchant and plan_change is not null and status = 'OPEN' and amount_paid = 0;
$b$);

-- -----------------------------------------------------------------------------
-- 5. Order RPCs: no cost_total for staff who may not see costs.
--
-- Each authenticated-callable function returning public.orders is renamed to
-- _raw_<name> (no longer callable by users) and replaced by a wrapper with the
-- same signature that clears cost_total unless _can_see_costs().
-- -----------------------------------------------------------------------------

do $do$
declare
  r record;
  v_raw text;
  v_call text;
  v_role text;
begin
  for r in
    select p.oid, p.proname, pg_get_function_arguments(p.oid) as args, oidvectortypes(p.proargtypes) as ident, p.proargtypes,
           p.proargnames, p.pronargs
    from pg_proc p
    where p.pronamespace = 'public'::regnamespace
      and p.prorettype = 'public.orders'::regtype
      and p.prokind = 'f'
      and p.proname not like '\_%'
      and has_function_privilege('authenticated', p.oid, 'execute')
  loop
    v_raw := '_raw_' || r.proname;
    if exists (select 1 from pg_proc x where x.pronamespace = 'public'::regnamespace and x.proname = v_raw and x.proargtypes = r.proargtypes) then
      continue; -- already wrapped
    end if;
    execute format('alter function %s rename to %I', r.oid::regprocedure, v_raw);
    select string_agg(format('%1$I => %1$I', n), ', ' order by i) into v_call
    from unnest(r.proargnames[1:r.pronargs]) with ordinality as a(n, i);
    execute format($f$
      create function public.%1$I(%2$s)
      returns public.orders
      language plpgsql
      security definer
      set search_path = public, pg_temp
      as $w$
      declare
        v public.orders;
      begin
        v := public.%3$I(%4$s);
        if not public._can_see_costs() then
          v.cost_total := null;
        end if;
        return v;
      end;
      $w$
      $f$, r.proname, r.args, v_raw, coalesce(v_call, ''));
    execute format('revoke all on function public.%I(%s) from public, anon, authenticated, service_role', r.proname, r.ident);
    foreach v_role in array array['anon', 'authenticated', 'service_role'] loop
      if has_function_privilege(v_role, r.oid, 'execute') then
        execute format('grant execute on function public.%I(%s) to %I', r.proname, r.ident, v_role);
      end if;
    end loop;
    execute format('revoke all on function %s from public, anon, authenticated', r.oid::regprocedure);
    execute format('comment on function public.%I(%s) is %L', r.proname, r.ident,
      format('Calls %s and clears cost_total for staff who may not see costs (security audit run 3).', v_raw));
  end loop;
end $do$;

-- -----------------------------------------------------------------------------
-- 6. WhatsApp sign-up: never overwrite an earlier request; a few per number per hour.
-- -----------------------------------------------------------------------------

select pg_temp.patch_fn('public.public_signup_request(jsonb)', 'too many sign-up requests for this number',
$a$  select id into v_id from public.signup_requests
  where phone = v_phone and status = 'NEW' and created_at > now() - interval '30 minutes'
  order by created_at desc limit 1 for update;
  if v_id is null and (select count(*) from public.signup_requests where created_at > now() - interval '1 hour') >= 60 then
$a$,
$b$  if (select count(*) from public.signup_requests where phone = v_phone and created_at > now() - interval '1 hour') >= 3 then
    raise exception 'RATE_LIMITED: too many sign-up requests for this number; please try again later' using errcode = 'P0001';
  end if;
  if (select count(*) from public.signup_requests where created_at > now() - interval '1 hour') >= 60 then
$b$);

select public._tenancy_own_functions();
