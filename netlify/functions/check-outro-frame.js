// check-outro-frame.js — Polling endpoint for generate-outro-frame-background.js
// Same pattern as check-openai.js, pointed at the separate "outro-frame-jobs" store.
// Returns: {status: "pending"} | {status: "done", outroFrameBase64} | {status: "error", error}

const { getStore } = require("@netlify/blobs");

exports.handler = async (event) => {
  const headers = { "Access-Control-Allow-Origin": "*", "Content-Type": "application/json" };

  const jobId = event.queryStringParameters?.jobId;
  if (!jobId) return { statusCode: 400, headers, body: JSON.stringify({ error: "Missing jobId" }) };

  const siteID = process.env.SZREG_SITE_ID || process.env.NETLIFY_SITE_ID;
  const token  = process.env.NETLIFY_ACCESS_TOKEN;
  if (!siteID || !token) return { statusCode: 500, headers, body: JSON.stringify({ error: "Storage not configured" }) };

  try {
    const store = getStore({ name: "outro-frame-jobs", siteID, token });
    const result = await store.get(jobId, { type: "json" });

    if (!result) {
      return { statusCode: 200, headers, body: JSON.stringify({ status: "pending", stage: "not_started" }) };
    }
    if (result.status === "processing") {
      return { statusCode: 200, headers, body: JSON.stringify({ status: "pending", stage: result.stage || "unknown" }) };
    }

    return { statusCode: 200, headers, body: JSON.stringify(result) };

  } catch (err) {
    console.error("check-outro-frame error:", err.message);
    if (err.message?.includes("404") || err.message?.includes("not found")) {
      return { statusCode: 200, headers, body: JSON.stringify({ status: "pending" }) };
    }
    return { statusCode: 500, headers, body: JSON.stringify({ error: err.message }) };
  }
};
