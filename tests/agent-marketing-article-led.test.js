// Run with: npm test
// PR 2: Article-Led discovery v2 (behind AGENT_MARKETING_ARTICLE_LED_ENABLED). Flag-off behavior is covered by the golden tests in
// agent-marketing-research-diag.test.js, which must stay identical.
const test = require("node:test");
const assert = require("node:assert");
const run = require("../netlify/functions/lib/agent-marketing-research-run-lib");
const rl = require("../netlify/functions/lib/agent-marketing-research-lib");
const al = require("../netlify/functions/lib/agent-marketing-article-led-lib");
const fx = require("./fixtures/research-diag/scenarios");

const NOW = fx.NOW;                                   // 2026-10-24
const ON = { AGENT_MARKETING_ARTICLE_LED_ENABLED: "true" };
const quiet = async (fn) => { const e = console.error; console.error = () => {}; try { return await fn(); } finally { console.error = e; } };
const noSleep = async () => {};
const row = { id: "r1", mode: "market_update", audience: "sellers", geography: fx.GEO.lincoln, focus: {}, upload_refs: [], data_source: "web" };

const Q = ["Could Parkwood's 122 homes change what Lincoln sellers face?", "Why did the city approve a second apartment site this fall?", "What do higher mortgage rates mean for move-up buyers here?", "Is a new school calendar shifting when families list?", "Which price bands saw pending sales slip last month?", "Are builder incentives pulling buyers from resale homes?", "What changed in the city's fee schedule for new permits?", "Did the county's new housing element reach Lincoln owners?"];
const src = (i, over) => ({ title: `Story ${i}`, url: `https://news${i}.example/story-${i}`, published: "2026-10-18", role: "secondary", kind: "local_news", source_geography: "Lincoln, CA", reporting_period: "October 2026", what_it_establishes: "Reports the development and the council's role.", ...(over || {}) });
const opp = (i, over) => ({
  question: Q[i - 1], headline: `Headline ${i}`, editorial_thesis: "The development adds competing supply, so pricing around it matters for sellers.", why_it_matters: "It changes what nearby sellers compete with this winter season.",
  homeowner_decision: "Whether to list now or wait.", development: `Development ${i}`, angle: `Angle ${i}`, geographic_relationship: "exact_market", route_to_market: null,
  status: "unverified", status_evidence: null, action_date: "2026-10-10", status_checked_date: null,
  established_facts: ["The council discussed the project."], possible_explanations: ["Added supply could soften asking prices."], project_facts: [], evidence_points: [{ text: "122 homes planned", area: "Lincoln", period: "October 2026", source: 1 }],
  evidence_gaps: ["Phasing is not stated."], verification_needs: ["Confirm the unit count in the approved agreement."], access_confidence: "medium", keyword_match: false, sources: [src(i)], ...(over || {}),
});
const urlsOf = (opps) => opps.flatMap((o) => (o.sources || []).map((s) => s.url));
// No provider dates on purpose: the model's own dates are judged (the provider's date would replace them).
const reply2 = (opps, extra) => ({ status: 200, json: { output: [
  { type: "search_results", results: urlsOf(opps).map((u) => ({ url: u })) },
  { type: "message", content: [{ type: "output_text", text: "```json\n" + JSON.stringify({ research_limits: { returned: opps.length, reason: null }, opportunities: opps, ...(extra || {}) }) + "\n```" }] }], usage: fx.usage(1) } });

async function go(answers, over) {
  const left = answers.slice(); const sent = [];
  const callFn = async (p) => { sent.push(JSON.parse(JSON.stringify(p))); return left.shift() || answers[answers.length - 1]; };
  const r = await quiet(() => run.runResearch({ row: (over && over.row) || row, apiKey: "k", now: NOW, env: (over && over.env) || ON, sleepFn: noSleep, callFn, claudeFn: over && over.claudeFn }));
  return { r, sent };
}
const five = () => [1, 2, 3, 4, 5].map((i) => opp(i));
const attempt = (r, n = 0) => r.fields.usage.discovery.attempts[n];

// ── Flag and routing ───────────────────────────────────────────────────────────────────────────
test("the pathway applies only with the flag on, to a Market Update that is not report-only", () => {
  const req = (mode, dataSource) => ({ mode, dataSource });
  assert.strictEqual(al.isArticleLed(req("market_update", "web"), ON), true);
  assert.strictEqual(al.isArticleLed(req("market_update", "both"), ON), true);
  assert.strictEqual(al.isArticleLed(req("market_update", "upload"), ON), false);   // report-only stays the MLS Market Trend pathway
  assert.strictEqual(al.isArticleLed(req("local_events", "web"), ON), false);
  assert.strictEqual(al.isArticleLed(req("market_update", "web"), {}), false);
  for (const v of ["0", "false", "off", ""]) assert.strictEqual(al.articleLedEnabled({ AGENT_MARKETING_ARTICLE_LED_ENABLED: v }), false);
  for (const v of ["1", "true", "TRUE", "yes", "on"]) assert.strictEqual(al.articleLedEnabled({ AGENT_MARKETING_ARTICLE_LED_ENABLED: v }), true);
});

test("flag off, or a Local Events request: the v1 prompt and search are sent", async () => {
  const { sent } = await go([fx.replayReply(1)], { env: {} });
  assert.ok(/EXACTLY 5/.test(sent[0].instructions) && sent[0].tools[0].max_results === 10 && sent[0].max_output_tokens === 2200);
  const ev = await go([fx.replayReply(1)], { env: ON, row: { ...row, mode: "local_events" } });
  assert.ok(/MODE: Local Events/.test(ev.sent[0].instructions) && !/Article-Led/.test(ev.sent[0].input));
});

// ── The request ────────────────────────────────────────────────────────────────────────────────
test("v2 request: the approved prompt corrections, 20 results / 6,000 tokens, 5,000 output tokens, a 12-month window, no MLS focus", async () => {
  const { sent } = await go([reply2(five())]);
  const p = sent[0];
  const ins = p.instructions;
  for (const must of ["up to FIVE substantive editorial opportunities", "WHERE TO LOOK, IN THIS ORDER", "action_date", "status_checked_date", "source_geography", "reporting_period", "project_facts",
    "your reading of a page is not verification", "provisional estimate", "has not been tested", "Do not turn an older announcement into ongoing", "only when an identifiable authoritative source shows it",
    "within the last 60 days", "up to 12 months old", "Prefer original reporting", "brokerage_or_agent", "Return fewer", "return fewer"]) assert.ok(ins.includes(must) || ins.toLowerCase().includes(must.toLowerCase()), `prompt lacks: ${must}`);
  for (const mustNot of ["EXACTLY 5", "ALWAYS RETURN FIVE", "Returning none, or fewer than five, is a failure", "different publisher", "different articles"]) assert.ok(!ins.includes(mustNot), `prompt has: ${mustNot}`);
  // lane order: local and official, then housing research, then financing, then builders
  const idx = ["(1) Exact-market local reporting", "(2) Recognized housing research", "(3) Financing and economic", "(4) Builder and development"].map((s) => ins.indexOf(s));
  assert.ok(idx.every((x) => x > 0) && idx.slice().sort((a, b) => a - b).join() === idx.join());
  assert.strictEqual(p.tools[0].max_results, 20); assert.strictEqual(p.tools[0].max_tokens, 6000); assert.strictEqual(p.max_output_tokens, 5000);
  assert.strictEqual(p.tools[0].filters.search_after_date_filter, "10/24/2025");   // 365 days before 2026-10-24
  assert.ok(/Selected market.*Lincoln, CA.*ZIP 95648/.test(p.input) && /Today: 2026-10-24/.test(p.input));
  assert.ok(!/MLS-based|market statistics|report with this scope|Optional data/i.test(p.input), "no MLS statistics focus and no report scope note go to the web provider");
});

test("v2 request: measurement knobs apply; output tokens are measured separately; a retry does not widen the search", async () => {
  const k = await go([reply2(five())], { env: { ...ON, AGENT_MARKETING_RESEARCH_MAX_RESULTS: "10", AGENT_MARKETING_RESEARCH_SEARCH_TOKENS: "6000", AGENT_MARKETING_RESEARCH_MAX_TOKENS: "2200" } });
  assert.deepStrictEqual([k.sent[0].tools[0].max_results, k.sent[0].tools[0].max_tokens, k.sent[0].max_output_tokens], [10, 6000, 2200]);
  const partial = [opp(1), opp(2), opp(3)];
  const { sent, r } = await go([reply2(partial), reply2(partial)]);
  assert.strictEqual(sent.length, 2);
  assert.deepStrictEqual(sent[1].tools, sent[0].tools, "no widening to 10,000 on a retry");
  assert.ok(/several may rest on the same article only when their evidence and angle differ/.test(sent[1].input) && !/different articles/.test(sent[1].input));
  assert.strictEqual(r.attempts, 2);
});

// ── Slots, distinct developments, no quotas ────────────────────────────────────────────────────
test("five valid opportunities are delivered and charged; the card is stored with the v1-compatible fields", async () => {
  const { r } = await go([reply2(five())]);
  assert.strictEqual(r.fields.status, "ready"); assert.strictEqual(r.fields.topics.length, 5); assert.ok(r.fields.charged_at);
  const t = r.fields.topics[0];
  assert.deepStrictEqual([t.id, t.origin, t.kind, t.discovery, t.scope, t.localIntent, t.event], ["t1", "web", "market_update", "v2", "selected", true, null]);
  assert.strictEqual(t.question, Q[0]); assert.ok(t.whyItMatters && t.trendSignals[0] === "122 homes planned (Lincoln, October 2026)");
  assert.strictEqual(t.editorial.thesis.slice(0, 20), "The development adds"); assert.strictEqual(t.editorial.development, "Development 1");
  assert.ok(r.fields.usage.articleLed.charged && r.fields.usage.pathway === "article_led" && r.fields.usage.articleLed.delivered === 5);
});

test("several opportunities may rest on one article; five different articles or publishers are not required", async () => {
  const sameArticle = [1, 2, 3, 4, 5].map((i) => opp(i, { sources: [src(1)] }));
  const { r } = await go([reply2(sameArticle)]);
  assert.strictEqual(r.fields.topics.length, 5);
  assert.strictEqual(new Set(r.fields.topics.map((t) => t.sources[0].url)).size, 1);
  assert.strictEqual(r.attempts, 1, "no retry is made to find more articles");
  assert.deepStrictEqual(r.fields.topics.map((t) => t.id), ["t1", "t2", "t3", "t4", "t5"], "no reordering for article diversity");
});

test("the same development and angle is not delivered twice, and near-identical questions overlap", async () => {
  const dup = [opp(1), opp(2, { development: "development 1", angle: "ANGLE 1" }), opp(3), opp(4, { question: "Could Parkwood's 122 homes change what Lincoln sellers will face?" }), opp(5)];
  const { r } = await go([reply2(dup)], { env: { ...ON, AGENT_MARKETING_RESEARCH_RETRIES: "0" } });
  assert.strictEqual(r.fields.topics.length, 3);
  const codes = attempt(r).topics.filter((t) => t.outcome === "left_out").map((t) => t.code).sort();
  assert.deepStrictEqual(codes, ["duplicate_development_angle", "overlaps_earlier_topic"]);
});

// ── Partial results and billing ────────────────────────────────────────────────────────────────
test("fewer than five: the valid results are kept, no session is charged, the limitation is explained and the MLS Market Trend option is offered", async () => {
  const partial = [opp(1), opp(2), opp(3)];
  const a = reply2(partial); a.json.output[1].content[0].text = a.json.output[1].content[0].text.replace('"reason":null', '"reason":"Few sources covered this community this month."');
  const { r } = await go([a, a]);
  assert.strictEqual(r.fields.status, "ready"); assert.strictEqual(r.fields.topics.length, 3); assert.strictEqual(r.fields.charged_at, null);
  assert.ok(/Only 3 of 5/.test(r.fields.usage.reportNote) && /Few sources covered/.test(r.fields.usage.reportNote) && /did not use a research session/.test(r.fields.usage.reportNote) && /MLS Market Trend Reel/.test(r.fields.usage.reportNote));
  assert.deepStrictEqual([r.fields.usage.articleLed.delivered, r.fields.usage.articleLed.charged, r.fields.usage.articleLed.offerMlsTrend], [3, false, true]);
  assert.strictEqual(r.fields.usage.articleLed.limits.reason, "Few sources covered this community this month.");
});

test("legacy billing is unchanged: a partial v1 set is still charged", async () => {
  const { result } = await quiet(() => fx.runScenario(run, fx.scenarios().find((s) => s.name === "partial_then_worse_retry")));
  assert.strictEqual(result.fields.status, "ready"); assert.ok(result.fields.charged_at);
  assert.strictEqual(rl.outcomeFields({ validation: { ok: true, topics: [{}] }, usage: {}, today: "2026-10-24", now: NOW }).charged_at, "2026-10-24T17:00:00.000Z");
});

test("nothing usable fails without a charge, as before", async () => {
  const bad = [1, 2, 3].map((i) => opp(i, { sources: [src(i, { url: "https://www.wsj.com/articles/x" + i })] }));
  const { r } = await go([reply2(bad), reply2(bad)]);
  assert.strictEqual(r.fields.status, "failed"); assert.strictEqual(r.fields.charged_at, null);
});

test("the MLS report takes no position: no report topics are written, no reframe is run, and Claude is never called", async () => {
  let called = 0;
  const { r } = await go([reply2(five())], { row: { ...row, data_source: "both", upload_refs: [{ id: "u1", scope_note: "Lincoln, Sept 2026" }] }, claudeFn: async () => { called++; return ""; } });
  assert.strictEqual(called, 0);
  assert.strictEqual(r.fields.topics.length, 5); assert.ok(r.fields.topics.every((t) => t.origin === "web"));
  assert.deepStrictEqual(r.fields.usage.discovery.final.origin, { web: 5, report: 0 });
});

// ── Freshness by source class ──────────────────────────────────────────────────────────────────
const gov = (i, published, over) => src(i, { url: `https://city${i}.example.gov/agenda-${i}`, title: `Agenda ${i}`, published, role: "primary", kind: "government_record", ...(over || {}) });
const ageIso = (days) => new Date(Date.parse("2026-10-24T00:00:00Z") - days * 86400000).toISOString().slice(0, 10);
const oneWith = (sources, over) => { const o = opp(1, { sources, ...(over || {}) }); return reply2([o]); };
const sourcesOf = async (sources, over) => { const { r } = await go([oneWith(sources, over)], { env: { ...ON, AGENT_MARKETING_RESEARCH_RETRIES: "0" } }); return { r, kept: (r.fields.topics || [])[0] && r.fields.topics[0].sources, dropped: attempt(r).sources.filter((s) => s.outcome === "dropped").map((s) => s.code) }; };

test("freshness: news and commentary must be within 60 days; the old v1 stale rule still applies to them", async () => {
  let x = await sourcesOf([src(1, { published: ageIso(60) }), src(2, { published: ageIso(61) })]);
  assert.deepStrictEqual(x.kept.map((s) => s.url), ["https://news1.example/story-1"]); assert.deepStrictEqual(x.dropped, ["stale"]);
});
test("freshness: a government record up to 12 months old is accepted as primary evidence; a builder release or a news story that old is not", async () => {
  let x = await sourcesOf([gov(1, ageIso(300))]);
  assert.strictEqual(x.kept[0].window, "authoritative_12_month"); assert.strictEqual(x.kept[0].ageDays, 300);
  x = await sourcesOf([src(1, { published: ageIso(300), role: "primary", kind: "builder_developer" }), src(2)]);
  assert.deepStrictEqual(x.dropped, ["stale"]); assert.strictEqual(x.kept.length, 1);
  x = await sourcesOf([gov(1, ageIso(365)), gov(2, ageIso(366), { role: "background" })]);   // day 365 is the last day of the 12-month window
  assert.deepStrictEqual(x.kept.map((k) => [k.ageDays, k.window]), [[365, "authoritative_12_month"], [366, "background_confirmed"]]);
});
test("freshness: an older primary record is background only, and only while a current authoritative source confirms it; never the only source", async () => {
  let x = await sourcesOf([gov(1, ageIso(500)), gov(2, ageIso(40))]);
  assert.deepStrictEqual(x.kept.map((s) => [s.window, s.role]).sort(), [["background_confirmed", "background"], ["timely_60_day", "primary"]]);
  assert.ok(x.kept.some((s) => s.window === "background_confirmed" && s.role === "background"));
  x = await sourcesOf([gov(1, ageIso(500)), src(2)]);   // a news story is not authoritative confirmation
  assert.ok(x.dropped.includes("stale_primary_unconfirmed")); assert.strictEqual(x.kept.length, 1);
  x = await sourcesOf([gov(1, ageIso(500)), gov(2, ageIso(30), { role: "background" })]);   // confirmed, but only background sources remain
  assert.strictEqual(x.kept, undefined, "the opportunity needs at least one non-background source");
  assert.ok(attempt(x.r).topics.some((t) => t.code === "only_background_sources"));
});
test("freshness: undated and future-dated sources are dropped with their own codes", async () => {
  const x = await sourcesOf([src(1, { published: "" }), src(2, { published: ageIso(-5) }), src(3)]);
  assert.deepStrictEqual(x.dropped.sort(), ["future_dated", "no_publication_date"]);
});

// ── Dates, status and facts ────────────────────────────────────────────────────────────────────
test("publication date, action date and status verification date are stored separately", async () => {
  const o = opp(1, { sources: [gov(1, ageIso(100))], action_date: "2026-06-02", status: "ongoing", status_checked_date: ageIso(5), status_evidence: { source: 1, shows: "The agreement is on the current agenda.", as_of: ageIso(5) } });
  const { r } = await go([reply2([o])], { env: { ...ON, AGENT_MARKETING_RESEARCH_RETRIES: "0" } });
  const t = r.fields.topics[0];
  assert.strictEqual(t.sources[0].published, ageIso(100)); assert.strictEqual(t.editorial.actionDate, "2026-06-02"); assert.strictEqual(t.editorial.statusCheckedDate, ageIso(5));
  assert.strictEqual(t.editorial.status, "ongoing");
  assert.deepStrictEqual(t.editorial.statusEvidence, { source: 1, shows: "The agreement is on the current agenda.", asOf: ageIso(5) });
});
test("status is recorded only with identifiable authoritative evidence; an older announcement is never converted to ongoing or new", async () => {
  const gs = [gov(1, ageIso(100)), src(2)];
  const cases = [
    ["no evidence", { status: "ongoing", status_checked_date: ageIso(5), status_evidence: null }, "unverified", /no authoritative source/],
    ["evidence from a news story", { status: "ongoing", status_checked_date: ageIso(5), status_evidence: { source: 2, shows: "x", as_of: ageIso(5) } }, "unverified", /no authoritative source/],
    ["evidence has no date", { status: "ongoing", status_checked_date: ageIso(5), status_evidence: { source: 1, shows: "x" } }, "unverified", /no date/],
    ["status check too old", { status: "ongoing", status_checked_date: ageIso(90), status_evidence: { source: 1, shows: "x", as_of: ageIso(90) } }, "unverified", /not checked within/],
    ["new, but the action is old", { status: "new", action_date: ageIso(200), status_checked_date: ageIso(3), status_evidence: { source: 1, shows: "x", as_of: ageIso(3) } }, "unverified", /not presented as new/],
    ["new, and the action is recent", { status: "new", action_date: ageIso(10), status_checked_date: ageIso(3), status_evidence: { source: 1, shows: "x", as_of: ageIso(3) } }, "new", null],
    ["completed with evidence", { status: "completed", status_checked_date: ageIso(3), status_evidence: { source: 1, shows: "x", as_of: ageIso(3) } }, "completed", null],
  ];
  for (const [name, over, want, reason] of cases) {
    const { r } = await go([reply2([opp(1, { sources: gs, ...over })])], { env: { ...ON, AGENT_MARKETING_RESEARCH_RETRIES: "0" } });
    const e = r.fields.topics[0].editorial;
    assert.strictEqual(e.status, want, name); assert.strictEqual(e.claimedStatus, over.status);
    if (reason) assert.ok(reason.test(e.statusReason), `${name}: ${e.statusReason}`); else assert.strictEqual(e.statusReason, null);
  }
});
test("status evidence follows its source when an earlier source is dropped", async () => {
  const o = opp(1, { sources: [src(1, { published: ageIso(200) }), gov(2, ageIso(100))], status: "ongoing", status_checked_date: ageIso(4), status_evidence: { source: 2, shows: "On the agenda", as_of: ageIso(4) } });
  const { r } = await go([reply2([o])], { env: { ...ON, AGENT_MARKETING_RESEARCH_RETRIES: "0" } });
  assert.strictEqual(r.fields.topics[0].editorial.statusEvidence.source, 1);   // the kept list renumbers: the government record is now source 1
});

test("project facts are source-supported claims: primary_record_cited holds only for a kept authoritative primary record, and none is marked verified", async () => {
  const o = opp(1, { sources: [gov(1, ageIso(40)), src(2)], project_facts: [
    { fact: "122 homes are planned", source: 1, basis: "primary_record_cited" }, { fact: "Construction starts in spring", source: 2, basis: "primary_record_cited" },
    { fact: "Located east of the highway", source: 2, basis: "source_stated" }, { fact: "Orphan", source: 9, basis: "source_stated" }, { fact: "Claims verified", source: 1, basis: "verified" }] });
  const { r } = await go([reply2([o])], { env: { ...ON, AGENT_MARKETING_RESEARCH_RETRIES: "0" } });
  const f = r.fields.topics[0].editorial.projectFacts;
  assert.deepStrictEqual(f.map((x) => [x.fact, x.source, x.basis]), [["122 homes are planned", 1, "primary_record_cited"], ["Construction starts in spring", 2, "source_stated"], ["Located east of the highway", 2, "source_stated"], ["Claims verified", 1, "source_stated"]]);
  assert.ok(f.every((x) => x.verification === "pending_primary_record_check"));
  assert.ok(!JSON.stringify(r.fields.topics[0].editorial).includes('"verified"'));
});

// ── Geography ──────────────────────────────────────────────────────────────────────────────────
test("geography: the relationship is required; wider-area information needs a route to the market; each source keeps its own geography and period", async () => {
  const o = [
    opp(1, { geographic_relationship: "same_jurisdiction", sources: [src(1, { source_geography: "City of Lincoln (ZIP 95648 data)", reporting_period: "Q3 2026" })] }),
    opp(2, { geographic_relationship: "county", route_to_market: "Placer County permit counts set the competition Lincoln sellers face.", sources: [src(2, { source_geography: "Placer County", reporting_period: "September 2026" })] }),
    opp(3, { geographic_relationship: "region", route_to_market: null }),
    opp(4, { geographic_relationship: "galaxy" }), opp(5, { geographic_relationship: undefined }),
  ];
  const { r } = await go([reply2(o)], { env: { ...ON, AGENT_MARKETING_RESEARCH_RETRIES: "0" } });
  assert.strictEqual(r.fields.topics.length, 2);
  const [a, b] = r.fields.topics;
  assert.deepStrictEqual([a.scope, a.scopeNote, a.sources[0].sourceGeography, a.sources[0].reportingPeriod], ["selected", "", "City of Lincoln (ZIP 95648 data)", "Q3 2026"]);
  assert.strictEqual(b.scope, "broader_context"); assert.ok(/^Placer County: Placer County permit counts/.test(b.scopeNote));
  assert.deepStrictEqual([b.sources[0].sourceGeography, b.sources[0].reportingPeriod, b.editorial.geographicRelationship], ["Placer County", "September 2026", "county"]);
  const codes = attempt(r).topics.filter((t) => t.outcome === "left_out").map((t) => t.code).sort();
  assert.deepStrictEqual(codes, ["bad_geographic_relationship", "bad_geographic_relationship", "broader_without_route"]);
});

test("access confidence is provisional and never a claim of retrieval", async () => {
  const { r } = await go([reply2([opp(1, { access_confidence: "high" }), opp(2, { access_confidence: "verified-full-text" })])], { env: { ...ON, AGENT_MARKETING_RESEARCH_RETRIES: "0" } });
  assert.deepStrictEqual(r.fields.topics.map((t) => t.editorial.accessConfidence), [{ value: "high", provisional: true, basis: "model estimate before any retrieval test" }, { value: "unknown", provisional: true, basis: "model estimate before any retrieval test" }]);
});

test("required editorial content: an opportunity without a thesis, a named development or a question is left out, with the reason recorded", async () => {
  const o = [opp(1), opp(2, { editorial_thesis: "" }), opp(3, { development: "" }), opp(4, { why_it_matters: "" }), opp(5)];
  const { r } = await go([reply2(o)], { env: { ...ON, AGENT_MARKETING_RESEARCH_RETRIES: "0" } });
  assert.strictEqual(r.fields.topics.length, 2);
  assert.deepStrictEqual(attempt(r).topics.filter((t) => t.outcome === "left_out").map((t) => t.code).sort(), ["no_development_or_angle", "no_editorial_thesis", "no_explanation"]);
});

// ── Diagnostics ────────────────────────────────────────────────────────────────────────────────
test("v2 diagnostics: source role, kind and freshness window are recorded, and depth_v2 measures the opportunities", async () => {
  const o = [opp(1, { sources: [gov(1, ageIso(100)), src(2, { kind: "brokerage_or_agent" })] }), opp(2, { sources: [src(3, { kind: "brokerage_or_agent" })] }), opp(3, { geographic_relationship: "county", route_to_market: "County supply reaches Lincoln sellers.", possible_explanations: [], evidence_gaps: [] })];
  const { r } = await go([reply2(o)], { env: { ...ON, AGENT_MARKETING_RESEARCH_RETRIES: "0" } });
  const d = r.fields.usage.discovery;
  assert.strictEqual(d.pathway, "article_led");
  const s = d.attempts[0].sources;
  assert.ok(s.some((x) => x.kind === "government_record" && x.role === "primary" && x.window === "authoritative_12_month"));
  assert.ok(s.some((x) => x.kind === "brokerage_or_agent" && x.window === "timely_60_day"));
  const v = d.depth_v2;
  assert.deepStrictEqual([v.opportunities, v.distinct_developments, v.exact_or_same_jurisdiction, v.with_authoritative_primary, v.with_brokerage_or_agent_source, v.only_brokerage_or_agent_sources, v.status_unverified, v.with_evidence_gaps, v.with_possible_explanations], [3, 3, 2, 1, 2, 1, 3, 2, 2]);
  assert.strictEqual(v.geographic_relationships.county, 1); assert.strictEqual(v.older_than_60_days_sources, 1);
});

test("v2 diagnostics stay isolated: a fault in the diagnostics cannot change the delivered opportunities", async () => {
  const dg = require("../netlify/functions/lib/agent-marketing-research-diag-lib");
  const good = await go([reply2(five())]);
  for (const name of ["pushSource", "pushTopic", "buildRecord", "depthOf"]) {
    const orig = dg[name]; dg[name] = () => { throw new Error("boom"); };
    try {
      const { r } = await go([reply2(five())]);
      assert.deepStrictEqual(r.fields.topics, good.r.fields.topics, name);
      assert.strictEqual(!!r.fields.charged_at, !!good.r.fields.charged_at);
    } finally { dg[name] = orig; }
  }
});

test("the recommendation maps to the delivered topic", async () => {
  const o = [opp(1), opp(2, { development: "Development 2", sources: [src(2, { published: "" })] }), opp(3)];
  const { r } = await go([reply2(o, { recommendation: { topic: 3, reason: "The strongest local development.", evidence: ["Council discussed the project."] } })], { env: { ...ON, AGENT_MARKETING_RESEARCH_RETRIES: "0" } });
  assert.strictEqual(r.fields.topics.length, 2);
  assert.strictEqual(r.fields.topics[1].recommended.reason, "The strongest local development.");
});
