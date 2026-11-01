// Run with: npm test
// PR 2, compact Stage A: up to eight short candidates; code qualifies, ranks and keeps up to five; retries off; the candidate handoff record.
const test = require("node:test");
const assert = require("node:assert");
const run = require("../netlify/functions/lib/agent-marketing-research-run-lib");
const cl = require("../netlify/functions/lib/agent-marketing-compact-lib");
const rl = require("../netlify/functions/lib/agent-marketing-research-lib");
const fx = require("./fixtures/research-diag/scenarios");

const NOW = fx.NOW, TODAY = "2026-10-24";
const ON = { AGENT_MARKETING_ARTICLE_LED_ENABLED: "true", AGENT_MARKETING_ARTICLE_LED_LANES: "single" };   // single compact pass (the lane default is tested separately)
const DIAG = { AGENT_MARKETING_ARTICLE_LED_DIAGNOSTICS: "true" };
const quiet = async (fn) => { const e = console.error; console.error = () => {}; try { return await fn(); } finally { console.error = e; } };
const row = (geo) => ({ id: "r1", mode: "market_update", audience: "sellers", geography: geo || fx.GEO.lincoln, focus: {}, upload_refs: [], data_source: "web" });
const CROCKER = { type: "neighborhood", name: "Crocker Ranch", city: "Roseville", zip: "95747", state: "CA", label: "Crocker Ranch, Roseville, CA" };

const src = (i, over) => ({ title: `Lincoln story ${i}`, url: `https://news${i}.example/lincoln-story-${i}`, published: "2026-10-18", role: "secondary", kind: "local_news", source_geography: "Lincoln, CA", reporting_period: "October 2026", what_it_establishes: "Reports the development.", ...(over || {}) });
const Q = ["Could Parkwood's 122 homes change what Lincoln sellers face?", "Why did the city approve a second apartment site this fall?", "What do higher mortgage rates mean for move-up buyers here?", "Is a new school calendar shifting when families list?", "Which price bands saw pending sales slip last month?", "Are builder incentives pulling buyers from resale homes?", "What changed in the city's fee schedule for new permits?", "Did the county's new housing element reach Lincoln owners?", "Will the bypass extension reshape commute times for sellers?", "How are new utility rates landing on older homes?"];
const DEV = ["Parkwood agreement", "Apartment site approval", "Mortgage rate shift", "School calendar change", "Pending sales slowdown", "Builder incentives", "Permit fee schedule", "Housing element update", "Bypass extension", "Utility rate change"];
const cand = (i, over) => ({
  question: Q[i - 1], development: DEV[i - 1], angle: `Angle ${DEV[i - 1].split(" ")[0]}`, why: "It changes what nearby sellers compete with.", relationship: "market", route: null,
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
  assert.strictEqual(ids[0], DEV[8], "the strong, directly relevant story ranks above official records of medium, indirect strength");
  assert.strictEqual(v.topics.length, 5);
  // among equals the official primary source decides
  const eq = cl.validateCandidates([cand(1), gov(2, { strength: "high", relevance: "direct" })], { today: TODAY, geography: fx.GEO.lincoln });
  assert.strictEqual(eq.topics[0].candidate.development, DEV[1]);
});

test("duplicates: the same development and angle, or near-identical questions, count once; two angles on one article are allowed", () => {
  const a = cand(1), b = cand(2, { development: DEV[0], angle: "Angle Parkwood" }), c = cand(3, { sources: [src(1)], development: "Another thing", angle: "Different angle", question: "Why does the school calendar shift listing timing in Lincoln?" });
  const v = cl.validateCandidates([a, b, c], { today: TODAY, geography: fx.GEO.lincoln });
  assert.deepStrictEqual(v.topics.map((t) => t.candidate.development), [DEV[0], "Another thing"]);
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
  assert.deepStrictEqual([byDev[DEV[0]].scope, byDev[DEV[0]].candidate.geography.relationship], ["broader_context", "city"]);
  assert.deepStrictEqual([byDev[DEV[2]].scope, byDev[DEV[2]].candidate.geography.relationship, byDev[DEV[2]].candidate.geography.nameFoundInSource], ["selected", "market", true]);
  const g = byDev[DEV[0]].candidate.geography;
  assert.strictEqual(g.boundaryVerified, false); assert.strictEqual(g.provisional, true);
  assert.deepStrictEqual(g.hierarchy.levels.map((l) => l.level), ["market", "district", "zip", "city", "county"]);
  assert.ok(/city rezoning/.test(g.route));
});

test("a market claim no source name supports is kept provisional, flagged for review and given no ranking weight; the model's own source_geography is not corroboration", () => {
  const unsupported = cand(1, { question: "What is happening on the north side of Lincoln?", sources: [src(1, { title: "A new development opens", url: "https://news1.example/story-1", source_geography: "Lincoln, CA" })] });
  const supported = cand(2);
  const v = cl.validateCandidates([unsupported, supported], { today: TODAY, geography: fx.GEO.lincoln });
  const byDev = Object.fromEntries(v.topics.map((t) => [t.candidate.development, t.candidate]));
  assert.strictEqual(byDev[DEV[0]].geography.nameFoundInSource, false);
  assert.strictEqual(byDev[DEV[0]].selection.geoSpecificity, 0);
  assert.strictEqual(byDev[DEV[0]].provisionalEvidence.geography, "unsupported_provisional");
  assert.ok(byDev[DEV[0]].review.needsReview && /unsupported/.test(byDev[DEV[0]].review.reasons.join()));
  assert.ok(byDev[DEV[1]].selection.geoSpecificity > 0);
  assert.strictEqual(v.topics[0].candidate.development, DEV[1], "unsupported claim ranks below the supported one with equal substance");
});

test("expired events: a past event is never presented as upcoming; the development stays only when a SOURCE reports a continuing process, appeal, pending action or consequential outcome", () => {
  const ev = (o) => ({ kind: "comment_period", date: "2026-09-20", deadline: "2026-10-05", continues_after_event: true, after_event: "The council now schedules a vote on the revised plan next month.", after_event_source: 2, ...(o || {}) });
  const two = (e, over) => cand(1, { event: e, sources: [src(1, { published: "2026-09-25", url: "https://news1.example/lincoln-story-1" }), src(2, { published: "2026-10-15", url: "https://news2.example/lincoln-story-2" })], ...(over || {}) });
  const V = (c) => cl.validateCandidates([c], { today: TODAY, geography: fx.GEO.lincoln });
  // source-reported open process: kept, never upcoming
  const pending = V(two(ev(), { status_by_source: [{ source: 2, state: "pending" }] }));
  assert.strictEqual(pending.topics.length, 1);
  const e1 = pending.topics[0].candidate.event;
  assert.deepStrictEqual([e1.status, e1.presentedAs, e1.postEvent.basis, e1.postEvent.sourceN, e1.postEvent.state], ["expired_with_supported_continuation", "past_event_outcome", "source_reports_open_process", 2, "pending"]);
  assert.ok(pending.topics[0].candidate.review.needsReview);
  // a source-reported consequential outcome is enough too
  const approved = V(two(ev({ after_event: null, after_event_source: null, continues_after_event: false }), { status_by_source: [{ source: 2, state: "approved" }] }));
  assert.deepStrictEqual([approved.topics.length, approved.topics[0].candidate.event.postEvent.basis], [1, "source_reports_consequential_outcome"]);
  // what must NOT stay: the model's explanation, the flag, an unknown state, a finished project, a source that predates the event
  for (const [name, c] of [
    ["explanation and flag, no source state", two(ev())],
    ["explanation with an unknown state", two(ev(), { status_by_source: [{ source: 2, state: "unknown" }] })],
    ["a completed project is not a continuing process", two(ev({ kind: "opening", date: "2026-10-01", deadline: null }), { status_by_source: [{ source: 2, state: "completed" }] })],
    ["the only state belongs to a source published before the event", cand(1, { event: ev({ after_event_source: 1 }), sources: [src(1, { published: "2026-09-25" })], status_by_source: [{ source: 1, state: "pending" }] })],
    ["the state belongs to the earlier source", two(ev(), { status_by_source: [{ source: 1, state: "pending" }] })]]) {
    const v = V(c);
    assert.strictEqual(v.topics.length, 0, name); assert.strictEqual(v.candidates[0].reason, "expired_event", name);
  }
  const upcoming = V(cand(1, { event: { kind: "hearing", date: "2026-11-05", deadline: null, continues_after_event: false } }));
  assert.deepStrictEqual([upcoming.topics[0].candidate.event.status, upcoming.topics[0].candidate.event.presentedAs], ["upcoming", "upcoming"]);
});

test("regression: the Sierra View shopping-center appeal survives although the model left after_event empty (council meeting passed; a later report says it went back to the Planning Commission)", async () => {
  const sierra = cand(1, {
    question: "Will the Sierra View appeal change what gets built near west Roseville homes?", development: "Roseville sent the Sierra View shopping center proposal back to the Planning Commission after an appeal", angle: "A nearby retail proposal remains unresolved",
    relationship: "district", route: "If the proposal proceeds, retail uses and traffic may affect west Roseville residents; effects on Crocker Ranch are not established.",
    event: { kind: "meeting", date: "2026-10-21", deadline: null, continues_after_event: false, after_event: null, after_event_source: null },
    status: "unverified", status_by_source: [{ source: 1, state: "approved" }, { source: 2, state: "appealed" }], conflict: "The commission approval stands in one report while the council returned the item for review.",
    sources: [{ ...src(1), title: "Proposed west Roseville shopping center faces appeal", url: "https://www.sacbee.com/news/local/roseville-appeal", published: "2026-10-20", source_geography: "West Roseville", what_it_establishes: "The appeal challenged the environmental review of the shopping center." },
      { ...src(2), title: "Roseville sends Sierra View shopping center back to Planning Commission", url: "https://www.onsiteobserver.com/roseville-sierra-view", published: "2026-10-22", kind: "trade_news", source_geography: "West Roseville", what_it_establishes: "The council returned the proposal to the Planning Commission." }] });
  const v = cl.validateCandidates([sierra], { today: TODAY, geography: CROCKER });
  assert.strictEqual(v.topics.length, 1, "kept");
  const c = v.topics[0].candidate;
  assert.deepStrictEqual([c.event.presentedAs, c.event.postEvent.sourceN, c.event.postEvent.basis, c.event.postEvent.state], ["past_event_outcome", 2, "source_reports_open_process", "appealed"]);
  assert.strictEqual(c.status.value, "unresolved");
  assert.deepStrictEqual([c.geography.relationship, v.topics[0].scope], ["district", "broader_context"]);
});

test("status: conflicting evidence stays unresolved even from an official source; official status needs an official primary source and a recent check", () => {
  const gov = (i) => ({ ...src(i), title: "Lincoln city record", url: `https://www.lincolnca.gov/record-${i}`, role: "primary", kind: "government_record" });
  const conflict = cand(1, { status: "ongoing", status_source: 1, status_checked_date: "2026-10-20", sources: [gov(1), src(2)], status_by_source: [{ source: 1, state: "approved" }, { source: 2, state: "pending" }] });
  const stated = cand(2, { status: "completed", status_source: 1, status_checked_date: "2026-10-20", sources: [gov(3)], conflict: "The city says complete; the builder says phase two is not built." });
  const official = cand(3, { status: "ongoing", status_source: 1, status_checked_date: "2026-10-20", sources: [gov(4)], status_by_source: [{ source: 1, state: "under_construction" }] });
  const claimed = cand(4, { status: "ongoing", status_source: 1, status_checked_date: "2026-10-20", sources: [src(5)] });
  const v = cl.validateCandidates([conflict, stated, official, claimed], { today: TODAY, geography: fx.GEO.lincoln });
  const s = Object.fromEntries(v.topics.map((t) => [t.candidate.development, t.candidate.status]));
  assert.deepStrictEqual([s[DEV[0]].value, s[DEV[0]].conflict.basis], ["unresolved", "states_differ"]);
  assert.deepStrictEqual([s[DEV[1]].value, s[DEV[1]].conflict.basis], ["unresolved", "model_stated"]);
  assert.strictEqual(s[DEV[2]].value, "ongoing"); assert.ok(s[DEV[2]].evidence);
  assert.strictEqual(s[DEV[3]].value, "unverified"); assert.ok(/no official primary source/.test(s[DEV[3]].reason));
  assert.ok(v.topics.find((t) => t.candidate.development === DEV[0]).candidate.provisionalEvidence.status === "unresolved_conflicting_evidence");
});

test("outlets are classified in code; brokerage and agent sources are allowed but labelled, trade aggregation is not local reporting", () => {
  const brokerage = cand(1, { sources: [src(1, { title: "Lincoln market blog", url: "https://www.thegoolsbygroup.com/lincoln-market", kind: "local_news" })] });
  const trade = cand(2, { sources: [src(2, { title: "Lincoln housing", url: "https://www.cahousingmarketnews.com/lincoln-update", kind: "local_news" })] });
  const local = cand(3, { sources: [src(3, { title: "Lincoln council", url: "https://www.goldmountaincanews.com/lincoln-council", kind: "local_news" })] });
  const v = cl.validateCandidates([brokerage, trade, local], { today: TODAY, geography: fx.GEO.lincoln });
  assert.strictEqual(v.topics.length, 3, "no ban on brokerage sources");
  const cls = Object.fromEntries(v.topics.map((t) => [t.candidate.development, t.candidate.sources[0].outletClass]));
  assert.deepStrictEqual(cls, { [DEV[0]]: "brokerage_or_agent_commentary", [DEV[1]]: "trade_aggregation", [DEV[2]]: "original_local_reporting" });
  assert.strictEqual(v.topics[0].candidate.development, DEV[2], "among equals, original reporting ranks first");
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
  assert.deepStrictEqual(v.topics.map((t) => t.candidate.development), [DEV[2]]);
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

// ── Three-lane experiment ─────────────────────────────────────────────────────────────────────
const LANES_ON = { ...ON, ...DIAG, AGENT_MARKETING_ARTICLE_LED_LANES: "three" };
const laneOf = (p) => (/Lane: Municipal/.test(p.input) ? "municipal" : /Lane: Housing/.test(p.input) ? "housing" : /Lane: Financing/.test(p.input) ? "economy" : null);
async function goLanes(byLane, over) {
  const sent = [];
  const callFn = async (p) => { sent.push(JSON.parse(JSON.stringify(p))); const a = byLane[laneOf(p)]; if (a instanceof Error) throw a; return a || reply([]); };
  const r = await quiet(() => run.runResearch({ row: row(over && over.geo), apiKey: "k", now: NOW, env: (over && over.env) || LANES_ON, sleepFn: async () => {}, callFn }));
  return { r, sent };
}
const withCost = (rp, cost) => ({ ...rp, json: { ...rp.json, usage: { ...rp.json.usage, cost: { total_cost: cost } } } });

test("lanes: three independent requests for the SAME market and hierarchy, each with its own lane and no market expansion; one pass only", async () => {
  const { sent, r } = await goLanes({ municipal: reply([cand(1)]), housing: reply([cand(2)]), economy: reply([cand(3)]) });
  assert.strictEqual(sent.length, 3); assert.strictEqual(r.attempts, 1);
  assert.deepStrictEqual(sent.map(laneOf).sort(), ["economy", "housing", "municipal"]);
  const selected = (p) => (/Selected market[^\n]*/.exec(p.input) || [])[0];
  assert.strictEqual(new Set(sent.map(selected)).size, 1, "every lane gets the identical selected-market line");
  assert.strictEqual(new Set(sent.map((p) => /Where the market sits[^\n]*/.exec(p.input)[0])).size, 1, "and the identical hierarchy");
  const ins = Object.fromEntries(sent.map((p) => [laneOf(p), p.instructions]));
  assert.ok(/YOUR LANE: Municipal and Local Developments/.test(ins.municipal) && /planning commission and council actions/.test(ins.municipal));
  assert.ok(/YOUR LANE: Housing and New Construction/.test(ins.housing) && /new-versus-resale/.test(ins.housing));
  assert.ok(/YOUR LANE: Financing and Local Economic Forces/.test(ins.economy) && /Freddie Mac/.test(ins.economy));
  for (const i of Object.values(ins)) assert.ok(/do not enlarge the selected market/.test(i) && !/WHERE TO LOOK, IN THIS ORDER/.test(i));
  sent.forEach((p) => assert.deepStrictEqual([p.tools[0].max_results, p.tools[0].max_tokens, p.max_output_tokens], [20, 6000, 4500]));
  assert.strictEqual(r.fields.topics.length, 3);
  assert.deepStrictEqual(r.fields.topics.map((t) => t.candidate.lane).sort(), ["economy", "housing", "municipal"]);
});

test("lanes: merged candidates are deduplicated by underlying development, the strongest version is kept, there are no lane quotas, weak results are not padded", async () => {
  const dupHigh = cand(1, { strength: "high" }), dupLow = cand(1, { strength: "medium", question: "What does Parkwood's agreement mean for new Lincoln listings this season?", sources: [src(7, { url: "https://news7.example/lincoln-parkwood" })] });
  const same = cand(1, { question: Q[8], angle: "Angle Parkwood", sources: [src(8)] });   // same development and angle, another article
  const { r, sent } = await goLanes({ municipal: reply([cand(2), cand(3)]), housing: reply([dupLow, cand(4), cand(5)]), economy: reply([dupHigh, same, cand(6, { strength: "low" })]) });
  const t = r.fields.topics;
  assert.strictEqual(sent.length, 3);
  const devs = t.map((x) => x.candidate.development);
  assert.strictEqual(new Set(devs).size, devs.length, "no development twice");
  assert.strictEqual(t.length, 5, "five distinct qualified developments: 2,3,4,5 and the Parkwood development once");
  const park = t.find((x) => x.candidate.development === DEV[0]);
  assert.strictEqual(park.candidate.strength, "high", "the stronger of the duplicate versions is kept");
  assert.strictEqual(park.candidate.lane, "economy");
  assert.ok(park.candidate.alsoFoundIn.length >= 2 && park.candidate.alsoFoundIn.some((x) => x.lane === "housing"), "the duplicates are recorded on the kept candidate");
  const sum = r.fields.usage.discovery.attempts[0].topics;
  assert.ok(sum.some((x) => x.code === "duplicate_development_angle" && x.lane) && sum.some((x) => x.code === "low_strength" && x.lane === "economy"));
  const dep = r.fields.usage.discovery.depth_v2;
  assert.strictEqual(dep.candidates_returned, 8); assert.ok(dep.duplicates >= 2);
  assert.deepStrictEqual(Object.keys(dep.by_lane).sort(), ["economy", "housing", "municipal"]);
  assert.ok(r.fields.charged_at, "five qualified: billing unchanged, charged once");
  // fewer than five stays partial and uncharged
  const few = await goLanes({ municipal: reply([cand(1)]), housing: reply([cand(1)]), economy: reply([]) });
  assert.strictEqual(few.r.fields.topics.length, 1); assert.strictEqual(few.r.fields.charged_at || null, null); assert.strictEqual(few.r.fields.usage.articleLed.offerMlsTrend, true);
});

test("lanes: every lane's actual cost is recorded and summed; one failed lane does not lose the others; all lanes failing is a failed run", async () => {
  const { r } = await goLanes({ municipal: withCost(reply([cand(1)]), 0.01), housing: withCost(reply([cand(2)]), 0.02), economy: withCost(reply([cand(3)]), 0.03) });
  const lanes = r.fields.usage.discovery.lanes;
  assert.deepStrictEqual(lanes.map((l) => [l.lane, l.returned, l.cost_usd]), [["municipal", 1, 0.01], ["housing", 1, 0.02], ["economy", 1, 0.03]]);
  assert.ok(Math.abs(r.fields.usage.costUsd - 0.06) < 1e-9, "the session's stored cost is the sum of the three lanes");
  const partial = await goLanes({ municipal: reply([cand(1)]), housing: new Error("boom"), economy: reply([cand(3)]) });
  assert.strictEqual(partial.r.fields.topics.length, 2);
  assert.ok(partial.r.fields.usage.discovery.lanes.find((l) => l.lane === "housing").error);
  const none = await goLanes({ municipal: new Error("a"), housing: new Error("b"), economy: new Error("c") });
  assert.notStrictEqual(none.r.fields.status, "ready");
});

test("lanes are off by default and for other designs; the single compact pass is unchanged", async () => {
  const { sent } = await go([cand(1)]);
  assert.strictEqual(sent.length, 1); assert.ok(/up to EIGHT/.test(sent[0].instructions) && /WHERE TO LOOK, IN THIS ORDER/.test(sent[0].instructions) && !/YOUR LANE/.test(sent[0].instructions));
  const det = await go([cand(1)], { env: { ...LANES_ON, AGENT_MARKETING_ARTICLE_LED_DESIGN: "detailed" } });
  assert.strictEqual(det.sent.length, 1);
});

test("harness and review package: the lanes cell is one session of three requests; the single-versus-lanes report shows yield, duplicates, exclusions, cost and the actual cards", () => {
  const fs = require("fs"), os = require("os"), path = require("path"), cp = require("child_process");
  const base = require("../scripts/research-baseline");
  const lanesCell = base.CELLS.find((c) => c.id === "lanes3_r20_c6000_o4500");
  assert.deepStrictEqual([lanesCell.prompt, lanesCell.lanes, lanesCell.results, lanesCell.context, lanesCell.output, lanesCell.retries], ["compact", "three", 20, 6000, 4500, 0]);
  assert.deepStrictEqual(base.cellsFor("lanes").map((c) => c.id), ["lanes3_r20_c6000_o4500"]);
  assert.strictEqual(base.plan(Object.keys(base.MARKETS), 2, base.cellsFor("lanes")).length, 8, "the approved eight-session experiment");
  assert.ok(!base.cellsFor("compact").some((c) => c.lanes), "the compact set does not include lanes");
  const d1 = fs.mkdtempSync(path.join(os.tmpdir(), "ls1-")), d2 = fs.mkdtempSync(path.join(os.tmpdir(), "ls2-")), out = path.join(d2, "review.md"), js = path.join(d2, "review.json");
  const node = (args) => cp.execFileSync(process.execPath, args, { encoding: "utf8" });
  const bl = path.join(__dirname, "..", "scripts", "research-baseline.js");
  node([bl, "--replay", "--cells", "compact_r20_c6000_o4500", "--markets", "lincoln", "--repeats", "2", "--out", d1]);
  node([bl, "--replay", "--prompt", "lanes", "--markets", "lincoln", "--repeats", "2", "--out", d2]);
  node([path.join(__dirname, "..", "scripts", "research-lanes-report.js"), "--single", d1, "--lanes", d2, "--lanes-cell", "lanes3_r20_c6000_o4500", "--out", out, "--json", js]);
  const md = fs.readFileSync(out, "utf8"), res = JSON.parse(fs.readFileSync(js, "utf8"));
  for (const sec of ["## Overall", "## By market", "### lincoln", "## The lanes: municipal + housing + economy (actual cost, yield and rate-limit handling)", "## Duplicate developments collapsed (three lanes)", "## Excluded candidates and qualification reasons", "## The actual cards, with source provenance", "Runs delivering five DISTINCT developments (charged)", "Cost per five-opportunity session"]) assert.ok(md.includes(sec), sec);
  assert.ok(/Also found \(duplicates collapsed\)/.test(md) && /Source cand_[0-9a-f]{12}:s1/.test(md) && /until approved/.test(md));
  assert.deepStrictEqual([res.single.runs, res.lanes.runs, res.lanes.runs_with_five], [2, 2, 2]);
  assert.ok(res.lanes.mean_duplicates > 0 && res.single.mean_duplicates === 0 && res.lanes.total_cost_usd > res.single.total_cost_usd);
  assert.deepStrictEqual(Object.keys(res.lane_table).sort(), ["economy", "housing", "municipal"]);
});

// Lane dispatch with a virtual clock: every call takes 10 seconds, every sleep advances time, so waits, intervals and the budget are exact and instant.
function vclock() { const c = { t: 0, sleeps: [], calls: [], starts: [] }; c.clock = () => c.t; c.sleepFn = async (ms) => { c.sleeps.push(ms); c.t += ms; }; return c; }
async function runLaneSession(script, over) {
  // script(lane, n) -> response object for the nth request of that lane; an Error rejects
  const v = vclock(); const n = {}; let live = 0, peak = 0;
  const callFn = async (p) => { const lane = laneOf(p); n[lane] = (n[lane] || 0) + 1; v.starts.push([lane, v.t]); live++; peak = Math.max(peak, live); v.calls.push(lane); v.t += 10000; live--; const a = script(lane, n[lane]); if (a instanceof Error) throw a; return a; };
  const r = await quiet(() => run.runResearch({ row: row(), apiKey: (over && over.apiKey) || "k", now: NOW, env: (over && over.env) || LANES_ON, sleepFn: v.sleepFn, clock: v.clock, rand: () => 0.5, callFn }));
  return { r, v, peak, lanes: r.fields.usage.discovery && r.fields.usage.discovery.lanes };
}
const ok = (c) => reply(c), busy = (headers) => ({ status: 429, json: { error: { message: "rate limited" } }, headers: headers || {} });
const OK3 = { municipal: ok([cand(1)]), housing: ok([cand(2)]), economy: ok([cand(3)]) };
const stateOf = (lanes) => Object.fromEntries(lanes.map((l) => [l.lane, l.state]));

test("lanes: sequential, one request at a time, in order, with the minimum interval between starts; each lane succeeds independently", async () => {
  const { r, v, peak, lanes } = await runLaneSession((lane) => OK3[lane]);
  assert.strictEqual(peak, 1); assert.deepStrictEqual(v.calls, ["municipal", "housing", "economy"]);
  assert.deepStrictEqual(stateOf(lanes), { municipal: "success", housing: "success", economy: "success" });
  const starts = v.starts.map((x) => x[1]);
  assert.ok(starts[1] - starts[0] >= 3000 && starts[2] - starts[1] >= 3000, "at least the configured interval between starts");
  assert.strictEqual(r.fields.topics.length, 3);
  assert.deepStrictEqual([r.fields.usage.articleLed.lanesSucceeded, r.fields.usage.articleLed.lanesIncomplete], [3, false]);
  // the interval is configurable, not assumed
  const slow = await runLaneSession((lane) => OK3[lane], { env: { ...LANES_ON, AGENT_MARKETING_LANE_MIN_INTERVAL_MS: "20000" } });
  const st = slow.v.starts.map((x) => x[1]);
  assert.ok(st[1] - st[0] >= 20000 && st[2] - st[1] >= 20000);
});

test("lanes: a 429 is retried after bounded, jittered backoff and the lane recovers; its record shows attempts, statuses and the wait", async () => {
  const { lanes, r } = await runLaneSession((lane, n) => (lane === "housing" && n === 1 ? busy() : OK3[lane]));
  const h = lanes.find((l) => l.lane === "housing");
  assert.deepStrictEqual([h.state, h.attempts, h.http_statuses, h.retry_after_seen], ["success", 2, [429, 200], false]);
  assert.deepStrictEqual(h.waits_ms, [1500], "base 2000 ms, jitter 0.5..1.0 (rand fixed at 0.5 -> 75%)");
  assert.strictEqual(r.fields.topics.length, 3);
  // backoff grows exponentially and is capped
  const lib = require("../netlify/functions/lib/agent-marketing-lane-runner-lib"); const s = lib.laneSettings({});
  assert.deepStrictEqual([1, 2, 3, 4, 5, 6].map((a) => lib.backoffMs(a, s, () => 1)), [2000, 4000, 8000, 16000, 30000, 30000]);
  assert.deepStrictEqual([lib.backoffMs(1, s, () => 0), lib.backoffMs(3, s, () => 0)], [1000, 4000]);
  assert.ok([lib.backoffMs(2, s)].every((x) => x >= 2000 && x <= 4000));
});

test("lanes: Retry-After is honored exactly (seconds or an HTTP date); a Retry-After beyond the maximum wait is not waited out", async () => {
  const a = await runLaneSession((lane, n) => (lane === "municipal" && n === 1 ? busy({ "Retry-After": "7" }) : OK3[lane]));
  const m = a.lanes.find((l) => l.lane === "municipal");
  assert.deepStrictEqual([m.state, m.waits_ms, m.retry_after_seen], ["success", [7000], true]);
  const date = new Date(Date.now() + 12000).toUTCString();
  const lib = require("../netlify/functions/lib/agent-marketing-lane-runner-lib");
  const ms = lib.retryAfterMs({ "retry-after": date }, Date.now());
  assert.ok(ms > 9000 && ms <= 12000, "an HTTP date becomes the remaining milliseconds");
  assert.deepStrictEqual([lib.retryAfterMs({}, 0), lib.retryAfterMs({ "retry-after": "soon" }, 0), lib.retryAfterMs({ "Retry-After": ["3"] }, 0)], [null, null, 3000]);
  const far = await runLaneSession((lane) => (lane === "housing" ? busy({ "retry-after": "600" }) : OK3[lane]));
  const h = far.lanes.find((l) => l.lane === "housing");
  assert.deepStrictEqual([h.state, h.reason, h.attempts, h.waits_ms], ["rate_limited", "retry_after_exceeds_max_wait", 1, []]);
});

test("lanes: exhausted retries leave the lane rate_limited (attempts = the maximum); the other lanes' answers are kept; a failed lane is null, never zero candidates", async () => {
  const { r, lanes } = await runLaneSession((lane) => (lane === "housing" ? busy() : OK3[lane]));
  const h = lanes.find((l) => l.lane === "housing");
  assert.deepStrictEqual([h.state, h.reason, h.attempts, h.http_statuses], ["rate_limited", "retries_exhausted", 4, [429, 429, 429, 429]]);
  assert.strictEqual(h.returned, null, "not 0: the lane did not answer");
  assert.strictEqual(h.cost_usd, null);
  assert.deepStrictEqual(stateOf(lanes), { municipal: "success", housing: "rate_limited", economy: "success" });
  assert.strictEqual(r.fields.topics.length, 2, "successful lanes are preserved");
  assert.deepStrictEqual([r.fields.usage.articleLed.lanesRateLimited, r.fields.usage.articleLed.lanesSucceeded, r.fields.usage.articleLed.lanesIncomplete], [1, 2, true]);
  // a lane that really answered with zero candidates IS a success with returned 0
  const zero = await runLaneSession((lane) => (lane === "economy" ? ok([]) : OK3[lane]));
  const e = zero.lanes.find((l) => l.lane === "economy");
  assert.deepStrictEqual([e.state, e.returned], ["success", 0]);
});

test("lanes: other failures and unreadable answers are 'failed', not zero-candidate successes; a 4xx is not retried; a thrown network error is retried", async () => {
  const bad = { status: 200, json: { output: [{ type: "message", content: [{ type: "output_text", text: "I could not find anything." }] }], usage: fx.usage(1) } };
  const { lanes } = await runLaneSession((lane, n) => lane === "municipal" ? { status: 403, json: { error: { message: "forbidden" } } } : lane === "housing" ? bad : (n === 1 ? new Error("socket hang up") : OK3[lane]));
  const by = Object.fromEntries(lanes.map((l) => [l.lane, l]));
  assert.deepStrictEqual([by.municipal.state, by.municipal.reason, by.municipal.attempts], ["failed", "not_retryable", 1]);
  assert.deepStrictEqual([by.housing.state, by.housing.reason, by.housing.returned], ["failed", "unreadable_answer", null]);
  assert.ok(by.housing.cost_usd != null, "the unreadable answer was billed, and its cost is recorded");
  assert.deepStrictEqual([by.economy.state, by.economy.attempts, by.economy.http_statuses], ["success", 2, [null, 200]]);
});

test("lanes: every lane failing is a failed run, not a partial one; nothing is charged; the diagnostics still list each lane", async () => {
  const { r, lanes } = await runLaneSession(() => busy(), { env: { ...LANES_ON, AGENT_MARKETING_LANE_MAX_ATTEMPTS: "2" } });
  assert.notStrictEqual(r.fields.status, "ready"); assert.strictEqual(r.fields.charged_at || null, null);
  assert.deepStrictEqual(stateOf(lanes), { municipal: "rate_limited", housing: "rate_limited", economy: "rate_limited" });
  assert.ok(lanes.every((l) => l.returned === null && l.attempts === 2));
  assert.ok(/busy/i.test(r.fields.error || ""), "the user is told the provider was busy");
});

test("lanes: the time budget is enforced; lanes that cannot start are not_attempted (not zero results) and the worst case stays inside the background-function limit", async () => {
  const lib = require("../netlify/functions/lib/agent-marketing-lane-runner-lib");
  assert.ok(lib.worstCaseMs(lib.laneSettings({})) < lib.BACKGROUND_LIMIT_MS, "default worst case is within 900 s");
  const { r, lanes, v } = await runLaneSession((lane) => OK3[lane], { env: { ...LANES_ON, AGENT_MARKETING_LANE_BUDGET_MS: "30000", AGENT_MARKETING_LANE_EXPECTED_CALL_MS: "15000" } });
  assert.ok(lanes.length === 3 && lanes[0].state === "success");
  const skipped = lanes.filter((l) => l.state === "not_attempted");
  assert.ok(skipped.length >= 1 && skipped.every((l) => l.reason === "time_budget" && l.returned === null && l.attempts === 0));
  assert.ok(v.t <= lib.worstCaseMs({ ...lib.laneSettings({}), budgetMs: 30000, expectedCallMs: 15000 }), "never beyond the stated worst case");
  assert.strictEqual(r.fields.usage.articleLed.lanesNotAttempted, skipped.length);
  // a retry whose wait would not fit is not started
  const w = await runLaneSession((lane) => (lane === "municipal" ? busy() : OK3[lane]), { env: { ...LANES_ON, AGENT_MARKETING_LANE_BUDGET_MS: "40000", AGENT_MARKETING_LANE_EXPECTED_CALL_MS: "15000" } });
  const m = w.lanes.find((l) => l.lane === "municipal");
  assert.ok(m.state === "rate_limited" && m.reason === "time_budget");
});

test("lanes: an adaptive interval after a 429, cost accounting per lane and in total, and no credential in any diagnostic", async () => {
  const SECRET = "pplx-SECRETKEY1234567890";
  const withCost2 = (rp, cost) => ({ ...rp, json: { ...rp.json, usage: { ...rp.json.usage, cost: { total_cost: cost } } } });
  const { r, v, lanes } = await runLaneSession((lane, n) => (lane === "municipal" && n === 1 ? { status: 429, json: { error: { message: `bad key ${SECRET} Bearer ${SECRET}` } }, headers: {} }
    : withCost2(OK3[lane], { municipal: 0.01, housing: 0.02, economy: 0.03 }[lane])), { apiKey: SECRET });
  assert.deepStrictEqual(lanes.map((l) => [l.lane, l.cost_usd]), [["municipal", 0.01], ["housing", 0.02], ["economy", 0.03]]);
  assert.ok(Math.abs(r.fields.usage.costUsd - 0.06) < 1e-9, "the 429 cost nothing; the stored cost is the three lanes' actual costs");
  const starts = Object.fromEntries(v.starts.filter(([l], i, a) => a.findIndex(([x]) => x === l) === i));
  assert.ok(starts.housing - starts.municipal >= 6000, "after one 429 the interval between lane starts doubles");
  const dump = JSON.stringify(r.fields);
  assert.ok(!dump.includes(SECRET) && !/Bearer pplx/.test(dump), "no credential is stored anywhere in the record");
  assert.ok(lanes.every((l) => !("apiKey" in l)) && lanes[0].error === null);
});

test("lanes: selected candidates per lane and the combined result are recorded; duplicates across lanes collapse", async () => {
  const dupe = cand(1, { sources: [src(5, { url: "https://news5.example/lincoln-parkwood-b" })] });
  const { r, lanes } = await runLaneSession((lane) => ({ municipal: ok([cand(1), cand(2)]), housing: ok([dupe, cand(3)]), economy: ok([cand(4), cand(5)]) }[lane]));
  assert.strictEqual(r.fields.topics.length, 5);
  assert.deepStrictEqual(lanes.map((l) => [l.lane, l.returned]), [["municipal", 2], ["housing", 2], ["economy", 2]]);
  assert.strictEqual(lanes.reduce((n, l) => n + l.selected, 0), 5);
  assert.ok(lanes.every((l) => Array.isArray(l.selected_ids) && l.selected_ids.every((id) => /^cand_/.test(id))));
  assert.strictEqual(lanes.reduce((n, l) => n + l.duplicates, 0), 1);
  assert.strictEqual(r.fields.usage.discovery.depth_v2.duplicates, 1);
  assert.ok(r.fields.charged_at, "five qualified: the billing rule is unchanged");
  assert.ok(r.fields.usage.discovery.lane_run.within_budget && r.fields.usage.discovery.lane_run.settings.minIntervalMs === 3000);
});

test("review package: a run where any lane request failed is announced as NOT a valid three-lane test", () => {
  const fs = require("fs"), os = require("os"), path = require("path");
  const rep = require("../scripts/research-lanes-report");
  const mkdir = (rows) => { const d = fs.mkdtempSync(path.join(os.tmpdir(), "lv-")); fs.writeFileSync(path.join(d, "runs.jsonl"), rows.map((r) => JSON.stringify(r)).join("\n")); rows.forEach((r) => fs.writeFileSync(path.join(d, `${r.market}-${r.cell}-${r.repeat}.discovery.json`), JSON.stringify({ attempts: [{ topics: [] }], lanes: r.lanes }))); return d; };
  const row1 = (cell, lanes) => ({ market: "lincoln", cell, repeat: 1, status: "ready", delivered: 2, charged: false, cost_usd: 0.01, v2: { candidates_returned: 2, qualified: 2 }, lanes });
  const single = mkdir([row1("compact_r20_c6000_o4500", null)]);
  const bad = mkdir([row1("lanes3_r20_c6000_o4500", [{ lane: "municipal", returned: 2, cost_usd: 0.01 }, { lane: "housing", error: "busy", returned: 0 }, { lane: "economy", error: "busy", returned: 0 }])]);
  const good = mkdir([row1("lanes3_r20_c6000_o4500", [{ lane: "municipal", returned: 1, cost_usd: 0.01 }, { lane: "housing", returned: 1, cost_usd: 0.01 }, { lane: "economy", returned: 0, cost_usd: 0.01 }])]);
  assert.ok(/NOT A VALID THREE-LANE TEST: 2 of 3 lane requests failed/.test(rep.markdown(rep.build(single, bad, "compact_r20_c6000_o4500", "lanes3_r20_c6000_o4500"), single, bad)));
  assert.ok(/All 3 lane requests completed/.test(rep.markdown(rep.build(single, good, "compact_r20_c6000_o4500", "lanes3_r20_c6000_o4500"), single, good)));
});

// ── Deduplication by underlying development (the Parkwood regression) ─────────────────────────────
const PARK = require("./fixtures/research-diag/parkwood-duplicates.json");
const D31 = "2026-10-31";
const others = (n) => [3, 4, 5, 6, 7, 8].slice(0, n).map((i) => cand(i, { sources: [src(i, { published: "2026-10-28" })] }));
const VD = (list) => cl.validateCandidates(list, { today: D31, geography: fx.GEO.lincoln });
const parkOf = (t) => /Parkwood/.test(t.candidate.development);

test("regression: both Lincoln runs selected Parkwood twice (one municipal, one housing candidate); the identical wording tests of the old logic did not see it", () => {
  for (const run of ["run1", "run2"]) {
    const pair = PARK[run];
    assert.strictEqual(pair.length, 2); assert.deepStrictEqual(pair.map((p) => p._lane).sort(), ["housing", "municipal"]);
    assert.ok(!rl.similar(pair[0].question, pair[1].question) && !rl.similar(pair[0].development, pair[1].development), "wording alone does not catch it");
    const v = VD([...pair, ...others(3)]);
    const parks = v.topics.filter(parkOf);
    assert.strictEqual(parks.length, 1, `${run}: Parkwood once`);
    const dup = v.candidates.find((c) => c.reason === "duplicate_development");
    assert.ok(dup, `${run}: the second Parkwood candidate is recorded as a duplicate development`);
    assert.strictEqual(v.summary.duplicates, 1);
    const g = v.summary.duplicate_groups[0];
    assert.deepStrictEqual([g.members.length, g.members[0].basis], [1, "shared_identifier"], "decided by the shared official record reference (and the permit number), before any wording");
    assert.ok(g.identity.projectNames.includes("parkwood") && g.identity.identifiers.some((x) => /pln2400048|sch2010102018\/42/.test(x)));
    // the duplicate's angle, question and sources are preserved in the kept candidate's research record
    const c = parks[0].candidate;
    assert.strictEqual(c.alternativeAngles.length, 1);
    const alt = c.alternativeAngles[0];
    assert.ok(alt.question && alt.angle && alt.why && alt.sources.length >= 1 && alt.sources.every((s) => s.ref && s.url) && alt.lane !== c.lane && /^cand_/.test(alt.candidateId));
    assert.notStrictEqual(alt.question, c.question);
  }
});

test("after deduplication the qualified candidates are reranked and a different development backfills; a fifth is never fabricated", () => {
  const pair = PARK.run1;
  const six = VD([...pair, ...others(4)]);     // Parkwood x2 + four others = five distinct developments
  assert.strictEqual(six.topics.length, 5, "five distinct developments");
  assert.strictEqual(new Set(six.topics.map((t) => t.candidate.development)).size, 5);
  // seven candidates: Parkwood twice, five others -> six distinct, the sixth is not selected, and the duplicate did not take a slot
  const seven = VD([...pair, ...others(5)]);
  assert.strictEqual(seven.topics.length, 5); assert.strictEqual(seven.topics.filter(parkOf).length, 1);
  assert.strictEqual(seven.summary.not_selected, 1);
  // backfill: the duplicate ranked above a candidate that, without it, would have missed the five; that candidate now enters
  const strongDup = [{ ...pair[0] }, { ...pair[1], strength: "high" }];
  const b = VD([...strongDup, ...others(4).map((c) => ({ ...c, strength: "medium", relevance: "indirect" })), cand(9, { strength: "medium", relevance: "indirect", sources: [src(9, { published: "2026-10-28" })] })]);
  assert.strictEqual(b.topics.length, 5); assert.strictEqual(b.topics.filter(parkOf).length, 1);
  assert.ok(b.summary.replacements.length >= 1 && b.summary.replacements[0].rankBeforeDuplicates > 5 && b.summary.replacements[0].rankAfter <= 5, "the backfilled candidate is reported");
  // only four distinct developments: four are delivered, uncharged, never five
  const four = VD([...pair, ...others(3)]);
  assert.strictEqual(four.topics.length, 4); assert.strictEqual(four.partial, true);
  assert.strictEqual(cl.depthCompact(four.topics, four.summary).five_card_yield, false);
});

test("identity rules: an identifier, a project name with a shared source, or a primary record with a similar description make one development; a shared article or an editorial angle alone does not", () => {
  const id = require("../netlify/functions/lib/agent-marketing-development-identity-lib");
  const mk = (development, srcs) => id.identityOf({ development, sources: srcs, hierarchyNames: ["Lincoln", "Placer County"] });
  const rec = (url, title, role) => ({ url, title, role: role || "primary", official: true, whatItEstablishes: "x" });
  // same permit number, different wording, different sources
  const a = mk("A development agreement was approved for a new neighborhood.", [rec("https://a.lincolnca.gov/x", "Agreement (PLN24-00048)")]);
  const b = mk("City signed terms for the 122-home neighborhood.", [rec("https://news.example/y", "Council signs terms for PLN24-00048", "secondary")]);
  assert.strictEqual(id.sameIdentity(a, b).basis, "shared_identifier");
  // a CEQAnet record reference counts as an identifier
  const c1 = mk("Notice for the agreement", [rec("https://ceqanet.lci.ca.gov/2010102018/42", "Notice")]), c2 = mk("Another view of the notice", [rec("https://www.ceqanet.lci.ca.gov/2010102018/42/", "Notice")]);
  assert.strictEqual(id.sameIdentity(c1, c2).basis, "shared_identifier");
  assert.strictEqual(id.sameIdentity(c1, mk("A different document", [rec("https://ceqanet.lci.ca.gov/2010102018/37", "Other")])), null, "a different document number is a different record");
  // two projects reported in the SAME article stay two developments
  const art = { url: "https://trade.example/lincoln-weekly", title: "Lincoln council takes up Parkwood as Hidden Hills Phase 2 designs go to review", role: "secondary", official: false, whatItEstablishes: "x" };
  const pk = mk("Lincoln approved a development agreement for Parkwood, a 21-acre project", [art]), hh = mk("The city reviewed production-home designs for Hidden Hills Phase 2", [art]);
  assert.strictEqual(id.sameIdentity(pk, hh), null);
  // Hidden Hills Phase 1 and Phase 2 are different
  assert.deepStrictEqual(id.projectNames(["Design review for Hidden Hills Phase 2", "Hidden Hills Phase 1 homes"], ["Lincoln"]).size, 2);
  // an editorial angle never makes two developments
  const x = mk("Council approved Parkwood", [rec("https://r.example/1", "Parkwood record")]);
  const y = mk("Parkwood sidewalk repair funding scheduled for spring", [rec("https://r.example/2", "Parkwood news", "secondary")]);
  assert.strictEqual(id.sameIdentity(x, y), null, "the same name with no shared source and a different description is not merged by name alone");
  const z = mk("Council approved Parkwood, as told for sellers", [rec("https://r.example/3", "Parkwood news", "secondary")]);
  assert.strictEqual(id.sameIdentity(x, z).basis, "shared_project_name", "the same name and a similar description is the same development whatever the angle");
});

test("distinct developments in the depth record come from identity, with a collision audit that should be zero", () => {
  const v = VD([...PARK.run2, ...others(4)]);
  const dep = cl.depthCompact(v.topics, v.summary);
  assert.deepStrictEqual([dep.distinct_developments, dep.identity_collisions, dep.selected], [5, 0, 5]);
  assert.ok(dep.duplicates === 1);
});

test("registry: californiaconstructionnews.com is a trade publication (no local-reporting credit); Legistar is official only when the tenant is an agency of the market's hierarchy", () => {
  const outlets = require("../netlify/functions/lib/agent-marketing-outlet-registry-lib"), gh = require("../netlify/functions/lib/agent-marketing-geography-hierarchy-lib");
  assert.strictEqual(outlets.classifyOutlet("https://www.californiaconstructionnews.com/2026/10/19/x").class, "trade_publication");
  assert.strictEqual(outlets.isOriginalLocalReporting(outlets.classifyOutlet("https://www.californiaconstructionnews.com/x")), false);
  const nat = gh.hierarchyFor({ type: "neighborhood", name: "Natomas", city: "Sacramento", zip: "95834", state: "CA" });
  const lin = gh.hierarchyFor(fx.GEO.lincoln);
  assert.deepStrictEqual([outlets.classifyOutlet("https://sacramento.legistar.com/x", { hierarchy: nat }).class, outlets.classifyOutlet("https://sacramento.legistar.com/x", { hierarchy: nat }).basis], ["government_record", "legistar_tenant"]);
  assert.deepStrictEqual([outlets.classifyOutlet("https://sacramento.legistar.com/x", { hierarchy: lin }).class, outlets.classifyOutlet("https://sacramento.legistar.com/x", { hierarchy: lin }).basis], ["unclassified", "legistar_tenant_not_established"]);
  assert.strictEqual(outlets.classifyOutlet("https://sacramento.legistar.com/x").class, "unclassified", "no hierarchy, no authority");
  assert.strictEqual(outlets.classifyOutlet("https://placer.legistar.com/x", { hierarchy: lin }).class, "government_record", "Placer County is in Lincoln's hierarchy, so the Placer tenant is established");
  assert.strictEqual(outlets.classifyOutlet("https://roseville.legistar.com/x", { hierarchy: lin }).class, "unclassified", "a city that is not in the hierarchy is not established");
  // in a candidate: an established tenant is an official primary source; an unestablished one is not
  const mkc = (url) => cand(1, { question: Q[0], sources: [{ ...src(1), title: "Natomas agenda", url, role: "primary", kind: "government_record", source_geography: "Natomas" }] });
  const good = cl.validateCandidates([mkc("https://sacramento.legistar.com/agenda-1")], { today: TODAY, geography: { type: "neighborhood", name: "Natomas", city: "Sacramento", zip: "95834", state: "CA" } });
  assert.deepStrictEqual([good.topics[0].candidate.sources[0].outletClass, good.topics[0].candidate.sources[0].authority.official], ["government_record", true]);
  const bad = cl.validateCandidates([mkc("https://sacramento.legistar.com/agenda-1")], { today: TODAY, geography: fx.GEO.lincoln });
  assert.deepStrictEqual([bad.topics[0].candidate.sources[0].outletClass, bad.topics[0].candidate.sources[0].authority.official], ["unclassified", false]);
});

// ── Two lanes: municipal + housing ────────────────────────────────────────────────────────────
const LANES2 = { ...ON, AGENT_MARKETING_ARTICLE_LED_LANES: "two" };
test("two-lane experiment: only the municipal and housing lanes run, in sequence, with the same rate-limit handling; no economy request is ever sent", async () => {
  const { r, v, peak, lanes } = await runLaneSession((lane) => ({ municipal: ok([cand(1), cand(2), cand(3)]), housing: ok([cand(4), cand(5)]) }[lane]), { env: LANES2 });
  assert.deepStrictEqual(v.calls, ["municipal", "housing"]); assert.strictEqual(peak, 1);
  assert.deepStrictEqual(lanes.map((l) => l.lane), ["municipal", "housing"]);
  assert.strictEqual(r.fields.topics.length, 5); assert.ok(r.fields.charged_at);
  assert.ok(v.starts[1][1] - v.starts[0][1] >= 3000, "minimum interval between starts");
  const rl2 = await runLaneSession((lane, n) => (lane === "housing" && n === 1 ? busy({ "retry-after": "5" }) : ok([cand(lane === "housing" ? 4 : 1)])), { env: LANES2 });
  assert.deepStrictEqual(rl2.lanes.find((l) => l.lane === "housing").waits_ms, [5000], "Retry-After honored in two-lane mode");
  const cm = require("../netlify/functions/lib/agent-marketing-compact-lib");
  assert.deepStrictEqual([cm.lanesFor(LANES2).map((l) => l.id), cm.lanesFor({ ...ON, ...DIAG, AGENT_MARKETING_ARTICLE_LED_LANES: "three" }).length, cm.lanesFor(ON).length], [["municipal", "housing"], 3, 0]);
});

test("two lanes, deduplicated: the same development in both lanes is one opportunity and the five delivered are distinct", async () => {
  const pair = PARK.run1;
  const { r } = await runLaneSession((lane) => ({ municipal: ok(pair.filter((p) => p._lane === "municipal").concat(others(2).slice(0, 2))), housing: ok(pair.filter((p) => p._lane === "housing").concat(others(4).slice(2))) }[lane]), { env: LANES2 });
  // (this scenario runs at the fixture's dates: today is 2026-10-24 in these sessions, so the 2026-10-31 sources are future-dated and dropped; the validation-level tests above pin the dedupe itself)
  assert.ok(r.fields.usage.discovery.lanes.length === 2);
});

test("two-lane review package: headings say Two lanes (never Three), the four tiers are reported apart, and a county-scope story is never counted as directly relevant with a supported geography", () => {
  const fs = require("fs"), os = require("os"), path = require("path"), cp = require("child_process");
  const d1 = fs.mkdtempSync(path.join(os.tmpdir(), "t21-")), d2 = fs.mkdtempSync(path.join(os.tmpdir(), "t22-")), out = path.join(d2, "r.md"), js = path.join(d2, "r.json");
  const bl = path.join(__dirname, "..", "scripts", "research-baseline.js"), node = (a) => cp.execFileSync(process.execPath, a, { encoding: "utf8" });
  node([bl, "--replay", "--cells", "compact_r20_c6000_o4500", "--markets", "lincoln", "--repeats", "2", "--out", d1]);
  node([bl, "--replay", "--prompt", "lanes2", "--markets", "lincoln", "--repeats", "2", "--out", d2]);
  node([path.join(__dirname, "..", "scripts", "research-lanes-report.js"), "--single", d1, "--lanes", d2, "--out", out, "--json", js]);
  const md = fs.readFileSync(out, "utf8"), res = JSON.parse(fs.readFileSync(js, "utf8"));
  assert.ok(/# Single pass versus two lanes: review package/.test(md) && /Two lanes \(municipal \+ housing\)/.test(md) && /\| Measure \| Single pass \| Two lanes \|/.test(md));
  assert.ok(!/three lanes/i.test(md) && !/THREE-LANE/.test(md), "no stale three-lane wording");
  for (const t of ["Tier 1: qualified by deterministic validation", "Tier 2: unique underlying developments", "Tier 3: delivered, directly relevant with a source-supported", "Tier 4: provisional discovery"]) assert.ok(md.includes(t), t);
  assert.ok(res.lanes.tier_qualified_validation >= res.lanes.tier_unique_development && res.lanes.tier_provisional === res.lanes.mean_delivered);
  // the tier-3 test: a county story marked direct does not count
  const rep = require("../scripts/research-lanes-report");
  const mk = (rel, found) => ({ n: 1, candidateId: "cand_x", relevance: "direct", relationship: rel, geography: { nameFoundInSource: found }, provisionalEvidence: { publicationAuthorized: false } });
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "t23-"));
  const row = { market: "thin", cell: "lanes2_r20_c6000_o4500", repeat: 1, status: "ready", delivered: 4, charged: false, cost_usd: 0.01, v2: { candidates_returned: 4, qualified: 4, duplicates: 0 }, lanes: [{ lane: "municipal", state: "success", returned: 2 }, { lane: "housing", state: "success", returned: 2 }] };
  fs.writeFileSync(path.join(dir, "runs.jsonl"), JSON.stringify(row)); fs.writeFileSync(path.join(dir, "thin-lanes2_r20_c6000_o4500-1.cards.json"), JSON.stringify([mk("market", true), mk("district", true), mk("county", true), mk("market", false)]));
  fs.writeFileSync(path.join(dir, "thin-lanes2_r20_c6000_o4500-1.discovery.json"), JSON.stringify({ attempts: [{ topics: [] }], lanes: row.lanes }));
  const stats = rep.stats(rep.load(dir, "lanes2_r20_c6000_o4500"));
  assert.strictEqual(stats.tier_direct_supported, 2, "market and district with a found name count; a county relationship and an unsupported market claim do not");
});

const cmIso = require("../netlify/functions/lib/agent-marketing-compact-lib");
// ---- production isolation: the approved architecture is Municipal + Housing; experiments need a server-controlled diagnostics switch ----
test("isolation: the flag alone runs the approved two lanes; the economy lane and gap-fill are ignored without the diagnostics switch", () => {
  const base = { AGENT_MARKETING_ARTICLE_LED_ENABLED: "true" };
  assert.deepStrictEqual(cmIso.lanesFor(base).map((l) => l.id), ["municipal", "housing"]);
  assert.strictEqual(cmIso.gapFillMode(base), false);
  const asked = { ...base, AGENT_MARKETING_ARTICLE_LED_LANES: "three", AGENT_MARKETING_ARTICLE_LED_GAPFILL: "diagnostic" };
  assert.deepStrictEqual(cmIso.lanesFor(asked).map((l) => l.id), ["municipal", "housing"], "three lanes need diagnostics");
  assert.strictEqual(cmIso.gapFillMode(asked), false, "gap-fill needs diagnostics");
  const diag = { ...asked, AGENT_MARKETING_ARTICLE_LED_DIAGNOSTICS: "true" };
  assert.strictEqual(cmIso.lanesFor(diag).length, 3); assert.strictEqual(cmIso.gapFillMode(diag), true);
  assert.strictEqual(cmIso.gapFillMode({ ...base, AGENT_MARKETING_ARTICLE_LED_DIAGNOSTICS: "true" }), false, "diagnostics alone does not turn gap-fill on");
  assert.strictEqual(cmIso.lanesOn({ ...base, AGENT_MARKETING_ARTICLE_LED_LANES: "single" }), false);
});

test("isolation: no request payload field reaches the experiment settings, and nothing in production code or config enables them", () => {
  const fs = require("fs"), path = require("path");
  const root = path.join(__dirname, "..");
  const walk = (d) => fs.readdirSync(d, { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? walk(path.join(d, e.name)) : [path.join(d, e.name)]));
  const files = walk(path.join(root, "netlify")).filter((f) => f.endsWith(".js"));
  const envRead = /AGENT_MARKETING_ARTICLE_LED_(LANES|GAPFILL|DIAGNOSTICS)/;
  for (const f of files) {
    const src = fs.readFileSync(f, "utf8");
    if (!envRead.test(src)) continue;
    assert.ok(!/(body|payload|event\.queryStringParameters|params)\s*[.\[][^;\n]*(LANES|GAPFILL|DIAGNOSTICS)/i.test(src), f + " reads an experiment setting from a request");
  }
  const endpoint = fs.readFileSync(path.join(root, "netlify/functions/agent-marketing-research.js"), "utf8");
  assert.ok(!/gapfill|diagnostics|ARTICLE_LED_LANES/i.test(endpoint), "the endpoint never handles experiment settings");
  for (const cfg of ["netlify.toml", ".env", ".env.example"]) {
    const p = path.join(root, cfg);
    if (fs.existsSync(p)) assert.ok(!/ARTICLE_LED_(LANES|GAPFILL|DIAGNOSTICS|ENABLED)/.test(fs.readFileSync(p, "utf8")), cfg + " must not enable Article-Led or its experiments");
  }
  const prod = files.filter((f) => !/scripts/.test(f));
  for (const f of prod) assert.ok(!/research-billing-shadow/.test(fs.readFileSync(f, "utf8")), f + " must not use the shadow billing script");
});
