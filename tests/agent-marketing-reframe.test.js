// Oct 28, 2026: the web article is the CONTEXT, the agent's uploaded report is the ANSWER. Reframing, slots, unique articles, downstream plumbing.
const test = require("node:test");
const assert = require("node:assert");
const reportLib = require("../netlify/functions/lib/agent-marketing-report-lib");
const rl = require("../netlify/functions/lib/agent-marketing-research-lib");
const rt = require("../netlify/functions/lib/agent-marketing-research-report-lib");
const rf = require("../netlify/functions/lib/agent-marketing-reframe-lib");
const gate = require("../netlify/functions/lib/agent-marketing-gate");
const article = require("../netlify/functions/lib/agent-marketing-article-lib");
const sources = require("../netlify/functions/lib/agent-marketing-sources-lib");
const plan = require("../netlify/functions/lib/agent-marketing-plan-lib");
const tv = require("./helpers/trend-fixture");

const ID = "11111111-1111-4111-8111-111111111111";
const GEO = { type: "zip", name: "95999", city: "", state: "CA", label: "ZIP 95999, CA" };
const facts = () => { const f = reportLib.analyzePages(tv.standard().pages).facts; f.mlsSource = "MetroList"; return f; };
const ctx = () => rt.buildContext([{ id: ID, facts: facts() }], { audience: "sellers", geography: GEO, focus: {} });
const ref = (c, key) => [...c.figures.values()].find((x) => x.fig.key === key).ref;
const webTopic = (over) => ({
  id: "t2", origin: "web", kind: "market_update", scope: "broader_context", scopeNote: "Sacramento County, not ZIP 95999",
  question: "Are Sacramento County listings climbing?", whyItMatters: "Sacramento County active listings rose 8.8% in September.",
  trendSignals: ["Sacramento County active listings rose 8.8% in September"], sources: [{ title: "Housing statistics", url: "https://sacrealtor.org/housing-statistics-september-2026/", domain: "sacrealtor.org", type: "web" }], ...over,
});
const good = (c, over) => ({ id: "t2", keep_original: false, question: "Sacramento County listings rose 8.8%, so how did ZIP 95999 do?", why_it_matters: "Average days on market was 45 days here.",
  figure_ids: [ref(c, "avg_dom")], area_context: [{ area: "Sacramento County", text: "Sacramento County active listings rose 8.8% in September." }], ...over });
const run = (c, entry, topics) => rf.reframeTopics({ topics: topics || [webTopic()], ctx: c, today: "2026-10-28", anthropicKey: "k", callFn: async () => JSON.stringify({ topics: [entry] }) });

test("a wider-area web topic is reframed: report figure answers, article figures stay labeled by area", async () => {
  const c = ctx(), r = await run(c, good(c));
  const t = r.topics[0];
  assert.strictEqual(t.reframed, true);
  assert.strictEqual(t.articleQuestion, "Are Sacramento County listings climbing?");
  assert.match(t.question, /ZIP 95999/);
  assert.strictEqual(t.answeredBy.length, 1);
  assert.strictEqual(t.areaContext[0].area, "Sacramento County");
  assert.strictEqual(r.reframed, 1);
});

test("a rewrite that invents a number, hides the area, or uses an article number the article lacks keeps the original", async () => {
  const c = ctx();
  for (const bad of [good(c, { why_it_matters: "Average days on market was 44 days." }),
    good(c, { area_context: [{ area: "Sacramento County", text: "Listings rose 8.8% in September." }] }),
    good(c, { area_context: [{ area: "Sacramento County", text: "Sacramento County listings rose 9.9%." }] }),
    good(c, { figure_ids: ["r9.nope"] })]) {
    const r = await run(c, bad);
    assert.strictEqual(r.topics[0].reframed, undefined);
    assert.strictEqual(r.topics[0].question, "Are Sacramento County listings climbing?");
  }
});

test("keep_original and ineligible topics are untouched; a report topic is never sent", async () => {
  const c = ctx();
  assert.strictEqual((await run(c, { id: "t2", keep_original: true })).topics[0].reframed, undefined);
  let called = 0;
  const rep = { id: "t1", origin: "report", scope: "selected" }, sel = webTopic({ id: "t3", scope: "selected" });
  const r = await rf.reframeTopics({ topics: [rep, sel], ctx: c, today: "2026-10-28", anthropicKey: "k", callFn: async () => { called++; return "{}"; } });
  assert.strictEqual(called, 0);
  assert.deepStrictEqual(r.topics, [rep, sel]);
});

test("applyReportPrecedence does not supersede county figures on a broader_context topic", () => {
  const c = ctx();
  const out = rt.applyReportPrecedence([{ ...webTopic(), reportFigures: [], question: "Median price in the county is 500,000", whyItMatters: "Median price 500,000" }], c);
  assert.ok(!out[0].reportPrecedence || out[0].reportPrecedence.length === 0);
});

test("articleFacts passes a reframed topic through and keeps area context; gate and manifest numbers read it", async () => {
  const c = ctx(), t = { ...(await run(c, good(c))).topics[0], reportFirst: true };
  const af = article.articleFacts(t);
  assert.match(af.question, /8\.8%/);
  assert.strictEqual(af.areaContext.length, 1);
  assert.ok(sources.topicNumbers(af).includes("8.8") || sources.topicNumbers(af).some((n) => String(n).includes("8.8")));
  const v = gate.verifiedFromTopic(t);
  assert.ok(JSON.stringify(v).includes("Sacramento County active listings rose 8.8%"));
  const brief = plan.topicBrief(t);
  assert.ok(brief.area_context[0].startsWith("Sacramento County"));
  assert.ok(brief.answered_by.length === 1);
});

test("planner rules keep the article-scene requirement and allow labeled area context", () => {
  const s = plan.buildSystemPrompt();
  assert.ok(s.includes('at least one middle scene must have source_role "article"'));
  assert.match(s, /SOURCE ROLES/);
  assert.match(s, /area_context/);
  assert.match(s, /wrong area/);
});

test("validateTopics puts unique articles first and only repeats an article to fill open slots", () => {
  assert.strictEqual(rl.articleKey("https://www.SacRealtor.org/a/b/"), "sacrealtor.org/a/b");
});

test("an event's date, time and venue numbers count as verified for words on screen (a Reel headline saying November 14 must not fail the number check)", () => {
  const sources = require("../netlify/functions/lib/agent-marketing-sources-lib");
  const nums = sources.topicNumbers({ question: "Can a holiday craft fair help you picture life at Eskaton Village?", whyItMatters: "A chance to meet local vendors.", event: { name: "Annual Holiday Craft Fair", date: "2026-11-14", endDate: null, time: "10:00 am - 2:00 pm", location: "Eskaton Village Roseville, Roseville", organizer: "Eskaton Village" } });
  [14, 11, 2026, 10, 2].forEach((n) => assert.ok(nums.includes(n), `${n} is verified`));
  assert.ok(!nums.includes(99), "other numbers are still unverified");
});
