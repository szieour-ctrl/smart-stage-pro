#!/usr/bin/env node
"use strict";
// Research baseline harness (PR 1). Measures what today's discovery delivers, market by market, so the BP-01 redesign can be compared with it.
//
//   node scripts/research-baseline.js --replay                  offline smoke run on recorded-style answers (no key, no cost)
//   PERPLEXITY_API_KEY=... node scripts/research-baseline.js --live [--markets lincoln,natomas] [--repeats 2] [--out dir]
//
// Live runs call Perplexity through the same runResearch() the app uses (same prompt, same validation). They write NOTHING to Supabase and charge
// no subscriber session; the only cost is the provider's. Every run records its full search configuration and its actual cost.
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

const CELLS = Object.freeze([
  { id: "as_shipped", results: null, context: null, retries: null },
  { id: "r10_c6000", results: 10, context: 6000, retries: 0 },
  { id: "r20_c6000", results: 20, context: 6000, retries: 0 },
  { id: "r10_c10000", results: 10, context: 10000, retries: 0 },
  { id: "r20_c10000", results: 20, context: 10000, retries: 0 },
]);
const MARKETS = JSON.parse(fs.readFileSync(path.join(__dirname, "..", "tests", "fixtures", "research-diag", "markets.json"), "utf8"));
delete MARKETS._note;

function parseArgs(argv) {
  const a = { live: false, replay: false, markets: Object.keys(MARKETS), repeats: 2, out: null, today: null };
  for (let i = 0; i < argv.length; i++) {
    const k = argv[i];
    if (k === "--live") a.live = true;
    else if (k === "--replay") a.replay = true;
    else if (k === "--markets") a.markets = String(argv[++i] || "").split(",").map((x) => x.trim()).filter(Boolean);
    else if (k === "--repeats") a.repeats = Math.max(1, Math.min(5, Number(argv[++i]) || 2));
    else if (k === "--out") a.out = argv[++i];
    else if (k === "--today") a.today = argv[++i];
  }
  if (a.live === a.replay) throw new Error("Choose exactly one of --live or --replay.");
  const bad = a.markets.filter((m) => !MARKETS[m]);
  if (bad.length) throw new Error(`Unknown market(s): ${bad.join(", ")}. Known: ${Object.keys(MARKETS).join(", ")}`);
  return a;
}

/** The plan: every market x cell x repeat, in a fixed order. */
function plan(markets, repeats) {
  const out = [];
  markets.forEach((m) => CELLS.forEach((c) => { for (let r = 1; r <= repeats; r++) out.push({ market: m, cell: c, repeat: r }); }));
  return out;
}

/** The environment for one cell: the search limits are set through the research settings, so the recorded configuration is exactly what was sent. */
function cellEnv(base, cell) {
  return {
    ...base,
    ...(cell.retries != null ? { AGENT_MARKETING_RESEARCH_RETRIES: String(cell.retries) } : {}),
    ...(cell.results != null ? { AGENT_MARKETING_RESEARCH_MAX_RESULTS: String(cell.results), AGENT_MARKETING_RESEARCH_SEARCH_TOKENS: String(cell.context) } : {}),
  };
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
  const jobs = plan(args.markets, args.repeats);
  const stamp = new Date().toISOString().slice(0, 10);
  const dir = args.out || path.join(process.cwd(), `research-baseline-${stamp}${args.replay ? "-replay" : ""}`);
  fs.mkdirSync(dir, { recursive: true });
  const rows = [];
  const quiet = args.replay ? () => {} : console.error;
  for (const job of jobs) {
    const row = { id: `baseline-${job.market}-${job.cell.id}-${job.repeat}`, mode: "market_update", audience: "sellers", geography: MARKETS[job.market], focus: {}, upload_refs: [], data_source: "web" };
    const env = cellEnv(process.env, job.cell);
    const inner = args.replay ? (async () => fx.replayReply(job.repeat)) : null;
    const callFn = inner || ((payload, k) => run.callPerplexity(payload, k));
    const t0 = Date.now();
    const origErr = console.error; console.error = quiet;
    let result;
    try { result = await run.runResearch({ row, apiKey: key || "replay", now: args.replay ? fx.NOW : (args.today || undefined), env, callFn, sleepFn: async () => {} }); }
    finally { console.error = origErr; }
    const sum = summarizeRun(job, result, Date.now() - t0, args.replay);
    rows.push(sum);
    fs.appendFileSync(path.join(dir, "runs.jsonl"), JSON.stringify(sum) + "\n");
    // The full diagnostics record of the run, for investigating a weak result.
    fs.writeFileSync(path.join(dir, `${job.market}-${job.cell.id}-${job.repeat}.discovery.json`), JSON.stringify(result.fields.usage && result.fields.usage.discovery || null, null, 1));
    process.stdout.write(`${job.market} ${job.cell.id} #${job.repeat}: ${sum.status} topics=${sum.topics_kept} cost=${sum.cost_usd == null ? "n/a" : "$" + sum.cost_usd}\n`);
  }
  fs.writeFileSync(path.join(dir, "summary.md"), summaryMarkdown(rows));
  process.stdout.write(`\nWrote ${rows.length} runs to ${dir}\n`);
}

module.exports = { CELLS, MARKETS, parseArgs, plan, cellEnv, summarizeRun, summaryMarkdown };
if (require.main === module) main().catch((e) => { console.error(e.message); process.exit(1); });
