-- =============================================================================
-- Our order number is given when an order is approved: 1000, 1001, 1002, … for each business.
--
-- Asked for on 30 Oct 2026: a web order has no Fullfilio order number yet.
--   * A Shopify or WooCommerce order keeps showing its store number (#1052) while it waits, as before.
--   * An order made in Fullfilio (own store, staff, chat, the API) waits under a web reference: W and a
--     running number (W10501).
--   * When the order is approved (confirmed for the first time) it gets the business's next number:
--     1000, 1001, 1002, … so cancelled and fake web orders leave no gaps. Every business counts on its
--     own, and can put a prefix in front (Settings → Advanced: "ATH" gives ATH-1000). No prefix is
--     the default, for every business.
--
-- How:
--   * order_counters keeps the last number each business gave. A number one of the business's orders
--     already has (a Shopify order's own number, for example) is skipped.
--   * orders.web_number keeps the number the order had before it was approved, so the web reference
--     or store number a customer or a staff member wrote down still finds it: the tracking and payment
--     pages, the searches, the API, the parcel scanner and courier statements.
--   * The ad Purchase event keeps the id it was given when the order was placed, so the browser and
--     server copies still count once.
--   * Nothing already approved is renumbered. Look-only demo businesses keep their prefix.
--
-- Functions that change in a line or two are patched in place (CREATE OR REPLACE keeps each one's
-- owner and grants). Safe to re-run.
-- =============================================================================

-- 1. The last number each business gave ------------------------------------------------------------

create table if not exists public.order_counters (
  merchant_id uuid primary key default public.current_merchant_id() references public.merchants(id) on delete cascade,
  last_number bigint not null
);

alter table public.order_counters enable row level security;
drop policy if exists tenant_isolation on public.order_counters;
create policy tenant_isolation on public.order_counters as restrictive for all to public
  using (merchant_id = (select public.current_merchant_id()))
  with check (merchant_id = (select public.current_merchant_id()) and not (select public._support_read_only()));
drop policy if exists app_owner_all on public.order_counters;
create policy app_owner_all on public.order_counters for all to app_owner using (true) with check (true);
-- Only the functions below read or write it.
revoke all on public.order_counters from anon, authenticated;

-- 2. The number an order had before it was approved -------------------------------------------------

alter table public.orders add column if not exists web_number text;
create index if not exists orders_web_number_idx on public.orders (merchant_id, web_number) where web_number is not null;
-- Staff read orders column by column (order costs are hidden): the new column too.
grant select (web_number) on public.orders to authenticated;

-- 3. A new order's number ----------------------------------------------------------------------------
-- A store order takes its store number instead (orders_store_number) when this business has not used it.

create or replace function public.next_order_number()
returns text
language sql
volatile
security definer
set search_path = public, pg_temp
as $$
  select 'W' || nextval('public.order_number_seq')::text
$$;

-- 4. Our number for an approved order -----------------------------------------------------------------
-- Approvals of one business wait for each other here, so two can never get the same number, and a
-- number is only used when the approval is saved. The order being approved does not block its own
-- store number (Shopify #1001 can become our 1001).

create or replace function public._approved_order_number(p_merchant uuid, p_order uuid default null)
returns text
language plpgsql
volatile
security definer
set search_path = public, pg_temp
as $$
declare
  v_prefix text := left(upper(regexp_replace(coalesce(
    (select s.value ->> 'order_prefix' from public.settings s where s.merchant_id = p_merchant and s.key = 'store'), ''),
    '[^A-Za-z0-9]', '', 'g')), 8);
  v_n bigint;
  v_number text;
begin
  loop
    insert into public.order_counters (merchant_id, last_number) values (p_merchant, 1000)
    on conflict (merchant_id) do update set last_number = public.order_counters.last_number + 1
    returning last_number into v_n;
    v_number := case when v_prefix = '' then v_n::text else v_prefix || '-' || v_n::text end;
    exit when not exists (select 1 from public.orders o
                         where o.merchant_id = p_merchant and o.order_number = v_number and o.id is distinct from p_order);
  end loop;
  return v_number;
end;
$$;

-- 5. Given once, the first time the order is approved ------------------------------------------------

create or replace function public._orders_number_on_approval()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
begin
  if new.web_number is null then
    new.web_number := new.order_number;
    new.order_number := public._approved_order_number(new.merchant_id, new.id);
  end if;
  return new;
end;
$$;

drop trigger if exists orders_number_on_approval on public.orders;
create trigger orders_number_on_approval before update of confirmed_at on public.orders
  for each row when (old.confirmed_at is null and new.confirmed_at is not null)
  execute function public._orders_number_on_approval();

do $$
declare f text;
begin
  foreach f in array array['_approved_order_number(uuid,uuid)', '_orders_number_on_approval()'] loop
    execute format('revoke all on function public.%s from public, anon, authenticated', f);
  end loop;
end $$;

-- 6. The earlier number still finds the order ------------------------------------------------------------

create or replace function pg_temp.patch_fn(p_fn text, p_from text, p_to text)
returns void
language plpgsql as $$
declare
  v_old text := replace(pg_get_functiondef(p_fn::regprocedure), E'\r', '');
  v_hits int;
begin
  if position(p_to in v_old) > 0 then
    return; -- already patched
  end if;
  v_hits := (length(v_old) - length(replace(v_old, p_from, ''))) / length(p_from);
  if v_hits <> 1 then
    raise exception 'approval order numbers: % has changed (% matches for "%")', p_fn, v_hits, left(p_from, 60);
  end if;
  execute replace(v_old, p_from, p_to);
end $$;

-- The customer's tracking and payment pages.
select pg_temp.patch_fn('public.track_order(text,text)',
  $a$where order_number = upper(trim(coalesce(p_order_number, '')))$a$,
  $b$where upper(trim(coalesce(p_order_number, ''))) in (order_number, web_number)$b$);
select pg_temp.patch_fn('public.start_order_payment(text,text,public.payment_purpose,text,public.payment_channel)',
  $a$where order_number = upper(trim(p_order_number)) and customer_phone$a$,
  $b$where upper(trim(p_order_number)) in (order_number, web_number) and customer_phone$b$);
select pg_temp.patch_fn('public.submit_manual_payment(text,text,public.payment_channel,text,text,numeric)',
  $a$where order_number = upper(trim(p_order_number)) and customer_phone$a$,
  $b$where upper(trim(p_order_number)) in (order_number, web_number) and customer_phone$b$);

-- The API (an order's current number wins over another order's earlier one).
select pg_temp.patch_fn('public.api_order(uuid,text)',
  $a$where order_number = p_ref or id::text = p_ref limit 1;$a$,
  $b$where p_ref in (order_number, web_number) or id::text = p_ref order by (order_number = p_ref) desc limit 1;$b$);
select pg_temp.patch_fn('public.api_order_set_status(uuid,text,text,text)',
  $a$where order_number = p_ref or id::text = p_ref limit 1;$a$,
  $b$where p_ref in (order_number, web_number) or id::text = p_ref order by (order_number = p_ref) desc limit 1;$b$);

-- The searches.
select pg_temp.patch_fn('public.admin_search_orders(jsonb,text,text,integer,integer)',
  $a$or o.order_number ilike '%' || v_q || '%'$a$,
  $b$or o.order_number ilike '%' || v_q || '%' or o.web_number ilike '%' || v_q || '%'$b$);
select pg_temp.patch_fn('public.admin_global_search(text,integer)',
  $a$where o.order_number ilike v_like$a$,
  $b$where o.order_number ilike v_like or o.web_number ilike v_like$b$);
select pg_temp.patch_fn('public.platform_search(text)',
  $a$o.external_order_number = v_q or o.external_order_id = v_q)$a$,
  $b$o.external_order_number = v_q or o.external_order_id = v_q or o.web_number = v_q)$b$);

-- The parcel scanner, courier statements and courier status updates (a Shopify packing slip or a
-- parcel booked before approval carries the earlier number; the current number wins).
select pg_temp.patch_fn('public.scan_parcel(text,text,uuid)',
  $a$select * into v_order from public.orders where upper(order_number) = v_code for update;$a$,
  $b$select * into v_order from public.orders where v_code in (upper(order_number), upper(web_number)) order by upper(order_number) = v_code desc limit 1 for update;$b$);
select pg_temp.patch_fn('public.import_courier_invoice(jsonb)',
  $a$or (v_ref is not null and upper(o.order_number) = upper(v_ref)))$a$,
  $b$or (v_ref is not null and upper(v_ref) in (upper(o.order_number), upper(o.web_number))))$b$);
select pg_temp.patch_fn('public.import_courier_invoice(jsonb)',
  $a$             s.is_active desc, s.created_at desc$a$,
  $b$             (upper(o.order_number) = upper(v_ref)) is true desc, s.is_active desc, s.created_at desc$b$);
select pg_temp.patch_fn('public._process_courier_webhook(uuid)',
  $a$or (e.order_ref is not null and upper(o.order_number) = upper(e.order_ref)))$a$,
  $b$or (e.order_ref is not null and upper(e.order_ref) in (upper(o.order_number), upper(o.web_number))))$b$);
select pg_temp.patch_fn('public._process_courier_webhook(uuid)',
  $a$           s.is_active desc, s.created_at desc$a$,
  $b$           (upper(o.order_number) = upper(e.order_ref)) is true desc, s.is_active desc, s.created_at desc$b$);

-- 7. The ad Purchase event keeps the id from when the order was placed ------------------------------------

select pg_temp.patch_fn('public._queue_ad_purchase()',
  $a$'ffs_pu_' || regexp_replace(new.order_number, '[^A-Za-z0-9_-]', '', 'g')$a$,
  $b$'ffs_pu_' || regexp_replace(coalesce(new.web_number, new.order_number), '[^A-Za-z0-9_-]', '', 'g')$b$);
select pg_temp.patch_fn('public.ad_event_order(uuid)',
  $a$'order_number', o.order_number, 'status', o.status,$a$,
  $b$'order_number', o.order_number, 'web_number', o.web_number, 'status', o.status,$b$);

-- 8. The prefix is optional, and off by default ------------------------------------------------------------

select pg_temp.patch_fn('public.admin_update_setting(text,jsonb)',
  $a$coalesce(p_value ->> 'order_prefix', '') !~ '^[A-Z0-9]{1,8}$' then$a$,
  $b$coalesce(p_value ->> 'order_prefix', '') !~ '^[A-Z0-9]{0,8}$' then$b$);
select pg_temp.patch_fn('public.admin_update_setting(text,jsonb)',
  $a$'VALIDATION: order prefix must be 1-8 uppercase letters or digits'$a$,
  $b$'VALIDATION: an order prefix is up to 8 uppercase letters or digits, or none'$b$);
select pg_temp.patch_fn('public._merchant_seed_defaults(uuid)',
  $a$"order_prefix": "ISO"$a$,
  $b$"order_prefix": ""$b$);

-- Each business's change is written (and audited) as that business.
do $$
declare v_merchant uuid;
begin
  for v_merchant in
    select s.merchant_id from public.settings s join public.merchants m on m.id = s.merchant_id
    where s.key = 'store' and coalesce(s.value ->> 'order_prefix', '') <> '' and not m.view_only
  loop
    perform set_config('app.merchant_id', v_merchant::text, true);
    update public.settings set value = jsonb_set(value, '{order_prefix}', '""'::jsonb)
    where merchant_id = v_merchant and key = 'store';
  end loop;
  perform set_config('app.merchant_id', '', true);
end $$;

select public._tenancy_own_functions();
