// Run with: npm test   (needs B1_WORKSPACE = the private ssp-b1-evidence workspace, Python 3 with beautifulsoup4 + lxml, and openssl;
// skipped with the reason otherwise; B1_FIXTURES_REQUIRED=1 makes a missing workspace a failure)
// DEVELOPMENT ONLY (Nov 8, 2026, workflow scope correction). The subscriber workflow up to the storyboard boundary, offline:
//   Select Topic → "Write my script" (agent-marketing-stageb { action: "script" } + the background function { mode: "script" })
//   → evidence obtained (snapshot, ledger reservation, MOCK provider with the frozen v1.2.1 response, REAL Python evidence gate on 127.0.0.1)
//     or reused (same project, or a saved research set opened in another project) → the DEVELOPMENT FIXTURE SCRIPT WRITER (no model call)
//   → Edit (agent-marketing-project save_narrative) → Approve (approve_narrative) → storyboard text checks (image descriptions).
// Storage is a fake PostgREST enforcing the proposed migrations' rules; agent-marketing-project.js runs unmodified against it. No production
// database, no provider credentials, no paid call, no network beyond 127.0.0.1.
const test = require("node:test");
const assert = require("node:assert");
const fs = require("fs");
const os = require("os");
const path = require("path");
const crypto = require("crypto");
const { spawn, spawnSync } = require("child_process");
const PRIV = require("./helpers/b1-private");

const WS = PRIV.workspace || "";
const PY = process.env.B1_BRIDGE_PYTHON || "python3";
const SKIP = PRIV.skip || (!fs.existsSync(path.join(WS, "src", "stageb_worker.py")) && "B1_WORKSPACE has no src/stageb_worker.py")
  || (spawnSync("openssl", ["version"]).status !== 0 && "openssl is needed for a throwaway test certificate") || false;
const sha = (s) => crypto.createHash("sha256").update(String(s), "utf8").digest("hex");
const nrm = (s) => String(s).replace(/[‘’]/g, "'").replace(/[“”]/g, '"').replace(/\s+/g, " ").trim();
const SECRET = "s".repeat(48);
const UA = "aaaaaaaa-0000-4000-8000-0000000000a1", UB = "bbbbbbbb-0000-4000-8000-0000000000b2";
const DEV_DB = "https://abcdefghijklmnopqrst.supabase.co";
const M = !SKIP ? JSON.parse(fs.readFileSync(path.join(WS, "frozen", "manifest_cases.json"), "utf8")) : {};

// ── a fake PostgREST enforcing the proposed migrations (evidence, ledger, project pointer R1/R10, research ownership, reuse rows) ────────────────
const db = { T: { agent_marketing_article_evidence: [], agent_marketing_projects: [], agent_marketing_research: [], agent_marketing_jobs: [], ledger: [] }, n: 0 };
const parse = (q) => { const p = new URLSearchParams(String(q || "").replace(/^\?/, "")); const f = []; let limit = 1e9, order = null;
  for (const [k, v] of p) { if (k === "limit") limit = +v; else if (k === "order") order = v; else if (k !== "select") { const i = v.indexOf("."); f.push([k, v.slice(0, i), v.slice(i + 1)]); } }
  return { f, limit, order }; };
const match = (r, f) => f.every(([k, op, v]) => op === "eq" ? String(r[k]) === v : op === "neq" ? String(r[k]) !== v : op === "in" ? v.replace(/[()]/g, "").split(",").includes(String(r[k]))
  : op === "not" && v === "is.null" ? r[k] != null : op === "gte" ? String(r[k]) >= decodeURIComponent(v) : op === "lt" ? String(r[k]) < decodeURIComponent(v) : op === "is" && v === "null" ? r[k] == null : false);
const err = (status, code, message) => ({ status, data: { code, message } });
const FROZEN = ["snapshot_text", "snapshot_sha256", "request_text", "request_sha256", "input_sha256", "cache_key", "user_id", "topic_id", "source_url"];
function rpc(b) {
  const hit = db.T.ledger.find((l) => l.research_id === b.p_research && l.seq === b.p_seq);
  if (hit) return { allowed: true, replayed: true, reservation_id: hit.id };
  const mine = db.T.ledger.filter((l) => l.user_id === b.p_user);
  if (mine.length + 1 > b.p_daily) return { allowed: false, scope: "daily", used: mine.length, limit: b.p_daily };
  const row = { id: crypto.randomUUID(), user_id: b.p_user, research_id: b.p_research, seq: b.p_seq, at: Date.now() }; db.T.ledger.push(row);
  return { allowed: true, replayed: false, reservation_id: row.id };
}
async function supabase(method, table, body, q) {
  if (table === "rpc/agent_marketing_reserve_provider_request") return { status: 200, data: rpc(body) };
  const rows = db.T[table]; if (!rows) return err(404, "42P01", `no table ${table}`);
  const { f, limit, order } = parse(q);
  if (method === "GET") { let out = rows.filter((r) => match(r, f));
    if (order) { const [k, dir] = order.split("."); out = out.slice().sort((a, b) => (a[k] < b[k] ? -1 : a[k] > b[k] ? 1 : 0) * (dir === "desc" ? -1 : 1)); }
    return { status: 200, data: out.slice(0, limit).map((r) => JSON.parse(JSON.stringify(r))) }; }
  if (method === "POST" && table === "agent_marketing_article_evidence") {
    const r = { ...body };
    if (!(r.status === "reserved" || (r.status === "ready" && r.reused_from))) return err(400, "P0001", "a new row is reserved, or ready only as a copy");
    if (r.project_id && !db.T.agent_marketing_projects.some((p) => p.id === r.project_id && p.user_id === r.user_id)) return err(400, "P0001", "user does not own the project");
    const rr = db.T.agent_marketing_research.find((x) => x.id === r.research_id);
    if (r.research_id && r.project_id && !(rr && rr.project_id === r.project_id && rr.user_id === r.user_id)) return err(400, "P0001", "research run does not belong to the project");
    if (r.reused_from) { const o = rows.find((x) => x.id === r.reused_from); if (!(o && o.status === "ready" && o.cache_key === r.cache_key && o.raw_response_sha256 === r.raw_response_sha256)) return err(400, "P0001", "reused_from must be a ready row with the same cache key and raw response"); }
    if (["reserved", "running"].includes(r.status) && rows.some((x) => x.cache_key === r.cache_key && ["reserved", "running"].includes(x.status))) return err(409, "23505", 'duplicate key value violates unique constraint "uq_amae_inflight_cache_key"');
    if (r.status === "ready" && rows.some((x) => x.status === "ready" && x.project_id === r.project_id && x.cache_key === r.cache_key && x.gate_version === r.gate_version)) return err(409, "23505", "uq_amae_project_ready");
    const at = new Date(Date.now() + (db.n++)).toISOString();
    const row = { provider_seq: null, provider_reservation_id: null, error: null, finished_at: null, ...r, id: crypto.randomUUID(), created_at: at, reserved_at: r.reserved_at || at };
    rows.push(row); return { status: 201, data: [{ ...row }] };
  }
  if (method === "PATCH") {
    const out = [];
    for (const old of rows.filter((r) => match(r, f))) {
      const nw = { ...old, ...body };
      if (table === "agent_marketing_projects") {
        // R10: a change of topic or research run clears the pointer unless the same statement sets a new one. R1: the pointer names a ready row of this project and user.
        if ((JSON.stringify(nw.selected_topic) !== JSON.stringify(old.selected_topic) || nw.selected_research_id !== old.selected_research_id) && !("article_evidence_id" in body)) nw.article_evidence_id = null;
        const ev = db.T.agent_marketing_article_evidence.find((e) => e.id === nw.article_evidence_id);
        if (nw.article_evidence_id && !(ev && ev.project_id === nw.id && ev.user_id === nw.user_id && ev.status === "ready")) return err(400, "P0001", "article_evidence_id must name a ready evidence row of this project and user");
      } else if (table === "agent_marketing_article_evidence") {
        if (FROZEN.some((k) => k in body && body[k] !== old[k])) return err(400, "P0001", "immutable");
        if (["ready", "failed"].includes(old.status)) return err(400, "P0001", `a ${old.status} row is final`);
        if (["running", "ready"].includes(nw.status) && nw.status !== old.status && (nw.provider_seq == null || nw.provider_reservation_id == null)) return err(400, "P0001", `${nw.status} requires a provider-request reservation`);
      }
      Object.assign(old, nw); out.push(JSON.parse(JSON.stringify(old)));
    }
    return { status: 200, data: out };
  }
  return err(405, "x", `${method} ${table}`);
}

// The modules that touch the network are replaced before anything loads them (the same pattern as agent-marketing-project.test.js).
let currentUser = UA;
const libPath = require.resolve("../netlify/functions/lib/marketing-profile-lib");
const authPath = require.resolve("../netlify/functions/lib/reel-auth-lib");
require.cache[libPath] = { id: libPath, filename: libPath, loaded: true, exports: { supabase } };
const tokens = { "token-a": UA, "token-b": UB };
require.cache[authPath] = { id: authPath, filename: authPath, loaded: true, exports: { requireUser: async (event) => {
  const t = String(((event && event.headers) || {}).authorization || "").replace(/^Bearer /, "");
  if (t) return tokens[t] ? { user: { id: tokens[t] } } : { error: { status: 401, body: { error: "Please log in again." } } };
  return { user: { id: currentUser } };
} } };
const run = require("../netlify/functions/lib/agent-marketing-b1-stageb-run-lib");
const st = require("../netlify/functions/lib/agent-marketing-b1-store-lib");
const pv = require("../netlify/functions/lib/agent-marketing-b1-provider-lib");
const b1 = require("../netlify/functions/lib/agent-marketing-b1-evidence-lib");
const fx = require("../netlify/functions/lib/agent-marketing-b1-fixture-planner-lib");
const elab = require("../netlify/functions/lib/agent-marketing-image-elaborate-lib");
const stagebFn = require("../netlify/functions/agent-marketing-stageb");
const bgFn = require("../netlify/functions/agent-marketing-stageb-background");
const projectFn = require("../netlify/functions/agent-marketing-project");

// ── the real Python worker on 127.0.0.1 (snapshot + evidence gate) ─────────────────────────────────────────────────────────────────────────
let W = null;
test.before(async () => {
  if (SKIP) return;
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "b1-script-"));
  const cert = path.join(dir, "c.pem"), key = path.join(dir, "k.pem");
  assert.strictEqual(spawnSync("openssl", ["req", "-x509", "-newkey", "rsa:2048", "-nodes", "-keyout", key, "-out", cert, "-days", "1", "-subj", "/CN=127.0.0.1", "-addext", "subjectAltName=IP:127.0.0.1"]).status, 0);
  const proc = spawn(PY, [path.join(WS, "src", "stageb_worker.py")], { env: { PATH: process.env.PATH, B1_WORKER_SECRET: SECRET, B1_WORKER_PORT: "0", B1_WORKER_TLS_CERT: cert, B1_WORKER_TLS_KEY: key }, stdio: ["ignore", "ignore", "pipe"] });
  const port = await new Promise((resolve, reject) => {
    let e = ""; const t = setTimeout(() => reject(new Error(`worker did not start: ${e}`)), 15000);
    proc.stderr.on("data", (d) => { e += d; const m = e.match(/listening on 127\.0\.0\.1:(\d+)/); if (m) { clearTimeout(t); resolve(Number(m[1])); } });
    proc.on("exit", (c) => { clearTimeout(t); reject(new Error(`worker exited ${c}: ${e}`)); });
  });
  W = { proc, port, dir, cert };
  Object.assign(process.env, env());
});
test.after(() => { if (W) { W.proc.kill("SIGKILL"); fs.rmSync(W.dir, { recursive: true, force: true }); } });

const env = (over) => ({ AGENT_MARKETING_B1_EVIDENCE: "dev", AGENT_MARKETING_ENABLED: "true", AGENT_MARKETING_USER_IDS: "", B1_STAGEB_USER_IDS: `${UA},${UB}`,
  SUPABASE_URL: DEV_DB, B1_PROVIDER: "mock", B1_PLANNER: "fixture", ANTHROPIC_API_KEY: "", INTERNAL_API_KEY: "internal-test",
  B1_WORKER_URL: W ? `https://127.0.0.1:${W.port}` : "", B1_WORKER_SECRET: SECRET, B1_WORKER_CA_FILE: W ? W.cert : "", ...(over || {}) });

// ── the subscriber's data: research sets, projects, the frozen pages ─────────────────────────────────────────────────────────────────────────
let seq = 0;
const uid = (p) => `${p}-0000-4000-8000-${String(++seq).padStart(12, "0")}`;
const topicOf = (c, id) => ({ id: id || `t-${c}`, question: "What is the market doing?", whyItMatters: "Pricing decisions.", scope: "selected",
  sources: [{ title: M[c].page_title, url: M[c].final_url, role: "primary" }], candidate: { id: `cand-${c}` } });
/** A research set (five topics in real life; here the cases asked for) owned by a project. copiedFrom: a saved set opened in this project. */
function research(projectId, userId, topics, copiedFrom) {
  const r = { id: uid("11111111"), project_id: projectId, user_id: userId, status: "ready", topics, usage: copiedFrom ? { copiedFrom } : {}, created_at: new Date().toISOString() };
  db.T.agent_marketing_research.push(r); return r;
}
function project(userId, extra) {
  const p = { id: uid("22222222"), user_id: userId, template: "local_market_insider", duration_sec: 45, formats: ["9x16"], status: "draft", narrative: null, article_evidence_id: null,
    intake: { market: "Sacramento County", audience: "Home sellers", angle: "neighborhood", observation: "Buyers are taking their time." }, created_at: new Date(Date.now() + (db.n++)).toISOString(), ...(extra || {}) };
  db.T.agent_marketing_projects.push(p); return p;
}
/** Select Topic, as agent-marketing-research.js stores it (the frozen topic + its research run). */
function select(p, r, topicId) {
  const t = r.topics.find((x) => x.id === topicId);
  return supabase("PATCH", "agent_marketing_projects", { selected_research_id: r.id, selected_topic: { ...t, researchId: r.id }, narrative: null, status: "draft" }, `?id=eq.${p.id}`);
}
const row = (id) => db.T.agent_marketing_projects.find((p) => p.id === id);
const evidenceRows = () => db.T.agent_marketing_article_evidence;
const raw = (c) => fs.readFileSync(path.join(WS, "frozen", "raw", `${c}.html`));
const byUrl = () => Object.fromEntries(["FA", "FB", "FC"].map((c) => [M[c].final_url, c]));
const fetches = [];
const fetchFn = async (url) => { fetches.push(url); return { status: 200, url, headers: { get: () => "text/html; charset=utf-8" }, arrayBuffer: async () => raw(byUrl()[url]) }; };
const responses = () => new Map(["FA", "FB", "FC"].map((c) => [sha(PRIV.request(c)), PRIV.response(c)]));
let provider = null;
const plannerInputs = [];
const realCreate = fx.createCallFn;
fx.createCallFn = (dur) => { const call = realCreate(dur); return async (system, user, ...rest) => { plannerInputs.push(user); return call(system, user, ...rest); }; };   // a spy on what the script writer is given

const storeFor = (e) => { try { return st.createStore({ env: e, request: supabase }); } catch (x) { return null; } };   // none with the switch off
const deps = (over) => ({ env: env(over && over.env), store: storeFor(env(over && over.env)),
  loadProject: async (id, u) => { const r = row(id); return r && r.user_id === u ? JSON.parse(JSON.stringify(r)) : null; },
  requireUser: require.cache[authPath].exports.requireUser, fetchFn: (over && over.fetchFn) || fetchFn, provider: over && "provider" in over ? over.provider : provider,
  sleep: async () => {}, supabase });
const ev = (token, body, extra) => ({ httpMethod: "POST", headers: { authorization: `Bearer ${token}`, host: "b1-stageb-dev--smart-stage-pro.netlify.app", ...(extra || {}) }, body: JSON.stringify(body) });
/** "Write my script", as the page sends it: the script check, then (on dispatch) the background function with its own token. */
async function writeScript(token, p, over) {
  const r = await stagebFn.handler(ev(token, { action: "script", projectId: p.id }), {}, deps(over));
  const body = JSON.parse(r.body);
  if (!(r.statusCode === 202 && body.state === "dispatch")) return { start: r.statusCode, startBody: body };
  const bg = await bgFn.handler(ev(token, { projectId: p.id, mode: "script" }), {}, deps(over));
  return { start: r.statusCode, result: JSON.parse(bg.body), narrative: row(p.id).narrative };
}
const projectCall = async (userId, body) => { currentUser = userId; const r = await projectFn.handler({ httpMethod: "POST", headers: {}, body: JSON.stringify(body) }); return { status: r.statusCode, json: JSON.parse(r.body) }; };
const editWith = (n, line) => {   // the subscriber's edit, sent exactly as the page sends it (scriptBody): the narration text and the CTA only
  const parts = n.scenes.map((s, i) => (i === 2 ? line : s.narrationExcerpt));
  return { narrationTagged: `[conversational] ${parts.join(" ")}`, cta: { text: (n.cta && n.cta.text) || "", source: "user_edited" } };
};
const quotesOf = (c, which) => b1.readBundle(PRIV.bundle(c))[which].flatMap((x) => b1.quotesOf(x.finding));
// Each test starts from an empty database: a completed B1 result is shared by every identical snapshot, so earlier tests would otherwise answer later ones.
const fresh = () => { for (const k of Object.keys(db.T)) db.T[k].length = 0; provider = pv.createProvider({ env: env(), responses: responses() }); plannerInputs.length = 0; fetches.length = 0; };

// ──────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────
test("Write my script on a selected topic: evidence is obtained automatically, then the script; one reservation, one (mock) provider call", { skip: SKIP }, async () => {
  fresh();
  const p = project(UA); const r = research(p.id, UA, [topicOf("FA")]); await select(p, r, "t-FA");
  const before = { ev: evidenceRows().length, ledger: db.T.ledger.length };
  const out = await writeScript("token-a", p);
  assert.strictEqual(out.start, 202);
  assert.deepStrictEqual([out.result.state, out.result.evidence, out.result.fixture], ["ready", "new", true]);
  assert.strictEqual(evidenceRows().length, before.ev + 1); assert.strictEqual(db.T.ledger.length, before.ledger + 1); assert.strictEqual(provider.calls, 1);
  const e = evidenceRows().at(-1);
  assert.deepStrictEqual([e.status, e.completeness_status, e.project_id, e.research_id, e.topic_id], ["ready", "PASSED_WITH_HOLDS", p.id, r.id, "t-FA"]);
  assert.strictEqual(e.bundle.payload, PRIV.bundle("FA").payload, "the stored bundle is the reviewed FA fixture");
  assert.strictEqual(row(p.id).article_evidence_id, e.id, "attached to the project");
  const n = out.narrative;
  assert.strictEqual(n.status, "ready"); assert.strictEqual(row(p.id).status, "narrative_ready"); assert.strictEqual(n.plannerFixture, true);
  assert.strictEqual(n.warnings[0], fx.WARNING, "the fixture script is labelled");
  assert.ok(n.warnings.some((w) => /^Article evidence is INCOMPLETE \(PASSED_WITH_HOLDS\)/.test(w)), "the holds are disclosed to the agent");
  assert.strictEqual(plannerInputs.length, 1, "one script-writer call");
  assert.strictEqual(fetches.length, 1, "the article was read once");
});

test("only validated evidence reaches the script writer; held and excluded findings never do, and never reach the script", { skip: SKIP }, async () => {
  for (const c of ["FA", "FB", "FC"]) {
    fresh();
    const p = project(UA); const r = research(p.id, UA, [topicOf(c)]); await select(p, r, `t-${c}`);
    const out = await writeScript("token-a", p);
    assert.strictEqual(out.result.state, "ready", c);
    const input = JSON.parse(plannerInputs[0]).selected_topic.article_evidence;
    const view = b1.readBundle(PRIV.bundle(c));
    assert.strictEqual(input.status, view.status, c);
    assert.strictEqual(input.held_findings_not_verified, view.held.length, `${c}: a held count only`);
    const given = JSON.stringify(input);
    for (const q of [...quotesOf(c, "held"), ...quotesOf(c, "excluded")]) {
      assert.ok(!given.includes(JSON.stringify(q).slice(1, -1)), `${c}: a held/excluded quotation reached the script writer`);
      assert.ok(!nrm(out.narrative.captionText).includes(nrm(q)), `${c}: a held/excluded quotation reached the script`);
    }
    const validated = quotesOf(c, "validated").map(nrm);
    const articleScene = out.narrative.scenes.find((s) => s.sourceRole === "article");
    assert.ok(articleScene && validated.some((q) => nrm(articleScene.narrationExcerpt).includes(q)), `${c}: the article scene states a validated quotation`);
  }
});

test("Edit and Approve keep the evidence-based checks: held claims and unsupported figures are refused, validated figures pass", { skip: SKIP }, async () => {
  fresh();
  const p = project(UA); const r = research(p.id, UA, [topicOf("FC")]); await select(p, r, "t-FC");
  const out = await writeScript("token-a", p);
  assert.strictEqual(out.result.state, "ready");
  const E = PRIV.cases.e2e;
  for (const line of E.fc_restore_lines) {
    const s = await projectCall(UA, { action: "save_narrative", id: p.id, narrative: editWith(row(p.id).narrative, line) });
    assert.strictEqual(s.status, 422, `restoring the held headline is refused: ${line}`);
  }
  const ok = await projectCall(UA, { action: "save_narrative", id: p.id, narrative: editWith(row(p.id).narrative, E.fc_valid_line) });
  assert.strictEqual(ok.status, 200, `the validated figure, as its quotation gives it, is accepted: ${JSON.stringify(ok.json).slice(0, 300)}`);
  // Approval checks the script again with the same evidence: a written script carrying a figure no validated finding gives is refused
  // (a number the agent types into an edit is the agent's own claim under the existing gate rules; held and article figures are checked above).
  const saved = JSON.parse(JSON.stringify(row(p.id).narrative));
  const tampered = { ...saved, source: "claude", narrationTagged: `${saved.narrationTagged} ${E.fc_unsupported_line}`, captionText: `${saved.captionText} ${E.fc_unsupported_line}` };
  row(p.id).narrative = tampered;
  const refused = await projectCall(UA, { action: "approve_narrative", id: p.id });
  assert.strictEqual(refused.status, 422, "approval re-checks a written figure against the evidence");
  row(p.id).narrative = saved;
  const ap = await projectCall(UA, { action: "approve_narrative", id: p.id });
  assert.strictEqual(ap.status, 200, JSON.stringify(ap.json).slice(0, 300));
  assert.strictEqual(row(p.id).status, "narrative_approved");
  assert.ok(!JSON.stringify(row(p.id).selected_topic).includes("b1Evidence"), "the evidence is read for each check, never written onto the project");
});

test("without valid attached evidence an Article-Led script cannot be approved", { skip: SKIP }, async () => {
  fresh();
  const p = project(UA); const r = research(p.id, UA, [topicOf("FB")]); await select(p, r, "t-FB");
  assert.strictEqual((await writeScript("token-a", p)).result.state, "ready");
  row(p.id).article_evidence_id = null;   // e.g. the evidence row's link was cleared
  const ap = await projectCall(UA, { action: "approve_narrative", id: p.id });
  assert.deepStrictEqual([ap.status, ap.json.code], [409, "evidence_blocked"]);
  assert.strictEqual(row(p.id).status, "narrative_ready");
});

test("storyboard text checks use the same evidence: a validated figure passes, a held claim is refused, and both are refused without evidence", { skip: SKIP }, async () => {
  fresh();
  const p = project(UA); const r = research(p.id, UA, [topicOf("FC")]); await select(p, r, "t-FC");
  assert.strictEqual((await writeScript("token-a", p)).result.state, "ready");
  const E = PRIV.cases.e2e;
  const withEv = await run.withPlanEvidence(JSON.parse(JSON.stringify(row(p.id))));
  assert.strictEqual(elab.checkText(withEv, E.fc_valid_line, false).ok, true, "validated figure in scene text");
  assert.strictEqual(elab.checkText(withEv, E.fc_restore_lines[0], false).ok, false, "held claim in scene text");
  assert.strictEqual(elab.checkText(JSON.parse(JSON.stringify(row(p.id))), E.fc_valid_line, false).ok, false, "without evidence the article figure has no source");
  const src = fs.readFileSync(path.join(__dirname, "..", "netlify", "functions", "agent-marketing-images.js"), "utf8");
  assert.match(src, /article_evidence_id&limit=1`\);[\s\S]{0,400}withPlanEvidence\(row\)/, "the images step loads its project with the attached evidence");
});

test("returning to a saved topic: no new research and no new evidence (same project after switching topics, or a new project)", { skip: SKIP }, async () => {
  fresh();
  const p = project(UA); const r1 = research(p.id, UA, [topicOf("FA"), topicOf("FB")]);
  await select(p, r1, "t-FA");
  assert.strictEqual((await writeScript("token-a", p)).result.state, "ready");
  const original = evidenceRows().at(-1);
  // switch to the other topic and back: the pointer is cleared by the topic change, the FA evidence is found again
  await select(p, r1, "t-FB"); assert.strictEqual(row(p.id).article_evidence_id, null);
  await select(p, r1, "t-FA");
  const counts = () => [evidenceRows().length, db.T.ledger.length, provider.calls, fetches.length, db.T.agent_marketing_research.length];
  const c0 = counts();
  const again = await writeScript("token-a", p);
  assert.deepStrictEqual([again.result.state, again.result.evidence], ["ready", "reused"]);
  assert.deepStrictEqual(counts(), c0, "no new evidence row, reservation, provider call, article fetch or research");
  assert.strictEqual(row(p.id).article_evidence_id, original.id);
  // a new project opens the saved set (agent-marketing-research copies it into the project: usage.copiedFrom) and picks the same topic
  const p2 = project(UA); const r1c = research(p2.id, UA, r1.topics, r1.id); await select(p2, r1c, "t-FA");
  const c1 = counts();
  const reuse = await writeScript("token-a", p2);
  assert.deepStrictEqual([reuse.result.state, reuse.result.evidence], ["ready", "reused"]);
  const ref = evidenceRows().at(-1);
  const origin = original.reused_from || original.id;   // the original evidence row (FA may itself have been reused from an identical earlier snapshot)
  assert.deepStrictEqual([ref.reused_from, ref.project_id, ref.research_id, ref.provider_seq, ref.provider_reservation_id], [origin, p2.id, r1c.id, null, null], "a provenance-linked reuse row");
  assert.deepStrictEqual([ref.snapshot_sha256, ref.cache_key, ref.raw_response_sha256, ref.bundle.payload_sha256], [original.snapshot_sha256, original.cache_key, original.raw_response_sha256, original.bundle.payload_sha256]);
  assert.deepStrictEqual(counts(), [c1[0] + 1, c1[1], c1[2], c1[3], c1[4]], "one reuse row; no reservation, provider call, article fetch or research");
  assert.strictEqual(reuse.narrative.status, "ready");
  // a third project that opens a copy of the copy still leads back to the original evidence row
  const p3 = project(UA); const r1cc = research(p3.id, UA, r1.topics, r1c.id); await select(p3, r1cc, "t-FA");
  assert.strictEqual((await writeScript("token-a", p3)).result.evidence, "reused");
  assert.strictEqual(evidenceRows().at(-1).reused_from, origin, "never a copy of a copy");
});

test("reuse is refused unless ownership, topic identity and source version all match", { skip: SKIP }, async () => {
  fresh();
  const pa = project(UA); const ra = research(pa.id, UA, [topicOf("FB")]); await select(pa, ra, "t-FB");
  assert.strictEqual((await writeScript("token-a", pa)).result.evidence, "new");
  const calls0 = provider.calls;
  // another user with the same topic id and article: saved-topic reuse never applies (no lineage, not B's row). B's own article is read; only an
  // IDENTICAL snapshot may then share the completed B1 result (the existing cache-key rule, which copies the result into a row B owns).
  const pb = project(UB); const rb = research(pb.id, UB, [topicOf("FB")]); await select(pb, rb, "t-FB");
  const fb0 = fetches.length;
  const b = await writeScript("token-b", pb);
  assert.strictEqual(b.result.state, "ready");
  assert.strictEqual(fetches.length, fb0 + 1, "B's article was read: not the saved-topic path");
  const be = evidenceRows().find((e) => e.id === row(pb.id).article_evidence_id);
  assert.deepStrictEqual([be.user_id, be.project_id, be.research_id], [UB, pb.id, rb.id], "B's own row, for B's own project and research");
  assert.strictEqual(be.snapshot_sha256, evidenceRows().find((e) => e.project_id === pa.id).snapshot_sha256, "shared only because the snapshot is identical");
  // same user, an unrelated research set whose topic has the same id but another article: never the FB evidence; its own article is read
  const pc = project(UA); const rc = research(pc.id, UA, [topicOf("FC", "t-FB")]); await select(pc, rc, "t-FB");
  const f0 = fetches.length;
  const c = await writeScript("token-a", pc);
  assert.strictEqual(c.result.state, "ready");
  const ce = evidenceRows().find((e) => e.id === row(pc.id).article_evidence_id);
  assert.strictEqual(ce.source_url, M.FC.final_url, "the evidence for its own article");
  assert.strictEqual(fetches.length, f0 + 1, "its article was read (only an identical snapshot may share a completed B1 result)");
  assert.ok(provider.calls >= calls0);
});

test("topic ids repeat across research sets: switching to another set's topic with the same id never uses the first set's evidence", { skip: SKIP }, async () => {
  fresh();
  const p = project(UA);
  const r1 = research(p.id, UA, [topicOf("FA", "t1")]); const r2 = research(p.id, UA, [topicOf("FB", "t1")]);
  await select(p, r1, "t1"); assert.strictEqual((await writeScript("token-a", p)).result.state, "ready");
  await select(p, r2, "t1");
  const out = await writeScript("token-a", p);
  assert.deepStrictEqual([out.result.state, out.result.evidence], ["ready", "new"]);
  const e = evidenceRows().find((x) => x.id === row(p.id).article_evidence_id);
  assert.deepStrictEqual([e.research_id, e.source_url], [r2.id, M.FB.final_url]);
  assert.strictEqual(out.narrative.status, "ready");
});

test("failures stop the script and say why; 'no analysis cost' is said only when no provider request was made", { skip: SKIP }, async () => {
  // the article cannot be read: no evidence row, no reservation, no provider call, no script-writer call
  fresh();
  const p1 = project(UA); const r1 = research(p1.id, UA, [topicOf("FA")]); await select(p1, r1, "t-FA");
  const gone = async (url) => ({ status: 410, url, headers: { get: () => "text/html" }, arrayBuffer: async () => Buffer.from("gone") });
  const n0 = evidenceRows().length, l0 = db.T.ledger.length;
  const a = await writeScript("token-a", p1, { fetchFn: gone });
  assert.deepStrictEqual([a.result.state, a.result.code], ["failed", "http_error"]);
  assert.strictEqual(a.narrative.status, "error"); assert.match(a.narrative.error, /^Your script was not written: the article's website answered with an error\. No article analysis was run, so there is no analysis cost\./);
  assert.deepStrictEqual(a.narrative.evidence, { code: "http_error", providerAttempted: false });
  assert.deepStrictEqual([evidenceRows().length, db.T.ledger.length, provider.calls, plannerInputs.length], [n0, l0, 0, 0]);
  assert.strictEqual((await projectCall(UA, { action: "approve_narrative", id: p1.id })).status, 409, "nothing to approve");
  // the provider was called and failed: the message says a request was made (never "no cost")
  fresh();
  const p2 = project(UA); const r2 = research(p2.id, UA, [topicOf("FB")]); await select(p2, r2, "t-FB");
  const flaky = { name: "mock", calls: 0, async call() { this.calls++; const e = new Error("upstream"); e.code = "provider_error"; throw e; } };
  const b = await writeScript("token-a", p2, { provider: flaky });
  assert.deepStrictEqual([b.result.state, b.result.code, flaky.calls], ["failed", "provider_error", 1]);
  assert.match(b.narrative.error, /An article analysis request was made, so it counts toward your usage\./);
  assert.ok(!/no analysis cost/.test(b.narrative.error));
  assert.deepStrictEqual(b.narrative.evidence, { code: "provider_error", providerAttempted: true });
  assert.strictEqual(plannerInputs.length, 0, "no script writer without evidence");
  // the live provider does not exist: refused before any reservation
  fresh();
  const p3 = project(UA); const r3 = research(p3.id, UA, [topicOf("FC")]); await select(p3, r3, "t-FC");
  const l3 = db.T.ledger.length;
  const c = await writeScript("token-a", p3, { provider: null });
  assert.deepStrictEqual([c.result.state, c.result.code, c.narrative.evidence.providerAttempted], ["failed", "provider_not_implemented", false]);
  assert.strictEqual(db.T.ledger.length, l3); assert.strictEqual(plannerInputs.length, 0);
});

test("script mode is refused where it must not run, and refuses without a configured script writer (nothing is written)", { skip: SKIP }, async () => {
  fresh();
  const p = project(UA); const r = research(p.id, UA, [topicOf("FA")]); await select(p, r, "t-FA");
  const start = async (over, token, extra) => { const x = await stagebFn.handler(ev(token || "token-a", { action: "script", projectId: p.id }, extra), {}, deps(over)); return [x.statusCode, JSON.parse(x.body).code]; };
  assert.deepStrictEqual((await start({ env: { AGENT_MARKETING_B1_EVIDENCE: "" } }))[0], 404);
  assert.deepStrictEqual((await start({ env: { B1_STAGEB_USER_IDS: "" } }))[0], 404);
  assert.deepStrictEqual(await start({ env: { SUPABASE_URL: "https://dnpaenpwdhjmslymgkse.supabase.co" } }), [503, "production_database_refused"]);
  assert.deepStrictEqual((await start({}, "token-a", { host: "smartstagepro.com" }))[0], 503, "never on a production host");
  assert.deepStrictEqual((await start({}, "token-b"))[0], 404, "another user's project reads as missing");
  assert.deepStrictEqual(await start({ env: { B1_PLANNER: "", ANTHROPIC_API_KEY: "" } }), [500, "not_configured"]);
  assert.strictEqual(row(p.id).narrative, null, "no planning stub was written by any refused request");
  // the background function does nothing for a project that has no planning stub
  const bg = await bgFn.handler(ev("token-a", { projectId: p.id, mode: "script" }), {}, deps());
  assert.deepStrictEqual(JSON.parse(bg.body), { state: "skipped", code: "no_stub" });
  assert.strictEqual(provider.calls, 0); assert.strictEqual(fetches.length, 0);
  // the fixture script writer exists only with the B1 switch, B1_PLANNER=fixture and a non-production database
  assert.strictEqual(fx.enabled(env()), true);
  assert.strictEqual(fx.enabled(env({ AGENT_MARKETING_B1_EVIDENCE: "" })), false);
  assert.strictEqual(fx.enabled(env({ B1_PLANNER: "" })), false);
  assert.strictEqual(fx.enabled(env({ SUPABASE_URL: "https://dnpaenpwdhjmslymgkse.supabase.co" })), false);
  assert.strictEqual(fx.enabled(env({ SUPABASE_URL: "" })), false);
});

test("a second Write my script for the same answers is refused like the production path (one script per set of answers)", { skip: SKIP }, async () => {
  fresh();
  const p = project(UA); const r = research(p.id, UA, [topicOf("FB")]); await select(p, r, "t-FB");
  assert.strictEqual((await writeScript("token-a", p)).result.state, "ready");
  const again = await writeScript("token-a", p);
  assert.deepStrictEqual([again.start, again.startBody.code], [409, "script_exists"]);
  assert.strictEqual(plannerInputs.length, 1);
});
