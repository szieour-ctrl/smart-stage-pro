// stage-openai.js — Job dispatcher
// Fires stage-openai-background and returns jobId immediately
// Image conversion to PNG happens in background function

const https = require("https");
const sharp = require("sharp");

// Compress image if needed — keeps payload under Netlify's 6MB limit
// and reduces OpenAI processing time on large inputs
// Target: max 1536px on longest side, max 1.5MB file size
async function prepareImage(imageBase64, mimeType) {
  const buffer = Buffer.from(imageBase64, "base64");
  const meta = await sharp(buffer).metadata();
  const sizeKB = Math.round(buffer.length / 1024);
  const maxDim = Math.max(meta.width || 0, meta.height || 0);

  console.log(`Image input: ${meta.width}x${meta.height} ${sizeKB}KB format=${meta.format} channels=${meta.channels} hasAlpha=${meta.hasAlpha} orientation=${meta.orientation||'none'}`);

  // Netlify function-to-function payload limit is ~300KB
  // Target: max 1024px longest side, max 200KB — ensures payload stays under 280KB
  const TARGET_MAX_DIM = 1024;
  const TARGET_MAX_KB  = 200;

  const needsResize = maxDim > TARGET_MAX_DIM || sizeKB > TARGET_MAX_KB;
  const hasAlpha    = meta.hasAlpha || meta.channels === 4;
  const hasRotation = meta.orientation && meta.orientation !== 1;
  const isPNG       = meta.format === 'png';

  if (needsResize || hasAlpha || hasRotation || isPNG) {
    let pipeline = sharp(buffer)
      .rotate()
      .flatten({ background: { r: 255, g: 255, b: 255 } })
      .resize(TARGET_MAX_DIM, TARGET_MAX_DIM, { fit: "inside", withoutEnlargement: true });

    const normalized = await pipeline
      .jpeg({ quality: 85, mozjpeg: false })
      .toBuffer();

    const normMeta = await sharp(normalized).metadata();
    console.log(`Image normalized: ${normMeta.width}x${normMeta.height} ${Math.round(normalized.length/1024)}KB → JPEG`);
    return { base64: normalized.toString("base64"), mimeType: "image/jpeg" };
  }

  console.log(`Image OK: ${meta.width}x${meta.height} ${sizeKB}KB — no normalization needed`);
  return { base64: imageBase64, mimeType };
}

async function triggerBackground(payload, siteUrl) {
  const body = Buffer.from(JSON.stringify(payload));
  console.log(`Triggering background: payload ${Math.round(body.length / 1024)}KB`);
  const url = new URL(`${siteUrl}/.netlify/functions/stage-openai-background`);
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
      const chunks = [];
      res.on("data", c => chunks.push(c));
      res.on("end", () => {
        const responseBody = Buffer.concat(chunks).toString("utf8").slice(0, 500);
        console.log(`Background response: status=${res.statusCode} body=${responseBody}`);
        resolve(res.statusCode);
      });
    });
    req.on("error", (err) => {
      console.error(`Background trigger network error: ${err.message}`);
      reject(err);
    });
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
    const { imageBase64, mimeType, stagingPrompt, quality } = JSON.parse(event.body);
    if (!imageBase64)   return { statusCode: 400, headers, body: JSON.stringify({ error: "Missing imageBase64" }) };
    if (!stagingPrompt) return { statusCode: 400, headers, body: JSON.stringify({ error: "Missing stagingPrompt" }) };

    // Always use Netlify subdomain for function-to-function calls —
    // custom domain redirects break background function 202 handshake
    const siteUrl = process.env.NETLIFY_URL || "https://smart-stage-pro.netlify.app";
    console.log(`Using trigger URL base: ${siteUrl}`);

    // Compress if large — protects against subscriber uploading 10MB photos
    const { base64: readyBase64, mimeType: readyMime } = await prepareImage(imageBase64, mimeType);

    const jobId = "oai-" + Date.now() + "-" + Math.random().toString(36).slice(2, 8);

    // Retry up to 3 times — Netlify background functions intermittently return 500
    let triggerStatus;
    for (let attempt = 1; attempt <= 3; attempt++) {
      triggerStatus = await triggerBackground({
        jobId, imageBase64: readyBase64, mimeType: readyMime, stagingPrompt, quality: quality || "low"
      }, siteUrl);

      console.log(`Job ${jobId}: attempt ${attempt} background trigger status = ${triggerStatus}`);

      if (triggerStatus === 202) break;
      if (attempt < 3) {
        console.log(`Job ${jobId}: retrying in 2 seconds...`);
        await new Promise(r => setTimeout(r, 2000));
      }
    }

    if (triggerStatus !== 202) {
      console.error(`Job ${jobId}: background trigger FAILED after 3 attempts, last status ${triggerStatus}`);
      return { statusCode: 500, headers, body: JSON.stringify({ error: `Background function trigger failed after 3 attempts: ${triggerStatus}` }) };
    }

    return { statusCode: 200, headers, body: JSON.stringify({ jobId }) };

  } catch (err) {
    console.error("stage-openai error:", err.message);
    return { statusCode: 500, headers, body: JSON.stringify({ error: err.message }) };
  }
};
