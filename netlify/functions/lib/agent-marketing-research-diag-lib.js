"use strict";
// Research diagnostics (PR 1). Pure helpers that DESCRIBE what the research pipeline did; nothing here decides anything.
//
// Contract (Sam, Oct 31, 2026): PR 1 must not change a prompt, a topic-selection decision, a compliance gate or Reel production. Every function
// here only builds a plain object that is stored in usage.discovery. Callers wrap it so a diagnostics failure can never change the research result.
//
// What is stored is bounded and sanitized: no credentials, no uploaded-report content, no URL query strings or fragments, no article text, no
// raw provider answer (the existing failure-only usage.topicDebug is untouched). Titles are cut to 120 characters, the agent-facing hook to 140.
// Size is capped (MAX_BYTES) and every record carries a retention date (RETENTION_DAYS). See docs/research-diagnostics.md.

const crypto = require("crypto");

const SCHEMA_VERSION = 1;
const DEPTH_RUBRIC_VERSION = 1;   // bump when the depth measures below change meaning, so runs of different rubrics are never compared
const RETENTION_DAYS = 90;
const MAX_BYTES = 24000;          // serialized size of usage.discovery
const MAX_CANDIDATES = 30;        // provider candidate pages kept per attempt
const MAX_SOURCE_RECORDS = 40;    // sources the model named, kept per attempt
const MAX_TOPIC_RECORDS = 12;
const TITLE_CHARS = 120, HOOK_CHARS = 140, DETAIL_CHARS = 160, REASON_LINES = 6;

// Where in the pipeline a source or topic was set aside. One stage per decision, so weak research can be traced to the step that lost it.
const STAGES = Object.freeze({
  PROVIDER_GROUNDING: "provider_grounding",     // the model named a page the provider never read
  ARTICLE_ELIGIBILITY: "article_eligibility",   // not https, paywalled, a listing/agent page, no title, bad address
  PUBLICATION_DATE: "publication_date",         // undated, future-dated, stale, unreadable date
  DUPLICATE: "duplicate",                       // the same address twice in one topic
  TOPIC_SELECTION: "topic_selection",           // a topic-level decision: invalid, overlapping, ranked past five, reordered
  ACCEPTED: "accepted",
});

const strip = (s) => String(s == null ? "" : s).replace(/[\u0000-\u001f\u007f]/g, " ").replace(/\s+/g, " ").trim();
const SECRET = /pplx-[A-Za-z0-9_-]+|sk-[A-Za-z0-9_-]{8,}|Bearer\s+\S+|(?:api[_-]?key|token|secret)=\S+/gi;
function safeText(s, max) { return strip(s).replace(SECRET, "[removed]").slice(0, max); }

/** https://host/path only: no query string, fragment, credentials or port; long opaque path segments (ids, tokens) become "…". */
function safeUrl(u) {
  try {
    const x = new URL(String(u || "").trim());
    if (x.protocol !== "https:" && x.protocol !== "http:") return "";
    const path = x.pathname.split("/").map((seg) => (/^[A-Za-z0-9_-]{28,}$/.test(seg) ? "…" : seg)).join("/");
    return `${x.protocol}//${x.hostname.toLowerCase().replace(/^www\./, "")}${path}`.slice(0, 200);
  } catch { return ""; }
}
function hostOf(u) { try { return new URL(String(u)).hostname.toLowerCase().replace(/^www\./, ""); } catch { return ""; } }
function keyOf(u) { try { const x = new URL(String(u)); return (x.hostname.replace(/^www\./i, "") + x.pathname.replace(/\/+$/, "")).toLowerCase(); } catch { return ""; } }
const day = (v) => { const m = /^(\d{4}-\d{2}-\d{2})/.exec(String(v || "")); return m ? m[1] : null; };

/** Every page the provider says it read (search results, citations, fetched pages), de-duplicated by article, capped. */
function candidatesOf(resp) {
  const seen = new Map();
  const add = (url, date, via) => {
    const k = keyOf(url);
    if (!k || seen.has(k)) return;
    seen.set(k, { url: safeUrl(url), host: hostOf(url), provider_date: day(date), via });
  };
  const r = resp && typeof resp === "object" ? resp : {};
  (Array.isArray(r.output) ? r.output : []).forEach((it) => {
    if (it && it.type === "search_results") (Array.isArray(it.results) ? it.results : []).forEach((x) => x && add(x.url, x.date || x.last_updated, "search_results"));
    if (it && Array.isArray(it.fetch_url_results)) it.fetch_url_results.forEach((x) => x && add(x.url, null, "fetched"));
  });
  (Array.isArray(r.search_results) ? r.search_results : []).forEach((s) => s && add(s.url, s.date || s.last_updated, "search_results"));
  (Array.isArray(r.citations) ? r.citations : []).forEach((c) => add(typeof c === "string" ? c : c && c.url, null, "citation"));
  const all = [...seen.values()];
  return { total: all.length, list: all.slice(0, MAX_CANDIDATES) };
}

/** A fresh collector for one provider answer. The validators push plain records into it. */
function newAttemptDiag() { return { sources: [], topics: [], grounding: null }; }

function pushSource(diag, rec) {
  if (!diag || !Array.isArray(diag.sources)) return;
  try {
    diag.sources.push({
      topic: rec.topic, url: safeUrl(rec.url), host: hostOf(rec.url), title: safeText(rec.title, TITLE_CHARS),
      model_date: day(rec.model_date), provider_date: day(rec.provider_date), date_from: rec.date_from || null,
      outcome: rec.outcome, stage: rec.stage, code: rec.code, detail: rec.detail ? safeText(rec.detail, DETAIL_CHARS) : null,
    });
  } catch { /* diagnostics never break research */ }
}
function pushTopic(diag, rec) {
  if (!diag || !Array.isArray(diag.topics)) return;
  try {
    diag.topics.push({
      topic: rec.topic, outcome: rec.outcome, stage: rec.stage, code: rec.code, detail: rec.detail ? safeText(rec.detail, DETAIL_CHARS) : null,
      hook: rec.hook ? safeText(rec.hook, HOOK_CHARS) : null, final_rank: rec.final_rank == null ? null : rec.final_rank,
    });
  } catch { /* ignore */ }
}

/**
 * One record per (topic, source). A later event updates the record unless the source was already set aside, so each source ends with the
 * stage that actually removed it (or "accepted").
 */
function mergeSources(events) {
  const out = new Map();
  (events || []).forEach((e) => {
    const k = `${e.topic}|${e.url}`;
    const prev = out.get(k);
    if (!prev) return out.set(k, { ...e });
    if (prev.outcome === "dropped") return;
    out.set(k, { ...prev, ...e, model_date: prev.model_date || e.model_date, title: prev.title || e.title, date_from: e.date_from || prev.date_from, provider_date: e.provider_date || prev.provider_date });
  });
  return [...out.values()];
}

function funnelOf(candidatesTotal, sources, topicRecords, finalTopics) {
  const s = sources || [];
  const droppedAt = (stage) => s.filter((x) => x.outcome === "dropped" && x.stage === stage).length;
  const named = s.length;
  const grounded = named - droppedAt(STAGES.PROVIDER_GROUNDING);
  const eligible = grounded - droppedAt(STAGES.ARTICLE_ELIGIBILITY);
  const dated = eligible - droppedAt(STAGES.PUBLICATION_DATE);
  const unique = dated - droppedAt(STAGES.DUPLICATE);
  const t = topicRecords || [];
  return {
    provider_candidates: candidatesTotal == null ? null : candidatesTotal,
    named_by_model: named, grounded_by_provider: grounded, article_eligible: eligible, date_ok: dated, unique_sources: unique,
    topics_answered: t.length, topics_kept: t.filter((x) => x.outcome === "kept").length, topics_final: finalTopics == null ? null : finalTopics,
  };
}

// ── Research depth (rubric v1) ─────────────────────────────────────────────────────────────────────────────
// These are DETERMINISTIC PROXIES computed from what validation already produced. They exist so the redesigned discovery prompt (BP-01) can be
// compared with today's on the same yardstick. They do not read articles, and "distinct developments" is a proxy (distinct articles that are not
// overlapping questions), not a judgment of what the articles report.
const HOUSING_RESEARCH = /(^|\.)(zillow\.com|redfin\.com|realtor\.com|freddiemac\.com|fanniemae\.com|car\.org|nar\.realtor|mba\.org|corelogic\.com)$/;
function sourceKind(host) {
  if (!host) return "unknown";
  if (/\.gov$/.test(host)) return "government";
  if (/\.edu$/.test(host)) return "education";
  if (HOUSING_RESEARCH.test(host)) return "housing_research";
  if (/\.org$/.test(host)) return "association_or_nonprofit";
  return "other";
}
const PERIOD = /\b(?:jan|feb|mar|apr|may|jun|jul|aug|sep|sept|oct|nov|dec)[a-z]*\.?\s+(?:\d{1,2},?\s+)?20\d\d\b|\bq[1-4]\s+20\d\d\b|\b20\d\d\b|\blast\s+(?:month|week|quarter)\b|\bthis\s+(?:month|week|quarter)\b/i;
const FIGURE = /\d/;
const ageDays = (published, today) => {
  const p = Date.parse(`${day(published)}T00:00:00Z`), t = Date.parse(`${today}T00:00:00Z`);
  return Number.isFinite(p) && Number.isFinite(t) ? Math.round((t - p) / 86400000) : null;
};
const median = (a) => { const v = a.filter((x) => x != null).sort((x, y) => x - y); if (!v.length) return null; const m = v.length >> 1; return v.length % 2 ? v[m] : Math.round((v[m - 1] + v[m]) / 2); };

function depthOf({ topics, geography, today, overlaps }) {
  const list = Array.isArray(topics) ? topics : [];
  const place = strip(geography && geography.name).toLowerCase();
  const per = list.map((t) => {
    const src = Array.isArray(t.sources) ? t.sources : [];
    const hosts = [...new Set(src.map((s) => hostOf(s.url)).filter(Boolean))];
    const articles = [...new Set(src.map((s) => keyOf(s.url)).filter(Boolean))];
    const ages = src.map((s) => ageDays(s.published, today)).filter((x) => x != null);
    const signals = Array.isArray(t.trendSignals) ? t.trendSignals : [];
    const withPeriod = signals.filter((s) => PERIOD.test(s)).length;
    const withFigure = signals.filter((s) => FIGURE.test(s)).length;
    const why = String(t.whyItMatters || "");
    const parts = { multi_source: hosts.length >= 2, multi_signal: signals.length >= 2, figure_with_period: signals.some((s) => FIGURE.test(s) && PERIOD.test(s)), explained: why.length >= 120 };
    const score = Object.values(parts).filter(Boolean).length;
    const wider = t.scope === "broader_context";
    return {
      id: t.id, origin: t.origin || "web", scope: wider ? "broader_context" : "selected",
      geographic_relationship: wider ? (t.scopeNote ? "wider_area_with_note" : "wider_area_no_note") : "exact_market",
      names_market_in_hook: !!place && String(t.question || "").toLowerCase().includes(place),
      sources: src.length, distinct_publishers: hosts.length, distinct_articles: articles.length,
      source_kinds: [...new Set(hosts.map(sourceKind))].sort(),
      newest_source_days: ages.length ? Math.min(...ages) : null, oldest_source_days: ages.length ? Math.max(...ages) : null,
      trend_signals: signals.length, signals_with_period: withPeriod, signals_with_figure: withFigure, why_chars: why.length,
      substance: { ...parts, score }, substantive: score >= 3,
    };
  });
  const allArticles = new Set();
  list.forEach((t) => (t.sources || []).forEach((s) => { const k = keyOf(s.url); if (k) allArticles.add(k); }));
  const allHosts = new Set();
  list.forEach((t) => (t.sources || []).forEach((s) => { const h = hostOf(s.url); if (h) allHosts.add(h); }));
  const firstArticles = new Set(list.map((t) => keyOf(t.sources && t.sources[0] && t.sources[0].url)).filter(Boolean));
  return {
    rubric: DEPTH_RUBRIC_VERSION,
    topics: per,
    set: {
      topics: per.length,
      distinct_articles: allArticles.size, distinct_publishers: allHosts.size,
      distinct_developments_proxy: Math.max(0, Math.min(firstArticles.size, per.length - (overlaps || 0))), overlapping_topics_removed: overlaps || 0,
      exact_market: per.filter((p) => p.scope === "selected").length, broader_context: per.filter((p) => p.scope === "broader_context").length,
      wider_area_with_note: per.filter((p) => p.geographic_relationship === "wider_area_with_note").length,
      substantive_topics: per.filter((p) => p.substantive).length,
      multi_publisher_topics: per.filter((p) => p.substance.multi_source).length,
      topics_with_government_source: per.filter((p) => p.source_kinds.includes("government")).length,
      topics_with_housing_research_source: per.filter((p) => p.source_kinds.includes("housing_research")).length,
      median_newest_source_days: median(per.map((p) => p.newest_source_days)),
    },
  };
}

const sha = (s) => crypto.createHash("sha256").update(String(s == null ? "" : s)).digest("hex").slice(0, 16);

function attemptConfig(payload, cfg) {
  const tool = (payload && Array.isArray(payload.tools) && payload.tools[0]) || {};
  return {
    model: payload && payload.model || null,
    search_context: cfg && cfg.searchContextSize || null,           // the named size the settings asked for
    max_results: tool.max_results == null ? null : tool.max_results,  // what was actually sent (a retry may widen both numbers)
    search_context_tokens: tool.max_tokens == null ? null : tool.max_tokens,
    max_output_tokens: payload && payload.max_output_tokens == null ? null : payload.max_output_tokens,
    published_after: tool.filters && tool.filters.search_after_date_filter ? String(tool.filters.search_after_date_filter) : null,
  };
}

function addDays(isoDay, n) {
  const t = Date.parse(`${isoDay}T00:00:00Z`);
  return Number.isFinite(t) ? new Date(t + n * 86400000).toISOString().slice(0, 10) : null;
}

/** Keeps the record under MAX_BYTES by dropping the least useful detail first, and says what it dropped. */
function bound(rec) {
  const size = () => Buffer.byteLength(JSON.stringify(rec));
  const trimmed = [];
  const steps = [
    ["candidates_over_12", () => rec.attempts.forEach((a) => { if (a.candidates) a.candidates = a.candidates.slice(0, 12); })],
    ["source_titles", () => rec.attempts.forEach((a) => (a.sources || []).forEach((s) => { delete s.title; }))],
    ["candidates", () => rec.attempts.forEach((a) => { delete a.candidates; })],
    ["earlier_attempt_sources", () => rec.attempts.slice(0, -1).forEach((a) => { delete a.sources; })],
    ["topic_details", () => { (rec.attempts || []).forEach((a) => { delete a.topics; }); }],
  ];
  for (const [name, fn] of steps) { if (size() <= MAX_BYTES) break; try { fn(); trimmed.push(name); } catch { /* ignore */ } }
  rec.trimmed = trimmed;
  rec.bytes = size();
  return rec;
}

/**
 * buildRecord → the object stored at usage.discovery.
 * attempts: [{ n, config, usage, ms, retry_reason, provider_error, candidates:{total,list}, diag:{sources,topics}, overlaps, validation_ok, partial }]
 */
function buildRecord({ request, dataSource, cfg, firstPayload, attempts, usedAttempt, finalTopics, today, codeVersion }) {
  const geo = request && request.geography || {};
  const atts = (attempts || []).map((a) => {
    const sources = mergeSources(a.diag && a.diag.sources).slice(0, MAX_SOURCE_RECORDS);
    const topicRecs = (a.diag && a.diag.topics || []).slice(0, MAX_TOPIC_RECORDS);
    return {
      n: a.n, config: a.config, usage: a.usage || null, ms: a.ms == null ? null : a.ms,
      retry_reason: a.retry_reason && a.retry_reason.length ? a.retry_reason.slice(0, REASON_LINES).map((x) => safeText(x, DETAIL_CHARS)) : null,
      provider_error: a.provider_error || false, grounding: a.grounding || null,
      candidates: a.candidates ? a.candidates.list : [], candidates_total: a.candidates ? a.candidates.total : null,
      sources, topics: topicRecs,
      funnel: funnelOf(a.candidates ? a.candidates.total : null, mergeSources(a.diag && a.diag.sources), a.diag && a.diag.topics, a.n === usedAttempt && finalTopics ? finalTopics.length : null),
    };
  });
  const used = atts.find((a) => a.n === usedAttempt) || null;
  const rec = {
    schema: SCHEMA_VERSION,
    retention: { days: RETENTION_DAYS, expires: addDays(today, RETENTION_DAYS) },
    request: {
      mode: request && request.mode || null, data_source: dataSource || null, audience: request && request.audience || null,
      geography: { type: geo.type || null, name: safeText(geo.name, 60), city: safeText(geo.city, 60), zip: safeText(geo.zip, 12) },
      period: request && request.period || null, keywords_given: !!(request && String(request.keywords || "").trim()), data_focus: request && request.dataFocus || null,
    },
    reproduce: { instructions_sha256: sha(firstPayload && firstPayload.instructions), input_sha256: sha(firstPayload && firstPayload.input), code_version: codeVersion ? safeText(codeVersion, 12) : null },
    settings: { configured: { model: cfg && cfg.model || null, search_context: cfg && cfg.searchContextSize || null, max_output_tokens: cfg && cfg.maxTokens || null } },
    used_attempt: usedAttempt == null ? null : usedAttempt,
    attempts: atts,
    funnel: used ? used.funnel : null,
    depth: null,
    final: null,
  };
  return rec;
}

module.exports = {
  SCHEMA_VERSION, DEPTH_RUBRIC_VERSION, RETENTION_DAYS, MAX_BYTES, MAX_CANDIDATES, MAX_SOURCE_RECORDS, STAGES,
  safeText, safeUrl, hostOf, keyOf, candidatesOf, newAttemptDiag, pushSource, pushTopic, mergeSources, funnelOf, depthOf, sourceKind,
  attemptConfig, buildRecord, bound, sha,
};
