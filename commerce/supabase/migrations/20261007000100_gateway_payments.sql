-- =============================================================================
-- Online advance payments: bKash Tokenized Checkout and PayStation
--   * credentials are saved from Settings → Payments into Vault
--   * each gateway attempt is remembered by its session id (bKash paymentID,
--     PayStation invoice) so callbacks and the reconcile job find the payment
--   * money is recorded only after the gateway confirms it server-to-server
-- =============================================================================

-- Off until connected.
update public.settings set value = jsonb_set(value, '{providers}', coalesce(value -> 'providers', '{}'::jsonb)
  || case when value -> 'providers' ? 'bkash' then '{}'::jsonb
          else jsonb_build_object('bkash', jsonb_build_object('enabled', false, 'type', 'redirect', 'label', 'Pay with bKash', 'sandbox', true)) end
  || case when value -> 'providers' ? 'paystation' then '{}'::jsonb
          else jsonb_build_object('paystation', jsonb_build_object('enabled', false, 'type', 'redirect',
            'label', 'Nagad, Rocket or card (PayStation)', 'pay_with_charge', false)) end)
where key = 'payments';

create index payments_gateway_sessions_idx on public.payments using gin (metadata jsonb_path_ops)
  where provider in ('bkash', 'paystation');
create index payments_pending_gateway_idx on public.payments(created_at)
  where status = 'PENDING' and provider in ('bkash', 'paystation');

-- Same as before; orders past delivery or lost no longer take payments.
create or replace function public.start_order_payment(
  p_order_number text,
  p_phone text,
  p_purpose public.payment_purpose,
  p_provider text,
  p_channel public.payment_channel default 'GATEWAY'
)
returns public.payments
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_order public.orders;
  v_amount numeric;
  v_payment public.payments;
begin
  if not public.is_system_context() then
    raise exception 'PERMISSION_DENIED' using errcode = '42501';
  end if;
  select * into v_order from public.orders
  where order_number = upper(trim(p_order_number)) and customer_phone = public.clean_phone(p_phone)
  for update;
  if not found then
    raise exception 'NOT_FOUND: order not found' using errcode = 'P0002';
  end if;
  if v_order.status in ('CANCELLED', 'REJECTED_FRAUD', 'RETURNED', 'DELIVERED', 'PARTIALLY_DELIVERED', 'FAILED_DELIVERY',
                        'RETURNING', 'LOST', 'PENDING_CANCEL') then
    raise exception 'VALIDATION: this order no longer accepts payments' using errcode = '22023';
  end if;

  v_amount := case p_purpose
    when 'ADVANCE' then v_order.advance_required - v_order.amount_paid
    else v_order.total_amount - v_order.amount_paid end;
  if v_amount <= 0 then
    raise exception 'VALIDATION: nothing is due on this order' using errcode = '22023';
  end if;

  select * into v_payment from public.payments
  where order_id = v_order.id and provider = p_provider and purpose = p_purpose and status = 'PENDING'
    and amount = public.money(v_amount) and (expires_at is null or expires_at > now())
  order by created_at desc limit 1;
  if found then
    return v_payment;
  end if;

  insert into public.payments(order_id, provider, purpose, amount, currency, channel, payer_phone, expires_at)
  values (v_order.id, p_provider, p_purpose, public.money(v_amount),
          public.setting_text('store', array['currency'], 'BDT'), p_channel, v_order.customer_phone,
          now() + interval '2 hours')
  returning * into v_payment;
  return v_payment;
end;
$$;

-- Remembers a gateway attempt (a payment can be retried several times).
create or replace function public.attach_gateway_session(p_payment_id uuid, p_redirect_url text, p_session text, p_metadata jsonb default '{}'::jsonb)
returns public.payments
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_payment public.payments;
begin
  if not public.is_system_context() then
    raise exception 'PERMISSION_DENIED' using errcode = '42501';
  end if;
  update public.payments set
    redirect_url = coalesce(p_redirect_url, redirect_url),
    metadata = metadata || coalesce(p_metadata, '{}'::jsonb)
      || case when nullif(p_session, '') is null then '{}'::jsonb else jsonb_build_object('sessions',
           (select coalesce(jsonb_agg(distinct s), '[]'::jsonb)
            from jsonb_array_elements_text(coalesce(metadata -> 'sessions', '[]'::jsonb) || to_jsonb(left(p_session, 120))) s)) end
  where id = p_payment_id
  returning * into v_payment;
  if not found then
    raise exception 'NOT_FOUND: payment not found' using errcode = 'P0002';
  end if;
  return v_payment;
end;
$$;

create or replace function public.find_gateway_payment(p_provider text, p_session text)
returns public.payments
language plpgsql
stable
security definer
set search_path = public, pg_temp
as $$
declare
  v_payment public.payments;
begin
  if not public.is_system_context() then
    raise exception 'PERMISSION_DENIED' using errcode = '42501';
  end if;
  select * into v_payment from public.payments
  where provider = p_provider
    and (metadata @> jsonb_build_object('sessions', jsonb_build_array(p_session)) or reference = p_session)
  order by created_at desc limit 1;
  return v_payment;
end;
$$;

-- Attempts whose customer may never have come back from the gateway.
create or replace function public.gateway_payments_to_reconcile(p_limit int default 50)
returns table (id uuid, provider text, reference text, sessions jsonb, age_minutes int)
language plpgsql
stable
security definer
set search_path = public, pg_temp
as $$
begin
  if not public.is_system_context() then
    raise exception 'PERMISSION_DENIED' using errcode = '42501';
  end if;
  return query
    select p.id, p.provider, p.reference, coalesce(p.metadata -> 'sessions', '[]'::jsonb),
           (extract(epoch from now() - p.created_at) / 60)::int
    from public.payments p
    where p.status = 'PENDING' and p.provider in ('bkash', 'paystation')
      and p.created_at < now() - interval '3 minutes' and p.created_at > now() - interval '3 days'
    order by p.created_at
    limit least(greatest(p_limit, 1), 200);
end;
$$;

-- Turns a gateway on or off after its credentials were tested (edge function only).
create or replace function public.payment_set_provider(p_code text, p_enabled boolean, p_sandbox boolean default null)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_value jsonb;
begin
  if not public.is_system_context() then
    raise exception 'PERMISSION_DENIED' using errcode = '42501';
  end if;
  if p_code not in ('bkash', 'paystation') then
    raise exception 'VALIDATION: unknown payment gateway' using errcode = '22023';
  end if;
  update public.settings set value = jsonb_set(value, array['providers', p_code],
      coalesce(value -> 'providers' -> p_code, jsonb_build_object('type', 'redirect'))
        || jsonb_strip_nulls(jsonb_build_object('enabled', p_enabled, 'sandbox', p_sandbox)), true),
    updated_at = now()
  where key = 'payments'
  returning value -> 'providers' -> p_code into v_value;
  return v_value;
end;
$$;

-- A payment the gateway confirmed is always recorded, even if an earlier
-- attempt on the same payment was cancelled in another tab.
create or replace function public.confirm_payment(
  p_reference text,
  p_provider text,
  p_provider_transaction_id text,
  p_amount numeric,
  p_event_id text,
  p_event_type text,
  p_payload jsonb,
  p_success boolean
)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_payment public.payments;
  v_event_id uuid;
  v_op public.order_payments;
begin
  if not public.is_system_context() then
    raise exception 'PERMISSION_DENIED' using errcode = '42501';
  end if;

  select * into v_payment from public.payments where reference = p_reference and provider = p_provider for update;
  if not found then
    raise exception 'NOT_FOUND: payment % not found', p_reference using errcode = 'P0002';
  end if;

  insert into public.payment_events(payment_id, provider, event_id, event_type, payload)
  values (v_payment.id, p_provider, p_event_id, p_event_type, coalesce(p_payload, '{}'::jsonb))
  on conflict (provider, event_id) do nothing
  returning id into v_event_id;

  if v_event_id is null then
    return jsonb_build_object('status', 'duplicate_event', 'payment_status', v_payment.status);
  end if;

  if v_payment.status = 'SUCCEEDED' then
    update public.payment_events set processed_at = now(), result = 'already_succeeded' where id = v_event_id;
    return jsonb_build_object('status', 'already_succeeded', 'payment_status', v_payment.status);
  end if;

  if not p_success then
    update public.payments set status = 'FAILED', failure_reason = coalesce(p_payload ->> 'reason', 'Declined by provider')
    where id = v_payment.id and status in ('PENDING', 'REQUIRES_VERIFICATION');
    update public.payment_events set processed_at = now(), result = 'failed' where id = v_event_id;
    return jsonb_build_object('status', 'failed');
  end if;

  if p_amount is null or public.money(p_amount) < v_payment.amount then
    update public.payments set status = 'REQUIRES_VERIFICATION',
      failure_reason = format('Amount mismatch: expected %s, provider reported %s', v_payment.amount, p_amount),
      provider_transaction_id = coalesce(provider_transaction_id, p_provider_transaction_id)
    where id = v_payment.id;
    update public.payment_events set processed_at = now(), result = 'amount_mismatch' where id = v_event_id;
    return jsonb_build_object('status', 'amount_mismatch');
  end if;

  update public.payments set
    status = case when status in ('FAILED', 'CANCELLED', 'EXPIRED') then 'PENDING' else status end,
    failure_reason = case when status in ('FAILED', 'CANCELLED', 'EXPIRED') then null else failure_reason end,
    provider_transaction_id = coalesce(provider_transaction_id, p_provider_transaction_id)
  where id = v_payment.id;
  v_op := public._settle_payment(v_payment.id, least(public.money(p_amount), v_payment.amount));
  update public.payment_events set processed_at = now(), result = 'succeeded' where id = v_event_id;
  return jsonb_build_object('status', 'succeeded', 'order_payment_id', v_op.id);
end;
$$;

-- Online gateways appear at checkout only once their credentials are connected.
create or replace function public.storefront_config()
returns jsonb
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  select jsonb_build_object(
    'store', public.get_setting('store') - 'phone_pattern',
    'storefront', public.get_setting('storefront'),
    'policies', public.get_setting('policies'),
    'delivery', jsonb_build_object(
      'methods', coalesce((select jsonb_agg(m) from jsonb_array_elements(coalesce(public.get_setting('delivery') -> 'methods', '[]'::jsonb)) m
                           where coalesce((m ->> 'active')::boolean, true)), '[]'::jsonb),
      'districts', coalesce(public.get_setting('delivery') -> 'districts', '[]'::jsonb),
      'free_delivery_threshold', public.get_setting('delivery') -> 'free_delivery_threshold',
      'zones', coalesce((select jsonb_agg(jsonb_build_object('name', z.name, 'charge', z.charge, 'districts', to_jsonb(z.districts),
                           'estimated_days', z.estimated_days, 'is_default', z.is_default) order by z.sort_order)
                         from public.delivery_zones z where z.is_active), '[]'::jsonb)
    ),
    'payments', jsonb_build_object(
      'cod_enabled', public.setting_bool('payments', array['cod_enabled'], true),
      'advance_enabled', public.setting_bool('payments', array['advance_enabled'], true),
      'full_payment_enabled', public.setting_bool('payments', array['full_payment_enabled'], true),
      'providers', coalesce((select jsonb_agg(jsonb_build_object('code', k, 'label', v ->> 'label', 'type', v ->> 'type',
                               'instructions', v ->> 'instructions', 'accounts', coalesce(v -> 'accounts', '[]'::jsonb))
                               order by case k when 'bkash' then 1 when 'paystation' then 2 when 'sslcommerz' then 3 else 9 end)
                             from jsonb_each(coalesce(public.get_setting('payments') -> 'providers', '{}'::jsonb)) as e(k, v)
                             where coalesce((v ->> 'enabled')::boolean, false)
                               and (k not in ('bkash', 'paystation') or v ->> 'credentials' = 'env'
                                    or exists (select 1 from public.integration_credentials c
                                               where c.key = 'payments.' || k and c.hint is not null))), '[]'::jsonb),
      'voluntary_advance', public.get_setting('payments') -> 'voluntary_advance'
    ),
    'phone_pattern', public.setting_text('store', array['phone_pattern'], '^01[3-9][0-9]{8}$')
  )
$$;

-- bKash's id_token, shared by every function instance so the store grants one an
-- hour (bKash asks merchants not to grant per request). Kept in Vault: it is a
-- bearer credential for the merchant account.
create or replace function public.gateway_token_get(p_key text)
returns jsonb
language plpgsql
stable
security definer
set search_path = public, pg_temp
as $$
declare
  v_value text;
begin
  if not public.is_system_context() then
    raise exception 'PERMISSION_DENIED' using errcode = '42501';
  end if;
  select decrypted_secret into v_value from vault.decrypted_secrets where name = 'gateway-token:' || p_key;
  return nullif(v_value, '')::jsonb;
end;
$$;

create or replace function public.gateway_token_put(p_key text, p_value jsonb)
returns void
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_secret uuid;
begin
  if not public.is_system_context() then
    raise exception 'PERMISSION_DENIED' using errcode = '42501';
  end if;
  if p_key !~ '^[a-z0-9_]{2,40}$' or jsonb_typeof(p_value) <> 'object' then
    raise exception 'VALIDATION: bad gateway token' using errcode = '22023';
  end if;
  select id into v_secret from vault.secrets where name = 'gateway-token:' || p_key;
  if v_secret is null then
    perform vault.create_secret(p_value::text, 'gateway-token:' || p_key, 'Payment gateway access token (expires on its own)');
  else
    perform vault.update_secret(v_secret, p_value::text);
  end if;
end;
$$;

revoke execute on function public.attach_gateway_session(uuid, text, text, jsonb), public.find_gateway_payment(text, text),
  public.gateway_payments_to_reconcile(int), public.payment_set_provider(text, boolean, boolean),
  public.gateway_token_get(text), public.gateway_token_put(text, jsonb)
from public, anon, authenticated;
grant execute on function public.attach_gateway_session(uuid, text, text, jsonb), public.find_gateway_payment(text, text),
  public.gateway_payments_to_reconcile(int), public.payment_set_provider(text, boolean, boolean),
  public.gateway_token_get(text), public.gateway_token_put(text, jsonb)
to service_role;
