-- Agent Marketing reel series (Nov 28, 2026). ADDITIVE ONLY: two nullable columns, a trigger, indexes. Nothing is dropped, renamed or rewritten.
-- Existing projects keep empty lineage and can be used as series roots. No code reads these columns until the matching deploy.
-- Apply through the Supabase connector (project dnpaenpwdhjmslymgkse) BEFORE the deploy that uses it.
--
-- source_project_id         the reel the subscriber clicked "Create a follow-up reel" on
-- series_root_project_id    the original reel of the series
-- creation_key              client-generated key for one follow-up request; a double click or a network retry returns the same draft
--
-- First follow-up:   source = original, root = original.
-- Follow-up of a follow-up (episode 3 from episode 2): source = episode 2, root = the original.

alter table public.agent_marketing_projects add column if not exists source_project_id uuid references public.agent_marketing_projects(id) on delete set null;
alter table public.agent_marketing_projects add column if not exists series_root_project_id uuid references public.agent_marketing_projects(id) on delete set null;
alter table public.agent_marketing_projects add column if not exists creation_key text;

-- Series lookup: the original is listed with its descendants by querying (user, id) alongside (user, root).
create index if not exists idx_agent_marketing_projects_series on public.agent_marketing_projects (user_id, series_root_project_id, created_at);
create index if not exists idx_agent_marketing_projects_source on public.agent_marketing_projects (source_project_id);
-- Retry-safe creation: one draft per subscriber per request key.
create unique index if not exists uq_agent_marketing_projects_creation_key on public.agent_marketing_projects (user_id, creation_key) where creation_key is not null;

-- Same-owner and consistency rules, enforced at the database boundary (the service role cannot bypass a trigger).
create or replace function public.agent_marketing_projects_lineage_check() returns trigger language plpgsql as $$
declare
  src public.agent_marketing_projects%rowtype;
  root public.agent_marketing_projects%rowtype;
begin
  if new.source_project_id is null and new.series_root_project_id is null then
    return new;
  end if;
  if new.source_project_id is null or new.series_root_project_id is null then
    raise exception 'source_project_id and series_root_project_id must be set together';
  end if;
  if new.source_project_id = new.id or new.series_root_project_id = new.id then
    raise exception 'a project cannot be its own source or series root';
  end if;
  select * into src from public.agent_marketing_projects where id = new.source_project_id;
  select * into root from public.agent_marketing_projects where id = new.series_root_project_id;
  if src.id is null or root.id is null then
    raise exception 'source or series root project not found';
  end if;
  if src.user_id <> new.user_id or root.user_id <> new.user_id then
    raise exception 'source and series root must belong to the same subscriber';
  end if;
  -- The root is the original reel (it is not itself a follow-up), and the source belongs to that series: it is the root or one of its descendants.
  if root.series_root_project_id is not null then
    raise exception 'series_root_project_id must point at the original reel';
  end if;
  if src.id <> root.id and src.series_root_project_id is distinct from root.id then
    raise exception 'source project is not part of the series root';
  end if;
  return new;
end $$;

drop trigger if exists trg_agent_marketing_projects_lineage on public.agent_marketing_projects;
create trigger trg_agent_marketing_projects_lineage
  before insert or update of source_project_id, series_root_project_id, user_id on public.agent_marketing_projects
  for each row execute function public.agent_marketing_projects_lineage_check();
