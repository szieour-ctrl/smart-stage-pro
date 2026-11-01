// Run with: npm test
// PR 2 review, finding 5: the temporary MLS handoff. applyReportPrecedence() is used only as compatibility with the legacy Planner and gate. These tests
// pin what must stay true: external market statistics are not authorized for local publication, the editorial card survives, and missing or truncated
// MLS evidence is never represented as complete. The structured evidence registry and the full Article-Led Planner integration are future PRs.
const test = require("node:test");
const assert = require("node:assert");
const al = require("../netlify/functions/lib/agent-marketing-article-led-lib");
const run = require("../netlify/functions/lib/agent-marketing-research-run-lib");
const plan = require("../netlify/functions/lib/agent-marketing-plan-lib");
const gate = require("../netlify/functions/lib/agent-marketing-gate");
const amLib = require("../netlify/functions/lib/agent-marketing-lib");
const reportLib = require("../netlify/functions/lib/agent-marketing-report-lib");
const rt = require("../netlify/functions/lib/agent-marketing-research-report-lib");
const tv = require("./helpers/trend-fixture");
const fx = require("./fixtures/research-diag/scenarios");

const NOW = fx.NOW, ON = { AGENT_MARKETING_ARTICLE_LED_ENABLED: "true", AGENT_MARKETING_ARTICLE_LED_DESIGN: "detailed", AGENT_MARKETING_RESEARCH_RETRIES: "0" };
const quiet = async (fn) => { const e = console.error; console.error = () => {}; try { return await fn(); } finally { console.error = e; } };
const ID = "11111111-1111-4111-8111-111111111111";
const GEO_ZIP = { type: "zip", name: "95999", city: "", state: "CA", label: "ZIP 95999, CA" };
const facts = () => { const f = reportLib.analyzePages(tv.standard().pages).facts; f.mlsSource = "MetroList"; return f; };
const WHY = "It changes what nearby sellers compete with this winter season, and how long they should expect to wait for offers.";
const opp = (i, over) => ({
  question: ["Could the 122 planned homes change what nearby sellers face?", "Why did the city approve a second apartment site?", "What do higher rates mean for move-up buyers here?", "Is the school calendar shifting listing timing?", "Which price bands saw pending sales slip?"][i - 1],
  headline: "h", editorial_thesis: "The development adds competing supply, so pricing around it matters.", why_it_matters: WHY, homeowner_decision: "List now or wait.", development: `Development ${i}`, angle: `Angle ${i}`,
  geographic_relationship: "exact_market", route_to_market: null, status: "unverified", status_evidence: null, action_date: "2026-10-10", status_checked_date: null,
  established_facts: ["The council discussed it."], possible_explanations: ["Supply could soften prices."], project_facts: [{ fact: "122 homes are planned", source: 1, basis: "source_stated" }],
  evidence_points: [{ text: "122 homes planned", area: "ZIP 95999", period: "October 2026", source: 1 }, { text: "Sacramento County active listings were 2,523", area: "Sacramento County", period: "September 2026", source: 1 }],
  evidence_gaps: ["Phasing is unknown."], verification_needs: ["Confirm the unit count."], access_confidence: "medium", keyword_match: false,
  sources: [{ title: `Story ${i} in ZIP 95999`, url: `https://news${i}.example/story-${i}`, published: "2026-10-18", role: "secondary", kind: "local_news", source_geography: "ZIP 95999", reporting_period: "October 2026", what_it_establishes: "Reports the project." }], ...(over || {}),
});
const reply = (opps) => ({ status: 200, json: { output: [{ type: "search_results", results: opps.flatMap((o) => o.sources.map((s) => ({ url: s.url }))) },
  { type: "message", content: [{ type: "output_text", text: "```json\n" + JSON.stringify({ research_limits: { returned: opps.length, reason: null }, opportunities: opps }) + "\n```" }] }], usage: fx.usage(1) } });
const five = () => [1, 2, 3, 4, 5].map((i) => opp(i));
const row = (src, refs) => ({ id: "r1", mode: "market_update", audience: "sellers", geography: GEO_ZIP, focus: {}, data_source: src, upload_refs: refs || [] });
const refs = [{ id: ID, scope_note: "MetroList market-trends report, ZIP 95999, September 2026" }];
const go = (r, uploads) => quiet(() => run.runResearch({ row: r, uploads, apiKey: "k", anthropicKey: "k", now: NOW, env: ON, sleepFn: async () => {}, callFn: async () => reply(five()), claudeFn: async () => { throw new Error("must not be called"); } }));

const gateRun = (topic, text) => {
  const project = { template: "local_market_insider", intake: { market: "ZIP 95999" }, selected_topic: topic };
  return gate.evaluate(amLib.gateInputFor(project, amLib.attachNotice(project, { captionText: text, narrationTagged: text, scenes: [{ narrationExcerpt: text }], cta: { text: "Ask me.", source: "claude" } }), "claude"));
};

// ── External market statistics stay unauthorized for local publication ─────────────────────────────
for (const [label, attached] of [["no report attached", false], ["a report attached", true]]) {
  test(`external market statistics are not authorized for publication (${label}); the article's project fact still is`, async () => {
    const r = attached ? await go(row("both", refs), [{ id: ID, facts: facts() }]) : await go(row("web"));
    const topic = r.fields.topics[0];
    assert.strictEqual(topic.reportFirst, true); assert.strictEqual(topic.externalStatisticsAuthorized, false);
    assert.strictEqual(topic.editorial.qualification.externalMarketStatistics, "not_authorized_for_publication");
    const verified = gate.verifiedFromTopic(topic);
    assert.ok(!verified.texts.some((t) => /2,523/.test(t)), "the county listing statistic is not verified text");
    const brief = plan.topicBrief(topic);
    assert.ok(!JSON.stringify(brief).includes("2,523"), "the planner is not handed the external statistic");
    assert.ok(JSON.stringify(brief).includes("122 homes planned"), "a project fact reaches the planner");
    const bad = gateRun(topic, "Sacramento County active listings were 2,523 in September.");
    assert.ok(bad.blocks.some((b) => b.rule === "invented_number" && /2,?523/.test(b.match)), "an external market statistic is blocked");
    assert.ok(!gateRun(topic, "A project with 122 homes is planned.").blocks.some((b) => b.rule === "invented_number"), "the project fact is allowed");
    if (attached) {
      const fig = topic.reportFigures[0];
      assert.ok(fig && fig.text, "the report's own figures are the numbers a script may use");
      assert.ok(!gateRun(topic, fig.text).blocks.some((b) => b.rule === "invented_number"));
    } else assert.deepStrictEqual(topic.reportFigures, [], "no report, no market figures at all");
  });
}

// ── The editorial card is preserved ────────────────────────────────────────────────────────────
test("the editorial card is unchanged by the MLS attachment and survives freezing on the project", async () => {
  const web = await go(row("web"));
  const both = await go(row("both", refs), [{ id: ID, facts: facts() }]);
  for (let i = 0; i < 5; i++) {
    const { mlsEvidence: _w, ...a } = web.fields.topics[i].editorial, { mlsEvidence: _b, ...b } = both.fields.topics[i].editorial;
    assert.deepStrictEqual(b, a, `card ${i + 1}`);
    assert.strictEqual(both.fields.topics[i].discovery, "v2"); assert.deepStrictEqual(both.fields.topics[i].sources, web.fields.topics[i].sources);
  }
  assert.ok(both.fields.topics[0].editorial.thesis && both.fields.topics[0].editorial.qualification.publicationAuthorized === false);
  // selecting a topic freezes it with `{ ...topic, researchId, ... }` (agent-marketing-research.js): the card is carried whole
  const frozen = { ...both.fields.topics[0], researchId: "x", researchDate: "2026-10-24", mode: "market_update" };
  assert.deepStrictEqual(frozen.editorial, both.fields.topics[0].editorial);
});

// ── Missing or truncated MLS evidence is never represented as complete ─────────────────────────────
test("MLS evidence status: none attached, unreadable, truncated and read-figures-included are told apart, and none says complete", async () => {
  assert.deepStrictEqual(["none_attached", "unreadable_or_missing", "truncated", "read_figures_included"].map((s) => s),
    [al.mlsEvidenceOf({ requested: false }).status, al.mlsEvidenceOf({ requested: true, available: 0, included: 0 }).status, al.mlsEvidenceOf({ requested: true, available: 60, included: 40 }).status, al.mlsEvidenceOf({ requested: true, available: 12, included: 12 }).status]);
  for (const e of [al.mlsEvidenceOf({ requested: false }), al.mlsEvidenceOf({ requested: true, available: 0, included: 0 }), al.mlsEvidenceOf({ requested: true, available: 60, included: 40 }), al.mlsEvidenceOf({ requested: true, available: 12, included: 12 })]) {
    assert.strictEqual(e.complete, false); assert.ok(!/\bcomplete\b/i.test(e.note.replace(/not verified|completeness/gi, "")) || /not verified/.test(e.note));
  }
  assert.ok(/Whether the reader found every figure in the report is not verified/.test(al.mlsEvidenceOf({ requested: true, available: 12, included: 12 }).note));
  assert.strictEqual(al.mlsEvidenceNote([al.mlsEvidenceOf({ requested: true, available: 12, included: 12 })]), null);
  assert.ok(/Only 40 of 60 figures/.test(al.mlsEvidenceNote([al.mlsEvidenceOf({ requested: true, available: 60, included: 40 })])));
});

test("a report attached with usable figures: every opportunity says read figures were included, not that the evidence is complete; no note is added", async () => {
  const r = await go(row("both", refs), [{ id: ID, facts: facts() }]);
  const ev = r.fields.topics[0].mlsEvidence;
  assert.strictEqual(ev.status, "read_figures_included"); assert.strictEqual(ev.complete, false); assert.ok(ev.figuresAvailable > 0 && ev.included === ev.figuresAvailable);
  assert.ok(r.fields.topics.every((t) => t.mlsEvidence.status === "read_figures_included"));
  assert.ok(!r.fields.usage.reportNote, "nothing to warn about");
});

test("a report attached but unreadable: the opportunities say so and the agent is told; nothing claims MLS figures are available", async () => {
  const r = await go(row("both", refs), [{ id: ID, facts: { figures: [] } }]);
  assert.strictEqual(r.fields.status, "ready"); assert.strictEqual(r.fields.topics.length, 5);
  assert.ok(r.fields.topics.every((t) => t.mlsEvidence.status === "unreadable_or_missing" && t.reportFigures.length === 0 && t.mlsEvidence.complete === false));
  assert.ok(/no usable figures could be read from it/.test(r.fields.usage.reportNote));
  const missing = await go(row("both", refs), []);   // the upload row was not found at all
  assert.ok(missing.fields.topics.every((t) => t.mlsEvidence.status === "unreadable_or_missing"));
});

test("a report with more figures than an opportunity carries is reported as truncated, with the counts", async () => {
  const f = facts();
  const total = rt.buildContext([{ id: ID, facts: f }], { audience: "sellers", geography: GEO_ZIP, focus: {} }).figures.size;
  // inflate the report past the 40-figure ceiling of the legacy attachment
  const many = { ...f, figures: Array.from({ length: 45 }, (_, i) => ({ ...f.figures[i % f.figures.length], id: `x${i}` })) };
  const ctx = rt.buildContext([{ id: ID, facts: many }], { audience: "sellers", geography: GEO_ZIP, focus: {} });
  assert.ok(ctx.figures.size > 40 && total > 0);
  const r = await go(row("both", refs), [{ id: ID, facts: many }]);
  const ev = r.fields.topics[0].mlsEvidence;
  assert.deepStrictEqual([ev.status, ev.included, ev.figuresAvailable, ev.complete], ["truncated", 40, ctx.figures.size, false]);
  assert.ok(new RegExp(`Only 40 of ${ctx.figures.size} figures`).test(r.fields.usage.reportNote));
});

test("a partial Article-Led set keeps both notes: the limitation and the MLS evidence status", async () => {
  const r = await quiet(() => run.runResearch({ row: row("both", refs), uploads: [{ id: ID, facts: { figures: [] } }], apiKey: "k", anthropicKey: "k", now: NOW, env: ON, sleepFn: async () => {}, callFn: async () => reply([opp(1), opp(2)]) }));
  assert.ok(/Only 2 of 5/.test(r.fields.usage.reportNote) && /no usable figures could be read/.test(r.fields.usage.reportNote) && /MLS Market Trend Reel/.test(r.fields.usage.reportNote));
  assert.strictEqual(r.fields.charged_at, null);
});

test("the handoff is compatibility only: the structured registry and the full Article-Led Planner are documented as future PRs", () => {
  const doc = require("fs").readFileSync(require("path").join(__dirname, "..", "docs", "article-led-discovery.md"), "utf8");
  assert.ok(/applyReportPrecedence/.test(doc) && /compatibility with the legacy Planner/i.test(doc));
  assert.ok(/structured evidence registry/i.test(doc) && /future PR/i.test(doc));
});
