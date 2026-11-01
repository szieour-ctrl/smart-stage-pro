// lib/agent-marketing-lane-runner-lib.js — Netlify (shared). Sequential, rate-limit-aware dispatch for the three-lane discovery experiment (PR 2).
//
// The first live three-lane benchmark was invalid because the lanes were sent at once and the provider answered two of three with HTTP 429. This runs the lanes
// ONE AT A TIME, with: a configurable minimum interval between lane starts (widened after any 429, because no fixed delay is assumed to satisfy every limit);
// the provider's Retry-After when it sends one, else bounded exponential backoff with jitter; independent per-lane state (success, rate_limited, failed,
// not_attempted) so one lane's failure never discards another's response and a failed lane is never read as "zero candidates"; and an overall time budget
// well inside the background function's 15-minute ceiling (netlify.toml: agent-marketing-research-background timeout = 900).
// Diagnostics are sanitized: lane, attempts, HTTP statuses, waits, durations; never a credential. Cost and candidate counts are attached by the caller.
"use strict";

const LANE_STATES = Object.freeze(["success", "rate_limited", "failed", "not_attempted"]);

const num = (v, lo, hi, dflt) => { const n = Number(v); return v !== undefined && v !== "" && Number.isFinite(n) && n >= lo && n <= hi ? n : dflt; };
/** Settings, all optional. Defaults keep the worst case well inside the 900-second background-function limit (see worstCaseMs). */
function laneSettings(env) {
  const e = env || process.env;
  return {
    minIntervalMs: num(e.AGENT_MARKETING_LANE_MIN_INTERVAL_MS, 0, 60000, 3000),   // minimum time between the START of one lane and the next
    maxAttempts: Math.round(num(e.AGENT_MARKETING_LANE_MAX_ATTEMPTS, 1, 6, 4)),   // provider requests per lane (first try included)
    backoffBaseMs: num(e.AGENT_MARKETING_LANE_BACKOFF_BASE_MS, 100, 30000, 2000), // first backoff when the provider gives no Retry-After
    backoffCapMs: num(e.AGENT_MARKETING_LANE_BACKOFF_CAP_MS, 500, 120000, 30000),
    maxWaitMs: num(e.AGENT_MARKETING_LANE_MAX_WAIT_MS, 500, 120000, 60000),       // a Retry-After longer than this is not waited out
    budgetMs: num(e.AGENT_MARKETING_LANE_BUDGET_MS, 30000, 600000, 240000),       // the whole lane phase; a request starts only if it can plausibly finish in time
    expectedCallMs: num(e.AGENT_MARKETING_LANE_EXPECTED_CALL_MS, 5000, 120000, 60000),
    callTimeoutMs: 120000,                                                        // the provider call's own timeout (CALL_TIMEOUT_MS in the run library)
  };
}
/** The latest the lane phase can end, in ms: a request starts only when elapsed + expected <= budget, and one request can take up to its timeout. */
const worstCaseMs = (s) => s.budgetMs - s.expectedCallMs + s.callTimeoutMs;
const BACKGROUND_LIMIT_MS = 900000;

/** Retry-After as milliseconds: delta-seconds or an HTTP date. Null when absent or unreadable. */
function retryAfterMs(headers, nowMs) {
  if (!headers || typeof headers !== "object") return null;
  const key = Object.keys(headers).find((k) => k.toLowerCase() === "retry-after");
  if (!key) return null;
  const raw = Array.isArray(headers[key]) ? headers[key][0] : headers[key];
  const v = String(raw == null ? "" : raw).trim();
  if (!v) return null;
  if (/^\d+(\.\d+)?$/.test(v)) return Math.round(Number(v) * 1000);
  const t = Date.parse(v);
  return Number.isFinite(t) ? Math.max(0, t - nowMs) : null;
}
/** Bounded exponential backoff with jitter: base * 2^(attempt-1), capped, then scaled into [50%, 100%] by `rand`. */
function backoffMs(attempt, s, rand) {
  const raw = Math.min(s.backoffCapMs, s.backoffBaseMs * Math.pow(2, Math.max(0, attempt - 1)));
  return Math.round(raw * (0.5 + 0.5 * (typeof rand === "function" ? rand() : Math.random())));
}

const scrub = (text, secret) => {
  let t = String(text == null ? "" : text);
  if (secret && String(secret).length >= 4) t = t.split(String(secret)).join("[key]");
  return t.replace(/pplx-[A-Za-z0-9_-]+/g, "[key]").replace(/sk-[A-Za-z0-9_-]{8,}/g, "[key]").replace(/Bearer\s+\S+/gi, "Bearer [key]").slice(0, 160);
};

/**
 * runLanes({ lanes, build, call, apiKey, sleep, clock, rand, settings }) -> { results, elapsedMs, settings }
 *   lanes: [{ id, ... }];  build(lane) -> provider payload;  call(payload, apiKey) -> Promise<{ status, json, headers? }> (rejects on network error or timeout)
 * results[i]: { lane, state, attempts, statuses:[...], waitsMs:[...], totalWaitMs, retryAfterSeen, startedMs, durationMs, reason, error, resp }
 */
async function runLanes({ lanes, build, call, apiKey, sleep, clock, rand, settings }) {
  const s = settings || laneSettings();
  const now = clock || Date.now;
  const t0 = now();
  const elapsed = () => now() - t0;
  const results = [];
  let lastStart = null, rateLimitsSeen = 0, stop = null;
  for (const lane of lanes) {
    const r = { lane: lane.id, state: "not_attempted", attempts: 0, statuses: [], waitsMs: [], totalWaitMs: 0, retryAfterSeen: false, startedMs: null, durationMs: null, reason: null, error: null, resp: null };
    results.push(r);
    if (stop) { r.reason = stop; continue; }
    // the interval between starts widens after every 429 seen, so a stricter limit than the default is found instead of assumed away
    if (lastStart != null) {
      const interval = s.minIntervalMs * (1 + rateLimitsSeen);
      const wait = Math.max(0, lastStart + interval - elapsed());
      if (wait > 0) {
        if (elapsed() + wait + s.expectedCallMs > s.budgetMs) { r.reason = stop = "time_budget"; continue; }
        await sleep(wait); r.totalWaitMs += wait;
      }
    }
    if (elapsed() + s.expectedCallMs > s.budgetMs) { r.reason = stop = "time_budget"; continue; }
    lastStart = elapsed(); r.startedMs = lastStart;
    const payload = build(lane);
    let lastKind = null;
    for (let attempt = 1; attempt <= s.maxAttempts; attempt++) {
      r.attempts = attempt;
      let res = null, threw = null;
      try { res = await call(payload, apiKey); } catch (err) { threw = err; }
      const status = threw ? null : (res && res.status) || null;
      r.statuses.push(status);
      if (!threw && status >= 200 && status < 300 && res.json) { r.state = "success"; r.resp = res.json; r.reason = null; r.error = null; break; }
      lastKind = threw ? "network" : status === 429 ? "rate_limited" : status >= 500 ? "server" : "rejected";
      r.state = lastKind === "rate_limited" ? "rate_limited" : "failed";
      r.error = threw ? scrub(threw && threw.message, apiKey) : scrub(`HTTP ${status}${res && res.json && (res.json.error && (res.json.error.message || res.json.error) || res.json.message) ? `: ${res.json.error && (res.json.error.message || res.json.error) || res.json.message}` : ""}`, apiKey);
      if (lastKind === "rate_limited") rateLimitsSeen++;
      if (lastKind === "rejected") { r.reason = "not_retryable"; break; }          // 400, 401, 403 and the like are not waited out
      if (attempt >= s.maxAttempts) { r.reason = "retries_exhausted"; break; }
      const ra = lastKind === "rate_limited" ? retryAfterMs(res && res.headers, Date.now()) : null;
      if (ra != null) r.retryAfterSeen = true;
      const wait = ra != null ? ra : backoffMs(attempt, s, rand);
      if (ra != null && ra > s.maxWaitMs) { r.reason = "retry_after_exceeds_max_wait"; break; }
      if (elapsed() + wait + s.expectedCallMs > s.budgetMs) { r.reason = "time_budget"; stop = stop || "time_budget"; break; }
      await sleep(wait); r.waitsMs.push(wait); r.totalWaitMs += wait;
    }
    r.durationMs = elapsed() - lastStart;
  }
  return { results, elapsedMs: elapsed(), settings: s };
}

module.exports = { LANE_STATES, BACKGROUND_LIMIT_MS, laneSettings, worstCaseMs, retryAfterMs, backoffMs, runLanes, scrub };
