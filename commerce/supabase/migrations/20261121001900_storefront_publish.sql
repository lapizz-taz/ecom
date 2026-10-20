-- Store builder: a saved draft, and Publish (the live store changes only when published).
--
-- The theme editor saved straight into the public "storefront" setting, as a whole: every Save
-- went live at once, and it also wrote back the setting's other keys (the sales-channel mode,
-- the store prompt) as they were when the editor opened, undoing changes made meanwhile.
-- Now the editor keeps its work in a private draft (setting "storefront_draft"), and Publish
-- copies only the keys the editor owns (theme, footer text) into "storefront". A draft saved on
-- top of a newer one is refused, so two people editing at once do not overwrite each other.
-- storefront_config also names its business, so a store page can tell when the session it
-- runs under belongs to another business.

-- Text is compared without carriage returns (a script pasted on Windows has CRLF line ends).
create or replace function pg_temp.lf(p text) returns text
language sql immutable as $$ select replace(p, E'\r', '') $$;

/** Checks a theme draft: only the editor's keys, sizes within reason, no script links. */
create or replace function public._storefront_content_check(p_content jsonb)
returns void
language plpgsql
immutable
set search_path = public, pg_temp
as $$
begin
  if p_content is null or jsonb_typeof(p_content) <> 'object' then
    raise exception 'VALIDATION: the theme must be a JSON object' using errcode = '22023';
  end if;
  if exists (select 1 from jsonb_object_keys(p_content) k where k not in ('theme', 'footer_text')) then
    raise exception 'VALIDATION: only the theme and the footer text are saved here' using errcode = '22023';
  end if;
  if p_content ? 'theme' and jsonb_typeof(p_content -> 'theme') <> 'object' then
    raise exception 'VALIDATION: the theme must be a JSON object' using errcode = '22023';
  end if;
  if p_content ? 'footer_text' and jsonb_typeof(p_content -> 'footer_text') not in ('string', 'null') then
    raise exception 'VALIDATION: the footer text must be text' using errcode = '22023';
  end if;
  if coalesce(jsonb_typeof(p_content #> '{theme,sections}'), 'array') <> 'array'
     or coalesce(jsonb_typeof(p_content #> '{theme,product_sections}'), 'array') <> 'array' then
    raise exception 'VALIDATION: sections must be a list' using errcode = '22023';
  end if;
  if coalesce(jsonb_array_length(p_content #> '{theme,sections}'), 0) > 60
     or coalesce(jsonb_array_length(p_content #> '{theme,product_sections}'), 0) > 30 then
    raise exception 'VALIDATION: too many sections (60 on the home page, 30 on product pages)' using errcode = '22023';
  end if;
  if length(p_content::text) > 300000 then
    raise exception 'VALIDATION: the theme is too large to save' using errcode = '22023';
  end if;
  -- Links, images and videos are web addresses or pages of the store: never script addresses.
  if p_content::text ~* '"\s*(javascript|vbscript|data:text/html)\s*:' then
    raise exception 'VALIDATION: links must be web addresses or pages of your store' using errcode = '22023';
  end if;
end;
$$;

/** The editor's starting point: the live theme, the saved draft (if any) and when each was saved. */
create or replace function public.storefront_draft_get()
returns jsonb
language plpgsql
stable
security definer
set search_path = public, pg_temp
as $$
declare
  v_live jsonb := public.get_setting('storefront');
  d public.settings;
begin
  if not public.is_staff() then
    raise exception 'PERMISSION_DENIED: staff only' using errcode = '42501';
  end if;
  select * into d from public.settings where key = 'storefront_draft';
  return jsonb_build_object(
    'live', jsonb_build_object('theme', coalesce(v_live -> 'theme', '{}'::jsonb), 'footer_text', v_live -> 'footer_text'),
    'draft', d.value -> 'content',
    'draft_saved_at', d.updated_at,
    'draft_saved_by', (select p.full_name from public.profiles p where p.id = d.updated_by),
    'published_at', v_live ->> 'published_at',
    'published_by', (select p.full_name from public.profiles p where p.id::text = v_live ->> 'published_by'));
end;
$$;

/**
 * Saves the editor's work as the draft (the live store does not change). p_base is when the
 * draft the editor started from was saved (null: no draft then); a newer draft is not overwritten.
 */
create or replace function public.storefront_draft_save(p_content jsonb, p_base timestamptz default null)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_at timestamptz;
  v_row public.settings;
begin
  perform public.require_permission('settings.manage');
  perform public._storefront_content_check(p_content);
  select updated_at into v_at from public.settings where key = 'storefront_draft' for update;
  if v_at is not null and (p_base is null or v_at > p_base) then
    raise exception 'CONFLICT: someone saved a newer draft of this theme. Reload the editor to see it.' using errcode = '40001';
  end if;
  insert into public.settings (merchant_id, key, value, is_public, description, updated_by, updated_at)
  values (public.current_merchant_id(), 'storefront_draft', jsonb_build_object('content', p_content), false,
          'Theme editor draft (not live until published)', auth.uid(), now())
  on conflict (merchant_id, key) do update set value = excluded.value, updated_by = excluded.updated_by, updated_at = now()
  returning * into v_row;
  return jsonb_build_object('draft_saved_at', v_row.updated_at);
end;
$$;

/** Puts the saved draft live: its theme and footer text replace the live ones; nothing else changes. */
create or replace function public.storefront_publish(p_base timestamptz default null)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  d public.settings;
begin
  perform public.require_permission('settings.manage');
  select * into d from public.settings where key = 'storefront_draft' for update;
  if d.key is null then
    raise exception 'NOT_FOUND: there is no saved draft to publish' using errcode = 'P0002';
  end if;
  if p_base is not null and d.updated_at > p_base then
    raise exception 'CONFLICT: someone saved a newer draft of this theme. Reload the editor before publishing.' using errcode = '40001';
  end if;
  perform public._storefront_content_check(d.value -> 'content');
  update public.settings
  set value = value || (d.value -> 'content') || jsonb_build_object('published_at', now(), 'published_by', auth.uid()),
      updated_by = auth.uid(), updated_at = now()
  where key = 'storefront';
  if not found then
    insert into public.settings (merchant_id, key, value, is_public, updated_by)
    values (public.current_merchant_id(), 'storefront',
            (d.value -> 'content') || jsonb_build_object('published_at', now(), 'published_by', auth.uid()), true, auth.uid());
  end if;
  delete from public.settings where key = 'storefront_draft';
  return jsonb_build_object('published_at', now());
end;
$$;

/** Throws the saved draft away (the live store stays as published). */
create or replace function public.storefront_draft_discard()
returns void
language plpgsql
security definer
set search_path = public, pg_temp
as $$
begin
  perform public.require_permission('settings.manage');
  delete from public.settings where key = 'storefront_draft';
end;
$$;

-- The draft and the SEO settings are saved on their own screens (with their own checks).
do $$
declare
  v_old text := pg_temp.lf(pg_get_functiondef('public.admin_update_setting(text,jsonb)'::regprocedure));
  v_from text := pg_temp.lf($a$if p_key in ('device_approval', 'hr', 'pbx') then$a$);
  v_to text := pg_temp.lf($b$if p_key in ('device_approval', 'hr', 'pbx', 'storefront_draft', 'seo') then$b$);
begin
  if position('storefront_draft' in v_old) > 0 then
    return;
  end if;
  if (length(v_old) - length(replace(v_old, v_from, ''))) / length(v_from) <> 1 then
    raise exception 'storefront publish: admin_update_setting has changed';
  end if;
  execute replace(v_old, v_from, v_to);
end $$;

-- Other screens save the storefront setting whole (checkout fields, sales channel): the theme and
-- footer text they send back are what was live when they opened, so the server keeps its own.
do $$
declare
  v_old text := pg_temp.lf(pg_get_functiondef('public.admin_update_setting(text,jsonb)'::regprocedure));
  v_from text := pg_temp.lf($a$  if p_key = 'store' and coalesce(p_value ->> 'order_prefix', '') !~ '^[A-Z0-9]{1,8}$' then$a$);
  v_to text := pg_temp.lf($b$  if p_key = 'storefront' then
    -- The theme and footer text change only through the theme editor's Publish.
    p_value := (p_value - 'theme' - 'footer_text' - 'published_at' - 'published_by')
      || coalesce((select jsonb_strip_nulls(jsonb_build_object('theme', s.value -> 'theme', 'footer_text', s.value -> 'footer_text',
                     'published_at', s.value -> 'published_at', 'published_by', s.value -> 'published_by'))
                   from public.settings s where s.key = 'storefront'), '{}'::jsonb);
  end if;
  if p_key = 'store' and coalesce(p_value ->> 'order_prefix', '') !~ '^[A-Z0-9]{1,8}$' then$b$);
begin
  if position('only through the theme editor' in v_old) > 0 then
    return;
  end if;
  if (length(v_old) - length(replace(v_old, v_from, ''))) / length(v_from) <> 1 then
    raise exception 'storefront publish: admin_update_setting (storefront keys) has changed';
  end if;
  execute replace(v_old, v_from, v_to);
end $$;

-- The store's settings name the business they belong to.
do $$
declare
  v_old text := pg_temp.lf(pg_get_functiondef('public.storefront_config()'::regprocedure));
  v_from text := pg_temp.lf($a$  select jsonb_build_object(
    'store', public.get_setting('store') - 'phone_pattern',$a$);
  v_to text := pg_temp.lf($b$  select jsonb_build_object(
    'merchant_id', public.current_merchant_id(),
    'store', public.get_setting('store') - 'phone_pattern',$b$);
begin
  if position('''merchant_id'', public.current_merchant_id()' in v_old) > 0 then
    return;
  end if;
  if (length(v_old) - length(replace(v_old, v_from, ''))) / length(v_from) <> 1 then
    raise exception 'storefront publish: storefront_config has changed';
  end if;
  execute replace(v_old, v_from, v_to);
end $$;

revoke all on function public._storefront_content_check(jsonb), public.storefront_draft_get(),
  public.storefront_draft_save(jsonb, timestamptz), public.storefront_publish(timestamptz), public.storefront_draft_discard()
  from public, anon;
grant execute on function public.storefront_draft_get(), public.storefront_draft_save(jsonb, timestamptz),
  public.storefront_publish(timestamptz), public.storefront_draft_discard() to authenticated;

select public._tenancy_own_functions();
