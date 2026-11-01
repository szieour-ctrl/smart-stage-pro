// Run with: npm test
// PR 2 (separate commit): a weaker retry must not silently replace a stronger earlier answer. Market Update and Local Events.
const test = require("node:test");
const assert = require("node:assert");
const run = require("../netlify/functions/lib/agent-marketing-research-run-lib");
const fx = require("./fixtures/research-diag/scenarios");
const golden = require("./fixtures/research-diag/golden.json");

const NOW = fx.NOW; // 2026-10-24
const quiet = async (fn) => { const e = console.error; console.error = () => {}; try { return await fn(); } finally { console.error = e; } };
const noSleep = async () => {};
const WHY = "It changes how sellers price and how long they should expect to wait, which affects their plans and the offers they take this fall season.";

// ── Market Update ──────────────────────────────────────────────────────────────────────────────
const T = (i, srcs) => ({ question: ["Are new subdivisions pulling buyers from resale homes?", "Why did the city approve more apartments this fall?", "What do higher mortgage rates mean for move-up buyers?", "Is the school-year calendar shifting listing timing?", "Which price bands saw pending sales slip last month?"][i - 1],
  why_it_matters: WHY, trend_signals: ["Active listings rose in September 2026 from August 2026"], local_intent: true, scope: "selected", scope_note: null, event: null,
  sources: srcs || [{ title: `Story ${i}`, url: `https://site${i}.example/news/story-${i}`, published: "2026-10-18" }] });
const bad = (i) => T(i, [{ title: "Paywalled", url: "https://www.wsj.com/articles/x" + i, published: "2026-10-18" }]);   // never usable
const urls = [1, 2, 3, 4, 5].map((i) => `https://site${i}.example/news/story-${i}`).concat(["https://www.wsj.com/articles/x1"]);
const answer = (topics, n) => fx.reply(urls, topics, n);
const row = { id: "r1", mode: "market_update", audience: "sellers", geography: fx.GEO.lincoln, focus: {}, upload_refs: [], data_source: "web" };

async function go(answers, rowOverride, env) {
  const left = answers.slice();
  const r = await quiet(() => run.runResearch({ row: rowOverride || row, apiKey: "k", now: NOW, env: env || {}, sleepFn: noSleep, callFn: async () => left.shift() || answers[answers.length - 1] }));
  return r;
}
const used = (r) => r.fields.usage.discovery.used_attempt;
const ids = (r) => (r.fields.topics || []).map((t) => t.question);

test("market update: a usable but weaker retry does not replace a stronger first answer", async () => {
  const first = [T(1), T(2), T(3), bad(4), bad(5)];     // 3 usable (partial: triggers the retry)
  const second = [T(1), T(2), bad(3), bad(4), bad(5)];  // 2 usable: weaker
  const r = await go([answer(first, 1), answer(second, 2)]);
  assert.strictEqual(r.attempts, 2);
  assert.strictEqual(r.fields.status, "ready");
  assert.strictEqual(r.fields.topics.length, 3);
  assert.strictEqual(used(r), 1);
  assert.deepStrictEqual(r.fields.usage.discovery.selection.attempts.map((a) => a.strength[0]), [3, 2]);
  // the scenario that showed the problem in PR 1 now keeps the 3-topic answer
  const sc = fx.scenarios().find((s) => s.name === "partial_then_worse_retry");
  assert.strictEqual(golden[sc.name].fields.topics.length, 2, "the golden entry still records the old behavior");
  const { result } = await quiet(() => fx.runScenario(run, sc));
  assert.strictEqual(result.fields.topics.length, 3);
});

test("market update: a stronger retry replaces the first answer", async () => {
  const first = [T(1), T(2), bad(3), bad(4), bad(5)];
  const second = [T(1), T(2), T(3), T(4), T(5)];
  const r = await go([answer(first, 1), answer(second, 2)]);
  assert.strictEqual(r.fields.topics.length, 5); assert.strictEqual(used(r), 2);
});

test("market update: equal strength keeps the later answer", async () => {
  const first = [T(1), T(2), T(3), bad(4), bad(5)];
  const second = [T(1), T(2), T(3), bad(4), bad(5)];
  const r = await go([answer(first, 1), answer(second, 2)]);
  assert.strictEqual(used(r), 2);
});

test("market update: after the topic count, distinct articles and then publishers decide", async () => {
  const sameArticle = (i) => T(i, [{ title: "One story", url: "https://site1.example/news/story-1", published: "2026-10-18" }]);
  const first = [T(1), sameArticle(2), sameArticle(3), bad(4), bad(5)].map((t, i) => (i === 1 ? { ...t, question: "Why did the city approve more apartments this fall?" } : i === 2 ? { ...t, question: "What do higher mortgage rates mean for move-up buyers?" } : t)); // 3 topics, 1 article
  const second = [T(1), T(2), T(3), bad(4), bad(5)];                                                                                                                            // 3 topics, 3 articles
  const r = await go([answer(first, 1), answer(second, 2)]);
  assert.strictEqual(r.fields.topics.length, 3); assert.strictEqual(used(r), 2);
  const r2 = await go([answer(second, 1), answer(first, 2)]);   // the stronger one came first: it stays
  assert.strictEqual(used(r2), 1);
});

test("market update: an unusable retry keeps the earlier usable answer, and three attempts keep the strongest", async () => {
  const first = [T(1), T(2), T(3), bad(4), bad(5)];
  const none = [bad(1), bad(2), bad(3), bad(4), bad(5)];
  const r = await go([answer(first, 1), answer(none, 2)]);
  assert.strictEqual(r.fields.status, "ready"); assert.strictEqual(r.fields.topics.length, 3); assert.strictEqual(used(r), 1);
  const second = [T(1), T(2), T(3), T(4), bad(5)];   // 4
  const third = [T(1), T(2), bad(3), bad(4), bad(5)]; // 2
  const r3 = await go([answer(first, 1), answer(second, 2), answer(third, 3)], row, { AGENT_MARKETING_RESEARCH_RETRIES: "2" });
  assert.strictEqual(r3.attempts, 3); assert.strictEqual(r3.fields.topics.length, 4); assert.strictEqual(used(r3), 2);
});

test("market update: a first answer that is already complete is unchanged and no retry is made", async () => {
  const r = await go([answer([T(1), T(2), T(3), T(4), T(5)], 1)]);
  assert.strictEqual(r.attempts, 1); assert.strictEqual(r.fields.topics.length, 5); assert.strictEqual(used(r), 1);
});

// ── Local Events ───────────────────────────────────────────────────────────────────────────────
const ev = (i, ok = true) => ({
  question: ["Which holiday craft fair benefits the library?", "Where is the harvest market this Saturday?", "Who is playing the downtown concert series?", "When does the fun run start at the lake?", "What opens at the theater for opening night?", "Which car show rolls into the old depot?", "Where do neighbors gather for the lantern walk?", "Who hosts the chili cook-off at the park?"][i - 1], why_it_matters: WHY, trend_signals: [], local_intent: true, scope: "selected", scope_note: null,
  event: { name: `Event ${i}`, date: "2026-10-30", end_date: null, dates_as_published: "Oct 30", time: "6 p.m.", location: `Venue ${i}, Lincoln`, organizer: `Organizer ${i}`, status: ok ? "upcoming" : "canceled", details: ["Live music"] },
  sources: [{ title: `Event page ${i}`, url: `https://events${i}.example/event-${i}`, published: "" }],
});
const evUrls = [1, 2, 3, 4, 5, 6, 7, 8].map((i) => `https://events${i}.example/event-${i}`);
const evAnswer = (events, n) => fx.reply(evUrls, events, n);
const evRow = { id: "e1", mode: "local_events", audience: "sellers", geography: fx.GEO.lincoln, focus: {}, upload_refs: [], data_source: "web" };

test("local events: a weaker retry does not replace a stronger first answer", async () => {
  const first = [ev(1), ev(2), ev(3), ev(4, false), ev(5, false)];     // 3 valid (partial)
  const second = [ev(1), ev(2), ev(3, false), ev(4, false), ev(5, false)]; // 2 valid
  const r = await go([evAnswer(first, 1), evAnswer(second, 2)], evRow);
  assert.strictEqual(r.attempts, 2); assert.strictEqual(r.fields.status, "ready");
  assert.strictEqual(r.fields.topics.length, 3); assert.strictEqual(used(r), 1);
  assert.ok(r.fields.topics.every((t) => t.event && t.event.name));
});

test("local events: a stronger retry replaces the first answer; an unusable retry keeps the first", async () => {
  const first = [ev(1), ev(2), ev(3, false), ev(4, false), ev(5, false)];
  const better = [ev(1), ev(2), ev(3), ev(4), ev(5)];
  const r = await go([evAnswer(first, 1), evAnswer(better, 2)], evRow);
  assert.strictEqual(r.fields.topics.length, 5); assert.strictEqual(used(r), 2);
  const none = [ev(1, false), ev(2, false), ev(3, false), ev(4, false), ev(5, false)];
  const r2 = await go([evAnswer(first, 1), evAnswer(none, 2)], evRow);
  assert.strictEqual(r2.fields.status, "ready"); assert.strictEqual(r2.fields.topics.length, 2); assert.strictEqual(used(r2), 1);
});

test("local events: equal strength keeps the later answer; up to eight candidates still keep five", async () => {
  const a = [ev(1), ev(2), ev(3, false), ev(4, false), ev(5, false)];
  const r = await go([evAnswer(a, 1), evAnswer(a, 2)], evRow);
  assert.strictEqual(used(r), 2);
  const eight = [1, 2, 3, 4, 5, 6, 7, 8].map((i) => ev(i));
  const r8 = await go([evAnswer(eight, 1)], evRow);
  assert.strictEqual(r8.fields.topics.length, 5); assert.strictEqual(r8.attempts, 1);
});

test("strength: a failed validation has the lowest strength, and ties compare equal", () => {
  assert.deepStrictEqual(run.strengthOf({ ok: false, topics: [] }), [0, 0, 0, 0]);
  assert.strictEqual(run.compareStrength({ ok: false, topics: [] }, { ok: false, topics: [] }), 0);
  const t = (u) => ({ sources: [{ url: u }] });
  assert.ok(run.compareStrength({ ok: true, topics: [t("https://a.example/x")] }, { ok: false, topics: [] }) > 0);
  assert.ok(run.compareStrength({ ok: true, topics: [t("https://a.example/x")] }, { ok: true, topics: [t("https://a.example/x"), t("https://b.example/y")] }) < 0);
});
