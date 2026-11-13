// Option 2 (Article + Trend Intelligence in B2) and the script-writer handoff for both options. Synthetic records and a stand-in model; nothing is fetched or paid for.
const test = require("node:test");
const assert = require("node:assert");
const lib = require("../netlify/functions/lib/agent-marketing-report-lib");
const rr = require("../netlify/functions/lib/agent-marketing-research-report-lib");
const ti = require("../netlify/functions/lib/agent-marketing-trend-intelligence-lib");
const b2 = require("../netlify/functions/lib/agent-marketing-b2-lib");
const plan = require("../netlify/functions/lib/agent-marketing-plan-lib");
const fx = require("./helpers/market-update-fixtures");

const records = [{ id: "A1", title: "New 600-home community approved", url: "https://news.example.org/a", published: "2026-11-01", completeness: "COMPLETE", held_findings_not_used: 0,
  findings: [{ id: "A1-F1", kind: "development", finding: "The council approved a community.", source_quotes: ["approved"], attribution: "the council", qualifications: [] }, { id: "A1-F2", kind: "timeline", finding: "Sales begin next year.", source_quotes: ["next year"], attribution: null, qualifications: [] }] }];
const articles = [{ url: "https://news.example.org/a", title: "New community", domain: "news.example.org", published: "2026-11-01", fromTopic: {} }];
const evidence = new Map([["https://news.example.org/a", { id: "ev1" }]]);
const ctxOf = (text) => rr.buildContext([{ id: "u1", facts: lib.analyzePages([text], {}).facts }], { geography: { type: "zip", name: "95747", label: "ZIP 95747" } });
function setup(text) {
  const ctx = ctxOf(text);
  const reportFigures = [...ctx.figures.values()].slice(0, 24).map((cf) => ({ ref: cf.ref, text: rr.figureText(cf) }));
  const rid = new Map(reportFigures.map((f, i) => [f.ref, `R${i + 1}`]));
  return { ctx, reportFigures, trend: ti.analyze(ctx, { refOf: (r) => rid.get(r) || r }) };
}
const model = (seen) => async (system, user) => {
  seen.push({ system, user });
  const u = JSON.parse(user);
  const ids = u.trend_intelligence ? [...u.trend_intelligence.matchAll(/^(TI\d+) /gm)].map((m) => m[1]) : [];
  const qs = ["Will a new community crowd my listing?", "Should I sell before it opens?", "What do buyers gain from more choice?", "How does pricing change near new homes?", "Is waiting a sound plan for the next move?"];
  const candidates = qs.map((q, i) => ({ id: `C${i + 1}`, question: q, article: "A1", findings: [i % 2 ? "A1-F2" : "A1-F1"], mechanism: `Mechanism ${i}`, homeowner_implication: `Implication ${i}`, editorial_angle: `Angle ${i}`, audience_journey: "Over the coming years.", why_it_matters: "Matters.",
    report_figures: ["R1", "R3"], ...(ids.length ? { trend_observations: [ids[i % ids.length]], trend_interpretation: `The new homes arrive into a market where ${ids[i % ids.length]} applies.` } : {}) }));
  return JSON.stringify({ candidates, selected: candidates.map((c) => c.id) });
};

test("Option 2: B2 is given the shared Trend Intelligence analysis, and every topic keeps the article, the interpretation and the report figures", async () => {
  const { reportFigures, trend } = setup(fx.marketUpdate());
  const seen = [];
  const out = await b2.generate({ records, articles, evidence, mode: "article_report", market: "ZIP 95747", audience: "sellers", reportFigures, trend, callFn: model(seen), anthropicKey: "k", reportSource: { type: "report" } });
  assert.match(seen[0].system, /TREND INTELLIGENCE/);
  assert.match(seen[0].user, /trend_intelligence/);
  assert.strictEqual(out.topics.length, 5);
  out.topics.forEach((t) => {
    assert.strictEqual(t.b2.article.url, "https://news.example.org/a");           // the article stays the central story
    assert.ok(t.b2.sourceRefs.length >= 1);
    assert.ok(t.b2.trendObservationRefs.length >= 1 && t.b2.trendInterpretation);
    assert.ok(t.b2.trendIntelligence.observations[0].evidence.every((e) => /^R\d+$/.test(e.ref)));
    assert.ok(t.b2.homeownerImplication && t.b2.audienceJourney && t.b2.editorialAngle && t.b2.reportFigureRefs.length);
  });
});

test("Option 3 (no report) and an unusable report leave B2's prompt without any Trend Intelligence", async () => {
  const seen = [];
  const out = await b2.generate({ records, articles, evidence, mode: "article_editorial", market: "ZIP 95747", audience: "sellers", reportFigures: [], trend: null, callFn: model(seen), anthropicKey: "k" });
  assert.ok(!/TREND INTELLIGENCE|trend_intelligence/.test(seen[0].system + seen[0].user));
  assert.ok(out.topics.every((t) => !t.b2.trendIntelligence && !t.b2.trendObservationRefs));
});

test("Option 1 and Option 2 use the same Trend Intelligence implementation", () => {
  const ed = require("../netlify/functions/lib/agent-marketing-report-editorial-lib");
  const tiPath = require.resolve("../netlify/functions/lib/agent-marketing-trend-intelligence-lib");
  assert.ok(require.cache[tiPath]);
  assert.strictEqual(require("../netlify/functions/lib/agent-marketing-trend-intelligence-lib"), ti);
  assert.ok(/ti\.analyze/.test(ed.generate.toString()) && /ti\.analyze/.test(require("fs").readFileSync(require.resolve("../netlify/functions/lib/agent-marketing-b2-lib"), "utf8")));
});

test("script writer handoff: Option 2 carries article direction plus market interpretation; Option 1 carries trend commentary", async () => {
  const { reportFigures, trend, ctx } = setup(fx.marketUpdate());
  const out = await b2.generate({ records, articles, evidence, mode: "article_report", market: "ZIP 95747", audience: "sellers", reportFigures, trend, callFn: model([]), anthropicKey: "k", reportSource: { type: "report" } });
  const t2 = { ...out.topics[0], reportFigures: [...ctx.figures.values()].map((cf) => ({ text: rr.figureText(cf) })) };
  const env = { AGENT_MARKETING_B1_EVIDENCE: "dev" };
  const b2brief = plan.topicBrief(t2, env);
  assert.strictEqual(b2brief.editorial_direction.kind, "article_story_with_market_interpretation");
  assert.ok(b2brief.editorial_direction.article.title && b2brief.editorial_direction.homeowner_implication);
  const mi = b2brief.editorial_direction.market_interpretation;
  assert.ok(mi.relationships[0].evidence.length >= 1 && mi.realtor_readings.length && mi.reporting_area_and_period[0].period === "October 2026");
  assert.ok(b2brief.figures_you_may_state.length > 0);
  // Option 1 topic (built by the report-only generator)
  const ed = require("../netlify/functions/lib/agent-marketing-report-editorial-lib");
  const o1 = await ed.generate({ ctx, market: "ZIP 95747", audience: "sellers", today: "2026-11-09", anthropicKey: "k", callFn: async (s, user) => {
    const obs = [...user.matchAll(/^(TI\d+) [^\n]*\n((?:   evidence [^\n]*\n?)+)/gm)].map((m) => ({ id: m[1], figs: [...m[2].matchAll(/evidence (r\d+\.f\d+):/g)].map((x) => x[1]) }));
    const first = obs[0].figs;
    const cands = obs.slice(0, 4).map((o, i) => ({ id: `C${i + 1}`, question: ["Is my neighborhood getting crowded?", "When would waiting cost me?", "Who has leverage in this market?", "What changed since last year for sellers?"][i], relationships: [o.id], report_figures: [...new Set(o.figs.concat(first))], realtor_interpretation: "Reading.", homeowner_implication: "Implication.", audience_journey: "Journey.", editorial_angle: "Angle.", why_it_matters: "Why." }));
    return JSON.stringify({ candidates: cands, selected: cands.map((c) => c.id) });
  } });
  const b1brief = plan.topicBrief(o1.topics[0], env);
  assert.strictEqual(b1brief.editorial_direction.kind, "trend_commentary");
  assert.ok(!b1brief.editorial_direction.article);
  assert.ok(b1brief.editorial_direction.market_interpretation.relationships.length);
  assert.ok(b1brief.figures_you_may_state.length >= 2);
  // flag off: the planner sees neither
  assert.ok(!plan.topicBrief(o1.topics[0], {}).editorial_direction);
  assert.ok(/2l\. MARKET INTERPRETATION/.test(plan.buildSystemPrompt(env)) && !/2l\. MARKET INTERPRETATION/.test(plan.buildSystemPrompt({})));
});

test("development only: a 60-second Reel targets 140-155 words; 30 and 45 and Production are unchanged", () => {
  const am = require("../netlify/functions/lib/agent-marketing-lib");
  assert.deepStrictEqual([am.wordTargets(30, {}), am.wordTargets(45, {}), am.wordTargets(60, {})], [[55, 70], [105, 125], [110, 130]]);
  const dev = { AGENT_MARKETING_B1_EVIDENCE: "dev" };
  assert.deepStrictEqual([am.wordTargets(30, dev), am.wordTargets(45, dev), am.wordTargets(60, dev)], [[55, 70], [105, 125], [140, 155]]);
  assert.deepStrictEqual(am.WORD_TARGETS[60], [110, 130]);
});
