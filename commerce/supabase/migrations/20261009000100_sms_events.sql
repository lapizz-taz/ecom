-- =============================================================================
-- SMS automation: the extra events customers can be told about, and the
-- permissions for the SMS section.
-- (Enum values must be committed before use, so they get their own migration.)
--   PRE_ORDER_CONFIRMED  the order was approved as a pre-order
--   OUT_FOR_DELIVERY     the courier is bringing the parcel today
--   RETURN_INITIATED     the parcel (or a customer return) is on its way back
--   PAYMENT_RECEIVED     the customer paid us (advance, full or balance)
--   PAYMENT_FAILED       an online payment attempt failed
-- =============================================================================
alter type public.notification_event add value if not exists 'PRE_ORDER_CONFIRMED' after 'ORDER_CONFIRMED';
alter type public.notification_event add value if not exists 'OUT_FOR_DELIVERY' after 'ORDER_SHIPPED';
alter type public.notification_event add value if not exists 'RETURN_INITIATED' after 'ORDER_CANCELLED';
alter type public.notification_event add value if not exists 'PAYMENT_FAILED' after 'ADVANCE_RECEIVED';
alter type public.notification_event add value if not exists 'PAYMENT_RECEIVED' after 'ADVANCE_RECEIVED';

insert into public.permissions(code, module, name) values
  ('sms.view', 'sms', 'View SMS messages, usage and costs'),
  ('sms.manage', 'sms', 'Connect the SMS provider and edit SMS automations')
on conflict (code) do nothing;

insert into public.role_permissions(role_id, permission_id)
select r.id, p.id
from (values
  ('ADMIN', 'sms.view'), ('ADMIN', 'sms.manage'),
  ('MANAGER', 'sms.view'), ('ORDER_MANAGER', 'sms.view'), ('FINANCE_MANAGER', 'sms.view')
) g(role_code, perm)
join public.roles r on r.code = g.role_code
join public.permissions p on p.code = g.perm
on conflict do nothing;
