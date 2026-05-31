// stage-openai.js — Job dispatcher
// Accepts image + prompt, fires background function, returns jobId immediately
// Client polls /.netlify/functions/check-decor8?jobId=xxx for result
// Background function stage-openai-background.js does the actual OpenAI call

const https = require("https");

async function triggerBackground(payload, token, siteId) {
  const body = Buffer.from(JSON.stringify(payload));
  return new Promise((resolve, reject) => {
    const req = https.request({
      hostname: "api.netlify.com",
      path: `/api/v1/sites/${siteId}/functions/stage-openai-background`,
      method: "POST",
      headers: {
        Authorization: `Bearer ${token}`,
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
    const { imageBase64, mimeType, stagingPrompt } = JSON.parse(event.body);
    if (!imageBase64)   return { statusCode: 400, headers, body: JSON.stringify({ error: "Missing imageBase64" }) };
    if (!stagingPrompt) return { statusCode: 400, headers, body: JSON.stringify({ error: "Missing stagingPrompt" }) };

    const token  = process.env.NETLIFY_ACCESS_TOKEN;
    const siteId = process.env.NETLIFY_SITE_ID;
    if (!token || !siteId) return { statusCode: 500, headers, body: JSON.stringify({ error: "Netlify env not configured" }) };

    // Generate unique jobId
    const jobId = "oai-" + Date.now() + "-" + Math.random().toString(36).slice(2, 8);

    // Fire background function — don't await result
    await triggerBackground({ jobId, imageBase64, mimeType, stagingPrompt }, token, siteId);

    // Return jobId immediately — client polls check-decor8 for result
    return {
      statusCode: 200,
      headers,
      body: JSON.stringify({ jobId }),
    };

  } catch (err) {
    console.error("stage-openai error:", err.message);
    return { statusCode: 500, headers, body: JSON.stringify({ error: err.message }) };
  }
};

