-- =============================================================================
-- 0700 · Suppliers & purchase orders, finance ledger and accounting automation
--
-- Accounting model (simple, auditable):
--   * finance_transactions is an immutable ledger. Corrections are new rows
--     (reversals carry a negative amount and point at the original).
--   * Each category has a P&L group. Cash receipts that are NOT revenue
--     (advance payments, COD collections, online payments) use group NONE, so
--     an advance is never counted twice: it is cash when received, and the
--     order's revenue is recognised once, on delivery.
--   * is_cash marks money that actually moved (cash-flow report); accrual
--     entries such as COGS and revenue recognition are non-cash.
--   * Stock purchases are cash out (group NONE); their cost hits the P&L as
--     COGS when the goods are delivered.
-- =============================================================================

create table public.suppliers (
  id uuid primary key default gen_random_uuid(),
  name text not null check (length(trim(name)) > 0),
  contact_person text,
  phone text,
  email text,
  address text,
  notes text,
  is_active boolean not null default true,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index suppliers_name_trgm_idx on public.suppliers using gin(name extensions.gin_trgm_ops);
create index suppliers_phone_idx on public.suppliers(phone);
create trigger suppliers_updated_at before update on public.suppliers
  for each row execute function public.set_updated_at();
create trigger suppliers_audit after insert or update or delete on public.suppliers
  for each row execute function public.audit_row_change();

create sequence public.purchase_order_seq start with 1001;

create table public.purchase_orders (
  id uuid primary key default gen_random_uuid(),
  po_number text not null unique default ('PO-' || nextval('public.purchase_order_seq')::text),
  supplier_id uuid not null references public.suppliers(id),
  status public.purchase_status not null default 'DRAFT',
  payment_status public.settlement_status not null default 'UNPAID',
  order_date date not null default current_date,
  expected_date date,
  received_at timestamptz,
  subtotal numeric(12,2) not null default 0 check (subtotal >= 0),
  shipping_cost numeric(12,2) not null default 0 check (shipping_cost >= 0),
  total_cost numeric(12,2) not null default 0 check (total_cost >= 0),
  amount_paid numeric(12,2) not null default 0 check (amount_paid >= 0),
  notes text,
  created_by uuid,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index purchase_orders_supplier_idx on public.purchase_orders(supplier_id, order_date desc);
create index purchase_orders_status_idx on public.purchase_orders(status);
create trigger purchase_orders_updated_at before update on public.purchase_orders
  for each row execute function public.set_updated_at();

create table public.purchase_order_items (
  id uuid primary key default gen_random_uuid(),
  purchase_order_id uuid not null references public.purchase_orders(id) on delete cascade,
  product_id uuid not null references public.products(id),
  variant_id uuid not null references public.product_variants(id),
  quantity int not null check (quantity > 0),
  received_quantity int not null default 0 check (received_quantity >= 0),
  unit_cost numeric(12,2) not null check (unit_cost >= 0),
  total_cost numeric(12,2) generated always as (round(quantity * unit_cost, 2)) stored,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint purchase_order_items_received_le_qty check (received_quantity <= quantity)
);
create index purchase_order_items_po_idx on public.purchase_order_items(purchase_order_id);
create index purchase_order_items_variant_idx on public.purchase_order_items(variant_id);
create trigger purchase_order_items_updated_at before update on public.purchase_order_items
  for each row execute function public.set_updated_at();

-- -----------------------------------------------------------------------------
-- Finance
-- -----------------------------------------------------------------------------
create table public.finance_categories (
  id uuid primary key default gen_random_uuid(),
  code text not null unique check (code ~ '^[A-Z][A-Z0-9_]*$'),
  name text not null,
  type public.finance_type not null,
  pnl_group public.pnl_group not null,
  description text,
  is_system boolean not null default false,
  allow_manual boolean not null default true,
  is_active boolean not null default true,
  sort_order int not null default 0,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create trigger finance_categories_updated_at before update on public.finance_categories
  for each row execute function public.set_updated_at();
create trigger finance_categories_audit after insert or update or delete on public.finance_categories
  for each row execute function public.audit_row_change();

-- System categories drive automatic postings; their meaning cannot change.
create or replace function public.finance_categories_guard()
returns trigger
language plpgsql
set search_path = public, pg_temp
as $$
begin
  if tg_op = 'DELETE' then
    raise exception 'VALIDATION: finance categories cannot be deleted; deactivate them instead' using errcode = '22023';
  end if;
  if old.is_system and (new.code <> old.code or new.type <> old.type or new.pnl_group <> old.pnl_group
                        or new.is_system <> old.is_system or new.allow_manual <> old.allow_manual) then
    raise exception 'VALIDATION: system category % can only be renamed', old.code using errcode = '22023';
  end if;
  return new;
end;
$$;
create trigger finance_categories_guard before update or delete on public.finance_categories
  for each row execute function public.finance_categories_guard();

create sequence public.finance_txn_seq start with 100001;

create table public.finance_transactions (
  id uuid primary key default gen_random_uuid(),
  txn_number text not null unique default ('FT-' || nextval('public.finance_txn_seq')::text),
  type public.finance_type not null,
  category_id uuid not null references public.finance_categories(id),
  amount numeric(12,2) not null check (amount <> 0),
  txn_date date not null,
  is_cash boolean not null default true,
  payment_channel public.payment_channel,
  reference text,
  order_id uuid references public.orders(id),
  customer_id uuid references public.customers(id),
  supplier_id uuid references public.suppliers(id),
  purchase_order_id uuid references public.purchase_orders(id),
  notes text,
  source public.data_source not null default 'MANUAL',
  source_key text unique,
  reverses_id uuid unique references public.finance_transactions(id),
  created_by uuid,
  created_at timestamptz not null default now(),
  constraint finance_transactions_negative_only_for_reversal check (amount > 0 or reverses_id is not null or source = 'SYSTEM')
);
create index finance_transactions_date_idx on public.finance_transactions(txn_date desc, created_at desc);
create index finance_transactions_category_idx on public.finance_transactions(category_id, txn_date);
create index finance_transactions_order_idx on public.finance_transactions(order_id);
create index finance_transactions_type_date_idx on public.finance_transactions(type, txn_date);
create index finance_transactions_supplier_idx on public.finance_transactions(supplier_id);
create trigger finance_transactions_immutable before update or delete on public.finance_transactions
  for each row execute function public.prevent_mutation();

create or replace function public.finance_category_id(p_code text)
returns uuid
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  select id from public.finance_categories where code = p_code
$$;

-- System posting. Idempotent through source_key; zero amounts are skipped.
create or replace function public._post_finance(
  p_type public.finance_type,
  p_category_code text,
  p_amount numeric,
  p_date date,
  p_is_cash boolean,
  p_order_id uuid,
  p_customer_id uuid,
  p_supplier_id uuid,
  p_reference text,
  p_notes text,
  p_source_key text,
  p_channel public.payment_channel,
  p_purchase_order_id uuid default null
)
returns public.finance_transactions
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_cat uuid := public.finance_category_id(p_category_code);
  v_row public.finance_transactions;
begin
  if coalesce(p_amount, 0) = 0 then
    return null;
  end if;
  if v_cat is null then
    raise exception 'CONFIG: finance category % is missing', p_category_code using errcode = 'P0001';
  end if;
  insert into public.finance_transactions(type, category_id, amount, txn_date, is_cash, payment_channel, reference,
    order_id, customer_id, supplier_id, purchase_order_id, notes, source, source_key, created_by)
  values (p_type, v_cat, public.money(p_amount), coalesce(p_date, (now() at time zone public.store_timezone())::date),
          p_is_cash, p_channel, p_reference, p_order_id, p_customer_id, p_supplier_id, p_purchase_order_id, p_notes,
          'SYSTEM', p_source_key, auth.uid())
  on conflict (source_key) do nothing
  returning * into v_row;
  return v_row;
end;
$$;

-- Revenue, delivery income, COGS and courier cost when an order is delivered.
create or replace function public._post_order_delivery_finance(p_order_id uuid)
returns void
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_order public.orders;
  v_ship public.shipments;
  v_date date;
begin
  select * into v_order from public.orders where id = p_order_id;
  v_date := (coalesce(v_order.delivered_at, now()) at time zone public.store_timezone())::date;

  perform public._post_finance('INCOME', 'PRODUCT_SALES', v_order.subtotal - v_order.discount_total, v_date, false,
    p_order_id, v_order.customer_id, null, v_order.order_number, 'Product revenue (delivered)',
    'order:' || p_order_id || ':product_revenue', null);
  perform public._post_finance('INCOME', 'DELIVERY_CHARGES', v_order.delivery_charge - v_order.delivery_discount, v_date, false,
    p_order_id, v_order.customer_id, null, v_order.order_number, 'Delivery charge (delivered)',
    'order:' || p_order_id || ':delivery_revenue', null);
  perform public._post_finance('EXPENSE', 'COGS', v_order.cost_total, v_date, false,
    p_order_id, v_order.customer_id, null, v_order.order_number, 'Cost of goods sold',
    'order:' || p_order_id || ':cogs', null);

  select * into v_ship from public.shipments where order_id = p_order_id and is_active;
  if found and public.setting_bool('finance', array['record_courier_cost_on_delivery'], true) then
    perform public._post_finance('EXPENSE', 'COURIER', v_ship.shipping_cost, v_date, true,
      p_order_id, null, null, v_order.order_number, 'Courier charge',
      'shipment:' || v_ship.id || ':shipping_cost', 'COURIER_COD');
  end if;

  -- Optional: treat the courier's COD collection as received on delivery.
  if public.setting_bool('finance', array['auto_collect_cod_on_delivery'], false) then
    select * into v_order from public.orders where id = p_order_id;
    if v_order.total_amount - v_order.amount_paid > 0 then
      insert into public.order_payments(order_id, kind, channel, amount, note, idempotency_key)
      values (p_order_id, 'COD', 'COURIER_COD', v_order.total_amount - v_order.amount_paid, 'Collected on delivery',
              'cod:delivered:' || p_order_id)
      on conflict (idempotency_key) do nothing;
      if found then
        perform public._post_finance('INCOME', 'COD_COLLECTIONS', v_order.total_amount - v_order.amount_paid, v_date, true,
          p_order_id, v_order.customer_id, null, v_order.order_number, 'COD collected on delivery',
          'order:' || p_order_id || ':cod_on_delivery', 'COURIER_COD');
        perform public.recalculate_order_totals(p_order_id);
      end if;
    end if;
  end if;
end;
$$;

-- Costs of a parcel that came back: delivery fee (if never delivered) and the
-- courier's return charge.
create or replace function public._post_order_return_finance(p_order_id uuid)
returns void
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_order public.orders;
  v_ship public.shipments;
  v_date date := (now() at time zone public.store_timezone())::date;
begin
  select * into v_order from public.orders where id = p_order_id;
  select * into v_ship from public.shipments where order_id = p_order_id and is_active;
  if not found then
    return;
  end if;
  if v_order.delivered_at is null then
    perform public._post_finance('EXPENSE', 'COURIER', v_ship.shipping_cost, v_date, true, p_order_id, null, null,
      v_order.order_number, 'Courier charge (failed delivery)', 'shipment:' || v_ship.id || ':shipping_cost', 'COURIER_COD');
  end if;
  perform public._post_finance('EXPENSE', 'RETURNS', v_ship.return_charge, v_date, true, p_order_id, null, null,
    v_order.order_number, 'Courier return charge', 'shipment:' || v_ship.id || ':return_charge', 'COURIER_COD');
end;
$$;

-- Manual income / expense entry (Add Expense, Add Income).
-- p: { type, category_id, amount, txn_date, payment_channel, reference, notes,
--      order_id?, customer_id?, supplier_id?, is_cash? }
create or replace function public.create_finance_transaction(p jsonb)
returns public.finance_transactions
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_cat public.finance_categories;
  v_row public.finance_transactions;
  v_amount numeric := (p ->> 'amount')::numeric;
  v_date date := coalesce(nullif(p ->> 'txn_date', '')::date, (now() at time zone public.store_timezone())::date);
begin
  perform public.require_permission('finance.manage');
  select * into v_cat from public.finance_categories where id = (p ->> 'category_id')::uuid;
  if not found or not v_cat.is_active then
    raise exception 'VALIDATION: choose an active category' using errcode = '22023';
  end if;
  if not v_cat.allow_manual then
    raise exception 'VALIDATION: % entries are created automatically and cannot be added by hand', v_cat.name using errcode = '22023';
  end if;
  if v_cat.type::text <> upper(coalesce(p ->> 'type', v_cat.type::text)) then
    raise exception 'VALIDATION: category % is an % category', v_cat.name, lower(v_cat.type::text) using errcode = '22023';
  end if;
  if v_amount is null or v_amount <= 0 then
    raise exception 'VALIDATION: amount must be greater than zero' using errcode = '22023';
  end if;
  if v_date > (now() at time zone public.store_timezone())::date + 1 then
    raise exception 'VALIDATION: transactions cannot be dated in the future' using errcode = '22023';
  end if;

  insert into public.finance_transactions(type, category_id, amount, txn_date, is_cash, payment_channel, reference,
    order_id, customer_id, supplier_id, notes, source, created_by)
  values (v_cat.type, v_cat.id, public.money(v_amount), v_date, coalesce((p ->> 'is_cash')::boolean, true),
          nullif(p ->> 'payment_channel', '')::public.payment_channel, nullif(trim(coalesce(p ->> 'reference', '')), ''),
          nullif(p ->> 'order_id', '')::uuid, nullif(p ->> 'customer_id', '')::uuid, nullif(p ->> 'supplier_id', '')::uuid,
          nullif(trim(coalesce(p ->> 'notes', '')), ''), 'MANUAL', auth.uid())
  returning * into v_row;

  perform public.log_audit('finance.entry_created', 'finance_transaction', v_row.id::text, null,
    jsonb_build_object('txn_number', v_row.txn_number, 'type', v_row.type, 'category', v_cat.code,
                       'amount', v_row.amount, 'date', v_row.txn_date));
  return v_row;
end;
$$;

create or replace function public.reverse_finance_transaction(p_id uuid, p_reason text)
returns public.finance_transactions
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_orig public.finance_transactions;
  v_row public.finance_transactions;
begin
  perform public.require_permission('finance.manage');
  if length(trim(coalesce(p_reason, ''))) = 0 then
    raise exception 'VALIDATION: a reason is required to reverse a transaction' using errcode = '22023';
  end if;
  select * into v_orig from public.finance_transactions where id = p_id;
  if not found then
    raise exception 'NOT_FOUND: transaction not found' using errcode = 'P0002';
  end if;
  if v_orig.reverses_id is not null then
    raise exception 'VALIDATION: a reversal cannot itself be reversed' using errcode = '22023';
  end if;
  if exists (select 1 from public.finance_transactions where reverses_id = p_id) then
    raise exception 'VALIDATION: this transaction has already been reversed' using errcode = '22023';
  end if;
  if v_orig.source = 'SYSTEM' and v_orig.source_key like 'order%' then
    raise exception 'VALIDATION: order-generated entries are corrected through the order (refund/return)' using errcode = '22023';
  end if;

  insert into public.finance_transactions(type, category_id, amount, txn_date, is_cash, payment_channel, reference,
    order_id, customer_id, supplier_id, purchase_order_id, notes, source, reverses_id, created_by)
  values (v_orig.type, v_orig.category_id, -v_orig.amount, (now() at time zone public.store_timezone())::date,
          v_orig.is_cash, v_orig.payment_channel, v_orig.txn_number, v_orig.order_id, v_orig.customer_id,
          v_orig.supplier_id, v_orig.purchase_order_id, 'Reversal: ' || trim(p_reason), 'MANUAL', p_id, auth.uid())
  returning * into v_row;

  perform public.log_audit('finance.entry_reversed', 'finance_transaction', p_id::text,
    jsonb_build_object('amount', v_orig.amount), jsonb_build_object('reversal', v_row.txn_number), jsonb_build_object('reason', p_reason));
  return v_row;
end;
$$;

-- -----------------------------------------------------------------------------
-- Purchasing functions
-- -----------------------------------------------------------------------------
-- p: { id?, supplier_id, order_date, expected_date, shipping_cost, notes, status?,
--      items: [{ id?, variant_id, quantity, unit_cost }] }
create or replace function public.admin_save_purchase_order(p jsonb)
returns public.purchase_orders
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_po public.purchase_orders;
  v_id uuid := nullif(p ->> 'id', '')::uuid;
  v_item jsonb;
begin
  perform public.require_permission('purchases.manage');
  if jsonb_array_length(coalesce(p -> 'items', '[]'::jsonb)) = 0 then
    raise exception 'VALIDATION: add at least one item' using errcode = '22023';
  end if;
  if not exists (select 1 from public.suppliers where id = (p ->> 'supplier_id')::uuid) then
    raise exception 'VALIDATION: choose a supplier' using errcode = '22023';
  end if;

  if v_id is null then
    insert into public.purchase_orders(supplier_id, status, order_date, expected_date, shipping_cost, notes, created_by)
    values ((p ->> 'supplier_id')::uuid,
            coalesce(nullif(p ->> 'status', '')::public.purchase_status, 'DRAFT'),
            coalesce(nullif(p ->> 'order_date', '')::date, current_date), nullif(p ->> 'expected_date', '')::date,
            coalesce((p ->> 'shipping_cost')::numeric, 0), nullif(trim(coalesce(p ->> 'notes', '')), ''), auth.uid())
    returning * into v_po;
  else
    select * into v_po from public.purchase_orders where id = v_id for update;
    if not found then
      raise exception 'NOT_FOUND: purchase order not found' using errcode = 'P0002';
    end if;
    if v_po.status not in ('DRAFT', 'ORDERED') then
      raise exception 'VALIDATION: % purchase orders cannot be edited', v_po.status using errcode = '22023';
    end if;
    if exists (select 1 from public.purchase_order_items where purchase_order_id = v_id and received_quantity > 0) then
      raise exception 'VALIDATION: items cannot be edited after receiving has started' using errcode = '22023';
    end if;
    update public.purchase_orders set supplier_id = (p ->> 'supplier_id')::uuid,
      status = coalesce(nullif(p ->> 'status', '')::public.purchase_status, status),
      order_date = coalesce(nullif(p ->> 'order_date', '')::date, order_date),
      expected_date = nullif(p ->> 'expected_date', '')::date,
      shipping_cost = coalesce((p ->> 'shipping_cost')::numeric, 0),
      notes = nullif(trim(coalesce(p ->> 'notes', '')), '')
    where id = v_id returning * into v_po;
    delete from public.purchase_order_items where purchase_order_id = v_id;
  end if;

  for v_item in select * from jsonb_array_elements(p -> 'items') loop
    insert into public.purchase_order_items(purchase_order_id, product_id, variant_id, quantity, unit_cost)
    select v_po.id, v.product_id, v.id, (v_item ->> 'quantity')::int, (v_item ->> 'unit_cost')::numeric
    from public.product_variants v where v.id = (v_item ->> 'variant_id')::uuid;
    if not found then
      raise exception 'VALIDATION: unknown product variant in purchase order' using errcode = '22023';
    end if;
  end loop;

  update public.purchase_orders po set
    subtotal = s.subtotal, total_cost = s.subtotal + po.shipping_cost
  from (select coalesce(sum(total_cost), 0) as subtotal from public.purchase_order_items where purchase_order_id = v_po.id) s
  where po.id = v_po.id returning po.* into v_po;

  perform public.log_audit(case when v_id is null then 'purchase.created' else 'purchase.updated' end,
    'purchase_order', v_po.id::text, null, jsonb_build_object('po_number', v_po.po_number, 'total_cost', v_po.total_cost));
  return v_po;
end;
$$;

create or replace function public.purchase_order_set_status(p_id uuid, p_status public.purchase_status)
returns public.purchase_orders
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_po public.purchase_orders;
begin
  perform public.require_permission('purchases.manage');
  select * into v_po from public.purchase_orders where id = p_id for update;
  if not found then
    raise exception 'NOT_FOUND: purchase order not found' using errcode = 'P0002';
  end if;
  if not ((v_po.status = 'DRAFT' and p_status in ('ORDERED', 'CANCELLED'))
       or (v_po.status = 'ORDERED' and p_status in ('CANCELLED', 'DRAFT'))) then
    raise exception 'INVALID_TRANSITION: purchase order is % and cannot become %', v_po.status, p_status using errcode = 'P0001';
  end if;
  update public.purchase_orders set status = p_status where id = p_id returning * into v_po;
  perform public.log_audit('purchase.status_changed', 'purchase_order', p_id::text, null, jsonb_build_object('status', p_status));
  return v_po;
end;
$$;

-- Receiving increases stock (PURCHASE movements) and updates unit cost.
-- p_items: [{ item_id, quantity }] or null = receive everything outstanding.
create or replace function public.receive_purchase_order(p_id uuid, p_items jsonb default null, p_note text default null)
returns public.purchase_orders
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_po public.purchase_orders;
  v_item public.purchase_order_items;
  v_qty int;
  v_inv public.inventory;
  v_old_cost numeric;
  v_method text := upper(public.setting_text('inventory', array['costing_method'], 'WEIGHTED_AVERAGE'));
  v_landed numeric;
  v_received_any boolean := false;
begin
  perform public.require_permission('purchases.manage');
  select * into v_po from public.purchase_orders where id = p_id for update;
  if not found then
    raise exception 'NOT_FOUND: purchase order not found' using errcode = 'P0002';
  end if;
  if v_po.status not in ('ORDERED', 'PARTIALLY_RECEIVED', 'DRAFT') then
    raise exception 'VALIDATION: % purchase orders cannot be received', v_po.status using errcode = '22023';
  end if;

  for v_item in select * from public.purchase_order_items where purchase_order_id = p_id for update loop
    if p_items is null then
      v_qty := v_item.quantity - v_item.received_quantity;
    else
      select (e ->> 'quantity')::int into v_qty from jsonb_array_elements(p_items) e
      where (e ->> 'item_id')::uuid = v_item.id;
    end if;
    if coalesce(v_qty, 0) <= 0 then
      continue;
    end if;
    if v_qty > v_item.quantity - v_item.received_quantity then
      raise exception 'VALIDATION: receiving more than ordered for an item' using errcode = '22023';
    end if;

    -- Landed unit cost: item cost plus its share of the PO shipping cost.
    v_landed := v_item.unit_cost + case when v_po.subtotal > 0
      then v_po.shipping_cost * v_item.unit_cost / v_po.subtotal else 0 end;

    select * into v_inv from public.inventory where variant_id = v_item.variant_id for update;
    v_old_cost := public.variant_cost(v_item.variant_id);
    if v_method = 'WEIGHTED_AVERAGE' then
      update public.product_variants set cost_price = public.money(
        (greatest(coalesce(v_inv.on_hand, 0), 0) * v_old_cost + v_qty * v_landed) / (greatest(coalesce(v_inv.on_hand, 0), 0) + v_qty))
      where id = v_item.variant_id;
    elsif v_method = 'LATEST' then
      update public.product_variants set cost_price = public.money(v_landed) where id = v_item.variant_id;
    end if;

    perform public._apply_inventory_movement(v_item.variant_id, 'PURCHASE', v_qty, 0, 0, 'PURCHASE_ORDER', p_id,
      v_po.po_number, coalesce(p_note, 'Received from purchase order'), public.money(v_landed));
    update public.purchase_order_items set received_quantity = received_quantity + v_qty where id = v_item.id;
    v_received_any := true;
  end loop;

  if not v_received_any then
    raise exception 'VALIDATION: nothing to receive' using errcode = '22023';
  end if;

  update public.purchase_orders set
    status = case when not exists (select 1 from public.purchase_order_items
                                   where purchase_order_id = p_id and received_quantity < quantity)
                  then 'RECEIVED' else 'PARTIALLY_RECEIVED' end::public.purchase_status,
    received_at = now()
  where id = p_id returning * into v_po;

  perform public.log_audit('purchase.received', 'purchase_order', p_id::text, null,
    jsonb_build_object('status', v_po.status, 'items', p_items));
  return v_po;
end;
$$;

create or replace function public.record_purchase_payment(
  p_id uuid,
  p_amount numeric,
  p_channel public.payment_channel,
  p_date date default null,
  p_reference text default null,
  p_note text default null
)
returns public.purchase_orders
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_po public.purchase_orders;
begin
  perform public.require_permission('purchases.manage');
  perform public.require_permission('finance.manage');
  select * into v_po from public.purchase_orders where id = p_id for update;
  if not found then
    raise exception 'NOT_FOUND: purchase order not found' using errcode = 'P0002';
  end if;
  if coalesce(p_amount, 0) <= 0 or public.money(p_amount) > v_po.total_cost - v_po.amount_paid then
    raise exception 'VALIDATION: payment must be between 1 and the % outstanding', v_po.total_cost - v_po.amount_paid
      using errcode = '22023';
  end if;
  perform public._post_finance('EXPENSE', 'PRODUCT_PURCHASE', p_amount,
    coalesce(p_date, (now() at time zone public.store_timezone())::date), true, null, null, v_po.supplier_id,
    coalesce(nullif(trim(p_reference), ''), v_po.po_number), coalesce(nullif(trim(p_note), ''), 'Supplier payment ' || v_po.po_number),
    'purchase_payment:' || gen_random_uuid(), p_channel, p_id);
  update public.purchase_orders set amount_paid = amount_paid + public.money(p_amount),
    payment_status = case when amount_paid + public.money(p_amount) >= total_cost then 'PAID' else 'PARTIALLY_PAID' end::public.settlement_status
  where id = p_id returning * into v_po;
  perform public.log_audit('purchase.payment_recorded', 'purchase_order', p_id::text, null,
    jsonb_build_object('amount', p_amount, 'channel', p_channel));
  return v_po;
end;
$$;

-- -----------------------------------------------------------------------------
-- Finance summaries (all aggregation in SQL)
-- -----------------------------------------------------------------------------
create or replace function public.report_profit_loss(p_from date, p_to date)
returns jsonb
language plpgsql
stable
security definer
set search_path = public, pg_temp
as $$
declare
  v jsonb;
begin
  perform public.require_permission('finance.view');
  with t as (
    select c.code, c.name, c.pnl_group, c.type, sum(ft.amount) as amount
    from public.finance_transactions ft
    join public.finance_categories c on c.id = ft.category_id
    where ft.txn_date between p_from and p_to
    group by c.code, c.name, c.pnl_group, c.type
  ), g as (
    select
      coalesce(sum(amount) filter (where pnl_group = 'REVENUE'), 0) as product_revenue,
      coalesce(sum(amount) filter (where pnl_group = 'DELIVERY_INCOME'), 0) as delivery_income,
      coalesce(sum(amount) filter (where pnl_group = 'CONTRA_REVENUE'), 0) as refunds,
      coalesce(sum(amount) filter (where pnl_group = 'COGS'), 0) as cogs,
      coalesce(sum(amount) filter (where pnl_group = 'OPERATING_EXPENSE'), 0) as opex,
      coalesce(sum(amount) filter (where pnl_group = 'OTHER_INCOME'), 0) as other_income
    from t
  )
  select jsonb_build_object(
    'from', p_from, 'to', p_to,
    'product_revenue', g.product_revenue,
    'delivery_income', g.delivery_income,
    'revenue', g.product_revenue + g.delivery_income,
    'refunds', g.refunds,
    'net_revenue', g.product_revenue + g.delivery_income - g.refunds,
    'cogs', g.cogs,
    'gross_profit', g.product_revenue + g.delivery_income - g.refunds - g.cogs,
    'gross_margin_pct', case when g.product_revenue + g.delivery_income - g.refunds > 0
      then round(100 * (g.product_revenue + g.delivery_income - g.refunds - g.cogs) / (g.product_revenue + g.delivery_income - g.refunds), 2) end,
    'operating_expenses', g.opex,
    'other_income', g.other_income,
    'net_profit', g.product_revenue + g.delivery_income - g.refunds - g.cogs - g.opex + g.other_income,
    'lines', coalesce((select jsonb_agg(jsonb_build_object('code', code, 'name', name, 'group', pnl_group, 'type', type, 'amount', amount)
                         order by pnl_group, amount desc) from t where pnl_group <> 'NONE'), '[]'::jsonb)
  ) into v from g;
  return v;
end;
$$;

create or replace function public.report_cash_flow(p_from date, p_to date, p_granularity text default 'day')
returns jsonb
language plpgsql
stable
security definer
set search_path = public, pg_temp
as $$
declare
  v jsonb;
  v_unit text := case when p_granularity in ('day', 'week', 'month', 'year') then p_granularity else 'day' end;
begin
  perform public.require_permission('finance.view');
  with t as (
    select date_trunc(v_unit, ft.txn_date::timestamp)::date as bucket,
           sum(ft.amount) filter (where ft.type = 'INCOME') as cash_in,
           sum(ft.amount) filter (where ft.type = 'EXPENSE') as cash_out
    from public.finance_transactions ft
    where ft.is_cash and ft.txn_date between p_from and p_to
    group by 1
  ), by_cat as (
    select c.name, c.type, sum(ft.amount) as amount
    from public.finance_transactions ft join public.finance_categories c on c.id = ft.category_id
    where ft.is_cash and ft.txn_date between p_from and p_to
    group by c.name, c.type
  )
  select jsonb_build_object(
    'cash_in', coalesce((select sum(cash_in) from t), 0),
    'cash_out', coalesce((select sum(cash_out) from t), 0),
    'net_cash_flow', coalesce((select sum(coalesce(cash_in, 0) - coalesce(cash_out, 0)) from t), 0),
    'series', coalesce((select jsonb_agg(jsonb_build_object('bucket', bucket, 'cash_in', coalesce(cash_in, 0),
      'cash_out', coalesce(cash_out, 0), 'net', coalesce(cash_in, 0) - coalesce(cash_out, 0)) order by bucket) from t), '[]'::jsonb),
    'by_category', coalesce((select jsonb_agg(jsonb_build_object('name', name, 'type', type, 'amount', amount)
      order by type, amount desc) from by_cat), '[]'::jsonb)
  ) into v;
  return v;
end;
$$;

create or replace function public.finance_overview(p_from date, p_to date)
returns jsonb
language plpgsql
stable
security definer
set search_path = public, pg_temp
as $$
declare
  v_pnl jsonb;
  v_cash jsonb;
begin
  perform public.require_permission('finance.view');
  v_pnl := public.report_profit_loss(p_from, p_to);
  v_cash := public.report_cash_flow(p_from, p_to, 'day');
  return v_pnl || jsonb_build_object(
    'total_expenses', (v_pnl ->> 'cogs')::numeric + (v_pnl ->> 'operating_expenses')::numeric,
    'cash_in', v_cash -> 'cash_in',
    'cash_out', v_cash -> 'cash_out',
    'net_cash_flow', v_cash -> 'net_cash_flow',
    'cash_series', v_cash -> 'series',
    'delivery_costs', coalesce((select sum(ft.amount) from public.finance_transactions ft
      join public.finance_categories c on c.id = ft.category_id
      where c.code in ('COURIER', 'RETURNS') and ft.txn_date between p_from and p_to), 0),
    'advance_payments', coalesce((select sum(ft.amount) from public.finance_transactions ft
      join public.finance_categories c on c.id = ft.category_id
      where c.code = 'ADVANCE_PAYMENTS' and ft.txn_date between p_from and p_to), 0),
    -- Point-in-time balances (not limited to the period)
    'cod_receivable', coalesce((select sum(total_amount - amount_paid) from public.orders
      where delivered_at is not null and status in ('DELIVERED', 'RETURN_REQUESTED') and total_amount > amount_paid), 0),
    'outstanding_amount', coalesce((select sum(total_amount - amount_paid) from public.orders
      where status in ('CONFIRMED', 'PROCESSING', 'PRODUCTION', 'QUALITY_CHECK', 'PACKING', 'READY_TO_SHIP', 'SHIPPED')
        and total_amount > amount_paid), 0),
    'supplier_payables', coalesce((select sum(total_cost - amount_paid) from public.purchase_orders
      where status in ('ORDERED', 'PARTIALLY_RECEIVED', 'RECEIVED') and total_cost > amount_paid), 0),
    'unresolved_advances', coalesce((select sum(amount_paid) from public.orders
      where status in ('CANCELLED', 'REJECTED_FRAUD', 'RETURNED') and delivered_at is null
        and amount_paid > 0 and advance_resolution is null), 0)
  );
end;
$$;

-- -----------------------------------------------------------------------------
-- RLS
-- -----------------------------------------------------------------------------
alter table public.suppliers enable row level security;
alter table public.purchase_orders enable row level security;
alter table public.purchase_order_items enable row level security;
alter table public.finance_categories enable row level security;
alter table public.finance_transactions enable row level security;

create policy suppliers_read on public.suppliers for select to authenticated
  using ((select public.has_permission('purchases.view')) or (select public.has_permission('finance.view')));
create policy suppliers_manage on public.suppliers for all to authenticated
  using ((select public.has_permission('purchases.manage')))
  with check ((select public.has_permission('purchases.manage')));
create policy purchase_orders_read on public.purchase_orders for select to authenticated
  using ((select public.has_permission('purchases.view')) or (select public.has_permission('finance.view')));
create policy purchase_order_items_read on public.purchase_order_items for select to authenticated
  using ((select public.has_permission('purchases.view')) or (select public.has_permission('finance.view')));

create policy finance_categories_read on public.finance_categories for select to authenticated
  using ((select public.is_staff()));
create policy finance_categories_manage on public.finance_categories for insert to authenticated
  with check ((select public.has_permission('finance.manage')) and not is_system);
create policy finance_categories_update on public.finance_categories for update to authenticated
  using ((select public.has_permission('finance.manage')))
  with check ((select public.has_permission('finance.manage')));
create policy finance_transactions_read on public.finance_transactions for select to authenticated
  using ((select public.has_permission('finance.view')));
