// Nov 12, 2026 (Sam): word count never blocks approval. A 162- or 177-word 60-second Test script is approved when the content checks pass.
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
const intake = { angle: "neighborhood", market: "Roseville, CA", audience: "Home sellers", issue: "Supply and buyer demand", action: "Understand the trade-off", observation: "Resale homes near new construction see more interested buyers but also new competition." };
const base = "[conversational] Is new construction helping or hurting your resale home? [thoughtful] Nearby new communities can bring more interested buyers, but also more competition. [emphasis] Builders may offer incentives or rate buydowns that change the comparison.";
const EXTRA = [" Buyers compare your home with the ones down the street, and they notice the small things first.", " Walk the neighborhood the way a buyer would, and be honest about what you see on the way in.", " A well prepared home still earns attention, even when a new community opens nearby and draws the crowds.", " I would rather you hear that from me now than from a buyer later, so ask me what I see in your area."];
const pad = (n) => { let t = base, i = 0; while (am.countWords(t) < n) t += EXTRA[i++ % EXTRA.length]; return t; };
async function approveWith(words) {
  process.env.AGENT_MARKETING_ENABLED = "true";
  process.env.AGENT_MARKETING_B1_EVIDENCE = "dev";
  try {
    const id = (await call("POST", { action: "create" })).json.project.id;
    rows.find((r) => r.id === id).duration_sec = 60;
    await call("POST", { action: "save_intake", id, intake });
    const text = pad(words);
    const sv = await call("POST", { action: "save_narrative", id, narrative: { narrationTagged: text, cta: { text: "Understand your home's competition.", source: "user_edited" } } });
    assert.strictEqual(sv.status, 200);
    const n = am.countWords(text);
    const a = await call("POST", { action: "approve_narrative", id });
    return { n, a, saveWarnings: sv.json.warnings || [] };
  } finally { delete process.env.AGENT_MARKETING_B1_EVIDENCE; }
}
for (const target of [162, 177]) {
  test(`a ${target}-word 60-second Test script can be approved: the word count only advises`, async () => {
    const { n, a, saveWarnings } = await approveWith(target);
    assert.ok(n > 155, "fixture is over the range: " + n);
    assert.strictEqual(a.status, 200, JSON.stringify(a.json).slice(0, 300));
    assert.strictEqual(a.json.project.status, "narrative_approved");
    assert.ok(!/script_too_long/.test(JSON.stringify(a.json)));
    assert.ok(saveWarnings.some((w) => new RegExp("About " + n + " spoken words").test(w)), "the word count is still shown as a warning");
  });
}
test("content checks stay active on an overlength script: the compliance gate still stops approval", async () => {
  process.env.AGENT_MARKETING_ENABLED = "true";
  process.env.AGENT_MARKETING_B1_EVIDENCE = "dev";
  try {
    const id = (await call("POST", { action: "create" })).json.project.id;
    rows.find((r) => r.id === id).duration_sec = 60;
    await call("POST", { action: "save_intake", id, intake });
    await call("POST", { action: "save_narrative", id, narrative: { narrationTagged: pad(170) + " Just listed in Roseville! Open house this Saturday at 1234 Oak Ridge Drive.", cta: { text: "Understand your home's competition.", source: "user_edited" } } });
    const a = await call("POST", { action: "approve_narrative", id });
    assert.notStrictEqual(a.status, 200, "a listing announcement is still refused");
    assert.ok(a.status === 422 || a.status === 409);
    assert.ok(!/script_too_long/.test(JSON.stringify(a.json)));
  } finally { delete process.env.AGENT_MARKETING_B1_EVIDENCE; }
});
