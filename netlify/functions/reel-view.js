// reel-view.js — public page at /reel/<token>. Plays a shared Reel; mints a fresh 1-hour signed URL per visit.
const { S3Client, GetObjectCommand } = require("@aws-sdk/client-s3");
const { getSignedUrl } = require("@aws-sdk/s3-request-presigner");
const { readToken } = require("./lib/reel-share-lib");
const s3 = new S3Client({ region: process.env.S3_REGION, credentials: { accessKeyId: process.env.S3_ACCESS_KEY_ID, secretAccessKey: process.env.S3_SECRET_ACCESS_KEY } });
const H = { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-store", "X-Robots-Tag": "noindex, nofollow" };
const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
const shell = (body) => `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="robots" content="noindex,nofollow"><title>Property Reel</title>
<style>html,body{margin:0;background:#111;color:#f3efe6;font-family:system-ui,-apple-system,Segoe UI,Roboto,sans-serif}main{max-width:420px;margin:0 auto;padding:16px;text-align:center}video{width:100%;aspect-ratio:9/16;background:#000;border-radius:10px}a.btn{display:inline-block;margin-top:14px;padding:10px 18px;border:1px solid #c9a24b;color:#c9a24b;border-radius:6px;text-decoration:none;font-weight:600}p.note{font-size:.78rem;color:#a9a396;line-height:1.5}</style></head><body><main>${body}</main></body></html>`;

exports.handler = async (event) => {
  const token = decodeURIComponent(String(event.path || "").split("/").filter(Boolean).pop() || "");
  const t = readToken(token);
  if (t.error) {
    const msg = t.error === "expired" ? "This Reel link has expired. Ask the person who sent it to share it again." : "This Reel link isn’t valid.";
    return { statusCode: t.error === "expired" ? 410 : 404, headers: H, body: shell(`<h2>Reel unavailable</h2><p>${esc(msg)}</p>`) };
  }
  try {
    const Bucket = process.env.S3_BUCKET_NAME;
    const play = await getSignedUrl(s3, new GetObjectCommand({ Bucket, Key: t.key }), { expiresIn: 3600 });
    const dl = await getSignedUrl(s3, new GetObjectCommand({ Bucket, Key: t.key, ResponseContentDisposition: 'attachment; filename="property-reel.mp4"' }), { expiresIn: 3600 });
    return { statusCode: 200, headers: H, body: shell(
      `<video src="${esc(play)}" controls playsinline loop preload="metadata"></video><div><a class="btn" href="${esc(dl)}">Download video</a></div>` +
      `<p class="note">Images in this video are labeled Virtually Staged or Digitally Enhanced where applicable (California AB 723). This link expires ${esc(new Date(t.exp * 1000).toDateString())}.</p>`) };
  } catch (e) {
    console.error("reel-view error:", e.message);
    return { statusCode: 500, headers: H, body: shell("<h2>Reel unavailable</h2><p>Please try again in a moment.</p>") };
  }
};
