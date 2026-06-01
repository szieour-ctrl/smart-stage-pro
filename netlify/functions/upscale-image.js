// upscale-image.js — Netlify Function
// Upscales approved staged draft using Sharp (no external API)
// Input:  imageBase64, mimeType, scaleFactor (2|4)
// Output: upscaledBase64

const sharp = require("sharp");

exports.handler = async (event) => {
  if (event.httpMethod !== "POST") return { statusCode: 405, body: "Method Not Allowed" };
  const headers = {
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Headers": "Content-Type",
    "Content-Type": "application/json",
  };

  try {
    const { imageBase64, mimeType, scaleFactor } = JSON.parse(event.body);
    if (!imageBase64) return { statusCode: 400, headers, body: JSON.stringify({ error: "Missing imageBase64" }) };

    const scale = Math.min(Math.max(parseInt(scaleFactor) || 2, 1), 4);
    const imageBuffer = Buffer.from(imageBase64, "base64");

    console.log(`Upscaling: scale=${scale}x inputSize=${Math.round(imageBuffer.length/1024)}KB`);

    // Get original dimensions then upscale
    const metadata = await sharp(imageBuffer).metadata();
    const newWidth  = Math.round(metadata.width  * scale);
    const newHeight = Math.round(metadata.height * scale);

    const upscaledBuffer = await sharp(imageBuffer)
      .resize(newWidth, newHeight, { kernel: sharp.kernel.lanczos3 })
      .jpeg({ quality: 92 })
      .toBuffer();

    const upscaledBase64 = upscaledBuffer.toString("base64");
    console.log(`Upscale complete: ${newWidth}x${newHeight} ${Math.round(upscaledBase64.length/1024)}KB`);

    return {
      statusCode: 200,
      headers,
      body: JSON.stringify({ upscaledBase64, scaleFactor: scale, width: newWidth, height: newHeight }),
    };

  } catch (err) {
    console.error("upscale-image error:", err.message);
    return { statusCode: 500, headers, body: JSON.stringify({ error: err.message }) };
  }
};
