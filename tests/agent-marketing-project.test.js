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
const uuid = (n) => `aaaaaaaa-aaaa-4aaa-8aaa-${String(n).padStart(12, "0")}`;
function fakeSupabase(method, table, body, qs = "") {
  assert.strictEqual(table, "agent_marketing_projects");
  const q = new URLSearchParams(qs.replace(/^\?/, ""));
  const idEq = (q.get("id") || "").replace("eq.", "");
  const userEq = (q.get("user_id") || "").replace("eq.", "");
  if (method === "POST") { const row = { id: uuid(nextId++), status: "draft", intake: {}, created_at: "t", updated_at: "t", ...body }; rows.push(row); return Promise.resolve({ status: 201, data: [row] }); }
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
