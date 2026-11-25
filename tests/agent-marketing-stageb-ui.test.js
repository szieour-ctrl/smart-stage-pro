// Run with: npm test
// DEVELOPMENT ONLY (Nov 8, 2026, workflow scope correction): "Write my script" with article evidence on agent-marketing.html. There is no separate
// evidence step for the subscriber: no "Check the article's evidence" or "Re-check the article" button and no evidence panel. The page has no DOM
// harness, so the self-contained block between SCRIPT_FLOW_BEGIN / SCRIPT_FLOW_END is extracted and run, and the wiring is checked in the source.
const test = require("node:test");
const assert = require("node:assert");
const fs = require("fs"), path = require("path");

const html = fs.readFileSync(path.join(__dirname, "..", "agent-marketing.html"), "utf8");
const block = html.slice(html.indexOf("// SCRIPT_FLOW_BEGIN"), html.indexOf("// SCRIPT_FLOW_END"));
const W = new Function(`${block}\nreturn { scriptWaitText, scriptMaxMs, SCRIPT_WAIT_DEFAULT, SCRIPT_PLAIN_MAX_MS, SCRIPT_EVIDENCE_MAX_MS, SCRIPT_EVIDENCE_POLL_MS };`)();
const fnBody = (name) => { const i = html.indexOf(`async function ${name}(`); assert.ok(i > 0, name); return html.slice(i, html.indexOf("\n  }\n", i)); };

test("no subscriber-facing evidence controls: no evidence buttons, no evidence panel, no re-check", () => {
  for (const s of ["stagebBox", "stagebBtn", "stagebVerifyBtn", "stagebAttempt", "Check the article's evidence", "Re-check the article", "verify_source", "Last re-check"]) {
    assert.ok(!html.includes(s), `the page still contains ${s}`);
  }
  assert.strictEqual((html.match(/id="planBtn"/g) || []).length, 1, "one Write my script button");
});

test("progress text: evidence first, then the script; held findings are named as held back, never shown", () => {
  const read = "Reading the article and checking its evidence… this can take a few minutes.";
  assert.strictEqual(W.scriptWaitText({ state: "none" }), read);
  assert.strictEqual(W.scriptWaitText({ state: "reserved" }), read);
  assert.strictEqual(W.scriptWaitText({ state: "running" }), read);
  assert.strictEqual(W.scriptWaitText({ state: "ready", counts: { validated: 14, held: 0, excluded: 0 } }), "Article evidence is ready (14 checked). Writing your script…");
  assert.strictEqual(W.scriptWaitText({ state: "ready", counts: { validated: 10, held: 4, excluded: 1 } }), "Article evidence is ready (10 checked, 4 held back as unverified). Writing your script…");
  assert.strictEqual(W.scriptWaitText({ state: "ready" }), "Article evidence is ready. Writing your script…");
  assert.strictEqual(W.scriptWaitText({ state: "failed" }), "Finishing up…", "a failure is reported by the narrative error, with its reason");
  assert.strictEqual(W.scriptWaitText(null), W.SCRIPT_WAIT_DEFAULT);
});

test("the page waits long enough for evidence + script, and keeps the old limit for the plain path", () => {
  assert.strictEqual(W.scriptMaxMs(false), W.SCRIPT_PLAIN_MAX_MS);
  assert.strictEqual(W.SCRIPT_PLAIN_MAX_MS, 330000, "the production planning wait is unchanged");
  assert.ok(W.scriptMaxMs(true) >= 17 * 60 * 1000, "longer than the background function's limit");
  assert.ok(W.SCRIPT_EVIDENCE_POLL_MS >= 3000);
});

test("Write my script: with Stage B offered → one script check + one background dispatch with mode script; otherwise the unchanged plan path", () => {
  const plan = fnBody("plan");
  assert.match(plan, /if \(await evidenceStatus\(\)\) \{ await planWithEvidence\(state\.project\)/);
  assert.match(plan, /action: "plan", id: state\.project\.id/, "the production path is unchanged");
  const pw = fnBody("planWithEvidence");
  assert.strictEqual((pw.match(/api\("POST"/g) || []).length, 2);
  assert.match(pw, /\{ action: "script", projectId: p\.id \}, STAGEB\)/);
  assert.match(pw, /\{ projectId: p\.id, mode: "script" \}, STAGEB_BG\)/);
  assert.ok(!/action: "start"/.test(html), "the separate evidence start is never sent by the page");
  assert.ok(!/setTimeout\(plan|setInterval\(plan|planWithEvidence\(state\.project\);\s*\}\s*catch/.test(html), "never retried by itself");
});

test("never asked on production; the status is only metadata for the progress line", () => {
  const es = fnBody("evidenceStatus");
  assert.match(es, /SSP_CFG\.env === "production"\) return null/);
  assert.match(es, /api\("GET", "\?projectId=/);
  const watch = fnBody("watchEvidenceFlow");
  assert.match(watch, /scriptWaitText\(/);
  assert.ok(!/api\("POST"/.test(watch), "watching never starts anything");
});

test("the page script still parses", () => {
  const scripts = [...html.matchAll(/<script>([\s\S]*?)<\/script>/g)].map((m) => m[1]);
  assert.ok(scripts.length);
  for (const s of scripts) assert.doesNotThrow(() => new Function(s));
});
