// check-smart-correct-batch.js — Polling endpoint for Smart Correct batch jobs
// Uses @netlify/blobs SDK with explicit siteID + token, same shape as
// check-openai.js.
//
// Per Sam's decision (July 7, 2026): the frontend polls this until the
// WHOLE batch is done — there is no per-image "partial" status returned.
// Railway parallelizes internally, so the wait is the total batch time,
// not sum-of-images time.
//
// Returns:
//   {status: "pending"}
//   {status: "done", results: [{ id, status, correctedBase64?, error? }]}
//   {status: "error", error}

const { getStore } = require("@netlify/blobs");

exports.handler = async (event) => {
  const headers = { "Access-Control-Allow-Origin": "*", "Content-Type": "application/json" };

  const batchId = event.queryStringParameters?.batchId;
  if (!batchId) return { statusCode: 400, headers, body: JSON.stringify({ error: "Missing batchId" }) };

  const siteID = process.env.SZREG_SITE_ID || process.env.NETLIFY_SITE_ID;
  const token  = process.env.NETLIFY_ACCESS_TOKEN;
  if (!siteID || !token) return { statusCode: 500, headers, body: JSON.stringify({ error: "Storage not configured" }) };

  console.log(`check-smart-correct-batch: batchId=${batchId}`);

  try {
    const store = getStore({ name: "smart-correct-jobs", siteID, token });
    const result = await store.get(batchId, { type: "json" });

    if (!result) {
      console.log(`Smart Correct batch ${batchId}: pending (not in store yet)`);
      return { statusCode: 200, headers, body: JSON.stringify({ status: "pending" }) };
    }

    if (result.status === "processing") {
      const elapsed = result.startedAt ? Math.round((Date.now() - result.startedAt) / 1000) : "?";
      console.log(`Smart Correct batch ${batchId}: processing — ${elapsed}s elapsed, ${result.imageCount || "?"} images`);
      return { statusCode: 200, headers, body: JSON.stringify({ status: "pending" }) };
    }

    console.log(`Smart Correct batch ${batchId}: status=${result.status}${result.error ? " error=" + result.error : ""}${result.results ? " resultCount=" + result.results.length : ""}`);
    return { statusCode: 200, headers, body: JSON.stringify(result) };

  } catch (err) {
    console.error("check-smart-correct-batch error:", err.message);
    if (err.message?.includes("404") || err.message?.includes("not found")) {
      return { statusCode: 200, headers, body: JSON.stringify({ status: "pending" }) };
    }
    return { statusCode: 500, headers, body: JSON.stringify({ error: err.message }) };
  }
};
