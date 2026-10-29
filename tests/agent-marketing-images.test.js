const test = require("node:test");
const assert = require("node:assert");

process.env.S3_REGION = "us-west-2"; process.env.S3_BUCKET_NAME = "b"; process.env.S3_ACCESS_KEY_ID = "k"; process.env.S3_SECRET_ACCESS_KEY = "s";
process.env.OPENAI_API_KEY = "x"; process.env.INTERNAL_API_KEY = "ik"; process.env.URL = "https://site.test";
const img = require("../netlify/functions/lib/agent-marketing-images-lib");

test("settings defaults and clamping", () => {
  assert.deepStrictEqual(img.settings({}), { freeRedos: 1, projectCap: 12, credits: 1, quality: "medium", charging: true });
  assert.strictEqual(img.settings({ AGENT_MARKETING_IMAGE_PROJECT_CAP: "999" }).projectCap, 12);
  assert.strictEqual(img.settings({ AGENT_MARKETING_IMAGE_QUALITY: "high", AGENT_MARKETING_IMAGE_FREE_REDOS: "0" }).freeRedos, 0);
});

test("beta switch: AGENT_MARKETING_IMAGE_CHARGING=off makes every try free but keeps the project cap", () => {
  const a = (i, f) => ({ source: "gpt_image_2", scene_index: i, generation: { format: f, state: "done" } });
  const many = [a(1, "9x16"), a(1, "9x16"), a(1, "9x16"), a(1, "9x16")];
  assert.strictEqual(img.quote(many, 1, "9x16", {}).charged, true);
  const q = img.quote(many, 1, "9x16", { AGENT_MARKETING_IMAGE_CHARGING: "off" });
  assert.deepStrictEqual([q.charged, q.credits], [false, 0]);
  assert.strictEqual(img.quote(Array.from({ length: 12 }, (_, i) => a(i, "9x16")), 0, "16x9", { AGENT_MARKETING_IMAGE_CHARGING: "off" }).capReached, true);
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

test("prompts: one wide 16:9 frame with the subject in the middle third; concept has no people; agent scene has only the agent; all forbid text and real places", () => {
  const c = img.buildPrompt({ kind: "concept", scenePrompt: "keys on a cushion" });
  assert.match(c, /No people at all/); assert.match(c, /16:9/); assert.match(c, /central third/); assert.match(c, /9:16 vertical window/); assert.match(c, /No text/);
  const ag = img.buildPrompt({ kind: "agent_scene", scenePrompt: "standing on a tree-lined street" });
  assert.match(ag, /ONLY person/); assert.match(ag, /reference photo/); assert.match(ag, /No real landmarks/); assert.match(ag, /NOT a portrait/); assert.match(ag, /one third of the way in/); assert.match(ag, /55 to 65 percent/);
});

test("wide size: default 2560x1440; a custom size must be 16:9 with edges that are multiples of 16 and within OpenAI's limits", () => {
  assert.strictEqual(img.SIZES["16x9"], "2560x1440"); assert.strictEqual(img.WIDE, "16x9");
  assert.strictEqual(img.validWideSize("2048x1152"), "2048x1152"); assert.strictEqual(img.validWideSize("3840x2160"), "3840x2160");
  assert.strictEqual(img.validWideSize("1536x1024"), null); // 3:2, not 16:9
  assert.strictEqual(img.validWideSize("1000x562"), null); // not multiples of 16
  assert.strictEqual(img.validWideSize("4096x2304"), null); // longer than 3840
  assert.strictEqual(img.validWideSize("nope"), null);
});

test("crop window: clamped inside the image; agent scenes default left of centre, concepts centred", () => {
  assert.strictEqual(img.defaultCropX("concept"), 0.5); assert.ok(img.defaultCropX("agent_scene") < 0.4);
  const half = img.CROP_WIDTH / 2;
  assert.strictEqual(img.clampCrop(-3), half); assert.strictEqual(img.clampCrop(9), 1 - half); assert.strictEqual(img.clampCrop(0.4), 0.4); assert.strictEqual(img.clampCrop("x"), 0.5);
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
  agent_marketing_projects: [{ id: P1, user_id: U1, status: "narrative_approved", formats: ["9x16", "16x9"], template: "local_market_insider", intake: { angle: "neighborhood", market: "Roseville, CA", audience: "Home sellers", issue: "Supply and buyer demand", action: "Understand the trade-off", observation: "Check the commute at rush hour." }, narrative: { scenes: [
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
  const keep = (r, k) => { const v = q.get(k); if (!v) return true; return v.startsWith("neq.") ? String(r[k]) !== v.slice(4) : String(r[k]) === eq(k); };
  const rows = t.filter((r) => ["id", "user_id", "project_id", "source", "scene_index", "status"].every((k) => keep(r, k)));
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

test("slots list every scene (any scene can get a generated image); first generation is free, dispatches the worker with the internal key", async () => {
  process.env.AGENT_MARKETING_ENABLED = "true";
  const l = await call("GET", null, { projectId: P1 });
  assert.deepStrictEqual(l.json.slots.map((s) => `${s.sceneIndex}:${s.format}`), ["0:9x16", "0:16x9", "1:9x16", "1:16x9", "2:9x16", "2:16x9"]);   // one slot per scene per ordered format
  assert.deepStrictEqual(l.json.slots.filter((x) => x.format === "16x9").map((x) => x.plannedKind), ["agent_scene", "concept", null]);
  assert.strictEqual(l.json.projectCap, 24);   // the project limit is per format ordered
  const g = await call("POST", { action: "generate", projectId: P1, sceneIndex: 0, format: "16x9" });
  assert.strictEqual(g.status, 202); assert.strictEqual(g.json.charged, false); assert.strictEqual(debits.length, 0);
  assert.strictEqual(dispatched[0].key, "ik"); assert.ok(dispatched[0].url.endsWith("agent-marketing-image-background"));
  const a = db.agent_marketing_assets[0];
  assert.strictEqual(a.generation.referenceKey, "agent-marketing/h.jpg"); assert.match(a.generation.prompt, /ONLY person/); assert.strictEqual(a.ai_generated, true);
  assert.strictEqual((await call("POST", { action: "generate", projectId: P1, sceneIndex: 0, format: "16x9" })).status, 409); // already generating
});

test("redo: one included, the next needs confirmation and is charged; failed dispatch refunds", async () => {
  finish(db.agent_marketing_assets[0]);
  assert.strictEqual((await call("POST", { action: "generate", projectId: P1, sceneIndex: 0, format: "16x9" })).status, 202); // free redo
  assert.strictEqual(db.agent_marketing_assets[0].status, "rejected"); // earlier unaccepted draft retired
  finish(db.agent_marketing_assets[1]);
  const need = await call("POST", { action: "generate", projectId: P1, sceneIndex: 0, format: "16x9" });
  assert.strictEqual(need.status, 402); assert.strictEqual(need.json.code, "confirm_charge"); assert.strictEqual(need.json.credits, 1); assert.strictEqual(debits.length, 0);
  dispatchOk = false;
  const bad = await call("POST", { action: "generate", projectId: P1, sceneIndex: 0, format: "16x9", confirmCharge: true });
  assert.strictEqual(bad.status, 502);
  assert.deepStrictEqual(debits.map((d) => [d.c, d.refund]), [[1, false], [1, true]]);
  dispatchOk = true; debits.length = 0;
  const ok = await call("POST", { action: "generate", projectId: P1, sceneIndex: 0, format: "16x9", confirmCharge: true });
  assert.strictEqual(ok.status, 202); assert.strictEqual(ok.json.credits, 1); assert.deepStrictEqual(debits.map((d) => d.refund), [false]);
});

test("insufficient Images blocks without creating a draft", async () => {
  const before = db.agent_marketing_assets.length;
  finish(db.agent_marketing_assets.at(-1)); debitStatus = 402;
  const r = await call("POST", { action: "generate", projectId: P1, sceneIndex: 0, format: "16x9", confirmCharge: true });
  assert.strictEqual(r.status, 402); assert.strictEqual(r.json.code, "insufficient_credits");
  assert.strictEqual(db.agent_marketing_assets.length, before); debitStatus = 200;
});

test("accept approves one image per scene; a redo of an approved scene is a new draft until accepted; keep saves to the library", async () => {
  const done = db.agent_marketing_assets.filter((a) => a.generation.state === "done").pop();
  assert.strictEqual((await call("POST", { action: "accept", projectId: P1, assetId: done.id })).status, 200);
  assert.strictEqual(done.status, "approved");
  assert.strictEqual(done.generation.format, "16x9"); // every generation is the one wide image
  const g = await call("POST", { action: "generate", projectId: P1, sceneIndex: 0, format: "16x9", confirmCharge: true }); // a requested format is ignored: still the wide image
  assert.strictEqual(g.status, 202);
  const w = db.agent_marketing_assets.at(-1);
  assert.strictEqual(w.generation.format, "16x9"); assert.strictEqual(w.generation.fromApproved, false); assert.match(w.generation.prompt, /NOT a portrait/);
  assert.strictEqual(done.status, "approved"); // the approved image stays until the new one is accepted
  const cr = await call("POST", { action: "crop", projectId: P1, assetId: done.id, cropX: 0.9 });
  assert.strictEqual(cr.status, 200); assert.ok(Math.abs(cr.json.cropX - (1 - img.CROP_WIDTH / 2)) < 1e-9); assert.strictEqual(done.generation.cropX, cr.json.cropX);
  assert.strictEqual((await call("POST", { action: "crop", projectId: P1, assetId: done.id })).status, 400);
  assert.strictEqual((await call("POST", { action: "keep", projectId: P1, assetId: done.id })).status, 200);
  assert.strictEqual(db.agent_marketing_library[0].kind, "generated"); assert.strictEqual(db.agent_marketing_library[0].rights.aiGenerated, true);
});

test("guards: no prompt for the scene, unknown scene, no profile photo, script not approved, cap", async () => {
  const np0 = await call("POST", { action: "generate", projectId: P1, sceneIndex: 2, format: "16x9" });
  assert.strictEqual(np0.status, 400); assert.strictEqual(np0.json.code, "description_needed"); // brand-card scene: the planner gave no image prompt
  assert.strictEqual((await call("POST", { action: "generate", projectId: P1, sceneIndex: 9, format: "16x9" })).status, 400);
  const prof = db.marketing_profiles[0]; const h = prof.headshot_key; prof.headshot_key = null;
  const np = await call("POST", { action: "generate", projectId: P1, sceneIndex: 0, format: "16x9" });
  assert.strictEqual(np.json.code === "profile_photo_needed" || np.status === 409, true); prof.headshot_key = h;
  db.agent_marketing_projects[0].status = "narrative_ready";
  assert.strictEqual((await call("POST", { action: "generate", projectId: P1, sceneIndex: 1, format: "16x9" })).status, 409);
  db.agent_marketing_projects[0].status = "images";
  process.env.AGENT_MARKETING_IMAGE_PROJECT_CAP = "1";
  assert.strictEqual((await call("POST", { action: "generate", projectId: P1, sceneIndex: 1, format: "16x9" })).json.code, "cap_reached");
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

// ── Oct 23: choose the source of any scene, and AI-elaborated notes ──
const planLib = require("../netlify/functions/lib/agent-marketing-plan-lib");
const mark = () => db.agent_marketing_assets.length;

test("elaborate: returns a scrubbed description, spends no try and creates no draft", async () => {
  process.env.ANTHROPIC_API_KEY = "ak";
  const orig = planLib.callClaudeText; let seen;
  planLib.callClaudeText = async (sys, user) => { seen = JSON.parse(user); return JSON.stringify({ description: "A bright front walk in soft morning light with mature trees.", removed: [] }); };
  const before = mark();
  const r = await call("POST", { action: "elaborate", projectId: P1, sceneIndex: 2, kind: "agent_scene", note: "mature trees" });
  assert.strictEqual(r.status, 200); assert.match(r.json.description, /mature trees/); assert.strictEqual(seen.agent_note, "mature trees");
  assert.strictEqual(mark(), before);
  const bad = await call("POST", { action: "elaborate", projectId: P1, sceneIndex: 2, kind: "concept", note: "Just listed 1234 Oak Street" });
  assert.strictEqual(bad.status, 422); assert.strictEqual(bad.json.code, "note_blocked");
  assert.strictEqual((await call("POST", { action: "elaborate", projectId: P1, sceneIndex: 2, kind: "nope", note: "" })).status, 400);
  assert.strictEqual((await call("POST", { action: "elaborate", projectId: P1, sceneIndex: 9, kind: "concept", note: "" })).status, 400);
  planLib.callClaudeText = orig;
});

test("generate on a scene the planner gave no image: needs a description, checks it again on the server, records kind and note", async () => {
  const ok = await call("POST", { action: "generate", projectId: P1, sceneIndex: 2, format: "16x9", kind: "concept", note: "mature trees", description: "A calm street lined with mature trees in soft light." });
  assert.strictEqual(ok.status, 202);
  const a = db.agent_marketing_assets.at(-1);
  assert.strictEqual(a.generation.kind, "concept"); assert.strictEqual(a.generation.note, "mature trees"); assert.strictEqual(a.generation.elaborated, true);
  assert.match(a.generation.prompt, /mature trees/); assert.match(a.generation.prompt, /No people at all/);
  // The page can show what an image was created from: the description, the agent's note and the full prompt.
  a.generation.state = "done"; a.asset_key = "k/done.png";
  const lst = await call("GET", null, { projectId: P1 });
  const lat = lst.json.slots.find((x) => x.sceneIndex === 2 && x.format === "16x9").latest;
  assert.strictEqual(lat.description, "A calm street lined with mature trees in soft light."); assert.strictEqual(lat.note, "mature trees"); assert.match(lat.fullPrompt, /mature trees/);
  const before = mark(); // the first image stays finished, so the next request is checked on its own merits

  const tampered = await call("POST", { action: "generate", projectId: P1, sceneIndex: 2, format: "16x9", kind: "concept", description: "A yard sign that says Just Listed with an open house banner" });
  assert.strictEqual(tampered.status, 422); assert.strictEqual(tampered.json.code, "description_blocked"); assert.strictEqual(mark(), before);
  assert.strictEqual((await call("POST", { action: "generate", projectId: P1, sceneIndex: 2, format: "16x9", kind: "sketch", description: "x" })).status, 400);
});

test("choosing the other kind on a planned scene does not reuse the planner's prompt; the same kind does", async () => {
  const wrong = await call("POST", { action: "generate", projectId: P1, sceneIndex: 1, format: "16x9", kind: "agent_scene" }); // scene 1 is a planned concept image
  assert.strictEqual(wrong.status, 400); assert.strictEqual(wrong.json.code, "description_needed");
  const withDesc = await call("POST", { action: "generate", projectId: P1, sceneIndex: 1, format: "16x9", kind: "agent_scene", description: "The agent sits at a bright kitchen table, relaxed." });
  assert.strictEqual(withDesc.status, 202);
  const a = db.agent_marketing_assets.at(-1);
  assert.strictEqual(a.generation.kind, "agent_scene"); assert.strictEqual(a.generation.referenceKey, "agent-marketing/h.jpg"); assert.match(a.generation.prompt, /ONLY person/);
});

test("accepting a generated image retires an approved own photo for that scene (one source per scene)", async () => {
  const own = { id: "eeeeeeee-eeee-4eee-8eee-000000000001", project_id: P1, user_id: U1, scene_index: 1, source: "library", status: "approved", generation: null };
  db.agent_marketing_assets.push(own);
  const g = db.agent_marketing_assets.filter((a) => a.source === "gpt_image_2" && a.scene_index === 1).pop();
  finish(g);
  assert.strictEqual((await call("POST", { action: "accept", projectId: P1, assetId: g.id })).status, 200);
  assert.strictEqual(g.status, "approved"); assert.strictEqual(own.status, "rejected");
});

test("tall prompt for the image of you uses the reference-photo rules and keeps the top calm", () => {
  const p = img.buildFormatPrompt({ kind: "agent_scene", scenePrompt: "standing on a tree-lined sidewalk", format: "9x16" });
  assert.match(p, /ONLY person/); assert.match(p, /reference photo/); assert.match(p, /top 45%/); assert.match(p, /9:16/);
  assert.doesNotMatch(p, /No people at all/);
  const wide = img.buildFormatPrompt({ kind: "agent_scene", scenePrompt: "x", format: "16x9" });
  assert.match(wide, /ONLY person/);
  assert.match(img.buildFormatPrompt({ kind: "concept", scenePrompt: "x", format: "9x16" }), /No people at all/);
});

test("9:16 is its own image: the vertical generate records the tall format and size, uses the tall prompt with the planner's vertical framing, and a 16:9 image cannot be revised into a 9:16 one", async () => {
  process.env.AGENT_MARKETING_ENABLED = "true";
  const before = db.agent_marketing_assets.length;
  const g = await call("POST", { action: "generate", projectId: P1, sceneIndex: 1, format: "9x16", kind: "concept" });
  assert.strictEqual(g.status, 202);
  const a = db.agent_marketing_assets[db.agent_marketing_assets.length - 1];
  assert.ok(db.agent_marketing_assets.length > before);
  assert.strictEqual(a.generation.format, "9x16");
  assert.strictEqual(a.generation.size, img.tallSize());
  assert.match(a.generation.prompt, /Tall vertical 9:16/);
  const bad = await call("POST", { action: "generate", projectId: P1, sceneIndex: 2, format: "9x16", kind: "concept", reviseAssetId: "00000000-0000-4000-8000-000000000001", description: "make it earlier" });
  assert.strictEqual(bad.status, 400);
  const nope = await call("POST", { action: "generate", projectId: P1, sceneIndex: 1, format: "4x5", kind: "concept" });
  assert.strictEqual(nope.status, 400);
});
