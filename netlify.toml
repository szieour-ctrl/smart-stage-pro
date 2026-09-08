// write-prospect-meta.js — Netlify Function
// NEW (Sep 8, 2026): writes staging-prospects/{slug}/meta.json AND
// staging-prospects/{slug}/qr.png directly to S3 — everything a prospecting
// shot needs beyond the images themselves, all living INSIDE the same S3
// folder as the images (see the screenshot that prompted this: Sam's
// staging-prospects/ bucket view, one folder per address). No Supabase
// write, no Netlify Blobs project record — the Supabase `listings` row
// created earlier in the flow still exists (it's load-bearing for
// upload-original.js/upload-staged.js's slug + isProspecting resolution —
// see reserveAssetKey() in those files), but this function and
// prospect-page.js never read from it. The S3 folder is the single source
// of truth for everything a prospecting page needs to render.
//
// FIX (Sep 8, 2026 — same day, real gap found live): originally this only
// wrote meta.json. The QR itself was only ever generated on-the-fly as a
// "Download QR" link in the app's compliance bar during the SAME session —
// nothing was ever saved. Confirmed live: leave the session, come back
// later, no way to get the QR back at all — which defeats the whole "2nd
// touch" point of prospecting. Now generates and saves qr.png here too, so
// it's sitting in the folder alongside everything else, downloadable any
// time, matching Sam's "keep everything in staging-prospects/" spec.
//
// Deliberately does NOT reuse generate-qr.js's branded canvas — that one
// has real AB 723 legal disclosure text baked in (correct for an actual
// listing, wrong here: there's no real transaction on a prospecting shot).
// This builds its own simpler, marketing-only canvas instead.
//
// Input:  POST { slug, address, siteUrl, finalKey, originalKey }
// Output: { ok: true }
//
// Idempotent — called once per Generate Final on a prospecting shot, always
// overwrites both files. Since the prospect page only ever shows the one
// most recent staged image (Sam's spec: "The Page will only have 1 staged
// image"), there's nothing to merge or append — this just reflects current
// state.

const { S3Client, PutObjectCommand } = require("@aws-sdk/client-s3");
const QRCode = require("qrcode");
const sharp = require("sharp");

const s3 = new S3Client({
  region: process.env.S3_REGION,
  credentials: {
    accessKeyId: process.env.S3_ACCESS_KEY_ID,
    secretAccessKey: process.env.S3_SECRET_ACCESS_KEY,
  },
});

const QR_PX = 480;
const CANVAS_W = 900;
const CANVAS_H = 780;
const QR_LEFT = (CANVAS_W - QR_PX) / 2;
const QR_TOP = 60;

function escSVG(str) {
  return String(str || "")
    .replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

function splitAddress(address) {
  const parts = (address || "").split(",");
  const street = (parts[0] || "").trim();
  const cityState = parts.slice(1).join(",").replace(/,?\s*USA\s*$/i, "").trim();
  return { street, cityState };
}

// Marketing-only canvas — no AB 723 / compliance language, since nothing
// here represents a real listing or a real disclosure obligation.
function buildCanvasSVG(address) {
  const { street, cityState } = splitAddress(address);
  const QR_BOTTOM = QR_TOP + QR_PX;

  return `<svg width="${CANVAS_W}" height="${CANVAS_H}" xmlns="http://www.w3.org/2000/svg">
    <rect width="${CANVAS_W}" height="${CANVAS_H}" fill="#f5f0e8"/>
    <rect width="${CANVAS_W}" height="8" fill="#b8975a"/>

    <rect x="${QR_LEFT - 16}" y="${QR_TOP - 16}" width="${QR_PX + 32}" height="${QR_PX + 32}" fill="#e8e0d0" rx="10"/>
    <rect x="${QR_LEFT - 12}" y="${QR_TOP - 12}" width="${QR_PX + 24}" height="${QR_PX + 24}" fill="#ffffff" rx="8"/>

    <text x="${CANVAS_W / 2}" y="${QR_BOTTOM + 56}" font-family="Arial, sans-serif" font-size="34" font-weight="700" fill="#1a1714" text-anchor="middle">${escSVG(street) || "See This Photo, Staged"}</text>
    ${cityState ? `<text x="${CANVAS_W / 2}" y="${QR_BOTTOM + 94}" font-family="Arial, sans-serif" font-size="24" font-weight="400" fill="#4a4540" text-anchor="middle">${escSVG(cityState)}</text>` : ""}

    <line x1="80" y1="${QR_BOTTOM + 118}" x2="${CANVAS_W - 80}" y2="${QR_BOTTOM + 118}" stroke="#b8975a" stroke-width="1.5"/>

    <text x="${CANVAS_W / 2}" y="${QR_BOTTOM + 150}" font-family="Arial, sans-serif" font-size="13" font-weight="700" fill="#b8975a" text-anchor="middle" letter-spacing="0.10em">SMART STAGE PRO</text>
    <text x="${CANVAS_W / 2}" y="${QR_BOTTOM + 178}" font-family="Arial, sans-serif" font-size="16" font-weight="400" fill="#2a2520" text-anchor="middle">Scan to see the before &amp; after</text>

    <rect y="${CANVAS_H - 8}" width="${CANVAS_W}" height="8" fill="#b8975a"/>
  </svg>`;
}

exports.handler = async (event) => {
  const headers = {
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Headers": "Content-Type",
    "Content-Type": "application/json",
  };

  if (event.httpMethod === "OPTIONS") return { statusCode: 200, headers, body: "" };
  if (event.httpMethod !== "POST") {
    return { statusCode: 405, headers, body: JSON.stringify({ error: "POST only" }) };
  }

  try {
    const { slug, address, siteUrl, finalKey, originalKey } = JSON.parse(event.body || "{}");
    if (!slug) {
      return { statusCode: 400, headers, body: JSON.stringify({ error: "Missing slug" }) };
    }

    // FIX (Sep 8, 2026): store the exact S3 keys here, at write time, when
    // the caller already knows them precisely from the upload that just
    // succeeded — rather than having prospect-page.js try to rediscover
    // them later via ListObjectsV2Command, which needs a bucket-level
    // s3:ListBucket permission nothing else in this app ever needed (and
    // very likely doesn't have — see prospect-page.js's header comment for
    // the live bug this caused).
    const meta = {
      address: address || "",
      createdAt: new Date().toISOString(),
      finalKey: finalKey || null,
      originalKey: originalKey || null,
    };

    const prospectUrl = `${siteUrl || process.env.URL || "https://smartstagepro.com"}/prospect/${slug}`;

    const qrBuffer = await QRCode.toBuffer(prospectUrl, {
      type: "png",
      width: QR_PX,
      margin: 1,
      color: { dark: "#1a1714", light: "#ffffff" },
      errorCorrectionLevel: "H",
    });

    const canvasBuffer = Buffer.from(buildCanvasSVG(address));

    const qrPng = await sharp({
      create: { width: CANVAS_W, height: CANVAS_H, channels: 4, background: { r: 245, g: 240, b: 232, alpha: 1 } }
    })
      .composite([
        { input: canvasBuffer, top: 0, left: 0 },
        { input: qrBuffer, top: QR_TOP, left: QR_LEFT },
      ])
      .png({ compressionLevel: 6 })
      .toBuffer();

    await Promise.all([
      s3.send(new PutObjectCommand({
        Bucket: process.env.S3_BUCKET_NAME,
        Key: `staging-prospects/${slug}/meta.json`,
        Body: JSON.stringify(meta, null, 2),
        ContentType: "application/json",
      })),
      s3.send(new PutObjectCommand({
        Bucket: process.env.S3_BUCKET_NAME,
        Key: `staging-prospects/${slug}/qr.png`,
        Body: qrPng,
        ContentType: "image/png",
      })),
    ]);

    return { statusCode: 200, headers, body: JSON.stringify({ ok: true, prospectUrl }) };
  } catch (err) {
    console.error("write-prospect-meta error:", err.message);
    return { statusCode: 500, headers, body: JSON.stringify({ error: err.message }) };
  }
};
