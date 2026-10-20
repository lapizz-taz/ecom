-- Store SEO: no AI writing; descriptions written from each item's own facts instead.
--
-- The "AI suggestions" setting is gone (no AI service is used): the settings no longer carry it,
-- and a save that still sends it (an admin page opened before this change) has it dropped.
-- When an item has nothing a template can use (no description, an empty template), the generated
-- meta description is a sentence made from its real facts: name, brand, category, price, the
-- sizes and colours on sale, how many products a collection has. Nothing is invented.
-- The SEO editor gets the same facts (seo_item_get -> facts) for its suggestions.

-- Text is compared without carriage returns (a script pasted on Windows has CRLF line ends).
create or replace function pg_temp.lf(p text) returns text
language sql immutable as $$ select replace(p, E'\r', '') $$;

/** Replaces each text once in a function's definition (it must appear exactly once), then runs it. */
create or replace function pg_temp.patch(p_fn regprocedure, p_marker text, p_pairs text[][])
returns void
language plpgsql as $$
declare
  v_def text := pg_temp.lf(pg_get_functiondef(p_fn));
  v_from text;
  i int;
begin
  if position(p_marker in v_def) > 0 then
    return;
  end if;
  for i in 1 .. array_length(p_pairs, 1) loop
    v_from := pg_temp.lf(p_pairs[i][1]);
    if (length(v_def) - length(replace(v_def, v_from, ''))) / length(v_from) <> 1 then
      raise exception 'seo writer: % has changed (part %)', p_fn, i;
    end if;
    v_def := replace(v_def, v_from, pg_temp.lf(p_pairs[i][2]));
  end loop;
  execute v_def;
end;
$$;

-- No AI setting.
select pg_temp.patch('public._seo_defaults()'::regprocedure, 'Facts the store has',
  array[array[$a$    'new_items', jsonb_build_object('products', 'auto', 'collections', 'auto'),
    'ai', jsonb_build_object('enabled', false))$a$, $b$    'new_items', jsonb_build_object('products', 'auto', 'collections', 'auto'))
    -- Facts the store has: with nothing for a template to use, descriptions are written from them.$b$]]);

select pg_temp.patch('public._seo_settings()'::regprocedure, $m$get_setting('seo') - 'ai'$m$,
  array[
    array[$a$  s jsonb := public.get_setting('seo');$a$, $b$  s jsonb := public.get_setting('seo') - 'ai';$b$],
    array[$a$  v := d || (s - array['generate', 'templates', 'social', 'structured_data', 'sitemap', 'indexing', 'new_items', 'ai']);
  foreach g in array array['generate', 'templates', 'social', 'structured_data', 'sitemap', 'indexing', 'new_items', 'ai'] loop$a$,
          $b$  v := d || (s - array['generate', 'templates', 'social', 'structured_data', 'sitemap', 'indexing', 'new_items']);
  foreach g in array array['generate', 'templates', 'social', 'structured_data', 'sitemap', 'indexing', 'new_items'] loop$b$]]);

select pg_temp.patch('public.seo_settings_get()'::regprocedure, $m$value - 'ai'$m$,
  array[
    array[$a$    'saved', (select value from public.settings where key = 'seo'),$a$, $b$    'saved', (select value - 'ai' from public.settings where key = 'seo'),$b$],
    array[$a$        + (select count(*) from public.seo_entries where entity_type = 'page' and nullif(trim(coalesce(title, '')), '') is not null)),
    'ai_available', false);$a$, $b$        + (select count(*) from public.seo_entries where entity_type = 'page' and nullif(trim(coalesce(title, '')), '') is not null)));$b$]]);

select pg_temp.patch('public.seo_settings_save(jsonb)'::regprocedure, 'an admin page opened before AI writing was removed',
  array[
    array[$a$  perform public.require_permission('settings.manage');
  if p_value is null or jsonb_typeof(p_value) <> 'object' then
    raise exception 'VALIDATION: SEO settings must be a JSON object' using errcode = '22023';
  end if;$a$, $b$  perform public.require_permission('settings.manage');
  if p_value is null or jsonb_typeof(p_value) <> 'object' then
    raise exception 'VALIDATION: SEO settings must be a JSON object' using errcode = '22023';
  end if;
  -- Sent by an admin page opened before AI writing was removed: not a setting any more.
  p_value := p_value - 'ai';$b$],
    array[$a$  foreach g in array array['generate', 'structured_data', 'sitemap', 'indexing', 'ai'] loop$a$,
          $b$  foreach g in array array['generate', 'structured_data', 'sitemap', 'indexing'] loop$b$]]);

-- Templates may also use the sizes and colours on sale.
create or replace function public._seo_template_vars()
returns text[]
language sql
immutable
as $$ select array['name', 'store', 'tagline', 'price', 'description', 'short_description', 'brand', 'category', 'sizes', 'colours'] $$;

-- A generated description with nothing for the template to use: the item's facts as a sentence.
select pg_temp.patch('public._seo_fields(text,text,jsonb,text,text,jsonb,jsonb)'::regprocedure, $m$p_vars ->> 'summary'$m$,
  array[array[$a$    v_auto_desc := public._seo_clip(public._seo_render(p_s #>> array['templates', v_tpl_kind || '_description'], p_vars), 160);
  end if;$a$, $b$    v_auto_desc := public._seo_clip(public._seo_render(p_s #>> array['templates', v_tpl_kind || '_description'], p_vars), 160);
    -- Nothing to make it from (no text on the item, or an empty template): a sentence from its facts.
    v_auto_desc := coalesce(v_auto_desc, public._seo_clip(nullif(trim(coalesce(p_vars ->> 'summary', '')), ''), 160));
  end if;$b$]]);

-- The facts of each item (and the sentence made from them), also returned for the editor.
select pg_temp.patch('public._seo_item(text,text,jsonb)'::regprocedure, $m$'facts', vars$m$,
  array[
    array[$a$    v_type_indexed := coalesce((s #>> '{indexing,products}')::boolean, true);$a$,
          $b$    v_type_indexed := coalesce((s #>> '{indexing,products}')::boolean, true);
    -- The sizes and colours on sale, in the product's own order.
    vars := vars || jsonb_build_object(
      'sizes', (select string_agg(x.v, ', ' order by x.pos) from (select trim(pv.size) as v, min(pv.position) as pos from public.product_variants pv
        where pv.product_id = p.id and pv.is_active and nullif(trim(coalesce(pv.size, '')), '') is not null group by trim(pv.size)) x),
      'colours', (select string_agg(x.v, ', ' order by x.pos) from (select trim(pv.color) as v, min(pv.position) as pos from public.product_variants pv
        where pv.product_id = p.id and pv.is_active and nullif(trim(coalesce(pv.color, '')), '') is not null group by trim(pv.color)) x));
    vars := vars || jsonb_build_object('summary', concat_ws(' ',
      p.name || coalesce(' by ' || nullif(trim(p.brand), ''), '') || coalesce(' – ' || (vars ->> 'category'), '') || '.',
      'Price ' || (vars ->> 'price') || '.',
      'Sizes: ' || (vars ->> 'sizes') || '.',
      'Colours: ' || (vars ->> 'colours') || '.',
      'Order online from ' || (vars ->> 'store') || '.'));$b$],
    array[$a$    v_type_indexed := coalesce((s #>> '{indexing,collections}')::boolean, true);$a$,
          $b$    v_type_indexed := coalesce((s #>> '{indexing,collections}')::boolean, true);
    vars := vars || jsonb_build_object(
      'count', (select count(*) from public.products x where x.status = 'ACTIVE' and (x.category_id = c.id or c.id = any(x.extra_category_ids))),
      'from_price', public._seo_price_text((select min(x.price) from public.products x
        where x.status = 'ACTIVE' and x.price > 0 and (x.category_id = c.id or c.id = any(x.extra_category_ids)))));
    vars := vars || jsonb_build_object('summary', case when (vars ->> 'count')::int > 0 then concat_ws(' ',
      'Shop ' || c.name || coalesce(' at ' || (vars ->> 'store'), '') || ': ' || (vars ->> 'count')
        || case when (vars ->> 'count')::int = 1 then ' product' else ' products' end || coalesce(', from ' || (vars ->> 'from_price'), '') || '.',
      'Order online.') end);$b$],
    array[$a$    v_type_indexed := coalesce((s #>> '{indexing,pages}')::boolean, true) or p_key = 'home';$a$,
          $b$    v_type_indexed := coalesce((s #>> '{indexing,pages}')::boolean, true) or p_key = 'home';
    vars := vars || jsonb_build_object('summary', case
      when vars ->> 'store' is null then null
      when p_key = 'home' then 'Shop ' || (vars ->> 'store') || ' online'
        || coalesce(': ' || (select string_agg(k.name, ', ' order by k.sort_order, k.name) from (select name, sort_order from public.categories
             where is_active order by sort_order, name limit 4) k), '') || '.'
      when p_key = 'shop' then 'All products at ' || (vars ->> 'store') || '. Order online.'
      when p_key = 'contact' then 'Get in touch with ' || (vars ->> 'store') || ' about products, orders and delivery.'
      when p_key = 'track-order' then 'Track your ' || (vars ->> 'store') || ' order with your order number and mobile number.'
      when p_key = 'policies' then 'Shipping, returns, privacy and other policies of ' || (vars ->> 'store') || '.'
      else initcap(replace(split_part(p_key, '/', 2), '-', ' ')) || ' policy of ' || (vars ->> 'store') || '.' end);$b$],
    array[$a$    'updated_at', e.updated_at);$a$, $b$    'updated_at', e.updated_at,
    'facts', vars);$b$]]);

select public._tenancy_own_functions();
