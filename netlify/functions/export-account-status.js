// export-account-status.js — Netlify Function
// Smart Stage PRO™  |  Poll endpoint for the account ZIP export
//
// GET ?jobId=<id>  (Authorization: Bearer <Supabase JWT>)
// Returns { status: 'none' | 'building' | 'ready' | 'empty' | 'failed', ... }
//   ready → also { url (presigned, 1 hour), imageCount, listingCount }
// Reads only the signed-in user's own record, and only for the jobId the
// browser started, so an older finished export is never handed back for a
// newer request.

const https = require("https");
const { getStore } = require("@netlify/blobs");
const { S3Client, GetObjectCommand } = require("@aws-sdk/client-s3");
const { getSignedUrl } = require("@aws-sdk/s3-request-presigner");

const s3 = new S3Client({
  region: process.env.S3_REGION,
  credentials: {
    accessKeyId: process.env.S3_ACCESS_KEY_ID,
    secretAccessKey: process.env.S3_SECRET_ACCESS_KEY,
  },
});

function getExportStore() {
  return getStore({
    name: "smart-stage-account-exports",
    siteID: process.env.SZREG_SITE_ID || process.env.NETLIFY_SITE_ID,
    token: process.env.NETLIFY_ACCESS_TOKEN,
    consistency: "strong",
  });
}

function verifyJWT(authHeader) {
  return new Promise((resolve) => {
    if (!authHeader || !authHeader.startsWith("Bearer ")) { resolve(null); return; }
    const jwt = authHeader.split(" ")[1];
    const url = new URL(`${process.env.SUPABASE_URL}/auth/v1/user`);
    const req = https.request({
      hostname: url.hostname, path: url.pathname, method: "GET",
      headers: { apikey: process.env.SUPABASE_SERVICE_ROLE_KEY, Authorization: `Bearer ${jwt}` },
    }, (res) => {
      let data = "";
      res.on("data", (c) => (data += c));
      res.on("end", () => {
        try { const p = JSON.parse(data); resolve(res.statusCode === 200 && p.id ? p : null); }
        catch { resolve(null); }
      });
    });
    req.on("error", () => resolve(null));
    req.end();
  });
}

const json = (statusCode, obj) => ({
  statusCode,
  headers: { "Content-Type": "application/json", "Cache-Control": "no-store" },
  body: JSON.stringify(obj),
});

exports.handler = async (event) => {
  if (event.httpMethod !== "GET") return json(405, { error: "Method Not Allowed" });

  const authUser = await verifyJWT(event.headers.authorization || event.headers.Authorization);
  if (!authUser) return json(401, { error: "Unauthorized" });

  const jobId = event.queryStringParameters?.jobId || "";
  if (!/^[A-Za-z0-9-]{8,64}$/.test(jobId)) return json(400, { error: "Invalid jobId" });

  let rec = null;
  try {
    const raw = await getExportStore().get(`user_${authUser.id}`);
    rec = raw ? JSON.parse(raw) : null;
  } catch (e) {
    console.warn("export-account-status: read failed:", e.message);
    return json(200, { status: "building" }); // transient — the browser keeps polling
  }

  // Not started yet (background function still spinning up) or a different job.
  if (!rec || rec.jobId !== jobId) return json(200, { status: "none" });

  if (rec.status === "ready" && rec.key) {
    const url = await getSignedUrl(
      s3,
      new GetObjectCommand({ Bucket: process.env.S3_BUCKET_NAME, Key: rec.key }),
      { expiresIn: 60 * 60 }
    );
    return json(200, {
      status: "ready", url,
      imageCount: rec.imageCount || 0,
      listingCount: rec.listingCount || 0,
      skipped: rec.skipped || 0,
    });
  }

  return json(200, {
    status: rec.status || "building",
    progress: rec.progress || null,
    error: rec.status === "failed" ? (rec.error === "export_window_closed" ? "export_window_closed" : "failed") : undefined,
  });
};
