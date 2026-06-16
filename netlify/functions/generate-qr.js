// generate-qr.js — Netlify Function
// Generates a standalone branded marketing QR code PNG
// Suitable for print (300dpi), flyers, email, social media
//
// Input:  { projectId, address, complianceUrl } via query params or POST body
// Output: PNG image — branded QR code with address and call-to-action
//
// QR target: compliance page URL (same as embedded in staged images)
// Size: 600x720px — print-ready at 300dpi = 2x2 inch QR + branding strip

const QRCode = require("qrcode");
const sharp  = require("sharp");

const QR_PX      = 460;   // QR code pixel size
const CANVAS_W   = 600;
const CANVAS_H   = 820;
const PADDING    = 70;
const BRAND_H    = 240;   // Height of branding strip below QR

function escSVG(str) {
  return String(str || "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function truncateAddress(address, maxLen = 45) {
  if (!address || address.length <= maxLen) return address || "";
  // Try to break at a comma
  const comma = address.lastIndexOf(",", maxLen);
  if (comma > 20) return address.slice(0, comma);
  return address.slice(0, maxLen) + "…";
}

function truncateUrl(url, maxLen = 52) {
  if (!url || url.length <= maxLen) return url || "";
  return url.slice(0, maxLen) + "…";
}

function buildCanvasSVG(address, agentName, agentBrokerage, complianceUrl) {
  const line1 = truncateAddress(address, 42);
  // Split address into two lines if long
  const parts = address ? address.split(",") : [];
  const addrLine1 = parts[0] || line1;
  const addrLine2 = parts.slice(1).join(",").trim();

  return `<svg width="${CANVAS_W}" height="${CANVAS_H}" xmlns="http://www.w3.org/2000/svg">
    <!-- Background -->
    <rect width="${CANVAS_W}" height="${CANVAS_H}" fill="#1a1714" rx="12"/>

    <!-- Inner white card for QR -->
    <rect x="${PADDING - 10}" y="${PADDING - 10}" width="${QR_PX + 20}" height="${QR_PX + 20}"
      fill="#ffffff" rx="8"/>

    <!-- Scan instruction above QR -->
    <text x="${CANVAS_W / 2}" y="${PADDING - 20}"
      font-family="Arial, sans-serif" font-size="13" font-weight="400"
      fill="#7a6f63" text-anchor="middle" letter-spacing="0.08em">
      SCAN TO VIEW ORIGINAL + STAGED PHOTOS
    </text>

    <!-- Property address line 1 -->
    <text x="${CANVAS_W / 2}" y="${PADDING + QR_PX + 50}"
      font-family="Arial, sans-serif" font-size="22" font-weight="500"
      fill="#ffffff" text-anchor="middle">
      ${escSVG(addrLine1)}
    </text>

    <!-- Property address line 2 (city, state) -->
    ${addrLine2 ? `<text x="${CANVAS_W / 2}" y="${PADDING + QR_PX + 80}"
      font-family="Arial, sans-serif" font-size="18" font-weight="400"
      fill="#9a8f83" text-anchor="middle">
      ${escSVG(addrLine2)}
    </text>` : ""}

    <!-- Divider -->
    <line x1="${PADDING}" y1="${PADDING + QR_PX + 105}"
      x2="${CANVAS_W - PADDING}" y2="${PADDING + QR_PX + 105}"
      stroke="#2d2824" stroke-width="1"/>

    <!-- AB 723 compliance note -->
    <text x="${CANVAS_W / 2}" y="${PADDING + QR_PX + 128}"
      font-family="Arial, sans-serif" font-size="11" font-weight="400"
      fill="#5a5048" text-anchor="middle" letter-spacing="0.04em">
      California AB 723 §10140.8 Virtual Staging Disclosure
    </text>

    <!-- MLS disclosure text line 1 -->
    <text x="${CANVAS_W / 2}" y="${PADDING + QR_PX + 152}"
      font-family="Arial, sans-serif" font-size="10" font-weight="400"
      fill="#7a6f63" text-anchor="middle">
      One or more photos have been virtually staged using AI-assisted technology.
    </text>

    <!-- MLS disclosure text line 2 -->
    <text x="${CANVAS_W / 2}" y="${PADDING + QR_PX + 168}"
      font-family="Arial, sans-serif" font-size="10" font-weight="400"
      fill="#7a6f63" text-anchor="middle">
      Staged images do not represent the current condition of the property.
    </text>

    <!-- Compliance URL in gold -->
    <text x="${CANVAS_W / 2}" y="${PADDING + QR_PX + 190}"
      font-family="Arial, sans-serif" font-size="10" font-weight="500"
      fill="#b8975a" text-anchor="middle" letter-spacing="0.02em">
      ${escSVG(truncateUrl(complianceUrl))}
    </text>

    <!-- Divider 2 -->
    <line x1="${PADDING}" y1="${PADDING + QR_PX + 205}"
      x2="${CANVAS_W - PADDING}" y2="${PADDING + QR_PX + 205}"
      stroke="#2d2824" stroke-width="1"/>

    <!-- Agent name -->
    ${agentName ? `<text x="${CANVAS_W / 2}" y="${PADDING + QR_PX + 225}"
      font-family="Arial, sans-serif" font-size="12" font-weight="500"
      fill="#b8975a" text-anchor="middle">
      ${escSVG(agentName)}${agentBrokerage ? "  ·  " + escSVG(agentBrokerage) : ""}
    </text>` : ""}

    <!-- Smart Stage brand -->
    <text x="${CANVAS_W / 2}" y="${CANVAS_H - 20}"
      font-family="Arial, sans-serif" font-size="10" font-weight="400"
      fill="#3a3028" text-anchor="middle" letter-spacing="0.06em">
      SMART STAGE PRO™
    </text>
  </svg>`;
}

exports.handler = async (event) => {
  const headers = {
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Headers": "Content-Type",
  };

  if (event.httpMethod === "OPTIONS") return { statusCode: 200, headers, body: "" };

  try {
    // Accept both GET (query params) and POST (body)
    let complianceUrl, address, projectId;

    if (event.httpMethod === "GET") {
      complianceUrl = event.queryStringParameters?.complianceUrl;
      address       = event.queryStringParameters?.address || "";
      projectId     = event.queryStringParameters?.projectId || "";
    } else {
      const body = JSON.parse(event.body || "{}");
      complianceUrl = body.complianceUrl;
      address       = body.address || "";
      projectId     = body.projectId || "";
    }

    if (!complianceUrl) return {
      statusCode: 400,
      headers: { ...headers, "Content-Type": "application/json" },
      body: JSON.stringify({ error: "Missing complianceUrl" })
    };

    const agentName      = process.env.AGENT_NAME      || "Smart Stage PRO™";
    const agentBrokerage = process.env.AGENT_BROKERAGE || "";

    // Generate high-resolution QR code
    const cleanUrl = String(complianceUrl).trim();
    const qrBuffer = await QRCode.toBuffer(cleanUrl, {
      type: "png",
      width: QR_PX,
      margin: 2,
      color: {
        dark: "#1a1714",   // Dark modules — matches brand
        light: "#ffffff",  // White background
      },
      errorCorrectionLevel: "H",  // 30% recovery — required for print use
    });

    // Build canvas SVG for branding layer
    const canvasSvg = buildCanvasSVG(address, agentName, agentBrokerage, cleanUrl);
    const canvasBuffer = Buffer.from(canvasSvg);

    // Composite: dark background + branding SVG, then place QR in the white card zone
    const finalPng = await sharp({
      create: {
        width: CANVAS_W,
        height: CANVAS_H,
        channels: 4,
        background: { r: 26, g: 23, b: 20, alpha: 1 },
      }
    })
    .composite([
      { input: canvasBuffer, top: 0, left: 0 },   // Branding SVG
      { input: qrBuffer,     top: PADDING, left: PADDING },  // QR code in white card
    ])
    .png({ compressionLevel: 6 })
    .toBuffer();

    // Filename for download
    const addrSlug = address
      .replace(/[^a-z0-9\s]/gi, "")
      .replace(/\s+/g, "_")
      .slice(0, 40);
    const filename = `SmartStage_QR_${addrSlug || projectId || "compliance"}.png`;

    return {
      statusCode: 200,
      headers: {
        ...headers,
        "Content-Type": "image/png",
        "Content-Disposition": `attachment; filename="${filename}"`,
        "Cache-Control": "no-cache",
      },
      body: finalPng.toString("base64"),
      isBase64Encoded: true,
    };

  } catch (err) {
    console.error("generate-qr error:", err.message);
    return {
      statusCode: 500,
      headers: { ...headers, "Content-Type": "application/json" },
      body: JSON.stringify({ error: err.message })
    };
  }
};
