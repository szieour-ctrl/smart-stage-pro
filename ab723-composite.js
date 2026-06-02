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
//   ✅ Smart Stage AI™ branding preserved

const sharp  = require("sharp");
const QRCode = require("qrcode");

// ── LAYOUT CONSTANTS ─────────────────────────────────────────────────────────
const FOOTER_H   = 72;    // px — slimmer disclosure bar (text only, no QR)
const QR_SIZE    = 200;   // px — larger QR overlaid directly on image corner
const QR_MARGIN  = 20;    // px — QR margin from image edge
const FONT_COLOR_GOLD  = { r: 184, g: 151, b: 90,  alpha: 1 };
const FONT_COLOR_MUTED = { r: 122, g: 111, b: 99,  alpha: 1 };
const FOOTER_BG        = { r: 26,  g: 23,  b: 20,  alpha: 1 };

// ── QR CODE GENERATION ───────────────────────────────────────────────────────
async function generateQRBuffer(url, size) {
  // Returns a PNG buffer of the QR code at specified size
  // Clean the URL to ensure reliable encoding
  const cleanUrl = String(url || "").trim().replace(/\s+/g, "");
  const qrPng = await QRCode.toBuffer(cleanUrl, {
    type: "png",
    width: size,
    margin: 1,
    color: {
      dark: "#FFFFFF",   // white modules on dark background — inverted for dark footer
      light: "#1a1714",  // matches footer background color
    },
    errorCorrectionLevel: "H",  // 30% error recovery — most reliable for printed/screen QR
  });
  return qrPng;
}

// ── TEXT SVG OVERLAY ─────────────────────────────────────────────────────────
// sharp doesn't have a native text renderer — we build SVG text overlays
// and composite them onto the image

function buildFooterSVG(width, footerH, roomName, originalUrl, tier, complianceUrl) {
  const tierLabel =
    tier === "final"    ? "VIRTUALLY STAGED — FINAL" :
    tier === "declutter"? "DECLUTTERED — OBJECTS REMOVED" :
    tier === "cns"      ? "CLEANED + STAGED" :
    "VIRTUALLY STAGED";

  // Truncate URL for display — show hostname + path prefix only
  const displayUrl = complianceUrl || originalUrl;
  let shortUrl = displayUrl;
  try {
    const u = new URL(displayUrl);
    shortUrl = u.hostname + u.pathname.slice(0, 50) + (u.pathname.length > 50 ? "…" : "");
  } catch(e) {}

  return `<svg width="${width}" height="${footerH}" xmlns="http://www.w3.org/2000/svg">
    <!-- Footer background -->
    <rect width="${width}" height="${footerH}" fill="#1a1714"/>

    <!-- Line 1: Brand + tier + room -->
    <text x="16" y="22" font-family="Arial, sans-serif" font-size="13" font-weight="500" fill="#b8975a">
      Smart Stage PRO™  |  SZREG  |  ${escSVG(tierLabel)}  |  ${escSVG(roomName)}
    </text>

    <!-- Line 2: AB 723 disclosure statement -->
    <text x="16" y="42" font-family="Arial, sans-serif" font-size="11" font-weight="400" fill="#9a8f83">
      Virtually staged image — digitally altered per California AB 723 §10140.8. Scan QR code for original + all staged images.
    </text>

    <!-- Line 3: URL -->
    <text x="16" y="60" font-family="Arial, sans-serif" font-size="10" font-weight="400" fill="#7a6f66">
      AB 723 Compliance: ${escSVG(shortUrl)}
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
    <!-- Top-left staged badge - larger and more prominent -->
    <rect x="16" y="16" width="${badgeW}" height="44" rx="4" fill="${bgColor}"/>
    <text x="24" y="45" font-family="Arial, sans-serif" font-size="22" font-weight="600" fill="#ffffff" letter-spacing="0.05em">
      ${escSVG(label)}
    </text>
  </svg>`;
}

// ── MAIN COMPOSITE ───────────────────────────────────────────────────────────
async function buildCompliantImage(stagedBase64, originalUrl, roomName, tier, complianceUrl) {
  // Use complianceUrl (compliance page) if available, otherwise fall back to originalUrl (Cloudinary)
  const qrTarget = complianceUrl || originalUrl;
  const imageBuffer = Buffer.from(stagedBase64, "base64");

  // Get image dimensions
  const meta = await sharp(imageBuffer).metadata();
  const W = meta.width;
  const H = meta.height;

  // 1. Generate QR code PNG
  const qrBuffer = await generateQRBuffer(qrTarget, QR_SIZE);

  // 2. Build footer SVG
  const footerSvg = buildFooterSVG(W, FOOTER_H, roomName, originalUrl, tier, complianceUrl);
  const footerBuffer = Buffer.from(footerSvg);

  // 3. Build badge SVG (overlaid on staged image)
  const badgeSvg = buildBadgeSVG(W, H, tier);
  const badgeBuffer = Buffer.from(badgeSvg);

  // 4. Composite everything with sharp
  // Layer order:
  //   - staged image (base)
  //   - badge SVG overlay (top-left of image)
  //   - footer bar (below image)
  //   - QR code (bottom-right of footer)

  const totalH = H + FOOTER_H;

  // QR overlaid on bottom-right corner of staged image with dark background pad
  const qrTop  = H - QR_SIZE - QR_MARGIN;
  const qrLeft = W - QR_SIZE - QR_MARGIN;

  const result = await sharp({
    create: {
      width: W,
      height: totalH,
      channels: 3,
      background: FOOTER_BG,
    }
  })
  .composite([
    // Place staged image at top
    { input: imageBuffer,  top: 0, left: 0 },
    // Badge overlay top-left of image
    { input: badgeBuffer,  top: 0, left: 0 },
    // QR code overlaid bottom-right of image (on top of staged image)
    { input: qrBuffer, top: qrTop, left: qrLeft },
    // Footer SVG at bottom
    { input: footerBuffer, top: H, left: 0 },
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
        compliantBase64,   // fully compliant image — ready for MLS upload
        originalUrl,       // echoed for reference
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
