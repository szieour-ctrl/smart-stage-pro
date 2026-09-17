// generate-thumbnail.js — Netlify Function
// Generates a small resized thumbnail for an already-uploaded S3 image.
//
// WHY THIS EXISTS AS A SEPARATE FUNCTION (August 2026 — picker-grid
// slowness after the S3 migration): upload-original.js can generate its
// thumbnail inline because it receives the image bytes directly in the
// request body. Staged finals don't work that way — upload-staged.js
// issues a presigned S3 PUT URL and the browser uploads the bytes DIRECTLY
// to S3 (see that file's own comments on why: avoiding the platform's
// payload ceiling). That function never has the actual image bytes to
// resize. This function is the follow-up step: called AFTER the direct
// browser→S3 upload finishes, given the resulting public URL, it downloads
// that image back down, resizes it, and uploads the thumbnail — the only
// way to get a server-side resize without restructuring the whole upload
// flow.
//
// Input:  { sourceUrl, projectId }
// Output: { thumbnailUrl } — null if generation fails (non-fatal by design,
//         same as upload-original.js's inline version — the picker grid
//         falls back to the full-res image when this is null)
//
// KEY NAMING (Aug 28, 2026 — readable-key migration): if sourceUrl points
// at a readable key (listings/{slug}/originals|finals/...), the thumbnail
// reuses the exact same slug/room/sequence, just under a thumbnails/
// folder — e.g. listings/2089-thornecroft-ln/finals/kitchen-01.jpg becomes
// listings/2089-thornecroft-ln/thumbnails/finals/kitchen-01.jpg. No new
// lookup or sequence needed: the source key already encodes everything,
// this is a straight folder swap. The corresponding media_assets row
// (matched by its s3_key, which equals the parsed source key) gets its
// thumbnail_key filled in, best-effort. Falls back to the legacy
// random-UUID scheme, unchanged, for any source key that doesn't match
// the new pattern.
//
// FIX (Sep 16, 2026 — confirmed real collision, not a hypothesis): the
// thumbnail key used to collapse BOTH "/originals/" and "/finals/" down
// to the exact same "/thumbnails/" folder. Since seq numbers are counted
// independently per image_type (see upload-original.js/upload-staged.js's
// reserveAssetKey), a room's original and final each start at seq 1
// independently — the ordinary case, not an edge case, is exactly one of
// each per room. That meant both types computed the IDENTICAL thumbnail
// key (e.g. listings/{slug}/thumbnails/bedroom-2-01.jpg), and since the
// final is always generated after its original, its thumbnail write
// silently overwrote the original's — while the original's own
// media_assets row still pointed at that same path string, now containing
// the wrong image. Confirmed live: Gallery showed the staged image under
// "Originals" while the click-to-copy URL (a separate field, untouched)
// was still correct — the full-res original file itself was never
// touched, only its derived thumbnail. Preserving the type segment
// (thumbnails/originals/... vs thumbnails/finals/...) instead of
// collapsing it makes the two paths structurally incapable of colliding,
// regardless of matching sequence numbers. Only affects NEW uploads going
// forward — existing thumbnail_key values already in Supabase are
// untouched by this change and need a separate backfill pass.

const https = require("https");
const crypto = require("crypto");
const sharp = require("sharp");
const { S3Client, PutObjectCommand } = require("@aws-sdk/client-s3");

const s3 = new S3Client({
  region: process.env.S3_REGION,
  credentials: {
    accessKeyId: process.env.S3_ACCESS_KEY_ID,
    secretAccessKey: process.env.S3_SECRET_ACCESS_KEY,
  },
});

const THUMBNAIL_MAX_DIM = 400;

function downloadBuffer(url) {
  return new Promise((resolve, reject) => {
    https.get(url, (res) => {
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
        return downloadBuffer(res.headers.location).then(resolve, reject);
      }
      if (res.statusCode !== 200) {
        reject(new Error(`HTTP ${res.statusCode} fetching ${url}`));
        res.resume();
        return;
      }
      const chunks = [];
      res.on("data", (c) => chunks.push(c));
      res.on("end", () => resolve(Buffer.concat(chunks)));
      res.on("error", reject);
    }).on("error", reject);
  });
}

// ── SUPABASE HELPER (same shape as project-manage.js's) ─────────────────────

function supabase(method, table, body, queryParams = "") {
  return new Promise((resolve, reject) => {
    const url = new URL(`${process.env.SUPABASE_URL}/rest/v1/${table}${queryParams}`);
    const bodyStr = body ? JSON.stringify(body) : null;
    const req = https.request({
      hostname: url.hostname,
      path: url.pathname + url.search,
      method,
      headers: {
        "apikey": process.env.SUPABASE_SERVICE_ROLE_KEY,
        "Authorization": `Bearer ${process.env.SUPABASE_SERVICE_ROLE_KEY}`,
        "Content-Type": "application/json",
        "Prefer": "return=representation",
        ...(bodyStr ? { "Content-Length": Buffer.byteLength(bodyStr) } : {})
      }
    }, res => {
      let data = "";
      res.on("data", c => data += c);
      res.on("end", () => {
        try { resolve({ status: res.statusCode, data: JSON.parse(data || "[]") }); }
        catch { resolve({ status: res.statusCode, data }); }
      });
    });
    req.on("error", reject);
    if (bodyStr) req.write(bodyStr);
    req.end();
  });
}

// Extracts the S3 key from one of our own public URLs. Returns null for
// anything that doesn't match (old Cloudinary URLs, external URLs, etc.)
function keyFromPublicUrl(url, bucket, region) {
  const prefix = `https://${bucket}.s3.${region}.amazonaws.com/`;
  return typeof url === "string" && url.startsWith(prefix) ? url.slice(prefix.length) : null;
}

exports.handler = async (event) => {
  const headers = {
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Headers": "Content-Type",
    "Content-Type": "application/json",
  };

  if (event.httpMethod !== "POST") return { statusCode: 405, headers, body: "Method Not Allowed" };

  try {
    const { sourceUrl, projectId } = JSON.parse(event.body || "{}");
    if (!sourceUrl) return { statusCode: 400, headers, body: JSON.stringify({ error: "Missing sourceUrl" }) };

    const bucket = process.env.S3_BUCKET_NAME;
    const region = process.env.S3_REGION;
    if (!bucket || !region) return {
      statusCode: 500, headers,
      body: JSON.stringify({ error: "S3_BUCKET_NAME or S3_REGION not configured" })
    };

    const original = await downloadBuffer(sourceUrl);
    const thumbBuffer = await sharp(original)
      .resize({ width: THUMBNAIL_MAX_DIM, height: THUMBNAIL_MAX_DIM, fit: "inside", withoutEnlargement: true })
      .jpeg({ quality: 80 })
      .toBuffer();

    const sourceKey = keyFromPublicUrl(sourceUrl, bucket, region);
    // Aug 28, 2026: staging-prospects/ added alongside listings/ as a recognized
    // readable-key root — prospecting shots get the same slug/room/seq
    // thumbnail treatment (staging-prospects/<slug>/thumbnails/...) instead of
    // falling back to the legacy random-UUID naming.
    const readableSourceKey = sourceKey &&
      (sourceKey.startsWith("listings/") || sourceKey.startsWith("staging-prospects/")) &&
      (sourceKey.includes("/originals/") || sourceKey.includes("/finals/"));

    // FIX (Sep 16, 2026) — see file header comment for the full collision
    // explanation. Preserves whichever of "originals"/"finals" matched,
    // instead of collapsing both into the same "/thumbnails/" folder.
    const thumbKey = readableSourceKey
      ? sourceKey.replace(/\/(originals|finals)\//, "/thumbnails/$1/")
      : `${projectId ? `smart-stage-thumbnails/${projectId}` : "smart-stage-thumbnails/unfiled"}/${crypto.randomUUID()}.jpg`;

    await s3.send(new PutObjectCommand({
      Bucket: bucket,
      Key: thumbKey,
      Body: thumbBuffer,
      ContentType: "image/jpeg",
    }));

    const thumbnailUrl = `https://${bucket}.s3.${region}.amazonaws.com/${thumbKey}`;

    if (readableSourceKey && process.env.SUPABASE_URL) {
      // AWAITED — see upload-original.js's lookupListingSlug comment for
      // why this can't be fire-and-forget in a serverless function.
      try {
        await supabase("PATCH", "media_assets", { thumbnail_key: thumbKey }, `?s3_key=eq.${encodeURIComponent(sourceKey)}`);
      } catch (e) {
        console.error("generate-thumbnail: thumbnail_key patch failed (non-fatal):", e.message);
      }
    }

    return { statusCode: 200, headers, body: JSON.stringify({ thumbnailUrl }) };

  } catch (err) {
    // Non-fatal by design from the CALLER's side — this function itself
    // still reports the real error for debugging, but index.html treats a
    // failure here as "no thumbnail available," not as blocking the whole
    // staged-image attach from completing.
    console.error("generate-thumbnail error:", err.message);
    return { statusCode: 500, headers, body: JSON.stringify({ error: err.message }) };
  }
};
