// remove-objects.js — Job dispatcher
// Fires remove-objects-background and returns jobId immediately
// Client polls check-openai.js for result (same blob store)

const https = require("https");
const sharp = require("sharp");

// Compress image if needed — keeps payload under Netlify's 6MB limit
async function prepareImage(imageBase64, mimeType) {
  const buffer = Buffer.from(imageBase64, "base64");
  const meta = await sharp(buffer).metadata();
  const sizeKB = Math.round(buffer.length / 1024);
  const maxDim = Math.max(meta.width || 0, meta.height || 0);

  if (maxDim <= 1536 && sizeKB <= 1500) {
    console.log(`remove-objects: Image OK ${meta.width}x${meta.height} ${sizeKB}KB — no compression`);
    return { base64: imageBase64, mimeType };
  }

  const compressed = await sharp(buffer)
    .resize(1536, 1536, { fit: "inside", withoutEnlargement: true })
    .jpeg({ quality: 88 })
    .toBuffer();

  console.log(`remove-objects: compressed ${meta.width}x${meta.height} ${sizeKB}KB → ${Math.round(compressed.length/1024)}KB`);
  return { base64: compressed.toString("base64"), mimeType: "image/jpeg" };
}

async function triggerBackground(payload, siteUrl) {
  const body = Buffer.from(JSON.stringify(payload));
  console.log(`remove-objects: triggering background, payload ${Math.round(body.length / 1024)}KB`);
  const url = new URL(`${siteUrl}/.netlify/functions/remove-objects-background`);
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
        console.log(`remove-objects: background response status=${res.statusCode} body=${responseBody}`);
        resolve(res.statusCode);
      });
    });
    req.on("error", (err) => {
      console.error(`remove-objects: background trigger error: ${err.message}`);
      reject(err);
    });
    req.write(body);
    req.end();
  });
}

exports.handler = async (event) => {
  if (event.httpMethod === "OPTIONS") return { statusCode: 204, headers: { "Access-Control-Allow-Origin": "*", "Access-Control-Allow-Headers": "Content-Type" } };
  if (event.httpMethod !== "POST") return { statusCode: 405, body: "Method Not Allowed" };

  const headers = {
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Headers": "Content-Type",
    "Content-Type": "application/json",
  };

  try {
    const { imageBase64, mimeType } = JSON.parse(event.body);
    if (!imageBase64) return { statusCode: 400, headers, body: JSON.stringify({ error: "Missing imageBase64" }) };

    const siteUrl = process.env.URL || process.env.DEPLOY_URL;
    if (!siteUrl) return { statusCode: 500, headers, body: JSON.stringify({ error: "Site URL not configured" }) };

    // Compress if large
    const { base64: readyBase64, mimeType: readyMime } = await prepareImage(imageBase64, mimeType);

    const jobId = "rm-" + Date.now() + "-" + Math.random().toString(36).slice(2, 8);

    const triggerStatus = await triggerBackground({
      jobId, imageBase64: readyBase64, mimeType: readyMime
    }, siteUrl);

    console.log(`Remove job ${jobId}: background trigger status = ${triggerStatus}`);

    if (triggerStatus !== 202) {
      console.error(`Remove job ${jobId}: background trigger FAILED with status ${triggerStatus}`);
      return { statusCode: 500, headers, body: JSON.stringify({ error: `Background function trigger failed: ${triggerStatus}` }) };
    }

    return { statusCode: 200, headers, body: JSON.stringify({ jobId }) };

  } catch (err) {
    console.error("remove-objects dispatcher error:", err.message);
    return { statusCode: 500, headers, body: JSON.stringify({ error: err.message }) };
  }
};
