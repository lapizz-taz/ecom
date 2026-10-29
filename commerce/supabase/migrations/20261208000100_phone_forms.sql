-- =============================================================================
-- Phone numbers in the forms people really type them.
--
-- A Shopify order from Atheron (#1052, 29 Oct 2026) had the phone "1712278464": a good number with
-- the 0 left off. The phone cleaner kept it as it was, the check refused it, and the order waited
-- under Need fixing until someone typed the number again. The cleaner now also repairs:
--   * the 0 left off:              1712278464, +88 1712278464           → 01712278464
--   * an extra 0 after the code:   +880 01712278464, 0088 01712278464   → 01712278464
--   * Bangla digits:               ০১৭১২২৭৮৪৬৪                          → 01712278464
--   * two numbers in one field:    "01712-278464 / 01812-000000"         → 01712278464 (the first)
-- Every number that was accepted before cleans to exactly what it did, and stored phones are already
-- clean, so nothing stored changes. Checkout, order edits, new customers, store imports (Shopify,
-- WooCommerce, the website API) and Quick SMS all use it. The browser and the backend functions use
-- the same rules (supabase/functions/_shared/phone.ts).
-- Safe to re-run.
-- =============================================================================

-- Digits only, in the country's local trunk form (0 then the national number).
create or replace function public._phone_local(p_digits text, p_country_code text)
returns text
language plpgsql
immutable
set search_path = public, pg_temp
as $$
declare
  d text := coalesce(p_digits, '');
begin
  if d = '' then
    return null;
  elsif d like '00' || p_country_code || '%' then
    return '0' || ltrim(substr(d, length(p_country_code) + 3), '0');
  elsif d like p_country_code || '%' and length(d) > length(p_country_code) + 8 then
    return '0' || ltrim(substr(d, length(p_country_code) + 1), '0');
  elsif p_country_code = '880' and d ~ '^881[3-9][0-9]{8}$' then
    return '0' || substr(d, 3);
  elsif p_country_code = '880' and d ~ '^0*1[3-9][0-9]{8}$' then
    return '0' || ltrim(d, '0');
  end if;
  return d;
end;
$$;

create or replace function public.normalize_phone(p_phone text, p_country_code text default '880')
returns text
language plpgsql
immutable
set search_path = public, pg_temp
as $$
declare
  v_text text := translate(coalesce(p_phone, ''), '০১২৩৪৫৬৭৮৯٠١٢٣٤٥٦٧٨٩۰۱۲۳۴۵۶۷۸۹', '012345678901234567890123456789');
  v_whole text := public._phone_local(regexp_replace(v_text, '[^0-9]', '', 'g'), p_country_code);
  v_first text;
begin
  if v_whole is null or p_country_code is distinct from '880' or v_whole ~ '^01[3-9][0-9]{8}$' then
    return v_whole;
  end if;
  -- A mobile number inside longer text (two numbers in one field), separators allowed between its digits.
  v_first := public._phone_local(regexp_replace(
    (regexp_match(v_text, '(?:^|[^0-9+])(\+?(?:00)?(?:88)?[ -]?0?1[3-9](?:[ -]?[0-9]){8})(?:[^0-9]|$)'))[1], '[^0-9]', '', 'g'),
    p_country_code);
  return case when v_first ~ '^01[3-9][0-9]{8}$' then v_first else v_whole end;
end;
$$;

-- SMS gateways want 8801XXXXXXXXX: the same cleaning first.
create or replace function public.sms_phone(p_phone text)
returns text
language plpgsql
immutable
set search_path = public, pg_temp
as $$
declare
  v text := public.normalize_phone(p_phone, '880');
begin
  return case when v ~ '^01[3-9][0-9]{8}$' then '88' || v end;
end;
$$;

-- A phone number in a chat message or comment (Bangla digits too).
create or replace function public._inbox_bd_phone(p_text text)
returns text
language sql
immutable
set search_path = public, pg_temp
as $$
  select '0' || (regexp_match(regexp_replace(translate(coalesce(p_text, ''), '০১২৩৪৫৬৭৮৯', '0123456789'), '[\s().-]', '', 'g'),
                              '(?<![0-9])(?:\+?880|0)(1[3-9][0-9]{8})(?![0-9])'))[1]
$$;

select public._tenancy_own_functions();
