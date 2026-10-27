// Run with: npm test
// Redfin Market Trends as the market data when no report is uploaded (Sam, Oct 27, 2026). The fixture is the 95746 page as Sam's screenshot shows it.
const test = require("node:test");
const assert = require("node:assert");
const rf = require("../netlify/functions/lib/agent-marketing-redfin-lib");
const run = require("../netlify/functions/lib/agent-marketing-research-run-lib");

const TODAY = "2026-10-27";
const PERIOD = "Over the three months ending September 2026, 95746 home prices were up 0.8% compared to the same period last year, selling for a median price of $1.2M.";
const page = (over) => ({
  page_url: "https://www.redfin.com/zipcode/95746/housing-market",
  period_sentence: PERIOD,
  figures: [
    { label: "Median sale price", value: "$1.2M", change: "up 0.8% since the same period last year", sentence: PERIOD },
    { label: "Median days on market", value: "44 days", change: "26 days last year", sentence: "On average, homes in 95746 sell after 44 days on the market compared to 26 days last year." },
    { label: "Homes sold", value: "78", change: "up from 76 last year", sentence: "There were 78 homes sold in September this year, up from 76 last year." },
    { label: "Median sale price per square foot", value: "$428", change: "up 9.6% since last year", sentence: "The median sale price per square foot in 95746 is $428, up 9.6% since last year." },
  ],
  ...over,
});

test("payload: the exact ZIP, the Redfin page only, copy never calculate; model is tunable", () => {
  const p = rf.buildRedfinPayload({ zip: "95746", env: {} });
  assert.strictEqual(p.model, "perplexity/sonar");
  assert.ok(/ZIP code: 95746/.test(p.input) && p.input.includes("https://www.redfin.com/zipcode/95746/housing-market"));
  assert.ok(/never calculate, round, estimate, average or add anything/.test(p.instructions));
  assert.ok(/Use no other website and no other ZIP code/.test(p.instructions));
  // a live fetch of the exact page, not the search index (which held an older month for Antelope on Oct 27)
  assert.deepStrictEqual(p.tools, [{ type: "fetch_url", max_urls: 1 }]);
  assert.ok(/fetch_url tool/.test(p.instructions) && /Fetch that page now/.test(p.input));
  assert.strictEqual(rf.buildRedfinPayload({ zip: "95746", env: { AGENT_MARKETING_REDFIN_MODEL: "openai/gpt-6-luna" } }).model, "openai/gpt-6-luna");
});

test("period: read from the page's own wording; attribution is Sam's wording with that period", () => {
  assert.deepStrictEqual(rf.parsePeriod(PERIOD), { month: "2026-09", label: "3-mos. ending September 2026" });
  assert.strictEqual(rf.parsePeriod("over the last 3 months ending Aug 2026").month, "2026-08");
  assert.strictEqual(rf.parsePeriod("Over the last 3 months"), null);
  assert.strictEqual(rf.attribution(rf.parsePeriod(PERIOD)), "Redfin Market Trends: Based on Redfin calculations of home data from MLS and/or public records. [Over the 3-mos. ending September 2026]");
});

test("validate: Sam's 95746 page is accepted whole; Redfin's numbers are never second-guessed; one attribution covers the page", () => {
  const v = rf.validateRedfin(page(), { zip: "95746", today: TODAY });
  assert.strictEqual(v.ok, true, v.problems.join("; "));
  assert.strictEqual(v.redfin.figures.length, 4);
  assert.ok(v.redfin.attribution.endsWith("[Over the 3-mos. ending September 2026]"));
  assert.deepStrictEqual(v.warnings, []);
  // "78 homes sold in September" is a one-month figure: kept, in Redfin's own sentence, under the page-level attribution
  const sold = v.redfin.figures.find((f) => f.label === "Homes sold");
  assert.ok(/78 homes sold in September/.test(sold.sentence));
  // 44 days vs 26 last year is a big swing: still Redfin's number, never questioned
  assert.strictEqual(v.redfin.figures.find((f) => /days/.test(f.label)).display, "44 days");
});

test("validate: Lincoln's tiles and narrative show one figure two ways ($620,704 and $621K); both are kept, nothing is compared", () => {
  const LINC = "Over the three months ending September 2026, Lincoln home prices were up 3.5% compared to the same period last year, selling for a median price of $621K. On average, homes in Lincoln sell after 37 days on the market compared to 35 days last year. There were 279 homes sold in September this year, up from 251 last year.";
  const v = rf.validateRedfin({
    page_url: "https://www.redfin.com/city/10201/CA/Lincoln/housing-market".replace("/city/10201/CA/Lincoln", "/zipcode/95648"), period_sentence: LINC,
    figures: [
      { label: "Median Sale Price", value: "$620,704", change: "+3.5% year-over-year", sentence: "Median Sale Price $620,704 +3.5% year-over-year" },
      { label: "Median sale price", value: "$621K", change: "up 3.5% compared to the same period last year", sentence: LINC },
      { label: "# of Homes Sold", value: "279", change: "+11.3% year-over-year", sentence: "# of Homes Sold 279 +11.3% year-over-year" },
      { label: "Median Days on Market", value: "37", change: "+2 year-over-year", sentence: "Median Days on Market 37 +2 year-over-year" },
    ],
  }, { zip: "95648", today: TODAY });
  assert.strictEqual(v.ok, true, v.problems.join("; "));
  assert.strictEqual(v.redfin.figures.length, 4);
  assert.deepStrictEqual(v.warnings, []);
  assert.ok(v.redfin.attribution.endsWith("[Over the 3-mos. ending September 2026]"));
});

test("validate: a figure with no period of its own is kept, not dropped", () => {
  const v = rf.validateRedfin(page({ figures: [{ label: "Homes sold above list", value: "24.7%", change: null, sentence: "24.7% of homes sold above list price." }] }), { zip: "95746", today: TODAY });
  assert.strictEqual(v.ok, true);
  assert.strictEqual(v.redfin.figures.length, 1);
});

test("validate: an older period is used and flagged, never rejected", () => {
  const aug = PERIOD.replace("September", "August");
  const v = rf.validateRedfin(page({ period_sentence: aug }), { zip: "95746", today: TODAY });
  assert.strictEqual(v.ok, true);
  assert.strictEqual(v.redfin.period.label, "3-mos. ending August 2026");
  assert.ok(v.warnings.some((w) => /older than the last complete month/.test(w)));
});

test("validate: refused only when it is not Redfin's page for this ZIP, names no period, or has no figure", () => {
  const bad = (over, opts) => rf.validateRedfin(page(over), { zip: "95746", today: TODAY, ...opts });
  assert.strictEqual(bad({ page_url: "https://www.zillow.com/home-values/95746/" }).ok, false);
  assert.strictEqual(bad({ page_url: "https://www.redfin.com/zipcode/95678/housing-market" }).ok, false);
  assert.strictEqual(bad({ page_url: "https://redfin.com.evil.example/zipcode/95746/housing-market" }).ok, false);
  assert.strictEqual(bad({ period_sentence: "Over the last 3 months, prices were up." }).ok, false);
  assert.strictEqual(bad({ figures: [] }).ok, false);
  // a figure is never dropped or refused for its value, or for not matching a sentence: Redfin's page is the source of truth
  const v = bad({ figures: [{ label: "Median sale price", value: "$1.3M", change: null, sentence: PERIOD }, ...page().figures.slice(1, 2)] });
  assert.strictEqual(v.ok, true);
  assert.strictEqual(v.redfin.figures.length, 2);
  assert.deepStrictEqual(v.warnings, []);
  // only an item with no label or no number at all is not a figure
  assert.strictEqual(bad({ figures: [{ label: "", value: "5", sentence: "x" }, { label: "Median days on market", value: "n/a", sentence: "x" }] }).ok, false);
  // the provider says it read other pages only
  assert.strictEqual(bad({}, { citations: ["https://www.zillow.com/x"] }).ok, false);
  assert.strictEqual(bad({}, { citations: ["https://www.redfin.com/zipcode/95746/housing-market?utm_source=smartstagepro.com"] }).ok, true);
  assert.strictEqual(rf.validateRedfin(page(), { zip: "9574", today: TODAY }).ok, false);
});

// ── the run: its own provider call, never fatal ─────────────────────────────────────────────────────────────────────
const Q = ["Are Lincoln sellers still getting full price?", "What is new construction doing to resale pricing?", "How long are homes sitting this fall?", "Are price cuts becoming more common?", "Which price bands are moving?"];
const topic = (n) => ({ question: Q[n - 1], why_it_matters: "It changes how sellers price.", trend_signals: ["Active listings up"], local_intent: true, scope: "selected", scope_note: null, event: null, sources: [{ title: `Source ${n}`, url: `https://site${n}.example.org/r${n}`, published: "2026-10-20" }] });
const topicsReply = () => ({ status: 200, json: { output: [{ type: "search_results", results: [1, 2, 3, 4, 5].map((i) => ({ url: `https://site${i}.example.org/r${i}` })) }, { type: "message", content: [{ type: "output_text", text: JSON.stringify({ topics: [1, 2, 3, 4, 5].map(topic) }) }] }] } });
const redfinReply = (obj) => ({ status: 200, json: { citations: ["https://www.redfin.com/zipcode/95746/housing-market"], output: [{ type: "message", content: [{ type: "output_text", text: "```json\n" + JSON.stringify(obj) + "\n```" }] }] } });
const router = (redfin) => { const calls = []; const fn = async (p) => { calls.push(p); return /ONE web page/.test(p.instructions) ? (typeof redfin === "function" ? redfin() : redfin) : topicsReply(); }; fn.calls = calls; return fn; };
const row = (geo) => ({ id: "r1", mode: "market_update", audience: "sellers", geography: { type: "city", name: "Lincoln", city: "", state: "CA", label: "Lincoln, CA", ...geo }, focus: {}, upload_refs: [], data_source: "web" });
const NOW = "2026-10-27T17:00:00Z";
const noSleep = async () => {};

test("run: with a ZIP and no upload, every topic carries the Redfin data; one extra call, session still charged once", async () => {
  const callFn = router(redfinReply(page()));
  const r = await run.runResearch({ row: row({ zip: "95746" }), apiKey: "k", now: NOW, env: {}, sleepFn: noSleep, callFn });
  assert.strictEqual(r.fields.status, "ready");
  assert.ok(r.fields.charged_at);
  assert.strictEqual(callFn.calls.length, 2);
  r.fields.topics.forEach((t) => { assert.strictEqual(t.marketData.kind, "redfin_market_trends"); assert.strictEqual(t.marketData.zip, "95746"); assert.ok(/\[Over the 3-mos\. ending September 2026\]$/.test(t.marketData.attribution)); });
  assert.strictEqual(r.fields.usage.redfinNote, null);
});

test("run: a ZIP market uses its own ZIP", async () => {
  const callFn = router(redfinReply(page()));
  const r = await run.runResearch({ row: row({ type: "zip", name: "95746" }), apiKey: "k", now: NOW, env: {}, sleepFn: noSleep, callFn });
  assert.strictEqual(r.fields.topics[0].marketData.zip, "95746");
});

test("run: Redfin failing never fails the session; the agent is told", async () => {
  for (const bad of [{ status: 500, json: {} }, redfinReply({ page_url: "https://www.zillow.com/x", figures: [] }), { status: 200, json: { output: [{ type: "message", content: [{ type: "output_text", text: "I could not open that page." }] }] } }]) {
    const r = await run.runResearch({ row: row({ zip: "95746" }), apiKey: "k", now: NOW, env: {}, sleepFn: noSleep, callFn: router(() => bad) });
    assert.strictEqual(r.fields.status, "ready");
    assert.ok(r.fields.charged_at);
    assert.ok(r.fields.topics.every((t) => !t.marketData));
    assert.ok(/Redfin Market Trends could not be read for ZIP 95746/.test(r.fields.usage.redfinNote));
    assert.ok(r.fields.usage.redfinDebug === null || (typeof r.fields.usage.redfinDebug.answer === "string" && r.fields.usage.redfinDebug.answer.length <= 1500));
  }
});

test("run: no ZIP, an uploaded report, or Local Events means no Redfin call", async () => {
  const noZip = router(redfinReply(page()));
  const a = await run.runResearch({ row: row({}), apiKey: "k", now: NOW, env: {}, sleepFn: noSleep, callFn: noZip });
  assert.strictEqual(noZip.calls.filter((c) => /ONE web page/.test(c.instructions)).length, 0);
  assert.ok(/No ZIP code was given/.test(a.fields.usage.redfinNote));
  const events = router(redfinReply(page()));
  await run.runResearch({ row: { ...row({ zip: "95746" }), mode: "local_events" }, apiKey: "k", now: NOW, env: {}, sleepFn: noSleep, callFn: events });
  assert.strictEqual(events.calls.filter((c) => /ONE web page/.test(c.instructions)).length, 0); // (the topic call may retry; none is a Redfin call)
});

test("fetchRedfinTrends never throws and reports why", async () => {
  const x = await run.fetchRedfinTrends({ zip: "95746", apiKey: "k", callFn: async () => { throw new Error("socket hang up"); }, sleepFn: noSleep, today: TODAY, env: {} });
  assert.strictEqual(x.ok, false);
  assert.ok(x.problems.length);
  const y = await run.fetchRedfinTrends({ zip: "95746", apiKey: "k", callFn: async () => redfinReply(page()), sleepFn: noSleep, today: TODAY, env: {} });
  assert.strictEqual(y.ok, true);
  assert.strictEqual(y.redfin.figures.length, 4);
});

test("a refused Redfin answer keeps what the provider said, so the cause can be seen; a good one keeps nothing extra", async () => {
  const said = { status: 200, json: { citations: ["https://www.redfin.com/zipcode/95843/housing-market"], output: [{ type: "message", content: [{ type: "output_text", text: JSON.stringify({ page_url: "https://www.redfin.com/zipcode/95843/housing-market", period_sentence: "Prices were up over the last quarter.", figures: [{ label: "Median sale price", value: "$520K", sentence: "median price of $520K" }] }) }] }] } };
  const bad = await run.fetchRedfinTrends({ zip: "95843", apiKey: "k", callFn: async () => said, sleepFn: noSleep, today: TODAY, env: {} });
  assert.strictEqual(bad.ok, false);
  assert.ok(/Prices were up over the last quarter/.test(bad.debug.answer));
  assert.deepStrictEqual(bad.debug.citations, ["https://www.redfin.com/zipcode/95843/housing-market"]);
  const good = await run.fetchRedfinTrends({ zip: "95746", apiKey: "k", callFn: async () => redfinReply(page()), sleepFn: noSleep, today: TODAY, env: {} });
  assert.strictEqual(good.debug, null);
});
