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
      // FIX (this session): this used to report "processing" here too —
      // identical to a job that's genuinely running, just not done yet.
      // That made it impossible to tell "background function never started"
      // apart from "running normally," from the client alone. Distinguishing
      // them matters a lot right now specifically because Netlify's own
      // function-log UI has been intermittently unavailable tonight, so this
      // is the only diagnostic signal available when that's down.
      return { statusCode: 200, headers, body: JSON.stringify({ status: "not_started", note: "No heartbeat found for this jobId yet — background function may not have been invoked, or hasn't run its first write yet." }) };
    }

    return { statusCode: 200, headers, body: JSON.stringify(job) };

  } catch (err) {
    console.error("check-declutter-prompt error:", err.message);
    return { statusCode: 500, headers, body: JSON.stringify({ error: err.message }) };
  }
};
