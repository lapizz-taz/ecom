-- =============================================================================
-- Email and WhatsApp modules: customer messages like Shopify's notifications
--
--   * Email: every order event has an HTML email written in Liquid (Shopify's
--     template language) that the seller can switch on or off and edit as code.
--     It goes out from the seller's own mailbox (SMTP; the password lives in
--     Vault under integration key email.smtp) or through Fullfilio's email
--     service (Resend; the platform's key lives in Vault as email.resend), with
--     a daily limit per store.
--   * WhatsApp: the same events as WhatsApp messages through the seller's
--     WhatsApp number connected in Messaging → Channels. Meta only delivers a
--     business-started message from an approved template, so each text is
--     submitted to Meta and sends once it is approved. Editing it afterwards
--     keeps the approved text in use until the new one is submitted.
--   * Queued messages keep the order's data at the time of the event
--     (notification_logs.data); an email is rendered by the sender, a WhatsApp
--     message carries the values of its placeholders.
--   * notification_defaults holds the default emails and WhatsApp texts (the
--     same as supabase/functions/_shared/notifications/defaults.ts) for "Reset
--     to default" and new stores.
--   * Permissions notifications.view / notifications.manage (Admin both;
--     Manager and Order manager can view).
-- Safe to re-run.
-- =============================================================================

-- ---------------------------------------------------------------- permissions
insert into public.permissions(code, module, name) values
  ('notifications.view', 'notifications', 'See customer emails and WhatsApp messages, their settings and log'),
  ('notifications.manage', 'notifications', 'Connect email, edit and switch on customer emails and WhatsApp messages')
on conflict (code) do nothing;

create or replace function public._seed_notification_permissions(p_merchant uuid)
returns void
language sql
security definer
set search_path = public, pg_temp
as $$
  insert into public.role_permissions (merchant_id, role_id, permission_id)
  select p_merchant, r.id, p.id
  from (values
    ('ADMIN', 'notifications.view'), ('ADMIN', 'notifications.manage'),
    ('MANAGER', 'notifications.view'), ('ORDER_MANAGER', 'notifications.view')
  ) g(role_code, perm)
  join public.roles r on r.merchant_id = p_merchant and r.code = g.role_code
  join public.permissions p on p.code = g.perm
  on conflict do nothing
$$;
revoke all on function public._seed_notification_permissions(uuid) from public, anon, authenticated;

create or replace function public._roles_seed_notifications()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
begin
  if new.code = 'VIEWER' then
    perform public._seed_notification_permissions(new.merchant_id);
  end if;
  return new;
end;
$$;
drop trigger if exists roles_seed_notifications on public.roles;
create trigger roles_seed_notifications after insert on public.roles for each row execute function public._roles_seed_notifications();

-- ---------------------------------------------------------------- defaults
create table if not exists public.notification_defaults (
  channel public.notification_channel not null check (channel in ('EMAIL', 'WHATSAPP')),
  event public.notification_event not null,
  subject text,
  template text not null,
  primary key (channel, event)
);
alter table public.notification_defaults enable row level security;
drop policy if exists notification_defaults_read on public.notification_defaults;
create policy notification_defaults_read on public.notification_defaults for select to authenticated using (true);
drop policy if exists app_owner_all on public.notification_defaults;
create policy app_owner_all on public.notification_defaults for all to app_owner using (true) with check (true);
revoke all on public.notification_defaults from anon;
grant select on public.notification_defaults to authenticated;
grant select, insert, update, delete on public.notification_defaults to app_owner;

-- A platform table (the same for every store), like plans and permissions.
create or replace function public._tenancy_global_tables()
returns text[]
language sql
immutable
as $$
  select array['permissions', 'order_status_transitions', 'pbx_packages', 'pbx_gateway_status',
               'merchants', 'platform_staff', 'support_sessions', 'tenancy_exempt_functions',
               'platform_settings', 'platform_audit_logs', 'platform_credentials',
               'platform_modules', 'platform_roles', 'platform_role_permissions', 'platform_staff_merchants',
               'merchant_notes', 'platform_approvals', 'config_versions', 'features', 'plans', 'plan_addons',
               'credit_types', 'credit_packages', 'platform_notifications', 'support_ticket_events', 'platform_cost_entries',
               'platform_incidents', 'platform_incident_merchants', 'platform_incident_updates', 'platform_announcements',
               'platform_announcement_deliveries', 'platform_announcement_reads', 'platform_automation_rules', 'platform_automation_runs',
               'platform_data_exports', 'merchant_deletion_requests', 'platform_restore_tests',
               'platform_contact_messages', 'account_removals', 'signup_requests',
               'platform_finance_categories', 'platform_finance_entries', 'platform_ad_accounts',
               'platform_meta_campaigns', 'platform_meta_adsets', 'platform_meta_ads', 'platform_meta_insights', 'platform_lead_touches',
               'notification_defaults']
$$;

-- Generated by scripts/gen-notification-defaults.mjs from supabase/functions/_shared/notifications/defaults.ts.
insert into public.notification_defaults (channel, event, subject, template) values
  ('EMAIL', 'ORDER_CREATED', $t$Order {{ order.name }} received$t$, $t${% assign accent = shop.accent_color | default: "#111827" %}<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Thank you for your order!</title>
</head>
<body style="margin:0;padding:0;background:#f4f5f7;">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#f4f5f7;">
<tr><td align="center" style="padding:32px 12px;">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="max-width:560px;background:#ffffff;border-radius:12px;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif;color:#111827;">
<tr><td style="padding:28px 32px 0;">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0"><tr>
<td>{% if shop.logo_url %}<img src="{{ shop.logo_url }}" alt="{{ shop.name }}" height="36" style="display:block;height:36px;max-width:180px;border:0;">{% else %}<span style="font-size:20px;font-weight:700;color:#111827;">{{ shop.name }}</span>{% endif %}</td>
<td align="right" style="font-size:13px;color:#6b7280;">Order {{ order.name }}</td>
</tr></table>
</td></tr>
<tr><td style="padding:24px 32px 4px;">
<h1 style="margin:0 0 12px;font-size:22px;line-height:1.3;color:#111827;">Thank you for your order!</h1>
<p style="margin:0 0 12px;font-size:15px;line-height:1.6;color:#374151;">Hi {{ customer.first_name | default: "there" }}, we have received your order {{ order.name }}. We will call you shortly to confirm it before it ships.</p>
</td></tr>
{% if order.status_url %}<tr><td style="padding:12px 32px 4px;">
<a href="{{ order.status_url }}" style="display:inline-block;background:{{ accent }};color:#ffffff;text-decoration:none;font-size:15px;font-weight:600;padding:12px 22px;border-radius:8px;">View your order</a>
</td></tr>{% endif %}
<tr><td style="padding:8px 32px 0;">
<p style="margin:0 0 8px;font-size:13px;font-weight:600;text-transform:uppercase;letter-spacing:0.04em;color:#6b7280;">Order summary</p>
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="border-top:1px solid #e5e7eb;">
{% for item in order.line_items %}<tr>
<td width="56" style="padding:12px 12px 12px 0;border-bottom:1px solid #f3f4f6;vertical-align:top;">{% if item.image_url %}<img src="{{ item.image_url }}" alt="" width="48" height="48" style="display:block;width:48px;height:48px;border-radius:8px;object-fit:cover;border:1px solid #e5e7eb;">{% endif %}</td>
<td style="padding:12px 0;border-bottom:1px solid #f3f4f6;font-size:14px;line-height:1.4;color:#111827;vertical-align:top;">{{ item.title }}{% if item.variant_title %}<br><span style="color:#6b7280;font-size:13px;">{{ item.variant_title }}</span>{% endif %}<br><span style="color:#6b7280;font-size:13px;">Qty {{ item.quantity }}</span></td>
<td align="right" style="padding:12px 0;border-bottom:1px solid #f3f4f6;font-size:14px;color:#111827;vertical-align:top;white-space:nowrap;">{{ item.line_price | money }}</td>
</tr>{% endfor %}
</table>
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="margin-top:8px;">
<tr><td style="padding:6px 0;font-size:14px;color:#374151;">Subtotal</td><td align="right" style="padding:6px 0;font-size:14px;color:#374151;">{{ order.subtotal_price | money }}</td></tr>
{% if order.discount_price > 0 %}<tr><td style="padding:6px 0;font-size:14px;color:#374151;">Discount</td><td align="right" style="padding:6px 0;font-size:14px;color:#374151;">-{{ order.discount_price | money }}</td></tr>{% endif %}
<tr><td style="padding:6px 0;font-size:14px;color:#374151;">Delivery</td><td align="right" style="padding:6px 0;font-size:14px;color:#374151;">{{ order.delivery_price | money }}</td></tr>
<tr><td style="padding:10px 0 6px;font-size:16px;font-weight:700;color:#111827;border-top:1px solid #e5e7eb;">Total</td><td align="right" style="padding:10px 0 6px;font-size:16px;font-weight:700;color:#111827;border-top:1px solid #e5e7eb;">{{ order.total_price | money }}</td></tr>
{% if order.paid_amount > 0 %}<tr><td style="padding:6px 0;font-size:14px;color:#374151;">Paid</td><td align="right" style="padding:6px 0;font-size:14px;color:#374151;">{{ order.paid_amount | money }}</td></tr>{% endif %}
{% if order.cod_amount > 0 %}<tr><td style="padding:6px 0;font-size:14px;color:#374151;"><strong>To pay on delivery</strong></td><td align="right" style="padding:6px 0;font-size:14px;color:#374151;"><strong>{{ order.cod_amount | money }}</strong></td></tr>{% endif %}
</table>
</td></tr>
{% if order.shipping_address.address %}<tr><td style="padding:20px 32px 0;">
<p style="margin:0 0 6px;font-size:13px;font-weight:600;text-transform:uppercase;letter-spacing:0.04em;color:#6b7280;">Delivery address</p>
<p style="margin:0;font-size:14px;line-height:1.6;color:#374151;">{{ order.shipping_address.name }}<br>{{ order.shipping_address.address }}{% if order.shipping_address.area %}, {{ order.shipping_address.area }}{% endif %}{% if order.shipping_address.district %}, {{ order.shipping_address.district }}{% endif %}<br>{{ order.shipping_address.phone }}</p>
</td></tr>{% endif %}
<tr><td style="padding:28px 32px 28px;">
<p style="margin:0;padding-top:20px;border-top:1px solid #e5e7eb;font-size:13px;line-height:1.6;color:#6b7280;">{{ shop.name }}{% if shop.phone %} · {{ shop.phone }}{% endif %}{% if shop.email %} · {{ shop.email }}{% endif %}{% if shop.address %}<br>{{ shop.address }}{% endif %}</p>
</td></tr>
</table>
</td></tr>
</table>
</body>
</html>$t$),
  ('EMAIL', 'ORDER_CONFIRMED', $t$Order {{ order.name }} confirmed$t$, $t${% assign accent = shop.accent_color | default: "#111827" %}<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Your order is confirmed</title>
</head>
<body style="margin:0;padding:0;background:#f4f5f7;">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#f4f5f7;">
<tr><td align="center" style="padding:32px 12px;">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="max-width:560px;background:#ffffff;border-radius:12px;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif;color:#111827;">
<tr><td style="padding:28px 32px 0;">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0"><tr>
<td>{% if shop.logo_url %}<img src="{{ shop.logo_url }}" alt="{{ shop.name }}" height="36" style="display:block;height:36px;max-width:180px;border:0;">{% else %}<span style="font-size:20px;font-weight:700;color:#111827;">{{ shop.name }}</span>{% endif %}</td>
<td align="right" style="font-size:13px;color:#6b7280;">Order {{ order.name }}</td>
</tr></table>
</td></tr>
<tr><td style="padding:24px 32px 4px;">
<h1 style="margin:0 0 12px;font-size:22px;line-height:1.3;color:#111827;">Your order is confirmed</h1>
<p style="margin:0 0 12px;font-size:15px;line-height:1.6;color:#374151;">Hi {{ customer.first_name | default: "there" }}, your order {{ order.name }} is confirmed and we are getting it ready.</p>
{% if order.cod_amount > 0 %}<p style="margin:0 0 12px;font-size:15px;line-height:1.6;color:#374151;">Please keep <strong>{{ order.cod_amount | money }}</strong> ready to pay on delivery.</p>{% endif %}
</td></tr>
{% if order.status_url %}<tr><td style="padding:12px 32px 4px;">
<a href="{{ order.status_url }}" style="display:inline-block;background:{{ accent }};color:#ffffff;text-decoration:none;font-size:15px;font-weight:600;padding:12px 22px;border-radius:8px;">View your order</a>
</td></tr>{% endif %}
<tr><td style="padding:8px 32px 0;">
<p style="margin:0 0 8px;font-size:13px;font-weight:600;text-transform:uppercase;letter-spacing:0.04em;color:#6b7280;">Order summary</p>
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="border-top:1px solid #e5e7eb;">
{% for item in order.line_items %}<tr>
<td width="56" style="padding:12px 12px 12px 0;border-bottom:1px solid #f3f4f6;vertical-align:top;">{% if item.image_url %}<img src="{{ item.image_url }}" alt="" width="48" height="48" style="display:block;width:48px;height:48px;border-radius:8px;object-fit:cover;border:1px solid #e5e7eb;">{% endif %}</td>
<td style="padding:12px 0;border-bottom:1px solid #f3f4f6;font-size:14px;line-height:1.4;color:#111827;vertical-align:top;">{{ item.title }}{% if item.variant_title %}<br><span style="color:#6b7280;font-size:13px;">{{ item.variant_title }}</span>{% endif %}<br><span style="color:#6b7280;font-size:13px;">Qty {{ item.quantity }}</span></td>
<td align="right" style="padding:12px 0;border-bottom:1px solid #f3f4f6;font-size:14px;color:#111827;vertical-align:top;white-space:nowrap;">{{ item.line_price | money }}</td>
</tr>{% endfor %}
</table>
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="margin-top:8px;">
<tr><td style="padding:6px 0;font-size:14px;color:#374151;">Subtotal</td><td align="right" style="padding:6px 0;font-size:14px;color:#374151;">{{ order.subtotal_price | money }}</td></tr>
{% if order.discount_price > 0 %}<tr><td style="padding:6px 0;font-size:14px;color:#374151;">Discount</td><td align="right" style="padding:6px 0;font-size:14px;color:#374151;">-{{ order.discount_price | money }}</td></tr>{% endif %}
<tr><td style="padding:6px 0;font-size:14px;color:#374151;">Delivery</td><td align="right" style="padding:6px 0;font-size:14px;color:#374151;">{{ order.delivery_price | money }}</td></tr>
<tr><td style="padding:10px 0 6px;font-size:16px;font-weight:700;color:#111827;border-top:1px solid #e5e7eb;">Total</td><td align="right" style="padding:10px 0 6px;font-size:16px;font-weight:700;color:#111827;border-top:1px solid #e5e7eb;">{{ order.total_price | money }}</td></tr>
{% if order.paid_amount > 0 %}<tr><td style="padding:6px 0;font-size:14px;color:#374151;">Paid</td><td align="right" style="padding:6px 0;font-size:14px;color:#374151;">{{ order.paid_amount | money }}</td></tr>{% endif %}
{% if order.cod_amount > 0 %}<tr><td style="padding:6px 0;font-size:14px;color:#374151;"><strong>To pay on delivery</strong></td><td align="right" style="padding:6px 0;font-size:14px;color:#374151;"><strong>{{ order.cod_amount | money }}</strong></td></tr>{% endif %}
</table>
</td></tr>
{% if order.shipping_address.address %}<tr><td style="padding:20px 32px 0;">
<p style="margin:0 0 6px;font-size:13px;font-weight:600;text-transform:uppercase;letter-spacing:0.04em;color:#6b7280;">Delivery address</p>
<p style="margin:0;font-size:14px;line-height:1.6;color:#374151;">{{ order.shipping_address.name }}<br>{{ order.shipping_address.address }}{% if order.shipping_address.area %}, {{ order.shipping_address.area }}{% endif %}{% if order.shipping_address.district %}, {{ order.shipping_address.district }}{% endif %}<br>{{ order.shipping_address.phone }}</p>
</td></tr>{% endif %}
<tr><td style="padding:28px 32px 28px;">
<p style="margin:0;padding-top:20px;border-top:1px solid #e5e7eb;font-size:13px;line-height:1.6;color:#6b7280;">{{ shop.name }}{% if shop.phone %} · {{ shop.phone }}{% endif %}{% if shop.email %} · {{ shop.email }}{% endif %}{% if shop.address %}<br>{{ shop.address }}{% endif %}</p>
</td></tr>
</table>
</td></tr>
</table>
</body>
</html>$t$),
  ('EMAIL', 'PRE_ORDER_CONFIRMED', $t$Pre-order {{ order.name }} confirmed$t$, $t${% assign accent = shop.accent_color | default: "#111827" %}<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Your pre-order is confirmed</title>
</head>
<body style="margin:0;padding:0;background:#f4f5f7;">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#f4f5f7;">
<tr><td align="center" style="padding:32px 12px;">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="max-width:560px;background:#ffffff;border-radius:12px;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif;color:#111827;">
<tr><td style="padding:28px 32px 0;">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0"><tr>
<td>{% if shop.logo_url %}<img src="{{ shop.logo_url }}" alt="{{ shop.name }}" height="36" style="display:block;height:36px;max-width:180px;border:0;">{% else %}<span style="font-size:20px;font-weight:700;color:#111827;">{{ shop.name }}</span>{% endif %}</td>
<td align="right" style="font-size:13px;color:#6b7280;">Order {{ order.name }}</td>
</tr></table>
</td></tr>
<tr><td style="padding:24px 32px 4px;">
<h1 style="margin:0 0 12px;font-size:22px;line-height:1.3;color:#111827;">Your pre-order is confirmed</h1>
<p style="margin:0 0 12px;font-size:15px;line-height:1.6;color:#374151;">Hi {{ customer.first_name | default: "there" }}, your pre-order {{ order.name }} is confirmed. We will ship it as soon as it arrives in stock.</p>
</td></tr>
{% if order.status_url %}<tr><td style="padding:12px 32px 4px;">
<a href="{{ order.status_url }}" style="display:inline-block;background:{{ accent }};color:#ffffff;text-decoration:none;font-size:15px;font-weight:600;padding:12px 22px;border-radius:8px;">View your order</a>
</td></tr>{% endif %}
<tr><td style="padding:8px 32px 0;">
<p style="margin:0 0 8px;font-size:13px;font-weight:600;text-transform:uppercase;letter-spacing:0.04em;color:#6b7280;">Order summary</p>
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="border-top:1px solid #e5e7eb;">
{% for item in order.line_items %}<tr>
<td width="56" style="padding:12px 12px 12px 0;border-bottom:1px solid #f3f4f6;vertical-align:top;">{% if item.image_url %}<img src="{{ item.image_url }}" alt="" width="48" height="48" style="display:block;width:48px;height:48px;border-radius:8px;object-fit:cover;border:1px solid #e5e7eb;">{% endif %}</td>
<td style="padding:12px 0;border-bottom:1px solid #f3f4f6;font-size:14px;line-height:1.4;color:#111827;vertical-align:top;">{{ item.title }}{% if item.variant_title %}<br><span style="color:#6b7280;font-size:13px;">{{ item.variant_title }}</span>{% endif %}<br><span style="color:#6b7280;font-size:13px;">Qty {{ item.quantity }}</span></td>
<td align="right" style="padding:12px 0;border-bottom:1px solid #f3f4f6;font-size:14px;color:#111827;vertical-align:top;white-space:nowrap;">{{ item.line_price | money }}</td>
</tr>{% endfor %}
</table>
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="margin-top:8px;">
<tr><td style="padding:6px 0;font-size:14px;color:#374151;">Subtotal</td><td align="right" style="padding:6px 0;font-size:14px;color:#374151;">{{ order.subtotal_price | money }}</td></tr>
{% if order.discount_price > 0 %}<tr><td style="padding:6px 0;font-size:14px;color:#374151;">Discount</td><td align="right" style="padding:6px 0;font-size:14px;color:#374151;">-{{ order.discount_price | money }}</td></tr>{% endif %}
<tr><td style="padding:6px 0;font-size:14px;color:#374151;">Delivery</td><td align="right" style="padding:6px 0;font-size:14px;color:#374151;">{{ order.delivery_price | money }}</td></tr>
<tr><td style="padding:10px 0 6px;font-size:16px;font-weight:700;color:#111827;border-top:1px solid #e5e7eb;">Total</td><td align="right" style="padding:10px 0 6px;font-size:16px;font-weight:700;color:#111827;border-top:1px solid #e5e7eb;">{{ order.total_price | money }}</td></tr>
{% if order.paid_amount > 0 %}<tr><td style="padding:6px 0;font-size:14px;color:#374151;">Paid</td><td align="right" style="padding:6px 0;font-size:14px;color:#374151;">{{ order.paid_amount | money }}</td></tr>{% endif %}
{% if order.cod_amount > 0 %}<tr><td style="padding:6px 0;font-size:14px;color:#374151;"><strong>To pay on delivery</strong></td><td align="right" style="padding:6px 0;font-size:14px;color:#374151;"><strong>{{ order.cod_amount | money }}</strong></td></tr>{% endif %}
</table>
</td></tr>
{% if order.shipping_address.address %}<tr><td style="padding:20px 32px 0;">
<p style="margin:0 0 6px;font-size:13px;font-weight:600;text-transform:uppercase;letter-spacing:0.04em;color:#6b7280;">Delivery address</p>
<p style="margin:0;font-size:14px;line-height:1.6;color:#374151;">{{ order.shipping_address.name }}<br>{{ order.shipping_address.address }}{% if order.shipping_address.area %}, {{ order.shipping_address.area }}{% endif %}{% if order.shipping_address.district %}, {{ order.shipping_address.district }}{% endif %}<br>{{ order.shipping_address.phone }}</p>
</td></tr>{% endif %}
<tr><td style="padding:28px 32px 28px;">
<p style="margin:0;padding-top:20px;border-top:1px solid #e5e7eb;font-size:13px;line-height:1.6;color:#6b7280;">{{ shop.name }}{% if shop.phone %} · {{ shop.phone }}{% endif %}{% if shop.email %} · {{ shop.email }}{% endif %}{% if shop.address %}<br>{{ shop.address }}{% endif %}</p>
</td></tr>
</table>
</td></tr>
</table>
</body>
</html>$t$),
  ('EMAIL', 'ADVANCE_REQUIRED', $t$Advance payment needed for order {{ order.name }}$t$, $t${% assign accent = shop.accent_color | default: "#111827" %}<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>One more step to confirm your order</title>
</head>
<body style="margin:0;padding:0;background:#f4f5f7;">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#f4f5f7;">
<tr><td align="center" style="padding:32px 12px;">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="max-width:560px;background:#ffffff;border-radius:12px;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif;color:#111827;">
<tr><td style="padding:28px 32px 0;">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0"><tr>
<td>{% if shop.logo_url %}<img src="{{ shop.logo_url }}" alt="{{ shop.name }}" height="36" style="display:block;height:36px;max-width:180px;border:0;">{% else %}<span style="font-size:20px;font-weight:700;color:#111827;">{{ shop.name }}</span>{% endif %}</td>
<td align="right" style="font-size:13px;color:#6b7280;">Order {{ order.name }}</td>
</tr></table>
</td></tr>
<tr><td style="padding:24px 32px 4px;">
<h1 style="margin:0 0 12px;font-size:22px;line-height:1.3;color:#111827;">One more step to confirm your order</h1>
<p style="margin:0 0 12px;font-size:15px;line-height:1.6;color:#374151;">Hi {{ customer.first_name | default: "there" }}, to confirm order {{ order.name }} please pay an advance of <strong>{{ order.advance_amount | money }}</strong>. The rest is paid on delivery.</p>
</td></tr>
{% if order.status_url %}<tr><td style="padding:12px 32px 4px;">
<a href="{{ order.status_url }}" style="display:inline-block;background:{{ accent }};color:#ffffff;text-decoration:none;font-size:15px;font-weight:600;padding:12px 22px;border-radius:8px;">Pay the advance</a>
</td></tr>{% endif %}
<tr><td style="padding:8px 32px 0;">
<p style="margin:0 0 8px;font-size:13px;font-weight:600;text-transform:uppercase;letter-spacing:0.04em;color:#6b7280;">Order summary</p>
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="border-top:1px solid #e5e7eb;">
{% for item in order.line_items %}<tr>
<td width="56" style="padding:12px 12px 12px 0;border-bottom:1px solid #f3f4f6;vertical-align:top;">{% if item.image_url %}<img src="{{ item.image_url }}" alt="" width="48" height="48" style="display:block;width:48px;height:48px;border-radius:8px;object-fit:cover;border:1px solid #e5e7eb;">{% endif %}</td>
<td style="padding:12px 0;border-bottom:1px solid #f3f4f6;font-size:14px;line-height:1.4;color:#111827;vertical-align:top;">{{ item.title }}{% if item.variant_title %}<br><span style="color:#6b7280;font-size:13px;">{{ item.variant_title }}</span>{% endif %}<br><span style="color:#6b7280;font-size:13px;">Qty {{ item.quantity }}</span></td>
<td align="right" style="padding:12px 0;border-bottom:1px solid #f3f4f6;font-size:14px;color:#111827;vertical-align:top;white-space:nowrap;">{{ item.line_price | money }}</td>
</tr>{% endfor %}
</table>
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="margin-top:8px;">
<tr><td style="padding:6px 0;font-size:14px;color:#374151;">Subtotal</td><td align="right" style="padding:6px 0;font-size:14px;color:#374151;">{{ order.subtotal_price | money }}</td></tr>
{% if order.discount_price > 0 %}<tr><td style="padding:6px 0;font-size:14px;color:#374151;">Discount</td><td align="right" style="padding:6px 0;font-size:14px;color:#374151;">-{{ order.discount_price | money }}</td></tr>{% endif %}
<tr><td style="padding:6px 0;font-size:14px;color:#374151;">Delivery</td><td align="right" style="padding:6px 0;font-size:14px;color:#374151;">{{ order.delivery_price | money }}</td></tr>
<tr><td style="padding:10px 0 6px;font-size:16px;font-weight:700;color:#111827;border-top:1px solid #e5e7eb;">Total</td><td align="right" style="padding:10px 0 6px;font-size:16px;font-weight:700;color:#111827;border-top:1px solid #e5e7eb;">{{ order.total_price | money }}</td></tr>
{% if order.paid_amount > 0 %}<tr><td style="padding:6px 0;font-size:14px;color:#374151;">Paid</td><td align="right" style="padding:6px 0;font-size:14px;color:#374151;">{{ order.paid_amount | money }}</td></tr>{% endif %}
{% if order.cod_amount > 0 %}<tr><td style="padding:6px 0;font-size:14px;color:#374151;"><strong>To pay on delivery</strong></td><td align="right" style="padding:6px 0;font-size:14px;color:#374151;"><strong>{{ order.cod_amount | money }}</strong></td></tr>{% endif %}
</table>
</td></tr>
{% if order.shipping_address.address %}<tr><td style="padding:20px 32px 0;">
<p style="margin:0 0 6px;font-size:13px;font-weight:600;text-transform:uppercase;letter-spacing:0.04em;color:#6b7280;">Delivery address</p>
<p style="margin:0;font-size:14px;line-height:1.6;color:#374151;">{{ order.shipping_address.name }}<br>{{ order.shipping_address.address }}{% if order.shipping_address.area %}, {{ order.shipping_address.area }}{% endif %}{% if order.shipping_address.district %}, {{ order.shipping_address.district }}{% endif %}<br>{{ order.shipping_address.phone }}</p>
</td></tr>{% endif %}
<tr><td style="padding:28px 32px 28px;">
<p style="margin:0;padding-top:20px;border-top:1px solid #e5e7eb;font-size:13px;line-height:1.6;color:#6b7280;">{{ shop.name }}{% if shop.phone %} · {{ shop.phone }}{% endif %}{% if shop.email %} · {{ shop.email }}{% endif %}{% if shop.address %}<br>{{ shop.address }}{% endif %}</p>
</td></tr>
</table>
</td></tr>
</table>
</body>
</html>$t$),
  ('EMAIL', 'PAYMENT_RECEIVED', $t$Payment received for order {{ order.name }}$t$, $t${% assign accent = shop.accent_color | default: "#111827" %}<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>We received your payment</title>
</head>
<body style="margin:0;padding:0;background:#f4f5f7;">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#f4f5f7;">
<tr><td align="center" style="padding:32px 12px;">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="max-width:560px;background:#ffffff;border-radius:12px;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif;color:#111827;">
<tr><td style="padding:28px 32px 0;">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0"><tr>
<td>{% if shop.logo_url %}<img src="{{ shop.logo_url }}" alt="{{ shop.name }}" height="36" style="display:block;height:36px;max-width:180px;border:0;">{% else %}<span style="font-size:20px;font-weight:700;color:#111827;">{{ shop.name }}</span>{% endif %}</td>
<td align="right" style="font-size:13px;color:#6b7280;">Order {{ order.name }}</td>
</tr></table>
</td></tr>
<tr><td style="padding:24px 32px 4px;">
<h1 style="margin:0 0 12px;font-size:22px;line-height:1.3;color:#111827;">We received your payment</h1>
<p style="margin:0 0 12px;font-size:15px;line-height:1.6;color:#374151;">Hi {{ customer.first_name | default: "there" }}, we received <strong>{{ payment.amount | money }}</strong> for order {{ order.name }}. Thank you!</p>
{% if order.due_amount > 0 %}<p style="margin:0 0 12px;font-size:15px;line-height:1.6;color:#374151;">Still to pay on delivery: <strong>{{ order.due_amount | money }}</strong>.</p>{% endif %}
</td></tr>

<tr><td style="padding:8px 32px 0;">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="border-top:1px solid #e5e7eb;">
<tr><td style="padding:6px 0;font-size:14px;color:#374151;">Order</td><td align="right" style="padding:6px 0;font-size:14px;color:#374151;">{{ order.name }}</td></tr>
<tr><td style="padding:6px 0;font-size:14px;color:#374151;">Items</td><td align="right" style="padding:6px 0;font-size:14px;color:#374151;">{{ order.item_count }}</td></tr>
<tr><td style="padding:6px 0;font-size:14px;color:#374151;">Total</td><td align="right" style="padding:6px 0;font-size:14px;color:#374151;">{{ order.total_price | money }}</td></tr>
{% if order.cod_amount > 0 %}<tr><td style="padding:6px 0;font-size:14px;color:#374151;">To pay on delivery</td><td align="right" style="padding:6px 0;font-size:14px;color:#374151;">{{ order.cod_amount | money }}</td></tr>{% endif %}
</table>
</td></tr>
<tr><td style="padding:28px 32px 28px;">
<p style="margin:0;padding-top:20px;border-top:1px solid #e5e7eb;font-size:13px;line-height:1.6;color:#6b7280;">{{ shop.name }}{% if shop.phone %} · {{ shop.phone }}{% endif %}{% if shop.email %} · {{ shop.email }}{% endif %}{% if shop.address %}<br>{{ shop.address }}{% endif %}</p>
</td></tr>
</table>
</td></tr>
</table>
</body>
</html>$t$),
  ('EMAIL', 'PAYMENT_FAILED', $t$Payment for order {{ order.name }} did not go through$t$, $t${% assign accent = shop.accent_color | default: "#111827" %}<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Your payment didn't go through</title>
</head>
<body style="margin:0;padding:0;background:#f4f5f7;">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#f4f5f7;">
<tr><td align="center" style="padding:32px 12px;">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="max-width:560px;background:#ffffff;border-radius:12px;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif;color:#111827;">
<tr><td style="padding:28px 32px 0;">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0"><tr>
<td>{% if shop.logo_url %}<img src="{{ shop.logo_url }}" alt="{{ shop.name }}" height="36" style="display:block;height:36px;max-width:180px;border:0;">{% else %}<span style="font-size:20px;font-weight:700;color:#111827;">{{ shop.name }}</span>{% endif %}</td>
<td align="right" style="font-size:13px;color:#6b7280;">Order {{ order.name }}</td>
</tr></table>
</td></tr>
<tr><td style="padding:24px 32px 4px;">
<h1 style="margin:0 0 12px;font-size:22px;line-height:1.3;color:#111827;">Your payment didn't go through</h1>
<p style="margin:0 0 12px;font-size:15px;line-height:1.6;color:#374151;">Hi {{ customer.first_name | default: "there" }}, your payment of <strong>{{ payment.amount | money }}</strong> for order {{ order.name }} did not go through. No money was taken. You can try again below.</p>
</td></tr>
{% if order.status_url %}<tr><td style="padding:12px 32px 4px;">
<a href="{{ order.status_url }}" style="display:inline-block;background:{{ accent }};color:#ffffff;text-decoration:none;font-size:15px;font-weight:600;padding:12px 22px;border-radius:8px;">Try again</a>
</td></tr>{% endif %}
<tr><td style="padding:8px 32px 0;">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="border-top:1px solid #e5e7eb;">
<tr><td style="padding:6px 0;font-size:14px;color:#374151;">Order</td><td align="right" style="padding:6px 0;font-size:14px;color:#374151;">{{ order.name }}</td></tr>
<tr><td style="padding:6px 0;font-size:14px;color:#374151;">Items</td><td align="right" style="padding:6px 0;font-size:14px;color:#374151;">{{ order.item_count }}</td></tr>
<tr><td style="padding:6px 0;font-size:14px;color:#374151;">Total</td><td align="right" style="padding:6px 0;font-size:14px;color:#374151;">{{ order.total_price | money }}</td></tr>
{% if order.cod_amount > 0 %}<tr><td style="padding:6px 0;font-size:14px;color:#374151;">To pay on delivery</td><td align="right" style="padding:6px 0;font-size:14px;color:#374151;">{{ order.cod_amount | money }}</td></tr>{% endif %}
</table>
</td></tr>
<tr><td style="padding:28px 32px 28px;">
<p style="margin:0;padding-top:20px;border-top:1px solid #e5e7eb;font-size:13px;line-height:1.6;color:#6b7280;">{{ shop.name }}{% if shop.phone %} · {{ shop.phone }}{% endif %}{% if shop.email %} · {{ shop.email }}{% endif %}{% if shop.address %}<br>{{ shop.address }}{% endif %}</p>
</td></tr>
</table>
</td></tr>
</table>
</body>
</html>$t$),
  ('EMAIL', 'ORDER_SHIPPED', $t$Order {{ order.name }} is on the way$t$, $t${% assign accent = shop.accent_color | default: "#111827" %}<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Your order is on the way</title>
</head>
<body style="margin:0;padding:0;background:#f4f5f7;">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#f4f5f7;">
<tr><td align="center" style="padding:32px 12px;">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="max-width:560px;background:#ffffff;border-radius:12px;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif;color:#111827;">
<tr><td style="padding:28px 32px 0;">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0"><tr>
<td>{% if shop.logo_url %}<img src="{{ shop.logo_url }}" alt="{{ shop.name }}" height="36" style="display:block;height:36px;max-width:180px;border:0;">{% else %}<span style="font-size:20px;font-weight:700;color:#111827;">{{ shop.name }}</span>{% endif %}</td>
<td align="right" style="font-size:13px;color:#6b7280;">Order {{ order.name }}</td>
</tr></table>
</td></tr>
<tr><td style="padding:24px 32px 4px;">
<h1 style="margin:0 0 12px;font-size:22px;line-height:1.3;color:#111827;">Your order is on the way</h1>
<p style="margin:0 0 12px;font-size:15px;line-height:1.6;color:#374151;">Hi {{ customer.first_name | default: "there" }}, your order {{ order.name }} has been handed to {{ shipment.courier | default: "the courier" }}.</p>
{% if shipment.tracking_number %}<p style="margin:0 0 12px;font-size:15px;line-height:1.6;color:#374151;">Tracking number: <strong>{{ shipment.tracking_number }}</strong></p>{% endif %}
{% if order.cod_amount > 0 %}<p style="margin:0 0 12px;font-size:15px;line-height:1.6;color:#374151;">Please keep <strong>{{ order.cod_amount | money }}</strong> ready to pay on delivery.</p>{% endif %}
</td></tr>
{% if shipment.tracking_url or order.status_url %}<tr><td style="padding:12px 32px 4px;">
<a href="{{ shipment.tracking_url | default: order.status_url }}" style="display:inline-block;background:{{ accent }};color:#ffffff;text-decoration:none;font-size:15px;font-weight:600;padding:12px 22px;border-radius:8px;">Track your parcel</a>
</td></tr>{% endif %}
<tr><td style="padding:8px 32px 0;">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="border-top:1px solid #e5e7eb;">
<tr><td style="padding:6px 0;font-size:14px;color:#374151;">Order</td><td align="right" style="padding:6px 0;font-size:14px;color:#374151;">{{ order.name }}</td></tr>
<tr><td style="padding:6px 0;font-size:14px;color:#374151;">Items</td><td align="right" style="padding:6px 0;font-size:14px;color:#374151;">{{ order.item_count }}</td></tr>
<tr><td style="padding:6px 0;font-size:14px;color:#374151;">Total</td><td align="right" style="padding:6px 0;font-size:14px;color:#374151;">{{ order.total_price | money }}</td></tr>
{% if order.cod_amount > 0 %}<tr><td style="padding:6px 0;font-size:14px;color:#374151;">To pay on delivery</td><td align="right" style="padding:6px 0;font-size:14px;color:#374151;">{{ order.cod_amount | money }}</td></tr>{% endif %}
</table>
</td></tr>
<tr><td style="padding:28px 32px 28px;">
<p style="margin:0;padding-top:20px;border-top:1px solid #e5e7eb;font-size:13px;line-height:1.6;color:#6b7280;">{{ shop.name }}{% if shop.phone %} · {{ shop.phone }}{% endif %}{% if shop.email %} · {{ shop.email }}{% endif %}{% if shop.address %}<br>{{ shop.address }}{% endif %}</p>
</td></tr>
</table>
</td></tr>
</table>
</body>
</html>$t$),
  ('EMAIL', 'OUT_FOR_DELIVERY', $t$Order {{ order.name }} is out for delivery$t$, $t${% assign accent = shop.accent_color | default: "#111827" %}<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Your order arrives today</title>
</head>
<body style="margin:0;padding:0;background:#f4f5f7;">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#f4f5f7;">
<tr><td align="center" style="padding:32px 12px;">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="max-width:560px;background:#ffffff;border-radius:12px;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif;color:#111827;">
<tr><td style="padding:28px 32px 0;">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0"><tr>
<td>{% if shop.logo_url %}<img src="{{ shop.logo_url }}" alt="{{ shop.name }}" height="36" style="display:block;height:36px;max-width:180px;border:0;">{% else %}<span style="font-size:20px;font-weight:700;color:#111827;">{{ shop.name }}</span>{% endif %}</td>
<td align="right" style="font-size:13px;color:#6b7280;">Order {{ order.name }}</td>
</tr></table>
</td></tr>
<tr><td style="padding:24px 32px 4px;">
<h1 style="margin:0 0 12px;font-size:22px;line-height:1.3;color:#111827;">Your order arrives today</h1>
<p style="margin:0 0 12px;font-size:15px;line-height:1.6;color:#374151;">Hi {{ customer.first_name | default: "there" }}, your order {{ order.name }} is out for delivery today{% if shipment.courier %} with {{ shipment.courier }}{% endif %}.</p>
{% if order.cod_amount > 0 %}<p style="margin:0 0 12px;font-size:15px;line-height:1.6;color:#374151;">Please keep <strong>{{ order.cod_amount | money }}</strong> ready for the delivery person.</p>{% endif %}
</td></tr>
{% if shipment.tracking_url or order.status_url %}<tr><td style="padding:12px 32px 4px;">
<a href="{{ shipment.tracking_url | default: order.status_url }}" style="display:inline-block;background:{{ accent }};color:#ffffff;text-decoration:none;font-size:15px;font-weight:600;padding:12px 22px;border-radius:8px;">Track your parcel</a>
</td></tr>{% endif %}

<tr><td style="padding:28px 32px 28px;">
<p style="margin:0;padding-top:20px;border-top:1px solid #e5e7eb;font-size:13px;line-height:1.6;color:#6b7280;">{{ shop.name }}{% if shop.phone %} · {{ shop.phone }}{% endif %}{% if shop.email %} · {{ shop.email }}{% endif %}{% if shop.address %}<br>{{ shop.address }}{% endif %}</p>
</td></tr>
</table>
</td></tr>
</table>
</body>
</html>$t$),
  ('EMAIL', 'ORDER_DELIVERED', $t$Order {{ order.name }} delivered$t$, $t${% assign accent = shop.accent_color | default: "#111827" %}<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Your order was delivered</title>
</head>
<body style="margin:0;padding:0;background:#f4f5f7;">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#f4f5f7;">
<tr><td align="center" style="padding:32px 12px;">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="max-width:560px;background:#ffffff;border-radius:12px;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif;color:#111827;">
<tr><td style="padding:28px 32px 0;">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0"><tr>
<td>{% if shop.logo_url %}<img src="{{ shop.logo_url }}" alt="{{ shop.name }}" height="36" style="display:block;height:36px;max-width:180px;border:0;">{% else %}<span style="font-size:20px;font-weight:700;color:#111827;">{{ shop.name }}</span>{% endif %}</td>
<td align="right" style="font-size:13px;color:#6b7280;">Order {{ order.name }}</td>
</tr></table>
</td></tr>
<tr><td style="padding:24px 32px 4px;">
<h1 style="margin:0 0 12px;font-size:22px;line-height:1.3;color:#111827;">Your order was delivered</h1>
<p style="margin:0 0 12px;font-size:15px;line-height:1.6;color:#374151;">Hi {{ customer.first_name | default: "there" }}, your order {{ order.name }} was delivered. We hope you love it!</p>
<p style="margin:0 0 12px;font-size:15px;line-height:1.6;color:#374151;">If anything is not right, just reply to this email{% if shop.phone %} or call us at {{ shop.phone }}{% endif %}.</p>
</td></tr>

<tr><td style="padding:8px 32px 0;">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="border-top:1px solid #e5e7eb;">
<tr><td style="padding:6px 0;font-size:14px;color:#374151;">Order</td><td align="right" style="padding:6px 0;font-size:14px;color:#374151;">{{ order.name }}</td></tr>
<tr><td style="padding:6px 0;font-size:14px;color:#374151;">Items</td><td align="right" style="padding:6px 0;font-size:14px;color:#374151;">{{ order.item_count }}</td></tr>
<tr><td style="padding:6px 0;font-size:14px;color:#374151;">Total</td><td align="right" style="padding:6px 0;font-size:14px;color:#374151;">{{ order.total_price | money }}</td></tr>
{% if order.cod_amount > 0 %}<tr><td style="padding:6px 0;font-size:14px;color:#374151;">To pay on delivery</td><td align="right" style="padding:6px 0;font-size:14px;color:#374151;">{{ order.cod_amount | money }}</td></tr>{% endif %}
</table>
</td></tr>
<tr><td style="padding:28px 32px 28px;">
<p style="margin:0;padding-top:20px;border-top:1px solid #e5e7eb;font-size:13px;line-height:1.6;color:#6b7280;">{{ shop.name }}{% if shop.phone %} · {{ shop.phone }}{% endif %}{% if shop.email %} · {{ shop.email }}{% endif %}{% if shop.address %}<br>{{ shop.address }}{% endif %}</p>
</td></tr>
</table>
</td></tr>
</table>
</body>
</html>$t$),
  ('EMAIL', 'ORDER_CANCELLED', $t$Order {{ order.name }} cancelled$t$, $t${% assign accent = shop.accent_color | default: "#111827" %}<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Your order was cancelled</title>
</head>
<body style="margin:0;padding:0;background:#f4f5f7;">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#f4f5f7;">
<tr><td align="center" style="padding:32px 12px;">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="max-width:560px;background:#ffffff;border-radius:12px;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif;color:#111827;">
<tr><td style="padding:28px 32px 0;">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0"><tr>
<td>{% if shop.logo_url %}<img src="{{ shop.logo_url }}" alt="{{ shop.name }}" height="36" style="display:block;height:36px;max-width:180px;border:0;">{% else %}<span style="font-size:20px;font-weight:700;color:#111827;">{{ shop.name }}</span>{% endif %}</td>
<td align="right" style="font-size:13px;color:#6b7280;">Order {{ order.name }}</td>
</tr></table>
</td></tr>
<tr><td style="padding:24px 32px 4px;">
<h1 style="margin:0 0 12px;font-size:22px;line-height:1.3;color:#111827;">Your order was cancelled</h1>
<p style="margin:0 0 12px;font-size:15px;line-height:1.6;color:#374151;">Hi {{ customer.first_name | default: "there" }}, your order {{ order.name }} has been cancelled.</p>
{% if order.paid_amount > 0 %}<p style="margin:0 0 12px;font-size:15px;line-height:1.6;color:#374151;">You paid {{ order.paid_amount | money }} for this order. We will contact you about the refund.</p>{% endif %}
<p style="margin:0 0 12px;font-size:15px;line-height:1.6;color:#374151;">Questions? Reply to this email{% if shop.phone %} or call us at {{ shop.phone }}{% endif %}.</p>
</td></tr>

<tr><td style="padding:8px 32px 0;">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="border-top:1px solid #e5e7eb;">
<tr><td style="padding:6px 0;font-size:14px;color:#374151;">Order</td><td align="right" style="padding:6px 0;font-size:14px;color:#374151;">{{ order.name }}</td></tr>
<tr><td style="padding:6px 0;font-size:14px;color:#374151;">Items</td><td align="right" style="padding:6px 0;font-size:14px;color:#374151;">{{ order.item_count }}</td></tr>
<tr><td style="padding:6px 0;font-size:14px;color:#374151;">Total</td><td align="right" style="padding:6px 0;font-size:14px;color:#374151;">{{ order.total_price | money }}</td></tr>
{% if order.cod_amount > 0 %}<tr><td style="padding:6px 0;font-size:14px;color:#374151;">To pay on delivery</td><td align="right" style="padding:6px 0;font-size:14px;color:#374151;">{{ order.cod_amount | money }}</td></tr>{% endif %}
</table>
</td></tr>
<tr><td style="padding:28px 32px 28px;">
<p style="margin:0;padding-top:20px;border-top:1px solid #e5e7eb;font-size:13px;line-height:1.6;color:#6b7280;">{{ shop.name }}{% if shop.phone %} · {{ shop.phone }}{% endif %}{% if shop.email %} · {{ shop.email }}{% endif %}{% if shop.address %}<br>{{ shop.address }}{% endif %}</p>
</td></tr>
</table>
</td></tr>
</table>
</body>
</html>$t$),
  ('EMAIL', 'RETURN_INITIATED', $t$Order {{ order.name }} is being returned$t$, $t${% assign accent = shop.accent_color | default: "#111827" %}<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Your order is being returned</title>
</head>
<body style="margin:0;padding:0;background:#f4f5f7;">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#f4f5f7;">
<tr><td align="center" style="padding:32px 12px;">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="max-width:560px;background:#ffffff;border-radius:12px;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif;color:#111827;">
<tr><td style="padding:28px 32px 0;">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0"><tr>
<td>{% if shop.logo_url %}<img src="{{ shop.logo_url }}" alt="{{ shop.name }}" height="36" style="display:block;height:36px;max-width:180px;border:0;">{% else %}<span style="font-size:20px;font-weight:700;color:#111827;">{{ shop.name }}</span>{% endif %}</td>
<td align="right" style="font-size:13px;color:#6b7280;">Order {{ order.name }}</td>
</tr></table>
</td></tr>
<tr><td style="padding:24px 32px 4px;">
<h1 style="margin:0 0 12px;font-size:22px;line-height:1.3;color:#111827;">Your order is being returned</h1>
<p style="margin:0 0 12px;font-size:15px;line-height:1.6;color:#374151;">Hi {{ customer.first_name | default: "there" }}, the parcel for order {{ order.name }} is on its way back to us.</p>
<p style="margin:0 0 12px;font-size:15px;line-height:1.6;color:#374151;">Questions? Reply to this email{% if shop.phone %} or call us at {{ shop.phone }}{% endif %}.</p>
</td></tr>


<tr><td style="padding:28px 32px 28px;">
<p style="margin:0;padding-top:20px;border-top:1px solid #e5e7eb;font-size:13px;line-height:1.6;color:#6b7280;">{{ shop.name }}{% if shop.phone %} · {{ shop.phone }}{% endif %}{% if shop.email %} · {{ shop.email }}{% endif %}{% if shop.address %}<br>{{ shop.address }}{% endif %}</p>
</td></tr>
</table>
</td></tr>
</table>
</body>
</html>$t$),
  ('EMAIL', 'ORDER_RETURNED', $t$Return received for order {{ order.name }}$t$, $t${% assign accent = shop.accent_color | default: "#111827" %}<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>We received your return</title>
</head>
<body style="margin:0;padding:0;background:#f4f5f7;">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#f4f5f7;">
<tr><td align="center" style="padding:32px 12px;">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="max-width:560px;background:#ffffff;border-radius:12px;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif;color:#111827;">
<tr><td style="padding:28px 32px 0;">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0"><tr>
<td>{% if shop.logo_url %}<img src="{{ shop.logo_url }}" alt="{{ shop.name }}" height="36" style="display:block;height:36px;max-width:180px;border:0;">{% else %}<span style="font-size:20px;font-weight:700;color:#111827;">{{ shop.name }}</span>{% endif %}</td>
<td align="right" style="font-size:13px;color:#6b7280;">Order {{ order.name }}</td>
</tr></table>
</td></tr>
<tr><td style="padding:24px 32px 4px;">
<h1 style="margin:0 0 12px;font-size:22px;line-height:1.3;color:#111827;">We received your return</h1>
<p style="margin:0 0 12px;font-size:15px;line-height:1.6;color:#374151;">Hi {{ customer.first_name | default: "there" }}, the returned parcel for order {{ order.name }} has reached us.</p>
{% if order.paid_amount > 0 %}<p style="margin:0 0 12px;font-size:15px;line-height:1.6;color:#374151;">We will contact you about your payment of {{ order.paid_amount | money }}.</p>{% endif %}
</td></tr>


<tr><td style="padding:28px 32px 28px;">
<p style="margin:0;padding-top:20px;border-top:1px solid #e5e7eb;font-size:13px;line-height:1.6;color:#6b7280;">{{ shop.name }}{% if shop.phone %} · {{ shop.phone }}{% endif %}{% if shop.email %} · {{ shop.email }}{% endif %}{% if shop.address %}<br>{{ shop.address }}{% endif %}</p>
</td></tr>
</table>
</td></tr>
</table>
</body>
</html>$t$),
  ('WHATSAPP', 'ORDER_CREATED', null, $t$Hi {{customer_first_name}}, thank you for your order {{order_number}} of {{total}}. We will call you shortly to confirm it.

Thank you for shopping with {{store_name}} today.$t$),
  ('WHATSAPP', 'ORDER_CONFIRMED', null, $t$Hi {{customer_first_name}}, your order {{order_number}} is confirmed and we are getting it ready. Amount to pay on delivery: {{cod_amount}}.

Thank you, the {{store_name}} team$t$),
  ('WHATSAPP', 'PRE_ORDER_CONFIRMED', null, $t$Hi {{customer_first_name}}, your pre-order {{order_number}} is confirmed. We will ship it as soon as it arrives in stock.

Thank you, the {{store_name}} team$t$),
  ('WHATSAPP', 'ADVANCE_REQUIRED', null, $t$Hi {{customer_first_name}}, to confirm order {{order_number}} please pay an advance of {{advance_amount}} here: {{track_order_url}} and we will ship it right away.

Thank you, the {{store_name}} team$t$),
  ('WHATSAPP', 'PAYMENT_RECEIVED', null, $t$Hi {{customer_first_name}}, we received your payment of {{payment_amount}} for order {{order_number}}. Thank you!

The {{store_name}} team$t$),
  ('WHATSAPP', 'PAYMENT_FAILED', null, $t$Hi {{customer_first_name}}, your payment of {{payment_amount}} for order {{order_number}} did not go through. You can try again here: {{track_order_url}} at any time.

The {{store_name}} team$t$),
  ('WHATSAPP', 'ORDER_SHIPPED', null, $t$Hi {{customer_first_name}}, your order {{order_number}} has been handed to {{courier_name}}. Tracking number: {{tracking_number}}. Track it here: {{tracking_url}} anytime.

The {{store_name}} team$t$),
  ('WHATSAPP', 'OUT_FOR_DELIVERY', null, $t$Hi {{customer_first_name}}, your order {{order_number}} is out for delivery today. Please keep {{cod_amount}} ready for the delivery person.

The {{store_name}} team$t$),
  ('WHATSAPP', 'ORDER_DELIVERED', null, $t$Hi {{customer_first_name}}, your order {{order_number}} was delivered. We hope you love it! Reply here if anything is not right.

The {{store_name}} team$t$),
  ('WHATSAPP', 'ORDER_CANCELLED', null, $t$Hi {{customer_first_name}}, your order {{order_number}} has been cancelled. Questions? Call us at {{store_phone}} or reply here.

The {{store_name}} team$t$),
  ('WHATSAPP', 'RETURN_INITIATED', null, $t$Hi {{customer_first_name}}, the parcel for order {{order_number}} is on its way back to us. Questions? Call us at {{store_phone}} or reply here.

The {{store_name}} team$t$),
  ('WHATSAPP', 'ORDER_RETURNED', null, $t$Hi {{customer_first_name}}, the returned parcel for order {{order_number}} has reached us. We will be in touch soon.

The {{store_name}} team$t$)
on conflict (channel, event) do update set subject = excluded.subject, template = excluded.template;

-- ---------------------------------------------------------------- templates
alter table public.notifications drop constraint if exists notifications_template_length;
alter table public.notifications add constraint notifications_template_length check (
  case channel when 'EMAIL' then length(template) between 1 and 200000
               when 'WHATSAPP' then length(template) between 1 and 1024
               else length(template) between 1 and 1000 end);
alter table public.notifications drop constraint if exists notifications_subject_length;
alter table public.notifications add constraint notifications_subject_length check (subject is null or length(subject) <= 300);

alter table public.notifications
  -- The WhatsApp template at Meta: its name and language, Meta's review, and the text it was
  -- submitted with ({{name}} placeholders, in the order of Meta's {{1}}, {{2}} … in wa_params).
  add column if not exists wa_name text check (wa_name ~ '^[a-z0-9_]+$' and length(wa_name) <= 512),
  add column if not exists wa_language text check (wa_language in ('en', 'bn')),
  add column if not exists wa_status text check (length(wa_status) <= 40),
  add column if not exists wa_reason text check (length(wa_reason) <= 500),
  add column if not exists wa_template_id text check (wa_template_id ~ '^[0-9]{1,40}$'),
  add column if not exists wa_params jsonb check (wa_params is null or jsonb_typeof(wa_params) = 'array'),
  add column if not exists wa_body text check (length(wa_body) <= 1024),
  add column if not exists wa_version int not null default 0,
  add column if not exists wa_checked_at timestamptz;

alter table public.notification_logs
  add column if not exists data jsonb check (data is null or jsonb_typeof(data) = 'object');

-- The emails and WhatsApp texts every store had were the SMS wording (plain text, ending with the
-- store name, which Meta does not accept). Nobody had changed or switched them on: they become the
-- new defaults.
do $$
declare m record;
begin
  for m in select id from public.merchants loop
    perform set_config('app.merchant_id', m.id::text, true);
    perform public._seed_notification_permissions(m.id);
    update public.notifications n set template = d.template, subject = d.subject
    from public.notification_defaults d
    where n.merchant_id = m.id and n.channel = 'EMAIL' and d.channel = 'EMAIL' and d.event = n.event
      and n.template !~* '<[a-z!]';
    update public.notifications n set template = d.template
    from public.notification_defaults d
    where n.merchant_id = m.id and n.channel = 'WHATSAPP' and d.channel = 'WHATSAPP' and d.event = n.event
      and n.template ~ '\{\{store_name\}\}\s*$';
  end loop;
  perform set_config('app.merchant_id', '', true);
end $$;

-- A new store's emails and WhatsApp texts start from these designs too (its notifications are
-- seeded with the old wording).
create or replace function public._notifications_use_defaults()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  d public.notification_defaults;
begin
  if new.channel = 'EMAIL' and new.template !~* '<[a-z!]'
     or new.channel = 'WHATSAPP' and new.template ~ '\{\{store_name\}\}\s*$' then
    select * into d from public.notification_defaults where channel = new.channel and event = new.event;
    if found then
      new.template := d.template;
      if new.channel = 'EMAIL' then
        new.subject := d.subject;
      end if;
    end if;
  end if;
  return new;
end;
$$;
drop trigger if exists notifications_use_defaults on public.notifications;
create trigger notifications_use_defaults before insert on public.notifications
  for each row execute function public._notifications_use_defaults();

-- ---------------------------------------------------------------- access
-- Messages change only through the functions below, which check the text and keep Meta's review
-- (wa_status, wa_body …) as Meta reported it. Nothing in the app writes the table directly any more.
drop policy if exists notifications_manage on public.notifications;
drop policy if exists notifications_read on public.notifications;
create policy notifications_read on public.notifications for select to authenticated
  using ((select public.has_permission('settings.view'))
         or (channel = 'SMS' and (select public.has_permission('sms.view')))
         or (channel in ('EMAIL', 'WHATSAPP') and (select public.has_permission('notifications.view'))));
drop policy if exists notification_logs_read on public.notification_logs;
create policy notification_logs_read on public.notification_logs for select to authenticated
  using ((select public.has_permission('orders.view')) or (select public.has_permission('settings.view'))
         or (channel = 'SMS' and (select public.has_permission('sms.view')))
         or (channel in ('EMAIL', 'WHATSAPP') and (select public.has_permission('notifications.view'))));

-- ---------------------------------------------------------------- platform email service
insert into public.platform_settings (key, value, description)
values ('email_service', '{"enabled": false, "from_email": "", "from_name": "", "daily_limit": 300}'::jsonb,
        'Fullfilio email service (Resend): sender address and the daily limit per store. The API key lives in Vault (email.resend).')
on conflict (key) do nothing;

/** Fullfilio's email service (platform tables, no store data): sender, daily limit and whether it is set up. */
create or replace function public._platform_email_service()
returns jsonb
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  select jsonb_build_object(
    'from_email', coalesce(s.value ->> 'from_email', ''),
    'from_name', coalesce(s.value ->> 'from_name', ''),
    'daily_limit', greatest(coalesce((s.value ->> 'daily_limit')::int, 300), 0),
    'ready', coalesce((s.value ->> 'enabled')::boolean, false) and coalesce(s.value ->> 'from_email', '') <> ''
             and exists (select 1 from public.platform_credentials where key = 'email.resend' and hint is not null))
  from (select (select value from public.platform_settings where key = 'email_service') as value) s
$$;

/** Fullfilio's email service is set up: switched on, a sender address and the API key saved. */
create or replace function public._email_service_ready()
returns boolean
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  select (public._platform_email_service() ->> 'ready')::boolean
$$;

create or replace function public._email_service_limit()
returns int
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  select (public._platform_email_service() ->> 'daily_limit')::int
$$;

insert into public.tenancy_exempt_functions (name, reason) values
  ('_platform_email_service', 'Reads the platform email service setting and whether its key is saved (platform tables, no merchant data)')
on conflict (name) do nothing;

-- ---------------------------------------------------------------- settings
/** The store's email settings, with defaults for what was never set. */
create or replace function public._email_settings()
returns jsonb
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  select jsonb_build_object(
    'enabled', false, 'provider', 'none', 'from_name', '', 'reply_to', '',
    'smtp', jsonb_build_object('host', '', 'port', 465, 'security', 'ssl', 'username', '', 'from_email', ''),
    'design', jsonb_build_object('logo_url', null, 'accent_color', '#111827')
  ) || coalesce(public.get_setting('notifications') -> 'channels' -> 'email', '{}'::jsonb)
    -- Before these modules the provider was "console" (log only): not set up.
    || case when coalesce(public.get_setting('notifications') #>> '{channels,email,provider}', '') in ('smtp', 'fullfilio') then '{}'::jsonb
            else '{"provider": "none", "enabled": false}'::jsonb end
$$;

create or replace function public._whatsapp_settings()
returns jsonb
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  select jsonb_build_object('enabled', false, 'provider', 'none', 'channel_id', null, 'language', 'en')
    || coalesce(public.get_setting('notifications') -> 'channels' -> 'whatsapp', '{}'::jsonb)
    || case when coalesce(public.get_setting('notifications') #>> '{channels,whatsapp,provider}', '') = 'meta' then '{}'::jsonb
            else '{"provider": "none", "enabled": false}'::jsonb end
$$;

/** Writes notifications.channels.<channel> (merging), keeping everything else in the setting. */
create or replace function public._notification_channel_put(p_channel text, p_value jsonb)
returns void
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v jsonb := coalesce(public.get_setting('notifications'), '{"enabled": true, "channels": {}}'::jsonb);
begin
  v := jsonb_set(v, array['channels'], coalesce(v -> 'channels', '{}'::jsonb), true);
  v := jsonb_set(v, array['channels', p_channel], coalesce(v -> 'channels' -> p_channel, '{}'::jsonb) || p_value, true);
  update public.settings set value = v, updated_at = now() where key = 'notifications';
  if not found then
    insert into public.settings (key, value, is_public, description)
    values ('notifications', v, false, 'Customer notification channels');
  end if;
end;
$$;

create or replace function public._email_ready(p_settings jsonb)
returns boolean
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  select case p_settings ->> 'provider'
    when 'smtp' then exists (select 1 from public.integration_credentials
                             where merchant_id = public.current_merchant_id() and key = 'email.smtp' and hint is not null)
    when 'fullfilio' then public._email_service_ready()
    else false end
$$;

/** Emails sent through Fullfilio's service today (Bangladesh time) by this store. */
create or replace function public._email_service_sent_today()
returns int
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  select count(*)::int from public.notification_logs
  where channel = 'EMAIL' and provider = 'fullfilio' and status in ('QUEUED', 'SENDING', 'SENT')
    and created_at >= (date_trunc('day', now() at time zone 'Asia/Dhaka') at time zone 'Asia/Dhaka')
$$;

create or replace function public.email_settings()
returns jsonb
language plpgsql
stable
security definer
set search_path = public, pg_temp
as $$
declare
  s jsonb := public._email_settings();
begin
  perform public.require_permission('notifications.view');
  return s || jsonb_build_object(
    'ready', public._email_ready(s),
    'smtp_saved', exists (select 1 from public.integration_credentials
                          where merchant_id = public.current_merchant_id() and key = 'email.smtp' and hint is not null),
    'service', jsonb_build_object(
      'available', public._email_service_ready(),
      'from_email', public._platform_email_service() ->> 'from_email',
      'daily_limit', public._email_service_limit(),
      'sent_today', public._email_service_sent_today()),
    'store', jsonb_build_object(
      'name', public.setting_text('store', array['name'], ''),
      'email', public.setting_text('store', array['email'], ''),
      'logo_url', public.setting_text('store', array['logo_url'], null)));
end;
$$;

/** What staff change on the Email page. The mailbox itself is connected through the messaging function. */
create or replace function public.email_settings_save(p jsonb)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  s jsonb := public._email_settings();
  v jsonb := '{}'::jsonb;
  v_design jsonb := coalesce(s -> 'design', '{}'::jsonb);
begin
  perform public.require_permission('notifications.manage');
  if p ? 'from_name' then
    if length(trim(coalesce(p ->> 'from_name', ''))) > 80 or coalesce(p ->> 'from_name', '') ~ '[<>"\r\n]' then
      raise exception 'VALIDATION: the sender name is up to 80 characters, without < > or quotes' using errcode = '22023';
    end if;
    v := v || jsonb_build_object('from_name', trim(coalesce(p ->> 'from_name', '')));
  end if;
  if p ? 'reply_to' then
    if coalesce(p ->> 'reply_to', '') <> '' and (p ->> 'reply_to') !~* '^[^\s@<>"]+@[^\s@<>"]+\.[a-z]{2,}$' then
      raise exception 'VALIDATION: the reply-to address is not an email address' using errcode = '22023';
    end if;
    v := v || jsonb_build_object('reply_to', lower(trim(coalesce(p ->> 'reply_to', ''))));
  end if;
  if p ? 'design' then
    if coalesce(p -> 'design' ->> 'logo_url', '') <> '' and ((p -> 'design' ->> 'logo_url') !~ '^https://[^\s"<>]+$' or length(p -> 'design' ->> 'logo_url') > 1000) then
      raise exception 'VALIDATION: the logo address must start with https://' using errcode = '22023';
    end if;
    if coalesce(p -> 'design' ->> 'accent_color', '#111827') !~* '^#[0-9a-f]{6}$' then
      raise exception 'VALIDATION: the colour is a hex code like #111827' using errcode = '22023';
    end if;
    v_design := v_design || jsonb_build_object(
      'logo_url', nullif(p -> 'design' ->> 'logo_url', ''),
      'accent_color', lower(coalesce(p -> 'design' ->> 'accent_color', '#111827')));
    v := v || jsonb_build_object('design', v_design);
  end if;
  if p ? 'provider' then
    if p ->> 'provider' not in ('smtp', 'fullfilio', 'none') then
      raise exception 'VALIDATION: choose your own mailbox or Fullfilio''s email service' using errcode = '22023';
    end if;
    if p ->> 'provider' = 'fullfilio' and not public._email_service_ready() then
      raise exception 'VALIDATION: Fullfilio''s email service is not available yet' using errcode = '22023';
    end if;
    if p ->> 'provider' = 'smtp' and not exists (select 1 from public.integration_credentials
        where merchant_id = public.current_merchant_id() and key = 'email.smtp' and hint is not null) then
      raise exception 'VALIDATION: connect your mailbox first' using errcode = '22023';
    end if;
    v := v || jsonb_build_object('provider', p ->> 'provider');
  end if;
  if p ? 'enabled' then
    if (p ->> 'enabled')::boolean and not public._email_ready(s || v) then
      raise exception 'VALIDATION: choose how emails are sent before switching them on' using errcode = '22023';
    end if;
    v := v || jsonb_build_object('enabled', (p ->> 'enabled')::boolean);
  end if;
  perform public._notification_channel_put('email', v);
  return public.email_settings();
end;
$$;

/** The messaging function, after a mailbox passed its test: keeps its (non-secret) details. */
create or replace function public._email_smtp_connected(p_smtp jsonb, p_actor uuid)
returns void
language plpgsql
security definer
set search_path = public, pg_temp
as $$
begin
  if not public.is_system_context() then
    raise exception 'PERMISSION_DENIED' using errcode = '42501';
  end if;
  perform public._notification_channel_put('email', jsonb_build_object(
    'provider', 'smtp',
    'smtp', jsonb_build_object(
      'host', p_smtp ->> 'host', 'port', (p_smtp ->> 'port')::int, 'security', p_smtp ->> 'security',
      'username', p_smtp ->> 'username', 'from_email', p_smtp ->> 'from_email'),
    'connected_at', now(), 'connected_by', p_actor));
end;
$$;

create or replace function public._email_smtp_disconnected()
returns void
language plpgsql
security definer
set search_path = public, pg_temp
as $$
begin
  if not public.is_system_context() then
    raise exception 'PERMISSION_DENIED' using errcode = '42501';
  end if;
  perform public._notification_channel_put('email', jsonb_build_object(
    'provider', case when public._email_settings() ->> 'provider' = 'smtp' then 'none' else public._email_settings() ->> 'provider' end,
    'enabled', case when public._email_settings() ->> 'provider' = 'smtp' then false else (public._email_settings() ->> 'enabled')::boolean end));
end;
$$;

create or replace function public.whatsapp_settings()
returns jsonb
language plpgsql
stable
security definer
set search_path = public, pg_temp
as $$
declare
  s jsonb := public._whatsapp_settings();
begin
  perform public.require_permission('notifications.view');
  return s || jsonb_build_object(
    'numbers', coalesce((select jsonb_agg(jsonb_build_object('id', c.id, 'name', c.name, 'display_phone', c.display_phone,
                                                             'waba_id', c.waba_id, 'status', c.status) order by c.created_at)
                         from public.inbox_channels c where c.platform = 'WHATSAPP'), '[]'::jsonb),
    'ready', exists (select 1 from public.inbox_channels c
                     where c.platform = 'WHATSAPP' and c.id::text = s ->> 'channel_id' and c.status <> 'DISCONNECTED' and c.waba_id is not null));
end;
$$;

create or replace function public.whatsapp_settings_save(p jsonb)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  s jsonb := public._whatsapp_settings();
  v jsonb := '{}'::jsonb;
begin
  perform public.require_permission('notifications.manage');
  if p ? 'channel_id' then
    if p ->> 'channel_id' is not null and not exists (
        select 1 from public.inbox_channels c where c.platform = 'WHATSAPP' and c.id::text = p ->> 'channel_id' and c.waba_id is not null) then
      raise exception 'VALIDATION: choose a WhatsApp number connected in Messaging → Channels' using errcode = '22023';
    end if;
    v := v || jsonb_build_object('channel_id', p ->> 'channel_id', 'provider', case when p ->> 'channel_id' is null then 'none' else 'meta' end);
  end if;
  if p ? 'language' then
    if p ->> 'language' not in ('en', 'bn') then
      raise exception 'VALIDATION: choose English or Bangla' using errcode = '22023';
    end if;
    v := v || jsonb_build_object('language', p ->> 'language');
  end if;
  if p ? 'enabled' then
    if (p ->> 'enabled')::boolean and coalesce((s || v) ->> 'channel_id', '') = '' then
      raise exception 'VALIDATION: choose the WhatsApp number that sends the messages first' using errcode = '22023';
    end if;
    v := v || jsonb_build_object('enabled', (p ->> 'enabled')::boolean);
  end if;
  perform public._notification_channel_put('whatsapp', v);
  return public.whatsapp_settings();
end;
$$;

-- ---------------------------------------------------------------- messages
create or replace function public.notification_message_save(p_id uuid, p_subject text, p_template text)
returns public.notifications
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_row public.notifications;
begin
  perform public.require_permission('notifications.manage');
  select * into v_row from public.notifications where id = p_id and channel in ('EMAIL', 'WHATSAPP');
  if not found then
    raise exception 'NOT_FOUND: message not found' using errcode = 'P0002';
  end if;
  if length(trim(coalesce(p_template, ''))) = 0 then
    raise exception 'VALIDATION: write the message' using errcode = '22023';
  end if;
  if v_row.channel = 'EMAIL' then
    if length(trim(coalesce(p_subject, ''))) = 0 or length(p_subject) > 300 then
      raise exception 'VALIDATION: write a subject of up to 300 characters' using errcode = '22023';
    end if;
    if length(p_template) > 200000 then
      raise exception 'VALIDATION: the email is longer than 200,000 characters' using errcode = '22023';
    end if;
  elsif length(trim(p_template)) > 1024 then
    raise exception 'VALIDATION: a WhatsApp message is up to 1024 characters' using errcode = '22023';
  end if;
  update public.notifications set
    subject = case when channel = 'EMAIL' then trim(p_subject) else subject end,
    template = case when channel = 'EMAIL' then p_template else trim(p_template) end
  where id = p_id
  returning * into v_row;
  return v_row;
end;
$$;

create or replace function public.notification_message_enable(p_id uuid, p_enabled boolean)
returns public.notifications
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_row public.notifications;
begin
  perform public.require_permission('notifications.manage');
  update public.notifications set is_enabled = coalesce(p_enabled, false)
  where id = p_id and channel in ('EMAIL', 'WHATSAPP')
  returning * into v_row;
  if not found then
    raise exception 'NOT_FOUND: message not found' using errcode = 'P0002';
  end if;
  return v_row;
end;
$$;

create or replace function public.notification_message_reset(p_id uuid)
returns public.notifications
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_row public.notifications;
begin
  perform public.require_permission('notifications.manage');
  update public.notifications n set template = d.template, subject = case when n.channel = 'EMAIL' then d.subject else n.subject end
  from public.notification_defaults d
  where n.id = p_id and d.channel = n.channel and d.event = n.event
  returning n.* into v_row;
  if not found then
    raise exception 'NOT_FOUND: message not found' using errcode = 'P0002';
  end if;
  return v_row;
end;
$$;

/** The messaging function records what Meta said about a WhatsApp template (submitted, approved, rejected …). */
create or replace function public._whatsapp_template_record(p_id uuid, p jsonb)
returns void
language plpgsql
security definer
set search_path = public, pg_temp
as $$
begin
  if not public.is_system_context() then
    raise exception 'PERMISSION_DENIED' using errcode = '42501';
  end if;
  update public.notifications set
    wa_name = case when p ? 'name' then p ->> 'name' else wa_name end,
    wa_language = case when p ? 'language' then p ->> 'language' else wa_language end,
    wa_status = case when p ? 'status' then upper(left(p ->> 'status', 40)) else wa_status end,
    wa_reason = case when p ? 'reason' then nullif(left(p ->> 'reason', 500), '') else wa_reason end,
    wa_template_id = case when p ? 'template_id' then p ->> 'template_id' else wa_template_id end,
    wa_params = case when p ? 'params' then p -> 'params' else wa_params end,
    wa_body = case when p ? 'body' then p ->> 'body' else wa_body end,
    wa_version = case when p ? 'version' then (p ->> 'version')::int else wa_version end,
    wa_checked_at = now()
  where id = p_id and channel = 'WHATSAPP';
end;
$$;

-- ---------------------------------------------------------------- order data
create or replace function public._payment_method_label(p public.payment_method)
returns text
language sql
immutable
as $$
  select case p when 'COD' then 'Cash on delivery' when 'ADVANCE' then 'Advance + cash on delivery'
                when 'FULL_PAYMENT' then 'Paid in full' else coalesce(p::text, '') end
$$;

/** Everything an email can show about an order (Liquid's shop, customer, order, shipment, payment). */
create or replace function public._notification_data(p_order_id uuid, p_payment numeric default null)
returns jsonb
language plpgsql
stable
security definer
set search_path = public, pg_temp
as $$
declare
  o public.orders;
  v_ship record;
  v_items jsonb;
  v_design jsonb := coalesce(public._email_settings() -> 'design', '{}'::jsonb);
  v_site text := rtrim(public.setting_text('store', array['website_url'], ''), '/');
begin
  select * into o from public.orders where id = p_order_id;
  if not found then
    return null;
  end if;
  select s.tracking_number, c.name as courier_name,
         case when c.tracking_url_template is not null and s.tracking_number is not null
              then replace(c.tracking_url_template, '{tracking}', s.tracking_number) end as tracking_url
  into v_ship
  from public.shipments s join public.couriers c on c.id = s.courier_id
  where s.order_id = p_order_id and s.is_active
  order by s.created_at desc limit 1;
  select coalesce(jsonb_agg(jsonb_build_object(
           'title', i.product_name, 'variant_title', nullif(i.variant_title, ''), 'sku', i.sku, 'quantity', i.quantity,
           'price', i.unit_price, 'line_price', i.line_total, 'image_url', i.image_url) order by i.created_at, i.id), '[]'::jsonb)
  into v_items
  from (select * from public.order_items where order_id = p_order_id order by created_at, id limit 50) i;

  return jsonb_build_object(
    'shop', jsonb_build_object(
      'name', public.setting_text('store', array['name'], 'Our store'),
      'phone', nullif(public.setting_text('store', array['phone'], ''), ''),
      'email', nullif(public.setting_text('store', array['email'], ''), ''),
      'address', nullif(public.setting_text('store', array['address'], ''), ''),
      'url', nullif(v_site, ''),
      'logo_url', coalesce(v_design ->> 'logo_url', public.setting_text('store', array['logo_url'], null)),
      'accent_color', coalesce(v_design ->> 'accent_color', '#111827'),
      'currency_symbol', public.setting_text('store', array['currency_symbol'], '৳')),
    'customer', jsonb_build_object(
      'name', o.customer_name, 'first_name', split_part(trim(coalesce(o.customer_name, '')), ' ', 1),
      'phone', o.customer_phone, 'email', o.customer_email),
    'order', jsonb_build_object(
      'name', o.order_number, 'number', o.order_number, 'created_at', o.created_at, 'status', o.status,
      'payment_method', public._payment_method_label(o.payment_method),
      'subtotal_price', o.subtotal, 'discount_price', o.discount_total, 'delivery_price', o.delivery_charge,
      'total_price', o.total_amount, 'paid_amount', o.amount_paid,
      'due_amount', greatest(o.total_amount - o.amount_paid, 0), 'cod_amount', o.cod_amount,
      'advance_amount', greatest(o.advance_required - o.amount_paid, 0),
      'note', nullif(o.customer_note, ''),
      'item_count', (select coalesce(sum(quantity), 0) from public.order_items where order_id = p_order_id),
      'status_url', case when v_site <> '' then v_site || '/track-order?order=' || o.order_number end,
      'line_items', v_items,
      'shipping_address', jsonb_build_object(
        'name', o.customer_name, 'phone', o.customer_phone, 'address', o.shipping_address, 'area', nullif(o.shipping_area, ''),
        'city', nullif(o.shipping_city, ''), 'district', nullif(o.shipping_district, ''), 'postal_code', nullif(o.shipping_postal_code, ''))),
    'shipment', jsonb_build_object('courier', v_ship.courier_name, 'tracking_number', v_ship.tracking_number, 'tracking_url', v_ship.tracking_url),
    'payment', jsonb_build_object('amount', p_payment));
end;
$$;

/** The simple {{name}} values of SMS and WhatsApp texts for an order (amounts with the given sign). */
create or replace function public._notification_vars(p_order_id uuid, p_prefix text, p_payment numeric default null)
returns jsonb
language plpgsql
stable
security definer
set search_path = public, pg_temp
as $$
declare
  o public.orders;
  v_ship record;
begin
  select * into o from public.orders where id = p_order_id;
  if not found then
    return '{}'::jsonb;
  end if;
  select s.tracking_number, c.name as courier_name,
         case when c.tracking_url_template is not null and s.tracking_number is not null
              then replace(c.tracking_url_template, '{tracking}', s.tracking_number) end as tracking_url
  into v_ship
  from public.shipments s join public.couriers c on c.id = s.courier_id
  where s.order_id = p_order_id and s.is_active
  order by s.created_at desc limit 1;
  return jsonb_build_object(
    'store_name', public.setting_text('store', array['name'], 'Our store'),
    'store_phone', public.setting_text('store', array['phone'], ''),
    'order_number', o.order_number,
    'customer_name', o.customer_name,
    'customer_first_name', split_part(trim(o.customer_name), ' ', 1),
    'tracking_number', coalesce(v_ship.tracking_number, ''),
    'courier_name', coalesce(v_ship.courier_name, ''),
    'tracking_url', coalesce(v_ship.tracking_url, ''),
    'track_order_url', public.setting_text('store', array['website_url'], '') || '/track-order?order=' || o.order_number,
    'total', public._fmt_amount(o.total_amount, p_prefix),
    'cod_amount', public._fmt_amount(o.cod_amount, p_prefix),
    'due_amount', public._fmt_amount(greatest(o.total_amount - o.amount_paid, 0), p_prefix),
    'advance_amount', public._fmt_amount(greatest(o.advance_required - o.amount_paid, 0), p_prefix),
    'payment_amount', case when p_payment is null then '' else public._fmt_amount(p_payment, p_prefix) end);
end;
$$;

/** For the email editor's preview: a recent order of the store (or a given one), else null (the editor's sample). */
create or replace function public.notification_preview_data(p_order_id uuid default null)
returns jsonb
language plpgsql
stable
security definer
set search_path = public, pg_temp
as $$
declare
  v_id uuid := p_order_id;
begin
  perform public.require_permission('notifications.view');
  if not public.has_permission('orders.view') then
    return null;
  end if;
  if v_id is null then
    select id into v_id from public.orders where merged_into is null order by created_at desc limit 1;
  end if;
  if v_id is null then
    return null;
  end if;
  return public._notification_data(v_id, 55);
end;
$$;

/** The store's WhatsApp texts filled in for one order, for "Send on WhatsApp" (opens the staff member's own WhatsApp). */
create or replace function public.whatsapp_order_messages(p_order_id uuid)
returns jsonb
language plpgsql
stable
security definer
set search_path = public, pg_temp
as $$
declare
  v_vars jsonb;
  v_phone text;
begin
  perform public.require_permission('orders.view');
  select public.sms_phone(customer_phone) into v_phone from public.orders where id = p_order_id;
  if not found then
    raise exception 'NOT_FOUND: order not found' using errcode = 'P0002';
  end if;
  v_vars := public._notification_vars(p_order_id, public.setting_text('store', array['currency_symbol'], '৳'), null);
  return jsonb_build_object(
    'phone', v_phone,
    'messages', coalesce((
      select jsonb_agg(jsonb_build_object('event', n.event, 'name', coalesce(n.name, public.notification_event_label(n.event)),
                                          'text', public.render_template(n.template, v_vars)) order by array_position(array[
        'ORDER_CREATED', 'ORDER_CONFIRMED', 'PRE_ORDER_CONFIRMED', 'ADVANCE_REQUIRED', 'PAYMENT_RECEIVED', 'PAYMENT_FAILED',
        'ORDER_SHIPPED', 'OUT_FOR_DELIVERY', 'ORDER_DELIVERED', 'ORDER_CANCELLED', 'RETURN_INITIATED', 'ORDER_RETURNED'
      ]::public.notification_event[], n.event))
      from public.notifications n where n.channel = 'WHATSAPP' and n.event <> 'ADVANCE_RECEIVED'), '[]'::jsonb));
end;
$$;

-- ---------------------------------------------------------------- queue
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
  v_vars jsonb;
  v_data jsonb;
  v_facts jsonb;
  v_symbol text;
  v_sms_prefix text;
  v_rate numeric;
  v_recipient text;
  v_body text;
  v_parts record;
  v_key text;
  v_count int := 0;
  v_payment numeric;
  v_email jsonb;
  v_wa jsonb;
  v_courier uuid;
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
    v_rate := greatest(public._sms_credit_price(), 0);
    v_payment := nullif(p_extra ->> 'payment_amount', '')::numeric;
    v_email := public._email_settings();
    v_wa := public._whatsapp_settings();
    select * into v_order from public.orders where id = p_order_id;
    if not found then
      return 0;
    end if;
    select s.courier_id into v_courier from public.shipments s
    where s.order_id = p_order_id and s.is_active order by s.created_at desc limit 1;
    v_facts := jsonb_build_object(
      'payment_method', v_order.payment_method,
      'total', v_order.total_amount,
      'district', v_order.shipping_district,
      'source', v_order.source,
      'courier', v_courier,
      'first_order', not exists (select 1 from public.orders o
                                 where o.customer_id = v_order.customer_id and o.id <> v_order.id
                                   and o.created_at < v_order.created_at)
    );

    for v_tpl in select * from public.notifications where event = p_event and is_enabled order by created_at, id loop
      if v_tpl.channel = 'SMS' then
        if not public.setting_bool('sms', array['enabled'], false) or not public.feature_enabled('sms') then
          continue;
        end if;
      elsif v_tpl.channel = 'EMAIL' then
        if not coalesce((v_email ->> 'enabled')::boolean, false) or not public._email_ready(v_email) then
          continue;
        end if;
      elsif not coalesce((v_wa ->> 'enabled')::boolean, false) or coalesce(v_wa ->> 'provider', '') <> 'meta' then
        continue;
      end if;
      if not public._notification_conditions_match(v_tpl.conditions, v_facts) then
        continue;
      end if;
      v_key := v_tpl.id || ':' || p_order_id || ':' || coalesce(p_ref, p_event::text);

      if v_tpl.channel = 'SMS' then
        -- SMS amounts use plain text ("Tk 1,250") so messages stay in the cheaper GSM encoding.
        v_vars := public._notification_vars(p_order_id, coalesce(v_sms_prefix || ' ', ''), v_payment);
        v_body := public.render_template(v_tpl.template, v_vars);
        v_recipient := public.sms_phone(v_order.customer_phone);
        select * into v_parts from public.sms_parts(v_body);
        if v_recipient is null then
          insert into public.notification_logs(notification_id, event, channel, recipient, body, order_id, customer_id,
            status, error, dedupe_key, segments, encoding, provider)
          values (v_tpl.id, p_event, 'SMS', coalesce(nullif(v_order.customer_phone, ''), '—'), v_body, p_order_id,
            v_order.customer_id, 'SKIPPED', 'Not a Bangladesh mobile number', v_key, v_parts.segments, v_parts.encoding,
            public._platform_sms_provider())
          on conflict (merchant_id, dedupe_key) do nothing;
          continue;
        end if;
        insert into public.notification_logs(notification_id, event, channel, recipient, body, order_id, customer_id,
          dedupe_key, segments, encoding, cost, cost_source, provider)
        values (v_tpl.id, p_event, 'SMS', v_recipient, v_body, p_order_id, v_order.customer_id, v_key,
          v_parts.segments, v_parts.encoding, round(v_parts.segments * v_rate, 4), 'ESTIMATE',
          public._platform_sms_provider())
        on conflict (merchant_id, dedupe_key) do nothing;

      elsif v_tpl.channel = 'EMAIL' then
        -- Most cash-on-delivery customers give no email: nothing to send, nothing to log.
        v_recipient := lower(trim(v_order.customer_email));
        if v_recipient is null or v_recipient !~* '^[^\s@<>"]+@[^\s@<>"]+\.[a-z]{2,}$' then
          continue;
        end if;
        -- The template and the order as they are now; the sender renders the email.
        v_data := jsonb_build_object('liquid', true, 'vars', public._notification_data(p_order_id, v_payment));
        if v_email ->> 'provider' = 'fullfilio' and public._email_service_sent_today() >= public._email_service_limit() then
          insert into public.notification_logs(notification_id, event, channel, recipient, subject, body, order_id,
            customer_id, dedupe_key, provider, data, status, error)
          values (v_tpl.id, p_event, 'EMAIL', v_recipient, v_tpl.subject, v_tpl.template, p_order_id, v_order.customer_id,
            v_key, 'fullfilio', v_data, 'SKIPPED',
            format('Today''s limit of %s emails through Fullfilio''s email service is used up. Connect your own mailbox to send more.', public._email_service_limit()))
          on conflict (merchant_id, dedupe_key) do nothing;
          continue;
        end if;
        insert into public.notification_logs(notification_id, event, channel, recipient, subject, body, order_id,
          customer_id, dedupe_key, provider, data)
        values (v_tpl.id, p_event, 'EMAIL', v_recipient, v_tpl.subject, v_tpl.template, p_order_id, v_order.customer_id,
          v_key, v_email ->> 'provider', v_data)
        on conflict (merchant_id, dedupe_key) do nothing;

      else
        v_vars := public._notification_vars(p_order_id, v_symbol, v_payment);
        v_recipient := public.sms_phone(v_order.customer_phone);
        -- What goes out is the text Meta approved (wa_body), not later edits.
        v_body := public.render_template(coalesce(v_tpl.wa_body, v_tpl.template), v_vars);
        v_data := jsonb_build_object('vars', v_vars, 'channel_id', v_wa ->> 'channel_id');
        if v_recipient is null or coalesce(v_tpl.wa_status, '') <> 'APPROVED' or v_tpl.wa_name is null then
          insert into public.notification_logs(notification_id, event, channel, recipient, body, order_id, customer_id,
            dedupe_key, provider, data, status, error)
          values (v_tpl.id, p_event, 'WHATSAPP', coalesce(v_recipient, nullif(v_order.customer_phone, ''), '—'), v_body, p_order_id,
            v_order.customer_id, v_key, 'meta', v_data, 'SKIPPED',
            case when v_recipient is null then 'Not a Bangladesh mobile number'
                 else 'This WhatsApp message is not approved by Meta yet (WhatsApp → submit it for approval)' end)
          on conflict (merchant_id, dedupe_key) do nothing;
          continue;
        end if;
        insert into public.notification_logs(notification_id, event, channel, recipient, body, order_id, customer_id,
          dedupe_key, provider, data)
        values (v_tpl.id, p_event, 'WHATSAPP', v_recipient, v_body, p_order_id, v_order.customer_id, v_key, 'meta', v_data)
        on conflict (merchant_id, dedupe_key) do nothing;
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

-- ---------------------------------------------------------------- sending
/** For the sender: how to send one queued email or WhatsApp message with the store's current setup. */
create or replace function public._notification_send_plan(p_log_id uuid)
returns jsonb
language plpgsql
stable
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
      'vars', l.data -> 'vars');
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
      'channel_id', c.id, 'phone_number_id', c.external_id, 'waba_id', c.waba_id,
      'connected', c.id is not null and c.status <> 'DISCONNECTED');
  end if;
  return null;
end;
$$;

/** The sender stores the email it rendered (so the log shows what the customer got). */
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
    body = left(p_body, 600000),
    data = coalesce(data, '{}'::jsonb) || '{"rendered": true}'::jsonb
  where id = p_id and status = 'SENDING';
end;
$$;

/** A test email or WhatsApp message from the Email / WhatsApp page: logged, at most 20 an hour per store. */
create or replace function public._notification_log_test(p_channel text, p_recipient text, p_subject text, p_body text, p_provider text, p_actor uuid)
returns uuid
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_id uuid;
begin
  if not public.is_system_context() then
    raise exception 'PERMISSION_DENIED' using errcode = '42501';
  end if;
  if p_channel not in ('EMAIL', 'WHATSAPP') then
    raise exception 'VALIDATION: unknown channel' using errcode = '22023';
  end if;
  if (select count(*) from public.notification_logs where purpose = 'TEST' and channel = p_channel::public.notification_channel
      and created_at > now() - interval '1 hour') >= 20 then
    raise exception 'VALIDATION: 20 test messages were sent in the last hour: try again later' using errcode = '22023';
  end if;
  insert into public.notification_logs(channel, recipient, subject, body, status, purpose, provider, created_by, attempts)
  values (p_channel::public.notification_channel, left(p_recipient, 200), left(p_subject, 300), left(coalesce(p_body, ''), 600000),
          'SENDING', 'TEST', p_provider, p_actor, 1)
  returning id into v_id;
  return v_id;
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
  if v_channel = 'SMS' then
    perform public.require_permission('sms.manage');
  elsif not public.has_permission('notifications.manage') then
    perform public.require_permission('settings.manage');
  end if;
  update public.notification_logs set status = 'QUEUED', next_attempt_at = now(), attempts = 0, error = null
  where id = p_id and status in ('FAILED', 'SKIPPED');
end;
$$;

-- ---------------------------------------------------------------- grants
revoke execute on function
  public._platform_email_service(),
  public._roles_seed_notifications(),
  public._notifications_use_defaults(),
  public._email_service_ready(),
  public._email_service_limit(),
  public._email_settings(),
  public._whatsapp_settings(),
  public._notification_channel_put(text, jsonb),
  public._email_ready(jsonb),
  public._email_service_sent_today(),
  public._email_smtp_connected(jsonb, uuid),
  public._email_smtp_disconnected(),
  public._whatsapp_template_record(uuid, jsonb),
  public._notification_data(uuid, numeric),
  public._notification_vars(uuid, text, numeric),
  public._notification_send_plan(uuid),
  public._notification_log_rendered(uuid, text, text),
  public._notification_log_test(text, text, text, text, text, uuid)
from public, anon, authenticated;
revoke execute on function
  public.email_settings(), public.email_settings_save(jsonb), public.whatsapp_settings(), public.whatsapp_settings_save(jsonb),
  public.notification_message_save(uuid, text, text), public.notification_message_enable(uuid, boolean),
  public.notification_message_reset(uuid), public.notification_preview_data(uuid), public.whatsapp_order_messages(uuid),
  public.retry_notification(uuid)
from public, anon;
grant execute on function
  public.email_settings(), public.email_settings_save(jsonb), public.whatsapp_settings(), public.whatsapp_settings_save(jsonb),
  public.notification_message_save(uuid, text, text), public.notification_message_enable(uuid, boolean),
  public.notification_message_reset(uuid), public.notification_preview_data(uuid), public.whatsapp_order_messages(uuid),
  public.retry_notification(uuid)
to authenticated;

select public._tenancy_own_functions();
