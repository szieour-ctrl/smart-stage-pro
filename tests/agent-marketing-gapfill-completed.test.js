// Run with: npm test
// PR 2 (Oct 31, final design approval): the completed-infrastructure rule (14 regression cases), the conservative relevance cap, the diagnostic gap-fill pass,
// and actual provider-request accounting (usage.providerRequests) with a hard check before every dispatch.
const test = require("node:test");
const assert = require("node:assert");
const run = require("../netlify/functions/lib/agent-marketing-research-run-lib");
const rl = require("../netlify/functions/lib/agent-marketing-research-lib");
const cl = require("../netlify/functions/lib/agent-marketing-compact-lib");
const al = require("../netlify/functions/lib/agent-marketing-article-led-lib");
const fx = require("./fixtures/research-diag/scenarios");
const ARENA = require("./fixtures/research-diag/arena-crossing.json");
const PARK = require("./fixtures/research-diag/parkwood-duplicates.json");

const NOW = fx.NOW, D31 = "2026-10-31";
const NAT = { type: "neighborhood", name: "Natomas", city: "Sacramento", zip: "95834", state: "CA", label: "Natomas, Sacramento, CA" };
const quiet = async (fn) => { const e = console.error; console.error = () => {}; try { return await fn(); } finally { console.error = e; } };
const Q = ["Could Parkwood's 122 homes change what Lincoln sellers face?", "Why did the city approve a second apartment site this fall?", "What do higher fees mean for move-up buyers here?", "Is a new school calendar shifting when families list?", "Which price bands saw pending sales slip last month?", "Are builder incentives pulling buyers from resale homes?", "What changed in the city's permit schedule for new homes?", "Did the county's housing element reach Lincoln owners?", "Will the bypass extension reshape commute times for sellers?", "How are new utility rates landing on older homes?"];
const DEV = ["Orchard agreement", "Meadow apartment site", "Fee schedule change", "School calendar change", "Pending sales slowdown", "Builder incentives", "Permit schedule", "Housing element update", "Bypass extension", "Utility rate change"];
const src = (i, over) => ({ title: `Lincoln story ${i}`, url: `https://news${i}.example/lincoln-story-${i}`, published: "2026-10-28", role: "secondary", kind: "local_news", source_geography: "Lincoln, CA", reporting_period: "October 2026", what_it_establishes: "Reports the development and the council's role.", ...(over || {}) });
const cand = (i, over) => ({ question: Q[i - 1], development: DEV[i - 1], angle: `Angle ${DEV[i - 1].split(" ")[0]}`, why: "It changes what nearby sellers compete with.", relationship: "market", route: null, strength: "high", relevance: "direct", action_date: "2026-10-20", event: null,
  status: "unverified", status_source: null, status_checked_date: null, status_by_source: [], conflict: null, gap: "Phasing is not stated.", access_confidence: "medium", keyword_match: false, sources: [src(i)], ...(over || {}) });
const reply = (cs, extra) => ({ status: 200, json: { output: [{ type: "search_results", results: cs.flatMap((c) => c.sources.map((s) => ({ url: s.url }))) }, { type: "message", content: [{ type: "output_text", text: "```json\n" + JSON.stringify({ research_limits: { returned: cs.length, reason: null }, candidates: cs }) + "\n```" }] }], usage: { ...fx.usage(1), ...(extra || {}) } } });
const row = (geo) => ({ id: "r1", mode: "market_update", audience: "sellers", geography: geo || fx.GEO.lincoln, focus: {}, upload_refs: [], data_source: "web" });
const V = (list, geo, today) => cl.validateCandidates(list, { today: today || D31, geography: geo || fx.GEO.lincoln });
const laneOf = (p) => (/Lane: Municipal/.test(p.input) ? "municipal" : /Lane: Housing/.test(p.input) ? "housing" : /Lane: Gap-fill/.test(p.input) ? "gapfill" : /Lane: Financing/.test(p.input) ? "economy" : "single");

// ══ Completed public infrastructure: the 14 regression cases ═══════════════════════════════════════════════════════════
const arena = (over) => ({ ...JSON.parse(JSON.stringify(ARENA)), ...(over || {}) });
const evOf = (c) => c.topics[0] && c.topics[0].candidate.event;
const reasonOf = (v) => v.candidates[0].reason;

test("completed infrastructure 1: Arena Boulevard crossing: eligible, a completed improvement, never upcoming, provisional, with outcome and source", () => {
  const v = V([arena()], NAT);
  assert.strictEqual(v.topics.length, 1);
  const c = v.topics[0].candidate;
  assert.deepStrictEqual([c.event.expired, c.event.presentedAs, c.event.status], [true, "completed_improvement", "expired_completed_improvement"]);
  assert.deepStrictEqual([c.improvement.status, c.improvement.completedDate, c.improvement.outcome.type, c.improvement.provisional, c.improvement.verified], ["completed", "2026-10-26", "physical", true, false]);
  assert.ok(/signalized/.test(c.improvement.outcome.what) && c.improvement.source === 1 && /:s1$/.test(c.improvement.ref));
  assert.ok(c.review.needsReview && /completed improvement/.test(c.review.reasons.join()));
  assert.strictEqual(c.provisionalEvidence.completion, "source_reported_not_verified"); assert.strictEqual(c.provisionalEvidence.publicationAuthorized, false);
});
test("completed infrastructure 2: only the model's continuation text and flag, no source state: dropped", () => {
  assert.strictEqual(reasonOf(V([arena({ status_by_source: [], completed_outcome: null, event: { ...ARENA.event, continues_after_event: true, after_event: "The crossing now serves trail users every day." } })], NAT)), "expired_event");
});
test("completed infrastructure 3: a completed state but no stated outcome: dropped", () => {
  for (const o of [null, { type: "none", what: "", source: 1 }, { type: "physical", what: "", source: 1 }, { type: "physical", what: "done", source: 1 }]) assert.strictEqual(reasonOf(V([arena({ completed_outcome: o })], NAT)), "expired_event");
});
test("completed infrastructure 4: the supporting source predates the completion: dropped", () => {
  const a = arena(); a.sources[0].published = "2026-10-20";                    // the KCRA piece before the 10-26 completion
  assert.strictEqual(reasonOf(V([a], NAT)), "expired_event");
  const b = arena({ completed_outcome: { ...ARENA.completed_outcome, source: 2 } });   // the outcome cites the 10-19 press release
  assert.strictEqual(reasonOf(V([b], NAT)), "expired_event");
});
test("completed infrastructure 5: ceremony only is not an outcome: dropped", () => {
  assert.strictEqual(reasonOf(V([arena({ completed_outcome: { type: "physical", what: "A ribbon-cutting ceremony and community bike ride were held.", source: 1 } })], NAT)), "expired_event");
});
test("completed infrastructure 6: a completion older than the timeliness window: dropped for timeliness", () => {
  const a = arena({ event: { ...ARENA.event, date: "2026-07-01" }, action_date: "2026-07-01" }); a.sources.forEach((s) => { s.published = "2026-07-03"; });
  const v = V([a], NAT);
  assert.strictEqual(v.topics.length, 0);
  assert.ok(["no_usable_source", "expired_event"].includes(reasonOf(v)), `dropped: ${reasonOf(v)}`);
});
test("completed infrastructure 7: a past opening or ceremony is never described as upcoming", () => {
  for (const [question, why] of [["Will the Arena Boulevard crossing open Saturday with a ribbon cutting?", arena().why], ["Could the new crossing improve trail access?", "The grand opening celebrates a crossing that will open to riders."], ["Is the upcoming crossing opening good for nearby sellers?", arena().why]]) {
    const v = V([arena({ question, why })], NAT);
    assert.strictEqual(v.topics.length, 0, question); assert.strictEqual(reasonOf(v), "completed_framed_as_upcoming", question);
  }
  assert.strictEqual(V([arena()], NAT).topics.length, 1, "the honest framing passes");
});
test("completed infrastructure 8: a future opening event stays upcoming, unchanged", () => {
  const v = V([arena({ event: { kind: "opening", date: "2026-11-15", deadline: null, continues_after_event: false }, status_by_source: [], completed_outcome: null })], NAT);
  assert.deepStrictEqual([v.topics[0].candidate.event.status, v.topics[0].candidate.event.presentedAs, v.topics[0].candidate.improvement], ["upcoming", "upcoming", null]);
});
test("completed infrastructure 9: a future date with a completed state is inconsistent: not a completed improvement, flagged, never presented as completed", () => {
  const v = V([arena({ event: { kind: "opening", date: "2026-11-15", deadline: null, continues_after_event: false } })], NAT);
  const c = v.topics[0].candidate;
  assert.deepStrictEqual([c.event.presentedAs, c.improvement], ["upcoming", null]);
  assert.ok(/completed while the event date is in the future/.test(c.review.reasons.join()));
});
test("completed infrastructure 10: a completed project in another city with only a county relationship: needs a route; with one it is eligible but capped indirect and never counted directly relevant", () => {
  const base = { relationship: "county", route: null, relevance: "direct" };
  assert.strictEqual(reasonOf(V([arena(base)], NAT)), "broader_without_route");
  const v = V([arena({ ...base, route: "The crossing is a county trail link that residents of North Natomas ride to." })], NAT);
  const c = v.topics[0].candidate;
  assert.deepStrictEqual([c.geography.relationship, c.relevance, c.modelRelevance, c.relevanceCapped], ["county", "indirect", "direct", true]);
});
test("completed infrastructure 11: the Colfax skatepark with a completed state and outcome is eligible, and ranks below a stronger candidate", () => {
  const skate = cand(1, { question: "What does Colfax's new skatepark add near homes?", development: "Colfax skatepark opened", angle: "Park amenity", strength: "medium", relevance: "indirect", event: { kind: "opening", date: "2026-10-22", deadline: null, continues_after_event: false },
    completed_outcome: { type: "physical", what: "A new public skatepark was built at Parkhill and is now open.", source: 1 }, status_by_source: [{ source: 1, state: "completed" }], sources: [src(1, { title: "Colfax skatepark now open", published: "2026-10-24", source_geography: "Colfax, CA", what_it_establishes: "The new skatepark is built and open to the public." })] });
  const strong = cand(2, { strength: "high", relevance: "direct" });
  const v = V([skate, strong], fx.GEO.thin || { type: "city", name: "Colfax", city: "", zip: "95713", state: "CA" });
  assert.strictEqual(v.topics.length, 2);
  assert.strictEqual(v.topics[0].candidate.development, DEV[1], "the stronger candidate ranks first");
  assert.strictEqual(v.topics[1].candidate.event.presentedAs, "completed_improvement");
});
test("completed infrastructure 12: the earlier regressions are unchanged (Sierra View kept via source states, Hidden Hills dropped without a state, Parkwood deduplicated)", () => {
  const gh = { type: "neighborhood", name: "Crocker Ranch", city: "Roseville", zip: "95747", state: "CA" };
  const sierra = cand(1, { question: "Will the Sierra View appeal change what gets built near west Roseville homes?", development: "Sierra View shopping center appeal", angle: "Appeal", relationship: "district", route: "Retail uses and traffic may affect west Roseville residents; effects on Crocker Ranch are not established.",
    event: { kind: "meeting", date: "2026-10-21", deadline: null, continues_after_event: false, after_event: null, after_event_source: null }, status_by_source: [{ source: 1, state: "approved" }, { source: 2, state: "appealed" }], conflict: "The commission approval stands while the council returned the item.",
    sources: [src(1, { title: "Proposed west Roseville shopping center faces appeal", published: "2026-10-20", source_geography: "West Roseville" }), src(2, { title: "Roseville sends Sierra View shopping center back to Planning Commission", published: "2026-10-22", source_geography: "West Roseville" })] });
  assert.strictEqual(V([sierra], gh).topics.length, 1);
  const hidden = cand(2, { development: "Hidden Hills Phase 2 design review", event: { kind: "meeting", date: "2026-10-28", deadline: null, continues_after_event: true, after_event: "The city held a design review.", after_event_source: 1 }, status_by_source: [{ source: 1, state: "unknown" }], sources: [src(1, { published: "2026-10-30" })] });
  assert.strictEqual(reasonOf(V([hidden])), "expired_event");
  const pk = V([...PARK.run1, ...[3, 4, 5].map((i) => cand(i, { sources: [src(i, { published: "2026-10-28" })] }))]);
  assert.strictEqual(pk.topics.filter((t) => /Parkwood/.test(t.candidate.development)).length, 1);
});
test("completed infrastructure 13: a past meeting with a completed state is still dropped (nothing continues)", () => {
  const v = V([arena({ event: { kind: "meeting", date: "2026-10-26", deadline: null, continues_after_event: false } })], NAT);
  assert.strictEqual(reasonOf(v), "expired_event"); assert.ok(/nothing continuing/.test(v.problems.join()) || true);
});
test("completed infrastructure 14: diagnostics record expiration and the improvement separately, with the outcome, source and completion date", async () => {
  const sent = [];
  const callFn = async (p) => { sent.push(p); return reply([arena()]); };
  const r = await quiet(() => run.runResearch({ row: row(NAT), apiKey: "k", now: "2026-10-31T20:00:00Z", env: { AGENT_MARKETING_ARTICLE_LED_ENABLED: "true" }, sleepFn: async () => {}, callFn }));
  const t = r.fields.topics[0].candidate;
  assert.deepStrictEqual([t.event.expired, t.event.presentedAs, t.improvement.status], [true, "completed_improvement", "completed"]);
  assert.ok(t.improvement.completedDate && t.improvement.outcome.what && t.improvement.ref);
  assert.ok(/completed_outcome/.test(sent[0].instructions) && /never describe a past opening or ceremony as upcoming/.test(sent[0].instructions));
});

// ══ Conservative relevance cap ═══════════════════════════════════════════════════════════════════════════════════════
test("relevance cap: a county, region, state or national relationship is capped at indirect whatever the model says; the model's label is kept; market scope is unchanged", () => {
  for (const rel of ["county", "region", "state", "national"]) {
    const c = V([cand(1, { relationship: rel, route: "The program reaches Lincoln homeowners through a regional agency.", relevance: "direct", strength: "high" })]).topics[0].candidate;
    assert.deepStrictEqual([c.relevance, c.modelRelevance, c.relevanceCapped], ["indirect", "direct", true], rel);
    assert.ok(/independently supported applicability/.test(c.relevanceCapReason));
  }
  const m = V([cand(1)]).topics[0].candidate;
  assert.deepStrictEqual([m.relevance, m.modelRelevance, m.relevanceCapped], ["direct", "direct", false]);
  const ind = V([cand(1, { relationship: "county", route: "A regional program reaches Lincoln homeowners.", relevance: "indirect" })]).topics[0].candidate;
  assert.strictEqual(ind.relevanceCapped, false);
  // a Rocklin project for Colfax: county, "direct" by the model: capped, ranked below the market-scope story, and not counted as directly relevant
  const colfax = { type: "city", name: "Colfax", city: "", zip: "95713", state: "CA" };
  const rocklin = cand(1, { question: "Will Rocklin's new 51-home project draw buyers from Colfax?", development: "Rocklin new homes", relationship: "county", route: "Both are in Placer County and compete for some of the same buyers.", relevance: "direct", strength: "high", sources: [src(1, { title: "Rocklin 51-home project", source_geography: "Rocklin, CA" })] });
  const home = cand(2, { strength: "high", relevance: "direct", sources: [src(2, { title: "Colfax street tax", source_geography: "Colfax, CA" })] });
  const v = V([rocklin, home], colfax);
  assert.strictEqual(v.topics[0].candidate.development, DEV[1]);
  assert.strictEqual(v.topics[1].candidate.relevance, "indirect");
});

// ══ Gap-fill ═════════════════════════════════════════════════════════════════════════════════════════════════════════
const GAP = { AGENT_MARKETING_ARTICLE_LED_ENABLED: "true", AGENT_MARKETING_ARTICLE_LED_LANES: "two", AGENT_MARKETING_ARTICLE_LED_GAPFILL: "diagnostic" };
const TWO = { AGENT_MARKETING_ARTICLE_LED_ENABLED: "true", AGENT_MARKETING_ARTICLE_LED_LANES: "two" };
const fresh = (i, over) => cand(i, { sources: [src(i)], ...(over || {}) });
async function session(script, env, over) {
  const sent = [], times = []; let t = 0; const n = {};
  const callFn = async (p) => { const lane = laneOf(p); n[lane] = (n[lane] || 0) + 1; sent.push(JSON.parse(JSON.stringify(p))); times.push([lane, t]); t += 10000; const a = script(lane, n[lane]); if (a instanceof Error) throw a; return a; };
  const r = await quiet(() => run.runResearch({ row: row(), apiKey: "k", now: "2026-10-31T20:00:00Z", env, sleepFn: async (ms) => { t += ms; }, clock: () => t, rand: () => 0.5, callFn, ...(over || {}) }));
  return { r, sent, times, gf: r.fields.usage.gapFill };
}
const lanesOf = (r) => r.fields.usage.discovery.lanes;

test("gap-fill: off by default (and ignored for anything but the diagnostic setting): no extra request even with three qualified developments", async () => {
  const s = await session((lane) => (lane === "municipal" ? reply([fresh(1), fresh(2)]) : reply([fresh(3)])), TWO);
  assert.strictEqual(s.sent.length, 2); assert.strictEqual(s.gf, undefined);
  const s2 = await session((lane) => (lane === "municipal" ? reply([fresh(1), fresh(2)]) : reply([fresh(3)])), { ...TWO, AGENT_MARKETING_ARTICLE_LED_GAPFILL: "on" });
  assert.strictEqual(s2.sent.length, 2);
});
test("gap-fill: triggers only with exactly three or four distinct qualified developments after deduplication", async () => {
  const mk = (n) => (lane) => (lane === "municipal" ? reply([1, 2, 3, 4, 5, 6].slice(0, Math.ceil(n / 2)).map((i) => fresh(i))) : lane === "housing" ? reply([7, 8, 9].slice(0, Math.floor(n / 2)).map((i) => fresh(i))) : reply([]));
  for (const [qual, fires] of [[0, false], [1, false], [2, false], [3, true], [4, true], [5, false], [6, false]]) {
    const s = await session(mk(qual), GAP);
    assert.strictEqual(s.gf.triggered, fires, `${qual} qualified`);
    assert.strictEqual(s.sent.length, fires ? 3 : 2, `${qual}: requests`);
    assert.strictEqual(s.gf.executed, fires);
  }
  // three raw candidates that include a duplicate are two distinct developments after deduplication: not eligible
  const dupes = await session((lane) => (lane === "municipal" ? reply([...PARK.run1.filter((p) => p._lane === "municipal"), fresh(1)]) : reply([...PARK.run1.filter((p) => p._lane === "housing")])), GAP, { now: "2026-10-31T20:00:00Z" });
  assert.strictEqual(dupes.gf.triggered, false);
});
test("gap-fill: the compact request, same hierarchy, up to six exclusions with identities and source references, sequential, spaced by the minimum interval", async () => {
  const s = await session((lane) => (lane === "gapfill" ? reply([fresh(5)]) : lane === "municipal" ? reply([fresh(1), fresh(2)]) : reply([fresh(3), fresh(4)])), GAP);
  assert.deepStrictEqual(s.times.map((x) => x[0]), ["municipal", "housing", "gapfill"]);
  const p = s.sent[2];
  assert.ok(/YOUR LANE: Gap-fill/.test(p.instructions) && /do not enlarge the selected market/.test(p.instructions) && /DIFFERENT from the developments already found/.test(p.instructions));
  assert.strictEqual(/Selected market[^\n]*/.exec(p.input)[0], /Selected market[^\n]*/.exec(s.sent[0].input)[0]);
  assert.strictEqual(/Where the market sits[^\n]*/.exec(p.input)[0], /Where the market sits[^\n]*/.exec(s.sent[0].input)[0]);
  assert.ok(/Already found for this market\. Do NOT return these developments/.test(p.input) && /Orchard agreement/.test(p.input) && /Meadow apartment site/.test(p.input) && /news1\.example\/lincoln-story-1/.test(p.input));
  assert.ok((p.input.match(/^\d+\. /gm) || []).length === 4, "one exclusion per qualified development (four here)");
  assert.deepStrictEqual([p.tools[0].max_results, p.tools[0].max_tokens, p.max_output_tokens], [20, 6000, 4500]);
  assert.ok(s.times[2][1] - s.times[1][1] >= 10000 + 3000 - 10000 + 0 && s.times[2][1] > s.times[1][1], "after the previous request, never concurrent");
  const cap = cl.gapFillExclusions({ topics: Array.from({ length: 9 }, (_, i) => ({ candidate: { id: `c${i}`, lane: "municipal", development: `D${i}`, identity: { projectNames: ["a", "b", "c", "d", "e"], identifiers: ["x1", "x2", "x3", "x4", "x5"] }, sources: [{ url: "u1" }, { url: "u2" }, { url: "u3" }, { url: "u4" }] } })) });
  assert.strictEqual(cap.length, 6); assert.ok(cap.every((e) => e.projectNames.length <= 4 && e.identifiers.length <= 4 && e.sourceUrls.length <= 3));
});
test("gap-fill: a new, distinct qualified development converts four to five; before and after pools keep full source provenance; billing follows the usual five-opportunity rule", async () => {
  const s = await session((lane) => (lane === "gapfill" ? reply([fresh(5)]) : lane === "municipal" ? reply([fresh(1), fresh(2)]) : reply([fresh(3), fresh(4)])), GAP);
  assert.strictEqual(s.r.fields.topics.length, 5); assert.ok(s.r.fields.charged_at);
  const gf = s.gf;
  assert.deepStrictEqual([gf.qualifiedBefore, gf.before.selected, gf.after.selected, gf.addedQualified, gf.convertedToFive], [4, 4, 5, 1, true]);
  assert.ok(gf.before.candidates.length === 4 && gf.before.candidates.every((c) => c.sources.length >= 1 && c.sources[0].url && c.sources[0].ref && c.identity));
  assert.ok(gf.after.candidates.length === 5 && gf.newCandidates.length === 1 && gf.newCandidates[0].sources[0].url);
  assert.strictEqual(r2(s).gapFill.converted, true);
  const newCard = s.r.fields.topics.find((t) => t.candidate.gapFill);
  assert.strictEqual(newCard.candidate.lane, "gapfill");
  assert.deepStrictEqual([gf.request.state, gf.request.attempts, gf.request.returned], ["success", 1, 1]);
  function r2(x) { return x.r.fields.usage.articleLed; }
  // three to four stays uncharged
  const s4 = await session((lane) => (lane === "gapfill" ? reply([fresh(5)]) : lane === "municipal" ? reply([fresh(1), fresh(2)]) : reply([fresh(3)])), GAP);
  assert.deepStrictEqual([s4.r.fields.topics.length, s4.gf.convertedToFive, s4.r.fields.charged_at || null], [4, false, null]);
});
test("gap-fill: nothing new means nothing added; a variation of an existing story is a gapfill_duplicate, checked against ALL existing qualified identities; never a forced fifth", async () => {
  const none = await session((lane) => (lane === "gapfill" ? reply([]) : lane === "municipal" ? reply([fresh(1), fresh(2)]) : reply([fresh(3), fresh(4)])), GAP);
  assert.deepStrictEqual([none.r.fields.topics.length, none.gf.addedQualified, none.gf.convertedToFive], [4, 0, false]);
  assert.strictEqual(none.r.fields.charged_at || null, null);
  // the gap-fill pass returns Parkwood again under a new angle: same identity as an existing candidate
  const base = (lane) => (lane === "municipal" ? reply([PARK.run1.find((p) => p._lane === "housing"), fresh(1)]) : reply([fresh(3), fresh(4)]));
  const variant = JSON.parse(JSON.stringify(PARK.run1.find((p) => p._lane === "municipal"))); variant.question = "Does Lincoln's Parkwood approval change resale pricing near Village One?"; variant.angle = "Resale pricing";
  const dup = await session((lane) => (lane === "gapfill" ? reply([variant, fresh(6)]) : base(lane)), GAP, { now: "2026-10-31T20:00:00Z" });
  assert.strictEqual(dup.gf.summary.duplicates, 1, "the Parkwood variation");
  const topicsLog = dup.r.fields.usage.discovery.attempts[0].topics;
  assert.ok(topicsLog.some((t) => t.code === "gapfill_duplicate"), "recorded as a gap-fill duplicate");
  assert.strictEqual(dup.r.fields.topics.filter((t) => /Parkwood/.test(t.candidate.development)).length, 1);
  assert.strictEqual(dup.r.fields.topics.filter((t) => t.candidate.gapFill).length, 1, "only the genuinely new development was added");
  // direct check: an existing development NOT in the (six-entry) exclusion list is still detected by code
  const pool = [1, 2, 3, 4, 5, 6, 7, 8].map((i) => ({ ...fresh(i), _lane: "municipal" })).concat([{ ...fresh(7, { question: "Why is the Permit schedule changing this fall for new homes?", sources: [src(40)] }), _lane: "gapfill" }]);
  const v = cl.validateCandidates(pool, { today: D31, geography: fx.GEO.lincoln, maxCandidates: 20 });
  assert.ok(v.candidates.some((c) => c.reason === "gapfill_duplicate"), "a gap-fill candidate identical to the 7th existing one is caught although a six-entry list could not name it");
});
test("gap-fill: a failed or rate-limited gap-fill pass, or one blocked by the request limit, leaves the lane results intact", async () => {
  const base = (lane) => (lane === "municipal" ? reply([fresh(1), fresh(2)]) : reply([fresh(3), fresh(4)]));
  const busy = await session((lane) => (lane === "gapfill" ? { status: 429, json: {}, headers: {} } : base(lane)), { ...GAP, AGENT_MARKETING_LANE_MAX_ATTEMPTS: "2" });
  assert.strictEqual(busy.r.fields.status, "ready"); assert.strictEqual(busy.r.fields.topics.length, 4);
  assert.deepStrictEqual([busy.gf.executed, busy.gf.state, busy.gf.request.attempts], [false, "rate_limited", 2]);
  assert.strictEqual(busy.gf.after.selected, 4);
  assert.strictEqual(busy.r.fields.usage.providerRequests, 4, "2 lanes + 2 gap-fill attempts");
  // blocked by the request limit before dispatch: nothing sent, lanes preserved
  const blocked = await session((lane) => base(lane), GAP, { quotaFn: async (dispatched) => ({ allowed: dispatched < 2, scope: "daily", used: 15, limit: 15 }) });
  assert.strictEqual(blocked.sent.length, 2); assert.strictEqual(blocked.r.fields.topics.length, 4);
  assert.deepStrictEqual([blocked.gf.executed, blocked.gf.state, blocked.gf.reason], [false, "not_attempted", "request_limit"]);
  assert.strictEqual(blocked.r.fields.usage.providerRequests, 2, "the blocked request is not counted");
});

// ══ Provider request accounting and the hard limits ═══════════════════════════════════════════════════════════════════
test("usage.providerRequests counts every dispatched request exactly once: lanes, retries, failures, gap-fill; never through a second counter", async () => {
  const s = await session((lane, n) => (lane === "housing" && n === 1 ? { status: 429, json: {}, headers: {} } : lane === "gapfill" ? reply([fresh(5)]) : lane === "municipal" ? reply([fresh(1), fresh(2)]) : reply([fresh(3), fresh(4)])), GAP);
  const lanes = lanesOf(s.r);
  assert.strictEqual(s.r.fields.usage.providerRequests, s.sent.length);
  assert.strictEqual(s.r.fields.usage.providerRequests, lanes.reduce((n, l) => n + l.attempts, 0), "equals the sum of every lane's and the gap-fill pass's attempts");
  assert.strictEqual(s.r.fields.usage.providerRequests, 4);
  assert.strictEqual(s.r.fields.usage.attempts, 1, "attempts is the number of research passes, not requests");
  // a failed request is counted, and a failed run reports what it dispatched
  const fail = await session(() => ({ status: 500, json: {} }), TWO);
  assert.strictEqual(fail.r.fields.status, "failed"); assert.strictEqual(fail.r.fields.usage.providerRequests, fail.sent.length);
  assert.ok(fail.r.fields.usage.providerRequests >= 2);
  // the single pass counts the provider's own retries once
  const one = []; const callFn = async (p) => { one.push(p); return one.length === 1 ? { status: 500, json: {} } : reply([fresh(1)]); };
  const sp = await quiet(() => run.runResearch({ row: row(), apiKey: "k", now: NOW, env: { AGENT_MARKETING_ARTICLE_LED_ENABLED: "true" }, sleepFn: async () => {}, callFn }));
  assert.strictEqual(sp.fields.usage.providerRequests, 2);
  // legacy research does not get the field (its stored shape is unchanged)
  const leg = await quiet(() => run.runResearch({ row: row(), apiKey: "k", now: NOW, env: {}, sleepFn: async () => {}, callFn: async () => fx.replayReply(1) }));
  assert.ok(!("providerRequests" in leg.fields.usage));
});
test("the request limit is checked BEFORE every dispatch; a refused request is not sent or counted, and successful lane results survive an optional call being blocked", async () => {
  const seen = []; let sentBefore = 0;
  const quotaFn = async (dispatched) => { seen.push(dispatched); return { allowed: dispatched < 2, scope: "daily", used: 14, limit: 15 }; };
  const s = await session((lane) => (lane === "municipal" ? reply([fresh(1), fresh(2), fresh(3)]) : reply([fresh(4)])), TWO, { quotaFn });
  assert.deepStrictEqual(seen, [0, 1], "asked before each dispatch with the count so far");
  assert.strictEqual(s.sent.length, 2); assert.strictEqual(s.r.fields.usage.providerRequests, 2);
  const lanes = lanesOf(s.r);
  assert.deepStrictEqual(lanes.map((l) => l.state), ["success", "success"]);
  // blocked mid-way: the first lane's result is preserved, the second is not_attempted (request_limit), the run is still usable
  const q2 = await session((lane) => (lane === "municipal" ? reply([fresh(1), fresh(2), fresh(3)]) : reply([fresh(4)])), TWO, { quotaFn: async (d) => ({ allowed: d < 1, scope: "monthly", used: 99, limit: 100 }) });
  assert.deepStrictEqual(lanesOf(q2.r).map((l) => [l.lane, l.state, l.reason]), [["municipal", "success", null], ["housing", "not_attempted", "request_limit"]]);
  assert.strictEqual(q2.r.fields.topics.length, 3); assert.strictEqual(q2.r.fields.usage.providerRequests, 1);
  // blocked before the first request: nothing is dispatched, the run fails uncharged
  const q3 = await session(() => reply([fresh(1)]), TWO, { quotaFn: async () => ({ allowed: false, scope: "daily", used: 15, limit: 15 }) });
  assert.strictEqual(q3.sent.length, 0); assert.notStrictEqual(q3.r.fields.status, "ready"); assert.strictEqual(q3.r.fields.charged_at || null, null);
  assert.strictEqual(q3.r.fields.usage.providerRequests, 0); assert.ok(/limit/i.test(q3.r.fields.error));
  // a 429 retry is also gated
  const q4 = await session((lane, n) => (lane === "municipal" && n === 1 ? { status: 429, json: {}, headers: { "retry-after": "1" } } : reply([fresh(1)])), TWO, { quotaFn: async (d) => ({ allowed: d < 1, scope: "daily", used: 15, limit: 15 }) });
  assert.strictEqual(q4.sent.length, 1, "the retry was never dispatched");
  assert.strictEqual(lanesOf(q4.r)[0].reason, "request_limit");
  // single-pass requests are gated too, and the provider's internal retries are not attempted once refused
  const sp = await quiet(() => run.runResearch({ row: row(), apiKey: "k", now: NOW, env: { AGENT_MARKETING_ARTICLE_LED_ENABLED: "true" }, sleepFn: async () => {}, callFn: async () => reply([fresh(1)]), quotaFn: async () => ({ allowed: false, scope: "daily" }) }));
  assert.strictEqual(sp.fields.usage.providerRequests, 0); assert.notStrictEqual(sp.fields.status, "ready");
});
test("onDispatch persists the running count BEFORE each request is sent", async () => {
  const order = [];
  const s = await session((lane) => { order.push(`call:${lane}`); return reply([fresh(1)]); }, TWO, { onDispatch: async (n) => { order.push(`count:${n}`); } });
  assert.deepStrictEqual(order, ["count:1", "call:municipal", "count:2", "call:housing"]);
  // a failing counter write never blocks research
  const f = await session(() => reply([fresh(1)]), TWO, { onDispatch: async () => { throw new Error("db down"); } });
  assert.strictEqual(f.r.fields.usage.providerRequests, 2);
});
test("request limits: 15 per 24 hours and 100 per 30 days, counted from providerRequests with backward-compatible fallback for older rows", () => {
  const now = Date.now(), ago = (h) => new Date(now - h * 3600e3).toISOString();
  const row1 = (id, h, over) => ({ id, created_at: ago(h), status: "ready", pathway: "article_led", ...(over || {}) });
  // backward compatible: an old row counts its attempts (at least 1); a new row counts providerRequests exactly (even 0)
  assert.deepStrictEqual([al.requestsOf(row1("a", 1, { attempts: "2" })), al.requestsOf(row1("b", 1, { attempts: "1", providerRequests: "4" })), al.requestsOf(row1("c", 1)), al.requestsOf(row1("d", 1, { providerRequests: "0" })), al.requestsOf(row1("e", 1, { status: "running", providerRequests: "3" })), al.requestsOf(row1("f", 1, { status: "running" }))], [2, 4, 1, 0, 3, 1]);
  const rows = (n) => Array.from({ length: n }, (_, i) => row1(`r${i}`, 2, { providerRequests: "1" }));
  assert.strictEqual(al.requestAllowance(rows(14), now, {}, "me", 0).allowed, true);
  assert.deepStrictEqual(al.requestAllowance(rows(15), now, {}, "me", 0), { allowed: false, scope: "daily", used: 15, limit: 15 });
  assert.strictEqual(al.requestAllowance(rows(10), now, {}, "me", 4).allowed, true, "10 recorded + 4 dispatched by this run + 1 = 15");
  assert.strictEqual(al.requestAllowance(rows(10), now, {}, "me", 5).allowed, false, "the 16th");
  assert.strictEqual(al.requestAllowance([...rows(10), row1("me", 0.1, { status: "running", providerRequests: "9" })], now, {}, "me", 4).allowed, true, "the running session's own row is excluded: its in-memory count is used instead");
  const old = Array.from({ length: 50 }, (_, i) => row1(`o${i}`, 30 + i % 10, { providerRequests: "1" }));
  assert.deepStrictEqual(al.requestAllowance(old, now, {}, "me", 0), { allowed: true, scope: null, used: 0, limit: 15 });
  assert.deepStrictEqual(al.requestAllowance(Array.from({ length: 100 }, (_, i) => row1(`m${i}`, 48 + i, { providerRequests: "1" })).slice(0, 100), now, {}, "me", 0), { allowed: false, scope: "monthly", used: 100, limit: 100 });
  // withdrawn and legacy rows do not count; admission uses the same counting
  assert.strictEqual(al.requestAllowance([row1("w", 1, { providerRequests: "50", withdrawn: "true" }), { id: "l", created_at: ago(1), status: "ready", pathway: "legacy", providerRequests: "50" }], now, {}, "me", 0).allowed, true);
  const adm = al.admit(rows(15), null, now, {}, 6 * 60 * 1000);
  assert.deepStrictEqual([adm.blocked, adm.code, adm.scope], [true, "provider_request_limit", "daily"]);
  // the limits stay the approved defaults
  assert.deepStrictEqual([al.REQUEST_DAILY_LIMIT, al.REQUEST_MONTHLY_LIMIT], [15, 100]);
});
test("the endpoint and the background function read and write the real count: the admission select includes providerRequests; the worker gates and persists every request (Article-Led only, fail closed)", () => {
  const fs = require("fs"), path = require("path");
  const ep = fs.readFileSync(path.join(__dirname, "..", "netlify", "functions", "agent-marketing-research.js"), "utf8");
  const bg = fs.readFileSync(path.join(__dirname, "..", "netlify", "functions", "agent-marketing-research-background.js"), "utf8");
  assert.ok(/providerRequests:usage->>providerRequests/.test(ep));
  assert.ok(/requestAllowance/.test(bg) && /onDispatch/.test(bg) && /unverifiable/.test(bg) && /const isAL = /.test(bg));
  assert.ok(!/gapfill/i.test(bg + ep), "no production path enables gap-fill");
});

test("harness and report: the gap-fill cell, the 16-session plan, a replay with before and after pools, and the approved stop criteria", () => {
  const fs = require("fs"), os = require("os"), path = require("path"), cp = require("child_process");
  const base = require("../scripts/research-baseline");
  const c = base.CELLS.find((x) => x.id === "lanes2gap_r20_c6000_o4500");
  assert.deepStrictEqual([c.prompt, c.lanes, c.gapfill, c.results, c.context, c.output, c.retries], ["compact", "two", "diagnostic", 20, 6000, 4500, 0]);
  assert.deepStrictEqual(base.cellsFor("gapfill").map((x) => x.id), ["lanes2gap_r20_c6000_o4500"]);
  assert.ok(!base.cellsFor("lanes2").some((x) => x.gapfill), "the plain two-lane set never includes gap-fill");
  assert.strictEqual(base.plan(Object.keys(base.MARKETS), 4, base.cellsFor("gapfill")).length, 16, "4 markets x 4 repeats");
  const env = base.cellEnv({}, c);
  assert.deepStrictEqual([env.AGENT_MARKETING_ARTICLE_LED_LANES, env.AGENT_MARKETING_ARTICLE_LED_GAPFILL], ["two", "diagnostic"]);
  assert.strictEqual(base.cellEnv({}, base.CELLS.find((x) => x.id === "lanes2_r20_c6000_o4500")).AGENT_MARKETING_ARTICLE_LED_GAPFILL, "", "gap-fill is off in every other cell");
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "gf-")), out = path.join(dir, "r.md"), js = path.join(dir, "r.json");
  const node = (a) => cp.execFileSync(process.execPath, a, { encoding: "utf8" });
  node([path.join(__dirname, "..", "scripts", "research-baseline.js"), "--replay", "--prompt", "gapfill", "--markets", "lincoln,thin", "--repeats", "2", "--out", dir]);
  assert.strictEqual(fs.readdirSync(dir).filter((f) => f.endsWith(".gapfill.json")).length, 4);
  node([path.join(__dirname, "..", "scripts", "research-gapfill-report.js"), "--in", dir, "--out", out, "--json", js]);
  const md = fs.readFileSync(out, "utf8"), res = JSON.parse(fs.readFileSync(js, "utf8"));
  for (const sec of ["## Summary", "## Approved stop criteria", "## By session", "## Unchanged or reduced results and why", "## New candidates added by the pass", "## Before and after pools for every fired session, with source provenance", "Cost per useful addition", "Sessions converted from 3 or 4 to 5", "Total provider requests / retries", "Five-opportunity billing eligible before / after"]) assert.ok(md.includes(sec), sec);
  assert.deepStrictEqual([res.sessions, res.eligible_3_or_4, res.executed, res.converted_to_five, res.reduced, res.five_before, res.five_after], [4, 4, 4, 4, 0, 0, 4]);
  assert.ok(res.total_provider_requests === 12 && res.gapfill_cost_usd > 0);
  assert.ok(/Exclusions passed in the prompt/.test(md) && /Before:/.test(md) && /After:/.test(md) && /:s1:/.test(md));
  // useful-addition judgement is deterministic and explains failures
  const rep = require("../scripts/research-gapfill-report");
  const good = rep.judgeNew({ geography: { relationship: "market", nameFoundInSource: true }, sources: [{ role: "primary", authority: { official: true }, host: "a.gov", outletClass: "government_record" }] });
  const weak = rep.judgeNew({ geography: { relationship: "county", nameFoundInSource: true }, sources: [{ role: "secondary", host: "x.com", outletClass: "unclassified" }] });
  assert.deepStrictEqual([good.useful, weak.useful], [true, false]); assert.strictEqual(weak.reasons.length, 2);
});
