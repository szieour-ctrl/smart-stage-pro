// Option 1, Agent Market Update: report-only editorial questions from the shared Trend Intelligence analysis. No web research, no articles.
const test = require("node:test");
const assert = require("node:assert");
const lib = require("../netlify/functions/lib/agent-marketing-report-lib");
const run = require("../netlify/functions/lib/agent-marketing-research-run-lib");
const ed = require("../netlify/functions/lib/agent-marketing-report-editorial-lib");
const fx = require("./helpers/market-update-fixtures");

const ID = "22222222-2222-4222-8222-222222222222";
const GEO = { type: "zip", name: "95747", city: "", state: "CA", label: "ZIP 95747, CA" };
const NOW = "2026-11-09T17:00:00Z";
const DEV = { AGENT_MARKETING_B1_EVIDENCE: "dev" };
const row = (over) => ({ id: "r1", mode: "market_update", audience: "sellers", geography: GEO, focus: { marketUpdateMode: "trend_report" }, data_source: "upload", upload_refs: [{ id: ID, scope_note: "Market update" }], ...over });
const uploadsOf = (text) => [{ id: ID, facts: lib.analyzePages([text], {}).facts }];
// A stand-in for the model: reads the analysis it is shown and writes one candidate per relationship, citing that relationship's own evidence.
const QS = ["Should sellers worry that #?", "How should a homeowner plan around the fact that #?", "What do buyers read into #?", "Does anyone gain when #?", "When would a family decide after #?", "Why does # matter to a move next year?", "Who benefits right now from #?", "What would a careful Realtor watch after #?"];
function modelFor(seen) {
  return async (system, user) => {
    seen.push({ system, user });
    const obs = [...user.matchAll(/^(TI\d+) \[[^\]]*\] ([^\n]*)\n((?:   evidence [^\n]*\n?)+)/gm)].map((m) => ({ id: m[1], title: m[2], figs: [...m[3].matchAll(/evidence (r\d+\.f\d+):/g)].map((x) => x[1]) }));
    const candidates = obs.slice(0, 8).map((o, i) => ({ id: `C${i + 1}`, question: QS[i % QS.length].replace("#", o.title.toLowerCase()), relationships: [o.id], report_figures: [...new Set(o.figs.concat(obs[0].figs))].slice(0, 3),
      realtor_interpretation: `Interpretation of ${o.title}.`, homeowner_implication: `Homeowner implication ${i + 1}.`, audience_journey: "Matters now and over the next few years.", editorial_angle: `Angle ${i + 1}: ${o.title}`, why_it_matters: `Why ${i + 1} matters.` }));
    return JSON.stringify({ candidates, selected: candidates.slice(0, 5).map((c) => c.id), selection_notes: "strongest relationships first" });
  };
}
const go = (text, over) => { const seen = []; let web = 0; return run.runResearch({ row: row(over && over.row), uploads: uploadsOf(text), anthropicKey: "k", callFn: async () => { web++; throw new Error("Perplexity must not be called"); }, claudeFn: modelFor(seen), now: NOW, env: (over && over.env) || DEV }).then((r) => ({ r, seen, web: () => web })); };

test("Option 1 uses only the report: no Perplexity call, one Claude call, three to five relationship-based topics", async () => {
  const { r, seen, web } = await go(fx.marketUpdate());
  assert.strictEqual(web(), 0);
  assert.strictEqual(seen.length, 1);
  assert.strictEqual(r.fields.status, "ready", JSON.stringify(r.fields.error));
  const topics = r.fields.topics;
  assert.ok(topics.length >= 3 && topics.length <= 5);
  assert.ok(r.fields.charged_at);
  topics.forEach((t) => {
    assert.strictEqual(t.origin, "report");
    assert.strictEqual(t.reportFirst, true);
    assert.strictEqual(t.b2.mode, "trend_report");
    assert.ok(t.b2.trendIntelligence.observations.length >= 1);
    assert.ok(t.reportFigures.length >= 2, "a question rests on a relationship, so on more than one figure");
    assert.ok(t.b2.homeownerImplication && t.b2.audienceJourney && t.b2.realtorInterpretation && t.b2.editorialAngle);
    assert.match(t.reportNotice, /MetroList Services/);
    assert.strictEqual(t.scope, "selected");
  });
  assert.match(seen[0].user, /TREND INTELLIGENCE[\s\S]*evidence r1\.f\d+:/);
  assert.ok(!/article|perplexity/i.test(seen[0].user));
  assert.strictEqual(r.fields.usage.option1.state, "ready");
});

test("Option 1 stops without charging when the report has nothing to interpret, or the answer cites no real relationship", async () => {
  const bad = await run.runResearch({ row: row(), uploads: uploadsOf(fx.marketUpdate()), anthropicKey: "k", claudeFn: async () => JSON.stringify({ candidates: [{ id: "C1", question: "A question?", relationships: ["TI99"], report_figures: ["r1.f1"] }], selected: ["C1"] }), now: NOW, env: DEV });
  assert.strictEqual(bad.fields.status, "failed");
  assert.strictEqual(bad.fields.charged_at, null);
  assert.match(bad.fields.error, /did not use a session/);
  const dead = await run.runResearch({ row: row(), uploads: uploadsOf(fx.marketUpdate()), anthropicKey: "k", claudeFn: async () => { throw new Error("down"); }, now: NOW, env: DEV });
  assert.strictEqual(dead.fields.status, "failed");
  assert.strictEqual(dead.fields.charged_at, null);
});

test("different reports give different perspectives, from the same Trend Intelligence implementation", async () => {
  const loose = await go(fx.marketUpdate());
  const tight = await go(fx.marketUpdate({ active: [180, 120], closed: [90, 118], pended: [80, 104], months: [1.5, 0.9], dom: [30, 21], sl: [99, 101], price: [600, 640] }));
  assert.notStrictEqual(loose.r.fields.usage.option1.character, tight.r.fields.usage.option1.character);
  const angles = (x) => x.r.fields.topics.map((t) => t.b2.editorialAngle).join("|");
  assert.notStrictEqual(angles(loose), angles(tight));
  const kinds = (x) => x.r.fields.topics.map((t) => t.b2.trendIntelligence.observations[0].kind + ":" + t.b2.trendIntelligence.observations[0].signal).sort().join("|");
  assert.notStrictEqual(kinds(loose), kinds(tight));
  const ti = require("../netlify/functions/lib/agent-marketing-trend-intelligence-lib");
  assert.strictEqual(ed.generate.toString().includes("ti.analyze"), true);
  assert.strictEqual(typeof ti.analyze, "function");
});

test("a county report asked about a city says its figures are wider, and the topics become broader context", async () => {
  const f = lib.analyzePages([fx.DOMUS_TEXT], { items: fx.DOMUS_ITEMS }).facts;
  const r = await run.runResearch({ row: row({ geography: { type: "city", name: "Roseville", county: "Placer County", label: "Roseville, CA" } }), uploads: [{ id: ID, facts: f }], anthropicKey: "k", claudeFn: modelFor([]), now: NOW, env: DEV });
  assert.strictEqual(r.fields.status, "ready", String(r.fields.error));
  assert.ok(r.fields.topics.every((t) => t.scope === "broader_context" && /wider than Roseville/.test(t.scopeNote)));
});

test("the development switch off leaves report-only research exactly as it was", async () => {
  const seen = [];
  const r = await run.runResearch({ row: row(), uploads: uploadsOf(fx.marketUpdate()), anthropicKey: "k", claudeFn: async (s, u) => { seen.push(u); return JSON.stringify({ topics: [] }); }, now: NOW, env: {} });
  assert.ok(!seen.some((u) => /TREND INTELLIGENCE/.test(u)));
  assert.strictEqual(r.fields.status, "failed");
});

test("Option 3 (article editorial, no report) is untouched by Option 1", () => {
  assert.strictEqual(ed.applies({ mode: "market_update", focus: { marketUpdateMode: "article_editorial" }, data_source: "web" }, DEV), false);
  assert.strictEqual(ed.applies({ mode: "market_update", focus: { marketUpdateMode: "article_report" }, data_source: "both" }, DEV), false);
  assert.strictEqual(ed.applies({ mode: "market_update", focus: { marketUpdateMode: "trend_report" }, data_source: "upload" }, {}), false);
  assert.strictEqual(ed.applies({ mode: "market_update", focus: { marketUpdateMode: "trend_report" }, data_source: "upload" }, DEV), true);
});
