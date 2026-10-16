// upload-clean-copy.js — private, unbadged "clean copy" of a Final for PRO Plus Video.
//
// Why: Generate Final bakes the AB 723 badge into the image (Gallery, compliance pages
// and Downloads keep that version, unchanged). The video renderer now overlays the badge
// as a fixed element in both 16:9 and 9:16 so a vertical crop can never cut it off — which
// needs the same image WITHOUT the baked badge.
//
// Two POST actions (browser PUTs the bytes straight to S3, same pattern as upload-staged.js):
//   { action: "presign", projectId }
//       → { uploadUrl, cleanKey }   presigned PUT into the PRIVATE prefix smart-stage-video-clean/
//   { action: "link", projectId, stagedUrl, cleanKey, badgeType }
//       → sets staged_images.clean_s3_key / badge_type on the row whose
//         cloudinary_staged_url = stagedUrl
//
// The prefix must stay OUT of the bucket's public-read policy: clean copies are unbadged
// and are only ever reached through presigned GET URLs minted by video-job.js for Railway.
//
// Requires: migration add_clean_copy_columns.sql (staged_images.clean_s3_key, badge_type).

const https = require("https");
const crypto = require("crypto");
const { S3Client, PutObjectCommand } = require("@aws-sdk/client-s3");
const { getSignedUrl } = require("@aws-sdk/s3-request-presigner");

const s3 = new S3Client({
  region: process.env.S3_REGION,
  credentials: {
    accessKeyId: process.env.S3_ACCESS_KEY_ID,
    secretAccessKey: process.env.S3_SECRET_ACCESS_KEY,
  },
});

const CLEAN_PREFIX = "smart-stage-video-clean/";
const VALID_BADGE_TYPES = new Set(["virtually_staged", "digitally_enhanced"]);

function supabase(method, table, body, queryParams = "") {
  return new Promise((resolve, reject) => {
    const url = new URL(`${process.env.SUPABASE_URL}/rest/v1/${table}${queryParams}`);
    const bodyStr = body ? JSON.stringify(body) : null;
    const req = https.request({
      hostname: url.hostname, path: url.pathname + url.search, method,
      headers: {
        apikey: process.env.SUPABASE_SERVICE_ROLE_KEY,
        Authorization: `Bearer ${process.env.SUPABASE_SERVICE_ROLE_KEY}`,
        "Content-Type": "application/json",
        Prefer: "return=representation",
        ...(bodyStr ? { "Content-Length": Buffer.byteLength(bodyStr) } : {}),
      },
    }, (res) => {
      let data = "";
      res.on("data", (c) => (data += c));
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

// Confirms the bearer token is a real, current Supabase user session.
function verifyUser(jwt) {
  return new Promise((resolve) => {
    if (!jwt) return resolve(null);
    const url = new URL(`${process.env.SUPABASE_URL}/auth/v1/user`);
    const req = https.request({
      hostname: url.hostname, path: url.pathname, method: "GET",
      headers: { apikey: process.env.SUPABASE_SERVICE_ROLE_KEY, Authorization: `Bearer ${jwt}` },
    }, (res) => {
      let data = "";
      res.on("data", (c) => (data += c));
      res.on("end", () => {
        try { const u = JSON.parse(data); resolve(res.statusCode === 200 && u.id ? u : null); }
        catch { resolve(null); }
      });
    });
    req.on("error", () => resolve(null));
    req.end();
  });
}

exports.handler = async (event) => {
  const headers = {
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Headers": "Content-Type, Authorization",
    "Content-Type": "application/json",
  };
  if (event.httpMethod === "OPTIONS") return { statusCode: 200, headers, body: "" };
  if (event.httpMethod !== "POST") return { statusCode: 405, headers, body: JSON.stringify({ error: "POST only" }) };

  try {
    const jwt = (event.headers.authorization || event.headers.Authorization || "").replace(/^Bearer\s+/i, "");
    const user = await verifyUser(jwt);
    if (!user) return { statusCode: 401, headers, body: JSON.stringify({ error: "Not signed in" }) };

    const body = JSON.parse(event.body || "{}");
    const projectId = String(body.projectId || "").replace(/[^a-zA-Z0-9_-]/g, "").slice(0, 80);
    if (!projectId) return { statusCode: 400, headers, body: JSON.stringify({ error: "Missing projectId" }) };

    if (body.action === "presign") {
      const cleanKey = `${CLEAN_PREFIX}${projectId}/${Date.now()}-${crypto.randomBytes(6).toString("hex")}.jpg`;
      const uploadUrl = await getSignedUrl(
        s3,
        new PutObjectCommand({ Bucket: process.env.S3_BUCKET_NAME, Key: cleanKey, ContentType: "image/jpeg" }),
        { expiresIn: 600 }
      );
      return { statusCode: 200, headers, body: JSON.stringify({ uploadUrl, cleanKey }) };
    }

    if (body.action === "link") {
      const { stagedUrl, cleanKey, badgeType } = body;
      if (!stagedUrl || !cleanKey || !VALID_BADGE_TYPES.has(badgeType)) {
        return { statusCode: 400, headers, body: JSON.stringify({ error: "Missing/invalid stagedUrl, cleanKey or badgeType" }) };
      }
      // Only keys this function itself issued for this project may be linked.
      if (!cleanKey.startsWith(`${CLEAN_PREFIX}${projectId}/`)) {
        return { statusCode: 400, headers, body: JSON.stringify({ error: "cleanKey does not belong to this project" }) };
      }
      const r = await supabase("PATCH", "staged_images",
        { clean_s3_key: cleanKey, badge_type: badgeType },
        `?cloudinary_staged_url=eq.${encodeURIComponent(stagedUrl)}`
      );
      if (r.status >= 300 || !Array.isArray(r.data) || r.data.length === 0) {
        console.error("upload-clean-copy link failed:", r.status, JSON.stringify(r.data).slice(0, 300));
        return { statusCode: 404, headers, body: JSON.stringify({ error: "No matching staged image row to link" }) };
      }
      return { statusCode: 200, headers, body: JSON.stringify({ ok: true, rows: r.data.length }) };
    }

    return { statusCode: 400, headers, body: JSON.stringify({ error: "Unknown action" }) };
  } catch (err) {
    console.error("upload-clean-copy error:", err);
    return { statusCode: 500, headers, body: JSON.stringify({ error: err.message }) };
  }
};
