#!/usr/bin/env node
"use strict";
// Research baseline harness (PR 1). Measures what today's discovery delivers, market by market, so the BP-01 redesign can be compared with it.
//
//   node scripts/research-baseline.js --replay                  offline smoke run on recorded-style answers (no key, no cost)
//   PERPLEXITY_API_KEY=... node scripts/research-baseline.js --live [--markets lincoln,natomas] [--repeats 2] [--out dir]
//
// Live runs call Perplexity through the same runResearch() the app uses (same prompt, same validation). They write NOTHING to Supabase and charge
// no subscriber session; the only cost is the provider's. Every run records its full search configuration and its actual cost.
// The key is read from the environment only. It is never written, printed or committed: every output passes through redact(), and result
// folders (research-baseline-*) are git-ignored.
//
// Cells (the 10-versus-20 comparison separates result count from context-token allowance):
//   as_shipped  today's settings including the retry that widens the search (what production does now)
//   r10_c6000   10 results, 6,000 context tokens   (today's "medium" first attempt)
//   r20_c6000   20 results, 6,000 context tokens   (result count only)
//   r10_c10000  10 results, 10,000 context tokens  (context allowance only)
//   r20_c10000  20 results, 10,000 context tokens  (today's "high")
// The four fixed cells send exactly one search (retries off) with the stated limits, set through AGENT_MARKETING_RESEARCH_MAX_RESULTS and AGENT_MARKETING_RESEARCH_SEARCH_TOKENS, so a cell never mixes in the retry widening and the stored configuration is what was sent.

const fs = require("fs");
const path = require("path");
const run = require("../netlify/functions/lib/agent-marketing-research-run-lib");
const diagLib = require("../netlify/functions/lib/agent-marketing-research-diag-lib");

// v1 cells: today's prompt. v2 cells (PR 2): the Article-Led prompt with AGENT_MARKETING_ARTICLE_LED_ENABLED on, one search, retries off, so they compare with
// the v1 fixed cells. The first v2 cell is the approved starting point (20 results, 6,000 context tokens, 5,000 output tokens); the second changes only the
// output-token allowance (2,200, as in v1) so its effect is measured separately; the third is the v2 default settings with its one retry.
const CELLS = Object.freeze([
  { id: "as_shipped", results: null, context: null, retries: null },
  { id: "r10_c6000", results: 10, context: 6000, retries: 0 },
  { id: "r20_c6000", results: 20, context: 6000, retries: 0 },
  { id: "r10_c10000", results: 10, context: 10000, retries: 0 },
  { id: "r20_c10000", results: 20, context: 10000, retries: 0 },
  { id: "v2_r20_c6000_o5000", prompt: "v2", results: 20, context: 6000, output: 5000, retries: 0 },
  { id: "v2_r20_c6000_o2200", prompt: "v2", results: 20, context: 6000, output: 2200, retries: 0 },
  { id: "v2_default", prompt: "v2", results: null, context: null, output: null, retries: null },
  // Compact Stage A (PR 2, Oct 31): up to eight short candidates, code selects up to five. The two compact cells differ only in the output allowance (4,500 and 6,000).
  // The detailed-prompt diagnostic cell runs the existing detailed prompt at 8,000 output tokens, one run per market (maxRepeats), to show what the compact design
  // gives up or gains. Search limits are the same everywhere (20 results, 6,000 context tokens); the ordinary retry is off.
  { id: "compact_r20_c6000_o4500", prompt: "compact", results: 20, context: 6000, output: 4500, retries: 0 },
  { id: "compact_r20_c6000_o6000", prompt: "compact", results: 20, context: 6000, output: 6000, retries: 0 },
  // Three-lane experiment (Oct 31): three independent compact passes (municipal, housing, economy) over the same market, merged in code. Compared with compact_r20_c6000_o4500.
  { id: "lanes3_r20_c6000_o4500", prompt: "compact", lanes: "three", results: 20, context: 6000, output: 4500, retries: 0 },
  { id: "detailed_r20_c6000_o8000", prompt: "compact", design: "detailed", maxRepeats: 1, results: 20, context: 6000, output: 8000, retries: 0 },
]);
const cellsFor = (prompt) => CELLS.filter((c) => (prompt === "v2" ? c.prompt === "v2" : prompt === "compact" ? c.prompt === "compact" && !c.lanes : prompt === "lanes" ? !!c.lanes : prompt === "both" ? true : c.prompt !== "v2" && c.prompt !== "compact"));
const isArticleCell = (c) => c.prompt === "v2" || c.prompt === "compact";
const designOfCell = (c) => (c.prompt === "compact" ? c.design || "compact" : c.prompt === "v2" ? "detailed" : null);
const MARKETS = JSON.parse(fs.readFileSync(path.join(__dirname, "..", "tests", "fixtures", "research-diag", "markets.json"), "utf8"));
delete MARKETS._note;

/** Nothing the harness writes or prints may contain a credential: the key itself and anything key-shaped is removed first. */
function redact(text, key) {
  let t = String(text);
  if (key && String(key).length >= 4) t = t.split(String(key)).join("[key]");
  return t.replace(/pplx-[A-Za-z0-9_-]+/g, "[key]").replace(/sk-[A-Za-z0-9_-]{8,}/g, "[key]").replace(/Bearer\s+\S+/gi, "Bearer [key]");
}

function parseArgs(argv) {
  const a = { live: false, replay: false, markets: Object.keys(MARKETS), repeats: 2, out: null, today: null, prompt: "v1", cells: null };
  for (let i = 0; i < argv.length; i++) {
    const k = argv[i];
    if (k === "--live") a.live = true;
    else if (k === "--replay") a.replay = true;
    else if (k === "--markets") a.markets = String(argv[++i] || "").split(",").map((x) => x.trim()).filter(Boolean);
    else if (k === "--repeats") a.repeats = Math.max(1, Math.min(5, Number(argv[++i]) || 2));
    else if (k === "--out") a.out = argv[++i];
    else if (k === "--today") a.today = argv[++i];
    else if (k === "--prompt") a.prompt = String(argv[++i] || "");
    else if (k === "--cells") a.cells = String(argv[++i] || "").split(",").map((x) => x.trim()).filter(Boolean);
  }
  if (a.live === a.replay) throw new Error("Choose exactly one of --live or --replay.");
  if (!["v1", "v2", "compact", "lanes", "both"].includes(a.prompt)) throw new Error("--prompt must be v1, v2, compact, lanes or both.");
  const badCells = (a.cells || []).filter((c) => !CELLS.some((x) => x.id === c));
  if (badCells.length) throw new Error(`Unknown cell(s): ${badCells.join(", ")}. Known: ${CELLS.map((c) => c.id).join(", ")}`);
  const bad = a.markets.filter((m) => !MARKETS[m]);
  if (bad.length) throw new Error(`Unknown market(s): ${bad.join(", ")}. Known: ${Object.keys(MARKETS).join(", ")}`);
  return a;
}

/** The plan: every market x cell x repeat, in a fixed order. */
function plan(markets, repeats, cells) {
  const out = [];
  const list = cells && cells.length ? cells.map((c) => (typeof c === "string" ? CELLS.find((x) => x.id === c) : c)).filter(Boolean) : CELLS.filter((c) => !isArticleCell(c));   // cell ids or cell objects
  markets.forEach((m) => list.forEach((c) => { for (let r = 1; r <= Math.min(repeats, c.maxRepeats || repeats); r++) out.push({ market: m, cell: c, repeat: r }); }));
  return out;
}

/** The environment for one cell: the search limits are set through the research settings, so the recorded configuration is exactly what was sent. */
function cellEnv(base, cell) {
  return {
    ...base,
    ...(cell.retries != null ? { AGENT_MARKETING_RESEARCH_RETRIES: String(cell.retries) } : {}),
    ...(cell.results != null ? { AGENT_MARKETING_RESEARCH_MAX_RESULTS: String(cell.results), AGENT_MARKETING_RESEARCH_SEARCH_TOKENS: String(cell.context) } : {}),
    ...(cell.output != null ? { AGENT_MARKETING_RESEARCH_MAX_TOKENS: String(cell.output) } : {}),
    ...(isArticleCell(cell) ? { AGENT_MARKETING_ARTICLE_LED_ENABLED: "true", AGENT_MARKETING_ARTICLE_LED_DESIGN: designOfCell(cell), AGENT_MARKETING_ARTICLE_LED_RETRIES: String(cell.retries == null ? 0 : cell.retries), AGENT_MARKETING_ARTICLE_LED_LANES: cell.lanes || "" } : { AGENT_MARKETING_ARTICLE_LED_ENABLED: "" }),   // v1 cells always run the v1 prompt
  };
}

/** The delivered Article-Led cards, for a human to read next to the diagnostics (model-written summaries and source references; no article text, no credentials). */
function compactCardsOf(topics) {
  return (Array.isArray(topics) ? topics : []).filter((t) => t && t.candidate).map((t, i) => {
    const c = t.candidate;
    return { n: i + 1, candidateId: c.id, lane: c.lane || null, alsoFoundIn: c.alsoFoundIn || null, question: c.question, development: c.development, angle: c.angle, why: c.why, strength: c.strength, relevance: c.relevance, gap: c.gap,
      relationship: c.geography.relationship, route: c.geography.route, geography: { nameFoundInSource: c.geography.nameFoundInSource, nameEvidence: c.geography.nameEvidence, provisional: true, hierarchy: c.geography.hierarchy, modelSourceGeography: c.geography.modelSourceGeography },
      status: c.status, event: c.event, selection: c.selection, review: c.review, provisionalEvidence: c.provisionalEvidence,
      sources: (c.sources || []).map((s) => ({ ref: s.ref, title: s.title, host: s.host, url: diagLib.safeUrl(s.url), published: s.published, role: s.role, kind: s.kind, outletClass: s.outletClass, window: s.window, sourceGeography: s.sourceGeography, reportingPeriod: s.reportingPeriod, whatItEstablishes: s.whatItEstablishes })) };
  });
}
function cardsOf(topics) {
  if ((Array.isArray(topics) ? topics : []).some((t) => t && t.candidate)) return compactCardsOf(topics);
  return (Array.isArray(topics) ? topics : []).filter((t) => t && t.editorial).map((t, i) => ({
    n: i + 1, question: t.question, scope: t.scope, scopeNote: t.scopeNote || null, relationship: t.editorial.geographicRelationship, routeToMarket: t.editorial.routeToMarket,
    status: t.editorial.status, claimedStatus: t.editorial.claimedStatus, statusReason: t.editorial.statusReason, actionDate: t.editorial.actionDate, statusCheckedDate: t.editorial.statusCheckedDate,
    development: t.editorial.development, angle: t.editorial.angle, thesis: t.editorial.thesis, homeownerDecision: t.editorial.homeownerDecision,
    sourceReportedFacts: t.editorial.sourceReportedFacts, geographyCheck: t.editorial.geographyCheck, qualification: t.editorial.qualification, review: t.editorial.review, possibleExplanations: t.editorial.possibleExplanations, projectFacts: t.editorial.projectFacts, evidencePoints: t.editorial.evidencePoints,
    evidenceGaps: t.editorial.evidenceGaps, verificationNeeds: t.editorial.verificationNeeds, accessConfidence: t.editorial.accessConfidence,
    sources: (t.sources || []).map((s) => ({ title: s.title, host: s.domain, url: diagLib.safeUrl(s.url), published: s.published, role: s.role, kind: s.kind, window: s.window, sourceGeography: s.sourceGeography, reportingPeriod: s.reportingPeriod, whatItEstablishes: s.whatItEstablishes })),
  }));
}

function summarizeRun(job, result, ms, replay) {
  const f = result.fields || {};
  const u = f.usage || {};
  const d = u.discovery || null;
  const set = d && d.depth && d.depth.set || null;
  const kept = Array.isArray(f.topics) ? f.topics.length : 0;
  const cost = u.costUsd == null ? null : u.costUsd;
  return {
    replay: !!replay, market: job.market, cell: job.cell.id, repeat: job.repeat, status: f.status || null, error: f.error || null,
    attempts: result.attempts, ms,
    config_by_attempt: d ? d.attempts.map((a) => ({ n: a.n, ...a.config, ms: a.ms })) : null,
    cost_usd: cost, cost_estimated: !!u.costEstimated, prompt_tokens: u.promptTokens == null ? null : u.promptTokens, completion_tokens: u.completionTokens == null ? null : u.completionTokens,
    reasoning_tokens: u.reasoningTokens == null ? null : u.reasoningTokens, searches: u.searchQueries == null ? null : u.searchQueries,
    funnel: d ? d.funnel : null, topics_kept: kept,
    substantive_topics: set ? set.substantive_topics : null, distinct_articles: set ? set.distinct_articles : null, distinct_publishers: set ? set.distinct_publishers : null,
    distinct_developments_proxy: set ? set.distinct_developments_proxy : null, exact_market: set ? set.exact_market : null, broader_context: set ? set.broader_context : null,
    multi_publisher_topics: set ? set.multi_publisher_topics : null, median_newest_source_days: set ? set.median_newest_source_days : null,
    pathway: u.pathway || "legacy", charged: !!f.charged_at, v2: d && d.depth_v2 ? d.depth_v2 : null, delivered: u.articleLed ? u.articleLed.delivered : null, research_limit: u.articleLed && u.articleLed.limits ? u.articleLed.limits.reason : null,
    cost_per_kept_topic: cost != null && kept ? Math.round((cost / kept) * 1e6) / 1e6 : null,
    cost_per_substantive_topic: cost != null && set && set.substantive_topics ? Math.round((cost / set.substantive_topics) * 1e6) / 1e6 : null,
  };
}

const mean = (a) => { const v = a.filter((x) => x != null && Number.isFinite(x)); return v.length ? v.reduce((s, x) => s + x, 0) / v.length : null; };
const fmt = (x, d = 2) => (x == null ? "n/a" : Number(x).toFixed(d));

function summaryMarkdown(rows) {
  const out = ["# Research baseline", "", `Runs: ${rows.length}${rows.some((r) => r.replay) ? " (REPLAY: recorded-style answers, not a measurement of the live provider)" : ""}`, "",
    "| Market | Cell | Runs | OK | Candidates | Grounded | Topics kept | Substantive | Publishers | Cost $ (mean) | $/kept topic |", "| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |"];
  const keys = [...new Set(rows.map((r) => `${r.market}|${r.cell}`))];
  keys.forEach((k) => {
    const g = rows.filter((r) => `${r.market}|${r.cell}` === k);
    const [m, c] = k.split("|");
    out.push(`| ${m} | ${c} | ${g.length} | ${g.filter((r) => r.status === "ready").length} | ${fmt(mean(g.map((r) => r.funnel && r.funnel.provider_candidates)), 1)} | ${fmt(mean(g.map((r) => r.funnel && r.funnel.grounded_by_provider)), 1)} | ${fmt(mean(g.map((r) => r.topics_kept)), 1)} | ${fmt(mean(g.map((r) => r.substantive_topics)), 1)} | ${fmt(mean(g.map((r) => r.distinct_publishers)), 1)} | ${fmt(mean(g.map((r) => r.cost_usd)), 4)} | ${fmt(mean(g.map((r) => r.cost_per_kept_topic)), 4)} |`);
  });
  const cp = rows.filter((r) => r.v2 && r.v2.design === "compact_v1");
  if (cp.length) {
    out.push("", "## Compact Stage A depth", "", "| Market | Cell | Runs | Returned | Qualified | Selected | Charged | Distinct developments | Market scope | Name in source | Geography unsupported | Official primary | Government record | Original local reporting | Trade aggregation | Only brokerage | Unresolved | Needs review | $/run |", "| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |");
    [...new Set(cp.map((r) => `${r.market}|${r.cell}`))].forEach((k) => {
      const g = cp.filter((r) => `${r.market}|${r.cell}` === k); const [m, c] = k.split("|");
      const mv = (f) => fmt(mean(g.map((r) => r.v2[f])), 1);
      out.push(`| ${m} | ${c} | ${g.length} | ${mv("candidates_returned")} | ${mv("qualified")} | ${fmt(mean(g.map((r) => r.delivered)), 1)} | ${g.filter((r) => r.charged).length}/${g.length} | ${mv("distinct_developments")} | ${mv("market_scope")} | ${mv("name_found_in_source")} | ${mv("geography_unsupported")} | ${mv("with_official_primary")} | ${mv("with_government_record")} | ${mv("with_original_local_reporting")} | ${mv("with_trade_aggregation")} | ${mv("only_brokerage_or_agent")} | ${mv("status_unresolved")} | ${mv("needs_review")} | ${fmt(mean(g.map((r) => r.cost_usd)), 4)} |`);
    });
    out.push("", "Candidates are compact and provisional: structure measures only. Read the cards (*.cards.json) to judge them.");
  }
  const v2 = rows.filter((r) => r.v2 && r.v2.design !== "compact_v1");
  if (v2.length) {
    out.push("", "## Article-Led (v2) depth", "", "| Market | Cell | Runs | Delivered | Charged | Distinct developments | Exact or same jurisdiction | With authoritative primary | With local news or government | Only brokerage or agent sources | Status supported | With evidence gaps | $/run |", "| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |");
    [...new Set(v2.map((r) => `${r.market}|${r.cell}`))].forEach((k) => {
      const g = v2.filter((r) => `${r.market}|${r.cell}` === k); const [m, c] = k.split("|");
      const mv = (f) => fmt(mean(g.map((r) => r.v2[f])), 1);
      out.push(`| ${m} | ${c} | ${g.length} | ${fmt(mean(g.map((r) => r.delivered)), 1)} | ${g.filter((r) => r.charged).length}/${g.length} | ${mv("distinct_developments")} | ${mv("exact_or_same_jurisdiction")} | ${mv("with_authoritative_primary")} | ${mv("with_local_news_or_government")} | ${mv("only_brokerage_or_agent_sources")} | ${mv("status_supported")} | ${mv("with_evidence_gaps")} | ${fmt(mean(g.map((r) => r.cost_usd)), 4)} |`);
    });
    out.push("", "These are measures of structure, not of quality. Judge the opportunities themselves with the review sample (scripts/research-baseline-inventory.js).");
  }
  out.push("", "Substantive = at least 3 of 4 depth checks (two publishers, two signals, a figure with a period, an explanation of 120+ characters); see depth rubric v1. These are proxies, not a reading of the articles.");
  const total = rows.reduce((s, r) => s + (r.cost_usd || 0), 0);
  out.push("", `Total provider cost of these runs: $${total.toFixed(4)}${rows.some((r) => r.cost_estimated) ? " (some estimated from tokens)" : ""}.`);
  return out.join("\n") + "\n";
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const fx = require("../tests/fixtures/research-diag/scenarios");
  const key = process.env.PERPLEXITY_API_KEY;
  if (args.live && !key) throw new Error("--live needs PERPLEXITY_API_KEY in the environment.");
  const jobs = plan(args.markets, args.repeats, args.cells || cellsFor(args.prompt));
  const stamp = new Date().toISOString().slice(0, 10);
  const dir = args.out || path.join(process.cwd(), `research-baseline-${stamp}${args.replay ? "-replay" : ""}`);
  fs.mkdirSync(dir, { recursive: true });
  const rows = [];
  const quiet = args.replay ? () => {} : console.error;
  for (const job of jobs) {
    const row = { id: `baseline-${job.market}-${job.cell.id}-${job.repeat}`, mode: "market_update", audience: "sellers", geography: MARKETS[job.market], focus: {}, upload_refs: [], data_source: "web" };
    const env = cellEnv(process.env, job.cell);
    const laneOfPayload = (pl) => (/Lane: Municipal/.test(pl.input) ? "municipal" : /Lane: Housing/.test(pl.input) ? "housing" : /Lane: Financing/.test(pl.input) ? "economy" : null);
    const inner = args.replay ? (async (pl) => (job.cell.prompt === "v2" || designOfCell(job.cell) === "detailed" ? fx.replayReplyV2(job.repeat) : job.cell.prompt === "compact" ? fx.replayReplyCompact(job.repeat, laneOfPayload(pl || {})) : fx.replayReply(job.repeat))) : null;
    const callFn = inner || ((payload, k) => run.callPerplexity(payload, k));
    const t0 = Date.now();
    const origErr = console.error; console.error = quiet;
    let result;
    try { result = await run.runResearch({ row, apiKey: key || "replay", now: args.replay ? fx.NOW : (args.today || undefined), env, callFn, sleepFn: args.replay ? async () => {} : undefined }); }
    finally { console.error = origErr; }
    const sum = summarizeRun(job, result, Date.now() - t0, args.replay);
    rows.push(sum);
    fs.appendFileSync(path.join(dir, "runs.jsonl"), redact(JSON.stringify(sum), key) + "\n");
    if (isArticleCell(job.cell)) fs.writeFileSync(path.join(dir, `${job.market}-${job.cell.id}-${job.repeat}.cards.json`), redact(JSON.stringify(cardsOf(result.fields.topics), null, 1), key));
    // The full diagnostics record of the run, for investigating a weak result.
    fs.writeFileSync(path.join(dir, `${job.market}-${job.cell.id}-${job.repeat}.discovery.json`), redact(JSON.stringify(result.fields.usage && result.fields.usage.discovery || null, null, 1), key));
    process.stdout.write(redact(`${job.market} ${job.cell.id} #${job.repeat}: ${sum.status} topics=${sum.topics_kept} cost=${sum.cost_usd == null ? "n/a" : "$" + sum.cost_usd}${sum.error ? " error=" + sum.error : ""}`, key) + "\n");
  }
  fs.writeFileSync(path.join(dir, "summary.md"), redact(summaryMarkdown(rows), key));
  process.stdout.write(`\nWrote ${rows.length} runs to ${dir}\n`);
}

module.exports = { cardsOf, CELLS, cellsFor, MARKETS, parseArgs, plan, cellEnv, summarizeRun, summaryMarkdown, redact };
if (require.main === module) main().catch((e) => { console.error(redact(e.message, process.env.PERPLEXITY_API_KEY)); process.exit(1); });
