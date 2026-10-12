-- Uploaded files on Cloudflare R2 (served by the site's Worker).
--
-- The Worker asks this function, as the signed-in staff member, before it
-- stores, signs or removes a file. The rules are the Supabase Storage policies
-- of the same buckets: every file lives in the store's own folder (the
-- merchant id this returns) and each kind of file needs the permission its
-- pages need. Nothing here changes data.

create or replace function public.file_access(p_bucket text, p_action text)
returns uuid
language plpgsql
stable
security invoker
set search_path = ''
as $$
declare
  v_merchant uuid := public.current_merchant_id();
  v_ok boolean;
begin
  if auth.uid() is null or v_merchant is null then
    raise exception 'PERMISSION_DENIED: sign in again before using files';
  end if;
  v_ok := case p_bucket
    when 'product-images' then case p_action
      when 'read' then true
      when 'write' then public.has_permission('products.manage')
      when 'delete' then public.has_permission('products.manage') end
    when 'courier-invoices' then case p_action
      when 'read' then public.has_permission('couriers.view') or public.has_permission('finance.view')
      when 'write' then public.has_permission('couriers.manage') end
    when 'order-files' then case p_action
      when 'read' then public.has_permission('orders.view')
      when 'write' then public.has_permission('orders.update')
      when 'delete' then public.has_permission('orders.update') end
    when 'documents' then case p_action
      when 'read' then public.has_permission('finance.view') or public.has_permission('purchases.view')
      when 'write' then public.has_permission('finance.manage') or public.has_permission('purchases.manage')
      when 'delete' then public.has_permission('finance.manage') end
  end;
  if not coalesce(v_ok, false) then
    raise exception 'PERMISSION_DENIED: you do not have permission to do that';
  end if;
  return v_merchant;
end $$;

revoke execute on function public.file_access(text, text) from public, anon;
grant execute on function public.file_access(text, text) to authenticated;

select public._tenancy_own_functions();
