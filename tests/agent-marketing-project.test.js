// End-to-end test of the project endpoint with an in-memory fake database (no network).
const test = require("node:test");
const assert = require("node:assert");
const path = require("node:path");

const U1 = "11111111-1111-4111-8111-111111111111";
const U2 = "22222222-2222-4222-8222-222222222222";
let currentUser = U1;
const rows = [];
let nextId = 1;

// Stub the two modules that touch the network, before the handler loads.
const libPath = require.resolve("../netlify/functions/lib/marketing-profile-lib");
const authPath = require.resolve("../netlify/functions/lib/reel-auth-lib");
// A chosen research topic (what the Research step freezes on the project).
const TOPIC = { id: "t2", researchId: "bbbbbbbb-bbbb-4bbb-8bbb-000000000001", question: "Are homes in Roseville taking longer to sell?", whyItMatters: "Sellers are pricing off old sales.", scope: "selected", scopeNote: "", origin: "web", audience: "sellers",
  geography: { type: "city", name: "Roseville", state: "CA", label: "Roseville, CA" }, sources: [{ type: "web", url: "https://example.com/a", title: "A", domain: "example.com" }] };
const uuid = (n) => `aaaaaaaa-aaaa-4aaa-8aaa-${String(n).padStart(12, "0")}`;
function fakeSupabase(method, table, body, qs = "") {
  assert.strictEqual(table, "agent_marketing_projects");
  const q = new URLSearchParams(qs.replace(/^\?/, ""));
  const idEq = (q.get("id") || "").replace("eq.", "");
  const userEq = (q.get("user_id") || "").replace("eq.", "");
  if (method === "POST") { const row = { id: uuid(nextId++), status: "draft", intake: {}, selected_topic: TOPIC, created_at: "t", updated_at: "t", ...body }; rows.push(row); return Promise.resolve({ status: 201, data: [row] }); }
  const match = rows.filter((r) => (!idEq || r.id === idEq) && (!userEq || r.user_id === userEq));
  if (method === "GET") return Promise.resolve({ status: 200, data: match });
  if (method === "PATCH") { match.forEach((r) => Object.assign(r, body)); return Promise.resolve({ status: 200, data: match }); }
  throw new Error("unexpected " + method);
}
require.cache[libPath] = { id: libPath, filename: libPath, loaded: true, exports: { supabase: fakeSupabase } };
require.cache[authPath] = { id: authPath, filename: authPath, loaded: true, exports: { requireUser: async () => ({ user: { id: currentUser } }) } };
const { handler } = require("../netlify/functions/agent-marketing-project");

const call = async (method, body, qs) => {
  const res = await handler({ httpMethod: method, headers: {}, body: body ? JSON.stringify(body) : null, queryStringParameters: qs || null });
  return { status: res.statusCode, json: JSON.parse(res.body) };
};
const intake = { angle: "neighborhood", market: "Roseville, CA", audience: "Home sellers", issue: "Supply and buyer demand", action: "Understand the trade-off", observation: "Resale homes near new construction get more buyer traffic, but builders have incentives and rate buy-downs." };
const script = "[conversational] Is new construction helping or hurting your resale home? [thoughtful] Nearby new communities can bring more interested buyers, but also more competition. [emphasis] Builders may offer incentives or rate buydowns that change the comparison.";

test("switch off: every call answers 404", async () => {
  delete process.env.AGENT_MARKETING_ENABLED;
  assert.strictEqual((await call("GET", null, { schema: "1" })).status, 404);
  assert.strictEqual((await call("POST", { action: "create" })).status, 404);
});

test("full flow: create, intake, script, approve", async () => {
  process.env.AGENT_MARKETING_ENABLED = "true";
  const schema = await call("GET", null, { schema: "1" });
  assert.strictEqual(schema.status, 200);
  assert.ok(schema.json.attestation.text);

  const c = await call("POST", { action: "create" });
  assert.strictEqual(c.status, 200);
  const id = c.json.project.id;
  assert.strictEqual(c.json.project.durationSec, 45);

  const i = await call("POST", { action: "save_intake", id, intake });
  assert.strictEqual(i.status, 200);
  assert.strictEqual(i.json.project.angle, "neighborhood");

  assert.strictEqual((await call("POST", { action: "approve_narrative", id })).status, 409); // nothing to approve yet

  const n = await call("POST", { action: "save_narrative", id, narrative: { narrationTagged: script, cta: { text: "Understand your home's competition.", source: "user_edited" } } });
  assert.strictEqual(n.status, 200);
  assert.ok(!/\[/.test(n.json.project.narrative.captionText));
  assert.strictEqual(n.json.project.status, "narrative_ready");

  const a = await call("POST", { action: "approve_narrative", id });
  assert.strictEqual(a.status, 200);
  assert.strictEqual(a.json.project.status, "narrative_approved");
  assert.ok(rows[0].narrative_approved.approvedAt);

  // editing after approval returns to narrative_ready but never touches the frozen approved copy
  const frozen = JSON.stringify(rows[0].narrative_approved);
  await call("POST", { action: "save_narrative", id, narrative: { narrationTagged: script + " Ask me." } });
  assert.strictEqual(rows[0].status, "narrative_ready");
  assert.strictEqual(JSON.stringify(rows[0].narrative_approved), frozen);
});

test("property-sale content is rejected with a clear message and nothing is saved", async () => {
  process.env.AGENT_MARKETING_ENABLED = "true";
  const id = (await call("POST", { action: "create" })).json.project.id;
  const bad = await call("POST", { action: "save_intake", id, intake: { ...intake, observation: "Just listed at 1234 Oak Ridge Drive, open house Saturday!" } });
  assert.strictEqual(bad.status, 422);
  assert.match(bad.json.error, /Listing Reel/);
  const withField = await call("POST", { action: "save_intake", id, intake: { ...intake, address: "1234 Oak Ridge Drive" } });
  assert.strictEqual(withField.status, 422);
  const row = rows.find((r) => r.id === id);
  assert.deepStrictEqual(row.intake, {});
  const cta = await call("POST", { action: "save_narrative", id, narrative: { narrationTagged: script, cta: { text: "Schedule a private tour today", source: "user_inserted" } } });
  assert.strictEqual(cta.status, 409); // intake not answered yet
  await call("POST", { action: "save_intake", id, intake });
  const cta2 = await call("POST", { action: "save_narrative", id, narrative: { narrationTagged: script, cta: { text: "Schedule a private tour today", source: "user_inserted" } } });
  assert.strictEqual(cta2.status, 422);
});

test("projects are private to their owner", async () => {
  process.env.AGENT_MARKETING_ENABLED = "true";
  currentUser = U1;
  const id = (await call("POST", { action: "create" })).json.project.id;
  currentUser = U2;
  assert.strictEqual((await call("GET", null, { id })).status, 404);
  assert.strictEqual((await call("POST", { action: "save_intake", id, intake })).status, 404);
  const mine = await call("GET");
  assert.ok(mine.json.projects.every((p) => p.id !== id));
  currentUser = U1;
});

test("a finished piece cannot be edited", async () => {
  process.env.AGENT_MARKETING_ENABLED = "true";
  const id = (await call("POST", { action: "create" })).json.project.id;
  rows.find((r) => r.id === id).status = "rendering";
  assert.strictEqual((await call("POST", { action: "save_intake", id, intake })).status, 409);
});

// ── plan action + background planner ───────────────────────────────────────────────────────────────────────────
const planLib = require("../netlify/functions/lib/agent-marketing-plan-lib");
const bg = require("../netlify/functions/agent-marketing-plan-background");

const planExcerpts = [
  "Is new construction helping or hurting your resale home?",
  "Here's what I see near new communities. More interested buyers come in, and that can help.",
  "But it also puts your home next to brand new competition.",
  "Builders often have incentives and rate buydowns, which changes how buyers compare.",
  "So don't judge your value on resale listings alone.",
  "Compare the full picture, and ask me for a local perspective.",
];
const planJson = JSON.stringify({
  editorial_angle: "a", hook: planExcerpts[0],
  narration_with_audio_tags: "[conversational] " + planExcerpts.join(" "),
  scenes: planExcerpts.map((t, i) => ({ role: "r" + i, narration_excerpt: t, purpose: "p", visual_source: i === 1 || i === 3 || i === 4 ? "GPT_IMAGE_2_CONCEPT" : "AUTHENTIC_AGENT_ASSET", visual_brief: "b",
    authentic_photo_request: { best_image: "x", should_contain: "y", avoid: "z", if_unavailable: "w" }, ai_generation_prompt: "Photorealistic tabletop models, no people, no text", camera_motion: "push_in", framing_9x16: "a", framing_16x9: "b", text_safe_placement: "c" })),
  cta_suggestion: "Ask me for a local perspective.", claims_to_verify: [], missing_agent_inputs: [],
});

test("plan: dispatches once, rejects duplicates, and the background run fills in the script", async () => {
  process.env.AGENT_MARKETING_ENABLED = "true";
  process.env.ANTHROPIC_API_KEY = "test"; process.env.INTERNAL_API_KEY = "secret"; process.env.URL = "https://example.test";
  currentUser = U1;
  const id = (await call("POST", { action: "create" })).json.project.id;
  assert.strictEqual((await call("POST", { action: "plan", id })).status, 409); // no intake yet
  await call("POST", { action: "save_intake", id, intake });

  const calls = [];
  const realFetch = global.fetch;
  global.fetch = async (url, opts) => { calls.push({ url, opts }); return { ok: true, status: 202 }; };
  try {
    const p = await call("POST", { action: "plan", id });
    assert.strictEqual(p.status, 202);
    assert.strictEqual(calls.length, 1);
    assert.match(calls[0].url, /agent-marketing-plan-background$/);
    assert.strictEqual(calls[0].opts.headers["x-internal-key"], "secret");
    const row = rows.find((r) => r.id === id);
    assert.strictEqual(row.narrative.status, "planning");
    assert.strictEqual((await call("POST", { action: "plan", id })).status, 409); // already planning

    // the background function: wrong key is refused
    assert.strictEqual((await bg.handler({ headers: { "x-internal-key": "nope" }, body: JSON.stringify({ projectId: id, owner: U1 }) })).statusCode, 401);
    // wrong owner does nothing
    assert.strictEqual((await bg.handler({ headers: { "x-internal-key": "secret" }, body: JSON.stringify({ projectId: id, owner: U2 }) })).statusCode, 404);
    assert.strictEqual(row.narrative.status, "planning");

    // right key and owner: Claude is called once and the script is saved
    let claudeCalls = 0;
    const realCall = planLib.callClaudeText;
    planLib.callClaudeText = async () => { claudeCalls++; return planJson; };
    try {
      await bg.handler({ headers: { "x-internal-key": "secret" }, body: JSON.stringify({ projectId: id, owner: U1 }) });
      await bg.handler({ headers: { "x-internal-key": "secret" }, body: JSON.stringify({ projectId: id, owner: U1 }) }); // duplicate delivery
    } finally { planLib.callClaudeText = realCall; }
    assert.strictEqual(claudeCalls, 1);
    assert.strictEqual(row.status, "narrative_ready");
    assert.strictEqual(row.narrative.status, "ready");
    assert.strictEqual(row.narrative.source, "claude");
    assert.strictEqual(row.narrative.scenes.length, 6);
    assert.strictEqual(row.narrative.attempts, 1);

    // same answers: no second purchase of a plan; changed answers: allowed again
    assert.strictEqual((await call("POST", { action: "plan", id })).status, 409);
    await call("POST", { action: "save_intake", id, intake: { ...intake, observation: intake.observation + " I also see buyers comparing monthly payments." } });
    assert.strictEqual((await call("POST", { action: "plan", id })).status, 202);
    assert.strictEqual(row.narrative.attempts, 2);

    // approving a planned (Claude) script works and uses the strict rules
    row.narrative = { ...JSON.parse(JSON.stringify(row.narrative)), status: "ready", source: "claude", narrationTagged: "[conversational] " + planExcerpts.join(" "), captionText: planExcerpts.join(" "), scenes: planExcerpts.map((t) => ({ narrationExcerpt: t })), cta: { text: "Ask me for a local perspective.", source: "claude" } };
    assert.strictEqual((await call("POST", { action: "approve_narrative", id })).status, 200);
  } finally { global.fetch = realFetch; }
});

test("plan: a failed Claude call is recorded as an error and can be retried, up to the attempt cap", async () => {
  process.env.AGENT_MARKETING_ENABLED = "true";
  process.env.ANTHROPIC_API_KEY = "test"; process.env.INTERNAL_API_KEY = "secret"; process.env.URL = "https://example.test";
  currentUser = U1;
  const id = (await call("POST", { action: "create" })).json.project.id;
  await call("POST", { action: "save_intake", id, intake });
  const row = rows.find((r) => r.id === id);
  const realFetch = global.fetch; global.fetch = async () => ({ ok: true });
  const realCall = planLib.callClaudeText;
  try {
    for (let n = 1; n <= planLib.MAX_ATTEMPTS; n++) {
      assert.strictEqual((await call("POST", { action: "plan", id })).status, 202);
      planLib.callClaudeText = async () => { throw new Error("boom"); };
      await bg.handler({ headers: { "x-internal-key": "secret" }, body: JSON.stringify({ projectId: id, owner: U1 }) });
      assert.strictEqual(row.narrative.status, "error");
      assert.strictEqual(row.narrative.attempts, n);
    }
    assert.strictEqual((await call("POST", { action: "plan", id })).status, 429);
  } finally { global.fetch = realFetch; planLib.callClaudeText = realCall; }
});

test("edits keep the planner's scenes and counters and flag stale scenes", async () => {
  process.env.AGENT_MARKETING_ENABLED = "true";
  currentUser = U1;
  const id = (await call("POST", { action: "create" })).json.project.id;
  await call("POST", { action: "save_intake", id, intake });
  const row = rows.find((r) => r.id === id);
  row.narrative = { status: "ready", source: "claude", narrationTagged: "[warm] Original words here.", scenes: [{ index: 0, narrationExcerpt: "Original words here." }], attempts: 1, intakeHash: "abc", claimsToVerify: ["x"] };
  const r = await call("POST", { action: "save_narrative", id, narrative: { narrationTagged: "[warm] My own edited words here." } });
  assert.strictEqual(r.status, 200);
  assert.strictEqual(row.narrative.source, "edited");
  assert.strictEqual(row.narrative.scenes.length, 1);
  assert.strictEqual(row.narrative.attempts, 1);
  assert.strictEqual(row.narrative.intakeHash, "abc");
  assert.strictEqual(row.narrative.scenesStale, true);
  assert.deepStrictEqual(row.narrative.claimsToVerify, ["x"]);
});

test("a topic makes the angle and issue optional, fills market and audience from the research, and is required to save", async () => {
  process.env.AGENT_MARKETING_ENABLED = "true";
  const c = await call("POST", { action: "create", template: "local_market_insider", durationSec: 45, formats: ["9x16"], voice: "ssp_male" });
  const id = c.json.project.id;
  const ok = await call("POST", { action: "save_intake", id, intake: { action: "Compare options", observation: "" } });
  assert.strictEqual(ok.status, 200, JSON.stringify(ok.json));
  assert.strictEqual(ok.json.project.intake.market, "Roseville, CA");
  assert.strictEqual(ok.json.project.intake.audience, "Home sellers");
  assert.strictEqual(ok.json.project.intake.angle, "");
  assert.deepStrictEqual(ok.json.needsInput, ["observation"]);
  assert.strictEqual(ok.json.project.selectedTopic.id, "t2");
  const bad = await call("POST", { action: "save_intake", id, intake: { angle: "nonsense", action: "Compare options" } });
  assert.strictEqual(bad.status, 400);
  const bare = await call("POST", { action: "create", template: "local_market_insider", durationSec: 45, formats: ["9x16"], voice: "ssp_male" });
  rows.find((r) => r.id === bare.json.project.id).selected_topic = null;
  const none = await call("POST", { action: "save_intake", id: bare.json.project.id, intake: { action: "Compare options" } });
  assert.strictEqual(none.status, 409);
  assert.match(none.json.error, /five topics/);
  const plan = await call("POST", { action: "plan", id: bare.json.project.id });
  assert.strictEqual(plan.status, 409);
});

test("a script written for another topic cannot be approved for the topic now selected", async () => {
  currentUser = U1;
  const c = await call("POST", { action: "create", template: "local_market_insider", durationSec: 45 });
  const id = c.json.project.id; const row = rows.find((r) => r.id === id);
  await call("POST", { action: "save_intake", id, intake });
  await call("POST", { action: "save_narrative", id, narrative: { narrationTagged: script, cta: { text: "Understand your home's competition.", source: "user_edited" } } });
  const planLib = require("../netlify/functions/lib/agent-marketing-plan-lib");
  const prior = row.narrative;
  // the script came from the planner for a different topic
  row.narrative = { ...prior, intakeHash: planLib.intakeHash(row.intake, { ...TOPIC, id: "t3" }) };
  const stale = await call("POST", { action: "approve_narrative", id });
  assert.strictEqual(stale.status, 409); assert.strictEqual(stale.json.code, "script_stale");
  // the same script for the selected topic is fine
  row.narrative = { ...prior, intakeHash: planLib.intakeHash(row.intake, row.selected_topic) };
  assert.strictEqual((await call("POST", { action: "approve_narrative", id })).status, 200);
});
