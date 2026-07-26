// declutter-prompt.js — Netlify Function (thin dispatcher)
// FIX (this session): this file used to run the entire Sonnet vision
// analysis synchronously. That worked on Haiku, but Sonnet's slower
// generation (plus the higher max_tokens needed for the fuller
// windowInventory requirements) pushed real duration to 30-35s — well past
// Netlify's synchronous function ceiling (10s default, 26s max even with an
// increase requested). Netlify kills the function at that point and returns
// its own HTML error page instead of JSON, which is what surfaced
// client-side as "Unexpected token '<'... is not valid JSON".
//
// This file now only fires declutter-prompt-background.js (which has no
// timeout ceiling) and returns a jobId immediately. The client polls
// check-declutter-prompt.js for the actual result. Same three-piece pattern
// already proven out by stage-openai.js + stage-openai-background.js +
// check-openai.js — this just applies it to the room-analysis step too.

const https = require("https");

function triggerBackground(payload, siteUrl, functionName) {
  const body = Buffer.from(JSON.stringify(payload));
  console.log(`Triggering ${functionName}: payload ${Math.round(body.length / 1024)}KB`);
  const url = new URL(`${siteUrl}/.netlify/functions/${functionName}`);

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
      res.on("data", (c) => chunks.push(c));
      res.on("end", () => {
        console.log(`${functionName} response: status=${res.statusCode}`);
        resolve(res.statusCode);
      });
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
    const { imageBase64, mimeType } = JSON.parse(event.body);
    if (!imageBase64) return { statusCode: 400, headers, body: JSON.stringify({ error: "Missing imageBase64" }) };

    const siteUrl = process.env.NETLIFY_URL || process.env.DEPLOY_URL || "https://smart-stage-pro.netlify.app";
    const jobId = "declutter-" + Date.now() + "-" + Math.random().toString(36).slice(2, 8);

    await triggerBackground(
      { jobId, imageBase64, mimeType },
      siteUrl,
      "declutter-prompt-background"
    );

    return {
      statusCode: 202,
      headers,
      body: JSON.stringify({ success: true, jobId, message: "Reading room for decluttering... (polling for result)" })
    };

  } catch (err) {
    console.error("declutter-prompt dispatcher error:", err.message);
    return { statusCode: 500, headers, body: JSON.stringify({ error: err.message }) };
  }
};
