// Topics written from the agent's confirmed MLS reports: the request choice, the checks on what the model returns, the merge of report and
// web topics, the research run for each data source, and the gate's use of the frozen figures and MetroList notice.
const test = require("node:test");
const assert = require("node:assert");
const reportLib = require("../netlify/functions/lib/agent-marketing-report-lib");
const rl = require("../netlify/functions/lib/agent-marketing-research-lib");
const rt = require("../netlify/functions/lib/agent-marketing-research-report-lib");
const run = require("../netlify/functions/lib/agent-marketing-research-run-lib");
const gate = require("../netlify/functions/lib/agent-marketing-gate");
const tv = require("./helpers/trend-fixture");
const cma = require("./helpers/cma-fixture");

const ID = "11111111-1111-4111-8111-111111111111";
const GEO_ZIP = { type: "zip", name: "95999", city: "", state: "CA", label: "ZIP 95999, CA" };
const trendFacts = (over) => { const f = reportLib.analyzePages(tv.standard(over).pages).facts; f.mlsSource = "MetroList"; return f; };
const mkCtx = (facts, geography) => rt.buildContext([{ id: ID, facts }], { audience: "sellers", geography: geography || GEO_ZIP, focus: {} });
const ref = (ctx, key) => [...ctx.figures.values()].find((c) => c.fig.key === key).ref;
const topicRaw = (ctx, over) => ({ question: "How long are homes in ZIP 95999 taking to sell?", why_it_matters: "Average days on market was 45 days.", figure_ids: [ref(ctx, "avg_dom")], ...over });
const validate = (ctx, raws) => rt.validateReportTopics(raws, ctx, { want: 5 });

// ── Request ─────────────────────────────────────────────────────────────────────────────────────────────────────────
test("request: the data source defaults sensibly and must match what is attached", () => {
  const base = { mode: "market_update", audience: "sellers", geography: { type: "city", name: "Roseville" } };
  const v = (x) => rl.validateResearchRequest({ ...base, ...x });
  assert.strictEqual(v({}).request.dataSource, "web");
  assert.strictEqual(v({ uploadIds: [ID] }).request.dataSource, "both");
  assert.strictEqual(v({ dataSource: "web", uploadIds: [ID] }).request.uploadIds.length, 0);       // web only: the report is not attached
  assert.strictEqual(v({ dataSource: "upload", uploadIds: [ID] }).ok, true);
  assert.strictEqual(v({ dataSource: "upload" }).ok, false);                                       // nothing to use
  assert.strictEqual(v({ dataSource: "both" }).ok, false);
  assert.strictEqual(v({ dataSource: "everything", uploadIds: [ID] }).ok, false);
  assert.strictEqual(v({ mode: "local_events", dataSource: "upload", uploadIds: [ID] }).ok, false);
  assert.notStrictEqual(rl.requestKey(v({ dataSource: "upload", uploadIds: [ID] }).request), rl.requestKey(v({ dataSource: "both", uploadIds: [ID] }).request));
});

// ── Checking the model's topics ─────────────────────────────────────────────────────────────────────────────────────
test("a topic that quotes its cited figures is accepted, with the figures, scope and MetroList notice frozen by code", () => {
  const ctx = mkCtx(trendFacts());
  const { topics, problems } = validate(ctx, [topicRaw(ctx)]);
  assert.deepStrictEqual(problems, []);
  const t = topics[0];
  assert.strictEqual(t.origin, "report");
  assert.strictEqual(t.scope, "selected");
  assert.strictEqual(t.reportNotice, "Based on information from MetroList Services, Inc. for the period Sep 1, 2026 through Sep 30, 2026.");
  assert.strictEqual(t.reportFigures.length, 1);
  assert.match(t.reportFigures[0].text, /Average days on market: 45 days vs 42 days in August 2026 \(up 7\.1%\) and 43 days in September 2025 \(up 4\.7%\)/);
  assert.strictEqual(t.sources[0].type, "report");
  assert.strictEqual(t.sources[0].url, null);
});

test("numbers must be the cited figures' own: invented, rounded and computed numbers are refused", () => {
  const ctx = mkCtx(trendFacts());
  for (const why of ["Average days on market was 44 days.", "Median sold price is about $715K.", "Days on market rose 4.6%."]) {
    const r = validate(ctx, [topicRaw(ctx, { why_it_matters: why })]);
    assert.strictEqual(r.topics.length, 0, why);
    assert.match(r.problems[0], /number|trend|change/);
  }
  assert.strictEqual(validate(ctx, [topicRaw(ctx, { why_it_matters: "It was 45 days in September 2026." })]).topics.length, 1);          // a year is fine
  assert.strictEqual(validate(ctx, [topicRaw(ctx, { why_it_matters: "ZIP 95999 sellers watch this." })]).topics.length, 1);                  // the place's own digits are fine
});

test("a change or trend needs a cited comparison, and never on a small sample", () => {
  const ctx = mkCtx(trendFacts());
  const up = topicRaw(ctx, { why_it_matters: "Average days on market is up from 42 days in August 2026." });
  assert.strictEqual(validate(ctx, [up]).topics.length, 1);                                       // the figure carries that comparison
  const small = mkCtx(trendFacts({ closed: 6 }));
  const r = validate(small, [{ ...up, figure_ids: [ref(small, "avg_dom")] }]);
  assert.strictEqual(r.topics.length, 0);
  assert.match(r.problems[0], /trend/);
  // a CMA has no comparisons at all, so it can never claim a change
  const c = reportLib.analyzePages(cma.standard().pages).facts;
  const cctx = rt.buildContext([{ id: ID, facts: c }], { audience: "sellers", geography: { type: "city", name: "Roseville" }, focus: {} });
  const cid = [...cctx.figures.values()].find((x) => x.fig.key === "median_close_price" && x.fig.status === "closed").ref;
  const bad = validate(cctx, [{ question: "Are Roseville prices rising?", why_it_matters: "Prices are rising fast.", figure_ids: [cid] }]);
  assert.strictEqual(bad.topics.length, 0);
});

test("a long closed-sales window cannot be called this month or recent", () => {
  const c = reportLib.analyzePages(cma.standard().pages).facts;
  c.sample.broadWindow = true; c.sample.windowDays = 213;
  const cctx = rt.buildContext([{ id: ID, facts: c }], { audience: "sellers", geography: { type: "city", name: "Roseville" }, focus: {} });
  const cid = [...cctx.figures.values()].find((x) => x.fig.key === "median_close_price" && x.fig.status === "closed").ref;
  const r = validate(cctx, [{ question: "What did homes sell for this month?", why_it_matters: "Here is the median sold price.", figure_ids: [cid] }]);
  assert.strictEqual(r.topics.length, 0);
  assert.match(r.problems[0], /this month|recent|now/);
  const ok = validate(cctx, [{ question: "What did homes in this report sell for?", why_it_matters: "Here is the median sold price.", figure_ids: [cid] }]);
  assert.strictEqual(ok.topics.length, 1);
  assert.match(ok.topics[0].scopeNote, /months, not one month/);
});

test("unknown figure ids, too many figures, addresses and sale advertising are refused", () => {
  const ctx = mkCtx(trendFacts());
  assert.match(validate(ctx, [topicRaw(ctx, { figure_ids: ["r1.f999"] })]).problems[0], /not in the report/);
  assert.match(validate(ctx, [topicRaw(ctx, { figure_ids: [] })]).problems[0], /cite 1 to 4/);
  const many = [...ctx.figures.keys()].slice(0, 5);
  assert.match(validate(ctx, [topicRaw(ctx, { figure_ids: many })]).problems[0], /cite 1 to 4/);
  assert.strictEqual(validate(ctx, [topicRaw(ctx, { why_it_matters: "See 123 Main Street for 45 days." })]).topics.length, 0);
  assert.strictEqual(validate(ctx, [topicRaw(ctx, { why_it_matters: "Just listed and 45 days on market." })]).topics.length, 0);
});

test("scope is set by code: a report for a different place makes the topic broader context and names the place", () => {
  const wide = reportLib.analyzePages(tv.standard().pages).facts;
  wide.geography = { cities: ["All MetroList MLS 14 Counties Combined"], zips: [], drawnOnMap: false };
  const ctx = mkCtx(wide, { type: "city", name: "Roseville", city: "", state: "CA", label: "Roseville, CA" });
  const t = validate(ctx, [topicRaw(ctx, { question: "How long are homes taking to sell?", why_it_matters: "Average days on market was 45 days." })]).topics[0];
  assert.strictEqual(t.scope, "broader_context");
  assert.match(t.scopeNote, /not Roseville/);
  assert.strictEqual(validate(mkCtx(trendFacts()), [topicRaw(mkCtx(trendFacts()))]).topics[0].scope, "selected");
});

test("a small month says so in the topic's scope note", () => {
  const ctx = mkCtx(trendFacts({ closed: 6 }));
  const t = validate(ctx, [topicRaw(ctx)]).topics[0];
  assert.strictEqual(t.smallSample, true);
  assert.match(t.scopeNote, /Small sample \(6 closed sales\)/);
});

test("two topics that are the same question in different words keep only the first", () => {
  const ctx = mkCtx(trendFacts());
  const a = topicRaw(ctx), b = topicRaw(ctx, { question: "How long are homes in ZIP 95999 taking to sell now?" });
  const r = validate(ctx, [a, b]);
  assert.strictEqual(r.topics.length, 1);
  assert.match(r.problems.join(" "), /overlap/);
});

// ── Asking the model ────────────────────────────────────────────────────────────────────────────────────────────────
test("the model sees figures and ids but no addresses, and a rejected first answer gets one corrective retry", async () => {
  const ctx = mkCtx(trendFacts());
  const seen = [];
  const good = JSON.stringify({ topics: [topicRaw(ctx)] });
  const bad = JSON.stringify({ topics: [topicRaw(ctx, { why_it_matters: "It was 77 days." })] });
  const answers = [bad, good];
  const out = await rt.generateReportTopics({ ctx, want: 3, minNeeded: 1, today: "2026-10-24", anthropicKey: "k", callFn: async (sys, user) => { seen.push(user); return answers.shift(); } });
  assert.strictEqual(out.attempts, 2);
  assert.strictEqual(out.topics.length, 1);
  assert.match(seen[0], /r1\.f\d+ \| Average days on market: 45 days vs 42 days in August 2026/);
  assert.match(seen[1], /previous answer was rejected/);
  assert.ok(!/Pat Fixture|@/.test(seen.join(" ")));
});

// ── Merging report and web topics ───────────────────────────────────────────────────────────────────────────────────
const webTopic = (n, q) => ({ id: `t${n}`, origin: "web", kind: "market_update", question: q || `Web question number ${n} about unrelated mortgage rates ${"abcdefgh"[n]}`, whyItMatters: "w", trendSignals: [], localIntent: true, scope: "selected", scopeNote: "", sources: [{ title: "s", url: "https://example.org/" + n, domain: "example.org", published: "2026-10-20" }], event: null });
const repTopic = (n) => ({ origin: "report", question: `Report question number ${n} about days on market ${"zyxwvu"[n]}`, whyItMatters: "r", sources: [{ type: "report", url: null }], reportFigures: [] });

test("upload only needs five report topics; both puts the report's topics first and fills with web topics", () => {
  const five = [1, 2, 3, 4, 5].map(repTopic);
  assert.strictEqual(rt.combineTopics({ dataSource: "upload", reportTopics: five.slice(0, 4), webTopics: [] }), null);
  assert.deepStrictEqual(rt.combineTopics({ dataSource: "upload", reportTopics: five, webTopics: [] }).map((t) => t.origin), Array(5).fill("report"));
  const both = rt.combineTopics({ dataSource: "both", reportTopics: [1, 2, 3, 4].map(repTopic), webTopics: [1, 2, 3, 4, 5].map((n) => webTopic(n)) });
  assert.deepStrictEqual(both.map((t) => t.origin), ["report", "report", "report", "web", "web"]);   // at most three from the report
  assert.deepStrictEqual(both.map((t) => t.id), ["t1", "t2", "t3", "t4", "t5"]);
  const dup = rt.combineTopics({ dataSource: "both", reportTopics: [repTopic(1)], webTopics: [webTopic(1, repTopic(1).question), ...[2, 3, 4, 5].map((n) => webTopic(n))] });
  assert.ok(!dup.slice(1).some((t) => t.question === repTopic(1).question) || dup.length === 5);       // the web copy of a report question goes last
  assert.strictEqual(dup[0].origin, "report");
});

// ── The research run ────────────────────────────────────────────────────────────────────────────────────────────────
const NOW = "2026-10-24T17:00:00Z";
const refs = [{ id: ID, scope_note: "MetroList market-trends report, covering ZIP 95999, Single Family Homes, for September 2026" }];
const baseRow = (src) => ({ id: "r1", mode: "market_update", audience: "sellers", geography: GEO_ZIP, focus: {}, data_source: src, upload_refs: src === "web" ? [] : refs });
const uploads = () => [{ id: ID, facts: trendFacts() }];
const RQ = ["Why are Roseville homes taking longer to sell?", "Does spring bring more competing listings?", "How are builder incentives changing resale pricing?", "What are mortgage buydowns doing to budgets?", "Which price bands see the most pending sales?"];
const webAnswer = (payloads) => ({ status: 200, json: { output: [{ type: "search_results", results: [1, 2, 3, 4, 5].map((i) => ({ url: `https://site${i}.example.org/report-${i}` })) }, { type: "message", content: [{ type: "output_text", text: JSON.stringify({ topics: RQ.map((q, i) => ({ question: q, why_it_matters: "It changes how sellers price.", trend_signals: [], local_intent: true, scope: "selected", scope_note: null, event: null, sources: [{ title: "r", url: `https://site${i + 1}.example.org/report-${i + 1}`, published: "2026-10-20" }] })) }) }] }] } });
const reportQs = (ctx) => [
  { question: "How long are homes in ZIP 95999 taking to sell?", why_it_matters: "Average days on market was 45 days.", figure_ids: [ref(ctx, "avg_dom")] },
  { question: "What is the median sold price in ZIP 95999?", why_it_matters: "The median sold price was $715,000.", figure_ids: [ref(ctx, "median_close_price")] },
  { question: "How much supply is in ZIP 95999?", why_it_matters: "Months of inventory was 5.9 months.", figure_ids: [ref(ctx, "months_supply")] },
  { question: "How many closed sales were there in ZIP 95999?", why_it_matters: "There were 52 closed sales.", figure_ids: [ref(ctx, "count_closed")] },
  { question: "How close to list price do homes sell in ZIP 95999?", why_it_matters: "Sold price was 98% of list price.", figure_ids: [ref(ctx, "avg_close_to_list_pct")] },
];

test("run, upload only: five report topics are delivered and charged, and the web provider is never called", async () => {
  const ctx = mkCtx(trendFacts());
  let web = 0;
  const r = await run.runResearch({ row: baseRow("upload"), uploads: uploads(), anthropicKey: "k", callFn: async () => { web++; return webAnswer(); }, claudeFn: async () => JSON.stringify({ topics: reportQs(ctx) }), now: NOW, env: {} });
  assert.strictEqual(web, 0);
  assert.strictEqual(r.fields.status, "ready");
  assert.ok(r.fields.charged_at);
  assert.deepStrictEqual(r.fields.topics.map((t) => t.origin), Array(5).fill("report"));
  assert.ok(r.fields.topics.every((t) => t.reportNotice.startsWith("Based on information from MetroList")));
  assert.strictEqual(r.fields.usage.dataSource, "upload");
});

test("run, upload only: fewer than five usable report topics fails and is never charged", async () => {
  const ctx = mkCtx(trendFacts());
  const r = await run.runResearch({ row: baseRow("upload"), uploads: uploads(), anthropicKey: "k", claudeFn: async () => JSON.stringify({ topics: reportQs(ctx).slice(0, 3) }), now: NOW, env: {} });
  assert.strictEqual(r.fields.status, "failed");
  assert.strictEqual(r.fields.charged_at, null);
  const dead = await run.runResearch({ row: baseRow("upload"), uploads: uploads(), anthropicKey: "k", claudeFn: async () => { throw new Error("boom sk-ant-secret"); }, now: NOW, env: {} });
  assert.strictEqual(dead.fields.status, "failed");
  assert.strictEqual(dead.fields.charged_at, null);
  assert.ok(!/sk-ant|boom/.test(JSON.stringify(dead.fields)));
});

test("run, both: report topics first, web topics after; only the scope note, never a report figure, goes to the web provider", async () => {
  const ctx = mkCtx(trendFacts());
  const payloads = [];
  const r = await run.runResearch({ row: baseRow("both"), uploads: uploads(), apiKey: "p", anthropicKey: "k", callFn: async (p) => { payloads.push(p); return webAnswer(); }, claudeFn: async () => JSON.stringify({ topics: reportQs(ctx) }), now: NOW, env: {} });
  assert.strictEqual(r.fields.status, "ready");
  assert.deepStrictEqual(r.fields.topics.map((t) => t.origin), ["report", "report", "report", "web", "web"]);
  assert.match(payloads[0].input, /market-trends report, covering ZIP 95999/);
  for (const secret of ["715,000", "715000", "5.9", "$7", "avg_dom"]) assert.ok(!payloads[0].input.includes(secret), secret);
});

test("run, both: if the report cannot be turned into topics the five web topics are still delivered, and the agent is told", async () => {
  const r = await run.runResearch({ row: baseRow("both"), uploads: uploads(), apiKey: "p", anthropicKey: "k", callFn: async () => webAnswer(), claudeFn: async () => { throw new Error("down"); }, now: NOW, env: {} });
  assert.strictEqual(r.fields.status, "ready");
  assert.deepStrictEqual(r.fields.topics.map((t) => t.origin), Array(5).fill("web"));
  assert.match(r.fields.usage.reportNote, /web research only/);
});

test("run, web only: unchanged, topics are tagged web, and an attached report is ignored", async () => {
  let called = 0;
  const r = await run.runResearch({ row: { ...baseRow("web"), upload_refs: refs }, uploads: uploads(), apiKey: "p", callFn: async (p) => { if (!/ONE web page/.test(p.instructions)) called++; assert.ok(!/MetroList market-trends/.test(p.input)); return webAnswer(); } /* a ZIP market also makes the separate Redfin call (Oct 27); this stub answers it with topics, so it is refused and the five web topics still arrive */, claudeFn: async () => { throw new Error("must not be called"); }, now: NOW, env: {} });
  assert.strictEqual(r.fields.status, "ready");
  assert.strictEqual(called, 1);
  assert.deepStrictEqual(r.fields.topics.map((t) => t.origin), Array(5).fill("web"));
});

// ── The gate ────────────────────────────────────────────────────────────────────────────────────────────────────────
function frozenTopic() {
  const ctx = mkCtx(trendFacts());
  return validate(ctx, [topicRaw(ctx, { figure_ids: [ref(ctx, "avg_dom"), ref(ctx, "median_close_price")] })]).topics[0];
}
const piece = (t, text, withNotice) => ({ template: "local_market_insider", intake: {}, verified: gate.verifiedFromTopic(t), fullPiece: true, generated: { narration: text, captions: text, sceneTexts: [], overlays: withNotice ? [t.reportNotice] : [] }, cta: null });

test("gate: figures the topic cited are allowed in a script, others are not, and the notice is required", () => {
  const t = frozenTopic();
  const ok = gate.evaluate(piece(t, "Average days on market was 45 days and the median sold price was $715,000.", true));
  assert.deepStrictEqual(ok.blocks, [], JSON.stringify(ok.blocks));
  const other = gate.evaluate(piece(t, "Months of inventory was 5.9 months.", true));
  assert.ok(other.blocks.some((b) => b.rule === "invented_number"));                    // a real report figure, but this topic did not cite it
  const noNotice = gate.evaluate(piece(t, "Average days on market was 45 days.", false));
  assert.deepStrictEqual(noNotice.blocks.map((b) => b.rule), ["missing_notice"]);
  const partial = gate.evaluate({ ...piece(t, "Average days on market was 45 days.", false), fullPiece: false });
  assert.deepStrictEqual(partial.blocks, []);                                           // a single caption check is not a whole piece
});

test("gate: a web topic has no notice requirement, and other templates never get verified report facts", () => {
  const web = webTopic(1);
  const g = gate.evaluate({ template: "local_market_insider", intake: {}, verified: gate.verifiedFromTopic(web), fullPiece: true, generated: { narration: "Homes are taking longer to sell.", captions: "", sceneTexts: [], overlays: [] }, cta: null });
  assert.ok(!g.blocks.some((b) => b.rule === "missing_notice"));
  const t = frozenTopic();
  const other = gate.evaluate({ ...piece(t, "Average days on market was 45 days.", true), template: "meet_the_agent" });
  assert.ok(other.blocks.length > 0);
});

test("plan: a piece built on a MetroList report carries the notice from the frozen topic, attached by code", async () => {
  const planLib = require("../netlify/functions/lib/agent-marketing-plan-lib");
  const t = frozenTopic();
  assert.ok(t.reportNotice);
  const am = require("../netlify/functions/lib/agent-marketing-lib");
  const stamped = am.attachNotice({ template: "local_market_insider", selected_topic: t }, { scenes: [{}, {}, {}, {}, {}] });
  assert.strictEqual(stamped.notice, t.reportNotice);
  assert.deepStrictEqual(stamped.noticeOverlay, { text: t.reportNotice, position: "bottom", scenes: [0, 4], showHeadshot: true, headshotSource: "marketing_profile" });
  const gi = am.gateInputFor({ template: "local_market_insider", intake: {}, selected_topic: t }, { captionText: "Average days on market was 45 days.", narrationTagged: "Average days on market was 45 days.", scenes: [], notice: t.reportNotice }, "claude");
  assert.strictEqual(gi.fullPiece, true);
  assert.deepStrictEqual(gi.generated.overlays, [t.reportNotice]);
  assert.deepStrictEqual(gate.evaluate(gi).blocks, [], JSON.stringify(gate.evaluate(gi).blocks));
  const user = am.gateInputFor({ template: "local_market_insider", intake: {}, selected_topic: t }, { captionText: "Average days on market was 45 days.", narrationTagged: "x", scenes: [], notice: t.reportNotice }, "user");
  assert.ok(!gate.evaluate(user).blocks.some((b) => b.rule === "missing_notice"), JSON.stringify(gate.evaluate(user).blocks));
  assert.ok(planLib.MODEL);
});
