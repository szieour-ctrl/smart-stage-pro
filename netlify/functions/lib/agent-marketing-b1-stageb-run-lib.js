// lib/agent-marketing-b1-stageb-run-lib.js — Netlify (shared). DEVELOPMENT ONLY (Nov 5, 2026). The owner-only Stage B pathway.
//
//   POST agent-marketing-stageb { action: "start", projectId }   (startRequest)  → checks only; 202 { state: "dispatch" } tells the page to start the job
//   POST agent-marketing-stageb-background { projectId }  + the user's Bearer token, sent BY THE PAGE (startJob → runJob)
//                                                                                   → same checks again, then snapshot, reservation, provider, gate, attach
//   GET  agent-marketing-stageb?projectId=                         (status)        → job state for the page: metadata and counts only
// Nov 7, 2026: the page dispatches the background function itself, with its own login token. There is no server-to-server call and no shared
// internal key: a development deploy behind team login cannot call its own functions, and the background function must not trust a userId it is
// handed. The user is always the one the token belongs to; nothing in the request body names a user.
//
// Job state lives in public.agent_marketing_article_evidence (proposed migration 20261105 rev 3), NOT in agent_marketing_jobs (the render pipeline):
//   (no row) --snapshot+insert--> reserved --ledger reservation--> running --provider+gate--> ready | failed
//   reserved --limit/refusal--> failed;  running --provider/gate error--> failed;  stale reserved/running (> STALE_MS) --> failed (retryable)
//   ready with the same cache key elsewhere --> a "ready" copy (reused_from), no provider call.
// Every state change is conditional on the current state (store.update(..., fromStatus)), and the database enforces the transitions, the
// one-in-flight-run-per-cache-key rule, immutability and "no running/ready from a call without a ledger reservation" (R11).
// Admission (all required, checked on every request, start and background alike):
//   AGENT_MARKETING_B1_EVIDENCE=dev; Agent Marketing enabled for the user; the user is listed in B1_STAGEB_USER_IDS (an empty or missing list
//   denies everyone); the server's SUPABASE_URL is NOT the production project; the project belongs to the signed-in user; Local Market Insider
//   with a selected Article-Led topic. Refusals answer 404 (as if the endpoint did not exist) except the database check (503).
// The paid B1 provider call is NOT implemented: lib/agent-marketing-b1-provider-lib.js offers only a mock.
"use strict";

const b1 = require("./agent-marketing-b1-evidence-lib");
const br = require("./agent-marketing-b1-bridge-lib");
const am = require("./agent-marketing-lib");
const articleLed = require("./agent-marketing-article-led-lib");
const { PRODUCTION_REF } = require("./public-config-lib");

const STALE_MS = 16 * 60 * 1000;   // longer than the background function's 15-minute limit
const DAY_MS = 24 * 3600 * 1000;
const envInt = (env, k, lo, hi, dflt) => { const n = Number(String((env || {})[k] || "").trim()); return Number.isInteger(n) && n >= lo && n <= hi ? n : dflt; };
function caps(env) {
  return { perUserDay: envInt(env, "B1_STAGEB_MAX_PER_USER_DAY", 1, 50, 3), globalDay: envInt(env, "B1_STAGEB_MAX_GLOBAL_DAY", 1, 500, 10) };
}
const deny = (status, code, message) => ({ status, code, message });
const out = (status, body) => ({ status, body });

/** Admission for a user (no project yet). null = admitted; otherwise { status, code, message }. */
function admit(userId, env) {
  const e = env || process.env;
  if (!b1.enabled(e)) return deny(404, "not_found", "Not found");
  if (!am.UUID_RE.test(String(userId || ""))) return deny(404, "not_found", "Not found");
  if (!am.isEnabledFor(userId, e)) return deny(404, "not_found", "Not found");
  const ids = String(e.B1_STAGEB_USER_IDS || "").split(",").map((s) => s.trim().toLowerCase()).filter(Boolean);
  if (!ids.length || !ids.includes(String(userId).toLowerCase())) return deny(404, "not_found", "Not found");   // explicit allowlist; empty denies
  const db = String(e.SUPABASE_URL || "");
  if (!db || db.includes(PRODUCTION_REF)) return deny(503, "production_database_refused", "Stage B runs only against a development database.");
  return null;
}

/** The project's Article-Led selection, or a refusal. */
function articleLedTopic(project) {
  if (!project) return { refusal: deny(404, "not_found", "Not found") };
  if (project.template !== "local_market_insider") return { refusal: deny(409, "not_article_led", "Stage B is for Local Market Insider projects.") };
  const t = project.selected_topic;
  if (!t || typeof t !== "object" || !t.candidate || !am.UUID_RE.test(String(t.researchId || "")) || !t.id) return { refusal: deny(409, "not_article_led", "Select an Article-Led topic first.") };
  if (project.selected_research_id && project.selected_research_id !== t.researchId) return { refusal: deny(409, "not_article_led", "The selected topic and research run do not match.") };
  return { topic: t };
}

const isStale = (row, nowMs) => ["reserved", "running"].includes(row.status) && nowMs - new Date(row.reserved_at || row.created_at).getTime() > STALE_MS;
async function attachIfNeeded(store, project, userId, row) {
  if (project.article_evidence_id === row.id) return true;
  try { await store.attach(project.id, userId, row.id); return true; } catch (e) { return false; }   // the database refuses a mismatched pointer
}

/**
 * precheck({ userId, projectId, store, loadProject, env, now }) → { refusal } | { ready } | { live } | { project, topic }
 * The checks shared by the start request and the background job: admission, the project (owned by this user), the Article-Led topic, and the
 * newest row for it. A stale reserved/running row (older than the background time limit) is retired here so a new run can start.
 */
async function precheck({ userId, projectId, store, loadProject, env, now }) {
  const e = env || process.env;
  const a = admit(userId, e); if (a) return { refusal: a };
  if (!am.UUID_RE.test(String(projectId || ""))) return { refusal: deny(400, "bad_request", "Missing or invalid projectId") };
  const project = await loadProject(projectId, userId);   // scoped to the signed-in user: another user's project reads as missing
  const { topic, refusal } = articleLedTopic(project); if (refusal) return { refusal };
  const nowMs = now ? new Date(now).getTime() : Date.now();
  const live = await store.findForProject(project.id, topic.id);   // the newest non-failed row for this project and topic
  if (live && live.status === "ready") { await attachIfNeeded(store, project, userId, live); return { ready: live }; }
  if (live && !isStale(live, nowMs)) return { live };   // a job is live: no second run
  if (live) { try { await store.fail(live.id, "stale", live.status); } catch (x) { /* another worker moved it on */ } }
  return { project, topic };
}

/**
 * startRequest({ userId, projectId, store, loadProject, env, now }) → { status, body }
 * Synchronous part (fits a normal function's time limit): no fetch, no worker, no provider. Answers 202 { state: "dispatch" } when the page should
 * start the background job; never while one is live.
 */
async function startRequest({ userId, projectId, store, loadProject, env, now }) {
  const p = await precheck({ userId, projectId, store, loadProject, env, now });
  if (p.refusal) return out(p.refusal.status, { error: p.refusal.message, code: p.refusal.code });
  if (p.ready) return out(200, { state: "ready", reused: !!p.ready.reused_from });
  if (p.live) return out(202, { state: p.live.status, code: "in_progress" });
  return out(202, { state: "dispatch" });
}

/**
 * startJob({ userId, projectId, store, loadProject, fetchFn, provider, env, now }) → { state, code?, reused? }
 * The background job as the page starts it: the same checks as startRequest (the page may skip the start request, send it twice, or send it
 * for someone else's project), then runJob. Concurrent calls are safe: prepare() and the database allow one in-flight row per cache key, and every
 * state change is conditional.
 */
async function startJob(args) {
  const p = await precheck(args);
  if (p.refusal) return { state: "refused", code: p.refusal.code };
  if (p.ready) return { state: "ready", reused: true };
  if (p.live) return { state: "in_progress", code: "in_progress" };
  return runJob(args);
}

/**
 * runJob({ userId, projectId, store, loadProject, fetchFn, provider, env, now }) → { state, code?, reused? }
 * The background job. Same admission as the start; every transition conditional; the provider is called at most once per row, and only after
 * the row holds its ledger reservation.
 */
async function runJob({ userId, projectId, store, loadProject, fetchFn, provider, env, now }) {
  const e = env || process.env;
  const a = admit(userId, e); if (a) return { state: "refused", code: a.code };
  const project = await loadProject(projectId, userId);
  const { topic, refusal } = articleLedTopic(project); if (refusal) return { state: "refused", code: refusal.code };

  let record, reused;
  try { ({ record, reused } = await br.prepare({ project, userId, store, fetchFn, env: e, now })); }
  catch (x) { return { state: x.code === "in_progress" ? "in_progress" : "failed", code: x.code || "prepare_error" }; }   // no row: nothing to finish
  if (record.status === "ready") { await attachIfNeeded(store, project, userId, record); return { state: "ready", reused: true }; }
  if (record.status !== "reserved") return { state: "in_progress", code: "in_progress" };   // another worker holds it

  const finish = async (code, from) => { try { await store.fail(record.id, code, from); } catch (x) { /* already moved on */ } return { state: "failed", code }; };
  if (!provider) return finish("provider_not_implemented", "reserved");

  // B1-specific spending caps (on top of the per-user ledger): rows that made or are making a provider call in the last 24 hours.
  const c = caps(e), since = new Date((now ? new Date(now).getTime() : Date.now()) - DAY_MS).toISOString();
  if (await store.countProviderCalls({ userId, sinceIso: since }) >= c.perUserDay) return finish("b1_limit_user_day", "reserved");
  if (await store.countProviderCalls({ userId: null, sinceIso: since }) >= c.globalDay) return finish("b1_limit_global_day", "reserved");

  // Re-read just before reserving: if another worker already took this row, do not spend a ledger slot (the conditional update below is the real guard).
  const fresh = await store.findForProject(project.id, topic.id);
  if (!fresh || fresh.id !== record.id || fresh.status !== "reserved") return { state: "in_progress", code: "in_progress" };
  // The atomic per-user ledger reservation, BEFORE any call (a crash after this still counts). Sequence 1001+ on this research run.
  const seq = Math.max(1000, await store.maxProviderSeq(topic.researchId)) + 1;
  const lim = articleLed.requestLimits(e);
  let res;
  try { res = await store.reserveProvider({ userId, researchId: topic.researchId, seq, daily: lim.daily, monthly: lim.monthly }); }
  catch (x) { return finish("ledger_unavailable", "reserved"); }
  if (!res.allowed) return finish(`provider_limit_${res.scope || "reached"}`, "reserved");
  let running;
  try { running = await store.update(record.id, { provider_seq: seq, provider_reservation_id: res.reservation_id, status: "running" }, "reserved"); }
  catch (x) { return x.code === "conflict" ? { state: "in_progress", code: "in_progress" } : finish("reservation_refused", "reserved"); }

  let responseText;
  try { responseText = await provider.call({ requestText: running.request_text }); }
  catch (x) { record = running; return finish(x.code || "provider_error", "running"); }
  let done;
  try { done = await br.complete({ record: running, responseText, store, env: e }); }
  catch (x) { record = running; return finish(x.code || "gate_error", "running"); }
  if (done.status !== "ready") return { state: "failed", code: done.error || "evidence_blocked" };
  await attachIfNeeded(store, project, userId, done);
  return { state: "ready", reused: false, completeness: done.completeness_status };
}

/** status({ userId, projectId, store, loadProject, env }) → { status, body }: what the page may know. Never evidence text or raw responses. */
async function status({ userId, projectId, store, loadProject, env }) {
  const e = env || process.env;
  const a = admit(userId, e); if (a) return out(a.status, { error: a.message, code: a.code });
  if (!am.UUID_RE.test(String(projectId || ""))) return out(400, { error: "Missing or invalid projectId", code: "bad_request" });
  const project = await loadProject(projectId, userId);
  const { topic, refusal } = articleLedTopic(project); if (refusal) return out(refusal.status, { error: refusal.message, code: refusal.code });
  const row = await store.latestForProject(project.id, topic.id);
  if (!row) return out(200, { state: "none" });
  const v = row.bundle ? b1.readBundle(row.bundle) : null;
  return out(200, { state: row.status, completeness: row.completeness_status || null, error: row.error || null, reused: !!row.reused_from,
    attached: project.article_evidence_id === row.id, counts: v && v.status !== b1.BLOCKED ? { validated: v.validated.length, held: v.held.length, excluded: v.excluded.length } : null,
    createdAt: row.created_at || null, finishedAt: row.finished_at || null });
}

/**
 * withPlanEvidence(project, { env, store }) → the project to plan from. Switch off, or not an Article-Led Local Market Insider topic: the project
 * unchanged (production behaviour). Switch on: the selected topic carries the project's attached evidence row's bundle when it passes
 * checkRecord, otherwise a BLOCKED value, so generatePlan stops before any model call. A store failure is also BLOCKED: never unevidenced planning.
 */
async function withPlanEvidence(project, { env, store } = {}) {
  const e = env || process.env;
  const t = project && project.selected_topic;
  if (!b1.enabled(e) || !project || project.template !== "local_market_insider" || !t || typeof t !== "object" || !t.candidate) return project;
  const sbLib = require("./agent-marketing-b1-stageb-lib");
  let row = null;
  try { row = await (store || require("./agent-marketing-b1-store-lib").createStore({ env: e })).forPlan(project); } catch (x) { row = null; }
  return { ...project, selected_topic: sbLib.topicWithEvidence(project, row, e) };
}

module.exports = { STALE_MS, caps, admit, articleLedTopic, precheck, startRequest, startJob, runJob, status, withPlanEvidence };
