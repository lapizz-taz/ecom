-- =============================================================================
-- New order statuses for the Approved Orders stages.
-- (Enum values must be committed before use, so they get their own migration.)
--   PRE_ORDER            approved, waiting for stock to arrive
--   PENDING_CANCEL       cancel asked for after the parcel was booked; waiting on the courier
--   PARTIALLY_DELIVERED  the customer kept part of the order; the rest comes back
--   RETURNING            the parcel is on its way back to us
--   LOST                 the courier lost the parcel
-- =============================================================================
alter type public.order_status add value if not exists 'PRE_ORDER' after 'CONFIRMED';
alter type public.order_status add value if not exists 'PENDING_CANCEL' after 'SHIPPED';
alter type public.order_status add value if not exists 'PARTIALLY_DELIVERED' after 'DELIVERED';
alter type public.order_status add value if not exists 'RETURNING' after 'RETURN_REQUESTED';
alter type public.order_status add value if not exists 'LOST' after 'FAILED_DELIVERY';
