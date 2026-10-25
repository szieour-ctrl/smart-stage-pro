-- Agent Marketing: which data a research session used (Oct 24, 2026). ADDITIVE ONLY: one new column with a default, so every existing row
-- and every deployed version of the code keeps working unchanged. Run it through the Supabase connector (or the SQL editor).
--   'web'    = web research only (what every session did before)
--   'upload' = the agent's confirmed MLS report(s) only
--   'both'   = report topics first, web research for the rest
-- Which reports were used lives in the existing upload_refs column ([{ id, scope_note }]).
alter table public.agent_marketing_research
  add column if not exists data_source text not null default 'web' check (data_source in ('web','upload','both'));
