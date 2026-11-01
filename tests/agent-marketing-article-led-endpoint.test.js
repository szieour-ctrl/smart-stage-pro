// End-to-end test of the Article-Led limits and client fields on the research endpoint, with an in-memory fake database (no network). PR 2.
const test = require("node:test");
const assert = require("node:assert");

const U1 = "11111111-1111-4111-8111-111111111111";
const U2 = "22222222-2222-4222-8222-222222222222";
let currentUser = U1;
let planCtx = { poolKind: "user" };
const db = { agent_marketing_projects: [], agent_marketing_research: [] };
let nextId = 1;
const hooks = { beforeInsert: null };   // lets a test run another request between this one's admission check and its insert
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
  if (method === "POST" && table === "agent_marketing_research" && hooks.beforeInsert) { hooks.beforeInsert(rows); hooks.beforeInsert = null; }
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
const REQ = { mode: "market_update", audience: "sellers", geography: { zip: "95678", type: "city", name: "Roseville" } };
const reset = () => { db.agent_marketing_projects.length = 0; db.agent_marketing_research.length = 0; fetched = []; currentUser = U1; planCtx = { poolKind: "user" }; process.env.AGENT_MARKETING_ENABLED = "true"; process.env.PERPLEXITY_API_KEY = "pplx-test"; process.env.INTERNAL_API_KEY = "internal"; process.env.URL = "https://site.test"; delete process.env.AGENT_MARKETING_RESEARCH_DEBUG; delete process.env.AGENT_MARKETING_RESEARCH_SESSIONS; };


const al = require("../netlify/functions/lib/agent-marketing-article-led-lib");
const HOUR = 3600 * 1000;
const iso = (agoMs) => new Date(Date.now() - agoMs).toISOString();
const partialRow = (agoMs, over) => { db.agent_marketing_research.push({ id: uuid(nextId++), user_id: currentUser, project_id: uuid(1), mode: "market_update", status: "ready", charged_at: null, created_at: iso(agoMs), updated_at: iso(agoMs), topics: [], usage: { pathway: "article_led", articleLed: { delivered: 3, charged: false, offerMlsTrend: true } }, ...(over || {}) }); };
const ON = () => { process.env.AGENT_MARKETING_ARTICLE_LED_ENABLED = "true"; };
const cleanEnv = () => { delete process.env.AGENT_MARKETING_ARTICLE_LED_ENABLED; delete process.env.AGENT_MARKETING_PARTIAL_DAILY_LIMIT; delete process.env.AGENT_MARKETING_PARTIAL_MONTHLY_LIMIT; delete process.env.AGENT_MARKETING_REQUEST_DAILY_LIMIT; delete process.env.AGENT_MARKETING_REQUEST_MONTHLY_LIMIT; };

test("schema tells the page whether the Article-Led pathway is on", async () => {
  reset(); cleanEnv();
  assert.strictEqual((await call("GET", null, { schema: "1" })).json.articleLed, false);
  ON();
  assert.strictEqual((await call("GET", null, { schema: "1" })).json.articleLed, true);
  cleanEnv();
});

test("partial limit: five uncharged partial sessions in 24 hours block the sixth, on the server, with the MLS Market Trend option named", async () => {
  reset(); ON();
  const p = mkProject();
  for (let i = 0; i < 4; i++) partialRow((i + 1) * HOUR);
  const ok = await call("POST", { action: "start", projectId: p.id, request: REQ });
  assert.strictEqual(ok.status, 202);
  db.agent_marketing_research.splice(db.agent_marketing_research.findIndex((r) => r.status === "running"), 1);
  partialRow(5 * HOUR);
  const blocked = await call("POST", { action: "start", projectId: p.id, request: { ...REQ, audience: "buyers" } });
  assert.strictEqual(blocked.status, 429);
  assert.strictEqual(blocked.json.code, "partial_limit"); assert.strictEqual(blocked.json.scope, "daily"); assert.strictEqual(blocked.json.mlsTrendAvailable, true);
  assert.ok(/limit of 5 incomplete research results in 24 hours/.test(blocked.json.error) && /MLS Market Trend Reel/.test(blocked.json.error));
  assert.strictEqual(db.agent_marketing_research.filter((r) => r.status === "running").length, 0, "nothing was started or dispatched");
  cleanEnv();
});

test("partial limit: only this user's partial Article-Led sets in the window count; charged, failed, legacy and old sets do not", async () => {
  reset(); ON();
  const p = mkProject();
  for (let i = 0; i < 5; i++) partialRow(i * HOUR + 1000, { user_id: U2 });                                   // someone else's
  for (let i = 0; i < 3; i++) partialRow((i + 1) * HOUR, { charged_at: iso(HOUR) });                          // charged (a full set)
  partialRow(HOUR, { status: "failed" });                                                                      // failed
  partialRow(2 * HOUR, { usage: { reportNote: "legacy partial" } });                                           // legacy research
  partialRow(26 * HOUR); partialRow(30 * HOUR);                                                                // outside 24 hours
  const r = await call("POST", { action: "start", projectId: p.id, request: REQ });
  assert.strictEqual(r.status, 202);
  cleanEnv();
});

test("partial limit: the monthly protection limit applies on its own and is configurable; flag off means no limit at all", async () => {
  reset(); ON(); process.env.AGENT_MARKETING_PARTIAL_MONTHLY_LIMIT = "3";
  const p = mkProject();
  for (let i = 0; i < 3; i++) partialRow((30 + i * 24) * HOUR);                                                // 3 older than a day, within 30 days
  const m = await call("POST", { action: "start", projectId: p.id, request: REQ });
  assert.strictEqual(m.status, 429); assert.strictEqual(m.json.scope, "monthly"); assert.ok(/this month's limit of 3/.test(m.json.error));
  cleanEnv();                                                                                                  // flag off: the same rows block nothing
  const off = await call("POST", { action: "start", projectId: p.id, request: REQ });
  assert.strictEqual(off.status, 202);
  cleanEnv();
});

test("partial limit: report-only and Local Events requests are not Article-Led and are never limited by it", () => {
  const rows = Array.from({ length: 9 }, (_, i) => ({ created_at: iso(i * HOUR), charged_at: null, status: "ready", pathway: "article_led" }));
  assert.strictEqual(al.partialLimit(rows, Date.now(), {}).blocked, true);
  assert.strictEqual(al.isArticleLed({ mode: "market_update", dataSource: "upload" }, { AGENT_MARKETING_ARTICLE_LED_ENABLED: "true" }), false);
  assert.strictEqual(al.isArticleLed({ mode: "local_events", dataSource: "web" }, { AGENT_MARKETING_ARTICLE_LED_ENABLED: "true" }), false);
  assert.deepStrictEqual(al.partialLimits({}), { daily: 5, monthly: 30 });
  assert.deepStrictEqual(al.partialLimits({ AGENT_MARKETING_PARTIAL_DAILY_LIMIT: "9", AGENT_MARKETING_PARTIAL_MONTHLY_LIMIT: "x" }), { daily: 9, monthly: 30 });
});

test("the client gets the number delivered, the limitation and the MLS Market Trend offer for an Article-Led set; a legacy set is unchanged", async () => {
  reset(); cleanEnv();
  const row = { id: uuid(nextId++), user_id: currentUser, project_id: uuid(1), mode: "market_update", audience: "sellers", geography: REQ.geography, status: "ready", charged_at: null, created_at: iso(HOUR), research_date: "2026-10-31",
    topics: [{ id: "t1" }, { id: "t2" }, { id: "t3" }], usage: { pathway: "article_led", reportNote: "Only 3 of 5 ...", articleLed: { delivered: 3, charged: false, offerMlsTrend: true, limits: { returned: 3, reason: "Few sources covered this community." } } } };
  db.agent_marketing_research.push(row);
  const a = await call("GET", null, { id: row.id });
  assert.deepStrictEqual([a.json.research.pathway, a.json.research.delivered, a.json.research.limitation, a.json.research.offerMlsTrend, a.json.research.charged], ["article_led", 3, "Few sources covered this community.", true, false]);
  assert.strictEqual(a.json.research.note, "Only 3 of 5 ...");
  const legacy = { ...row, id: uuid(nextId++), usage: { reportNote: "x" }, charged_at: iso(HOUR) };
  db.agent_marketing_research.push(legacy);
  const l = await call("GET", null, { id: legacy.id });
  assert.ok(!("pathway" in l.json.research) && !("delivered" in l.json.research) && l.json.research.charged === true);
});


// ── Provider-request limit and concurrency (PR 2 review, finding 4) ─────────────────────────────────────────
const alRow = (agoMs, over) => { db.agent_marketing_research.push({ id: uuid(nextId++), user_id: currentUser, project_id: uuid(1), mode: "market_update", status: "failed", charged_at: null, created_at: iso(agoMs), updated_at: iso(agoMs), topics: null, usage: { pathway: "article_led", attempts: 1 }, ...(over || {}) }); };
const startReq = (p, over) => call("POST", { action: "start", projectId: p.id, request: { ...REQ, ...(over || {}) } });

test("provider requests: failed, charged, partial and running Article-Led runs ALL count toward a separate limit (15 per 24 hours by default)", async () => {
  reset(); ON();
  const p = mkProject();
  for (let i = 0; i < 4; i++) alRow((i + 1) * HOUR);                                                   // failed
  for (let i = 0; i < 4; i++) alRow((i + 1) * HOUR, { status: "ready", charged_at: iso(HOUR) });        // charged
  for (let i = 0; i < 3; i++) alRow((i + 1) * HOUR, { status: "ready" });                               // partial
  for (let i = 0; i < 3; i++) alRow((i + 1) * HOUR, { status: "failed", usage: { pathway: "article_led", attempts: 1 } });
  assert.strictEqual(db.agent_marketing_research.length, 14);
  assert.strictEqual((await startReq(p)).status, 202, "14 earlier requests leave room for the 15th");
  db.agent_marketing_research.splice(db.agent_marketing_research.findIndex((r) => r.status === "running"), 1);
  alRow(2 * HOUR);                                                                                       // now 15
  const r = await startReq(p, { audience: "buyers" });
  assert.strictEqual(r.status, 429);
  assert.deepStrictEqual([r.json.code, r.json.scope], ["provider_request_limit", "daily"]);
  assert.ok(/limit of 15 research requests in 24 hours/.test(r.json.error));
  assert.strictEqual(db.agent_marketing_research.filter((x) => x.status === "running").length, 0, "nothing was started or dispatched");
  cleanEnv();
});

test("provider requests: a finished run counts the requests it made (its retry too); a running one counts one; withdrawn, old, other users' and legacy rows do not", async () => {
  reset(); ON();
  const p = mkProject();
  for (let i = 0; i < 7; i++) alRow((i + 1) * HOUR, { usage: { pathway: "article_led", attempts: 2 } });       // 14 requests
  alRow(9 * HOUR, { usage: { pathway: "article_led", withdrawn: true } });                                     // withdrawn: not counted
  alRow(30 * HOUR); alRow(40 * HOUR);                                                                          // older than 24 hours
  alRow(HOUR, { user_id: U2 }); alRow(HOUR, { usage: { reportNote: "legacy" } });                              // someone else's, and legacy research
  assert.strictEqual((await startReq(p)).status, 202);                                                         // 14 + this one = 15
  db.agent_marketing_research.splice(db.agent_marketing_research.findIndex((r) => r.status === "running"), 1);
  alRow(2 * HOUR, { usage: { pathway: "article_led", attempts: 2 } });                                         // 16 requests
  const r = await startReq(p, { audience: "buyers" });
  assert.strictEqual(r.status, 429); assert.strictEqual(r.json.code, "provider_request_limit");
  cleanEnv();
});

test("provider requests: the monthly request limit and the settings are separate from the partial limits; flag off means no limit", async () => {
  reset(); ON(); process.env.AGENT_MARKETING_REQUEST_MONTHLY_LIMIT = "4";
  const p = mkProject();
  for (let i = 0; i < 4; i++) alRow((30 + i * 24) * HOUR);
  const m = await startReq(p);
  assert.deepStrictEqual([m.status, m.json.code, m.json.scope], [429, "provider_request_limit", "monthly"]);
  assert.deepStrictEqual(al.requestLimits({}), { daily: 15, monthly: 100 });
  assert.deepStrictEqual(al.requestLimits({ AGENT_MARKETING_REQUEST_DAILY_LIMIT: "7", AGENT_MARKETING_REQUEST_MONTHLY_LIMIT: "x" }), { daily: 7, monthly: 100 });
  cleanEnv();
  assert.strictEqual((await startReq(p)).status, 202, "flag off: the same rows block nothing");
  cleanEnv();
});

test("partial results are still limited to 5 in 24 hours and 30 in 30 days, and failed runs stay uncharged", async () => {
  reset(); ON();
  const p = mkProject();
  for (let i = 0; i < 5; i++) alRow((i + 1) * HOUR, { status: "ready", topics: [] });
  const r = await startReq(p);
  assert.deepStrictEqual([r.status, r.json.code, r.json.scope], [429, "partial_limit", "daily"]);
  assert.strictEqual(r.json.mlsTrendAvailable, true);
  assert.ok(db.agent_marketing_research.filter((x) => x.status === "failed").every((x) => x.charged_at === null));
  cleanEnv();
});

test("concurrency: a request already running blocks a second, before and after the row is saved", async () => {
  reset(); ON();
  const p = mkProject();
  const a = await startReq(p);
  assert.strictEqual(a.status, 202);
  const b = await startReq(p, { audience: "buyers" });          // the earlier request is still running
  assert.strictEqual(b.status, 409);
  assert.strictEqual(fetched.length, 1);
  cleanEnv();
});

test("concurrency: when two requests race past the check, the later row is withdrawn, uncharged and never dispatched", async () => {
  reset(); ON();
  const p = mkProject();
  // another request saves its row just before this one's insert, after this one's admission check passed
  hooks.beforeInsert = (rows) => { rows.push({ id: uuid(nextId++), user_id: currentUser, project_id: p.id, mode: "market_update", status: "running", charged_at: null, created_at: iso(5), usage: { pathway: "article_led" } }); };
  const r = await startReq(p);
  assert.deepStrictEqual([r.status, r.json.code], [409, "already_running"]);
  assert.strictEqual(fetched.length, 0, "the worker was never dispatched");
  const mine = db.agent_marketing_research.filter((x) => x.status === "failed");
  assert.strictEqual(mine.length, 1); assert.strictEqual(mine[0].charged_at, null);
  assert.deepStrictEqual([mine[0].usage.withdrawn, mine[0].usage.withdrawnFor], [true, "already_running"]);
  assert.ok(/This did not use a session/.test(mine[0].error));
  // a withdrawn row is not counted afterwards, and the surviving request is unaffected
  const rival = db.agent_marketing_research.find((x) => x.status === "running"); rival.status = "ready"; rival.charged_at = iso(1);
  assert.strictEqual((await startReq(p)).status, 202);
  cleanEnv();
});

test("concurrency: racing requests cannot exceed the request limit, because only rows ordered before a request count", async () => {
  reset(); ON();
  const p = mkProject();
  for (let i = 0; i < 14; i++) alRow((i + 1) * HOUR);                                                   // 14 finished requests
  hooks.beforeInsert = (rows) => { rows.push({ id: uuid(nextId++), user_id: currentUser, project_id: p.id, mode: "market_update", status: "ready", charged_at: iso(1), created_at: iso(5), usage: { pathway: "article_led", attempts: 1 } }); };
  const r = await startReq(p);                                                                          // the rival made it 15 first
  assert.deepStrictEqual([r.status, r.json.code, r.json.scope], [429, "provider_request_limit", "daily"]);
  assert.strictEqual(fetched.length, 0);
  assert.strictEqual(db.agent_marketing_research.filter((x) => x.usage && x.usage.withdrawn).length, 1);
  // the earlier row of a race is the one that stays: ordering is by created_at, then id
  assert.deepStrictEqual(al.admit([{ id: "a", created_at: iso(10), status: "running", pathway: "article_led" }], { id: "b", created_at: iso(10) }, Date.now(), {}).code, "already_running");
  assert.strictEqual(al.admit([{ id: "b", created_at: iso(10), status: "running", pathway: "article_led" }], { id: "a", created_at: iso(10) }, Date.now(), {}).blocked, false);
  cleanEnv();
});

test("admission fails closed: if the rows cannot be read after the insert, the request is withdrawn and nothing is dispatched", async () => {
  reset(); ON();
  const p = mkProject();
  const orig = fakeSupabase;
  let calls = 0;
  stub("../netlify/functions/lib/marketing-profile-lib", { supabase: (m, t, b, q) => { if (m === "GET" && t === "agent_marketing_research" && /pathway:usage/.test(q || "") && ++calls === 2) return Promise.resolve({ status: 500, data: null }); return orig(m, t, b, q); } });
  delete require.cache[require.resolve("../netlify/functions/agent-marketing-research")];
  const { handler: h2 } = require("../netlify/functions/agent-marketing-research");
  const res = await h2({ httpMethod: "POST", headers: { host: "x.test" }, body: JSON.stringify({ action: "start", projectId: p.id, request: REQ }), queryStringParameters: null });
  assert.strictEqual(res.statusCode, 500);
  assert.strictEqual(fetched.length, 0);
  assert.ok(db.agent_marketing_research.every((x) => x.status !== "running"));
  stub("../netlify/functions/lib/marketing-profile-lib", { supabase: fakeSupabase });
  cleanEnv();
});
