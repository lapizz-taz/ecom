-- =============================================================================
-- Customer messages: unsubscribe from marketing emails, and the numbers the Email and WhatsApp
-- pages show.
--   * Every email address a store sends cart reminders or review requests to gets a private
--     token. The email carries a visible "Unsubscribe" link and List-Unsubscribe headers, so
--     Gmail and others show their own unsubscribe button (one click, RFC 8058).
--   * An unsubscribed address gets no cart reminders or review requests by email (they are
--     logged as not sent). Order emails (confirmation, shipping …) still go: the customer
--     needs them.
--   * messaging_channel_stats: sent, delivered, read, failed, confirmed by customers,
--     unsubscribed, per message, for the last days.
-- Safe to re-run.
-- =============================================================================

create table if not exists public.email_preferences (
  merchant_id uuid not null default public.current_merchant_id() references public.merchants(id),
  email text not null check (email = lower(email) and length(email) <= 320),
  token text not null unique check (token ~ '^[0-9a-f]{40}$'),
  created_at timestamptz not null default now(),
  unsubscribed_at timestamptz,
  unsubscribed_via text check (unsubscribed_via in ('LINK', 'ONE_CLICK')),
  primary key (merchant_id, email)
);

do $$
declare t text;
begin
  foreach t in array array['email_preferences'] loop
    execute format('alter table public.%I enable row level security', t);
    execute format('drop policy if exists tenant_isolation on public.%I', t);
    execute format($p$create policy tenant_isolation on public.%I as restrictive for all to public
      using (merchant_id = (select public.current_merchant_id()))
      with check (merchant_id = (select public.current_merchant_id()) and not (select public._support_read_only()))$p$, t);
    execute format('drop policy if exists app_owner_all on public.%I', t);
    execute format('create policy app_owner_all on public.%I for all to app_owner using (true) with check (true)', t);
    execute format('revoke all on public.%I from anon, authenticated', t);
  end loop;
end $$;

/** The emails a customer can unsubscribe from: offers and reminders, not order updates. */
create or replace function public._email_marketing_event(p_event public.notification_event)
returns boolean
language sql
immutable
set search_path = public, pg_temp
as $$
  select p_event in ('CART_REMINDER', 'REVIEW_REQUEST')
$$;

/** The address's unsubscribe token in this store (made the first time it is needed). */
create or replace function public._email_preference_token(p_email text)
returns text
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_email text := lower(trim(coalesce(p_email, '')));
  v_token text;
begin
  if v_email !~ '^[^\s@<>"]+@[^\s@<>"]+\.[a-z]{2,}$' then
    return null;
  end if;
  select token into v_token from public.email_preferences where email = v_email;
  if v_token is null then
    -- 160 random bits, as the order's confirm token (gen_random_uuid is cryptographically random).
    insert into public.email_preferences (email, token)
    values (v_email, replace(gen_random_uuid()::text, '-', '') || left(replace(gen_random_uuid()::text, '-', ''), 8))
    on conflict (merchant_id, email) do nothing;
    select token into v_token from public.email_preferences where email = v_email;
  end if;
  return v_token;
end;
$$;

create or replace function public._email_unsubscribed(p_email text)
returns boolean
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  select exists (select 1 from public.email_preferences
                 where email = lower(trim(coalesce(p_email, ''))) and unsubscribed_at is not null)
$$;

-- A cart reminder or review request to an address that unsubscribed is logged as not sent
-- (whichever path queued it, and when staff press "Send again").
create or replace function public._notification_logs_unsubscribed()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
begin
  if new.channel = 'EMAIL' and new.status = 'QUEUED' and new.purpose = 'AUTOMATION' and new.event is not null
     and public._email_marketing_event(new.event) and public._email_unsubscribed(new.recipient) then
    new.status := 'SKIPPED';
    new.error := 'The customer unsubscribed from these emails';
  end if;
  return new;
end;
$$;

drop trigger if exists notification_logs_unsubscribed on public.notification_logs;
create trigger notification_logs_unsubscribed before insert or update of status on public.notification_logs
  for each row execute function public._notification_logs_unsubscribed();

-- ---------------------------------------------------------------- the customer's page (no sign-in)
/** "c•••••@gmail.com": enough for the customer to recognise the address, not to read it off. */
create or replace function public._email_masked(p_email text)
returns text
language sql
immutable
set search_path = public, pg_temp
as $$
  select case when position('@' in p_email) > 1
    then left(p_email, 1) || repeat('•', least(greatest(position('@' in p_email) - 2, 1), 6)) || substr(p_email, position('@' in p_email))
    else p_email end
$$;

create or replace function public.email_unsubscribe_view(p_token text)
returns jsonb
language plpgsql
stable
security definer
set search_path = public, pg_temp
as $$
declare
  p public.email_preferences;
begin
  if not public.is_system_context() then
    raise exception 'PERMISSION_DENIED' using errcode = '42501';
  end if;
  if coalesce(p_token, '') !~ '^[0-9a-f]{40}$' then
    return null;
  end if;
  select * into p from public.email_preferences where token = p_token;
  if not found then
    return null;
  end if;
  return jsonb_build_object(
    'store', public._notification_shop() - 'review_url' - 'address' - 'email',
    'email', public._email_masked(p.email),
    'unsubscribed', p.unsubscribed_at is not null,
    'language', public._messaging_settings() ->> 'language');
end;
$$;

/** Unsubscribe (or subscribe again) from the page or a mail app's own button; answers the page's view. */
create or replace function public.email_unsubscribe_apply(p_token text, p_subscribe boolean, p_via text)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
begin
  if not public.is_system_context() then
    raise exception 'PERMISSION_DENIED' using errcode = '42501';
  end if;
  if coalesce(p_token, '') !~ '^[0-9a-f]{40}$' then
    return null;
  end if;
  update public.email_preferences set
    unsubscribed_at = case when p_subscribe then null else coalesce(unsubscribed_at, now()) end,
    unsubscribed_via = case when p_subscribe then null
                            else coalesce(unsubscribed_via, case when p_via = 'ONE_CLICK' then 'ONE_CLICK' else 'LINK' end) end
  where token = p_token;
  return public.email_unsubscribe_view(p_token);
end;
$$;

-- ---------------------------------------------------------------- sending
/** For the sender: as before, and a cart reminder or review request carries its unsubscribe token. */
create or replace function public._notification_send_plan(p_log_id uuid)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  l public.notification_logs;
  n public.notifications;
  e jsonb;
  c public.inbox_channels;
begin
  if not public.is_system_context() then
    raise exception 'PERMISSION_DENIED' using errcode = '42501';
  end if;
  select * into l from public.notification_logs where id = p_log_id;
  if not found then
    return null;
  end if;
  if l.channel = 'EMAIL' then
    e := public._email_settings();
    return jsonb_build_object(
      'channel', 'EMAIL', 'provider', l.provider,
      'from_name', coalesce(nullif(e ->> 'from_name', ''), public.setting_text('store', array['name'], 'Our store')),
      'reply_to', coalesce(nullif(e ->> 'reply_to', ''), nullif(public.setting_text('store', array['email'], ''), '')),
      'smtp', e -> 'smtp',
      'service', public._platform_email_service(),
      'rendered', coalesce((l.data ->> 'rendered')::boolean, false),
      'liquid', coalesce((l.data ->> 'liquid')::boolean, false),
      'vars', l.data -> 'vars',
      'reply_token', l.data ->> 'reply_token',
      'unsubscribe_token', case when l.purpose = 'AUTOMATION' and l.event is not null and public._email_marketing_event(l.event)
                                then public._email_preference_token(l.recipient) end,
      'language', public._messaging_settings() ->> 'language',
      'merchant_id', l.merchant_id);
  end if;
  if l.channel = 'WHATSAPP' then
    select * into n from public.notifications where id = l.notification_id;
    select * into c from public.inbox_channels
    where platform = 'WHATSAPP' and id::text = coalesce(l.data ->> 'channel_id', public._whatsapp_settings() ->> 'channel_id');
    return jsonb_build_object(
      'channel', 'WHATSAPP',
      'approved', n.wa_status = 'APPROVED' and n.wa_name is not null,
      'template', n.wa_name, 'language', n.wa_language,
      'params', coalesce((select jsonb_agg(coalesce(l.data -> 'vars' ->> p.name, '') order by p.ord)
                          from jsonb_array_elements_text(coalesce(n.wa_params, '[]'::jsonb)) with ordinality p(name, ord)), '[]'::jsonb),
      -- The approved template has Confirm / Cancel: each button carries the order's token.
      'buttons', case when n.wa_buttons and l.data ? 'reply_token'
                      then jsonb_build_array('ffo:confirm:' || (l.data ->> 'reply_token'), 'ffo:cancel:' || (l.data ->> 'reply_token')) end,
      'channel_id', c.id, 'phone_number_id', c.external_id, 'waba_id', c.waba_id,
      'connected', c.id is not null and c.status <> 'DISCONNECTED');
  end if;
  return null;
end;
$$;

-- ---------------------------------------------------------------- what the Email and WhatsApp pages show
/**
 * The last days of one channel's customer messages (tests and the owner's summary left out):
 * how many went out, reached the phone, were read, failed or were not sent; per message; what
 * customers answered to Confirm / Cancel; and (email) how many unsubscribed.
 */
create or replace function public.messaging_channel_stats(p_channel text, p_days int default 30)
returns jsonb
language plpgsql
stable
security definer
set search_path = public, pg_temp
as $$
declare
  v_days int := least(greatest(coalesce(p_days, 30), 1), 365);
  v_since timestamptz := now() - make_interval(days => least(greatest(coalesce(p_days, 30), 1), 365));
  v jsonb;
begin
  perform public.require_permission('notifications.view');
  if p_channel not in ('EMAIL', 'WHATSAPP') then
    raise exception 'VALIDATION: choose email or WhatsApp' using errcode = '22023';
  end if;
  with l as (
    select * from public.notification_logs
    where channel = p_channel::public.notification_channel and purpose = 'AUTOMATION' and created_at >= v_since
  )
  select jsonb_build_object(
    'days', v_days,
    'sent', count(*) filter (where status = 'SENT'),
    'delivered', count(*) filter (where status = 'SENT' and delivery_status in ('DELIVERED', 'READ')),
    'read', count(*) filter (where status = 'SENT' and delivery_status = 'READ'),
    'failed', count(*) filter (where status = 'FAILED' or (status = 'SENT' and delivery_status = 'FAILED')),
    'skipped', count(*) filter (where status = 'SKIPPED'),
    'waiting', count(*) filter (where status in ('QUEUED', 'SENDING')),
    'last_sent_at', max(sent_at),
    'by_event', coalesce((select jsonb_object_agg(x.event, x.n) from (
      select event::text as event, count(*) as n from l where status = 'SENT' and event is not null group by event) x), '{}'::jsonb),
    'by_sms', (select count(*) from public.notification_logs f join l on l.id = f.fallback_of where f.status = 'SENT'),
    'confirmed', (select count(*) from public.order_reply_tokens t
                  where t.replied_at >= v_since and t.reply = 'CONFIRMED' and t.reply_via = p_channel),
    'cancelled', (select count(*) from public.order_reply_tokens t
                  where t.replied_at >= v_since and t.reply in ('CANCELLED', 'CANCEL_REQUESTED') and t.reply_via = p_channel),
    'unsubscribed', case when p_channel = 'EMAIL'
                         then (select count(*) from public.email_preferences where unsubscribed_at is not null) else 0 end,
    'tested', exists (select 1 from public.notification_logs t
                      where t.channel = p_channel::public.notification_channel and t.purpose = 'TEST' and t.status = 'SENT'))
  into v
  from l;
  return v;
end;
$$;

revoke execute on function
  public._email_marketing_event(public.notification_event),
  public._email_preference_token(text),
  public._email_unsubscribed(text),
  public._notification_logs_unsubscribed(),
  public._email_masked(text),
  public.email_unsubscribe_view(text),
  public.email_unsubscribe_apply(text, boolean, text),
  public._notification_send_plan(uuid)
from public, anon, authenticated;
revoke execute on function public.messaging_channel_stats(text, int) from public, anon;
grant execute on function public.messaging_channel_stats(text, int) to authenticated;

select public._tenancy_own_functions();
