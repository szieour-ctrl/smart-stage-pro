#!/usr/bin/env node
// scripts/research-gapfill-report.js: the gap-fill diagnostic benchmark report (PR 2, Oct 31, 2026).
//
//   node scripts/research-gapfill-report.js --in <folder> [--cell lanes2gap_r20_c6000_o4500] --out review.md [--json review.json]
//
// <folder> is research-baseline.js output for the two-lane + gap-fill cell (runs.jsonl, *.discovery.json, *.cards.json, *.gapfill.json).
// It compares the two-lane result BEFORE and AFTER the gap-fill pass and applies the approved stop criteria. Structural measures only; every candidate is a provisional
// discovery lead. "Useful addition" here is the DETERMINISTIC part of the approved definition (qualified, a unique identity against every existing candidate, timely,
// substantiated, a market, district or ZIP relationship with a found name); the "not a variation of an existing story" judgement is a human review of the listed cards.
"use strict";
const fs = require("fs");
const path = require("path");

const readJsonl = (f) => { try { return fs.readFileSync(f, "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l)); } catch { return []; } };
const readJson = (f) => { try { return JSON.parse(fs.readFileSync(f, "utf8")); } catch { return null; } };
const sum = (a) => a.reduce((s, x) => s + (x || 0), 0);
const f = (x, d = 4) => (x == null ? "n/a" : Number(x).toFixed(d));
const OFFICIAL = new Set(["government_record", "official_financing"]);

function load(dir, cell) {
  return readJsonl(path.join(dir, "runs.jsonl")).filter((r) => r.cell === cell).map((r) => {
    const base = `${r.market}-${r.cell}-${r.repeat}`;
    const d = readJson(path.join(dir, `${base}.discovery.json`)) || {};
    return { ...r, gf: readJson(path.join(dir, `${base}.gapfill.json`)), cards: readJson(path.join(dir, `${base}.cards.json`)) || [], lanes: d.lanes || [], topicsLog: ((d.attempts || [])[0] || {}).topics || [] };
  });
}

/** Deterministic part of "useful addition", with the reasons it fails. */
function judgeNew(c) {
  const srcs = c.sources || [];
  const official = srcs.some((s) => s.role === "primary" && s.authority && s.authority.official);
  const local = srcs.some((s) => s.outletClass === "original_local_reporting");
  const publishers = new Set(srcs.map((s) => s.host)).size;
  const substantiated = official || local || publishers >= 2;
  const geo = c.geography || {};
  const geographic = ["market", "district", "zip"].includes(geo.relationship) && geo.nameFoundInSource === true;
  const reasons = [];
  if (!substantiated) reasons.push("not substantiated (no official primary source, original local reporting or two independent publishers)");
  if (!geographic) reasons.push("geography: not a market, district or ZIP relationship with a found name");
  return { useful: substantiated && geographic, official, local, publishers, substantiated, geographic, reasons };
}

function build(dir, cell) {
  const runs = load(dir, cell);
  const rows = runs.map((r) => {
    const gf = r.gf;
    const afterN = r.delivered || 0;
    const beforeN = gf && gf.before ? gf.before.selected : afterN;
    const fired = !!(gf && gf.triggered), executed = !!(gf && gf.executed);
    const news = gf && gf.newCandidates ? gf.newCandidates : [];
    const gapReq = gf && gf.request ? gf.request : null;
    return { market: r.market, repeat: r.repeat, qualifiedBefore: gf ? gf.qualifiedBefore : null, fired, executed, state: gf ? (gf.state || (fired ? null : "not_triggered")) : "gapfill_off", reason: gf ? gf.reason : null,
      returned: gapReq ? gapReq.returned : null, duplicates: gf && gf.summary ? gf.summary.duplicates : 0, newKept: news.length, newCards: news, beforeN, afterN,
      converted: !!(gf && gf.convertedToFive), chargedBefore: beforeN >= 5, chargedAfter: afterN >= 5 && !!r.charged,
      providerRequests: r.provider_requests, retries: (r.lanes || []).reduce((n, l) => n + Math.max(0, (l.attempts || 0) - 1), 0), cost: r.cost_usd, gapCost: gapReq ? gapReq.cost_usd : null, gapReqState: gapReq ? gapReq.state : null,
      judged: news.map((c) => ({ id: c.candidateId, development: c.development, ...judgeNew(c) })), run: r };
  });
  const fired = rows.filter((x) => x.fired), exec = rows.filter((x) => x.executed);
  const judged = rows.flatMap((x) => x.judged);
  const useful = judged.filter((j) => j.useful);
  const gapCost = sum(rows.map((x) => x.gapCost));
  const laneCosts = rows.flatMap((x) => (x.run.lanes || []).filter((l) => l.lane !== "gapfill").map((l) => l.cost_usd)).filter((c) => c != null);
  const meanLaneCost = laneCosts.length ? sum(laneCosts) / laneCosts.length : null;
  const returnedTotal = sum(exec.map((x) => x.returned)), dupTotal = sum(exec.map((x) => x.duplicates));
  const out = {
    cell, sessions: rows.length, eligible_3_or_4: fired.length, executed: exec.length, not_executed: fired.length - exec.length,
    blocked_or_failed: fired.filter((x) => !x.executed).map((x) => ({ market: x.market, repeat: x.repeat, state: x.state, reason: x.reason })),
    gapfill_returned: returnedTotal, gapfill_duplicates: dupTotal, new_qualified_distinct: sum(rows.map((x) => x.newKept)), useful_additions_deterministic: useful.length,
    converted_to_five: rows.filter((x) => x.converted).length, five_before: rows.filter((x) => x.beforeN >= 5).length, five_after: rows.filter((x) => x.afterN >= 5).length,
    charged_before: rows.filter((x) => x.chargedBefore).length, charged_after: rows.filter((x) => x.afterN >= 5).length,
    reduced: rows.filter((x) => x.afterN < x.beforeN).length,
    total_provider_requests: sum(rows.map((x) => x.providerRequests)), total_retries: sum(rows.map((x) => x.retries)), total_cost_usd: Math.round(sum(rows.map((x) => x.cost)) * 1e5) / 1e5, gapfill_cost_usd: Math.round(gapCost * 1e5) / 1e5,
    cost_per_useful_addition_usd: useful.length ? gapCost / useful.length : null, mean_lane_request_cost_usd: meanLaneCost,
    stop: {
      useful_adds_per_fired_session: fired.length ? useful.length / fired.length : null,
      criterion_1_fewer_than_one_in_three: fired.length ? useful.length / fired.length < 1 / 3 : null,
      variation_share_proxy: returnedTotal ? dupTotal / returnedTotal : null,
      criterion_2_more_than_a_quarter_variations: returnedTotal ? dupTotal / returnedTotal > 0.25 : null,
      criterion_3_cost_per_add_above_a_lane_pass: useful.length && meanLaneCost != null ? gapCost / useful.length > meanLaneCost : null,
    },
  };
  return { rows, out, useful, judged };
}

function markdown(b, dir) {
  const { rows, out } = b;
  const o = [`# Gap-fill diagnostic benchmark: two lanes before and after`, "", `Cell ${out.cell}, ${out.sessions} sessions (${dir}). Municipal + Housing, sequential, with the diagnostic gap-fill pass (off by default in production). Every candidate is a provisional discovery lead, not publication-authorized.`, "",
    "## Summary", "", "| Measure | Value |", "| --- | --- |",
    `| Sessions | ${out.sessions} |`, `| Gap-fill eligible (exactly 3 or 4 distinct qualified developments) | ${out.eligible_3_or_4} |`, `| Gap-fill executed | ${out.executed} (not executed: ${out.not_executed}) |`,
    `| Candidates the pass returned / dropped as gapfill_duplicate | ${out.gapfill_returned} / ${out.gapfill_duplicates} |`, `| New qualified, truly distinct developments added | ${out.new_qualified_distinct} |`, `| Useful additions (deterministic gates) | ${out.useful_additions_deterministic} |`,
    `| Sessions converted from 3 or 4 to 5 | ${out.converted_to_five} |`, `| Sessions with five before / after | ${out.five_before} / ${out.five_after} |`, `| Five-opportunity billing eligible before / after (charged at the usual rule) | ${out.charged_before} / ${out.charged_after} |`,
    `| Results reduced by the pass | ${out.reduced} |`, `| Total provider requests / retries | ${out.total_provider_requests} / ${out.total_retries} |`, `| Total provider cost | $${f(out.total_cost_usd, 5)} |`, `| Gap-fill pass cost | $${f(out.gapfill_cost_usd, 5)} |`, `| Cost per useful addition | ${out.cost_per_useful_addition_usd == null ? "n/a (none)" : "$" + f(out.cost_per_useful_addition_usd)} |`, `| Mean cost of one lane request | $${f(out.mean_lane_request_cost_usd)} |`, "",
    "## Approved stop criteria", ""];
  const s = out.stop, tf = (v) => (v == null ? "not measurable (no fired sessions or no useful additions)" : v ? "**MET: stop**" : "not met");
  o.push(`1. Useful additions per fired session: ${s.useful_adds_per_fired_session == null ? "n/a" : s.useful_adds_per_fired_session.toFixed(2)} (stop if below 0.33): ${tf(s.criterion_1_fewer_than_one_in_three)}`,
    `2. Share of returned candidates that restate an existing story (automatic proxy: gapfill_duplicate, plus the human variation review below): ${s.variation_share_proxy == null ? "n/a" : (s.variation_share_proxy * 100).toFixed(0) + "%"} (stop if above 25%): ${tf(s.criterion_2_more_than_a_quarter_variations)}`,
    `3. Cost per useful addition against the cost of one lane pass: ${tf(s.criterion_3_cost_per_add_above_a_lane_pass)}`, "");
  o.push("## By session", "", "| Market | Run | Qualified before | Eligible | Executed | Returned | Duplicates | New kept | Before | After | Converted to 5 | Provider requests | Retries | Cost $ | Gap-fill $ |", "| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |");
  rows.forEach((x) => o.push(`| ${x.market} | ${x.repeat} | ${x.qualifiedBefore == null ? "n/a" : x.qualifiedBefore} | ${x.fired ? "yes" : "no"} | ${x.executed ? "yes" : x.fired ? `no (${x.state}${x.reason ? ": " + x.reason : ""})` : "no"} | ${x.returned == null ? "-" : x.returned} | ${x.duplicates || 0} | ${x.newKept} | ${x.beforeN} | ${x.afterN} | ${x.converted ? "yes" : "no"} | ${x.providerRequests == null ? "n/a" : x.providerRequests} | ${x.retries} | ${f(x.cost, 5)} | ${f(x.gapCost, 5)} |`));
  o.push("", "## Unchanged or reduced results and why", "");
  const none = rows.filter((x) => x.fired && x.newKept === 0);
  if (!none.length) o.push("Every fired session gained at least one development."); else none.forEach((x) => {
    const codes = {}; x.run.topicsLog.filter((t) => t.lane === "gapfill" && t.outcome === "left_out").forEach((t) => { codes[t.code] = (codes[t.code] || 0) + 1; });
    o.push(`- ${x.market} #${x.repeat}: unchanged at ${x.beforeN}. ${!x.executed ? `The pass did not run (${x.state}${x.reason ? ", " + x.reason : ""}).` : x.returned === 0 ? "The pass returned nothing new." : `The pass returned ${x.returned}; none was added (${Object.entries(codes).map(([k, n]) => `${k} ${n}`).join(", ") || "reasons not recorded"}).`}`);
  });
  o.push(`- Reduced by the pass: ${out.reduced} session(s) (must be 0: the pass only adds to the pool).`, "", "## New candidates added by the pass (provisional; judge each for 'variation of an existing story')", "");
  rows.forEach((x) => x.newCards.forEach((c, i) => { const j = x.judged[i]; o.push(`- ${x.market} #${x.repeat} ${c.candidateId}: ${c.development} | rel ${c.geography.relationship}, name found ${c.geography.nameFoundInSource}, ${c.strength}/${c.relevance} | official primary ${j.official}, local reporting ${j.local}, publishers ${j.publishers} | deterministic useful: ${j.useful ? "YES" : "no (" + j.reasons.join("; ") + ")"}`, ...c.sources.map((s) => `    - ${s.ref}: ${s.host} (${s.outletClass}; ${s.role}) "${s.title}" published ${s.published}`)); }));
  if (!rows.some((x) => x.newCards.length)) o.push("None.");
  o.push("", "## Before and after pools for every fired session, with source provenance", "");
  rows.filter((x) => x.fired && x.run.gf).forEach((x) => {
    const gf = x.run.gf;
    o.push(`### ${x.market} #${x.repeat}: ${gf.before.selected} before, ${gf.after.selected} after${x.converted ? " (converted to five)" : ""}`, "", "Exclusions passed in the prompt:", ...gf.exclusions.map((e, i) => `${i + 1}. ${e.development} | names ${e.projectNames.join(", ") || "-"} | ids ${e.identifiers.join(", ") || "-"} | ${e.sourceUrls.join(" ; ")}`), "", "Before:");
    const line = (c) => [`- ${c.candidateId} [${c.lane}] ${c.development} (${c.geography.relationship}, ${c.strength}/${c.relevance})`, ...c.sources.map((s) => `    - ${s.ref}: ${s.host} (${s.outletClass}; ${s.role}) "${s.title}" published ${s.published}`)];
    gf.before.candidates.forEach((c) => o.push(...line(c))); o.push("", "After:"); gf.after.candidates.forEach((c) => o.push(...line(c))); o.push("");
  });
  return o.join("\n") + "\n";
}

function parseArgs(argv) {
  const a = { cell: "lanes2gap_r20_c6000_o4500" };
  for (let i = 0; i < argv.length; i++) { const k = argv[i]; if (k === "--in") a.in = argv[++i]; else if (k === "--cell") a.cell = argv[++i]; else if (k === "--out") a.out = argv[++i]; else if (k === "--json") a.json = argv[++i]; }
  if (!a.in) throw new Error("Give --in <folder>.");
  return a;
}
function main() {
  const a = parseArgs(process.argv.slice(2));
  const b = build(a.in, a.cell);
  if (!b.rows.length) throw new Error(`No ${a.cell} runs found in ${a.in}.`);
  const md = markdown(b, a.in);
  if (a.out) fs.writeFileSync(a.out, md); else process.stdout.write(md);
  if (a.json) fs.writeFileSync(a.json, JSON.stringify(b.out, null, 1));
}
if (require.main === module) main();
module.exports = { build, markdown, parseArgs, judgeNew, load };
