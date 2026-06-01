// check-openai.js — Polling endpoint for OpenAI background jobs
// Uses @netlify/blobs SDK with explicit siteID + token
// Returns: {status: "pending"} | {status: "done", stagedBase64} | {status: "error", error}

const { getStore } = require("@netlify/blobs");

exports.handler = async (event) => {
  const headers = { "Access-Control-Allow-Origin": "*", "Content-Type": "application/json" };

  const jobId = event.queryStringParameters?.jobId;
  if (!jobId) return { statusCode: 400, headers, body: JSON.stringify({ error: "Missing jobId" }) };

  const siteID = process.env.NETLIFY_SITE_ID;
  const token  = process.env.NETLIFY_ACCESS_TOKEN;
  if (!siteID || !token) return { statusCode: 500, headers, body: JSON.stringify({ error: "Storage not configured" }) };

  console.log(`check-openai: jobId=${jobId}`);

  try {
    const store = getStore({ name: "staging-jobs", siteID, token });
    const result = await store.get(jobId, { type: "json" });

    if (!result) {
      console.log(`Job ${jobId}: pending`);
      return { statusCode: 200, headers, body: JSON.stringify({ status: "pending" }) };
    }

    console.log(`Job ${jobId}: status=${result.status} stagedBase64=${result.stagedBase64?.length || 0}`);
    return { statusCode: 200, headers, body: JSON.stringify(result) };

  } catch (err) {
    console.error("check-openai error:", err.message);
    if (err.message?.includes("404") || err.message?.includes("not found")) {
      return { statusCode: 200, headers, body: JSON.stringify({ status: "pending" }) };
    }
    return { statusCode: 500, headers, body: JSON.stringify({ error: err.message }) };
  }
};
