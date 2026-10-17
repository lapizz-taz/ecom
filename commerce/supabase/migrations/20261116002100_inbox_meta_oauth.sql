-- =============================================================================
-- Messaging: connect with "Continue with Facebook" on Fullfilio's own Meta app.
--
--   * One Meta app for every store (Super Admin keeps its credentials), so Meta
--     sends every store's events to one webhook. merchant_for('inbox_account',
--     '<PLATFORM>:<id>') finds the store a Page, Instagram account or WhatsApp
--     number belongs to.
--   * A Page, Instagram account or WhatsApp number can be connected to one store
--     at a time; connecting it to a second store is refused with a clear message.
-- =============================================================================

create or replace function public.merchant_for(p_kind text, p_key text)
returns uuid
language plpgsql
stable
security definer
set search_path = public, pg_temp
as $$
declare
  v_ids uuid[];
  v_uuid uuid;
  v_a text;
  v_b text;
begin
  if not public.is_system_context() then
    raise exception 'PERMISSION_DENIED' using errcode = '42501';
  end if;
  if p_key is null or length(p_key) = 0 or length(p_key) > 300 then
    return null;
  end if;
  if p_kind in ('channel', 'courier', 'payment', 'pbx_call', 'order', 'profile') then
    if p_key !~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' then
      return null;
    end if;
    v_uuid := p_key::uuid;
  end if;
  v_a := split_part(p_key, ':', 1);
  v_b := substr(p_key, length(v_a) + 2);

  v_ids := case p_kind
    when 'channel' then array(select merchant_id from public.sales_channels where id = v_uuid)
    when 'channel_oauth_state' then array(select merchant_id from public.channel_oauth_states where state = p_key)
    when 'ad_oauth_state' then array(select merchant_id from public.ad_oauth_states where state = p_key)
    when 'courier' then array(select merchant_id from public.couriers where id = v_uuid)
    -- "<provider>:<consignment id>" for provider-wide courier webhooks
    when 'consignment' then array(select distinct s.merchant_id from public.shipments s join public.couriers c on c.id = s.courier_id
                                  where c.provider = v_a and (s.consignment_id = v_b or s.tracking_number = v_b))
    -- "<provider>:<gateway session or our reference>" for payment returns and IPNs
    when 'payment_session' then array(select distinct merchant_id from public.payments
                                      where provider = v_a and (metadata @> jsonb_build_object('sessions', jsonb_build_array(v_b)) or reference = v_b))
    when 'payment' then array(select merchant_id from public.payments where id = v_uuid)
    when 'site_api_key' then array(select merchant_id from public.site_api_keys where key_hash = p_key and revoked_at is null)
    when 'store_domain' then array(select merchant_id from public.store_domains where domain = lower(p_key) and status <> 'REMOVED')
    when 'pbx_bkash_reference' then array(select merchant_id from public.pbx_bkash_transactions where reference = p_key)
    when 'pbx_bkash_payment' then array(select merchant_id from public.pbx_bkash_transactions where payment_id = p_key)
    when 'pbx_sip_username' then array(select merchant_id from public.pbx_agents where sip_username = p_key)
    when 'pbx_did' then array(select merchant_id from public.pbx_businesses where did in (p_key, public.normalize_phone(p_key)))
    when 'pbx_business_code' then array(select merchant_id from public.pbx_businesses where code::text = p_key)
    when 'pbx_call' then array(select merchant_id from public.pbx_call_records where id = v_uuid)
    when 'order' then array(select merchant_id from public.orders where id = v_uuid)
    when 'profile' then array(select merchant_id from public.profiles where id = v_uuid)
    -- "<FACEBOOK|INSTAGRAM|WHATSAPP>:<Page, Instagram account or phone number id>" for the shared Meta webhook
    when 'inbox_account' then array(select distinct merchant_id from public.inbox_channels
                                    where status <> 'DISCONNECTED' and platform = v_a
                                      and (external_id = v_b or (v_a = 'INSTAGRAM' and page_id = v_b)))
    else null
  end;
  if v_ids is null then
    raise exception 'VALIDATION: unknown lookup %', p_kind using errcode = '22023';
  end if;
  -- Not found, or found in more than one merchant: no answer rather than a guess.
  if cardinality(v_ids) <> 1 then
    return null;
  end if;
  return (select id from public.merchants where id = v_ids[1] and status <> 'CLOSED');
end;
$$;
-- (create or replace keeps merchant_for's existing grants: system only.)

create unique index if not exists inbox_channels_one_store_idx
  on public.inbox_channels (platform, external_id) where status <> 'DISCONNECTED';

-- Add or update a connected channel. Returns the row (no secrets live here).
create or replace function public.inbox_channel_save(p jsonb, p_actor uuid default null)
returns public.inbox_channels
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_row public.inbox_channels;
begin
  if not public.is_system_context() then
    raise exception 'PERMISSION_DENIED' using errcode = '42501';
  end if;
  begin
    insert into public.inbox_channels (platform, external_id, name, username, avatar_url, page_id, waba_id, display_phone,
      receive_comments, status, status_error, token_hint, connected_by)
    values (p ->> 'platform', p ->> 'external_id', left(coalesce(nullif(p ->> 'name', ''), p ->> 'external_id'), 120),
      nullif(p ->> 'username', ''), nullif(p ->> 'avatar_url', ''), nullif(p ->> 'page_id', ''), nullif(p ->> 'waba_id', ''),
      nullif(p ->> 'display_phone', ''), coalesce((p ->> 'receive_comments')::boolean, true), coalesce(p ->> 'status', 'OK'),
      nullif(p ->> 'status_error', ''), nullif(p ->> 'token_hint', ''), p_actor)
    on conflict (merchant_id, platform, external_id) do update set
      name = excluded.name, username = coalesce(excluded.username, inbox_channels.username),
      avatar_url = coalesce(excluded.avatar_url, inbox_channels.avatar_url), page_id = coalesce(excluded.page_id, inbox_channels.page_id),
      waba_id = coalesce(excluded.waba_id, inbox_channels.waba_id), display_phone = coalesce(excluded.display_phone, inbox_channels.display_phone),
      receive_comments = excluded.receive_comments, status = excluded.status, status_error = excluded.status_error,
      token_hint = coalesce(excluded.token_hint, inbox_channels.token_hint), connected_by = coalesce(excluded.connected_by, inbox_channels.connected_by),
      updated_at = now()
    returning * into v_row;
  exception when unique_violation then
    raise exception 'CONFLICT: % is already connected to another Fullfilio store. Disconnect it there first.',
      coalesce(nullif(p ->> 'name', ''), p ->> 'external_id') using errcode = 'P0001';
  end;
  insert into public.audit_logs (actor_id, action, entity_type, entity_id, new_values)
  values (p_actor, 'inbox_channel.saved', 'inbox_channel', v_row.id, jsonb_build_object('platform', v_row.platform, 'name', v_row.name, 'status', v_row.status));
  return v_row;
end;
$$;

select public._tenancy_own_functions();
