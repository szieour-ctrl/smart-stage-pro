const test = require("node:test");
const assert = require("node:assert");

process.env.S3_REGION = "us-west-2"; process.env.S3_BUCKET_NAME = "b"; process.env.S3_ACCESS_KEY_ID = "k"; process.env.S3_SECRET_ACCESS_KEY = "s";
process.env.OPENAI_API_KEY = "x"; process.env.INTERNAL_API_KEY = "ik"; process.env.URL = "https://site.test";
const img = require("../netlify/functions/lib/agent-marketing-images-lib");

test("settings defaults and clamping", () => {
  assert.deepStrictEqual(img.settings({}), { freeRedos: 1, projectCap: 12, credits: 1, quality: "medium" });
  assert.strictEqual(img.settings({ AGENT_MARKETING_IMAGE_PROJECT_CAP: "999" }).projectCap, 12);
  assert.strictEqual(img.settings({ AGENT_MARKETING_IMAGE_QUALITY: "high", AGENT_MARKETING_IMAGE_FREE_REDOS: "0" }).freeRedos, 0);
});

test("quote: first image and one redo included, then charged; failed attempts do not use up the allowance; cap", () => {
  const a = (scene, format, state, n) => ({ source: "gpt_image_2", scene_index: scene, generation: { format, state }, n });
  assert.deepStrictEqual([img.quote([], 1, "9x16", {}).charged, img.quote([], 1, "9x16", {}).credits], [false, 0]);
  assert.strictEqual(img.quote([a(1, "9x16", "done")], 1, "9x16", {}).charged, false);
  const two = [a(1, "9x16", "done"), a(1, "9x16", "done")];
  assert.deepStrictEqual([img.quote(two, 1, "9x16", {}).charged, img.quote(two, 1, "9x16", {}).credits], [true, 1]);
  assert.strictEqual(img.quote([...two.slice(0, 1), a(1, "9x16", "error")], 1, "9x16", {}).charged, false);
  assert.strictEqual(img.quote(two, 1, "16x9", {}).charged, false); // other format has its own slot
  assert.strictEqual(img.quote(Array.from({ length: 12 }, (_, i) => a(i, "9x16", "done")), 0, "16x9", {}).capReached, true);
});

test("prompts: concept has no people; agent scene has only the agent; 16:9 from approved keeps the same scene; all forbid text and real places", () => {
  const c = img.buildPrompt({ kind: "concept", scenePrompt: "keys on a cushion", format: "9x16" });
  assert.match(c, /No people at all/); assert.match(c, /9:16/); assert.match(c, /No text/);
  const ag = img.buildPrompt({ kind: "agent_scene", scenePrompt: "standing on a tree-lined street", format: "9x16" });
  assert.match(ag, /ONLY person/); assert.match(ag, /reference photo/); assert.match(ag, /No real landmarks/);
  const re = img.buildPrompt({ kind: "agent_scene", scenePrompt: "x", format: "16x9", fromApproved: true });
  assert.match(re, /Recompose the reference/); assert.match(re, /16:9/); assert.match(re, /same person/);
});

test("reference photo: full body first, else headshot, else none", () => {
  assert.strictEqual(img.pickReferenceKey({ fullbody_key: "f", headshot_key: "h" }), "f");
  assert.strictEqual(img.pickReferenceKey({ headshot_key: "h" }), "h");
  assert.strictEqual(img.pickReferenceKey({}), null);
});

// ── endpoint ──
const U1 = "11111111-1111-4111-8111-111111111111";
const P1 = "aaaaaaaa-aaaa-4aaa-8aaa-000000000001";
const db = {
  agent_marketing_projects: [{ id: P1, user_id: U1, status: "narrative_approved", formats: ["9x16", "16x9"], narrative: { scenes: [
    { visualSource: "AGENT_SCENE", aiGenerationPrompt: "agent on a quiet street" }, { visualSource: "GPT_IMAGE_2_CONCEPT", aiGenerationPrompt: "keys on cushion" }, { visualSource: "BRAND_CARD" }] } }],
  agent_marketing_assets: [], agent_marketing_library: [], marketing_profiles: [{ user_id: U1, headshot_key: "agent-marketing/h.jpg", fullbody_key: null }],
};
let n = 1; const debits = [];
const libPath = require.resolve("../netlify/functions/lib/marketing-profile-lib");
const authPath = require.resolve("../netlify/functions/lib/reel-auth-lib");
const quotaPath = require.resolve("../netlify/functions/lib/reel-quota-lib");
function fake(method, table, body, qs = "") {
  const q = new URLSearchParams(qs.replace(/^\?/, "")); const t = db[table];
  const eq = (k) => (q.get(k) || "").replace(/^eq\./, "");
  const rows = t.filter((r) => ["id", "user_id", "project_id", "source"].every((k) => !q.get(k) || String(r[k]) === eq(k)));
  if (method === "POST") { const row = { id: "dddddddd-dddd-4ddd-8ddd-" + String(n++).padStart(12, "0"), created_at: String(n), ...body }; t.push(row); return Promise.resolve({ status: 201, data: [row] }); }
  if (method === "PATCH") { rows.forEach((r) => Object.assign(r, body)); return Promise.resolve({ status: 200, data: rows }); }
  return Promise.resolve({ status: 200, data: rows });
}
require.cache[libPath] = { id: libPath, filename: libPath, loaded: true, exports: { supabase: fake } };
require.cache[authPath] = { id: authPath, filename: authPath, loaded: true, exports: { requireUser: async () => ({ user: { id: U1 } }) } };
let debitStatus = 200;
require.cache[quotaPath] = { id: quotaPath, filename: quotaPath, loaded: true, exports: { callDebitCredit: async (u, c, r, refund) => { debits.push({ c, r, refund: !!refund }); return { status: refund ? 200 : debitStatus, data: {} }; } } };
const dispatched = []; let dispatchOk = true;
global.fetch = async (url, o) => { dispatched.push({ url, body: JSON.parse(o.body), key: o.headers["x-internal-key"] }); if (!dispatchOk) throw new Error("down"); return { ok: true }; };
const { handler } = require("../netlify/functions/agent-marketing-images");
const call = async (method, body, qs) => { const r = await handler({ httpMethod: method, headers: { host: "h" }, body: body ? JSON.stringify(body) : null, queryStringParameters: qs || null }); return { status: r.statusCode, json: JSON.parse(r.body) }; };
const finish = (a) => { a.generation.state = "done"; a.asset_key = "agent-marketing-generated/x.png"; };

test("off by default", async () => { delete process.env.AGENT_MARKETING_ENABLED; assert.strictEqual((await call("GET", null, { projectId: P1 })).status, 404); });

test("slots list only generated-image scenes; first generation is free, dispatches the worker with the internal key", async () => {
  process.env.AGENT_MARKETING_ENABLED = "true";
  const l = await call("GET", null, { projectId: P1 });
  assert.deepStrictEqual(l.json.slots.map((s) => `${s.sceneIndex}:${s.format}`), ["0:9x16", "0:16x9", "1:9x16", "1:16x9"]);
  const g = await call("POST", { action: "generate", projectId: P1, sceneIndex: 0, format: "9x16" });
  assert.strictEqual(g.status, 202); assert.strictEqual(g.json.charged, false); assert.strictEqual(debits.length, 0);
  assert.strictEqual(dispatched[0].key, "ik"); assert.ok(dispatched[0].url.endsWith("agent-marketing-image-background"));
  const a = db.agent_marketing_assets[0];
  assert.strictEqual(a.generation.referenceKey, "agent-marketing/h.jpg"); assert.match(a.generation.prompt, /ONLY person/); assert.strictEqual(a.ai_generated, true);
  assert.strictEqual((await call("POST", { action: "generate", projectId: P1, sceneIndex: 0, format: "9x16" })).status, 409); // already generating
});

test("redo: one included, the next needs confirmation and is charged; failed dispatch refunds", async () => {
  finish(db.agent_marketing_assets[0]);
  assert.strictEqual((await call("POST", { action: "generate", projectId: P1, sceneIndex: 0, format: "9x16" })).status, 202); // free redo
  assert.strictEqual(db.agent_marketing_assets[0].status, "rejected"); // earlier unaccepted draft retired
  finish(db.agent_marketing_assets[1]);
  const need = await call("POST", { action: "generate", projectId: P1, sceneIndex: 0, format: "9x16" });
  assert.strictEqual(need.status, 402); assert.strictEqual(need.json.code, "confirm_charge"); assert.strictEqual(need.json.credits, 1); assert.strictEqual(debits.length, 0);
  dispatchOk = false;
  const bad = await call("POST", { action: "generate", projectId: P1, sceneIndex: 0, format: "9x16", confirmCharge: true });
  assert.strictEqual(bad.status, 502);
  assert.deepStrictEqual(debits.map((d) => [d.c, d.refund]), [[1, false], [1, true]]);
  dispatchOk = true; debits.length = 0;
  const ok = await call("POST", { action: "generate", projectId: P1, sceneIndex: 0, format: "9x16", confirmCharge: true });
  assert.strictEqual(ok.status, 202); assert.strictEqual(ok.json.credits, 1); assert.deepStrictEqual(debits.map((d) => d.refund), [false]);
});

test("insufficient Images blocks without creating a draft", async () => {
  const before = db.agent_marketing_assets.length;
  finish(db.agent_marketing_assets.at(-1)); debitStatus = 402;
  const r = await call("POST", { action: "generate", projectId: P1, sceneIndex: 0, format: "9x16", confirmCharge: true });
  assert.strictEqual(r.status, 402); assert.strictEqual(r.json.code, "insufficient_credits");
  assert.strictEqual(db.agent_marketing_assets.length, before); debitStatus = 200;
});

test("accept approves one image per slot; 16:9 is built from the approved 9:16; keep saves to the library", async () => {
  const done = db.agent_marketing_assets.filter((a) => a.generation.state === "done").pop();
  assert.strictEqual((await call("POST", { action: "accept", projectId: P1, assetId: done.id })).status, 200);
  assert.strictEqual(done.status, "approved");
  const g = await call("POST", { action: "generate", projectId: P1, sceneIndex: 0, format: "16x9" });
  assert.strictEqual(g.status, 202);
  const w = db.agent_marketing_assets.at(-1);
  assert.strictEqual(w.generation.fromApproved, true); assert.strictEqual(w.generation.referenceKey, done.asset_key); assert.match(w.generation.prompt, /Recompose/);
  assert.strictEqual((await call("POST", { action: "keep", projectId: P1, assetId: done.id })).status, 200);
  assert.strictEqual(db.agent_marketing_library[0].kind, "generated"); assert.strictEqual(db.agent_marketing_library[0].rights.aiGenerated, true);
});

test("guards: not an image scene, wrong format, no profile photo, script not approved, cap", async () => {
  assert.strictEqual((await call("POST", { action: "generate", projectId: P1, sceneIndex: 2, format: "9x16" })).status, 400);
  assert.strictEqual((await call("POST", { action: "generate", projectId: P1, sceneIndex: 1, format: "1x1" })).status, 400);
  const prof = db.marketing_profiles[0]; const h = prof.headshot_key; prof.headshot_key = null;
  const np = await call("POST", { action: "generate", projectId: P1, sceneIndex: 0, format: "9x16" });
  assert.strictEqual(np.json.code === "profile_photo_needed" || np.status === 409, true); prof.headshot_key = h;
  db.agent_marketing_projects[0].status = "narrative_ready";
  assert.strictEqual((await call("POST", { action: "generate", projectId: P1, sceneIndex: 1, format: "9x16" })).status, 409);
  db.agent_marketing_projects[0].status = "images";
  process.env.AGENT_MARKETING_IMAGE_PROJECT_CAP = "1";
  assert.strictEqual((await call("POST", { action: "generate", projectId: P1, sceneIndex: 1, format: "9x16" })).json.code, "cap_reached");
  delete process.env.AGENT_MARKETING_IMAGE_PROJECT_CAP;
});

test("a generation that never finishes is closed out and refunded", async () => {
  const a = db.agent_marketing_assets.at(-1);
  a.generation = { ...a.generation, state: "generating", startedAt: new Date(Date.now() - 20 * 60000).toISOString(), charged: { credits: 1 } };
  debits.length = 0;
  const l = await call("GET", null, { projectId: P1 });
  assert.strictEqual(a.generation.state, "error"); assert.strictEqual(a.generation.refunded, true);
  assert.deepStrictEqual(debits.map((d) => d.refund), [true]); assert.ok(l.json.slots.length);
});
