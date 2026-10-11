-- external-api part 5 of 5: run the parts in order
revoke all on function public.admin_api_key_create(text, text[], timestamptz), public.admin_api_keys(), public.admin_api_key_revoke(uuid),
  public.admin_api_logs(int, uuid), public.api_key_merchant(text), public.api_key_check(text),
  public.api_request_log(uuid, text, text, int, int, text, text), public._api_require(uuid, text), public._api_order_json(public.orders, boolean),
  public.api_orders(uuid, jsonb), public.api_order(uuid, text), public.api_order_set_status(uuid, text, text, text), public.api_products(uuid, jsonb),
  public.api_inventory(uuid, jsonb), public.api_inventory_adjust(uuid, text, text, int, text), public.api_customers(uuid, jsonb)
from public, anon, authenticated;
grant execute on function public.admin_api_key_create(text, text[], timestamptz), public.admin_api_keys(), public.admin_api_key_revoke(uuid),
  public.admin_api_logs(int, uuid) to authenticated;
grant execute on function public.api_key_merchant(text), public.api_key_check(text), public.api_request_log(uuid, text, text, int, int, text, text),
  public.api_orders(uuid, jsonb), public.api_order(uuid, text), public.api_order_set_status(uuid, text, text, text), public.api_products(uuid, jsonb),
  public.api_inventory(uuid, jsonb), public.api_inventory_adjust(uuid, text, text, int, text), public.api_customers(uuid, jsonb)
to service_role;
insert into public.tenancy_exempt_functions (name, reason) values
  ('api_key_merchant', 'External API: finds which business a key belongs to (returns only the id; service role only)')
on conflict (name) do nothing;
select public._tenancy_own_functions();
