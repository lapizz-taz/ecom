-- =============================================================================
-- Customer messages v2: the new events (their own file, because Postgres only
-- lets a new enum value be used once the statement that added it committed).
--   DELIVERY_FAILED  the courier put the parcel on hold / a delivery attempt failed
--   CART_REMINDER    a customer left checkout without ordering
--   REVIEW_REQUEST   a few days after delivery
--   DAILY_SUMMARY    the owner's morning email (not a customer message)
-- Safe to re-run.
-- =============================================================================

alter type public.notification_event add value if not exists 'DELIVERY_FAILED' after 'OUT_FOR_DELIVERY';
alter type public.notification_event add value if not exists 'CART_REMINDER';
alter type public.notification_event add value if not exists 'REVIEW_REQUEST';
alter type public.notification_event add value if not exists 'DAILY_SUMMARY';
