// reel-recent.js — Netlify Function. Lets a user get back to Reels they rendered but have not downloaded
// (or want to re-open) after reloading the page, logging out, or switching devices.
//   GET                 → { reels: [{ jobId, event, lengthSec, createdAt, downloaded, listingId, address, hasBranded, hasUnbranded }] }
//                         the caller's own completed renders from the last 7 days (the draft files' lifetime), newest first.
//   GET ?jobId=reel-... → { jobId, branded, unbranded, keys, durationSec, downloaded } with fresh 1-hour preview links.
// Login required; the user always comes from the verified token. Charging still happens only in reel-download.
const { S3Client, GetObjectCommand } = require("@aws-sdk/client-s3");
const { getSignedUrl } = require("@aws-sdk/s3-request-presigner");
const { supabase } = require("./lib/marketing-profile-lib");
const { requireUser, UUID_RE } = require("./lib/reel-auth-lib");

const headers = { "Access-Control-Allow-Origin": "*", "Content-Type": "application/json", "Cache-Control": "no-store" };
const reply = (statusCode, obj) => ({ statusCode, headers, body: JSON.stringify(obj) });
const DRAFT_PREFIX = "smart-stage-reel-drafts/";
const DAYS = 7;
const s3 = new S3Client({ region: process.env.S3_REGION, credentials: { accessKeyId: process.env.S3_ACCESS_KEY_ID, secretAccessKey: process.env.S3_SECRET_ACCESS_KEY } });

async function presign(key) {
  if (!key || !String(key).startsWith(DRAFT_PREFIX)) return null;
  try { return await getSignedUrl(s3, new GetObjectCommand({ Bucket: process.env.S3_BUCKET_NAME, Key: key }), { expiresIn: 3600 }); }
  catch (e) { console.error("reel-recent presign failed:", e.message); return null; }
}

exports.handler = async (event) => {
  if (event.httpMethod === "OPTIONS") return { statusCode: 204, headers: { ...headers, "Access-Control-Allow-Headers": "Content-Type, Authorization", "Access-Control-Allow-Methods": "GET, OPTIONS" }, body: "" };
  if (event.httpMethod !== "GET") return reply(405, { error: "Method not allowed" });
  const auth = await requireUser(event);
  if (auth.error) return reply(auth.error.status, auth.error.body);
  const userId = auth.user.id;
  const since = new Date(Date.now() - DAYS * 24 * 3600 * 1000).toISOString();
  const qs = event.queryStringParameters || {};

  try {
    if (qs.jobId) {
      if (!/^[\w-]{6,80}$/.test(qs.jobId)) return reply(400, { error: "Invalid jobId" });
      const r = await supabase("GET", "reel_jobs", null, `?id=eq.${encodeURIComponent(qs.jobId)}&select=user_id,status,length_sec,created_at,downloaded_at,branded_key,unbranded_key&limit=1`);
      const job = Array.isArray(r.data) ? r.data[0] : null;
      if (!job) return reply(404, { error: "Reel not found" });
      if (job.user_id !== userId) return reply(403, { error: "This Reel belongs to another account" });
      if (job.status !== "complete" || job.created_at < since) return reply(410, { error: "This Reel has expired. Please render it again." });
      const [branded, unbranded] = await Promise.all([presign(job.branded_key), presign(job.unbranded_key)]);
      if (!branded && !unbranded) return reply(410, { error: "This Reel has expired. Please render it again." });
      return reply(200, { jobId: qs.jobId, branded, unbranded, keys: { branded: job.branded_key || null, unbranded: job.unbranded_key || null }, durationSec: job.length_sec, downloaded: !!job.downloaded_at });
    }

    const r = await supabase("GET", "reel_jobs", null, `?user_id=eq.${userId}&status=eq.complete&created_at=gte.${encodeURIComponent(since)}&select=id,event,length_sec,created_at,downloaded_at,listing_id,branded_key,unbranded_key&order=created_at.desc&limit=10`);
    const jobs = Array.isArray(r.data) ? r.data : [];
    const ids = [...new Set(jobs.map((j) => j.listing_id).filter((x) => UUID_RE.test(String(x || ""))))];
    const addr = new Map();
    if (ids.length) {
      const l = await supabase("GET", "listings", null, `?id=in.(${ids.join(",")})&select=id,address`);
      (Array.isArray(l.data) ? l.data : []).forEach((x) => addr.set(x.id, x.address));
    }
    return reply(200, { reels: jobs.map((j) => ({
      jobId: j.id, event: j.event, lengthSec: j.length_sec, createdAt: j.created_at, downloaded: !!j.downloaded_at,
      listingId: j.listing_id, address: addr.get(j.listing_id) || null, hasBranded: !!j.branded_key, hasUnbranded: !!j.unbranded_key,
    })) });
  } catch (e) {
    console.error("reel-recent error:", e.message);
    return reply(500, { error: "Could not load your recent Reels" });
  }
};
