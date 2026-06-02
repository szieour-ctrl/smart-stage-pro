// group-spatial-read-background.js
// Temporarily minimal — confirms function boots and Blobs works
// Full logic restored once boot confirmed

const https = require("https");
const { getStore } = require("@netlify/blobs");

exports.handler = async (event) => {
  const siteID = process.env.SZREG_SITE_ID || process.env.NETLIFY_SITE_ID;
  const token  = process.env.NETLIFY_ACCESS_TOKEN;

  let jobId = "unknown";
  try {
    const body = JSON.parse(event.body);
    jobId = body.jobId || "unknown";
    console.log(`group-spatial-read-background BOOT TEST: jobId=${jobId}`);

    const store = getStore({ name: "staging-jobs", siteID, token });
    await store.setJSON(jobId, { status: "processing", startedAt: Date.now(), test: true });
    console.log(`Job ${jobId}: heartbeat written — boot confirmed`);

    // TODO: full logic restored after boot confirmed
    await store.setJSON(jobId, { status: "error", error: "Boot test complete — full logic not yet restored" });

    return { statusCode: 200, body: JSON.stringify({ ok: true, jobId }) };

  } catch (err) {
    console.error(`Boot test error: ${err.message}`);
    try {
      const store = getStore({ name: "staging-jobs", siteID, token });
      await store.setJSON(jobId, { status: "error", error: err.message });
    } catch(e) {}
    return { statusCode: 500, body: JSON.stringify({ error: err.message }) };
  }
};
