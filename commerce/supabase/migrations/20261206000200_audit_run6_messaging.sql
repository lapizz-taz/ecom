-- =============================================================================
-- Security audit run 6: customer messages.
--
--   * The customer's Confirm/Cancel and unsubscribe links stay out of the message log. The token is
--     made when the message is sent (never kept on the log row), and the copy of a sent email kept
--     for the log shows "hidden" in place of the token. "Send again" puts the real links back.
--     Links already in the log are hidden too.
--   * The owner's daily summary (profit, ad spend) is in the message log only for staff who may
--     see finance.
--   * "Send again" on an email skipped for the Fullfilio email service's daily limit waits until
--     the limit allows it, like a new email.
--   * Cart reminders: one reminder per phone number or email address per 24 hours from a store,
--     however many carts carry it (a cart's own second reminder still goes); the first name is one
--     clean word; a reminder email goes only to the signed-in customer's own address.
--
-- Patched in place where a function is long (CREATE OR REPLACE keeps owner and grants), every
-- matched line written as a one-line E'' string. Safe to re-run.
-- =============================================================================

-- ---------------------------------------------------------------- confirm / cancel tokens
do $$
declare
  v_old text := replace(pg_get_functiondef('public._enqueue_order_notification(uuid,public.notification_event,text,jsonb)'::regprocedure), E'\r', '');
  v_from text := E'jsonb_build_object(''reply_token'', v_token)';
begin
  if position(E'jsonb_build_object(''reply'', true)' in v_old) > 0 then
    return; -- already patched
  end if;
  if (length(v_old) - length(replace(v_old, v_from, ''))) / length(v_from) <> 2 then
    raise exception 'reply tokens: _enqueue_order_notification has changed';
  end if;
  execute replace(v_old, v_from, E'jsonb_build_object(''reply'', true)');
end $$;

do $$
declare
  v_old text := replace(pg_get_functiondef('public._notification_send_plan(uuid)'::regprocedure), E'\r', '');
  v_token text := E'''reply_token'', l.data ->> ''reply_token'',';
  v_cond text := E'n.wa_buttons and l.data ? ''reply_token''';
  v_buttons text := E'jsonb_build_array(''ffo:confirm:'' || (l.data ->> ''reply_token''), ''ffo:cancel:'' || (l.data ->> ''reply_token''))';
  v_new text;
begin
  if position('public._order_reply_token(l.order_id)' in v_old) > 0 then
    return; -- already patched
  end if;
  if (length(v_old) - length(replace(v_old, v_token, ''))) / length(v_token) <> 1
     or (length(v_old) - length(replace(v_old, v_cond, ''))) / length(v_cond) <> 1
     or (length(v_old) - length(replace(v_old, v_buttons, ''))) / length(v_buttons) <> 1 then
    raise exception 'reply tokens: _notification_send_plan has changed';
  end if;
  v_new := replace(v_old, v_token,
    E'''reply_token'', case when l.order_id is not null and (l.data ? ''reply'' or l.data ? ''reply_token'') then public._order_reply_token(l.order_id) end,');
  v_new := replace(v_new, v_cond, E'n.wa_buttons and l.order_id is not null and (l.data ? ''reply'' or l.data ? ''reply_token'')');
  v_new := replace(v_new, v_buttons,
    E'(select jsonb_build_array(''ffo:confirm:'' || t, ''ffo:cancel:'' || t) from public._order_reply_token(l.order_id) t)');
  execute v_new;
end $$;

-- The copy of a sent email kept for the log: the customer's link tokens are hidden.
create or replace function public._notification_log_rendered(p_id uuid, p_subject text, p_body text)
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
    subject = left(p_subject, 300),
    body = left(regexp_replace(p_body, '(/(order-confirm|unsubscribe)/[0-9a-fA-F-]{36}/)[0-9a-f]{40}', '\1hidden', 'g'), 600000),
    data = coalesce(data, '{}'::jsonb) || '{"rendered": true}'::jsonb
  where id = p_id and status = 'SENDING';
end;
$$;

-- Tokens already in the log.
update public.notification_logs
set data = (data - 'reply_token') || '{"reply": true}'::jsonb
where data ? 'reply_token';
update public.notification_logs
set body = regexp_replace(body, '(/(order-confirm|unsubscribe)/[0-9a-fA-F-]{36}/)[0-9a-f]{40}', '\1hidden', 'g')
where channel = 'EMAIL' and body ~ '/(order-confirm|unsubscribe)/[0-9a-fA-F-]{36}/[0-9a-f]{40}';

-- ---------------------------------------------------------------- who reads the message log
drop policy if exists notification_logs_read on public.notification_logs;
create policy notification_logs_read on public.notification_logs for select to authenticated
  using (((select public.has_permission('orders.view')) or (select public.has_permission('settings.view'))
          or (channel = 'SMS' and (select public.has_permission('sms.view')))
          or (channel in ('EMAIL', 'WHATSAPP') and (select public.has_permission('notifications.view'))))
         -- The owner's daily summary carries profit and ad spend.
         and (purpose is distinct from 'SUMMARY' or (select public.has_permission('finance.view'))));

-- ---------------------------------------------------------------- "Send again"
create or replace function public.retry_notification(p_id uuid)
returns void
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_log public.notification_logs;
begin
  select * into v_log from public.notification_logs where id = p_id;
  if not found then
    raise exception 'NOT_FOUND: message not found' using errcode = 'P0002';
  end if;
  if v_log.channel = 'SMS' then
    perform public.require_permission('sms.manage');
  elsif not public.has_permission('notifications.manage') then
    perform public.require_permission('settings.manage');
  end if;
  -- Fullfilio's email service: sending again counts against today's limit like a new email.
  if v_log.channel = 'EMAIL' and v_log.provider = 'fullfilio' and v_log.status in ('FAILED', 'SKIPPED') then
    perform pg_advisory_xact_lock(hashtextextended('email-service-limit:' || coalesce(v_log.merchant_id::text, ''), 0));
    if public._email_service_sent_today() >= public._email_service_limit() then
      raise exception 'VALIDATION: today''s limit of % emails through Fullfilio''s email service is used up. Send it again tomorrow, or connect your own mailbox.',
        public._email_service_limit() using errcode = '22023';
    end if;
  end if;
  update public.notification_logs set status = 'QUEUED', next_attempt_at = now(), attempts = 0, error = null
  where id = p_id and status in ('FAILED', 'SKIPPED');
end;
$$;

-- ---------------------------------------------------------------- cart reminders
create or replace function public.messaging_queue_cart(p_source text, p_id uuid, p_step int, p_url text)
returns int
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_name text;
  v_first text;
  v_phone text;
  v_email text;
  v_items jsonb;
  v_total numeric;
  v_count_items int;
  v_customer uuid;
  v_step text := 'cart:' || p_source || ':' || p_id || ':' || p_step;
  v_cart_steps text := 'cart:' || p_source || ':' || p_id || ':%';
  v_symbol text := public.setting_text('store', array['currency_symbol'], '৳');
  v_sms_prefix text := coalesce(nullif(trim(public.setting_text('sms', array['currency_text'], 'Tk')), '') || ' ', '');
  v_email_settings jsonb := public._email_settings();
  v_wa jsonb := public._whatsapp_settings();
  v_tpl public.notifications;
  v_vars jsonb;
  v_sms_vars jsonb;
  v_data jsonb;
  v_recipient text;
  v_body text;
  v_parts record;
  v_key text;
  v_log uuid;
  v_count int := 0;
begin
  if not public.is_system_context() then
    raise exception 'PERMISSION_DENIED' using errcode = '42501';
  end if;
  if p_source not in ('own', 'shopify') or p_step not in (1, 2) or coalesce(p_url, '') !~* '^https?://' then
    raise exception 'VALIDATION: unknown cart' using errcode = '22023';
  end if;
  if p_source = 'own' then
    -- The email goes only to the signed-in customer's own address, never one found by the typed phone.
    select c.customer_name, c.phone, c.customer_id,
           (select lower(cu.email) from public.customers cu where c.customer_id is not null and cu.id = c.customer_id limit 1),
           (select coalesce(jsonb_agg(jsonb_build_object('title', e ->> 'name', 'variant_title', e ->> 'variant', 'quantity', (e ->> 'quantity')::int,
                                                         'price', (e ->> 'unit_price')::numeric,
                                                         'line_price', (e ->> 'unit_price')::numeric * (e ->> 'quantity')::int,
                                                         'image_url', e ->> 'image') order by ord), '[]'::jsonb)
            from jsonb_array_elements(c.items) with ordinality as t(e, ord)),
           c.subtotal, c.item_count
    into v_name, v_phone, v_customer, v_email, v_items, v_total, v_count_items
    from public.store_carts c where c.id = p_id and c.status = 'ACTIVE';
  else
    select s.customer_name, s.phone, null::uuid, lower(s.email),
           (select coalesce(jsonb_agg(jsonb_build_object('title', e ->> 'title', 'variant_title', e ->> 'variant', 'quantity', (e ->> 'quantity')::int,
                                                         'price', nullif(e ->> 'price', '')::numeric,
                                                         'line_price', nullif(e ->> 'price', '')::numeric * (e ->> 'quantity')::int,
                                                         'image_url', e ->> 'image') order by ord), '[]'::jsonb)
            from jsonb_array_elements(s.items) with ordinality as t(e, ord)),
           s.total, s.item_count
    into v_name, v_phone, v_customer, v_email, v_items, v_total, v_count_items
    from public.shopify_abandoned_checkouts s where s.id = p_id and s.status = 'OPEN' and s.follow_up = 'NONE';
  end if;
  if v_items is null then
    return 0;
  end if;
  -- The typed name on one line; the first name one word without control characters.
  v_name := left(regexp_replace(regexp_replace(trim(coalesce(v_name, '')), '\s+', ' ', 'g'), '[[:cntrl:]]', '', 'g'), 100);
  v_first := left(split_part(v_name, ' ', 1), 40);
  v_vars := jsonb_build_object(
    'customer_name', v_name, 'customer_first_name', v_first,
    'cart_total', public._fmt_amount(v_total, v_symbol), 'cart_url', p_url,
    'store_name', public.setting_text('store', array['name'], 'Our store'), 'store_phone', public.setting_text('store', array['phone'], ''));
  v_sms_vars := v_vars || jsonb_build_object('cart_total', public._fmt_amount(v_total, v_sms_prefix));

  for v_tpl in select * from public.notifications where event = 'CART_REMINDER' and is_enabled order by created_at, id loop
    v_key := v_tpl.id || ':' || v_step;
    v_log := null;
    v_recipient := case when v_tpl.channel = 'EMAIL' then v_email else public.sms_phone(v_phone) end;
    -- One reminder per phone number or address per 24 hours, however many carts carry it
    -- (this cart's own earlier reminder does not count, so its second reminder still goes).
    if v_recipient is not null and exists (
         select 1 from public.notification_logs r
         where r.event = 'CART_REMINDER' and r.channel = v_tpl.channel and r.recipient = v_recipient
           and r.status in ('QUEUED', 'SENDING', 'SENT') and r.created_at > now() - interval '24 hours'
           and coalesce(r.data ->> 'step', '') not like v_cart_steps) then
      continue;
    end if;
    if v_tpl.channel = 'SMS' then
      if not public.setting_bool('sms', array['enabled'], false) or not public.feature_enabled('sms') then
        continue;
      end if;
      if v_recipient is null or exists (select 1 from public.notification_logs f where f.fallback_of is not null
                                        and f.data ->> 'step' = v_step and f.status in ('QUEUED', 'SENDING', 'SENT')) then
        continue;
      end if;
      v_body := public.render_template(v_tpl.template, v_sms_vars);
      select * into v_parts from public.sms_parts(v_body);
      insert into public.notification_logs(notification_id, event, channel, recipient, body, customer_id, dedupe_key,
        segments, encoding, cost, cost_source, provider, data)
      values (v_tpl.id, 'CART_REMINDER', 'SMS', v_recipient, v_body, v_customer, v_key, v_parts.segments, v_parts.encoding,
        round(v_parts.segments * greatest(public._sms_credit_price(), 0), 4), 'ESTIMATE', public._platform_sms_provider(),
        jsonb_build_object('step', v_step))
      on conflict (merchant_id, dedupe_key) do nothing;
    elsif v_tpl.channel = 'EMAIL' then
      if not coalesce((v_email_settings ->> 'enabled')::boolean, false) or not public._email_ready(v_email_settings)
         or v_email is null or v_email !~* '^[^\s@<>"]+@[^\s@<>"]+\.[a-z]{2,}$' then
        continue;
      end if;
      if v_email_settings ->> 'provider' = 'fullfilio' and public._email_service_sent_today() >= public._email_service_limit() then
        continue;
      end if;
      v_data := jsonb_build_object('liquid', true, 'step', v_step, 'vars', jsonb_build_object(
        'shop', public._notification_shop(),
        'customer', jsonb_build_object('name', v_name, 'first_name', v_first, 'phone', v_phone, 'email', v_email),
        'cart', jsonb_build_object('url', p_url, 'total', v_total, 'item_count', v_count_items, 'line_items', v_items)));
      insert into public.notification_logs(notification_id, event, channel, recipient, subject, body, customer_id, dedupe_key, provider, data)
      values (v_tpl.id, 'CART_REMINDER', 'EMAIL', v_email, v_tpl.subject, v_tpl.template, v_customer, v_key, v_email_settings ->> 'provider', v_data)
      on conflict (merchant_id, dedupe_key) do nothing;
    else
      if not coalesce((v_wa ->> 'enabled')::boolean, false) or coalesce(v_wa ->> 'provider', '') <> 'meta' then
        continue;
      end if;
      if v_recipient is null then
        continue;
      end if;
      v_body := public.render_template(coalesce(v_tpl.wa_body, v_tpl.template), v_vars);
      v_data := jsonb_build_object('vars', v_vars, 'sms_vars', v_sms_vars, 'channel_id', v_wa ->> 'channel_id', 'step', v_step);
      if coalesce(v_tpl.wa_status, '') <> 'APPROVED' or v_tpl.wa_name is null then
        insert into public.notification_logs(notification_id, event, channel, recipient, body, customer_id, dedupe_key, provider, data, status, error)
        values (v_tpl.id, 'CART_REMINDER', 'WHATSAPP', v_recipient, v_body, v_customer, v_key, 'meta', v_data, 'SKIPPED',
          'This WhatsApp message is not approved by Meta yet (WhatsApp → submit it for approval)')
        on conflict (merchant_id, dedupe_key) do nothing
        returning id into v_log;
        if v_log is not null then
          perform public._whatsapp_fallback(v_log);
        end if;
        continue;
      end if;
      insert into public.notification_logs(notification_id, event, channel, recipient, body, customer_id, dedupe_key, provider, data)
      values (v_tpl.id, 'CART_REMINDER', 'WHATSAPP', v_recipient, v_body, v_customer, v_key, 'meta', v_data)
      on conflict (merchant_id, dedupe_key) do nothing;
    end if;
    if found then
      v_count := v_count + 1;
    end if;
  end loop;
  return v_count;
end;
$$;

select public._tenancy_own_functions();
