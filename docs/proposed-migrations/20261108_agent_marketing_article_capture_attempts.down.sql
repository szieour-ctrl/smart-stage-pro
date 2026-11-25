-- Rollback of 20261108_agent_marketing_article_capture_attempts.up.sql (development only). Removes the attempt log and its functions.
-- Nothing else depends on it; the evidence table and its rows are untouched.
drop table if exists public.agent_marketing_article_capture_attempts;
drop function if exists public.agent_marketing_article_capture_attempts_owner();
drop function if exists public.agent_marketing_article_capture_attempts_freeze();
drop function if exists public.agent_marketing_article_capture_attempts_nodelete();
