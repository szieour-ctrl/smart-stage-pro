// Run with: npm test
process.env.AGENT_MARKETING_READABILITY = "off"; // these tests run research with no network; the readability check has its own tests
const test = require("node:test");
const assert = require("node:assert");
const run = require("../netlify/functions/lib/agent-marketing-research-run-lib");

const NOW = "2026-10-24T17:00:00Z";
const ENV = {}; // defaults: perplexity/sonar, medium context, one corrective retry, $0.025 target
// No ZIP on purpose: these tests are about the topic call and its cost.
const row = { id: "r1", mode: "market_update", audience: "sellers", geography: { type: "city", name: "Roseville", city: "", state: "CA", label: "Roseville, CA" }, focus: {}, upload_refs: [] };
const noSleep = async () => {};

const Q = [
  "Why are some Roseville homes taking longer to sell?",
  "Does spring bring more competing listings to Roseville?",
  "How are builder incentives changing resale pricing near new communities?",
  "What are mortgage rate buydowns doing to buyer budgets?",
  "Which price bands are seeing the most pending sales this month?",
];
const url = (n) => `https://site${n}.example.org/report-${n}`;
const topic = (n) => ({ question: Q[n - 1], why_it_matters: "It changes how sellers price.", trend_signals: ["MLS active listings up month over month"], local_intent: true, scope: "selected", scope_note: null, event: null, sources: [{ title: `Report ${n}`, url: url(n), published: "2026-10-20" }] });
const five = () => [1, 2, 3, 4, 5].map(topic);
const reply = (topics, extra) => ({
  status: 200,
  json: { output: [{ type: "search_results", results: [1, 2, 3, 4, 5].map((i) => ({ url: url(i) })) }, { type: "message", content: [{ type: "output_text", text: "```json\n" + JSON.stringify({ topics }) + "\n```" }] }], usage: { input_tokens: 600, output_tokens: 1500, tool_calls_details: { search_web: { invocation: 2 } } }, ...(extra || {}) },
});

test("cost: estimated from the published rates when the provider sends none", () => {
  assert.strictEqual(run.estimateCostUsd("perplexity/sonar", { promptTokens: 600, completionTokens: 1500, searchQueries: 2 }), 0.0089);
  assert.strictEqual(run.estimateCostUsd("openai/gpt-6-luna", { promptTokens: 10000, completionTokens: 2000, searchQueries: 3 }), 0.0095);
  assert.strictEqual(run.estimateCostUsd("mystery-model", { promptTokens: 1, completionTokens: 1 }), null);
  assert.strictEqual(run.estimateCostUsd("perplexity/sonar", {}), null);
});

test("today is the Pacific calendar day", () => {
  assert.strictEqual(run.todayPT("2026-10-24T17:00:00Z"), "2026-10-24");
  assert.strictEqual(run.todayPT("2026-10-25T02:00:00Z"), "2026-10-24"); // still the 24th in California
});

test("grounding: a source the provider never found is dropped; the provider's own date wins; no provider list means no filtering", () => {
  const t = [{ sources: [{ title: "a", url: "https://www.site1.example.org/report-1/?utm_source=x", published: "2026-10-01" }, { title: "invented", url: "https://made-up.example/x", published: "2026-10-20" }] }];
  const g = run.groundTopics(t, { search_results: [{ url: "https://site1.example.org/report-1", date: "2026-10-22T08:00:00Z" }] });
  assert.strictEqual(g.grounded, true);
  assert.strictEqual(g.topics[0].sources.length, 1);
  assert.strictEqual(g.topics[0].sources[0].published, "2026-10-22");
  const none = run.groundTopics(t, { choices: [] });
  assert.strictEqual(none.grounded, false);
  assert.strictEqual(none.topics[0].sources.length, 2);
  assert.strictEqual(run.groundTopics(t, { citations: [{ url: "https://site1.example.org/report-1" }] }).topics[0].sources.length, 1);
});

test("provider: busy answers are retried, a rejected model spelling is tried once, a bad key is a plain message", async () => {
  let calls = [];
  const seq = (answers) => async (payload) => { calls.push(payload.model); return answers.shift(); };
  const ok = { status: 200, json: { output: [] } };
  calls = [];
  const a = await run.askProvider({ payload: { model: "perplexity/sonar" }, apiKey: "k", callFn: seq([{ status: 429, json: {} }, { status: 503, json: {} }, ok]), sleepFn: noSleep, retries: 2 });
  assert.strictEqual(a.resp, ok.json);
  assert.strictEqual(calls.length, 3);
  calls = [];
  await assert.rejects(run.askProvider({ payload: { model: "perplexity/sonar" }, apiKey: "SECRET-KEY", callFn: seq([{ status: 401, json: { error: "bad key SECRET-KEY" } }]), sleepFn: noSleep, retries: 2 }), (e) => !/SECRET-KEY/.test(e.message) && /not set up/.test(e.message));
  await assert.rejects(run.askProvider({ payload: { model: "perplexity/sonar" }, apiKey: "k", callFn: async () => { throw new Error("socket hang up"); }, sleepFn: noSleep, retries: 1 }), /busy|timed out/);
  await assert.rejects(run.askProvider({ payload: { model: "perplexity/sonar" }, apiKey: "k", callFn: seq([{ status: 422, json: {} }]), sleepFn: noSleep, retries: 2 }), /not accepted/);
});

test("run: five grounded topics are delivered and charged; cost is estimated and compared with the $0.025 target", async () => {
  let sent;
  const r = await run.runResearch({ row, apiKey: "k", now: NOW, env: ENV, sleepFn: noSleep, callFn: async (p) => { sent = p; return reply(five()); } });
  assert.strictEqual(r.fields.status, "ready");
  assert.strictEqual(r.fields.topics.length, 5);
  assert.strictEqual(r.fields.charged_at, "2026-10-24T17:00:00.000Z");
  assert.strictEqual(r.fields.research_date, "2026-10-24");
  assert.strictEqual(r.attempts, 1);
  assert.strictEqual(r.fields.usage.costUsd, 0.0089);
  assert.strictEqual(r.fields.usage.costEstimated, true);
  assert.strictEqual(r.fields.usage.withinTarget, true);
  assert.strictEqual(r.fields.usage.grounded, true);
  assert.match(sent.input, /Roseville, CA/);
  assert.strictEqual(sent.model, "perplexity/sonar");
  assert.strictEqual(sent.tools[0].type, "web_search");
});

test("run: a provider-reported cost beats the estimate and can miss the target", async () => {
  const r = await run.runResearch({ row, apiKey: "k", now: NOW, env: ENV, sleepFn: noSleep, callFn: async () => reply(five(), { usage: { input_tokens: 600, output_tokens: 1500, cost: { total_cost: 0.06 } } }) });
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
  assert.strictEqual(r.fields.topics.length, 5);
  assert.match(sent[1].input, /usable but needs work/);
  assert.match(sent[1].input, /only 4 of 5 topics/);
});

test("run: a partial answer is retried once, then delivered and charged (Sam, Oct 28: one usable article is a usable run)", async () => {
  const r = await run.runResearch({ row, apiKey: "k", now: NOW, env: ENV, sleepFn: noSleep, callFn: async () => reply(five().slice(0, 3)) });
  assert.strictEqual(r.fields.status, "ready");
  assert.strictEqual(r.fields.topics.length, 3);
  assert.ok(r.fields.charged_at);
  assert.strictEqual(r.attempts, 2);
  assert.match(r.fields.usage.reportNote, /Only 3 of 5/);
  const retries0 = await run.runResearch({ row, apiKey: "k", now: NOW, env: { AGENT_MARKETING_RESEARCH_RETRIES: "0" }, sleepFn: noSleep, callFn: async () => reply(five().slice(0, 3)) });
  assert.strictEqual(retries0.attempts, 1);
  const none = await run.runResearch({ row, apiKey: "k", now: NOW, env: ENV, sleepFn: noSleep, callFn: async () => reply([]) });
  assert.strictEqual(none.fields.status, "failed");
  assert.strictEqual(none.fields.charged_at, null);
  assert.strictEqual(none.fields.topics, null);
  assert.strictEqual(none.attempts, 2);
  assert.ok(none.fields.usage.costUsd > 0); // the spend is recorded even though the subscriber is not charged
});

test("run: prose instead of JSON, invented sources and a dead provider all fail uncharged", async () => {
  const prose = await run.runResearch({ row, apiKey: "k", now: NOW, env: { AGENT_MARKETING_RESEARCH_RETRIES: "0" }, sleepFn: noSleep, callFn: async () => ({ status: 200, json: { output_text: "I could not find anything.", usage: { input_tokens: 10, output_tokens: 10 } } }) });
  assert.strictEqual(prose.fields.status, "failed");
  assert.strictEqual(prose.fields.charged_at, null);
  const invented = five(); invented[2].sources = [{ title: "Fake", url: "https://made-up.example/report", published: "2026-10-20" }];
  const inv = await run.runResearch({ row, apiKey: "k", now: NOW, env: { AGENT_MARKETING_RESEARCH_RETRIES: "0" }, sleepFn: noSleep, callFn: async () => reply(invented) });
  assert.strictEqual(inv.fields.status, "ready");            // the topic with an invented source is left out; the other four are kept
  assert.strictEqual(inv.fields.topics.length, 4);
  assert.match(inv.problems.join(" "), /no usable source/);
  const dead = await run.runResearch({ row, apiKey: "SECRET-KEY", now: NOW, env: ENV, sleepFn: noSleep, callFn: async () => ({ status: 500, json: { error: "boom SECRET-KEY" } }) });
  assert.strictEqual(dead.fields.status, "failed");
  assert.strictEqual(dead.fields.charged_at, null);
  assert.ok(!/SECRET-KEY/.test(JSON.stringify(dead.fields)));
  assert.match(dead.fields.error, /busy/);
});

test("run: when the provider rejects the key, the reason is kept with the failed session and the key never is", async () => {
  const r = await run.runResearch({ row, apiKey: "pplx-SECRET123", now: NOW, env: ENV, sleepFn: noSleep, callFn: async () => ({ status: 401, json: { error: { message: "Invalid API key pplx-SECRET123 for Bearer pplx-SECRET123" } } }) });
  assert.strictEqual(r.fields.status, "failed");
  assert.strictEqual(r.fields.charged_at, null);
  assert.match(r.fields.error, /not set up correctly/);
  assert.match(r.fields.usage.providerError, /^401: Invalid API key/);
  assert.ok(!/SECRET123|pplx-/.test(JSON.stringify(r.fields)));
  const ok = await run.runResearch({ row, apiKey: "k", now: NOW, env: ENV, sleepFn: noSleep, callFn: async () => reply(five()) });
  assert.strictEqual(ok.fields.usage.providerError, null);
});

test("run: events mode asks for events and accepts a verified upcoming set", async () => {
  const ev = (n) => ({ question: ["Is the harvest festival at the town square this weekend?", "When does the lantern walk start downtown?", "Where is the chili cook-off being held?", "What time is the jazz concert in the park?", "Does the holiday tree lighting need tickets?"][n - 1], why_it_matters: "Neighbors can plan around it.", trend_signals: [], local_intent: true, scope: "selected", event: { name: `Event ${n}`, date: "2026-10-31", end_date: null, time: "10am to 4pm", location: "Town Square, Roseville", organizer: "City of Roseville", status: "upcoming" }, sources: [{ title: "City page", url: url(n), published: null }] });
  let sent;
  const r = await run.runResearch({ row: { ...row, mode: "local_events", audience: "general" }, apiKey: "k", now: NOW, env: ENV, sleepFn: noSleep, callFn: async (p) => { sent = p; return reply([1, 2, 3, 4, 5].map(ev)); } });
  assert.strictEqual(r.fields.status, "ready", r.problems.join("; "));
  assert.match(sent.instructions, /MODE: Local Events/);
  assert.strictEqual(r.fields.topics[0].event.organizer, "City of Roseville");
});

test("plan key: brokerage and team members use their tier, everyone else Solo", () => {
  assert.strictEqual(run.planKeyFromContext({ poolKind: "brokerage" }), "brokerage");
  assert.strictEqual(run.planKeyFromContext({ poolKind: "team" }), "team");
  assert.strictEqual(run.planKeyFromContext({ poolKind: "user" }), "solo");
  assert.strictEqual(run.planKeyFromContext(null), "solo");
});

test("run: topics that share one publisher are fine: one attempt, no retry, no note (the publisher rule was removed Oct 27)", async () => {
  const oneSite = reply(five().map((t, n) => ({ ...t, sources: [{ title: "Local news story", url: `https://news.example.org/story-${n}`, published: "2026-10-20" }] })));
  const grounded = { ...oneSite, json: { ...oneSite.json, output: [{ type: "search_results", results: [0, 1, 2, 3, 4].map((i) => ({ url: `https://news.example.org/story-${i}` })) }, oneSite.json.output[1]] } };
  const r = await run.runResearch({ row, apiKey: "k", now: NOW, env: ENV, sleepFn: noSleep, callFn: async () => grounded });
  assert.strictEqual(r.fields.status, "ready");
  assert.ok(r.fields.charged_at);
  assert.strictEqual(r.attempts, 1);
  assert.strictEqual(r.fields.usage.reportNote, null);
});

test("run: keywords asked for but no topic matches them: the agent is told, nothing is passed off as a match", async () => {
  const kwRow = { ...row, focus: { keywords: "short sales" } };
  const none = await run.runResearch({ row: kwRow, apiKey: "k", now: NOW, env: ENV, sleepFn: noSleep, callFn: async () => reply(five()) });
  assert.strictEqual(none.fields.status, "ready");
  assert.match(none.fields.usage.reportNote, /No article about \u201cshort sales\u201d was found/);
  const hit = await run.runResearch({ row: kwRow, apiKey: "k", now: NOW, env: ENV, sleepFn: noSleep, callFn: async () => reply(five().map((t, n) => (n < 2 ? { ...t, keyword_match: true } : t))) });
  assert.strictEqual(hit.fields.usage.reportNote, null);
  assert.strictEqual(hit.fields.topics.filter((t) => t.keywordMatch).length, 2);
  const noKw = await run.runResearch({ row, apiKey: "k", now: NOW, env: ENV, sleepFn: noSleep, callFn: async () => reply(five()) });
  assert.strictEqual(noKw.fields.usage.reportNote, null);
});

test("run: a failed set records why it was rejected", async () => {
  const r = await run.runResearch({ row, apiKey: "k", now: NOW, env: { AGENT_MARKETING_RESEARCH_RETRIES: "0" }, sleepFn: noSleep, callFn: async () => reply([]) });
  assert.strictEqual(r.fields.status, "failed");
  assert.ok(r.fields.usage.problems.length > 0);
  assert.match(r.fields.usage.problems.join(" "), /expected 5 topics/);
});

test("run: a refused topic set keeps what the provider said (topicDebug); a good one keeps nothing extra", async () => {
  const empty = { status: 200, json: { output: [{ type: "message", content: [{ type: "output_text", text: JSON.stringify({ topics: [] }) }] }] } };
  const bad = await run.runResearch({ row, apiKey: "k", now: NOW, env: { AGENT_MARKETING_RESEARCH_RETRIES: "0" }, sleepFn: noSleep, callFn: async () => empty });
  assert.strictEqual(bad.fields.status, "failed");
  assert.match(bad.fields.usage.problems.join(" "), /expected 5 topics, got 0/);
  assert.match(bad.fields.usage.topicDebug.answer, /"topics":\[\]/);
  assert.strictEqual(bad.fields.usage.topicDebug.attempt, 1);
  const good = await run.runResearch({ row, apiKey: "k", now: NOW, env: ENV, sleepFn: noSleep, callFn: async () => reply(five()) });
  assert.strictEqual(good.fields.usage.topicDebug, null);
});
