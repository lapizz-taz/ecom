-- =============================================================================
-- SMS integration and automation
--   * one SMS provider connected from the admin (credentials in Vault, only
--     the provider name, a masked hint and the sender ID are kept here)
--   * automation rules: event + optional conditions + template; several rules
--     may share an event (e.g. one text for COD, another for prepaid orders)
--   * every message is queued once per rule, order and event (dedupe key), so
--     repeated status changes or duplicate webhooks never text a customer twice
--   * each sent SMS records its parts and cost and posts the cost to Finance
--     (category SMS) against its order; a provider-reported charge replaces
--     the estimate with a single adjustment
--   * delivery reports are polled where the provider offers them
--   * a failure while queueing is written to the System log and never blocks
--     the order change that triggered it
-- =============================================================================

-- -----------------------------------------------------------------------------
-- Settings, finance category
-- -----------------------------------------------------------------------------
insert into public.settings(key, is_public, description, value) values
('sms', false, 'SMS provider connection (credentials live in Vault) and automation switch', jsonb_build_object(
  'enabled', false,
  'provider', null,
  'connected', false,
  'hint', null,
  'sender_id', '',
  'cost_per_sms', 0.35,
  'currency_text', 'Tk',
  'balance', null,
  'balance_checked_at', null,
  'connected_at', null
))
on conflict (key) do nothing;

insert into public.finance_categories(code, name, type, pnl_group, is_system, allow_manual, sort_order, description) values
  ('SMS', 'SMS', 'EXPENSE', 'OPERATING_EXPENSE', true, false, 155,
   'Cost of each SMS sent to customers, posted automatically (do not add SMS top-ups as expenses)')
on conflict (code) do nothing;

-- -----------------------------------------------------------------------------
-- Rules (the notifications table) and the message log
-- -----------------------------------------------------------------------------
alter table public.notifications drop constraint if exists notifications_event_channel_key;

create or replace function public.notification_event_label(p_event public.notification_event)
returns text
language sql
immutable
set search_path = public, pg_temp
as $$
  select case p_event::text
    when 'ORDER_CREATED' then 'Order placed'
    when 'ORDER_CONFIRMED' then 'Order approved'
    when 'PRE_ORDER_CONFIRMED' then 'Pre-order confirmed'
    when 'ADVANCE_REQUIRED' then 'Advance needed'
    when 'ADVANCE_RECEIVED' then 'Advance received'
    when 'PAYMENT_RECEIVED' then 'Payment received'
    when 'PAYMENT_FAILED' then 'Payment failed'
    when 'ORDER_SHIPPED' then 'Order shipped'
    when 'OUT_FOR_DELIVERY' then 'Out for delivery'
    when 'ORDER_DELIVERED' then 'Delivered'
    when 'ORDER_CANCELLED' then 'Order cancelled'
    when 'RETURN_INITIATED' then 'Return initiated'
    when 'ORDER_RETURNED' then 'Returned'
    else initcap(replace(p_event::text, '_', ' ')) end
$$;

-- Conditions: [{"field": "...", "op": "...", "value": ...}], all must match.
-- Returns null when valid, otherwise what is wrong (also used by a CHECK).
create or replace function public.notification_conditions_error(p_conditions jsonb)
returns text
language plpgsql
immutable
set search_path = public, pg_temp
as $$
declare
  c jsonb;
  v_field text;
  v_op text;
  v_value jsonb;
  v_item text;
begin
  if p_conditions is null or jsonb_typeof(p_conditions) <> 'array' then
    return 'conditions must be a list';
  end if;
  if jsonb_array_length(p_conditions) > 10 then
    return 'use at most 10 conditions';
  end if;
  for c in select * from jsonb_array_elements(p_conditions) loop
    if jsonb_typeof(c) <> 'object' then
      return 'each condition must be an object';
    end if;
    v_field := c ->> 'field';
    v_op := c ->> 'op';
    v_value := c -> 'value';
    if v_field in ('payment_method', 'district', 'source', 'courier') then
      if v_op not in ('in', 'not_in') then
        return format('%s needs "is one of" or "is not one of"', v_field);
      end if;
      if v_value is null or jsonb_typeof(v_value) <> 'array' or jsonb_array_length(v_value) = 0
         or jsonb_array_length(v_value) > 70 then
        return format('choose at least one value for %s', v_field);
      end if;
      for v_item in select * from jsonb_array_elements_text(v_value) loop
        if length(trim(v_item)) = 0 or length(v_item) > 80 then
          return format('%s has an empty or too long value', v_field);
        end if;
        if v_field = 'payment_method' and v_item not in ('COD', 'ADVANCE', 'FULL_PAYMENT') then
          return format('unknown payment method %s', v_item);
        end if;
        if v_field = 'source' and v_item not in ('STOREFRONT', 'ADMIN', 'IMPORT', 'API') then
          return format('unknown order source %s', v_item);
        end if;
        if v_field = 'courier' and v_item !~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' then
          return 'courier must be a courier id';
        end if;
      end loop;
    elsif v_field = 'total' then
      if v_op not in ('gte', 'lte') then
        return 'order total needs "at least" or "at most"';
      end if;
      if v_value is null or jsonb_typeof(v_value) <> 'number' or (v_value #>> '{}')::numeric < 0 then
        return 'order total must be a number of 0 or more';
      end if;
    elsif v_field = 'first_order' then
      if v_op <> 'eq' or v_value is null or jsonb_typeof(v_value) <> 'boolean' then
        return 'first order must be yes or no';
      end if;
    else
      return format('unknown condition %s', coalesce(v_field, '(none)'));
    end if;
  end loop;
  return null;
end;
$$;

create or replace function public._notification_conditions_match(p_conditions jsonb, p_facts jsonb)
returns boolean
language plpgsql
immutable
set search_path = public, pg_temp
as $$
declare
  c jsonb;
  v_fact text;
  v_in boolean;
begin
  for c in select * from jsonb_array_elements(coalesce(p_conditions, '[]'::jsonb)) loop
    v_fact := p_facts ->> (c ->> 'field');
    if c ->> 'op' in ('in', 'not_in') then
      v_in := v_fact is not null and exists (
        select 1 from jsonb_array_elements_text(c -> 'value') x where lower(trim(x)) = lower(trim(v_fact)));
      if (c ->> 'op' = 'in') <> v_in then
        return false;
      end if;
    elsif c ->> 'op' = 'gte' then
      if v_fact is null or v_fact::numeric < (c ->> 'value')::numeric then
        return false;
      end if;
    elsif c ->> 'op' = 'lte' then
      if v_fact is null or v_fact::numeric > (c ->> 'value')::numeric then
        return false;
      end if;
    elsif c ->> 'op' = 'eq' then
      if v_fact is null or lower(v_fact) <> lower(c ->> 'value') then
        return false;
      end if;
    else
      return false;
    end if;
  end loop;
  return true;
end;
$$;

alter table public.notifications
  add column if not exists name text check (name is null or length(name) between 1 and 80),
  add column if not exists conditions jsonb not null default '[]'::jsonb;
alter table public.notifications
  add constraint notifications_conditions_valid check (public.notification_conditions_error(conditions) is null),
  add constraint notifications_template_length check (length(template) between 1 and 1000);

-- Advance received is now one case of "Payment received" (sent for every payment).
update public.notifications set event = 'PAYMENT_RECEIVED' where event = 'ADVANCE_RECEIVED';

insert into public.notifications(event, channel, is_enabled, subject, template)
select e.event::public.notification_event, c.channel::public.notification_channel, false,
       case when c.channel = 'EMAIL' then e.subject end, e.body
from (values
  ('PRE_ORDER_CONFIRMED', 'Pre-order {{order_number}} confirmed',
   'Your pre-order {{order_number}} is confirmed. We will ship it as soon as it arrives in stock. - {{store_name}}'),
  ('OUT_FOR_DELIVERY', 'Order {{order_number}} is out for delivery',
   'Your order {{order_number}} is out for delivery today. Please keep {{cod_amount}} ready. - {{store_name}}'),
  ('RETURN_INITIATED', 'Order {{order_number}} is being returned',
   'Your order {{order_number}} is being returned to us. Questions? Call {{store_phone}}. - {{store_name}}'),
  ('PAYMENT_FAILED', 'Payment for {{order_number}} did not go through',
   'Your payment of {{payment_amount}} for order {{order_number}} did not go through. Try again: {{track_order_url}} - {{store_name}}')
) e(event, subject, body)
cross join (values ('SMS'), ('WHATSAPP'), ('EMAIL')) c(channel)
where not exists (select 1 from public.notifications n where n.event = e.event::public.notification_event and n.channel = c.channel::public.notification_channel);

update public.notifications set template =
  'We received {{payment_amount}} for order {{order_number}}. Thank you! - {{store_name}}'
where event = 'PAYMENT_RECEIVED'
  and template = 'We received your payment for order {{order_number}}. Thank you! - {{store_name}}';

update public.notifications set name = public.notification_event_label(event) where name is null;

alter table public.notification_logs
  alter column event drop not null,
  add column if not exists purpose text not null default 'AUTOMATION' check (purpose in ('AUTOMATION', 'TEST')),
  add column if not exists dedupe_key text unique,
  add column if not exists segments int check (segments is null or segments >= 0),
  add column if not exists encoding text check (encoding in ('GSM', 'UNICODE')),
  add column if not exists cost numeric(10,4) check (cost is null or cost >= 0),
  add column if not exists cost_source text check (cost_source in ('ESTIMATE', 'PROVIDER')),
  add column if not exists delivery_status text check (delivery_status in ('PENDING', 'DELIVERED', 'FAILED', 'UNKNOWN')),
  add column if not exists delivered_at timestamptz,
  add column if not exists status_checked_at timestamptz,
  add column if not exists created_by uuid;
alter table public.notification_logs
  add constraint notification_logs_event_or_test check (event is not null or purpose = 'TEST');

create index if not exists notification_logs_channel_created_idx on public.notification_logs(channel, created_at desc);
create index if not exists notification_logs_dlr_idx on public.notification_logs(sent_at)
  where channel = 'SMS' and status = 'SENT' and delivery_status = 'PENDING';

-- -----------------------------------------------------------------------------
-- SMS helpers
-- -----------------------------------------------------------------------------
-- GSM-7 text: 160 characters in one SMS, 153 per part when longer (a few
-- symbols take two). Anything else (Bangla, ৳, emoji) is sent as Unicode:
-- 70 characters, 67 per part.
create or replace function public.sms_parts(p_text text)
returns table (encoding text, units int, segments int)
language plpgsql
immutable
set search_path = public, pg_temp
as $$
declare
  v_basic constant text := E'@£$¥èéùìòÇ\nØø\rÅåΔ_ΦΓΛΩΠΨΣΘΞÆæßÉ !"#¤%&''()*+,-./0123456789:;<=>?¡ABCDEFGHIJKLMNOPQRSTUVWXYZÄÖÑÜ§¿abcdefghijklmnopqrstuvwxyzäöñüà';
  v_ext constant text := E'^{}\\[~]|€\f';
  v_ch text;
  v_gsm int := 0;
  v_ucs int := 0;
  v_unicode boolean := false;
  i int;
begin
  for i in 1 .. coalesce(char_length(p_text), 0) loop
    v_ch := substr(p_text, i, 1);
    v_ucs := v_ucs + case when ascii(v_ch) > 65535 then 2 else 1 end;
    if not v_unicode then
      if strpos(v_basic, v_ch) > 0 then
        v_gsm := v_gsm + 1;
      elsif strpos(v_ext, v_ch) > 0 then
        v_gsm := v_gsm + 2;
      else
        v_unicode := true;
      end if;
    end if;
  end loop;
  if v_unicode then
    return query select 'UNICODE'::text, v_ucs, case when v_ucs = 0 then 0 when v_ucs <= 70 then 1 else ceil(v_ucs / 67.0)::int end;
  else
    return query select 'GSM'::text, v_gsm, case when v_gsm = 0 then 0 when v_gsm <= 160 then 1 else ceil(v_gsm / 153.0)::int end;
  end if;
end;
$$;

-- Bangladesh mobile number in the 8801XXXXXXXXX form SMS gateways expect, or null.
create or replace function public.sms_phone(p_phone text)
returns text
language plpgsql
immutable
set search_path = public, pg_temp
as $$
declare
  v text := regexp_replace(coalesce(p_phone, ''), '[^0-9]', '', 'g');
begin
  if v ~ '^01[3-9][0-9]{8}$' then
    return '88' || v;
  elsif v ~ '^8801[3-9][0-9]{8}$' then
    return v;
  elsif v ~ '^1[3-9][0-9]{8}$' then
    return '880' || v;
  end if;
  return null;
end;
$$;

create or replace function public._fmt_amount(p_amount numeric, p_prefix text)
returns text
language sql
immutable
set search_path = public, pg_temp
as $$
  select coalesce(p_prefix, '') || case
    when round(coalesce(p_amount, 0), 2) = trunc(coalesce(p_amount, 0)) then to_char(coalesce(p_amount, 0), 'FM999,999,999,990')
    else to_char(round(p_amount, 2), 'FM999,999,999,990.00') end
$$;

-- Masks the middle of a phone number for finance notes and logs.
create or replace function public._mask_phone(p_phone text)
returns text
language sql
immutable
set search_path = public, pg_temp
as $$
  select case when length(coalesce(p_phone, '')) > 7
    then left(p_phone, length(p_phone) - 7) || '••••' || right(p_phone, 3) else coalesce(p_phone, '') end
$$;

-- -----------------------------------------------------------------------------
-- Queueing
-- -----------------------------------------------------------------------------
create or replace function public._enqueue_order_notification(
  p_order_id uuid,
  p_event public.notification_event,
  p_ref text,
  p_extra jsonb
)
returns int
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_order public.orders;
  v_tpl public.notifications;
  v_ship record;
  v_vars jsonb;
  v_ch_vars jsonb;
  v_facts jsonb;
  v_prefix text;
  v_symbol text;
  v_sms_prefix text;
  v_rate numeric;
  v_recipient text;
  v_body text;
  v_parts record;
  v_key text;
  v_count int := 0;
  v_payment numeric;
begin
  if not exists (select 1 from public.notifications where event = p_event and is_enabled) then
    return 0;
  end if;

  begin
    if not public.setting_bool('notifications', array['enabled'], true) then
      return 0;
    end if;
    v_symbol := public.setting_text('store', array['currency_symbol'], '৳');
    v_sms_prefix := nullif(trim(public.setting_text('sms', array['currency_text'], 'Tk')), '');
    v_rate := greatest(public.setting_numeric('sms', array['cost_per_sms'], 0.35), 0);
    v_payment := nullif(p_extra ->> 'payment_amount', '')::numeric;
    select * into v_order from public.orders where id = p_order_id;
    if not found then
      return 0;
    end if;
    select s.id, s.courier_id, s.tracking_number, c.name as courier_name,
           case when c.tracking_url_template is not null and s.tracking_number is not null
                then replace(c.tracking_url_template, '{tracking}', s.tracking_number) end as tracking_url
    into v_ship
    from public.shipments s join public.couriers c on c.id = s.courier_id
    where s.order_id = p_order_id and s.is_active
    order by s.created_at desc limit 1;

    v_vars := jsonb_build_object(
      'store_name', public.setting_text('store', array['name'], 'Our store'),
      'store_phone', public.setting_text('store', array['phone'], ''),
      'order_number', v_order.order_number,
      'customer_name', v_order.customer_name,
      'customer_first_name', split_part(trim(v_order.customer_name), ' ', 1),
      'tracking_number', coalesce(v_ship.tracking_number, ''),
      'courier_name', coalesce(v_ship.courier_name, ''),
      'tracking_url', coalesce(v_ship.tracking_url, ''),
      'track_order_url', public.setting_text('store', array['website_url'], '') || '/track-order?order=' || v_order.order_number
    );
    v_facts := jsonb_build_object(
      'payment_method', v_order.payment_method,
      'total', v_order.total_amount,
      'district', v_order.shipping_district,
      'source', v_order.source,
      'courier', v_ship.courier_id,
      'first_order', not exists (select 1 from public.orders o
                                 where o.customer_id = v_order.customer_id and o.id <> v_order.id
                                   and o.created_at < v_order.created_at)
    );

    for v_tpl in select * from public.notifications where event = p_event and is_enabled order by created_at, id loop
      if v_tpl.channel = 'SMS' then
        if not public.setting_bool('sms', array['enabled'], false) then
          continue;
        end if;
      elsif not public.setting_bool('notifications', array['channels', lower(v_tpl.channel::text), 'enabled'], false) then
        continue;
      end if;
      if not public._notification_conditions_match(v_tpl.conditions, v_facts) then
        continue;
      end if;

      -- SMS amounts use plain text ("Tk 1,250") so messages stay in the cheaper GSM encoding.
      v_prefix := case when v_tpl.channel = 'SMS' then coalesce(v_sms_prefix || ' ', '') else v_symbol end;
      v_ch_vars := v_vars || jsonb_build_object(
        'total', public._fmt_amount(v_order.total_amount, v_prefix),
        'cod_amount', public._fmt_amount(v_order.cod_amount, v_prefix),
        'due_amount', public._fmt_amount(greatest(v_order.total_amount - v_order.amount_paid, 0), v_prefix),
        'advance_amount', public._fmt_amount(greatest(v_order.advance_required - v_order.amount_paid, 0), v_prefix),
        'payment_amount', case when v_payment is null then '' else public._fmt_amount(v_payment, v_prefix) end
      );
      v_body := public.render_template(v_tpl.template, v_ch_vars);
      v_key := v_tpl.id || ':' || p_order_id || ':' || coalesce(p_ref, p_event::text);
      v_recipient := case v_tpl.channel when 'EMAIL' then v_order.customer_email
                                        when 'SMS' then public.sms_phone(v_order.customer_phone)
                                        else v_order.customer_phone end;

      if v_tpl.channel = 'SMS' then
        select * into v_parts from public.sms_parts(v_body);
        if v_recipient is null then
          insert into public.notification_logs(notification_id, event, channel, recipient, body, order_id, customer_id,
            status, error, dedupe_key, segments, encoding, provider)
          values (v_tpl.id, p_event, 'SMS', coalesce(nullif(v_order.customer_phone, ''), '—'), v_body, p_order_id,
            v_order.customer_id, 'SKIPPED', 'Not a Bangladesh mobile number', v_key, v_parts.segments, v_parts.encoding,
            public.setting_text('sms', array['provider'], null))
          on conflict (dedupe_key) do nothing;
          continue;
        end if;
        insert into public.notification_logs(notification_id, event, channel, recipient, body, order_id, customer_id,
          dedupe_key, segments, encoding, cost, cost_source, provider)
        values (v_tpl.id, p_event, 'SMS', v_recipient, v_body, p_order_id, v_order.customer_id, v_key,
          v_parts.segments, v_parts.encoding, round(v_parts.segments * v_rate, 4), 'ESTIMATE',
          public.setting_text('sms', array['provider'], null))
        on conflict (dedupe_key) do nothing;
      else
        if v_recipient is null then
          continue;
        end if;
        insert into public.notification_logs(notification_id, event, channel, recipient, subject, body, order_id,
          customer_id, dedupe_key, provider)
        values (v_tpl.id, p_event, v_tpl.channel, v_recipient, public.render_template(v_tpl.subject, v_ch_vars), v_body,
          p_order_id, v_order.customer_id, v_key,
          public.setting_text('notifications', array['channels', lower(v_tpl.channel::text), 'provider'], 'console'))
        on conflict (dedupe_key) do nothing;
      end if;
      if found then
        v_count := v_count + 1;
      end if;
    end loop;
  exception when others then
    -- A broken template or setting must never stop the order change itself.
    perform public._log_system_event('ERROR', 'SMS', '_enqueue_order_notification',
      format('Could not queue the %s message for an order: %s', public.notification_event_label(p_event), sqlerrm),
      jsonb_build_object('order_id', p_order_id, 'event', p_event, 'sqlstate', sqlstate));
    return 0;
  end;
  return v_count;
end;
$$;

-- Existing callers. "Advance received" is covered by "Payment received",
-- which the payment itself queues (with its amount).
create or replace function public._enqueue_order_notification(p_order_id uuid, p_event public.notification_event)
returns int
language plpgsql
security definer
set search_path = public, pg_temp
as $$
begin
  if p_event = 'ADVANCE_RECEIVED' then
    return 0;
  end if;
  return public._enqueue_order_notification(p_order_id, p_event, null, null);
end;
$$;

-- New events -----------------------------------------------------------------
create or replace function public._order_status_notifications()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
begin
  if new.status = 'PRE_ORDER' then
    perform public._enqueue_order_notification(new.id, 'PRE_ORDER_CONFIRMED', null, null);
  elsif new.status in ('RETURN_REQUESTED', 'RETURNING') and old.status not in ('RETURN_REQUESTED', 'RETURNING', 'RETURNED') then
    perform public._enqueue_order_notification(new.id, 'RETURN_INITIATED', null, null);
  end if;
  return null;
end;
$$;

drop trigger if exists orders_status_notifications on public.orders;
create trigger orders_status_notifications after update of status on public.orders
  for each row when (old.status is distinct from new.status) execute function public._order_status_notifications();

create or replace function public._shipment_status_notifications()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
begin
  if not new.is_active then
    return null;
  end if;
  if new.status = 'OUT_FOR_DELIVERY' and exists (
       select 1 from public.orders o where o.id = new.order_id
         and o.status not in ('DELIVERED', 'PARTIALLY_DELIVERED', 'RETURN_REQUESTED', 'RETURNING', 'RETURNED',
                              'CANCELLED', 'REJECTED_FRAUD', 'LOST')) then
    -- At most one a day: a parcel can go out again after a failed attempt.
    perform public._enqueue_order_notification(new.order_id, 'OUT_FOR_DELIVERY',
      new.id || ':' || (now() at time zone public.store_timezone())::date, null);
  elsif new.status = 'RETURNING' then
    perform public._enqueue_order_notification(new.order_id, 'RETURN_INITIATED', null, null);
  end if;
  return null;
end;
$$;

drop trigger if exists shipments_status_notifications on public.shipments;
create trigger shipments_status_notifications after update of status on public.shipments
  for each row when (old.status is distinct from new.status) execute function public._shipment_status_notifications();

create or replace function public._order_payment_notifications()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
begin
  if new.kind in ('ADVANCE', 'FULL', 'BALANCE') then
    perform public._enqueue_order_notification(new.order_id, 'PAYMENT_RECEIVED', 'payment:' || new.id,
      jsonb_build_object('payment_amount', new.amount));
  end if;
  return null;
end;
$$;

drop trigger if exists order_payments_notifications on public.order_payments;
create trigger order_payments_notifications after insert on public.order_payments
  for each row execute function public._order_payment_notifications();

create or replace function public._payment_failed_notifications()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
begin
  if new.status = 'FAILED' and new.channel = 'GATEWAY'
     and not exists (select 1 from public.payments p
                     where p.order_id = new.order_id and p.purpose = new.purpose and p.status = 'SUCCEEDED') then
    perform public._enqueue_order_notification(new.order_id, 'PAYMENT_FAILED', 'payment:' || new.id,
      jsonb_build_object('payment_amount', new.amount));
  end if;
  return null;
end;
$$;

drop trigger if exists payments_failed_notifications on public.payments;
create trigger payments_failed_notifications after update of status on public.payments
  for each row when (old.status is distinct from new.status) execute function public._payment_failed_notifications();

-- -----------------------------------------------------------------------------
-- Sending (notifications-dispatch, service role)
-- -----------------------------------------------------------------------------
-- SMS cost to Finance: the estimate when sent, then one adjustment if the
-- provider reports a different charge. Idempotent through source keys.
create or replace function public._post_sms_finance(p_log_id uuid)
returns void
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_log public.notification_logs;
  v_posted numeric;
  v_date date;
  v_note text;
  v_ref text;
begin
  select * into v_log from public.notification_logs where id = p_log_id;
  if not found or v_log.channel <> 'SMS' or v_log.status <> 'SENT' or v_log.cost is null then
    return;
  end if;
  v_date := (coalesce(v_log.sent_at, now()) at time zone public.store_timezone())::date;
  v_note := format('SMS · %s · %s', coalesce(public.notification_event_label(v_log.event), 'Test message'),
                   public._mask_phone(v_log.recipient));
  select order_number into v_ref from public.orders where id = v_log.order_id;

  if not exists (select 1 from public.finance_transactions where source_key = 'sms:' || v_log.id) then
    perform public._post_finance('EXPENSE', 'SMS', v_log.cost, v_date, true, v_log.order_id, v_log.customer_id, null,
      v_ref, v_note, 'sms:' || v_log.id, null);
  elsif v_log.cost_source = 'PROVIDER' then
    select coalesce(sum(amount), 0) into v_posted from public.finance_transactions
    where source_key in ('sms:' || v_log.id, 'sms:' || v_log.id || ':provider');
    if public.money(v_log.cost) <> v_posted then
      perform public._post_finance('EXPENSE', 'SMS', public.money(v_log.cost) - v_posted, v_date, true, v_log.order_id,
        v_log.customer_id, null, v_ref, v_note || ' · charge reported by the provider', 'sms:' || v_log.id || ':provider', null);
    end if;
  end if;
end;
$$;

-- Claims a batch. A message left "sending" for 15 minutes (the sender
-- stopped mid-way) is marked failed, not re-sent: the gateway may already
-- have delivered it, and a retry is one click on the message.
create or replace function public.claim_notifications(p_limit int default 20)
returns setof public.notification_logs
language plpgsql
security definer
set search_path = public, pg_temp
as $$
begin
  if not public.is_system_context() then
    raise exception 'PERMISSION_DENIED' using errcode = '42501';
  end if;
  update public.notification_logs set status = 'FAILED',
    error = 'Sending was interrupted. Check with the provider before trying again.'
  where status = 'SENDING' and updated_at < now() - interval '15 minutes';
  return query
  update public.notification_logs n set status = 'SENDING', attempts = attempts + 1
  where n.id in (
    select id from public.notification_logs
    where status = 'QUEUED' and next_attempt_at <= now()
    order by next_attempt_at
    limit least(greatest(p_limit, 1), 100)
    for update skip locked
  )
  returning n.*;
end;
$$;

drop function if exists public.complete_notification(uuid, boolean, text, text, text);
create or replace function public.complete_notification(
  p_id uuid,
  p_success boolean,
  p_provider text,
  p_provider_message_id text,
  p_error text,
  p_cost numeric default null,
  p_permanent boolean default false,
  p_delivery_status text default null
)
returns text
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_status public.notification_status;
begin
  if not public.is_system_context() then
    raise exception 'PERMISSION_DENIED' using errcode = '42501';
  end if;
  update public.notification_logs set
    status = case when p_success then 'SENT' when p_permanent or attempts >= 3 then 'FAILED' else 'QUEUED' end::public.notification_status,
    provider = coalesce(p_provider, provider),
    provider_message_id = case when p_success then left(p_provider_message_id, 120) else provider_message_id end,
    error = case when p_success then null else left(p_error, 1000) end,
    sent_at = case when p_success then now() else sent_at end,
    next_attempt_at = case when p_success then next_attempt_at else now() + make_interval(mins => 5 * attempts) end,
    cost = case when p_success and p_cost is not null and p_cost >= 0 then p_cost else cost end,
    cost_source = case when p_success and p_cost is not null and p_cost >= 0 then 'PROVIDER' else cost_source end,
    delivery_status = case
      when p_success and channel = 'SMS' then
        case when p_delivery_status in ('PENDING', 'DELIVERED', 'FAILED', 'UNKNOWN') then p_delivery_status else 'UNKNOWN' end
      else delivery_status end,
    delivered_at = case when p_success and p_delivery_status = 'DELIVERED' then now() else delivered_at end
  where id = p_id and status = 'SENDING'
  returning status into v_status;
  if v_status = 'SENT' then
    perform public._post_sms_finance(p_id);
  end if;
  return v_status::text;
end;
$$;

-- Connection settings for the dispatcher (no secrets: those stay in Vault).
create or replace function public.sms_dispatch_config()
returns jsonb
language plpgsql
stable
security definer
set search_path = public, pg_temp
as $$
begin
  if not public.is_system_context() then
    raise exception 'PERMISSION_DENIED' using errcode = '42501';
  end if;
  return public.get_setting('sms');
end;
$$;

-- Sent messages whose delivery report is due; claimed so two runs don't both
-- ask. Checks space out as the message ages (about a dozen over a day); after
-- a day without a final answer the delivery is recorded as unknown.
create or replace function public.sms_delivery_checks(p_limit int default 20)
returns setof public.notification_logs
language plpgsql
security definer
set search_path = public, pg_temp
as $$
begin
  if not public.is_system_context() then
    raise exception 'PERMISSION_DENIED' using errcode = '42501';
  end if;
  update public.notification_logs set delivery_status = 'UNKNOWN', status_checked_at = now()
  where channel = 'SMS' and status = 'SENT' and delivery_status = 'PENDING' and sent_at < now() - interval '1 day';
  return query
  update public.notification_logs n set status_checked_at = now()
  where n.id in (
    select id from public.notification_logs
    where channel = 'SMS' and status = 'SENT' and delivery_status = 'PENDING' and provider_message_id is not null
      and sent_at < now() - interval '1 minute'
      and (status_checked_at is null
           or status_checked_at < now() - least(interval '6 hours', greatest(interval '2 minutes', (now() - sent_at) / 4)))
    order by sent_at
    limit least(greatest(p_limit, 1), 100)
    for update skip locked
  )
  returning n.*;
end;
$$;

create or replace function public.record_sms_delivery(p_id uuid, p_status text, p_cost numeric default null)
returns void
language plpgsql
security definer
set search_path = public, pg_temp
as $$
begin
  if not public.is_system_context() then
    raise exception 'PERMISSION_DENIED' using errcode = '42501';
  end if;
  update public.notification_logs set
    delivery_status = case when p_status in ('PENDING', 'DELIVERED', 'FAILED', 'UNKNOWN') then p_status else delivery_status end,
    delivered_at = case when p_status = 'DELIVERED' then coalesce(delivered_at, now()) else delivered_at end,
    status_checked_at = now(),
    cost = case when p_cost is not null and p_cost >= 0 then p_cost else cost end,
    cost_source = case when p_cost is not null and p_cost >= 0 then 'PROVIDER' else cost_source end
  where id = p_id and channel = 'SMS' and status = 'SENT';
  perform public._post_sms_finance(p_id);
end;
$$;

-- A test message from the SMS page: logged (and its cost posted) like any other.
create or replace function public.sms_log_test(p_to text, p_body text, p_actor uuid)
returns public.notification_logs
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_to text := public.sms_phone(p_to);
  v_parts record;
  v_row public.notification_logs;
begin
  if not public.is_system_context() then
    raise exception 'PERMISSION_DENIED' using errcode = '42501';
  end if;
  if v_to is null then
    raise exception 'VALIDATION: enter a Bangladesh mobile number (01XXXXXXXXX)' using errcode = '22023';
  end if;
  if length(trim(coalesce(p_body, ''))) = 0 or length(p_body) > 1000 then
    raise exception 'VALIDATION: write a message of up to 1000 characters' using errcode = '22023';
  end if;
  if (select count(*) from public.notification_logs
      where purpose = 'TEST' and created_at > now() - interval '1 hour') >= 20 then
    raise exception 'VALIDATION: 20 test messages were sent in the last hour; try again later' using errcode = '22023';
  end if;
  select * into v_parts from public.sms_parts(p_body);
  insert into public.notification_logs(event, channel, recipient, body, status, attempts, purpose, segments, encoding,
    cost, cost_source, provider, created_by)
  values (null, 'SMS', v_to, p_body, 'SENDING', 1, 'TEST', v_parts.segments, v_parts.encoding,
    round(v_parts.segments * greatest(public.setting_numeric('sms', array['cost_per_sms'], 0.35), 0), 4), 'ESTIMATE',
    public.setting_text('sms', array['provider'], null), p_actor)
  returning * into v_row;
  return v_row;
end;
$$;

-- Saved by the sms edge function after the credentials were tested.
create or replace function public.sms_set_connection(
  p_provider text, p_hint text, p_sender_id text, p_balance numeric, p_actor uuid
)
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
  if p_provider is null then
    update public.settings set value = value || jsonb_build_object('provider', null, 'connected', false, 'enabled', false,
      'hint', null, 'balance', null, 'balance_checked_at', null, 'connected_at', null), updated_by = p_actor
    where key = 'sms' returning value into v_value;
  else
    update public.settings set value = value || jsonb_build_object('provider', p_provider, 'connected', true,
      'hint', p_hint, 'sender_id', coalesce(trim(p_sender_id), ''), 'balance', p_balance,
      'balance_checked_at', case when p_balance is null then null else now() end, 'connected_at', now()), updated_by = p_actor
    where key = 'sms' returning value into v_value;
  end if;
  insert into public.audit_logs(actor_id, actor_email, action, entity_type, entity_id, metadata)
  values (p_actor, (select email from public.profiles where id = p_actor),
          case when p_provider is null then 'sms.disconnected' else 'sms.connected' end, 'integration', 'sms',
          jsonb_build_object('provider', p_provider, 'hint', p_hint, 'sender_id', p_sender_id));
  return v_value;
end;
$$;

create or replace function public.sms_set_balance(p_balance numeric)
returns void
language plpgsql
security definer
set search_path = public, pg_temp
as $$
begin
  if not public.is_system_context() then
    raise exception 'PERMISSION_DENIED' using errcode = '42501';
  end if;
  update public.settings set value = value || jsonb_build_object('balance', p_balance, 'balance_checked_at', now())
  where key = 'sms';
end;
$$;

-- -----------------------------------------------------------------------------
-- Staff API (SMS page)
-- -----------------------------------------------------------------------------
create or replace function public.sms_update_settings(
  p_enabled boolean default null,
  p_sender_id text default null,
  p_cost_per_sms numeric default null,
  p_currency_text text default null
)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_current jsonb := public.get_setting('sms');
  v_patch jsonb := '{}'::jsonb;
  v_value jsonb;
begin
  perform public.require_permission('sms.manage');
  if p_enabled is not null then
    if p_enabled and not coalesce((v_current ->> 'connected')::boolean, false) then
      raise exception 'VALIDATION: connect an SMS provider first' using errcode = '22023';
    end if;
    v_patch := v_patch || jsonb_build_object('enabled', p_enabled);
  end if;
  if p_sender_id is not null then
    if trim(p_sender_id) !~ '^[A-Za-z0-9 ._+-]{0,20}$' then
      raise exception 'VALIDATION: the sender ID can have up to 20 letters, digits, spaces, dots or dashes' using errcode = '22023';
    end if;
    v_patch := v_patch || jsonb_build_object('sender_id', trim(p_sender_id));
  end if;
  if p_cost_per_sms is not null then
    if p_cost_per_sms < 0 or p_cost_per_sms > 20 then
      raise exception 'VALIDATION: the cost per SMS must be between 0 and 20' using errcode = '22023';
    end if;
    v_patch := v_patch || jsonb_build_object('cost_per_sms', round(p_cost_per_sms, 4));
  end if;
  if p_currency_text is not null then
    if length(trim(p_currency_text)) > 6 then
      raise exception 'VALIDATION: the currency text can be up to 6 characters' using errcode = '22023';
    end if;
    v_patch := v_patch || jsonb_build_object('currency_text', trim(p_currency_text));
  end if;
  update public.settings set value = value || v_patch, updated_by = auth.uid()
  where key = 'sms' returning value into v_value;
  perform public.log_audit('sms.settings_changed', 'settings', 'sms', null, v_patch);
  return v_value;
end;
$$;

create or replace function public.sms_rule_save(
  p_id uuid,
  p_event public.notification_event,
  p_name text,
  p_template text,
  p_conditions jsonb,
  p_enabled boolean
)
returns public.notifications
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_row public.notifications;
  v_error text := public.notification_conditions_error(coalesce(p_conditions, '[]'::jsonb));
begin
  perform public.require_permission('sms.manage');
  if v_error is not null then
    raise exception 'VALIDATION: %', v_error using errcode = '22023';
  end if;
  if p_event is null or p_event = 'ADVANCE_RECEIVED' then
    raise exception 'VALIDATION: choose when the message is sent' using errcode = '22023';
  end if;
  if length(trim(coalesce(p_template, ''))) = 0 or length(p_template) > 1000 then
    raise exception 'VALIDATION: write a message of up to 1000 characters' using errcode = '22023';
  end if;
  if p_name is not null and length(trim(p_name)) > 80 then
    raise exception 'VALIDATION: the name can be up to 80 characters' using errcode = '22023';
  end if;

  if p_id is null then
    insert into public.notifications(event, channel, is_enabled, template, name, conditions)
    values (p_event, 'SMS', coalesce(p_enabled, false), trim(p_template),
            coalesce(nullif(trim(p_name), ''), public.notification_event_label(p_event)), coalesce(p_conditions, '[]'::jsonb))
    returning * into v_row;
  else
    update public.notifications set
      event = p_event,
      template = trim(p_template),
      name = coalesce(nullif(trim(p_name), ''), public.notification_event_label(p_event)),
      conditions = coalesce(p_conditions, '[]'::jsonb),
      is_enabled = coalesce(p_enabled, is_enabled)
    where id = p_id and channel = 'SMS'
    returning * into v_row;
    if not found then
      raise exception 'NOT_FOUND: automation not found' using errcode = 'P0002';
    end if;
  end if;
  return v_row;
end;
$$;

create or replace function public.sms_rule_delete(p_id uuid)
returns void
language plpgsql
security definer
set search_path = public, pg_temp
as $$
begin
  perform public.require_permission('sms.manage');
  delete from public.notifications where id = p_id and channel = 'SMS';
  if not found then
    raise exception 'NOT_FOUND: automation not found' using errcode = 'P0002';
  end if;
end;
$$;

create or replace function public.retry_notification(p_id uuid)
returns void
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_channel public.notification_channel;
begin
  select channel into v_channel from public.notification_logs where id = p_id;
  if not found then
    raise exception 'NOT_FOUND: message not found' using errcode = 'P0002';
  end if;
  perform public.require_permission(case when v_channel = 'SMS' then 'sms.manage' else 'settings.manage' end);
  update public.notification_logs set status = 'QUEUED', next_attempt_at = now(), attempts = 0, error = null
  where id = p_id and status in ('FAILED', 'SKIPPED');
end;
$$;

-- Connection, usage and cost for a period (store dates).
create or replace function public.sms_overview(p_from date, p_to date)
returns jsonb
language plpgsql
stable
security definer
set search_path = public, pg_temp
as $$
declare
  v_settings jsonb := public.get_setting('sms');
  v_result jsonb;
begin
  perform public.require_permission('sms.view');
  with l as (
    select * from public.notification_logs
    where channel = 'SMS'
      and (created_at at time zone public.store_timezone())::date between p_from and p_to
  )
  select jsonb_build_object(
    'settings', jsonb_build_object(
      'enabled', coalesce((v_settings ->> 'enabled')::boolean, false),
      'connected', coalesce((v_settings ->> 'connected')::boolean, false),
      'provider', v_settings -> 'provider',
      'hint', v_settings -> 'hint',
      'sender_id', coalesce(v_settings ->> 'sender_id', ''),
      'cost_per_sms', coalesce((v_settings ->> 'cost_per_sms')::numeric, 0),
      'currency_text', coalesce(v_settings ->> 'currency_text', 'Tk'),
      'balance', v_settings -> 'balance',
      'balance_checked_at', v_settings -> 'balance_checked_at',
      'connected_at', v_settings -> 'connected_at'),
    'totals', (select jsonb_build_object(
      'sent', count(*) filter (where status = 'SENT'),
      'failed', count(*) filter (where status = 'FAILED'),
      'waiting', count(*) filter (where status in ('QUEUED', 'SENDING')),
      'skipped', count(*) filter (where status = 'SKIPPED'),
      'parts', coalesce(sum(segments) filter (where status = 'SENT'), 0),
      'cost', coalesce(sum(cost) filter (where status = 'SENT'), 0),
      'delivered', count(*) filter (where status = 'SENT' and delivery_status = 'DELIVERED'),
      'undelivered', count(*) filter (where status = 'SENT' and delivery_status = 'FAILED'),
      'awaiting_report', count(*) filter (where status = 'SENT' and delivery_status = 'PENDING'),
      'orders', count(distinct order_id) filter (where status = 'SENT')) from l),
    'by_event', coalesce((select jsonb_agg(x order by x.sent desc, x.event) from (
      select coalesce(event::text, 'TEST') as event,
             count(*) filter (where status = 'SENT') as sent,
             count(*) filter (where status = 'FAILED') as failed,
             coalesce(sum(segments) filter (where status = 'SENT'), 0) as parts,
             coalesce(sum(cost) filter (where status = 'SENT'), 0) as cost
      from l group by 1) x), '[]'::jsonb),
    'active_rules', (select count(*) from public.notifications where channel = 'SMS' and is_enabled)
  ) into v_result;
  return v_result;
end;
$$;

-- -----------------------------------------------------------------------------
-- Access
-- -----------------------------------------------------------------------------
drop policy if exists notifications_read on public.notifications;
create policy notifications_read on public.notifications for select to authenticated
  using ((select public.has_permission('settings.view')) or (channel = 'SMS' and (select public.has_permission('sms.view'))));
drop policy if exists notification_logs_read on public.notification_logs;
create policy notification_logs_read on public.notification_logs for select to authenticated
  using ((select public.has_permission('orders.view')) or (select public.has_permission('settings.view'))
         or (channel = 'SMS' and (select public.has_permission('sms.view'))));

revoke execute on function
  public.notification_event_label(public.notification_event),
  public.notification_conditions_error(jsonb),
  public._notification_conditions_match(jsonb, jsonb),
  public.sms_parts(text),
  public.sms_phone(text),
  public._fmt_amount(numeric, text),
  public._mask_phone(text),
  public._enqueue_order_notification(uuid, public.notification_event, text, jsonb),
  public._enqueue_order_notification(uuid, public.notification_event),
  public._order_status_notifications(),
  public._shipment_status_notifications(),
  public._order_payment_notifications(),
  public._payment_failed_notifications(),
  public._post_sms_finance(uuid),
  public.complete_notification(uuid, boolean, text, text, text, numeric, boolean, text),
  public.sms_dispatch_config(),
  public.sms_delivery_checks(int),
  public.record_sms_delivery(uuid, text, numeric),
  public.sms_log_test(text, text, uuid),
  public.sms_set_connection(text, text, text, numeric, uuid),
  public.sms_set_balance(numeric),
  public.sms_update_settings(boolean, text, numeric, text),
  public.sms_rule_save(uuid, public.notification_event, text, text, jsonb, boolean),
  public.sms_rule_delete(uuid),
  public.retry_notification(uuid),
  public.sms_overview(date, date)
from public, anon, authenticated;

-- The CHECK on notifications runs this as the caller; it only reads its argument.
grant execute on function public.notification_conditions_error(jsonb), public.notification_event_label(public.notification_event)
  to authenticated, service_role;
grant execute on function
  public.sms_update_settings(boolean, text, numeric, text),
  public.sms_rule_save(uuid, public.notification_event, text, text, jsonb, boolean),
  public.sms_rule_delete(uuid),
  public.retry_notification(uuid),
  public.sms_overview(date, date)
to authenticated;
grant execute on function
  public.complete_notification(uuid, boolean, text, text, text, numeric, boolean, text),
  public.sms_dispatch_config(),
  public.sms_delivery_checks(int),
  public.record_sms_delivery(uuid, text, numeric),
  public.sms_log_test(text, text, uuid),
  public.sms_set_connection(text, text, text, numeric, uuid),
  public.sms_set_balance(numeric),
  public.sms_parts(text)
to service_role;
