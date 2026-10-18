-- Data Management counts: "merchants" are the live businesses; deleted ones
-- (kept only as "Deleted merchant #N" for their money records) are counted apart.
create or replace function public._platform_table_counts()
returns jsonb
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  select jsonb_build_object(
    'merchants', (select count(*) from public.merchants where deleted_at is null),
    'deleted_merchants', (select count(*) from public.merchants where deleted_at is not null),
    'orders', (select count(*) from public.orders),
    'order_items', (select count(*) from public.order_items), 'customers', (select count(*) from public.customers),
    'products', (select count(*) from public.products), 'shipments', (select count(*) from public.shipments),
    'invoices', (select count(*) from public.billing_invoices), 'platform_payments', (select count(*) from public.billing_payments),
    'credit_ledger', (select count(*) from public.credit_ledger), 'audit_logs', (select count(*) from public.platform_audit_logs))
$$;

select public._tenancy_own_functions();
