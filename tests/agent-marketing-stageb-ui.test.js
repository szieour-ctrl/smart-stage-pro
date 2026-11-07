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
  const start = html.slice(html.indexOf("async function startStageB"), html.indexOf("// STAGEB_WATCH_BEGIN"));
  assert.match(start, /await stagebWatch\(\{ poll: refreshStageB,/);
  assert.match(start, /w\.outcome === "not_started"[\s\S]*paintStageB\(\{ state: "failed", error: "no record was created" \}\)[\s\S]*say\("scriptMsg", STAGEB_NOT_STARTED, "err"\)/);
  assert.match(W.STAGEB_NOT_STARTED, /could not start/);
  // exactly one start + one background dispatch per click; the watcher only reads the status
  assert.strictEqual((start.match(/STAGEB_BG\)/g) || []).length, 1);
  assert.strictEqual((start.match(/action: "start"/g) || []).length, 1);
  assert.doesNotMatch(block, /STAGEB_BG|action: "start"|"POST"|DELETE|fail\(|reset/);
  // a failed state re-enables the button for a deliberate retry only
  assert.match(html, /\$\("stagebBtn"\)\.textContent = st\.state === "failed" \? "Try the evidence check again"/);
});

test("the page script still parses", () => {
  const scripts = [...html.matchAll(/<script>([\s\S]*?)<\/script>/g)].map((m) => m[1]);
  assert.ok(scripts.length);
  for (const s of scripts) assert.doesNotThrow(() => new Function(s));
});
