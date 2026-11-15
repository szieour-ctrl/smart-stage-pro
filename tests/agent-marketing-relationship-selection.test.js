"use strict";
// Nov 14, 2026 (Sam; Test only): relationship-based evidence selection for Option 2. B2 chooses the market observation by what the article's lever acts on;
// the Planner records market_relationship in composition_plan and may improve a weak B2 reading. Offline only: prompt text, deterministic library, stored Lincoln fixture.
const test = require("node:test");
const assert = require("node:assert");
const fs = require("fs");
const planLib = require("../netlify/functions/lib/agent-marketing-plan-lib");
const b2 = require("../netlify/functions/lib/agent-marketing-b2-lib");
const ti = require("../netlify/functions/lib/agent-marketing-trend-intelligence-lib");
const lib = require("../netlify/functions/lib/agent-marketing-report-lib");
const rr = require("../netlify/functions/lib/agent-marketing-research-report-lib");
const fx = require("./helpers/market-update-fixtures");
const FX = require("./fixtures/lincoln-option2-t1.json");

const DEV = { AGENT_MARKETING_B1_EVIDENCE: "dev" };
const LIB = __dirname + "/../netlify/functions/lib/";
const analyze = (text) => ti.analyze(rr.buildContext([{ id: "u1", facts: lib.analyzePages([text], {}).facts }], { geography: { type: "zip", name: "95747", label: "ZIP 95747" } }));
const userOf = (b2extra) => JSON.parse(planLib.buildUserMessage({ template: "local_market_insider", duration_sec: 60, formats: ["9x16"], intake: { angle: "", market: "Lincoln, CA", audience: "Home sellers", issue: "", action: "Ask", observation: "" }, selected_topic: { ...FX.topic, b2: { ...FX.topic.b2, ...(b2extra || {}) } } }));

test("B2 rule 2b (Nov 15): the report relationship may be reinforce, complicate, context or none; the report prompt only; the most relevant observation first", () => {
  const withTrend = b2.systemPrompt("article_report", true), plain = b2.systemPrompt("article_report", false), editorial = b2.systemPrompt("article_editorial", false);
  assert.match(withTrend, /REPORT RELATIONSHIPS/);
  assert.match(withTrend, /reinforces the article's point, complicates or contradicts it, adds local context only, or has no real bearing on it; say which/);
  assert.match(withTrend, /the most relevant first/);
  assert.match(withTrend, /never force a link to make a candidate stronger/);
  assert.match(withTrend, /Never compare the prices of homes for sale with the prices of homes that sold as if they were the same homes/);
  assert.match(withTrend, /The report's caveats are binding/);
  for (const p of [plain, editorial]) assert.doesNotMatch(p, /REPORT RELATIONSHIPS/, "Option 3 and non-trend prompts do not carry the report relationships rule");
});

test("B2 rule 1b (Nov 15): the mechanism is stated in plain sentences only when a homeowner needs it to understand the position", () => {
  const p = b2.systemPrompt("article_report", true);
  assert.match(p, /when a homeowner needs it to understand the position, state it in two or three plain sentences; when they do not, leave it empty/);
  assert.match(p, /editorial_angle does not lead with a rule, limit, percentage or calculation/);
});

test("no rule text added here carries Lincoln, a particular ratio, or a fixed figure", () => {
  const texts = [b2.systemPrompt("article_report", true), planLib.buildSystemPrompt(DEV, {})].join("\n");
  const added = texts.split("\n").filter((l) => /RELATIONSHIP TEST|^2r\.|MARKET RELATIONSHIP|^2n\.|^2l\./.test(l)).join("\n");
  assert.doesNotMatch(added, /Lincoln|95\s?%|forward commitment|forward-commitment|Fannie|buydown|MetroList/i);
});

test("editorialInput keeps the order B2 cited: the first id is the observation the story rests on", () => {
  const a = FX.topic.b2.trendIntelligence;
  // the stored slice is already filtered; rebuild a full analysis-like object from it
  const full = { usable: true, version: a.version, character: a.character, reports: a.reports, observations: a.observations, contrasts: a.contrasts || [], interpretations: a.interpretations || [], caveats: a.caveats || [] };
  assert.deepStrictEqual(ti.editorialInput(full, ["TI4", "TI3"]).observations.map((o) => o.id), ["TI4", "TI3"]);
  assert.deepStrictEqual(ti.editorialInput(full, ["TI3", "TI4"]).observations.map((o) => o.id), ["TI3", "TI4"]);
  assert.deepStrictEqual(ti.editorialInput(full, ["TI3"]).observations.map((o) => o.id), ["TI3"]);
});

test("the ranking is unchanged: the stronger negotiation observation is still labelled ahead of the weaker asking-vs-sold one", () => {
  const a = analyze(fx.marketUpdate());
  const idx = (k) => a.observations.findIndex((o) => o.kind === k);
  assert.ok(idx("negotiation") >= 0 && idx("asking_vs_sold") >= 0);
  assert.ok(idx("negotiation") < idx("asking_vs_sold"));
  assert.ok(a.observations.every((o, i, all) => i === 0 || all[i - 1].strength >= o.strength), "still sorted by strength");
});

test("an asking-vs-sold observation carries the active-versus-closed caveat and the softened reading; a report without it carries neither", () => {
  const a = analyze(fx.marketUpdate());
  assert.ok(a.observations.some((o) => o.kind === "asking_vs_sold"));
  assert.ok(a.caveats.some((c) => /different homes/.test(c) && /never describe the difference/.test(c) && /discount, a concession/.test(c)));
  const reads = a.interpretations.map((i) => i.text).join("\n");
  assert.doesNotMatch(reads, /usual place where listings stall/);
  assert.match(reads, /different homes/);
  const noActive = fx.marketUpdate().split("\n").filter((l) => !/Avg\. Active Price|Median Active Price/.test(l)).join("\n");
  const b = analyze(noActive);
  assert.ok(!b.observations.some((o) => o.kind === "asking_vs_sold"));
  assert.ok(!b.caveats.some((c) => /Homes for sale now and homes that closed/.test(c)));
});

test("the caveat reaches the Planner through the existing caveats array and no new field", () => {
  const withGap = analyze(fx.marketUpdate());
  const src = fs.readFileSync(LIB + "agent-marketing-plan-lib.js", "utf8");
  assert.match(src, /caveats: \(ti\.caveats \|\| \[\]\)\.map\(String\)/);
  assert.ok(withGap.caveats.some((c) => /different homes/.test(c)));
});

test("the 600-character truncation is gone: a long reading survives whole to a sentence end, with a higher limit", () => {
  const src = fs.readFileSync(LIB + "agent-marketing-b2-lib.js", "utf8");
  assert.doesNotMatch(src, /clip\(c\.trend_interpretation, 600\)/);
  assert.match(src, /clip\(c\.trend_interpretation, TREND_READING_CHARS\)/);
  assert.match(src, /TREND_READING_CHARS = 1200/);
});

test("Planner rule 2i E: the figure's own label decides what it measures; for-sale and sold prices describe different homes", () => {
  const rule = planLib.buildSystemPrompt(DEV, {}).split("\n").find((l) => l.startsWith("2i. "));
  assert.match(rule, /A figure means what its own label and basis say/);
  assert.match(rule, /a ratio to original list price is not a ratio to last list price/);
  assert.match(rule, /the prices of homes for sale and the prices of homes that sold describe different homes/);
});

test("Planner rule 2i B: B2's reading is one reading, not instructions; the writer may improve on it", () => {
  const rule = planLib.buildSystemPrompt(DEV, {}).split("\n").find((l) => l.startsWith("2i. "));
  assert.match(rule, /one reading, not instructions: build on them where the evidence holds, improve on them where it supports something better/);
  assert.match(rule, /leave out any that compare different groups of homes or different measures as if they were the same/);
});

test("Planner schema (Nov 15): market_relationship is gone; composition_plan stays optional diagnostic metadata with no extra call or gate", () => {
  const sys = planLib.buildSystemPrompt(DEV, {});
  assert.ok(!sys.includes("market_relationship"), "the field is removed");
  assert.match(sys, /"composition_plan": \{ "central_tension": string, "realtor_conclusion": string, "essential_findings"/);
  assert.ok(!planLib.buildSystemPrompt({}, {}).includes("composition_plan"), "production prompt untouched");
});

test("stored Lincoln T1: the Planner message keeps B2's cited order and both observations, with the Option 2 component contract", () => {
  const prev = process.env.AGENT_MARKETING_B1_EVIDENCE; process.env.AGENT_MARKETING_B1_EVIDENCE = "dev";
  let u; try { u = userOf(); } finally { if (prev === undefined) delete process.env.AGENT_MARKETING_B1_EVIDENCE; else process.env.AGENT_MARKETING_B1_EVIDENCE = prev; }
  assert.deepStrictEqual(u.narrative_contract.components.map((c) => c.component), ["opening", "article", "trend", "synthesis", "cta"]);
  assert.strictEqual(u.narrative_contract.target_words, 150);
  const refs = FX.topic.b2.trendObservationRefs;
  assert.deepStrictEqual(refs, ["TI4", "TI3"]);
  const rels = (u.selected_topic.editorial_direction.market_interpretation || {}).relationships || [];
  assert.ok(rels.length >= 2);
});
