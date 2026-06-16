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

const QR_PX    = 480;   // QR code pixel size
const CANVAS_W = 900;   // Square canvas — MLS + marketing safe
const CANVAS_H = 900;
const QR_LEFT  = (900 - 480) / 2;   // 210 — centered
const QR_TOP   = 60;

function escSVG(str) {
  return String(str || "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function splitAddress(address) {
  const parts = (address || "").split(",");
  const street = (parts[0] || "").trim();
  const cityState = parts.slice(1).join(",").replace(/,?\s*USA\s*$/i, "").trim();
  return { street, cityState };
}

function buildCanvasSVG(address, agentName, agentBrokerage, complianceUrl) {
  const { street, cityState } = splitAddress(address);
  const QR_BOTTOM = QR_TOP + QR_PX;  // 540

  return `<svg width="${CANVAS_W}" height="${CANVAS_H}" xmlns="http://www.w3.org/2000/svg">

    <!-- Cream background -->
    <rect width="${CANVAS_W}" height="${CANVAS_H}" fill="#f5f0e8"/>

    <!-- Gold top bar -->
    <rect width="${CANVAS_W}" height="8" fill="#b8975a"/>

    <!-- QR white card with shadow effect -->
    <rect x="${QR_LEFT - 16}" y="${QR_TOP - 16}" width="${QR_PX + 32}" height="${QR_PX + 32}"
      fill="#e8e0d0" rx="10"/>
    <rect x="${QR_LEFT - 12}" y="${QR_TOP - 12}" width="${QR_PX + 24}" height="${QR_PX + 24}"
      fill="#ffffff" rx="8"/>

    <!-- Property address -->
    <text x="${CANVAS_W / 2}" y="${QR_BOTTOM + 60}"
      font-family="Arial, sans-serif" font-size="36" font-weight="700"
      fill="#1a1714" text-anchor="middle">
      ${escSVG(street)}
    </text>

    ${cityState ? `<text x="${CANVAS_W / 2}" y="${QR_BOTTOM + 100}"
      font-family="Arial, sans-serif" font-size="26" font-weight="400"
      fill="#4a4540" text-anchor="middle">
      ${escSVG(cityState)}
    </text>` : ""}

    <!-- Gold divider -->
    <line x1="80" y1="${QR_BOTTOM + 126}" x2="${CANVAS_W - 80}" y2="${QR_BOTTOM + 126}"
      stroke="#b8975a" stroke-width="1.5"/>

    <!-- Disclosure label -->
    <text x="${CANVAS_W / 2}" y="${QR_BOTTOM + 155}"
      font-family="Arial, sans-serif" font-size="13" font-weight="700"
      fill="#b8975a" text-anchor="middle" letter-spacing="0.10em">
      AB 723 VIRTUAL STAGING DISCLOSURE
    </text>

    <!-- Disclosure text line 1 -->
    <text x="${CANVAS_W / 2}" y="${QR_BOTTOM + 182}"
      font-family="Arial, sans-serif" font-size="15" font-weight="400"
      fill="#2a2520" text-anchor="middle">
      One or more photos in this listing have been virtually staged
    </text>

    <!-- Disclosure text line 2 -->
    <text x="${CANVAS_W / 2}" y="${QR_BOTTOM + 203}"
      font-family="Arial, sans-serif" font-size="15" font-weight="400"
      fill="#2a2520" text-anchor="middle">
      using AI-assisted technology. Staged images do not represent
    </text>

    <!-- Disclosure text line 3 -->
    <text x="${CANVAS_W / 2}" y="${QR_BOTTOM + 224}"
      font-family="Arial, sans-serif" font-size="15" font-weight="400"
      fill="#2a2520" text-anchor="middle">
      the current condition of the property.
    </text>

    <!-- Compliance URL -->
    <text x="${CANVAS_W / 2}" y="${QR_BOTTOM + 254}"
      font-family="Arial, sans-serif" font-size="14" font-weight="600"
      fill="#b8975a" text-anchor="middle" letter-spacing="0.01em">
      ${escSVG(complianceUrl || "")}
    </text>

    <!-- Agent line -->
    ${agentName ? `<text x="${CANVAS_W / 2}" y="${CANVAS_H - 28}"
      font-family="Arial, sans-serif" font-size="13" font-weight="500"
      fill="#7a6f63" text-anchor="middle">
      ${escSVG(agentName)}${agentBrokerage ? "  ·  " + escSVG(agentBrokerage) : ""}
    </text>` : ""}

    <!-- Gold bottom bar -->
    <rect y="${CANVAS_H - 8}" width="${CANVAS_W}" height="8" fill="#b8975a"/>

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

    const agentName      = process.env.AGENT_NAME      || "";
    const agentBrokerage = process.env.AGENT_BROKERAGE || "";

    // Generate high-resolution QR code
    const cleanUrl = String(complianceUrl).trim();
    const qrBuffer = await QRCode.toBuffer(cleanUrl, {
      type: "png",
      width: QR_PX,
      margin: 1,
      color: {
        dark: "#1a1714",
        light: "#ffffff",
      },
      errorCorrectionLevel: "H",
    });

    // Build canvas SVG for branding layer
    const canvasSvg = buildCanvasSVG(address, agentName, agentBrokerage, cleanUrl);
    const canvasBuffer = Buffer.from(canvasSvg);

    // Composite: cream background SVG + QR centered in white card
    const finalPng = await sharp({
      create: {
        width:    CANVAS_W,
        height:   CANVAS_H,
        channels: 4,
        background: { r: 245, g: 240, b: 232, alpha: 1 },
      }
    })
    .composite([
      { input: canvasBuffer, top: 0,      left: 0        },
      { input: qrBuffer,     top: QR_TOP, left: QR_LEFT  },
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
