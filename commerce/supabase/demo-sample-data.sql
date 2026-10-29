-- =============================================================================
-- SAMPLE DATA FOR THE LOOK-ONLY DEMO BUSINESS
--
-- Fills one look-only business (merchants.view_only, the shared demo account) with a small
-- fashion shop: categories, products with stock, suppliers and purchases, couriers, coupons,
-- about 60 orders in every stage, customers, fraud checks, payments, finance entries and
-- ad campaigns. Everything belongs to that business only. It is built through the same
-- database functions the app uses, so stock, payments, finance and timelines agree.
--
-- Nothing leaves the platform: the demo's message templates are off (the script refuses
-- otherwise), the couriers are hand-entered ones with no courier account behind them, and
-- the courier history is made up, so no courier is asked. The phone numbers and names are
-- made up; the e-mail addresses are on example.com.
--
-- Run it in one transaction, after setting the business:
--   begin;
--   set transaction isolation level repeatable read;
--   select set_config('demo.merchant_id', '<the demo business id>', true);
--   select set_config('demo.backdate', 'on', true);  -- or 'off'
--   \i supabase/demo-sample-data.sql
--   commit;
-- It refuses a business that is not look-only, or one that already has products or orders,
-- and it rolls everything back if any other business's rows change.
--
-- demo.backdate = 'on' spreads the orders over the last 30 days. Order timelines, payments,
-- stock movements, fraud checks and finance entries are records that cannot be edited; for
-- the backdating the script lifts that lock on those tables for this one transaction (the
-- change is never visible outside it) and edits only this business's new rows. 'off' leaves
-- every new record dated today.
-- =============================================================================

create or replace function pg_temp.demo_id()
returns uuid
language sql
stable
as $$ select nullif(current_setting('demo.merchant_id', true), '')::uuid $$;

do $$
declare
  v_id uuid := pg_temp.demo_id();
begin
  if v_id is null then
    raise exception 'demo sample data: set demo.merchant_id first';
  end if;
  if not exists (select 1 from public.merchants where id = v_id and view_only) then
    raise exception 'demo sample data: % is not a look-only business', v_id;
  end if;
  if exists (select 1 from public.products where merchant_id = v_id)
     or exists (select 1 from public.orders where merchant_id = v_id) then
    raise exception 'demo sample data: the business already has products or orders';
  end if;
  if exists (select 1 from public.notifications where merchant_id = v_id and is_enabled) then
    raise exception 'demo sample data: switch the business''s customer messages off first';
  end if;
  if coalesce(current_setting('demo.backdate', true), '') not in ('on', 'off') then
    raise exception 'demo sample data: set demo.backdate to on or off';
  end if;
end $$;

-- The business's own context, for this transaction only.
select set_config('app.merchant_id', pg_temp.demo_id()::text, true);

-- Every other business's rows, fingerprinted per table, to prove afterwards nothing else changed.
create or replace function pg_temp.others_fingerprint()
returns table (tbl text, scoped boolean, fp text)
language plpgsql
as $$
declare
  r record;
  v_fp text;
begin
  for r in
    select c.relname,
           exists (select 1 from pg_attribute a where a.attrelid = c.oid and a.attname = 'merchant_id' and not a.attisdropped) as has_merchant
    from pg_class c
    where c.relnamespace = 'public'::regnamespace and c.relkind = 'r'
    order by c.relname
  loop
    execute format('select md5(coalesce(string_agg(md5(t::text), %L order by md5(t::text)), %L)) from public.%I t %s', '', '', r.relname,
      case when r.has_merchant then 'where t.merchant_id is distinct from $1'
           when r.relname = 'merchants' then 'where t.id <> $1'
           else '' end)
      into v_fp using pg_temp.demo_id();
    tbl := r.relname;
    scoped := r.has_merchant or r.relname = 'merchants';
    fp := v_fp;
    return next;
  end loop;
end;
$$;

create temporary table demo_fp_before on commit drop as select * from pg_temp.others_fingerprint();
-- Outside requests (pg_net) wait in a queue until the transaction ends; none may be added.
create or replace function pg_temp.http_queued()
returns bigint
language plpgsql
as $$
declare
  v bigint := 0;
begin
  if to_regclass('net.http_request_queue') is not null then
    execute 'select count(*) from net.http_request_queue' into v;
  end if;
  return v;
end;
$$;

create temporary table demo_queues_before on commit drop as
  select (select count(*) from public.notification_logs) as notification_logs, pg_temp.http_queued() as http_requests;

-- Look-only means no changes through the app; the platform's own script may fill it.
update public.merchants set view_only = false where id = pg_temp.demo_id();

-- Product pictures: simple drawings, so the demo needs no image hosting --------
create or replace function pg_temp.picture(p_kind text, p_color text, p_accent text default null)
returns text
language plpgsql
immutable
as $$
declare
  v_line constant text := 'rgba(0,0,0,0.14)';
  v_body text;
begin
  v_body := case p_kind
    when 'tee' then
      format('<path d=''M150 92 L106 104 L58 156 L98 200 L128 178 L128 404 L272 404 L272 178 L302 200 L342 156 L294 104 L250 92 Q200 128 150 92 Z'' fill=''%s'' stroke=''%s'' stroke-width=''3''/>'
             '<path d=''M160 95 Q200 122 240 95'' fill=''none'' stroke=''%s'' stroke-width=''4''/>', p_color, v_line, v_line)
    when 'oversized' then
      format('<path d=''M146 88 L92 102 L40 170 L88 214 L118 192 L116 410 L284 410 L282 192 L312 214 L360 170 L308 102 L254 88 Q200 126 146 88 Z'' fill=''%s'' stroke=''%s'' stroke-width=''3''/>'
             '<path d=''M158 92 Q200 120 242 92'' fill=''none'' stroke=''%s'' stroke-width=''4''/>', p_color, v_line, v_line)
    when 'shirt' then
      format('<path d=''M152 86 L114 98 L84 132 L62 334 L98 340 L124 186 L126 406 L274 406 L276 186 L302 340 L338 334 L316 132 L286 98 L248 86 L200 124 Z'' fill=''%s'' stroke=''%s'' stroke-width=''3''/>'
             '<path d=''M170 86 L200 124 L230 86 M200 124 L200 406'' fill=''none'' stroke=''%s'' stroke-width=''3''/>'
             '<circle cx=''200'' cy=''170'' r=''4'' fill=''%s''/><circle cx=''200'' cy=''230'' r=''4'' fill=''%s''/><circle cx=''200'' cy=''290'' r=''4'' fill=''%s''/><circle cx=''200'' cy=''350'' r=''4'' fill=''%s''/>',
             p_color, v_line, v_line, v_line, v_line, v_line, v_line)
    when 'hoodie' then
      format('<path d=''M152 96 L112 108 L80 146 L58 348 L96 354 L122 196 L124 406 L276 406 L278 196 L304 354 L342 348 L320 146 L288 108 L248 96 Z'' fill=''%s'' stroke=''%s'' stroke-width=''3''/>'
             '<path d=''M148 100 Q150 34 200 34 Q250 34 252 100 Q200 140 148 100 Z'' fill=''%s'' stroke=''%s'' stroke-width=''3''/>'
             '<path d=''M154 304 L246 304 L262 364 L138 364 Z M186 122 L182 176 M214 122 L218 176'' fill=''none'' stroke=''%s'' stroke-width=''3''/>',
             p_color, v_line, p_color, v_line, v_line)
    when 'zip' then
      format('<path d=''M152 96 L112 108 L80 146 L58 348 L96 354 L122 196 L124 406 L276 406 L278 196 L304 354 L342 348 L320 146 L288 108 L248 96 Z'' fill=''%s'' stroke=''%s'' stroke-width=''3''/>'
             '<path d=''M148 100 Q150 34 200 34 Q250 34 252 100 Q200 140 148 100 Z'' fill=''%s'' stroke=''%s'' stroke-width=''3''/>'
             '<path d=''M200 118 L200 406 M140 300 L176 300 L176 360 M260 300 L224 300 L224 360'' fill=''none'' stroke=''%s'' stroke-width=''3''/>',
             p_color, v_line, p_color, v_line, coalesce(p_accent, v_line))
    when 'puffer' then
      format('<path d=''M150 88 L108 100 L76 140 L54 350 L96 356 L122 194 L122 412 L278 412 L278 194 L304 356 L346 350 L324 140 L292 100 L250 88 Q200 112 150 88 Z'' fill=''%s'' stroke=''%s'' stroke-width=''3''/>'
             '<path d=''M122 160 L278 160 M122 222 L278 222 M122 284 L278 284 M122 346 L278 346 M200 100 L200 412 M70 200 L112 206 M66 262 L106 268 M330 200 L288 206 M334 262 L294 268'' fill=''none'' stroke=''%s'' stroke-width=''3''/>',
             p_color, v_line, 'rgba(255,255,255,0.18)')
    when 'tote' then
      format('<path d=''M150 176 Q150 88 200 88 Q250 88 250 176'' fill=''none'' stroke=''%s'' stroke-width=''12''/>'
             '<path d=''M106 170 L294 170 L306 418 L94 418 Z'' fill=''%s'' stroke=''%s'' stroke-width=''3''/>'
             '<path d=''M106 194 L294 194'' stroke=''%s'' stroke-width=''3''/>', p_color, p_color, v_line, v_line)
    when 'cardholder' then
      format('<rect x=''104'' y=''170'' width=''192'' height=''156'' rx=''18'' fill=''%s'' stroke=''%s'' stroke-width=''3''/>'
             '<rect x=''116'' y=''182'' width=''168'' height=''132'' rx=''12'' fill=''none'' stroke=''rgba(255,255,255,0.35)'' stroke-width=''2'' stroke-dasharray=''6 6''/>'
             '<path d=''M124 222 L276 222 M124 256 L276 256'' stroke=''%s'' stroke-width=''4''/>', p_color, v_line, v_line)
    when 'cap' then
      format('<path d=''M108 300 Q108 158 200 158 Q292 158 292 300 Z'' fill=''%s'' stroke=''%s'' stroke-width=''3''/>'
             '<path d=''M98 298 Q210 278 338 320 Q262 350 98 316 Z'' fill=''%s'' stroke=''%s'' stroke-width=''3''/>'
             '<path d=''M200 160 L200 298 M154 168 Q172 230 170 298 M246 168 Q228 230 230 298'' fill=''none'' stroke=''%s'' stroke-width=''2''/><circle cx=''200'' cy=''160'' r=''7'' fill=''%s''/>',
             p_color, v_line, p_color, v_line, v_line, v_line)
    when 'socks' then
      format('<path d=''M128 110 L184 110 L184 300 Q184 330 214 344 L268 368 Q292 382 282 404 Q270 424 242 414 L156 380 Q128 368 128 336 Z'' fill=''%s'' stroke=''%s'' stroke-width=''3''/>'
             '<path d=''M188 96 L244 96 L244 286 Q244 316 274 330 L328 354 Q352 368 342 390 Q330 410 302 400 L216 366 Q188 354 188 322 Z'' fill=''%s'' stroke=''%s'' stroke-width=''3''/>'
             '<path d=''M128 136 L184 136 M188 122 L244 122'' stroke=''%s'' stroke-width=''8''/>', p_color, v_line, p_color, v_line, coalesce(p_accent, v_line))
    when 'panjabi' then
      format('<path d=''M156 80 L118 92 L90 128 L68 340 L104 346 L128 182 L124 462 L276 462 L272 182 L296 346 L332 340 L310 128 L282 92 L244 80 Q200 100 156 80 Z'' fill=''%s'' stroke=''%s'' stroke-width=''3''/>'
             '<path d=''M184 82 L184 68 L216 68 L216 82 M200 92 L200 214 M124 400 L140 462 M276 400 L260 462'' fill=''none'' stroke=''%s'' stroke-width=''3''/>'
             '<circle cx=''200'' cy=''122'' r=''4'' fill=''%s''/><circle cx=''200'' cy=''158'' r=''4'' fill=''%s''/><circle cx=''200'' cy=''194'' r=''4'' fill=''%s''/>',
             p_color, v_line, v_line, coalesce(p_accent, v_line), coalesce(p_accent, v_line), coalesce(p_accent, v_line))
    when 'threepiece' then
      format('<path d=''M158 84 L120 96 L94 132 L74 330 L108 336 L130 184 L118 462 L282 462 L270 184 L292 336 L326 330 L306 132 L280 96 L242 84 Q200 132 158 84 Z'' fill=''%s'' stroke=''%s'' stroke-width=''3''/>'
             '<path d=''M118 98 Q196 250 292 462 L330 452 Q236 240 154 90 Z'' fill=''%s'' fill-opacity=''0.75''/>'
             '<path d=''M150 300 L250 300 M144 340 L256 340'' stroke=''%s'' stroke-width=''3''/>', p_color, v_line, coalesce(p_accent, p_color), v_line)
    else ''
  end;
  return 'data:image/svg+xml;charset=utf-8,' || replace(replace(replace(
    '<svg xmlns=''http://www.w3.org/2000/svg'' viewBox=''0 0 400 500''>'
    || '<rect width=''400'' height=''500'' fill=''#f3efe8''/>'
    || '<ellipse cx=''200'' cy=''470'' rx=''150'' ry=''14'' fill=''rgba(0,0,0,0.06)''/>'
    || v_body || '</svg>', '#', '%23'), '<', '%3C'), '>', '%3E');
end;
$$;

-- Catalog ---------------------------------------------------------------------
insert into public.categories(name, slug, description, sort_order) values
  ('T-Shirts', 't-shirts', 'Soft cotton tees for every day', 1),
  ('Shirts', 'shirts', 'Linen and cotton shirts', 2),
  ('Panjabi', 'panjabi', 'Cotton panjabi for Eid and every Friday', 3),
  ('Three-Piece', 'three-piece', 'Lawn and cotton three-piece sets', 4),
  ('Hoodies & Jackets', 'hoodies', 'Warm fleece, zip hoodies and jackets', 5),
  ('Bags', 'bags', 'Totes and everyday carry', 6),
  ('Accessories', 'accessories', 'Small leather goods, caps and socks', 7)
on conflict (merchant_id, slug) do nothing;

create or replace function pg_temp.seed_product(
  p_name text, p_slug text, p_category text, p_price numeric, p_compare numeric, p_cost numeric,
  p_sizes text[], p_colors text[], p_stock int, p_picture text, p_hex text[],
  p_track boolean default true, p_production boolean default false,
  p_featured boolean default false, p_status text default 'ACTIVE', p_tags text[] default '{}', p_description text default null,
  p_accent text default null
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
    'name', p_name, 'slug', p_slug,
    'category_id', (select id from public.categories where merchant_id = pg_temp.demo_id() and slug = p_category),
    'brand', 'Demo', 'status', p_status, 'price', p_price, 'compare_at_price', p_compare, 'cost_price', p_cost,
    'tags', to_jsonb(p_tags), 'is_featured', p_featured, 'track_inventory', p_track, 'requires_production', p_production,
    'option_names', to_jsonb(array_remove(array[case when p_sizes <> '{}' then 'Size' end, case when p_colors <> '{}' then 'Color' end], null)),
    'description', coalesce(p_description, p_name || ' — designed for comfort and made to last. Pre-washed to minimise shrinkage.'),
    'variants', v_variants));

  -- One picture per colour, the first one is the main picture.
  insert into public.product_images(product_id, url, alt, position, is_primary)
  select v_product.id, pg_temp.picture(p_picture, h, p_accent), concat_ws(' — ', p_name, c), n - 1, n = 1
  from unnest(p_hex, coalesce(nullif(p_colors, '{}'), array[null::text])) with ordinality as x(h, c, n)
  where h is not null;
  return v_product.id;
end;
$$;

select pg_temp.seed_product('Essential Cotton Tee', 'essential-cotton-tee', 't-shirts', 690, 850, 260,
  array['S', 'M', 'L', 'XL'], array['Black', 'White'], 30, 'tee', array['#1f2023', '#fbfaf7'],
  true, false, true, 'ACTIVE', array['cotton', 'bestseller']);
select pg_temp.seed_product('Heavyweight Oversized Tee', 'heavyweight-oversized-tee', 't-shirts', 990, null, 380,
  array['M', 'L', 'XL'], array['Off-white'], 25, 'oversized', array['#ebe4d6'],
  true, false, true, 'ACTIVE', array['cotton', 'oversized']);
select pg_temp.seed_product('Linen Resort Shirt', 'linen-resort-shirt', 'shirts', 1890, 2200, 820,
  array['M', 'L', 'XL'], array['Sand'], 8, 'shirt', array['#d8c3a0'],
  true, false, false, 'ACTIVE', array['linen', 'summer']);
select pg_temp.seed_product('Cotton Panjabi', 'cotton-panjabi', 'panjabi', 1850, 2150, 780,
  array['M', 'L', 'XL'], array['White', 'Maroon'], 12, 'panjabi', array['#fbfaf7', '#6d1f2b'],
  true, false, true, 'ACTIVE', array['eid', 'cotton', 'bestseller'],
  'Soft cotton panjabi with a classic band collar and wooden buttons. Easy to wash, made for Eid and every Friday.', '#b48a4a');
select pg_temp.seed_product('Lawn Three-Piece', 'lawn-three-piece', 'three-piece', 2450, 2900, 1150,
  '{}', array['Teal', 'Peach'], 10, 'threepiece', array['#2f7f7a', '#f0b49a'],
  true, false, true, 'ACTIVE', array['lawn', 'eid', 'women'],
  'Printed lawn kameez, salwar and chiffon dupatta. Unstitched, three metres of fabric.', '#f4ead6');
select pg_temp.seed_product('Fleece Pullover Hoodie', 'fleece-pullover-hoodie', 'hoodies', 2490, null, 1100,
  array['M', 'L'], array['Charcoal'], 3, 'hoodie', array['#3c3f44'],
  true, false, true, 'ACTIVE', array['winter']);
select pg_temp.seed_product('Zip Hoodie', 'zip-hoodie', 'hoodies', 2790, 3200, 1200,
  array['M', 'L'], array['Navy'], 0, 'zip', array['#23324d'],
  true, false, false, 'ACTIVE', array['winter'], null, '#c9ced6');
select pg_temp.seed_product('Canvas Tote Bag', 'canvas-tote-bag', 'bags', 650, null, 210,
  '{}', '{}', 40, 'tote', array['#e3d7bf'],
  true, false, true, 'ACTIVE', array['canvas', 'gift']);
select pg_temp.seed_product('Leather Card Holder', 'leather-card-holder', 'accessories', 1290, null, 480,
  '{}', array['Brown', 'Black'], 0, 'cardholder', array['#7a4b2a', '#26231f'],
  false, true, true, 'ACTIVE', array['leather', 'handmade', 'gift'],
  'Hand-stitched full-grain leather card holder, made to order in our workshop (3–4 days).');
select pg_temp.seed_product('Custom Embroidered Cap', 'custom-embroidered-cap', 'accessories', 890, null, 300,
  '{}', array['Black', 'Beige'], 0, 'cap', array['#1f2023', '#d9c6a5'],
  false, true, false, 'ACTIVE', array['custom', 'made-to-order'],
  'Six-panel cotton cap embroidered with your initials. Made to order.');
select pg_temp.seed_product('Everyday Socks (3 pack)', 'everyday-socks-3-pack', 'accessories', 450, null, 150,
  '{}', '{}', 60, 'socks', array['#9aa0a6'],
  true, false, false, 'ACTIVE', array['basics'], null, '#5b6168');
select pg_temp.seed_product('Winter Puffer Jacket', 'winter-puffer-jacket', 'hoodies', 4990, null, 2300,
  array['M', 'L'], array['Black'], 5, 'puffer', array['#1f2023'],
  true, false, false, 'DRAFT', array['winter']);

-- n-th active variant of one of this business's products (falls back to the first one).
create or replace function pg_temp.variant(p_slug text, p_n int default 1)
returns uuid
language sql
as $$
  select coalesce(
    (select v.id from public.product_variants v join public.products p on p.id = v.product_id
     where p.merchant_id = pg_temp.demo_id() and p.slug = p_slug and v.is_active order by v.position offset p_n - 1 limit 1),
    (select v.id from public.product_variants v join public.products p on p.id = v.product_id
     where p.merchant_id = pg_temp.demo_id() and p.slug = p_slug and v.is_active order by v.position limit 1))
$$;

-- Suppliers, purchasing ---------------------------------------------------------
insert into public.suppliers(name, contact_person, phone, email, address) values
  ('Dhaka Garments Ltd', 'Mr. Kamal', '01700000101', 'sales@dhakagarments.example.com', 'Ashulia, Savar'),
  ('Leather Craft BD', 'Ms. Rupa', '01800000102', 'orders@leathercraft.example.com', 'Hazaribagh, Dhaka'),
  ('Narsingdi Textiles', 'Mr. Habib', '01900000103', 'hello@narsingditex.example.com', 'Madhabdi, Narsingdi');

do $$
declare
  v_po public.purchase_orders;
  v_supplier jsonb := (select jsonb_object_agg(name, id) from public.suppliers where merchant_id = pg_temp.demo_id());
begin
  v_po := public.admin_save_purchase_order(jsonb_build_object(
    'supplier_id', v_supplier ->> 'Dhaka Garments Ltd', 'status', 'ORDERED',
    'shipping_cost', 300, 'notes', 'Restock socks and totes',
    'items', jsonb_build_array(
      jsonb_build_object('variant_id', pg_temp.variant('everyday-socks-3-pack'), 'quantity', 40, 'unit_cost', 140),
      jsonb_build_object('variant_id', pg_temp.variant('canvas-tote-bag'), 'quantity', 20, 'unit_cost', 200))));
  perform public.receive_purchase_order(v_po.id, null, 'Delivered by supplier');
  perform public.record_purchase_payment(v_po.id, 5000, 'BANK_TRANSFER', null, 'TT-88812', 'Part payment');

  v_po := public.admin_save_purchase_order(jsonb_build_object(
    'supplier_id', v_supplier ->> 'Narsingdi Textiles', 'status', 'ORDERED', 'shipping_cost', 500,
    'notes', 'Eid lawn and panjabi fabric',
    'items', jsonb_build_array(
      jsonb_build_object('variant_id', pg_temp.variant('lawn-three-piece', 1), 'quantity', 15, 'unit_cost', 1100),
      jsonb_build_object('variant_id', pg_temp.variant('cotton-panjabi', 2), 'quantity', 10, 'unit_cost', 750))));
  perform public.receive_purchase_order(v_po.id, null, 'Received, quality checked');
  perform public.record_purchase_payment(v_po.id, 20000, 'BKASH', null, 'BKP77120', 'Full payment');

  perform public.admin_save_purchase_order(jsonb_build_object(
    'supplier_id', v_supplier ->> 'Leather Craft BD', 'status', 'ORDERED',
    'expected_date', current_date + 7,
    'items', jsonb_build_array(
      jsonb_build_object('variant_id', pg_temp.variant('fleece-pullover-hoodie', 1), 'quantity', 15, 'unit_cost', 1050))));
end $$;

-- Couriers & coupons ------------------------------------------------------------
-- Entered by hand (no courier account behind them), so nothing is ever booked or tracked online.
insert into public.couriers(name, provider, tracking_url_template, phone, default_shipping_cost, notes)
select * from (values
  ('Steadfast', 'manual', 'https://steadfast.com.bd/t/{tracking}', null, 70::numeric, 'Sample courier'),
  ('Pathao', 'manual', 'https://merchant.pathao.com/tracking?consignment_id={tracking}', null, 75::numeric, 'Sample courier'),
  ('RedX', 'manual', null, null, 70::numeric, 'Sample courier')
) c(name, provider, tracking_url_template, phone, default_shipping_cost, notes)
where not exists (select 1 from public.couriers x where x.merchant_id = pg_temp.demo_id() and x.name = c.name);

insert into public.coupons(code, description, discount_type, discount_value, min_order_value, max_discount, per_customer_limit, usage_limit)
values
  ('WELCOME10', '10% off your first order', 'PERCENTAGE', 10, 0, 300, 1, null),
  ('FREESHIP', 'Free delivery over ৳1,500', 'FREE_DELIVERY', 0, 1500, null, null, null),
  ('EID200', '৳200 off orders over ৳2,000', 'FIXED', 200, 2000, null, 2, 500)
on conflict (merchant_id, code) do nothing;

-- Orders through every stage ---------------------------------------------------
create temporary table seed_orders(order_id uuid, offset_days int) on commit drop;

create or replace function pg_temp.seed_order(
  p_name text, p_phone text, p_district text, p_items jsonb, p_offset int,
  p_counts jsonb default '{}'::jsonb, p_payment text default 'COD', p_coupon text default null,
  p_utm text default null
)
returns uuid
language plpgsql
as $$
declare
  v_check public.fraud_checks;
  v_result jsonb;
begin
  -- Made-up courier history: no courier is asked.
  v_check := public.record_fraud_check(jsonb_build_object('phone', p_phone,
    'provider', case when p_counts = '{}'::jsonb then 'internal' else 'http' end,
    'providers', case when p_counts = '{}'::jsonb then '["internal"]'::jsonb else '["internal","http"]'::jsonb end,
    'provider_counts', p_counts));
  v_result := public.place_storefront_order(jsonb_build_object(
    'customer', jsonb_build_object('full_name', p_name, 'phone', p_phone,
                                   'email', lower(split_part(p_name, ' ', 1)) || '.' || right(p_phone, 3) || '@example.com'),
    'shipping', jsonb_build_object('address', 'House ' || (10 + p_offset) || ', Road ' || (3 + p_offset % 7) || ', ' || p_district,
                                   'district', p_district, 'area', null),
    'items', p_items, 'payment_method', p_payment, 'coupon_code', p_coupon,
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
  v_o public.orders;
  v_s text;
begin
  -- Orders the business's risk rules held back are cleared the way staff would: the customer pays
  -- the advance, a reviewed order is approved, a web order is approved after a call.
  for i in 1..3 loop
    select * into v_o from public.orders where id = p_order;
    if v_o.status = 'ADVANCE_REQUIRED' then
      perform public.record_order_payment(p_order, 'ADVANCE', 'BKASH', v_o.advance_required,
        'BK' || upper(left(md5(p_order::text), 8)), 'Advance via bKash');
    elsif v_o.status in ('PENDING', 'FRAUD_CHECK', 'FRAUD_REVIEW') then
      perform public.fraud_review_decide(p_order, 'APPROVE', null, 'Approved after a confirmation call');
    elsif v_o.status = 'CONFIRMATION_REQUIRED' and p_statuses[1] <> 'CONFIRMED' then
      perform public._transition_order(p_order, 'CONFIRMED', 'Approved after a confirmation call');
    else
      exit;
    end if;
  end loop;
  foreach v_s in array p_statuses loop
    if (select status::text from public.orders where id = p_order) <> v_s then
      perform public._transition_order(p_order, v_s::public.order_status, null);
    end if;
  end loop;
end;
$$;

create or replace function pg_temp.ship(p_order uuid, p_courier text, p_tracking text)
returns void
language plpgsql
as $$
declare
  v_courier public.couriers;
begin
  select * into v_courier from public.couriers where merchant_id = pg_temp.demo_id() and name = p_courier;
  perform pg_temp.go(p_order, array['PROCESSING', 'PACKING', 'READY_TO_SHIP']);
  perform public.assign_courier(p_order, v_courier.id, p_tracking, v_courier.default_shipping_cost);
  perform public._transition_order(p_order, 'SHIPPED', 'Handed to ' || p_courier);
end;
$$;

do $$
declare
  o uuid;
  v_first text[] := array['Tanjila', 'Mehedi', 'Sumaiya', 'Rakibul', 'Farzana', 'Shahriar', 'Nafisa', 'Arman', 'Jannatul', 'Sohel',
                          'Anika', 'Riyad', 'Tahmina', 'Fahim', 'Sharmin', 'Ashik', 'Lamia', 'Zubair', 'Rifat', 'Moushumi'];
  v_last text[] := array['Islam', 'Rahman', 'Hossain', 'Ahmed', 'Akter', 'Khan', 'Chowdhury', 'Sarker', 'Mia', 'Begum', 'Talukder', 'Siddique'];
  v_district text[] := array['Dhaka', 'Chattogram', 'Gazipur', 'Sylhet', 'Khulna', 'Rajshahi', 'Narayanganj', 'Cumilla', 'Barishal', 'Rangpur', 'Mymensingh', 'Bogura'];
  v_slug text[] := array['essential-cotton-tee', 'cotton-panjabi', 'canvas-tote-bag', 'lawn-three-piece', 'everyday-socks-3-pack',
                         'heavyweight-oversized-tee', 'linen-resort-shirt'];
  v_prefix text[] := array['7', '8', '9', '3', '5', '6'];
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
    jsonb_build_array(jsonb_build_object('variant_id', pg_temp.variant('cotton-panjabi', 2), 'quantity', 1)), 21);
  perform pg_temp.ship(o, 'Pathao', 'PT7700012');
  perform public._transition_order(o, 'DELIVERED', null);

  -- 3. Coupon order, delivered
  o := pg_temp.seed_order('Nusrat Jahan', '01911000003', 'Dhaka',
    jsonb_build_array(jsonb_build_object('variant_id', pg_temp.variant('lawn-three-piece', 2), 'quantity', 1),
                      jsonb_build_object('variant_id', pg_temp.variant('canvas-tote-bag'), 'quantity', 1)), 18,
    p_coupon => 'WELCOME10', p_utm => 'eid-collection');
  perform pg_temp.ship(o, 'Steadfast', 'SF1000003');
  perform public._transition_order(o, 'DELIVERED', null);
  perform public.record_cod_settlement(array(select id from public.shipments where order_id = o), 'Steadfast payout #2');

  -- 4. High-risk customer: advance required, waiting for payment
  o := pg_temp.seed_order('Mahfuz Alam', '01611000004', 'Narayanganj',
    jsonb_build_array(jsonb_build_object('variant_id', pg_temp.variant('heavyweight-oversized-tee', 1), 'quantity', 2)), 0,
    '{"total": 9, "delivered": 3, "failed": 6}'::jsonb);

  -- 5. Made-to-order item in production
  o := pg_temp.seed_order('Tanvir Ahmed', '01511000005', 'Sylhet',
    jsonb_build_array(jsonb_build_object('variant_id', pg_temp.variant('leather-card-holder', 1), 'quantity', 1)), 2);
  perform pg_temp.go(o, array['PROCESSING']);
  perform public.production_action((select id from public.production_orders where order_id = o), 'START', 'Cutting leather');

  -- 6. Custom caps in quality check
  o := pg_temp.seed_order('Sadia Islam', '01311000006', 'Dhaka',
    jsonb_build_array(jsonb_build_object('variant_id', pg_temp.variant('custom-embroidered-cap', 2), 'quantity', 2)), 3);
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
  o := pg_temp.seed_order('Test Test', '01611000011', 'Cumilla',
    jsonb_build_array(jsonb_build_object('variant_id', pg_temp.variant('cotton-panjabi', 1), 'quantity', 1)), 0,
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
    jsonb_build_array(jsonb_build_object('variant_id', pg_temp.variant('lawn-three-piece', 1), 'quantity', 1)), 0);
  update public.orders set review_status = 'NO_RESPONSE', contact_attempts = 2, last_contact_at = now() - interval '1 hour'
  where id = o;
  o := pg_temp.seed_order('Sabbir Hossain', '01811000018', 'Chattogram',
    jsonb_build_array(jsonb_build_object('variant_id', pg_temp.variant('linen-resort-shirt', 2), 'quantity', 1)), 0);
  update public.orders set review_status = 'FOLLOW_UP', follow_up_at = now() + interval '3 hours',
    review_note = 'Asked to call back after work' where id = o;
  o := pg_temp.seed_order('Shirin Sultana', '01911000019', 'Mymensingh',
    jsonb_build_array(jsonb_build_object('variant_id', pg_temp.variant('cotton-panjabi', 3), 'quantity', 2)), 0, p_utm => 'eid-collection');

  -- 14. Paid in full online, delivered
  o := pg_temp.seed_order('Lima Begum', '01911000013', 'Dhaka',
    jsonb_build_array(jsonb_build_object('variant_id', pg_temp.variant('essential-cotton-tee', 2), 'quantity', 1)), 10,
    p_payment => 'FULL_PAYMENT');
  perform public.record_order_payment(o, 'FULL', 'BKASH',
    (select total_amount from public.orders where id = o), 'BK8XY12', 'Paid in full via bKash');
  perform pg_temp.ship(o, 'RedX', 'RX5550013');
  perform public._transition_order(o, 'DELIVERED', null);

  -- 15. Rejected after review, customer blocked
  o := pg_temp.seed_order('Prank Order', '01511000014', 'Dhaka',
    jsonb_build_array(jsonb_build_object('variant_id', pg_temp.variant('heavyweight-oversized-tee', 2), 'quantity', 3)), 5,
    '{"total": 15, "delivered": 2, "returned": 4, "failed": 9}'::jsonb);
  perform public.fraud_review_decide(o, 'REJECT', null, 'Fake address, phone switched off', true);

  -- 16. Risky customer: paid the advance by bKash (when the rules ask for one), now processing
  o := pg_temp.seed_order('Shakil Mahmud', '01311000015', 'Cumilla',
    jsonb_build_array(jsonb_build_object('variant_id', pg_temp.variant('linen-resort-shirt', 3), 'quantity', 1)), 6,
    '{"total": 6, "delivered": 2, "failed": 4}'::jsonb);
  perform pg_temp.go(o, array['PROCESSING']);

  -- 17. Refused at the door (wrong size): came back with the courier. Delivered orders are final and never become returns.
  o := pg_temp.seed_order('Rumana Haque', '01711000016', 'Dhaka',
    jsonb_build_array(jsonb_build_object('variant_id', pg_temp.variant('heavyweight-oversized-tee', 3), 'quantity', 1)), 22);
  perform pg_temp.ship(o, 'Steadfast', 'SF1000016');
  perform public._transition_order(o, 'RETURNING', 'Customer refused: wrong size');
  perform public._transition_order(o, 'RETURNED', 'Item back in good condition');

  -- More delivered orders for the charts, spread over the month
  for i in 1..40 loop
    o := pg_temp.seed_order(v_first[1 + i % 20] || ' ' || v_last[1 + (i * 7) % 12],
      '01' || v_prefix[1 + i % 6] || lpad((21000000 + i * 1373)::text, 8, '0'),
      v_district[1 + (i * 5) % 12],
      jsonb_build_array(jsonb_build_object('variant_id', pg_temp.variant(v_slug[1 + i % 7], 1 + i % 3), 'quantity', 1 + i % 2)),
      1 + i % 28, p_coupon => case when i % 9 = 0 then 'WELCOME10' end,
      p_utm => case when i % 3 <> 0 then 'eid-collection' end);
    perform pg_temp.ship(o, (array['Steadfast', 'Pathao', 'RedX'])[1 + i % 3], 'TRK' || (900000 + i));
    if i % 11 = 0 then
      perform public._transition_order(o, 'FAILED_DELIVERY', 'Customer not reachable');
      perform public._transition_order(o, 'RETURNED', 'Parcel received back');
    else
      perform public._transition_order(o, 'DELIVERED', null);
      if i % 3 <> 0 then
        perform public.record_cod_settlement(array(select id from public.shipments where order_id = o), 'Courier payout');
      end if;
    end if;
  end loop;
end $$;

-- Payment waiting for verification (customer submitted a bKash TrxID).
select public.submit_manual_payment(o.order_number, o.customer_phone, 'BKASH', '01999888777', 'BKX9Z8Y7', o.advance_required)
from public.orders o
where o.merchant_id = pg_temp.demo_id() and o.customer_phone = '01611000004' and o.status = 'ADVANCE_REQUIRED';

-- Stock adjustments ------------------------------------------------------------
select public.adjust_stock(pg_temp.variant('fleece-pullover-hoodie', 1), 'DAMAGE', 1, 'Zip broken during quality inspection');
select public.adjust_stock(pg_temp.variant('everyday-socks-3-pack'), 'LOSS', 2, 'Missing after stock count');
select public.adjust_stock(pg_temp.variant('essential-cotton-tee', 5), 'ADJUSTMENT', 3, 'Found in returns shelf', 'ADD');

-- Finance: operating expenses -------------------------------------------------
select public.create_finance_transaction(jsonb_build_object('type', 'EXPENSE', 'category_id', public.finance_category_id(code),
  'amount', amount, 'txn_date', current_date - days, 'payment_channel', channel, 'notes', notes))
from (values
  ('RENT', 8000, 28, 'BANK_TRANSFER', 'Office and stock room rent'),
  ('SALARIES', 12000, 27, 'BANK_TRANSFER', 'Packer and call agent salaries'),
  ('PACKAGING', 2500, 14, 'CASH', 'Mailer bags, tape and tissue paper'),
  ('SOFTWARE', 1600, 20, 'BKASH', 'Fullfilio subscription'),
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
       ('TIKTOK', 'Creator seeding', null, 'PAUSED', current_date - 25, 10000, 'Two creators');

insert into public.marketing_spend(campaign_id, spend_date, spend, impressions, clicks, orders, revenue)
select c.id, current_date - d, 400 + (d * 37) % 300, 9000 + d * 410, 180 + d * 7, 1 + d % 3, (1 + d % 3) * 1350
from public.marketing_campaigns c, generate_series(1, 14) d
where c.merchant_id = pg_temp.demo_id() and c.name = 'Eid Collection';

insert into public.marketing_spend(campaign_id, spend_date, spend, clicks, orders, revenue)
select c.id, current_date - d, 300 + (d * 23) % 200, 60 + d, d % 2, (d % 2) * 1890
from public.marketing_campaigns c, generate_series(1, 10) d
where c.merchant_id = pg_temp.demo_id() and c.name = 'Search — Brand';

-- Spread the orders over the last 30 days ---------------------------------------
-- Only this business's new orders; the record locks come back on before the transaction ends.
do $$
begin
  if current_setting('demo.backdate') <> 'on' then
    return;
  end if;
  alter table public.order_status_history disable trigger order_status_history_immutable;
  alter table public.order_payments disable trigger order_payments_immutable;
  alter table public.finance_transactions disable trigger finance_transactions_immutable;
  alter table public.inventory_movements disable trigger inventory_movements_immutable;
  alter table public.fraud_checks disable trigger fraud_checks_guard;
  alter table public.shipment_events disable trigger shipment_events_immutable;

  update public.orders o set
    created_at = o.created_at - make_interval(days => s.offset_days),
    confirmed_at = o.confirmed_at - make_interval(days => s.offset_days),
    shipped_at = o.shipped_at - make_interval(days => greatest(s.offset_days - 1, 0)),
    delivered_at = o.delivered_at - make_interval(days => greatest(s.offset_days - 3, 0)),
    cancelled_at = o.cancelled_at - make_interval(days => s.offset_days),
    returned_at = o.returned_at - make_interval(days => greatest(s.offset_days - 5, 0))
  from seed_orders s where s.order_id = o.id and s.offset_days > 0 and o.merchant_id = pg_temp.demo_id();

  update public.order_status_history h set created_at = h.created_at - make_interval(days => s.offset_days)
  from seed_orders s where s.order_id = h.order_id and s.offset_days > 0 and h.merchant_id = pg_temp.demo_id();
  update public.order_payments p set created_at = p.created_at - make_interval(days => greatest(s.offset_days - 3, 0))
  from seed_orders s where s.order_id = p.order_id and s.offset_days > 0 and p.merchant_id = pg_temp.demo_id();
  update public.finance_transactions f set
    txn_date = f.txn_date - greatest(s.offset_days - 3, 0),
    created_at = f.created_at - make_interval(days => greatest(s.offset_days - 3, 0))
  from seed_orders s where s.order_id = f.order_id and s.offset_days > 0 and f.merchant_id = pg_temp.demo_id();
  update public.inventory_movements m set created_at = m.created_at - make_interval(days => s.offset_days)
  from seed_orders s where s.order_id = m.reference_id and s.offset_days > 0 and m.merchant_id = pg_temp.demo_id();
  update public.fraud_checks f set created_at = f.created_at - make_interval(days => s.offset_days)
  from seed_orders s where s.order_id = f.order_id and s.offset_days > 0 and f.merchant_id = pg_temp.demo_id();
  update public.shipments sh set created_at = sh.created_at - make_interval(days => greatest(s.offset_days - 1, 0)),
    delivered_at = sh.delivered_at - make_interval(days => greatest(s.offset_days - 3, 0))
  from seed_orders s where s.order_id = sh.order_id and s.offset_days > 0 and sh.merchant_id = pg_temp.demo_id();
  update public.shipment_events e set created_at = e.created_at - make_interval(days => greatest(s.offset_days - 1, 0))
  from public.shipments sh, seed_orders s
  where e.shipment_id = sh.id and s.order_id = sh.order_id and s.offset_days > 0 and e.merchant_id = pg_temp.demo_id();

  alter table public.order_status_history enable trigger order_status_history_immutable;
  alter table public.order_payments enable trigger order_payments_immutable;
  alter table public.finance_transactions enable trigger finance_transactions_immutable;
  alter table public.inventory_movements enable trigger inventory_movements_immutable;
  alter table public.fraud_checks enable trigger fraud_checks_guard;
  alter table public.shipment_events enable trigger shipment_events_immutable;

  update public.customers c set created_at = sub.first_at
  from (select customer_id, min(created_at) as first_at from public.orders
        where merchant_id = pg_temp.demo_id() group by customer_id) sub
  where sub.customer_id = c.id and c.merchant_id = pg_temp.demo_id();
end $$;

select public.refresh_customer_stats(id) from public.customers where merchant_id = pg_temp.demo_id();

-- Kept out of the platform's own figures, and look-only again.
update public.merchants set is_demo = true, view_only = true where id = pg_temp.demo_id();

-- Proof ----------------------------------------------------------------------------
do $$
declare
  v_changed text;
  v_lock text;
begin
  select string_agg(a.tbl, ', ' order by a.tbl) into v_changed
  from pg_temp.others_fingerprint() a join demo_fp_before b using (tbl)
  where a.scoped and a.fp is distinct from b.fp;
  if v_changed is not null then
    raise exception 'demo sample data: other businesses'' rows changed in %; nothing was saved', v_changed;
  end if;
  if (select count(*) from public.notification_logs) <> (select notification_logs from demo_queues_before) then
    raise exception 'demo sample data: a customer message was queued; nothing was saved';
  end if;
  if pg_temp.http_queued() <> (select http_requests from demo_queues_before) then
    raise exception 'demo sample data: an outside request was queued; nothing was saved';
  end if;
  select string_agg(t.tgrelid::regclass::text, ', ') into v_lock
  from pg_trigger t
  where t.tgname in ('order_status_history_immutable', 'order_payments_immutable', 'finance_transactions_immutable',
                     'inventory_movements_immutable', 'fraud_checks_guard', 'shipment_events_immutable')
    and t.tgenabled = 'D';
  if v_lock is not null then
    raise exception 'demo sample data: record lock still off on %; nothing was saved', v_lock;
  end if;
end $$;

select jsonb_build_object(
  'products', (select count(*) from public.products where merchant_id = pg_temp.demo_id()),
  'variants', (select count(*) from public.product_variants v join public.products p on p.id = v.product_id where p.merchant_id = pg_temp.demo_id()),
  'orders', (select count(*) from public.orders where merchant_id = pg_temp.demo_id()),
  'orders_by_status', (select jsonb_object_agg(status, n) from (select status, count(*) n from public.orders where merchant_id = pg_temp.demo_id() group by status) s),
  'customers', (select count(*) from public.customers where merchant_id = pg_temp.demo_id()),
  'oldest_order', (select min(created_at)::date from public.orders where merchant_id = pg_temp.demo_id()),
  'finance_entries', (select count(*) from public.finance_transactions where merchant_id = pg_temp.demo_id()),
  'other_tables_changed', (select coalesce(jsonb_agg(a.tbl order by a.tbl), '[]'::jsonb)
                           from pg_temp.others_fingerprint() a join demo_fp_before b using (tbl)
                           where not a.scoped and a.fp is distinct from b.fp),
  'view_only', (select view_only from public.merchants where id = pg_temp.demo_id()),
  'is_demo', (select is_demo from public.merchants where id = pg_temp.demo_id())
) as demo_sample_data;
