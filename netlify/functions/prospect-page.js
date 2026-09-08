// prospect-page.js — Netlify Function
// NEW (Sep 8, 2026): serves the "2nd touch" prospecting page.
// URL: /prospect/{slug}
//
// Deliberately NOT built on compliance-page.js's Netlify Blobs + Supabase
// `listings` machinery — per Sam's spec, this needs to be fully
// self-contained under S3's staging-prospects/{slug}/ folder, with nothing
// written to or read from the `listings` table for rendering, so a
// prospecting shot can never end up in My Listings or Gallery no matter
// what this page does. The Supabase `listings` row still exists for a
// prospecting project (it's load-bearing for slug/isProspecting resolution
// in upload-original.js/upload-staged.js — see reserveAssetKey() there),
// but this function never queries it.
//
// Content, per Sam: exactly one staged image, the same before/after slider
// used on the marketing homepage (same CSS/JS, copied here since this is a
// standalone server-rendered page, not part of the index.html SPA), plus
// marketing copy and a call to action. Images are served via short-lived
// signed URLs rather than relying on the bucket's public-read policy —
// staging-prospects/ was never confirmed to be covered by that policy the
// way listings/ explicitly was, and signing sidesteps the question rather
// than needing to verify/change bucket policy.

// FIX (Sep 8, 2026 — real bug found live): originally used
// ListObjectsV2Command to find the newest file under finals/ and
// originals/. Confirmed live: this is the ONLY function anywhere in the
// codebase that ever lists S3 objects — every other function only does
// Get/Put/Head on a key it already knows deterministically. This app's S3
// credentials were almost certainly scoped for exactly that (object-level
// access only, no bucket-level s3:ListBucket) — meaning ListObjectsV2Command
// was likely throwing AccessDenied, and the catch-all error handler below
// silently rendered that as the exact same "Page not found" text as a
// genuinely missing image, masking the real cause entirely. Fixed by
// removing the need to list anything: write-prospect-meta.js now stores
// the exact finalKey/originalKey it already knows (from the upload that
// just succeeded) directly in meta.json, so this function just reads two
// known keys — same permission profile as everything else in the app.

const { S3Client, GetObjectCommand, HeadObjectCommand } = require("@aws-sdk/client-s3");
const { getSignedUrl } = require("@aws-sdk/s3-request-presigner");

const s3 = new S3Client({
  region: process.env.S3_REGION,
  credentials: {
    accessKeyId: process.env.S3_ACCESS_KEY_ID,
    secretAccessKey: process.env.S3_SECRET_ACCESS_KEY,
  },
});

const BUCKET = process.env.S3_BUCKET_NAME;

async function signKey(key) {
  if (!key) return null;
  return getSignedUrl(s3, new GetObjectCommand({ Bucket: BUCKET, Key: key }), { expiresIn: 60 * 60 * 24 * 7 });
}

async function signQrIfExists(slug) {
  const key = `staging-prospects/${slug}/qr.png`;
  try {
    await s3.send(new HeadObjectCommand({ Bucket: BUCKET, Key: key }));
    return signKey(key);
  } catch {
    return null; // no qr.png yet — e.g. a prospect created before this fix shipped
  }
}

async function readMeta(slug) {
  try {
    const res = await s3.send(new GetObjectCommand({ Bucket: BUCKET, Key: `staging-prospects/${slug}/meta.json` }));
    const chunks = [];
    for await (const chunk of res.Body) chunks.push(chunk);
    return JSON.parse(Buffer.concat(chunks).toString("utf-8"));
  } catch {
    return {};
  }
}

function escHtml(str) {
  return String(str || "")
    .replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

function renderPage({ slug, address, beforeUrl, afterUrl, qrUrl }) {
  const displayAddress = address || "This Property";
  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>${escHtml(displayAddress)} — Staged with Smart Stage PRO</title>
<meta name="robots" content="noindex, nofollow">
<style>
:root{--ink:#1a1714;--cream:#f7f4ef;--warm:#e8e0d4;--gold:#b8975a;--gold-light:#d4b87a;--muted:#7a6f63;--border:#ddd5c8;--shadow:0 2px 20px rgba(26,23,20,0.08);}
*{box-sizing:border-box;margin:0;padding:0;}
body{font-family:'DM Sans',Arial,sans-serif;background:var(--cream);color:var(--ink);min-height:100vh;line-height:1.6;}
.wrap{max-width:720px;margin:0 auto;padding:32px 20px 60px;}
.brand{text-align:center;font-family:Georgia,serif;font-size:1.05rem;letter-spacing:0.06em;color:var(--ink);margin-bottom:28px;text-transform:uppercase;}
.brand b{color:var(--gold);}
.eyebrow{text-align:center;font-size:0.72rem;letter-spacing:0.12em;text-transform:uppercase;color:var(--gold);font-weight:700;margin-bottom:8px;}
h1{font-family:Georgia,serif;font-weight:400;font-size:1.7rem;text-align:center;margin-bottom:6px;}
.address{text-align:center;color:var(--muted);font-size:0.9rem;margin-bottom:26px;}
.slider-container{position:relative;width:100%;aspect-ratio:16/10;border-radius:8px;overflow:hidden;cursor:ew-resize;user-select:none;box-shadow:var(--shadow);background:#000;}
.sl-after,.sl-before{position:absolute;inset:0;width:100%;height:100%;object-fit:cover;display:block;pointer-events:none;}
.sl-before-wrap{position:absolute;inset:0;width:50%;overflow:hidden;pointer-events:none;}
.sl-before{position:absolute;top:0;left:0;object-position:left center;}
.sl-divider{position:absolute;top:0;bottom:0;left:50%;width:2px;background:var(--gold);transform:translateX(-50%);pointer-events:none;z-index:3;}
.sl-handle{position:absolute;top:50%;left:50%;transform:translate(-50%,-50%);width:38px;height:38px;filter:drop-shadow(0 3px 8px rgba(0,0,0,0.4));}
.sl-label{position:absolute;top:12px;font-size:0.62rem;font-weight:700;letter-spacing:0.08em;text-transform:uppercase;padding:5px 9px;border-radius:2px;z-index:2;pointer-events:none;background:rgba(26,23,20,0.8);color:var(--cream);}
.sl-label.before-label{left:12px;}
.sl-label.after-label{right:12px;background:var(--gold);color:var(--ink);}
.pitch{background:#fff;border:1px solid var(--border);border-radius:6px;padding:26px 28px;margin-top:28px;box-shadow:var(--shadow);text-align:center;}
.pitch h2{font-family:Georgia,serif;font-weight:400;font-size:1.25rem;margin-bottom:10px;}
.pitch p{color:var(--muted);font-size:0.92rem;margin-bottom:18px;}
.cta{display:inline-block;background:var(--gold);color:var(--ink);font-weight:600;font-size:0.85rem;letter-spacing:0.02em;padding:12px 28px;border-radius:4px;text-decoration:none;transition:background 0.15s ease;}
.cta:hover{background:var(--gold-light);}
.footer{text-align:center;color:var(--muted);font-size:0.72rem;margin-top:28px;}
</style>
</head>
<body>
<div class="wrap">
  <div class="brand">SMART STAGE <b>PRO</b></div>
  <div class="eyebrow">Before &amp; After</div>
  <h1>See What This Photo Could Look Like</h1>
  <div class="address">${escHtml(displayAddress)}</div>

  <div class="slider-container" data-slider>
    <img class="sl-after" src="${afterUrl}" alt="Staged" draggable="false" />
    <div class="sl-before-wrap">
      <img class="sl-before" src="${beforeUrl}" alt="Original" draggable="false" />
    </div>
    <span class="sl-label before-label">Original</span>
    <span class="sl-label after-label">Smart Stage PRO Final</span>
    <div class="sl-divider"><div class="sl-handle">
      <svg viewBox="0 0 40 40" xmlns="http://www.w3.org/2000/svg"><circle cx="20" cy="20" r="19" fill="#1a1714" stroke="#b8975a" stroke-width="1.5"/><polyline points="16,13 9,20 16,27" fill="none" stroke="#b8975a" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"/><polyline points="24,13 31,20 24,27" fill="none" stroke="#b8975a" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"/></svg>
    </div></div>
  </div>

  <div class="pitch">
    <h2>This is what Smart Stage PRO can do for your listings.</h2>
    <p>AI-powered virtual staging, AB 723-compliant disclosure built in, ready in minutes — not days. Every listing gets its own permanent compliance record and QR code, automatically.</p>
    <div style="display:flex;gap:14px;justify-content:center;flex-wrap:wrap;align-items:center;">
      <a class="cta" href="https://smartstagepro.com/#pricing" target="_blank">See Plans &amp; Pricing →</a>
      ${qrUrl ? `<a href="${qrUrl}" download="SmartStage_QR_${slug}.png" style="color:var(--muted);font-size:0.82rem;text-decoration:underline;">↓ Download this QR code</a>` : ""}
    </div>
  </div>

  <div class="footer">Smart Stage PRO · smartstagepro.com</div>
</div>
<script>
(function(){
  var container = document.querySelector('.slider-container[data-slider]');
  if (!container) return;
  var beforeWrap = container.querySelector('.sl-before-wrap');
  var divider = container.querySelector('.sl-divider');
  var isDragging = false;
  function setPosition(pct){
    pct = Math.max(2, Math.min(98, pct));
    beforeWrap.style.width = pct + '%';
    divider.style.left = pct + '%';
  }
  function getPct(clientX){
    var rect = container.getBoundingClientRect();
    return ((clientX - rect.left) / rect.width) * 100;
  }
  container.addEventListener('mousedown', function(e){ isDragging = true; setPosition(getPct(e.clientX)); e.preventDefault(); });
  window.addEventListener('mousemove', function(e){ if (isDragging) setPosition(getPct(e.clientX)); });
  window.addEventListener('mouseup', function(){ isDragging = false; });
  container.addEventListener('touchstart', function(e){ isDragging = true; setPosition(getPct(e.touches[0].clientX)); e.preventDefault(); }, { passive: false });
  window.addEventListener('touchmove', function(e){ if (isDragging) setPosition(getPct(e.touches[0].clientX)); }, { passive: true });
  window.addEventListener('touchend', function(){ isDragging = false; });
  setPosition(50);
})();
</script>
</body>
</html>`;
}

function renderNotFound(slug) {
  return `<!DOCTYPE html><html><head><meta charset="UTF-8"><title>Not Found</title>
<style>body{font-family:Arial,sans-serif;background:#f7f4ef;color:#1a1714;display:flex;align-items:center;justify-content:center;min-height:100vh;text-align:center;}
.box{max-width:420px;padding:32px;}</style></head>
<body><div class="box"><h2>Page not found</h2><p style="color:#7a6f63;margin-top:8px;">This prospecting link (${escHtml(slug)}) may have expired or is incorrect.</p></div></body></html>`;
}

// FIX (Sep 8, 2026): separate page for a genuine server-side error, so it's
// never confused with a real 404 again the way the old ListObjectsV2-based
// version's catch-all was. Same visual shell, different message — and the
// real error is always in the function logs via console.error below either way.
function renderServerError(slug) {
  return `<!DOCTYPE html><html><head><meta charset="UTF-8"><title>Something went wrong</title>
<style>body{font-family:Arial,sans-serif;background:#f7f4ef;color:#1a1714;display:flex;align-items:center;justify-content:center;min-height:100vh;text-align:center;}
.box{max-width:420px;padding:32px;}</style></head>
<body><div class="box"><h2>Something went wrong</h2><p style="color:#7a6f63;margin-top:8px;">This page (${escHtml(slug)}) hit a server error — check Netlify function logs for prospect-page. Not the same as a missing/expired link.</p></div></body></html>`;
}

exports.handler = async (event) => {
  const pathParts = (event.path || "").split("/").filter(Boolean);
  const slug = pathParts[pathParts.length - 1];
  const htmlHeaders = { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-store" };

  if (!slug || slug === "prospect") {
    return { statusCode: 400, headers: htmlHeaders, body: renderNotFound(slug || "") };
  }

  try {
    // FIX (Sep 8, 2026): finalKey/originalKey now come straight from
    // meta.json — written by write-prospect-meta.js right after the same
    // upload that already knows both keys exactly. No S3 listing, no
    // guessing at "newest" — see this file's header comment for why.
    const meta = await readMeta(slug);
    const finalKey = meta.finalKey;

    if (!finalKey) {
      return { statusCode: 404, headers: htmlHeaders, body: renderNotFound(slug) };
    }

    const [afterUrl, beforeUrl, qrUrl] = await Promise.all([
      signKey(finalKey),
      signKey(meta.originalKey || finalKey), // fall back to the final itself if somehow no original was recorded — page still renders rather than 404ing
      signQrIfExists(slug),
    ]);

    return {
      statusCode: 200,
      headers: htmlHeaders,
      body: renderPage({ slug, address: meta.address, beforeUrl, afterUrl, qrUrl }),
    };
  } catch (err) {
    console.error("prospect-page error for slug", slug, ":", err.message);
    return { statusCode: 500, headers: htmlHeaders, body: renderServerError(slug) };
  }
};
