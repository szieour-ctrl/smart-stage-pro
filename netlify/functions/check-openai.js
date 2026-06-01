// check-openai.js — Polling endpoint for OpenAI background jobs
// Uses @netlify/blobs SDK — avoids presigned S3 URL expiry issues
// Returns: {status: "pending"} | {status: "done", stagedBase64} | {status: "error", error}

const { getStore } = require("@netlify/blobs");

exports.handler = async (event) => {
  const headers = { "Access-Control-Allow-Origin": "*", "Content-Type": "application/json" };

  const jobId = event.queryStringParameters?.jobId;
  if (!jobId) return { statusCode: 400, headers, body: JSON.stringify({ error: "Missing jobId" }) };

  console.log(`check-openai: jobId=${jobId}`);

  try {
    const store = getStore("staging-jobs");
    const result = await store.get(jobId, { type: "json" });

    if (!result) {
      console.log(`Job ${jobId}: pending (not in store yet)`);
      return { statusCode: 200, headers, body: JSON.stringify({ status: "pending" }) };
    }

    console.log(`Job ${jobId}: status=${result.status} stagedBase64=${result.stagedBase64?.length || 0}`);
    return { statusCode: 200, headers, body: JSON.stringify(result) };

  } catch (err) {
    console.error("check-openai error:", err.message);
    // Blob not found = still pending
    if (err.message?.includes("404") || err.message?.includes("not found")) {
      return { statusCode: 200, headers, body: JSON.stringify({ status: "pending" }) };
    }
    return { statusCode: 500, headers, body: JSON.stringify({ error: err.message }) };
  }
};
