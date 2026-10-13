-- =============================================================================
-- Sign-up asks for the owner's WhatsApp number.
--
-- The Fullfilio team adds every new business to a WhatsApp support group, so
-- sign-up now asks for the number (most owners use their mobile number, which
-- is the default). It is kept with the business's onboarding details
-- (merchants.onboarding ->> 'whatsapp'), which Super Admin already reads.
-- Accepted: a Bangladesh mobile (01XXXXXXXXX, +8801…, 8801…) or an
-- international number written with + and the country code. Left out, it is
-- the mobile number, so older sign-up pages keep working.
-- The function is patched in place (its current text carries earlier patches);
-- CREATE OR REPLACE keeps its owner and grants. Safe to re-run.
-- =============================================================================

do $$
declare
  v_old text := replace(pg_get_functiondef('public.merchant_self_onboard(jsonb)'::regprocedure), E'\r', '');
  v_new text := v_old;
  r record;
begin
  if position('v_whatsapp' in v_old) > 0 then
    return; -- already patched
  end if;
  for r in select * from (values
    ($a$  v_website text := nullif(trim(coalesce(p ->> 'website', '')), '');
$a$, $b$  v_website text := nullif(trim(coalesce(p ->> 'website', '')), '');
  v_whatsapp text := regexp_replace(coalesce(p ->> 'whatsapp', ''), '[^0-9+]', '', 'g');
$b$),
    ($a$  if v_website is not null and v_website !~* $a$, $b$  -- WhatsApp for the support group: the mobile number unless another one is given.
  if v_whatsapp = '' then
    v_whatsapp := v_phone;
  elsif v_whatsapp ~ '^\+?8801[3-9][0-9]{8}$' then
    v_whatsapp := '0' || right(v_whatsapp, 10);
  end if;
  if v_whatsapp !~ '^01[3-9][0-9]{8}$' and v_whatsapp !~ '^\+[1-9][0-9]{7,14}$' then
    raise exception 'VALIDATION: enter a WhatsApp number (01XXXXXXXXX, or + country code and number)' using errcode = '22023';
  end if;
  if v_website is not null and v_website !~* $b$),
    ($a$'orders_per_month', nullif(p ->> 'orders_per_month', '')))$a$,
     $b$'orders_per_month', nullif(p ->> 'orders_per_month', ''), 'whatsapp', v_whatsapp))$b$)
  ) as t(old_text, new_text)
  loop
    if (length(v_new) - length(replace(v_new, r.old_text, ''))) / length(r.old_text) <> 1 then
      raise exception 'signup whatsapp: merchant_self_onboard has changed near %', left(r.old_text, 60);
    end if;
    v_new := replace(v_new, r.old_text, r.new_text);
  end loop;
  execute v_new;
end $$;
