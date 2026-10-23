-- =============================================================================
-- New plan prices and limits (October 2026)
--
--   Starter  ৳2,500 / month: 1,750 orders a month, 5 team members, 500 products
--   Growth   ৳5,000 / month: 3,500 orders a month, 10 team members, 1,000 products
--   Pro     ৳10,000 / month: 8,000 orders a month, 20 team members, 2,000 products
--
-- Connected stores, trial days, features and the new-business offer stay as they are.
-- Purchases (supplier orders) stay unlimited on every plan.
--
-- Running subscriptions on these plans move to the new price too: their next bill (for the
-- accounts on trial, their first one) is at the new price. Bills already issued keep their
-- amount. The Founder plan is not touched.
-- Safe to re-run.
-- =============================================================================

update public.plans p
set price = n.price,
    limits = p.limits || n.limits
from (values
  ('STARTER', 2500::numeric, '{"orders_per_month": 1750, "staff": 5, "products": 500}'::jsonb),
  ('GROWTH', 5000::numeric, '{"orders_per_month": 3500, "staff": 10, "products": 1000}'::jsonb),
  ('PRO', 10000::numeric, '{"orders_per_month": 8000, "staff": 20, "products": 2000}'::jsonb)
) as n(code, price, limits)
where p.code = n.code;

update public.subscriptions s
set price = p.price
from public.plans p
where p.id = s.plan_id
  and p.code in ('STARTER', 'GROWTH', 'PRO')
  and s.ended_at is null
  and s.price > 0
  and s.price <> p.price;
