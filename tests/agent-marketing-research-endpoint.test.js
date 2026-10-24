// End-to-end test of the research endpoint and worker with an in-memory fake database (no network).
const test = require("node:test");
const assert = require("node:assert");

const U1 = "11111111-1111-4111-8111-111111111111";
const U2 = "22222222-2222-4222-8222-222222222222";
let currentUser = U1;
let planCtx = { poolKind: "user" };
const db = { agent_marketing_projects: [], agent_marketing_research: [] };
let nextId = 1;
const uuid = (n) => `bbbbbbbb-bbbb-4bbb-8bbb-${String(n).padStart(12, "0")}`;

function fakeSupabase(method, table, body, qs = "") {
  const rows = db[table];
  assert.ok(rows, "unexpected table " + table);
  const q = new URLSearchParams(String(qs).replace(/^\?/, ""));
  const matches = (r) => {
    for (const [k, v] of q.entries()) {
      if (["select", "order", "limit"].includes(k)) continue;
      if (v.startsWith("eq.")) { if (String(r[k]) !== v.slice(3)) return false; }
      else if (v.startsWith("gte.")) { if (!r[k] || !(String(r[k]) >= v.slice(4))) return false; }
      else throw new Error("unsupported filter " + k + "=" + v);
    }
    return true;
  };
  if (method === "POST") { const row = { id: uuid(nextId++), created_at: new Date().toISOString(), updated_at: new Date().toISOString(), charged_at: null, ...body }; rows.push(row); return Promise.resolve({ status: 201, data: [row] }); }
  const found = rows.filter(matches);
  if (method === "GET") return Promise.resolve({ status: 200, data: found.slice().sort((a, b) => String(b.created_at).localeCompare(String(a.created_at))) });
  if (method === "PATCH") { found.forEach((r) => Object.assign(r, body)); return Promise.resolve({ status: 200, data: found }); }
  throw new Error("unexpected " + method);
}
const stub = (mod, exports) => { const p = require.resolve(mod); require.cache[p] = { id: p, filename: p, loaded: true, exports }; };
stub("../netlify/functions/lib/marketing-profile-lib", { supabase: fakeSupabase });
stub("../netlify/functions/lib/reel-auth-lib", { requireUser: async () => ({ user: { id: currentUser } }) });
stub("../netlify/functions/lib/reel-quota-lib", { getPlanContext: async () => planCtx });
const { handler } = require("../netlify/functions/agent-marketing-research");
const worker = require("../netlify/functions/agent-marketing-research-background");
const runLib = require("../netlify/functions/lib/agent-marketing-research-run-lib");

let fetched = [];
global.fetch = async (url, opts) => { fetched.push({ url, opts }); return { ok: true }; };
const call = async (method, body, qs) => {
  const res = await handler({ httpMethod: method, headers: { host: "x.test" }, body: body ? JSON.stringify(body) : null, queryStringParameters: qs || null });
  return { status: res.statusCode, json: JSON.parse(res.body) };
};
const mkProject = (over) => { const row = { id: uuid(nextId++), user_id: currentUser, template: "local_market_insider", status: "draft", intake: {}, ...over }; db.agent_marketing_projects.push(row); return row; };
const REQ = { mode: "market_update", audience: "sellers", geography: { type: "city", name: "Roseville" } };
const reset = () => { db.agent_marketing_projects.length = 0; db.agent_marketing_research.length = 0; fetched = []; currentUser = U1; planCtx = { poolKind: "user" }; process.env.AGENT_MARKETING_ENABLED = "true"; process.env.PERPLEXITY_API_KEY = "pplx-test"; process.env.INTERNAL_API_KEY = "internal"; process.env.URL = "https://site.test"; delete process.env.AGENT_MARKETING_RESEARCH_DEBUG; delete process.env.AGENT_MARKETING_RESEARCH_SESSIONS; };

test("switch off: every call answers 404", async () => {
  reset(); delete process.env.AGENT_MARKETING_ENABLED;
  assert.strictEqual((await call("GET", null, { projectId: uuid(1) })).status, 404);
  assert.strictEqual((await call("POST", { action: "start" })).status, 404);
});

test("schema: the page reads its choices from the server", async () => {
  reset();
  const r = await call("GET", null, { schema: "1" });
  assert.strictEqual(r.status, 200);
  assert.deepStrictEqual(r.json.modes.map((m) => m.key), ["market_update", "local_events"]);
  assert.deepStrictEqual(r.json.audiences.map((a) => a.key), ["buyers", "sellers", "both", "investors", "general"]);
  assert.deepStrictEqual(r.json.geoTypes.map((g) => g.key), ["neighborhood", "city", "zip", "county", "metro"]);
  assert.strictEqual(r.json.topicCount, 5);
});

test("start: validates, saves a running row, dispatches the worker with the internal key, and reports the session balance", async () => {
  reset();
  const p = mkProject();
  assert.strictEqual((await call("POST", { action: "start", projectId: p.id, request: { ...REQ, mode: "blog" } })).status, 400);
  assert.strictEqual(db.agent_marketing_research.length, 0);
  const r = await call("POST", { action: "start", projectId: p.id, request: REQ });
  assert.strictEqual(r.status, 202);
  assert.strictEqual(r.json.research.status, "running");
  assert.deepStrictEqual(r.json.session, { used: 0, allowance: 10, remaining: 10, canStart: true, shared: false, pool: "user" });
  assert.strictEqual(db.agent_marketing_research[0].pool_user_id, U1); // a Solo user is their own pool
  assert.strictEqual(db.agent_marketing_research.length, 1);
  assert.strictEqual(db.agent_marketing_research[0].charged_at, null); // nothing is charged at the start
  assert.strictEqual(fetched.length, 1);
  assert.match(fetched[0].url, /agent-marketing-research-background$/);
  assert.strictEqual(fetched[0].opts.headers["x-internal-key"], "internal");
  assert.ok(!JSON.stringify(r.json).includes("pplx-test"));
});

test("start: only the owner's local_market_insider project that can still be edited; missing key or dispatch failure never charges", async () => {
  reset();
  const other = mkProject({ user_id: U2 });
  assert.strictEqual((await call("POST", { action: "start", projectId: other.id, request: REQ })).status, 404);
  const wrong = mkProject({ template: "meet_your_agent" });
  assert.strictEqual((await call("POST", { action: "start", projectId: wrong.id, request: REQ })).status, 409);
  const done = mkProject({ status: "rendering" });
  assert.strictEqual((await call("POST", { action: "start", projectId: done.id, request: REQ })).status, 409);
  const ok = mkProject();
  delete process.env.PERPLEXITY_API_KEY;
  assert.strictEqual((await call("POST", { action: "start", projectId: ok.id, request: REQ })).status, 500);
  assert.strictEqual(db.agent_marketing_research.length, 0);
  process.env.PERPLEXITY_API_KEY = "pplx-test";
  global.fetch = async () => { throw new Error("network down"); };
  const bad = await call("POST", { action: "start", projectId: ok.id, request: REQ });
  assert.strictEqual(bad.status, 502);
  assert.strictEqual(db.agent_marketing_research[0].status, "failed");
  assert.strictEqual(db.agent_marketing_research[0].charged_at, null);
  global.fetch = async (url, opts) => { fetched.push({ url, opts }); return { ok: true }; };
});

test("start: one run at a time; a second request while one is running is refused", async () => {
  reset();
  const p = mkProject();
  assert.strictEqual((await call("POST", { action: "start", projectId: p.id, request: REQ })).status, 202);
  const again = await call("POST", { action: "start", projectId: p.id, request: { ...REQ, audience: "buyers" } });
  assert.strictEqual(again.status, 409);
  assert.strictEqual(db.agent_marketing_research.length, 1);
});

test("a run that never reported back is treated as failed, uncharged, after six minutes", async () => {
  reset();
  const p = mkProject();
  await call("POST", { action: "start", projectId: p.id, request: REQ });
  db.agent_marketing_research[0].created_at = new Date(Date.now() - 7 * 60 * 1000).toISOString();
  const g = await call("GET", null, { projectId: p.id });
  assert.strictEqual(g.json.research[0].status, "failed");
  assert.match(g.json.research[0].error, /did not use a session/);
  assert.strictEqual(db.agent_marketing_research[0].charged_at, null);
  assert.strictEqual(g.json.session.used, 0);
});

test("allowance: ten charged sessions this month stops a new run; failed runs do not count; Team members get 30", async () => {
  reset();
  const p = mkProject();
  const chargedNow = () => new Date().toISOString();
  for (let i = 0; i < 9; i++) db.agent_marketing_research.push({ id: uuid(nextId++), user_id: U1, pool_user_id: U1, project_id: p.id, status: "ready", charged_at: chargedNow(), created_at: chargedNow() });
  db.agent_marketing_research.push({ id: uuid(nextId++), user_id: U1, pool_user_id: U1, project_id: p.id, status: "failed", charged_at: null, created_at: chargedNow() });
  const nine = await call("POST", { action: "start", projectId: p.id, request: REQ });
  assert.strictEqual(nine.status, 202);
  assert.strictEqual(nine.json.session.used, 9);
  db.agent_marketing_research.find((r) => r.status === "running").status = "failed";
  db.agent_marketing_research.push({ id: uuid(nextId++), user_id: U1, pool_user_id: U1, project_id: p.id, status: "ready", charged_at: chargedNow(), created_at: chargedNow() });
  const none = await call("POST", { action: "start", projectId: p.id, request: { ...REQ, audience: "buyers" } });
  assert.strictEqual(none.status, 429);
  assert.strictEqual(none.json.session.remaining, 0);
  planCtx = { poolKind: "team", poolUserId: U1 };
  assert.strictEqual((await call("POST", { action: "start", projectId: p.id, request: { ...REQ, audience: "investors" } })).status, 202);
});

test("shared pools: a team's 30 and a brokerage's 100 are drawn down by every member; Solo users are unaffected", async () => {
  reset();
  const LEAD = "33333333-3333-4333-8333-333333333333";
  const now = () => new Date().toISOString();
  const seed = (n, pool, by) => { for (let i = 0; i < n; i++) db.agent_marketing_research.push({ id: uuid(nextId++), user_id: by, pool_user_id: pool, project_id: uuid(999), status: "ready", charged_at: now(), created_at: now() }); };
  // 29 of the team's 30 were used by the lead and a teammate; U1 is another member of the same team
  seed(20, LEAD, LEAD); seed(9, LEAD, U2);
  planCtx = { poolKind: "team", poolUserId: LEAD };
  const p = mkProject();
  const first = await call("POST", { action: "start", projectId: p.id, request: REQ });
  assert.strictEqual(first.status, 202);
  assert.deepStrictEqual(first.json.session, { used: 29, allowance: 30, remaining: 1, canStart: true, shared: true, pool: "team" });
  assert.strictEqual(db.agent_marketing_research.find((r) => r.status === "running").pool_user_id, LEAD);
  // the 30th session is charged (as the worker would) and the next member is stopped, with a message that names the team
  const run = db.agent_marketing_research.find((r) => r.status === "running");
  Object.assign(run, { status: "ready", charged_at: now() });
  const stopped = await call("POST", { action: "start", projectId: p.id, request: { ...REQ, audience: "buyers" } });
  assert.strictEqual(stopped.status, 429);
  assert.match(stopped.json.error, /Your team has used all 30/);
  assert.strictEqual(stopped.json.session.remaining, 0);
  // the same on the GET the page reads
  assert.strictEqual((await call("GET", null, { projectId: p.id })).json.session.pool, "team");
  // brokerage members draw on 100
  planCtx = { poolKind: "brokerage", poolUserId: LEAD };
  const b = await call("GET", null, { projectId: p.id });
  assert.strictEqual(b.json.session.allowance, 100);
  assert.strictEqual(b.json.session.used, 30);
  // a Solo user's own sessions are separate from the team's pool
  planCtx = { poolKind: "user" };
  const solo = await call("GET", null, { projectId: p.id });
  assert.deepStrictEqual(solo.json.session, { used: 0, allowance: 10, remaining: 10, canStart: true, shared: false, pool: "user" });
  // a plan lookup failure falls back to the user's own Solo pool rather than blocking or over-granting
  stub("../netlify/functions/lib/reel-quota-lib", { getPlanContext: async () => { throw new Error("db down"); } });
  delete require.cache[require.resolve("../netlify/functions/agent-marketing-research")];
  const h2 = require("../netlify/functions/agent-marketing-research").handler;
  const res = await h2({ httpMethod: "GET", headers: {}, queryStringParameters: { projectId: p.id } });
  assert.strictEqual(JSON.parse(res.body).session.pool, "user");
  stub("../netlify/functions/lib/reel-quota-lib", { getPlanContext: async () => planCtx });
});

test("worker: five grounded topics are saved and charged once; the page then reads them with no new session", async () => {
  reset();
  const p = mkProject();
  const started = await call("POST", { action: "start", projectId: p.id, request: REQ });
  const id = started.json.research.id;
  const Q = ["Why are some Roseville homes taking longer to sell?", "Does spring bring more competing listings to Roseville?", "How are builder incentives changing resale pricing near new communities?", "What are mortgage rate buydowns doing to buyer budgets?", "Which price bands are seeing the most pending sales this month?"];
  const today = runLib.todayPT();
  const dayAgo = new Date(Date.now() - 4 * 86400000).toISOString().slice(0, 10);
  const url = (n) => `https://example.org/report-${n}`;
  const topics = Q.map((q, i) => ({ question: q, why_it_matters: "It changes how sellers price.", trend_signals: ["MLS active listings up"], local_intent: true, scope: "selected", event: null, sources: [{ title: `R${i}`, url: url(i), published: dayAgo }] }));
  const original = runLib.callPerplexity;
  runLib.callPerplexity = async () => ({ status: 200, json: { choices: [{ message: { content: JSON.stringify({ topics }) } }], citations: Q.map((_, i) => url(i)), usage: { prompt_tokens: 600, completion_tokens: 1500 } } });
  try {
    const w = await worker.handler({ headers: { "x-internal-key": "internal" }, body: JSON.stringify({ researchId: id, owner: U1 }) });
    assert.strictEqual(w.statusCode, 200);
    const again = await worker.handler({ headers: { "x-internal-key": "internal" }, body: JSON.stringify({ researchId: id, owner: U1 }) });
    assert.strictEqual(again.statusCode, 200); // duplicate dispatch does nothing
  } finally { runLib.callPerplexity = original; }
  const row = db.agent_marketing_research[0];
  assert.strictEqual(row.status, "ready");
  assert.strictEqual(row.topics.length, 5);
  assert.ok(row.charged_at);
  assert.strictEqual(row.research_date, today);
  const g = await call("GET", null, { projectId: p.id });
  assert.strictEqual(g.json.research[0].topics.length, 5);
  assert.strictEqual(g.json.session.used, 1);
  assert.strictEqual(g.json.research[0].usage, undefined); // cost is hidden from subscribers
  process.env.AGENT_MARKETING_RESEARCH_DEBUG = "true";
  assert.strictEqual((await call("GET", null, { id })).json.research.usage.costUsd, 0.0243);
  delete process.env.AGENT_MARKETING_RESEARCH_DEBUG;
  // the same request on the same project reuses the saved set: no new row, no dispatch, no session
  fetched = [];
  const reuse = await call("POST", { action: "start", projectId: p.id, request: REQ });
  assert.strictEqual(reuse.status, 200);
  assert.strictEqual(reuse.json.reused, true);
  assert.strictEqual(db.agent_marketing_research.length, 1);
  assert.strictEqual(fetched.length, 0);
  assert.strictEqual(reuse.json.session.used, 1);
  // "New Topics" is the way to buy another set
  assert.strictEqual((await call("POST", { action: "start", projectId: p.id, request: REQ, newTopics: true })).status, 202);
  // a failed result is never charged
  db.agent_marketing_research[1].status = "running";
  const dead = runLib.callPerplexity;
  runLib.callPerplexity = async () => ({ status: 500, json: {} });
  try { await worker.handler({ headers: { "x-internal-key": "internal" }, body: JSON.stringify({ researchId: db.agent_marketing_research[1].id, owner: U1 }) }); } finally { runLib.callPerplexity = dead; }
  assert.strictEqual(db.agent_marketing_research[1].status, "failed");
  assert.strictEqual(db.agent_marketing_research[1].charged_at, null);
});

test("worker: wrong key, bad ids, other users and a missing provider key are handled", async () => {
  reset();
  const p = mkProject();
  const started = await call("POST", { action: "start", projectId: p.id, request: REQ });
  const id = started.json.research.id;
  assert.strictEqual((await worker.handler({ headers: { "x-internal-key": "nope" }, body: "{}" })).statusCode, 401);
  assert.strictEqual((await worker.handler({ headers: { "x-internal-key": "internal" }, body: JSON.stringify({ researchId: "x", owner: U1 }) })).statusCode, 400);
  assert.strictEqual((await worker.handler({ headers: { "x-internal-key": "internal" }, body: JSON.stringify({ researchId: id, owner: U2 }) })).statusCode, 404);
  delete process.env.PERPLEXITY_API_KEY;
  await worker.handler({ headers: { "x-internal-key": "internal" }, body: JSON.stringify({ researchId: id, owner: U1 }) });
  assert.strictEqual(db.agent_marketing_research[0].status, "failed");
  assert.strictEqual(db.agent_marketing_research[0].charged_at, null);
});

test("select: freezes the chosen topic and its sources on the project; only from a ready set the owner has", async () => {
  reset();
  const p = mkProject();
  const topics = [1, 2, 3, 4, 5].map((n) => ({ id: `t${n}`, kind: "market_update", question: `Q${n}`, sources: [{ title: "S", url: "https://example.org/a", published: "2026-10-20" }] }));
  const ready = { id: uuid(nextId++), project_id: p.id, user_id: U1, mode: "market_update", audience: "sellers", geography: { label: "Roseville, CA" }, focus: {}, status: "ready", topics, research_date: "2026-10-24", charged_at: "2026-10-24T17:00:00Z", created_at: "2026-10-24T17:00:00Z" };
  db.agent_marketing_research.push(ready);
  const ok = await call("POST", { action: "select", projectId: p.id, researchId: ready.id, topicId: "t3" });
  assert.strictEqual(ok.status, 200);
  assert.strictEqual(p.selected_research_id, ready.id);
  assert.strictEqual(p.selected_topic.question, "Q3");
  assert.strictEqual(p.selected_topic.researchDate, "2026-10-24");
  assert.strictEqual(p.selected_topic.geography.label, "Roseville, CA");
  assert.strictEqual(p.selected_topic.sources[0].url, "https://example.org/a");
  assert.strictEqual((await call("POST", { action: "select", projectId: p.id, researchId: ready.id, topicId: "t9" })).status, 400);
  const running = { ...ready, id: uuid(nextId++), status: "running", topics: null };
  db.agent_marketing_research.push(running);
  assert.strictEqual((await call("POST", { action: "select", projectId: p.id, researchId: running.id, topicId: "t1" })).status, 404);
  const g = await call("GET", null, { projectId: p.id });
  assert.strictEqual(g.json.selectedResearchId, ready.id);
  assert.strictEqual(g.json.selectedTopic.id, "t3");
  currentUser = U2;
  assert.strictEqual((await call("POST", { action: "select", projectId: p.id, researchId: ready.id, topicId: "t1" })).status, 404);
});
