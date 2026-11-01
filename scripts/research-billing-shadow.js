#!/usr/bin/env node
// scripts/research-billing-shadow.js: SHADOW evaluation of a proposed billing-quality floor (PR 2, Oct 31, 2026). It changes no billing, quota or entitlement.
//
//   node scripts/research-billing-shadow.js --in <folder> [--cell lanes2gap_r20_c6000_o4500] --out report.md [--json report.json]
//
// Current rule (unchanged): a session is billable when it delivers five DISTINCT qualified opportunities.
// Proposed additional requirement (evaluated here only): at least TWO of the five have source-supported DIRECT relevance to the selected audience and geography. Not all five
// need to be exact-market. A subdivision's direct relevance can arise from a broader city or nearby development only with a defensible, evidence-supported connection; being
// in the same municipality or county does not establish it, and Stage A cannot verify such a connection, so it stays provisional.
// The saved benchmark sessions are REPLAYED with the current identity and geography rules (the publisher-jurisdiction fix, the continuation rule), from saved records only.
//   Variant A (the proposed rule): relevance direct, relationship market, district or ZIP, and coverage evidence (a name in the title or address path) or the publisher's
//             official jurisdiction.
//   Variant B (strictest evidence): as A, but coverage evidence only (no credit for the publisher's domain).
//   Variant C (broader connection, provisional): as A, plus a direct city-level relationship with a name in the title or address path.
"use strict";
const fs = require("fs");
const path = require("path");
const gh = require("../netlify/functions/lib/agent-marketing-geography-hierarchy-lib");
const ident = require("../netlify/functions/lib/agent-marketing-development-identity-lib");

const MARKETS = JSON.parse(fs.readFileSync(path.join(__dirname, "..", "tests", "fixtures", "research-diag", "markets.json"), "utf8")); delete MARKETS._note;
const readJsonl = (f) => { try { return fs.readFileSync(f, "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l)); } catch { return []; } };
const readJson = (f) => { try { return JSON.parse(fs.readFileSync(f, "utf8")); } catch { return null; } };
const SELECTED_LEVELS = ["market", "district", "zip"];

/** One candidate from either record shape, normalized and re-evaluated with the current geography rules. */
function evaluate(c, hierarchy) {
  const rel = c.relationship || (c.geography && c.geography.relationship);
  const srcs = (c.sources || []).map((s) => ({ title: s.title, url: s.url, host: s.host || s.domain, role: s.role, official: !!(s.authority && s.authority.official), whatItEstablishes: s.whatItEstablishes, outletClass: s.outletClass }));
  const named = ["region", "state", "national"].includes(rel) ? null : srcs.map((s) => gh.nameEvidence(hierarchy, rel, { title: s.title, url: s.url })).find((e) => e.found) || null;
  const pj = srcs.map((s) => gh.publisherJurisdiction(s.host, hierarchy)).find(Boolean) || null;
  const support = named ? "name_in_source" : pj ? "publisher_jurisdiction_only" : ["region", "state", "national"].includes(rel) ? "not_checked" : "unsupported";
  const identity = ident.identityOf({ development: c.development, angle: c.angle, sources: srcs, hierarchyNames: hierarchy.levels.map((l) => l.name).concat(hierarchy.subareas || []) });
  const direct = c.relevance === "direct";
  const A = direct && SELECTED_LEVELS.includes(rel) && (support === "name_in_source" || support === "publisher_jurisdiction_only");
  const B = direct && SELECTED_LEVELS.includes(rel) && support === "name_in_source";
  const C = A || (direct && rel === "city" && support === "name_in_source");
  const why = [];
  if (!A) { if (!direct) why.push("indirect relevance"); if (direct && !SELECTED_LEVELS.includes(rel)) why.push(`${rel}-level relationship (context, not subdivision or market)`); if (direct && SELECTED_LEVELS.includes(rel) && support === "unsupported") why.push("no coverage or jurisdiction evidence"); }
  return { id: c.candidateId, lane: c.lane || null, development: c.development, relationship: rel, relevance: c.relevance, strength: c.strength, support, publisherJurisdiction: pj, identity, A, B, C, why, evidenceClass: A ? (support === "name_in_source" ? "name in title or path (boundary unverified)" : "publisher jurisdiction only (location unverified)") : null };
}
function distinctCount(items) {
  const parent = items.map((_, i) => i); const find = (i) => (parent[i] === i ? i : (parent[i] = find(parent[i])));
  for (let i = 0; i < items.length; i++) for (let j = i + 1; j < items.length; j++) if (ident.sameIdentity(items[i].identity, items[j].identity)) parent[find(j)] = find(i);
  return new Set(items.map((_, i) => find(i))).size;
}

function load(dir, cell) {
  return readJsonl(path.join(dir, "runs.jsonl")).filter((r) => r.cell === cell).map((r) => {
    const base = `${r.market}-${r.cell}-${r.repeat}`;
    const gf = readJson(path.join(dir, `${base}.gapfill.json`));
    const cards = readJson(path.join(dir, `${base}.cards.json`)) || [];
    const hierarchy = gh.hierarchyFor(MARKETS[r.market] || {});
    const after = cards.map((c) => evaluate(c, hierarchy));
    const before = gf && gf.before && gf.before.candidates ? gf.before.candidates.map((c) => evaluate(c, hierarchy)) : after;   // no gap-fill pass: nothing was added
    return { market: r.market, repeat: r.repeat, before, after, gapFilled: !!(gf && gf.executed) };
  });
}
function judge(pool) {
  const distinct = distinctCount(pool);
  const five = pool.length >= 5 && distinct >= 5;
  const n = (k) => pool.filter((c) => c[k]).length;
  const reasons = {}; pool.filter((c) => !c.A).forEach((c) => c.why.forEach((w) => { reasons[w] = (reasons[w] || 0) + 1; }));
  return { size: pool.length, distinct, five, A: n("A"), B: n("B"), C: n("C"), floorA: n("A") >= 2, floorB: n("B") >= 2, floorC: n("C") >= 2, reasons, counted: pool.filter((c) => c.A).map((c) => ({ id: c.id, development: c.development, evidence: c.evidenceClass })) };
}

function build(dir, cell) {
  const sessions = load(dir, cell).map((s) => ({ market: s.market, repeat: s.repeat, gapFilled: s.gapFilled, without: judge(s.before), withGap: judge(s.after), pools: s }));
  const markets = [...new Set(sessions.map((s) => s.market))];
  const agg = (key) => {
    const row = (list) => { const five = list.filter((s) => s[key].five); return { sessions: list.length, five_distinct: five.length, floor_A: five.filter((s) => s[key].floorA).length, floor_B: five.filter((s) => s[key].floorB).length, floor_C: five.filter((s) => s[key].floorC).length, billable_current: five.length, billable_shadow_A: five.filter((s) => s[key].floorA).length }; };
    return { all: row(sessions), by_market: Object.fromEntries(markets.map((m) => [m, row(sessions.filter((s) => s.market === m))])) };
  };
  return { sessions, markets, out: { cell, sessions: sessions.length, without_gapfill: agg("without"), with_gapfill: agg("withGap") } };
}

function markdown(b, dir) {
  const { sessions, markets, out } = b;
  const o = ["# Shadow billing evaluation: a direct-relevance floor", "", `Cell ${out.cell}, ${out.sessions} saved sessions (${dir}), replayed with the current identity and geography rules. **Shadow only: no billing, quota or entitlement changes.** All geography below is provisional: no project boundary or location was verified for any candidate.`, "",
    "Current rule (unchanged): five DISTINCT qualified opportunities. Proposed additional floor: at least two of the five directly relevant with source-supported geography. Variant A is the proposed rule (direct relevance, a market, district or ZIP relationship, coverage evidence in the title or address path OR the publisher's official jurisdiction). Variant B accepts coverage evidence only. Variant C also accepts a direct city-level relationship with a name in the title or path (a provisional broader connection that Stage A cannot verify).", ""];
  const table = (label, a) => {
    o.push(`## ${label}`, "", "| Market | Sessions | Five distinct (billable now) | Floor A met | Floor B met | Floor C met | Billable under the shadow floor (A) |", "| --- | --- | --- | --- | --- | --- | --- |");
    markets.forEach((m) => { const r = a.by_market[m]; o.push(`| ${m} | ${r.sessions} | ${r.five_distinct} | ${r.floor_A} | ${r.floor_B} | ${r.floor_C} | ${r.billable_shadow_A} |`); });
    const r = a.all; o.push(`| **all** | ${r.sessions} | ${r.five_distinct} | ${r.floor_A} | ${r.floor_B} | ${r.floor_C} | ${r.billable_shadow_A} |`, "");
  };
  table("Retained architecture: Municipal + Housing, no gap-fill", out.without_gapfill);
  table("Reference: as benchmarked, with the (stopped) gap-fill pass", out.with_gapfill);
  o.push("## By session (retained architecture)", "", "| Market | Run | Pool | Distinct | Five distinct | Directly relevant (A / B / C) | Floor A | Why candidates do not count |", "| --- | --- | --- | --- | --- | --- | --- | --- |");
  sessions.forEach((s) => { const j = s.without; o.push(`| ${s.market} | ${s.repeat} | ${j.size} | ${j.distinct} | ${j.five ? "yes" : "no"} | ${j.A} / ${j.B} / ${j.C} | ${j.five ? (j.floorA ? "met" : "**FAILS**") : "n/a (fewer than five)"} | ${Object.entries(j.reasons).map(([k, n]) => `${n} ${k}`).join("; ") || "-"} |`); });
  o.push("", "## Why sessions with five distinct developments fail the floor", "");
  const fails = sessions.filter((s) => s.without.five && !s.without.floorA);
  if (!fails.length) o.push("None."); else fails.forEach((s) => o.push(`- ${s.market} #${s.repeat}: ${s.without.A} of 5 directly relevant. Not counted: ${Object.entries(s.without.reasons).map(([k, n]) => `${n} ${k}`).join("; ")}.`));
  o.push("", "## Which decisions rest on provisional source geography rather than verified project location", "", "No candidate has a verified project location (`boundaryVerified` is false everywhere), so every floor decision is provisional. The evidence behind each counted candidate differs, and a result can change if a weaker class of evidence is discounted:", "");
  sessions.filter((s) => s.without.five).forEach((s) => {
    const j = s.without, pubOnly = j.counted.filter((c) => /publisher jurisdiction only/.test(c.evidence)).length;
    o.push(`- ${s.market} #${s.repeat}: floor A ${j.floorA ? "met" : "not met"} (${j.A} counted); floor B (coverage evidence only) ${j.floorB ? "met" : "not met"}${j.floorA && !j.floorB ? ` **: the result depends on publisher-jurisdiction-only evidence (${pubOnly} candidate(s))**` : ""}; floor C (adding direct city-level connections) ${j.floorC ? "met" : "not met"}${!j.floorA && j.floorC ? " **: it would pass only by accepting an unverified city-level connection**" : ""}.`, ...j.counted.map((c) => `    - counted: ${c.development.slice(0, 90)}: ${c.evidence}`));
  });
  if (!sessions.some((s) => s.without.five)) o.push("No session reached five distinct developments in this replay.");
  return o.join("\n") + "\n";
}

function parseArgs(argv) {
  const a = { cell: "lanes2gap_r20_c6000_o4500" };
  for (let i = 0; i < argv.length; i++) { const k = argv[i]; if (k === "--in") a.in = argv[++i]; else if (k === "--cell") a.cell = argv[++i]; else if (k === "--out") a.out = argv[++i]; else if (k === "--json") a.json = argv[++i]; }
  if (!a.in) throw new Error("Give --in <folder>.");
  return a;
}
function main() {
  const a = parseArgs(process.argv.slice(2)); const b = build(a.in, a.cell);
  if (!b.sessions.length) throw new Error(`No ${a.cell} runs found in ${a.in}.`);
  const md = markdown(b, a.in);
  if (a.out) fs.writeFileSync(a.out, md); else process.stdout.write(md);
  if (a.json) fs.writeFileSync(a.json, JSON.stringify(b.out, null, 1));
}
if (require.main === module) main();
module.exports = { evaluate, judge, distinctCount, build, markdown, parseArgs, load };
