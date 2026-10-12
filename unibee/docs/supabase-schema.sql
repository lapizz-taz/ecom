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
