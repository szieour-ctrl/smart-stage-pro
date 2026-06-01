// group-spatial-read.js — Dispatcher
// Validates input, generates jobId, triggers background, returns jobId immediately.
// NO sharp dependency — images passed through as-is to background function.
// Background function handles all processing with no timeout risk.

const https = require("https");

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

    const jobId = "gsr-" + Date.now() + "-" + Math.random().toString(36).slice(2, 8);
    console.log(`Group spatial read dispatch: jobId=${jobId} images=${images.length} type=${groupType}`);

    const triggerStatus = await triggerBackground({
      jobId, images, groupType, designStyle, colorPalette
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
