// reel-download.js — POST { jobId, userId } -> { downloadReady, branded, unbranded, charge:{via,images}, quota }
// The charge point for Reels. Branded + Unbranded (MLS) are one Reel and one charge.
// Charged once per Reel (idempotent): against the plan's Reel allotment first, then 1 Image per Reel beyond it.
// Any download resets the user's not-downloaded render counter to 0 (see lib/reel-quota-lib.js).
const { S3Client, GetObjectCommand } = require("@aws-sdk/client-s3");
const { getSignedUrl } = require("@aws-sdk/s3-request-presigner");
const quota = require("./lib/reel-quota-lib");

const headers = { "Access-Control-Allow-Origin": "*", "Content-Type": "application/json", "Cache-Control": "no-store" };
const reply = (statusCode, obj) => ({ statusCode, headers, body: JSON.stringify(obj) });
const DRAFT_PREFIX = "smart-stage-reel-drafts/";
const s3 = new S3Client({ region: process.env.S3_REGION, credentials: { accessKeyId: process.env.S3_ACCESS_KEY_ID, secretAccessKey: process.env.S3_SECRET_ACCESS_KEY } });
async function presign(key, secs) {
  if (!key || !String(key).startsWith(DRAFT_PREFIX)) return null;
  try { return await getSignedUrl(s3, new GetObjectCommand({ Bucket: process.env.S3_BUCKET_NAME, Key: key, ResponseContentDisposition: "attachment" }), { expiresIn: secs }); }
  catch (e) { console.error("reel-download presign failed:", e.message); return null; }
}
const STATUS = { job_not_found: 404, forbidden: 403, not_ready: 409, insufficient_credits: 402, no_active_subscription: 402 };

exports.handler = async (event) => {
  if (event.httpMethod === "OPTIONS") return { statusCode: 204, headers: { ...headers, "Access-Control-Allow-Headers": "Content-Type", "Access-Control-Allow-Methods": "POST, OPTIONS" }, body: "" };
  if (event.httpMethod !== "POST") return reply(405, { error: "Method not allowed" });
  let b; try { b = JSON.parse(event.body || "{}"); } catch { return reply(400, { error: "Invalid JSON" }); }
  const { jobId, userId } = b;
  if (!/^[\w-]{6,80}$/.test(String(jobId || "")) || !userId) return reply(400, { error: "Missing jobId or userId" });
  try {
    const r = await quota.chargeDownload(jobId, userId);
    if (r.error) return reply(STATUS[r.error] || 500, { error: r.error, required: r.required, balance: r.balance });
    const [branded, unbranded] = await Promise.all([presign(r.keys.branded, 86400), presign(r.keys.unbranded, 86400)]);
    return reply(200, {
      downloadReady: true, branded, unbranded,
      charge: { via: r.via, images: r.images, already: !!r.already },
      quota: await quota.getQuotaSummary(userId),
    });
  } catch (e) {
    console.error("reel-download error:", e.message);
    return reply(500, { error: e.message });
  }
};
