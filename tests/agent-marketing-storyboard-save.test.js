// Nov 14, 2026 (Sam, Option 2 beta): save_narrative keeps the AI plan only for the words it was planned for (handler level, stubbed storage).
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
  geography: { zip: "95678", type: "city", name: "Roseville", state: "CA", label: "Roseville, CA" }, sources: [{ type: "web", url: "https://example.com/a", title: "A", domain: "example.com" }] };
const uuid = (n) => `aaaaaaaa-aaaa-4aaa-8aaa-${String(n).padStart(12, "0")}`;
function fakeSupabase(method, table, body, qs = "") {
  if (table === "agent_marketing_jobs" && method === "GET") return Promise.resolve({ status: 200, data: [] });   // the project list also asks for each project's newest Reel job
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
const am = require("../netlify/functions/lib/agent-marketing-lib");
const intake = { angle: "neighborhood", market: "Roseville, CA", audience: "Home sellers", issue: "Supply and buyer demand", action: "Understand the trade-off", observation: "Resale homes near new construction" };
const SCENES = ["Has your buyer pool quietly shrunk since last year? Here is what I think sellers need to hear.", "A buyer on a median priced home now pays noticeably more every month than a year ago, assuming a steady down payment.", "That is not a paper number, that is who can qualify for your home.", "Active listings are rising while closed sales keep slipping, and homes are sitting longer than they were.", "I keep a close eye on this, so let us talk about where your home sits in that buyer pool today."];
const AI = SCENES.join(" ");
async function setup(dur = 45) {
  const id = (await call("POST", { action: "create" })).json.project.id;
  const row = rows.find((r) => r.id === id);
  row.duration_sec = dur;
  await call("POST", { action: "save_intake", id, intake });
  row.narrative = { source: "claude", status: "ready", editorialAngle: "AI ANGLE", hook: "AI HOOK", claimsToVerify: ["AI CLAIM"], narrationTagged: AI, captionText: AI, wordCount: am.countWords(AI),
    scenes: SCENES.map((t, i) => ({ index: i, role: "r" + i, narrationExcerpt: t, purpose: "p", visualSource: "GPT_IMAGE_2_CONCEPT", sourceRole: "data" })) };
  return id;
}
const save = (id, text) => call("POST", { action: "save_narrative", id, narrative: { narrationTagged: text, cta: { text: "Want to talk?", source: "user_edited" } } });
const flag = async (on, fn) => { process.env.AGENT_MARKETING_ENABLED = "true"; if (on) process.env.AGENT_MARKETING_B1_EVIDENCE = "dev"; else delete process.env.AGENT_MARKETING_B1_EVIDENCE; try { return await fn(); } finally { delete process.env.AGENT_MARKETING_B1_EVIDENCE; } };

test("article-led: saving the AI words unchanged keeps the plan; a changed script marks the scenes stale and drops the discarded angle, claims and hook; changing back restores", async () => {
  await flag(true, async () => {
    const id = await setup();
    const row = () => rows.find((r) => r.id === id).narrative;
    let r = await save(id, AI);
    assert.strictEqual(r.status, 200);
    assert.strictEqual(row().scenesStale, false);
    assert.strictEqual(row().scenesFor, am.narrationKey(AI));
    assert.strictEqual(row().editorialAngle, "AI ANGLE");
    assert.deepStrictEqual(row().claimsToVerify, ["AI CLAIM"]);
    const edited = "What if sellers are pricing for buyers who no longer exist? Rates changed what a family can afford each month, and that changes who walks through your door. If you plan to sell, price for today's buyer, not last spring's. Want me to show you where your home lands?";
    r = await save(id, edited);
    assert.strictEqual(r.status, 200);
    assert.strictEqual(row().scenesStale, true);
    assert.strictEqual(row().editorialAngle, "");
    assert.deepStrictEqual(row().claimsToVerify, []);
    assert.strictEqual(row().hook, "What if sellers are pricing for buyers who no longer exist?");
    assert.strictEqual(row().scenesFor, am.narrationKey(AI), "the scenes still say which words they were planned for");
    assert.strictEqual(am.storyboardNeeded(row()), true);
    await save(id, AI);
    assert.strictEqual(row().scenesStale, false);
    assert.strictEqual(am.storyboardNeeded(row()), false, "an edit undone needs no new storyboard");
  });
});

test("approval records the approved words exactly, and carries the stale flag to the render step", async () => {
  await flag(true, async () => {
    const id = await setup();
    const edited = "What if sellers are pricing for buyers who no longer exist? Rates changed what a family can afford each month, and that changes who walks through your door. If you plan to sell, price for today's buyer, not last spring's. Want me to show you where your home lands?";
    await save(id, edited);
    const a = await call("POST", { action: "approve_narrative", id });
    if (a.status === 200) {
      const ap = rows.find((r) => r.id === id).narrative_approved;
      assert.strictEqual(ap.narrationTagged, edited);
      assert.strictEqual(am.storyboardNeeded(ap), true);
    } else assert.ok([409, 422].includes(a.status), "approval can be refused only by its existing checks: " + JSON.stringify(a.json).slice(0, 160));
  });
});

test("without the article-led switch the save is unchanged: no plan bookkeeping, scenes never marked stale", async () => {
  await flag(false, async () => {
    const id = await setup();
    const r = await save(id, AI + " Thank you.");
    assert.strictEqual(r.status, 200);
    const n = rows.find((x) => x.id === id).narrative;
    assert.strictEqual(n.scenesStale, false);
    assert.strictEqual(n.scenesFor, undefined);
    assert.strictEqual(n.editorialAngle, "AI ANGLE");
  });
});
