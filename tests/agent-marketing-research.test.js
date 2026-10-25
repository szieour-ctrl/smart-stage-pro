// Run with: npm test
const test = require("node:test");
const assert = require("node:assert");
const r = require("../netlify/functions/lib/agent-marketing-research-lib");

const TODAY = "2026-10-24";
const src = (n, published) => ({ title: `Source ${n}`, url: `https://example.org/report-${n}`, published: published || "2026-10-20" });
const QUESTIONS = [
  "Why are some Crocker Ranch homes taking longer to sell?",
  "Does spring bring more competing listings to Roseville?",
  "How are builder incentives changing resale pricing near new communities?",
  "What are mortgage rate buydowns doing to buyer budgets?",
  "Which price bands are seeing the most pending sales this month?",
];
const rawMarket = (n, q) => ({
  question: q || QUESTIONS[n - 1],
  why_it_matters: "It changes how sellers price against nearby competition.",
  trend_signals: ["Active listings up month over month in the MLS report"], local_intent: true, scope: "selected", scope_note: null, event: null,
  sources: [src(n), src(n + 10)],
});
const fiveMarket = () => [1, 2, 3, 4, 5].map((n) => rawMarket(n));
const rawEvent = (n, over) => ({
  question: ["Is the harvest festival at the town square this weekend?", "When does the lantern walk start downtown?", "Where is the chili cook-off being held?", "What time is the jazz concert in the park?", "Does the holiday tree lighting need tickets?"][n - 1],
  why_it_matters: "Neighbors can plan their weekend around it.", trend_signals: [], local_intent: true, scope: "selected", scope_note: null,
  event: { name: `Event ${n}`, date: "2026-10-31", end_date: null, time: "10am to 4pm", location: "Town Square, Roseville", organizer: "City of Roseville", status: "upcoming", ...(over || {}) },
  sources: [{ title: "City event page", url: "https://www.roseville.ca.us/events/1", published: null }],
});
const fiveEvents = () => [1, 2, 3, 4, 5].map((n) => rawEvent(n));

test("geography: the agent defines it, a neighborhood must name its city, ZIPs are five digits, state is stripped", () => {
  const nb = r.validateGeography({ type: "neighborhood", name: "Crocker Ranch", city: "Roseville, CA" });
  assert.strictEqual(nb.ok, true);
  assert.strictEqual(nb.geography.label, "Crocker Ranch, Roseville, CA");
  assert.strictEqual(r.validateGeography({ type: "neighborhood", name: "Crocker Ranch" }).ok, false);
  assert.strictEqual(r.validateGeography({ type: "zip", name: "95678" }).geography.label, "ZIP 95678, CA");
  assert.strictEqual(r.validateGeography({ type: "zip", name: "9567" }).ok, false);
  assert.strictEqual(r.validateGeography({ type: "county", name: "Placer" }).geography.label, "Placer County, CA");
  assert.strictEqual(r.validateGeography({ type: "county", name: "Placer County" }).geography.label, "Placer County, CA");
  assert.strictEqual(r.validateGeography({ type: "metro", name: "Sacramento" }).geography.label, "Sacramento metro area, CA");
  assert.strictEqual(r.validateGeography({ type: "city", name: "Roseville, California" }).geography.name, "Roseville");
  assert.strictEqual(r.validateGeography({ type: "planet", name: "Mars" }).ok, false);
  assert.strictEqual(r.validateGeography({ type: "city", name: "" }).ok, false);
  assert.strictEqual(r.validateGeography({ type: "city", name: "x".repeat(61) }).ok, false);
  assert.strictEqual(r.validateGeography(null).ok, false);
});

test("request: known keys only, both modes, audiences, focus flags, upload limits", () => {
  const ok = r.validateResearchRequest({ mode: "market_update", audience: "sellers", geography: { type: "city", name: "Roseville" }, focus: { active_adult_55: true, new_construction: "true", junk: 1 }, address: "1 Main St" });
  assert.strictEqual(ok.ok, true);
  assert.deepStrictEqual(Object.keys(ok.request).sort(), ["audience", "dataSource", "focus", "geography", "mode", "uploadIds"]);
  assert.deepStrictEqual(ok.request.focus, { active_adult_55: true, new_construction: true });
  assert.strictEqual(r.validateResearchRequest({ mode: "local_events", audience: "general", geography: { type: "zip", name: "95661" } }).ok, true);
  assert.strictEqual(r.validateResearchRequest({ mode: "blog", audience: "sellers", geography: { type: "city", name: "A" } }).ok, false);
  assert.strictEqual(r.validateResearchRequest({ mode: "market_update", audience: "everyone", geography: { type: "city", name: "A" } }).ok, false);
  const id = "11111111-1111-4111-8111-111111111111";
  assert.strictEqual(r.validateResearchRequest({ mode: "market_update", audience: "both", geography: { type: "city", name: "A" }, uploadIds: [id] }).ok, true);
  assert.strictEqual(r.validateResearchRequest({ mode: "market_update", audience: "both", geography: { type: "city", name: "A" }, uploadIds: ["nope"] }).ok, false);
  const four = ["1", "2", "3", "4"].map((d) => `${d.repeat(8)}-1111-4111-8111-111111111111`);
  assert.strictEqual(r.validateResearchRequest({ mode: "market_update", audience: "both", geography: { type: "city", name: "A" }, uploadIds: four }).ok, false);
});

test("request key: same request, same key; a different place or focus changes it", () => {
  const a = r.validateResearchRequest({ mode: "market_update", audience: "sellers", geography: { type: "city", name: "Roseville" } }).request;
  const b = r.validateResearchRequest({ mode: "market_update", audience: "sellers", geography: { type: "city", name: "roseville" } }).request;
  const c = r.validateResearchRequest({ mode: "market_update", audience: "sellers", geography: { type: "city", name: "Rocklin" } }).request;
  const d = r.validateResearchRequest({ mode: "market_update", audience: "sellers", geography: { type: "city", name: "Roseville" }, focus: { new_construction: true } }).request;
  assert.strictEqual(r.requestKey(a), r.requestKey(b));
  assert.notStrictEqual(r.requestKey(a), r.requestKey(c));
  assert.notStrictEqual(r.requestKey(a), r.requestKey(d));
});

test("payload: exact market, never widened; mode rules; model comes from the environment", () => {
  const request = r.validateResearchRequest({ mode: "market_update", audience: "sellers", geography: { type: "neighborhood", name: "Crocker Ranch", city: "Roseville" }, focus: { active_adult_55: true } }).request;
  const p = r.buildResearchPayload({ request, today: TODAY, env: {} });
  assert.strictEqual(p.model, "perplexity/sonar");
  assert.strictEqual(p.max_output_tokens, 2200);                             // bounds output cost
  assert.deepStrictEqual(p.tools, [{ type: "web_search", max_results: 10, max_tokens: 6000, filters: { search_recency_filter: "month" } }]);
  const user = p.input;
  assert.match(user, /Crocker Ranch, Roseville, CA/);
  assert.match(user, /do not broaden/i);
  assert.match(user, /55\+ active adult/);
  assert.match(user, /Today: 2026-10-24/);
  assert.match(p.instructions, /EXACTLY 5/);
  assert.match(p.instructions, /broader_context/);
  assert.strictEqual(r.buildResearchPayload({ request, today: TODAY, env: { AGENT_MARKETING_RESEARCH_MODEL: "openai/gpt-6-luna" } }).model, "openai/gpt-6-luna");
  const ev = r.buildResearchPayload({ request: { ...request, mode: "local_events" }, today: TODAY, env: {} });
  assert.match(ev.instructions, /MODE: Local Events/);
  assert.match(ev.instructions, /upcoming" or "ongoing"/);
  const up = r.buildResearchPayload({ request, today: TODAY, uploadContext: "CMA, Crocker Ranch, 12 comps, Aug-Oct 2026", env: {} });
  assert.match(up.input, /12 comps/);
});

test("settings: enhanced local research at a $0.025 target by default, every knob tunable, bad values ignored", () => {
  const d = r.researchSettings({});
  assert.deepStrictEqual(d, { model: "perplexity/sonar", searchContextSize: "medium", maxTokens: 2200, costTargetUsd: 0.025 });
  const t = r.researchSettings({ AGENT_MARKETING_RESEARCH_MODEL: "openai/gpt-6-luna", AGENT_MARKETING_RESEARCH_CONTEXT: "LOW", AGENT_MARKETING_RESEARCH_MAX_TOKENS: "1500", AGENT_MARKETING_RESEARCH_COST_TARGET_USD: "0.04" });
  assert.deepStrictEqual(t, { model: "openai/gpt-6-luna", searchContextSize: "low", maxTokens: 1500, costTargetUsd: 0.04 });
  assert.deepStrictEqual(r.researchSettings({ AGENT_MARKETING_RESEARCH_CONTEXT: "huge", AGENT_MARKETING_RESEARCH_MAX_TOKENS: "99999", AGENT_MARKETING_RESEARCH_COST_TARGET_USD: "-1" }), d);
  assert.notStrictEqual(r.researchSettings({}).model, "sonar-deep-research"); // deep research is opt-in only, never the default
  const lowCtx = r.buildResearchPayload({ request: r.validateResearchRequest({ mode: "market_update", audience: "sellers", geography: { type: "city", name: "Roseville" } }).request, today: TODAY, env: { AGENT_MARKETING_RESEARCH_CONTEXT: "high" } });
  assert.strictEqual(lowCtx.tools[0].max_results, 20);
});

test("topics: exactly five distinct sourced market topics are accepted", () => {
  const v = r.validateTopics(fiveMarket(), { mode: "market_update", today: TODAY });
  assert.strictEqual(v.ok, true, v.problems.join("; "));
  assert.strictEqual(v.topics.length, 5);
  assert.deepStrictEqual(v.topics.map((t) => t.id), ["t1", "t2", "t3", "t4", "t5"]);
  assert.ok(v.topics.every((t) => t.kind === "market_update" && t.sources.length >= 1 && t.sources[0].domain === "example.org"));
});

test("topics: four, six or zero topics fail", () => {
  assert.strictEqual(r.validateTopics(fiveMarket().slice(0, 4), { mode: "market_update", today: TODAY }).ok, false);
  assert.strictEqual(r.validateTopics([...fiveMarket(), rawMarket(6)], { mode: "market_update", today: TODAY }).ok, false);
  assert.strictEqual(r.validateTopics([], { mode: "market_update", today: TODAY }).ok, false);
  assert.strictEqual(r.validateTopics(null, { mode: "market_update", today: TODAY }).ok, false);
});

test("topics: unsafe, paywalled, undated, stale and future sources are dropped and an unsourced topic fails the set", () => {
  const bad = (s) => { const t = fiveMarket(); t[2].sources = s; return r.validateTopics(t, { mode: "market_update", today: TODAY }); };
  assert.strictEqual(bad([{ title: "x", url: "http://example.org/a", published: "2026-10-20" }]).ok, false);          // not https
  assert.strictEqual(bad([{ title: "x", url: "https://www.wsj.com/articles/a", published: "2026-10-20" }]).ok, false); // paywalled
  assert.strictEqual(bad([{ title: "x", url: "https://example.org/a" }]).ok, false);                                  // undated market source
  assert.strictEqual(bad([{ title: "x", url: "https://example.org/a", published: "2026-08-01" }]).ok, false);         // stale
  assert.strictEqual(bad([{ title: "x", url: "https://example.org/a", published: "2026-12-01" }]).ok, false);         // from the future
  assert.strictEqual(bad([{ title: "x", url: "https://user:pw@example.org/a", published: "2026-10-20" }]).ok, false); // credentials
  assert.strictEqual(bad([{ title: "x", url: "javascript:alert(1)", published: "2026-10-20" }]).ok, false);
  assert.strictEqual(bad([{ title: "x", url: "https://example.org/a", published: "2026-02-31" }]).ok, false);         // impossible date
  assert.strictEqual(bad([]).ok, false);
  // one bad source beside a good one: the good one keeps the topic
  const t = fiveMarket(); t[2].sources = [{ title: "x", url: "https://www.ft.com/a", published: "2026-10-20" }, src(3)];
  const ok = r.validateTopics(t, { mode: "market_update", today: TODAY });
  assert.strictEqual(ok.ok, true);
  assert.strictEqual(ok.topics[2].sources.length, 1);
});

test("topics: overlapping questions fail; a trend claim needs a measurable signal", () => {
  const t = fiveMarket(); t[1].question = t[0].question;
  assert.strictEqual(r.validateTopics(t, { mode: "market_update", today: TODAY }).ok, false);
  const trend = fiveMarket(); trend[0].question = "Why are listings trending in Roseville?"; trend[0].trend_signals = [];
  const v = r.validateTopics(trend, { mode: "market_update", today: TODAY });
  assert.strictEqual(v.ok, false);
  assert.match(v.problems.join(" "), /trend/);
  trend[0].trend_signals = ["County report shows active listings up 12% since August"];
  assert.strictEqual(r.validateTopics(trend, { mode: "market_update", today: TODAY }).ok, true);
});

test("topics: broader-than-selected data must say what area it covers", () => {
  const t = fiveMarket(); t[0].scope = "broader_context";
  assert.strictEqual(r.validateTopics(t, { mode: "market_update", today: TODAY }).ok, false);
  t[0].scope_note = "Placer County figures, not Crocker Ranch";
  const v = r.validateTopics(t, { mode: "market_update", today: TODAY });
  assert.strictEqual(v.ok, true);
  assert.strictEqual(v.topics[0].scope, "broader_context");
  assert.match(v.topics[0].scopeNote, /Placer County/);
  assert.strictEqual(v.topics[1].scope, "selected");
});

test("events: upcoming or ongoing with organizer, place, date and time are accepted", () => {
  const v = r.validateTopics(fiveEvents(), { mode: "local_events", today: TODAY });
  assert.strictEqual(v.ok, true, v.problems.join("; "));
  assert.strictEqual(v.topics[0].event.organizer, "City of Roseville");
  assert.strictEqual(v.topics[0].sources[0].published, null);
  const ongoing = fiveEvents(); ongoing[0].event = { ...ongoing[0].event, date: "2026-10-01", end_date: "2026-11-01", status: "ongoing" };
  assert.strictEqual(r.validateTopics(ongoing, { mode: "local_events", today: TODAY }).ok, true);
});

test("events: placeholders like 'Not stated in the source' or 'venue not stated' do not count as details", () => {
  const run = (over) => { const t = fiveEvents(); t[0] = rawEvent(1, over); return r.validateTopics(t, { mode: "local_events", today: TODAY }); };
  assert.strictEqual(run({ time: "Not stated in the source" }).ok, false);
  assert.strictEqual(run({ location: "Roseville, CA; venue not stated" }).ok, false);
  assert.strictEqual(run({ organizer: "TBD" }).ok, false);
  assert.strictEqual(run({ time: "N/A" }).ok, false);
  assert.strictEqual(run({ time: "5:30–7:30 PM" }).ok, true);
  assert.match(run({ time: "Not stated in the source" }).problems.join(" "), /time is not confirmed/);
});

test("events: past, canceled, postponed and incomplete events fail the set", () => {
  const run = (over) => { const t = fiveEvents(); t[0] = rawEvent(1, over); return r.validateTopics(t, { mode: "local_events", today: TODAY }); };
  assert.strictEqual(run({ date: "2026-10-01" }).ok, false);
  assert.strictEqual(run({ status: "canceled" }).ok, false);
  assert.strictEqual(run({ status: "postponed" }).ok, false);
  assert.strictEqual(run({ organizer: "" }).ok, false);
  assert.strictEqual(run({ location: "" }).ok, false);
  assert.strictEqual(run({ time: "" }).ok, false);
  assert.strictEqual(run({ date: "soon" }).ok, false);
  assert.strictEqual(run({ end_date: "2026-10-01" }).ok, false);
  const none = fiveEvents(); none[0].event = null;
  assert.strictEqual(r.validateTopics(none, { mode: "local_events", today: TODAY }).ok, false);
});

test("extractTopics: reads a fenced or bare JSON response, rejects prose", () => {
  const body = JSON.stringify({ topics: fiveMarket() });
  assert.strictEqual(r.extractTopics("```json\n" + body + "\n```").length, 5);
  assert.strictEqual(r.extractTopics("Here you go:\n" + body).length, 5);
  assert.throws(() => r.extractTopics("Perplexity is busy."), /JSON/);
  assert.throws(() => r.extractTopics(JSON.stringify({ items: [] })), /topics/);
});

test("usage: measured tokens and cost are kept when present and null when not", () => {
  const u = r.usageSummary({ usage: { input_tokens: 100, output_tokens: 900, output_tokens_details: { reasoning_tokens: 0 }, tool_calls_details: { search_web: { invocation: 3 } }, cost: { total_cost: 0.0421 } } });
  assert.deepStrictEqual(u, { promptTokens: 100, completionTokens: 900, citationTokens: null, reasoningTokens: 0, searchQueries: 3, costUsd: 0.0421, targetUsd: 0.025, withinTarget: false });
  assert.strictEqual(r.usageSummary({ usage: { cost: { total_cost: 0.019 } } }).withinTarget, true);
  assert.strictEqual(r.usageSummary({ usage: { cost: { total_cost: 0.04 } } }, 0.05).withinTarget, true);
  assert.deepStrictEqual(r.usageSummary({}), { promptTokens: null, completionTokens: null, citationTokens: null, reasoningTokens: null, searchQueries: null, costUsd: null, targetUsd: 0.025, withinTarget: null });
  assert.strictEqual(r.usageSummary(null).costUsd, null);
});

test("sessions: allowance by plan, beta override, and only charged sessions in this Pacific month count", () => {
  assert.strictEqual(r.allowanceFor("solo", {}), 10);
  assert.strictEqual(r.allowanceFor("Team", {}), 30);
  assert.strictEqual(r.allowanceFor("brokerage", {}), 100);
  assert.strictEqual(r.allowanceFor("mystery", {}), 10);
  assert.strictEqual(r.allowanceFor("team", { AGENT_MARKETING_RESEARCH_SESSIONS: "3" }), 3);
  assert.strictEqual(r.allowanceFor("team", { AGENT_MARKETING_RESEARCH_SESSIONS: "abc" }), 30);
  const now = "2026-10-24T17:00:00Z";
  const rows = [
    { charged_at: "2026-10-02T18:00:00Z" }, { charged_at: "2026-10-20T18:00:00Z" },
    { charged_at: null },                                   // failed run
    { charged_at: "2026-09-30T20:00:00Z" },                 // last month
    { charged_at: "2026-11-01T05:00:00Z" },                 // Oct 31 10pm Pacific, still October
  ];
  const s = r.sessionStatus({ rows, planKey: "solo", now, env: {} });
  assert.deepStrictEqual(s, { used: 3, allowance: 10, remaining: 7, canStart: true });
  // month edge is Pacific: Nov 1 03:00Z is still Oct 31 in California
  assert.strictEqual(r.monthKeyPT("2026-11-01T03:00:00Z"), "2026-10");
  assert.strictEqual(r.monthKeyPT("2026-11-01T08:00:00Z"), "2026-11");
});

test("sessions: 10 down to 0 stops new runs; reopening saved research needs no session", () => {
  const rows = Array.from({ length: 10 }, (_, i) => ({ charged_at: `2026-10-${String(i + 1).padStart(2, "0")}T18:00:00Z` }));
  const s = r.sessionStatus({ rows, planKey: "solo", now: "2026-10-24T17:00:00Z", env: {} });
  assert.deepStrictEqual(s, { used: 10, allowance: 10, remaining: 0, canStart: false });
  // reading saved rows is just reading them; sessionStatus is only consulted before a NEW run
  assert.strictEqual(r.sessionStatus({ rows: [], planKey: "solo", now: "2026-10-24T17:00:00Z", env: {} }).canStart, true);
});

test("outcome: charged only for a validated five-topic set; failures, timeouts and unusable results are never charged", () => {
  const good = r.validateTopics(fiveMarket(), { mode: "market_update", today: TODAY });
  const ok = r.outcomeFields({ validation: good, usage: { costUsd: 0.04 }, model: "perplexity/sonar", today: TODAY, now: "2026-10-24T17:00:00Z" });
  assert.strictEqual(ok.status, "ready");
  assert.strictEqual(ok.topics.length, 5);
  assert.strictEqual(ok.charged_at, "2026-10-24T17:00:00.000Z");
  assert.strictEqual(ok.research_date, TODAY);
  const four = r.validateTopics(fiveMarket().slice(0, 4), { mode: "market_update", today: TODAY });
  const bad = r.outcomeFields({ validation: four, today: TODAY });
  assert.strictEqual(bad.status, "failed");
  assert.strictEqual(bad.charged_at, null);
  assert.strictEqual(bad.topics, null);
  const timeout = r.outcomeFields({ validation: null, error: "Research timed out", today: TODAY });
  assert.strictEqual(timeout.status, "failed");
  assert.strictEqual(timeout.charged_at, null);
  assert.match(timeout.error, /timed out/);
});
