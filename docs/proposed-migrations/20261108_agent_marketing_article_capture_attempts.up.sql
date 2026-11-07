-- PROPOSED (development only). Live-fetch Stage B: an append-only log of article capture attempts (docs/b1-live-fetch-spec.md, C2).
-- REQUIRES 20261105_agent_marketing_article_evidence.up.sql (foreign key compared_to). ADDITIVE ONLY: one new table, three trigger functions.
-- No existing table, row, column or policy changes. The only code that writes or reads it (lib/agent-marketing-b1-store-lib.js) is inert unless
-- AGENT_MARKETING_B1_EVIDENCE=dev. Idempotent. Rollback: 20261108_agent_marketing_article_capture_attempts.down.sql.
-- Verified on a throwaway local PostgreSQL cluster by scripts/b1-attempts-migration-check.sh before any hosted use.
--
-- One row = one capture attempt that did NOT produce an evidence row: a source verification (unchanged / source_changed / no_baseline) or a
-- failure before an evidence row could exist (fetch, snapshot or comparison). MINIMAL BY DESIGN: hashes, URLs, an HTTP status, a content
-- type, a size and the observed page title. Never the article HTML or text, never a provider request or response, never a credential.
-- Written by the service role only: RLS on with NO policies, and no table privileges for anon/authenticated. Browsers never read these rows.
create table if not exists public.agent_marketing_article_capture_attempts (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references public.users(id) on delete cascade,
  project_id uuid references public.agent_marketing_projects(id) on delete set null,
  topic_id text not null check (length(topic_id) between 1 and 200),
  mode text not null check (mode in ('verify_source', 'evidence')),
  stage text not null check (stage in ('fetch', 'snapshot', 'compare')),
  outcome text not null check (outcome ~ '^[a-z][a-z_]{1,39}$'),   -- unchanged | source_changed | no_baseline | a failure code
  http_status smallint check (http_status between 100 and 599),
  content_type text check (length(content_type) <= 200),
  bytes integer check (bytes >= 0),
  source_url text not null check (length(source_url) between 1 and 2048),
  final_url text check (length(final_url) <= 2048),
  observed_title text check (length(observed_title) <= 500),       -- the fetched page's <title>: provenance only, never used in a request
  raw_html_sha256 text check (raw_html_sha256 ~ '^[0-9a-f]{64}$'),
  snapshot_sha256 text check (snapshot_sha256 ~ '^[0-9a-f]{64}$'),
  compared_to uuid references public.agent_marketing_article_evidence(id) on delete set null,
  created_at timestamptz not null default now(),
  constraint amca_compare_has_snapshot check (stage <> 'compare' or snapshot_sha256 is not null),
  constraint amca_compared_only_on_compare check (compared_to is null or stage = 'compare')
);
create index if not exists idx_amca_project on public.agent_marketing_article_capture_attempts (project_id, created_at desc);
create index if not exists idx_amca_user on public.agent_marketing_article_capture_attempts (user_id, created_at desc);

alter table public.agent_marketing_article_capture_attempts enable row level security;
revoke all on table public.agent_marketing_article_capture_attempts from anon, authenticated, public;

-- Ownership at insert: the user owns the project, and the compared evidence row is a ready row of that same project and user.
create or replace function public.agent_marketing_article_capture_attempts_owner() returns trigger language plpgsql set search_path = public, pg_temp as $$
begin
  if new.project_id is not null and not exists (select 1 from public.agent_marketing_projects p where p.id = new.project_id and p.user_id = new.user_id) then
    raise exception 'agent_marketing_article_capture_attempts: user does not own the project';
  end if;
  if new.compared_to is not null and not exists (select 1 from public.agent_marketing_article_evidence e where e.id = new.compared_to
      and e.project_id = new.project_id and e.user_id = new.user_id and e.status = 'ready') then
    raise exception 'agent_marketing_article_capture_attempts: compared_to must be a ready evidence row of the same project and user';
  end if;
  return new;
end $$;
drop trigger if exists trg_amca_owner on public.agent_marketing_article_capture_attempts;
create trigger trg_amca_owner before insert on public.agent_marketing_article_capture_attempts
  for each row execute function public.agent_marketing_article_capture_attempts_owner();

-- Append-only: no update, except the ON DELETE SET NULL links (project_id, compared_to) going to null.
create or replace function public.agent_marketing_article_capture_attempts_freeze() returns trigger language plpgsql set search_path = public, pg_temp as $$
begin
  if (new.id, new.user_id, new.topic_id, new.mode, new.stage, new.outcome, new.http_status, new.content_type, new.bytes, new.source_url,
      new.final_url, new.observed_title, new.raw_html_sha256, new.snapshot_sha256, new.created_at)
     is distinct from
     (old.id, old.user_id, old.topic_id, old.mode, old.stage, old.outcome, old.http_status, old.content_type, old.bytes, old.source_url,
      old.final_url, old.observed_title, old.raw_html_sha256, old.snapshot_sha256, old.created_at)
     or (new.project_id is distinct from old.project_id and new.project_id is not null)
     or (new.compared_to is distinct from old.compared_to and new.compared_to is not null) then
    raise exception 'agent_marketing_article_capture_attempts: attempts are append-only';
  end if;
  return new;
end $$;
drop trigger if exists trg_amca_freeze on public.agent_marketing_article_capture_attempts;
create trigger trg_amca_freeze before update on public.agent_marketing_article_capture_attempts
  for each row execute function public.agent_marketing_article_capture_attempts_freeze();

-- No direct delete: an attempt goes only with its user (ON DELETE CASCADE runs inside the referential trigger, so pg_trigger_depth() > 1).
create or replace function public.agent_marketing_article_capture_attempts_nodelete() returns trigger language plpgsql set search_path = public, pg_temp as $$
begin
  if pg_trigger_depth() <= 1 then
    raise exception 'agent_marketing_article_capture_attempts: attempts are audit records and are not deleted';
  end if;
  return old;
end $$;
drop trigger if exists trg_amca_nodelete on public.agent_marketing_article_capture_attempts;
create trigger trg_amca_nodelete before delete on public.agent_marketing_article_capture_attempts
  for each row execute function public.agent_marketing_article_capture_attempts_nodelete();

revoke all on function public.agent_marketing_article_capture_attempts_owner() from public, anon, authenticated;
revoke all on function public.agent_marketing_article_capture_attempts_freeze() from public, anon, authenticated;
revoke all on function public.agent_marketing_article_capture_attempts_nodelete() from public, anon, authenticated;
