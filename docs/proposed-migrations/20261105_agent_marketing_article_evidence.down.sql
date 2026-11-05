-- PROPOSED, NOT APPLIED. Rollback of 20261105_agent_marketing_article_evidence.up.sql (revision 3; the R11 columns go with the table). Drops the Stage B evidence (development data only).
drop trigger if exists trg_amp_article_evidence on public.agent_marketing_projects;
drop function if exists public.agent_marketing_projects_article_evidence();
alter table public.agent_marketing_projects drop column if exists article_evidence_id;
drop table if exists public.agent_marketing_article_evidence;   -- drops its triggers too
drop function if exists public.agent_marketing_article_evidence_owner();
drop function if exists public.agent_marketing_article_evidence_freeze();
drop function if exists public.agent_marketing_article_evidence_nodelete();
