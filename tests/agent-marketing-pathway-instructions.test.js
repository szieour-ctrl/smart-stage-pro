"use strict";
// Phase C (Nov 13, 2026, Sam; Test only): pathway-aware editorial instructions on the shared planner. Option 2 (article_report) keeps its article-plus-report
// instructions; Option 3 (article_editorial) is never told to use report figures it does not have. Same planner, rules and duration contract.
const test = require("node:test");
const assert = require("node:assert");
const crypto = require("crypto");
const planLib = require("../netlify/functions/lib/agent-marketing-plan-lib");

const PROD_HASH = "25f3118fed1b9726fc4dc78b16dcc92233cef785d3c074ef89a6ee7aaf7b0495";
const withEnv = (dev, fn) => { const prev = process.env.AGENT_MARKETING_B1_EVIDENCE; if (dev) process.env.AGENT_MARKETING_B1_EVIDENCE = "dev"; else delete process.env.AGENT_MARKETING_B1_EVIDENCE;
  try { return fn(); } finally { if (prev === undefined) delete process.env.AGENT_MARKETING_B1_EVIDENCE; else process.env.AGENT_MARKETING_B1_EVIDENCE = prev; } };
const b2 = (mode) => ({ mode, mechanism: "Supply is loosening.", homeownerImplication: "Pricing matters more.", editorialAngle: "Prepare and price for choice.", audienceJourney: "j", sourceRefs: [{ finding: "f1", quote: "Inventory rose.", attribution: "the article" }] });
const topic = (mode, figures) => ({ id: "t1", question: "Is supply changing?", whyItMatters: "w", scope: "selected", origin: "web", reportFirst: mode === "article_report", trendSignals: [],
  reportFigures: figures || [], sources: [{ url: "https://example.org/a", kind: "article", role: "primary", title: "t" }], ...(mode ? { b2: b2(mode) } : {}) });
const user = (t, dev = true) => withEnv(dev, () => JSON.parse(planLib.buildUserMessage({ template: "local_market_insider", duration_sec: 45, formats: ["9x16"], intake: { market: "Roseville, CA", audience: "Home sellers", action: "Ask for a local perspective" }, selected_topic: t })));
const rule = (id) => withEnv(true, () => planLib.buildSystemPrompt(undefined, { scoped: false }).split("\n").find((l) => l.startsWith(id + ". ")));

test("Option 3 (article_editorial): the architecture names article facts only, and source_pathway says there is no report", () => {
  const u = user(topic("article_editorial"));
  assert.match(u.narrative_architecture, /the article's validated, attributed facts, each in the scene where it does its work/);
  assert.ok(!/report/i.test(u.narrative_architecture), "no mention of a report or its figures");
  assert.match(u.source_pathway, /^Article only\. There is no Market Trend Report in this Reel and no figures_you_may_state\./);
  assert.match(u.source_pathway, /attributed to the article as rule 2h requires; do not introduce a market statistic from any other source/);
  assert.ok(!("figures_you_may_state" in u.selected_topic) && !("report_is_source_of_truth_for_market_numbers" in u.selected_topic), "no report fields in the brief");
});

test("Option 2 (article_report): the architecture is exactly the article-plus-report one, and source_pathway names both sources", () => {
  const fig = [{ key: "months_supply", ref: "r1.months_supply", role: "area_statistic", text: "ROSEVILLE, October 2026: Months of inventory: 3.2 months", label: "x", period: "October 2026", display: "x", areaLabel: "ROSEVILLE", scopeKind: "exact", partialPeriod: false, partialComparison: false }];
  const u = user(topic("article_report", fig));
  assert.strictEqual(u.narrative_architecture, "A question naming what is at stake → the Realtor's answer, built from the evidence that establishes it (the article's facts and the report's figures, each in the scene where it does its work) → what that answer means for the seller, specifically → low-pressure next step");
  assert.match(u.source_pathway, /^Article plus the agent's report\./);
  assert.match(u.source_pathway, /Keep the two sources separate and attributed under rules 2f, 2g and 2h/);
  assert.ok(Array.isArray(u.selected_topic.figures_you_may_state) && u.selected_topic.report_is_source_of_truth_for_market_numbers === true, "Option 2 still gets its report fields");
});

test("outside the two pathways and outside Test, nothing changes: no source_pathway and the original architecture strings", () => {
  const noMode = user(topic(null));
  assert.ok(!("source_pathway" in noMode));
  const trend = user(topic("trend_report"));
  assert.ok(!("source_pathway" in trend), "Option 1 is untouched");
  assert.ok(!("source_pathway" in user(topic("article_editorial"), false)), "production has no pathway field");
  assert.ok(!("source_pathway" in user(topic("article_report"), false)));
  assert.strictEqual(user(topic(null), false).narrative_architecture, "Hook on the topic's question → what the sourced facts show (only those) → what it means for the audience → low-pressure next step");
});

test("rule 2g (Nov 13 correction): no first/last data rule in Test; without a report article facts may stand in any scene, attributed", () => {
  const r = rule("2g");
  assert.ok(!/The FIRST and the LAST scene are always/.test(r), "position no longer decides the source");
  assert.match(r, /\(no agent report; source_pathway says "article_only"\), there are no data figures and no scene states a report figure: any scene, the first and the last included, may state the article's facts with the article attributed as rule 2h requires/);
  assert.match(r, /the hook may lead with one\./);
  assert.match(r, /never combine an article figure and a report figure into one calculation or comparison/, "article and report figures are still never combined");
});


test("rule 2i: report figures are a source only when a report is present; without one every claim comes from article_evidence", () => {
  const r = rule("2i");
  assert.match(r, /from the article findings, and the report figures when a report is present, where rule 2g permits them/);
  assert.match(r, /or, when a report is present, from figures_you_may_state \(source_role "data"\); without a report it comes from article_evidence alone;/);
  assert.ok(!/from the article and report findings/.test(r));
});

test("rule 2n: the report-menu sentence applies when a report is present; without one the discipline applies to the article's validated findings", () => {
  const r = rule("2n");
  assert.match(r, /^2n\. CHOOSING AND READING STATISTICS\. When a report is present, the figures in figures_you_may_state are its whole menu, not a list to cover; without a report \(source_pathway "article_only"\) the same discipline applies to the figures in article_evidence's validated findings\./);
  assert.ok(!/are the report's whole menu/.test(r));
});

test("Rules 2o, 2p and 2q, the rule count and the production system prompt are untouched", () => {
  const labels = withEnv(true, () => planLib.buildSystemPrompt(undefined, { scoped: false }).split("\n").map((l) => (l.match(/^(\d+[a-z]?)\. /) || [])[1]).filter(Boolean));
  assert.ok(!labels.includes("2r"), "no new rule");
  ["2o", "2p", "2q"].forEach((id) => assert.strictEqual(labels.filter((x) => x === id).length, 1, id));
  assert.strictEqual(crypto.createHash("sha256").update(withEnv(false, () => planLib.buildSystemPrompt())).digest("hex"), PROD_HASH);
});

test("one planner serves both pathways: only the two user-message fields differ between Option 2 and Option 3 briefs", () => {
  const a = user(topic("article_editorial")), b = user(topic("article_report"));
  const diff = Object.keys({ ...a, ...b }).filter((k) => JSON.stringify(a[k]) !== JSON.stringify(b[k])).sort();
  assert.deepStrictEqual(diff, ["narrative_architecture", "selected_topic", "source_pathway"], "the topic itself differs (report fields); no other planner field does");
  assert.deepStrictEqual(a.spoken_word_range, b.spoken_word_range);
  assert.deepStrictEqual(a.scene_count_range, b.scene_count_range);
  assert.strictEqual(a.spoken_word_aim, b.spoken_word_aim);
});
