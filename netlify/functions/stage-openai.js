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

  // Only resize/compress if over threshold
  if (maxDim <= 1536 && sizeKB <= 1500) {
    console.log(`Image OK: ${meta.width}x${meta.height} ${sizeKB}KB — no compression needed`);
    return { base64: imageBase64, mimeType };
  }

  const compressed = await sharp(buffer)
    .resize(1536, 1536, { fit: "inside", withoutEnlargement: true })
    .jpeg({ quality: 88 })
    .toBuffer();

  const compressedKB = Math.round(compressed.length / 1024);
  console.log(`Image compressed: ${meta.width}x${meta.height} ${sizeKB}KB → 1536px max ${compressedKB}KB`);
  return { base64: compressed.toString("base64"), mimeType: "image/jpeg" };
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

    const siteUrl = process.env.URL || process.env.DEPLOY_URL;
    if (!siteUrl) return { statusCode: 500, headers, body: JSON.stringify({ error: "Site URL not configured" }) };

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
