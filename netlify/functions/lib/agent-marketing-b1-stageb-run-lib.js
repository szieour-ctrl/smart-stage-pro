// lib/agent-marketing-b1-stageb-run-lib.js — Netlify (shared). DEVELOPMENT ONLY (Nov 5, 2026). The owner-only Stage B pathway.
//
//   POST agent-marketing-stageb { action: "start", projectId }   (startRequest)  → checks only; 202 { state: "dispatch" } tells the page to start the job
//   POST agent-marketing-stageb-background { projectId }  + the user's Bearer token, sent BY THE PAGE (startJob → runJob)
//                                                                                   → same checks again, then snapshot, reservation, provider, gate, attach
//   GET  agent-marketing-stageb?projectId=                         (status)        → job state for the page: metadata and counts only
//   POST agent-marketing-stageb { action: "script", projectId }  (startScriptRequest) → "Write my script" for an Article-Led project (Nov 8, 2026):
//        checks + the planning stub; 202 { state: "dispatch", mode: "script" } tells the page to start the background function with
//        { projectId, mode: "script" } (scriptJob): evidence (reused or obtained) first, then the ONE planning run. No evidence, no script.
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
const keyOf = (t) => require("./agent-marketing-b1-stageb-lib").topicKeyOf(t);

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

/** A Local Market Insider project with a selected topic that has no article (report-only or legacy): written without article evidence. */
function plainMarketTopic(project) {
  const t = project && project.selected_topic;
  return !!(project && project.template === "local_market_insider" && t && typeof t === "object" && !t.candidate);
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
 * ownReadyEvidence({ store, project, topic, userId }) → this project's own completed, checked evidence row for the selected article, or null.
 * It is what lets a project resume, or move to a later research run on the same article, without a second evidence row (Nov 12, 2026). Only an
 * article-keyed topic qualifies, only rows of this subscriber and this project, and the same integrity, settings and bundle checks apply.
 */
async function ownReadyEvidence({ store, project, topic, userId }) {
  if (!topic || !topic.b1 || typeof topic.b1.articleKey !== "string" || !topic.b1.articleKey || typeof store.findReadyForTopic !== "function") return null;
  const art = br.articleOf(topic);
  let rows; try { rows = await store.findReadyForTopic(userId, keyOf(topic)); } catch (x) { return null; }
  const sbLib = require("./agent-marketing-b1-stageb-lib");
  for (const row of rows || []) {
    if (!row || row.user_id !== userId || row.project_id !== project.id || row.status !== "ready" || row.topic_id !== keyOf(topic)) continue;
    if (art && row.source_url !== art.url) continue;
    if (sbLib.checkRecord(row, project).length) continue;
    return row;
  }
  return null;
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
  const live = await store.findForProject(project.id, keyOf(topic), topic.researchId);   // the newest non-failed row for this project, topic and research run
  if (live && live.status === "ready") { await attachIfNeeded(store, project, userId, live); return { ready: live }; }
  if (live && !isStale(live, nowMs)) return { live };   // a job is live: no second run
  if (!live) { const own = await ownReadyEvidence({ store, project, topic, userId }); if (own) { await attachIfNeeded(store, project, userId, own); return { ready: own }; } }   // resume / a later run on the same article
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

  // A saved topic this user already has checked evidence for (in another project) is reused without fetching the article again or calling B1.
  const saved = await reuseSavedTopic({ store, project, topic, userId });
  if (saved) { await attachIfNeeded(store, project, userId, saved); return { state: "ready", reused: true, reusedFrom: saved.reused_from }; }

  let record, reused;
  try { ({ record, reused } = await br.prepare({ project, userId, store, fetchFn, env: e, now })); }
  catch (x) {   // no evidence row: nothing to finish. A capture failure (fetch, snapshot, source_changed) is recorded in the attempt log.
    if (x.code === "in_progress") return { state: "in_progress", code: "in_progress" };
    await recordAttempt(store, { userId, project, topic, mode: "evidence", code: x.code || "prepare_error", detail: x.detail });
    return { state: "failed", code: x.code || "prepare_error" };
  }
  if (record.status === "ready") { await attachIfNeeded(store, project, userId, record); return { state: "ready", reused: true }; }
  if (record.status !== "reserved") return { state: "in_progress", code: "in_progress" };   // another worker holds it

  // providerAttempted: the row reached "running", i.e. it holds a ledger reservation and the provider is (or was) called for it.
  const finish = async (code, from) => { try { await store.fail(record.id, code, from); } catch (x) { /* already moved on */ } return { state: "failed", code, providerAttempted: from === "running" }; };
  if (!provider) return finish("provider_not_implemented", "reserved");

  // B1-specific spending caps (on top of the per-user ledger): rows that made or are making a provider call in the last 24 hours.
  const c = caps(e), since = new Date((now ? new Date(now).getTime() : Date.now()) - DAY_MS).toISOString();
  if (await store.countProviderCalls({ userId, sinceIso: since }) >= c.perUserDay) return finish("b1_limit_user_day", "reserved");
  if (await store.countProviderCalls({ userId: null, sinceIso: since }) >= c.globalDay) return finish("b1_limit_global_day", "reserved");

  // Re-read just before reserving: if another worker already took this row, do not spend a ledger slot (the conditional update below is the real guard).
  const fresh = await store.findForProject(project.id, keyOf(topic), topic.researchId);
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
  if (done.status !== "ready") return { state: "failed", code: done.error || "evidence_blocked", providerAttempted: true };
  await attachIfNeeded(store, project, userId, done);
  return { state: "ready", reused: false, completeness: done.completeness_status, providerAttempted: true };
}

/** One attempt-log row. Never throws: a log write that fails must not change the job's outcome (it is reported in the function log only). */
async function recordAttempt(store, { userId, project, topic, mode, code, detail }) {
  const d = detail || {};
  if (!d.stage || !store || typeof store.insertAttempt !== "function") return null;
  const art = br.articleOf(topic) || {};
  try {
    return await store.insertAttempt({ userId, projectId: project.id, topicId: keyOf(topic), mode, stage: d.stage, outcome: code, httpStatus: d.httpStatus,
      contentType: d.contentType, bytes: d.bytes, sourceUrl: art.url, finalUrl: d.finalUrl, observedTitle: d.observedTitle, rawHtmlSha256: d.rawHtmlSha256,
      snapshotSha256: d.snapshotSha256, comparedTo: d.stage === "compare" ? d.comparedTo || null : null });
  } catch (x) { console.error("stageb attempt log:", x.code || x.message); return null; }
}

/** status({ userId, projectId, store, loadProject, env }) → { status, body }: what the page may know. Never evidence text or raw responses. */
async function status({ userId, projectId, store, loadProject, env }) {
  const e = env || process.env;
  const a = admit(userId, e); if (a) return out(a.status, { error: a.message, code: a.code });
  if (!am.UUID_RE.test(String(projectId || ""))) return out(400, { error: "Missing or invalid projectId", code: "bad_request" });
  const project = await loadProject(projectId, userId);
  const { topic, refusal } = articleLedTopic(project);
  // A Market Update topic without an article (a Market Trend Update from the agent's report): no article evidence is needed (Nov 8, 2026).
  if (refusal && refusal.code === "not_article_led" && plainMarketTopic(project)) return out(200, { state: "not_needed" });
  if (refusal) return out(refusal.status, { error: refusal.message, code: refusal.code });
  let row = await store.latestForProject(project.id, keyOf(topic), topic.researchId);
  if (!row && topic.b1 && topic.b1.articleKey) row = await store.latestForProject(project.id, keyOf(topic), null);   // the article's evidence written by an earlier run of this project
  let la = null;
  try { la = typeof store.latestAttempt === "function" ? await store.latestAttempt(project.id, keyOf(topic)) : null; } catch (x) { la = null; }
  const lastAttempt = la ? { mode: la.mode, stage: la.stage, outcome: la.outcome, httpStatus: la.http_status || null, at: la.created_at } : null;
  if (!row) return out(200, { state: "none", lastAttempt });
  const v = row.bundle ? b1.readBundle(row.bundle) : null;
  return out(200, { state: row.status, completeness: row.completeness_status || null, error: row.error || null, reused: !!row.reused_from,
    providerAttempted: row.provider_seq != null,   // a B1 provider request was reserved for this row (and may have been sent)
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

/**
 * reuseSavedTopic({ store, project, topic, userId }) → a ready evidence row for THIS project, or null.
 * The subscriber may open a saved research set in a new project: agent-marketing-research copies the set into that project (usage.copiedFrom), so
 * the topic keeps its id but gets a new research run id. When this user already has checked evidence for the same topic of the same original
 * research, it is reused without fetching the article again or calling B1. Before reuse, every one of these must hold:
 *   ownership: the evidence row is this user's (the store query and the row are both checked);
 *   topic identity: same topic id, and both research runs lead back to the same original research run;
 *   source version: the row's source URL is the topic's article URL, and its stored snapshot still matches its hash (immutable snapshot);
 *   evidence contract: checkRecord passes in full for the row's own project and topic (approved B1 settings, request, raw response, bundle).
 * The reuse row the database requires for this project's pointer (a project may point only at its own rows) is a provenance-linked record:
 * reused_from names the original evidence row (never a copy of a copy), it carries no provider reservation, and the database checks that it has
 * the same cache key and raw response as the original. Nothing is fetched and no provider is called.
 */
async function reuseSavedTopic({ store, project, topic, userId }) {
  if (typeof store.findReadyForTopic !== "function" || typeof store.researchRoot !== "function") return null;
  const art = br.articleOf(topic);
  if (!art) return null;
  let root;
  try { root = await store.researchRoot(topic.researchId, userId); } catch (x) { return null; }
  if (!root) return null;
  let rows;
  try { rows = await store.findReadyForTopic(userId, keyOf(topic)); } catch (x) { return null; }
  const sbLib = require("./agent-marketing-b1-stageb-lib");
  // Originals first: a reuse row always points at the original evidence row.
  const ordered = rows.filter((r) => !r.reused_from).concat(rows.filter((r) => r.reused_from));
  for (const row of ordered) {
    if (!row || row.user_id !== userId || row.status !== "ready" || row.topic_id !== keyOf(topic) || row.project_id === project.id || !row.research_id) continue;
    if (row.source_url !== art.url) continue;
    let rootR; try { rootR = await store.researchRoot(row.research_id, userId); } catch (x) { rootR = null; }
    if (rootR !== root) continue;
    const ownProject = { id: row.project_id, selected_topic: { ...topic, researchId: row.research_id } };
    if (sbLib.checkRecord(row, ownProject).length) continue;   // integrity, approved settings and bundle, re-verified before reuse
    const { id, created_at, reserved_at, finished_at, cost_usd, error, provider_seq, provider_reservation_id, reused_from, project_id, research_id, ...copy } = row;
    if (typeof store.findReadyForProjectKey === "function") {   // this project already holds that snapshot: use it, insert nothing
      let own = null; try { own = await store.findReadyForProjectKey(userId, project.id, row.cache_key, row.gate_version); } catch (x) { own = null; }
      if (own && own.topic_id === keyOf(topic) && !sbLib.checkRecord(own, project).length) return own;
    }
    try {
      return await store.insert({ ...copy, user_id: userId, project_id: project.id, research_id: topic.researchId, topic_id: keyOf(topic), status: "ready", reused_from: reused_from || id });
    } catch (x) { console.error("stageb saved-topic reuse:", x.code || x.message); return null; }
  }
  return null;
}

/** Where the script text comes from in script mode: the development fixture script writer, or the real planner (needs ANTHROPIC_API_KEY). */
function plannerConfig(env, durationSec) {
  const fx = require("./agent-marketing-b1-fixture-planner-lib");
  if (fx.enabled(env)) return { fixture: true, callFn: fx.createCallFn(durationSec), anthropicKey: null, extraWarnings: [fx.WARNING], narrativeExtra: { plannerFixture: true } };
  const key = String((env || {}).ANTHROPIC_API_KEY || "");
  return key ? { fixture: false, anthropicKey: key } : null;
}

const CAPTURE_TEXT = {
  bad_url: "the article address is not a secure public web address", fetch_timeout: "the article did not answer in time", fetch_failed: "the article could not be reached",
  too_many_redirects: "the article redirected too many times", redirected_elsewhere: "the article redirected to another website", http_error: "the article's website answered with an error",
  not_html: "the address is not a web page", empty: "the article page was empty", too_large: "the article page is too large", capture_blocked: "the page looks like a paywall, robot check or error page",
  incomplete: "the page has too little article text to check", fixture_refused: "this article is not one of the test articles", source_changed: "the article no longer matches the snapshot this project started from",
  b1_limit_user_day: "the daily limit for article analysis is reached", b1_limit_global_day: "the daily limit for article analysis is reached", provider_not_implemented: "article analysis is not available here",
  evidence_blocked: "the article's evidence did not pass the evidence check", in_progress: "an evidence check for this article is still running",
  provider_http_error: "the article analysis service returned an error", provider_incomplete: "the article analysis did not complete",
  provider_unreachable: "the article analysis service could not be reached", mock_no_response: "no saved analysis exists for this article (test mode)",
};
/**
 * evidenceFailureMessage(code, providerAttempted) → what the subscriber is told when no script can be written. It never says that nothing was
 * spent unless no provider request was made: providerAttempted is true once a B1 provider request was reserved for the run.
 */
function evidenceFailureMessage(code, providerAttempted) {
  const c = String(code || "");
  const reason = CAPTURE_TEXT[c] || (/^provider_limit_/.test(c) ? "the monthly or daily limit for article analysis is reached" : `the evidence check did not finish (${c || "unknown"})`);
  const cost = providerAttempted ? "An article analysis request was made, so it counts toward your usage." : "No article analysis was run, so there is no analysis cost.";
  return `Your script was not written: ${reason}. ${cost} You can try again.`;
}

/**
 * startScriptRequest({ userId, projectId, loadProject, patchNarrative, env, now }) → { status, body }
 * "Write my script" for an Article-Led project while Stage B is on. Checks only (admission, the Article-Led topic, the usual planning checks and
 * the planner configuration), then writes the "planning" stub. 202 { state: "dispatch", mode: "script" }: the page starts the background function.
 */
async function startScriptRequest({ userId, projectId, loadProject, patchNarrative, env, now }) {
  const e = env || process.env;
  const a = admit(userId, e); if (a) return out(a.status, { error: a.message, code: a.code });
  if (!am.UUID_RE.test(String(projectId || ""))) return out(400, { error: "Missing or invalid projectId", code: "bad_request" });
  const project = await loadProject(projectId, userId);
  const { refusal } = articleLedTopic(project);
  if (refusal && !(refusal.code === "not_article_led" && plainMarketTopic(project))) return out(refusal.status, { error: refusal.message, code: refusal.code });
  if (am.NOT_EDITABLE_AFTER.includes(project.status)) return out(409, { error: "This piece is already rendering or finished. Start a new one to change it.", code: "not_editable" });
  const ps = require("./agent-marketing-plan-run-lib").planStart(project, now ? new Date(now).getTime() : undefined);
  if (ps.error) return out(ps.error.status, { error: ps.error.message, code: ps.error.code || "plan_refused" });
  if (!plannerConfig(e, project.duration_sec)) return out(500, { error: "Planning is not configured.", code: "not_configured" });
  const saved = await patchNarrative(project.id, userId, ps.stub);
  if (!saved) return out(500, { error: "Could not start planning", code: "error" });
  return out(202, { state: "dispatch", mode: "script" });
}

/**
 * scriptJob({ userId, projectId, store, loadProject, fetchFn, provider, env, now, sleep, supabase }) → { state, code? }
 * The background part of "Write my script": evidence first (an existing ready row, a saved topic's evidence, or a new run through startJob),
 * then the planning run with that evidence. When no ready evidence exists the planner is never called: the narrative becomes an error with the
 * reason, and says whether an article analysis request was made.
 */
async function scriptJob(args) {
  const { userId, projectId, store, loadProject, env } = args;
  const e = env || process.env;
  const sleep = args.sleep || ((ms) => new Promise((r) => setTimeout(r, ms)));
  const planRun = require("./agent-marketing-plan-run-lib");
  const supabase = args.supabase || require("./marketing-profile-lib").supabase;
  const project = await loadProject(projectId, userId);
  if (!project || !project.narrative || project.narrative.status !== "planning") return { state: "skipped", code: "no_stub" };
  const stub = project.narrative;
  const failScript = async (code, providerAttempted) => {
    await planRun.writeNarrative(supabase, project.id, userId, planRun.errorNarrative(stub, evidenceFailureMessage(code, providerAttempted), { evidence: { code, providerAttempted: !!providerAttempted } }));
    return { state: "failed", code };
  };
  let ev;
  if (plainMarketTopic(project)) ev = { state: "ready", reused: false, plain: true };   // no article: nothing to read, straight to the script
  else try {
    ev = await startJob(args);
    // Another evidence job for this topic is live (a second tab): wait for it, within this function's time limit, instead of starting another.
    for (let i = 0; ev.state === "in_progress" && i < 144; i++) { await sleep(5000); ev = await startJob(args); }
  } catch (x) { console.error("stageb script evidence:", x.code || x.message); return failScript(x.code || "evidence_error", false); }
  if (ev.state !== "ready") return failScript(ev.code || ev.state, !!ev.providerAttempted);
  const pc = plannerConfig(e, project.duration_sec);
  if (!pc) { await planRun.writeNarrative(supabase, project.id, userId, planRun.errorNarrative(stub, "Planning is not configured.")); return { state: "failed", code: "not_configured" }; }
  const r = await planRun.runPlan({ id: project.id, userId, deps: { supabase, env: e, anthropicKey: pc.anthropicKey, callFn: pc.callFn, extraWarnings: pc.extraWarnings, narrativeExtra: pc.narrativeExtra,
    withEvidence: (p) => withPlanEvidence(p, { env: e, store }) } });
  return { state: r.state === "ready" ? "ready" : "failed", code: r.code, evidence: ev.plain ? "not_needed" : ev.reused ? "reused" : "new", fixture: !!pc.fixture };
}

/**
 * articleEvidence({ userId, projectId, researchId, art: { url, title }, store, fetchFn, provider, env, now })
 *   → { articleKey, state, code?, providerAttempted, row }
 * B1 for one ARTICLE during research (Nov 8, 2026), before any topic exists: the same job as startJob (admission, existing or reusable evidence,
 * snapshot with extract_v3, ledger reservation and caps, provider, evidence gate), keyed by the article (topic_id = its article key) under this
 * research run. The project's evidence pointer is NOT set here: the topic the agent selects later points at its article's row.
 */
async function articleEvidence({ userId, projectId, researchId, art, store, fetchFn, provider, env, now }) {
  const sbLib = require("./agent-marketing-b1-stageb-lib");
  const articleKey = require("./agent-marketing-b2-lib").articleKey(art.url);
  const topic = { id: articleKey, researchId, candidate: { id: articleKey, stage: "b1_article" }, sources: [{ url: art.url, title: art.title || "", role: "primary" }], b1: { articleKey } };
  const project = { id: projectId, user_id: userId, template: "local_market_insider", selected_research_id: researchId, selected_topic: topic, article_evidence_id: null };
  const noAttach = Object.assign(Object.create(Object.getPrototypeOf(store)), store, { attach: async () => null });
  const res = await startJob({ userId, projectId, store: noAttach, loadProject: async (id, uid) => (id === projectId && uid === userId ? project : null), fetchFn, provider, env, now });
  let row = null;
  if (res.state === "ready") { try { row = await store.findForProject(projectId, articleKey, researchId); } catch (x) { row = null; } }
  if (row && sbLib.checkRecord(row, project).length) row = null;   // the same contract as at planning time
  return { articleKey, state: row ? "ready" : res.state, code: row ? undefined : res.code || (res.state === "ready" ? "evidence_unreadable" : undefined), providerAttempted: !!res.providerAttempted, row };
}

module.exports = { STALE_MS, caps, admit, articleLedTopic, ownReadyEvidence, precheck, startRequest, startJob, runJob, reuseSavedTopic, recordAttempt, status, withPlanEvidence,
  startScriptRequest, scriptJob, evidenceFailureMessage, plannerConfig, articleEvidence };
