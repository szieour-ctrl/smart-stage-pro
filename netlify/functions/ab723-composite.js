// ab723-composite.js — Netlify Function
// AB 723 §10140.6 Compliance — Final Image Processing
//
// MLS RULES UPDATE: Final images must be CLEAN — no overlays, badges, or QR codes.
// AB 723 compliance is satisfied by:
//   1. The compliance page at smartstagepro.com/compliance/{projectId}
//   2. The Marketing QR code (standalone download for MLS photo gallery)
//   3. The Final Side-by-Side (includes compliance sidebar + footer with URL)
//
// This function now simply validates and returns the clean staged image.
// The compliance record (original URL, prompt, metadata) is written by project-manage.js
//
// Input:  { stagedBase64, mimeType, originalUrl, complianceUrl, roomName, tier }
// Output: { compliantBase64, originalUrl } — clean image, no overlays

const sharp = require("sharp");

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

    console.log(`ab723-composite: room=${roomName} tier=${tier} — returning clean image (no overlays per MLS rules)`);

    // Ensure image is proper JPEG — normalize format only, no overlays
    const imageBuffer = Buffer.from(stagedBase64, "base64");
    const meta = await sharp(imageBuffer).metadata();

    let compliantBase64 = stagedBase64;

    // Only re-encode if not already JPEG
    if (meta.format !== "jpeg") {
      const jpegBuffer = await sharp(imageBuffer)
        .jpeg({ quality: 95, progressive: true })
        .toBuffer();
      compliantBase64 = jpegBuffer.toString("base64");
      console.log(`ab723-composite: converted ${meta.format} → JPEG ${Math.round(jpegBuffer.length/1024)}KB`);
    } else {
      console.log(`ab723-composite: clean JPEG ${Math.round(imageBuffer.length/1024)}KB — no conversion needed`);
    }

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
