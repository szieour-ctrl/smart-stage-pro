-- Agent Marketing: notes from the agent when a step is "not right" (Oct 25, 2026). ADDITIVE ONLY: one new table. Nothing is dropped, renamed or
-- rewritten, and no shipped code reads it except the new "feedback" action, so it is safe to run before or after the matching code.
-- Run it through the Supabase connector (or the SQL editor).
--
-- WHAT IS STORED: which step ('report' first), the reasons the agent ticked, an optional note (600 characters), and a small `context`:
-- the scope sentence and layout of the report read, its window and sample size. NEVER the file, its text, addresses, names, phones or emails.
-- RLS is on with NO policies: service role only, same as the other agent_marketing tables.
create table if not exists public.agent_marketing_feedback (
  id uuid primary key default gen_random_uuid(),
  project_id uuid references public.agent_marketing_projects(id) on delete cascade,
  user_id uuid not null references public.users(id),
  stage text not null check (stage in ('report','topic','script','visuals')),
  reasons text[] not null default '{}',
  message text,
  context jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now()
);
create index if not exists idx_agent_marketing_feedback_project on public.agent_marketing_feedback (project_id, created_at desc);
alter table public.agent_marketing_feedback enable row level security;
