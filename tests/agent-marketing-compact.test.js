// Run with: npm test
// PR 2, compact Stage A: up to eight short candidates; code qualifies, ranks and keeps up to five; retries off; the candidate handoff record.
const test = require("node:test");
const assert = require("node:assert");
const run = require("../netlify/functions/lib/agent-marketing-research-run-lib");
const cl = require("../netlify/functions/lib/agent-marketing-compact-lib");
const fx = require("./fixtures/research-diag/scenarios");

const NOW = fx.NOW, TODAY = "2026-10-24";
const ON = { AGENT_MARKETING_ARTICLE_LED_ENABLED: "true" };   // the compact design is the default
const quiet = async (fn) => { const e = console.error; console.error = () => {}; try { return await fn(); } finally { console.error = e; } };
const row = (geo) => ({ id: "r1", mode: "market_update", audience: "sellers", geography: geo || fx.GEO.lincoln, focus: {}, upload_refs: [], data_source: "web" });
const CROCKER = { type: "neighborhood", name: "Crocker Ranch", city: "Roseville", zip: "95747", state: "CA", label: "Crocker Ranch, Roseville, CA" };

const src = (i, over) => ({ title: `Lincoln story ${i}`, url: `https://news${i}.example/lincoln-story-${i}`, published: "2026-10-18", role: "secondary", kind: "local_news", source_geography: "Lincoln, CA", reporting_period: "October 2026", what_it_establishes: "Reports the development.", ...(over || {}) });
const Q = ["Could Parkwood's 122 homes change what Lincoln sellers face?", "Why did the city approve a second apartment site this fall?", "What do higher mortgage rates mean for move-up buyers here?", "Is a new school calendar shifting when families list?", "Which price bands saw pending sales slip last month?", "Are builder incentives pulling buyers from resale homes?", "What changed in the city's fee schedule for new permits?", "Did the county's new housing element reach Lincoln owners?", "Will the bypass extension reshape commute times for sellers?", "How are new utility rates landing on older homes?"];
const cand = (i, over) => ({
  question: Q[i - 1], development: `Development ${i}`, angle: `Angle ${i}`, why: "It changes what nearby sellers compete with.", relationship: "market", route: null,
  strength: "high", relevance: "direct", action_date: "2026-10-10", event: null, status: "unverified", status_source: null, status_checked_date: null, status_by_source: [], conflict: null,
  gap: "Phasing is not stated.", access_confidence: "medium", keyword_match: false, sources: [src(i)], ...(over || {}),
});
const reply = (cands) => ({ status: 200, json: { output: [{ type: "search_results", results: cands.flatMap((c) => c.sources.map((s) => ({ url: s.url }))) },
  { type: "message", content: [{ type: "output_text", text: "```json\n" + JSON.stringify({ research_limits: { returned: cands.length, reason: null }, candidates: cands }) + "\n```" }] }], usage: fx.usage(1) } });
async function go(cands, over) {
  const sent = []; const left = Array.isArray(cands) && cands.length && cands[0].json ? cands.slice() : null;
  const callFn = async (p) => { sent.push(JSON.parse(JSON.stringify(p))); return left ? left.shift() || left[left.length - 1] : reply(cands); };
  const r = await quiet(() => run.runResearch({ row: row(over && over.geo), apiKey: "k", now: NOW, env: (over && over.env) || ON, sleepFn: async () => {}, callFn }));
  return { r, sent };
}
const eight = () => [1, 2, 3, 4, 5, 6, 7, 8].map((i) => cand(i));
const topics = (r) => r.fields.topics;
const cardOf = (t) => t.candidate;

test("the default Article-Led design is compact: eight candidates, 20 results / 6,000 context, 4,500 output tokens, the market's hierarchy in the input, one provider request", async () => {
  const { sent, r } = await go([cand(1)]);   // fewer than five: the ordinary retry is off
  assert.strictEqual(sent.length, 1); assert.strictEqual(r.attempts, 1);
  const p = sent[0];
  assert.deepStrictEqual([p.tools[0].max_results, p.tools[0].max_tokens, p.max_output_tokens], [20, 6000, 4500]);
  assert.ok(/up to EIGHT distinct discovery candidates/.test(p.instructions) && /Return fewer than eight, and fewer than five/.test(p.instructions) && /Never pad/.test(p.instructions));
  assert.ok(/district, zip, city, county, region, state or national/.test(p.instructions) && /unresolved/.test(p.instructions) && /after_event_source/.test(p.instructions) && /15 words or fewer/.test(p.instructions));
  assert.ok(!/EXACTLY|ALWAYS RETURN/i.test(p.instructions));
  assert.ok(/Selected market.*Lincoln, CA/.test(p.input) && /ZIP 95648/.test(p.input) && /Placer County/.test(p.input) && /up to 8 short discovery candidates/.test(p.input));
  assert.strictEqual(p.tools[0].filters.search_after_date_filter, "10/24/2025");
});

test("knobs and the detailed design: output tokens follow the setting; the detailed prompt is still available for diagnostics; retries only when asked", async () => {
  const k = await go([cand(1)], { env: { ...ON, AGENT_MARKETING_RESEARCH_MAX_TOKENS: "6000" } });
  assert.strictEqual(k.sent[0].max_output_tokens, 6000);
  const d = await go([cand(1)], { env: { ...ON, AGENT_MARKETING_ARTICLE_LED_DESIGN: "detailed" } });
  assert.ok(/up to FIVE substantive editorial opportunities/.test(d.sent[0].instructions) && d.sent[0].max_output_tokens === 5000);
  const rt = await go([reply([cand(1)]), reply([cand(1), cand(2)])], { env: { ...ON, AGENT_MARKETING_ARTICLE_LED_RETRIES: "1" } });
  assert.strictEqual(rt.sent.length, 2); assert.ok(/needs work|rejected/.test(rt.sent[1].input));
  assert.deepStrictEqual(rt.sent[1].tools, rt.sent[0].tools, "no widening");
  const legacy = await go([fx.replayReply(1)], { env: {} });
  assert.strictEqual(legacy.sent.length > 0 && /EXACTLY 5/.test(legacy.sent[0].instructions), true, "flag off: legacy unchanged");
});

test("eight candidates: code keeps five, charges once, and records why the others were not used", async () => {
  const { r } = await go(eight());
  assert.strictEqual(topics(r).length, 5); assert.ok(r.fields.charged_at);
  const sel = r.fields.usage.discovery.attempts[0].topics;
  assert.strictEqual(sel.filter((t) => t.code === "selected").length, 5);
  assert.strictEqual(sel.filter((t) => t.code === "qualified_not_selected").length, 3);
  const dep = r.fields.usage.discovery.depth_v2;
  assert.deepStrictEqual([dep.design, dep.candidates_returned, dep.qualified, dep.selected, dep.five_card_yield], ["compact_v1", 8, 8, 5, true]);
});

test("a weak slot is never filled: low-strength, no-relevance, no-source and expired candidates leave fewer than five, uncharged, with the MLS option", async () => {
  const c = [cand(1), cand(2), cand(3, { strength: "low" }), cand(4, { relevance: "none" }), cand(5, { sources: [] }), cand(6, { event: { kind: "workshop", date: "2026-10-01", deadline: "2026-10-10", continues_after_event: false, after_event: null, after_event_source: null } })];
  const { r } = await go(c);
  assert.strictEqual(topics(r).length, 2); assert.strictEqual(r.fields.charged_at || null, null);
  assert.strictEqual(r.fields.usage.articleLed.offerMlsTrend, true);
  const reasons = r.fields.usage.discovery.depth_v2.not_qualified_reasons;
  assert.deepStrictEqual([reasons.low_strength, reasons.no_homeowner_relevance, reasons.no_usable_source, reasons.expired_event], [1, 1, 1, 1]);
});

test("ranking: editorial substance and homeowner relevance first; an official source alone does not outrank a more useful story", () => {
  const gov = (i, over) => cand(i, { question: Q[i - 1], strength: "medium", relevance: "indirect", sources: [{ ...src(i), title: "Lincoln council agenda", url: `https://www.lincolnca.gov/agenda-${i}`, role: "primary", kind: "government_record" }], ...(over || {}) });
  const story = cand(9, { strength: "high", relevance: "direct", sources: [src(9, { url: "https://www.goldmountaincanews.com/lincoln-story-9" })] });
  const v = cl.validateCandidates([gov(1), gov(2), gov(3), gov(4), gov(5), gov(6), story], { today: TODAY, geography: fx.GEO.lincoln });
  const ids = v.topics.map((t) => t.candidate.development);
  assert.strictEqual(ids[0], "Development 9", "the strong, directly relevant story ranks above official records of medium, indirect strength");
  assert.strictEqual(v.topics.length, 5);
  // among equals the official primary source decides
  const eq = cl.validateCandidates([cand(1), gov(2, { strength: "high", relevance: "direct" })], { today: TODAY, geography: fx.GEO.lincoln });
  assert.strictEqual(eq.topics[0].candidate.development, "Development 2");
});

test("duplicates: the same development and angle, or near-identical questions, count once; two angles on one article are allowed", () => {
  const a = cand(1), b = cand(2, { development: "Development 1", angle: "Angle 1" }), c = cand(3, { sources: [src(1)], development: "Another thing", angle: "Different angle", question: "Why does the school calendar shift listing timing in Lincoln?" });
  const v = cl.validateCandidates([a, b, c], { today: TODAY, geography: fx.GEO.lincoln });
  assert.deepStrictEqual(v.topics.map((t) => t.candidate.development), ["Development 1", "Another thing"]);
  assert.strictEqual(v.candidates[1].reason, "duplicate_development_angle");
});

test("geography: only the selected market itself is scope 'market'; a city action carries its route; a Roseville action is not a Crocker Ranch-specific development", async () => {
  const roseville = cand(1, { question: "What did Roseville's planning vote change for Crocker Ranch homeowners?", relationship: "city", route: "The city rezoning sets fees and density that Crocker Ranch homeowners' neighbors face.",
    sources: [{ ...src(1), title: "Roseville Planning Commission staff report", url: "https://www.roseville.ca.us/planning/report-oct", role: "primary", kind: "government_record", source_geography: "City of Roseville" }] });
  const noRoute = { ...roseville, question: "What else did Roseville decide this month for Crocker Ranch?", development: "Other", angle: "Other angle", route: null };
  const crocker = cand(3, { question: "Is the Crocker Ranch park phase moving ahead?", sources: [src(3, { title: "Crocker Ranch park phase advances", url: "https://news3.example/crocker-ranch-park", source_geography: "Crocker Ranch, Roseville" })] });
  const v = cl.validateCandidates([roseville, noRoute, crocker], { today: TODAY, geography: CROCKER });
  const byDev = Object.fromEntries(v.topics.map((t) => [t.candidate.development, t]));
  assert.strictEqual(v.topics.length, 2); assert.strictEqual(v.candidates[1].reason, "broader_without_route");
  assert.deepStrictEqual([byDev["Development 1"].scope, byDev["Development 1"].candidate.geography.relationship], ["broader_context", "city"]);
  assert.deepStrictEqual([byDev["Development 3"].scope, byDev["Development 3"].candidate.geography.relationship, byDev["Development 3"].candidate.geography.nameFoundInSource], ["selected", "market", true]);
  const g = byDev["Development 1"].candidate.geography;
  assert.strictEqual(g.boundaryVerified, false); assert.strictEqual(g.provisional, true);
  assert.deepStrictEqual(g.hierarchy.levels.map((l) => l.level), ["market", "district", "zip", "city", "county"]);
  assert.ok(/city rezoning/.test(g.route));
});

test("a market claim no source name supports is kept provisional, flagged for review and given no ranking weight; the model's own source_geography is not corroboration", () => {
  const unsupported = cand(1, { question: "What is happening on the north side of Lincoln?", sources: [src(1, { title: "A new development opens", url: "https://news1.example/story-1", source_geography: "Lincoln, CA" })] });
  const supported = cand(2);
  const v = cl.validateCandidates([unsupported, supported], { today: TODAY, geography: fx.GEO.lincoln });
  const byDev = Object.fromEntries(v.topics.map((t) => [t.candidate.development, t.candidate]));
  assert.strictEqual(byDev["Development 1"].geography.nameFoundInSource, false);
  assert.strictEqual(byDev["Development 1"].selection.geoSpecificity, 0);
  assert.strictEqual(byDev["Development 1"].provisionalEvidence.geography, "unsupported_provisional");
  assert.ok(byDev["Development 1"].review.needsReview && /unsupported/.test(byDev["Development 1"].review.reasons.join()));
  assert.ok(byDev["Development 2"].selection.geoSpecificity > 0);
  assert.strictEqual(v.topics[0].candidate.development, "Development 2", "unsupported claim ranks below the supported one with equal substance");
});

test("expired events: a past comment deadline is not presented as upcoming; it stays only with an explained continuation supported by a later source", () => {
  const ev = (o) => ({ kind: "comment_period", date: "2026-09-20", deadline: "2026-10-05", continues_after_event: true, after_event: "The council now schedules a vote on the revised plan next month.", after_event_source: 2, ...(o || {}) });
  const withSources = (e) => cand(1, { event: e, sources: [src(1, { published: "2026-09-25", url: "https://news1.example/lincoln-story-1" }), src(2, { published: "2026-10-15", url: "https://news2.example/lincoln-story-2" })] });
  const ok = cl.validateCandidates([withSources(ev())], { today: TODAY, geography: fx.GEO.lincoln });
  assert.strictEqual(ok.topics.length, 1); assert.strictEqual(ok.topics[0].candidate.event.status, "expired_with_supported_continuation");
  assert.ok(ok.topics[0].candidate.review.needsReview);
  for (const [name, e, why] of [["boolean alone", ev({ after_event: null, after_event_source: null }), /not explained/], ["flag false", ev({ continues_after_event: false }), /nothing is said to continue/],
    ["no source", ev({ after_event_source: null }), /no kept source/], ["source before the event", ev({ after_event_source: 1 }), /not published after/]]) {
    const v = cl.validateCandidates([withSources(e)], { today: TODAY, geography: fx.GEO.lincoln });
    assert.strictEqual(v.topics.length, 0, name); assert.strictEqual(v.candidates[0].reason, "expired_event", name);
  }
  const upcoming = cl.validateCandidates([cand(1, { event: { kind: "hearing", date: "2026-11-05", deadline: null, continues_after_event: false } })], { today: TODAY, geography: fx.GEO.lincoln });
  assert.strictEqual(upcoming.topics[0].candidate.event.status, "upcoming");
});

test("status: conflicting evidence stays unresolved even from an official source; official status needs an official primary source and a recent check", () => {
  const gov = (i) => ({ ...src(i), title: "Lincoln city record", url: `https://www.lincolnca.gov/record-${i}`, role: "primary", kind: "government_record" });
  const conflict = cand(1, { status: "ongoing", status_source: 1, status_checked_date: "2026-10-20", sources: [gov(1), src(2)], status_by_source: [{ source: 1, state: "approved" }, { source: 2, state: "pending" }] });
  const stated = cand(2, { status: "completed", status_source: 1, status_checked_date: "2026-10-20", sources: [gov(3)], conflict: "The city says complete; the builder says phase two is not built." });
  const official = cand(3, { status: "ongoing", status_source: 1, status_checked_date: "2026-10-20", sources: [gov(4)], status_by_source: [{ source: 1, state: "under_construction" }] });
  const claimed = cand(4, { status: "ongoing", status_source: 1, status_checked_date: "2026-10-20", sources: [src(5)] });
  const v = cl.validateCandidates([conflict, stated, official, claimed], { today: TODAY, geography: fx.GEO.lincoln });
  const s = Object.fromEntries(v.topics.map((t) => [t.candidate.development, t.candidate.status]));
  assert.deepStrictEqual([s["Development 1"].value, s["Development 1"].conflict.basis], ["unresolved", "states_differ"]);
  assert.deepStrictEqual([s["Development 2"].value, s["Development 2"].conflict.basis], ["unresolved", "model_stated"]);
  assert.strictEqual(s["Development 3"].value, "ongoing"); assert.ok(s["Development 3"].evidence);
  assert.strictEqual(s["Development 4"].value, "unverified"); assert.ok(/no official primary source/.test(s["Development 4"].reason));
  assert.ok(v.topics.find((t) => t.candidate.development === "Development 1").candidate.provisionalEvidence.status === "unresolved_conflicting_evidence");
});

test("outlets are classified in code; brokerage and agent sources are allowed but labelled, trade aggregation is not local reporting", () => {
  const brokerage = cand(1, { sources: [src(1, { title: "Lincoln market blog", url: "https://www.thegoolsbygroup.com/lincoln-market", kind: "local_news" })] });
  const trade = cand(2, { sources: [src(2, { title: "Lincoln housing", url: "https://www.cahousingmarketnews.com/lincoln-update", kind: "local_news" })] });
  const local = cand(3, { sources: [src(3, { title: "Lincoln council", url: "https://www.goldmountaincanews.com/lincoln-council", kind: "local_news" })] });
  const v = cl.validateCandidates([brokerage, trade, local], { today: TODAY, geography: fx.GEO.lincoln });
  assert.strictEqual(v.topics.length, 3, "no ban on brokerage sources");
  const cls = Object.fromEntries(v.topics.map((t) => [t.candidate.development, t.candidate.sources[0].outletClass]));
  assert.deepStrictEqual(cls, { "Development 1": "brokerage_or_agent_commentary", "Development 2": "trade_aggregation", "Development 3": "original_local_reporting" });
  assert.strictEqual(v.topics[0].candidate.development, "Development 3", "among equals, original reporting ranks first");
  const dep = cl.depthCompact(v.topics, v.summary);
  assert.deepStrictEqual([dep.only_brokerage_or_agent, dep.with_original_local_reporting, dep.with_trade_aggregation], [1, 1, 1]);
});

test("handoff: each selected candidate stores a stable id, source references, development identity, geographic context and provisional evidence status", async () => {
  const a = await go(eight()), b = await go(eight());
  const ta = topics(a.r), tb = topics(b.r);
  assert.deepStrictEqual(ta.map((t) => cardOf(t).id), tb.map((t) => cardOf(t).id), "ids are stable across runs");
  const c = cardOf(ta[0]);
  assert.ok(/^cand_[0-9a-f]{12}$/.test(c.id));
  assert.ok(c.development && c.developmentKey && c.angle && c.angleKey);
  assert.ok(c.sources.every((s) => s.ref.startsWith(`${c.id}:s`) && s.url && s.outletClass && s.published));
  assert.deepStrictEqual([c.geography.relationship, c.geography.provisional, c.geography.boundaryVerified], ["market", true, false]);
  assert.deepStrictEqual([c.provisionalEvidence.stage, c.provisionalEvidence.publicationAuthorized, c.provisionalEvidence.claims], ["stage_a_candidate", false, "source_reported_not_verified"]);
  assert.ok(c.selection.selected && c.selection.rank === 1);
  assert.strictEqual(new Set(ta.map((t) => cardOf(t).id)).size, 5);
  // v1-compatible fields for the legacy planner and gate
  assert.deepStrictEqual([ta[0].reportFirst, ta[0].externalStatisticsAuthorized, ta[0].kind], [true, false, "market_update"]);
  // a different market gives a different id for the same development
  const other = cl.validateCandidates([cand(1)], { today: TODAY, geography: fx.GEO.natomas });
  assert.notStrictEqual(other.topics[0].candidate.id, cl.validateCandidates([cand(1)], { today: TODAY, geography: fx.GEO.lincoln }).topics[0].candidate.id);
});

test("freshness and source rules are unchanged: a 90-day news story is dropped and a listing page is rejected", () => {
  const old = cand(1, { sources: [src(1, { published: "2026-07-01" })] });
  const listing = cand(2, { sources: [src(2, { url: "https://news2.example/homes-for-sale/lincoln", title: "Lincoln homes for sale" })] });
  const v = cl.validateCandidates([old, listing, cand(3)], { today: TODAY, geography: fx.GEO.lincoln });
  assert.deepStrictEqual(v.topics.map((t) => t.candidate.development), ["Development 3"]);
});

test("compact answer shape: a missing candidates list is a failed run, not a partial one", async () => {
  const bad = { status: 200, json: { output: [{ type: "message", content: [{ type: "output_text", text: "```json\n{\"opportunities\":[]}\n```" }] }], usage: fx.usage(1) } };
  const { r } = await go([bad]);
  assert.notStrictEqual(r.fields.status, "ready");
});

test("harness: the 20-run plan, a compact replay writes candidate cards (no query strings), a summary table and an inventory review sample", () => {
  const fs = require("fs"), os = require("os"), path = require("path"), cp = require("child_process");
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "cb-"));
  const node = (args) => cp.execFileSync(process.execPath, args, { encoding: "utf8" });
  node([path.join(__dirname, "..", "scripts", "research-baseline.js"), "--replay", "--prompt", "compact", "--markets", "lincoln", "--repeats", "2", "--out", dir]);
  const files = fs.readdirSync(dir).filter((f) => f.endsWith(".cards.json"));
  assert.strictEqual(files.length, 5, "2 + 2 compact runs and one detailed diagnostic run for the market");
  const md = fs.readFileSync(path.join(dir, "summary.md"), "utf8");
  assert.ok(/## Compact Stage A depth/.test(md) && /compact_r20_c6000_o4500/.test(md) && /compact_r20_c6000_o6000/.test(md) && /## Article-Led \(v2\) depth/.test(md) && /detailed_r20_c6000_o8000/.test(md));
  const cards = JSON.parse(fs.readFileSync(path.join(dir, "lincoln-compact_r20_c6000_o4500-1.cards.json"), "utf8"));
  assert.strictEqual(cards.length, 5);
  assert.ok(/^cand_/.test(cards[0].candidateId) && cards[0].sources[0].ref && cards[0].provisionalEvidence.publicationAuthorized === false);
  const out = node([path.join(__dirname, "..", "scripts", "research-baseline-inventory.js"), dir, "--sample-cells", "compact_r20_c6000_o4500"]);
  assert.ok(/Geography: name found in/.test(out) && /Source cand_[0-9a-f]{12}:s1/.test(out) && /boundary NOT verified/.test(out));
  const detailed = JSON.parse(fs.readFileSync(path.join(dir, "lincoln-detailed_r20_c6000_o8000-1.cards.json"), "utf8"));
  assert.ok(detailed[0].thesis && !detailed[0].candidateId, "the detailed diagnostic cell still produces the detailed card");
  const env = require("../scripts/research-baseline").cellEnv({}, require("../scripts/research-baseline").CELLS.find((c) => c.id === "detailed_r20_c6000_o8000"));
  assert.deepStrictEqual([env.AGENT_MARKETING_ARTICLE_LED_DESIGN, env.AGENT_MARKETING_RESEARCH_MAX_TOKENS, env.AGENT_MARKETING_ARTICLE_LED_RETRIES], ["detailed", "8000", "0"]);
});
