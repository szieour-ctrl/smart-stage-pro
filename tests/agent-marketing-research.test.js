// Run with: npm test
const test = require("node:test");
const assert = require("node:assert");
const r = require("../netlify/functions/lib/agent-marketing-research-lib");

const TODAY = "2026-10-24";
const src = (n, published) => ({ title: `Source ${n}`, url: `https://site${n}.example.org/report-${n}`, published: published || "2026-10-20" });
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
  const ok = r.validateResearchRequest({ mode: "market_update", audience: "sellers", geography: { zip: "95678", type: "city", name: "Roseville" }, focus: { active_adult_55: true, new_construction: "true", junk: 1 }, address: "1 Main St" });
  assert.strictEqual(ok.ok, true);
  assert.deepStrictEqual(Object.keys(ok.request).sort(), ["audience", "dataFocus", "dataSource", "focus", "geography", "keywords", "mode", "period", "uploadIds"]);
  assert.deepStrictEqual(ok.request.focus, { active_adult_55: true, new_construction: true });
  assert.strictEqual(r.validateResearchRequest({ mode: "local_events", audience: "general", geography: { type: "zip", name: "95661" } }).ok, true);
  assert.strictEqual(r.validateResearchRequest({ mode: "blog", audience: "sellers", geography: { zip: "95678", type: "city", name: "A" } }).ok, false);
  assert.strictEqual(r.validateResearchRequest({ mode: "market_update", audience: "everyone", geography: { zip: "95678", type: "city", name: "A" } }).ok, false);
  const id = "11111111-1111-4111-8111-111111111111";
  assert.strictEqual(r.validateResearchRequest({ mode: "market_update", audience: "both", geography: { zip: "95678", type: "city", name: "A" }, uploadIds: [id] }).ok, true);
  assert.strictEqual(r.validateResearchRequest({ mode: "market_update", audience: "both", geography: { zip: "95678", type: "city", name: "A" }, uploadIds: ["nope"] }).ok, false);
  const four = ["1", "2", "3", "4"].map((d) => `${d.repeat(8)}-1111-4111-8111-111111111111`);
  assert.strictEqual(r.validateResearchRequest({ mode: "market_update", audience: "both", geography: { zip: "95678", type: "city", name: "A" }, uploadIds: four }).ok, false);
});

test("request key: same request, same key; a different place or focus changes it", () => {
  const a = r.validateResearchRequest({ mode: "market_update", audience: "sellers", geography: { zip: "95678", type: "city", name: "Roseville" } }).request;
  const b = r.validateResearchRequest({ mode: "market_update", audience: "sellers", geography: { zip: "95678", type: "city", name: "roseville" } }).request;
  const c = r.validateResearchRequest({ mode: "market_update", audience: "sellers", geography: { zip: "95678", type: "city", name: "Rocklin" } }).request;
  const d = r.validateResearchRequest({ mode: "market_update", audience: "sellers", geography: { zip: "95678", type: "city", name: "Roseville" }, focus: { new_construction: true } }).request;
  assert.strictEqual(r.requestKey(a), r.requestKey(b));
  assert.notStrictEqual(r.requestKey(a), r.requestKey(c));
  assert.notStrictEqual(r.requestKey(a), r.requestKey(d));
});

test("payload: exact market, never widened; mode rules; model comes from the environment", () => {
  const request = r.validateResearchRequest({ mode: "market_update", audience: "sellers", geography: { zip: "95678", type: "neighborhood", name: "Crocker Ranch", city: "Roseville" }, focus: { active_adult_55: true } }).request;
  const p = r.buildResearchPayload({ request, today: TODAY, env: {} });
  assert.strictEqual(p.model, "perplexity/sonar");
  assert.strictEqual(p.max_output_tokens, 2200);                             // bounds output cost
  const dd = new Date(Date.parse(`${TODAY}T00:00:00Z`) - 60 * 86400000), pad = (n) => String(n).padStart(2, "0");
  const searchAfterExpected = `${pad(dd.getUTCMonth() + 1)}/${pad(dd.getUTCDate())}/${dd.getUTCFullYear()}`; // 60 days back, MM/DD/YYYY
  assert.deepStrictEqual(p.tools, [{ type: "web_search", max_results: 10, max_tokens: 6000, filters: { search_after_date_filter: searchAfterExpected } }]);
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
  const lowCtx = r.buildResearchPayload({ request: r.validateResearchRequest({ mode: "market_update", audience: "sellers", geography: { zip: "95678", type: "city", name: "Roseville" } }).request, today: TODAY, env: { AGENT_MARKETING_RESEARCH_CONTEXT: "high" } });
  assert.strictEqual(lowCtx.tools[0].max_results, 20);
});

test("topics: exactly five distinct sourced market topics are accepted", () => {
  const v = r.validateTopics(fiveMarket(), { mode: "market_update", today: TODAY });
  assert.strictEqual(v.ok, true, v.problems.join("; "));
  assert.strictEqual(v.topics.length, 5);
  assert.deepStrictEqual(v.topics.map((t) => t.id), ["t1", "t2", "t3", "t4", "t5"]);
  assert.ok(v.topics.every((t) => t.kind === "market_update" && t.sources.length >= 1 && /\.example\.org$/.test(t.sources[0].domain)));
});

test("topics: fewer than five are kept (one good article is a usable run), more than five are capped, and none fails", () => {
  const four = r.validateTopics(fiveMarket().slice(0, 4), { mode: "market_update", today: TODAY });
  assert.strictEqual(four.ok, true);
  assert.strictEqual(four.topics.length, 4);
  assert.strictEqual(four.partial, true);
  assert.strictEqual(r.validateTopics(fiveMarket().slice(0, 1), { mode: "market_update", today: TODAY }).topics.length, 1);
  assert.strictEqual(r.validateTopics([...fiveMarket(), rawMarket(6)], { mode: "market_update", today: TODAY }).topics.length, 5);
  assert.strictEqual(r.validateTopics([], { mode: "market_update", today: TODAY }).ok, false);
  assert.strictEqual(r.validateTopics(null, { mode: "market_update", today: TODAY }).ok, false);
});

test("topics: unsafe, paywalled, undated, stale and future sources are dropped and an unsourced topic fails the set", () => {
  const bad = (s) => { const t = fiveMarket(); t[2].sources = s; return r.validateTopics(t, { mode: "market_update", today: TODAY }); };
  assert.strictEqual(bad([{ title: "x", url: "http://example.org/a", published: "2026-10-20" }]).topics.length < 5, true);          // not https
  assert.strictEqual(bad([{ title: "x", url: "https://www.wsj.com/articles/a", published: "2026-10-20" }]).topics.length < 5, true); // paywalled
  assert.strictEqual(bad([{ title: "x", url: "https://example.org/a" }]).topics.length < 5, true);                                  // undated market source
  assert.strictEqual(bad([{ title: "x", url: "https://example.org/a", published: "2026-08-01" }]).topics.length < 5, true);         // stale
  assert.strictEqual(bad([{ title: "x", url: "https://example.org/a", published: "2026-12-01" }]).topics.length < 5, true);         // from the future
  assert.strictEqual(bad([{ title: "x", url: "https://user:pw@example.org/a", published: "2026-10-20" }]).topics.length < 5, true); // credentials
  assert.strictEqual(bad([{ title: "x", url: "javascript:alert(1)", published: "2026-10-20" }]).topics.length < 5, true);
  assert.strictEqual(bad([{ title: "x", url: "https://example.org/a", published: "2026-02-31" }]).topics.length < 5, true);         // impossible date
  assert.strictEqual(bad([]).topics.length < 5, true);
  // one bad source beside a good one: the good one keeps the topic
  const t = fiveMarket(); t[2].sources = [{ title: "x", url: "https://www.ft.com/a", published: "2026-10-20" }, src(3)];
  const ok = r.validateTopics(t, { mode: "market_update", today: TODAY });
  assert.strictEqual(ok.ok, true);
  assert.strictEqual(ok.topics[2].sources.length, 1);
});

test("topics: overlapping questions fail; a trend claim needs a measurable signal", () => {
  const t = fiveMarket(); t[1].question = t[0].question;
  assert.strictEqual(r.validateTopics(t, { mode: "market_update", today: TODAY }).topics.length < 5, true);
  const trend = fiveMarket(); trend[0].question = "Why are listings trending in Roseville?"; trend[0].trend_signals = [];
  const v = r.validateTopics(trend, { mode: "market_update", today: TODAY });
  assert.strictEqual(v.topics.length, 4);
  assert.match(v.problems.join(" "), /trend/);
  trend[0].trend_signals = ["County report shows active listings up 12% since August"];
  assert.strictEqual(r.validateTopics(trend, { mode: "market_update", today: TODAY }).ok, true);
});

test("topics: broader-than-selected data must say what area it covers", () => {
  const t = fiveMarket(); t[0].scope = "broader_context";
  assert.strictEqual(r.validateTopics(t, { mode: "market_update", today: TODAY }).topics.length < 5, true);
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
  assert.strictEqual(run({ time: "Not stated in the source" }).topics.length < 5, true);
  assert.strictEqual(run({ location: "Roseville, CA; venue not stated" }).topics.length < 5, true);
  assert.strictEqual(run({ organizer: "TBD" }).topics.length < 5, true);
  assert.strictEqual(run({ time: "N/A" }).topics.length < 5, true);
  assert.strictEqual(run({ time: "5:30–7:30 PM" }).ok, true);
  assert.match(run({ time: "Not stated in the source" }).problems.join(" "), /time is not confirmed/);
});

test("events: past, canceled, postponed and incomplete events fail the set", () => {
  const run = (over) => { const t = fiveEvents(); t[0] = rawEvent(1, over); return r.validateTopics(t, { mode: "local_events", today: TODAY }); };
  assert.strictEqual(run({ date: "2026-10-01" }).topics.length < 5, true);
  assert.strictEqual(run({ status: "canceled" }).topics.length < 5, true);
  assert.strictEqual(run({ status: "postponed" }).topics.length < 5, true);
  assert.strictEqual(run({ organizer: "" }).topics.length < 5, true);
  assert.strictEqual(run({ location: "" }).topics.length < 5, true);
  assert.strictEqual(run({ time: "" }).topics.length < 5, true);
  assert.strictEqual(run({ date: "soon" }).topics.length < 5, true);
  assert.strictEqual(run({ end_date: "2026-10-01" }).topics.length < 5, true);
  const none = fiveEvents(); none[0].event = null;
  assert.strictEqual(r.validateTopics(none, { mode: "local_events", today: TODAY }).topics.length < 5, true);
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
  const none = r.validateTopics([], { mode: "market_update", today: TODAY });
  const bad = r.outcomeFields({ validation: none, today: TODAY });
  assert.strictEqual(bad.status, "failed");
  assert.strictEqual(bad.charged_at, null);
  assert.strictEqual(bad.topics, null);
  const timeout = r.outcomeFields({ validation: null, error: "Research timed out", today: TODAY });
  assert.strictEqual(timeout.status, "failed");
  assert.strictEqual(timeout.charged_at, null);
  assert.match(timeout.error, /timed out/);
});

test("topics: no publisher-variety rule for market updates (Oct 27); events are exempt as before", () => {
  const oneSite = fiveMarket().map((t, i) => ({ ...t, sources: [{ title: "Local news story", url: `https://news.example.com/story-${i}`, published: "2026-10-20" }] }));
  const a = r.validateTopics(oneSite, { mode: "market_update", today: TODAY });
  assert.strictEqual(a.ok, true);
  assert.deepStrictEqual(a.soft, []);
  const ev = fiveEvents().map((t, i) => ({ ...t, sources: [{ title: "City", url: `https://www.roseville.ca.gov/events/${i}`, published: null }] }));
  assert.deepStrictEqual(r.validateTopics(ev, { mode: "local_events", today: TODAY }).soft, []);
});

test("sources: articles only. Listing pages, brokerage landing pages and agent sites are dropped; news, city pages and portal research stay", () => {
  const one = (url) => { const t = fiveMarket(); t[0] = { ...t[0], sources: [{ title: "S", url, published: "2026-10-20" }] }; return r.validateTopics(t, { mode: "market_update", today: TODAY }); };
  const dropped = [
    "https://homes.re.eukreate.com/homes/ca/antelope/4148-crumley-way-3fd1b4d6d6",      // a single listing
    "https://homes.re.eukreate.com/markets/ca/county/sacramento",                      // a brokerage's market page
    "https://www.evatagorerealestate.com/neighborhood/163179424/antelope",             // a brokerage neighborhood page
    "https://www.zillow.com/homedetails/4148-Crumley-Way-Antelope-CA-95843/1_zpid/",
    "https://www.redfin.com/zipcode/95843/housing-market",                             // a portal market page is data, not an article
    "https://www.redfin.com/CA/Antelope/4148-Crumley-Way-95843/home/123",
    "https://www.realtor.com/realestateandhomes-detail/4148-Crumley-Way_Antelope_CA_95843_M12345-67890",
    "https://www.sheahomes.com/55-plus-homes/california/",                              // a builder landing page
    "https://www.zillow.com/sacramento-ca/55-community/",                              // a portal search page
    "https://www.55places.com/california",
    "https://www.example-city.org/homes/for-sale",
  ];
  dropped.forEach((u) => { const v = one(u); assert.strictEqual(v.topics.length, 4, u); assert.match(v.problems.join(" "), /topic 1: no usable source/, u); });
  const kept = [
    "https://smithteamrealty.com/blog/market-update",                                   // a blog is an article wherever it lives (Sam, Oct 28)
    "https://www.redfin.com/blog/sacramento-housing-market-update/",
    "https://www.sacbee.com/news/local/neighborhoods/article99999.html",               // a news story whose path says neighborhoods
    "https://www.abc10.com/article/news/local/communities/antelope-apartments/",
    "https://www.sacbee.com/news/business/real-estate/article12345.html",
    "https://www.cityofantelope.example.gov/news/2026/10/permits",
    "https://www.redfin.com/news/housing-market-update-october-2026/",
    "https://www.zillow.com/research/home-values-october-2026/",
    "https://www.car.org/marketdata/news/october-2026",
    "https://sacramentoappraisalblog.com/2026/10/",
    "https://myfolsom.com/2026/10/sacramento-housing-market-rates-no-crash/",
  ];
  kept.forEach((u) => assert.strictEqual(one(u).ok, true, u));
  // Local Events keeps its own sources: a city calendar page under /events/ or /communities/ is fine
  const ev = fiveEvents().map((t, i) => ({ ...t, sources: [{ title: "City", url: `https://www.roseville.ca.gov/communities/events/${i}`, published: null }] }));
  assert.strictEqual(r.validateTopics(ev, { mode: "local_events", today: TODAY }).ok, true);
});

test("topic prompt: articles only, a specific development behind each question, keywords first, no publisher rule", () => {
  const sp = r.systemPrompt("market_update");
  assert.match(sp, /SOURCES MUST BE ARTICLES/);
  assert.match(sp, /A listing page cannot support a question/);
  assert.match(sp, /BUILD EACH QUESTION FROM ONE SPECIFIC DEVELOPMENT/);
  assert.match(sp, /stale and generic/);
  assert.match(sp, /search for articles about those keywords in this market FIRST/);
  assert.match(sp, /keyword_match/);
  assert.doesNotMatch(sp, /at least three different publishers/);
  assert.doesNotMatch(r.systemPrompt("local_events"), /SOURCES MUST BE ARTICLES/);
});

test("keyword_match is carried on the topic, and only a literal true counts", () => {
  const t = fiveMarket().map((x, i) => ({ ...x, keyword_match: i === 0 ? true : i === 1 ? "yes" : undefined }));
  const v = r.validateTopics(t, { mode: "market_update", today: TODAY });
  assert.deepStrictEqual(v.topics.map((x) => x.keywordMatch), [true, false, false, false, false]);
});

test("text that is too long is cut back to a whole word, never mid-word", () => {
  const intake = require("../netlify/functions/lib/agent-marketing-intake");
  const cta = "Ask me what September's pending data means for your timing and pricing — no pressure at all.";
  const out = intake.cleanWords(cta, 80);
  assert.ok(out.length <= 80);
  assert.ok(cta.startsWith(out));
  assert.ok(!/[—,;:-]$/.test(out));
  assert.strictEqual(out, "Ask me what September's pending data means for your timing and pricing");
  assert.strictEqual(intake.cleanWords("short text", 80), "short text");
  assert.strictEqual(intake.cleanWords("abcdefghij", 5), "abcde"); // one long word: nothing to cut back to
  assert.strictEqual(intake.cleanWords("one two three", 7), "one two");
  assert.strictEqual(intake.cleanWords("one two three", 8), "one two"); // would cut "three" in half
});

test("keywords: optional, cleaned, kept short, part of the request key and the research request", () => {
  const base = { mode: "market_update", audience: "sellers", geography: { zip: "95678", type: "city", name: "Roseville" } };
  const none = r.validateResearchRequest(base).request;
  assert.strictEqual(none.keywords, "");
  const kw = r.validateResearchRequest({ ...base, keywords: "55+, Four Seasons\nHeritage" }).request;
  assert.strictEqual(kw.keywords, "55+, Four Seasons, Heritage");
  assert.notStrictEqual(r.requestKey(none), r.requestKey(kw));
  assert.strictEqual(r.requestKey(kw), r.requestKey(r.validateResearchRequest({ ...base, keywords: "55+, FOUR SEASONS, heritage" }).request));
  assert.ok(r.validateResearchRequest({ ...base, keywords: "x ".repeat(200) }).request.keywords.length <= 120);
  const p = r.buildResearchPayload({ request: kw, today: "2026-10-25", env: {} });
  assert.ok(/Keywords from the agent \(search for articles about these[^\n]*55\+, Four Seasons, Heritage/.test(p.input));
  assert.ok(!/Keywords from the agent/.test(r.buildResearchPayload({ request: none, today: "2026-10-25", env: {} }).input));
});

test("recommendation: the model's pick is attached to that topic; a missing or odd pick never fails the run", () => {
  const opts = { mode: "market_update", today: TODAY };
  const rec = { topic: 3, reason: "  Sellers are asking this now.  ", evidence: ["Pending sales rose.", "Days on market fell.", "c", "d"] };
  const v = r.validateTopics(fiveMarket(), { ...opts, recommendation: rec });
  assert.strictEqual(v.ok, true);
  assert.deepStrictEqual(v.topics.filter((t) => t.recommended).map((t) => t.id), ["t3"]);
  assert.strictEqual(v.topics[2].recommended.reason, "Sellers are asking this now.");
  assert.strictEqual(v.topics[2].recommended.evidence.length, 3);
  for (const bad of [null, {}, { topic: 9, reason: "x" }, { topic: 2, reason: "" }, { topic: "two", reason: "x" }, "t2"]) {
    const w = r.validateTopics(fiveMarket(), { ...opts, recommendation: bad });
    assert.strictEqual(w.ok, true);
    assert.strictEqual(w.topics.filter((t) => t.recommended).length, 0);
  }
  assert.deepStrictEqual(r.extractRecommendation(JSON.stringify({ topics: [], recommendation: rec })), rec);
  assert.strictEqual(r.extractRecommendation("not json"), null);
  assert.match(r.systemPrompt("market_update"), /"recommendation"/);
});

test("optional data: four choices, default all with the last 30 days; none and Local Events carry no period; the period is checked", () => {
  const base = { mode: "market_update", audience: "sellers", geography: { zip: "95678", type: "city", name: "Roseville" } };
  assert.deepStrictEqual(r.DATA_FOCUS.map((d) => d.key), ["none", "stats", "recent_sales", "all"]);
  const d = r.validateResearchRequest(base).request;
  assert.strictEqual(d.dataFocus, "all");
  assert.deepStrictEqual(d.period, { days: 30 });
  const none = r.validateResearchRequest({ ...base, dataFocus: "none", period: { days: 90 } }).request;
  assert.strictEqual(none.period, null);
  const ev = r.validateResearchRequest({ ...base, mode: "local_events", dataFocus: "all" }).request;
  assert.deepStrictEqual([ev.dataFocus, ev.period], ["none", null]);
  assert.deepStrictEqual(r.validateResearchRequest({ ...base, dataFocus: "recent_sales", period: { start: "2026-07-01", end: "2026-09-30" } }).request.period, { start: "2026-07-01", end: "2026-09-30" });
  for (const bad of [{ dataFocus: "everything" }, { period: { days: 45 } }, { period: { start: "2026-10-01", end: "2026-09-01" } }, { period: { start: "x", end: "y" } }, { period: { start: "2020-01-01", end: "2026-01-01" } }]) {
    assert.strictEqual(r.validateResearchRequest({ ...base, ...bad }).ok, false, JSON.stringify(bad));
  }
  // a different data choice or period is a different request, so it is not served from an old saved set
  const k = (x) => r.requestKey(r.validateResearchRequest({ ...base, ...x }).request);
  assert.notStrictEqual(k({}), k({ dataFocus: "stats" }));
  assert.notStrictEqual(k({}), k({ period: { days: 90 } }));
  assert.strictEqual(k({}), k({ dataFocus: "all", period: { days: 30 } }));
});

test("optional data: the research is told what data and which dates; periods count back from today; none and events say nothing about data", () => {
  const base = { mode: "market_update", audience: "sellers", geography: { zip: "95678", type: "city", name: "Roseville" } };
  const input = (x) => r.buildResearchPayload({ request: r.validateResearchRequest({ ...base, ...x }).request, today: "2026-10-25", env: {} }).input;
  assert.match(input({ dataFocus: "recent_sales", period: { days: 30 } }), /Optional data to include: recent listings and sales[^\n]*never individual properties[^\n]*Period: 2026-09-26 to 2026-10-25\./);
  assert.match(input({ dataFocus: "stats", period: { start: "2026-07-01", end: "2026-09-30" } }), /MLS-based market statistics[^\n]*Period: 2026-07-01 to 2026-09-30\./);
  assert.match(input({}), /all available market data/);
  assert.match(input({}), /State on every figure the period it covers/);
  assert.match(input({ dataFocus: "none" }), /Optional data: none/);
  assert.doesNotMatch(input({ mode: "local_events" }), /Optional data/);
  assert.deepStrictEqual(r.periodDates({ days: 7 === 7 ? 30 : 0 }, "2026-10-25"), { start: "2026-09-26", end: "2026-10-25" });
});

test("the research prompt asks for a short hook, not an article title", () => {
  const sys = r.systemPrompt("market_update");
  assert.match(sys, /HOOK, not an article title: 12 words or fewer/);
  assert.match(sys, /never use a colon, a source name or a date range/);
});

// ── ZIP required for a Local Market Update (Oct 27, 2026) ─────────────────────────────────────────────────────────
test("zip: a Local Market Update needs a 5-digit ZIP for every market type except ZIP itself; Local Events does not", () => {
  const base = { mode: "market_update", audience: "sellers" };
  for (const geography of [{ type: "city", name: "Roseville" }, { type: "neighborhood", name: "Crocker Ranch", city: "Roseville" }, { type: "county", name: "Placer" }, { type: "metro", name: "Sacramento" }]) {
    const missing = r.validateResearchRequest({ ...base, geography });
    assert.strictEqual(missing.ok, false);
    assert.ok(missing.errors.some((e) => e.field === "geography.zip" && /5-digit ZIP/.test(e.message)), geography.type);
    const ok = r.validateResearchRequest({ ...base, geography: { ...geography, zip: "95746" } });
    assert.strictEqual(ok.ok, true);
    assert.strictEqual(ok.request.geography.zip, "95746");
  }
  assert.strictEqual(r.validateResearchRequest({ ...base, geography: { type: "city", name: "Roseville", zip: "9574" } }).ok, false);
  assert.strictEqual(r.validateResearchRequest({ ...base, geography: { type: "city", name: "Roseville", zip: "ABCDE" } }).ok, false);
  // a ZIP market is its own ZIP
  assert.strictEqual(r.validateResearchRequest({ ...base, geography: { type: "zip", name: "95746" } }).request.geography.zip, "95746");
  // Local Events never needs one, but a malformed one is still refused and a good one is kept
  assert.strictEqual(r.validateResearchRequest({ mode: "local_events", audience: "general", geography: { type: "city", name: "Roseville" } }).ok, true);
  assert.strictEqual(r.validateResearchRequest({ mode: "local_events", audience: "general", geography: { type: "city", name: "Roseville", zip: "12" } }).ok, false);
  // validateGeography alone (report upload check) does not require it
  assert.strictEqual(r.validateGeography({ type: "city", name: "Roseville" }).ok, true);
  assert.strictEqual(r.validateGeography({ type: "city", name: "Roseville" }, { requireZip: true }).ok, false);
});

test("zip: a different ZIP is a different request", () => {
  const mk = (zip) => r.validateResearchRequest({ mode: "market_update", audience: "sellers", geography: { type: "city", name: "Roseville", zip } }).request;
  assert.strictEqual(r.requestKey(mk("95746")), r.requestKey(mk("95746")));
  assert.notStrictEqual(r.requestKey(mk("95746")), r.requestKey(mk("95678")));
});

test("source rule: a topic is one local article; market data comes from the agent's report, never another publisher", () => {
  const sp = r.systemPrompt("market_update");
  assert.ok(/ONE local article/.test(sp));
  assert.ok(/never add market statistics from another publisher/.test(sp));
  assert.ok(/agent's own uploaded report/.test(sp));
  assert.ok(!/from ONE source and name its period/.test(sp));
});

test("topic prompt: a market update always returns five (wider articles marked broader_context); events may still return fewer", () => {
  const m = r.systemPrompt("market_update");
  assert.match(m, /ALWAYS RETURN FIVE TOPICS/);
  assert.match(m, /Returning none, or fewer than five, is a failure/);
  assert.doesNotMatch(m, /return fewer rather than guess/);
  assert.match(r.systemPrompt("local_events"), /return fewer rather than guess/);
});

test("source filter: an association on .org is an article source, a builder's inventory page is not, and a dropped source says why (Oct 27)", () => {
  const good = { title: "Housing Statistics – September 2026", url: "https://sacrealtor.org/housing-statistics-september-2026/", published: "2026-10-20" };
  const lennar = { title: "Residence 1233", url: "https://www.lennar.com/new-homes/california/sacramento/antelope/antelope-north/calabria-ii/residence-1233/2476510114", published: "2026-10-20" };
  const old = { title: "Old piece", url: "https://www.sacbee.com/news/article1.html", published: "2026-06-01" };
  const mk = (sources) => (Array.from({ length: 5 }, (_, i) => ({ question: ["Are Antelope sellers cutting prices?","How fast do Antelope homes go pending?","Is new construction pulling Antelope buyers?","What do rising rates mean on Walerga Road?","Why are Sacramento listings climbing now?"][i], why_it_matters: "It matters to sellers.", trend_signals: [], local_intent: true, scope: "selected", scope_note: null, event: null, keyword_match: false, sources })));
  const okRes = r.validateTopics(mk([good]), { mode: "market_update", today: "2026-10-27" });
  assert.strictEqual(okRes.topics.length, 5, "sacrealtor.org must not be dropped as an agent's own site");
  const bad = r.validateTopics(mk([lennar, old]), { mode: "market_update", today: "2026-10-27" });
  assert.strictEqual(bad.topics.length, 0);
  assert.match(bad.problems.join(" "), /lennar\.com: looks like a listing/);
  assert.match(bad.problems.join(" "), /sacbee\.com: 148 days old/);
});

test("event details: what the event offers is kept (short, up to six, placeholders dropped) and absent when the page lists none", () => {
  const withD = r.validateTopics([rawEvent(1, { details: ["Browse dozens of local vendors", "A bake sale and an antique sale", "Free and open to the public", "Proceeds support the Eskaton Foundation", "Register through the online form", "TBD", "extra one", "extra two"] })], { mode: "local_events", today: TODAY });
  assert.deepStrictEqual(withD.topics[0].event.details.slice(0, 2), ["Browse dozens of local vendors", "A bake sale and an antique sale"]);
  assert.ok(withD.topics[0].event.details.length <= 6);
  assert.ok(!withD.topics[0].event.details.includes("TBD"));
  const none = r.validateTopics([rawEvent(1)], { mode: "local_events", today: TODAY });
  assert.strictEqual(none.topics[0].event.details, undefined);
  assert.match(r.systemPrompt("local_events"), /details: up to 6 short facts/);
});
