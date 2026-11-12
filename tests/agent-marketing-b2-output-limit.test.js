// The Article-Led editorial writer needs more output room than the planner default, and a cut-off reply must leave diagnostics.
const test = require("node:test");
const assert = require("node:assert");
const https = require("https");
const { EventEmitter } = require("events");
const fs = require("fs"), path = require("path");
const planLib = require("../netlify/functions/lib/agent-marketing-plan-lib");
const b2 = require("../netlify/functions/lib/agent-marketing-b2-lib");

/** Replaces https.request for one call and answers with `reply`, recording the request body that was sent. */
function withFakeAnthropic(reply, fn) {
  const real = https.request; const sent = [];
  https.request = (opts, cb) => {
    const req = new EventEmitter();
    let body = "";
    req.setTimeout = () => {}; req.destroy = () => {};
    req.write = (b) => { body += b; };
    req.end = () => { sent.push(JSON.parse(body)); const res = new EventEmitter(); res.setEncoding = () => {}; cb(res); res.emit("data", JSON.stringify(reply)); res.emit("end"); };
    return req;
  };
  return Promise.resolve().then(() => fn(sent)).finally(() => { https.request = real; });
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
      assert.deepStrictEqual(e.diagnostics, { model: "claude-sonnet-4-6", stop_reason: "max_tokens", input_tokens: 12345, output_tokens: 8000, max_output_tokens: 8000 });
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
  assert.deepStrictEqual(seen.opts, { maxTokens: 8000 });
  assert.match(seen.sys, /Explore 10 /, "the number of candidates is unchanged");
});

test("failure metadata for the editorial step names the stage and, for a cut-off reply, the diagnostics", () => {
  const e = new Error("Planner response was cut off");
  e.diagnostics = { model: "claude-sonnet-4-6", stop_reason: "max_tokens", input_tokens: 9, output_tokens: 8000, max_output_tokens: 8000 };
  assert.deepStrictEqual(b2.failureDiagnostics(e), { stage: "editorial_topic_generation", model: "claude-sonnet-4-6", stop_reason: "max_tokens", input_tokens: 9, output_tokens: 8000, max_output_tokens: 8000 });
  assert.deepStrictEqual(b2.failureDiagnostics(new Error("boom")), { stage: "editorial_topic_generation", max_output_tokens: 8000 });
  const src = fs.readFileSync(path.join(__dirname, "..", "netlify", "functions", "lib", "agent-marketing-b2-lib.js"), "utf8");
  assert.match(src, /b2_failed[\s\S]{0,260}diagnostics: failureDiagnostics\(x\)/, "the existing b2_failed metadata carries it");
});

test("other planner callers are unchanged: only the B2 call passes a larger allowance", () => {
  const dir = path.join(__dirname, "..", "netlify", "functions", "lib");
  const users = fs.readdirSync(dir).filter((f) => /\.js$/.test(f)).filter((f) => /\bsink, \{ maxTokens/.test(fs.readFileSync(path.join(dir, f), "utf8")));
  assert.deepStrictEqual(users, ["agent-marketing-b2-lib.js"]);
});
