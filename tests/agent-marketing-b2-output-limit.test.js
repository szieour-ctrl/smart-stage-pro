// The Article-Led editorial writer needs more output room than the planner default, and a cut-off reply must leave diagnostics.
const test = require("node:test");
const assert = require("node:assert");
const https = require("https");
const { EventEmitter } = require("events");
const fs = require("fs"), path = require("path");
const planLib = require("../netlify/functions/lib/agent-marketing-plan-lib");
const b2 = require("../netlify/functions/lib/agent-marketing-b2-lib");

/** Replaces https.request for one call. With a reply it answers at once; with reply === null it waits and lets the test fire the request timeout. */
function withFakeAnthropic(reply, fn) {
  const real = https.request; const sent = [], timeouts = []; let fire = null;
  https.request = (opts, cb) => {
    const req = new EventEmitter();
    let body = "";
    req.setTimeout = (ms, h) => { timeouts.push(ms); fire = h; };
    req.destroy = (e) => req.emit("error", e);
    req.write = (b) => { body += b; };
    req.end = () => { sent.push(JSON.parse(body)); if (reply === null) return; const res = new EventEmitter(); res.setEncoding = () => {}; cb(res); res.emit("data", JSON.stringify(reply)); res.emit("end"); };
    return req;
  };
  return Promise.resolve().then(() => fn(sent, timeouts, () => fire && fire())).finally(() => { https.request = real; });
}
const cutOff = { model: "claude-sonnet-4-6", stop_reason: "max_tokens", content: [{ type: "text", text: "{\"candidates\": [" }], usage: { input_tokens: 12345, output_tokens: 8000 } };
const fine = { model: "claude-sonnet-4-6", stop_reason: "end_turn", content: [{ type: "text", text: "{}" }], usage: { input_tokens: 10, output_tokens: 2 } };

test("callClaudeText keeps its 4,000-token default and takes an optional larger allowance", async () => {
  await withFakeAnthropic(fine, async (sent) => {
    await planLib.callClaudeText("s", "u", "k", []);
    await planLib.callClaudeText("s", "u", "k", [], { maxTokens: 8000 });
    await planLib.callClaudeText("s", "u", "k", [], { maxTokens: 0 });
    await planLib.callClaudeText("s", "u", "k", [], {});
    assert.deepStrictEqual(sent.map((b) => b.max_tokens), [4000, 8000, 4000, 4000]);
  });
});

test("a cut-off reply is still rejected, and carries the model, stop reason, token counts and limit (no prompt, article text or key)", async () => {
  await withFakeAnthropic(cutOff, async () => {
    await assert.rejects(() => planLib.callClaudeText("SYSTEM SECRET TEXT", "ARTICLE TEXT", "sk-secret", [], { maxTokens: 8000 }), (e) => {
      assert.strictEqual(e.message, "Planner response was cut off");
      const { elapsed_ms, ...rest } = e.diagnostics;
      assert.deepStrictEqual(rest, { model: "claude-sonnet-4-6", stop_reason: "max_tokens", input_tokens: 12345, output_tokens: 8000, max_output_tokens: 8000, configured_timeout_ms: 120000 });
      assert.ok(Number.isInteger(elapsed_ms) && elapsed_ms >= 0);
      const dump = JSON.stringify(e.diagnostics) + e.message;
      assert.ok(!/SYSTEM SECRET|ARTICLE TEXT|sk-secret/.test(dump));
      return true;
    });
  });
  await withFakeAnthropic(cutOff, async () => {
    await assert.rejects(() => planLib.callClaudeText("s", "u", "k", []), (e) => e.diagnostics.max_output_tokens === 4000, "the default call reports its own limit");
  });
});

test("the B2 editorial call asks for 8,000 output tokens and still requests ten candidates", async () => {
  assert.strictEqual(b2.B2_MAX_OUTPUT_TOKENS, 8000);
  assert.strictEqual(b2.MAX_CANDIDATES, 10);
  let seen;
  const records = [{ id: "A1", title: "t", url: "https://example.com/a", findings: [{ id: "A1-F1", kind: "k", finding: "f", source_quotes: ["q"], attribution: "x", qualifications: [] }] }];
  await b2.generate({ records, articles: [], evidence: new Map(), mode: "article_report", market: "Roseville, ZIP 95747", audience: "sellers", reportFigures: [], callFn: async (sys, user, key, sink, opts) => { seen = { sys, opts }; return JSON.stringify({ candidates: [], selected: [] }); } });
  assert.deepStrictEqual(seen.opts, { maxTokens: 8000, timeoutMs: 210000 });
  assert.match(seen.sys, /Explore 10 /, "the number of candidates is unchanged");
});

test("failure metadata for the editorial step names the stage and, for a cut-off reply, the diagnostics", () => {
  const e = new Error("Planner response was cut off");
  e.diagnostics = { model: "claude-sonnet-4-6", stop_reason: "max_tokens", input_tokens: 9, output_tokens: 8000, max_output_tokens: 8000 };
  assert.deepStrictEqual(b2.failureDiagnostics(e), { stage: "editorial_topic_generation", model: "claude-sonnet-4-6", stop_reason: "max_tokens", input_tokens: 9, output_tokens: 8000, max_output_tokens: 8000 });
  assert.match(fs.readFileSync(path.join(__dirname, "..", "netlify", "functions", "lib", "agent-marketing-b2-lib.js"), "utf8"), /elapsed_since_start_ms: time\.elapsed/, "the run's elapsed time is added when it is known");
  assert.deepStrictEqual(b2.failureDiagnostics(new Error("boom")), { stage: "editorial_topic_generation", max_output_tokens: 8000, configured_timeout_ms: 210000 });
  const src = fs.readFileSync(path.join(__dirname, "..", "netlify", "functions", "lib", "agent-marketing-b2-lib.js"), "utf8");
  assert.match(src, /b2_failed[\s\S]{0,400}diagnostics: \{ \.\.\.failureDiagnostics\(x\)/, "the existing b2_failed metadata carries it");
});

test("other planner callers are unchanged: only the B2 call passes a larger allowance", () => {
  const dir = path.join(__dirname, "..", "netlify", "functions", "lib");
  const users = fs.readdirSync(dir).filter((f) => /\.js$/.test(f)).filter((f) => /\bsink, \{ maxTokens/.test(fs.readFileSync(path.join(dir, f), "utf8")));
  assert.deepStrictEqual(users, ["agent-marketing-b2-lib.js"]);
});

test("the request timeout: 120 s by default, 210 s only when the editorial writer asks, and a timeout is handled cleanly with diagnostics", async () => {
  await withFakeAnthropic(fine, async (sent, timeouts) => {
    await planLib.callClaudeText("s", "u", "k", []);
    await planLib.callClaudeText("s", "u", "k", [], { timeoutMs: 210000 });
    await planLib.callClaudeText("s", "u", "k", [], { timeoutMs: -5 });
    assert.deepStrictEqual(timeouts, [120000, 210000, 120000]);
  });
  await withFakeAnthropic(null, async (sent, timeouts, fire) => {
    const p = planLib.callClaudeText("SYSTEM SECRET", "ARTICLE TEXT", "sk-secret", [], { maxTokens: 8000, timeoutMs: 210000 });
    fire();
    await assert.rejects(p, (e) => {
      assert.strictEqual(e.message, "Planner call timed out");
      const { elapsed_ms, ...rest } = e.diagnostics;
      assert.deepStrictEqual(rest, { model: "claude-sonnet-4-6", stop_reason: "timeout", input_tokens: 0, output_tokens: 0, max_output_tokens: 8000, configured_timeout_ms: 210000 });
      assert.ok(Number.isInteger(elapsed_ms));
      assert.ok(!/SYSTEM SECRET|ARTICLE TEXT|sk-secret/.test(JSON.stringify(e.diagnostics)));
      assert.deepStrictEqual({ stage: b2.failureDiagnostics(e).stage, stop: b2.failureDiagnostics(e).stop_reason }, { stage: "editorial_topic_generation", stop: "timeout" });
      return true;
    });
  });
  assert.strictEqual(b2.B2_TIMEOUT_MS, 210000);
});

test("the editorial call starts only when it can finish inside the six-minute run window; otherwise it stops cleanly", () => {
  const t0 = Date.parse("2026-11-12T04:00:00Z");
  const at = (sec) => t0 + sec * 1000;
  // 360 s window - 210 s call - 15 s to write the result = 135 s of discovery and reading allowed.
  assert.strictEqual(b2.B2_RUN_WINDOW_MS - b2.B2_TIMEOUT_MS - b2.B2_RESULT_MARGIN_MS, 135000);
  assert.deepStrictEqual(b2.timeLeft("2026-11-12T04:00:00Z", at(60)), { ok: true, elapsed: 60000 });
  assert.strictEqual(b2.timeLeft("2026-11-12T04:00:00Z", at(135)).ok, true);
  assert.deepStrictEqual(b2.timeLeft("2026-11-12T04:00:00Z", at(136)), { ok: false, elapsed: 136000 });
  assert.deepStrictEqual(b2.timeLeft(undefined, at(500)), { ok: true, elapsed: null }, "an unknown start never blocks the call");
  const src = fs.readFileSync(path.join(__dirname, "..", "netlify", "functions", "lib", "agent-marketing-b2-lib.js"), "utf8");
  const research = fs.readFileSync(path.join(__dirname, "..", "netlify", "functions", "agent-marketing-research.js"), "utf8");
  assert.match(research, /const STALE_RUNNING_MS = 6 \* 60 \* 1000;/, "the window the helper assumes is the one the research function enforces");
  // The check runs before the model call, and the stop is an uncharged failure with its own state and diagnostics.
  assert.ok(src.indexOf("timeLeft(row.created_at") > -1 && src.indexOf("timeLeft(row.created_at") < src.indexOf("out = await generate("), "checked before the call");
  assert.match(src, /failOut\("b2_no_time", "The articles were read, but there was not enough time left[^"]*This did not use a session\./);
  assert.match(src, /reason: "insufficient_time"/);
});
