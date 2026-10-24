-- Agent Marketing research: shared allowance pools (Oct 24, 2026). ADDITIVE ONLY: one new nullable column, one index, one backfill.
-- A team's 30 and a brokerage's 100 research sessions are shared by every member (same rule as Reels), so each research row records
-- the pool it draws from: the team lead / brokerage admin, or the user themself for Solo, trial and package accounts.
-- Run in the Supabase SQL editor after 20261024_agent_marketing_research.sql.
alter table public.agent_marketing_research add column if not exists pool_user_id uuid references public.users(id);
-- Rows written before this column existed belong to their own user's pool.
update public.agent_marketing_research set pool_user_id = user_id where pool_user_id is null;
create index if not exists idx_agent_marketing_research_pool_charged on public.agent_marketing_research (pool_user_id, charged_at) where charged_at is not null;
