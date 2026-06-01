// group-spatial-read.js — Dispatcher
// Compresses images, generates jobId, triggers background, returns jobId immediately.
// Mirrors stage-openai.js pattern exactly — fire-and-forget to background function.

const https = require("https");
const sharp = require("sharp");

// Compress each image — same logic as stage-openai.js
// Keeps total payload under Netlify 6MB limit across multiple images
async function compressImage(imageBase64, mimeType) {
  const buffer = Buffer.from(imageBase64, "base64");
  const meta = await sharp(buffer).metadata();
  const sizeKB = Math.round(buffer.length / 1024);
  const maxDim = Math.max(meta.width || 0, meta.height || 0);

  // For group reads: compress more aggressively — target 800px max, 600KB per image
  // Haiku only needs to read spatial layout, not pixel-level detail
  if (maxDim <= 800 && sizeKB <= 600) {
    return { base64: imageBase64, mimeType };
  }

  const compressed = await sharp(buffer)
    .resize(800, 800, { fit: "inside", withoutEnlargement: true })
    .jpeg({ quality: 82 })
    .toBuffer();

  const compressedKB = Math.round(compressed.length / 1024);
  console.log(`Image compressed for spatial read: ${meta.width}x${meta.height} ${sizeKB}KB → 800px ${compressedKB}KB`);
  return { base64: compressed.toString("base64"), mimeType: "image/jpeg" };
}

async function triggerBackground(payload, siteUrl) {
  const body = Buffer.from(JSON.stringify(payload));
  console.log(`Triggering group-spatial-read-background: payload ${Math.round(body.length / 1024)}KB`);
  const url = new URL(`${siteUrl}/.netlify/functions/group-spatial-read-background`);
  return new Promise((resolve, reject) => {
    const req = https.request({
      hostname: url.hostname,
      path: url.pathname,
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Content-Length": body.length,
      }
    }, (res) => {
      res.resume();
      res.on("end", () => resolve(res.statusCode));
    });
    req.on("error", reject);
    req.write(body);
    req.end();
  });
}

exports.handler = async (event) => {
  if (event.httpMethod !== "POST") return { statusCode: 405, body: "Method Not Allowed" };

  const headers = {
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Headers": "Content-Type",
    "Content-Type": "application/json",
  };

  try {
    const { images, groupType, designStyle, colorPalette } = JSON.parse(event.body);

    if (!images || !Array.isArray(images) || images.length < 2) {
      return { statusCode: 400, headers, body: JSON.stringify({ error: "At least 2 images required for group spatial read" }) };
    }
    if (images.length > 5) {
      return { statusCode: 400, headers, body: JSON.stringify({ error: "Maximum 5 images per group" }) };
    }

    const siteUrl = process.env.URL || process.env.DEPLOY_URL;
    if (!siteUrl) return { statusCode: 500, headers, body: JSON.stringify({ error: "Site URL not configured" }) };

    // Compress all images before dispatch — keeps payload under 6MB
    console.log(`Compressing ${images.length} images for spatial read...`);
    const compressedImages = await Promise.all(
      images.map(async (img) => {
        const { base64, mimeType } = await compressImage(img.base64, img.mimeType || "image/jpeg");
        return { ...img, base64, mimeType };
      })
    );

    const totalKB = Math.round(compressedImages.reduce((sum, img) => sum + img.base64.length * 0.75 / 1024, 0));
    console.log(`Total compressed payload: ~${totalKB}KB for ${images.length} images`);

    const jobId = "gsr-" + Date.now() + "-" + Math.random().toString(36).slice(2, 8);

    const triggerStatus = await triggerBackground({
      jobId, images: compressedImages, groupType, designStyle, colorPalette
    }, siteUrl);

    console.log(`Job ${jobId}: background trigger status = ${triggerStatus}`);

    if (triggerStatus !== 202) {
      console.error(`Job ${jobId}: background trigger FAILED with status ${triggerStatus}`);
      return { statusCode: 500, headers, body: JSON.stringify({ error: `Background trigger failed: ${triggerStatus}` }) };
    }

    return { statusCode: 200, headers, body: JSON.stringify({ jobId }) };

  } catch (err) {
    console.error("group-spatial-read dispatch error:", err.message);
    return { statusCode: 500, headers, body: JSON.stringify({ error: err.message }) };
  }
};
