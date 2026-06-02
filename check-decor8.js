// check-decor8 — Polling endpoint for background Decor8 staging jobs
// Called by client every 3 seconds after firing stage-decor8-background
// Returns: {status:"pending"} | {status:"done", stagedBase64} | {status:"error", error}

const { getStore } = require("@netlify/blobs");

exports.handler = async (event, context) => {
  const headers = {
    "Access-Control-Allow-Origin": "*",
    "Content-Type": "application/json",
  };

  const jobId = event.queryStringParameters?.jobId;
  if (!jobId) return {
    statusCode: 400,
    headers,
    body: JSON.stringify({ error: "Missing jobId" }),
  };

  try {
    const netlifyToken = process.env.NETLIFY_ACCESS_TOKEN;
    const netlifyId    = process.env.SZREG_SITE_ID || process.env.NETLIFY_SITE_ID;
    if (!netlifyToken || !netlifyId) {
      return { statusCode: 200, headers, body: JSON.stringify({ status: "pending" }) };
    }
    const store = getStore({ name: "staging-jobs", siteID: netlifyId, token: netlifyToken });
    const raw = await store.get(jobId);

    if (!raw) {
      // Not yet written — still processing
      return { statusCode: 200, headers, body: JSON.stringify({ status: "pending" }) };
    }

    const result = JSON.parse(raw);
    return { statusCode: 200, headers, body: JSON.stringify(result) };

  } catch (err) {
    console.error("check-decor8 error:", err.message);
    // If blobs not available yet (job just started), return pending
    return { statusCode: 200, headers, body: JSON.stringify({ status: "pending" }) };
  }
};
