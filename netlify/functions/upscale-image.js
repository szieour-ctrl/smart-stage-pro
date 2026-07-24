// upscale-image.js — Netlify Function
// Upscales approved staged draft using Sharp (no external API)
// Input:  imageBase64, mimeType, scaleFactor (2|4)
// Output: upscaledBase64

const sharp = require("sharp");

// SECONDARY MITIGATION (Sam's 502/OOM report — see the memory=3008
// override in netlify.toml for the primary fix): Sharp/libvips keeps an
// internal operation cache by default (50MB, up to 100 items) meant to
// speed up repeated operations on the SAME image data. In a warm Lambda
// container reused across many DIFFERENT one-off images, that cache adds
// memory overhead with no benefit — real-world reports on how much this
// actually helps are mixed (some teams see it resolve their memory
// creep, others report it alone isn't sufficient), so treat this as a
// safeguard alongside the memory increase, not a substitute for it.
sharp.cache(false);
sharp.concurrency(1);

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

    // FIX (this session — real render evidence: an ultra-wide-lens interior
    // photo, 6144x4096 native / ~25MP, at the requested 4x scale computed
    // a 24576x16384 target — over 400 megapixels. Every real failure in
    // Netlify's logs died silently after logging this target and before
    // "Upscale complete," reporting Memory Usage near the function's
    // ceiling each time. A normal (non-ultra-wide) photo at the same 4x
    // request — 2016x1512 → 8064x6048, ~49MP — completed in ~5s using
    // under 550MB. The scale factor alone isn't the problem; it's that
    // multiplying an unusually large SOURCE by that factor has no ceiling
    // at all. No real deliverable (MLS, marketing, even large-format
    // print) needs a >400MP image — this caps the long edge at a still-
    // generous 12,000px and scales the EFFECTIVE factor down to fit that
    // cap, rather than blindly honoring whatever the source size implies.
    const MAX_OUTPUT_LONG_EDGE = 12000;
    const scale = Math.min(Math.max(parseInt(scaleFactor) || 2, 1), 4);
    const imageBuffer = Buffer.from(imageBase64, "base64");

    console.log(`Upscale request: scale=${scale}x requestedFactor=${scaleFactor} inputSize=${Math.round(imageBuffer.length/1024)}KB`);

    // Get original dimensions then upscale
    const metadata = await sharp(imageBuffer).metadata();
    let newWidth  = Math.round(metadata.width  * scale);
    let newHeight = Math.round(metadata.height * scale);
    const longEdge = Math.max(newWidth, newHeight);
    if (longEdge > MAX_OUTPUT_LONG_EDGE) {
      const capRatio = MAX_OUTPUT_LONG_EDGE / longEdge;
      const cappedWidth  = Math.round(newWidth  * capRatio);
      const cappedHeight = Math.round(newHeight * capRatio);
      console.log(`Upscale target ${newWidth}x${newHeight} exceeds the ${MAX_OUTPUT_LONG_EDGE}px long-edge cap (source is unusually large — likely an ultra-wide-lens shot) — capping to ${cappedWidth}x${cappedHeight} instead.`);
      newWidth = cappedWidth;
      newHeight = cappedHeight;
    }
    console.log(`Upscale target: ${metadata.width}x${metadata.height} → ${newWidth}x${newHeight} (${scale}x requested)`);

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
