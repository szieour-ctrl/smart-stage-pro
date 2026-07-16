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

    const scale = Math.min(Math.max(parseInt(scaleFactor) || 2, 1), 4);
    const imageBuffer = Buffer.from(imageBase64, "base64");

    // FLAGGED, NOT YET FIXED (Sam's report — 502 on interior Generate
    // Final, exterior works): this clamps to a max of 4x, but the client
    // offers Marketing (6x) and Print (8x) tiers — those two tiers are
    // silently capped down to 4x with no error, never delivering what
    // they promised. That's a real, separate bug — but I'm deliberately
    // NOT raising this cap yet, because if the 502 turns out to be a
    // resource/timeout ceiling on this synchronous function, a HIGHER
    // scale factor makes that worse, not better. This cap may have been
    // an intentional (if undocumented) workaround for exactly that. Fix
    // once the actual 502 cause is confirmed from Netlify's logs, not
    // before.
    //
    // Logging payload size up front regardless — a 502 means Netlify's
    // platform killed this function (timeout, memory, or payload-size
    // ceiling), and there was no visibility into which, without a log
    // line recorded before the point of failure.
    console.log(`Upscale request: scale=${scale}x requestedFactor=${scaleFactor} inputSize=${Math.round(imageBuffer.length/1024)}KB`);

    // Get original dimensions then upscale
    const metadata = await sharp(imageBuffer).metadata();
    const newWidth  = Math.round(metadata.width  * scale);
    const newHeight = Math.round(metadata.height * scale);
    console.log(`Upscale target: ${metadata.width}x${metadata.height} → ${newWidth}x${newHeight} (${scale}x)`);

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
