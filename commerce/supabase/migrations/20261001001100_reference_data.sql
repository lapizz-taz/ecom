-- =============================================================================
-- 1100 · Reference data the application needs to run (roles, permissions,
-- default settings, finance categories, notification templates, default
-- fraud rules). All of it is editable from the admin. Development sample data
-- lives in supabase/seed.sql instead.
-- =============================================================================

insert into public.permissions(code, module, name) values
  ('dashboard.view', 'dashboard', 'View dashboard'),
  ('orders.view', 'orders', 'View orders'),
  ('orders.create', 'orders', 'Create manual orders'),
  ('orders.update', 'orders', 'Edit orders, items and notes'),
  ('orders.status', 'orders', 'Change order status'),
  ('orders.cancel', 'orders', 'Cancel orders'),
  ('orders.export', 'orders', 'Export orders'),
  ('orders.price_override', 'orders', 'Override prices, discounts and delivery charges'),
  ('payments.record', 'payments', 'Record payments received'),
  ('payments.verify', 'payments', 'Verify customer-submitted payments'),
  ('refunds.manage', 'payments', 'Issue refunds and resolve advances'),
  ('customers.view', 'customers', 'View customers'),
  ('customers.manage', 'customers', 'Edit and block customers'),
  ('fraud.view', 'fraud', 'View fraud checks and the review queue'),
  ('fraud.review', 'fraud', 'Approve, reject or request advance on risky orders'),
  ('fraud.rules', 'fraud', 'Manage fraud rules'),
  ('products.view', 'products', 'View products'),
  ('products.manage', 'products', 'Create and edit products, categories and images'),
  ('inventory.view', 'inventory', 'View stock and movements'),
  ('inventory.adjust', 'inventory', 'Adjust stock'),
  ('purchases.view', 'purchases', 'View suppliers and purchase orders'),
  ('purchases.manage', 'purchases', 'Manage suppliers, purchase orders and receiving'),
  ('production.view', 'production', 'View production queue'),
  ('production.manage', 'production', 'Run the production pipeline'),
  ('couriers.view', 'couriers', 'View couriers and shipments'),
  ('couriers.manage', 'couriers', 'Manage courier accounts'),
  ('shipments.manage', 'couriers', 'Assign couriers and update shipments'),
  ('finance.view', 'finance', 'View finance'),
  ('finance.manage', 'finance', 'Record income and expenses'),
  ('reports.view', 'reports', 'View reports and analytics'),
  ('reports.export', 'reports', 'Export reports'),
  ('marketing.view', 'marketing', 'View marketing'),
  ('marketing.manage', 'marketing', 'Manage campaigns and ad spend'),
  ('coupons.manage', 'marketing', 'Manage coupons'),
  ('settings.view', 'settings', 'View settings'),
  ('settings.manage', 'settings', 'Change settings, delivery zones and templates'),
  ('users.manage', 'users', 'Manage staff accounts and roles'),
  ('audit.view', 'audit', 'View audit logs')
on conflict (code) do nothing;

insert into public.roles(code, name, description, is_system, rank) values
  ('OWNER', 'Owner', 'Full access to everything', true, 100),
  ('ADMIN', 'Admin', 'Runs the store: orders, catalog, stock, production, reports and settings', true, 90),
  ('MANAGER', 'Manager', 'Day-to-day operations across orders, stock and production', true, 70),
  ('ORDER_MANAGER', 'Order manager', 'Orders, customers, couriers and fraud review', true, 50),
  ('INVENTORY_MANAGER', 'Inventory manager', 'Products, stock, purchasing and adjustments', true, 50),
  ('FINANCE_MANAGER', 'Finance manager', 'Income, expenses, refunds and profit reports', true, 50),
  ('PRODUCTION_MANAGER', 'Production manager', 'Production, quality check and packing', true, 50),
  ('VIEWER', 'Viewer', 'Read-only access', true, 10)
on conflict (code) do nothing;

with grants(role_code, perms) as (values
  ('ADMIN', array['dashboard.view', 'orders.view', 'orders.create', 'orders.update', 'orders.status', 'orders.cancel',
    'orders.export', 'orders.price_override', 'payments.record', 'payments.verify', 'customers.view', 'customers.manage',
    'fraud.view', 'fraud.review', 'fraud.rules', 'products.view', 'products.manage', 'inventory.view', 'inventory.adjust',
    'purchases.view', 'purchases.manage', 'production.view', 'production.manage', 'couriers.view', 'couriers.manage',
    'shipments.manage', 'finance.view', 'reports.view', 'reports.export', 'marketing.view', 'marketing.manage',
    'coupons.manage', 'settings.view', 'settings.manage', 'audit.view']),
  ('MANAGER', array['dashboard.view', 'orders.view', 'orders.create', 'orders.update', 'orders.status', 'orders.cancel',
    'orders.export', 'payments.record', 'customers.view', 'customers.manage', 'fraud.view', 'fraud.review',
    'products.view', 'inventory.view', 'inventory.adjust', 'purchases.view', 'production.view', 'production.manage',
    'couriers.view', 'shipments.manage', 'reports.view', 'reports.export', 'marketing.view', 'settings.view']),
  ('ORDER_MANAGER', array['dashboard.view', 'orders.view', 'orders.create', 'orders.update', 'orders.status',
    'orders.cancel', 'orders.export', 'payments.record', 'payments.verify', 'customers.view', 'customers.manage',
    'fraud.view', 'fraud.review', 'products.view', 'inventory.view', 'production.view', 'couriers.view', 'shipments.manage']),
  ('INVENTORY_MANAGER', array['dashboard.view', 'products.view', 'products.manage', 'inventory.view', 'inventory.adjust',
    'purchases.view', 'purchases.manage', 'reports.view']),
  ('FINANCE_MANAGER', array['dashboard.view', 'finance.view', 'finance.manage', 'refunds.manage', 'payments.record',
    'payments.verify', 'orders.view', 'customers.view', 'purchases.view', 'couriers.view', 'marketing.view',
    'reports.view', 'reports.export']),
  ('PRODUCTION_MANAGER', array['dashboard.view', 'production.view', 'production.manage', 'orders.view', 'products.view',
    'inventory.view']),
  ('VIEWER', array['dashboard.view', 'orders.view', 'products.view', 'inventory.view', 'customers.view',
    'production.view', 'couriers.view', 'reports.view'])
)
insert into public.role_permissions(role_id, permission_id)
select r.id, p.id
from grants g
join public.roles r on r.code = g.role_code
join public.permissions p on p.code = any(g.perms)
on conflict do nothing;

-- -----------------------------------------------------------------------------
-- Default settings
-- -----------------------------------------------------------------------------
insert into public.settings(key, is_public, description, value) values
('store', true, 'Store information, currency, timezone, order numbering', jsonb_build_object(
  'name', 'My Store',
  'tagline', 'Thoughtfully made essentials',
  'email', '',
  'phone', '',
  'address', '',
  'website_url', '',
  'logo_url', null,
  'currency', 'BDT',
  'currency_symbol', '৳',
  'locale', 'en-BD',
  'timezone', 'Asia/Dhaka',
  'order_prefix', 'ISO',
  'phone_country_code', '880',
  'phone_pattern', '^01[3-9][0-9]{8}$',
  'social', jsonb_build_object('facebook', '', 'instagram', '', 'tiktok', '')
)),
('storefront', true, 'Storefront home page content', jsonb_build_object(
  'announcement', '',
  'hero_title', 'Everyday pieces, made to last',
  'hero_subtitle', 'Free returns within 3 days. Cash on delivery available nationwide.',
  'hero_image_url', null,
  'hero_cta_label', 'Shop now',
  'hero_cta_link', '/shop',
  'featured_category_slugs', '[]'::jsonb,
  'footer_text', ''
)),
('policies', true, 'Customer-facing policies', jsonb_build_object(
  'shipping', 'Orders are dispatched within 1–2 working days. Delivery times depend on your location.',
  'returns', 'If something is not right, contact us within 3 days of delivery to arrange a return or exchange.',
  'privacy', 'We only use your details to process and deliver your orders and to contact you about them.',
  'terms', 'By placing an order you agree to pay the order total including delivery. Some orders may require an advance payment before dispatch.'
)),
('delivery', true, 'Delivery methods, free delivery threshold and district list', jsonb_build_object(
  'methods', jsonb_build_array(
    jsonb_build_object('code', 'standard', 'name', 'Standard delivery', 'extra_charge', 0, 'active', true),
    jsonb_build_object('code', 'express', 'name', 'Express delivery', 'extra_charge', 60, 'active', false)),
  'free_delivery_threshold', 0,
  'districts', jsonb_build_array('Bagerhat', 'Bandarban', 'Barguna', 'Barishal', 'Bhola', 'Bogura', 'Brahmanbaria',
    'Chandpur', 'Chapainawabganj', 'Chattogram', 'Chuadanga', 'Cox''s Bazar', 'Cumilla', 'Dhaka', 'Dinajpur', 'Faridpur',
    'Feni', 'Gaibandha', 'Gazipur', 'Gopalganj', 'Habiganj', 'Jamalpur', 'Jashore', 'Jhalokathi', 'Jhenaidah',
    'Joypurhat', 'Khagrachhari', 'Khulna', 'Kishoreganj', 'Kurigram', 'Kushtia', 'Lakshmipur', 'Lalmonirhat',
    'Madaripur', 'Magura', 'Manikganj', 'Meherpur', 'Moulvibazar', 'Munshiganj', 'Mymensingh', 'Naogaon', 'Narail',
    'Narayanganj', 'Narsingdi', 'Natore', 'Netrokona', 'Nilphamari', 'Noakhali', 'Pabna', 'Panchagarh', 'Patuakhali',
    'Pirojpur', 'Rajbari', 'Rajshahi', 'Rangamati', 'Rangpur', 'Satkhira', 'Shariatpur', 'Sherpur', 'Sirajganj',
    'Sunamganj', 'Sylhet', 'Tangail', 'Thakurgaon')
)),
('payments', false, 'Payment methods and providers (credentials live in edge function secrets)', jsonb_build_object(
  'cod_enabled', true,
  'advance_enabled', true,
  'full_payment_enabled', true,
  'voluntary_advance', jsonb_build_object('type', 'DELIVERY_CHARGE', 'value', 0),
  'providers', jsonb_build_object(
    'manual', jsonb_build_object('enabled', true, 'type', 'manual', 'label', 'bKash / Nagad (Send Money)',
      'instructions', 'Send the amount to one of the numbers below using "Send Money", then enter the Transaction ID.',
      'accounts', jsonb_build_array(jsonb_build_object('channel', 'BKASH', 'label', 'bKash Personal', 'number', ''))),
    'sslcommerz', jsonb_build_object('enabled', false, 'type', 'redirect', 'label', 'Card / Mobile Banking (SSLCommerz)',
      'sandbox', true))
)),
('fraud', false, 'Fraud detection provider, thresholds and customer messages', jsonb_build_object(
  'enabled', true,
  'providers', jsonb_build_array('internal'),
  'cache_minutes', 30,
  'thresholds', jsonb_build_object('medium', 30, 'high', 60, 'critical', 80),
  'new_customer_score', 20,
  'on_provider_error', 'REVIEW',
  'block_mode', 'REJECT',
  'check_manual_orders', false,
  'default_advance', jsonb_build_object('type', 'DELIVERY_CHARGE', 'value', 0),
  'messages', jsonb_build_object(
    'advance', 'To confirm this order, a {amount} advance payment is required.',
    'review', 'Your order needs a quick confirmation. Our team will contact you shortly.',
    'blocked', 'We are unable to accept this order online. Please contact us to complete your purchase.'),
  'http', jsonb_build_object(
    'mapping', jsonb_build_object('total', 'summary.total_parcel', 'delivered', 'summary.success_parcel',
      'cancelled', 'summary.cancelled_parcel', 'success_ratio', 'summary.success_ratio', 'risk_score', null))
)),
('orders', false, 'Order workflow rules', jsonb_build_object(
  'require_confirmation', false,
  'require_confirmation_after_advance', false,
  'advance_payment_timeout_hours', 24,
  'max_quantity_per_item', 20,
  'require_courier_before_ship', false
)),
('inventory', false, 'Stock rules', jsonb_build_object(
  'low_stock_threshold', 5,
  'allow_overselling', false,
  'return_restock_default', true,
  'costing_method', 'WEIGHTED_AVERAGE'
)),
('customers', false, 'Customer segmentation', jsonb_build_object(
  'vip_min_spent', 20000,
  'vip_min_orders', 5,
  'regular_min_orders', 2,
  'high_risk_bad_rate', 0.5
)),
('notifications', false, 'Customer notification channels (provider credentials live in edge function secrets)', jsonb_build_object(
  'enabled', true,
  'channels', jsonb_build_object(
    'sms', jsonb_build_object('enabled', false, 'provider', 'console'),
    'whatsapp', jsonb_build_object('enabled', false, 'provider', 'console'),
    'email', jsonb_build_object('enabled', false, 'provider', 'console'))
)),
('couriers', false, 'Courier defaults', jsonb_build_object(
  'default_courier_id', null,
  'sync_interval_minutes', 60
)),
('production', false, 'Production pipeline', jsonb_build_object(
  'enabled', true,
  'auto_create', 'REQUIRED_ONLY',
  'default_deadline_days', 3
)),
('finance', false, 'Accounting automation', jsonb_build_object(
  'auto_collect_cod_on_delivery', false,
  'record_courier_cost_on_delivery', true,
  'post_ad_spend_to_expenses', true
))
on conflict (key) do nothing;

-- -----------------------------------------------------------------------------
-- Finance categories
-- -----------------------------------------------------------------------------
insert into public.finance_categories(code, name, type, pnl_group, is_system, allow_manual, sort_order, description) values
  ('PRODUCT_SALES', 'Product Sales', 'INCOME', 'REVENUE', true, false, 10, 'Recognised automatically when an order is delivered'),
  ('DELIVERY_CHARGES', 'Delivery Charges', 'INCOME', 'DELIVERY_INCOME', true, false, 20, 'Delivery fee charged to customers on delivered orders'),
  ('ADVANCE_PAYMENTS', 'Advance Payments', 'INCOME', 'NONE', true, false, 30, 'Cash received before delivery (not revenue until delivered)'),
  ('ONLINE_PAYMENTS', 'Online Payments', 'INCOME', 'NONE', true, false, 40, 'Full or balance payments received online'),
  ('COD_COLLECTIONS', 'COD Collections', 'INCOME', 'NONE', true, false, 50, 'Cash on delivery settled by couriers'),
  ('RETAINED_ADVANCES', 'Retained Advances', 'INCOME', 'OTHER_INCOME', true, false, 60, 'Advances kept after cancellation/return'),
  ('OTHER_INCOME', 'Other Income', 'INCOME', 'OTHER_INCOME', true, true, 70, null),
  ('INCOME_OTHER', 'Other', 'INCOME', 'OTHER_INCOME', true, true, 80, null),
  ('PRODUCT_PURCHASE', 'Product Purchase', 'EXPENSE', 'NONE', true, true, 100, 'Stock purchases; cost reaches P&L as COGS on delivery'),
  ('COGS', 'Cost of Goods Sold', 'EXPENSE', 'COGS', true, false, 110, 'Posted automatically on delivery'),
  ('PRODUCTION_COST', 'Production Cost', 'EXPENSE', 'COGS', true, true, 120, null),
  ('PACKAGING', 'Packaging', 'EXPENSE', 'OPERATING_EXPENSE', true, true, 130, null),
  ('COURIER', 'Courier', 'EXPENSE', 'OPERATING_EXPENSE', true, true, 140, null),
  ('ADVERTISING', 'Advertising', 'EXPENSE', 'OPERATING_EXPENSE', true, true, 150, 'Ad spend entries are posted automatically from Marketing'),
  ('SALARIES', 'Salaries', 'EXPENSE', 'OPERATING_EXPENSE', true, true, 160, null),
  ('SOFTWARE', 'Software', 'EXPENSE', 'OPERATING_EXPENSE', true, true, 170, null),
  ('HOSTING', 'Hosting', 'EXPENSE', 'OPERATING_EXPENSE', true, true, 180, null),
  ('RENT', 'Rent', 'EXPENSE', 'OPERATING_EXPENSE', true, true, 190, null),
  ('UTILITIES', 'Utilities', 'EXPENSE', 'OPERATING_EXPENSE', true, true, 200, null),
  ('REFUNDS', 'Refunds', 'EXPENSE', 'CONTRA_REVENUE', true, false, 210, 'Refunds on delivered orders (reduce revenue)'),
  ('ADVANCE_REFUNDS', 'Advance Refunds', 'EXPENSE', 'NONE', true, false, 220, 'Advances returned on undelivered orders'),
  ('RETURNS', 'Returns', 'EXPENSE', 'OPERATING_EXPENSE', true, true, 230, 'Return shipping and return-related costs'),
  ('EXPENSE_OTHER', 'Other', 'EXPENSE', 'OPERATING_EXPENSE', true, true, 240, null)
on conflict (code) do nothing;

-- -----------------------------------------------------------------------------
-- Default delivery zones (edit in Settings → Delivery)
-- -----------------------------------------------------------------------------
insert into public.delivery_zones(name, districts, areas, charge, return_charge, estimated_days, is_default, sort_order)
select * from (values
  ('Inside Dhaka', array['dhaka'], array[]::text[], 80::numeric, 50::numeric, '1–2 days', false, 1),
  ('Dhaka suburbs', array['gazipur', 'narayanganj', 'savar'], array[]::text[], 110::numeric, 60::numeric, '2–3 days', false, 2),
  ('Outside Dhaka', array[]::text[], array[]::text[], 130::numeric, 80::numeric, '3–5 days', true, 3)
) z(name, districts, areas, charge, return_charge, estimated_days, is_default, sort_order)
where not exists (select 1 from public.delivery_zones);

insert into public.couriers(name, provider, tracking_url_template, notes)
select 'Own delivery', 'manual', null, 'Deliveries handled by your own team or a courier without API integration'
where not exists (select 1 from public.couriers);

-- -----------------------------------------------------------------------------
-- Default fraud rules (most severe matching decision wins)
-- -----------------------------------------------------------------------------
do $$
declare
  v_id uuid;
begin
  if exists (select 1 from public.fraud_rules) then
    return;
  end if;

  insert into public.fraud_rules(name, description, priority, conditions)
  values ('Blocked customer', 'Phone number belongs to a blocked customer', 10,
          '[{"field": "phone_flagged", "op": "is_true"}]') returning id into v_id;
  insert into public.fraud_rule_actions(rule_id, decision, stop_processing) values (v_id, 'BLOCK', true);

  insert into public.fraud_rules(name, description, priority, conditions)
  values ('Critical risk', 'Send to manual review; suggest delivery + return charge as advance', 20,
          '[{"field": "risk_level", "op": "eq", "value": "CRITICAL"}]') returning id into v_id;
  insert into public.fraud_rule_actions(rule_id, decision, advance_type) values (v_id, 'REVIEW', 'DELIVERY_PLUS_RETURN');

  insert into public.fraud_rules(name, description, priority, conditions)
  values ('High risk', 'Advance of the delivery charge before confirming', 30,
          '[{"field": "risk_level", "op": "eq", "value": "HIGH"}]') returning id into v_id;
  insert into public.fraud_rule_actions(rule_id, decision, advance_type) values (v_id, 'ADVANCE_REQUIRED', 'DELIVERY_CHARGE');

  insert into public.fraud_rules(name, description, priority, conditions)
  values ('Repeated failed COD', 'Two or more COD parcels refused/failed before', 40,
          '[{"field": "failed_cod_orders", "op": "gte", "value": 2}]') returning id into v_id;
  insert into public.fraud_rule_actions(rule_id, decision, advance_type) values (v_id, 'ADVANCE_REQUIRED', 'DELIVERY_PLUS_RETURN');

  insert into public.fraud_rules(name, description, priority, conditions)
  values ('New customer, high order value', 'First order above 5,000', 50,
          '[{"field": "is_new_customer", "op": "is_true"}, {"field": "order_value", "op": "gte", "value": 5000}]') returning id into v_id;
  insert into public.fraud_rule_actions(rule_id, decision, advance_type, advance_value) values (v_id, 'ADVANCE_REQUIRED', 'PERCENTAGE', 20);

  insert into public.fraud_rules(name, description, priority, conditions)
  values ('Medium risk', 'Cash on delivery allowed (change to an advance if needed)', 60,
          '[{"field": "risk_level", "op": "eq", "value": "MEDIUM"}]') returning id into v_id;
  insert into public.fraud_rule_actions(rule_id, decision) values (v_id, 'ALLOW');

  insert into public.fraud_rules(name, description, priority, conditions)
  values ('Low risk', 'Normal cash on delivery', 70,
          '[{"field": "risk_level", "op": "eq", "value": "LOW"}]') returning id into v_id;
  insert into public.fraud_rule_actions(rule_id, decision) values (v_id, 'ALLOW');
end $$;

-- -----------------------------------------------------------------------------
-- Notification templates (disabled until a channel/provider is configured)
-- -----------------------------------------------------------------------------
insert into public.notifications(event, channel, is_enabled, subject, template)
select e.event::public.notification_event, c.channel::public.notification_channel, false,
       case when c.channel = 'EMAIL' then e.subject end, e.body
from (values
  ('ORDER_CREATED', 'We received your order {{order_number}}',
   'Hi {{customer_name}}, thanks for your order {{order_number}} ({{total}}). We will confirm it shortly. - {{store_name}}'),
  ('ORDER_CONFIRMED', 'Order {{order_number}} confirmed',
   'Your order {{order_number}} is confirmed and being prepared. Total due on delivery: {{cod_amount}}. - {{store_name}}'),
  ('ADVANCE_REQUIRED', 'Advance payment needed for {{order_number}}',
   'To confirm order {{order_number}}, please pay an advance of {{advance_amount}}. Pay here: {{track_order_url}} - {{store_name}}'),
  ('ADVANCE_RECEIVED', 'Payment received for {{order_number}}',
   'We received your payment for order {{order_number}}. Thank you! - {{store_name}}'),
  ('ORDER_SHIPPED', 'Order {{order_number}} is on the way',
   'Your order {{order_number}} has been handed to {{courier_name}}. Tracking: {{tracking_number}} {{tracking_url}} - {{store_name}}'),
  ('ORDER_DELIVERED', 'Order {{order_number}} delivered',
   'Your order {{order_number}} was delivered. We hope you love it! - {{store_name}}'),
  ('ORDER_CANCELLED', 'Order {{order_number}} cancelled',
   'Your order {{order_number}} has been cancelled. Questions? Call {{store_phone}}. - {{store_name}}'),
  ('ORDER_RETURNED', 'Return received for {{order_number}}',
   'We have received the return for order {{order_number}}. - {{store_name}}')
) e(event, subject, body)
cross join (values ('SMS'), ('WHATSAPP'), ('EMAIL')) c(channel)
on conflict (event, channel) do nothing;
