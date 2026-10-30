-- =============================================================================
-- Web Orders: no "Customer confirmed" call status.
--
-- Asked for on 30 Oct 2026: Web Orders keeps the call statuses the team works with; "Customer confirmed"
-- goes. A customer's Confirm tap (WhatsApp button or the email's Confirm page) now puts the order in
-- Processing with the note "Confirmed by the customer on WhatsApp" / "… by email", which the order row
-- shows, or approves it when the store chose that (Settings → Customer messages), as before.
--   * The confirm page still knows the customer confirmed: it reads the tap kept on the reply, not the
--     call status, so a later call status change does not ask the customer again.
--   * The "Customer confirmed" call status is removed from every business (none of the live orders is on
--     it; any that is moves to Processing).
--
-- Functions that change in a line are patched in place (CREATE OR REPLACE keeps each one's owner and
-- grants). Safe to re-run.
-- =============================================================================

create or replace function pg_temp.patch_fn(p_fn text, p_from text, p_to text)
returns void
language plpgsql as $$
declare
  v_old text := replace(pg_get_functiondef(p_fn::regprocedure), E'\r', '');
  v_hits int;
begin
  if position(p_to in v_old) > 0 then
    return; -- already patched
  end if;
  v_hits := (length(v_old) - length(replace(v_old, p_from, ''))) / length(p_from);
  if v_hits <> 1 then
    raise exception 'no customer confirmed: % has changed (% matches for "%")', p_fn, v_hits, left(p_from, 60);
  end if;
  execute replace(v_old, p_from, p_to);
end $$;

-- 1. The confirm page: a confirmed tap is read from the reply ------------------------------------------

select pg_temp.patch_fn('public._order_reply_state(public.orders,public.order_reply_tokens)',
  $a$when o.confirmed_at is not null or o.review_status = 'CUSTOMER_CONFIRMED' then 'CONFIRMED'$a$,
  $b$when o.confirmed_at is not null or t.reply = 'CONFIRMED' then 'CONFIRMED'$b$);

-- 2. A Confirm tap: Processing with the note (the insert only makes sure Processing exists) -------------

select pg_temp.patch_fn('public.order_reply_apply(text,text,text,text)',
  $a$values (o.merchant_id, 'CUSTOMER_CONFIRMED', 'Customer confirmed', 'The customer confirmed the order on WhatsApp or by email',$a$,
  $b$values (o.merchant_id, 'PROCESSING', 'Processing', 'New, or being handled',$b$);
select pg_temp.patch_fn('public.order_reply_apply(text,text,text,text)',
  $a$'success', false, false, false, true, true, 15)$a$,
  $b$'info', false, false, false, true, true, 10)$b$);
select pg_temp.patch_fn('public.order_reply_apply(text,text,text,text)',
  $a$update public.orders set review_status = 'CUSTOMER_CONFIRMED', review_note$a$,
  $b$update public.orders set review_status = 'PROCESSING', review_note$b$);
select pg_temp.patch_fn('public.order_reply_apply(text,text,text,text)',
  $a$'to', 'CUSTOMER_CONFIRMED', 'via', p_via$a$,
  $b$'to', 'PROCESSING', 'via', p_via$b$);

-- 3. The call status goes, business by business (written as that business) ------------------------------

do $$
declare v_m uuid;
begin
  for v_m in select distinct merchant_id from public.order_review_statuses where code = 'CUSTOMER_CONFIRMED' loop
    perform set_config('app.merchant_id', v_m::text, true);
    update public.orders set review_status = 'PROCESSING' where merchant_id = v_m and review_status = 'CUSTOMER_CONFIRMED';
    delete from public.order_review_statuses where merchant_id = v_m and code = 'CUSTOMER_CONFIRMED';
  end loop;
  perform set_config('app.merchant_id', '', true);
end $$;

select public._tenancy_own_functions();
