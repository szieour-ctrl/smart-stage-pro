// write-prospect-meta.js — Netlify Function
// NEW (Sep 8, 2026): writes staging-prospects/{slug}/meta.json AND
// staging-prospects/{slug}/qr.png directly to S3 — everything a prospecting
// shot needs beyond the images themselves, all living INSIDE the same S3
// folder as the images (see the screenshot that prompted this: Sam's
// staging-prospects/ bucket view, one folder per address). No Supabase
// write, no Netlify Blobs project record from THIS file — a Supabase row
// for the prospecting project does exist (created earlier in the flow —
// see marketing-manage.js), but this function and prospect-page.js never
// read from or write to it. The S3 folder is the single source of truth
// for everything a prospecting page needs to render.
//
// CORRECTION (Sep 16, 2026 — pipeline separation): this comment
// previously said the load-bearing Supabase row lived in the `listings`
// table, load-bearing for upload-original.js/upload-staged.js's slug +
// isProspecting resolution. That was accurate on Sep 8 but is no longer
// true — Prospecting now has its own standalone `prospects` table, own
// Blobs store, and own function (marketing-manage.js), fully separate
// from Listings; a prospecting project never creates a `listings` row at
// all anymore, and slug resolution for uploads now goes through
// upload-original.js/upload-staged.js's lookupProspectSlug() against
// `prospects` instead. This file's own behavior is unaffected either way
// — it has never queried any Supabase table, and the `slug` this file
// operates on comes straight from the S3 key the frontend already parsed,
// same as before. Correction is purely so the comment doesn't point a
// future debugging session at the wrong table.
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
// Input:  POST { slug, address, siteUrl, finalKey, originalKey, roomName? }
// Output: { ok: true }
//
// CHANGE (Sep 24, 2026 — Sam's spec update): the prospect page now shows
// EVERY staged image for the address, like a normal compliance page (Sam
// sends prospects an interior and an exterior before/after). The old spec
// was "the page will only have 1 staged image," and this file used to
// overwrite meta.json with just the latest final. Now meta.json carries a
// `pairs` array, and each Generate Final adds to it instead of replacing it:
//   - Re-staging the SAME original replaces that original's pair (latest
//     final wins), so retries don't stack duplicates on the page.
//   - A different original is appended, in the order it was staged.
//   - finalKey/originalKey at the top level are still written (latest
//     pair) so nothing that reads the old shape breaks.
//   - Old meta.json files with only finalKey/originalKey are converted
//     into a one-item `pairs` array the first time they're updated.
// The read-modify-write uses S3 conditional writes (If-Match on the ETag
// we read, If-None-Match for a brand-new file), retried on conflict, so
// two Generate Finals finishing at the same moment can't drop a pair —
// the same CAS pattern addImage() uses for Blobs.
// qr.png is still regenerated on every call (same URL, so same QR).
//
// NEW (Sep 24, 2026 — Sam's GPT handoff): also writes
// staging-prospects/{slug}/prospect-links.txt on every call — a plain-text
// list of the prospect page URL, the QR code URL, and every before/after
// image URL labeled by room. Sam drops this file into his custom GPT
// together with the MLS PDF instead of copy-pasting each URL out of the S3
// console. The URLs use the exact same public S3 URL format as the "Object
// URL" he was copying by hand (same format upload-staged.js returns).
// Rebuilt from meta.json's pairs each time, so it always matches the
// prospect page. Plain .txt rather than .docx: the GPT reads it the same,
// and it opens in Notepad and previews in the S3 console.

const { S3Client, PutObjectCommand, GetObjectCommand } = require("@aws-sdk/client-s3");
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


async function readMetaWithEtag(slug) {
  try {
    const res = await s3.send(new GetObjectCommand({
      Bucket: process.env.S3_BUCKET_NAME,
      Key: `staging-prospects/${slug}/meta.json`,
    }));
    const chunks = [];
    for await (const chunk of res.Body) chunks.push(chunk);
    return { meta: JSON.parse(Buffer.concat(chunks).toString("utf-8")), etag: res.ETag };
  } catch (err) {
    if (err.name === "NoSuchKey" || err.$metadata?.httpStatusCode === 404) return { meta: null, etag: null };
    throw err;
  }
}

// Old single-image meta.json → pairs array.
function existingPairs(meta) {
  if (!meta) return [];
  if (Array.isArray(meta.pairs)) return meta.pairs.filter(p => p && p.finalKey);
  if (meta.finalKey) return [{ finalKey: meta.finalKey, originalKey: meta.originalKey || null, roomName: null, stagedAt: meta.createdAt || null }];
  return [];
}

function mergePair(pairs, pair) {
  const out = pairs.slice();
  const i = out.findIndex(p =>
    (pair.originalKey && p.originalKey === pair.originalKey) || p.finalKey === pair.finalKey);
  if (i >= 0) out[i] = { ...pair, roomName: pair.roomName || out[i].roomName || null };
  else out.push(pair);
  return out;
}

async function writeMetaMerged(slug, address, pair) {
  for (let attempt = 1; attempt <= 4; attempt++) {
    const { meta, etag } = await readMetaWithEtag(slug);
    const pairs = pair.finalKey ? mergePair(existingPairs(meta), pair) : existingPairs(meta);
    const latest = pairs[pairs.length - 1] || {};
    const next = {
      address: address || meta?.address || "",
      createdAt: meta?.createdAt || new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      finalKey: pair.finalKey || latest.finalKey || null,
      originalKey: pair.finalKey ? (pair.originalKey || null) : (latest.originalKey || null),
      pairs,
    };
    try {
      await s3.send(new PutObjectCommand({
        Bucket: process.env.S3_BUCKET_NAME,
        Key: `staging-prospects/${slug}/meta.json`,
        Body: JSON.stringify(next, null, 2),
        ContentType: "application/json",
        ...(etag ? { IfMatch: etag } : { IfNoneMatch: "*" }),
      }));
      return next;
    } catch (err) {
      const code = err.$metadata?.httpStatusCode;
      if ((code === 412 || code === 409) && attempt < 4) {
        await new Promise(r => setTimeout(r, 150 * attempt));
        continue;
      }
      throw err;
    }
  }
}


function s3PublicUrl(key) {
  if (!key) return null;
  return `https://${process.env.S3_BUCKET_NAME}.s3.${process.env.S3_REGION}.amazonaws.com/${key}`;
}

function buildLinksText({ address, prospectUrl, slug, pairs }) {
  const lines = [
    "SMART STAGE PRO — PROSPECT LINKS",
    `Address: ${address || "(no address recorded)"}`,
    `Last updated: ${new Date().toISOString().slice(0, 10)}`,
    "",
    `Prospect page: ${prospectUrl}`,
    `QR code: ${s3PublicUrl(`staging-prospects/${slug}/qr.png`)}`,
  ];
  pairs.forEach((p, i) => {
    lines.push("", `${i + 1}. ${p.roomName || `Photo ${i + 1}`}`);
    lines.push(`Before: ${s3PublicUrl(p.originalKey) || "(no original recorded)"}`);
    lines.push(`After: ${s3PublicUrl(p.finalKey)}`);
  });
  return lines.join("\r\n") + "\r\n"; // CRLF so it displays correctly in Windows Notepad
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
    const { slug, address, siteUrl, finalKey, originalKey, roomName } = JSON.parse(event.body || "{}");
    if (!slug) {
      return { statusCode: 400, headers, body: JSON.stringify({ error: "Missing slug" }) };
    }

    // Exact S3 keys come from the caller, who knows them precisely from the
    // upload that just succeeded (Sep 8 fix — prospect-page.js never lists
    // the bucket). Merged into meta.json's pairs array — see header.
    const meta = await writeMetaMerged(slug, address, {
      finalKey: finalKey || null,
      originalKey: originalKey || null,
      roomName: roomName ? String(roomName).slice(0, 80) : null,
      stagedAt: new Date().toISOString(),
    });

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
        Key: `staging-prospects/${slug}/qr.png`,
        Body: qrPng,
        ContentType: "image/png",
      })),
      s3.send(new PutObjectCommand({
        Bucket: process.env.S3_BUCKET_NAME,
        Key: `staging-prospects/${slug}/prospect-links.txt`,
        Body: buildLinksText({ address: meta.address, prospectUrl, slug, pairs: meta.pairs }),
        ContentType: "text/plain; charset=utf-8",
      })),
    ]);

    return { statusCode: 200, headers, body: JSON.stringify({ ok: true, prospectUrl, imageCount: meta.pairs.length }) };
  } catch (err) {
    console.error("write-prospect-meta error:", err.message);
    return { statusCode: 500, headers, body: JSON.stringify({ error: err.message }) };
  }
};
