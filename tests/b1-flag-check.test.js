// b1-flag-check (temporary): answers only on the b1-stageb-dev branch deploy against the development database; reports whether
// AGENT_MARKETING_ENABLED evaluates to on and whether the fixture worker accepts this deploy's B1_WORKER_SECRET, never a value.
const test = require("node:test");
const assert = require("node:assert");
const fs = require("fs");
const os = require("os");
const path = require("path");
const http = require("http");
const { spawn } = require("child_process");
const fn = require("../netlify/functions/b1-flag-check");
const am = require("../netlify/functions/lib/agent-marketing-lib");
const br = require("../netlify/functions/lib/agent-marketing-b1-bridge-lib");
const { BRANCH_HOST, DEV_URL, PROBE_URL, PROBE_PATH } = fn._internals;

const SECRET = "S".repeat(64), OTHER = "O".repeat(64);
const workerEnv = { AGENT_MARKETING_B1_EVIDENCE: "dev", B1_WORKER_URL: "https://worker.example.test", B1_WORKER_SECRET: SECRET };
const base = { CONTEXT: "branch-deploy", BRANCH: "b1-stageb-dev", SUPABASE_URL: DEV_URL };
const call = (host, env, post) => fn.handler({ headers: { host } }, {}, { env, post: post || (async () => { throw new Error("no worker in this test"); }) });

// A fake worker following the real contract (ssp-b1-evidence src/stageb_worker.py): it verifies the request with ITS secret; authenticated
// replies are signed for the request's nonce, unauthenticated ones are not.
function fakeWorker(workerSecret, { authedStatus = 404, authedCode = "not_in_fixture_allowlist", seen } = {}) {
  return async (url, pathname, h, body) => {
    if (seen) seen.push({ url: String(url), pathname, body: JSON.parse(body.toString("utf8")), headers: Object.keys(h) });
    const want = require("crypto").createHmac("sha256", workerSecret).update(`b1-stageb-req/1\nPOST\n${pathname}\n${h["X-B1-Timestamp"]}\n${h["X-B1-Nonce"]}\n${require("crypto").createHash("sha256").update(body).digest("hex")}`).digest("hex");
    if (want !== h["X-B1-Signature"]) return { status: 401, signature: "", body: Buffer.from('{"ok": false, "code": "bad_signature"}') };
    const out = Buffer.from(JSON.stringify({ ok: false, code: authedCode }));
    return { status: authedStatus, signature: br.replySignature(workerSecret, h["X-B1-Nonce"], authedStatus, out), body: out };
  };
}

test("b1-flag-check: 404 on every other host, a present-but-different context or branch, and any non-development database", async () => {
  for (const h of ["smartstagepro.com", "smart-stage-pro.netlify.app", "main--smart-stage-pro.netlify.app", "deploy-preview-219--smart-stage-pro.netlify.app", ""]) {
    assert.strictEqual((await call(h, { ...base, AGENT_MARKETING_ENABLED: "true" })).statusCode, 404, h);
  }
  assert.strictEqual((await call(BRANCH_HOST, { ...base, CONTEXT: "production", AGENT_MARKETING_ENABLED: "true" })).statusCode, 404);
  assert.strictEqual((await call(BRANCH_HOST, { ...base, CONTEXT: "deploy-preview", AGENT_MARKETING_ENABLED: "true" })).statusCode, 404);
  assert.strictEqual((await call(BRANCH_HOST, { ...base, BRANCH: "main", AGENT_MARKETING_ENABLED: "true" })).statusCode, 404);
  for (const db of ["https://dnpaenpwdhjmslymgkse.supabase.co", "https://other.supabase.co", "", undefined]) {
    assert.strictEqual((await call(BRANCH_HOST, { ...base, SUPABASE_URL: db, AGENT_MARKETING_ENABLED: "true" })).statusCode, 404, String(db));
  }
});

test("b1-flag-check: answers when Netlify does not expose CONTEXT/BRANCH to the function at runtime, and says so", async () => {
  for (const [env, runtime] of [
    [{ SUPABASE_URL: DEV_URL }, { context: "unset", branch: "unset" }],
    [{ SUPABASE_URL: DEV_URL, CONTEXT: "branch-deploy" }, { context: "branch-deploy", branch: "unset" }],
    [{ SUPABASE_URL: DEV_URL, BRANCH: "b1-stageb-dev" }, { context: "unset", branch: "b1-stageb-dev" }],
    [base, { context: "branch-deploy", branch: "b1-stageb-dev" }],
  ]) {
    const r = await call(BRANCH_HOST, { ...env, AGENT_MARKETING_ENABLED: "true" });
    assert.strictEqual(r.statusCode, 200, JSON.stringify(env));
    const b = JSON.parse(r.body);
    assert.strictEqual(b.agentMarketingEnabled, true);
    assert.deepStrictEqual(b.runtime, runtime);
  }
});

test("b1-flag-check: agentMarketingEnabled is one boolean by the feature's own rule; the value is never returned", async () => {
  const uid = "f3abd467-cf79-455d-bdae-a2b32bafaa17";
  for (const v of ["true", " TRUE ", "True", "false", "1", "yes", "", undefined, "SECRET-NEVER-SHOWN"]) {
    const r = await call(BRANCH_HOST, { ...base, AGENT_MARKETING_ENABLED: v });
    assert.strictEqual(r.statusCode, 200);
    const b = JSON.parse(r.body);
    assert.deepStrictEqual(Object.keys(b), ["agentMarketingEnabled", "runtime", "workerAuth", "workerAuthCode", "workerStatus", "workerRefusal", "clockSkewSec", "deploy", "secret", "stagebCaps"]);
    assert.strictEqual(typeof b.agentMarketingEnabled, "boolean");
    assert.strictEqual(b.agentMarketingEnabled, am.isEnabledFor(uid, { AGENT_MARKETING_ENABLED: v }), String(v));
    assert.ok(!r.body.includes("SECRET-NEVER-SHOWN") && !r.body.includes(DEV_URL));
  }
});

test("b1-flag-check workerAuth: matching secret → true via the signed not_in_fixture_allowlist reply; one non-allowlisted probe, no secret in the answer", async () => {
  const seen = [];
  const r = await call(BRANCH_HOST, { ...base, ...workerEnv }, fakeWorker(SECRET, { seen }));
  const b = JSON.parse(r.body);
  assert.deepStrictEqual([b.workerAuth, b.workerAuthCode, b.workerStatus], [true, "accepted_not_in_allowlist", 404]);
  assert.strictEqual(seen.length, 1);
  assert.strictEqual(seen[0].pathname, PROBE_PATH);
  assert.deepStrictEqual(seen[0].body, { url: PROBE_URL });
  assert.ok(/\.invalid\//.test(PROBE_URL), "the probe URL is under the reserved .invalid domain, never a fixture");
  for (const s of [SECRET, "worker.example.test"]) assert.ok(!r.body.includes(s), s);
});

test("b1-flag-check workerAuth: wrong secret → false (401, unsigned)", async () => {
  const b = JSON.parse((await call(BRANCH_HOST, { ...base, ...workerEnv }, fakeWorker(OTHER))).body);
  assert.deepStrictEqual([b.workerAuth, b.workerAuthCode, b.workerStatus], [false, "rejected_401_unsigned", 401]);
});

test("b1-flag-check workerAuth: an unsigned 404 (e.g. unknown path) or a reply signed with another secret is NOT authentication", async () => {
  const unsigned404 = async () => ({ status: 404, signature: "", body: Buffer.from('{"ok": false, "code": "not_found"}') });
  let b = JSON.parse((await call(BRANCH_HOST, { ...base, ...workerEnv }, unsigned404)).body);
  assert.deepStrictEqual([b.workerAuth, b.workerAuthCode, b.workerStatus], [false, "unsigned_reply", 404]);
  const forged = async (url, p, h) => { const out = Buffer.from('{"ok": false, "code": "not_in_fixture_allowlist"}'); return { status: 404, signature: br.replySignature(OTHER, h["X-B1-Nonce"], 404, out), body: out }; };
  b = JSON.parse((await call(BRANCH_HOST, { ...base, ...workerEnv }, forged)).body);
  assert.deepStrictEqual([b.workerAuth, b.workerAuthCode], [false, "unsigned_reply"]);
  const otherNonce = async (url, p, h) => { const out = Buffer.from('{"ok": false, "code": "not_in_fixture_allowlist"}'); return { status: 404, signature: br.replySignature(SECRET, "someone-elses-nonce", 404, out), body: out }; };
  b = JSON.parse((await call(BRANCH_HOST, { ...base, ...workerEnv }, otherNonce)).body);
  assert.strictEqual(b.workerAuth, false, "a signature for another request's nonce is not accepted");
});

test("b1-flag-check workerAuth: signed but unexpected reply, unreachable worker, and missing configuration", async () => {
  let b = JSON.parse((await call(BRANCH_HOST, { ...base, ...workerEnv }, fakeWorker(SECRET, { authedStatus: 503, authedCode: "fixtures_unavailable" }))).body);
  assert.deepStrictEqual([b.workerAuth, b.workerAuthCode, b.workerStatus], [true, "accepted_unexpected_reply", 503]);
  b = JSON.parse((await call(BRANCH_HOST, { ...base, ...workerEnv }, async () => { throw new Error("ECONNREFUSED"); })).body);
  assert.deepStrictEqual([b.workerAuth, b.workerAuthCode, b.workerStatus], [null, "unreachable", null]);
  for (const over of [{ AGENT_MARKETING_B1_EVIDENCE: "" }, { B1_WORKER_URL: "" }, { B1_WORKER_URL: "http://worker.example.test" }, { B1_WORKER_SECRET: "short" }]) {
    let called = false;
    b = JSON.parse((await call(BRANCH_HOST, { ...base, ...workerEnv, ...over }, async () => { called = true; return {}; })).body);
    assert.deepStrictEqual([b.workerAuth, b.workerAuthCode], [null, "not_configured"], JSON.stringify(over));
    assert.strictEqual(called, false, "no request when the worker is not configured");
  }
});

// Against the REAL worker code (ssp-b1-evidence src/stageb_worker.py, fixture mode on, plaintext on 127.0.0.1). Without the frozen fixture files the
// worker answers authenticated fixture requests with a signed 503 fixtures_unavailable, which still proves the signature path end to end.
const WORKER_PY = [process.env.B1_WORKER_SRC, process.env.B1_WORKSPACE && path.join(process.env.B1_WORKSPACE, "src", "stageb_worker.py")].find((p) => p && fs.existsSync(p));
test("b1-flag-check workerAuth against the real worker code: right secret → true, wrong secret → false", { skip: WORKER_PY ? false : "set B1_WORKER_SRC (or B1_WORKSPACE) to run against src/stageb_worker.py" }, async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "b1fc-"));
  const proc = spawn(process.env.B1_BRIDGE_PYTHON || "python3", [WORKER_PY], { env: { PATH: process.env.PATH, B1_WORKER_SECRET: SECRET, B1_WORKER_PORT: "0",
    B1_WORKER_PLAINTEXT_BEHIND_TLS_PROXY: "1", B1_WORKER_FIXTURES: "1", B1_WORKER_FIXTURES_DIR: dir }, stdio: ["ignore", "ignore", "pipe"] });
  try {
    const port = await new Promise((resolve, reject) => {
      let err = ""; const t = setTimeout(() => reject(new Error(`worker did not start: ${err}`)), 15000);
      proc.stderr.on("data", (d) => { err += d; const m = err.match(/listening on 127\.0\.0\.1:(\d+)/); if (m) { clearTimeout(t); resolve(Number(m[1])); } });
      proc.on("exit", (code) => { clearTimeout(t); reject(new Error(`worker exited ${code}: ${err}`)); });
    });
    const httpPost = (url, pathname, h, body) => new Promise((resolve, reject) => {
      const q = http.request({ host: "127.0.0.1", port, path: pathname, method: "POST", headers: h }, (res) => { const parts = []; res.on("data", (d) => parts.push(d)); res.on("end", () => resolve({ status: res.statusCode, signature: String(res.headers["x-b1-response-signature"] || ""), body: Buffer.concat(parts) })); });
      q.on("error", reject); q.end(body);
    });
    let b = JSON.parse((await call(BRANCH_HOST, { ...base, ...workerEnv }, httpPost)).body);
    assert.deepStrictEqual([b.workerAuth, b.workerAuthCode, b.workerStatus], [true, "accepted_unexpected_reply", 503]);
    b = JSON.parse((await call(BRANCH_HOST, { ...base, ...workerEnv, B1_WORKER_SECRET: OTHER }, httpPost)).body);
    assert.deepStrictEqual([b.workerAuth, b.workerAuthCode, b.workerStatus], [false, "rejected_401_unsigned", 401]);
  } finally { proc.kill("SIGKILL"); fs.rmSync(dir, { recursive: true, force: true }); }
});

test("b1-flag-check: wrong secret reports the worker's refusal code and the clock difference; a refusal outside the fixed set is 'other'", async () => {
  let b = JSON.parse((await call(BRANCH_HOST, { ...base, ...workerEnv }, fakeWorker(OTHER))).body);
  assert.strictEqual(b.workerRefusal, "bad_signature");
  const stale = async () => ({ status: 401, signature: "", body: Buffer.from('{"ok": false, "code": "stale_or_future_timestamp"}'), date: new Date(Date.now() + 600000).toUTCString() });
  b = JSON.parse((await call(BRANCH_HOST, { ...base, ...workerEnv }, stale)).body);
  assert.strictEqual(b.workerRefusal, "stale_or_future_timestamp");
  assert.ok(b.clockSkewSec >= 598 && b.clockSkewSec <= 601, String(b.clockSkewSec));
  const odd = async () => ({ status: 401, signature: "", body: Buffer.from('{"code": "<script>SECRET</script>"}') });
  b = JSON.parse((await call(BRANCH_HOST, { ...base, ...workerEnv }, odd)).body);
  assert.strictEqual(b.workerRefusal, "other");
  assert.ok(!JSON.stringify(b).includes("SECRET"));
});

test("b1-flag-check: secret shape reports length and character class only; never the value or anything derived from it", async () => {
  const shape = async (v) => JSON.parse((await call(BRANCH_HOST, { ...base, ...workerEnv, B1_WORKER_SECRET: v }, fakeWorker(SECRET))).body).secret;
  const hex = "0123456789abcdef".repeat(4);
  assert.deepStrictEqual(await shape(hex), { present: true, length: 64, hex64: true, hexAnyCase64: true, edgeWhitespace: false, innerWhitespace: false, quoted: false, unresolvedReference: false, nonPrintable: false });
  assert.strictEqual((await shape(hex + "\n")).edgeWhitespace, true);
  assert.strictEqual((await shape(hex.toUpperCase())).hex64, false);
  assert.strictEqual((await shape(hex.toUpperCase())).hexAnyCase64, true);
  assert.strictEqual((await shape('"' + hex + '"')).quoted, true);
  assert.strictEqual((await shape("${{ secret(64) }}" + "x".repeat(20))).unresolvedReference, true);
  const r = await call(BRANCH_HOST, { ...base, ...workerEnv, B1_WORKER_SECRET: hex }, fakeWorker(hex));
  for (const part of [hex, hex.slice(0, 8), hex.slice(-4)]) assert.ok(!r.body.includes(part), "no part of the secret in the reply");
  assert.deepStrictEqual(JSON.parse((await call(BRANCH_HOST, { ...base })).body).secret, { present: false });
});

test("b1-flag-check: reports which deploy answered (x-nf-deploy-id header, else DEPLOY_URL), a public identifier", async () => {
  const id = "6aef7420303b82711a747047";
  let r = await fn.handler({ headers: { host: BRANCH_HOST, "x-nf-deploy-id": id } }, {}, { env: { ...base }, post: async () => { throw new Error("x"); } });
  assert.deepStrictEqual(JSON.parse(r.body).deploy, { deployId: id, source: "header" });
  r = await fn.handler({ headers: { host: BRANCH_HOST } }, {}, { env: { ...base, DEPLOY_URL: `https://${id}--smart-stage-pro.netlify.app` } });
  assert.deepStrictEqual(JSON.parse(r.body).deploy, { deployId: id, source: "DEPLOY_URL" });
  r = await fn.handler({ headers: { host: BRANCH_HOST, "x-nf-deploy-id": "not-an-id" } }, {}, { env: { ...base } });
  assert.deepStrictEqual(JSON.parse(r.body).deploy, { deployId: null, source: "unavailable" });
});

test("b1-flag-check: reports the Stage B daily limits exactly as the job reads them (default 3/10, branch override honoured)", async () => {
  const caps = async (over) => JSON.parse((await call(BRANCH_HOST, { ...base, ...over })).body).stagebCaps;
  assert.deepStrictEqual(await caps({}), { perUserDay: 3, globalDay: 10 });
  assert.deepStrictEqual(await caps({ B1_STAGEB_MAX_PER_USER_DAY: "4" }), { perUserDay: 4, globalDay: 10 });
  assert.deepStrictEqual(await caps({ B1_STAGEB_MAX_PER_USER_DAY: "4" }), require("../netlify/functions/lib/agent-marketing-b1-stageb-run-lib").caps({ B1_STAGEB_MAX_PER_USER_DAY: "4" }));
});
