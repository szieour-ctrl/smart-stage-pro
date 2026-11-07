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
  catch (x) {   // no evidence row: nothing to finish. A capture failure (fetch, snapshot, source_changed) is recorded in the attempt log.
    if (x.code === "in_progress") return { state: "in_progress", code: "in_progress" };
    await recordAttempt(store, { userId, project, topic, mode: "evidence", code: x.code || "prepare_error", detail: x.detail });
    return { state: "failed", code: x.code || "prepare_error" };
  }
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

/** One attempt-log row. Never throws: a log write that fails must not change the job's outcome (it is reported in the function log only). */
async function recordAttempt(store, { userId, project, topic, mode, code, detail }) {
  const d = detail || {};
  if (!d.stage || !store || typeof store.insertAttempt !== "function") return null;
  const art = br.articleOf(topic) || {};
  try {
    return await store.insertAttempt({ userId, projectId: project.id, topicId: topic.id, mode, stage: d.stage, outcome: code, httpStatus: d.httpStatus,
      contentType: d.contentType, bytes: d.bytes, sourceUrl: art.url, finalUrl: d.finalUrl, observedTitle: d.observedTitle, rawHtmlSha256: d.rawHtmlSha256,
      snapshotSha256: d.snapshotSha256, comparedTo: d.stage === "compare" ? d.comparedTo || null : null });
  } catch (x) { console.error("stageb attempt log:", x.code || x.message); return null; }
}

const verifyCap = (env) => envInt(env, "B1_VERIFY_MAX_PER_USER_DAY", 1, 200, 20);

/** Shared checks for a source verification: admission, the project (owned by this user), its Article-Led topic, the verify-only daily cap. */
async function verifyCheck({ userId, projectId, store, loadProject, env, now }) {
  const e = env || process.env;
  const a = admit(userId, e); if (a) return { refusal: a };
  if (!am.UUID_RE.test(String(projectId || ""))) return { refusal: deny(400, "bad_request", "Missing or invalid projectId") };
  const project = await loadProject(projectId, userId);
  const { topic, refusal } = articleLedTopic(project); if (refusal) return { refusal };
  if (!br.articleOf(topic)) return { refusal: deny(409, "no_article", "The selected topic has no article URL.") };
  const since = new Date((now ? new Date(now).getTime() : Date.now()) - DAY_MS).toISOString();
  if (await store.countVerifications({ userId, sinceIso: since }) >= verifyCap(e)) return { refusal: deny(429, "verify_limit_user_day", "The daily limit for source checks is reached.") };
  return { project, topic };
}

/**
 * startVerifyRequest(...) → { status, body }: the synchronous part of a source verification (checks only). 202 { state: "dispatch",
 * mode: "verify_source" } tells the page to start the background function with { projectId, mode: "verify_source" }.
 */
async function startVerifyRequest(args) {
  const c = await verifyCheck(args);
  if (c.refusal) return out(c.refusal.status, { error: c.refusal.message, code: c.refusal.code });
  return out(202, { state: "dispatch", mode: "verify_source" });
}

/**
 * verifyJob({ userId, projectId, store, loadProject, fetchFn, env, now }) → { state: "verified", outcome, ... } | { state: "refused"|"failed", code }
 * Live fetch → worker snapshot → compare with the project's attached ready evidence row. Outcomes: unchanged | source_changed | no_baseline, or a
 * capture failure code. It NEVER inserts or changes an evidence row, never reserves on the ledger, never calls a provider and never changes the
 * project's evidence link: the only write is one attempt-log row.
 */
async function verifyJob(args) {
  const { userId, store, fetchFn, env, now } = args;
  const e = env || process.env;
  const c = await verifyCheck(args);
  if (c.refusal) return { state: "refused", code: c.refusal.code };
  const { project, topic } = c;
  let cap;
  try { cap = await br.capture({ art: br.articleOf(topic), fetchFn, env: e, now }); }
  catch (x) {
    const code = x.code || "capture_error";
    await recordAttempt(store, { userId, project, topic, mode: "verify_source", code, detail: x.detail || { stage: "fetch" } });
    return { state: "failed", code };
  }
  const base = await store.forPlan(project);   // the attached evidence row, read-only
  const baseline = base && base.status === "ready" && base.topic_id === topic.id ? base : null;
  const outcome = !baseline ? "no_baseline" : baseline.cache_key === cap.key ? "unchanged" : "source_changed";
  const detail = { ...br.captureDetail(cap.page, cap.snap, "compare"), comparedTo: baseline ? baseline.id : null };
  const logged = await recordAttempt(store, { userId, project, topic, mode: "verify_source", code: outcome, detail });
  return { state: "verified", outcome, logged: !!logged };
}

/** status({ userId, projectId, store, loadProject, env }) → { status, body }: what the page may know. Never evidence text or raw responses. */
async function status({ userId, projectId, store, loadProject, env }) {
  const e = env || process.env;
  const a = admit(userId, e); if (a) return out(a.status, { error: a.message, code: a.code });
  if (!am.UUID_RE.test(String(projectId || ""))) return out(400, { error: "Missing or invalid projectId", code: "bad_request" });
  const project = await loadProject(projectId, userId);
  const { topic, refusal } = articleLedTopic(project); if (refusal) return out(refusal.status, { error: refusal.message, code: refusal.code });
  const row = await store.latestForProject(project.id, topic.id);
  let la = null;
  try { la = typeof store.latestAttempt === "function" ? await store.latestAttempt(project.id, topic.id) : null; } catch (x) { la = null; }
  const lastAttempt = la ? { mode: la.mode, stage: la.stage, outcome: la.outcome, httpStatus: la.http_status || null, at: la.created_at } : null;
  if (!row) return out(200, { state: "none", lastAttempt });
  const v = row.bundle ? b1.readBundle(row.bundle) : null;
  return out(200, { state: row.status, completeness: row.completeness_status || null, error: row.error || null, reused: !!row.reused_from,
    attached: project.article_evidence_id === row.id, counts: v && v.status !== b1.BLOCKED ? { validated: v.validated.length, held: v.held.length, excluded: v.excluded.length } : null,
    createdAt: row.created_at || null, finishedAt: row.finished_at || null, lastAttempt });
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

module.exports = { STALE_MS, caps, verifyCap, admit, articleLedTopic, precheck, startRequest, startJob, runJob, startVerifyRequest, verifyJob, recordAttempt, status, withPlanEvidence };
