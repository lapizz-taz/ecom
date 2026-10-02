-- =============================================================================
-- 1000 · Storage buckets & policies, product image management, realtime,
--        scheduled jobs
-- =============================================================================

insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values
  ('product-images', 'product-images', true, 5242880, array['image/jpeg', 'image/png', 'image/webp', 'image/avif', 'image/gif']),
  ('order-files', 'order-files', false, 10485760, null),
  ('documents', 'documents', false, 20971520, null)
on conflict (id) do update set public = excluded.public, file_size_limit = excluded.file_size_limit,
  allowed_mime_types = excluded.allowed_mime_types;

-- product-images: public read (bucket is public), staff with products.manage write.
create policy "product images staff upload" on storage.objects for insert to authenticated
  with check (bucket_id = 'product-images' and (select public.has_permission('products.manage')));
create policy "product images staff update" on storage.objects for update to authenticated
  using (bucket_id = 'product-images' and (select public.has_permission('products.manage')));
create policy "product images staff delete" on storage.objects for delete to authenticated
  using (bucket_id = 'product-images' and (select public.has_permission('products.manage')));
create policy "product images read" on storage.objects for select to anon, authenticated
  using (bucket_id = 'product-images');

-- order-files: staff only (invoices, payment screenshots, courier slips).
create policy "order files read" on storage.objects for select to authenticated
  using (bucket_id = 'order-files' and (select public.has_permission('orders.view')));
create policy "order files write" on storage.objects for insert to authenticated
  with check (bucket_id = 'order-files' and (select public.has_permission('orders.update')));
create policy "order files delete" on storage.objects for delete to authenticated
  using (bucket_id = 'order-files' and (select public.has_permission('orders.update')));

-- documents: finance / purchasing paperwork.
create policy "documents read" on storage.objects for select to authenticated
  using (bucket_id = 'documents' and ((select public.has_permission('finance.view')) or (select public.has_permission('purchases.view'))));
create policy "documents write" on storage.objects for insert to authenticated
  with check (bucket_id = 'documents' and ((select public.has_permission('finance.manage')) or (select public.has_permission('purchases.manage'))));
create policy "documents delete" on storage.objects for delete to authenticated
  using (bucket_id = 'documents' and (select public.has_permission('finance.manage')));

-- -----------------------------------------------------------------------------
-- Product images: ordering and primary image in one transaction
-- -----------------------------------------------------------------------------
create or replace function public.admin_reorder_product_images(p_product_id uuid, p_image_ids uuid[], p_primary_id uuid default null)
returns void
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_primary uuid := coalesce(p_primary_id, p_image_ids[1]);
begin
  perform public.require_permission('products.manage');
  if exists (select 1 from unnest(p_image_ids) i where i not in (select id from public.product_images where product_id = p_product_id)) then
    raise exception 'VALIDATION: image does not belong to this product' using errcode = '22023';
  end if;
  update public.product_images set is_primary = false where product_id = p_product_id and is_primary;
  update public.product_images pi set position = t.ord - 1, is_primary = (pi.id = v_primary)
  from unnest(p_image_ids) with ordinality as t(id, ord)
  where pi.id = t.id and pi.product_id = p_product_id;
end;
$$;

-- -----------------------------------------------------------------------------
-- Realtime: only where it adds operational value (new orders, status
-- changes, production board, stock levels, finance postings).
-- -----------------------------------------------------------------------------
do $$
begin
  if exists (select 1 from pg_publication where pubname = 'supabase_realtime') then
    alter publication supabase_realtime add table public.orders;
    alter publication supabase_realtime add table public.production_orders;
    alter publication supabase_realtime add table public.inventory;
    alter publication supabase_realtime add table public.finance_transactions;
  end if;
end $$;

-- -----------------------------------------------------------------------------
-- Scheduled jobs (pg_cron is available on Supabase; skipped elsewhere)
-- -----------------------------------------------------------------------------
do $$
begin
  if exists (select 1 from pg_available_extensions where name = 'pg_cron') then
    create extension if not exists pg_cron;
    perform cron.schedule('expire-unpaid-advance-orders', '*/15 * * * *', 'select public.expire_unpaid_advance_orders()');
  end if;
end $$;
