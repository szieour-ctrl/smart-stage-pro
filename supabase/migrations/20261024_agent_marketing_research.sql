-- Agent Marketing: Local Market Insider research sessions (Oct 24, 2026). ADDITIVE ONLY: one new table, two new nullable
-- columns on agent_marketing_projects. Nothing is dropped, renamed or rewritten, and no shipped code reads these objects
-- yet, so it is safe to run before or after the matching code. Run it in the Supabase SQL editor.
-- RLS is on with NO policies: service role only, same as the other agent_marketing tables.
--
-- One row per research request ("session"). A project can have several (New Topics starts another). A session is CHARGED
-- only when charged_at is set, and the code sets it in the same write that stores a validated five-topic result. Failed,
-- timed-out and unusable runs are stored with status 'failed' and charged_at NULL, so they never use an included session.
-- Reopening saved research reads this table and uses none.
create table if not exists public.agent_marketing_research (
  id uuid primary key default gen_random_uuid(),
  project_id uuid not null references public.agent_marketing_projects(id) on delete cascade,
  user_id uuid not null references public.users(id),
  mode text not null check (mode in ('market_update','local_events')),
  geography jsonb not null,                -- { type, name, city, label }: the agent's own definition, never widened by the code
  audience text not null,
  focus jsonb not null default '{}'::jsonb,   -- { active_adult_55, new_construction }
  upload_refs jsonb not null default '[]'::jsonb,  -- agent-uploaded report ids/scope notes used as context (processing built later)
  status text not null default 'running' check (status in ('running','ready','failed')),
  model text,
  topics jsonb,                            -- exactly five validated topics when status = 'ready'
  research_date date,                      -- the day the research ran (stale-claim check before publishing)
  usage jsonb,                             -- measured tokens / search queries / cost from the provider, for cost benchmarking
  error text,
  charged_at timestamptz,                  -- set only with a delivered, validated five-topic set
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index if not exists idx_agent_marketing_research_project on public.agent_marketing_research (project_id, created_at desc);
create index if not exists idx_agent_marketing_research_user_charged on public.agent_marketing_research (user_id, charged_at) where charged_at is not null;
alter table public.agent_marketing_research enable row level security;

-- The topic the agent picked. Kept on the project so resuming a draft needs no new research call.
alter table public.agent_marketing_projects add column if not exists selected_research_id uuid references public.agent_marketing_research(id) on delete set null;
alter table public.agent_marketing_projects add column if not exists selected_topic jsonb;   -- frozen copy of the chosen topic with its sources
