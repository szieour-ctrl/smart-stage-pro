// ab723-composite.js — Netlify Function
// AB 723 §10140.8 Compliance — Step 2
// Takes the staged image + original public URL
// Generates QR code pointing to the original
// Composites disclosure bar + QR onto the staged image
// Returns a single fully AB 723-compliant image ready for MLS upload
//
// Input:
//   stagedBase64  — the staged (or cleaned/upscaled) image
//   mimeType      — image mime type
//   originalUrl   — Cloudinary permanent URL of the original (from upload-original.js)
//   roomName      — e.g. "Kitchen + Great Room"
//   tier          — 'draft' | 'final' | 'declutter' | 'cns'
//
// Output:
//   compliantBase64 — JPEG base64 of the fully composited compliant image
//   originalUrl     — echoed back for reference
//
// AB 723 Requirements satisfied:
//   ✅ "reasonably conspicuous" disclosure statement on the image
//   ✅ QR code linking to "publicly accessible internet website"
//   ✅ Statement includes language that unaltered image is accessible via QR/URL
//   ✅ Smart Stage PRO™ branding preserved

const sharp  = require("sharp");
const QRCode = require("qrcode");

// ── LAYOUT CONSTANTS ─────────────────────────────────────────────────────────
const FOOTER_H   = 120;   // px — disclosure bar height (increased to fit QR in footer)
const QR_SIZE    = 100;   // px — QR in footer bar (scannable at this size in footer)
const QR_MARGIN  = 10;    // px — QR margin from footer edge
const FONT_COLOR_GOLD  = { r: 184, g: 151, b: 90,  alpha: 1 };
const FONT_COLOR_MUTED = { r: 122, g: 111, b: 99,  alpha: 1 };
const FOOTER_BG        = { r: 26,  g: 23,  b: 20,  alpha: 1 };

// ── QR CODE GENERATION ───────────────────────────────────────────────────────
async function generateQRBuffer(url, size) {
  const cleanUrl = String(url || "").trim().replace(/\s+/g, "");
  const qrPng = await QRCode.toBuffer(cleanUrl, {
    type: "png",
    width: size,
    margin: 1,
    color: {
      dark: "#000000",   // black modules — maximum contrast for scanning
      light: "#FFFFFF",  // white background
    },
    errorCorrectionLevel: "H",  // 30% error recovery — most reliable for printed/screen QR
  });
  return qrPng;
}

// ── TEXT SVG OVERLAY ─────────────────────────────────────────────────────────
function buildFooterSVG(width, footerH, roomName, originalUrl, tier, complianceUrl) {
  const tierLabel =
    tier === "final"    ? "VIRTUALLY STAGED — FINAL" :
    tier === "declutter"? "DECLUTTERED — OBJECTS REMOVED" :
    tier === "cns"      ? "CLEANED + STAGED" :
    "VIRTUALLY STAGED";

  // Reserve right side for QR — text only fills the left portion
  const textWidth = width - QR_SIZE - QR_MARGIN * 3;

  const displayUrl = complianceUrl || originalUrl;
  let shortUrl = displayUrl;
  try {
    const u = new URL(displayUrl);
    shortUrl = u.hostname + u.pathname.slice(0, 50) + (u.pathname.length > 50 ? "…" : "");
  } catch(e) {}

  const textAreaW = width - QR_SIZE - QR_MARGIN * 3 - 16;
  return `<svg width="${width}" height="${footerH}" xmlns="http://www.w3.org/2000/svg">
    <rect width="${width}" height="${footerH}" fill="#1a1714"/>
    <!-- Left divider for QR zone -->
    <line x1="${width - QR_SIZE - QR_MARGIN * 2}" y1="8" x2="${width - QR_SIZE - QR_MARGIN * 2}" y2="${footerH - 8}" stroke="#2d2824" stroke-width="1"/>
    <!-- Text content -->
    <text x="16" y="24" font-family="Arial, sans-serif" font-size="13" font-weight="500" fill="#b8975a">
      Smart Stage PRO™  |  ${escSVG(tierLabel)}  |  ${escSVG(roomName)}
    </text>
    <text x="16" y="46" font-family="Arial, sans-serif" font-size="11" font-weight="400" fill="#9a8f83">
      Virtually staged image — digitally altered per California AB 723 §10140.8.
    </text>
    <text x="16" y="64" font-family="Arial, sans-serif" font-size="11" font-weight="400" fill="#9a8f83">
      Original unaltered image available — scan QR code or visit compliance URL.
    </text>
    <text x="16" y="84" font-family="Arial, sans-serif" font-size="10" font-weight="400" fill="#7a6f66">
      AB 723 Compliance: ${escSVG(shortUrl)}
    </text>
    <text x="16" y="100" font-family="Arial, sans-serif" font-size="10" font-weight="400" fill="#5a5048">
      MetroList Rule 11.6.1 compliant · Smart Stage PRO™ · smartstagepro.com
    </text>
    <!-- QR label -->
    <text x="${width - QR_SIZE/2 - QR_MARGIN}" y="${footerH - 6}" font-family="Arial, sans-serif" font-size="9" font-weight="400" fill="#5a5048" text-anchor="middle">
      SCAN FOR ORIGINAL
    </text>
  </svg>`;
}

function escSVG(str) {
  return String(str || "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

// ── STAGED IMAGE BADGE ───────────────────────────────────────────────────────
function buildBadgeSVG(width, imageH, tier) {
  const label =
    tier === "final"     ? "VIRTUALLY STAGED — FINAL" :
    tier === "declutter" ? "DECLUTTERED — OBJECTS REMOVED" :
    tier === "cns"       ? "CLEANED + STAGED" :
    "VIRTUALLY STAGED · DRAFT";

  const bgColor =
    tier === "final"     ? "rgba(45,106,79,0.92)" :
    tier === "declutter" ? "rgba(124,92,62,0.92)" :
    tier === "cns"       ? "rgba(74,103,65,0.92)" :
    "rgba(184,151,90,0.92)";

  const badgeW = Math.min(label.length * 10 + 40, 600);

  return `<svg width="${width}" height="${imageH}" xmlns="http://www.w3.org/2000/svg">
    <rect x="16" y="16" width="${badgeW}" height="44" rx="4" fill="${bgColor}"/>
    <text x="24" y="45" font-family="Arial, sans-serif" font-size="22" font-weight="600" fill="#ffffff" letter-spacing="0.05em">
      ${escSVG(label)}
    </text>
  </svg>`;
}

// ── MAIN COMPOSITE ───────────────────────────────────────────────────────────
async function buildCompliantImage(stagedBase64, originalUrl, roomName, tier, complianceUrl) {
  const qrTarget = complianceUrl || originalUrl;
  const imageBuffer = Buffer.from(stagedBase64, "base64");

  const meta = await sharp(imageBuffer).metadata();
  const W = meta.width;
  const H = meta.height;

  // 1. Generate QR at new larger size
  const qrBuffer = await generateQRBuffer(qrTarget, QR_SIZE);

  // 2. Build footer SVG
  const footerSvg = buildFooterSVG(W, FOOTER_H, roomName, originalUrl, tier, complianceUrl);
  const footerBuffer = Buffer.from(footerSvg);

  // 3. Build badge SVG
  const badgeSvg = buildBadgeSVG(W, H, tier);
  const badgeBuffer = Buffer.from(badgeSvg);

  // 4. QR goes in the footer bar (right side) — never cropped, always scannable
  const qrPad = 10;
  const totalH = H + FOOTER_H;

  // QR position: right side of footer bar, vertically centered
  const qrLeft = W - QR_SIZE - QR_MARGIN;
  const qrTop  = H + (FOOTER_H - QR_SIZE) / 2;

  const result = await sharp({
    create: {
      width: W,
      height: totalH,
      channels: 3,
      background: FOOTER_BG,
    }
  })
  .composite([
    { input: imageBuffer,  top: 0,        left: 0 },
    { input: badgeBuffer,  top: 0,        left: 0 },
    { input: footerBuffer, top: H,        left: 0 },
    { input: qrBuffer,     top: Math.round(qrTop), left: Math.round(qrLeft) },
  ])
  .jpeg({ quality: 93, progressive: true })
  .toBuffer();

  return result.toString("base64");
}

// ── HANDLER ──────────────────────────────────────────────────────────────────
exports.handler = async (event) => {
  if (event.httpMethod !== "POST") return { statusCode: 405, body: "Method Not Allowed" };

  const headers = {
    "Access-Control-Allow-Origin":  "*",
    "Access-Control-Allow-Headers": "Content-Type",
    "Content-Type": "application/json",
  };

  try {
    const {
      stagedBase64,
      mimeType,
      originalUrl,
      complianceUrl,
      roomName,
      tier,
    } = JSON.parse(event.body || "{}");

    if (!stagedBase64) return {
      statusCode: 400, headers,
      body: JSON.stringify({ error: "Missing stagedBase64" })
    };
    if (!originalUrl) return {
      statusCode: 400, headers,
      body: JSON.stringify({ error: "Missing originalUrl — upload original first via upload-original" })
    };

    console.log(`AB723 composite: room=${roomName} tier=${tier} url=${originalUrl.slice(0, 60)}`);

    const compliantBase64 = await buildCompliantImage(
      stagedBase64,
      originalUrl,
      roomName || "Room",
      tier || "draft",
      complianceUrl || null
    );

    console.log(`AB723 composite complete: ${Math.round(compliantBase64.length / 1024)}KB`);

    return {
      statusCode: 200,
      headers,
      body: JSON.stringify({
        compliantBase64,
        originalUrl,
      }),
    };

  } catch (err) {
    console.error("ab723-composite error:", err.message);
    return {
      statusCode: 500, headers,
      body: JSON.stringify({ error: err.message })
    };
  }
};
