// Run with: npm test
// Request accounting at the quota boundary. The harness mirrors the background function's wiring exactly: quotaFn reads this user's rows and calls requestAllowance(rows, now, env, ownId, dispatched);
// onDispatch persists the running row's count before each dispatch. Everything else is the real runResearch and the real article-led lib.
const test = require("node:test");
const assert = require("node:assert");
const run = require("../netlify/functions/lib/agent-marketing-research-run-lib");
const al = require("../netlify/functions/lib/agent-marketing-article-led-lib");
const fx = require("./fixtures/research-diag/scenarios");

const HOUR = 3600e3, DAY = 24 * HOUR;
const Q = ["Could Parkwood's 122 homes change what Lincoln sellers face?", "Why did the city approve a second apartment site this fall?", "What do higher fees mean for move-up buyers here?", "Is a new school calendar shifting when listings go live?", "Are pending sales slowing for new construction?"];
const DEV = ["Orchard agreement", "Meadow apartment site", "Fee schedule change", "School calendar change", "Pending sales slowdown"];
const src = (i) => ({ title: `Lincoln story ${i}`, url: `https://news${i}.example/lincoln-story-${i}`, published: "2026-10-28", role: "secondary", kind: "local_news", source_geography: "Lincoln, CA", reporting_period: "October 2026", used_for: "context" });
const cand = (i) => ({ question: Q[i - 1], development: DEV[i - 1], angle: `Angle ${DEV[i - 1].split(" ")[0]}`, why: "It changes what nearby sellers compete with.", relationship: "market", route: null, strength: "high", relevance: "direct",
  status: "unverified", status_source: null, status_checked_date: null, status_by_source: [], conflict: null, gap: "Phasing is not stated.", access_confidence: "medium", keyword_match: false, sources: [src(i)] });
const reply = (cs) => ({ status: 200, json: { output: [{ type: "search_results", results: cs.flatMap((c) => c.sources.map((s) => ({ url: s.url }))) }, { type: "message", content: [{ type: "output_text", text: "```json\n" + JSON.stringify({ research_lane: "x", candidates: cs }) + "\n```" }] }] } });
const laneOf = (p) => (/Lane: Municipal/.test(p.input) ? "municipal" : /Lane: Housing/.test(p.input) ? "housing" : "single");
const quiet = async (fn) => { const e = console.error; console.error = () => {}; try { return await fn(); } finally { console.error = e; } };
const ENV = { AGENT_MARKETING_ARTICLE_LED_ENABLED: "true" };            // the approved default: Municipal + Housing, sequential

// Other finished Article-Led sessions for this user: `reqs` provider requests spread over sessions of 2, all inside `ageMs`.
const priorRows = (reqs, ageMs, charged) => { const rows = []; let left = reqs, i = 0; while (left > 0) { const n = Math.min(2, left); left -= n; rows.push({ id: `p${i}`, created_at: new Date(Date.now() - ageMs - i * 1000).toISOString(), status: "ready", charged_at: charged ? "x" : null, pathway: "article_led", attempts: "1", providerRequests: String(n), withdrawn: null }); i++; } return rows; };

async function boundary({ prior, script, env, readFails }) {
  const own = { id: "me", created_at: new Date().toISOString(), status: "running", charged_at: null, pathway: "article_led", attempts: null, providerRequests: null, withdrawn: null };
  const rows = prior.concat([own]);
  const quotaFn = async (dispatched) => (readFails ? { allowed: false, scope: "unverifiable", used: null, limit: null } : al.requestAllowance(rows.map((r) => ({ ...r })), Date.now(), env || ENV, "me", dispatched));
  const persisted = [];
  const onDispatch = async (n) => { own.providerRequests = String(n); persisted.push(n); };
  const sent = []; const n = {};
  const callFn = async (p) => { const lane = laneOf(p); n[lane] = (n[lane] || 0) + 1; sent.push(lane); const a = script(lane, n[lane]); if (a instanceof Error) throw a; return a; };
  const r = await quiet(() => run.runResearch({ row: { id: "me", mode: "market_update", audience: "sellers", geography: fx.GEO.lincoln, focus: {}, upload_refs: [], data_source: "web" }, apiKey: "k", now: "2026-10-31T20:00:00Z", env: env || ENV, sleepFn: async () => {}, clock: () => 0, rand: () => 0.5, callFn, quotaFn, onDispatch }));
  const f = r.fields, d = f.usage.discovery && f.usage.discovery.lanes;
  const total = (extra) => priorTotal(prior) + (f.usage.providerRequests || 0) + (extra || 0);
  return { f, sent, persisted, lanes: d, providerRequests: f.usage.providerRequests, charged: !!f.charged_at || f.usage.charged === true, finalDay: total(), status: f.status };
}
const priorTotal = (rows) => rows.reduce((s, r) => s + Number(r.providerRequests), 0);
const OK = (lane, n) => (lane === "municipal" ? reply([cand(1), cand(2), cand(3)]) : reply([cand(4), cand(5)]));
const stateOf = (b, lane) => (b.lanes.find((l) => l.lane === lane) || {}).state;

test("boundary: admission accepts 14/15 and refuses 15/15 (needs one request of headroom)", () => {
  const adm = (reqs) => al.admit(priorRows(reqs, HOUR, true), null, Date.now(), ENV, 360000);
  assert.strictEqual(adm(14).blocked, false); assert.strictEqual(adm(15).blocked, true); assert.strictEqual(adm(15).code, "provider_request_limit");
  const mon = (reqs) => al.admit(priorRows(reqs, 3 * DAY, true), null, Date.now(), ENV, 360000);
  assert.strictEqual(mon(99).blocked, false); assert.strictEqual(mon(100).blocked, true); assert.strictEqual(mon(100).scope, "monthly");
  assert.strictEqual(adm(0).blocked, false);
});

test("boundary: a session that begins at 14/15 sends exactly one request, then stops; the day total is 15, never 16", async () => {
  const b = await boundary({ prior: priorRows(14, HOUR), script: OK });
  assert.deepStrictEqual(b.sent, ["municipal"]);
  assert.strictEqual(b.providerRequests, 1); assert.deepStrictEqual(b.persisted, [1]);
  assert.strictEqual(stateOf(b, "municipal"), "success"); assert.strictEqual(stateOf(b, "housing"), "not_attempted");
  assert.strictEqual(b.finalDay, 15);
  assert.ok(b.f.status !== "failed", "the municipal lane's result is kept as a partial result"); assert.ok(!b.f.charged_at, "three opportunities: uncharged partial");
});

test("boundary: at 14/15 a 429 on the only permitted request is NOT retried: one request, rate_limited, nothing charged", async () => {
  const b = await boundary({ prior: priorRows(14, HOUR), script: () => ({ status: 429, json: {}, headers: { "retry-after": "1" } }) });
  assert.strictEqual(b.sent.length, 1); assert.strictEqual(b.providerRequests, 1); assert.strictEqual(b.finalDay, 15);
  assert.strictEqual(b.status, "failed"); assert.ok(!b.f.charged_at);
});

test("boundary: at 14/15 a failed (HTTP 500) request still counts; no retry beyond the limit", async () => {
  const b = await boundary({ prior: priorRows(14, HOUR), script: () => ({ status: 500, json: {} }) });
  assert.strictEqual(b.sent.length, 1); assert.strictEqual(b.providerRequests, 1); assert.strictEqual(b.finalDay, 15); assert.strictEqual(b.status, "failed");
});

test("boundary: at 14/15 a thrown network error counts as a dispatched request and is not retried past the limit", async () => {
  const b = await boundary({ prior: priorRows(14, HOUR), script: () => new Error("socket hang up") });
  assert.strictEqual(b.sent.length, 1); assert.strictEqual(b.providerRequests, 1); assert.strictEqual(b.finalDay, 15);
});

test("boundary: at 15/15 the first request is refused: nothing sent, nothing counted, 'did not use a session'", async () => {
  const b = await boundary({ prior: priorRows(15, HOUR), script: OK });
  assert.strictEqual(b.sent.length, 0); assert.strictEqual(b.providerRequests, 0); assert.strictEqual(b.status, "failed");
  assert.ok(/did not use a session|limit/i.test(b.f.error || JSON.stringify(b.f.usage)), "the user is told it was a limit");
  assert.ok(!b.f.charged_at);
});

test("boundary: at 13/15 a 429 retry fits (13 → 14 → 15) and the second lane is then refused; total 15", async () => {
  let first = true;
  const b = await boundary({ prior: priorRows(13, HOUR), script: (lane, n) => (lane === "municipal" && n === 1 ? { status: 429, json: {}, headers: { "retry-after": "1" } } : OK(lane, n)) });
  assert.deepStrictEqual(b.sent, ["municipal", "municipal"]); assert.strictEqual(b.providerRequests, 2); assert.deepStrictEqual(b.persisted, [1, 2]);
  assert.strictEqual(stateOf(b, "municipal"), "success"); assert.strictEqual(stateOf(b, "housing"), "not_attempted"); assert.strictEqual(b.finalDay, 15);
});

test("boundary: at 12/15 both lanes run (12 → 13 → 14); a partial result (fewer than five) is uncharged", async () => {
  const b = await boundary({ prior: priorRows(12, HOUR), script: (lane) => (lane === "municipal" ? reply([cand(1), cand(2)]) : reply([cand(3)])) });
  assert.deepStrictEqual(b.sent, ["municipal", "housing"]); assert.strictEqual(b.providerRequests, 2); assert.strictEqual(b.finalDay, 14);
  assert.ok(!b.f.charged_at); assert.strictEqual(b.f.status, "ready");
});

test("boundary: at 12/15 with five distinct opportunities the session is charged once and still ends at 14", async () => {
  const b = await boundary({ prior: priorRows(12, HOUR), script: OK });
  assert.strictEqual(b.providerRequests, 2); assert.strictEqual(b.finalDay, 14);
  assert.ok(b.f.charged_at, "five distinct opportunities: one charged session"); assert.strictEqual(b.f.topics.length, 5);
});

test("boundary: the 30-day limit binds the same way (99/100) and old rows roll out of the window", async () => {
  const month = await boundary({ prior: priorRows(99, 3 * DAY), script: OK });
  assert.strictEqual(month.sent.length, 1); assert.strictEqual(month.providerRequests, 1);
  const old = await boundary({ prior: priorRows(40, 31 * DAY), script: OK });
  assert.strictEqual(old.sent.length, 2, "requests older than 30 days do not count");
  const dayRoll = await boundary({ prior: priorRows(14, 25 * HOUR), script: OK });
  assert.strictEqual(dayRoll.sent.length, 2, "requests older than 24 hours do not count against the daily limit");
});

test("boundary: the check fails closed: if this user's rows cannot be read, no request is sent", async () => {
  const b = await boundary({ prior: [], script: OK, readFails: true });
  assert.strictEqual(b.sent.length, 0); assert.strictEqual(b.providerRequests, 0); assert.strictEqual(b.status, "failed");
});

test("boundary: a crashed session leaves its true count: the persisted count is written BEFORE each dispatch", async () => {
  const own = { id: "me", status: "running" }; const order = [];
  const callFn = async () => { order.push("call"); return reply([cand(1)]); };
  await quiet(() => run.runResearch({ row: { id: "me", mode: "market_update", audience: "sellers", geography: fx.GEO.lincoln, focus: {}, upload_refs: [], data_source: "web" }, apiKey: "k", now: "2026-10-31T20:00:00Z", env: ENV, sleepFn: async () => {}, clock: () => 0, rand: () => 0.5, callFn, onDispatch: async (n) => { order.push("persist" + n); } }));
  assert.deepStrictEqual(order, ["persist1", "call", "persist2", "call"]);
  // and a running row is counted at no less than its persisted count by every other session's check
  const running = { id: "x", created_at: new Date(Date.now() - 60000).toISOString(), status: "running", pathway: "article_led", providerRequests: "2", withdrawn: null };
  assert.strictEqual(al.requestsOf(running), 2); assert.strictEqual(al.requestsOf({ ...running, providerRequests: null }), 1);
});

test("boundary: a sequential session can never exceed a limit; a full sweep of starting points 0..15 ends at most at 15", async () => {
  for (let start = 0; start <= 15; start++) {
    for (const script of [OK, () => ({ status: 500, json: {} }), () => ({ status: 429, json: {}, headers: { "retry-after": "1" } })]) {
      const b = await boundary({ prior: priorRows(start, HOUR), script });
      assert.ok(b.finalDay <= 15, `start ${start}: ended at ${b.finalDay}`);
      assert.strictEqual(b.providerRequests, b.sent.length, `start ${start}: every dispatched request counted once`);
    }
  }
});

test("boundary: a re-executed worker resumes from the persisted count, so a crashed execution's requests still count (13 others + 1 already sent = 14/15)", async () => {
  const prior = priorRows(13, HOUR);
  const own = { id: "me", created_at: new Date().toISOString(), status: "running", pathway: "article_led", attempts: null, providerRequests: "1", withdrawn: null };
  const rows = prior.concat([own]); const persisted = [];
  const quotaFn = async (d) => al.requestAllowance(rows.map((r) => ({ ...r })), Date.now(), ENV, "me", d);
  const onDispatch = async (n) => { own.providerRequests = String(n); persisted.push(n); };
  const sent = [];
  const r = await quiet(() => run.runResearch({ row: { id: "me", mode: "market_update", audience: "sellers", geography: fx.GEO.lincoln, focus: {}, upload_refs: [], data_source: "web" }, apiKey: "k", now: "2026-10-31T20:00:00Z", env: ENV, sleepFn: async () => {}, clock: () => 0, rand: () => 0.5,
    callFn: async (p) => { sent.push(laneOf(p)); return OK(laneOf(p)); }, quotaFn, onDispatch, startingRequests: 1 }));
  assert.deepStrictEqual(sent, ["municipal"], "only the one request that still fits");
  assert.deepStrictEqual(persisted, [2], "the count continues from 1; it is never written back lower");
  assert.strictEqual(r.fields.usage.providerRequests, 2);
  assert.strictEqual(priorTotal(prior) + Number(own.providerRequests), 15);
});
