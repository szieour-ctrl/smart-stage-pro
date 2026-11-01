// lib/agent-marketing-research-run-lib.js — Netlify (shared). Runs ONE Local Market Insider research session (Oct 24, 2026).
//
// Calls Perplexity, then holds the answer to the rules in agent-marketing-research-lib.js. The only network call is
// callPerplexity(); tests pass their own callFn. The API key is used in one header and is never logged or returned.
//
//   runResearch({ row, apiKey }) → { fields, problems, attempts }
//     `fields` is exactly what to PATCH onto the agent_marketing_research row: status "ready" with five topics and charged_at,
//     or status "failed" with charged_at null. A session is never charged unless five validated topics were delivered.
"use strict";

const https = require("https");
const rl = require("./agent-marketing-research-lib");
const reportTopics = require("./agent-marketing-research-report-lib");
const planLib = require("./agent-marketing-plan-lib");
const reframeLib = require("./agent-marketing-reframe-lib");
const diagLib = require("./agent-marketing-research-diag-lib");
const articleLed = require("./agent-marketing-article-led-lib");
const compact = require("./agent-marketing-compact-lib");
const laneRunner = require("./agent-marketing-lane-runner-lib");

const API_HOST = "api.perplexity.ai";
const API_PATH = "/v1/agent";
const CALL_TIMEOUT_MS = 120000;

// USD per 1M tokens, from Perplexity's Agent API models page (Oct 24, 2026), plus $0.0025 per standard web_search call. Used ONLY to
// estimate cost when the provider does not report one; a provider-reported cost always wins.
const SEARCH_CALL_USD = 0.0025;
const PRICES = {
  "perplexity/sonar": { in: 0.25, out: 2.5 },
  "perplexity/glm-5.3-flash": { in: 0.15, out: 0.5 },
  "openai/gpt-6-luna": { in: 0.1, out: 0.5 },
  "openai/gpt-5.6-luna": { in: 0.2, out: 1.2 },
  "anthropic/claude-haiku-5-5": { in: 0.1, out: 0.5 },
  "google/gemini-3.7-flash": { in: 0.75, out: 3.75 },
  "anthropic/claude-sonnet-5-5": { in: 2, out: 10 },
  "openai/gpt-6-sol": { in: 2, out: 10 },
};

function estimateCostUsd(model, usage) {
  const p = PRICES[String(model || "")];
  const u = usage || {};
  if (!p || u.promptTokens == null || u.completionTokens == null) return null;
  const n = (v) => (Number.isFinite(Number(v)) ? Number(v) : 0);
  const usd = (n(u.promptTokens) * p.in + n(u.completionTokens) * p.out) / 1e6 + n(u.searchQueries) * SEARCH_CALL_USD;
  return Math.round(usd * 1e6) / 1e6;
}

function todayPT(now) {
  return new Intl.DateTimeFormat("en-CA", { timeZone: "America/Los_Angeles", year: "numeric", month: "2-digit", day: "2-digit" }).format(now ? new Date(now) : new Date());
}

// ── The one network call ────────────────────────────────────────────────────────────────────────────────────────
// Resolves { status, json } for ANY HTTP status; rejects only on a network error or timeout (marked retryable).
function callPerplexity(payload, apiKey) {
  return new Promise((resolve, reject) => {
    const bodyStr = JSON.stringify(payload);
    const req = https.request({
      hostname: API_HOST, path: API_PATH, method: "POST",
      headers: { "Authorization": `Bearer ${apiKey}`, "Content-Type": "application/json", "Content-Length": Buffer.byteLength(bodyStr) },
    }, (res) => {
      let data = "";
      res.setEncoding("utf8");
      res.on("data", (c) => (data += c));
      res.on("end", () => { let json = null; try { json = JSON.parse(data); } catch { /* leave null */ } resolve({ status: res.statusCode, json, headers: res.headers }); });
    });
    req.setTimeout(CALL_TIMEOUT_MS, () => { const e = new Error("Research timed out"); e.retryable = true; req.destroy(e); });
    req.on("error", (e) => { e.retryable = true; reject(e); });
    req.write(bodyStr);
    req.end();
  });
}

// A short, safe description of what the provider said ("401: Invalid API key"), kept with the failed session so the cause can be seen in
// the test page while debugging. Anything that looks like a key, and the key itself, is removed.
function providerDetail(status, json, apiKey) {
  let t = `${status}: ${errText(json) || "no message"}`;
  if (apiKey) t = t.split(String(apiKey)).join("[key]");
  return t.replace(/pplx-[A-Za-z0-9_-]+/g, "[key]").replace(/Bearer\s+\S+/gi, "Bearer [key]").slice(0, 240);
}

const defaultSleep = (ms) => new Promise((r) => setTimeout(r, ms));
const errText = (j) => String((j && (j.error && (j.error.message || j.error) || j.message)) || "").slice(0, 200);

/**
 * askProvider({ payload, apiKey, callFn, sleepFn, retries }) → { resp, modelUsed }  (throws a user-safe Error)
 * Retries only busy/network failures (429, 5xx, timeouts).
 */
async function askProvider({ payload, apiKey, callFn, sleepFn, retries }) {
  const call = callFn || module.exports.callPerplexity; // looked up at call time so tests can replace it
  const sleep = sleepFn || defaultSleep;
  const delays = [1500, 4000, 8000];
  const body = payload;
  for (let attempt = 0; ; attempt++) {
    let res;
    try { res = await call(body, apiKey); }
    catch (e) {
      if (attempt < retries) { await sleep(delays[attempt] || 8000); continue; }
      throw new Error("Research is busy right now or timed out.");
    }
    const status = res && res.status;
    if (status >= 200 && status < 300 && res.json) return { resp: res.json, modelUsed: body.model };
    if ((status === 429 || status >= 500) && attempt < retries) { await sleep(delays[attempt] || 8000); continue; }
    const detail = providerDetail(status, res && res.json, apiKey);
    console.error(`[agent-marketing-research] provider answered ${detail}`);
    const fail = (msg) => { const e = new Error(msg); e.providerDetail = detail; return e; };
    if (status === 401 || status === 403) throw fail("Research is not set up correctly yet.");
    if (status === 429 || status >= 500) throw fail("Research is busy right now. Please try again.");
    throw fail("The research request was not accepted.");
  }
}

// ── Grounding: only trust sources the provider itself found ─────────────────────────────────────────────────────
// Perplexity returns the pages it actually read (citations / search_results). A source the model names that is NOT in that list
// may be invented, so it is dropped. When the provider sends a publish date for a page, that date replaces the model's claim.
function urlKey(u) {
  try { const x = new URL(String(u)); return `${x.hostname.toLowerCase().replace(/^www\./, "")}${x.pathname.replace(/\/+$/, "")}`; } catch { return ""; }
}
function providerDay(v) { const m = /^(\d{4}-\d{2}-\d{2})/.exec(String(v || "")); return m ? m[1] : null; }

// The answer text, wherever the Agent API puts it (output_text, or the message item in output[]).
function answerText(resp) {
  if (!resp || typeof resp !== "object") return "";
  if (typeof resp.output_text === "string" && resp.output_text) return resp.output_text;
  const parts = [];
  (Array.isArray(resp.output) ? resp.output : []).forEach((it) => {
    if (it && it.type === "message") (Array.isArray(it.content) ? it.content : []).forEach((c) => { if (c && typeof c.text === "string") parts.push(c.text); });
  });
  return parts.join("\n");
}

// Diagnostics isolation (PR 1): every statement that only RECORDS goes through this; an exception in it is swallowed, so a diagnostics fault can never
// change which sources or topics survive grounding. Nothing a recording statement does feeds back into the result.
function diagOnly(fn) { try { return fn(); } catch (_) { return undefined; } }

// `diag` (optional) is a diagnostics collector: it only receives a record of each decision below and never changes the result.
function groundTopics(rawTopics, resp, diag) {
  const known = new Map();
  const add = (url, date) => { const k = urlKey(url); if (k && !known.has(k)) known.set(k, providerDay(date)); };
  (Array.isArray(resp && resp.output) ? resp.output : []).forEach((it) => {
    if (it && it.type === "search_results") (Array.isArray(it.results) ? it.results : []).forEach((x) => x && add(x.url, x.date || x.last_updated));
  });
  (Array.isArray(resp && resp.citations) ? resp.citations : []).forEach((c) => add(typeof c === "string" ? c : c && c.url));
  (Array.isArray(resp && resp.search_results) ? resp.search_results : []).forEach((s) => s && add(s.url, s.date || s.last_updated));
  if (known.size === 0) { if (diag) diagOnly(() => { diag.grounding = { applicable: false, provider_urls: 0 }; }); return { topics: rawTopics, grounded: false }; } // the provider gave nothing to check against
  if (diag) diagOnly(() => { diag.grounding = { applicable: true, provider_urls: known.size }; });
  const topics = (Array.isArray(rawTopics) ? rawTopics : []).map((t, ti) => {
    if (!t || typeof t !== "object") return t;
    if (diag) diagOnly(() => (Array.isArray(t.sources) ? t.sources : []).forEach((s) => {
      if (!s) return;
      const ok = known.has(urlKey(s.url)), d = ok ? known.get(urlKey(s.url)) : null;
      diagLib.pushSource(diag, { topic: ti + 1, url: s.url, title: s.title, model_date: s.published, provider_date: d, date_from: ok ? (d ? "provider" : "model") : null, outcome: ok ? "kept" : "dropped", stage: "provider_grounding", code: ok ? "grounded" : "not_in_provider_results" });
    }));
    const sources = (Array.isArray(t.sources) ? t.sources : []).filter((s) => s && known.has(urlKey(s.url))).map((s) => {
      const d = known.get(urlKey(s.url));
      return d ? { ...s, published: d } : s;
    });
    return { ...t, sources };
  });
  return { topics, grounded: true };
}

// ── Usage across attempts ───────────────────────────────────────────────────────────────────────────────────────
const SUM_FIELDS = ["promptTokens", "completionTokens", "citationTokens", "reasoningTokens", "searchQueries", "costUsd"];
function addUsage(total, u) {
  const out = { ...total };
  SUM_FIELDS.forEach((k) => { if (u[k] != null) out[k] = (out[k] == null ? 0 : out[k]) + u[k]; });
  return out;
}

function requestFromRow(row) {
  const refs = Array.isArray(row.upload_refs) ? row.upload_refs : [];
  return {
    request: { mode: row.mode, audience: row.audience, geography: row.geography, focus: row.focus || {}, keywords: (row.focus && row.focus.keywords) || "", dataFocus: (row.focus && row.focus.dataFocus) || "all", period: (row.focus && row.focus.period) || null, dataSource: row.data_source || "web", uploadIds: refs.map((r) => r && r.id).filter(Boolean) },
    // Only the scope note (places, dates, counts) ever goes to the web provider: never a price, median or address from a report.
    uploadContext: (row.data_source || "web") === "both" ? refs.map((r) => r && r.scope_note).filter(Boolean).join("; ") : "",
  };
}

function citationUrls(resp) {
  const out = [];
  (Array.isArray(resp && resp.citations) ? resp.citations : []).forEach((c) => out.push(typeof c === "string" ? c : c && c.url));
  (Array.isArray(resp && resp.search_results) ? resp.search_results : []).forEach((s) => out.push(s && s.url));
  (Array.isArray(resp && resp.output) ? resp.output : []).forEach((it) => { if (it && Array.isArray(it.fetch_url_results)) it.fetch_url_results.forEach((x) => out.push(x && x.url)); });
  (Array.isArray(resp && resp.fetch_url_results) ? resp.fetch_url_results : []).forEach((x) => out.push(x && x.url));
  (Array.isArray(resp && resp.output) ? resp.output : []).forEach((it) => { if (it && it.type === "search_results") (Array.isArray(it.results) ? it.results : []).forEach((x) => out.push(x && x.url)); });
  return out.filter(Boolean);
}
// Which answer to keep when more than one is usable (Sam, Oct 31, 2026): a weaker retry must not silently replace a stronger earlier answer.
// Strength, in order: valid distinct topics, then distinct articles, then distinct publishers, then total sources. Equal strength: the later answer.
function strengthOf(validation) {
  const topics = validation && validation.ok && Array.isArray(validation.topics) ? validation.topics : [];
  const srcs = topics.flatMap((t) => (Array.isArray(t.sources) ? t.sources : []));
  const host = (u) => { try { return new URL(String(u)).hostname.replace(/^www\./i, "").toLowerCase(); } catch { return ""; } };
  if (topics.length && topics.every((t) => t.discovery === compact.DESIGN)) {
    // Compact Stage A: valid selected candidates, then editorial substance (rank scores), then official-primary support, then total sources.
    const sel = topics.map((t) => (t.candidate && t.candidate.selection) || {});
    const sum = (k) => sel.reduce((n, x) => n + (x[k] || 0), 0);
    return [topics.length, sum("editorialScore"), sum("sourceSupport"), srcs.length];
  }
  if (topics.length && topics.every((t) => t.discovery === "v2")) {
    // Article-Led (v2): valid distinct opportunities, then supporting-source quality (primary records, authoritative primary records, then total sources).
    // Different articles or publishers are not a strength here: several opportunities may rest on one article.
    const primary = srcs.filter((x) => x.role === "primary").length;
    const authoritative = srcs.filter((x) => x.role === "primary" && (x.kind === "government_record" || x.kind === "financing_economic")).length;
    return [topics.length, primary, authoritative, srcs.length];
  }
  return [
    topics.length,
    new Set(topics.map((t) => rl.articleKey(t.sources && t.sources[0] && t.sources[0].url)).filter(Boolean)).size,
    new Set(srcs.map((s) => host(s.url)).filter(Boolean)).size,
    srcs.length,
  ];
}
/** > 0 when a is stronger than b, < 0 when weaker, 0 when equal. */
function compareStrength(a, b) {
  const x = strengthOf(a), y = strengthOf(b);
  for (let i = 0; i < x.length; i++) if (x[i] !== y[i]) return x[i] - y[i];
  return 0;
}

/**
 * runResearch({ row, apiKey, uploads, anthropicKey, claudeFn, callFn, sleepFn, now, env }) → { fields, problems, attempts }
 * Where the topics come from is row.data_source:
 *   web     Perplexity only (what every session did before).
 *   upload  Claude writes the five topics from the agent's confirmed report(s); no web call at all.
 *   both    Perplexity finds five web topics as before; Claude writes up to three from the report(s); the report's topics come first.
 * Up to 1 + AGENT_MARKETING_RESEARCH_RETRIES (default 1, max 2) web answers are tried. A retry tells the provider why the previous
 * answer was rejected. All attempts' usage is added together, so the stored cost is the real cost of the session.
 * A session is charged only when FIVE validated topics are delivered, whatever the source.
 */
async function runResearch({ row, apiKey, uploads, anthropicKey, claudeFn, callFn, sleepFn, now, env, clock: opts_clock, rand: opts_rand }) {
  const e = env || process.env;
  const cfg = rl.researchSettings(e);
  const extra = Number(e.AGENT_MARKETING_RESEARCH_RETRIES);
  const providerRetries = 2;
  const today = todayPT(now);
  const { request, uploadContext } = requestFromRow(row);
  const dataSource = request.dataSource;
  // Article-Led pathway (PR 2): only with AGENT_MARKETING_ARTICLE_LED_ENABLED, a Market Update that is not report-only. Flag off: everything below is v1.
  const alOn = articleLed.isArticleLed(request, e);
  // Article-Led runs the compact Stage A design by default (up to eight short candidates; code qualifies, ranks and keeps up to five). AGENT_MARKETING_ARTICLE_LED_DESIGN=detailed keeps the earlier prompt for diagnostics.
  const cmp = alOn && compact.designOf(e) === "compact";
  // The ordinary retry is off for Article-Led until a targeted second pass is evaluated (AGENT_MARKETING_ARTICLE_LED_RETRIES to measure it). Legacy keeps its one retry.
  // Three-lane experiment (AGENT_MARKETING_ARTICLE_LED_LANES=three): three independent compact passes over the same market; merged, deduplicated and ranked in code. No retry.
  const lanesMode = cmp && compact.lanesOn(e);
  const maxAttempts = lanesMode ? 1 : 1 + (alOn ? compact.retriesFor(e) : (Number.isInteger(extra) && extra >= 0 && extra <= 2 ? extra : 1));
  let payload = dataSource === "upload" ? null : (cmp ? compact.buildPayloadCompact({ request, today, env: e }) : alOn ? articleLed.buildPayloadV2({ request, today, env: e }) : rl.buildResearchPayload({ request, today, uploadContext, env: e }));
  const baseInput = payload && payload.input;
  let usage = { promptTokens: null, completionTokens: null, citationTokens: null, reasoningTokens: null, searchQueries: null, costUsd: null };
  let modelUsed = payload ? payload.model : null, grounded = null, attempts = 0, problems = [], validation = null, error = null, providerError = null;
  let mlsNote = null;
  let reportNote = null, reportAttempts = 0, reframeAttempts = 0, reframed = 0, topicAnswer = null;
  // Diagnostics (PR 1): everything below that touches `diag*` only RECORDS. It is wrapped so a diagnostics error can never change the result.
  const safe = (fn) => { try { return fn(); } catch (err) { console.error(`[agent-marketing-research] diagnostics skipped: ${String(err && err.message).slice(0, 160)}`); return undefined; } };
  const diagAttempts = [];
  let usedAttempt = null, lastWhy = null, webTopics = null, webOverlaps = 0;
  let best = null;            // the strongest usable answer so far: { validation, attempt }
  const strengthLog = [];     // diagnostics: how each answer compared
  const firstPayload = payload;
  let laneLog = null, laneMeta = null;         // three-lane experiment: per-lane cost, yield and errors

  // One sanitized record per lane: name, state, attempts, HTTP statuses, waits, durations, actual provider cost, candidates and the candidates selected. No credentials.
  const laneRecord = (l) => ({
    lane: l.lane, state: l.run.state, reason: l.run.reason || null, attempts: l.run.attempts, http_statuses: l.run.statuses, waits_ms: l.run.waitsMs, total_wait_ms: l.run.totalWaitMs, retry_after_seen: l.run.retryAfterSeen,
    started_ms: l.run.startedMs, duration_ms: l.run.durationMs, error: l.run.error || null,
    // null, not zero, when the lane did not answer: a failed lane is not a lane that found nothing
    returned: l.run.state === "success" ? l.topics.length : null, grounded: l.grounded,
    cost_usd: l.usage ? l.usage.costUsd : null, prompt_tokens: l.usage ? l.usage.promptTokens : null, completion_tokens: l.usage ? l.usage.completionTokens : null, searches: l.usage ? l.usage.searchQueries : null,
    selected: null, selected_ids: null,
  });
  const clockFn = opts_clock, randFn = opts_rand;

  try {
    if (dataSource !== "upload") {
      while (attempts < maxAttempts) {
        attempts++;
        const attemptDiag = safe(() => diagLib.newAttemptDiag()) || null;
        const attemptCfg = safe(() => diagLib.attemptConfig(payload, cfg));
        const t0 = Date.now(), retryReason = lastWhy;
        let provided, laneRaw = null;
        if (lanesMode) {
          // Sequential, rate-limit-aware dispatch (lane-runner lib): Retry-After or jittered backoff, a minimum interval between lane starts, a time budget inside the
          // background function's limit, and independent per-lane state. A lane that did not succeed is never read as a successful lane with zero candidates.
          const ls = laneRunner.laneSettings(e);
          const call = callFn || module.exports.callPerplexity;
          const ran = await laneRunner.runLanes({ lanes: compact.lanesFor(e), build: (lane) => compact.buildPayloadCompact({ request, today, env: e, lane }), call, apiKey, sleep: sleepFn || defaultSleep, clock: clockFn, rand: randFn, settings: ls });
          laneRaw = ran.results.map((x) => {
            const base = { lane: x.lane, run: x, state: x.state, usage: null, topics: [], text: "", resp: x.resp, grounded: null, parseError: null };
            if (x.state !== "success") return base;
            const r = x.resp, t = answerText(r), us = rl.usageSummary(r, cfg.costTargetUsd);
            try { const g = groundTopics(compact.extractCandidates(t), r, null); return { ...base, text: t, usage: us, grounded: g.grounded, topics: g.topics.map((c) => (c && typeof c === "object" ? { ...c, _lane: x.lane } : c)) }; }
            catch (pe) { return { ...base, state: "failed", text: t, usage: us, parseError: pe.message, run: { ...x, state: "failed", reason: "unreadable_answer", error: laneRunner.scrub(pe.message, apiKey) } }; }   // billed, but not a usable answer
          });
          laneMeta = { settings: ls, elapsedMs: ran.elapsedMs, worstCaseMs: laneRunner.worstCaseMs(ls), backgroundLimitMs: laneRunner.BACKGROUND_LIMIT_MS };
          const okLanes = laneRaw.filter((l) => l.state === "success");
          if (!okLanes.length) {
            safe(() => diagAttempts.push({ n: attempts, config: attemptCfg, ms: Date.now() - t0, retry_reason: retryReason, provider_error: true, diag: attemptDiag }));
            usage = laneRaw.reduce((tot, l) => (l.usage ? addUsage(tot, l.usage) : tot), usage);   // a billed but unreadable answer still costs money
            laneLog = laneRaw.map(laneRecord);
            const worst = laneRaw.find((l) => l.run.state === "rate_limited") || laneRaw.find((l) => l.run.state === "failed") || laneRaw[0];
            const pe = new Error(worst.run.state === "rate_limited" ? "Research is busy right now. Please try again." : worst.run.state === "not_attempted" ? "Research ran out of time. Please try again." : "The research could not be completed.");
            pe.providerDetail = worst.run.error || null; throw pe;
          }
          provided = { resp: { output: laneRaw.flatMap((l) => (l.resp && Array.isArray(l.resp.output) ? l.resp.output : [])), citations: laneRaw.flatMap((l) => (l.resp && Array.isArray(l.resp.citations) ? l.resp.citations : [])) }, modelUsed: (okLanes[0].resp && okLanes[0].resp.model) || firstPayload.model };
        } else {
          try { provided = await askProvider({ payload, apiKey, callFn, sleepFn, retries: providerRetries }); }
          catch (pe) { safe(() => diagAttempts.push({ n: attempts, config: attemptCfg, ms: Date.now() - t0, retry_reason: retryReason, provider_error: true, diag: attemptDiag })); throw pe; }
        }
        const { resp, modelUsed: m } = provided;
        modelUsed = m;
        const attemptUsage = lanesMode ? laneRaw.reduce((tot, l) => (l.usage ? addUsage(tot, l.usage) : tot), { promptTokens: null, completionTokens: null, citationTokens: null, reasoningTokens: null, searchQueries: null, costUsd: null }) : rl.usageSummary(resp, cfg.costTargetUsd);
        usage = addUsage(usage, attemptUsage);
        const text = lanesMode ? laneRaw.map((l) => `[${l.lane}] ${l.text}`).join("\n") : answerText(resp);
        topicAnswer = { answer: text.slice(0, 1500), citations: citationUrls(resp).slice(0, 8).map((u) => String(u).slice(0, 200)), attempt: attempts };
        if (lanesMode) safe(() => { laneLog = laneRaw.map(laneRecord); });
        try {
          if (lanesMode) {
            const merged = laneRaw.flatMap((l) => l.topics);
            grounded = laneRaw.some((l) => l.grounded);
            validation = compact.validateCandidates(merged, { today, geography: request.geography, diag: attemptDiag, maxCandidates: compact.MAX_CANDIDATES * compact.lanesFor(e).length });
            problems = validation.problems;
          } else {
          const g = groundTopics(cmp ? compact.extractCandidates(text) : alOn ? articleLed.extractOpportunities(text) : rl.extractTopics(text), resp, attemptDiag);
          grounded = g.grounded;
          validation = cmp
            ? compact.validateCandidates(g.topics, { today, geography: request.geography, limits: articleLed.extractLimits(text), diag: attemptDiag })
            : alOn
            ? articleLed.validateOpportunities(g.topics, { today, geography: request.geography, limits: articleLed.extractLimits(text), recommendation: rl.extractRecommendation(text), diag: attemptDiag })
            : rl.validateTopics(g.topics, { mode: request.mode, today, recommendation: rl.extractRecommendation(text), need: dataSource === "both" ? rl.TOPIC_COUNT - reportTopics.REPORT_TOPICS_WHEN_BOTH : rl.TOPIC_COUNT, diag: attemptDiag });
          problems = validation.problems;
          }
        } catch (parseErr) {
          validation = { ok: false, topics: [], problems: [parseErr.message] };
          problems = validation.problems;
        }
        const soft = validation.ok && validation.soft ? validation.soft : [];
        usedAttempt = attempts;
        if (validation.ok && (!best || compareStrength(validation, best.validation) >= 0)) best = { validation, attempt: attempts };   // equal strength: the later answer
        safe(() => strengthLog.push({ n: attempts, ok: !!validation.ok, strength: strengthOf(validation) }));
        safe(() => diagAttempts.push({
          n: attempts, config: attemptCfg, ms: Date.now() - t0, retry_reason: retryReason, grounding: attemptDiag.grounding, diag: attemptDiag, candidates: diagLib.candidatesOf(resp),
          usage: { promptTokens: attemptUsage.promptTokens, completionTokens: attemptUsage.completionTokens, reasoningTokens: attemptUsage.reasoningTokens, searchQueries: attemptUsage.searchQueries, costUsd: attemptUsage.costUsd, costEstimatedUsd: attemptUsage.costUsd == null ? estimateCostUsd(m, attemptUsage) : null },
        }));
        if (validation.ok && !soft.length) break;
        if (attempts < maxAttempts) {
          const why = validation.ok ? soft : problems;
          lastWhy = why;
          const tool = payload.tools && payload.tools[0];
          // A retry also looks wider (more results, more search context) so there is more to choose publishers from.
          // Article-Led (v2) does not widen the search on a retry: search-context limits are not raised without evidence that they help (Sam, Oct 31).
          const tools = alOn ? payload.tools : (tool ? [{ ...tool, max_results: Math.max(tool.max_results || 0, 20), max_tokens: Math.max(tool.max_tokens || 0, 10000) }] : payload.tools);
          if (cmp) payload = { ...payload, tools, input: compact.retryInstructionCompact(why, baseInput) };
          else if (alOn) payload = { ...payload, tools, input: articleLed.retryInstructionV2(why, baseInput) };
          else payload = { ...payload, tools, input: `${baseInput}\n\nYour previous answer was ${validation.ok ? "usable but needs work" : "rejected"}: ${why.slice(0, 6).join("; ").slice(0, 600)}. Return the JSON again with exactly 5 topics that fix this. Do not invent sources, dates or events.` };
        }
      }
      // Keep the strongest usable answer: an earlier one when a later answer is weaker or unusable (never the reverse).
      if (best && (!(validation && validation.ok) || best.validation !== validation)) { validation = best.validation; usedAttempt = best.attempt; }
      // What the web research alone delivered (before the report topics are added): the yardstick for discovery quality.
      safe(() => {
        webTopics = validation && validation.ok ? validation.topics.slice() : [];
        const used = diagAttempts.find((a) => a.n === usedAttempt);
        webOverlaps = used && used.diag ? used.diag.topics.filter((t) => t.code === "overlaps_earlier_topic").length : 0;
      });
      if (validation && validation.ok && validation.partial && !reportNote) reportNote = `Only ${validation.topics.length} of 5 topics came back with a usable article this time, because few local news stories matched. Your own MLS report is the best way to add more.`;
      else if (validation && validation.ok && validation.soft && validation.soft.length && !reportNote) reportNote = "Most of these topics rest on one or two websites, because few independent sources were found for this market this month. Your own MLS report is the best way to add a second source.";
    }
    // Article-Led (v2): the confirmed MLS report is separate numerical evidence. It writes no topics, takes none of the five positions and triggers no
    // reframe. Its figures are attached to each opportunity the same way they are for a web topic in combined mode, so Reel creation keeps working.
    if (alOn && validation && validation.ok) {
      // The MLS report is attached for compatibility with the legacy Planner (the existing applyReportPrecedence, which attaches figures and marks the topic reportFirst).
      // Each opportunity says what MLS evidence it actually has: never "complete", and a missing or truncated report is stated as such.
      let ctx = null;
      if (dataSource === "both") {
        try { ctx = reportTopics.buildContext(uploads, request); if (ctx.figures && ctx.figures.size) validation = { ...validation, topics: reportTopics.applyReportPrecedence(validation.topics, ctx) }; }
        catch (err) { console.error(`[agent-marketing-research] report figures not attached: ${String(err && err.message).slice(0, 200)}`); }
      }
      const available = ctx && ctx.figures ? ctx.figures.size : 0;
      validation = { ...validation, topics: validation.topics.map((t) => ({ ...t, mlsEvidence: articleLed.mlsEvidenceOf({ requested: dataSource === "both", available, included: Array.isArray(t.reportFigures) ? t.reportFigures.length : 0 }) })) };
      const evNote = articleLed.mlsEvidenceNote(validation.topics.map((t) => t.mlsEvidence));
      mlsNote = evNote;
    }
    if (!alOn && dataSource !== "web" && (dataSource === "upload" || (validation && validation.ok))) {
      // Topics from the agent's own report. In "both", a failure here is not fatal: the five web topics are still delivered, and the agent is told.
      const ctx = reportTopics.buildContext(uploads, request);
      const want = dataSource === "both" ? reportTopics.REPORT_TOPICS_WHEN_BOTH : rl.TOPIC_COUNT;
      try {
        if (!ctx.reports.length) throw new Error("no report figures");
        const out = await reportTopics.generateReportTopics({ ctx, want, minNeeded: dataSource === "both" ? 1 : rl.TOPIC_COUNT, today, anthropicKey, callFn: claudeFn });
        reportAttempts = out.attempts;
        modelUsed = dataSource === "upload" ? planLib.MODEL : modelUsed;
        const combined = reportTopics.combineTopics({ dataSource, reportTopics: out.topics, webTopics: validation && validation.topics });
        let toUse = combined;
        if (combined && dataSource === "both") {
          // Web topics about a wider area than the agent's market are reframed: the article is the context, the agent's report is the answer.
          // Failure-safe: any problem leaves the topics exactly as the web research wrote them.
          try {
            const rf = await reframeLib.reframeTopics({ topics: combined, ctx, today, anthropicKey, callFn: claudeFn });
            reframeAttempts = rf.attempts; reframed = rf.reframed; toUse = rf.topics;
          } catch (rfErr) { console.error(`[agent-marketing-research] reframe skipped: ${String(rfErr && rfErr.message).slice(0, 200)}`); }
        }
        if (combined) validation = { ok: true, topics: dataSource === "both" ? reportTopics.applyReportPrecedence(toUse, ctx) : combined, problems: [] }; // the agent's own report wins over a conflicting same-area web figure
        else if (dataSource === "upload") { problems = out.problems.length ? out.problems : [`only ${out.topics.length} topics could be written from the report`]; validation = { ok: false, topics: [], problems }; }
        else reportNote = "Your report could not be turned into topics this time, so these five come from web research only.";
        if (dataSource === "both" && out.topics.length === 0 && !reportNote) reportNote = "Your report could not be turned into topics this time, so these five come from web research only.";
      } catch (err) {
        console.error(`[agent-marketing-research] report topics failed: ${String(err && err.message).slice(0, 200)}`);
        if (dataSource === "upload") { error = "Topics could not be written from your report this time. This did not use a session."; }
        else reportNote = "Your report could not be turned into topics this time, so these five come from web research only.";
      }
    }
    // Keywords asked for but no article found about them: say so, never pass an unrelated article off as a match.
    if (validation && validation.ok && request.mode === "market_update" && String(request.keywords || "").trim() && !validation.topics.some((t) => t.keywordMatch === true)) {
      reportNote = `No article about \u201c${String(request.keywords).trim().slice(0, 80)}\u201d was found for this market this time, so these topics cover other timely news. ${reportNote || ""}`.trim();
    }
  } catch (err) {
    error = err.message;
    providerError = err.providerDetail || null;
  }

  // Cost: the provider's own figure when it sent one, otherwise an estimate from tokens (flagged as an estimate).
  const estimated = usage.costUsd == null ? estimateCostUsd(modelUsed, usage) : null;
  const costUsd = usage.costUsd != null ? usage.costUsd : estimated;
  // Article-Led billing and the partial-result note: one session is charged only when five qualifying opportunities are delivered.
  const alCharge = alOn ? articleLed.shouldCharge(validation) : true;
  if (alOn && validation && validation.ok) {
    if (!alCharge) reportNote = articleLed.partialNote(validation);
    if (mlsNote) reportNote = [reportNote, mlsNote].filter(Boolean).join(" ");
  }
  const discovery = safe(() => {
    const rec = diagLib.buildRecord({ request, dataSource, cfg, firstPayload, attempts: diagAttempts, usedAttempt, finalTopics: webTopics, today, codeVersion: e.COMMIT_REF || e.DEPLOY_ID || null });
    rec.selection = { rule: "strongest_valid_attempt", chosen: usedAttempt, order: "topics, articles, publishers, sources; tie = later answer", attempts: strengthLog };
    rec.pathway = alOn ? "article_led" : "legacy";
    if (laneLog) {
      const byLane = validation && validation.summary && validation.summary.by_lane || {};
      laneLog.forEach((l) => { const sel = (validation && validation.ok ? validation.topics : []).filter((t) => t.candidate && t.candidate.lane === l.lane); l.selected = sel.length; l.selected_ids = sel.map((t) => t.candidate.id); l.duplicates = (byLane[l.lane] || {}).duplicates || 0; });
      rec.lanes = laneLog; rec.lane_run = laneMeta && { settings: laneMeta.settings, elapsed_ms: laneMeta.elapsedMs, worst_case_ms: laneMeta.worstCaseMs, background_limit_ms: laneMeta.backgroundLimitMs, within_budget: laneMeta.worstCaseMs < laneMeta.backgroundLimitMs };
    }
    if (alOn && webTopics) rec.depth_v2 = cmp ? compact.depthCompact(webTopics, validation && validation.summary) : articleLed.depthV2(webTopics);
    if (cmp && validation && validation.candidates) rec.candidate_selection = { design: compact.DESIGN, summary: validation.summary, candidates: validation.candidates, retries: compact.retriesFor(e), max_output_tokens: firstPayload && firstPayload.max_output_tokens };
    rec.depth = webTopics ? diagLib.depthOf({ topics: webTopics, geography: request.geography, today, overlaps: webOverlaps }) : null;
    const fin = validation && validation.ok ? validation.topics : null;
    rec.final = fin ? { topics: fin.length, origin: { web: fin.filter((t) => t.origin !== "report").length, report: fin.filter((t) => t.origin === "report").length }, scope: { selected: fin.filter((t) => t.scope !== "broader_context").length, broader_context: fin.filter((t) => t.scope === "broader_context").length }, reframed: fin.filter((t) => t.reframed === true).length } : null;
    return diagLib.bound(rec);
  });
  const finalUsage = { ...usage, ...(discovery ? { discovery } : {}), ...(alOn ? { pathway: "article_led", articleLed: { delivered: validation && validation.ok ? validation.topics.length : 0, charged: !!(validation && validation.ok && alCharge), limits: validation && validation.limits || null, offerMlsTrend: !!(validation && validation.ok && !alCharge), ...(laneLog ? { lanes: laneLog.length, lanesSucceeded: laneLog.filter((l) => l.state === "success").length, lanesRateLimited: laneLog.filter((l) => l.state === "rate_limited").length, lanesFailed: laneLog.filter((l) => l.state === "failed").length, lanesNotAttempted: laneLog.filter((l) => l.state === "not_attempted").length, lanesIncomplete: laneLog.some((l) => l.state !== "success") } : {}) } } : {}), costUsd, costEstimated: usage.costUsd == null && estimated != null, targetUsd: cfg.costTargetUsd, withinTarget: costUsd == null ? null : costUsd <= cfg.costTargetUsd, attempts, grounded, providerError, dataSource, reportAttempts, reframeAttempts, reframed, reportNote, topicDebug: validation && validation.ok ? null : topicAnswer, problems: problems.slice(0, 6).map((x) => String(x).slice(0, 200)) };
  const fields = rl.outcomeFields({ validation: error ? null : validation, usage: finalUsage, model: modelUsed, today, now, error, charge: alCharge });
  return { fields, problems, attempts };
}

// Which allowance size applies: a brokerage or team member draws on that tier's number; everyone else (including trials and
// packages, for now) gets the Solo number. Mirrors getPlanContext in reel-quota-lib.js.
function planKeyFromContext(ctx) {
  if (ctx && ctx.poolKind === "brokerage") return "brokerage";
  if (ctx && ctx.poolKind === "team") return "team";
  return "solo";
}

module.exports = { strengthOf, compareStrength, answerText, PRICES, estimateCostUsd, todayPT, callPerplexity, askProvider, groundTopics, urlKey, requestFromRow, runResearch, planKeyFromContext, citationUrls };
