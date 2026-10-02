-- =============================================================================
-- DEVELOPMENT SEED DATA — for local development and demos only.
-- Never run this against production. The application does not depend on it:
-- everything it needs to run is created by the migrations.
--
-- Staff logins (password for all: Password123!)
--   owner@example.com       OWNER
--   orders@example.com      ORDER_MANAGER
--   warehouse@example.com   INVENTORY_MANAGER
--   finance@example.com     FINANCE_MANAGER
--   production@example.com  PRODUCTION_MANAGER
-- Customer login: customer@example.com / Password123!
--
-- All data is created through the same database functions the app uses, so
-- stock, payments, finance entries and timelines are consistent. Afterwards
-- orders are spread over the last 30 days for realistic charts.
-- =============================================================================

-- Staff and customer accounts -------------------------------------------------
create or replace function pg_temp.seed_user(p_email text, p_name text, p_role text)
returns uuid
language plpgsql
as $$
declare
  v_id uuid;
begin
  select id into v_id from auth.users where email = p_email;
  if v_id is null then
    v_id := gen_random_uuid();
    insert into auth.users (instance_id, id, aud, role, email, encrypted_password, email_confirmed_at,
                            raw_app_meta_data, raw_user_meta_data, created_at, updated_at,
                            confirmation_token, email_change, email_change_token_new, recovery_token)
    values ('00000000-0000-0000-0000-000000000000', v_id, 'authenticated', 'authenticated', p_email,
            extensions.crypt('Password123!', extensions.gen_salt('bf')), now(),
            '{"provider":"email","providers":["email"]}', jsonb_build_object('full_name', p_name), now(), now(),
            '', '', '', '');
    insert into auth.identities (id, user_id, provider_id, identity_data, provider, last_sign_in_at, created_at, updated_at)
    values (gen_random_uuid(), v_id, v_id::text,
            jsonb_build_object('sub', v_id::text, 'email', p_email, 'email_verified', true), 'email', now(), now(), now());
  end if;
  if p_role is not null then
    perform public.admin_set_user_role(v_id, p_role, true);
    update public.profiles set full_name = p_name where id = v_id;
  end if;
  return v_id;
end;
$$;

select pg_temp.seed_user('owner@example.com', 'Ayesha Rahman', 'OWNER');
select pg_temp.seed_user('orders@example.com', 'Nadim Hossain', 'ORDER_MANAGER');
select pg_temp.seed_user('warehouse@example.com', 'Sabbir Ahmed', 'INVENTORY_MANAGER');
select pg_temp.seed_user('finance@example.com', 'Tasnim Akter', 'FINANCE_MANAGER');
select pg_temp.seed_user('production@example.com', 'Rafiq Islam', 'PRODUCTION_MANAGER');
select pg_temp.seed_user('customer@example.com', 'Demo Customer', null);

-- Store settings (dev values) --------------------------------------------------
update public.settings set value = value || jsonb_build_object(
  'name', 'Isolation', 'tagline', 'Everyday essentials, made in Bangladesh',
  'email', 'hello@example.com', 'phone', '01700000000', 'address', 'House 12, Road 5, Dhanmondi, Dhaka',
  'website_url', 'http://localhost:5173')
where key = 'store';
update public.settings set value = jsonb_set(value, '{providers,manual,accounts}',
  '[{"channel":"BKASH","label":"bKash Personal","number":"01700000000"},{"channel":"NAGAD","label":"Nagad Personal","number":"01700000001"}]')
where key = 'payments';
update public.settings set value = value || '{"featured_category_slugs": ["t-shirts", "hoodies", "accessories"],
  "announcement": "Free delivery inside Dhaka on orders over ৳3,000"}'::jsonb
where key = 'storefront';

-- Catalog ---------------------------------------------------------------------
insert into public.categories(name, slug, description, sort_order) values
  ('T-Shirts', 't-shirts', 'Soft cotton tees for every day', 1),
  ('Shirts', 'shirts', 'Linen and cotton shirts', 2),
  ('Hoodies', 'hoodies', 'Warm fleece and zip hoodies', 3),
  ('Bags', 'bags', 'Totes and everyday carry', 4),
  ('Accessories', 'accessories', 'Small leather goods, caps and socks', 5)
on conflict (slug) do nothing;

create or replace function pg_temp.seed_product(
  p_name text, p_slug text, p_category text, p_price numeric, p_compare numeric, p_cost numeric,
  p_sizes text[], p_colors text[], p_stock int, p_track boolean default true, p_production boolean default false,
  p_featured boolean default false, p_status text default 'ACTIVE', p_tags text[] default '{}', p_description text default null
)
returns uuid
language plpgsql
as $$
declare
  v_variants jsonb := '[]'::jsonb;
  v_size text;
  v_color text;
  v_prefix text := upper(left(regexp_replace(p_slug, '[^a-z]', '', 'g'), 6));
  v_product public.products;
  v_i int := 0;
begin
  if exists (select 1 from public.products where slug = p_slug) then
    return (select id from public.products where slug = p_slug);
  end if;
  foreach v_size in array coalesce(nullif(p_sizes, '{}'), array[null::text]) loop
    foreach v_color in array coalesce(nullif(p_colors, '{}'), array[null::text]) loop
      v_variants := v_variants || jsonb_build_object(
        'sku', v_prefix || coalesce('-' || upper(left(v_color, 3)), '') || coalesce('-' || v_size, ''),
        'title', coalesce(nullif(concat_ws(' / ', v_size, v_color), ''), 'Default'),
        'size', v_size, 'color', v_color,
        'option_values', jsonb_strip_nulls(jsonb_build_object('Size', v_size, 'Color', v_color)),
        'initial_stock', greatest(p_stock - (v_i % 3), 0));
      v_i := v_i + 1;
    end loop;
  end loop;

  v_product := public.admin_save_product(jsonb_build_object(
    'name', p_name, 'slug', p_slug, 'category_id', (select id from public.categories where slug = p_category),
    'brand', 'Isolation', 'status', p_status, 'price', p_price, 'compare_at_price', p_compare, 'cost_price', p_cost,
    'tags', to_jsonb(p_tags), 'is_featured', p_featured, 'track_inventory', p_track, 'requires_production', p_production,
    'option_names', to_jsonb(array_remove(array[case when p_sizes <> '{}' then 'Size' end, case when p_colors <> '{}' then 'Color' end], null)),
    'description', coalesce(p_description, p_name || ' — designed for comfort and made to last. Pre-washed to minimise shrinkage.'),
    'variants', v_variants));

  insert into public.product_images(product_id, url, alt, position, is_primary)
  select v_product.id, format('https://picsum.photos/seed/%s-%s/800/1000', p_slug, n), p_name, n - 1, n = 1
  from generate_series(1, 3) n;
  return v_product.id;
end;
$$;

select pg_temp.seed_product('Essential Cotton Tee', 'essential-cotton-tee', 't-shirts', 690, 850, 260,
  array['S', 'M', 'L', 'XL'], array['Black', 'White'], 30, true, false, true, 'ACTIVE', array['cotton', 'bestseller']);
select pg_temp.seed_product('Heavyweight Oversized Tee', 'heavyweight-oversized-tee', 't-shirts', 990, null, 380,
  array['M', 'L', 'XL'], array['Off-white'], 25, true, false, true, 'ACTIVE', array['cotton', 'oversized']);
select pg_temp.seed_product('Linen Resort Shirt', 'linen-resort-shirt', 'shirts', 1890, 2200, 820,
  array['M', 'L', 'XL'], array['Sand'], 8, true, false, false, 'ACTIVE', array['linen', 'summer']);
select pg_temp.seed_product('Fleece Pullover Hoodie', 'fleece-pullover-hoodie', 'hoodies', 2490, null, 1100,
  array['M', 'L'], array['Charcoal'], 3, true, false, true, 'ACTIVE', array['winter']);
select pg_temp.seed_product('Zip Hoodie', 'zip-hoodie', 'hoodies', 2790, 3200, 1200,
  array['M', 'L'], array['Navy'], 0, true, false, false, 'ACTIVE', array['winter']);
select pg_temp.seed_product('Canvas Tote Bag', 'canvas-tote-bag', 'bags', 650, null, 210,
  '{}', '{}', 40, true, false, true, 'ACTIVE', array['canvas', 'gift']);
select pg_temp.seed_product('Leather Card Holder', 'leather-card-holder', 'accessories', 1290, null, 480,
  '{}', array['Brown', 'Black'], 0, false, true, true, 'ACTIVE', array['leather', 'handmade', 'gift'],
  'Hand-stitched full-grain leather card holder, made to order in our workshop (3–4 days).');
select pg_temp.seed_product('Custom Embroidered Cap', 'custom-embroidered-cap', 'accessories', 890, null, 300,
  '{}', array['Black', 'Beige'], 0, false, true, false, 'ACTIVE', array['custom', 'made-to-order'],
  'Six-panel cotton cap embroidered with your initials. Made to order.');
select pg_temp.seed_product('Everyday Socks (3 pack)', 'everyday-socks-3-pack', 'accessories', 450, null, 150,
  '{}', '{}', 60, true, false, false, 'ACTIVE', array['basics']);
select pg_temp.seed_product('Winter Puffer Jacket', 'winter-puffer-jacket', 'hoodies', 4990, null, 2300,
  array['M', 'L'], array['Black'], 5, true, false, false, 'DRAFT', array['winter']);

-- Suppliers, purchasing ---------------------------------------------------------
insert into public.suppliers(name, contact_person, phone, email, address)
select * from (values
  ('Dhaka Garments Ltd', 'Mr. Kamal', '01711223344', 'sales@dhakagarments.example', 'Ashulia, Savar'),
  ('Leather Craft BD', 'Ms. Rupa', '01811223344', 'orders@leathercraft.example', 'Hazaribagh, Dhaka')
) s(name, contact_person, phone, email, address)
where not exists (select 1 from public.suppliers);

do $$
declare
  v_po public.purchase_orders;
begin
  v_po := public.admin_save_purchase_order(jsonb_build_object(
    'supplier_id', (select id from public.suppliers where name = 'Dhaka Garments Ltd'), 'status', 'ORDERED',
    'shipping_cost', 300, 'notes', 'Restock socks and totes',
    'items', jsonb_build_array(
      jsonb_build_object('variant_id', (select v.id from public.product_variants v join public.products p on p.id = v.product_id
                                        where p.slug = 'everyday-socks-3-pack' limit 1), 'quantity', 40, 'unit_cost', 140),
      jsonb_build_object('variant_id', (select v.id from public.product_variants v join public.products p on p.id = v.product_id
                                        where p.slug = 'canvas-tote-bag' limit 1), 'quantity', 20, 'unit_cost', 200))));
  perform public.receive_purchase_order(v_po.id, null, 'Delivered by supplier');
  perform public.record_purchase_payment(v_po.id, 5000, 'BANK_TRANSFER', null, 'TT-88812', 'Part payment');

  perform public.admin_save_purchase_order(jsonb_build_object(
    'supplier_id', (select id from public.suppliers where name = 'Leather Craft BD'), 'status', 'ORDERED',
    'expected_date', current_date + 7,
    'items', jsonb_build_array(
      jsonb_build_object('variant_id', (select v.id from public.product_variants v join public.products p on p.id = v.product_id
                                        where p.slug = 'fleece-pullover-hoodie' limit 1), 'quantity', 15, 'unit_cost', 1050))));
end $$;

-- Couriers & coupons ------------------------------------------------------------
insert into public.couriers(name, provider, tracking_url_template, phone, default_shipping_cost, notes)
select * from (values
  ('Steadfast', 'steadfast', 'https://steadfast.com.bd/t/{tracking}', '09678000000', 70::numeric, 'API: set STEADFAST_API_KEY / STEADFAST_SECRET_KEY'),
  ('Pathao', 'manual', 'https://merchant.pathao.com/tracking?consignment_id={tracking}', null, 75::numeric, null),
  ('RedX', 'manual', null, null, 70::numeric, null)
) c(name, provider, tracking_url_template, phone, default_shipping_cost, notes)
where not exists (select 1 from public.couriers where name = 'Steadfast');

insert into public.coupons(code, description, discount_type, discount_value, min_order_value, max_discount, per_customer_limit, usage_limit)
values
  ('WELCOME10', '10% off your first order', 'PERCENTAGE', 10, 0, 300, 1, null),
  ('FREESHIP', 'Free delivery over ৳1,500', 'FREE_DELIVERY', 0, 1500, null, null, null),
  ('EID200', '৳200 off orders over ৳2,000', 'FIXED', 200, 2000, null, 2, 500)
on conflict (code) do nothing;

-- Orders through every stage ---------------------------------------------------
create temporary table seed_orders(order_id uuid, offset_days int);

-- n-th active variant of a product (falls back to the first one).
create or replace function pg_temp.variant(p_slug text, p_n int default 1)
returns uuid
language sql
as $$
  select coalesce(
    (select v.id from public.product_variants v join public.products p on p.id = v.product_id
     where p.slug = p_slug and v.is_active order by v.position offset p_n - 1 limit 1),
    (select v.id from public.product_variants v join public.products p on p.id = v.product_id
     where p.slug = p_slug and v.is_active order by v.position limit 1))
$$;

create or replace function pg_temp.seed_order(
  p_name text, p_phone text, p_district text, p_items jsonb, p_offset int,
  p_counts jsonb default '{}'::jsonb, p_payment text default 'COD', p_coupon text default null,
  p_auth uuid default null, p_utm text default null
)
returns uuid
language plpgsql
as $$
declare
  v_check public.fraud_checks;
  v_result jsonb;
begin
  v_check := public.record_fraud_check(jsonb_build_object('phone', p_phone,
    'provider', case when p_counts = '{}'::jsonb then 'internal' else 'http' end,
    'providers', case when p_counts = '{}'::jsonb then '["internal"]'::jsonb else '["internal","http"]'::jsonb end,
    'provider_counts', p_counts));
  v_result := public.place_storefront_order(jsonb_build_object(
    'customer', jsonb_build_object('full_name', p_name, 'phone', p_phone, 'email', lower(split_part(p_name, ' ', 1)) || '@example.com'),
    'shipping', jsonb_build_object('address', 'House ' || (10 + p_offset) || ', Road ' || (3 + p_offset % 7) || ', ' || p_district,
                                   'district', p_district, 'area', null),
    'items', p_items, 'payment_method', p_payment, 'coupon_code', p_coupon, 'auth_user_id', p_auth,
    'utm', case when p_utm is not null then jsonb_build_object('source', 'facebook', 'medium', 'paid', 'campaign', p_utm) end
  ), v_check.id);
  insert into seed_orders values ((v_result ->> 'id')::uuid, p_offset);
  return (v_result ->> 'id')::uuid;
end;
$$;

create or replace function pg_temp.go(p_order uuid, p_statuses text[])
returns void
language plpgsql
as $$
declare
  v_s text;
begin
  -- Web orders wait for approval; the seeded ones that move on were approved first.
  if (select status from public.orders where id = p_order) = 'CONFIRMATION_REQUIRED' and p_statuses[1] <> 'CONFIRMED' then
    perform public._transition_order(p_order, 'CONFIRMED', 'Approved after a confirmation call');
  end if;
  foreach v_s in array p_statuses loop
    perform public._transition_order(p_order, v_s::public.order_status, null);
  end loop;
end;
$$;

create or replace function pg_temp.ship(p_order uuid, p_courier text, p_tracking text)
returns void
language plpgsql
as $$
begin
  perform pg_temp.go(p_order, array['PROCESSING', 'PACKING', 'READY_TO_SHIP']);
  perform public.assign_courier(p_order, (select id from public.couriers where name = p_courier), p_tracking,
    (select default_shipping_cost from public.couriers where name = p_courier));
  perform public._transition_order(p_order, 'SHIPPED', 'Handed to ' || p_courier);
end;
$$;

do $$
declare
  o uuid;
  v_customer uuid := (select id from auth.users where email = 'customer@example.com');
begin
  -- 1. Repeat customer, delivered and settled
  o := pg_temp.seed_order('Rahim Uddin', '01711000001', 'Dhaka',
    jsonb_build_array(jsonb_build_object('variant_id', pg_temp.variant('essential-cotton-tee', 1), 'quantity', 2)), 26,
    p_utm => 'eid-collection');
  perform pg_temp.ship(o, 'Steadfast', 'SF1000001');
  perform public._transition_order(o, 'DELIVERED', 'Delivered by courier');
  perform public.record_cod_settlement(array(select id from public.shipments where order_id = o), 'Steadfast payout #1');

  -- 2. Delivered, COD still with the courier
  o := pg_temp.seed_order('Karim Hasan', '01811000002', 'Chattogram',
    jsonb_build_array(jsonb_build_object('variant_id', pg_temp.variant('fleece-pullover-hoodie', 1), 'quantity', 1)), 21);
  perform pg_temp.ship(o, 'Pathao', 'PT7700012');
  perform public._transition_order(o, 'DELIVERED', null);

  -- 3. Coupon order, delivered
  o := pg_temp.seed_order('Nusrat Jahan', '01911000003', 'Dhaka',
    jsonb_build_array(jsonb_build_object('variant_id', pg_temp.variant('linen-resort-shirt', 2), 'quantity', 1),
                      jsonb_build_object('variant_id', pg_temp.variant('canvas-tote-bag'), 'quantity', 1)), 18,
    p_coupon => 'WELCOME10', p_utm => 'eid-collection');
  perform pg_temp.ship(o, 'Steadfast', 'SF1000003');
  perform public._transition_order(o, 'DELIVERED', null);
  perform public.record_cod_settlement(array(select id from public.shipments where order_id = o), 'Steadfast payout #2');

  -- 4. High-risk customer: advance required, waiting for payment
  o := pg_temp.seed_order('Unknown Buyer', '01611000004', 'Narayanganj',
    jsonb_build_array(jsonb_build_object('variant_id', pg_temp.variant('heavyweight-oversized-tee', 1), 'quantity', 2)), 0,
    '{"total": 9, "delivered": 3, "failed": 6}'::jsonb);

  -- 5. Made-to-order item in production
  o := pg_temp.seed_order('Tanvir Ahmed', '01511000005', 'Sylhet',
    jsonb_build_array(jsonb_build_object('variant_id', pg_temp.variant('leather-card-holder', 1), 'quantity', 1)), 2);
  perform pg_temp.go(o, array['PROCESSING']);
  perform public.production_action((select id from public.production_orders where order_id = o), 'START', 'Cutting leather');

  -- 6. Custom caps in quality check
  o := pg_temp.seed_order('Sadia Islam', '01311000006', 'Dhaka',
    jsonb_build_array(jsonb_build_object('variant_id', pg_temp.variant('custom-embroidered-cap', 2), 'quantity', 2)), 3,
    p_auth => v_customer);
  perform pg_temp.go(o, array['PROCESSING']);
  perform public.production_action((select id from public.production_orders where order_id = o), 'START', null);
  perform public.production_action((select id from public.production_orders where order_id = o), 'SEND_TO_QC', null);

  -- 7. Shipped, in transit
  o := pg_temp.seed_order('Imran Kabir', '01711000007', 'Khulna',
    jsonb_build_array(jsonb_build_object('variant_id', pg_temp.variant('essential-cotton-tee', 4), 'quantity', 1)), 4);
  perform pg_temp.ship(o, 'Steadfast', 'SF1000007');

  -- 8. Packed and ready to ship
  o := pg_temp.seed_order('Farhana Yasmin', '01811000008', 'Dhaka',
    jsonb_build_array(jsonb_build_object('variant_id', pg_temp.variant('everyday-socks-3-pack'), 'quantity', 3)), 1);
  perform pg_temp.go(o, array['PROCESSING', 'PACKING', 'READY_TO_SHIP']);

  -- 9. Refused at the door, parcel back in stock
  o := pg_temp.seed_order('Jamal Hossain', '01911000009', 'Rajshahi',
    jsonb_build_array(jsonb_build_object('variant_id', pg_temp.variant('fleece-pullover-hoodie', 2), 'quantity', 1)), 15);
  perform pg_temp.ship(o, 'Pathao', 'PT7700019');
  perform public._transition_order(o, 'FAILED_DELIVERY', 'Customer refused the parcel');
  update public.shipments set return_charge = 60 where order_id = o;
  perform public._transition_order(o, 'RETURNED', 'Parcel received back');

  -- 10. Cancelled by the customer
  o := pg_temp.seed_order('Mitu Akter', '01711000010', 'Dhaka',
    jsonb_build_array(jsonb_build_object('variant_id', pg_temp.variant('essential-cotton-tee', 3), 'quantity', 1)), 12);
  perform public._transition_order(o, 'CANCELLED', 'Customer ordered by mistake');

  -- 11. Critical risk: waiting in the fraud review queue
  o := pg_temp.seed_order('Fake Name', '01611000011', 'Cumilla',
    jsonb_build_array(jsonb_build_object('variant_id', pg_temp.variant('fleece-pullover-hoodie', 2), 'quantity', 1)), 0,
    '{"total": 12, "delivered": 1, "returned": 5, "failed": 6}'::jsonb);

  -- 12. Repeat order from customer 1
  o := pg_temp.seed_order('Rahim Uddin', '01711000001', 'Dhaka',
    jsonb_build_array(jsonb_build_object('variant_id', pg_temp.variant('everyday-socks-3-pack'), 'quantity', 2),
                      jsonb_build_object('variant_id', pg_temp.variant('canvas-tote-bag'), 'quantity', 1)), 8);
  perform pg_temp.ship(o, 'Steadfast', 'SF1000012');
  perform public._transition_order(o, 'DELIVERED', null);

  -- 13. Approved this morning after a call
  o := pg_temp.seed_order('Arif Chowdhury', '01811000012', 'Gazipur',
    jsonb_build_array(jsonb_build_object('variant_id', pg_temp.variant('linen-resort-shirt', 1), 'quantity', 2)), 0);
  perform pg_temp.go(o, array['CONFIRMED']);

  -- 13b. Web orders still waiting for a call
  o := pg_temp.seed_order('Nadia Rahman', '01711000017', 'Dhaka',
    jsonb_build_array(jsonb_build_object('variant_id', pg_temp.variant('canvas-tote-bag'), 'quantity', 1)), 0);
  update public.orders set review_status = 'NO_RESPONSE', contact_attempts = 2, last_contact_at = now() - interval '1 hour'
  where id = o;
  o := pg_temp.seed_order('Sabbir Hossain', '01811000018', 'Chattogram',
    jsonb_build_array(jsonb_build_object('variant_id', pg_temp.variant('linen-resort-shirt', 2), 'quantity', 1)), 0);
  update public.orders set review_status = 'FOLLOW_UP', follow_up_at = now() + interval '3 hours',
    review_note = 'Asked to call back after work' where id = o;

  -- 14. Paid in full online, delivered
  o := pg_temp.seed_order('Lima Begum', '01911000013', 'Dhaka',
    jsonb_build_array(jsonb_build_object('variant_id', pg_temp.variant('essential-cotton-tee', 2), 'quantity', 1)), 10,
    p_payment => 'FULL_PAYMENT', p_auth => v_customer);
  perform public.record_order_payment(o, 'FULL', 'BKASH',
    (select total_amount from public.orders where id = o), 'BK8XY12', 'Paid in full via bKash');
  perform pg_temp.ship(o, 'RedX', 'RX5550013');
  perform public._transition_order(o, 'DELIVERED', null);

  -- 15. Rejected after review, customer blocked
  o := pg_temp.seed_order('Spam Orders', '01511000014', 'Dhaka',
    jsonb_build_array(jsonb_build_object('variant_id', pg_temp.variant('heavyweight-oversized-tee', 2), 'quantity', 3)), 5,
    '{"total": 15, "delivered": 2, "returned": 4, "failed": 9}'::jsonb);
  perform public.fraud_review_decide(o, 'REJECT', null, 'Fake address, phone switched off', true);

  -- 16. Advance paid by bKash, now processing
  o := pg_temp.seed_order('Shakil Mahmud', '01311000015', 'Cumilla',
    jsonb_build_array(jsonb_build_object('variant_id', pg_temp.variant('linen-resort-shirt', 3), 'quantity', 1)), 6,
    '{"total": 6, "delivered": 2, "failed": 4}'::jsonb);
  perform public.record_order_payment(o, 'ADVANCE', 'BKASH',
    (select advance_required from public.orders where id = o), 'BK7QW33', 'Advance via bKash');
  perform pg_temp.go(o, array['PROCESSING']);

  -- 17. Delivered, returned by the customer and refunded
  o := pg_temp.seed_order('Rumana Haque', '01711000016', 'Dhaka',
    jsonb_build_array(jsonb_build_object('variant_id', pg_temp.variant('heavyweight-oversized-tee', 3), 'quantity', 1)), 22);
  perform pg_temp.ship(o, 'Steadfast', 'SF1000016');
  perform public._transition_order(o, 'DELIVERED', null);
  perform public.record_cod_settlement(array(select id from public.shipments where order_id = o), 'Steadfast payout #3');
  perform public._transition_order(o, 'RETURN_REQUESTED', 'Wrong size');
  perform public._transition_order(o, 'RETURNED', 'Item back in good condition');
  perform public.refund_order(o, 990, 'BKASH', 'Returned — wrong size');

  -- A few more delivered orders for the charts
  for i in 1..30 loop
    o := pg_temp.seed_order('Customer ' || i, '0171' || lpad((2000000 + i)::text, 7, '0'),
      (array['Dhaka', 'Chattogram', 'Gazipur', 'Sylhet', 'Khulna'])[1 + i % 5],
      jsonb_build_array(jsonb_build_object('variant_id', pg_temp.variant(
        (array['essential-cotton-tee', 'canvas-tote-bag', 'everyday-socks-3-pack', 'heavyweight-oversized-tee'])[1 + i % 4], 1 + i % 2),
        'quantity', 1 + i % 3)), 1 + i % 28, p_utm => case when i % 2 = 0 then 'eid-collection' end);
    perform pg_temp.ship(o, (array['Steadfast', 'Pathao', 'RedX'])[1 + i % 3], 'TRK' || (900000 + i));
    perform public._transition_order(o, 'DELIVERED', null);
    if i % 3 <> 0 then
      perform public.record_cod_settlement(array(select id from public.shipments where order_id = o), 'Courier payout');
    end if;
  end loop;
end $$;

-- Payment waiting for verification (customer submitted a bKash TrxID).
select public.submit_manual_payment(o.order_number, o.customer_phone, 'BKASH', '01999888777', 'BKX9Z8Y7', o.advance_required)
from public.orders o where o.customer_phone = '01611000004' and o.status = 'ADVANCE_REQUIRED';

-- Stock adjustments ------------------------------------------------------------
select public.adjust_stock(pg_temp.variant('fleece-pullover-hoodie', 1), 'DAMAGE', 1, 'Zip broken during quality inspection');
select public.adjust_stock(pg_temp.variant('everyday-socks-3-pack'), 'LOSS', 2, 'Missing after stock count');
select public.adjust_stock(pg_temp.variant('essential-cotton-tee', 5), 'ADJUSTMENT', 3, 'Found in returns shelf', 'ADD');

-- Finance: operating expenses -------------------------------------------------
select public.create_finance_transaction(jsonb_build_object('type', 'EXPENSE', 'category_id', public.finance_category_id(code),
  'amount', amount, 'txn_date', current_date - days, 'payment_channel', channel, 'notes', notes))
from (values
  ('RENT', 6000, 28, 'BANK_TRANSFER', 'Workshop rent'),
  ('SALARIES', 5000, 27, 'BANK_TRANSFER', 'Monthly salaries'),
  ('PACKAGING', 2500, 14, 'CASH', 'Mailer bags and tissue paper'),
  ('SOFTWARE', 2500, 20, 'CARD', 'Accounting & design tools'),
  ('HOSTING', 1200, 20, 'CARD', 'Supabase + hosting'),
  ('UTILITIES', 2200, 10, 'BKASH', 'Electricity and internet'),
  ('PRODUCTION_COST', 1800, 5, 'CASH', 'Embroidery thread and leather offcuts')
) e(code, amount, days, channel, notes);

select public.create_finance_transaction(jsonb_build_object('type', 'INCOME',
  'category_id', public.finance_category_id('OTHER_INCOME'), 'amount', 3000, 'txn_date', current_date - 9,
  'payment_channel', 'BANK_TRANSFER', 'notes', 'Wholesale sample sale'));

-- Marketing --------------------------------------------------------------------
insert into public.marketing_campaigns(platform, name, utm_campaign, status, start_date, budget, notes)
values ('META', 'Eid Collection', 'eid-collection', 'ACTIVE', current_date - 20, 30000, 'Carousel + reels'),
       ('GOOGLE', 'Search — Brand', 'brand-search', 'ACTIVE', current_date - 14, 8000, null),
       ('TIKTOK', 'Creator seeding', null, 'PAUSED', current_date - 25, 10000, 'Two creators')
on conflict do nothing;

insert into public.marketing_spend(campaign_id, spend_date, spend, impressions, clicks, orders, revenue)
select c.id, current_date - d, 400 + (d * 37) % 300, 9000 + d * 410, 180 + d * 7, 1 + d % 3, (1 + d % 3) * 1350
from public.marketing_campaigns c, generate_series(1, 14) d
where c.name = 'Eid Collection'
on conflict do nothing;

insert into public.marketing_spend(campaign_id, spend_date, spend, clicks, orders, revenue)
select c.id, current_date - d, 300 + (d * 23) % 200, 60 + d, d % 2, (d % 2) * 1890
from public.marketing_campaigns c, generate_series(1, 10) d
where c.name = 'Search — Brand'
on conflict do nothing;

-- Spread seeded orders over the last 30 days ------------------------------------
-- Ledger tables are immutable; the table owner briefly lifts that for backdating.
alter table public.order_status_history disable trigger order_status_history_immutable;
alter table public.order_payments disable trigger order_payments_immutable;
alter table public.finance_transactions disable trigger finance_transactions_immutable;
alter table public.inventory_movements disable trigger inventory_movements_immutable;
alter table public.fraud_checks disable trigger fraud_checks_guard;
alter table public.shipment_events disable trigger shipment_events_immutable;
alter table public.production_status_history disable trigger production_status_history_immutable;

update public.orders o set
  created_at = o.created_at - make_interval(days => s.offset_days),
  confirmed_at = o.confirmed_at - make_interval(days => s.offset_days),
  shipped_at = o.shipped_at - make_interval(days => greatest(s.offset_days - 1, 0)),
  delivered_at = o.delivered_at - make_interval(days => greatest(s.offset_days - 3, 0)),
  cancelled_at = o.cancelled_at - make_interval(days => s.offset_days),
  returned_at = o.returned_at - make_interval(days => greatest(s.offset_days - 5, 0))
from seed_orders s where s.order_id = o.id and s.offset_days > 0;

update public.order_status_history h set created_at = h.created_at - make_interval(days => s.offset_days)
from seed_orders s where s.order_id = h.order_id and s.offset_days > 0;
update public.order_payments p set created_at = p.created_at - make_interval(days => greatest(s.offset_days - 3, 0))
from seed_orders s where s.order_id = p.order_id and s.offset_days > 0;
update public.finance_transactions f set
  txn_date = f.txn_date - greatest(s.offset_days - 3, 0),
  created_at = f.created_at - make_interval(days => greatest(s.offset_days - 3, 0))
from seed_orders s where s.order_id = f.order_id and s.offset_days > 0;
update public.inventory_movements m set created_at = m.created_at - make_interval(days => s.offset_days)
from seed_orders s where s.order_id = m.reference_id and s.offset_days > 0;
update public.fraud_checks f set created_at = f.created_at - make_interval(days => s.offset_days)
from seed_orders s where s.order_id = f.order_id and s.offset_days > 0;
update public.shipments sh set created_at = sh.created_at - make_interval(days => greatest(s.offset_days - 1, 0)),
  delivered_at = sh.delivered_at - make_interval(days => greatest(s.offset_days - 3, 0))
from seed_orders s where s.order_id = sh.order_id and s.offset_days > 0;
update public.customers c set created_at = sub.first_at
from (select customer_id, min(created_at) as first_at from public.orders group by customer_id) sub
where sub.customer_id = c.id;

alter table public.order_status_history enable trigger order_status_history_immutable;
alter table public.order_payments enable trigger order_payments_immutable;
alter table public.finance_transactions enable trigger finance_transactions_immutable;
alter table public.inventory_movements enable trigger inventory_movements_immutable;
alter table public.fraud_checks enable trigger fraud_checks_guard;
alter table public.shipment_events enable trigger shipment_events_immutable;
alter table public.production_status_history enable trigger production_status_history_immutable;

select public.refresh_customer_stats(id) from public.customers;
