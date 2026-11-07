// Run with: npm test
// DEVELOPMENT ONLY (Nov 7, 2026): the Article Evidence (Stage B) panel's polling after a start. The page has no DOM harness, so the self-contained
// watcher between STAGEB_WATCH_BEGIN / STAGEB_WATCH_END is extracted from agent-marketing.html and run with a fake clock and fake status replies.
const test = require("node:test");
const assert = require("node:assert");
const fs = require("fs"), path = require("path");

const html = fs.readFileSync(path.join(__dirname, "..", "agent-marketing.html"), "utf8");
const block = html.slice(html.indexOf("// STAGEB_WATCH_BEGIN"), html.indexOf("// STAGEB_WATCH_END"));
const W = new Function(`${block}\nreturn { stagebWatch, STAGEB_POLL_MS, STAGEB_GRACE_MS, STAGEB_MAX_MS, STAGEB_NOT_STARTED };`)();

/** Runs the watcher against a scripted sequence of status replies on a fake clock. Each poll consumes one reply (the last one repeats). */
async function run(replies) {
  let t = 0; const calls = [];
  const res = await W.stagebWatch({
    now: () => t,
    sleep: async (ms) => { t += ms; },
    poll: async () => { const r = replies[Math.min(calls.length, replies.length - 1)]; calls.push(t); return typeof r === "function" ? r(t) : r; },
  });
  return { ...res, elapsed: t, calls };
}
const none = { state: "none" }, running = { state: "running" }, reserved = { state: "reserved" };

test("missing record: the status stays 'none' → polling stops after the grace period with not_started (no endless polling)", async () => {
  const r = await run([none]);
  assert.strictEqual(r.outcome, "not_started");
  assert.ok(r.elapsed >= W.STAGEB_GRACE_MS && r.elapsed < W.STAGEB_GRACE_MS + W.STAGEB_POLL_MS, `stopped at ${r.elapsed} ms`);
  assert.strictEqual(r.polls, W.STAGEB_GRACE_MS / W.STAGEB_POLL_MS);
});

test("the grace period covers a healthy job's slowest path to its first record (fixture article + snapshot, 60 s worker limit each)", () => {
  assert.ok(W.STAGEB_GRACE_MS >= 2 * 60 * 1000, "a working job must not be reported as not started");
  assert.ok(W.STAGEB_GRACE_MS < W.STAGEB_MAX_MS);
});

test("successful polling: 'none' while the record is being created, then reserved/running → keeps polling past the grace period, ends on ready", async () => {
  // record appears at 100 s (inside the grace period), the job runs for several minutes, then completes
  const r = await run([(t) => (t < 100000 ? none : t < 400000 ? running : { state: "ready", completeness: "PASSED_WITH_HOLDS", counts: { validated: 3, held: 1 } })]);
  assert.strictEqual(r.outcome, "ready");
  assert.ok(r.elapsed > W.STAGEB_GRACE_MS, "never stopped as not_started once a record existed");
  assert.strictEqual(r.status.completeness, "PASSED_WITH_HOLDS");
});

test("normal completion: reserved → running → ready stops at once with the status", async () => {
  const r = await run([reserved, running, running, { state: "ready", completeness: "COMPLETE" }]);
  assert.deepStrictEqual([r.outcome, r.polls, r.status.completeness], ["ready", 4, "COMPLETE"]);
});

test("a failed record stops polling with failed (not not_started); an unavailable status stops quietly", async () => {
  let r = await run([running, { state: "failed", error: "provider_error" }]);
  assert.deepStrictEqual([r.outcome, r.status.error], ["failed", "provider_error"]);
  r = await run([null]);
  assert.deepStrictEqual([r.outcome, r.polls], ["unavailable", 1]);
});

test("a live record never times out early; the overall limit still ends polling", async () => {
  const r = await run([running]);
  assert.strictEqual(r.outcome, "timeout");
  assert.ok(r.elapsed >= W.STAGEB_MAX_MS);
});

test("the page wires it in: not_started shows a clear message, keeps every record, and never retries or starts a job by itself", () => {
  const start = html.slice(html.indexOf("async function startStageB"), html.indexOf("// Re-check the article (development only)"));
  assert.match(start, /await stagebWatch\(\{ poll: refreshStageB, sleep: stagebSleep, now: Date\.now, prev: prev, mode: "evidence" \}\)/);
  assert.match(start, /w\.outcome === "not_started"[\s\S]*paintStageB\(\{ state: "failed", error: "no record was created" \}\)[\s\S]*say\("scriptMsg", STAGEB_NOT_STARTED/);
  assert.match(W.STAGEB_NOT_STARTED, /could not start/);
  // exactly one start + one background dispatch per click; already-ready answers start nothing; the watcher only reads the status
  assert.strictEqual((start.match(/STAGEB_BG\)/g) || []).length, 1);
  assert.strictEqual((start.match(/action: "start"/g) || []).length, 1);
  assert.match(start, /r\.status === 200 && r\.json\.state === "ready"\) \{ await refreshStageB\(\); return; \}/);
  assert.doesNotMatch(block, /STAGEB_BG|action: "start"|action: "verify_source"|"POST"|DELETE|fail\(|reset/);
  // a failed state re-enables the button for a deliberate retry only
  assert.match(html, /\$\("stagebBtn"\)\.textContent = st\.state === "failed" \? "Try the evidence check again"/);
});

test("re-check wiring: one verify_source check + one background dispatch with mode verify_source per click; never the evidence start", () => {
  const v = html.slice(html.indexOf("async function verifyStageB"), html.indexOf("// STAGEB_WATCH_BEGIN"));
  assert.strictEqual((v.match(/action: "verify_source"/g) || []).length, 1);
  assert.strictEqual((v.match(/STAGEB_BG\)/g) || []).length, 1);
  assert.match(v, /\{ projectId: p\.id, mode: "verify_source" \}, STAGEB_BG/);
  assert.doesNotMatch(v, /action: "start"/);
  assert.match(v, /mode: "verify_source" \}\)/);   // the watcher runs in verify mode
  assert.match(html, /id="stagebVerifyBtn">Re-check the article</);
  assert.match(html, /\$\("stagebVerifyBtn"\)\.addEventListener\("click", verifyStageB\)/);
});

test("attempt messages: every code the server can record has plain words; http_error shows its status; unknown codes are named", () => {
  const blockA = html.slice(html.indexOf("var STAGEB_ATTEMPT_TEXT"), html.indexOf("  function paintStageB"));
  const T = new Function(`${blockA}\nreturn { STAGEB_ATTEMPT_TEXT, attemptText };`)();
  for (const c of ["unchanged", "source_changed", "no_baseline", "bad_url", "fetch_timeout", "fetch_failed", "too_many_redirects", "redirected_elsewhere",
    "http_error", "not_html", "empty", "too_large", "capture_blocked", "incomplete", "fixture_refused", "verify_limit_user_day"]) assert.ok(T.STAGEB_ATTEMPT_TEXT[c], c);
  assert.match(T.attemptText({ outcome: "http_error", httpStatus: 451 }), /HTTP 451/);
  assert.match(T.attemptText({ outcome: "source_changed" }), /nothing was replaced/);
  assert.match(T.attemptText({ outcome: "weird_code" }), /\(weird_code\)/);
  assert.strictEqual(T.attemptText(null), "");
});

test("evidence mode: a NEW attempt while no new row exists ends at once as not_started with that attempt (no 150 s wait)", async () => {
  const prev = { createdAt: null, attemptAt: "2026-11-08T10:00:00Z" };
  const fresh = { mode: "evidence", stage: "fetch", outcome: "http_error", httpStatus: 404, at: "2026-11-08T10:05:00Z" };
  let t = 0;
  const r = await W.stagebWatch({ now: () => t, sleep: async (ms) => { t += ms; }, prev, mode: "evidence",
    poll: async () => (t < 10000 ? { state: "none", lastAttempt: { ...fresh, at: prev.attemptAt } } : { state: "none", lastAttempt: fresh }) });
  assert.deepStrictEqual([r.outcome, r.attempt.outcome], ["not_started", "http_error"]);
  assert.ok(t < W.STAGEB_GRACE_MS);
});

test("evidence mode: the project's EARLIER failed or ready row never ends a new run; only a new row does", async () => {
  const prev = { createdAt: "2026-11-07T19:16:12Z", attemptAt: null };
  let t = 0;
  const r = await W.stagebWatch({ now: () => t, sleep: async (ms) => { t += ms; }, prev, mode: "evidence",
    poll: async () => (t < 30000 ? { state: "failed", error: "mock_no_response", createdAt: prev.createdAt }
      : t < 60000 ? { state: "running", createdAt: "2026-11-07T19:51:26Z" } : { state: "ready", completeness: "PASSED_WITH_HOLDS", createdAt: "2026-11-07T19:51:26Z" }) });
  assert.deepStrictEqual([r.outcome, r.status.completeness], ["ready", "PASSED_WITH_HOLDS"]);
  assert.ok(t >= 60000);
});

test("verify mode: ends on the NEW attempt (any outcome), ignores the earlier one, and gives up after the grace period", async () => {
  const prev = { createdAt: "x", attemptAt: "2026-11-08T10:00:00Z" };
  let t = 0;
  let r = await W.stagebWatch({ now: () => t, sleep: async (ms) => { t += ms; }, prev, mode: "verify_source",
    poll: async () => ({ state: "ready", createdAt: "x", lastAttempt: t < 15000 ? { mode: "verify_source", outcome: "unchanged", at: prev.attemptAt } : { mode: "verify_source", outcome: "source_changed", at: "2026-11-08T10:01:00Z" } }) });
  assert.deepStrictEqual([r.outcome, r.attempt.outcome], ["verified", "source_changed"]);
  t = 0;
  r = await W.stagebWatch({ now: () => t, sleep: async (ms) => { t += ms; }, prev, mode: "verify_source", poll: async () => ({ state: "ready", lastAttempt: { mode: "evidence", outcome: "x", at: "later" } }) });
  assert.strictEqual(r.outcome, "not_started", "an evidence-mode attempt does not end a re-check");
  assert.ok(t >= W.STAGEB_GRACE_MS && t < W.STAGEB_GRACE_MS + W.STAGEB_POLL_MS);
});

test("the page script still parses", () => {
  const scripts = [...html.matchAll(/<script>([\s\S]*?)<\/script>/g)].map((m) => m[1]);
  assert.ok(scripts.length);
  for (const s of scripts) assert.doesNotThrow(() => new Function(s));
});
