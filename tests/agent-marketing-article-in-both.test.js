// Oct 27, 2026: when the agent uses their report AND an approved article, the Reel is about the article, and market numbers still come only from the report.
const test = require("node:test");
const assert = require("node:assert");
const art = require("../netlify/functions/lib/agent-marketing-article-lib");
const plan = require("../netlify/functions/lib/agent-marketing-plan-lib");
const gate = require("../netlify/functions/lib/agent-marketing-gate");
const amLib = require("../netlify/functions/lib/agent-marketing-lib");

const TOPIC = {
  id: "t5", origin: "web", reportFirst: true, scope: "selected", question: "Could Antelope sellers feel the 132 apartments planned at Poker Lane?",
  whyItMatters: "A proposed 132-unit affordable apartment complex is a specific local housing development. County active listings were 2,523, up 6.2% from August.",
  trendSignals: ["The article reports plans submitted for a 132-unit apartment complex at Poker Lane and Antelope North Road.", "Sacramento County median price rose 3.1% in September."],
  sources: [{ title: "Developer files plans for 132-unit affordable apartment complex in Antelope", url: "https://www.onsiteobserver.com/x", domain: "onsiteobserver.com", published: "2026-10-19" }],
  reportFigures: [{ ref: "r1.f1", text: "Average days on market: 22 days vs 32 days in September 2025 (down 31.2%)" }], reportNotice: "", reportPrecedence: [],
};

test("the article's project facts reach the planner; its market statistics do not", () => {
  const f = art.articleFacts(TOPIC);
  assert.match(f.question, /132 apartments planned at Poker Lane/);
  assert.match(f.whyItMatters, /132-unit affordable apartment complex/);
  assert.doesNotMatch(f.whyItMatters, /2,523|6\.2/, "the county listing statistic is the report's job");
  assert.deepStrictEqual(f.trendSignals, [TOPIC.trendSignals[0]]);
  const brief = plan.topicBrief(TOPIC);
  assert.match(brief.topic_question, /132 apartments/);
  assert.ok(brief.trend_signals.some((x) => /Poker Lane/.test(x)));
  assert.doesNotMatch(JSON.stringify(brief), /2,523|3\.1%/);
});

test("the planner is told to build a scene on the article", () => {
  const sys = plan.buildSystemPrompt ? plan.buildSystemPrompt() : "";
  if (!sys) return;
  assert.match(sys, /at least one middle scene must have source_role "article"/);
});

test("the script may say 132 apartments, but not a web market statistic", () => {
  const project = { template: "local_market_insider", intake: { market: "Antelope, CA" }, selected_topic: TOPIC };
  const run = (text) => gate.evaluate(amLib.gateInputFor(project, amLib.attachNotice(project, { captionText: text, narrationTagged: text, scenes: [{ narrationExcerpt: text }], cta: { text: "Ask me.", source: "claude" } }), "claude"));
  assert.ok(!run("Plans were filed for a 132-unit apartment complex at Poker Lane.").blocks.some((b) => b.rule === "invented_number"), "132 comes from the article");
  const bad = run("County median price rose 3.1% in September.");
  assert.ok(bad.blocks.some((b) => b.rule === "invented_number" && b.match === "3.1"), "a web market statistic still needs the report");
});
