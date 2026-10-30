// Start and run research with an uploaded report, end to end against an in-memory database (no network).
const test = require("node:test");
const assert = require("node:assert");

const U1 = "11111111-1111-4111-8111-111111111111";
const U2 = "22222222-2222-4222-8222-222222222222";
let currentUser = U1;
const db = { agent_marketing_projects: [], agent_marketing_research: [], agent_marketing_uploads: [] };
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
      else if (v.startsWith("in.(")) { if (!v.slice(4, -1).split(",").includes(String(r[k]))) return false; }
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
stub("../netlify/functions/lib/reel-quota-lib", { getPlanContext: async () => ({ poolKind: "user" }) });
const { handler } = require("../netlify/functions/agent-marketing-research");
const worker = require("../netlify/functions/agent-marketing-research-background");
const runLib = require("../netlify/functions/lib/agent-marketing-research-run-lib");
const planLib = require("../netlify/functions/lib/agent-marketing-plan-lib");
const reportLib = require("../netlify/functions/lib/agent-marketing-report-lib");
const tv = require("./helpers/trend-fixture");

let fetched = [];
global.fetch = async (url, opts) => { fetched.push({ url, opts }); return { ok: true }; };
const call = async (method, body, qs) => {
  const res = await handler({ httpMethod: method, headers: { host: "x.test" }, body: body ? JSON.stringify(body) : null, queryStringParameters: qs || null });
  return { status: res.statusCode, json: JSON.parse(res.body) };
};
const REQ = { mode: "market_update", audience: "sellers", geography: { type: "zip", name: "95999" } };
const reset = () => { for (const k of Object.keys(db)) db[k].length = 0; fetched = []; currentUser = U1; process.env.AGENT_MARKETING_ENABLED = "true"; process.env.PERPLEXITY_API_KEY = "pplx-test"; process.env.ANTHROPIC_API_KEY = "sk-ant-test"; process.env.INTERNAL_API_KEY = "internal"; process.env.URL = "https://site.test"; delete process.env.AGENT_MARKETING_RESEARCH_SESSIONS; };
const mkProject = (over) => { const row = { id: uuid(nextId++), user_id: currentUser, template: "local_market_insider", status: "draft", intake: {}, ...over }; db.agent_marketing_projects.push(row); return row; };
const mkUpload = (p, over) => {
  const facts = reportLib.analyzePages(tv.standard().pages).facts; facts.mlsSource = "MetroList";
  const row = { id: uuid(nextId++), project_id: p.id, user_id: currentUser, status: "confirmed", facts, scope_note: reportLib.scopeNote(facts), ...over };
  db.agent_marketing_uploads.push(row); return row;
};
const dispatch = (id, owner) => worker.handler({ headers: { "x-internal-key": "internal" }, body: JSON.stringify({ researchId: id, owner: owner || U1 }) });

test("start with a report: only a confirmed upload of this project and user is used; its scope note is saved with the request", async () => {
  reset();
  const p = mkProject(), other = mkProject();
  const ok = mkUpload(p);
  const pending = mkUpload(p, { status: "pending" });
  const wrongProject = mkUpload(other);
  currentUser = U2; const theirs = mkUpload(p); currentUser = U1;
  const start = (uploadIds, dataSource) => call("POST", { action: "start", projectId: p.id, request: { ...REQ, dataSource, uploadIds } });
  for (const bad of [pending.id, wrongProject.id, theirs.id, uuid(999)]) {
    const r = await start([bad], "both");
    assert.strictEqual(r.status, 400, bad);
    assert.match(r.json.error, /confirmed yet, or was removed/);
  }
  assert.strictEqual(db.agent_marketing_research.length, 0);
  const r = await start([ok.id], "both");
  assert.strictEqual(r.status, 202);
  const row = db.agent_marketing_research[0];
  assert.strictEqual(row.data_source, "both");
  assert.deepStrictEqual(row.upload_refs, [{ id: ok.id, scope_note: ok.scope_note }]);
  assert.ok(!JSON.stringify(row.upload_refs).includes("715"));            // no figure is stored in the request
  assert.strictEqual(r.json.research.dataSource, "both");
});

test("start: 'web only' ignores an attached report, and 'upload' needs no web key but does need the model key", async () => {
  reset();
  const p = mkProject(); const u = mkUpload(p);
  const web = await call("POST", { action: "start", projectId: p.id, request: { ...REQ, dataSource: "web", uploadIds: [u.id] } });
  assert.strictEqual(web.status, 202);
  assert.deepStrictEqual(db.agent_marketing_research[0].upload_refs, []);
  assert.strictEqual(db.agent_marketing_research[0].data_source, "web");
  db.agent_marketing_research[0].status = "failed";
  delete process.env.PERPLEXITY_API_KEY;
  assert.strictEqual((await call("POST", { action: "start", projectId: p.id, request: { ...REQ, dataSource: "upload", uploadIds: [u.id] } })).status, 202);
  db.agent_marketing_research[1].status = "failed";
  delete process.env.ANTHROPIC_API_KEY;
  assert.strictEqual((await call("POST", { action: "start", projectId: p.id, request: { ...REQ, dataSource: "upload", uploadIds: [u.id] }, newTopics: true })).status, 500);
});

test("the same request with and without the report are different requests (no wrong reuse)", async () => {
  reset();
  const p = mkProject(); const u = mkUpload(p);
  assert.strictEqual((await call("POST", { action: "start", projectId: p.id, request: { ...REQ, dataSource: "upload", uploadIds: [u.id] } })).status, 202);
  const id = db.agent_marketing_research[0].id;
  db.agent_marketing_research[0].status = "ready"; db.agent_marketing_research[0].topics = [{}];
  const again = await call("POST", { action: "start", projectId: p.id, request: { ...REQ, dataSource: "upload", uploadIds: [u.id] } });
  assert.strictEqual(again.json.reused, true);
  assert.strictEqual(again.json.research.id, id);
  const web = await call("POST", { action: "start", projectId: p.id, request: { ...REQ, dataSource: "web" } });
  assert.strictEqual(web.status, 202);                                      // a different request: a new run
});

test("worker, upload only: topics come from the report, are charged once, and are frozen with their figures when chosen", async () => {
  reset();
  const p = mkProject(); const u = mkUpload(p);
  const ids = [...reportLib.analyzePages(tv.standard().pages).facts.figures];
  const f = (key) => `r1.${ids.find((x) => x.key === key).id}`;
  const answer = JSON.stringify({ topics: [
    { question: "How long are homes in ZIP 95999 taking to sell?", why_it_matters: "Average days on market was 45 days.", figure_ids: [f("avg_dom")] },
    { question: "What is the median sold price in ZIP 95999?", why_it_matters: "The median sold price was $715,000.", figure_ids: [f("median_close_price")] },
    { question: "How much supply is in ZIP 95999?", why_it_matters: "Months of inventory was 5.9 months.", figure_ids: [f("months_supply")] },
    { question: "How many closed sales were there in ZIP 95999?", why_it_matters: "There were 52 closed sales.", figure_ids: [f("count_closed")] },
    { question: "How close to list price do homes sell in ZIP 95999?", why_it_matters: "Sold price was 98% of list price.", figure_ids: [f("avg_close_to_list_pct")] },
  ] });
  const start = await call("POST", { action: "start", projectId: p.id, request: { ...REQ, dataSource: "upload", uploadIds: [u.id] } });
  const id = start.json.research.id;
  const orig = planLib.callClaudeText;
  planLib.callClaudeText = async () => answer;
  try { assert.strictEqual((await dispatch(id)).statusCode, 200); } finally { planLib.callClaudeText = orig; }
  const row = db.agent_marketing_research[0];
  assert.strictEqual(row.status, "ready");
  assert.ok(row.charged_at);
  assert.deepStrictEqual(row.topics.map((t) => t.origin), Array(5).fill("report"));
  const g = await call("GET", null, { projectId: p.id });
  assert.strictEqual(g.json.research[0].topics[0].reportFigures[0].uploadId, u.id);
  assert.strictEqual(g.json.session.used, 1);
  const sel = await call("POST", { action: "select", projectId: p.id, researchId: id, topicId: "t2" });
  assert.strictEqual(sel.status, 200);
  const frozen = db.agent_marketing_projects.find((x) => x.id === p.id).selected_topic;
  assert.match(frozen.reportNotice, /^Based on information from MetroList Services, Inc\./);
  assert.match(frozen.reportFigures[0].text, /Median sold price: \$715,000/);
  // removing the report afterwards does not change the frozen topic
  db.agent_marketing_uploads.length = 0;
  assert.match(db.agent_marketing_projects.find((x) => x.id === p.id).selected_topic.reportFigures[0].text, /\$715,000/);
});

test("worker: a report removed before the run finishes fails the run without charging", async () => {
  reset();
  const p = mkProject(); const u = mkUpload(p);
  const start = await call("POST", { action: "start", projectId: p.id, request: { ...REQ, dataSource: "both", uploadIds: [u.id] } });
  db.agent_marketing_uploads.length = 0;
  assert.strictEqual((await dispatch(start.json.research.id)).statusCode, 200);
  const row = db.agent_marketing_research[0];
  assert.strictEqual(row.status, "failed");
  assert.strictEqual(row.charged_at, null);
  assert.match(row.error, /removed/);
});

test("worker: another user's dispatch cannot read this user's report", async () => {
  reset();
  const p = mkProject(); const u = mkUpload(p);
  const start = await call("POST", { action: "start", projectId: p.id, request: { ...REQ, dataSource: "upload", uploadIds: [u.id] } });
  assert.strictEqual((await dispatch(start.json.research.id, U2)).statusCode, 404);
  assert.strictEqual(db.agent_marketing_research[0].status, "running");
});

// Oct 30, 2026: choosing a topic from a saved set of another project brought no report with it (the project had zero uploads).
const mkSavedSet = (p, u, over) => {
  const row = { id: uuid(nextId++), project_id: p.id, user_id: currentUser, mode: "market_update", audience: "sellers", geography: { type: "zip", name: "95999" }, focus: {}, status: "ready", data_source: "both",
    upload_refs: [{ id: u.id, scope_note: u.scope_note }], research_date: "2026-10-27",
    topics: [{ id: "t3", origin: "report", question: "Q?", reportFigures: [{ ref: "r1.f7", uploadId: u.id, key: "median_close_price", label: "Median sold price", display: "$482,000", text: "Median sold price: $482,000" }] }], ...over };
  db.agent_marketing_research.push(row); return row;
};

test("select from another project's saved set copies the report into this project and points the set and topic at the copy", async () => {
  reset();
  const old = mkProject(); const u = mkUpload(old); const set = mkSavedSet(old, u);
  const now = mkProject();
  const r = await call("POST", { action: "select", projectId: now.id, researchId: set.id, topicId: "t3" });
  assert.strictEqual(r.status, 200);
  const mine = db.agent_marketing_uploads.filter((x) => x.project_id === now.id);
  assert.strictEqual(mine.length, 1, "the report now belongs to this project");
  assert.strictEqual(mine[0].status, "confirmed");
  assert.deepStrictEqual(mine[0].facts, u.facts);
  assert.strictEqual(r.json.reportAttached, true);
  assert.strictEqual(r.json.selectedTopic.reportFigures[0].uploadId, mine[0].id, "the frozen figures name the copy");
  const copy = db.agent_marketing_research.find((x) => x.project_id === now.id);
  assert.strictEqual(copy.upload_refs[0].id, mine[0].id);
  assert.strictEqual(db.agent_marketing_uploads.filter((x) => x.project_id === old.id).length, 1, "the original project keeps its report");
  // choosing again does not add a second copy
  await call("POST", { action: "select", projectId: now.id, researchId: set.id, topicId: "t3" });
  assert.strictEqual(db.agent_marketing_uploads.filter((x) => x.project_id === now.id).length, 1);
});

test("select from a set of this project changes nothing about its report, and a set with no report still works", async () => {
  reset();
  const p = mkProject(); const u = mkUpload(p); const set = mkSavedSet(p, u);
  const r = await call("POST", { action: "select", projectId: p.id, researchId: set.id, topicId: "t3" });
  assert.strictEqual(r.status, 200);
  assert.strictEqual(db.agent_marketing_uploads.length, 1);
  assert.strictEqual(r.json.selectedTopic.reportFigures[0].uploadId, u.id);
  const web = mkSavedSet(p, u, { upload_refs: [], data_source: "web", topics: [{ id: "t1", origin: "web", question: "Q?" }] });
  const w = await call("POST", { action: "select", projectId: p.id, researchId: web.id, topicId: "t1" });
  assert.strictEqual(w.status, 200); assert.strictEqual(w.json.reportAttached, false);
});
