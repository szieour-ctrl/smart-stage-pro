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

test("B2 rule 2b: relationship test is in the report prompt only, generic, and puts the measuring observation first", () => {
  const withTrend = b2.systemPrompt("article_report", true), plain = b2.systemPrompt("article_report", false), editorial = b2.systemPrompt("article_editorial", false);
  assert.match(withTrend, /RELATIONSHIP TEST: state what the article's lever or mechanism changes for the buyer and for the seller/);
  assert.match(withTrend, /cite it FIRST/);
  assert.match(withTrend, /not thereby related/);
  assert.match(withTrend, /never a budget every seller has/);
  assert.match(withTrend, /Never set the asking prices of homes for sale against sold prices as a discount or concession/);
  for (const p of [plain, editorial]) assert.doesNotMatch(p, /RELATIONSHIP TEST/, "Option 3 and non-trend prompts do not carry the relationship test");
});

test("B2 rule 1b: the position candidate's mechanism is the lever in plain homeowner terms; rules and limits are brief constraints", () => {
  const p = b2.systemPrompt("article_report", true);
  assert.match(p, /Its mechanism states, in two or three plain homeowner sentences, the competitive lever or practical step/);
  assert.match(p, /regulatory limits, caps and calculations are mentioned only briefly as constraints and never lead it/);
  assert.match(p, /editorial_angle must not lead with a rule, limit, percentage or calculation/);
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

test("Planner rule 2n: the figure's own label decides what it measures; original-list is not described as saying nothing about first pricing", () => {
  const rule = planLib.buildSystemPrompt(DEV, {}).split("\n").find((l) => l.startsWith("2n. "));
  assert.match(rule, /the figure's own label says what it measures, so read the label/);
  assert.match(rule, /measured against the original list price shows, across the sales it covers, how far closings landed from where homes were first priced/);
  assert.match(rule, /an average ratio does not give every seller that much room/);
  assert.doesNotMatch(rule, /so it says nothing about how the home was first priced/);
  assert.match(rule, /for the relationship it has to that lever or choice, not for resembling another figure in wording/);
});

test("Planner rule 2l: B2's reading is a suggestion the writer may improve on when verified evidence supports a stronger relationship", () => {
  const rule = planLib.buildSystemPrompt(DEV, {}).split("\n").find((l) => l.startsWith("2l. "));
  assert.match(rule, /article_and_market text and the readings are suggestions, not instructions/);
  assert.match(rule, /build on the stronger one and leave the weaker reading out/);
  assert.match(rule, /never repeat a reading that compares different groups of homes as if they were the same/);
});

test("Planner rule 2r and schema: market_relationship is written first, chosen by relationship, and conditional; no extra call or gate", () => {
  const sys = planLib.buildSystemPrompt(DEV, {});
  const r = sys.split("\n").find((l) => l.startsWith("2r. "));
  assert.match(r, /MARKET RELATIONSHIP/);
  assert.match(r, /not by wording similarity or by size/);
  assert.match(r, /never a budget every seller has/);
  assert.match(r, /If no figure has a real relationship to the lever, say so/);
  assert.match(sys, /"market_relationship": string/);
  assert.ok(!planLib.buildSystemPrompt({}, {}).includes("market_relationship"), "production prompt untouched");
});

test("stored Lincoln T1: the Planner message keeps B2's cited order and both observations, with the existing five-beat contract", () => {
  const prev = process.env.AGENT_MARKETING_B1_EVIDENCE; process.env.AGENT_MARKETING_B1_EVIDENCE = "dev";
  let u; try { u = userOf(); } finally { if (prev === undefined) delete process.env.AGENT_MARKETING_B1_EVIDENCE; else process.env.AGENT_MARKETING_B1_EVIDENCE = prev; }
  assert.deepStrictEqual(u.narrative_contract.beats.map((b) => b.beat), ["hook", "setup", "evidence", "interpretation", "cta"]);
  assert.strictEqual(u.narrative_contract.target_words, 150);
  const refs = FX.topic.b2.trendObservationRefs;
  assert.deepStrictEqual(refs, ["TI4", "TI3"]);
  const rels = (u.selected_topic.editorial_direction.market_interpretation || {}).relationships || [];
  assert.ok(rels.length >= 2);
});
