// check-declutter-prompt.js — Netlify Function
// Polling endpoint for declutter-prompt-background.js jobs. Client
// (callDeclutterPromptAPI in index.html) hits this every 1.5s with a jobId
// until status is "done" or "error". Same shape and Blobs conventions as
// check-openai.js — just a different store name ("declutter-jobs") and
// jobId prefix ("declutter-").

const { getStore } = require("@netlify/blobs");

exports.handler = async (event) => {
  const headers = {
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Headers": "Content-Type",
    "Content-Type": "application/json",
  };

  try {
    const jobId = event.queryStringParameters?.jobId;
    if (!jobId) return { statusCode: 400, headers, body: JSON.stringify({ error: "Missing jobId" }) };

    const siteID = process.env.SZREG_SITE_ID || process.env.NETLIFY_SITE_ID;
    const token  = process.env.NETLIFY_ACCESS_TOKEN;
    if (!siteID) return { statusCode: 500, headers, body: JSON.stringify({ error: "NETLIFY_SITE_ID not configured" }) };
    if (!token)  return { statusCode: 500, headers, body: JSON.stringify({ error: "NETLIFY_ACCESS_TOKEN not configured" }) };

    const store = getStore({ name: "declutter-jobs", siteID, token });
    const job = await store.get(jobId, { type: "json" });

    if (!job) {
      // Heartbeat not written yet (background function still cold-starting) —
      // treat as still-processing rather than an error, matching
      // check-openai.js's tolerance for the same race.
      return { statusCode: 200, headers, body: JSON.stringify({ status: "processing" }) };
    }

    return { statusCode: 200, headers, body: JSON.stringify(job) };

  } catch (err) {
    console.error("check-declutter-prompt error:", err.message);
    return { statusCode: 500, headers, body: JSON.stringify({ error: err.message }) };
  }
};
