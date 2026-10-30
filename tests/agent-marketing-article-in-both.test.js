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

test("the article's project facts and ideas reach the planner; its market statistics arrive with the figure neutralized", () => {
  const f = art.articleFacts(TOPIC);
  assert.match(f.question, /132 apartments planned at Poker Lane/, "a project fact is the article's story and stays");
  assert.match(f.whyItMatters, /132-unit affordable apartment complex/);
  assert.doesNotMatch(f.whyItMatters, /2,523|6\.2/, "the county listing statistic is the report's job");
  assert.match(f.whyItMatters, /County active listings were \[article figure\], up \[article figure\] from August/, "the sentence and its idea stay; only the figures are neutralized");
  assert.strictEqual(f.trendSignals.length, 2, "no trend signal is deleted any more");
  assert.strictEqual(f.trendSignals[0], TOPIC.trendSignals[0]);
  assert.match(f.trendSignals[1], /median price rose \[article figure\] in September/);
  const brief = plan.topicBrief(TOPIC);
  assert.match(brief.topic_question, /132 apartments/);
  assert.ok(brief.trend_signals.some((x) => /Poker Lane/.test(x)));
  assert.match(brief.article_figure_rule, /\[article figure\]/);
  assert.doesNotMatch(JSON.stringify(brief), /2,523|3\.1%/);
});

test("Oct 30 (Lincoln): a question whose number is a market count is never sent empty", () => {
  const lincoln = { ...TOPIC, id: "t3", question: "Could 81 builder listings change what Lincoln resale sellers can ask?",
    whyItMatters: "A local article says builder homes made up 81 of 237 listings in Lincoln's 95648 ZIP code, putting new construction in the comparison set for resale sellers.",
    trendSignals: ["As reported in an article updated October 27, 2026, 81 of 237 listings in ZIP code 95648 were new-construction listings", "The article says the City of Lincoln approved a Village 7 amendment on July 28, 2026, increasing allocated units from 570 to 1,205."] };
  const brief = plan.topicBrief(lincoln);
  assert.strictEqual(brief.topic_question, "Could [article figure] builder listings change what Lincoln resale sellers can ask?");
  assert.match(brief.why_it_matters, /builder homes made up \[article figure\] of \[article figure\] listings/, "the idea stays");
  assert.strictEqual(brief.trend_signals.length, 2);
  assert.match(brief.trend_signals[1], /Village 7 amendment on July 28, 2026/, "a project fact and its date are untouched");
  assert.deepStrictEqual(art.articleNumbers(lincoln).sort(), ["237", "81", "95648"].sort());
});

test("Oct 30: the script is refused if it states a market figure that only the article has, and accepted when it says the idea without it", () => {
  const lincoln = { ...TOPIC, id: "t3", question: "Could 81 builder listings change what Lincoln resale sellers can ask?",
    whyItMatters: "Builder homes made up 81 of 237 listings in the ZIP code.", trendSignals: [] };
  const project = { template: "local_market_insider", intake: { market: "Lincoln, CA" }, selected_topic: lincoln };
  const run = (text) => gate.evaluate(amLib.gateInputFor(project, amLib.attachNotice(project, { captionText: text, narrationTagged: text, scenes: [{ narrationExcerpt: text }], cta: { text: "Ask me.", source: "claude" } }), "claude"));
  const bad = run("There are 81 builder listings competing with your home.");
  assert.ok(bad.blocks.some((b) => b.rule === "article_figure" && b.match === "81"));
  assert.match(bad.blocks.find((b) => b.rule === "article_figure").message, /comes from the article/);
  assert.ok(!run("Builder homes are a big part of what resale sellers compete with.").blocks.some((b) => b.rule === "article_figure"));
});

test("Oct 30: an article-backed script with no article scene is found, and a script with one is not", () => {
  const project = { selected_topic: { ...TOPIC, question: "Could builder listings change what resale sellers can ask?", whyItMatters: "Builder homes are a large share of the competition.", trendSignals: [] } };
  const scene = (role, text) => ({ sourceRole: role, narrationExcerpt: text });
  const allData = { scenes: [scene("data", "Prices per square foot are down."), scene("data", "More homes closed last month."), scene("data", "Pricing matters.")] };
  assert.strictEqual(plan.articleSceneProblems(allData, project).length, 1);
  const withArticle = { scenes: [scene("data", "Prices per square foot are down."), scene("article", "Buyers also walk into a builder's sales office."), scene("data", "Pricing matters.")] };
  assert.deepStrictEqual(plan.articleSceneProblems(withArticle, project), []);
  const wrongTopic = { scenes: [scene("data", "Prices are down."), scene("article", "Weather has been lovely lately."), scene("data", "Pricing matters.")] };
  assert.strictEqual(plan.articleSceneProblems(wrongTopic, project).length, 1, "an article label with no article idea in it does not count");
  assert.deepStrictEqual(plan.articleSceneProblems(allData, { selected_topic: { ...TOPIC, reportFirst: false } }), [], "no article involved");
  assert.deepStrictEqual(plan.articleSceneProblems(allData, { selected_topic: { ...TOPIC, reframed: true } }), [], "a reframed topic keeps its own rules");
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

// ── Oct 30, 2026: Claude reads the whole article (Directive A), then code checks the script ──
const BODY = "How do you sell a home in Lincoln when you are competing with new construction? Roughly one in three homes for sale in the ZIP code is a builder home, 81 new-construction listings out of 237 total, according to a listing site. You cannot match a builder's incentive dollar for dollar. The winning strategy is pricing against their net, not their sticker, and selling the four things a builder cannot deliver. The city approved a plan for 132 apartments near the downtown core in July.";
const READ = { ...TOPIC, id: "t3", question: "Could 81 builder listings change what Lincoln resale sellers can ask?", whyItMatters: "Builder homes are a big share of the competition.", trendSignals: [], articleText: BODY,
  reportFigures: [{ ref: "r1.f1", key: "count_closed", label: "Closed sales", display: "93", text: "Closed sales: 93 vs 89 in September 2025 (up 4.5%)" }, { ref: "r1.f2", key: "avg_close_to_list_pct", label: "Sold to list", display: "95%", text: "Sold price as a percent of original list price: 95% down 1% from September 2025" }] };

const PERSPECTIVE = { idea: "Resale sellers now compete with builders who offer incentives, so a seller should price against what a buyer nets, not the sticker.",
  perspective_points: ["Price against the builder's real net, not the sticker.", "Sell what a builder cannot deliver: a closing date you control, a finished yard, an HOA history buyers can read."],
  opinion_angles: ["Builders play by different rules on incentives, which changes how buyers compare a resale home."], context: ["The city approved a plan for 132 apartments near the downtown core in July."],
  questions_to_ponder: ["Are buyers weighing your home against brand-new ones?"] };

test("the planner is given the article's perspective and context, the question as written and a ref for every report figure, never the article itself", () => {
  const b = plan.topicBrief({ ...READ, perspectiveBrief: PERSPECTIVE });
  assert.match(b.directive, /only data figures you may present come from the agent's Market Trend data/);
  assert.match(b.directive, /it gives no market statistic/);
  assert.strictEqual(b.topic_question, "Could 81 builder listings change what Lincoln resale sellers can ask?", "the question is our own prompt, never filtered");
  assert.deepStrictEqual(b.article_perspective, PERSPECTIVE);
  assert.strictEqual(b.article_text, undefined, "the article text never reaches the planner");
  const all = JSON.stringify(b);
  assert.doesNotMatch(all, /out of 237|one in three homes|according to a listing site/, "nothing from the article's body leaks through");
  assert.doesNotMatch(all, /\b237\b/, "no article statistic reaches the planner");
  assert.strictEqual(b.article_read, undefined);
  assert.deepStrictEqual(b.figure_refs.map((f) => f.ref), ["r1.f1", "r1.f2"]);
  const sys = plan.buildSystemPrompt();
  assert.match(sys, /article_perspective is the approved article as it was read for you/);
  assert.match(sys, /SOURCING/);
  assert.match(sys, /a plan for 132 apartments is such a fact/);
  assert.doesNotMatch(sys, /article_text/);
});

test("an article that could not be read falls back to the neutralized summary and says so", () => {
  const { articleText, ...unread } = READ;
  const b = plan.topicBrief(unread);
  assert.strictEqual(b.article_read, false);
  assert.strictEqual(b.directive, undefined);
  assert.match(b.topic_question, /\[article figure\]/);
});

test("the gate checks the script after Claude read the article: a body market statistic is refused, project facts and perspective pass", () => {
  const project = { template: "local_market_insider", intake: { market: "Lincoln, CA" }, selected_topic: READ };
  const run = (text) => gate.evaluate(amLib.gateInputFor(project, amLib.attachNotice(project, { captionText: text, narrationTagged: text, scenes: [{ narrationExcerpt: text }], cta: { text: "Ask me.", source: "claude" } }), "claude"));
  const stat = run("There are 237 homes for sale and 81 of them are builder homes.");
  assert.ok(stat.blocks.some((b) => b.match === "237" || b.rule === "article_figure"), "a market statistic from the article's body is not allowed");
  assert.ok(run("The city approved a plan for 132 apartments near downtown in July.").blocks.every((b) => b.match !== "132"), "a project fact in the article's body may be stated");
  assert.deepStrictEqual(run("Price against what a builder nets, not the sticker, and sell what a builder cannot deliver.").blocks, [], "perspective is never refused");
  assert.deepStrictEqual(run("There were 93 closed sales, and homes sold at 95% of original list price.").blocks, [], "report figures pass");
});
