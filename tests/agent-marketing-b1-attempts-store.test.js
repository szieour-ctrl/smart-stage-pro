// Run with: npm test
// DEVELOPMENT ONLY (live-fetch milestone, Nov 8, 2026): the attempt-log store methods (lib/agent-marketing-b1-store-lib.js). The request helper is
// stubbed, so this shows exactly what would be sent to the database: whitelisted minimal fields only, never HTML, text, requests or credentials.
const test = require("node:test");
const assert = require("node:assert");
const st = require("../netlify/functions/lib/agent-marketing-b1-store-lib");

const ENV = { AGENT_MARKETING_B1_EVIDENCE: "dev" };
const H = "a".repeat(64);
function stub(reply) { const sent = []; return { sent, request: async (method, table, body, query) => { sent.push({ method, table, body, query }); return reply || { status: 201, data: [{ id: "x", ...(body || {}) }] }; } }; }

test("insertAttempt sends only the minimal whitelisted fields to the attempt table; extra fields (HTML, text, secrets) are dropped", async () => {
  const s = stub(); const store = st.createStore({ env: ENV, request: s.request });
  await store.insertAttempt({ userId: "u", projectId: "p", topicId: "t-FA", mode: "evidence", stage: "snapshot", outcome: "capture_blocked", httpStatus: 200,
    contentType: "text/html", bytes: 1234, sourceUrl: "https://a.example/x", finalUrl: "https://a.example/x", observedTitle: "T", rawHtmlSha256: H,
    snapshotSha256: H, comparedTo: "e1", html: "<html>BODY</html>", snapshotText: "ARTICLE TEXT", requestText: "REQ", secret: "S3CRET" });
  const { method, table, body } = s.sent[0];
  assert.deepStrictEqual([method, table], ["POST", st.ATTEMPTS]);
  assert.deepStrictEqual(Object.keys(body).sort(), ["bytes", "compared_to", "content_type", "final_url", "http_status", "mode", "observed_title", "outcome",
    "project_id", "raw_html_sha256", "snapshot_sha256", "source_url", "stage", "topic_id", "user_id"]);
  for (const v of ["BODY", "ARTICLE TEXT", "REQ", "S3CRET"]) assert.ok(!JSON.stringify(body).includes(v), v);
});

test("insertAttempt normalises values to what the database accepts (codes, bounds, hashes)", async () => {
  const s = stub(); const store = st.createStore({ env: ENV, request: s.request });
  await store.insertAttempt({ userId: "u", projectId: "p", topicId: "t", mode: "evidence", stage: "fetch", outcome: "HTTP-Error!", httpStatus: 99999,
    bytes: -1, sourceUrl: "https://a.example/" + "x".repeat(3000), observedTitle: "y".repeat(900), rawHtmlSha256: "nope", snapshotSha256: H.toUpperCase() });
  const b = s.sent[0].body;
  assert.strictEqual(b.outcome, "http_error_");
  assert.ok(/^[a-z][a-z_]{1,39}$/.test(b.outcome));
  assert.deepStrictEqual([b.http_status, b.bytes, b.raw_html_sha256, b.snapshot_sha256], [null, null, null, null]);
  assert.deepStrictEqual([b.source_url.length, b.observed_title.length], [2048, 500]);
  await store.insertAttempt({ userId: "u", topicId: "t", mode: "evidence", stage: "fetch", outcome: "" });
  assert.strictEqual(s.sent[1].body.outcome, "unknown_error");
});

test("latestAttempt asks only for page-safe metadata; the removed re-check left no verification counter", async () => {
  const s = stub({ status: 200, data: [] }); const store = st.createStore({ env: ENV, request: s.request });
  await store.latestAttempt("p1", "t-FA");
  assert.match(s.sent[0].query, /select=mode,stage,outcome,http_status,created_at&/);
  assert.doesNotMatch(s.sent[0].query, /url|title|sha256/);
  assert.strictEqual(store.countVerifications, undefined);
});

test("the attempt store is inert unless Stage B is switched on; a database refusal is a store error, not a crash", async () => {
  assert.throws(() => st.createStore({ env: {}, request: async () => ({}) }), (e) => e.code === "disabled");
  const store = st.createStore({ env: ENV, request: async () => ({ status: 400, data: { code: "P0001", message: "attempts are append-only" } }) });
  await assert.rejects(store.insertAttempt({ userId: "u", topicId: "t", mode: "evidence", stage: "fetch", outcome: "x_y" }), (e) => e.code === "refused");
});
