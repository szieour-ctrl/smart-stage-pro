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
      res.on("data", (c) => (data += c));
      res.on("end", () => { let json = null; try { json = JSON.parse(data); } catch { /* leave null */ } resolve({ status: res.statusCode, json }); });
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

function groundTopics(rawTopics, resp) {
  const known = new Map();
  const add = (url, date) => { const k = urlKey(url); if (k && !known.has(k)) known.set(k, providerDay(date)); };
  (Array.isArray(resp && resp.output) ? resp.output : []).forEach((it) => {
    if (it && it.type === "search_results") (Array.isArray(it.results) ? it.results : []).forEach((x) => x && add(x.url, x.date || x.last_updated));
  });
  (Array.isArray(resp && resp.citations) ? resp.citations : []).forEach((c) => add(typeof c === "string" ? c : c && c.url));
  (Array.isArray(resp && resp.search_results) ? resp.search_results : []).forEach((s) => s && add(s.url, s.date || s.last_updated));
  if (known.size === 0) return { topics: rawTopics, grounded: false }; // the provider gave nothing to check against
  const topics = (Array.isArray(rawTopics) ? rawTopics : []).map((t) => {
    if (!t || typeof t !== "object") return t;
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
async function runResearch({ row, apiKey, uploads, anthropicKey, claudeFn, callFn, sleepFn, now, env }) {
  const e = env || process.env;
  const cfg = rl.researchSettings(e);
  const extra = Number(e.AGENT_MARKETING_RESEARCH_RETRIES);
  const maxAttempts = 1 + (Number.isInteger(extra) && extra >= 0 && extra <= 2 ? extra : 1);
  const providerRetries = 2;
  const today = todayPT(now);
  const { request, uploadContext } = requestFromRow(row);
  const dataSource = request.dataSource;
  let payload = dataSource === "upload" ? null : rl.buildResearchPayload({ request, today, uploadContext, env: e });
  const baseInput = payload && payload.input;
  let usage = { promptTokens: null, completionTokens: null, citationTokens: null, reasoningTokens: null, searchQueries: null, costUsd: null };
  let modelUsed = payload ? payload.model : null, grounded = null, attempts = 0, problems = [], validation = null, error = null, providerError = null;
  let reportNote = null, reportAttempts = 0, fallback = null;

  try {
    if (dataSource !== "upload") {
      while (attempts < maxAttempts) {
        attempts++;
        const { resp, modelUsed: m } = await askProvider({ payload, apiKey, callFn, sleepFn, retries: providerRetries });
        modelUsed = m;
        usage = addUsage(usage, rl.usageSummary(resp, cfg.costTargetUsd));
        const text = answerText(resp);
        try {
          const g = groundTopics(rl.extractTopics(text), resp);
          grounded = g.grounded;
          validation = rl.validateTopics(g.topics, { mode: request.mode, today, recommendation: rl.extractRecommendation(text) });
          problems = validation.problems;
        } catch (parseErr) {
          validation = { ok: false, topics: [], problems: [parseErr.message] };
          problems = validation.problems;
        }
        const soft = validation.ok && validation.soft ? validation.soft : [];
        if (validation.ok && !soft.length) break;
        if (validation.ok) fallback = fallback || validation;   // usable, but too few different sites: keep it in case the retry does worse
        if (attempts < maxAttempts) {
          const why = validation.ok ? soft : problems;
          const tool = payload.tools && payload.tools[0];
          // A retry also looks wider (more results, more search context) so there is more to choose publishers from.
          const tools = tool ? [{ ...tool, max_results: Math.max(tool.max_results || 0, 20), max_tokens: Math.max(tool.max_tokens || 0, 10000) }] : payload.tools;
          payload = { ...payload, tools, input: `${baseInput}\n\nYour previous answer was ${validation.ok ? "usable but needs work" : "rejected"}: ${why.slice(0, 6).join("; ").slice(0, 600)}. Return the JSON again with exactly 5 topics that fix this. Do not invent sources, dates or events.` };
        }
      }
      if (!(validation && validation.ok) && fallback) validation = fallback;
      if (validation && validation.ok && validation.soft && validation.soft.length && !reportNote) reportNote = "Most of these topics rest on one or two websites, because few independent sources were found for this market this month. Your own MLS report is the best way to add a second source.";
    }
    if (dataSource !== "web" && (dataSource === "upload" || (validation && validation.ok))) {
      // Topics from the agent's own report. In "both", a failure here is not fatal: the five web topics are still delivered, and the agent is told.
      const ctx = reportTopics.buildContext(uploads, request);
      const want = dataSource === "both" ? reportTopics.REPORT_TOPICS_WHEN_BOTH : rl.TOPIC_COUNT;
      try {
        if (!ctx.reports.length) throw new Error("no report figures");
        const out = await reportTopics.generateReportTopics({ ctx, want, minNeeded: dataSource === "both" ? 1 : rl.TOPIC_COUNT, today, anthropicKey, callFn: claudeFn });
        reportAttempts = out.attempts;
        modelUsed = dataSource === "upload" ? planLib.MODEL : modelUsed;
        const combined = reportTopics.combineTopics({ dataSource, reportTopics: out.topics, webTopics: validation && validation.topics });
        if (combined) validation = { ok: true, topics: dataSource === "both" ? reportTopics.applyReportPrecedence(combined, ctx) : combined, problems: [] }; // the agent's own report wins over a conflicting web figure
        else if (dataSource === "upload") { problems = out.problems.length ? out.problems : [`only ${out.topics.length} topics could be written from the report`]; validation = { ok: false, topics: [], problems }; }
        else reportNote = "Your report could not be turned into topics this time, so these five come from web research only.";
        if (dataSource === "both" && out.topics.length === 0 && !reportNote) reportNote = "Your report could not be turned into topics this time, so these five come from web research only.";
      } catch (err) {
        console.error(`[agent-marketing-research] report topics failed: ${String(err && err.message).slice(0, 200)}`);
        if (dataSource === "upload") { error = "Topics could not be written from your report this time. This did not use a session."; }
        else reportNote = "Your report could not be turned into topics this time, so these five come from web research only.";
      }
    }
  } catch (err) {
    error = err.message;
    providerError = err.providerDetail || null;
  }

  // Cost: the provider's own figure when it sent one, otherwise an estimate from tokens (flagged as an estimate).
  const estimated = usage.costUsd == null ? estimateCostUsd(modelUsed, usage) : null;
  const costUsd = usage.costUsd != null ? usage.costUsd : estimated;
  const finalUsage = { ...usage, costUsd, costEstimated: usage.costUsd == null && estimated != null, targetUsd: cfg.costTargetUsd, withinTarget: costUsd == null ? null : costUsd <= cfg.costTargetUsd, attempts, grounded, providerError, dataSource, reportAttempts, reportNote, problems: problems.slice(0, 6).map((x) => String(x).slice(0, 200)) };
  const fields = rl.outcomeFields({ validation: error ? null : validation, usage: finalUsage, model: modelUsed, today, now, error });
  return { fields, problems, attempts };
}

// Which allowance size applies: a brokerage or team member draws on that tier's number; everyone else (including trials and
// packages, for now) gets the Solo number. Mirrors getPlanContext in reel-quota-lib.js.
function planKeyFromContext(ctx) {
  if (ctx && ctx.poolKind === "brokerage") return "brokerage";
  if (ctx && ctx.poolKind === "team") return "team";
  return "solo";
}

module.exports = { answerText, PRICES, estimateCostUsd, todayPT, callPerplexity, askProvider, groundTopics, urlKey, requestFromRow, runResearch, planKeyFromContext };
