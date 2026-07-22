// check-autoSelect.js — polls Netlify Blobs for an auto-select job's result.
// Mirrors check-narration.js's proven pattern exactly (same store/get
// conventions, same status vocabulary) — deliberately not a new invention,
// see autoSelect-background.js's header for why this shape was chosen.
//
// Returns: {status: "pending"} | {status: "done", plan} | {status: "error", error}

const { getStore } = require("@netlify/blobs");

exports.handler = async (event) => {
  const headers = { "Access-Control-Allow-Origin": "*", "Content-Type": "application/json" };

  const jobId = event.queryStringParameters?.jobId;
  if (!jobId) return { statusCode: 400, headers, body: JSON.stringify({ error: "Missing jobId" }) };

  const siteID = process.env.SZREG_SITE_ID || process.env.NETLIFY_SITE_ID;
  const token = process.env.NETLIFY_ACCESS_TOKEN;
  if (!siteID || !token) return { statusCode: 500, headers, body: JSON.stringify({ error: "Storage not configured" }) };

  try {
    const store = getStore({ name: "autoselect-jobs", siteID, token });
    const result = await store.get(jobId, { type: "json" });

    if (!result) {
      return { statusCode: 200, headers, body: JSON.stringify({ status: "pending" }) };
    }
    if (result.status === "processing") {
      return { statusCode: 200, headers, body: JSON.stringify({ status: "pending" }) };
    }

    return { statusCode: 200, headers, body: JSON.stringify(result) };
  } catch (err) {
    console.error("check-autoSelect error:", err.message);
    if (err.message?.includes("404") || err.message?.includes("not found")) {
      return { statusCode: 200, headers, body: JSON.stringify({ status: "pending" }) };
    }
    return { statusCode: 500, headers, body: JSON.stringify({ error: err.message }) };
  }
};
