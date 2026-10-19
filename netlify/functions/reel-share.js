// reel-share.js — POST {key} -> {url, expiresAt}. Makes a 7-day public share link for a rendered Reel draft.
// The link never exposes the S3 address; /reel/<token> (reel-view.js) mints a fresh signed URL on each visit.
// The share lifetime is capped at the draft's own 7-day life (counted from its upload time).
const { S3Client, HeadObjectCommand } = require("@aws-sdk/client-s3");
const { makeToken, KEY_RE, SHARE_SECONDS } = require("./lib/reel-share-lib");
const { supabase } = require("./lib/marketing-profile-lib");
const headers = { "Access-Control-Allow-Origin": "*", "Content-Type": "application/json", "Cache-Control": "no-store" };
const reply = (statusCode, obj) => ({ statusCode, headers, body: JSON.stringify(obj) });
const s3 = new S3Client({ region: process.env.S3_REGION, credentials: { accessKeyId: process.env.S3_ACCESS_KEY_ID, secretAccessKey: process.env.S3_SECRET_ACCESS_KEY } });

exports.handler = async (event) => {
  if (event.httpMethod === "OPTIONS") return { statusCode: 204, headers: { ...headers, "Access-Control-Allow-Headers": "Content-Type", "Access-Control-Allow-Methods": "POST, OPTIONS" }, body: "" };
  if (event.httpMethod !== "POST") return reply(405, { error: "Method not allowed" });
  let b; try { b = JSON.parse(event.body || "{}"); } catch { return reply(400, { error: "Invalid JSON" }); }
  const key = String(b.key || "");
  if (!KEY_RE.test(key)) return reply(400, { error: "Invalid Reel" });
  try {
    // Sharing is a delivery: the Reel must have been downloaded (charged) first. Drafts rendered before
    // charging existed have no reel_jobs row and are still allowed until they expire.
    const jr = await supabase("GET", "reel_jobs", null, `?or=(branded_key.eq.${encodeURIComponent(key)},unbranded_key.eq.${encodeURIComponent(key)})&select=downloaded_at&limit=1`);
    const job = Array.isArray(jr.data) ? jr.data[0] : null;
    if (job && !job.downloaded_at) return reply(402, { error: "Download this Reel first to unlock sharing." });
    const h = await s3.send(new HeadObjectCommand({ Bucket: process.env.S3_BUCKET_NAME, Key: key }));
    const now = Math.floor(Date.now() / 1000);
    const born = h.LastModified ? Math.floor(h.LastModified.getTime() / 1000) : now;
    const exp = Math.min(now + SHARE_SECONDS, born + SHARE_SECONDS);
    if (exp <= now + 60) return reply(410, { error: "This Reel has expired. Please render it again." });
    const base = (process.env.SITE_URL || "https://smartstagepro.com").replace(/\/+$/, "");
    return reply(200, { url: `${base}/reel/${makeToken(key, exp)}`, expiresAt: exp * 1000 });
  } catch (e) {
    console.error("reel-share error:", e.name, e.message);
    return reply(e.name === "NotFound" ? 404 : 500, { error: e.name === "NotFound" ? "Reel file not found" : "Could not create the share link" });
  }
};
