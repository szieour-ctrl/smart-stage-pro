// Run with: npm test   (needs B1_WORKSPACE = the private ssp-b1-evidence workspace, Python 3 with beautifulsoup4 + lxml, and openssl;
// skipped with the reason otherwise; B1_FIXTURES_REQUIRED=1 makes a missing workspace a failure)
// DEVELOPMENT ONLY (Nov 5, 2026). The Stage B bridge over the private HTTPS worker (B1 workspace src/stageb_worker.py), offline:
// the worker runs on 127.0.0.1 with a throwaway self-signed certificate; SSP's bridge reaches it ONLY through B1_WORKER_URL (no B1_WORKSPACE),
// signs every request, accepts only replies signed for that request, and still re-checks every reply itself. No provider call.
const test = require("node:test");
const assert = require("node:assert");
const fs = require("fs");
const os = require("os");
const path = require("path");
const https = require("https");
const { spawn, spawnSync } = require("child_process");
const br = require("../netlify/functions/lib/agent-marketing-b1-bridge-lib");
const sb = require("../netlify/functions/lib/agent-marketing-b1-stageb-lib");
const b1 = require("../netlify/functions/lib/agent-marketing-b1-evidence-lib");
const PRIV = require("./helpers/b1-private");

const WS = PRIV.workspace || "";
const PY = process.env.B1_BRIDGE_PYTHON || "python3";
const SKIP = PRIV.skip || (!fs.existsSync(path.join(WS, "src", "stageb_worker.py")) && "B1_WORKSPACE has no src/stageb_worker.py")
  || (spawnSync("openssl", ["version"]).status !== 0 && "openssl is needed for a throwaway test certificate") || false;
const SECRET = "s".repeat(48);
const M = !SKIP ? JSON.parse(fs.readFileSync(path.join(WS, "frozen", "manifest_cases.json"), "utf8")) : {};
const raw = (c) => fs.readFileSync(path.join(WS, "frozen", "raw", `${c}.html`));

let W = null;   // { proc, port, dir, cert, key }
async function startWorker() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "b1w-node-"));
  const cert = path.join(dir, "c.pem"), key = path.join(dir, "k.pem");
  const r = spawnSync("openssl", ["req", "-x509", "-newkey", "rsa:2048", "-nodes", "-keyout", key, "-out", cert, "-days", "1", "-subj", "/CN=127.0.0.1", "-addext", "subjectAltName=IP:127.0.0.1"]);
  assert.strictEqual(r.status, 0, String(r.stderr));
  const proc = spawn(PY, [path.join(WS, "src", "stageb_worker.py")], { env: { PATH: process.env.PATH, B1_WORKER_SECRET: SECRET, B1_WORKER_PORT: "0", B1_WORKER_TLS_CERT: cert, B1_WORKER_TLS_KEY: key }, stdio: ["ignore", "ignore", "pipe"] });
  const port = await new Promise((resolve, reject) => {
    let err = ""; const t = setTimeout(() => reject(new Error(`worker did not start: ${err}`)), 15000);
    proc.stderr.on("data", (d) => { err += d; const m = err.match(/listening on 127\.0\.0\.1:(\d+)/); if (m) { clearTimeout(t); resolve(Number(m[1])); } });
    proc.on("exit", (code) => { clearTimeout(t); reject(new Error(`worker exited ${code}: ${err}`)); });
  });
  W = { proc, port, dir, cert, key };
}
test.before(async () => { if (!SKIP) await startWorker(); });
test.after(() => { if (W) { W.proc.kill("SIGKILL"); fs.rmSync(W.dir, { recursive: true, force: true }); } });

const env = (over) => ({ AGENT_MARKETING_B1_EVIDENCE: "dev", B1_WORKER_URL: `https://127.0.0.1:${W.port}`, B1_WORKER_SECRET: SECRET, B1_WORKER_CA_FILE: W.cert, ...(over || {}) });
function memStore() {
  const rows = []; let n = 0;
  return { rows,
    async findForProject(pid, tid) { return rows.filter((r) => r.project_id === pid && r.topic_id === tid && r.status !== "failed").pop() || null; },
    async findLive(key) { return rows.find((r) => r.cache_key === key && ["reserved", "running"].includes(r.status)) || rows.find((r) => r.cache_key === key && r.status === "ready") || null; },
    async insert(r) { if (["reserved", "running"].includes(r.status) && rows.some((x) => x.cache_key === r.cache_key && ["reserved", "running"].includes(x.status))) throw Object.assign(new Error("in flight"), { code: "in_progress" }); const row = { ...r, id: `ev-${++n}` }; rows.push(row); return row; },
    async update(id, f, expect) { const i = rows.findIndex((x) => x.id === id); if (expect && rows[i].status !== expect) throw new Error("conflict"); rows[i] = { ...rows[i], ...f }; return rows[i]; } };
}
const fetchFrom = (c) => async (url) => ({ status: 200, url, headers: { get: () => "text/html; charset=utf-8" }, arrayBuffer: async () => raw(c) });
const project = (c) => ({ id: `p-${c}`, template: "local_market_insider", selected_topic: { id: `t-${c}`, researchId: `r-${c}`, question: "q", whyItMatters: "w", scope: "selected",
  sources: [{ title: M[c] && M[c].page_title, url: M[c] && M[c].final_url, role: "primary" }], candidate: { id: `cand-${c}` } } });

test("worker: FA, FB and FC through the HTTPS worker reproduce the frozen v1.2.1 requests and the reviewed bundles", { skip: SKIP }, async () => {
  const store = memStore(), E = env();
  assert.ok(!("B1_WORKSPACE" in E), "SSP needs no local B1 workspace with the worker");
  const want = { FA: "PASSED_WITH_HOLDS", FB: "COMPLETE", FC: "PASSED_WITH_HOLDS" };
  for (const c of ["FA", "FB", "FC"]) {
    const p = project(c);
    const { record, reused } = await br.prepare({ project: p, userId: "u1", store, fetchFn: fetchFrom(c), env: E, now: "2026-11-05T06:00:00Z" });
    assert.strictEqual(reused, false);
    assert.strictEqual(record.request_text, PRIV.request(c), `${c}: byte-for-byte the frozen request`);
    const done = await br.complete({ record, responseText: PRIV.response(c), store, env: E });   // the saved response stands in for the provider call
    assert.strictEqual(done.completeness_status, want[c], c);
    assert.strictEqual(done.bundle.payload, PRIV.bundle(c).payload, `${c}: the reviewed bundle`);
    assert.deepStrictEqual(sb.checkRecord(done, p), [], c);
    assert.strictEqual(b1.readBundle(sb.topicWithEvidence(p, done, E).b1Evidence).status, want[c]);
  }
  // FA A1 stays held; A6 and A7 validated; FC's held headline is not in the Planner evidence
  const fa = b1.readBundle(store.rows.find((r) => r.project_id === "p-FA").bundle);
  assert.deepStrictEqual(Object.values(PRIV.faItems(fa.validated, PRIV.cases)), [false, true, true]);
  const fc = b1.plannerArticleEvidence(b1.readBundle(store.rows.find((r) => r.project_id === "p-FC").bundle));
  assert.ok(!JSON.stringify(fc).includes(PRIV.cases.fc.held_headline));
});

test("worker: a wrong secret, plain http or a missing configuration fails closed", { skip: SKIP }, async () => {
  const store = memStore();
  await assert.rejects(br.prepare({ project: project("FA"), userId: "u", store, fetchFn: fetchFrom("FA"), env: env({ B1_WORKER_SECRET: "x".repeat(48) }) }), (e) => e.code === "bridge_auth");
  await assert.rejects(br.callBridge("gate", {}, env({ B1_WORKER_URL: `http://127.0.0.1:${W.port}` })), (e) => e.code === "not_configured");
  await assert.rejects(br.callBridge("gate", {}, env({ B1_WORKER_SECRET: "short" })), (e) => e.code === "not_configured");
  await assert.rejects(br.callBridge("gate", {}, { AGENT_MARKETING_B1_EVIDENCE: "dev" }), (e) => e.code === "not_configured");
  await assert.rejects(br.callBridge("gate", {}, { B1_WORKER_URL: `https://127.0.0.1:${W.port}`, B1_WORKER_SECRET: SECRET }), (e) => e.code === "disabled");
  await assert.rejects(br.callBridge("gate", {}, env({ B1_WORKER_CA_FILE: "" })), (e) => e.code === "bridge_unavailable", "an untrusted certificate is refused");
  assert.strictEqual(store.rows.length, 0, "nothing was stored");
});

test("worker: Node rejects forged, unsigned or replayed replies, and still re-checks a correctly signed one", { skip: SKIP }, async () => {
  // A stand-in server on the same certificate. It knows the secret only where a test says so.
  let mode = "unsigned", saved = null;
  const s = https.createServer({ cert: fs.readFileSync(W.cert), key: fs.readFileSync(W.key) }, (req, res) => {
    let body = ""; req.on("data", (d) => (body += d)); req.on("end", () => {
      const nonce = req.headers["x-b1-nonce"];
      const real = JSON.parse(saved); const out = Buffer.from(JSON.stringify(mode === "tampered" ? { ...real, snapshot_text: real.snapshot_text + " (a later version)" } : real));
      const sig = mode === "unsigned" ? undefined : mode === "replayed" ? br.replySignature(SECRET, "an-earlier-request-nonce", 200, out) : br.replySignature(SECRET, nonce, 200, out);
      res.writeHead(200, { "Content-Type": "application/json", ...(sig ? { "X-B1-Response-Signature": sig } : {}) }); res.end(out);
    });
  });
  await new Promise((r) => s.listen(0, "127.0.0.1", r));
  const E = env({ B1_WORKER_URL: `https://127.0.0.1:${s.address().port}` });
  try {
    saved = JSON.stringify(await br.callBridge("snapshot", { url: M.FA.final_url, title: M.FA.page_title, html_b64: raw("FA").toString("base64") }, env()));   // a genuine worker reply
    const store = memStore();
    for (const [m, code] of [["unsigned", "bridge_auth"], ["replayed", "bridge_auth"], ["tampered", "snapshot_inconsistent"]]) {
      mode = m;
      await assert.rejects(br.prepare({ project: project("FA"), userId: "u", store, fetchFn: fetchFrom("FA"), env: E }), (e) => e.code === code, m);
    }
    assert.strictEqual(store.rows.length, 0, "nothing was stored");
  } finally { await new Promise((r) => s.close(r)); }
});
