// Run with: npm test
const test = require("node:test");
const assert = require("node:assert");
const run = require("../netlify/functions/lib/agent-marketing-research-run-lib");

const NOW = "2026-10-24T17:00:00Z";
const ENV = {}; // defaults: sonar-pro, medium context, one corrective retry, $0.025 target
const row = { id: "r1", mode: "market_update", audience: "sellers", geography: { type: "city", name: "Roseville", city: "", state: "CA", label: "Roseville, CA" }, focus: {}, upload_refs: [] };
const noSleep = async () => {};

const Q = [
  "Why are some Roseville homes taking longer to sell?",
  "Does spring bring more competing listings to Roseville?",
  "How are builder incentives changing resale pricing near new communities?",
  "What are mortgage rate buydowns doing to buyer budgets?",
  "Which price bands are seeing the most pending sales this month?",
];
const url = (n) => `https://example.org/report-${n}`;
const topic = (n) => ({ question: Q[n - 1], why_it_matters: "It changes how sellers price.", trend_signals: ["MLS active listings up month over month"], local_intent: true, scope: "selected", scope_note: null, event: null, sources: [{ title: `Report ${n}`, url: url(n), published: "2026-10-20" }] });
const five = () => [1, 2, 3, 4, 5].map(topic);
const reply = (topics, extra) => ({
  status: 200,
  json: { choices: [{ message: { content: "```json\n" + JSON.stringify({ topics }) + "\n```" } }], citations: [1, 2, 3, 4, 5].map(url), usage: { prompt_tokens: 600, completion_tokens: 1500 }, ...(extra || {}) },
});

test("cost: estimated from the published rates when the provider sends none", () => {
  assert.strictEqual(run.estimateCostUsd("sonar-pro", { promptTokens: 600, completionTokens: 1500 }), 0.0243);
  assert.strictEqual(run.estimateCostUsd("perplexity/sonar-pro", { promptTokens: 600, completionTokens: 1500 }), 0.0243);
  assert.strictEqual(run.estimateCostUsd("sonar", { promptTokens: 1000, completionTokens: 2000 }), 0.003);
  assert.strictEqual(run.estimateCostUsd("sonar-deep-research", { promptTokens: 1000, completionTokens: 2000, reasoningTokens: 100000, citationTokens: 5000, searchQueries: 20 }), 0.428);
  assert.strictEqual(run.estimateCostUsd("mystery-model", { promptTokens: 1, completionTokens: 1 }), null);
  assert.strictEqual(run.estimateCostUsd("sonar-pro", {}), null);
});

test("today is the Pacific calendar day", () => {
  assert.strictEqual(run.todayPT("2026-10-24T17:00:00Z"), "2026-10-24");
  assert.strictEqual(run.todayPT("2026-10-25T02:00:00Z"), "2026-10-24"); // still the 24th in California
});

test("grounding: a source the provider never found is dropped; the provider's own date wins; no provider list means no filtering", () => {
  const t = [{ sources: [{ title: "a", url: "https://www.example.org/report-1/?utm_source=x", published: "2026-10-01" }, { title: "invented", url: "https://made-up.example/x", published: "2026-10-20" }] }];
  const g = run.groundTopics(t, { search_results: [{ url: "https://example.org/report-1", date: "2026-10-22T08:00:00Z" }] });
  assert.strictEqual(g.grounded, true);
  assert.strictEqual(g.topics[0].sources.length, 1);
  assert.strictEqual(g.topics[0].sources[0].published, "2026-10-22");
  const none = run.groundTopics(t, { choices: [] });
  assert.strictEqual(none.grounded, false);
  assert.strictEqual(none.topics[0].sources.length, 2);
  assert.strictEqual(run.groundTopics(t, { citations: [{ url: "https://example.org/report-1" }] }).topics[0].sources.length, 1);
});

test("provider: busy answers are retried, a rejected model spelling is tried once, a bad key is a plain message", async () => {
  let calls = [];
  const seq = (answers) => async (payload) => { calls.push(payload.model); return answers.shift(); };
  const ok = { status: 200, json: { choices: [] } };
  calls = [];
  const a = await run.askProvider({ payload: { model: "sonar-pro" }, apiKey: "k", callFn: seq([{ status: 429, json: {} }, { status: 503, json: {} }, ok]), sleepFn: noSleep, retries: 2 });
  assert.strictEqual(a.resp, ok.json);
  assert.strictEqual(calls.length, 3);
  calls = [];
  const b = await run.askProvider({ payload: { model: "sonar-pro" }, apiKey: "k", callFn: seq([{ status: 400, json: { error: { message: "Invalid model 'sonar-pro'" } } }, ok]), sleepFn: noSleep, retries: 0 });
  assert.deepStrictEqual(calls, ["sonar-pro", "perplexity/sonar-pro"]);
  assert.strictEqual(b.modelUsed, "perplexity/sonar-pro");
  await assert.rejects(run.askProvider({ payload: { model: "sonar-pro" }, apiKey: "SECRET-KEY", callFn: seq([{ status: 401, json: { error: "bad key SECRET-KEY" } }]), sleepFn: noSleep, retries: 2 }), (e) => !/SECRET-KEY/.test(e.message) && /not set up/.test(e.message));
  await assert.rejects(run.askProvider({ payload: { model: "sonar-pro" }, apiKey: "k", callFn: async () => { throw new Error("socket hang up"); }, sleepFn: noSleep, retries: 1 }), /busy|timed out/);
  await assert.rejects(run.askProvider({ payload: { model: "sonar-pro" }, apiKey: "k", callFn: seq([{ status: 422, json: {} }]), sleepFn: noSleep, retries: 2 }), /not accepted/);
});

test("run: five grounded topics are delivered and charged; cost is estimated and compared with the $0.025 target", async () => {
  let sent;
  const r = await run.runResearch({ row, apiKey: "k", now: NOW, env: ENV, sleepFn: noSleep, callFn: async (p) => { sent = p; return reply(five()); } });
  assert.strictEqual(r.fields.status, "ready");
  assert.strictEqual(r.fields.topics.length, 5);
  assert.strictEqual(r.fields.charged_at, "2026-10-24T17:00:00.000Z");
  assert.strictEqual(r.fields.research_date, "2026-10-24");
  assert.strictEqual(r.attempts, 1);
  assert.strictEqual(r.fields.usage.costUsd, 0.0243);
  assert.strictEqual(r.fields.usage.costEstimated, true);
  assert.strictEqual(r.fields.usage.withinTarget, true);
  assert.strictEqual(r.fields.usage.grounded, true);
  assert.match(sent.messages[1].content, /Roseville, CA/);
  assert.strictEqual(sent.model, "sonar-pro");
});

test("run: a provider-reported cost beats the estimate and can miss the target", async () => {
  const r = await run.runResearch({ row, apiKey: "k", now: NOW, env: ENV, sleepFn: noSleep, callFn: async () => reply(five(), { usage: { prompt_tokens: 600, completion_tokens: 1500, cost: { total_cost: 0.06 } } }) });
  assert.strictEqual(r.fields.usage.costUsd, 0.06);
  assert.strictEqual(r.fields.usage.costEstimated, false);
  assert.strictEqual(r.fields.usage.withinTarget, false);
});

test("run: an unusable first answer gets one corrective retry; both attempts' cost is counted; success is charged once", async () => {
  const sent = [];
  const answers = [reply(five().slice(0, 4)), reply(five())];
  const r = await run.runResearch({ row, apiKey: "k", now: NOW, env: ENV, sleepFn: noSleep, callFn: async (p) => { sent.push(p); return answers.shift(); } });
  assert.strictEqual(r.fields.status, "ready");
  assert.strictEqual(r.attempts, 2);
  assert.strictEqual(r.fields.usage.promptTokens, 1200);
  assert.strictEqual(r.fields.usage.completionTokens, 3000);
  assert.match(sent[1].messages[2].content, /rejected/);
  assert.match(sent[1].messages[2].content, /expected 5 topics/);
});

test("run: two unusable answers fail the session and never charge it", async () => {
  const r = await run.runResearch({ row, apiKey: "k", now: NOW, env: ENV, sleepFn: noSleep, callFn: async () => reply(five().slice(0, 3)) });
  assert.strictEqual(r.fields.status, "failed");
  assert.strictEqual(r.fields.charged_at, null);
  assert.strictEqual(r.fields.topics, null);
  assert.strictEqual(r.attempts, 2);
  assert.ok(r.fields.usage.costUsd > 0); // the spend is recorded even though the subscriber is not charged
  const retries0 = await run.runResearch({ row, apiKey: "k", now: NOW, env: { AGENT_MARKETING_RESEARCH_RETRIES: "0" }, sleepFn: noSleep, callFn: async () => reply(five().slice(0, 3)) });
  assert.strictEqual(retries0.attempts, 1);
});

test("run: prose instead of JSON, invented sources and a dead provider all fail uncharged", async () => {
  const prose = await run.runResearch({ row, apiKey: "k", now: NOW, env: { AGENT_MARKETING_RESEARCH_RETRIES: "0" }, sleepFn: noSleep, callFn: async () => ({ status: 200, json: { choices: [{ message: { content: "I could not find anything." } }], usage: { prompt_tokens: 10, completion_tokens: 10 } } }) });
  assert.strictEqual(prose.fields.status, "failed");
  assert.strictEqual(prose.fields.charged_at, null);
  const invented = five(); invented[2].sources = [{ title: "Fake", url: "https://made-up.example/report", published: "2026-10-20" }];
  const inv = await run.runResearch({ row, apiKey: "k", now: NOW, env: { AGENT_MARKETING_RESEARCH_RETRIES: "0" }, sleepFn: noSleep, callFn: async () => reply(invented) });
  assert.strictEqual(inv.fields.status, "failed");
  assert.match(inv.problems.join(" "), /no usable source/);
  const dead = await run.runResearch({ row, apiKey: "SECRET-KEY", now: NOW, env: ENV, sleepFn: noSleep, callFn: async () => ({ status: 500, json: { error: "boom SECRET-KEY" } }) });
  assert.strictEqual(dead.fields.status, "failed");
  assert.strictEqual(dead.fields.charged_at, null);
  assert.ok(!/SECRET-KEY/.test(JSON.stringify(dead.fields)));
  assert.match(dead.fields.error, /busy/);
});

test("run: events mode asks for events and accepts a verified upcoming set", async () => {
  const ev = (n) => ({ question: ["Is the harvest festival at the town square this weekend?", "When does the lantern walk start downtown?", "Where is the chili cook-off being held?", "What time is the jazz concert in the park?", "Does the holiday tree lighting need tickets?"][n - 1], why_it_matters: "Neighbors can plan around it.", trend_signals: [], local_intent: true, scope: "selected", event: { name: `Event ${n}`, date: "2026-10-31", end_date: null, time: "10am to 4pm", location: "Town Square, Roseville", organizer: "City of Roseville", status: "upcoming" }, sources: [{ title: "City page", url: url(n), published: null }] });
  let sent;
  const r = await run.runResearch({ row: { ...row, mode: "local_events", audience: "general" }, apiKey: "k", now: NOW, env: ENV, sleepFn: noSleep, callFn: async (p) => { sent = p; return reply([1, 2, 3, 4, 5].map(ev)); } });
  assert.strictEqual(r.fields.status, "ready", r.problems.join("; "));
  assert.match(sent.messages[0].content, /MODE: Local Events/);
  assert.strictEqual(r.fields.topics[0].event.organizer, "City of Roseville");
});

test("plan key: brokerage and team members use their tier, everyone else Solo", () => {
  assert.strictEqual(run.planKeyFromContext({ poolKind: "brokerage" }), "brokerage");
  assert.strictEqual(run.planKeyFromContext({ poolKind: "team" }), "team");
  assert.strictEqual(run.planKeyFromContext({ poolKind: "user" }), "solo");
  assert.strictEqual(run.planKeyFromContext(null), "solo");
});
