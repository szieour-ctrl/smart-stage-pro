// group-spatial-read.js — Dispatcher (synchronous)
// Validates input, generates jobId, triggers background function, returns jobId immediately.
// Client polls check-spatial-read.js every 3 seconds for result.
// Background function does the actual Haiku call + prompt assembly.

const https = require("https");

function triggerBackground(payload, siteUrl) {
  // Fire-and-forget — do NOT await response body, just confirm connection made.
  // group-spatial-read-background runs with timeout=900 as a long-running function.
  // Dispatcher returns jobId immediately; client polls check-spatial-read.
  const body = Buffer.from(JSON.stringify(payload));
  const url = new URL(`${siteUrl}/.netlify/functions/group-spatial-read-background`);
  return new Promise((resolve) => {
    const req = https.request({
      hostname: url.hostname,
      path: url.pathname,
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Content-Length": body.length,
      }
    }, (res) => {
      // Drain response so connection closes cleanly, resolve immediately
      res.resume();
      resolve(res.statusCode);
    });
    req.on("error", (err) => {
      console.warn("Background trigger connection error (non-fatal):", err.message);
      resolve(200); // treat as fired — background may still run
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

    if (triggerStatus !== 202 && triggerStatus !== 200) {
      return { statusCode: 500, headers, body: JSON.stringify({ error: `Background trigger failed: ${triggerStatus}` }) };
    }

    return {
      statusCode: 200,
      headers,
      body: JSON.stringify({ jobId })
    };

  } catch (err) {
    console.error("group-spatial-read dispatch error:", err.message);
    return { statusCode: 500, headers, body: JSON.stringify({ error: err.message }) };
  }
};
