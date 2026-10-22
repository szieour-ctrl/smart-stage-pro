const test = require("node:test");
const assert = require("node:assert");

process.env.S3_REGION = "us-west-2"; process.env.S3_BUCKET_NAME = "b"; process.env.S3_ACCESS_KEY_ID = "k"; process.env.S3_SECRET_ACCESS_KEY = "s";
const U1 = "11111111-1111-4111-8111-111111111111", U2 = "22222222-2222-4222-8222-222222222222";
const P1 = "aaaaaaaa-aaaa-4aaa-8aaa-000000000001";
const S1 = "bbbbbbbb-bbbb-4bbb-8bbb-000000000001", S2 = "bbbbbbbb-bbbb-4bbb-8bbb-000000000002";
let user = U1;
const db = {
  agent_marketing_projects: [{ id: P1, user_id: U1, status: "narrative_approved", narrative: { scenes: [{ visualSource: "AUTHENTIC_AGENT_ASSET" }, { visualSource: "GPT_IMAGE_2_CONCEPT" }] } }],
  agent_marketing_assets: [],
  staged_images: [
    { id: S1, user_id: U1, listing_id: "cccccccc-cccc-4ccc-8ccc-000000000001", clean_s3_key: "clean/a.png", badge_type: "virtually_staged", cloudinary_original_url: "https://x/o.jpg", is_hero_shot: false, hidden: false },
    { id: S2, user_id: U2, listing_id: null, clean_s3_key: "clean/b.png", badge_type: "x", cloudinary_original_url: "https://x/p.jpg", hidden: false },
  ],
  external_photos: [],
};
const libPath = require.resolve("../netlify/functions/lib/marketing-profile-lib");
const authPath = require.resolve("../netlify/functions/lib/reel-auth-lib");
function fake(method, table, body, qs = "") {
  const q = new URLSearchParams(qs.replace(/^\?/, "")); const t = db[table];
  const eq = (k) => (q.get(k) || "").replace(/^eq\./, "");
  let rows = t.filter((r) => (!q.get("id") || r.id === eq("id")) && (!q.get("user_id") || r.user_id === eq("user_id")) && (!q.get("project_id") || r.project_id === eq("project_id")) && (!q.get("scene_index") || String(r.scene_index) === eq("scene_index")) && (!q.get("status") || r.status === eq("status")));
  if (method === "POST") { const row = { id: "dddddddd-dddd-4ddd-8ddd-" + String(t.length + 1).padStart(12, "0"), ...body }; t.push(row); return Promise.resolve({ status: 201, data: [row] }); }
  if (method === "PATCH") { rows.forEach((r) => Object.assign(r, body)); return Promise.resolve({ status: 200, data: rows }); }
  return Promise.resolve({ status: 200, data: rows });
}
require.cache[libPath] = { id: libPath, filename: libPath, loaded: true, exports: { supabase: fake } };
require.cache[authPath] = { id: authPath, filename: authPath, loaded: true, exports: { requireUser: async () => ({ user: { id: user } }) } };
const { handler } = require("../netlify/functions/agent-marketing-media");
const call = async (method, body, qs) => { const r = await handler({ httpMethod: method, headers: {}, body: body ? JSON.stringify(body) : null, queryStringParameters: qs || null }); return { status: r.statusCode, json: JSON.parse(r.body) }; };

test("off by default", async () => { delete process.env.AGENT_MARKETING_ENABLED; assert.strictEqual((await call("GET", null, { projectId: P1, source: "staged" })).status, 404); });

test("staged route lists only the caller's clean copies, select records provenance, replace retires old pick", async () => {
  process.env.AGENT_MARKETING_ENABLED = "true";
  const l = await call("GET", null, { projectId: P1, source: "staged" });
  assert.strictEqual(l.status, 200);
  const c = await call("POST", { action: "select", projectId: P1, sceneIndex: 0, kind: "staged", id: S1 });
  assert.strictEqual(c.status, 200);
  const a = db.agent_marketing_assets[0];
  assert.strictEqual(a.asset_key, "clean/a.png"); assert.strictEqual(a.original_url, "https://x/o.jpg"); assert.strictEqual(a.staged_image_id, S1); assert.ok(a.source_listing_id);
  assert.strictEqual(db.agent_marketing_projects[0].status, "images");
  assert.strictEqual((await call("POST", { action: "select", projectId: P1, sceneIndex: 0, kind: "gallery_original", id: S1 })).status, 200);
  assert.deepStrictEqual(db.agent_marketing_assets.map((x) => x.status), ["rejected", "approved"]);
  assert.strictEqual(db.agent_marketing_assets[1].version, 2);
});

test("cannot use another user's photo, a concept scene, or a project that isn't yours", async () => {
  assert.strictEqual((await call("POST", { action: "select", projectId: P1, sceneIndex: 0, kind: "staged", id: S2 })).status, 404);
  assert.strictEqual((await call("POST", { action: "select", projectId: P1, sceneIndex: 1, kind: "staged", id: S1 })).status, 400);
  user = U2;
  assert.strictEqual((await call("GET", null, { projectId: P1, source: "staged" })).status, 404);
  user = U1;
});

test("upload route needs the attestation and a key inside the caller's project folder", async () => {
  const p = await call("POST", { action: "presign_upload", projectId: P1, contentType: "image/png" });
  assert.strictEqual(p.status, 200);
  assert.ok(p.json.key.startsWith(`agent-marketing-uploads/${U1}/${P1}/`));
  assert.strictEqual((await call("POST", { action: "presign_upload", projectId: P1, contentType: "image/gif" })).status, 400);
  assert.strictEqual((await call("POST", { action: "confirm_upload", projectId: P1, sceneIndex: 0, key: p.json.key })).status, 400);
  assert.strictEqual((await call("POST", { action: "confirm_upload", projectId: P1, sceneIndex: 0, key: `agent-marketing-uploads/${U2}/${P1}/x.png`, ownerConfirmed: true })).status, 400);
  const ok = await call("POST", { action: "confirm_upload", projectId: P1, sceneIndex: 0, key: p.json.key, ownerConfirmed: true, source: "own_camera" });
  assert.strictEqual(ok.status, 200);
  const row = db.agent_marketing_assets.at(-1);
  assert.strictEqual(row.source, "upload"); assert.strictEqual(row.rights.attestationVersion, "agent-upload-1"); assert.ok(row.rights.attestedAt);
});

test("clear retires the pick; unapproved script blocks picking", async () => {
  assert.strictEqual((await call("POST", { action: "clear", projectId: P1, sceneIndex: 0 })).status, 200);
  assert.ok(!db.agent_marketing_assets.some((x) => x.status === "approved"));
  db.agent_marketing_projects[0].status = "narrative_ready";
  assert.strictEqual((await call("POST", { action: "select", projectId: P1, sceneIndex: 0, kind: "staged", id: S1 })).status, 409);
});
