// agent-appearance.js — Netlify Function. Agent Appearance Sheet, slice 2: the headshot intake (Nov 27, 2026).
// Same switch as the rest of Agent Marketing; 404 when off. The user always comes from the login token.
//
//   GET                                   → state: pool, consent, the uploaded photo and its check, enhanced drafts, the approved headshot
//   POST { action: "consent", version }   → records the consent line
//   POST { action: "presign", contentType } → { uploadUrl, key } (the browser PUTs the raw photo to private storage)
//   POST { action: "check", key, contentType } → makes the working copy, runs the photo check
//   POST { action: "enhance" }            → starts one enhancement (a background job); takes one iteration from the pool
//   POST { action: "approve" | "reject", assetId }
//   POST { action: "refill", confirmed }  → out of iterations: 5 Images buys 12 more
const { PutObjectCommand, S3Client } = require("@aws-sdk/client-s3");
const { getSignedUrl } = require("@aws-sdk/s3-request-presigner");
const { requireUser } = require("./lib/reel-auth-lib");
const { brandingKeyPrefix } = require("./lib/marketing-profile-lib");
const { selfBase } = require("./lib/self-dispatch-lib");
const am = require("./lib/agent-marketing-lib");
const H = require("./lib/agent-appearance-headshot-lib");
const R = require("./lib/agent-appearance-headshot-run-lib");
const fal = require("./lib/agent-appearance-fal-lib");

const headers = { "Access-Control-Allow-Origin": "*", "Content-Type": "application/json", "Cache-Control": "no-store" };
const reply = (statusCode, obj) => ({ statusCode, headers, body: JSON.stringify(obj) });
const fail = (r) => reply(r.status || 400, { error: r.error, ...(r.code ? { code: r.code } : {}), ...(r.images ? { images: r.images } : {}) });

exports.handler = async (event) => {
  if (event.httpMethod === "OPTIONS") return { statusCode: 204, headers: { ...headers, "Access-Control-Allow-Headers": "Content-Type, Authorization", "Access-Control-Allow-Methods": "GET, POST, OPTIONS" }, body: "" };
  const auth = await requireUser(event);
  if (auth.error) return reply(auth.error.status, auth.error.body);
  const userId = auth.user.id;
  if (!am.isEnabledFor(userId)) return reply(404, { error: "Not found" });
  if (!process.env.S3_BUCKET_NAME || !process.env.S3_REGION) return reply(500, { error: "Storage is not configured." });
  const deps = fal.realDeps(process.env, userId);
  try {
    if (event.httpMethod === "GET") return reply(200, await R.loadState({ deps, userId }));
    if (event.httpMethod !== "POST") return reply(405, { error: "Method not allowed" });
    let b = {}; try { b = JSON.parse(event.body || "{}"); } catch { return reply(400, { error: "Invalid request." }); }

    if (b.action === "consent") { const r = await R.recordConsent({ deps, userId, version: b.version }); return r.ok ? reply(200, await R.loadState({ deps, userId })) : fail(r); }

    if (b.action === "presign") {
      const bad = H.validateUpload({ contentType: b.contentType });
      if (bad) return reply(400, { error: bad });
      const sheet = await deps.db.ensureSheet(userId);
      const key = R.rawUploadKey({ deps, sheet, userId, contentType: b.contentType });
      const s3 = new S3Client({ region: process.env.S3_REGION, credentials: { accessKeyId: process.env.S3_ACCESS_KEY_ID, secretAccessKey: process.env.S3_SECRET_ACCESS_KEY } });
      const uploadUrl = await getSignedUrl(s3, new PutObjectCommand({ Bucket: process.env.S3_BUCKET_NAME, Key: key, ContentType: b.contentType }), { expiresIn: 300 });
      return reply(200, { uploadUrl, key });
    }

    if (b.action === "check") {
      if (!process.env.ANTHROPIC_API_KEY) return reply(500, { error: "The photo check is not configured." });
      const r = await R.checkUpload({ deps, userId, key: b.key, contentType: b.contentType });
      return r.ok ? reply(200, await R.loadState({ deps, userId })) : fail(r);
    }

    if (b.action === "enhance") {
      if (!process.env.FAL_KEY) return reply(500, { error: "Headshot enhancement is not configured." });
      const g = await R.readyToEnhance({ deps, userId });
      if (!g.ok) return fail(g);
      if (require("./lib/self-dispatch-lib").pageDispatch(event)) return reply(202, { dispatch: true, assetId: g.assetId });
      const siteUrl = selfBase(event, process.env.URL || `https://${event.headers && event.headers.host}`);
      try {
        await fetch(`${siteUrl}/.netlify/functions/agent-appearance-background`, { method: "POST", headers: { "Content-Type": "application/json", "x-internal-key": process.env.INTERNAL_API_KEY }, body: JSON.stringify({ owner: userId, assetId: g.assetId }) });
      } catch (e) { console.error("agent-appearance dispatch failed:", e.message); return reply(502, { error: "The enhancement could not be started. Please try again." }); }
      return reply(202, { assetId: g.assetId });
    }

    if (b.action === "approve") { const r = await R.approveEnhanced({ deps, userId, assetId: b.assetId, brandingPrefix: brandingKeyPrefix(userId) }); return r.ok ? reply(200, { ...(await R.loadState({ deps, userId })), profileUpdated: r.profileUpdated }) : fail(r); }
    if (b.action === "reject") { const r = await R.rejectEnhanced({ deps, userId, assetId: b.assetId }); return r.ok ? reply(200, await R.loadState({ deps, userId })) : fail(r); }
    if (b.action === "refill") { const r = await R.refillPool({ deps, userId, confirmed: b.confirmed }); return r.ok ? reply(200, await R.loadState({ deps, userId })) : fail(r); }
    return reply(400, { error: "Unknown action." });
  } catch (e) {
    console.error("agent-appearance error:", e.message);
    return reply(500, { error: "Something went wrong. Please try again." });
  }
};
