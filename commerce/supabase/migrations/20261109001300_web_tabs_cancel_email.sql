-- =============================================================================
-- Web Orders without the "Invalid" and "Old cancelled" tabs, and Shopify's
-- order cancelled e-mail.
--
-- 1. The "Invalid" and "Old cancelled" call statuses are turned off for every
--    store and for new stores, so their tabs and choices are gone. An order the
--    fraud check rejects now shows under Cancelled (Invalid only while a store
--    has switched it back on in Settings > Call statuses). No order uses either
--    status, so no order changes.
-- 2. A Shopify store order cancelled here is cancelled on Shopify with
--    Shopify's cancellation e-mail to the customer. A new store setting
--    (cancel_email, on by default) turns it off. Merging never cancels on
--    Shopify, so a merge never sends it; the order log says when it was sent.
-- =============================================================================

create or replace function pg_temp.lf(p text) returns text
language sql immutable as $$ select replace(p, E'\r', '') $$;

-- 1a. A fraud-rejected web order goes to Cancelled unless the store uses Invalid
do $$
declare
  v_old text := pg_temp.lf(pg_get_functiondef('public._orders_review_sync()'::regprocedure));
  v_from text := $a$    new.review_status := case when new.status = 'REJECTED_FRAUD' then 'INVALID' else 'CANCELLED' end;$a$;
  v_to text := $b$    new.review_status := case when new.status = 'REJECTED_FRAUD' and exists (select 1 from public.order_review_statuses s
        where s.merchant_id = new.merchant_id and s.code = 'INVALID' and s.is_active) then 'INVALID' else 'CANCELLED' end;$b$;
begin
  if position(v_from in v_old) = 0 then
    if position(v_to in v_old) > 0 then
      return;
    end if;
    raise exception 'web tabs: _orders_review_sync has changed';
  end if;
  execute replace(v_old, v_from, v_to);
end $$;

-- 1b. Invalid can be turned off like any other call status
do $$
declare
  v_old text := pg_temp.lf(pg_get_functiondef('public.admin_save_review_status(jsonb)'::regprocedure));
  v_from text := $a$if v_code in ('PROCESSING', 'CANCELLED', 'INVALID') and not$a$;
  v_to text := $b$if v_code in ('PROCESSING', 'CANCELLED') and not$b$;
begin
  if position(v_from in v_old) = 0 then
    if position(v_to in v_old) > 0 then
      return;
    end if;
    raise exception 'web tabs: admin_save_review_status has changed';
  end if;
  execute replace(v_old, v_from, v_to);
end $$;

-- 1c. New stores start with both turned off
do $$
declare
  v_old text := pg_temp.lf(pg_get_functiondef('public._merchant_seed_defaults(uuid)'::regprocedure));
  v_new text := v_old;
  r record;
begin
  for r in select * from (values
    ('"code": "INVALID", "color": "danger", "label": "Invalid", "is_active": true',
     '"code": "INVALID", "color": "danger", "label": "Invalid", "is_active": false'),
    ('"code": "OLD_CANCELLED", "color": "neutral", "label": "Old cancelled", "is_active": true',
     '"code": "OLD_CANCELLED", "color": "neutral", "label": "Old cancelled", "is_active": false')) as t(old_text, new_text)
  loop
    if position(r.old_text in v_new) = 0 then
      if position(r.new_text in v_new) > 0 then
        continue;
      end if;
      raise exception 'web tabs: _merchant_seed_defaults has changed near %', left(r.old_text, 40);
    end if;
    v_new := replace(v_new, r.old_text, r.new_text);
  end loop;
  if v_new <> v_old then
    execute v_new;
  end if;
end $$;

-- 1d. Every store: both off
update public.order_review_statuses set is_active = false
where code in ('INVALID', 'OLD_CANCELLED') and is_active;

-- 2a. Store setting: Shopify's cancellation e-mail (on unless turned off)
do $$
declare
  v_old text := pg_temp.lf(pg_get_functiondef('public.channel_inventory_overview(uuid)'::regprocedure));
  v_from text := $a$        'cancel_on_shopify', v_c.platform = 'SHOPIFY' and public._channel_opt(v_c, 'cancel_on_shopify', true),
$a$;
  v_to text := $b$        'cancel_on_shopify', v_c.platform = 'SHOPIFY' and public._channel_opt(v_c, 'cancel_on_shopify', true),
        'cancel_email', v_c.platform = 'SHOPIFY' and public._channel_opt(v_c, 'cancel_email', true),
$b$;
begin
  if position(v_to in v_old) > 0 then
    return;
  end if;
  if position(v_from in v_old) = 0 then
    raise exception 'cancel e-mail: channel_inventory_overview has changed';
  end if;
  execute replace(v_old, v_from, v_to);
end $$;

do $$
declare
  v_old text := pg_temp.lf(pg_get_functiondef('public.channel_sync_settings_save(uuid,jsonb)'::regprocedure));
  v_from text := $a$    'cancel_on_shopify', (p ->> 'cancel_on_shopify')::boolean, 'mark_paid_on_delivery'$a$;
  v_to text := $b$    'cancel_on_shopify', (p ->> 'cancel_on_shopify')::boolean, 'cancel_email', (p ->> 'cancel_email')::boolean,
    'mark_paid_on_delivery'$b$;
begin
  if position(v_to in v_old) > 0 then
    return;
  end if;
  if position(v_from in v_old) = 0 then
    raise exception 'cancel e-mail: channel_sync_settings_save has changed';
  end if;
  execute replace(v_old, v_from, v_to);
end $$;

-- 2b. The order log says when Shopify e-mailed the customer
do $$
declare
  v_old text := pg_temp.lf(pg_get_functiondef('public.channel_order_sync_update(uuid,jsonb)'::regprocedure));
  v_from text := $a$      when 'REQUESTED' then 'Cancel sent to Shopify' || case when v_new.restocked_in_store then ' (Shopify restocks)' else ' (stock handled here, not restocked twice)' end
$a$;
  v_to text := $b$      when 'REQUESTED' then 'Cancel sent to Shopify' || case when v_new.restocked_in_store then ' (Shopify restocks)' else ' (stock handled here, not restocked twice)' end
        || case when coalesce((p ->> 'customer_emailed')::boolean, false) then '; Shopify e-mails the customer that it was cancelled' else '' end
$b$;
begin
  if position(v_to in v_old) > 0 then
    return;
  end if;
  if position(v_from in v_old) = 0 then
    raise exception 'cancel e-mail: channel_order_sync_update has changed';
  end if;
  execute replace(v_old, v_from, v_to);
end $$;

select public._tenancy_own_functions();
