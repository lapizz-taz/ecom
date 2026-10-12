-- UniBee registrations table. Run once in Supabase → SQL Editor.
create table if not exists public.registrations (
  id                uuid primary key,
  created_at        timestamptz not null default now(),
  full_name         text not null,
  email             text not null,
  phone             text not null,
  whatsapp          text not null,
  study_level       text not null,
  ssc_gpa           text not null,
  ssc_year          text not null,
  ssc_group         text not null,
  hsc_gpa           text not null,
  hsc_year          text not null,
  hsc_group         text not null,
  bachelor_subject  text default '',
  bachelor_cgpa     text default '',
  bachelor_year     text default '',
  english_test      text not null,
  english_score     text default '',
  english_test_date text default '',
  moi_details       text default '',
  plan_to_take_test text default '',
  moi_if_english    text default '',
  why_lithuania     text not null,
  university        text default '',
  comments          text default '',
  source            text default ''
);

create index if not exists registrations_created_at_idx on public.registrations (created_at desc);

-- Lock the table down: only the server (service role key) can read/write.
alter table public.registrations enable row level security;

-- ─────────────────────────────────────────────────────────────
-- CMS (Website content editor at /admin/content)
-- ─────────────────────────────────────────────────────────────
create table if not exists public.site_content (
  id          text primary key,            -- always 'main'
  data        jsonb not null,
  updated_at  timestamptz not null default now()
);

create table if not exists public.site_content_history (
  id        bigserial primary key,
  data      jsonb not null,
  saved_at  timestamptz not null default now()
);
create index if not exists site_content_history_saved_at_idx on public.site_content_history (saved_at desc);

alter table public.site_content enable row level security;
alter table public.site_content_history enable row level security;

-- Public bucket for images uploaded in the CMS (logos, hero photos, instructor photo).
insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values ('site-media', 'site-media', true, 5242880, array['image/jpeg', 'image/png', 'image/webp', 'image/avif'])
on conflict (id) do nothing;
