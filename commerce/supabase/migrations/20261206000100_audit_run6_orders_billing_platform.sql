-- =============================================================================
-- Security audit run 6: orders, quotes, billing, platform announcements, the mailbox server setting.
--
--   * Creating an order (orders.create) no longer shows or approves an order that already exists:
--     an existing order's key needs orders.view to be answered and orders.status (plus fraud.review
--     for orders waiting for an advance or a fraud review) to be confirmed. A new order that joins
--     an earlier order someone else created shows a caller without orders.view only its number and
--     status.
--   * A storefront or website-API checkout that joins an earlier order gets back only what it sent
--     (its own lines and "merged"), never the earlier order's name, address, items or number. The
--     merge itself is unchanged: staff still see one order and confirm it by phone.
--   * New-order quotes leave out cost prices for staff who may not see costs (the Moderator role).
--   * Under the new-business offer, a renewal raised while an unpaid plan change is open still
--     carries the one-time setup fee; whichever invoice is paid first settles it.
--   * Platform staff limited to some stores see, withdraw and edit only announcements for their
--     stores.
--   * The mailbox server (Settings > notifications) changes only through the Email page's connect
--     step, so the saved mailbox password signs in only where it was connected.
--
-- Patched in place where a function is long (CREATE OR REPLACE keeps owner and grants), every
-- matched line written as a one-line E'' string. Safe to re-run.
-- =============================================================================

-- ---------------------------------------------------------------- creating an order (staff)
create or replace function public._raw_admin_create_order(p_payload jsonb, p_confirm boolean default false)
returns public.orders
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_order public.orders;
  v_min public.orders;
  v_shown uuid;
  v_key text := nullif(p_payload ->> 'idempotency_key', '');
  v_is_new boolean := v_key is null or not exists (select 1 from public.orders where idempotency_key = v_key);
  v_sees boolean;
begin
  perform public.require_permission('orders.create');
  v_sees := public.is_system_context() or public.has_permission('orders.view');
  -- The key names an order that already exists: answering with it shows it.
  if not v_is_new and not v_sees then
    raise exception 'PERMISSION_DENIED: orders.view is required to open an existing order' using errcode = '42501';
  end if;
  v_order := public._create_order(p_payload, 'ADMIN');
  if p_confirm then
    -- Confirming an order that already exists is a status change like any other.
    if not v_is_new and not public.is_system_context() then
      perform public.require_permission('orders.status');
      if v_order.status in ('ADVANCE_REQUIRED', 'FRAUD_REVIEW') then
        perform public.require_permission('fraud.review');
      end if;
    end if;
    v_order := public._transition_order(v_order.id, 'CONFIRMED', 'Confirmed by staff when the order was created');
  end if;
  if v_is_new then
    v_shown := public._after_order_created(v_order.id);
    select * into v_order from public.orders where id = v_shown;
  end if;
  perform public.log_audit('order.created', 'order', v_order.id::text, null,
    jsonb_build_object('order_number', v_order.order_number, 'total', v_order.total_amount));
  -- Joined an order someone else created: a caller who may not see orders gets its number and status only.
  if not v_sees and v_order.created_by is distinct from auth.uid() then
    v_min.id := v_order.id;
    v_min.merchant_id := v_order.merchant_id;
    v_min.order_number := v_order.order_number;
    v_min.status := v_order.status;
    v_min.merged_count := v_order.merged_count;
    return v_min;
  end if;
  return v_order;
end;
$$;

-- ---------------------------------------------------------------- storefront checkout
-- What a checkout that joined an earlier order is told: its own lines, never the order it joined.
create or replace function public._merged_checkout_reply(p_own_order uuid, p_lines jsonb)
returns jsonb
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  select jsonb_build_object(
    'id', p_own_order,
    'order_number', null,
    'status', 'MERGED',
    'merged', true,
    'items', coalesce((select jsonb_agg(jsonb_build_object(
        'product_name', l ->> 'product_name', 'variant_title', l ->> 'variant_title',
        'quantity', (l ->> 'quantity')::int, 'unit_price', (l ->> 'unit_price')::numeric,
        'line_subtotal', coalesce((l ->> 'line_subtotal')::numeric, (l ->> 'unit_price')::numeric * (l ->> 'quantity')::int)))
      from jsonb_array_elements(coalesce(p_lines, '[]'::jsonb)) l), '[]'::jsonb),
    'subtotal', coalesce((select sum(coalesce((l ->> 'line_subtotal')::numeric, (l ->> 'unit_price')::numeric * (l ->> 'quantity')::int))
      from jsonb_array_elements(coalesce(p_lines, '[]'::jsonb)) l), 0),
    'amount_due_now', 0,
    'payment_requirement', null)
$$;
revoke all on function public._merged_checkout_reply(uuid, jsonb) from public, anon, authenticated;

create or replace function public.place_storefront_order(p_payload jsonb, p_fraud_check_id uuid default null)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_order public.orders;
  v_target public.orders;
  v_merge public.order_merges;
  v_key text := nullif(p_payload ->> 'idempotency_key', '');
  v_is_new boolean;
  v_shown uuid;
begin
  if not public.is_system_context() then
    raise exception 'PERMISSION_DENIED' using errcode = '42501';
  end if;

  -- A retry of a checkout that joined an earlier order gets the same answer.
  if v_key is not null then
    select * into v_merge from public.order_merges where idempotency_key = v_key;
    if found then
      return public._merged_checkout_reply(v_merge.source_order_id, v_merge.items);
    end if;
  end if;

  v_is_new := v_key is null or not exists (select 1 from public.orders where idempotency_key = v_key);
  if v_is_new then
    v_target := public._find_merge_target(p_payload, p_fraud_check_id);
    if v_target.id is not null then
      perform public._merge_checkout_into(v_target.id, p_payload);
      select * into v_merge from public.order_merges
      where order_id = v_target.id and source_order_id is null and idempotency_key is not distinct from v_key
      order by created_at desc limit 1;
      return public._merged_checkout_reply(null, v_merge.items);
    end if;
  end if;

  -- A retry gets its own order back: the key must belong to a checkout with the same phone.
  if not v_is_new and not exists (select 1 from public.orders o where o.idempotency_key = v_key and o.source = 'STOREFRONT'
                                   and o.customer_phone = public.clean_phone(p_payload #>> '{customer,phone}')) then
    raise exception 'VALIDATION: this checkout was already used; refresh the page and try again' using errcode = '22023';
  end if;
  v_order := public._create_order(p_payload, 'STOREFRONT');
  if v_is_new then
    v_order := public._apply_fraud_decision(v_order.id, p_fraud_check_id);
    v_shown := public._after_order_created(v_order.id);
    if v_shown <> v_order.id then
      select * into v_merge from public.order_merges where source_order_id = v_order.id order by created_at desc limit 1;
      return public._merged_checkout_reply(v_order.id, v_merge.items);
    end if;
  end if;

  return public._order_public_json(v_order) || jsonb_build_object(
    'merged', false,
    'payment_requirement', public.payment_requirement_for(
      coalesce(v_order.fraud_decision, 'ALLOW'), v_order.advance_required, v_order.total_amount, v_order.payment_method));
end;
$$;

-- ---------------------------------------------------------------- new-order quotes
create or replace function public.admin_quote_order(
  p_items jsonb, p_district text, p_area text default null, p_delivery_method text default 'standard',
  p_coupon_code text default null, p_phone text default null
)
returns jsonb
language plpgsql
stable
security definer
set search_path = public, pg_temp
as $$
declare
  v jsonb;
begin
  perform public.require_permission('orders.create');
  v := public.calculate_order_quote(p_items, p_district, p_area, p_delivery_method, p_coupon_code, p_phone, true,
    public.has_permission('orders.price_override'));
  -- Prices and totals for everyone; cost prices only for staff who may see costs (as order_catalog).
  if not public._can_see_costs() then
    v := (v - 'cost_total') || jsonb_build_object('lines',
      (select coalesce(jsonb_agg(e.l - 'unit_cost' order by e.i), '[]'::jsonb)
       from jsonb_array_elements(coalesce(v -> 'lines', '[]'::jsonb)) with ordinality as e(l, i)));
  end if;
  return v;
end;
$$;

-- ---------------------------------------------------------------- the one-time setup fee
-- An open, unpaid plan change does not count as having charged the fee: the renewal carries it too,
-- and whichever is paid first settles it (paying the plan change voids the open renewal; a paid
-- renewal makes the plan change refuse with "the setup fee is already paid").
do $$
declare
  v_old text := replace(pg_get_functiondef('public._billing_invoice_for(public.subscriptions,timestamptz,timestamptz)'::regprocedure), E'\r', '');
  v_from text := E'where i.subscription_id = p_sub.id and i.status <> ''VOID''';
begin
  if position('i.plan_change is not null' in v_old) > 0 then
    return; -- already patched
  end if;
  if (length(v_old) - length(replace(v_old, v_from, ''))) / length(v_from) <> 1 then
    raise exception 'setup fee: _billing_invoice_for has changed';
  end if;
  execute replace(v_old, v_from, v_from || E' and not (i.status = ''OPEN'' and coalesce(i.amount_paid, 0) = 0 and i.plan_change is not null)');
end $$;

do $$
declare
  v_old text := replace(pg_get_functiondef('public.my_plan()'::regprocedure), E'\r', '');
  v_from text := E'where i.subscription_id = s.id and i.status <> ''VOID''';
begin
  if position('i.plan_change is not null' in v_old) > 0 then
    return; -- already patched
  end if;
  if (length(v_old) - length(replace(v_old, v_from, ''))) / length(v_from) <> 1 then
    raise exception 'setup fee: my_plan has changed';
  end if;
  execute replace(v_old, v_from, v_from || E' and not (i.status = ''OPEN'' and coalesce(i.amount_paid, 0) = 0 and i.plan_change is not null)');
end $$;

-- ---------------------------------------------------------------- platform announcements
-- Whether an announcement is addressed only to the signed-in employee's stores (or the employee sees every store).
create or replace function public._platform_announcement_in_scope(p_id uuid)
returns boolean
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  select public._platform_scope_all() or exists (
    select 1 from public.platform_announcements a
    where a.id = p_id and coalesce(a.audience ->> 'type', 'ALL') = 'MERCHANTS'
      and not exists (select 1 from jsonb_array_elements_text(coalesce(a.audience -> 'merchants', '[]'::jsonb)) e(id)
                      where e.id::uuid not in (select public._platform_merchant_ids())))
$$;
revoke all on function public._platform_announcement_in_scope(uuid) from public, anon, authenticated;
-- A platform function: it reads announcements across stores, like the other announcement functions.
insert into public.tenancy_exempt_functions (name, reason)
values ('_platform_announcement_in_scope', 'Platform announcements: whether an announcement is addressed only to the signed-in employee''s stores')
on conflict (name) do nothing;

do $$
declare
  v_old text := replace(pg_get_functiondef('public.platform_announcement_get(uuid)'::regprocedure), E'\r', '');
  v_from text := E'where d.announcement_id = a.id))';
begin
  if position('_platform_merchant_ids' in v_old) > 0 then
    return; -- already patched
  end if;
  if (length(v_old) - length(replace(v_old, v_from, ''))) / length(v_from) <> 1 then
    raise exception 'platform scope: platform_announcement_get has changed';
  end if;
  execute replace(v_old, v_from, E'where d.announcement_id = a.id and d.merchant_id in (select public._platform_merchant_ids())))');
end $$;

do $$
declare
  v_old text := replace(pg_get_functiondef('public.platform_announcement_cancel(uuid,text)'::regprocedure), E'\r', '');
  v_from text := E'  perform public._platform_require(''notifications'', ''manage'');\n';
begin
  if position('_platform_announcement_in_scope' in v_old) > 0 then
    return; -- already patched
  end if;
  if (length(v_old) - length(replace(v_old, v_from, ''))) / length(v_from) <> 1 then
    raise exception 'platform scope: platform_announcement_cancel has changed';
  end if;
  execute replace(v_old, v_from, v_from
    || E'  if not public._platform_announcement_in_scope(p_id) then\n'
    || E'    raise exception ''PERMISSION_DENIED: you can withdraw only announcements sent to the stores assigned to you'' using errcode = ''42501'';\n'
    || E'  end if;\n');
end $$;

do $$
declare
  v_old text := replace(pg_get_functiondef('public.platform_announcement_save(jsonb)'::regprocedure), E'\r', '');
  v_from text := E'  else\n    update public.platform_announcements set kind';
begin
  if position('_platform_announcement_in_scope' in v_old) > 0 then
    return; -- already patched
  end if;
  if (length(v_old) - length(replace(v_old, v_from, ''))) / length(v_from) <> 1 then
    raise exception 'platform scope: platform_announcement_save has changed';
  end if;
  execute replace(v_old, v_from, E'  else\n'
    || E'    if not public._platform_announcement_in_scope((p ->> ''id'')::uuid) then\n'
    || E'      raise exception ''PERMISSION_DENIED: you can change only drafts for the stores assigned to you'' using errcode = ''42501'';\n'
    || E'    end if;\n'
    || E'    update public.platform_announcements set kind');
end $$;

-- ---------------------------------------------------------------- the mailbox server setting
-- The customer-message channels (the mailbox server, the WhatsApp number) change only on the Email
-- and WhatsApp pages, so the saved mailbox password signs in only where it was connected.
do $$
declare
  v_old text := replace(pg_get_functiondef('public.admin_update_setting(text,jsonb)'::regprocedure), E'\r', '');
  v_from text := E'if p_key in (''device_approval'', ''hr'', ''pbx'', ''storefront_draft'', ''seo'') then';
  v_to text := E'if p_key in (''device_approval'', ''hr'', ''pbx'', ''storefront_draft'', ''seo'', ''notifications'') then';
begin
  if position(v_to in v_old) > 0 then
    return; -- already patched
  end if;
  if (length(v_old) - length(replace(v_old, v_from, ''))) / length(v_from) <> 1 then
    raise exception 'settings lock: admin_update_setting has changed';
  end if;
  execute replace(v_old, v_from, v_to);
end $$;

select public._tenancy_own_functions();
