// agent-marketing-media.js — Netlify Function. Photo picker for Agent Marketing (Oct 22, 2026).
// Same switch as the rest of the feature (AGENT_MARKETING_ENABLED / AGENT_MARKETING_USER_IDS); 404 when off.
//
//   GET  ?projectId=&source=staged     → the caller's Virtually Staged images that have a clean (unbadged) copy
//   GET  ?projectId=&source=gallery    → the caller's own originals and external photos
//   GET  ?projectId=&source=selected   → photos already chosen for this project, per scene
//   POST { action: "select", projectId, sceneIndex, kind: "staged"|"gallery_original"|"gallery_external", id }
//   POST { action: "presign_upload", projectId, contentType }
//   POST { action: "confirm_upload", projectId, sceneIndex, key, ownerConfirmed: true, source?, note? }
//   POST { action: "clear", projectId, sceneIndex }
//
// Only the caller's own photos are ever listed or accepted (user_id / added_by_user_id = the login token's user).
// The record keeps provenance (original, staged, source listing) but no badge is ever added to these images.
const crypto = require("crypto");
const { S3Client, GetObjectCommand, PutObjectCommand } = require("@aws-sdk/client-s3");
const { getSignedUrl } = require("@aws-sdk/s3-request-presigner");
const { supabase } = require("./lib/marketing-profile-lib");
const { requireUser } = require("./lib/reel-auth-lib");
const am = require("./lib/agent-marketing-lib");
const media = require("./lib/agent-marketing-media-lib");

const headers = { "Access-Control-Allow-Origin": "*", "Content-Type": "application/json", "Cache-Control": "no-store" };
const reply = (statusCode, obj) => ({ statusCode, headers, body: JSON.stringify(obj) });

const s3 = new S3Client({ region: process.env.S3_REGION, credentials: { accessKeyId: process.env.S3_ACCESS_KEY_ID, secretAccessKey: process.env.S3_SECRET_ACCESS_KEY } });
async function presignGet(key, secs) {
  try { return await getSignedUrl(s3, new GetObjectCommand({ Bucket: process.env.S3_BUCKET_NAME, Key: key }), { expiresIn: secs || 3600 }); }
  catch (e) { console.error("agent-marketing-media presign failed:", e.message); return null; }
}
const dbOk = (r) => r && r.status < 300;
const rowsOf = (r) => (r && Array.isArray(r.data) ? r.data : []);

async function loadProject(id, userId) {
  if (!media.UUID_RE.test(String(id || ""))) return { error: reply(400, { error: "Missing or invalid project id" }) };
  const r = await supabase("GET", "agent_marketing_projects", null, `?id=eq.${id}&user_id=eq.${userId}&select=id,status,narrative&limit=1`);
  const row = rowsOf(r)[0];
  if (!row) return { error: reply(404, { error: "Project not found" }) };
  return { row };
}

// The asset the page shows for a scene: a short-lived link (private keys) or the stored URL.
async function viewOf(a) {
  let url = null;
  if (a.asset_key) url = await presignGet(a.asset_key, 3600);
  else url = a.original_url || a.staged_url || null;
  return { id: a.id, sceneIndex: a.scene_index, version: a.version, source: a.source, route: a.rights && a.rights.route, url, aiGenerated: !!a.ai_generated };
}

exports.handler = async (event) => {
  if (event.httpMethod === "OPTIONS") return { statusCode: 204, headers: { ...headers, "Access-Control-Allow-Headers": "Content-Type, Authorization", "Access-Control-Allow-Methods": "GET, POST, OPTIONS" }, body: "" };
  const auth = await requireUser(event);
  if (auth.error) return reply(auth.error.status, auth.error.body);
  const userId = auth.user.id;
  if (!am.isEnabledFor(userId)) return reply(404, { error: "Not found" });

  try {
    if (event.httpMethod === "GET") {
      const qs = event.queryStringParameters || {};
      const p = await loadProject(qs.projectId, userId);
      if (p.error) return p.error;

      if (qs.source === "selected") {
        const r = await supabase("GET", "agent_marketing_assets", null, `?project_id=eq.${p.row.id}&user_id=eq.${userId}&status=eq.approved&select=*&order=scene_index.asc`);
        const items = await Promise.all(rowsOf(r).map(viewOf));
        return reply(200, { items });
      }
      if (qs.source === "staged") {
        const r = await supabase("GET", "staged_images", null, `?user_id=eq.${userId}&hidden=not.is.true&clean_s3_key=not.is.null&select=id,room_type,created_at,clean_s3_key,listing_id&order=created_at.desc&limit=60`);
        const items = await Promise.all(rowsOf(r).map(async (x) => ({ kind: "staged", id: x.id, roomType: x.room_type || "", createdAt: x.created_at, thumbUrl: await presignGet(x.clean_s3_key, 3600) })));
        return reply(200, { items: items.filter((i) => i.thumbUrl) });
      }
      if (qs.source === "gallery") {
        const [o, e] = await Promise.all([
          supabase("GET", "staged_images", null, `?user_id=eq.${userId}&hidden=not.is.true&is_hero_shot=not.is.true&cloudinary_original_url=not.is.null&select=id,room_type,created_at,cloudinary_original_url&order=created_at.desc&limit=60`),
          supabase("GET", "external_photos", null, `?added_by_user_id=eq.${userId}&select=id,room_type,created_at,image_url&order=created_at.desc&limit=60`),
        ]);
        const items = [
          ...rowsOf(o).filter((x) => /^https?:\/\//.test(x.cloudinary_original_url || "")).map((x) => ({ kind: "gallery_original", id: x.id, roomType: x.room_type || "", createdAt: x.created_at, thumbUrl: x.cloudinary_original_url })),
          ...rowsOf(e).filter((x) => /^https?:\/\//.test(x.image_url || "")).map((x) => ({ kind: "gallery_external", id: x.id, roomType: x.room_type || "", createdAt: x.created_at, thumbUrl: x.image_url })),
        ];
        return reply(200, { items });
      }
      return reply(400, { error: "Unknown source" });
    }

    if (event.httpMethod !== "POST") return reply(405, { error: "Method not allowed" });
    let b;
    try { b = JSON.parse(event.body || "{}"); } catch { return reply(400, { error: "Invalid JSON" }); }
    const p = await loadProject(b.projectId, userId);
    if (p.error) return p.error;
    const project = p.row;

    if (b.action === "presign_upload") {
      const ext = media.UPLOAD_TYPES[b.contentType];
      if (!ext) return reply(400, { error: "Upload a PNG, JPG or WebP image." });
      if (!process.env.S3_BUCKET_NAME || !process.env.S3_REGION) return reply(500, { error: "Storage is not configured." });
      const key = `${media.uploadKeyPrefix(userId, project.id)}${Date.now()}_${crypto.randomBytes(3).toString("hex")}.${ext}`;
      const uploadUrl = await getSignedUrl(s3, new PutObjectCommand({ Bucket: process.env.S3_BUCKET_NAME, Key: key, ContentType: b.contentType }), { expiresIn: 300 });
      return reply(200, { uploadUrl, key, attestation: { version: media.UPLOAD_ATTESTATION_VERSION, text: media.UPLOAD_ATTESTATION_TEXT } });
    }

    if (!["select", "confirm_upload", "clear"].includes(b.action)) return reply(400, { error: "Unknown action" });
    if (!media.SELECTABLE_STATUSES.includes(project.status)) return reply(409, { error: "Approve your script before choosing photos." });
    const sc = media.validateSceneIndex(project.narrative, b.sceneIndex);
    if (sc.error) return reply(400, { error: sc.error });

    if (b.action === "clear") {
      await supabase("PATCH", "agent_marketing_assets", { status: "rejected" }, `?project_id=eq.${project.id}&user_id=eq.${userId}&scene_index=eq.${sc.index}&status=eq.approved`);
      return reply(200, { ok: true });
    }

    let built;
    const prev = await supabase("GET", "agent_marketing_assets", null, `?project_id=eq.${project.id}&scene_index=eq.${sc.index}&select=version&order=version.desc&limit=1`);
    const version = ((rowsOf(prev)[0] || {}).version || 0) + 1;
    const ctx = { projectId: project.id, userId, sceneIndex: sc.index, version };

    if (b.action === "select") {
      const id = String(b.id || "");
      if (!media.UUID_RE.test(id)) return reply(400, { error: "Invalid photo" });
      if (b.kind === "staged" || b.kind === "gallery_original") {
        const r = await supabase("GET", "staged_images", null, `?id=eq.${id}&user_id=eq.${userId}&select=id,listing_id,clean_s3_key,badge_type,cloudinary_original_url,is_hero_shot&limit=1`);
        const row = rowsOf(r)[0];
        if (!row) return reply(404, { error: "Photo not found" });
        built = media.assetRowFor(b.kind, { ...ctx, row });
      } else if (b.kind === "gallery_external") {
        const r = await supabase("GET", "external_photos", null, `?id=eq.${id}&added_by_user_id=eq.${userId}&select=id,listing_id,image_url,source_label&limit=1`);
        const row = rowsOf(r)[0];
        if (!row) return reply(404, { error: "Photo not found" });
        built = media.assetRowFor("gallery_external", { ...ctx, row });
      } else return reply(400, { error: "Unknown photo source" });
      if (built.error) return reply(400, { error: built.error });
    } else {
      const v = media.validateUpload(b, userId, project.id);
      if (v.error) return reply(400, { error: v.error });
      built = { row: { project_id: project.id, user_id: userId, scene_index: sc.index, version, source: "upload", asset_key: v.key, original_url: null, staged_url: null, ai_generated: false, rights: v.rights, status: "approved" } };
    }

    // One approved photo per scene: retire the previous pick, then record the new one.
    await supabase("PATCH", "agent_marketing_assets", { status: "rejected" }, `?project_id=eq.${project.id}&user_id=eq.${userId}&scene_index=eq.${sc.index}&status=eq.approved`);
    const ins = await supabase("POST", "agent_marketing_assets", built.row);
    if (!dbOk(ins)) { console.error("agent-marketing-media insert failed:", ins && ins.status); return reply(500, { error: "Could not save that photo" }); }
    if (project.status === "narrative_approved") await supabase("PATCH", "agent_marketing_projects", { status: "images", updated_at: new Date().toISOString() }, `?id=eq.${project.id}&user_id=eq.${userId}`);
    return reply(200, { item: await viewOf(rowsOf(ins)[0] || built.row) });
  } catch (e) {
    console.error("agent-marketing-media error:", e.message);
    return reply(500, { error: "Something went wrong. Please try again." });
  }
};
