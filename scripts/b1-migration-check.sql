-- Checks for docs/proposed-migrations/20261105_agent_marketing_article_evidence.up.sql (run by scripts/b1-migration-check.sh on a THROWAWAY local
-- cluster only). Every check prints PASS or raises. Uses the repo's real agent-marketing migrations underneath, with stubbed users/marketing_profiles.
\set ON_ERROR_STOP on
create or replace function pg_temp.expect_error(sql text, pattern text, label text) returns void language plpgsql as $$
begin
  begin execute sql; exception when others then
    if sqlerrm ~* pattern then raise notice 'PASS %', label; return; end if;
    raise exception 'FAIL %: wrong error: %', label, sqlerrm;
  end;
  raise exception 'FAIL %: statement succeeded', label;
end $$;
create or replace function pg_temp.ok(cond boolean, label text) returns void language plpgsql as $$
begin if cond then raise notice 'PASS %', label; else raise exception 'FAIL %', label; end if; end $$;

-- fixtures: two users, a project and research run each
insert into public.users(id) values ('00000000-0000-0000-0000-00000000000a'), ('00000000-0000-0000-0000-00000000000b');
insert into public.agent_marketing_projects(id, user_id, template) values
  ('10000000-0000-0000-0000-00000000000a', '00000000-0000-0000-0000-00000000000a', 'local_market_insider'),
  ('10000000-0000-0000-0000-00000000000b', '00000000-0000-0000-0000-00000000000b', 'local_market_insider');
insert into public.agent_marketing_research(id, project_id, user_id, mode, geography, audience) values
  ('20000000-0000-0000-0000-00000000000a', '10000000-0000-0000-0000-00000000000a', '00000000-0000-0000-0000-00000000000a', 'market_update', '{}', 'sellers'),
  ('20000000-0000-0000-0000-00000000000b', '10000000-0000-0000-0000-00000000000b', '00000000-0000-0000-0000-00000000000b', 'market_update', '{}', 'sellers');

create temp view h as select repeat('a',64) a64, repeat('b',64) b64, repeat('c',64) c64, repeat('d',64) d64;
create or replace function pg_temp.ins(id text, uid text, pid text, rid text, key text, status text, reused text default null) returns text language sql as $$
  insert into public.agent_marketing_article_evidence(id, user_id, project_id, research_id, topic_id, source_url, snapshot_text, snapshot_sha256, extractor,
    snapshot_retrieved_at, prompt_version, instructions_sha256, model, max_output_tokens, reasoning_effort, cache_key, request_text, request_sha256, input_sha256,
    raw_response_text, raw_response_sha256, gate_version, bundle, completeness_status, status, reused_from)
  values (id::uuid, uid::uuid, pid::uuid, rid::uuid, 't1', 'https://example.test/a', 'text', repeat('a',64), 'extract_v2', now(), 'v1.2.1', repeat('b',64),
    'm', 5000, 'minimal', key, 'req', repeat('c',64), repeat('d',64),
    case when status = 'ready' then 'resp' end, case when status = 'ready' then repeat('e',64) end, case when status = 'ready' then 'g1' end,
    case when status = 'ready' then '{"status":"COMPLETE"}'::jsonb end, case when status = 'ready' then 'COMPLETE' end, status, reused::uuid)
  returning id::text $$;
\set UA '00000000-0000-0000-0000-00000000000a'
\set UB '00000000-0000-0000-0000-00000000000b'
\set PA '10000000-0000-0000-0000-00000000000a'
\set PB '10000000-0000-0000-0000-00000000000b'
\set RA '20000000-0000-0000-0000-00000000000a'
\set RB '20000000-0000-0000-0000-00000000000b'
\set K1 '1111111111111111111111111111111111111111111111111111111111111111'
\set K2 '2222222222222222222222222222222222222222222222222222222222222222'

-- R1/R2 ownership
select pg_temp.expect_error($$select pg_temp.ins('30000000-0000-0000-0000-000000000001', '00000000-0000-0000-0000-00000000000b', '10000000-0000-0000-0000-00000000000a', null, '1111111111111111111111111111111111111111111111111111111111111111', 'reserved')$$, 'does not own the project', 'R1 a user cannot attach evidence to another user''s project');
select pg_temp.expect_error($$select pg_temp.ins('30000000-0000-0000-0000-000000000001', '00000000-0000-0000-0000-00000000000a', '10000000-0000-0000-0000-00000000000a', '20000000-0000-0000-0000-00000000000b', '1111111111111111111111111111111111111111111111111111111111111111', 'reserved')$$, 'research run does not belong', 'R2 research run must belong to the project');
select pg_temp.expect_error($$select pg_temp.ins('30000000-0000-0000-0000-000000000001', '00000000-0000-0000-0000-00000000000a', '10000000-0000-0000-0000-00000000000a', null, '1111111111111111111111111111111111111111111111111111111111111111', 'ready')$$, 'reserved, or ready only as a copy', 'R6 a new row cannot be inserted ready without reused_from');

-- R4 one in-flight run per cache key across users; retry after failure
select pg_temp.ins('30000000-0000-0000-0000-000000000001', :'UA', :'PA', :'RA', :'K1', 'reserved');
select pg_temp.expect_error($$select pg_temp.ins('30000000-0000-0000-0000-000000000002', '00000000-0000-0000-0000-00000000000b', '10000000-0000-0000-0000-00000000000b', null, '1111111111111111111111111111111111111111111111111111111111111111', 'reserved')$$, 'uq_amae_inflight_cache_key', 'R4 a second concurrent B1 reservation for the same cache key is refused (any user)');
update public.agent_marketing_article_evidence set status = 'failed', error = 'timeout', finished_at = now() where id = '30000000-0000-0000-0000-000000000001';
select pg_temp.ins('30000000-0000-0000-0000-000000000003', :'UA', :'PA', :'RA', :'K1', 'reserved');
select pg_temp.ok(true, 'R4 a failed run does not block a retry for the same project and key');
select pg_temp.expect_error($$update public.agent_marketing_article_evidence set status = 'reserved' where id = '30000000-0000-0000-0000-000000000001'$$, 'final', 'R6 a failed row is final');
select pg_temp.expect_error($$delete from public.agent_marketing_article_evidence where id = '30000000-0000-0000-0000-000000000001'$$, 'audit records', 'R8 a failed row is not deleted directly');

-- R3 snapshot and request immutable from insert (before ready)
select pg_temp.expect_error($$update public.agent_marketing_article_evidence set snapshot_text = 'later version' where id = '30000000-0000-0000-0000-000000000003'$$, 'immutable', 'R3 a reserved snapshot cannot be replaced by a later webpage version');
select pg_temp.expect_error($$update public.agent_marketing_article_evidence set request_text = 'other' where id = '30000000-0000-0000-0000-000000000003'$$, 'immutable', 'R3 the exact B1 request cannot change after reservation');
select pg_temp.expect_error($$update public.agent_marketing_article_evidence set cache_key = repeat('9',64) where id = '30000000-0000-0000-0000-000000000003'$$, 'immutable', 'R3 the cache key cannot change');
-- R7 ready needs its evidence
select pg_temp.expect_error($$update public.agent_marketing_article_evidence set status = 'ready' where id = '30000000-0000-0000-0000-000000000003'$$, 'amae_ready_complete', 'R7 a row cannot become ready without raw response, gate version, bundle and status');
update public.agent_marketing_article_evidence set raw_response_text = 'resp', raw_response_sha256 = repeat('e',64), gate_version = 'g1',
  bundle = '{"status":"PASSED_WITH_HOLDS"}', completeness_status = 'PASSED_WITH_HOLDS', status = 'ready', finished_at = now()
  where id = '30000000-0000-0000-0000-000000000003';
select pg_temp.ok((select status = 'ready' and completeness_status = 'PASSED_WITH_HOLDS' from public.agent_marketing_article_evidence where id = '30000000-0000-0000-0000-000000000003'), 'reserved -> ready with full evidence; PASSED_WITH_HOLDS stored as such');

-- R5 frozen once ready (raw response, bundle, status)
select pg_temp.expect_error($$update public.agent_marketing_article_evidence set raw_response_text = 'x' where id = '30000000-0000-0000-0000-000000000003'$$, 'final', 'R5 the raw provider response is immutable once ready');
select pg_temp.expect_error($$update public.agent_marketing_article_evidence set bundle = '{"status":"COMPLETE"}', completeness_status = 'COMPLETE' where id = '30000000-0000-0000-0000-000000000003'$$, 'final', 'R5 a ready bundle cannot be upgraded in place (PASSED_WITH_HOLDS stays incomplete)');
select pg_temp.expect_error($$update public.agent_marketing_article_evidence set status = 'failed' where id = '30000000-0000-0000-0000-000000000003'$$, 'final', 'R6 ready is final');
select pg_temp.expect_error($$delete from public.agent_marketing_article_evidence where id = '30000000-0000-0000-0000-000000000003'$$, 'audit records', 'R8 a ready row is not deleted directly');
select pg_temp.expect_error($$select pg_temp.ins('30000000-0000-0000-0000-000000000009', '00000000-0000-0000-0000-00000000000a', '10000000-0000-0000-0000-00000000000a', '20000000-0000-0000-0000-00000000000a', '1111111111111111111111111111111111111111111111111111111111111111', 'ready', '30000000-0000-0000-0000-000000000003')$$, 'uq_amae_project_ready', 'R4 one ready row per project, key and gate version (idempotent)');

-- reuse: B copies A's completed result (no new B1 call); a copy must match the source
select pg_temp.ins('30000000-0000-0000-0000-000000000004', :'UB', :'PB', :'RB', :'K1', 'ready', '30000000-0000-0000-0000-000000000003');
select pg_temp.ok(true, 'reuse: another project copies a completed result as ready with reused_from');
select pg_temp.expect_error($$select pg_temp.ins('30000000-0000-0000-0000-000000000005', '00000000-0000-0000-0000-00000000000b', '10000000-0000-0000-0000-00000000000b', null, '2222222222222222222222222222222222222222222222222222222222222222', 'ready', '30000000-0000-0000-0000-000000000003')$$, 'same cache key', 'reuse: a copy with another cache key is refused');

-- R1 project pointer; R10 stale detection
select pg_temp.expect_error($$update public.agent_marketing_projects set article_evidence_id = '30000000-0000-0000-0000-000000000003' where id = '10000000-0000-0000-0000-00000000000b'$$, 'must name a ready evidence row of this project', 'R1 a project cannot point at another user''s evidence');
select pg_temp.expect_error($$update public.agent_marketing_projects set article_evidence_id = '30000000-0000-0000-0000-000000000001' where id = '10000000-0000-0000-0000-00000000000a'$$, 'must name a ready evidence row', 'R1 a project cannot point at a failed row');
update public.agent_marketing_projects set article_evidence_id = '30000000-0000-0000-0000-000000000003' where id = :'PA';
update public.agent_marketing_projects set status = 'narrative_ready' where id = :'PA';
select pg_temp.ok((select article_evidence_id is not null from public.agent_marketing_projects where id = :'PA'), 'R10 unrelated project updates keep the pointer');
update public.agent_marketing_projects set selected_topic = '{"id":"t2"}' where id = :'PA';
select pg_temp.ok((select article_evidence_id is null from public.agent_marketing_projects where id = :'PA'), 'R10 changing the selected topic clears the evidence pointer (stale result)');

-- R9 client roles
select pg_temp.ok(not has_table_privilege('anon', 'public.agent_marketing_article_evidence', 'select') and not has_table_privilege('authenticated', 'public.agent_marketing_article_evidence', 'select')
  and not has_table_privilege('authenticated', 'public.agent_marketing_article_evidence', 'insert'), 'R9 anon/authenticated have no table privileges');
select pg_temp.ok((select relrowsecurity from pg_class where oid = 'public.agent_marketing_article_evidence'::regclass)
  and not exists (select 1 from pg_policies where tablename = 'agent_marketing_article_evidence'), 'R9 RLS on, no policies');
set role authenticated;
select pg_temp.expect_error($$select raw_response_text from public.agent_marketing_article_evidence$$, 'permission denied', 'R9 a signed-in client cannot read raw provider responses');
reset role;

-- deletes: project deletion detaches (set null) without touching the audit row; user deletion cascades
delete from public.agent_marketing_research where project_id = :'PB';
delete from public.agent_marketing_projects where id = :'PB';
select pg_temp.ok((select project_id is null and research_id is null and status = 'ready' and raw_response_text = 'resp' from public.agent_marketing_article_evidence where id = '30000000-0000-0000-0000-000000000004'), 'deleting a project detaches its evidence row; the audit record is kept intact');
delete from public.agent_marketing_research where project_id = :'PA';
delete from public.agent_marketing_projects where id = :'PA';
delete from public.users where id = :'UA';
select pg_temp.ok((select count(*) = 0 from public.agent_marketing_article_evidence where user_id = :'UA'), 'deleting a user cascades through the audit guard');
select pg_temp.ok((select reused_from is null and status = 'ready' from public.agent_marketing_article_evidence where id = '30000000-0000-0000-0000-000000000004'), 'another user''s copy survives (reused_from set null), still self-contained');
\echo ALL MIGRATION CHECKS PASSED
