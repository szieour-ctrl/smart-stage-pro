// reel-download.js — POST { jobId, userId } -> { downloadReady, branded, unbranded, charge:{via,images}, quota }
// The charge point for Reels. Branded + Unbranded (MLS) are one Reel and one charge.
// Charged once per Reel (idempotent): against the plan's Reel allotment first, then 1 Image per Reel beyond it.
// Any download resets the user's not-downloaded render counter to 0 (see lib/reel-quota-lib.js).
const { S3Client, GetObjectCommand, CopyObjectCommand } = require("@aws-sdk/client-s3");
const { getSignedUrl } = require("@aws-sdk/s3-request-presigner");
const quota = require("./lib/reel-quota-lib");
const { supabase } = require("./lib/marketing-profile-lib");
const { requireUser } = require("./lib/reel-auth-lib");

const headers = { "Access-Control-Allow-Origin": "*", "Content-Type": "application/json", "Cache-Control": "no-store" };
const reply = (statusCode, obj) => ({ statusCode, headers, body: JSON.stringify(obj) });
const DRAFT_PREFIX = "smart-stage-reel-drafts/";
// Oct 20, 2026 — a downloaded Listing Reel is an AB 723 record: it is copied out of the 7-day draft area into
// this permanent prefix and shown on the property compliance page. NO lifecycle/expiry rule may ever be
// applied to this prefix; its lifetime follows the compliance page (see compliance-page.js).
const FINAL_PREFIX = "smart-stage-reel-finals/";
const s3 = new S3Client({ region: process.env.S3_REGION, credentials: { accessKeyId: process.env.S3_ACCESS_KEY_ID, secretAccessKey: process.env.S3_SECRET_ACCESS_KEY } });
async function presign(key, secs) {
  if (!key || !String(key).startsWith(DRAFT_PREFIX)) return null;
  try { return await getSignedUrl(s3, new GetObjectCommand({ Bucket: process.env.S3_BUCKET_NAME, Key: key, ResponseContentDisposition: "attachment" }), { expiresIn: secs }); }
  catch (e) { console.error("reel-download presign failed:", e.message); return null; }
}
// Copies the job's branded + unbranded drafts to FINAL_PREFIX and records the keys on reel_jobs. Idempotent:
// safe to run on every download call, and it keeps retrying on later calls until both copies exist.
// Never throws and never blocks the download (the user has already been charged); a failure is logged.
async function persistFinals(jobId, keys) {
  try {
    const jr = await supabase("GET", "reel_jobs", null, `?id=eq.${encodeURIComponent(jobId)}&select=listing_id,final_branded_key,final_unbranded_key&limit=1`);
    if (jr.status >= 300) { console.error("reel finals lookup failed (run the 20261020 migration?):", JSON.stringify(jr.data).slice(0, 200)); return; }
    const job = Array.isArray(jr.data) ? jr.data[0] : null;
    if (!job || !job.listing_id) return;
    const out = {};
    for (const kind of ["branded", "unbranded"]) {
      const src = keys[kind];
      if (!src || !String(src).startsWith(DRAFT_PREFIX)) continue;
      const existing = job[`final_${kind}_key`];
      if (existing) { out[`final_${kind}_key`] = existing; continue; }
      const dest = `${FINAL_PREFIX}${jobId}/${kind}.mp4`;
      await s3.send(new CopyObjectCommand({ Bucket: process.env.S3_BUCKET_NAME, CopySource: `${process.env.S3_BUCKET_NAME}/${src}`, Key: dest }));
      out[`final_${kind}_key`] = dest;
    }
    if (Object.keys(out).length && (out.final_branded_key !== job.final_branded_key || out.final_unbranded_key !== job.final_unbranded_key)) {
      const u = await supabase("PATCH", "reel_jobs", { ...out, finalized_at: new Date().toISOString() }, `?id=eq.${encodeURIComponent(jobId)}`);
      if (u.status >= 300) console.error("reel finals update failed:", JSON.stringify(u.data).slice(0, 200));
    }
  } catch (e) {
    console.error("reel persistFinals error (non-fatal):", e.message);
  }
}
const STATUS = { job_not_found: 404, forbidden: 403, not_ready: 409, insufficient_credits: 402, no_active_subscription: 402 };

exports.handler = async (event) => {
  if (event.httpMethod === "OPTIONS") return { statusCode: 204, headers: { ...headers, "Access-Control-Allow-Headers": "Content-Type, Authorization", "Access-Control-Allow-Methods": "POST, OPTIONS" }, body: "" };
  if (event.httpMethod !== "POST") return reply(405, { error: "Method not allowed" });
  let b; try { b = JSON.parse(event.body || "{}"); } catch { return reply(400, { error: "Invalid JSON" }); }
  const auth = await requireUser(event);
  if (auth.error) return reply(auth.error.status, auth.error.body);
  const userId = auth.user.id; // never the body's userId
  const { jobId } = b;
  if (!/^[\w-]{6,80}$/.test(String(jobId || ""))) return reply(400, { error: "Missing jobId" });
  try {
    const r = await quota.chargeDownload(jobId, userId);
    if (r.error) return reply(STATUS[r.error] || 500, { error: r.error, required: r.required, balance: r.balance });
    await persistFinals(jobId, r.keys);
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
