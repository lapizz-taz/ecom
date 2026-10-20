-- Store SEO: the product form and the SEO panel save different things.
--
-- The product form saved the SEO title, the meta description and the address with everything
-- else, so saving a product put back whatever those fields held when the form opened (and an
-- empty title wiped a generated one). Now admin_save_product changes them only when the payload
-- carries them: the SEO panel (seo_item_save) owns them for saved products. A title or
-- description another client writes here is the merchant's own: its "generated" mark goes.

-- Text is compared without carriage returns (a script pasted on Windows has CRLF line ends).
create or replace function pg_temp.lf(p text) returns text
language sql immutable as $$ select replace(p, E'\r', '') $$;

do $$
declare
  v_old text := pg_temp.lf(pg_get_functiondef('public.admin_save_product(jsonb)'::regprocedure));
  v_new text := v_old;
  v_pairs text[][] := array[
    array[$a$  v_slug text;
$a$, $b$  v_slug text;
  v_was public.products;
$b$],
    array[$a$  else
    update public.products set
      name = trim(p_payload ->> 'name'),
      slug = v_slug,$a$, $b$  else
    select * into v_was from public.products where id = v_id;
    update public.products set
      name = trim(p_payload ->> 'name'),
      slug = case when p_payload ? 'slug' then v_slug else slug end,$b$],
    array[$a$      seo_title = nullif(p_payload ->> 'seo_title', ''),
      seo_description = nullif(p_payload ->> 'seo_description', '')
    where id = v_id$a$, $b$      seo_title = case when p_payload ? 'seo_title' then nullif(p_payload ->> 'seo_title', '') else seo_title end,
      seo_description = case when p_payload ? 'seo_description' then nullif(p_payload ->> 'seo_description', '') else seo_description end
    where id = v_id$b$],
    array[$a$      raise exception 'NOT_FOUND: product % does not exist', v_id using errcode = 'P0002';
    end if;
$a$, $b$      raise exception 'NOT_FOUND: product % does not exist', v_id using errcode = 'P0002';
    end if;
    -- A title or description changed here is the merchant's own (no recorded source).
    update public.seo_entries set sources = sources
        - case when v_product.seo_title is distinct from v_was.seo_title then 'title' else '' end
        - case when v_product.seo_description is distinct from v_was.seo_description then 'description' else '' end
    where entity_type = 'product' and entity_key = v_id::text;
$b$]];
  i int;
  v_from text;
begin
  if position('v_was public.products' in v_old) > 0 then
    return;
  end if;
  for i in 1 .. array_length(v_pairs, 1) loop
    v_from := pg_temp.lf(v_pairs[i][1]);
    if (length(v_new) - length(replace(v_new, v_from, ''))) / length(v_from) <> 1 then
      raise exception 'seo product save: admin_save_product has changed (part %)', i;
    end if;
    v_new := replace(v_new, v_from, pg_temp.lf(v_pairs[i][2]));
  end loop;
  execute v_new;
end $$;

select public._tenancy_own_functions();
