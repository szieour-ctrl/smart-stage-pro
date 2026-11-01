#!/usr/bin/env node
"use strict";
// v1-versus-v2 benchmark review (PR 2). Reads two baseline folders written by scripts/research-baseline.js (the saved v1 baseline and the v2 run) and writes ONE
// review document: measured provider cost, development diversity, authoritative sources, local relevance, opportunities led by external housing statistics,
// brokerage or agent reliance, rejected-source diagnostics, and the actual v2 opportunities with their evidence.
//
//   node scripts/research-benchmark-report.js --v1 <v1 folder> --v2 <v2 folder> [--out benchmark-review.md] [--json benchmark-review.json]
//        [--v1-cells r10_c6000,r20_c6000] [--v2-cells v2_r20_c6000_o5000,v2_r20_c6000_o2200,v2_default]
//
// Every measure is a structural proxy computed from sanitized diagnostics (hosts, short titles, hooks, model-written cards); none reads article text. They sit
// beside the human review sample at the end, which is the real test of quality. Heuristics are stated where they are used.

const fs = require("fs");
const path = require("path");
const inv = require("./research-baseline-inventory");
const auth = require("../netlify/functions/lib/agent-marketing-source-authority-lib");

// A hook led by an external housing statistic: it pairs a figure with a market measure and names no specific development or action.
const STAT_WORDS = /\b(?:pending|sales|sold|closed|median|average|prices?|listings?|inventory|supply|days on market|dom|sale-to-list|list price|months? of|absorption|rates?|mortgage|cuts?|credits?)\b|%/i;
const DEVELOPMENT_WORDS = /\b(?:planned|plans?|approved|approves|approval|subdivision|lots?|apartments?|project|permits?|applications?|council|ordinance|agreement|zoning|rezone|proposed|builder|builders|construction|new homes?|development|annex|district|assessment|mello-?roos|ceqa|environmental)\b/i;
function statisticsLedHook(hook) {
  const h = String(hook || "");
  return /\d/.test(h) && STAT_WORDS.test(h) && !DEVELOPMENT_WORDS.test(h);
}
const STAT_SOURCE_CLASSES = new Set(["housing_research", "association_or_nonprofit", "brokerage_or_agent", "portal", "news_like", "unclassified"]);

function readJsonl(file) {
  try { return fs.readFileSync(file, "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l)); } catch { return []; }
}

/** One record per delivered opportunity, from a run's diagnostics (and, for v2, its delivered card). */
function opportunitiesOf(run) {
  const k = inv.keptOf(run);
  const cards = Array.isArray(run.cards) ? run.cards : null;
  return k.topics.map((t, i) => {
    const card = cards && cards[i] ? cards[i] : null;
    const srcs = (card ? card.sources : t.sources).map((s) => ({ host: s.host, url: s.url, kind: s.kind || null, role: s.role || null, window: s.window || null }));
    const classes = srcs.map((s) => inv.classify(s.host));
    const officialSource = srcs.some((s) => auth.isOfficial(auth.publisherAuthority(s.host)));
    const hook = card ? card.question : t.hook;
    const depth = t.depth || {};
    return {
      market: run.market, cell: run.cell, repeat: run.repeat, hook, development: card ? card.development : null,
      relationship: card ? card.relationship : (depth.scope === "broader_context" ? "broader_context" : "exact_market"),   // v1: the model's label, unchecked
      geographySupported: card && card.geographyCheck ? card.geographyCheck.supported : card && card.geography ? card.geography.nameFoundInSource : null,
      sources: srcs, officialSource, brokerageOnly: srcs.length > 0 && classes.every((c) => c === "brokerage_or_agent"),
      brokerageAny: classes.includes("brokerage_or_agent"), localNewsOrGov: classes.some((c) => c === "news_like" || c === "government") || officialSource,
      statisticsLedHook: statisticsLedHook(hook),
      statisticsOnlySources: srcs.length > 0 && classes.every((c) => STAT_SOURCE_CLASSES.has(c)) && !officialSource,
      needsReview: card && card.review ? !!card.review.needsReview : null,
    };
  });
}

function summarize(runs, runRows, label) {
  const opps = runs.flatMap(opportunitiesOf);
  const n = opps.length || 1;
  const pct = (x) => Math.round((x / n) * 1000) / 10;
  const byRun = {};
  opps.forEach((o) => { const k = `${o.market}|${o.cell}|${o.repeat}`; (byRun[k] = byRun[k] || []).push(o); });
  const div = Object.values(byRun).map((list) => new Set(list.map((o) => o.development ? o.development.toLowerCase().replace(/[^a-z0-9]+/g, " ").trim() : (o.sources[0] && o.sources[0].url))).size);
  const mean = (a) => (a.length ? Math.round((a.reduce((s, x) => s + x, 0) / a.length) * 100) / 100 : null);
  const cost = runRows.reduce((s, r) => s + (r.cost_usd || 0), 0);
  const sourceUses = opps.reduce((s, o) => s + o.sources.length, 0);
  return {
    label, runs: runs.length, opportunities: opps.length,
    total_cost_usd: Math.round(cost * 1e4) / 1e4, mean_cost_per_run_usd: runRows.length ? Math.round((cost / runRows.length) * 1e4) / 1e4 : null,
    cost_per_opportunity_usd: opps.length ? Math.round((cost / opps.length) * 1e4) / 1e4 : null,
    mean_distinct_developments_per_run: mean(div),
    share_with_official_source_pct: pct(opps.filter((o) => o.officialSource).length),
    share_with_local_news_or_government_pct: pct(opps.filter((o) => o.localNewsOrGov).length),
    share_exact_or_same_jurisdiction_pct: pct(opps.filter((o) => o.relationship === "exact_market" || o.relationship === "market" || o.relationship === "same_jurisdiction").length),
    share_exact_or_same_supported_by_sources_pct: opps.some((o) => o.geographySupported !== null) ? pct(opps.filter((o) => (o.relationship === "exact_market" || o.relationship === "market" || o.relationship === "same_jurisdiction") && o.geographySupported === true).length) : null,
    share_statistics_led_hook_pct: pct(opps.filter((o) => o.statisticsLedHook).length),
    share_statistics_only_sources_pct: pct(opps.filter((o) => o.statisticsOnlySources).length),
    share_brokerage_or_agent_only_pct: pct(opps.filter((o) => o.brokerageOnly).length),
    share_any_brokerage_or_agent_source_pct: pct(opps.filter((o) => o.brokerageAny).length),
    source_uses: sourceUses, official_source_uses_pct: sourceUses ? Math.round((opps.reduce((s, o) => s + o.sources.filter((x) => auth.isOfficial(auth.publisherAuthority(x.host))).length, 0) / sourceUses) * 1000) / 10 : null,
    share_flagged_for_review_pct: opps.some((o) => o.needsReview !== null) ? pct(opps.filter((o) => o.needsReview === true).length) : null,
  };
}

/** Counts of dropped sources and left-out topics by stage and code, from the attempt the topics came from AND every other attempt. */
function rejections(runs) {
  const src = {}, top = {};
  runs.forEach((r) => r.d.attempts.forEach((a) => {
    (a.sources || []).filter((s) => s.outcome === "dropped").forEach((s) => { const k = `${s.stage}/${s.code}`; src[k] = (src[k] || 0) + 1; });
    (a.topics || []).filter((t) => t.outcome === "left_out").forEach((t) => { const k = `${t.stage}/${t.code}`; top[k] = (top[k] || 0) + 1; });
  }));
  return { dropped_sources: src, left_out_topics: top };
}

function load(dir, cells) {
  const runs = inv.readRuns(dir).filter((r) => !cells || cells.includes(r.cell));
  const rows = readJsonl(path.join(dir, "runs.jsonl")).filter((r) => !cells || cells.includes(r.cell));
  return { runs, rows };
}

function build(v1dir, v2dir, v1cells, v2cells) {
  const a = load(v1dir, v1cells), b = load(v2dir, v2cells);
  const markets = [...new Set([...a.runs, ...b.runs].map((r) => r.market))];
  const out = { v1: summarize(a.runs, a.rows, "v1"), v2: summarize(b.runs, b.rows, "v2"), by_market: {}, by_cell: {}, rejections: { v1: rejections(a.runs), v2: rejections(b.runs) } };
  markets.forEach((m) => { out.by_market[m] = { v1: summarize(a.runs.filter((r) => r.market === m), a.rows.filter((r) => r.market === m), "v1"), v2: summarize(b.runs.filter((r) => r.market === m), b.rows.filter((r) => r.market === m), "v2") }; });
  [...new Set(b.runs.map((r) => r.cell))].forEach((c) => { out.by_cell[c] = summarize(b.runs.filter((r) => r.cell === c), b.rows.filter((r) => r.cell === c), c); });
  [...new Set(a.runs.map((r) => r.cell))].forEach((c) => { out.by_cell[c] = summarize(a.runs.filter((r) => r.cell === c), a.rows.filter((r) => r.cell === c), c); });
  return { out, a, b };
}

const ROWS = [
  ["Runs", "runs"], ["Opportunities delivered", "opportunities"], ["Total provider cost ($)", "total_cost_usd"], ["Mean cost per run ($)", "mean_cost_per_run_usd"], ["Cost per opportunity ($)", "cost_per_opportunity_usd"],
  ["Distinct developments per run (v1: distinct articles)", "mean_distinct_developments_per_run"],
  ["Opportunities with an official (government or official financing) source, %", "share_with_official_source_pct"],
  ["Opportunities with a local news or government source, %", "share_with_local_news_or_government_pct"],
  ["Exact market or same jurisdiction (the model's label), %", "share_exact_or_same_jurisdiction_pct"],
  ["...of which a source names the market (v2 only), %", "share_exact_or_same_supported_by_sources_pct"],
  ["Hook led by an external housing statistic, %", "share_statistics_led_hook_pct"],
  ["Sources are only statistics, brokerage or portal material, %", "share_statistics_only_sources_pct"],
  ["Rest only on brokerage or agent sources, %", "share_brokerage_or_agent_only_pct"],
  ["Any brokerage or agent source, %", "share_any_brokerage_or_agent_source_pct"],
  ["Official publishers' share of all source uses, %", "official_source_uses_pct"],
  ["Flagged for review (v2 only), %", "share_flagged_for_review_pct"],
];

function markdown(res, a, b, cells) {
  const { out } = res;
  const L = [];
  const f = (x) => (x == null ? "n/a" : x);
  L.push("# Article-Led v2 benchmark review", "", `v1 reference: ${a.runs.length} runs (${[...new Set(a.runs.map((r) => r.cell))].join(", ")}). v2: ${b.runs.length} runs (${[...new Set(b.runs.map((r) => r.cell))].join(", ")}). Markets: ${Object.keys(out.by_market).join(", ")}.`, "",
    `**Measured provider cost of the v2 runs: $${out.v2.total_cost_usd}** (${b.rows.some((r) => r.cost_estimated) ? "some estimated from tokens" : "all reported by the provider"}). v1 reference runs: $${out.v1.total_cost_usd}.`, "",
    "All measures below are structural proxies from sanitized diagnostics, with the heuristics noted in `scripts/research-benchmark-report.js`. A hook is \"statistics-led\" when it pairs a figure with a market measure and names no development or action. v1 relationship labels are the model's own and were never checked; v2 labels are checked against the sources (second row of that pair).", "",
    "## v1 against v2 (all markets)", "", "| Measure | v1 | v2 |", "| --- | --- | --- |");
  ROWS.forEach(([name, k]) => L.push(`| ${name} | ${f(out.v1[k])} | ${f(out.v2[k])} |`));
  L.push("", "## By market", "");
  Object.entries(out.by_market).forEach(([m, x]) => {
    L.push(`### ${m}`, "", "| Measure | v1 | v2 |", "| --- | --- | --- |");
    ROWS.forEach(([name, k]) => L.push(`| ${name} | ${f(x.v1[k])} | ${f(x.v2[k])} |`));
    L.push("");
  });
  L.push("## By configuration (measured cost and structure)", "", "| Cell | Runs | Opportunities | Total $ | Mean $/run | $/opportunity | Distinct developments/run | Official source, % | Statistics-led hook, % |", "| --- | --- | --- | --- | --- | --- | --- | --- | --- |");
  Object.entries(out.by_cell).forEach(([c, x]) => L.push(`| ${c} | ${x.runs} | ${x.opportunities} | ${x.total_cost_usd} | ${f(x.mean_cost_per_run_usd)} | ${f(x.cost_per_opportunity_usd)} | ${f(x.mean_distinct_developments_per_run)} | ${f(x.share_with_official_source_pct)} | ${f(x.share_statistics_led_hook_pct)} |`));
  const tbl = (title, o) => { L.push("", `## ${title}`, "", "| Stage / code | Count |", "| --- | --- |"); const e = Object.entries(o).sort((x, y) => y[1] - x[1]); if (!e.length) L.push("| none | 0 |"); e.forEach(([k, n]) => L.push(`| ${k} | ${n} |`)); };
  tbl("v2 rejected sources (every attempt)", out.rejections.v2.dropped_sources); tbl("v2 topics left out (every attempt)", out.rejections.v2.left_out_topics);
  tbl("v1 rejected sources (every attempt)", out.rejections.v1.dropped_sources); tbl("v1 topics left out (every attempt)", out.rejections.v1.left_out_topics);
  L.push("", "## Source inventory (v2)", "");
  const iv = inv.inventory(b.runs);
  L.push(`Kept source uses: ${iv.source_uses}; unique publishers: ${iv.unique_publishers}; repeat uses: ${iv.duplicate_uses}.`, "", "| Host | Class | Uses | Runs | Markets |", "| --- | --- | --- | --- | --- |");
  iv.hosts.forEach((h) => L.push(`| ${h.host} | ${h.class} | ${h.uses} | ${h.runs} | ${h.markets.join(", ")} |`));
  L.push("", "## The actual v2 opportunities, with their evidence (review sample)", "");
  const sample = inv.sample(b.runs, cells || [...new Set(b.runs.map((r) => r.cell))], 1);
  L.push(inv.markdown({ runs: 0, source_uses: 0, unique_publishers: 0, duplicate_uses: 0, class_uses: {}, markets: [], hosts: [] }, sample).split("## Review sample")[1] || "");
  return L.join("\n") + "\n";
}

function parseArgs(argv) {
  const a = { v1: null, v2: null, out: null, json: null, v1Cells: ["r10_c6000", "r20_c6000"], v2Cells: null, sampleCells: null };
  for (let i = 0; i < argv.length; i++) {
    const k = argv[i], list = () => String(argv[++i] || "").split(",").map((x) => x.trim()).filter(Boolean);
    if (k === "--v1") a.v1 = argv[++i]; else if (k === "--v2") a.v2 = argv[++i]; else if (k === "--out") a.out = argv[++i]; else if (k === "--json") a.json = argv[++i];
    else if (k === "--v1-cells") a.v1Cells = list(); else if (k === "--v2-cells") a.v2Cells = list(); else if (k === "--sample-cells") a.sampleCells = list();
  }
  if (!a.v1 || !a.v2) throw new Error("Give --v1 <folder> and --v2 <folder>.");
  return a;
}

function main() {
  const a = parseArgs(process.argv.slice(2));
  const res = build(a.v1, a.v2, a.v1Cells, a.v2Cells);
  if (!res.b.runs.length) throw new Error(`No v2 runs found in ${a.v2}.`);
  const md = inv.redact(markdown(res, res.a, res.b, a.sampleCells));
  if (a.out) fs.writeFileSync(a.out, md); else process.stdout.write(md);
  if (a.json) fs.writeFileSync(a.json, inv.redact(JSON.stringify(res.out, null, 1)));
}

module.exports = { statisticsLedHook, opportunitiesOf, summarize, rejections, build, markdown, parseArgs, ROWS };
if (require.main === module) { try { main(); } catch (e) { console.error(inv.redact(e.message)); process.exit(1); } }
