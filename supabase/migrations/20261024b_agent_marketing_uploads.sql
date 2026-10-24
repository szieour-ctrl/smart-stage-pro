-- Agent Marketing: uploaded MLS reports / CMAs for Local Market Insider (Oct 24, 2026). ADDITIVE ONLY: one new table. Nothing is
-- dropped, renamed or rewritten, and no shipped code reads it yet, so it is safe to run before or after the matching code.
-- Run it through the Supabase connector (or the SQL editor).
--
-- WHAT IS STORED: only `facts`: market-level figures (counts, medians, averages, ranges, days on market, close vs list, date windows,
-- the cities the report covers). The uploaded file itself is NEVER stored, and neither is its text, file name, property addresses,
-- names, phone numbers or emails: the code turns the report into numbers and drops the rest (see agent-marketing-report-lib.js).
-- `permission_at` / `permission_version` record the agent's checkbox: "I am permitted to use this data in my marketing, and it excludes
-- confidential client information." A report cannot be stored without it.
-- RLS is on with NO policies: service role only, same as the other agent_marketing tables.
create table if not exists public.agent_marketing_uploads (
  id uuid primary key default gen_random_uuid(),
  project_id uuid not null references public.agent_marketing_projects(id) on delete cascade,
  user_id uuid not null references public.users(id),
  file_kind text not null check (file_kind in ('pdf','csv','xlsx')),
  file_bytes integer not null check (file_bytes >= 0),
  status text not null default 'pending' check (status in ('pending','confirmed')),  -- 'confirmed' = the agent checked "This report covers… Correct?"
  facts jsonb not null,                    -- the extracted market-level figures and scope (versioned; see FACTS_VERSION)
  scope_note text,                         -- the only text about the report that may be sent to a research provider: places, dates, counts. No prices.
  permission_at timestamptz not null,
  permission_version text not null,
  confirmed_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index if not exists idx_agent_marketing_uploads_project on public.agent_marketing_uploads (project_id, created_at desc);
alter table public.agent_marketing_uploads enable row level security;
