-- PROPOSED, NOT APPLIED. Stage B: B1 article evidence for a selected Article-Led project (development only; design: docs/b1-stage-b-design.md;
-- review: docs/b1-stage-b-migration-review.md). Revision 2 (Nov 5, 2026): the review fixes R1-R10 below.
-- ADDITIVE ONLY: one new table, one nullable column and two triggers on agent_marketing_projects. No existing row, column or policy changes. The
-- only code that reads these objects (lib/agent-marketing-b1-stageb-lib.js, lib/agent-marketing-b1-store-lib.js) is inert unless
-- AGENT_MARKETING_B1_EVIDENCE=dev. Idempotent. Rollback: 20261105_agent_marketing_article_evidence.down.sql.
-- Verified on a throwaway local PostgreSQL 16 cluster by scripts/b1-migration-check.sh (never on a hosted project).
--
-- One row = one B1 run (or one re-use of a completed run) over one frozen source snapshot with one set of B1 request settings and one gate version.
-- Written by the service role only: RLS on with NO policies, and no table privileges for anon/authenticated (R9). Browsers never read these rows.

create table if not exists public.agent_marketing_article_evidence (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references public.users(id) on delete cascade,
  project_id uuid references public.agent_marketing_projects(id) on delete set null,
  research_id uuid references public.agent_marketing_research(id) on delete set null,
  topic_id text not null,                          -- selected_topic.id at the time B1 ran
  source_url text not null,                        -- the selected article
  final_url text,                                  -- after redirects (same site only; the capture refuses a cross-site redirect)
  raw_html_sha256 text check (raw_html_sha256 ~ '^[0-9a-f]{64}$'),
  extractor_sha256 text check (extractor_sha256 ~ '^[0-9a-f]{64}$'),   -- the exact extract_v2 source used
  bridge_version text,
  capture_flags jsonb not null default '[]'::jsonb,
  reused_from uuid references public.agent_marketing_article_evidence(id) on delete set null,   -- a completed result copied without a new B1 call; the copy
                                                   -- carries its own snapshot, request, raw response and hashes, so it stays self-contained
  snapshot_text text not null,                     -- the exact retrieved article text B1 read (frozen from insert, R3)
  snapshot_sha256 text not null check (snapshot_sha256 ~ '^[0-9a-f]{64}$'),
  extractor text not null,                         -- e.g. extract_v2
  snapshot_retrieved_at timestamptz not null,
  prompt_version text not null,                    -- e.g. v1.2.1
  instructions_sha256 text not null check (instructions_sha256 ~ '^[0-9a-f]{64}$'),
  model text not null,
  max_output_tokens integer not null,
  reasoning_effort text not null,
  cache_key text not null check (cache_key ~ '^[0-9a-f]{64}$'),   -- lib cacheKey(): snapshot + B1 settings; gate version excluded
  request_text text not null,                      -- the exact request (its input wraps snapshot_text), fixed before any provider call (R7)
  request_sha256 text not null check (request_sha256 ~ '^[0-9a-f]{64}$'),
  input_sha256 text not null check (input_sha256 ~ '^[0-9a-f]{64}$'),
  raw_response_text text,                          -- the provider's response, byte for byte
  raw_response_sha256 text check (raw_response_sha256 ~ '^[0-9a-f]{64}$'),
  gate_version text,
  bundle jsonb,                                    -- the ssp-b1-evidence/1 document, re-checked by the code on every read
  completeness_status text check (completeness_status in ('COMPLETE','PASSED_WITH_HOLDS','BLOCKED')),
  status text not null check (status in ('reserved','running','ready','failed')),
  error text,
  cost_usd numeric(10,5),
  created_at timestamptz not null default now(),
  reserved_at timestamptz not null default now(),  -- a 'reserved'/'running' row older than the provider timeout may be marked 'failed' and retried
  finished_at timestamptz,
  -- R7: a ready row carries everything the code re-checks. Nothing about a ready row can be missing.
  constraint amae_ready_complete check (status <> 'ready' or (raw_response_text is not null and raw_response_sha256 is not null
    and gate_version is not null and bundle is not null and completeness_status is not null))
);

-- R4: no concurrent duplicate B1 request: at most ONE in-flight run per cache key across all users.
create unique index if not exists uq_amae_inflight_cache_key on public.agent_marketing_article_evidence (cache_key) where status in ('reserved','running');
-- R4: idempotent per project. One ready row per project, cache key and gate version; a 'failed' row never blocks a retry (rev 1 blocked it).
drop index if exists public.uq_amae_project_cache_key;
create unique index if not exists uq_amae_project_ready on public.agent_marketing_article_evidence (project_id, cache_key, gate_version) where status = 'ready';
create index if not exists idx_amae_project on public.agent_marketing_article_evidence (project_id, created_at desc);
create index if not exists idx_amae_cache_key on public.agent_marketing_article_evidence (cache_key, status);
alter table public.agent_marketing_article_evidence enable row level security;
-- R9: raw provider responses and audit records: no client role may touch the table even if a policy were added by mistake later.
revoke all on table public.agent_marketing_article_evidence from anon, authenticated, public;

-- The project's chosen evidence row. Null = no Stage B evidence (with the switch on, an Article-Led plan then fails closed).
alter table public.agent_marketing_projects add column if not exists article_evidence_id uuid references public.agent_marketing_article_evidence(id) on delete set null;

-- R1, R2: ownership. A row's user must own its project, and its research run must belong to that project.
create or replace function public.agent_marketing_article_evidence_owner() returns trigger language plpgsql set search_path = public, pg_temp as $$
begin
  if new.project_id is not null and not exists (select 1 from public.agent_marketing_projects p where p.id = new.project_id and p.user_id = new.user_id) then
    raise exception 'agent_marketing_article_evidence: user does not own the project';
  end if;
  if new.research_id is not null and new.project_id is not null and not exists (
      select 1 from public.agent_marketing_research r where r.id = new.research_id and r.project_id = new.project_id and r.user_id = new.user_id) then
    raise exception 'agent_marketing_article_evidence: research run does not belong to the project';
  end if;
  if tg_op = 'INSERT' and new.status not in ('reserved') and not (new.status = 'ready' and new.reused_from is not null) then
    raise exception 'agent_marketing_article_evidence: a new row is reserved, or ready only as a copy of a completed row (reused_from)';
  end if;
  if new.reused_from is not null and not exists (select 1 from public.agent_marketing_article_evidence s where s.id = new.reused_from and s.status = 'ready'
      and s.cache_key = new.cache_key and s.raw_response_sha256 is not distinct from new.raw_response_sha256) then
    raise exception 'agent_marketing_article_evidence: reused_from must be a ready row with the same cache key and raw response';
  end if;
  return new;
end $$;
drop trigger if exists trg_amae_owner on public.agent_marketing_article_evidence;
create trigger trg_amae_owner before insert or update of project_id, user_id, research_id, status, reused_from on public.agent_marketing_article_evidence
  for each row execute function public.agent_marketing_article_evidence_owner();

-- R3, R5, R6: immutability and state. What B1 was given is frozen from insert; what it returned and the gate's bundle are frozen once ready
-- (rev 1 let a re-gate overwrite the bundle in place: that would modify historical evidence; a re-gate is now a new row with reused_from).
-- Status moves only forward: reserved -> running -> ready | failed, reserved -> ready | failed. ready and failed are final.
-- The only later changes a ready row accepts are the ON DELETE SET NULL links (project_id, research_id, reused_from) going to null.
create or replace function public.agent_marketing_article_evidence_freeze() returns trigger language plpgsql set search_path = public, pg_temp as $$
begin
  if (new.user_id, new.topic_id, new.source_url, new.final_url, new.raw_html_sha256, new.extractor_sha256, new.bridge_version, new.capture_flags,
      new.snapshot_text, new.snapshot_sha256, new.extractor, new.snapshot_retrieved_at, new.prompt_version, new.instructions_sha256,
      new.model, new.max_output_tokens, new.reasoning_effort, new.cache_key, new.request_text, new.request_sha256, new.input_sha256, new.created_at,
      new.reserved_at)
     is distinct from
     (old.user_id, old.topic_id, old.source_url, old.final_url, old.raw_html_sha256, old.extractor_sha256, old.bridge_version, old.capture_flags,
      old.snapshot_text, old.snapshot_sha256, old.extractor, old.snapshot_retrieved_at, old.prompt_version, old.instructions_sha256,
      old.model, old.max_output_tokens, old.reasoning_effort, old.cache_key, old.request_text, old.request_sha256, old.input_sha256, old.created_at,
      old.reserved_at) then
    raise exception 'agent_marketing_article_evidence: the snapshot, request and B1 settings are immutable';
  end if;
  if old.status in ('ready','failed') then
    if new.status is distinct from old.status or (new.raw_response_text, new.raw_response_sha256, new.gate_version, new.bundle, new.completeness_status,
        new.error, new.cost_usd, new.finished_at) is distinct from (old.raw_response_text, old.raw_response_sha256, old.gate_version, old.bundle,
        old.completeness_status, old.error, old.cost_usd, old.finished_at)
       or (new.project_id is distinct from old.project_id and new.project_id is not null)
       or (new.research_id is distinct from old.research_id and new.research_id is not null)
       or (new.reused_from is distinct from old.reused_from and new.reused_from is not null) then
      raise exception 'agent_marketing_article_evidence: a % row is final', old.status;
    end if;
  elsif new.reused_from is distinct from old.reused_from then
    raise exception 'agent_marketing_article_evidence: reused_from is set only at insert';
  elsif not ((old.status = 'reserved' and new.status in ('reserved','running','ready','failed'))
          or (old.status = 'running' and new.status in ('running','ready','failed'))) then
    raise exception 'agent_marketing_article_evidence: status cannot move from % to %', old.status, new.status;
  end if;
  return new;
end $$;
drop trigger if exists trg_amae_freeze on public.agent_marketing_article_evidence;
create trigger trg_amae_freeze before update on public.agent_marketing_article_evidence for each row execute function public.agent_marketing_article_evidence_freeze();

-- R8: audit records are not deleted directly. A ready or failed row goes only with its user (ON DELETE CASCADE from public.users, which runs inside
-- the referential-integrity trigger, so pg_trigger_depth() > 1). Reserved rows may be deleted (an abandoned reservation that never called B1).
create or replace function public.agent_marketing_article_evidence_nodelete() returns trigger language plpgsql set search_path = public, pg_temp as $$
begin
  if old.status in ('ready','failed') and pg_trigger_depth() <= 1 then
    raise exception 'agent_marketing_article_evidence: % rows are audit records and are not deleted', old.status;
  end if;
  return old;
end $$;
drop trigger if exists trg_amae_nodelete on public.agent_marketing_article_evidence;
create trigger trg_amae_nodelete before delete on public.agent_marketing_article_evidence for each row execute function public.agent_marketing_article_evidence_nodelete();

-- R1: the project's pointer may name only a ready row of the same project and user.
-- R10: stale-result detection in the database too: changing the selected topic or research run clears the pointer (unless the same statement sets a
-- new one), so a plan can never read evidence for a topic that is no longer selected. The code's checkRecord topic check stays as a second guard.
create or replace function public.agent_marketing_projects_article_evidence() returns trigger language plpgsql set search_path = public, pg_temp as $$
begin
  if tg_op = 'UPDATE' and (new.selected_topic is distinct from old.selected_topic or new.selected_research_id is distinct from old.selected_research_id)
     and new.article_evidence_id is not distinct from old.article_evidence_id then
    new.article_evidence_id := null;
  end if;
  if new.article_evidence_id is not null and not exists (select 1 from public.agent_marketing_article_evidence e where e.id = new.article_evidence_id
      and e.project_id = new.id and e.user_id = new.user_id and e.status = 'ready') then
    raise exception 'agent_marketing_projects: article_evidence_id must name a ready evidence row of this project and user';
  end if;
  return new;
end $$;
drop trigger if exists trg_amp_article_evidence on public.agent_marketing_projects;
create trigger trg_amp_article_evidence before insert or update on public.agent_marketing_projects
  for each row execute function public.agent_marketing_projects_article_evidence();

revoke all on function public.agent_marketing_article_evidence_owner() from public, anon, authenticated;
revoke all on function public.agent_marketing_article_evidence_freeze() from public, anon, authenticated;
revoke all on function public.agent_marketing_article_evidence_nodelete() from public, anon, authenticated;
revoke all on function public.agent_marketing_projects_article_evidence() from public, anon, authenticated;
