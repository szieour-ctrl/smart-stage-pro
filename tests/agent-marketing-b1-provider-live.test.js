// Run with: npm test
// DEVELOPMENT ONLY (Nov 8, 2026): the PAID live B1 provider (B1_PROVIDER=live), exercised against a stub fetch only. No network, no key, no cost.
const test = require("node:test");
const assert = require("node:assert");
const pv = require("../netlify/functions/lib/agent-marketing-b1-provider-lib");

const ENV = { AGENT_MARKETING_B1_EVIDENCE: "dev", B1_PROVIDER: "live", B1_ENDPOINT: "https://b1.example/v1/responses", B1_API_KEY: "test-key" };
const reply = (status, body) => async (url, init) => { reply.last = { url, init }; return { status, text: async () => (typeof body === "string" ? body : JSON.stringify(body)) }; };
const DONE = { status: "completed", output: [], usage: { cost: { total_cost: 0.02425 } } };

test("live provider: configured only by the server env, https endpoint and key required, refused with the switch off", () => {
  assert.throws(() => pv.createProvider({ env: { ...ENV, AGENT_MARKETING_B1_EVIDENCE: "" } }), (e) => e.code === "disabled");
  assert.throws(() => pv.createProvider({ env: { ...ENV, B1_ENDPOINT: "http://b1.example" } }), (e) => e.code === "not_configured");
  assert.throws(() => pv.createProvider({ env: { ...ENV, B1_API_KEY: "" } }), (e) => e.code === "not_configured");
  assert.throws(() => pv.createProvider({ env: { ...ENV, B1_PROVIDER: "" } }), (e) => e.code === "provider_not_implemented", "nothing is paid unless chosen");
  const p = pv.createProvider({ env: ENV });
  assert.deepStrictEqual([p.name, p.paid], ["live", true]);
});

test("live provider: sends the stored request body byte for byte with the key, returns the raw response text only when completed", async () => {
  const body = '{"model": "anthropic/claude-sonnet-5-5", "input": "x"}';
  const p = pv.liveProvider(ENV, reply(200, DONE));
  const text = await p.call({ requestText: body });
  assert.strictEqual(text, JSON.stringify(DONE));
  assert.strictEqual(reply.last.url, ENV.B1_ENDPOINT);
  assert.strictEqual(reply.last.init.body, body);
  assert.strictEqual(reply.last.init.headers.authorization, "Bearer test-key");
  assert.strictEqual(pv.reportedCost(text), 0.02425);
});

test("live provider: a non-200, an incomplete analysis or an unreachable endpoint fails with its own code", async () => {
  await assert.rejects(pv.liveProvider(ENV, reply(429, { error: "rate" })).call({ requestText: "{}" }), (e) => e.code === "provider_http_error");
  await assert.rejects(pv.liveProvider(ENV, reply(200, { status: "incomplete" })).call({ requestText: "{}" }), (e) => e.code === "provider_incomplete");
  await assert.rejects(pv.liveProvider(ENV, reply(200, "not json")).call({ requestText: "{}" }), (e) => e.code === "provider_incomplete");
  await assert.rejects(pv.liveProvider(ENV, async () => { throw new Error("ECONNRESET"); }).call({ requestText: "{}" }), (e) => e.code === "provider_unreachable");
  assert.strictEqual(pv.reportedCost("{}"), null);
});
