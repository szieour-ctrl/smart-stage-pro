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

test("live provider credential: B1_API_KEY first; otherwise the server's Perplexity key, and only for the exact Perplexity Agent endpoint", async () => {
  const base = { AGENT_MARKETING_B1_EVIDENCE: "dev", B1_PROVIDER: "live", PERPLEXITY_API_KEY: "pplx-test" };
  const sent = async (env) => { let auth = null; const p = pv.liveProvider(env, async (url, init) => { auth = init.headers.authorization; return { status: 200, text: async () => JSON.stringify(DONE) }; }); await p.call({ requestText: "{}" }); return auth; };
  // the approved endpoint with no B1_API_KEY: the existing Perplexity key is used
  assert.strictEqual(await sent({ ...base, B1_ENDPOINT: pv.PERPLEXITY_AGENT_ENDPOINT }), "Bearer pplx-test");
  // an explicit B1_API_KEY always wins
  assert.strictEqual(await sent({ ...base, B1_ENDPOINT: pv.PERPLEXITY_AGENT_ENDPOINT, B1_API_KEY: "b1-own" }), "Bearer b1-own");
  assert.strictEqual(await sent({ ...base, B1_ENDPOINT: "https://b1.example/v1/responses", B1_API_KEY: "b1-own" }), "Bearer b1-own");
  // any other endpoint never receives the Perplexity key
  for (const ep of ["https://b1.example/v1/responses", "https://api.perplexity.ai/v1/agent?x=1", "https://api.perplexity.ai/v1/agent/", "https://api.perplexity.ai/chat/completions",
    "https://api.perplexity.ai:8443/v1/agent", "http://api.perplexity.ai/v1/agent", "https://user:pw@api.perplexity.ai/v1/agent", "https://api.perplexity.ai.evil.example/v1/agent", "https://evil.example/?u=https://api.perplexity.ai/v1/agent"]) {
    assert.throws(() => pv.liveProvider({ ...base, B1_ENDPOINT: ep }), (e) => e.code === "not_configured" && !/pplx-test/.test(e.message), ep);
  }
  assert.strictEqual(pv.isPerplexityAgentEndpoint("https://api.perplexity.ai/v1/agent"), true);
  // no key anywhere: not configured, and the message names no secret
  assert.throws(() => pv.liveProvider({ ...base, PERPLEXITY_API_KEY: "", B1_ENDPOINT: pv.PERPLEXITY_AGENT_ENDPOINT }), (e) => e.code === "not_configured");
  // createProvider takes the same path
  assert.strictEqual(pv.createProvider({ env: { ...base, B1_ENDPOINT: pv.PERPLEXITY_AGENT_ENDPOINT } }).name, "live");
});
