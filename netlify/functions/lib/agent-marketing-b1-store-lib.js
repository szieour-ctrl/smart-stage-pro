// lib/agent-marketing-b1-store-lib.js — Netlify (shared). DEVELOPMENT ONLY (Nov 5, 2026). Stage B persistence over Supabase PostgREST.
//
// The store the bridge (lib/agent-marketing-b1-bridge-lib.js) and Stage B (lib/agent-marketing-b1-stageb-run-lib.js) use: findForProject, findLive,
// insert, update, attach, forPlan, latestForProject, maxProviderSeq, countProviderCalls, reserveProvider, fail. It reads and writes
// public.agent_marketing_article_evidence, which exists only once the PROPOSED migration
// docs/proposed-migrations/20261105_agent_marketing_article_evidence.up.sql is applied to an authorized development database (it is NOT applied).
// Service role only (RLS on, no policies): this file is server-side, has no handler export and never reads a request.
// The database is the authority on uniqueness, ownership and immutability; this file maps its refusals to Stage B error codes:
//   unique violation on the in-flight index -> in_progress (a concurrent duplicate B1 request); any trigger refusal -> refused; a conditional
//   update that matched no row (the record moved on, e.g. another worker completed it) -> conflict.
// Inert unless AGENT_MARKETING_B1_EVIDENCE=dev.
"use strict";

const b1 = require("./agent-marketing-b1-evidence-lib");

const TABLE = "agent_marketing_article_evidence";
const ATTEMPTS = "agent_marketing_article_capture_attempts";   // proposed migration 20261108 (development database only)
class StoreError extends Error { constructor(code, message) { super(message); this.code = code; } }
const enc = encodeURIComponent;

function defaultRequest() { return require("./marketing-profile-lib").supabase; }

function check(res, what) {
  if (res && res.status >= 200 && res.status < 300) return Array.isArray(res.data) ? res.data : [];
  const d = (res && res.data) || {};
  const code = String(d.code || ""), msg = String(d.message || d.details || d || "");
  if (code === "23505" && /uq_amae_inflight_cache_key/.test(msg)) throw new StoreError("in_progress", "a B1 run for this exact article and settings is already in progress");
  if (code === "23505") throw new StoreError("duplicate", `${what}: ${msg}`);
  if (code === "P0001" || code === "23514" || code === "23503") throw new StoreError("refused", `${what}: ${msg}`);
  throw new StoreError("store_error", `${what}: HTTP ${res ? res.status : "none"} ${msg}`.trim());
}

/** createStore({ env, request }) — request(method, table, body, query) → { status, data } (defaults to the shared Supabase helper). */
function createStore({ env, request } = {}) {
  if (!b1.enabled(env || process.env)) throw new StoreError("disabled", "Stage B is development-only and switched off");
  const rq = request || defaultRequest();
  const one = (rows) => (rows.length ? rows[0] : null);
  return {
    /** The project's current non-failed record for the topic (a failed run never blocks a retry). */
    async findForProject(projectId, topicId) {
      return one(check(await rq("GET", TABLE, null, `?project_id=eq.${enc(projectId)}&topic_id=eq.${enc(topicId)}&status=neq.failed&order=created_at.desc&limit=1`), "findForProject"));
    },
    /** An in-flight run for the key if there is one, otherwise the earliest ready result (the original B1 run, not a copy). */
    async findLive(cacheKey) {
      const rows = check(await rq("GET", TABLE, null, `?cache_key=eq.${enc(cacheKey)}&status=in.(reserved,running,ready)&order=created_at.asc&limit=20`), "findLive");
      return rows.find((r) => r.status !== "ready") || rows.find((r) => r.status === "ready" && !r.reused_from) || rows.find((r) => r.status === "ready") || null;
    },
    async insert(row) {
      const body = { ...row }; delete body.id;
      for (const k of Object.keys(body)) if (body[k] === undefined) delete body[k];
      const r = one(check(await rq("POST", TABLE, body, ""), "insert"));
      if (!r) throw new StoreError("store_error", "insert returned no row");
      return r;
    },
    /** Conditional update: applies only while the row still has expectStatus (so two workers cannot both complete one reservation). */
    async update(id, fields, expectStatus) {
      const q = `?id=eq.${enc(id)}${expectStatus ? `&status=eq.${enc(expectStatus)}` : ""}`;
      const r = one(check(await rq("PATCH", TABLE, fields, q), "update"));
      if (!r) throw new StoreError("conflict", `record ${id} is no longer ${expectStatus || "present"}`);
      return r;
    },
    /** Point the project at a ready record (the database refuses another user's or project's row, or one that is not ready). */
    async attach(projectId, userId, evidenceId) {
      const r = one(check(await rq("PATCH", "agent_marketing_projects", { article_evidence_id: evidenceId }, `?id=eq.${enc(projectId)}&user_id=eq.${enc(userId)}`), "attach"));
      if (!r) throw new StoreError("not_found", "project not found for this user");
      return r;
    },
    /** Stage B job status for the page: metadata only, never the snapshot, request, raw response or bundle text (counts are derived). */
    async latestForProject(projectId, topicId) {
      const rows = check(await rq("GET", TABLE, null, `?project_id=eq.${enc(projectId)}&topic_id=eq.${enc(topicId)}&select=id,status,completeness_status,error,reused_from,provider_seq,created_at,finished_at,bundle&order=created_at.desc&limit=1`), "latestForProject");
      return one(rows);
    },
    /** Highest Stage B ledger sequence used on this research run (Stage B uses 1001 and up; research itself uses 1, 2, ...). */
    async maxProviderSeq(researchId) {
      const r = one(check(await rq("GET", TABLE, null, `?research_id=eq.${enc(researchId)}&provider_seq=not.is.null&select=provider_seq&order=provider_seq.desc&limit=1`), "maxProviderSeq"));
      return r ? Number(r.provider_seq) : 1000;
    },
    /** Rows that made (or are making) a B1 provider call since `sinceIso`: for one user, or for everyone when userId is null. */
    async countProviderCalls({ userId, sinceIso }) {
      const q = `?provider_seq=not.is.null&reserved_at=gte.${enc(sinceIso)}${userId ? `&user_id=eq.${enc(userId)}` : ""}&select=id&limit=1000`;
      return check(await rq("GET", TABLE, null, q), "countProviderCalls").length;
    },
    /** The atomic per-user ledger reservation (proposed migration 20261101): { allowed, replayed?, reservation_id?, scope?, used?, limit? }. */
    async reserveProvider({ userId, researchId, seq, daily, monthly }) {
      const res = await rq("POST", "rpc/agent_marketing_reserve_provider_request", { p_user: userId, p_research: researchId, p_seq: seq, p_daily: daily, p_monthly: monthly }, "");
      if (!res || res.status < 200 || res.status >= 300) check(res, "reserveProvider");
      const d = res.data && !Array.isArray(res.data) ? res.data : Array.isArray(res.data) ? res.data[0] : null;
      if (!d || typeof d.allowed !== "boolean") throw new StoreError("store_error", "reserveProvider returned no decision");
      return d;
    },
    /** Finish a run as failed with a code, only while it is still in `fromStatus` (never overwrites a ready or failed row). */
    async fail(id, code, fromStatus) {
      return this.update(id, { status: "failed", error: String(code).slice(0, 200), finished_at: new Date().toISOString() }, fromStatus);
    },
    /**
     * Append one capture attempt (live-fetch milestone): a verification, or a failure before an evidence row could exist. Only the whitelisted
     * minimal fields are sent; anything else is dropped here, and the database refuses text-sized or malformed values. Never HTML or text.
     */
    async insertAttempt(a) {
      const hex = (v) => (/^[0-9a-f]{64}$/.test(String(v || "")) ? v : null);
      const str = (v, n) => (v === undefined || v === null || v === "" ? null : String(v).slice(0, n));
      const intOr = (v, lo, hi) => (Number.isInteger(v) && v >= lo && v <= hi ? v : null);
      const body = { user_id: a.userId, project_id: a.projectId || null, topic_id: String(a.topicId || "").slice(0, 200), mode: a.mode, stage: a.stage,
        outcome: String(a.outcome || "").toLowerCase().replace(/[^a-z_]/g, "_").replace(/^[^a-z]+/, "").slice(0, 40) || "unknown_error",
        http_status: intOr(a.httpStatus, 100, 599), content_type: str(a.contentType, 200), bytes: intOr(a.bytes, 0, 2147483647),
        source_url: str(a.sourceUrl, 2048), final_url: str(a.finalUrl, 2048), observed_title: str(a.observedTitle, 500),
        raw_html_sha256: hex(a.rawHtmlSha256), snapshot_sha256: hex(a.snapshotSha256), compared_to: a.comparedTo || null };
      if (body.outcome.length < 2) body.outcome = "unknown_error";
      const r = one(check(await rq("POST", ATTEMPTS, body, ""), "insertAttempt"));
      if (!r) throw new StoreError("store_error", "insertAttempt returned no row");
      return r;
    },
    /** The project's latest attempt, as the page may see it: mode, stage, outcome, HTTP status and time (no URL, title or hashes). */
    async latestAttempt(projectId, topicId) {
      return one(check(await rq("GET", ATTEMPTS, null, `?project_id=eq.${enc(projectId)}&topic_id=eq.${enc(topicId)}&select=mode,stage,outcome,http_status,created_at&order=created_at.desc&limit=1`), "latestAttempt"));
    },
    /** Source verifications by this user since `sinceIso` (the verify-only daily cap). */
    async countVerifications({ userId, sinceIso }) {
      return check(await rq("GET", ATTEMPTS, null, `?user_id=eq.${enc(userId)}&mode=eq.verify_source&created_at=gte.${enc(sinceIso)}&select=id&limit=1000`), "countVerifications").length;
    },
    /** The plan-time read: the project's chosen record (or null; with the switch on, null makes the Planner fail closed). */
    async forPlan(project) {
      if (!project || !project.article_evidence_id) return null;
      return one(check(await rq("GET", TABLE, null, `?id=eq.${enc(project.article_evidence_id)}&project_id=eq.${enc(project.id)}&limit=1`), "forPlan"));
    },
  };
}

module.exports = { createStore, StoreError, TABLE, ATTEMPTS };
