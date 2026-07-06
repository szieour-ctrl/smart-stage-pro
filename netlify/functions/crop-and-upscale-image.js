// crop-and-upscale-image.js — Netlify Function
// Deterministic crop + upscale for Cinematic Asset Generator shots. Pure Sharp,
// no external API — the exact pixels the Director selected, enlarged. No
// generative model involved, so no hallucination risk. Mirrors upscale-image.js's
// conventions (same error handling shape, same kernel choice).
//
// Input:  imageBase64, mimeType, crop: {x, y, width, height} — all fractions
//         0–1 relative to the SOURCE image's natural dimensions (not on-screen
//         pixels — the client must convert screen coords to natural-image
//         fractions before calling this), scaleFactor (2|4|6|8)
// Output: croppedUpscaledBase64, width, height

const sharp = require("sharp");

exports.handler = async (event) => {
  if (event.httpMethod !== "POST") return { statusCode: 405, body: "Method Not Allowed" };
  const headers = {
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Headers": "Content-Type",
    "Content-Type": "application/json",
  };

  try {
    const { imageBase64, mimeType, crop, scaleFactor } = JSON.parse(event.body);
    if (!imageBase64) return { statusCode: 400, headers, body: JSON.stringify({ error: "Missing imageBase64" }) };
    if (!crop || typeof crop.x !== "number" || typeof crop.y !== "number" ||
        typeof crop.width !== "number" || typeof crop.height !== "number") {
      return { statusCode: 400, headers, body: JSON.stringify({ error: "Missing or invalid crop rect" }) };
    }

    const scale = Math.min(Math.max(parseInt(scaleFactor) || 4, 1), 8);
    const imageBuffer = Buffer.from(imageBase64, "base64");
    const metadata = await sharp(imageBuffer).metadata();
    const srcW = metadata.width;
    const srcH = metadata.height;

    // Convert fractional crop rect to pixel rect against the SOURCE image's
    // actual dimensions — this is what makes the crop deterministic and exact,
    // regardless of what size the browser happened to display the image at.
    let left   = Math.round(crop.x * srcW);
    let top    = Math.round(crop.y * srcH);
    let width  = Math.round(crop.width * srcW);
    let height = Math.round(crop.height * srcH);

    // Clamp to image bounds — protects against a crop box that was dragged
    // slightly outside the image edge on-screen.
    left   = Math.max(0, Math.min(left, srcW - 1));
    top    = Math.max(0, Math.min(top, srcH - 1));
    width  = Math.max(1, Math.min(width, srcW - left));
    height = Math.max(1, Math.min(height, srcH - top));

    console.log(`Crop+upscale: source ${srcW}x${srcH} → crop [${left},${top},${width},${height}] → ${scale}x`);

    const newWidth  = Math.round(width * scale);
    const newHeight = Math.round(height * scale);

    const outputBuffer = await sharp(imageBuffer)
      .extract({ left, top, width, height })
      .resize(newWidth, newHeight, { kernel: sharp.kernel.lanczos3 })
      .jpeg({ quality: 92 })
      .toBuffer();

    const croppedUpscaledBase64 = outputBuffer.toString("base64");
    console.log(`Crop+upscale complete: ${newWidth}x${newHeight} ${Math.round(croppedUpscaledBase64.length/1024)}KB`);

    return {
      statusCode: 200,
      headers,
      body: JSON.stringify({ croppedUpscaledBase64, scaleFactor: scale, width: newWidth, height: newHeight }),
    };

  } catch (err) {
    console.error("crop-and-upscale-image error:", err.message);
    return { statusCode: 500, headers, body: JSON.stringify({ error: err.message }) };
  }
};
