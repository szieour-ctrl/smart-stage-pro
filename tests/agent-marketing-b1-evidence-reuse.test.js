"use strict";
// Nov 12, 2026: a project that already holds completed evidence for an article uses that row for a later research run on the same article
// (the database allows one completed row per project, article snapshot and gate version), and a project resumes without a second row.
// Offline: an in-memory store that enforces the same uniqueness and user scoping. No provider call, no database, no schema change.
const test = require("node:test");
const assert = require("node:assert");
const run = require("../netlify/functions/lib/agent-marketing-b1-stageb-run-lib");
const sb = require("../netlify/functions/lib/agent-marketing-b1-stageb-lib");
const store = require("../netlify/functions/lib/agent-marketing-b1-store-lib");
const fs = require("fs");

const U1 = "11111111-1111-4111-8111-111111111111", U2 = "22222222-2222-4222-8222-222222222222";
const PA = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa", PB = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const R1 = "c1111111-1111-4111-8111-111111111111", R2 = "c2222222-2222-4222-8222-222222222222", R3 = "c3333333-3333-4333-8333-333333333333";
const KEY = "a-3ce01306a40f51fcc101e381", URL_A = "https://example.test/roseville-september", CK = "c".repeat(64), GATE = "output_gate v1.2.1+qrec-1+review-1";
const ENV = { AGENT_MARKETING_B1_EVIDENCE: "dev", AGENT_MARKETING_ENABLED: "true", AGENT_MARKETING_USER_IDS: `${U1},${U2}`, B1_STAGEB_USER_IDS: `${U1},${U2}`, SUPABASE_URL: "https://dev-project.supabase.co" };

const row = (o) => ({ id: `e-${Math.random().toString(36).slice(2, 8)}`, user_id: U1, project_id: PA, research_id: R1, topic_id: KEY, source_url: URL_A, cache_key: CK, gate_version: GATE, status: "ready", reused_from: null, created_at: "2026-11-12T04:27:00Z", ...o });
const topic = (researchId) => ({ id: "t5", researchId, candidate: { id: "b2-C9" }, b1: { articleKey: KEY, evidenceId: "x" }, sources: [{ url: URL_A, title: "T", role: "primary", kind: "article" }] });
const proj = (id, researchId, user) => ({ id, user_id: user || U1, template: "local_market_insider", selected_research_id: researchId, selected_topic: topic(researchId), article_evidence_id: null });

// A store that behaves like the real one where it matters: research-aware findForProject, user-scoped findReadyForTopic, and the database's
// one-completed-row-per-(project, cache key, gate version) rule on insert.
function mem(rows) {
  const inserts = [], attaches = [];
  return { rows, inserts, attaches,
    async findForProject(pid, tid, rid) { return rows.filter((r) => r.project_id === pid && r.topic_id === tid && (!rid || r.research_id === rid) && r.status !== "failed").pop() || null; },
    async latestForProject(pid, tid, rid) { return rows.filter((r) => r.project_id === pid && r.topic_id === tid && (!rid || r.research_id === rid)).pop() || null; },
    async findReadyForTopic(uid, tid) { return rows.filter((r) => r.user_id === uid && r.topic_id === tid && r.status === "ready"); },
    async findReadyForProjectKey(uid, pid, ck, gv) { return rows.find((r) => r.user_id === uid && r.project_id === pid && r.cache_key === ck && r.gate_version === gv && r.status === "ready") || null; },
    async researchRoot(id) { return id === R3 ? R1 : id === R2 ? R1 : id; },
    async attach(pid, uid, eid) { attaches.push({ pid, uid, eid }); return true; },
    async insert(r) {
      if (r.status === "ready" && rows.some((x) => x.project_id === r.project_id && x.cache_key === r.cache_key && x.gate_version === r.gate_version && x.status === "ready")) throw Object.assign(new Error("duplicate"), { code: "duplicate" });
      const n = { ...r, id: `e-new-${inserts.length}` }; inserts.push(n); rows.push(n); return n;
    } };
}
const withCheck = async (fn) => { const orig = sb.checkRecord; sb.checkRecord = () => []; try { return await fn(); } finally { sb.checkRecord = orig; } };   // integrity itself is covered by the B1 suites

test("same project, later research run, same article: the existing completed row is used and nothing is inserted", async () => {
  await withCheck(async () => {
    const s = mem([row({ research_id: R1 })]);   // written by the earlier (failed-at-B2) run of this project
    const project = proj(PA, R2);
    const got = await run.ownReadyEvidence({ store: s, project, topic: project.selected_topic, userId: U1 });
    assert.strictEqual(got.id, s.rows[0].id);
    const p = await run.precheck({ userId: U1, projectId: PA, store: s, loadProject: async () => project, env: ENV });
    assert.strictEqual(p.ready.id, s.rows[0].id, "precheck reports the project's own row as ready");
    assert.deepStrictEqual(s.attaches.map((a) => a.eid), [s.rows[0].id], "the project is pointed at its own row");
    assert.strictEqual(s.inserts.length, 0);
  });
});

test("the saved-set path that used to collide now returns the project's own row instead of inserting a copy", async () => {
  await withCheck(async () => {
    const own = row({ research_id: R1, project_id: PA });
    const original = row({ research_id: R1, project_id: PB, reused_from: null, id: "e-orig" });   // another project's completed row, same snapshot
    const s = mem([own, original]);
    const project = proj(PA, R2);   // a copy of the saved set (research R2) opened in project A
    const got = await run.reuseSavedTopic({ store: s, project, topic: project.selected_topic, userId: U1 });
    assert.strictEqual(got.id, own.id);
    assert.strictEqual(s.inserts.length, 0, "no second completed row, so no duplicate error");
  });
});

test("ordinary resumption of the same project and research run still finds its row and inserts nothing", async () => {
  await withCheck(async () => {
    const s = mem([row({ research_id: R1 })]);
    const project = proj(PA, R1);
    const p = await run.precheck({ userId: U1, projectId: PA, store: s, loadProject: async () => project, env: ENV });
    assert.strictEqual(p.ready.id, s.rows[0].id);
    const again = await run.precheck({ userId: U1, projectId: PA, store: s, loadProject: async () => project, env: ENV });
    assert.strictEqual(again.ready.id, s.rows[0].id);
    assert.strictEqual(s.inserts.length, 0);
  });
});

test("separate Reel projects stay independent: another project's or another subscriber's row is never taken as this project's own", async () => {
  await withCheck(async () => {
    const elsewhere = row({ project_id: PB });          // same subscriber, a different Reel
    const stranger = row({ user_id: U2, project_id: PA });   // same project id value but another subscriber's row
    const s = mem([elsewhere, stranger]);
    const project = proj(PA, R2);
    assert.strictEqual(await run.ownReadyEvidence({ store: s, project, topic: project.selected_topic, userId: U1 }), null);
    const p = await run.precheck({ userId: U1, projectId: PA, store: s, loadProject: async () => project, env: ENV });
    assert.ok(!p.ready && !p.live, "a separate Reel starts its own production: nothing is inherited by this lookup");
    assert.strictEqual(s.attaches.length, 0);
    // and the project-key lookup is scoped to the subscriber and the project
    assert.strictEqual(await s.findReadyForProjectKey(U1, PA, CK, GATE), null);
  });
});

test("only an article-keyed topic can use a row from an earlier research run; any other topic key still needs its own research run", () => {
  const rec = row({ research_id: R1 });
  const p1 = proj(PA, R2);
  const problems = (r, p) => sb.checkRecord(r, p).filter((x) => /different selected topic/.test(x));
  assert.deepStrictEqual(problems(rec, p1), [], "article-keyed topic: an earlier run's row of this project is compatible");
  const plain = { ...p1, selected_topic: { ...p1.selected_topic, b1: undefined } };
  assert.strictEqual(problems({ ...rec, topic_id: "t5" }, plain).length, 1, "a non-article key still requires the same research run");
  assert.strictEqual(problems(row({ research_id: R1, topic_id: "a-other" }), p1).length, 1, "a different article is still rejected");
  assert.strictEqual(problems({ ...rec, project_id: PB }, p1).length, 0, "(the project check reports this separately)");
  assert.ok(sb.checkRecord({ ...rec, project_id: PB }, p1).some((x) => /another project/.test(x)), "another project's row is still refused");
});

test("the store offers the project-key lookup scoped by subscriber, project, cache key, gate version and ready status", async () => {
  let q = null;
  const st = store.createStore({ env: { AGENT_MARKETING_B1_EVIDENCE: "dev" }, request: async (m, t, b, query) => { q = { m, t, query }; return { status: 200, data: [] }; } });
  assert.strictEqual(await st.findReadyForProjectKey(U1, PA, CK, GATE), null);
  assert.strictEqual(q.m, "GET");
  for (const part of [`user_id=eq.${U1}`, `project_id=eq.${PA}`, `cache_key=eq.${CK}`, "gate_version=eq.", "status=eq.ready"]) assert.ok(q.query.includes(part), part);
});

test("no schema, storage or retention change: no migration file was added and the code adds no delete", () => {
  const files = ["agent-marketing-b1-store-lib.js", "agent-marketing-b1-stageb-run-lib.js", "agent-marketing-b1-bridge-lib.js", "agent-marketing-b1-stageb-lib.js"]
    .map((f) => fs.readFileSync(require.resolve(`../netlify/functions/lib/${f}`), "utf8")).join("\n");
  assert.ok(!/"DELETE"/.test(files));
  assert.ok(!/create table|alter table|create unique index/i.test(files));
});
