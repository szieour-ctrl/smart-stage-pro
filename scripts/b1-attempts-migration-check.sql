-- Checks for 20261108_agent_marketing_article_capture_attempts.up.sql on a THROWAWAY local cluster (scripts/b1-attempts-migration-check.sh).
\set ON_ERROR_STOP on
create or replace function pg_temp.expect_error(sql text, pattern text, label text) returns void language plpgsql as $$
begin
  begin execute sql; exception when others then
    if sqlerrm ~* pattern then raise notice 'PASS %', label; return; end if;
    raise exception 'FAIL % (unexpected error: %)', label, sqlerrm;
  end;
  raise exception 'FAIL % (no error)', label;
end $$;
create or replace function pg_temp.ok(cond boolean, label text) returns void language plpgsql as $$
begin if cond then raise notice 'PASS %', label; else raise exception 'FAIL %', label; end if; end $$;

-- fixtures: two users, a project each, one READY evidence row on A's project (that table's triggers are bypassed for this setup row only)
insert into public.users(id) values ('00000000-0000-0000-0000-00000000000a'), ('00000000-0000-0000-0000-00000000000b');
insert into public.agent_marketing_projects(id, user_id, template) values
  ('10000000-0000-0000-0000-00000000000a', '00000000-0000-0000-0000-00000000000a', 'local_market_insider'),
  ('10000000-0000-0000-0000-00000000000b', '00000000-0000-0000-0000-00000000000b', 'local_market_insider');
alter table public.agent_marketing_article_evidence disable trigger user;
insert into public.agent_marketing_article_evidence (id, user_id, project_id, topic_id, source_url, snapshot_text, snapshot_sha256, extractor,
  snapshot_retrieved_at, prompt_version, instructions_sha256, model, max_output_tokens, reasoning_effort, cache_key, request_text, request_sha256,
  input_sha256, raw_response_text, raw_response_sha256, gate_version, bundle, completeness_status, status)
values ('30000000-0000-0000-0000-00000000000a', '00000000-0000-0000-0000-00000000000a', '10000000-0000-0000-0000-00000000000a', 't-A', 'https://a.example/x',
  'text', repeat('a',64), 'extract_v2', now(), 'v1.2.1', repeat('b',64), 'm', 5000, 'minimal', repeat('c',64), 'req', repeat('d',64), repeat('e',64),
  'resp', repeat('f',64), 'g1', '{}'::jsonb, 'COMPLETE', 'ready'),
  ('30000000-0000-0000-0000-00000000000f', '00000000-0000-0000-0000-00000000000a', '10000000-0000-0000-0000-00000000000a', 't-A', 'https://a.example/x',
  'text', repeat('a',64), 'extract_v2', now(), 'v1.2.1', repeat('b',64), 'm', 5000, 'minimal', repeat('1',64), 'req', repeat('d',64), repeat('e',64),
  null, null, null, null, null, 'failed');
alter table public.agent_marketing_article_evidence enable trigger user;

create or replace function pg_temp.att(id text, uid text, pid text, stage text, outcome text, compared text default null, snap text default null) returns void language sql as $$
  insert into public.agent_marketing_article_capture_attempts (id, user_id, project_id, topic_id, mode, stage, outcome, source_url, snapshot_sha256, compared_to)
  values (id::uuid, uid::uuid, pid::uuid, 't-A', 'verify_source', stage, outcome, 'https://a.example/x', snap, compared::uuid) $$;

-- valid rows
select pg_temp.att('40000000-0000-0000-0000-000000000001', '00000000-0000-0000-0000-00000000000a', '10000000-0000-0000-0000-00000000000a', 'compare', 'unchanged', '30000000-0000-0000-0000-00000000000a', repeat('a',64));
select pg_temp.att('40000000-0000-0000-0000-000000000002', '00000000-0000-0000-0000-00000000000a', '10000000-0000-0000-0000-00000000000a', 'fetch', 'http_error');
select pg_temp.ok((select count(*) = 2 from public.agent_marketing_article_capture_attempts), 'a compare row (with its baseline) and a fetch failure row are accepted');

-- ownership
select pg_temp.expect_error($$select pg_temp.att('40000000-0000-0000-0000-000000000003', '00000000-0000-0000-0000-00000000000b', '10000000-0000-0000-0000-00000000000a', 'fetch', 'http_error')$$, 'does not own the project', 'an attempt cannot name another user''s project');
select pg_temp.expect_error($$select pg_temp.att('40000000-0000-0000-0000-000000000004', '00000000-0000-0000-0000-00000000000b', '10000000-0000-0000-0000-00000000000b', 'compare', 'unchanged', '30000000-0000-0000-0000-00000000000a', repeat('a',64))$$, 'compared_to must be a ready evidence row of the same project', 'an attempt cannot compare against another user''s evidence');
select pg_temp.expect_error($$select pg_temp.att('40000000-0000-0000-0000-000000000005', '00000000-0000-0000-0000-00000000000a', '10000000-0000-0000-0000-00000000000a', 'compare', 'unchanged', '30000000-0000-0000-0000-00000000000f', repeat('a',64))$$, 'compared_to must be a ready evidence row', 'an attempt cannot compare against a failed row');

-- minimal shape
select pg_temp.expect_error($$select pg_temp.att('40000000-0000-0000-0000-000000000006', '00000000-0000-0000-0000-00000000000a', '10000000-0000-0000-0000-00000000000a', 'compare', 'unchanged')$$, 'amca_compare_has_snapshot', 'a compare row carries its snapshot hash');
select pg_temp.expect_error($$select pg_temp.att('40000000-0000-0000-0000-000000000007', '00000000-0000-0000-0000-00000000000a', '10000000-0000-0000-0000-00000000000a', 'fetch', 'http_error', '30000000-0000-0000-0000-00000000000a')$$, 'amca_compared_only_on_compare', 'only a compare row names a baseline');
select pg_temp.expect_error($$select pg_temp.att('40000000-0000-0000-0000-000000000008', '00000000-0000-0000-0000-00000000000a', '10000000-0000-0000-0000-00000000000a', 'fetch', 'Free text with spaces')$$, 'outcome_check', 'the outcome is a code, not free text');
select pg_temp.expect_error($$insert into public.agent_marketing_article_capture_attempts (user_id, project_id, topic_id, mode, stage, outcome, source_url, raw_html_sha256)
  values ('00000000-0000-0000-0000-00000000000a', '10000000-0000-0000-0000-00000000000a', 't-A', 'verify_source', 'fetch', 'http_error', 'https://a.example/x', 'not-a-hash')$$, 'raw_html_sha256_check', 'hash columns accept only sha256 hex');
select pg_temp.expect_error($$insert into public.agent_marketing_article_capture_attempts (user_id, project_id, topic_id, mode, stage, outcome, source_url, observed_title)
  values ('00000000-0000-0000-0000-00000000000a', '10000000-0000-0000-0000-00000000000a', 't-A', 'verify_source', 'fetch', 'http_error', 'https://a.example/x', repeat('x', 501))$$, 'observed_title_check', 'the observed title is bounded (no article body can be stored)');
select pg_temp.expect_error($$insert into public.agent_marketing_article_capture_attempts (user_id, project_id, topic_id, mode, stage, outcome, source_url)
  values ('00000000-0000-0000-0000-00000000000a', '10000000-0000-0000-0000-00000000000a', 't-A', 'live_research', 'fetch', 'http_error', 'https://a.example/x')$$, 'mode_check', 'only verify_source and evidence modes exist');
select pg_temp.ok((select count(*) = 0 from information_schema.columns where table_name = 'agent_marketing_article_capture_attempts'
  and column_name ~ '(text|html|body|response|request|secret|token|key)$' and column_name not in ('observed_title')), 'no column can hold article text, HTML, a request, a response or a credential');

-- append-only
select pg_temp.expect_error($$update public.agent_marketing_article_capture_attempts set outcome = 'unchanged' where id = '40000000-0000-0000-0000-000000000002'$$, 'append-only', 'an attempt cannot be rewritten');
select pg_temp.expect_error($$update public.agent_marketing_article_capture_attempts set compared_to = '30000000-0000-0000-0000-00000000000a' where id = '40000000-0000-0000-0000-000000000002'$$, 'append-only', 'a baseline cannot be attached later');
select pg_temp.expect_error($$delete from public.agent_marketing_article_capture_attempts where id = '40000000-0000-0000-0000-000000000002'$$, 'not deleted', 'an attempt cannot be deleted directly');

-- access control: client roles have no privilege at all; RLS is on with no policies
select pg_temp.ok((select relrowsecurity from pg_class where oid = 'public.agent_marketing_article_capture_attempts'::regclass), 'RLS is enabled');
select pg_temp.ok((select count(*) = 0 from pg_policies where tablename = 'agent_marketing_article_capture_attempts'), 'no RLS policy exists (service role only)');
select pg_temp.ok(not has_table_privilege('anon', 'public.agent_marketing_article_capture_attempts', 'select,insert,update,delete'), 'anon has no table privilege');
select pg_temp.ok(not has_table_privilege('authenticated', 'public.agent_marketing_article_capture_attempts', 'select,insert,update,delete'), 'authenticated has no table privilege');
set role authenticated;
select pg_temp.expect_error($$select count(*) from public.agent_marketing_article_capture_attempts$$, 'permission denied', 'a signed-in browser role cannot read attempts');
reset role;

-- the evidence table and its ready row are untouched by attempts
select pg_temp.ok((select status = 'ready' and raw_response_text = 'resp' from public.agent_marketing_article_evidence where id = '30000000-0000-0000-0000-00000000000a'), 'evidence rows are unchanged');

-- link housekeeping: deleting a project detaches its attempts (audit kept); deleting a user removes them with the user
delete from public.agent_marketing_projects where id = '10000000-0000-0000-0000-00000000000a';
select pg_temp.ok((select count(*) = 2 and bool_and(project_id is null) from public.agent_marketing_article_capture_attempts), 'deleting a project detaches its attempts; the records are kept');
delete from public.users where id = '00000000-0000-0000-0000-00000000000a';
select pg_temp.ok((select count(*) = 0 from public.agent_marketing_article_capture_attempts), 'deleting the user removes their attempts (account deletion)');
