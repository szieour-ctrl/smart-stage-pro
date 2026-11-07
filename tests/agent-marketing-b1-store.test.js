// Run with: npm test
// DEVELOPMENT ONLY (Nov 5, 2026): Stage B Supabase store (query shapes, error mapping, fail-closed) and the bridge's persistence flow
// (retry after a failed run, idempotent resume, reuse without a second B1 call, conditional completion, project attach).
// No database, no network, no provider call. The bridge is replaced by a STUB that replays the frozen v1.2.1 FA snapshot and the exported FA
// bundle: it tests the Node flow and Node's independent checks only. The authoritative Python gate runs in tests/agent-marketing-b1-e2e.test.js
// (needs B1_WORKSPACE). The SQL constraints themselves are checked on a local throwaway cluster by scripts/b1-migration-check.sh.
const test = require("node:test");
const assert = require("node:assert");
const fs = require("fs");
const os = require("os");
const path = require("path");
const { spawnSync } = require("child_process");
const st = require("../netlify/functions/lib/agent-marketing-b1-store-lib");
const br = require("../netlify/functions/lib/agent-marketing-b1-bridge-lib");
const sb = require("../netlify/functions/lib/agent-marketing-b1-stageb-lib");
const b1 = require("../netlify/functions/lib/agent-marketing-b1-evidence-lib");

// PRIVATE fixtures (frozen v1.2.1 FA request/response and the exported FA bundle) come from the B1 workspace: tests/helpers/b1-private.js.
const PRIV = require("./helpers/b1-private");
let F = null;
const fx = () => {
  if (F) return F;
  const REQ = PRIV.request("FA"), RESP = PRIV.response("FA"), BUNDLE = PRIV.bundle("FA"), INPUT = JSON.parse(REQ).input;
  const SNAP = INPUT.slice(INPUT.indexOf("=====BEGIN RETRIEVED TEXT=====\n") + 31, INPUT.lastIndexOf("\n=====END RETRIEVED TEXT====="));
  return (F = { REQ, RESP, BUNDLE, INPUT, SNAP });
};
const HAVE_PY = spawnSync("python3", ["-c", "print(1)"]).status === 0;

// A fake PostgREST over an in-memory table: supports the eq/neq/in filters, order and limit this store uses, and the in-flight unique index.
function fakeRest() {
  const t = { agent_marketing_article_evidence: [], agent_marketing_projects: [] }; let n = 0; const calls = [];
  const parse = (q) => { const p = new URLSearchParams(q.replace(/^\?/, "")); const f = []; let limit = 1e9, order = null;
    for (const [k, v] of p) { if (k === "limit") limit = +v; else if (k === "order") order = v; else { const [op, ...rest] = v.split("."); f.push([k, op, rest.join(".")]); } }
    return { f, limit, order }; };
  const match = (r, f) => f.every(([k, op, v]) => op === "eq" ? String(r[k]) === v : op === "neq" ? String(r[k]) !== v : op === "in" ? v.replace(/[()]/g, "").split(",").includes(String(r[k])) : false);
  const rq = async (method, table, body, q) => {
    calls.push({ method, table, body, q });
    const rows = t[table]; const { f, limit, order } = parse(q || "");
    if (method === "GET") { let out = rows.filter((r) => match(r, f)); if (order === "created_at.desc") out = out.slice().reverse(); return { status: 200, data: out.slice(0, limit) }; }
    if (method === "POST") {
      if (["reserved", "running"].includes(body.status) && rows.some((x) => x.cache_key === body.cache_key && ["reserved", "running"].includes(x.status)))
        return { status: 409, data: { code: "23505", message: 'duplicate key value violates unique constraint "uq_amae_inflight_cache_key"' } };
      const row = { ...body, id: `ev-${++n}`, created_at: new Date(Date.UTC(2026, 10, 5, 0, 0, n)).toISOString() }; rows.push(row); return { status: 201, data: [row] };
    }
    if (method === "PATCH") { const hit = rows.filter((r) => match(r, f));
      if (hit.some((r) => ["ready", "failed"].includes(r.status))) return { status: 400, data: { code: "P0001", message: "agent_marketing_article_evidence: a ready row is final" } };
      hit.forEach((r) => Object.assign(r, body)); return { status: 200, data: hit }; }
    return { status: 405, data: {} };
  };
  return { t, rq, calls };
}

// The bridge stub: a B1_WORKSPACE whose src/stageb_bridge.py replays canned replies (written by the test, never by B1).
function stubWorkspace(over = {}) {
  const ws = fs.mkdtempSync(path.join(os.tmpdir(), "b1-stub-"));
  fs.mkdirSync(path.join(ws, "src"));
  fs.writeFileSync(path.join(ws, "src", "stageb_bridge.py"), "import sys, json, os\nreq = json.load(sys.stdin)\nd = os.path.dirname(os.path.abspath(__file__))\nsys.stdout.write(open(os.path.join(d, req['op'] + '.json')).read())\n");
  const snapshot = { ok: true, snapshot_text: fx().SNAP, snapshot_sha256: sb.sha(fx().SNAP), input: fx().INPUT, input_sha256: sb.sha(fx().INPUT), request_text: fx().REQ, request_sha256: sb.sha(fx().REQ),
    extractor: "extract_v2", raw_html_sha256: "a".repeat(64), extractor_sha256: "b".repeat(64), bridge: "stub", flags: [], ...(over.snapshot || {}) };
  const gate = { ok: true, bundle: fx().BUNDLE, raw_response_sha256: sb.sha(fx().RESP), request_sha256: sb.sha(fx().REQ), completeness_status: "PASSED_WITH_HOLDS", gate_version: "gate-stub", ...(over.gate || {}) };
  fs.writeFileSync(path.join(ws, "src", "snapshot.json"), JSON.stringify(snapshot));
  fs.writeFileSync(path.join(ws, "src", "gate.json"), JSON.stringify(gate));
  return ws;
}
const page = async (url) => ({ status: 200, url, headers: { get: () => "text/html" }, arrayBuffer: async () => Buffer.from("<html><body>frozen</body></html>") });
const project = (id, uid) => ({ id, user_id: uid, selected_topic: { id: "t-fa", researchId: "r-1", question: "q", whyItMatters: "w", scope: "selected",
  sources: [{ title: "a", url: "https://example.org/fa", role: "primary" }], candidate: { id: "c1" } } });

test("store: switched off, the store cannot be created", () => {
  assert.throws(() => st.createStore({ env: {}, request: async () => ({}) }), (e) => e.code === "disabled");
});

test("store: queries are scoped by project and key; failed rows are ignored for the project; errors map to Stage B codes", async () => {
  const f = fakeRest(); const s = st.createStore({ env: { AGENT_MARKETING_B1_EVIDENCE: "dev" }, request: f.rq });
  await s.findForProject("p 1", "t&1");
  assert.match(f.calls[0].q, /project_id=eq\.p%201&topic_id=eq\.t%261&status=neq\.failed/);
  const bad = (status, data) => st.createStore({ env: { AGENT_MARKETING_B1_EVIDENCE: "dev" }, request: async () => ({ status, data }) });
  await assert.rejects(bad(409, { code: "23505", message: "uq_amae_inflight_cache_key" }).insert({ status: "reserved" }), (e) => e.code === "in_progress");
  await assert.rejects(bad(400, { code: "P0001", message: "immutable" }).update("x", {}), (e) => e.code === "refused");
  await assert.rejects(bad(500, {}).findLive("k"), (e) => e.code === "store_error");
  await assert.rejects(bad(200, []).update("x", { status: "ready" }, "reserved"), (e) => e.code === "conflict");
  await assert.rejects(bad(200, []).attach("p", "u", "e"), (e) => e.code === "not_found");
  assert.strictEqual(await bad(200, []).forPlan({ id: "p" }), null);   // no pointer: null, and the Planner then fails closed
});

test("store + bridge: reserve, complete, reuse, retry after failure, concurrent duplicate refused", { skip: PRIV.skip || (!HAVE_PY && "python3 not available") }, async () => {
  const ws = stubWorkspace(); const ENV = { AGENT_MARKETING_B1_EVIDENCE: "dev", B1_WORKSPACE: ws };
  const f = fakeRest(); const store = st.createStore({ env: ENV, request: f.rq });
  try {
    const a = await br.prepare({ project: project("pA", "uA"), userId: "uA", store, fetchFn: page, env: ENV });
    assert.strictEqual(a.reused, false); assert.strictEqual(a.record.status, "reserved");
    assert.strictEqual(a.record.request_text, fx().REQ, "the exact B1 request is stored before any provider call");
    // the same project asking again resumes its reservation rather than creating a second one
    const again = await br.prepare({ project: project("pA", "uA"), userId: "uA", store, fetchFn: page, env: ENV });
    assert.strictEqual(again.record.id, a.record.id);
    // another project with the same article while A is in flight: refused, no second B1 request
    await assert.rejects(br.prepare({ project: project("pB", "uB"), userId: "uB", store, fetchFn: page, env: ENV }), (e) => e.code === "in_progress");
    // the run fails (e.g. provider timeout): marked failed; a retry for the same project makes a NEW reservation
    await store.update(a.record.id, { status: "failed", error: "timeout" }, "reserved");
    const retry = await br.prepare({ project: project("pA", "uA"), userId: "uA", store, fetchFn: page, env: ENV });
    assert.notStrictEqual(retry.record.id, a.record.id); assert.strictEqual(retry.record.status, "reserved");
    // complete with the saved response (stands in for the provider call); conditional on still being reserved
    const stale = { ...retry.record };   // what a second worker would still hold
    const done = await br.complete({ record: retry.record, responseText: fx().RESP, store, env: ENV });
    assert.strictEqual(done.status, "ready"); assert.strictEqual(done.completeness_status, "PASSED_WITH_HOLDS");
    await assert.rejects(br.complete({ record: stale, responseText: fx().RESP, store, env: ENV }), (e) => e.code === "refused" || e.code === "conflict", "a second completion is refused");
    // project B now reuses A's completed result: a ready copy, no B1 call, its own self-contained evidence
    const reuse = await br.prepare({ project: project("pB", "uB"), userId: "uB", store, fetchFn: page, env: ENV });
    assert.strictEqual(reuse.reused, true); assert.strictEqual(reuse.record.reused_from, done.id);
    assert.strictEqual(reuse.record.raw_response_text, fx().RESP); assert.strictEqual(reuse.record.user_id, "uB");
    assert.ok(!("cost_usd" in reuse.record) || reuse.record.cost_usd == null, "a copy carries no cost");
    // the project pointer and the plan-time read
    f.t.agent_marketing_projects.push({ id: "pA", user_id: "uA" });
    await store.attach("pA", "uA", done.id);
    const row = await store.forPlan({ id: "pA", article_evidence_id: done.id });
    const topic = sb.topicWithEvidence({ ...project("pA", "uA"), selected_topic: { ...project("pA", "uA").selected_topic, researchId: "r-1" } }, row, ENV);
    assert.strictEqual(b1.readBundle(topic.b1Evidence).status, "PASSED_WITH_HOLDS", "PASSED_WITH_HOLDS stays visibly incomplete");
  } finally { fs.rmSync(ws, { recursive: true, force: true }); }
});

test("bridge: Node rejects a stub bridge reply that is inconsistent, so nothing is stored", { skip: PRIV.skip || (!HAVE_PY && "python3 not available") }, async () => {
  const cases = [
    [{ snapshot: { snapshot_text: fx().SNAP + " (a later version)" } }, "snapshot_inconsistent"],
    [{ snapshot: { request_text: fx().REQ.replace("minimal", "high") } }, "snapshot_inconsistent"],
    [{ snapshot: { extractor: "fetch_url" } }, "snapshot_inconsistent"],
  ];
  for (const [over, code] of cases) {
    const ws = stubWorkspace(over); const ENV = { AGENT_MARKETING_B1_EVIDENCE: "dev", B1_WORKSPACE: ws };
    const f = fakeRest(); const store = st.createStore({ env: ENV, request: f.rq });
    try {
      await assert.rejects(br.prepare({ project: project("pA", "uA"), userId: "uA", store, fetchFn: page, env: ENV }), (e) => e.code === code);
      assert.strictEqual(f.t.agent_marketing_article_evidence.length, 0);
    } finally { fs.rmSync(ws, { recursive: true, force: true }); }
  }
  const ws = stubWorkspace({ gate: { raw_response_sha256: "f".repeat(64) } }); const ENV = { AGENT_MARKETING_B1_EVIDENCE: "dev", B1_WORKSPACE: ws };
  const f = fakeRest(); const store = st.createStore({ env: ENV, request: f.rq });
  try {
    const a = await br.prepare({ project: project("pA", "uA"), userId: "uA", store, fetchFn: page, env: ENV });
    await assert.rejects(br.complete({ record: a.record, responseText: fx().RESP, store, env: ENV }), (e) => e.code === "gate_inconsistent");
    assert.strictEqual(f.t.agent_marketing_article_evidence[0].status, "reserved", "an inconsistent gate reply never makes a ready row");
  } finally { fs.rmSync(ws, { recursive: true, force: true }); }
});

test("bridge: a BLOCKED gate result finishes the row as failed (evidence_blocked), never ready", { skip: PRIV.skip || (!HAVE_PY && "python3 not available") }, async () => {
  const ws = stubWorkspace({ gate: { bundle: PRIV.bundle("BLOCKED"), completeness_status: "BLOCKED" } }); const ENV = { AGENT_MARKETING_B1_EVIDENCE: "dev", B1_WORKSPACE: ws };
  const f = fakeRest(); const store = st.createStore({ env: ENV, request: f.rq });
  try {
    const a = await br.prepare({ project: project("pA", "uA"), userId: "uA", store, fetchFn: page, env: ENV });
    const done = await br.complete({ record: a.record, responseText: fx().RESP, store, env: ENV });
    assert.deepStrictEqual([done.status, done.error, done.completeness_status], ["failed", "evidence_blocked", "BLOCKED"]);
    assert.strictEqual(b1.readBundle(done.bundle).status, "BLOCKED");
  } finally { fs.rmSync(ws, { recursive: true, force: true }); }
});
