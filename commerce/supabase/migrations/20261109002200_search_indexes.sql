-- Order search matches "contains" (ILIKE '%…%') on these columns too. A btree index
-- cannot answer that, so each search read the whole table; trigram indexes can.
-- Name, phone and invoice number already have theirs (orders_*_trgm_idx).
create extension if not exists pg_trgm with schema extensions;

create index if not exists orders_external_number_trgm_idx on public.orders using gin (external_order_number extensions.gin_trgm_ops);
create index if not exists shipments_tracking_trgm_idx on public.shipments using gin (tracking_number extensions.gin_trgm_ops);
create index if not exists shipments_consignment_trgm_idx on public.shipments using gin (consignment_id extensions.gin_trgm_ops);
create index if not exists payments_txn_trgm_idx on public.payments using gin (provider_transaction_id extensions.gin_trgm_ops);
create index if not exists payments_reference_trgm_idx on public.payments using gin (reference extensions.gin_trgm_ops);
