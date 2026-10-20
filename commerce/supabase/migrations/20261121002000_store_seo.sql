-- Store SEO: Automatic, Manual and Hybrid modes, per-item overrides, redirects, the data for
-- server-rendered meta tags, the sitemap and robots.txt, and an audit of what needs attention.
--
-- Settings live in the private "seo" setting (defaults in _seo_defaults()). Titles and meta
-- descriptions keep living where they were: products.seo_title / seo_description, now also
-- categories.seo_title / seo_description, and seo_entries for store pages (home, shop, …).
-- seo_entries also holds, for any item, where each stored value came from (sources:
-- {"title": "manual" | "generated", …}), a custom canonical address, noindex, a focus keyword
-- and a sharing image. A stored value without a recorded source is the merchant's own (manual).
--
-- What a page shows (one rule everywhere, _seo_fields):
--   automatic  generated from the templates; stored values are kept but not used;
--   manual     only stored values; an empty title falls back to the item's name;
--   hybrid     a stored value wins (manual ones are never regenerated), else generated.
-- Generated values are worked out when a page is asked for (cheap: no stored copies to go
-- stale), from the item's current data, so imports and edits never overwrite manual values.
-- Changing a product's or collection's address keeps a redirect from the old one (no chains).
-- Structured data uses only stored facts: no invented prices, stock, ratings or reviews.

-- Text is compared without carriage returns (a script pasted on Windows has CRLF line ends).
create or replace function pg_temp.lf(p text) returns text
language sql immutable as $$ select replace(p, E'\r', '') $$;

alter table public.categories add column if not exists seo_title text;
alter table public.categories add column if not exists seo_description text;

create table if not exists public.seo_entries (
  merchant_id uuid not null default public.current_merchant_id() references public.merchants(id),
  entity_type text not null check (entity_type in ('product', 'collection', 'page')),
  -- A product or category id, or a store page: home, shop, contact, track-order, policies, policies/<name>.
  entity_key text not null check (length(entity_key) between 1 and 80),
  -- Store pages only (products and categories keep theirs on their own rows).
  title text check (length(title) <= 300),
  description text check (length(description) <= 1000),
  canonical_url text check (canonical_url ~ '^https://[^\s]+$' and length(canonical_url) <= 500),
  noindex boolean not null default false,
  focus_keyword text check (length(focus_keyword) <= 100),
  og_image text check (og_image ~ '^(https?://|/)[^\s]+$' and length(og_image) <= 1000),
  sources jsonb not null default '{}'::jsonb check (jsonb_typeof(sources) = 'object'),
  updated_by uuid,
  updated_at timestamptz not null default now(),
  primary key (merchant_id, entity_type, entity_key)
);
alter table public.seo_entries enable row level security;
drop policy if exists tenant_isolation on public.seo_entries;
drop policy if exists app_owner_all on public.seo_entries;
drop policy if exists staff_read on public.seo_entries;
create policy tenant_isolation on public.seo_entries as restrictive for all to public
  using (merchant_id = public.current_merchant_id()) with check (merchant_id = public.current_merchant_id());
create policy app_owner_all on public.seo_entries for all to app_owner using (true) with check (true);
create policy staff_read on public.seo_entries for select to authenticated using ((select public.is_staff()));
revoke all on public.seo_entries from anon;

create table if not exists public.seo_redirects (
  id uuid primary key default gen_random_uuid(),
  merchant_id uuid not null default public.current_merchant_id() references public.merchants(id),
  from_path text not null check (from_path ~ '^/[^\s?#]*$' and length(from_path) <= 300),
  to_path text not null check (to_path ~ '^/[^\s?#]*$' and length(to_path) <= 300),
  source text not null default 'auto' check (source in ('auto', 'manual')),
  created_by uuid,
  created_at timestamptz not null default now(),
  unique (merchant_id, from_path),
  check (from_path <> to_path)
);
alter table public.seo_redirects enable row level security;
drop policy if exists tenant_isolation on public.seo_redirects;
drop policy if exists app_owner_all on public.seo_redirects;
drop policy if exists staff_read on public.seo_redirects;
create policy tenant_isolation on public.seo_redirects as restrictive for all to public
  using (merchant_id = public.current_merchant_id()) with check (merchant_id = public.current_merchant_id());
create policy app_owner_all on public.seo_redirects for all to app_owner using (true) with check (true);
create policy staff_read on public.seo_redirects for select to authenticated using ((select public.is_staff()));
revoke all on public.seo_redirects from anon;

-- ---------------------------------------------------------------------------------------------
-- Settings
-- ---------------------------------------------------------------------------------------------

create or replace function public._seo_defaults()
returns jsonb
language sql
immutable
set search_path = public, pg_temp
as $$
  select jsonb_build_object(
    -- Hybrid: generated by default, and any field the merchant writes is kept as written.
    'mode', 'hybrid',
    'generate', jsonb_build_object('title', true, 'description', true, 'alt_text', true),
    'templates', jsonb_build_object(
      'product_title', '{{name}}',
      'product_description', '{{short_description|description}}',
      'collection_title', '{{name}}',
      'collection_description', '{{description}}',
      'page_title', '{{name}}',
      'page_description', '',
      'home_title', '{{store}}',
      'home_description', '{{tagline}}'),
    -- Added to generated titles (not to the home page, nor to titles the merchant wrote).
    'title_suffix', ' | {{store}}',
    'social', jsonb_build_object('og_image', '', 'twitter_site', ''),
    'structured_data', jsonb_build_object('product', true, 'breadcrumbs', true, 'organization', true, 'website', true),
    'sitemap', jsonb_build_object('enabled', true, 'products', true, 'collections', true, 'pages', true),
    'indexing', jsonb_build_object('store', true, 'products', true, 'collections', true, 'pages', true, 'search', false),
    -- New products / collections: 'auto' follows the mode; 'fill' stores generated values at once.
    'new_items', jsonb_build_object('products', 'auto', 'collections', 'auto'),
    'ai', jsonb_build_object('enabled', false))
$$;

/** The store's SEO settings: the saved ones over the defaults (grouped settings key by key). */
create or replace function public._seo_settings()
returns jsonb
language plpgsql
stable
security definer
set search_path = public, pg_temp
as $$
declare
  d jsonb := public._seo_defaults();
  s jsonb := public.get_setting('seo');
  g text;
  v jsonb;
begin
  v := d || (s - array['generate', 'templates', 'social', 'structured_data', 'sitemap', 'indexing', 'new_items', 'ai']);
  foreach g in array array['generate', 'templates', 'social', 'structured_data', 'sitemap', 'indexing', 'new_items', 'ai'] loop
    if jsonb_typeof(s -> g) = 'object' then
      v := jsonb_set(v, array[g], (d -> g) || (s -> g));
    end if;
  end loop;
  return v;
end;
$$;

-- ---------------------------------------------------------------------------------------------
-- Text helpers
-- ---------------------------------------------------------------------------------------------

/** Plain text from a product description (tags and common entities removed, spaces collapsed). */
create or replace function public._seo_plain(p_text text)
returns text
language sql
immutable
set search_path = public, pg_temp
as $$
  select nullif(trim(regexp_replace(
    replace(replace(replace(replace(replace(replace(
      regexp_replace(coalesce(p_text, ''), '<[^>]*>', ' ', 'g'),
      '&nbsp;', ' '), '&amp;', '&'), '&lt;', '<'), '&gt;', '>'), '&quot;', '"'), '&#39;', ''''),
    '\s+', ' ', 'g')), '')
$$;

/** Text cut to about p_max characters at a word boundary. */
create or replace function public._seo_clip(p_text text, p_max int)
returns text
language plpgsql
immutable
set search_path = public, pg_temp
as $$
declare
  v text := nullif(trim(coalesce(p_text, '')), '');
  v_cut text;
begin
  if v is null or length(v) <= p_max then
    return v;
  end if;
  v_cut := left(v, p_max - 1);
  if position(' ' in v_cut) > 0 then
    v_cut := regexp_replace(v_cut, '\s+\S*$', '');
  end if;
  return rtrim(v_cut, ' ,.;:-') || '…';
end;
$$;

/**
 * A template with {{name}}-style values ("{{short_description|description}}" takes the first
 * non-empty one). Values are inserted as they are: never read again as template text.
 */
create or replace function public._seo_render(p_tpl text, p_vars jsonb)
returns text
language plpgsql
immutable
set search_path = public, pg_temp
as $$
declare
  v_done text := '';
  v_rest text := coalesce(p_tpl, '');
  m text[];
  k text;
  v_val text;
  p int;
begin
  loop
    m := regexp_match(v_rest, '(\{\{\s*([a-z_]+(?:\|[a-z_]+)*)\s*\}\})');
    exit when m is null;
    v_val := null;
    foreach k in array string_to_array(m[2], '|') loop
      v_val := nullif(trim(coalesce(p_vars ->> k, '')), '');
      exit when v_val is not null;
    end loop;
    p := position(m[1] in v_rest);
    v_done := v_done || left(v_rest, p - 1) || coalesce(v_val, '');
    v_rest := substr(v_rest, p + length(m[1]));
  end loop;
  return nullif(trim(regexp_replace(v_done || v_rest, '\s+', ' ', 'g')), '');
end;
$$;

/** The names a template may use. */
create or replace function public._seo_template_vars()
returns text[]
language sql
immutable
as $$ select array['name', 'store', 'tagline', 'price', 'description', 'short_description', 'brand', 'category'] $$;

/**
 * Title and meta description for one item under the store's mode (see the top of this file).
 * p_kind: product | collection | page | home. Sources: manual, generated, auto (worked out
 * now), missing (manual mode, nothing written: the title falls back to the item's name).
 */
create or replace function public._seo_fields(p_kind text, p_name text, p_vars jsonb, p_title text, p_description text,
  p_sources jsonb, p_s jsonb)
returns jsonb
language plpgsql
immutable
set search_path = public, pg_temp
as $$
declare
  v_mode text := coalesce(p_s ->> 'mode', 'hybrid');
  v_tpl_kind text := case p_kind when 'home' then 'home' else p_kind end;
  v_store text := nullif(trim(coalesce(p_vars ->> 'store', '')), '');
  v_suffix text := public._seo_render(p_s ->> 'title_suffix', p_vars);
  v_title text := nullif(trim(coalesce(p_title, '')), '');
  v_desc text := nullif(trim(coalesce(p_description, '')), '');
  v_auto_title text;
  v_auto_desc text;
  v_fallback text;
  r_title text;
  r_desc text;
  s_title text;
  s_desc text;
begin
  -- Generated values.
  if coalesce((p_s #>> '{generate,title}')::boolean, true) then
    v_auto_title := public._seo_render(p_s #>> array['templates', v_tpl_kind || '_title'], p_vars);
  end if;
  v_auto_title := coalesce(v_auto_title, nullif(trim(coalesce(p_name, '')), ''), v_store);
  v_fallback := coalesce(nullif(trim(coalesce(p_name, '')), ''), v_store);
  -- The suffix: generated titles of inner pages, unless they already carry the store's name.
  if p_kind <> 'home' and v_suffix is not null and v_store is not null then
    if position(lower(v_store) in lower(coalesce(v_auto_title, ''))) = 0 then
      v_auto_title := v_auto_title || coalesce(p_s ->> 'title_suffix', '');
      v_auto_title := public._seo_render(v_auto_title, p_vars);
    end if;
    if position(lower(v_store) in lower(coalesce(v_fallback, ''))) = 0 then
      v_fallback := public._seo_render(v_fallback || coalesce(p_s ->> 'title_suffix', ''), p_vars);
    end if;
  end if;
  if coalesce((p_s #>> '{generate,description}')::boolean, true) then
    v_auto_desc := public._seo_clip(public._seo_render(p_s #>> array['templates', v_tpl_kind || '_description'], p_vars), 160);
  end if;

  if v_mode = 'automatic' then
    r_title := v_auto_title; s_title := 'auto';
    r_desc := v_auto_desc; s_desc := case when v_auto_desc is null then 'missing' else 'auto' end;
  elsif v_mode = 'manual' then
    r_title := coalesce(v_title, v_fallback);
    s_title := case when v_title is null then 'missing' else coalesce(p_sources ->> 'title', 'manual') end;
    r_desc := v_desc;
    s_desc := case when v_desc is null then 'missing' else coalesce(p_sources ->> 'description', 'manual') end;
  else
    r_title := coalesce(v_title, v_auto_title);
    s_title := case when v_title is null then 'auto' else coalesce(p_sources ->> 'title', 'manual') end;
    r_desc := coalesce(v_desc, v_auto_desc);
    s_desc := case when v_desc is not null then coalesce(p_sources ->> 'description', 'manual') when v_auto_desc is null then 'missing' else 'auto' end;
  end if;
  return jsonb_build_object('title', r_title, 'description', r_desc, 'title_source', s_title, 'description_source', s_desc,
    'auto_title', v_auto_title, 'auto_description', v_auto_desc);
end;
$$;

-- ---------------------------------------------------------------------------------------------
-- The store's address and facts
-- ---------------------------------------------------------------------------------------------

/** https://<primary domain> (else the store's subdomain), or null when the store has no address yet. */
create or replace function public._seo_base_url()
returns text
language plpgsql
stable
security definer
set search_path = public, pg_temp
as $$
declare
  v_merchant uuid := public.current_merchant_id();
  v_domain text;
  v_root text := public._store_root_domain();
  v_slug text;
begin
  select d.domain into v_domain from public.store_domains d
  where d.merchant_id = v_merchant and d.status = 'ACTIVE' and d.verified_at is not null and d.removed_at is null
  order by d.is_primary desc, d.created_at limit 1;
  if v_domain is not null then
    return 'https://' || v_domain;
  end if;
  select m.slug into v_slug from public.merchants m where m.id = v_merchant;
  if v_root is not null and v_slug is not null then
    return 'https://' || v_slug || '.' || v_root;
  end if;
  return null;
end;
$$;

/** The values store-wide templates may use. */
create or replace function public._seo_store_vars()
returns jsonb
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  select jsonb_build_object('store', nullif(trim(coalesce(s ->> 'name', '')), ''), 'tagline', nullif(trim(coalesce(s ->> 'tagline', '')), ''))
  from (select public.get_setting('store') as s) x
$$;

/** "৳1,290" (the store's currency symbol), or null for no price. */
create or replace function public._seo_price_text(p_price numeric)
returns text
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  select case when coalesce(p_price, 0) > 0
    then coalesce(nullif(public.get_setting('store') ->> 'currency_symbol', ''), '৳') || to_char(p_price, 'FM999,999,999,990.##') end
$$;

/** Store pages that have their own SEO (with their names). */
create or replace function public._seo_pages()
returns table (key text, name text, path text)
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  select * from (values ('home', null::text, '/'), ('shop', 'All products', '/shop'), ('contact', 'Contact', '/contact'),
    ('track-order', 'Track your order', '/track-order'), ('policies', 'Policies', '/policies')) v(key, name, path)
  union all
  select 'policies/' || k, initcap(k) || ' policy', '/policies/' || k
  from jsonb_each_text(public.get_setting('policies')) p(k, v)
  where k ~ '^[a-z][a-z0-9_-]{0,30}$' and nullif(trim(v), '') is not null
$$;

/** The SEO picture of one item (product, collection or page), as the store would show it now. */
create or replace function public._seo_item(p_type text, p_key text, p_s jsonb default null)
returns jsonb
language plpgsql
stable
security definer
set search_path = public, pg_temp
as $$
declare
  s jsonb := coalesce(p_s, public._seo_settings());
  vars jsonb := public._seo_store_vars();
  e public.seo_entries;
  p public.products;
  c public.categories;
  v_name text;
  v_path text;
  v_kind text := p_type;
  v_title text;
  v_desc text;
  v_slug text;
  v_active boolean := true;
  v_image text;
  v_fields jsonb;
  v_type_indexed boolean;
  v_robots text;
begin
  select * into e from public.seo_entries where entity_type = p_type and entity_key = p_key;
  if p_type = 'product' then
    select * into p from public.products where id::text = p_key;
    if p.id is null then return null; end if;
    v_name := p.name; v_slug := p.slug; v_path := '/product/' || p.slug; v_active := p.status = 'ACTIVE';
    v_title := p.seo_title; v_desc := p.seo_description;
    v_image := (select i.url from public.product_images i where i.product_id = p.id order by i.is_primary desc, i.position limit 1);
    vars := vars || jsonb_build_object('name', p.name, 'description', public._seo_clip(public._seo_plain(p.description), 300),
      'short_description', public._seo_clip(public._seo_plain(p.short_description), 300), 'brand', p.brand,
      'price', public._seo_price_text(p.price),
      'category', (select k.name from public.categories k where k.id = p.category_id));
    v_type_indexed := coalesce((s #>> '{indexing,products}')::boolean, true);
  elsif p_type = 'collection' then
    select * into c from public.categories where id::text = p_key;
    if c.id is null then return null; end if;
    v_name := c.name; v_slug := c.slug; v_path := '/collection/' || c.slug; v_active := c.is_active;
    v_title := c.seo_title; v_desc := c.seo_description; v_image := c.image_url;
    vars := vars || jsonb_build_object('name', c.name, 'description', public._seo_clip(public._seo_plain(c.description), 300));
    v_type_indexed := coalesce((s #>> '{indexing,collections}')::boolean, true);
  elsif p_type = 'page' then
    select pg.name, pg.path into v_name, v_path from public._seo_pages() pg where pg.key = p_key;
    if v_path is null then return null; end if;
    if p_key = 'home' then v_kind := 'home'; v_name := vars ->> 'store'; end if;
    v_title := e.title; v_desc := e.description;
    vars := vars || jsonb_build_object('name', v_name);
    v_type_indexed := coalesce((s #>> '{indexing,pages}')::boolean, true) or p_key = 'home';
  else
    return null;
  end if;

  v_fields := public._seo_fields(v_kind, v_name, vars, v_title, v_desc, coalesce(e.sources, '{}'::jsonb), s);
  v_robots := case when not coalesce((s #>> '{indexing,store}')::boolean, true) or not v_type_indexed
                     or coalesce(e.noindex, false) or not v_active then 'noindex,follow' else 'index,follow' end;
  return v_fields || jsonb_build_object(
    'type', p_type, 'key', p_key, 'name', v_name, 'path', v_path, 'slug', v_slug, 'active', v_active,
    'stored_title', nullif(trim(coalesce(v_title, '')), ''), 'stored_description', nullif(trim(coalesce(v_desc, '')), ''),
    'sources', coalesce(e.sources, '{}'::jsonb),
    'canonical_url', case when coalesce(s ->> 'mode', 'hybrid') <> 'automatic' then e.canonical_url end,
    'custom_canonical', e.canonical_url,
    'noindex', coalesce(e.noindex, false),
    'robots', v_robots,
    'focus_keyword', e.focus_keyword,
    'og_image', coalesce(nullif(e.og_image, ''), v_image, nullif(s #>> '{social,og_image}', ''), nullif(public.get_setting('store') ->> 'logo_url', '')),
    'custom_og_image', e.og_image,
    'image', v_image,
    'updated_at', e.updated_at);
end;
$$;

-- ---------------------------------------------------------------------------------------------
-- What a store page shows (the Worker puts it in the page; the store updates it on navigation)
-- ---------------------------------------------------------------------------------------------

/** A path as the store compares it: no query, fragment or trailing slash. */
create or replace function public._seo_clean_path(p_path text)
returns text
language sql
immutable
set search_path = public, pg_temp
as $$
  select coalesce(nullif(regexp_replace(regexp_replace(split_part(split_part(coalesce(p_path, '/'), '#', 1), '?', 1), '/{2,}', '/', 'g'), '(.)/+$', '\1'), ''), '/')
$$;

/** Schema.org data for a product: only stored facts (price and stock only when known). */
create or replace function public._seo_product_ld(p_id uuid, p_url text)
returns jsonb
language plpgsql
stable
security definer
set search_path = public, pg_temp
as $$
declare
  p public.products;
  v_currency text := coalesce(nullif(public.get_setting('store') ->> 'currency', ''), 'BDT');
  v_low numeric;
  v_high numeric;
  v_count int;
  v_in_stock boolean;
  v_offer jsonb;
  ld jsonb;
begin
  select * into p from public.products where id = p_id and status = 'ACTIVE';
  if p.id is null then return null; end if;
  select min(coalesce(v.price, p.price)), max(coalesce(v.price, p.price)), count(*),
         bool_or(coalesce(i.available, 0) > 0)
    into v_low, v_high, v_count, v_in_stock
  from public.product_variants v left join public.inventory i on i.variant_id = v.id
  where v.product_id = p.id and v.is_active;
  if v_count = 0 then
    v_low := p.price; v_high := p.price; v_count := 1; v_in_stock := null;
  end if;
  ld := jsonb_build_object('@context', 'https://schema.org', '@type', 'Product', 'name', p.name);
  if public._seo_plain(p.description) is not null or public._seo_plain(p.short_description) is not null then
    ld := ld || jsonb_build_object('description', public._seo_clip(coalesce(public._seo_plain(p.short_description), public._seo_plain(p.description)), 500));
  end if;
  if exists (select 1 from public.product_images i where i.product_id = p.id) then
    ld := ld || jsonb_build_object('image', (select jsonb_agg(x.url) from (select i.url from public.product_images i
      where i.product_id = p.id order by i.is_primary desc, i.position limit 6) x));
  end if;
  if nullif(trim(coalesce(p.sku, '')), '') is not null then ld := ld || jsonb_build_object('sku', p.sku); end if;
  if nullif(trim(coalesce(p.brand, '')), '') is not null then ld := ld || jsonb_build_object('brand', jsonb_build_object('@type', 'Brand', 'name', p.brand)); end if;
  if coalesce(v_low, 0) > 0 then
    if v_low = v_high then
      v_offer := jsonb_build_object('@type', 'Offer', 'price', v_low, 'priceCurrency', v_currency);
    else
      v_offer := jsonb_build_object('@type', 'AggregateOffer', 'lowPrice', v_low, 'highPrice', v_high, 'offerCount', v_count, 'priceCurrency', v_currency);
    end if;
    if p_url is not null then v_offer := v_offer || jsonb_build_object('url', p_url); end if;
    -- Availability only when the store counts stock (and does not sell beyond it).
    if p.track_inventory and not public.allow_overselling() and v_in_stock is not null then
      v_offer := v_offer || jsonb_build_object('availability', case when v_in_stock then 'https://schema.org/InStock' else 'https://schema.org/OutOfStock' end);
    end if;
    ld := ld || jsonb_build_object('offers', v_offer);
  end if;
  return ld;
end;
$$;

/** BreadcrumbList from (name, path) pairs. */
create or replace function public._seo_breadcrumbs(p_items jsonb, p_base text)
returns jsonb
language sql
immutable
set search_path = public, pg_temp
as $$
  select jsonb_build_object('@context', 'https://schema.org', '@type', 'BreadcrumbList', 'itemListElement',
    (select jsonb_agg(jsonb_build_object('@type', 'ListItem', 'position', n, 'name', x ->> 'name',
       'item', coalesce(p_base, '') || (x ->> 'path')) order by n)
     from jsonb_array_elements(p_items) with ordinality t(x, n)))
$$;

/**
 * Everything the head of a store page needs, for the store this request belongs to:
 * title, description, canonical address, robots, sharing tags and structured data, or a
 * redirect / not found. Private pages (cart, checkout, account, sign-in) are never indexed.
 */
create or replace function public.storefront_seo(p_path text)
returns jsonb
language plpgsql
stable
security definer
set search_path = public, pg_temp
as $$
declare
  s jsonb := public._seo_settings();
  v_path text := public._seo_clean_path(p_path);
  v_base text := public._seo_base_url();
  v_store jsonb := public.get_setting('store');
  v_store_name text := coalesce(nullif(trim(v_store ->> 'name'), ''), 'Store');
  v_lang text := coalesce(nullif(v_store ->> 'locale', ''), 'en');
  v_seg text[] := string_to_array(trim(both '/' from v_path), '/');
  v_item jsonb;
  v_type text;
  v_key text;
  v_redirect text;
  v_ld jsonb := '[]'::jsonb;
  v_crumbs jsonb;
  p public.products;
  c public.categories;
  v_social jsonb;
begin
  -- A redirect kept for an old address wins (product and collection addresses that changed).
  select r.to_path into v_redirect from public.seo_redirects r where r.from_path = v_path;
  if v_redirect is not null then
    return jsonb_build_object('status', 301, 'redirect', v_redirect, 'path', v_path);
  end if;

  if v_path = '/' then
    v_type := 'page'; v_key := 'home';
  elsif v_seg[1] = 'product' and array_length(v_seg, 1) = 2 then
    select * into p from public.products where slug = v_seg[2] and status = 'ACTIVE';
    if p.id is not null then v_type := 'product'; v_key := p.id::text; end if;
  elsif v_seg[1] = 'collection' and array_length(v_seg, 1) = 2 then
    select * into c from public.categories where slug = v_seg[2] and is_active;
    if c.id is not null then v_type := 'collection'; v_key := c.id::text; end if;
  elsif v_path in ('/shop', '/contact', '/track-order', '/policies') or v_path ~ '^/policies/[a-z][a-z0-9_-]{0,30}$' then
    v_type := 'page'; v_key := substr(v_path, 2);
  elsif v_path = '/search' then
    return jsonb_build_object('status', 200, 'path', v_path, 'type', 'search', 'lang', v_lang,
      'title', 'Search' || coalesce(public._seo_render(s ->> 'title_suffix', public._seo_store_vars()), ''),
      'robots', case when coalesce((s #>> '{indexing,search}')::boolean, false) and coalesce((s #>> '{indexing,store}')::boolean, true)
                     then 'index,follow' else 'noindex,follow' end,
      'canonical', coalesce(v_base, '') || v_path, 'jsonld', '[]'::jsonb);
  elsif v_seg[1] in ('cart', 'checkout', 'order-success', 'login', 'register', 'forgot-password', 'reset-password', 'account') then
    return jsonb_build_object('status', 200, 'path', v_path, 'type', 'private', 'lang', v_lang,
      'title', initcap(replace(v_seg[1], '-', ' ')) || ' | ' || v_store_name, 'robots', 'noindex,nofollow', 'jsonld', '[]'::jsonb);
  end if;

  if v_type is not null then
    v_item := public._seo_item(v_type, v_key, s);
  end if;
  if v_item is null then
    return jsonb_build_object('status', 404, 'path', v_path, 'type', 'missing', 'lang', v_lang,
      'title', 'Page not found | ' || v_store_name, 'robots', 'noindex,follow', 'jsonld', '[]'::jsonb);
  end if;

  -- Structured data: only what is switched on, and only from stored facts.
  if v_type = 'product' and coalesce((s #>> '{structured_data,product}')::boolean, true) then
    v_ld := v_ld || jsonb_build_array(public._seo_product_ld(p.id, coalesce(v_base, '') || v_path));
  end if;
  if v_type in ('product', 'collection') and coalesce((s #>> '{structured_data,breadcrumbs}')::boolean, true) then
    v_crumbs := jsonb_build_array(jsonb_build_object('name', v_store_name, 'path', '/'));
    if v_type = 'product' and p.category_id is not null then
      v_crumbs := v_crumbs || coalesce((select jsonb_build_array(jsonb_build_object('name', k.name, 'path', '/collection/' || k.slug))
                                        from public.categories k where k.id = p.category_id and k.is_active), '[]'::jsonb);
    end if;
    v_crumbs := v_crumbs || jsonb_build_array(jsonb_build_object('name', v_item ->> 'name', 'path', v_path));
    v_ld := v_ld || jsonb_build_array(public._seo_breadcrumbs(v_crumbs, v_base));
  end if;
  if v_key = 'home' and v_type = 'page' then
    if coalesce((s #>> '{structured_data,organization}')::boolean, true) then
      v_social := coalesce((select jsonb_agg(case when x.v ~ '^https?://' then x.v else 'https://' || x.k || '.com/' || ltrim(x.v, '@') end)
                            from jsonb_each_text(coalesce(v_store -> 'social', '{}'::jsonb)) x(k, v)
                            where x.k in ('facebook', 'instagram', 'tiktok', 'youtube', 'twitter') and nullif(trim(x.v), '') is not null), '[]'::jsonb);
      v_ld := v_ld || jsonb_build_array(jsonb_strip_nulls(jsonb_build_object('@context', 'https://schema.org', '@type', 'Organization',
        'name', v_store_name, 'url', v_base || '/', 'logo', nullif(v_store ->> 'logo_url', ''),
        'email', nullif(trim(coalesce(v_store ->> 'email', '')), ''), 'telephone', nullif(trim(coalesce(v_store ->> 'phone', '')), ''),
        'sameAs', case when jsonb_array_length(v_social) > 0 then v_social end)));
    end if;
    if coalesce((s #>> '{structured_data,website}')::boolean, true) and v_base is not null then
      v_ld := v_ld || jsonb_build_array(jsonb_build_object('@context', 'https://schema.org', '@type', 'WebSite', 'name', v_store_name,
        'url', v_base || '/', 'potentialAction', jsonb_build_object('@type', 'SearchAction',
          'target', v_base || '/search?q={search_term_string}', 'query-input', 'required name=search_term_string')));
    end if;
  end if;

  return jsonb_build_object(
    'status', 200, 'path', v_path, 'type', v_type, 'lang', v_lang,
    'title', v_item ->> 'title', 'description', v_item ->> 'description',
    'canonical', coalesce(v_item ->> 'canonical_url', coalesce(v_base, '') || v_path),
    'robots', v_item ->> 'robots',
    'og', jsonb_strip_nulls(jsonb_build_object('type', case when v_type = 'product' then 'product' else 'website' end,
      'title', v_item ->> 'title', 'description', v_item ->> 'description', 'image', v_item ->> 'og_image',
      'site_name', v_store_name, 'url', coalesce(v_item ->> 'canonical_url', case when v_base is not null then v_base || v_path end))),
    'twitter', jsonb_strip_nulls(jsonb_build_object('card', case when v_item ->> 'og_image' is not null then 'summary_large_image' else 'summary' end,
      'site', nullif(s #>> '{social,twitter_site}', ''))),
    'jsonld', v_ld);
end;
$$;

/** The store's settings and this page's SEO in one answer (the Worker's call for a page). */
create or replace function public.storefront_page(p_path text)
returns jsonb
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  select jsonb_build_object('config', public.storefront_config(), 'seo', public.storefront_seo(p_path))
$$;

/** The store's public pages for sitemap.xml (empty when the sitemap or indexing is off). */
create or replace function public.storefront_sitemap()
returns jsonb
language plpgsql
stable
security definer
set search_path = public, pg_temp
as $$
declare
  s jsonb := public._seo_settings();
  v_base text := public._seo_base_url();
  v_on boolean := coalesce((s #>> '{sitemap,enabled}')::boolean, true) and coalesce((s #>> '{indexing,store}')::boolean, true);
  v_urls jsonb := '[]'::jsonb;
begin
  if not v_on then
    return jsonb_build_object('enabled', false, 'base', v_base, 'urls', '[]'::jsonb);
  end if;
  -- Store pages (the home page always), minus any marked noindex.
  v_urls := coalesce((select jsonb_agg(jsonb_build_object('path', pg.path, 'lastmod', e.updated_at) order by pg.path)
    from public._seo_pages() pg left join public.seo_entries e on e.entity_type = 'page' and e.entity_key = pg.key
    where (pg.key = 'home' or (coalesce((s #>> '{sitemap,pages}')::boolean, true) and coalesce((s #>> '{indexing,pages}')::boolean, true)
                                and pg.key not in ('track-order')))
      and not coalesce(e.noindex, false)), '[]'::jsonb);
  if coalesce((s #>> '{sitemap,collections}')::boolean, true) and coalesce((s #>> '{indexing,collections}')::boolean, true) then
    v_urls := v_urls || coalesce((select jsonb_agg(jsonb_build_object('path', '/collection/' || k.slug, 'lastmod', k.updated_at) order by k.slug)
      from public.categories k left join public.seo_entries e on e.entity_type = 'collection' and e.entity_key = k.id::text
      where k.is_active and not coalesce(e.noindex, false)
        and exists (select 1 from public.products p where p.status = 'ACTIVE'
                    and (p.category_id = k.id or k.id = any (coalesce(p.extra_category_ids, '{}'))))), '[]'::jsonb);
  end if;
  if coalesce((s #>> '{sitemap,products}')::boolean, true) and coalesce((s #>> '{indexing,products}')::boolean, true) then
    v_urls := v_urls || coalesce((select jsonb_agg(jsonb_build_object('path', '/product/' || p.slug, 'lastmod', p.updated_at) order by p.created_at)
      from public.products p left join public.seo_entries e on e.entity_type = 'product' and e.entity_key = p.id::text
      where p.status = 'ACTIVE' and not coalesce(e.noindex, false)), '[]'::jsonb);
  end if;
  return jsonb_build_object('enabled', true, 'base', v_base, 'urls', v_urls);
end;
$$;

/** What robots.txt says for the store. */
create or replace function public.storefront_robots()
returns jsonb
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  select jsonb_build_object('indexable', coalesce((s #>> '{indexing,store}')::boolean, true),
    'sitemap', coalesce((s #>> '{sitemap,enabled}')::boolean, true), 'base', public._seo_base_url())
  from (select public._seo_settings() as s) x
$$;

-- ---------------------------------------------------------------------------------------------
-- Staff: settings, one item, bulk changes, redirects
-- ---------------------------------------------------------------------------------------------

create or replace function public.seo_settings_get()
returns jsonb
language plpgsql
stable
security definer
set search_path = public, pg_temp
as $$
begin
  if not public.is_staff() then
    raise exception 'PERMISSION_DENIED: staff only' using errcode = '42501';
  end if;
  return jsonb_build_object(
    'settings', public._seo_settings(),
    'saved', (select value from public.settings where key = 'seo'),
    'saved_at', (select updated_at from public.settings where key = 'seo'),
    'base_url', public._seo_base_url(),
    'store', public._seo_store_vars(),
    'template_vars', to_jsonb(public._seo_template_vars()),
    'counts', jsonb_build_object(
      'products', (select count(*) from public.products where status = 'ACTIVE'),
      'collections', (select count(*) from public.categories where is_active),
      'pages', (select count(*) from public._seo_pages()),
      'manual_titles', (select count(*) from public.products where nullif(trim(coalesce(seo_title, '')), '') is not null)
        + (select count(*) from public.categories where nullif(trim(coalesce(seo_title, '')), '') is not null)
        + (select count(*) from public.seo_entries where entity_type = 'page' and nullif(trim(coalesce(title, '')), '') is not null)),
    'ai_available', false);
end;
$$;

/** Checks and saves the SEO settings (mode, generation, templates, indexing, sitemap, …). */
create or replace function public.seo_settings_save(p_value jsonb)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  d jsonb := public._seo_defaults();
  g text;
  k text;
  v jsonb;
  t text;
  m text[];
  v_rest text;
  v_tok text;
begin
  perform public.require_permission('settings.manage');
  if p_value is null or jsonb_typeof(p_value) <> 'object' then
    raise exception 'VALIDATION: SEO settings must be a JSON object' using errcode = '22023';
  end if;
  if exists (select 1 from jsonb_object_keys(p_value) x where not (d ? x)) then
    raise exception 'VALIDATION: unknown SEO setting' using errcode = '22023';
  end if;
  if coalesce(p_value ->> 'mode', 'hybrid') not in ('automatic', 'manual', 'hybrid') then
    raise exception 'VALIDATION: the SEO mode is Automatic, Manual or Hybrid' using errcode = '22023';
  end if;
  -- Grouped settings: known keys, and switches are true / false.
  foreach g in array array['generate', 'structured_data', 'sitemap', 'indexing', 'ai'] loop
    if p_value ? g then
      if jsonb_typeof(p_value -> g) <> 'object' then
        raise exception 'VALIDATION: % must be a group of switches', g using errcode = '22023';
      end if;
      for k, v in select x.key, x.value from jsonb_each(p_value -> g) x loop
        if not ((d -> g) ? k) or jsonb_typeof(v) <> 'boolean' then
          raise exception 'VALIDATION: %.% must be on or off', g, k using errcode = '22023';
        end if;
      end loop;
    end if;
  end loop;
  if p_value ? 'templates' then
    if jsonb_typeof(p_value -> 'templates') <> 'object' then
      raise exception 'VALIDATION: templates must be a group of texts' using errcode = '22023';
    end if;
    for k, v in select x.key, x.value from jsonb_each(p_value -> 'templates') x loop
      if not ((d -> 'templates') ? k) or jsonb_typeof(v) <> 'string' or length(v #>> '{}') > 300 then
        raise exception 'VALIDATION: the % template must be text of up to 300 characters', replace(k, '_', ' ') using errcode = '22023';
      end if;
    end loop;
  end if;
  -- Every {{value}} in a template or the suffix is one the store knows.
  for t in select x.value from jsonb_each_text(coalesce(p_value -> 'templates', '{}'::jsonb)) x
           union all select coalesce(p_value ->> 'title_suffix', '') loop
    v_rest := t;
    loop
      m := regexp_match(v_rest, '\{\{\s*([^}]*?)\s*\}\}');
      exit when m is null;
      foreach v_tok in array string_to_array(m[1], '|') loop
        if not (trim(v_tok) = any (public._seo_template_vars())) then
          raise exception 'VALIDATION: {{%}} is not a value templates can use (use: %)', trim(v_tok),
            array_to_string(public._seo_template_vars(), ', ') using errcode = '22023';
        end if;
      end loop;
      v_rest := substr(v_rest, position(m[1] in v_rest) + length(m[1]) + 2);
    end loop;
  end loop;
  if p_value ? 'title_suffix' and (jsonb_typeof(p_value -> 'title_suffix') <> 'string' or length(p_value ->> 'title_suffix') > 80) then
    raise exception 'VALIDATION: the title suffix must be text of up to 80 characters' using errcode = '22023';
  end if;
  if p_value ? 'social' then
    if jsonb_typeof(p_value -> 'social') <> 'object' or exists (select 1 from jsonb_object_keys(p_value -> 'social') x where not ((d -> 'social') ? x)) then
      raise exception 'VALIDATION: unknown sharing setting' using errcode = '22023';
    end if;
    if coalesce(p_value #>> '{social,og_image}', '') !~ '^(|https?://\S+|/\S+)$' then
      raise exception 'VALIDATION: the sharing image must be a web address' using errcode = '22023';
    end if;
    if coalesce(p_value #>> '{social,twitter_site}', '') !~ '^(|@?[A-Za-z0-9_]{1,15})$' then
      raise exception 'VALIDATION: the X (Twitter) account is a handle like @yourstore' using errcode = '22023';
    end if;
  end if;
  if p_value ? 'new_items' then
    if jsonb_typeof(p_value -> 'new_items') <> 'object' then
      raise exception 'VALIDATION: new_items must be a group' using errcode = '22023';
    end if;
    for k, v in select x.key, x.value from jsonb_each(p_value -> 'new_items') x loop
      if not ((d -> 'new_items') ? k) or coalesce(v #>> '{}', '') not in ('auto', 'fill') then
        raise exception 'VALIDATION: new % use auto or fill', k using errcode = '22023';
      end if;
    end loop;
  end if;
  insert into public.settings (merchant_id, key, value, is_public, description, updated_by, updated_at)
  values (public.current_merchant_id(), 'seo', p_value, false, 'Store SEO settings', auth.uid(), now())
  on conflict (merchant_id, key) do update set value = excluded.value, updated_by = excluded.updated_by, updated_at = now();
  return public._seo_settings();
end;
$$;

/** One item's SEO for its editor panel: what is stored, what would be generated, what shows. */
create or replace function public.seo_item_get(p_type text, p_key text)
returns jsonb
language plpgsql
stable
security definer
set search_path = public, pg_temp
as $$
declare
  v jsonb;
begin
  if not public.is_staff() then
    raise exception 'PERMISSION_DENIED: staff only' using errcode = '42501';
  end if;
  v := public._seo_item(p_type, p_key);
  if v is null then
    raise exception 'NOT_FOUND: that item does not exist' using errcode = 'P0002';
  end if;
  return v || jsonb_build_object('mode', public._seo_settings() ->> 'mode', 'base_url', public._seo_base_url(),
    'images', case when p_type = 'product' then coalesce((select jsonb_agg(jsonb_build_object('id', i.id, 'url', i.url, 'alt', i.alt,
        'suggested_alt', public._seo_alt_suggestion(i.id)) order by i.is_primary desc, i.position)
      from public.product_images i where i.product_id::text = p_key), '[]'::jsonb) end);
end;
$$;

/** A suggested alt text for a product image from the product's own details. */
create or replace function public._seo_alt_suggestion(p_image uuid)
returns text
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  select left(concat_ws(' – ', p.name, nullif(concat_ws(' ', nullif(trim(coalesce(v.color, '')), ''), nullif(trim(coalesce(v.size, '')), '')), ''),
           case when (select count(*) from public.product_images x where x.product_id = p.id) > 1 and not i.is_primary
                then 'view ' || (1 + (select count(*) from public.product_images x where x.product_id = p.id
                                      and (x.is_primary or x.position < i.position))) end), 200)
  from public.product_images i join public.products p on p.id = i.product_id
  left join public.product_variants v on v.id = i.variant_id
  where i.id = p_image
$$;

/**
 * Saves one item's SEO. Keys (each optional): title, description (text: written by the merchant;
 * null: back to generated), slug (products / collections), canonical_url, noindex,
 * focus_keyword, og_image, image_alts ([{id, alt}], products).
 */
create or replace function public.seo_item_save(p_type text, p_key text, p_value jsonb)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  e public.seo_entries;
  v_sources jsonb;
  v_text text;
  v_slug text;
  x jsonb;
  v_exists boolean;
begin
  if p_type in ('product', 'collection') then
    perform public.require_permission('products.manage');
  elsif p_type = 'page' then
    perform public.require_permission('settings.manage');
  else
    raise exception 'VALIDATION: unknown item type' using errcode = '22023';
  end if;
  if p_value is null or jsonb_typeof(p_value) <> 'object'
     or exists (select 1 from jsonb_object_keys(p_value) k where k not in ('title', 'description', 'slug', 'canonical_url', 'noindex', 'focus_keyword', 'og_image', 'image_alts')) then
    raise exception 'VALIDATION: unknown SEO field' using errcode = '22023';
  end if;
  v_exists := case p_type
    when 'product' then exists (select 1 from public.products where id::text = p_key)
    when 'collection' then exists (select 1 from public.categories where id::text = p_key)
    else exists (select 1 from public._seo_pages() pg where pg.key = p_key) end;
  if not v_exists then
    raise exception 'NOT_FOUND: that item does not exist' using errcode = 'P0002';
  end if;

  insert into public.seo_entries (merchant_id, entity_type, entity_key, updated_by)
  values (public.current_merchant_id(), p_type, p_key, auth.uid())
  on conflict (merchant_id, entity_type, entity_key) do nothing;
  select * into e from public.seo_entries where entity_type = p_type and entity_key = p_key for update;
  v_sources := e.sources;

  -- Title and description: text is the merchant's own; null hands the field back to generation.
  if p_value ? 'title' then
    v_text := nullif(trim(coalesce(p_value ->> 'title', '')), '');
    if length(v_text) > 300 then raise exception 'VALIDATION: the SEO title is too long (300 characters at most)' using errcode = '22023'; end if;
    v_sources := case when v_text is null then v_sources - 'title' else v_sources || '{"title": "manual"}' end;
    if p_type = 'product' then update public.products set seo_title = v_text where id::text = p_key;
    elsif p_type = 'collection' then update public.categories set seo_title = v_text where id::text = p_key;
    else update public.seo_entries set title = v_text where entity_type = p_type and entity_key = p_key; end if;
  end if;
  if p_value ? 'description' then
    v_text := nullif(trim(coalesce(p_value ->> 'description', '')), '');
    if length(v_text) > 1000 then raise exception 'VALIDATION: the meta description is too long (1000 characters at most)' using errcode = '22023'; end if;
    v_sources := case when v_text is null then v_sources - 'description' else v_sources || '{"description": "manual"}' end;
    if p_type = 'product' then update public.products set seo_description = v_text where id::text = p_key;
    elsif p_type = 'collection' then update public.categories set seo_description = v_text where id::text = p_key;
    else update public.seo_entries set description = v_text where entity_type = p_type and entity_key = p_key; end if;
  end if;
  -- The address: lower-case words and dashes, free in the store; the old one keeps a redirect.
  if p_value ? 'slug' then
    if p_type = 'page' then raise exception 'VALIDATION: store page addresses are fixed' using errcode = '22023'; end if;
    v_slug := lower(trim(coalesce(p_value ->> 'slug', '')));
    if v_slug !~ '^[a-z0-9]+(-[a-z0-9]+)*$' or length(v_slug) > 80 then
      raise exception 'VALIDATION: the address may use lower-case letters, digits and dashes (up to 80)' using errcode = '22023';
    end if;
    if p_type = 'product' then
      if exists (select 1 from public.products where slug = v_slug and id::text <> p_key) then
        raise exception 'VALIDATION: another product already uses this address' using errcode = '23505';
      end if;
      update public.products set slug = v_slug where id::text = p_key and slug is distinct from v_slug;
    else
      if exists (select 1 from public.categories where slug = v_slug and id::text <> p_key) then
        raise exception 'VALIDATION: another collection already uses this address' using errcode = '23505';
      end if;
      update public.categories set slug = v_slug where id::text = p_key and slug is distinct from v_slug;
    end if;
    v_sources := v_sources || '{"slug": "manual"}';
  end if;
  if p_value ? 'canonical_url' then
    v_text := nullif(trim(coalesce(p_value ->> 'canonical_url', '')), '');
    if v_text is not null and (v_text !~ '^https://[^\s]+$' or length(v_text) > 500) then
      raise exception 'VALIDATION: the canonical address must be a full https:// address' using errcode = '22023';
    end if;
    update public.seo_entries set canonical_url = v_text where entity_type = p_type and entity_key = p_key;
  end if;
  if p_value ? 'noindex' then
    if jsonb_typeof(p_value -> 'noindex') <> 'boolean' then raise exception 'VALIDATION: noindex is on or off' using errcode = '22023'; end if;
    update public.seo_entries set noindex = (p_value ->> 'noindex')::boolean where entity_type = p_type and entity_key = p_key;
  end if;
  if p_value ? 'focus_keyword' then
    v_text := nullif(trim(coalesce(p_value ->> 'focus_keyword', '')), '');
    if length(v_text) > 100 then raise exception 'VALIDATION: the focus keyword is too long' using errcode = '22023'; end if;
    update public.seo_entries set focus_keyword = v_text where entity_type = p_type and entity_key = p_key;
  end if;
  if p_value ? 'og_image' then
    v_text := nullif(trim(coalesce(p_value ->> 'og_image', '')), '');
    if v_text is not null and v_text !~ '^(https?://|/)[^\s]+$' then
      raise exception 'VALIDATION: the sharing image must be a web address' using errcode = '22023';
    end if;
    update public.seo_entries set og_image = v_text where entity_type = p_type and entity_key = p_key;
  end if;
  if p_value ? 'image_alts' then
    if p_type <> 'product' or jsonb_typeof(p_value -> 'image_alts') <> 'array' then
      raise exception 'VALIDATION: image texts are a list for a product' using errcode = '22023';
    end if;
    for x in select * from jsonb_array_elements(p_value -> 'image_alts') loop
      if length(x ->> 'alt') > 250 then raise exception 'VALIDATION: image texts are 250 characters at most' using errcode = '22023'; end if;
      update public.product_images set alt = nullif(trim(coalesce(x ->> 'alt', '')), '')
      where id::text = x ->> 'id' and product_id::text = p_key;
    end loop;
  end if;
  update public.seo_entries set sources = v_sources, updated_by = auth.uid(), updated_at = now()
  where entity_type = p_type and entity_key = p_key;
  return public.seo_item_get(p_type, p_key);
end;
$$;

/**
 * Bulk changes, asked for explicitly (the admin confirms first). p_items: [{type, key}], or null
 * for every product, collection and page. Fields the merchant wrote are never touched unless
 * p_include_manual. Actions:
 *   generate  store the generated title and description (source "generated");
 *   reset     clear stored titles and descriptions (back to generated);
 *   alt_text  fill empty product image texts with suggestions;
 *   index     let search engines index the items again (noindex off).
 */
create or replace function public.seo_bulk(p_action text, p_items jsonb default null, p_include_manual boolean default false)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  s jsonb := public._seo_settings() || '{"mode": "hybrid", "generate": {"title": true, "description": true, "alt_text": true}}'::jsonb;
  r record;
  v jsonb;
  e public.seo_entries;
  v_changed int := 0;
  v_skipped int := 0;
  v_title_manual boolean;
  v_desc_manual boolean;
  n int;
begin
  perform public.require_permission('products.manage');
  perform public.require_permission('settings.manage');
  if p_action not in ('generate', 'reset', 'alt_text', 'index') then
    raise exception 'VALIDATION: unknown bulk action' using errcode = '22023';
  end if;
  if p_items is not null and (jsonb_typeof(p_items) <> 'array' or jsonb_array_length(p_items) > 5000) then
    raise exception 'VALIDATION: items must be a list (5000 at most)' using errcode = '22023';
  end if;
  for r in
    select x ->> 'type' as type, x ->> 'key' as key from jsonb_array_elements(coalesce(p_items, '[]'::jsonb)) x
    where p_items is not null
    union all
    select 'product', id::text from public.products where p_items is null and status <> 'ARCHIVED'
    union all
    select 'collection', id::text from public.categories where p_items is null
    union all
    select 'page', pg.key from public._seo_pages() pg where p_items is null
  loop
    if r.type not in ('product', 'collection', 'page') then continue; end if;
    if p_action = 'alt_text' then
      if r.type = 'product' then
        update public.product_images i set alt = public._seo_alt_suggestion(i.id)
        where i.product_id::text = r.key and nullif(trim(coalesce(i.alt, '')), '') is null;
        get diagnostics n = row_count;
        v_changed := v_changed + n;
      end if;
      continue;
    end if;
    if p_action = 'index' then
      update public.seo_entries set noindex = false, updated_by = auth.uid(), updated_at = now()
      where entity_type = r.type and entity_key = r.key and noindex;
      get diagnostics n = row_count;
      v_changed := v_changed + n;
      continue;
    end if;
    select * into e from public.seo_entries where entity_type = r.type and entity_key = r.key;
    v := public._seo_item(r.type, r.key, s);
    if v is null then continue; end if;
    v_title_manual := (v ->> 'stored_title') is not null and coalesce(e.sources ->> 'title', 'manual') = 'manual';
    v_desc_manual := (v ->> 'stored_description') is not null and coalesce(e.sources ->> 'description', 'manual') = 'manual';
    if (v_title_manual or v_desc_manual) and not p_include_manual then
      v_skipped := v_skipped + 1;
    end if;
    insert into public.seo_entries (merchant_id, entity_type, entity_key, updated_by)
    values (public.current_merchant_id(), r.type, r.key, auth.uid())
    on conflict (merchant_id, entity_type, entity_key) do nothing;
    if p_include_manual or not v_title_manual then
      perform public._seo_store_field(r.type, r.key, 'title', case when p_action = 'generate' then v ->> 'auto_title' end);
    end if;
    if p_include_manual or not v_desc_manual then
      perform public._seo_store_field(r.type, r.key, 'description', case when p_action = 'generate' then v ->> 'auto_description' end);
    end if;
    v_changed := v_changed + 1;
  end loop;
  return jsonb_build_object('action', p_action, 'changed', v_changed, 'skipped_manual', v_skipped);
end;
$$;

/** Stores (or clears, with null) a generated title / description for one item. */
create or replace function public._seo_store_field(p_type text, p_key text, p_field text, p_value text)
returns void
language plpgsql
security definer
set search_path = public, pg_temp
as $$
begin
  if p_field not in ('title', 'description') then
    return;
  end if;
  if p_type = 'product' then
    if p_field = 'title' then update public.products set seo_title = p_value where id::text = p_key;
    else update public.products set seo_description = p_value where id::text = p_key; end if;
  elsif p_type = 'collection' then
    if p_field = 'title' then update public.categories set seo_title = p_value where id::text = p_key;
    else update public.categories set seo_description = p_value where id::text = p_key; end if;
  else
    if p_field = 'title' then update public.seo_entries set title = p_value where entity_type = 'page' and entity_key = p_key;
    else update public.seo_entries set description = p_value where entity_type = 'page' and entity_key = p_key; end if;
  end if;
  update public.seo_entries
  set sources = case when p_value is null then sources - p_field else sources || jsonb_build_object(p_field, 'generated') end,
      updated_by = auth.uid(), updated_at = now()
  where entity_type = p_type and entity_key = p_key;
end;
$$;

create or replace function public.seo_redirects_list()
returns jsonb
language plpgsql
stable
security definer
set search_path = public, pg_temp
as $$
begin
  if not public.is_staff() then
    raise exception 'PERMISSION_DENIED: staff only' using errcode = '42501';
  end if;
  return coalesce((select jsonb_agg(jsonb_build_object('id', r.id, 'from_path', r.from_path, 'to_path', r.to_path, 'source', r.source,
    'created_at', r.created_at) order by r.created_at desc) from public.seo_redirects r), '[]'::jsonb);
end;
$$;

/** A redirect the merchant adds (an old address to a page of the store), without loops or chains. */
create or replace function public.seo_redirect_save(p_from text, p_to text)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_from text := public._seo_clean_path(p_from);
  v_to text := public._seo_clean_path(p_to);
begin
  perform public.require_permission('settings.manage');
  if v_from !~ '^/[^\s?#]*$' or v_to !~ '^/[^\s?#]*$' or length(v_from) > 300 or length(v_to) > 300 then
    raise exception 'VALIDATION: use paths of your store, like /old-page and /shop' using errcode = '22023';
  end if;
  if v_from = v_to then
    raise exception 'VALIDATION: a page cannot redirect to itself' using errcode = '22023';
  end if;
  if v_from = '/' or v_from ~ '^/(admin|cart|checkout|account|login|register|files|functions|rest|auth)(/|$)' then
    raise exception 'VALIDATION: that address cannot be redirected' using errcode = '22023';
  end if;
  -- The target is where it ends (no chains), and nothing may lead back to the start (no loops).
  v_to := coalesce((select r.to_path from public.seo_redirects r where r.from_path = v_to), v_to);
  if v_to = v_from then
    raise exception 'VALIDATION: that redirect would make a loop' using errcode = '22023';
  end if;
  update public.seo_redirects set to_path = v_to where to_path = v_from;
  delete from public.seo_redirects where from_path = to_path;
  insert into public.seo_redirects (merchant_id, from_path, to_path, source, created_by)
  values (public.current_merchant_id(), v_from, v_to, 'manual', auth.uid())
  on conflict (merchant_id, from_path) do update set to_path = excluded.to_path, source = 'manual', created_by = excluded.created_by;
  return public.seo_redirects_list();
end;
$$;

create or replace function public.seo_redirect_delete(p_id uuid)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
begin
  perform public.require_permission('settings.manage');
  delete from public.seo_redirects where id = p_id;
  return public.seo_redirects_list();
end;
$$;

-- ---------------------------------------------------------------------------------------------
-- Audit
-- ---------------------------------------------------------------------------------------------

/** Internal links in the theme (menus, footer, section buttons) that lead nowhere in the store. */
create or replace function public._seo_theme_links()
returns table (place text, link text)
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  with t as (select coalesce(public.get_setting('storefront') -> 'theme', '{}'::jsonb) as theme)
  select 'Header menu', x.value ->> 'link' from t cross join lateral jsonb_array_elements(coalesce(t.theme #> '{header,menu}', '[]'::jsonb)) x
  union all
  select 'Footer links', x.value ->> 'link' from t cross join lateral jsonb_array_elements(coalesce(t.theme #> '{footer,links}', '[]'::jsonb)) x
  union all
  select coalesce(x.value ->> 'type', 'Section') || ' section', y.value
  from t cross join lateral jsonb_array_elements(coalesce(t.theme -> 'sections', '[]'::jsonb)) x
         cross join lateral jsonb_each_text(coalesce(x.value -> 'settings', '{}'::jsonb)) y
  where y.key in ('button_link', 'link')
$$;

create or replace function public._seo_link_ok(p_link text)
returns boolean
language plpgsql
stable
security definer
set search_path = public, pg_temp
as $$
declare
  v text := public._seo_clean_path(p_link);
  seg text[];
begin
  if p_link is null or trim(p_link) = '' or p_link ~* '^(https?:|mailto:|tel:|#)' then
    return true;
  end if;
  if exists (select 1 from public.seo_redirects r where r.from_path = v) then
    return true;
  end if;
  seg := string_to_array(trim(both '/' from v), '/');
  if v in ('/', '/shop', '/search', '/contact', '/track-order', '/policies', '/cart', '/account', '/login', '/register') then
    return true;
  end if;
  if seg[1] = 'product' then return exists (select 1 from public.products where slug = seg[2] and status = 'ACTIVE'); end if;
  if seg[1] = 'collection' then return exists (select 1 from public.categories where slug = seg[2] and is_active); end if;
  if seg[1] = 'policies' then return exists (select 1 from public._seo_pages() pg where pg.path = v); end if;
  return false;
end;
$$;

/**
 * What needs attention, from checks the store can make itself. Each issue names the item,
 * the problem, why it matters and what fixes it. Search Console coverage and Google's own
 * rich-result test are outside this check (listed under "external").
 */
create or replace function public.seo_audit()
returns jsonb
language plpgsql
stable
security definer
set search_path = public, pg_temp
as $$
declare
  s jsonb := public._seo_settings();
  v_base text := public._seo_base_url();
  v_issues jsonb := '[]'::jsonb;
  v_items jsonb := '[]'::jsonb;
  r record;
  v jsonb;
  v_checks int := 0;
  v_failed int := 0;
  v_title text;
  v_desc text;
  n int;
begin
  if not public.is_staff() then
    raise exception 'PERMISSION_DENIED: staff only' using errcode = '42501';
  end if;

  -- Every public item, as the store shows it now.
  for r in
    select 'product' as type, id::text as key from public.products where status = 'ACTIVE'
    union all select 'collection', id::text from public.categories where is_active
    union all select 'page', pg.key from public._seo_pages() pg
  loop
    v := public._seo_item(r.type, r.key, s);
    if v is null then continue; end if;
    v_items := v_items || jsonb_build_array(v);
    v_title := v ->> 'title';
    v_desc := v ->> 'description';
    v_checks := v_checks + 4;
    if v ->> 'title_source' = 'missing' then
      v_failed := v_failed + 1;
      v_issues := v_issues || jsonb_build_array(jsonb_build_object('severity', 'error', 'code', 'title_missing', 'type', r.type, 'key', r.key,
        'name', v ->> 'name', 'path', v ->> 'path', 'field', 'title',
        'message', 'No SEO title written (Manual mode): the page uses its name, "' || coalesce(v_title, '') || '".'));
    elsif length(v_title) > 65 then
      v_failed := v_failed + 1;
      v_issues := v_issues || jsonb_build_array(jsonb_build_object('severity', 'info', 'code', 'title_long', 'type', r.type, 'key', r.key,
        'name', v ->> 'name', 'path', v ->> 'path', 'field', 'title',
        'message', 'The title is ' || length(v_title) || ' characters; search results usually show about 50–60.'));
    end if;
    if v_desc is null then
      v_failed := v_failed + 1;
      v_issues := v_issues || jsonb_build_array(jsonb_build_object('severity', 'warning', 'code', 'description_missing', 'type', r.type, 'key', r.key,
        'name', v ->> 'name', 'path', v ->> 'path', 'field', 'description',
        'message', case when v ->> 'description_source' = 'missing' and s ->> 'mode' <> 'manual'
          then 'No meta description: nothing to generate it from (add a description to the item, or write one).'
          else 'No meta description written.' end));
    elsif length(v_desc) < 50 then
      v_failed := v_failed + 1;
      v_issues := v_issues || jsonb_build_array(jsonb_build_object('severity', 'info', 'code', 'description_short', 'type', r.type, 'key', r.key,
        'name', v ->> 'name', 'path', v ->> 'path', 'field', 'description',
        'message', 'The meta description is only ' || length(v_desc) || ' characters; about 120–160 says more in search results.'));
    end if;
    if (v ->> 'robots') like 'noindex%' and coalesce((s #>> '{indexing,store}')::boolean, true) then
      v_failed := v_failed + 1;
      v_issues := v_issues || jsonb_build_array(jsonb_build_object('severity', case when (v ->> 'noindex')::boolean then 'warning' else 'info' end,
        'code', 'noindex', 'type', r.type, 'key', r.key, 'name', v ->> 'name', 'path', v ->> 'path', 'field', 'noindex',
        'message', case when (v ->> 'noindex')::boolean then 'Hidden from search engines (noindex is on for this item).'
                        else 'Hidden from search engines: indexing is off for all ' || r.type || 's.' end));
    end if;
    if (v ->> 'custom_canonical') is not null and v_base is not null and (v ->> 'custom_canonical') not like v_base || '/%' then
      v_failed := v_failed + 1;
      v_issues := v_issues || jsonb_build_array(jsonb_build_object('severity', 'warning', 'code', 'canonical_other', 'type', r.type, 'key', r.key,
        'name', v ->> 'name', 'path', v ->> 'path', 'field', 'canonical_url',
        'message', 'The canonical address points away from this store (' || (v ->> 'custom_canonical') || '): search engines may index that page instead.'));
    end if;
  end loop;

  -- Duplicate titles and descriptions among indexable items.
  for r in
    select lower(x ->> 'title') as t, jsonb_agg(x order by x ->> 'path') as items from jsonb_array_elements(v_items) x
    where (x ->> 'robots') like 'index%' group by lower(x ->> 'title') having count(*) > 1
  loop
    v_checks := v_checks + 1; v_failed := v_failed + 1;
    v_issues := v_issues || (select jsonb_agg(jsonb_build_object('severity', 'warning', 'code', 'title_duplicate', 'type', i ->> 'type', 'key', i ->> 'key',
      'name', i ->> 'name', 'path', i ->> 'path', 'field', 'title',
      'message', 'The same title as ' || (jsonb_array_length(r.items) - 1) || ' other page(s): "' || (i ->> 'title') || '".'))
      from jsonb_array_elements(r.items) i);
  end loop;
  for r in
    select lower(x ->> 'description') as d, jsonb_agg(x order by x ->> 'path') as items from jsonb_array_elements(v_items) x
    where (x ->> 'robots') like 'index%' and x ->> 'description' is not null group by lower(x ->> 'description') having count(*) > 1
  loop
    v_checks := v_checks + 1; v_failed := v_failed + 1;
    v_issues := v_issues || (select jsonb_agg(jsonb_build_object('severity', 'info', 'code', 'description_duplicate', 'type', i ->> 'type', 'key', i ->> 'key',
      'name', i ->> 'name', 'path', i ->> 'path', 'field', 'description',
      'message', 'The same meta description as ' || (jsonb_array_length(r.items) - 1) || ' other page(s).'))
      from jsonb_array_elements(r.items) i);
  end loop;

  -- Products: images without alt text, unclear addresses, data for rich results.
  for r in
    select p.id, p.name, p.slug, p.price,
      (select count(*) from public.product_images i where i.product_id = p.id) as images,
      (select count(*) from public.product_images i where i.product_id = p.id and nullif(trim(coalesce(i.alt, '')), '') is null) as no_alt
    from public.products p where p.status = 'ACTIVE'
  loop
    v_checks := v_checks + 3;
    if r.no_alt > 0 then
      v_failed := v_failed + 1;
      v_issues := v_issues || jsonb_build_array(jsonb_build_object('severity', case when coalesce((s #>> '{generate,alt_text}')::boolean, true) then 'info' else 'warning' end,
        'code', 'alt_missing', 'type', 'product', 'key', r.id::text, 'name', r.name, 'path', '/product/' || r.slug, 'field', 'image_alts',
        'message', r.no_alt || ' of ' || r.images || ' image(s) have no alt text' ||
          case when coalesce((s #>> '{generate,alt_text}')::boolean, true) then ' (the product name is used for now; descriptive text is better).' else '.' end));
    end if;
    if r.slug !~ '^[a-z0-9]+(-[a-z0-9]+)*$' or length(r.slug) > 80 then
      v_failed := v_failed + 1;
      v_issues := v_issues || jsonb_build_array(jsonb_build_object('severity', 'info', 'code', 'slug_unclear', 'type', 'product', 'key', r.id::text,
        'name', r.name, 'path', '/product/' || r.slug, 'field', 'slug', 'message', 'The address is not plain words and dashes.'));
    elsif r.slug ~ '-[0-9a-f]{6,8}$' then
      v_failed := v_failed + 1;
      v_issues := v_issues || jsonb_build_array(jsonb_build_object('severity', 'info', 'code', 'slug_code', 'type', 'product', 'key', r.id::text,
        'name', r.name, 'path', '/product/' || r.slug, 'field', 'slug', 'message', 'The address ends in an import code; a readable one is easier to share (the old address keeps working).'));
    end if;
    if coalesce((s #>> '{structured_data,product}')::boolean, true) and (coalesce(r.price, 0) <= 0 or r.images = 0) then
      v_failed := v_failed + 1;
      v_issues := v_issues || jsonb_build_array(jsonb_build_object('severity', 'info', 'code', 'schema_incomplete', 'type', 'product', 'key', r.id::text,
        'name', r.name, 'path', '/product/' || r.slug, 'field', null,
        'message', 'Product data for rich results is incomplete: ' || concat_ws(' and ', case when coalesce(r.price, 0) <= 0 then 'no price' end,
          case when r.images = 0 then 'no image' end) || '.'));
    end if;
  end loop;

  -- Links in the theme that lead nowhere.
  for r in select l.place, l.link from public._seo_theme_links() l loop
    v_checks := v_checks + 1;
    if not public._seo_link_ok(r.link) then
      v_failed := v_failed + 1;
      v_issues := v_issues || jsonb_build_array(jsonb_build_object('severity', 'error', 'code', 'link_broken', 'type', 'theme', 'key', r.place,
        'name', r.place, 'path', r.link, 'field', null, 'message', 'The link ' || r.link || ' (' || r.place || ') leads to a page that does not exist.'));
    end if;
  end loop;

  -- The store as a whole.
  v_checks := v_checks + 3;
  if not coalesce((s #>> '{indexing,store}')::boolean, true) then
    v_failed := v_failed + 1;
    v_issues := v_issues || jsonb_build_array(jsonb_build_object('severity', 'error', 'code', 'store_noindex', 'type', 'store', 'key', 'store',
      'name', 'Whole store', 'path', '/', 'field', 'indexing', 'message', 'Search engines are asked not to index any page of the store (Indexing → Allow search engines is off).'));
  end if;
  if not coalesce((s #>> '{sitemap,enabled}')::boolean, true) then
    v_failed := v_failed + 1;
    v_issues := v_issues || jsonb_build_array(jsonb_build_object('severity', 'warning', 'code', 'sitemap_off', 'type', 'store', 'key', 'store',
      'name', 'Sitemap', 'path', '/sitemap.xml', 'field', 'sitemap', 'message', 'The sitemap is switched off: search engines find new pages more slowly.'));
  end if;
  if v_base is null then
    v_failed := v_failed + 1;
    v_issues := v_issues || jsonb_build_array(jsonb_build_object('severity', 'warning', 'code', 'no_address', 'type', 'store', 'key', 'store',
      'name', 'Store address', 'path', '/', 'field', null,
      'message', 'The store has no published address (a connected domain or store subdomain), so canonical addresses and the sitemap use the address it is opened on.'));
  end if;

  select count(*) into n from jsonb_array_elements(v_issues) i where i ->> 'severity' = 'error';
  return jsonb_build_object(
    'checked_at', now(), 'mode', s ->> 'mode', 'base_url', v_base,
    'health', jsonb_build_object('checks', v_checks, 'failed', v_failed,
      'score', case when v_checks = 0 then 100 else greatest(0, round(100.0 * (v_checks - v_failed) / v_checks))::int end,
      'errors', n,
      'warnings', (select count(*) from jsonb_array_elements(v_issues) i where i ->> 'severity' = 'warning'),
      'notes', (select count(*) from jsonb_array_elements(v_issues) i where i ->> 'severity' = 'info')),
    'counts', jsonb_build_object(
      'products', (select count(*) from jsonb_array_elements(v_items) x where x ->> 'type' = 'product'),
      'collections', (select count(*) from jsonb_array_elements(v_items) x where x ->> 'type' = 'collection'),
      'pages', (select count(*) from jsonb_array_elements(v_items) x where x ->> 'type' = 'page'),
      'indexable', (select count(*) from jsonb_array_elements(v_items) x where (x ->> 'robots') like 'index%')),
    'technical', jsonb_build_object(
      'sitemap', jsonb_build_object('enabled', coalesce((s #>> '{sitemap,enabled}')::boolean, true), 'url', case when v_base is not null then v_base || '/sitemap.xml' end,
        'urls', jsonb_array_length(public.storefront_sitemap() -> 'urls')),
      'robots', jsonb_build_object('url', case when v_base is not null then v_base || '/robots.txt' end, 'store_indexable', coalesce((s #>> '{indexing,store}')::boolean, true)),
      'structured_data', s -> 'structured_data'),
    'external', jsonb_build_array(
      'Whether Google has indexed each page (Google Search Console → Pages)',
      'Rich result eligibility (Google Rich Results Test)',
      'Page speed and Core Web Vitals (PageSpeed Insights)'),
    'issues', v_issues,
    -- Every public item as checked (for the list of products, collections and pages).
    'items', coalesce((select jsonb_agg(jsonb_build_object('type', x ->> 'type', 'key', x ->> 'key', 'name', x ->> 'name',
        'path', x ->> 'path', 'title', x ->> 'title', 'description', x ->> 'description', 'title_source', x ->> 'title_source',
        'description_source', x ->> 'description_source', 'robots', x ->> 'robots', 'noindex', x -> 'noindex',
        'focus_keyword', x ->> 'focus_keyword') order by x ->> 'type', x ->> 'name')
      from jsonb_array_elements(v_items) x), '[]'::jsonb));
end;
$$;

-- ---------------------------------------------------------------------------------------------
-- Triggers: old addresses keep working; new items under "fill"; entries go with their items
-- ---------------------------------------------------------------------------------------------

create or replace function public._seo_slug_redirect()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_prefix text := case tg_table_name when 'products' then '/product/' else '/collection/' end;
  v_old text := v_prefix || old.slug;
  v_new text := v_prefix || new.slug;
begin
  if old.slug is not distinct from new.slug or old.slug is null or new.slug is null then
    return new;
  end if;
  -- The new address is live: nothing redirects away from it; older redirects lead straight there.
  delete from public.seo_redirects where merchant_id = new.merchant_id and from_path = v_new;
  update public.seo_redirects set to_path = v_new where merchant_id = new.merchant_id and to_path = v_old;
  insert into public.seo_redirects (merchant_id, from_path, to_path, source, created_by)
  values (new.merchant_id, v_old, v_new, 'auto', auth.uid())
  on conflict (merchant_id, from_path) do update set to_path = excluded.to_path, source = 'auto';
  return new;
end;
$$;

drop trigger if exists seo_slug_redirect on public.products;
create trigger seo_slug_redirect after update of slug on public.products
  for each row execute function public._seo_slug_redirect();
drop trigger if exists seo_slug_redirect on public.categories;
create trigger seo_slug_redirect after update of slug on public.categories
  for each row execute function public._seo_slug_redirect();

/** New products / collections under "fill": the generated title and description are stored at once. */
create or replace function public._seo_new_item()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  s jsonb;
  v_kind text := case tg_table_name when 'products' then 'products' else 'collections' end;
  v jsonb;
  vars jsonb;
begin
  s := public._seo_settings();
  if coalesce(s #>> array['new_items', v_kind], 'auto') <> 'fill' or new.seo_title is not null or new.seo_description is not null then
    return new;
  end if;
  s := s || '{"mode": "hybrid"}'::jsonb;
  if tg_table_name = 'products' then
    vars := public._seo_store_vars() || jsonb_build_object('name', new.name, 'description', public._seo_clip(public._seo_plain(new.description), 300),
      'short_description', public._seo_clip(public._seo_plain(new.short_description), 300), 'brand', new.brand, 'price', public._seo_price_text(new.price),
      'category', (select k.name from public.categories k where k.id = new.category_id));
    v := public._seo_fields('product', new.name, vars, null, null, '{}'::jsonb, s);
  else
    vars := public._seo_store_vars() || jsonb_build_object('name', new.name, 'description', public._seo_clip(public._seo_plain(new.description), 300));
    v := public._seo_fields('collection', new.name, vars, null, null, '{}'::jsonb, s);
  end if;
  new.seo_title := v ->> 'auto_title';
  new.seo_description := v ->> 'auto_description';
  insert into public.seo_entries (merchant_id, entity_type, entity_key, sources)
  values (new.merchant_id, case tg_table_name when 'products' then 'product' else 'collection' end, new.id::text,
          jsonb_strip_nulls(jsonb_build_object('title', case when new.seo_title is not null then 'generated' end,
            'description', case when new.seo_description is not null then 'generated' end)))
  on conflict (merchant_id, entity_type, entity_key) do update set sources = excluded.sources;
  return new;
end;
$$;

drop trigger if exists seo_new_item on public.products;
create trigger seo_new_item before insert on public.products
  for each row execute function public._seo_new_item();
drop trigger if exists seo_new_item on public.categories;
create trigger seo_new_item before insert on public.categories
  for each row execute function public._seo_new_item();

create or replace function public._seo_item_gone()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
begin
  delete from public.seo_entries
  where merchant_id = old.merchant_id and entity_type = case tg_table_name when 'products' then 'product' else 'collection' end
    and entity_key = old.id::text;
  return old;
end;
$$;

drop trigger if exists seo_item_gone on public.products;
create trigger seo_item_gone after delete on public.products
  for each row execute function public._seo_item_gone();
drop trigger if exists seo_item_gone on public.categories;
create trigger seo_item_gone after delete on public.categories
  for each row execute function public._seo_item_gone();

-- A full store reset removes the store's redirects and SEO entries with its catalogue.
do $$
declare
  v_old text := pg_temp.lf(pg_get_functiondef('public.platform_store_reset(uuid,text,text,text)'::regprocedure));
  v_from text := pg_temp.lf($a$    delete from public.categories where merchant_id = p_merchant;
    delete from public.coupons where merchant_id = p_merchant;$a$);
  v_to text := pg_temp.lf($b$    delete from public.categories where merchant_id = p_merchant;
    delete from public.coupons where merchant_id = p_merchant;
    delete from public.seo_redirects where merchant_id = p_merchant;
    delete from public.seo_entries where merchant_id = p_merchant;$b$);
begin
  if position('public.seo_redirects' in v_old) > 0 then
    return;
  end if;
  if (length(v_old) - length(replace(v_old, v_from, ''))) / length(v_from) <> 1 then
    raise exception 'store seo: platform_store_reset has changed';
  end if;
  execute replace(v_old, v_from, v_to);
end $$;

-- Grants: the store's pages are public; everything else is for signed-in staff.
revoke all on function public._seo_defaults(), public._seo_settings(), public._seo_plain(text), public._seo_clip(text, int),
  public._seo_render(text, jsonb), public._seo_template_vars(), public._seo_fields(text, text, jsonb, text, text, jsonb, jsonb),
  public._seo_base_url(), public._seo_store_vars(), public._seo_price_text(numeric), public._seo_pages(),
  public._seo_item(text, text, jsonb), public._seo_clean_path(text), public._seo_product_ld(uuid, text),
  public._seo_breadcrumbs(jsonb, text), public._seo_alt_suggestion(uuid), public._seo_store_field(text, text, text, text),
  public._seo_theme_links(), public._seo_link_ok(text), public._seo_slug_redirect(), public._seo_new_item(), public._seo_item_gone(),
  public.seo_settings_get(), public.seo_settings_save(jsonb), public.seo_item_get(text, text), public.seo_item_save(text, text, jsonb),
  public.seo_bulk(text, jsonb, boolean), public.seo_redirects_list(), public.seo_redirect_save(text, text), public.seo_redirect_delete(uuid),
  public.seo_audit(), public.storefront_seo(text), public.storefront_page(text), public.storefront_sitemap(), public.storefront_robots()
  from public, anon, authenticated;
grant execute on function public.storefront_seo(text), public.storefront_page(text), public.storefront_sitemap(), public.storefront_robots()
  to anon, authenticated;
grant execute on function public.seo_settings_get(), public.seo_settings_save(jsonb), public.seo_item_get(text, text),
  public.seo_item_save(text, text, jsonb), public.seo_bulk(text, jsonb, boolean), public.seo_redirects_list(),
  public.seo_redirect_save(text, text), public.seo_redirect_delete(uuid), public.seo_audit() to authenticated;

select public._tenancy_own_functions();
