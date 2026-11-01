-- PROPOSED, NOT APPLIED. Atomic provider-request reservation for Article-Led research (PR #217 follow-up).
-- ADDITIVE ONLY: two new tables (the ledger and a one-row cutover marker), three new functions. No existing table, column, row or policy is changed, and no shipped code reads these objects until the matching code
-- change is deployed, so it is safe to run before that code. Idempotent: running it twice is harmless. Rollback: 20261101_..._reservation.down.sql.
--
-- Why: the per-request check in the background function reads this user's rows and then dispatches, which is not atomic across two sessions. This ledger plus one function
-- makes "is there room, and take a slot" a single serialized step per user, so the 15-per-24-hours and 100-per-30-days request limits cannot be overshot by concurrency.
--
-- One ledger row = one RESERVED outbound provider request (reserved BEFORE it is sent, so a crash or a failed request still counts). RLS is on with NO policies and the
-- function is executable by the service role only: browsers can never read or call either.

create table if not exists public.agent_marketing_provider_requests (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references public.users(id) on delete cascade,
  research_id uuid references public.agent_marketing_research(id) on delete set null,   -- set null, not cascade: deleting a project or a research row must never reset a user's usage
  seq integer not null check (seq >= 1),                                              -- 1-based request number inside the research session; (research_id, seq) makes a retried reservation call idempotent
  reserved_at timestamptz not null default now(),
  outcome text check (outcome in ('sent','failed')),                                  -- optional, best effort, diagnostics only; never used for counting
  unique (research_id, seq)
);
create index if not exists idx_amr_provider_requests_user_time on public.agent_marketing_provider_requests (user_id, reserved_at desc);
alter table public.agent_marketing_provider_requests enable row level security;

-- One-row cutover marker: research rows created BEFORE it are counted from their own usage (the pre-ledger bridge below); rows created after it are counted only through the ledger,
-- so a session's own running row is never double-counted while it is between "row saved" and "first request reserved".
create table if not exists public.agent_marketing_provider_request_cutover (
  only_row boolean primary key default true check (only_row), at timestamptz not null default now()
);
insert into public.agent_marketing_provider_request_cutover (only_row) values (true) on conflict do nothing;
alter table public.agent_marketing_provider_request_cutover enable row level security;

-- Safe integer read of a jsonb text value (null when absent or not a plain integer).
create or replace function public.agent_marketing_safe_int(p_text text) returns integer
language sql immutable as $$ select case when p_text ~ '^[0-9]{1,9}$' then p_text::integer end $$;

-- Reserve one provider request for p_user. Returns jsonb:
--   { allowed: true,  replayed: bool, reservation_id, used_day, used_month }            (the slot is taken, counted in used_*)
--   { allowed: false, scope: 'daily'|'monthly', used, limit }                          (nothing is taken)
-- Counting = ledger rows in the window, PLUS requests of Article-Led research rows created before the cutover that have no ledger rows (rows from before the ledger existed), counted exactly
-- as the application's requestsOf(): usage.providerRequests when present, else attempts (at least 1); a running row counts at least 1; withdrawn rows count 0.
create or replace function public.agent_marketing_reserve_provider_request(p_user uuid, p_research uuid, p_seq integer, p_daily integer, p_monthly integer)
returns jsonb language plpgsql security definer set search_path = public, pg_temp as $$
declare
  v_id uuid; v_day integer; v_month integer; v_legacy_day integer; v_legacy_month integer;
begin
  if p_user is null or p_seq is null or p_seq < 1 or p_daily is null or p_daily < 1 or p_monthly is null or p_monthly < 1 then
    raise exception 'invalid reservation arguments' using errcode = '22023';
  end if;
  -- One user's reservations are serialized; different users never wait for each other. The lock is released when this function's transaction ends.
  perform pg_advisory_xact_lock(hashtextextended('agent_marketing_provider_requests:' || p_user::text, 0));

  if p_research is not null then
    select id into v_id from public.agent_marketing_provider_requests where research_id = p_research and seq = p_seq;
    if found then return jsonb_build_object('allowed', true, 'replayed', true, 'reservation_id', v_id); end if;
  end if;

  select count(*) filter (where reserved_at >= now() - interval '24 hours'), count(*) filter (where reserved_at >= now() - interval '30 days')
    into v_day, v_month from public.agent_marketing_provider_requests where user_id = p_user and reserved_at >= now() - interval '30 days';

  select coalesce(sum(n) filter (where created_at >= now() - interval '24 hours'), 0), coalesce(sum(n), 0) into v_legacy_day, v_legacy_month from (
    select r.created_at,
      case when r.status = 'running' then greatest(1, coalesce(public.agent_marketing_safe_int(r.usage->>'providerRequests'), 0))
           else coalesce(public.agent_marketing_safe_int(r.usage->>'providerRequests'), greatest(1, coalesce(public.agent_marketing_safe_int(r.usage->>'attempts'), 1))) end as n
    from public.agent_marketing_research r
    where r.user_id = p_user and r.usage->>'pathway' = 'article_led' and coalesce(r.usage->>'withdrawn', '') <> 'true'
      and r.created_at >= now() - interval '30 days' and r.id is distinct from p_research
      and r.created_at < (select c.at from public.agent_marketing_provider_request_cutover c)
      and not exists (select 1 from public.agent_marketing_provider_requests l where l.research_id = r.id)
  ) legacy;
  v_day := v_day + v_legacy_day; v_month := v_month + v_legacy_month;

  if v_day + 1 > p_daily then return jsonb_build_object('allowed', false, 'scope', 'daily', 'used', v_day, 'limit', p_daily); end if;
  if v_month + 1 > p_monthly then return jsonb_build_object('allowed', false, 'scope', 'monthly', 'used', v_month, 'limit', p_monthly); end if;

  insert into public.agent_marketing_provider_requests (user_id, research_id, seq) values (p_user, p_research, p_seq) returning id into v_id;
  return jsonb_build_object('allowed', true, 'replayed', false, 'reservation_id', v_id, 'used_day', v_day + 1, 'used_month', v_month + 1);
end $$;

-- Housekeeping: drop ledger rows older than the longest window (default 40 days). Never needed for correctness.
create or replace function public.agent_marketing_prune_provider_requests(p_keep interval default interval '40 days') returns integer
language plpgsql security definer set search_path = public, pg_temp as $$
declare n integer; begin
  delete from public.agent_marketing_provider_requests where reserved_at < now() - p_keep; get diagnostics n = row_count; return n;
end $$;

revoke all on function public.agent_marketing_reserve_provider_request(uuid, uuid, integer, integer, integer) from public, anon, authenticated;
revoke all on function public.agent_marketing_prune_provider_requests(interval) from public, anon, authenticated;
revoke all on function public.agent_marketing_safe_int(text) from public, anon, authenticated;
grant execute on function public.agent_marketing_reserve_provider_request(uuid, uuid, integer, integer, integer) to service_role;
grant execute on function public.agent_marketing_prune_provider_requests(interval) to service_role;
grant execute on function public.agent_marketing_safe_int(text) to service_role;
