#!/usr/bin/env node
"use strict";
// Source inventory and review sample for a research baseline folder (PR 2).
//
//   node scripts/research-baseline-inventory.js <folder-with-*.discovery.json> [--out inventory.md] [--json inventory.json]
//                                                [--sample-cells as_shipped,r20_c6000] [--sample-repeat 1]
//
// Reads the sanitized diagnostics the baseline harness wrote (usage.discovery: hosts, 120-character titles, hooks, dates; no keys, no article text) and
// reports, per market and overall:
//   * every KEPT source (from the attempt the topics came from), with duplicate uses told apart from unique publishers;
//   * a publisher-host table with a heuristic source class, so local reporting, government records, housing research and brokerage or agent material
//     can be judged. The class is a first-pass heuristic from the address alone; hosts it cannot place are listed as "unclassified" for a human to judge;
//   * a human-readable review sample: the actual opportunities (hook, scope, depth facts) with their source evidence.
// Nothing here reads article text, and the output is redacted of anything key-shaped.

const fs = require("fs");
const path = require("path");

const CLASSES = ["government", "housing_research", "financing_economic", "association_or_nonprofit", "builder_developer", "portal", "brokerage_or_agent", "news_like", "education", "unclassified"];

const HOUSING_RESEARCH = /(^|\.)(zillow\.com|redfin\.com|realtor\.com|car\.org|nar\.realtor|corelogic\.com|cotality\.com|mba\.org|nahb\.org|attomdata\.com|housingwire\.com)$/;
const FINANCING = /(^|\.)(freddiemac\.com|freddiemac\.gcs-web\.com|fanniemae\.com|federalreserve\.gov|frbsf\.org|bls\.gov|census\.gov|dof\.ca\.gov|edd\.ca\.gov|fhfa\.gov)$/;
const BUILDER = /(^|[.-])(lennar|drhorton|toll(brothers)?|kbhome|pulte|hovnanian|taylormorrison|shea(homes)?|meritage|richmondamerican|woodsidehomes|taylorwoodrow|centex|delwebb|trilogylife)([.-]|\.|$)/;
const PORTAL = /(^|\.)(movoto\.com|homes\.com|trulia\.com|apartments\.com|rocket\.com|rockethomes\.com|opendoor\.com|compass\.com|55places\.com|zumper\.com)$/;
const BROKERAGE_AGENT = /(^|[.-])(realty|realtors?|realestate|real-estate|properties|homesales|homesforsale|brokerage|remax|kw|exprealty|coldwellbanker|century21|bhhs|redfinagent|group|team|agent[a-z]*|homes?by[a-z]+)([.-]|\d|$)|(realty|realestate|realtor|homes?sales|properties|group)\.[a-z]{2,}$|^homes\.|^living\./i;
const NEWS_LIKE = /(news|times|bee\b|observer|gazette|journal|herald|tribune|patch|press|post|chronicle|courier|sentinel|dispatch|magazine|ledger|daily|weekly|insider)/i;

function classify(host) {
  const h = String(host || "").toLowerCase();
  if (!h) return "unclassified";
  if (FINANCING.test(h)) return "financing_economic";
  if (/\.gov$|\.ca\.us$|(^|\.)cityof[a-z]+\./.test(h) || /\.(gov|ca\.us)\./.test(h)) return "government";
  if (/\.edu$/.test(h)) return "education";
  if (HOUSING_RESEARCH.test(h)) return "housing_research";
  if (BUILDER.test(h)) return "builder_developer";
  if (PORTAL.test(h)) return "portal";
  if (/\.org$/.test(h)) return "association_or_nonprofit";
  if (BROKERAGE_AGENT.test(h)) return "brokerage_or_agent";
  if (NEWS_LIKE.test(h)) return "news_like";
  return "unclassified";
}

function redact(text) {
  return String(text).replace(/pplx-[A-Za-z0-9_-]+/g, "[key]").replace(/sk-[A-Za-z0-9_-]{8,}/g, "[key]").replace(/Bearer\s+\S+/gi, "Bearer [key]");
}

/** Reads every *.discovery.json in a folder: { market, cell, repeat, d }. File names are <market>-<cell>-<repeat>.discovery.json. */
function readRuns(dir) {
  const out = [];
  fs.readdirSync(dir).filter((f) => f.endsWith(".discovery.json")).sort().forEach((f) => {
    const m = /^(.+?)-(as_shipped|v2_[a-z0-9_]+|r\d+_c\d+)-(\d+)\.discovery\.json$/.exec(f);
    if (!m) return;
    let d = null;
    try { d = JSON.parse(fs.readFileSync(path.join(dir, f), "utf8")); } catch { return; }
    let cards = null;   // Article-Led (v2) runs also have the delivered cards, for the human review sample
    try { cards = JSON.parse(fs.readFileSync(path.join(dir, f.replace(/\.discovery\.json$/, ".cards.json")), "utf8")); } catch { /* v1 runs have none */ }
    if (d && Array.isArray(d.attempts)) out.push({ file: f, market: m[1], cell: m[2], repeat: Number(m[3]), d, cards });
  });
  return out;
}

/** The kept sources of the attempt the delivered topics came from, with their topic's hook and final position. */
function keptOf(run) {
  const d = run.d;
  const used = d.attempts.find((a) => a.n === d.used_attempt) || d.attempts[d.attempts.length - 1];
  if (!used) return { topics: [], sources: [] };
  const topics = (used.topics || []).filter((t) => t.outcome === "kept").sort((a, b) => (a.final_rank || 99) - (b.final_rank || 99));
  const depthTopics = d.depth && d.depth.topics || [];
  const sources = (used.sources || []).filter((s) => s.outcome === "kept");
  return {
    topics: topics.map((t, i) => ({ n: t.topic, rank: t.final_rank, hook: t.hook, depth: depthTopics[i] || null, sources: sources.filter((s) => s.topic === t.topic) })),
    sources,
  };
}

function inventory(runs) {
  const byMarket = {};
  const hostRows = {};
  runs.forEach((r) => {
    const k = keptOf(r);
    const mk = (byMarket[r.market] = byMarket[r.market] || { runs: 0, uses: 0, hosts: new Map(), classUses: {} });
    mk.runs++;
    k.sources.forEach((s) => {
      mk.uses++;
      mk.hosts.set(s.host, (mk.hosts.get(s.host) || 0) + 1);
      const c = classify(s.host);
      mk.classUses[c] = (mk.classUses[c] || 0) + 1;
      const hr = (hostRows[s.host] = hostRows[s.host] || { host: s.host, class: c, uses: 0, runs: new Set(), markets: new Set() });
      hr.uses++; hr.runs.add(r.file); hr.markets.add(r.market);
    });
  });
  const markets = Object.entries(byMarket).map(([market, m]) => ({
    market, runs: m.runs, source_uses: m.uses, unique_publishers: m.hosts.size, duplicate_uses: m.uses - m.hosts.size,
    class_uses: m.classUses, top_hosts: [...m.hosts.entries()].sort((a, b) => b[1] - a[1]).slice(0, 8).map(([host, uses]) => ({ host, uses })),
  }));
  const hosts = Object.values(hostRows).map((h) => ({ host: h.host, class: h.class, uses: h.uses, runs: h.runs.size, markets: [...h.markets].sort() })).sort((a, b) => b.uses - a.uses);
  const total = markets.reduce((s, m) => s + m.source_uses, 0);
  const classTotals = {};
  hosts.forEach((h) => { classTotals[h.class] = (classTotals[h.class] || 0) + h.uses; });
  return { runs: runs.length, source_uses: total, unique_publishers: hosts.length, duplicate_uses: total - hosts.length, class_uses: classTotals, markets, hosts };
}

function sample(runs, cells, repeat) {
  return runs.filter((r) => cells.includes(r.cell) && r.repeat === repeat).map((r) => ({ market: r.market, cell: r.cell, repeat: r.repeat, topics: keptOf(r).topics, cards: r.cards }));
}

function markdown(inv, samples) {
  const L = [];
  const pct = (a, b) => (b ? `${Math.round((a / b) * 100)}%` : "n/a");
  L.push("# Research baseline: source inventory", "", `Runs: ${inv.runs}. Kept source uses: ${inv.source_uses}. Unique publishers: ${inv.unique_publishers}. Repeat uses of a publisher: ${inv.duplicate_uses}.`, "",
    "Source classes are a first-pass heuristic from the host name alone (not a reading of the pages); hosts marked `unclassified` need a human judgment.", "",
    "## By source class (all markets)", "", "| Class | Uses | Share |", "| --- | --- | --- |");
  CLASSES.forEach((c) => { if (inv.class_uses[c]) L.push(`| ${c} | ${inv.class_uses[c]} | ${pct(inv.class_uses[c], inv.source_uses)} |`); });
  L.push("", "## By market", "", "| Market | Runs | Source uses | Unique publishers | Repeat uses | Top hosts (uses) |", "| --- | --- | --- | --- | --- | --- |");
  inv.markets.forEach((m) => L.push(`| ${m.market} | ${m.runs} | ${m.source_uses} | ${m.unique_publishers} | ${m.duplicate_uses} | ${m.top_hosts.map((h) => `${h.host} (${h.uses})`).join(", ")} |`));
  L.push("", "### Source class by market (uses)", "", `| Market | ${CLASSES.join(" | ")} |`, `| --- | ${CLASSES.map(() => "---").join(" | ")} |`);
  inv.markets.forEach((m) => L.push(`| ${m.market} | ${CLASSES.map((c) => m.class_uses[c] || 0).join(" | ")} |`));
  L.push("", "## Publisher hosts", "", "| Host | Class | Uses | Runs | Markets |", "| --- | --- | --- | --- | --- |");
  inv.hosts.forEach((h) => L.push(`| ${h.host} | ${h.class} | ${h.uses} | ${h.runs} | ${h.markets.join(", ")} |`));
  L.push("", "## Review sample: the actual opportunities and their source evidence", "",
    "Each run lists the delivered topics (hook as written), whether the model labelled it exact-market or broader context, and the sources it rests on. Judge whether the hook is a real, distinct development, whether the source supports it, and whether a better source existed.", "");
  samples.forEach((s) => {
    L.push(`### ${s.market} / ${s.cell} / run ${s.repeat}`, "");
    if (s.cards && s.cards.length) {   // Article-Led (v2): the full card next to its sources
      s.cards.forEach((c) => {
        L.push(`${c.n}. **${c.question}** (${c.relationship}${c.routeToMarket ? `; route: ${c.routeToMarket}` : ""}; status ${c.status}${c.statusReason ? ` (${c.statusReason})` : ""}; access ${c.accessConfidence && c.accessConfidence.value} [provisional])`,
          `   - Development / angle: ${c.development} / ${c.angle}`, `   - Perspective: ${c.thesis}`, `   - Homeowner decision: ${c.homeownerDecision || "n/a"}`,
          `   - Established: ${(c.establishedFacts || []).join(" | ") || "none"}`, `   - Possible, not proven: ${(c.possibleExplanations || []).join(" | ") || "none"}`,
          `   - Project facts: ${(c.projectFacts || []).map((f) => `${f.fact} [${f.basis}; ${f.verification}]`).join(" | ") || "none"}`,
          `   - Evidence gaps: ${(c.evidenceGaps || []).join(" | ") || "none"}; to verify: ${(c.verificationNeeds || []).join(" | ") || "none"}`);
        (c.sources || []).forEach((src) => L.push(`   - Source: ${src.host} (${src.role}, ${src.kind}; host heuristic ${classify(src.host)}), "${src.title}", published ${src.published}, ${src.window}; about ${src.sourceGeography || "n/a"}, period ${src.reportingPeriod || "n/a"}`));
      });
      L.push("");
      return;
    }
    s.topics.forEach((t, i) => {
      const dp = t.depth;
      L.push(`${i + 1}. **${t.hook || "(no hook stored)"}**${dp ? ` (${dp.scope === "broader_context" ? "broader context" : "exact market"}; ${dp.trend_signals} signals; newest source ${dp.newest_source_days == null ? "n/a" : dp.newest_source_days + " days"} old)` : ""}`);
      t.sources.forEach((src) => L.push(`   - ${src.host} (${classify(src.host)}), "${src.title || "no title"}", date ${src.provider_date || src.model_date || "n/a"}${src.date_from ? ` (${src.date_from})` : ""}`));
    });
    L.push("");
  });
  return L.join("\n") + "\n";
}

function parseArgs(argv) {
  const a = { dir: null, out: null, json: null, cells: ["as_shipped", "r20_c6000"], repeat: 1 };
  for (let i = 0; i < argv.length; i++) {
    const k = argv[i];
    if (k === "--out") a.out = argv[++i];
    else if (k === "--json") a.json = argv[++i];
    else if (k === "--sample-cells") a.cells = String(argv[++i] || "").split(",").map((x) => x.trim()).filter(Boolean);
    else if (k === "--sample-repeat") a.repeat = Number(argv[++i]) || 1;
    else if (!a.dir && !k.startsWith("--")) a.dir = k;
  }
  if (!a.dir) throw new Error("Give the folder that holds the *.discovery.json files.");
  return a;
}

function main() {
  const a = parseArgs(process.argv.slice(2));
  const runs = readRuns(a.dir);
  if (!runs.length) throw new Error(`No *.discovery.json files found in ${a.dir}.`);
  const inv = inventory(runs);
  const md = redact(markdown(inv, sample(runs, a.cells, a.repeat)));
  if (a.out) fs.writeFileSync(a.out, md); else process.stdout.write(md);
  if (a.json) fs.writeFileSync(a.json, redact(JSON.stringify(inv, null, 1)));
}

module.exports = { classify, readRuns, keptOf, inventory, sample, markdown, parseArgs, redact, CLASSES };
if (require.main === module) { try { main(); } catch (e) { console.error(redact(e.message)); process.exit(1); } }
