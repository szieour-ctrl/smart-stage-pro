// Run with: npm test   (needs B1_WORKSPACE = the private ssp-b1-evidence workspace, Python 3 with beautifulsoup4 + lxml, and openssl;
// skipped with the reason otherwise; B1_FIXTURES_REQUIRED=1 makes a missing workspace a failure)
// DEVELOPMENT ONLY (Nov 5, 2026). The owner-only Stage B pathway end to end, offline:
//   agent-marketing-stageb (start / status) → agent-marketing-stageb-background → snapshot (plain fetch of the frozen page) → the REAL Python
//   worker over HTTPS → ledger reservation → MOCK provider (the frozen v1.2.1 response for the exact request; no paid call exists) → the REAL
//   Python evidence gate → stored evidence row → project pointer → Planner (withPlanEvidence) → content gate.
// Storage is a fake PostgREST that enforces the proposed migrations' rules (in-flight uniqueness, conditional updates, R11, final rows, the
// ledger function's idempotency and limits). No production database, no provider credentials, no network beyond 127.0.0.1.
const test = require("node:test");
const assert = require("node:assert");
const fs = require("fs");
const os = require("os");
const path = require("path");
const crypto = require("crypto");
const { spawn, spawnSync } = require("child_process");
const PRIV = require("./helpers/b1-private");
const st = require("../netlify/functions/lib/agent-marketing-b1-store-lib");
const run = require("../netlify/functions/lib/agent-marketing-b1-stageb-run-lib");
const pv = require("../netlify/functions/lib/agent-marketing-b1-provider-lib");
const b1 = require("../netlify/functions/lib/agent-marketing-b1-evidence-lib");
const planLib = require("../netlify/functions/lib/agent-marketing-plan-lib");
const gate = require("../netlify/functions/lib/agent-marketing-gate");
const startFn = require("../netlify/functions/agent-marketing-stageb");
const bgFn = require("../netlify/functions/agent-marketing-stageb-background");
const { PRODUCTION_REF } = require("../netlify/functions/lib/public-config-lib");

const WS = PRIV.workspace || "";
const PY = process.env.B1_BRIDGE_PYTHON || "python3";
const SKIP = PRIV.skip || (!fs.existsSync(path.join(WS, "src", "stageb_worker.py")) && "B1_WORKSPACE has no src/stageb_worker.py")
  || (spawnSync("openssl", ["version"]).status !== 0 && "openssl is needed for a throwaway test certificate") || false;
const sha = (s) => crypto.createHash("sha256").update(String(s), "utf8").digest("hex");
const SECRET = "t".repeat(48);
const U = { A: "aaaaaaaa-0000-4000-8000-000000000001", B: "bbbbbbbb-0000-4000-8000-000000000002", OUT: "cccccccc-0000-4000-8000-000000000003" };
const DEV_DB = "https://abcdefghijklmnopqrst.supabase.co";
const M = !SKIP ? JSON.parse(fs.readFileSync(path.join(WS, "frozen", "manifest_cases.json"), "utf8")) : {};

// ── the real Python worker on 127.0.0.1 with a throwaway certificate ─────────────────────────────────────────────────────────────────────────
let W = null;
test.before(async () => {
  if (SKIP) return;
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "b1-flow-"));
  const cert = path.join(dir, "c.pem"), key = path.join(dir, "k.pem");
  assert.strictEqual(spawnSync("openssl", ["req", "-x509", "-newkey", "rsa:2048", "-nodes", "-keyout", key, "-out", cert, "-days", "1", "-subj", "/CN=127.0.0.1", "-addext", "subjectAltName=IP:127.0.0.1"]).status, 0);
  const proc = spawn(PY, [path.join(WS, "src", "stageb_worker.py")], { env: { PATH: process.env.PATH, B1_WORKER_SECRET: SECRET, B1_WORKER_PORT: "0", B1_WORKER_TLS_CERT: cert, B1_WORKER_TLS_KEY: key }, stdio: ["ignore", "ignore", "pipe"] });
  const port = await new Promise((resolve, reject) => {
    let err = ""; const t = setTimeout(() => reject(new Error(`worker did not start: ${err}`)), 15000);
    proc.stderr.on("data", (d) => { err += d; const m = err.match(/listening on 127\.0\.0\.1:(\d+)/); if (m) { clearTimeout(t); resolve(Number(m[1])); } });
    proc.on("exit", (c) => { clearTimeout(t); reject(new Error(`worker exited ${c}: ${err}`)); });
  });
  W = { proc, port, dir, cert };
});
// The same worker in DEVELOPMENT FIXTURE MODE (Nov 7, 2026): B1_WORKER_FIXTURES=1 with the frozen FA/FB/FC files laid out as Dockerfile.fixtures does.
let WF = null;
test.before(async () => {
  if (SKIP || !fs.existsSync(path.join(WS, "src", "stageb_fixtures.py"))) return;
  for (let i = 0; !W && i < 300; i++) await new Promise((r) => setTimeout(r, 50));   // the main worker (its certificate) starts first
  if (!W) throw new Error("the main test worker did not start");
  const fx = fs.mkdtempSync(path.join(os.tmpdir(), "b1-fixtures-"));
  fs.copyFileSync(path.join(WS, "fixtures", "manifest.json"), path.join(fx, "manifest.json"));
  for (const c of ["FA", "FB", "FC"]) {
    fs.copyFileSync(path.join(WS, "frozen", "raw", `${c}.html`), path.join(fx, `${c}.html`));
    for (const k of ["request", "response"]) fs.copyFileSync(path.join(WS, "frozen", "v121_run", `${c}.${k}.json`), path.join(fx, `${c}.${k}.json`));
  }
  const proc = spawn(PY, [path.join(WS, "src", "stageb_worker.py")], { env: { PATH: process.env.PATH, B1_WORKER_SECRET: SECRET, B1_WORKER_PORT: "0",
    B1_WORKER_TLS_CERT: W.cert, B1_WORKER_TLS_KEY: path.join(W.dir, "k.pem"), B1_WORKER_FIXTURES: "1", B1_WORKER_FIXTURES_DIR: fx }, stdio: ["ignore", "ignore", "pipe"] });
  const port = await new Promise((resolve, reject) => {
    let err = ""; const t = setTimeout(() => reject(new Error(`fixture worker did not start: ${err}`)), 15000);
    proc.stderr.on("data", (d) => { err += d; const m = err.match(/listening on 127\.0\.0\.1:(\d+) fixture-mode=on/); if (m) { clearTimeout(t); resolve(Number(m[1])); } });
    proc.on("exit", (c) => { clearTimeout(t); reject(new Error(`fixture worker exited ${c}: ${err}`)); });
  });
  WF = { proc, port, fx };
});
test.after(() => { if (W) { W.proc.kill("SIGKILL"); fs.rmSync(W.dir, { recursive: true, force: true }); } if (WF) { WF.proc.kill("SIGKILL"); fs.rmSync(WF.fx, { recursive: true, force: true }); } });

const baseEnv = (over) => ({ AGENT_MARKETING_B1_EVIDENCE: "dev", AGENT_MARKETING_ENABLED: "true", AGENT_MARKETING_USER_IDS: "", B1_STAGEB_USER_IDS: `${U.A},${U.B}`,
  SUPABASE_URL: DEV_DB, B1_PROVIDER: "mock",
  B1_WORKER_URL: W ? `https://127.0.0.1:${W.port}` : "", B1_WORKER_SECRET: SECRET, B1_WORKER_CA_FILE: W ? W.cert : "", ...(over || {}) });

// ── a fake PostgREST that enforces the proposed migrations ─────────────────────────────────────────────────────────────────────────────────
function fakeDb() {
  const T = { agent_marketing_article_evidence: [], agent_marketing_projects: [], ledger: [] }; let n = 0; const calls = [];
  const parse = (q) => { const p = new URLSearchParams(String(q || "").replace(/^\?/, "")); const f = []; let limit = 1e9, order = null;
    for (const [k, v] of p) { if (k === "limit") limit = +v; else if (k === "order") order = v; else if (k !== "select") { const i = v.indexOf("."); f.push([k, v.slice(0, i), v.slice(i + 1)]); } }
    return { f, limit, order }; };
  const match = (r, f) => f.every(([k, op, v]) => op === "eq" ? String(r[k]) === v : op === "neq" ? String(r[k]) !== v : op === "in" ? v.replace(/[()]/g, "").split(",").includes(String(r[k]))
    : op === "not" && v === "is.null" ? r[k] != null : op === "gte" ? String(r[k]) >= decodeURIComponent(v) : false);
  const err = (status, code, message) => ({ status, data: { code, message } });
  const FROZEN = ["snapshot_text", "snapshot_sha256", "request_text", "request_sha256", "input_sha256", "cache_key", "user_id", "topic_id", "source_url"];
  function rpc(body) {
    const { p_user, p_research, p_seq, p_daily, p_monthly } = body;
    const hit = T.ledger.find((l) => l.research_id === p_research && l.seq === p_seq);
    if (hit) return { allowed: true, replayed: true, reservation_id: hit.id };
    const now = Date.now(), mine = T.ledger.filter((l) => l.user_id === p_user);
    const day = mine.filter((l) => now - l.at < 864e5).length, month = mine.filter((l) => now - l.at < 30 * 864e5).length;
    if (day + 1 > p_daily) return { allowed: false, scope: "daily", used: day, limit: p_daily };
    if (month + 1 > p_monthly) return { allowed: false, scope: "monthly", used: month, limit: p_monthly };
    const row = { id: crypto.randomUUID(), user_id: p_user, research_id: p_research, seq: p_seq, at: now }; T.ledger.push(row);
    return { allowed: true, replayed: false, reservation_id: row.id, used_day: day + 1, used_month: month + 1 };
  }
  async function rq(method, table, body, q) {
    calls.push({ method, table, q });
    if (table === "rpc/agent_marketing_reserve_provider_request") return { status: 200, data: rpc(body) };
    const rows = T[table]; if (!rows) return err(404, "42P01", `no table ${table}`);
    const { f, limit, order } = parse(q);
    if (method === "GET") { let out = rows.filter((r) => match(r, f));
      if (order) { const [k, dir] = order.split("."); out = out.slice().sort((a, b) => (a[k] < b[k] ? -1 : a[k] > b[k] ? 1 : 0) * (dir === "desc" ? -1 : 1)); }
      return { status: 200, data: out.slice(0, limit).map((r) => ({ ...r })) }; }
    if (method === "POST") {
      const r = { ...body };
      if (!(r.status === "reserved" || (r.status === "ready" && r.reused_from))) return err(400, "P0001", "a new row is reserved, or ready only as a copy");
      if (["reserved", "running"].includes(r.status) && rows.some((x) => x.cache_key === r.cache_key && ["reserved", "running"].includes(x.status))) return err(409, "23505", 'duplicate key value violates unique constraint "uq_amae_inflight_cache_key"');
      if (r.status === "ready" && rows.some((x) => x.status === "ready" && x.project_id === r.project_id && x.cache_key === r.cache_key && x.gate_version === r.gate_version)) return err(409, "23505", "uq_amae_project_ready");
      const nowIso = new Date(Date.now() + (n++)).toISOString();
      const row = { provider_seq: null, provider_reservation_id: null, error: null, finished_at: null, ...r, id: crypto.randomUUID(), created_at: nowIso, reserved_at: r.reserved_at || nowIso };
      rows.push(row); return { status: 201, data: [{ ...row }] };
    }
    if (method === "PATCH") {
      const hit = rows.filter((r) => match(r, f)); const out = [];
      for (const old of hit) {
        const nw = { ...old, ...body };
        if (table === "agent_marketing_projects") {
          const ev = T.agent_marketing_article_evidence.find((e) => e.id === nw.article_evidence_id);
          if (nw.article_evidence_id && !(ev && ev.project_id === nw.id && ev.user_id === nw.user_id && ev.status === "ready")) return err(400, "P0001", "article_evidence_id must name a ready evidence row of this project and user");
        } else {
          if (FROZEN.some((k) => k in body && body[k] !== old[k])) return err(400, "P0001", "immutable");
          if (["ready", "failed"].includes(old.status)) return err(400, "P0001", `a ${old.status} row is final`);
          if ((old.provider_seq != null && "provider_seq" in body && body.provider_seq !== old.provider_seq) || (old.status !== "reserved" && (("provider_seq" in body && old.provider_seq == null)))) return err(400, "P0001", "the provider reservation is set once, while reserved");
          if (["running", "ready"].includes(nw.status) && nw.status !== old.status && (nw.provider_seq == null || nw.provider_reservation_id == null)) return err(400, "P0001", `${nw.status} requires a provider-request reservation`);
          if (nw.provider_seq != null && rows.some((x) => x !== old && x.research_id === nw.research_id && x.provider_seq === nw.provider_seq)) return err(409, "23505", "uq_amae_research_provider_seq");
          if (nw.status === "ready" && !(nw.raw_response_text && nw.bundle && nw.completeness_status && nw.gate_version)) return err(400, "23514", "amae_ready_complete");
        }
        Object.assign(old, nw); out.push({ ...old });
      }
      return { status: 200, data: out };
    }
    return err(405, "x", "method");
  }
  return { T, rq, calls };
}

// ── projects, users, the frozen pages, the mock provider ─────────────────────────────────────────────────────────────────────────────────────
function world(over) {
  const db = fakeDb(), env = baseEnv(over && over.env);
  const mk = (c, uid, id) => ({ id, user_id: uid, template: "local_market_insider", duration_sec: 45, formats: ["9x16"], intake: { market: "Sacramento County", audience: "Home sellers", angle: "neighborhood", observation: "Buyers are taking their time." },
    article_evidence_id: null, selected_research_id: `11111111-0000-4000-8000-00000000000${c === "FA" ? 1 : c === "FB" ? 2 : 3}`,
    selected_topic: { id: `t-${c}`, researchId: `11111111-0000-4000-8000-00000000000${c === "FA" ? 1 : c === "FB" ? 2 : 3}`, question: "What is the market doing?", whyItMatters: "Pricing decisions.", scope: "selected",
      sources: [{ title: M[c].page_title, url: M[c].final_url, role: "primary" }], candidate: { id: `cand-${c}` } } });
  const P = { FA: mk("FA", U.A, "22222222-0000-4000-8000-0000000000a1"), FB: mk("FB", U.A, "22222222-0000-4000-8000-0000000000b1"), FC: mk("FC", U.A, "22222222-0000-4000-8000-0000000000c1") };
  db.T.agent_marketing_projects.push(...Object.values(P));
  const store = st.createStore({ env, request: db.rq });
  const loadProject = async (id, uid) => { const r = db.T.agent_marketing_projects.find((p) => p.id === id && p.user_id === uid); return r ? { ...r } : null; };
  const raw = (c) => fs.readFileSync(path.join(WS, "frozen", "raw", `${c}.html`));
  const byUrl = Object.fromEntries(["FA", "FB", "FC"].map((c) => [M[c].final_url, c]));
  const fetchFn = async (url) => ({ status: 200, url, headers: { get: () => "text/html; charset=utf-8" }, arrayBuffer: async () => raw(byUrl[url]) });
  const responses = new Map(["FA", "FB", "FC"].map((c) => [sha(PRIV.request(c)), PRIV.response(c)]));
  const provider = over && "provider" in over ? over.provider : pv.createProvider({ env, responses });
  const dispatched = [];
  const tokens = { "token-a": U.A, "token-b": U.B, "token-out": U.OUT };
  const requireUser = async (event) => { const t = String((event.headers || {}).authorization || "").replace(/^Bearer /, ""); return tokens[t] ? { user: { id: tokens[t] } } : { error: { status: 401, body: { error: "Please log in again.", code: "unauthorized" } } }; };
  const deps = { env, store, loadProject, requireUser };
  // The start answers { state: "dispatch" } when the page should start the job; `dispatched` records what the page would then send.
  const start = async (token, projectId, d) => {
    const r = await startFn.handler({ httpMethod: "POST", headers: { authorization: `Bearer ${token}` }, body: JSON.stringify({ action: "start", projectId }) }, {}, { ...deps, ...(d || {}) });
    if (r.statusCode === 202 && JSON.parse(r.body).state === "dispatch") dispatched.push({ projectId, userId: tokens[token] });
    return r;
  };
  const get = (token, projectId, d) => startFn.handler({ httpMethod: "GET", headers: { authorization: `Bearer ${token}` }, queryStringParameters: { projectId } }, {}, { ...deps, ...(d || {}) });
  // The page's call to the background function: its own Bearer token, only { projectId } in the body.
  const tokenOf = (uid) => Object.keys(tokens).find((t) => tokens[t] === uid);
  const background = (job, d) => bgFn.handler({ httpMethod: "POST", headers: { authorization: `Bearer ${tokenOf(job.userId) || "none"}` }, body: JSON.stringify({ projectId: job.projectId }) }, {},
    { env, store, loadProject, requireUser, fetchFn, provider, ...(d || {}) });
  return { db, env, store, P, provider, dispatched, start, get, background, loadProject, fetchFn, requireUser };
}
const json = (r) => JSON.parse(r.body);

test("stageb: admission: flag, explicit allowlist (empty denies), Agent Marketing, sign-in, never the production database", { skip: SKIP }, async () => {
  const w = world();
  const pid = w.P.FA.id;
  assert.strictEqual((await w.start("nobody", pid)).statusCode, 401);
  for (const [over, status] of [[{ AGENT_MARKETING_B1_EVIDENCE: "" }, 404], [{ AGENT_MARKETING_B1_EVIDENCE: "true" }, 404], [{ B1_STAGEB_USER_IDS: "" }, 404], [{ B1_STAGEB_USER_IDS: " , " }, 404],
    [{ B1_STAGEB_USER_IDS: U.B }, 404], [{ AGENT_MARKETING_ENABLED: "" }, 404], [{ SUPABASE_URL: `https://${PRODUCTION_REF}.supabase.co` }, 503], [{ SUPABASE_URL: "" }, 503]]) {
    const r = await w.start("token-a", pid, { env: baseEnv(over) });
    assert.strictEqual(r.statusCode, status, JSON.stringify(over));
    assert.strictEqual((await w.get("token-a", pid, { env: baseEnv(over) })).statusCode, status, `GET ${JSON.stringify(over)}`);
  }
  assert.strictEqual((await w.start("token-out", pid)).statusCode, 404, "a signed-in user outside the allowlist");
  assert.deepStrictEqual(w.dispatched, [], "nothing was dispatched");
  // the background job applies the same admission to the token's user
  assert.strictEqual((await w.background({ projectId: pid, userId: U.OUT })).statusCode, 404, "outside the allowlist");
  const bg = (headers, body, env) => bgFn.handler({ httpMethod: "POST", headers, body: JSON.stringify(body) }, {}, { env: env || w.env, store: w.store, loadProject: w.loadProject, requireUser: w.requireUser, fetchFn: w.fetchFn, provider: w.provider });
  assert.strictEqual((await bg({}, { projectId: pid })).statusCode, 401, "no token");
  assert.strictEqual((await bg({ authorization: "Bearer forged" }, { projectId: pid, userId: U.A })).statusCode, 401, "an unverified token, whatever userId the body names");
  assert.strictEqual((await bg({ "x-internal-key": "anything" }, { projectId: pid, userId: U.A })).statusCode, 401, "no internal-key path");
  assert.strictEqual((await bg({ authorization: "Bearer token-a" }, { projectId: pid }, baseEnv({ AGENT_MARKETING_B1_EVIDENCE: "" }))).statusCode, 404, "flag off");
  assert.strictEqual((await bg({ authorization: "Bearer token-a" }, { projectId: pid }, baseEnv({ SUPABASE_URL: `https://${PRODUCTION_REF}.supabase.co` }))).statusCode, 404, "production database");
  assert.strictEqual((await bg({ authorization: "Bearer token-a", host: "smartstagepro.com" }, { projectId: pid })).statusCode, 503, "production host");
  assert.strictEqual((await bgFn.handler({ httpMethod: "GET", headers: { authorization: "Bearer token-a" } }, {}, { env: w.env, requireUser: w.requireUser })).statusCode, 405);
  assert.strictEqual(w.db.T.agent_marketing_article_evidence.length, 0); assert.strictEqual(w.provider.calls, 0); assert.strictEqual(w.db.T.ledger.length, 0);
});

test("stageb: ownership: another user's project reads as missing, start and status alike", { skip: SKIP }, async () => {
  const w = world();
  assert.strictEqual((await w.start("token-b", w.P.FA.id)).statusCode, 404);
  assert.strictEqual((await w.get("token-b", w.P.FA.id)).statusCode, 404);
  assert.strictEqual(json(await w.background({ projectId: w.P.FA.id, userId: U.B })).state, "refused");
  assert.strictEqual((await w.start("token-a", "not-a-uuid")).statusCode, 400);
  w.db.T.agent_marketing_projects.push({ ...w.P.FA, id: "22222222-0000-4000-8000-0000000000d1", selected_topic: { ...w.P.FA.selected_topic, candidate: undefined } });
  assert.strictEqual((await w.start("token-a", "22222222-0000-4000-8000-0000000000d1")).statusCode, 409, "a legacy (non Article-Led) topic");
  assert.deepStrictEqual(w.dispatched, []);
  // the body cannot name a user: B's token with A's userId still acts as B (A's project reads as missing)
  const forged = await bgFn.handler({ httpMethod: "POST", headers: { authorization: "Bearer token-b" }, body: JSON.stringify({ projectId: w.P.FA.id, userId: U.A }) }, {},
    { env: w.env, store: w.store, loadProject: w.loadProject, requireUser: w.requireUser, fetchFn: w.fetchFn, provider: w.provider });
  assert.deepStrictEqual(json(forged), { state: "refused", code: "not_found" });
  assert.strictEqual(w.db.T.agent_marketing_article_evidence.length, 0); assert.strictEqual(w.provider.calls, 0); assert.strictEqual(w.db.T.ledger.length, 0);
});

test("stageb: the page may skip the start or send the job twice: the background job repeats every check and runs once", { skip: SKIP }, async () => {
  const w = world();
  const job = { projectId: w.P.FA.id, userId: U.A };
  assert.strictEqual(json(await w.background(job)).state, "ready", "straight to the background job, no start request");
  assert.deepStrictEqual(json(await w.background(job)), { state: "ready", reused: true }, "a repeat after ready");
  const [x, y] = await Promise.all([w.background({ projectId: w.P.FB.id, userId: U.A }), w.background({ projectId: w.P.FB.id, userId: U.A })]);
  assert.deepStrictEqual([json(x).state, json(y).state].sort(), ["in_progress", "ready"], "two at once: one runs, one stands aside");
  assert.strictEqual(w.provider.calls, 2, "one provider call per project");
  assert.strictEqual(w.db.T.ledger.length, 2, "one reservation per project");
  assert.strictEqual((await w.get("token-a", w.P.FB.id)).statusCode, 200);
  assert.strictEqual(json(await w.get("token-a", w.P.FB.id)).state, "ready");
});

test("stageb: FA, FB and FC end to end: one reservation and one provider call each, approved statuses, attached, status without evidence text", { skip: SKIP }, async () => {
  const w = world();
  const want = { FA: "PASSED_WITH_HOLDS", FB: "COMPLETE", FC: "PASSED_WITH_HOLDS" };
  for (const c of ["FA", "FB", "FC"]) {
    const s = await w.start("token-a", w.P[c].id);
    assert.deepStrictEqual([s.statusCode, json(s).state], [202, "dispatch"], c);
    const job = w.dispatched.pop(); assert.deepStrictEqual(job, { projectId: w.P[c].id, userId: U.A });
    const r = json(await w.background(job));
    assert.deepStrictEqual([r.state, r.completeness], ["ready", want[c]], c);
    const row = w.db.T.agent_marketing_article_evidence.find((e) => e.project_id === w.P[c].id);
    assert.strictEqual(row.request_text, PRIV.request(c), `${c}: the frozen v1.2.1 request, byte for byte`);
    assert.strictEqual(row.bundle.payload, PRIV.bundle(c).payload, `${c}: the reviewed bundle`);
    assert.strictEqual(row.provider_seq, 1001);
    assert.ok(w.db.T.ledger.some((l) => l.id === row.provider_reservation_id && l.research_id === w.P[c].selected_topic.researchId && l.seq === 1001));
    assert.strictEqual(w.db.T.agent_marketing_projects.find((p) => p.id === w.P[c].id).article_evidence_id, row.id, `${c}: attached`);
    const g = await w.get("token-a", w.P[c].id);
    const body = json(g);
    assert.deepStrictEqual([body.state, body.completeness, body.attached], ["ready", want[c], true]);
    assert.ok(body.counts && body.counts.validated > 0);
    assert.ok(!g.body.includes(row.snapshot_text.slice(200, 260)) && !/raw_response|request_text|payload/.test(g.body), "no evidence text or raw response reaches the page");
  }
  assert.strictEqual(w.provider.calls, 3); assert.strictEqual(w.db.T.ledger.length, 3);
});

test("stageb: duplicates: no second dispatch while live, no second provider run, reuse after ready, concurrent jobs make one call", { skip: SKIP }, async () => {
  const w = world();
  const pid = w.P.FA.id;
  await w.start("token-a", pid); const job = w.dispatched.pop();
  // two background jobs at once for the same project
  const both = await Promise.all([w.background(job), w.background(job)]);
  const states = both.map((r) => json(r).state).sort();
  assert.deepStrictEqual(states, ["in_progress", "ready"], JSON.stringify(states));
  assert.strictEqual(w.provider.calls, 1, "one provider call"); assert.strictEqual(w.db.T.ledger.length, 1, "one reservation");
  // started again once ready: no dispatch; a late job reuses the result without a call
  const again = await w.start("token-a", pid);
  assert.deepStrictEqual([again.statusCode, json(again).state], [200, "ready"]); assert.deepStrictEqual(w.dispatched, []);
  assert.strictEqual(json(await w.background(job)).state, "ready"); assert.strictEqual(w.provider.calls, 1);
  // a live (reserved) row blocks a second dispatch
  const w2 = world(); await w2.start("token-a", w2.P.FB.id); const j2 = w2.dispatched.pop();
  const slow = { name: "mock", paid: false, calls: 0, async call() { this.calls++; await new Promise((r) => setTimeout(r, 300)); throw Object.assign(new Error("x"), { code: "provider_error" }); } };
  const pending = w2.background(j2, { provider: slow });
  for (let i = 0; i < 200 && !w2.db.T.agent_marketing_article_evidence.some((e) => ["reserved", "running"].includes(e.status)); i++) await new Promise((r) => setTimeout(r, 25));
  assert.ok(w2.db.T.agent_marketing_article_evidence.some((e) => ["reserved", "running"].includes(e.status)), "the job's row is live");
  const during = await w2.start("token-a", w2.P.FB.id);
  assert.deepStrictEqual([during.statusCode, json(during).code], [202, "in_progress"]); assert.deepStrictEqual(w2.dispatched, [], "no second dispatch");
  await pending;
});

test("stageb: failures: a failed run can be retried with a new reservation; stale runs are retired; limits refuse before any call", { skip: SKIP }, async () => {
  const flaky = { name: "mock", paid: false, calls: 0, async call() { this.calls++; throw Object.assign(new Error("boom"), { code: "provider_error" }); } };
  const w = world();
  const pid = w.P.FC.id;
  await w.start("token-a", pid);
  assert.deepStrictEqual(json(await w.background(w.dispatched.pop(), { provider: flaky })), { state: "failed", code: "provider_error" });
  assert.strictEqual(w.db.T.agent_marketing_article_evidence[0].status, "failed");
  await w.start("token-a", pid);   // retry
  const r = json(await w.background(w.dispatched.pop()));
  assert.strictEqual(r.state, "ready");
  const seqs = w.db.T.agent_marketing_article_evidence.map((e) => [e.status, e.provider_seq]);
  assert.deepStrictEqual(seqs, [["failed", 1001], ["ready", 1002]], "a new attempt takes the next ledger sequence");
  // stale: a reserved row older than the background time limit is retired and the work re-dispatched
  const w2 = world(); await w2.start("token-a", w2.P.FA.id); const j = w2.dispatched.pop();
  const noCall = { name: "mock", paid: false, calls: 0, async call() { this.calls++; return new Promise(() => {}); } };   // never answers
  w2.background(j, { provider: noCall });
  await new Promise((res) => setTimeout(res, 800));
  const row = w2.db.T.agent_marketing_article_evidence[0]; row.reserved_at = new Date(Date.now() - run.STALE_MS - 1000).toISOString();
  const s = await w2.start("token-a", w2.P.FA.id);
  assert.deepStrictEqual([s.statusCode, json(s).state], [202, "dispatch"]); assert.strictEqual(row.status, "failed"); assert.strictEqual(row.error, "stale");
  // limits: the B1 per-user cap and the ledger's own daily limit refuse BEFORE any provider call
  const w3 = world({ env: { B1_STAGEB_MAX_PER_USER_DAY: "1" } });
  await w3.start("token-a", w3.P.FA.id); assert.strictEqual(json(await w3.background(w3.dispatched.pop())).state, "ready");
  await w3.start("token-a", w3.P.FB.id); assert.deepStrictEqual(json(await w3.background(w3.dispatched.pop())), { state: "failed", code: "b1_limit_user_day" });
  assert.strictEqual(w3.provider.calls, 1);
  const w4 = world({ env: { AGENT_MARKETING_REQUEST_DAILY_LIMIT: "1" } });
  w4.db.T.ledger.push({ id: crypto.randomUUID(), user_id: U.A, research_id: "11111111-0000-4000-8000-00000000000f", seq: 1, at: Date.now() });   // research already used today's request
  await w4.start("token-a", w4.P.FA.id); assert.deepStrictEqual(json(await w4.background(w4.dispatched.pop())), { state: "failed", code: "provider_limit_daily" });
  assert.strictEqual(w4.provider.calls, 0);
});

test("stageb: the live provider is absent: without B1_PROVIDER=mock the run fails before any reservation", { skip: SKIP }, async () => {
  const w = world({ env: { B1_PROVIDER: "" }, provider: null });
  assert.throws(() => pv.createProvider({ env: w.env }), (e) => e.code === "provider_not_implemented");
  assert.throws(() => pv.createProvider({ env: { ...w.env, B1_PROVIDER: "perplexity" } }), (e) => e.code === "provider_not_implemented");
  assert.throws(() => pv.createProvider({ env: { B1_PROVIDER: "mock", B1_MOCK_RESPONSES_DIR: "/x" } }), (e) => e.code === "disabled");
  await w.start("token-a", w.P.FA.id);
  const r = json(await w.background(w.dispatched.pop(), { provider: undefined }));
  assert.deepStrictEqual(r, { state: "failed", code: "provider_not_implemented" });
  assert.strictEqual(w.db.T.ledger.length, 0, "no reservation was spent");
});

test("stageb → Planner: held evidence never becomes verified content; missing, tampered, stale or BLOCKED evidence stops the plan", { skip: SKIP }, async () => {
  const w = world();
  for (const c of ["FA", "FC"]) { await w.start("token-a", w.P[c].id); await w.background(w.dispatched.pop()); }
  const fresh = async (c) => w.loadProject(w.P[c].id, U.A);
  const keep = { ...process.env }; Object.assign(process.env, w.env);
  try {
    for (const c of ["FA", "FC"]) {
      const proj = await run.withPlanEvidence(await fresh(c), { env: w.env, store: w.store });
      const v = b1.readBundle(proj.selected_topic.b1Evidence);
      assert.strictEqual(v.status, "PASSED_WITH_HOLDS", c);
      const msg = planLib.buildUserMessage(proj), ver = gate.verifiedFromProject(proj).texts.join("\n");
      for (const x of [...v.held, ...v.excluded]) for (const q of b1.quotesOf(x.finding)) { assert.ok(!msg.includes(q), `${c}: held quotation in the Planner input`); assert.ok(!ver.includes(q), `${c}: held quotation verified`); }
    }
    const fcPlan = await run.withPlanEvidence(await fresh("FC"), { env: w.env, store: w.store });
    assert.ok(!planLib.buildUserMessage(fcPlan).includes(PRIV.cases.fc.held_headline));
    const blockedFor = async (project) => { let called = 0;
      await assert.rejects(planLib.generatePlan({ project: await run.withPlanEvidence(project, { env: w.env, store: w.store }), anthropicKey: "k", callFn: async () => { called++; return "{}"; } }), (e) => e.code === "B1_EVIDENCE_BLOCKED");
      assert.strictEqual(called, 0, "no model call"); };
    await blockedFor(await fresh("FB"));                                                                       // never ran: no evidence
    const row = w.db.T.agent_marketing_article_evidence.find((e) => e.project_id === w.P.FA.id);
    const saved = row.snapshot_text; row.snapshot_text = saved + " (a later version)";                       // tampered stored snapshot
    await blockedFor(await fresh("FA")); row.snapshot_text = saved;
    await blockedFor({ ...(await fresh("FA")), selected_topic: { ...(await fresh("FA")).selected_topic, id: "t-other" } });   // stale: topic changed
    const bad = { ...(await fresh("FC")), article_evidence_id: "99999999-0000-4000-8000-000000000000" };      // pointer to nothing
    await blockedFor(bad);
    const failing = { async forPlan() { throw new Error("db down"); } };
    let called = 0;
    await assert.rejects(planLib.generatePlan({ project: await run.withPlanEvidence(await fresh("FA"), { env: w.env, store: failing }), anthropicKey: "k", callFn: async () => { called++; return "{}"; } }), (e) => e.code === "B1_EVIDENCE_BLOCKED");
    assert.strictEqual(called, 0, "a database failure is BLOCKED, never unevidenced planning");
  } finally { for (const k of Object.keys(process.env)) if (!(k in keep)) delete process.env[k]; Object.assign(process.env, keep); }
  // switch off: the project is unchanged (production path)
  const off = await w.loadProject(w.P.FA.id, U.A);
  assert.strictEqual(await run.withPlanEvidence(off, { env: {}, store: w.store }), off);
});

test("stageb: no production database or provider credentials anywhere in the path", { skip: SKIP }, async () => {
  const w = world();
  await w.start("token-a", w.P.FA.id); await w.background(w.dispatched.pop());
  assert.ok(!JSON.stringify(w.env).includes(PRODUCTION_REF));
  assert.ok(!Object.keys(w.env).some((k) => /ANTHROPIC|PERPLEXITY|OPENAI|STRIPE|SERVICE_ROLE/.test(k)), "no provider or database admin credential is configured");
  assert.ok(w.db.calls.length > 0 && w.db.calls.every((c) => typeof c.table === "string"), "every database call went to the fake");
  assert.strictEqual(w.provider.paid, false);
});

test("stageb fixture mode: FA, FB and FC through the private fixture worker with NO live fetch and NO injected provider reach the approved results", { skip: SKIP }, async () => {
  assert.ok(WF, "the fixture worker is running");
  const fixtureEnv = { B1_WORKER_URL: `https://127.0.0.1:${WF.port}`, B1_PROVIDER: "worker-fixture", B1_SNAPSHOT_SOURCE: "worker-fixture" };
  const w = world({ env: fixtureEnv, provider: undefined });
  const want = { FA: "PASSED_WITH_HOLDS", FB: "COMPLETE", FC: "PASSED_WITH_HOLDS" };
  const keep = global.fetch; const live = [];
  global.fetch = async (u) => { live.push(String(u)); throw new Error("a live fetch was attempted"); };
  try {
    for (const c of ["FA", "FB", "FC"]) {
      await w.start("token-a", w.P[c].id);
      const r = json(await w.background(w.dispatched.pop(), { fetchFn: undefined, provider: undefined }));
      assert.deepStrictEqual([r.state, r.completeness], ["ready", want[c]], c);
      const row = w.db.T.agent_marketing_article_evidence.find((e) => e.project_id === w.P[c].id);
      assert.strictEqual(row.request_text, PRIV.request(c), `${c}: the frozen v1.2.1 request, byte for byte`);
      assert.strictEqual(row.raw_response_text, PRIV.response(c), `${c}: the saved raw response, byte for byte`);
      assert.strictEqual(row.bundle.payload, PRIV.bundle(c).payload, `${c}: the reviewed bundle`);
      assert.strictEqual(row.final_url, M[c].final_url);
      assert.strictEqual(row.provider_seq, 1001);
    }
  } finally { global.fetch = keep; }
  assert.deepStrictEqual(live, [], "no live article or provider fetch");
  assert.strictEqual(w.db.T.ledger.length, 3, "one reservation per case");
});

test("stageb fixture mode: an article outside the FA/FB/FC allowlist fails the snapshot (no live fetch, no reservation, no provider call)", { skip: SKIP }, async () => {
  assert.ok(WF, "the fixture worker is running");
  const w = world({ env: { B1_WORKER_URL: `https://127.0.0.1:${WF.port}`, B1_PROVIDER: "worker-fixture", B1_SNAPSHOT_SOURCE: "worker-fixture" }, provider: undefined });
  const P = w.db.T.agent_marketing_projects.find((p) => p.id === w.P.FA.id);
  P.selected_topic = { ...P.selected_topic, sources: [{ title: "Other", url: "https://example.org/not-a-fixture", role: "primary" }] };
  const keep = global.fetch; let live = 0;
  global.fetch = async () => { live += 1; throw new Error("live fetch"); };
  try {
    await w.start("token-a", w.P.FA.id);
    const r = json(await w.background(w.dispatched.pop(), { fetchFn: undefined, provider: undefined }));
    assert.deepStrictEqual([r.state, r.code], ["failed", "inaccessible"]);
  } finally { global.fetch = keep; }
  assert.strictEqual(live, 0); assert.strictEqual(w.db.T.ledger.length, 0); assert.strictEqual(w.db.T.agent_marketing_article_evidence.length, 0);
});

test("stageb fixture mode is off unless configured: worker-fixture provider needs the worker; the fixture source needs the Stage B flag", { skip: SKIP }, async () => {
  const br = require("../netlify/functions/lib/agent-marketing-b1-bridge-lib");
  assert.strictEqual(br.fixtureSource({ AGENT_MARKETING_B1_EVIDENCE: "dev" }), null, "absent setting: normal live fetch");
  assert.throws(() => br.fixtureSource({ B1_SNAPSHOT_SOURCE: "worker-fixture" }), (e) => e.code === "disabled", "flag off");
  assert.throws(() => br.fixtureSource({ AGENT_MARKETING_B1_EVIDENCE: "dev", B1_SNAPSHOT_SOURCE: "worker-fixture", B1_WORKSPACE: WS }), (e) => e.code === "not_configured", "needs the HTTPS worker");
  assert.throws(() => pv.createProvider({ env: { AGENT_MARKETING_B1_EVIDENCE: "dev", B1_PROVIDER: "worker-fixture", B1_WORKSPACE: WS } }), (e) => e.code === "not_configured");
  assert.throws(() => pv.createProvider({ env: { B1_PROVIDER: "worker-fixture" } }), (e) => e.code === "disabled");
});

