// generate-sbs.js — Netlify Function
// Smart Stage PRO™  |  AB 723 Side-by-Side Compliance Image
// Generates a professional SBS composite — NO agent/brokerage branding (MLS rules)
// Platform branding only: Smart Stage PRO™ + AB 723 compliance info
//
// Input:  POST { originalBase64, stagedBase64, address, roomName, tier, complianceUrl }
// Output: { sbsBase64 } — JPEG base64 of the full SBS compliance image

const sharp  = require("sharp");
const https  = require("https");

// ── LAYOUT ───────────────────────────────────────────────────────────────────
const HEADER_H    = 72;   // dark header bar
const SIDEBAR_W   = 280;  // right compliance sidebar — wider for readable text
const FOOTER_H    = 80;   // bottom disclosure footer — taller for compliance URL
const PANEL_GAP   = 8;    // gap between original and staged panels
const PAD         = 16;   // outer padding
const BADGE_H     = 48;   // address bar height
const NOTICE_H    = 52;   // "THIS IMAGE HAS BEEN VIRTUALLY STAGED" strip

function escSVG(s) {
  return String(s||"").replace(/&/g,"&amp;").replace(/</g,"&lt;").replace(/>/g,"&gt;").replace(/"/g,"&quot;");
}

function formatDate() {
  return new Date().toLocaleDateString("en-US", { month:"long", day:"numeric", year:"numeric" });
}

// ── HEADER BAR ───────────────────────────────────────────────────────────────
function buildHeaderSVG(totalW) {
  return `<svg width="${totalW}" height="${HEADER_H}" xmlns="http://www.w3.org/2000/svg">
    <rect width="${totalW}" height="${HEADER_H}" fill="#ffffff"/>
    <rect x="0" y="${HEADER_H-2}" width="${totalW}" height="2" fill="#e0d8ce"/>
    <!-- Smart Stage PRO wordmark -->
    <text x="20" y="28" font-family="Arial,sans-serif" font-size="18" font-weight="700" fill="#b8975a" letter-spacing="0.04em">SMART STAGE PRO™</text>
    <text x="20" y="50" font-family="Arial,sans-serif" font-size="10" font-weight="400" fill="#aaa098" letter-spacing="0.1em">THE COMPLETE VIRTUAL STAGING PLATFORM</text>
    <!-- AB 723 badge -->
    <rect x="${totalW-310}" y="14" width="130" height="44" rx="4" fill="#2d6a4f" opacity="0.9"/>
    <text x="${totalW-245}" y="34" font-family="Arial,sans-serif" font-size="11" font-weight="700" fill="#fff" text-anchor="middle" letter-spacing="0.06em">AB 723</text>
    <text x="${totalW-245}" y="50" font-family="Arial,sans-serif" font-size="9" font-weight="400" fill="#a8d5b8" text-anchor="middle" letter-spacing="0.06em">COMPLIANCE</text>
    <!-- Divider -->
    <line x1="${totalW-168}" y1="18" x2="${totalW-168}" y2="${HEADER_H-10}" stroke="#e0d8ce" stroke-width="1"/>
    <!-- Date -->
    <text x="${totalW-150}" y="32" font-family="Arial,sans-serif" font-size="9" font-weight="400" fill="#aaa098" letter-spacing="0.06em">DATE GENERATED</text>
    <text x="${totalW-150}" y="50" font-family="Arial,sans-serif" font-size="12" font-weight="500" fill="#1a1714">${formatDate()}</text>
  </svg>`;
}

// ── ADDRESS BAR ──────────────────────────────────────────────────────────────
function buildAddressSVG(totalW, address) {
  return `<svg width="${totalW}" height="${BADGE_H}" xmlns="http://www.w3.org/2000/svg">
    <rect width="${totalW}" height="${BADGE_H}" fill="#f7f4ef"/>
    <rect x="0" y="${BADGE_H-1}" width="${totalW}" height="1" fill="#e0d8ce"/>
    <!-- Pin icon -->
    <circle cx="28" cy="24" r="10" fill="#b8975a" opacity="0.15"/>
    <text x="28" y="29" font-family="Arial,sans-serif" font-size="14" fill="#b8975a" text-anchor="middle">📍</text>
    <!-- Address -->
    <text x="52" y="20" font-family="Arial,sans-serif" font-size="15" font-weight="600" fill="#1a1714">${escSVG(address)}</text>
    <text x="52" y="38" font-family="Arial,sans-serif" font-size="10" font-weight="400" fill="#7a6f63" letter-spacing="0.04em">PROPERTY ADDRESS · VIRTUAL STAGING DISCLOSURE RECORD</text>
  </svg>`;
}

// ── LABEL BADGE ──────────────────────────────────────────────────────────────
function buildLabelSVG(w, h, text, bgColor) {
  return `<svg width="${w}" height="${h}" xmlns="http://www.w3.org/2000/svg">
    <rect x="12" y="12" width="${Math.min(text.length*9+24, w-20)}" height="30" rx="3" fill="${bgColor}" opacity="0.92"/>
    <text x="24" y="31" font-family="Arial,sans-serif" font-size="13" font-weight="700" fill="#ffffff" letter-spacing="0.04em">${escSVG(text)}</text>
  </svg>`;
}

// ── COMPLIANCE SIDEBAR ───────────────────────────────────────────────────────
function buildSidebarSVG(h, complianceUrl) {
  const items = [
    { icon:"✓", title:"AB 723 Compliant", sub:"California Civil Code §10140.6" },
    { icon:"🔒", title:"Transparent", sub:"Full disclosure of virtually staged images" },
    { icon:"👤", title:"Consumer Protection", sub:"Clear and upfront information" },
    { icon:"📄", title:"View Full Disclosure", sub:"Scan QR or visit compliance URL" },
  ];

  const itemH = 80;
  const startY = 72;
  const itemsSVG = items.map((item, i) => {
    const y = startY + i * itemH;
    return `
    <circle cx="24" cy="${y+18}" r="16" fill="rgba(184,151,90,0.12)" stroke="rgba(184,151,90,0.3)" stroke-width="1"/>
    <text x="24" y="${y+24}" font-family="Arial,sans-serif" font-size="14" fill="#b8975a" text-anchor="middle">${item.icon}</text>
    <text x="50" y="${y+14}" font-family="Arial,sans-serif" font-size="13" font-weight="700" fill="#1a1714">${escSVG(item.title)}</text>
    <text x="50" y="${y+30}" font-family="Arial,sans-serif" font-size="11" font-weight="400" fill="#7a6f63">${escSVG(item.sub.slice(0,26))}</text>
    ${item.sub.length > 26 ? `<text x="50" y="${y+44}" font-family="Arial,sans-serif" font-size="11" fill="#7a6f63">${escSVG(item.sub.slice(26))}</text>` : ''}`;
  }).join('');

  const urlShort = (complianceUrl||'').replace('https://','').slice(0,30);

  const QR_SZ = 180;
  const qrY = h - QR_SZ - 80; // QR position from bottom of sidebar
  const urlFull = (complianceUrl || '').replace('https://', '');
  const urlLine1 = urlFull.slice(0, 32);
  const urlLine2 = urlFull.slice(32, 64);
  return `<svg width="${SIDEBAR_W}" height="${h}" xmlns="http://www.w3.org/2000/svg">
    <rect width="${SIDEBAR_W}" height="${h}" fill="#f7f4ef"/>
    <rect x="0" y="0" width="2" height="${h}" fill="#e0d8ce"/>
    <text x="${SIDEBAR_W/2}" y="36" font-family="Arial,sans-serif" font-size="12" font-weight="700" fill="#b8975a" text-anchor="middle" letter-spacing="0.1em">AB 723 COMPLIANCE</text>
    <line x1="12" y1="50" x2="${SIDEBAR_W-12}" y2="50" stroke="#e0d8ce" stroke-width="1"/>
    ${itemsSVG}
    <line x1="12" y1="${qrY - 18}" x2="${SIDEBAR_W-12}" y2="${qrY - 18}" stroke="#e0d8ce" stroke-width="1"/>
    <text x="${SIDEBAR_W/2}" y="${qrY - 6}" font-family="Arial,sans-serif" font-size="10" font-weight="700" fill="#b8975a" text-anchor="middle" letter-spacing="0.06em">SCAN FOR ORIGINAL PHOTO</text>
    <rect x="${(SIDEBAR_W-QR_SZ)/2 - 4}" y="${qrY}" width="${QR_SZ + 8}" height="${QR_SZ + 8}" rx="4" fill="#ffffff" stroke="#e0d8ce" stroke-width="1"/>
    <text x="${SIDEBAR_W/2}" y="${qrY + QR_SZ + 24}" font-family="Arial,sans-serif" font-size="9" font-weight="600" fill="#b8975a" text-anchor="middle">COMPLIANCE PAGE:</text>
    <text x="${SIDEBAR_W/2}" y="${qrY + QR_SZ + 38}" font-family="Arial,sans-serif" font-size="9" fill="#1a1714" text-anchor="middle">${escSVG(urlLine1)}</text>
    ${urlLine2 ? `<text x="${SIDEBAR_W/2}" y="${qrY + QR_SZ + 52}" font-family="Arial,sans-serif" font-size="9" fill="#1a1714" text-anchor="middle">${escSVG(urlLine2)}</text>` : ''}
  </svg>`;
}

// ── NOTICE STRIP ─────────────────────────────────────────────────────────────
function buildNoticeSVG(w) {
  return `<svg width="${w}" height="${NOTICE_H}" xmlns="http://www.w3.org/2000/svg">
    <rect width="${w}" height="${NOTICE_H}" fill="#ffffff"/>
    <rect x="0" y="0" width="${w}" height="1" fill="#e0d8ce"/>
    <rect x="0" y="${NOTICE_H-1}" width="${w}" height="1" fill="#e0d8ce"/>
    <circle cx="30" cy="${NOTICE_H/2}" r="14" fill="rgba(184,151,90,0.15)" stroke="rgba(184,151,90,0.3)" stroke-width="1"/>
    <text x="30" y="${NOTICE_H/2+5}" font-family="Arial,sans-serif" font-size="14" fill="#b8975a" text-anchor="middle">ⓘ</text>
    <text x="56" y="${NOTICE_H/2-6}" font-family="Arial,sans-serif" font-size="11" font-weight="700" fill="#1a1714" letter-spacing="0.04em">THIS IMAGE HAS BEEN VIRTUALLY STAGED</text>
    <text x="56" y="${NOTICE_H/2+10}" font-family="Arial,sans-serif" font-size="10" fill="#7a6f63">Furniture and décor have been digitally added. The property is sold unfurnished unless otherwise stated.</text>
  </svg>`;
}

// ── FOOTER ───────────────────────────────────────────────────────────────────
function buildFooterSVG(totalW, complianceUrl) {
  const urlDisplay = complianceUrl || "smartstagepro.com/compliance/[project-id]";
  return `<svg width="${totalW}" height="${FOOTER_H}" xmlns="http://www.w3.org/2000/svg">
    <rect width="${totalW}" height="${FOOTER_H}" fill="#f0ece4"/>
    <rect x="0" y="0" width="${totalW}" height="2" fill="#e0d8ce"/>
    <text x="20" y="22" font-family="Arial,sans-serif" font-size="11" font-weight="700" fill="#1a1714" letter-spacing="0.04em">IMPORTANT DISCLOSURE:</text>
    <text x="190" y="22" font-family="Arial,sans-serif" font-size="11" fill="#5a5048">These images include virtual staging. Furniture, décor, and enhancements are digitally added and are not included in the sale of the property.</text>
    <text x="20" y="40" font-family="Arial,sans-serif" font-size="11" fill="#5a5048">AB 723 Compliance disclosures, original unaltered photos, and staged image pairs are available at:</text>
    <text x="20" y="58" font-family="Arial,sans-serif" font-size="12" font-weight="700" fill="#b8975a">${escSVG(urlDisplay)}</text>
    <text x="${totalW - 20}" y="76" font-family="Arial,sans-serif" font-size="9" fill="#aaa098" text-anchor="end">Smart Stage PRO™  ·  California AB 723 §10140.6  ·  MetroList Rule 11.6.1  ·  smartstagepro.com</text>
  </svg>`;
}

// ── MAIN COMPOSITE ───────────────────────────────────────────────────────────
async function buildSidebarWithQR(h, complianceUrl) {
  // Generate QR code for compliance URL
  const QRCode = require("qrcode");
  const QR_SZ = 160;
  const qrBuffer = await QRCode.toBuffer(complianceUrl || "https://smartstagepro.com", {
    type: "png", width: QR_SZ, margin: 1,
    color: { dark: "#000000", light: "#ffffff" },
    errorCorrectionLevel: "H"
  });
  return qrBuffer;
}

async function buildSBS(originalBase64, stagedBase64, address, roomName, tier, complianceUrl) {
  const origBuf   = Buffer.from(originalBase64, "base64");
  const stagedBuf = Buffer.from(stagedBase64, "base64");

  const origMeta   = await sharp(origBuf).metadata();
  const stagedMeta = await sharp(stagedBuf).metadata();

  // Target panel height — use original height, scale staged to match
  // Cap panel width at 900px so sidebar stays proportionally readable
  // regardless of original image resolution
  const MAX_PANEL_W = 900;
  const scale = origMeta.width > MAX_PANEL_W ? MAX_PANEL_W / origMeta.width : 1;
  const PANEL_W = Math.round(origMeta.width * scale);
  const PANEL_H = Math.round(origMeta.height * scale);

  // Resize both panels to capped dimensions for consistent layout
  const origResized = scale < 1
    ? await sharp(origBuf).resize(PANEL_W, PANEL_H, { fit: "fill" }).jpeg({ quality: 92 }).toBuffer()
    : origBuf;

  // Resize staged to match panel dimensions exactly
  const stagedResized = await sharp(stagedBuf)
    .resize(PANEL_W, PANEL_H, { fit: "cover", position: "center" })
    .jpeg({ quality: 92 })
    .toBuffer();

  // Total canvas dimensions
  const imageAreaW = PANEL_W * 2 + PANEL_GAP;
  const totalW     = imageAreaW + SIDEBAR_W + PAD * 2;
  const totalH     = HEADER_H + BADGE_H + PAD + PANEL_H + PAD + NOTICE_H + FOOTER_H;
  const sidebarH   = BADGE_H + PAD + PANEL_H + PAD + NOTICE_H;

  // Generate QR for sidebar
  const QRCode = require("qrcode");
  const QR_SZ = 160;
  const qrBuffer = await QRCode.toBuffer(complianceUrl || "https://smartstagepro.com", {
    type: "png", width: QR_SZ, margin: 1,
    color: { dark: "#000000", light: "#ffffff" },
    errorCorrectionLevel: "H"
  });

  // Build all SVG layers
  const headerBuf  = Buffer.from(buildHeaderSVG(totalW));
  const addressBuf = Buffer.from(buildAddressSVG(totalW, address || "Property Address"));
  const sidebarBuf = Buffer.from(buildSidebarSVG(sidebarH, complianceUrl));
  const noticeBuf  = Buffer.from(buildNoticeSVG(imageAreaW + PAD * 2));
  const footerBuf  = Buffer.from(buildFooterSVG(totalW, complianceUrl));

  // Label badges over images
  const origLabelBuf = Buffer.from(buildLabelSVG(PANEL_W, PANEL_H, "ORIGINAL", "#1a1714"));
  const stagedLabel  =
    tier === "final"     ? "VIRTUALLY STAGED" :
    tier === "declutter" ? "DECLUTTERED" :
    tier === "cns"       ? "CLEANED + STAGED" :
    "VIRTUALLY STAGED";
  const stagedLabelColor = "#2d6a4f"; // always green — clean, consistent with compliance page
  const stagedLabelBuf = Buffer.from(buildLabelSVG(PANEL_W, PANEL_H, stagedLabel, stagedLabelColor));

  // Image panel Y position
  const panelY = HEADER_H + BADGE_H + PAD;
  const origX  = PAD;
  const stagX  = PAD + PANEL_W + PANEL_GAP;
  const sideX  = PAD * 2 + imageAreaW;

  const result = await sharp({
    create: { width: totalW, height: totalH, channels: 3, background: { r:255,g:255,b:255 } }
  })
  .composite([
    // Header
    { input: headerBuf,      top: 0,                                left: 0 },
    // Address bar
    { input: addressBuf,     top: HEADER_H,                        left: 0 },
    // Original image
    { input: origResized,    top: panelY,                          left: origX },
    { input: origLabelBuf,   top: panelY,                          left: origX },
    // Staged image
    { input: stagedResized,  top: panelY,                          left: stagX },
    { input: stagedLabelBuf, top: panelY,                          left: stagX },
    // Sidebar
    { input: sidebarBuf,     top: HEADER_H,                        left: sideX },
    // QR code in sidebar
    { input: qrBuffer,       top: HEADER_H + sidebarH - QR_SZ - 56, left: sideX + Math.round((SIDEBAR_W - QR_SZ) / 2) },
    // Notice strip
    { input: noticeBuf,      top: panelY + PANEL_H + PAD,         left: 0 },
    // Footer
    { input: footerBuf,      top: totalH - FOOTER_H,              left: 0 },
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
    const { originalBase64, stagedBase64, address, roomName, tier, complianceUrl } = JSON.parse(event.body || "{}");

    if (!originalBase64) return { statusCode: 400, headers, body: JSON.stringify({ error: "Missing originalBase64" }) };
    if (!stagedBase64)   return { statusCode: 400, headers, body: JSON.stringify({ error: "Missing stagedBase64" }) };

    console.log(`generate-sbs: room=${roomName} tier=${tier} address=${(address||"").slice(0,40)}`);

    const sbsBase64 = await buildSBS(originalBase64, stagedBase64, address, roomName, tier, complianceUrl);

    console.log(`generate-sbs complete: ${Math.round(sbsBase64.length/1024)}KB`);

    return {
      statusCode: 200, headers,
      body: JSON.stringify({ sbsBase64 })
    };

  } catch (err) {
    console.error("generate-sbs error:", err.message);
    return { statusCode: 500, headers, body: JSON.stringify({ error: err.message }) };
  }
};
