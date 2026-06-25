// check-spatial-read.js — Poll for group spatial read result
// Client calls every 3 seconds with jobId until status is done or error.
// Uses same Netlify Blobs store as background spatial read function.

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
    const store  = getStore({ name: "spatial-jobs", siteID, token });  // ✅ FIXED: matches background function

    const data = await store.get(jobId, { type: "json" });

    if (!data) {
      // Not yet written — background function hasn't started yet
      return { statusCode: 200, headers, body: JSON.stringify({ status: "pending" }) };
    }

    return { statusCode: 200, headers, body: JSON.stringify(data) };

  } catch (err) {
    console.error("check-spatial-read error:", err.message);
    return { statusCode: 500, headers, body: JSON.stringify({ error: err.message }) };
  }
};
