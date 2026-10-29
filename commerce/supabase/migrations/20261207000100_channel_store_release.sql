-- =============================================================================
-- A store's connection holds the store only while it is live.
--
-- A Shopify store (or WooCommerce site) connects to one Fullfilio business at a time. Its address
-- was unique across every connection ever saved, disconnected and unfinished ones included, so a
-- store that one business had connected and then disconnected could never be connected by another:
-- the save ran into the first business's row, row security refused it, and the admin said
-- "You do not have permission to do that" (Atheron, 29 Oct 2026).
--
-- Now:
--  * only a CONNECTED or ERROR connection holds the store across the platform. A DISCONNECTED one
--    holds nothing, nor does a PENDING one (its keys were never proven), so typing someone else's
--    store address cannot block its owner;
--  * each business keeps one row per store, and connecting again reuses it with its history;
--  * a business connecting a store that another business holds is told so in words.
-- Webhooks and the Shopify return find a connection by its id or its one-time state, never by the
-- store address, so two rows for one address (at most one of them live) route correctly.
-- Safe to re-run.
-- =============================================================================

create unique index if not exists sales_channels_merchant_domain_uq
  on public.sales_channels (merchant_id, platform, lower(shop_domain));
drop index if exists public.sales_channels_domain_uq;
create unique index sales_channels_domain_uq
  on public.sales_channels (platform, lower(shop_domain)) where status in ('CONNECTED', 'ERROR');

-- Whether another business holds this store: yes or no, nothing about which business. It reads
-- other businesses' rows, so it stays owned by postgres and is listed with the exempt functions.
create or replace function public._channel_held_elsewhere(p_platform text, p_domain text)
returns boolean
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  select exists (
    select 1 from public.sales_channels c
    where c.platform = upper(p_platform)
      and lower(c.shop_domain) = lower(trim(p_domain))
      and c.status in ('CONNECTED', 'ERROR')
      and c.merchant_id is distinct from public.current_merchant_id())
$$;
revoke all on function public._channel_held_elsewhere(text, text) from public, anon, authenticated;
insert into public.tenancy_exempt_functions (name, reason)
values ('_channel_held_elsewhere', 'Sales channels: whether another business holds a store address (yes or no only)')
on conflict (name) do nothing;

create or replace function public._channel_taken_message(p_platform text)
returns text
language sql
immutable
set search_path = public, pg_temp
as $$
  select case upper(p_platform) when 'SHOPIFY' then 'This Shopify store' else 'This WooCommerce site' end
    || ' is connected to another Fullfilio business. Disconnect it there first, or ask Fullfilio support for help.'
$$;

create or replace function public.channel_upsert(p jsonb, p_actor uuid)
returns public.sales_channels
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_row public.sales_channels;
  v_platform text := upper(p ->> 'platform');
  v_domain text := lower(trim(p ->> 'shop_domain'));
begin
  perform public.require_feature(lower(p ->> 'platform'));
  if not exists (select 1 from public.sales_channels where merchant_id = public.current_merchant_id()
                 and platform = v_platform and lower(shop_domain) = v_domain and status <> 'DISCONNECTED') then
    perform public.require_limit('stores');
  end if;
  perform public._require_system();
  if v_platform not in ('SHOPIFY', 'WOOCOMMERCE') then
    raise exception 'VALIDATION: unknown platform' using errcode = '22023';
  end if;
  if public._channel_held_elsewhere(v_platform, v_domain) then
    raise exception 'DUPLICATE: %', public._channel_taken_message(v_platform);
  end if;
  -- This business's own row for the store, if it ever connected it.
  select * into v_row from public.sales_channels
  where merchant_id = public.current_merchant_id() and platform = v_platform and lower(shop_domain) = v_domain
  for update;
  if found then
    update public.sales_channels
      set auth_mode = coalesce(p ->> 'auth_mode', auth_mode),
          status = case when status = 'DISCONNECTED' then 'PENDING' else status end
      where id = v_row.id
      returning * into v_row;
  else
    begin
      insert into public.sales_channels(platform, name, shop_domain, auth_mode, created_by)
      values (v_platform, coalesce(nullif(trim(p ->> 'name'), ''), v_domain), v_domain, p ->> 'auth_mode', p_actor)
      returning * into v_row;
    exception when unique_violation then
      -- Another tab of this business saved the same store a moment ago.
      raise exception 'DUPLICATE: This store is being connected already. Try again in a moment.';
    end;
  end if;
  return v_row;
end;
$$;

-- Becoming CONNECTED (or ERROR) is where a store is claimed; if another business got there first,
-- say so instead of failing with a database error.
create or replace function public.channel_update(p_id uuid, p jsonb, p_actor uuid default null)
returns public.sales_channels
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_old public.sales_channels;
  v_row public.sales_channels;
begin
  perform public._require_system();
  select * into v_old from public.sales_channels where id = p_id for update;
  if not found then
    raise exception 'NOT_FOUND: sales channel not found' using errcode = 'P0002';
  end if;
  begin
    update public.sales_channels set
      name = coalesce(nullif(trim(p ->> 'name'), ''), name),
      status = coalesce(p ->> 'status', status),
      scopes = coalesce((select array_agg(x) from jsonb_array_elements_text(p -> 'scopes') x), scopes),
      currency = coalesce(p ->> 'currency', currency),
      webhooks = coalesce(p -> 'webhooks', webhooks),
      last_test = coalesce(p -> 'last_test', last_test),
      last_tested_at = case when p ? 'last_test' then now() else last_tested_at end,
      last_error = case when p ? 'last_error' then nullif(p ->> 'last_error', '') else last_error end,
      last_sync_at = case when (p ->> 'synced')::boolean then now() else last_sync_at end,
      connected_at = case when (p ->> 'status') = 'CONNECTED' and v_old.status <> 'CONNECTED' then now() else connected_at end
    where id = p_id returning * into v_row;
  exception when unique_violation then
    raise exception 'DUPLICATE: %', public._channel_taken_message(v_old.platform);
  end;
  if (p ->> 'status') is distinct from v_old.status and p ? 'status' then
    insert into public.audit_logs(actor_id, actor_email, action, entity_type, entity_id, old_values, new_values)
    values (p_actor, (select email from public.profiles where id = p_actor), 'channel.' || lower(v_row.status), 'sales_channel',
            p_id::text, jsonb_build_object('status', v_old.status), jsonb_build_object('status', v_row.status, 'error', v_row.last_error));
  end if;
  return v_row;
end;
$$;

select public._tenancy_own_functions();
