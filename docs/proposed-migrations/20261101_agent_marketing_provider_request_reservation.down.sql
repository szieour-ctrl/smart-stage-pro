-- ROLLBACK for 20261101_agent_marketing_provider_request_reservation.up.sql. PROPOSED, NOT APPLIED.
-- Order: turn the application back to the per-request check (or disable Article-Led) FIRST, then run this. It removes only objects the up-migration created.
-- Usage is not lost: every Article-Led research row still carries usage.providerRequests (written before each dispatch), which the application's own check reads.
drop function if exists public.agent_marketing_reserve_provider_request(uuid, uuid, integer, integer, integer);
drop function if exists public.agent_marketing_prune_provider_requests(interval);
drop function if exists public.agent_marketing_safe_int(text);
drop table if exists public.agent_marketing_provider_requests;
drop table if exists public.agent_marketing_provider_request_cutover;
