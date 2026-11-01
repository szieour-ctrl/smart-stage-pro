#!/usr/bin/env node
// scripts/research-lanes-report.js — single-pass versus three-lane review package (PR 2 experiment, Oct 31, 2026).
//
//   node scripts/research-lanes-report.js --single <folder> --lanes <folder> [--single-cell compact_r20_c6000_o4500] [--lanes-cell lanes3_r20_c6000_o4500] --out review.md [--json review.json]
//
// Both folders are research-baseline.js output (runs.jsonl, *.cards.json, *.discovery.json). The report states measured provider cost, candidate yield, qualified yield,
// five-opportunity yield, duplicates, excluded candidates with their reasons, and the actual cards with source provenance, by market. It reads sanitized diagnostics
// and delivered cards only (no article text, no credentials). Structure counts are proxies; the cards are for a human to judge.
"use strict";
const fs = require("fs");
const path = require("path");

const readJsonl = (f) => { try { return fs.readFileSync(f, "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l)); } catch { return []; } };
const readJson = (f) => { try { return JSON.parse(fs.readFileSync(f, "utf8")); } catch { return null; } };
const mean = (a) => { const v = a.filter((x) => x != null && Number.isFinite(x)); return v.length ? v.reduce((s, x) => s + x, 0) / v.length : null; };
const f = (x, d = 2) => (x == null ? "n/a" : Number(x).toFixed(d));
const sum = (a) => a.reduce((s, x) => s + (x || 0), 0);

function load(dir, cell) {
  return readJsonl(path.join(dir, "runs.jsonl")).filter((r) => r.cell === cell).map((r) => {
    const base = `${r.market}-${r.cell}-${r.repeat}`;
    const d = readJson(path.join(dir, `${base}.discovery.json`)) || {};
    const a = (d.attempts || [])[0] || {};
    return { ...r, cards: readJson(path.join(dir, `${base}.cards.json`)) || [], topicsLog: a.topics || [], lanes: d.lanes || null };
  });
}

function stats(runs) {
  const v = (r) => r.v2 || {};
  const delivered = runs.map((r) => r.delivered || 0);
  return {
    runs: runs.length, ready: runs.filter((r) => r.status === "ready").length,
    mean_returned: mean(runs.map((r) => v(r).candidates_returned)), mean_qualified: mean(runs.map((r) => v(r).qualified)), mean_delivered: mean(delivered),
    runs_with_five: delivered.filter((n) => n >= 5).length, charged: runs.filter((r) => r.charged).length, mean_duplicates: mean(runs.map((r) => v(r).duplicates || 0)),
    total_cost_usd: Math.round(sum(runs.map((r) => r.cost_usd)) * 1e4) / 1e4, mean_cost_per_run_usd: mean(runs.map((r) => r.cost_usd)),
    cost_per_delivered_usd: sum(delivered) ? sum(runs.map((r) => r.cost_usd)) / sum(delivered) : null,
    cost_per_five_yield_usd: delivered.filter((n) => n >= 5).length ? sum(runs.map((r) => r.cost_usd)) / delivered.filter((n) => n >= 5).length : null,
    distinct_developments: mean(runs.map((r) => v(r).distinct_developments)), market_scope: mean(runs.map((r) => v(r).market_scope)),
    name_found: mean(runs.map((r) => v(r).name_found_in_source)), geography_unsupported: mean(runs.map((r) => v(r).geography_unsupported)),
    official_primary: mean(runs.map((r) => v(r).with_official_primary)), original_local: mean(runs.map((r) => v(r).with_original_local_reporting)), trade_only_or_agg: mean(runs.map((r) => v(r).with_trade_aggregation)),
    strong_or_direct: mean(runs.map((r) => v(r).strong_or_direct)), needs_review: mean(runs.map((r) => v(r).needs_review)), unresolved: mean(runs.map((r) => v(r).status_unresolved)),
  };
}
const ROWS = [["Runs", "runs", 0], ["Runs ready", "ready", 0], ["Candidates returned (mean/run)", "mean_returned", 1], ["Qualified, after duplicates (mean/run)", "mean_qualified", 1], ["Delivered (mean/run)", "mean_delivered", 1],
  ["Runs delivering five (charged)", "runs_with_five", 0], ["Duplicates collapsed (mean/run)", "mean_duplicates", 1], ["Distinct developments (mean/run)", "distinct_developments", 1],
  ["Market-scope candidates (mean/run)", "market_scope", 1], ["Market name found in a source (mean/run)", "name_found", 1], ["Geography unsupported, provisional (mean/run)", "geography_unsupported", 1],
  ["With an official primary source (mean/run)", "official_primary", 1], ["With original local reporting (mean/run)", "original_local", 1], ["Strong or directly relevant (mean/run)", "strong_or_direct", 1],
  ["Needs review (mean/run)", "needs_review", 1], ["Status unresolved (mean/run)", "unresolved", 1], ["Provider cost, total $", "total_cost_usd", 4], ["Provider cost per run $", "mean_cost_per_run_usd", 4],
  ["Cost per delivered opportunity $", "cost_per_delivered_usd", 4], ["Cost per five-opportunity session $", "cost_per_five_yield_usd", 4]];

function laneTable(runs) {
  const by = {};
  runs.forEach((r) => (r.lanes || []).forEach((l) => { const x = by[l.lane] = by[l.lane] || { runs: 0, returned: 0, cost: 0, completion: 0, errors: 0, selected: 0, duplicates: 0 }; x.runs++; x.returned += l.returned || 0; x.cost += l.cost_usd || 0; x.completion += l.completion_tokens || 0; x.errors += l.error ? 1 : 0; }));
  runs.forEach((r) => Object.entries((r.v2 || {}).by_lane || {}).forEach(([lane, s]) => { if (by[lane]) { by[lane].selected += s.selected || 0; by[lane].duplicates += s.duplicates || 0; } }));
  return by;
}

function cardLines(c) {
  const g = c.geography || {}, st = c.status || {};
  const out = [`${c.n}. **${c.question}** (${c.relationship}${c.route ? `; route: ${c.route}` : ""}${c.lane ? `; lane ${c.lane}` : ""}; strength ${c.strength}, relevance ${c.relevance}; status ${st.value}${st.conflict ? " (CONFLICT)" : ""}; id ${c.candidateId})`,
    `   - ${c.development} / ${c.angle}`,
    `   - Geography: ${g.nameFoundInSource === true ? `name found in ${g.nameEvidence && g.nameEvidence.where}${g.nameEvidence && g.nameEvidence.via && g.nameEvidence.via !== "level" ? ` (via ${g.nameEvidence.via}; ${(g.nameEvidence.names || []).join(", ")})` : ""}, boundary NOT verified` : g.nameFoundInSource === false ? "UNSUPPORTED name (provisional, no ranking weight)" : "wider level, route stated"}`,
    `   - Event: ${c.event ? `${c.event.kind} ${c.event.date || ""} (${c.event.presentedAs || c.event.status}${c.event.postEvent ? `; post-event source s${c.event.postEvent.sourceN}, basis ${c.event.postEvent.basis}` : ""})` : "none"}${c.review && c.review.needsReview ? `; NEEDS REVIEW: ${c.review.reasons.join("; ")}` : ""}`];
  if (c.alsoFoundIn && c.alsoFoundIn.length) out.push(`   - Also found (duplicates collapsed): ${c.alsoFoundIn.map((d) => `${d.lane || "single"} "${d.hook}" [${d.reason}]`).join(" | ")}`);
  (c.sources || []).forEach((s) => out.push(`   - Source ${s.ref}: ${s.host} (${s.outletClass}; ${s.role}, ${s.kind}), "${s.title}", published ${s.published}, ${s.window}; about ${s.sourceGeography || "n/a"}; establishes: ${s.whatItEstablishes || "n/a"}`));
  return out;
}

function build(singleDir, lanesDir, singleCell, lanesCell) {
  const S = load(singleDir, singleCell), L = load(lanesDir, lanesCell);
  const markets = [...new Set([...S, ...L].map((r) => r.market))];
  const out = { single: { cell: singleCell, ...stats(S) }, lanes: { cell: lanesCell, ...stats(L) }, by_market: {}, lane_table: laneTable(L) };
  markets.forEach((m) => { out.by_market[m] = { single: stats(S.filter((r) => r.market === m)), lanes: stats(L.filter((r) => r.market === m)) }; });
  return { S, L, markets, out };
}

function markdown(b, singleDir, lanesDir) {
  const { S, L, markets, out } = b;
  const o = [`# Single pass versus three lanes: review package`, "",
    `Single pass: ${out.single.cell}, ${S.length} runs (${singleDir}). Three lanes: ${out.lanes.cell}, ${L.length} runs (${lanesDir}). Markets: ${markets.join(", ")}.`, "",
    ...(() => { const bad = Object.values(out.lane_table).reduce((n, x) => n + x.errors, 0), total = Object.values(out.lane_table).reduce((n, x) => n + x.runs, 0); return bad ? [`**NOT A VALID THREE-LANE TEST: ${bad} of ${total} lane requests failed (see the lane table).** Do not read the comparison below as a result for the lanes.`, ""] : [`All ${total} lane requests completed.`, ""]; })(),
    "**Status of everything below: discovery candidates.** Provider-grounded and model-reported; none is checked against article text, records or project facts, and none is publication-authorized. The measures are structural proxies; the cards at the end are for human judgment. The three-lane architecture is an experiment and is not adopted.", "",
    "## Overall", "", "| Measure | Single pass | Three lanes |", "| --- | --- | --- |"];
  ROWS.forEach(([n, k, d]) => o.push(`| ${n} | ${f(out.single[k], d)} | ${f(out.lanes[k], d)} |`));
  o.push("", "## By market", "");
  markets.forEach((m) => { const x = out.by_market[m]; o.push(`### ${m}`, "", "| Measure | Single pass | Three lanes |", "| --- | --- | --- |"); ROWS.filter(([, k]) => ["runs", "mean_returned", "mean_qualified", "mean_delivered", "runs_with_five", "mean_duplicates", "market_scope", "official_primary", "original_local", "needs_review", "mean_cost_per_run_usd", "cost_per_delivered_usd"].includes(k)).forEach(([n, k, d]) => o.push(`| ${n} | ${f(x.single[k], d)} | ${f(x.lanes[k], d)} |`)); o.push(""); });
  o.push("## The three lanes (actual cost and yield)", "", "| Lane | Runs | Candidates returned | Selected in the final five | Duplicates collapsed | Provider cost $ | Mean cost/run $ | Lane errors |", "| --- | --- | --- | --- | --- | --- | --- | --- |");
  Object.entries(out.lane_table).forEach(([lane, x]) => o.push(`| ${lane} | ${x.runs} | ${x.returned} | ${x.selected} | ${x.duplicates} | ${f(x.cost, 4)} | ${f(x.runs ? x.cost / x.runs : null, 4)} | ${x.errors} |`));
  o.push("", "## Duplicate developments collapsed (three lanes)", "");
  const dups = L.flatMap((r) => r.topicsLog.filter((t) => /^duplicate_|^overlaps_/.test(t.code || "")).map((t) => ({ r, t })));
  if (!dups.length) o.push("None."); else dups.forEach(({ r, t }) => o.push(`- ${r.market} #${r.repeat}: "${t.hook}" (lane ${t.lane || "n/a"}) dropped as ${t.code}: ${t.detail}`));
  o.push("", "## Excluded candidates and qualification reasons", "", "Every candidate that was not delivered, with the reason code, for both designs.", "");
  [["Single pass", S], ["Three lanes", L]].forEach(([label, runs]) => {
    o.push(`### ${label}`, "");
    const tally = {}; runs.forEach((r) => r.topicsLog.filter((t) => t.outcome === "left_out").forEach((t) => { tally[t.code] = (tally[t.code] || 0) + 1; }));
    o.push(`Reasons: ${Object.entries(tally).map(([k, n]) => `${k} ${n}`).join(", ") || "none"}`, "");
    runs.forEach((r) => r.topicsLog.filter((t) => t.outcome === "left_out").forEach((t) => o.push(`- ${r.market} #${r.repeat}${t.lane ? ` [${t.lane}]` : ""}: "${t.hook}": ${t.code}${t.detail ? ` (${t.detail})` : ""}`)));
    o.push("");
  });
  o.push("## The actual cards, with source provenance", "");
  markets.forEach((m) => { o.push(`### ${m}`, ""); [["Single pass", S], ["Three lanes", L]].forEach(([label, runs]) => runs.filter((r) => r.market === m).forEach((r) => {
    o.push(`#### ${label}, run ${r.repeat}: delivered ${r.delivered}${r.charged ? " (five, charged)" : " (uncharged partial)"}, cost $${r.cost_usd}`, "");
    if (!r.cards.length) o.push("(no cards)", ""); else { r.cards.forEach((c) => o.push(...cardLines(c))); o.push(""); }
  })); });
  return o.join("\n") + "\n";
}

function parseArgs(argv) {
  const a = { singleCell: "compact_r20_c6000_o4500", lanesCell: "lanes3_r20_c6000_o4500" };
  for (let i = 0; i < argv.length; i++) { const k = argv[i];
    if (k === "--single") a.single = argv[++i]; else if (k === "--lanes") a.lanes = argv[++i]; else if (k === "--single-cell") a.singleCell = argv[++i]; else if (k === "--lanes-cell") a.lanesCell = argv[++i];
    else if (k === "--out") a.out = argv[++i]; else if (k === "--json") a.json = argv[++i]; }
  if (!a.single || !a.lanes) throw new Error("Give --single <folder> and --lanes <folder>.");
  return a;
}
function main() {
  const a = parseArgs(process.argv.slice(2));
  const b = build(a.single, a.lanes, a.singleCell, a.lanesCell);
  if (!b.L.length) throw new Error(`No ${a.lanesCell} runs found in ${a.lanes}.`);
  const md = markdown(b, a.single, a.lanes);
  if (a.out) fs.writeFileSync(a.out, md); else process.stdout.write(md);
  if (a.json) fs.writeFileSync(a.json, JSON.stringify(b.out, null, 1));
}
if (require.main === module) main();
module.exports = { build, markdown, parseArgs, stats, load };
