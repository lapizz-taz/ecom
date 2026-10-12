-- Merchants point their own domains at stores.<platform domain> (Cloudflare for
-- SaaS), so no store may take the name "stores" (its address would be that
-- hostname). Same list as before plus 'stores'.
create or replace function public._store_slug_reserved(p_slug text)
returns boolean
language sql
immutable
set search_path = public, pg_temp
as $$
  select p_slug = any (array['www', 'app', 'admin', 'api', 'mail', 'smtp', 'ftp', 'super', 'superadmin', 'super-admin', 'root',
    'static', 'assets', 'cdn', 'status', 'help', 'support', 'docs', 'blog', 'store', 'shop', 's', 'start', 'login', 'signup',
    'fullfilio', 'dashboard', 'billing', 'pay', 'payment', 'payments', 'checkout', 'account', 'auth', 'ops', 'internal', 'test',
    'stores'])
$$;
