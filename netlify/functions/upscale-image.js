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

    // FIX (this session — real render evidence: the dimension cap above
    // fixed the MEMORY problem, but exposed a SECOND, different Lambda
    // ceiling right behind it — the RESPONSE itself. A 12000x8000 JPEG
    // encoded to an 8.2MB base64 string, and Lambda's synchronous
    // function response is capped at the same 6MB regular-function limit
    // that caused Smart Correct's original bug, just on the outbound side
    // this time: "Exceeded maximum allowed payload size (6291556 bytes)."
    // A fixed pixel cap "usually" staying under 6MB isn't a real
    // guarantee — JPEG size depends on image content (a highly detailed
    // photo compresses far larger than a simple one at the same pixel
    // count), so this checks the ACTUAL encoded size and shrinks until it
    // genuinely fits, for any image, rather than hoping a static number
    // is conservative enough. Quality reduction is tried first (cheaper
    // to visual fidelity than losing pixels) before falling back to
    // shrinking dimensions further.
    const MAX_RESPONSE_BYTES = 5.5 * 1024 * 1024; // 5.5MB raw base64 — real margin under Lambda's 6MB ceiling for the JSON-wrapped response as a whole, not just the base64 field alone
    let quality = 92;
    let upscaledBuffer = await sharp(imageBuffer)
      .resize(newWidth, newHeight, { kernel: sharp.kernel.lanczos3 })
      .jpeg({ quality })
      .toBuffer();

    while (upscaledBuffer.length * 1.34 > MAX_RESPONSE_BYTES) { // *1.34 — base64 encoding overhead, applied before actually encoding so this loop works on the cheaper raw buffer size
      if (quality > 60) {
        quality -= 10;
        console.log(`Upscale response would exceed the ${Math.round(MAX_RESPONSE_BYTES/1024/1024)}MB response ceiling at quality ${quality + 10} — retrying at quality ${quality}.`);
        upscaledBuffer = await sharp(imageBuffer)
          .resize(newWidth, newHeight, { kernel: sharp.kernel.lanczos3 })
          .jpeg({ quality })
          .toBuffer();
      } else {
        // Quality floor reached with no relief — the image is too large
        // at these dimensions regardless of compression. Shrink the
        // canvas itself by 15% and reset quality, rather than degrading
        // quality indefinitely into visibly bad territory.
        newWidth = Math.round(newWidth * 0.85);
        newHeight = Math.round(newHeight * 0.85);
        quality = 92;
        console.log(`Upscale response still too large at the quality floor — shrinking target to ${newWidth}x${newHeight} and resetting quality to ${quality}.`);
        upscaledBuffer = await sharp(imageBuffer)
          .resize(newWidth, newHeight, { kernel: sharp.kernel.lanczos3 })
          .jpeg({ quality })
          .toBuffer();
      }
    }

    const upscaledBase64 = upscaledBuffer.toString("base64");
    console.log(`Upscale complete: ${newWidth}x${newHeight} quality=${quality} ${Math.round(upscaledBase64.length/1024)}KB`);

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
