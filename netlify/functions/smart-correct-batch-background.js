// smart-correct-batch-background.js — Netlify Background Function
// Smart Connect™ / Smart Correct™ — Module 1/2 deterministic batch correction
//
// Receives a batch of uploaded images, sends the whole batch to the Railway
// OpenCV correction service in one call, and stores the result in Netlify
// Blobs. Client polls check-smart-correct-batch.js every few seconds.
//
// This mirrors the existing stage-openai-background.js / check-openai.js
// pattern exactly — same job-store shape (processing → done/error), same
// reason for existing as a background function: a single Netlify sync
// function call is capped around 26-30s wall clock, and a batch of images
// each running OpenCV correction would blow past that if forced into one
// sync call (same constraint that forced the earlier PDF-based Buyer
// Protection Report rebuild off a sync Netlify function).
//
// Per Sam's decision (July 7, 2026): user waits for the FULL batch to
// complete before seeing any results — no progressive per-image display.
// Railway processes images in parallel internally to keep total wait
// reasonable despite that.
//
// ⚠️ CONTRACT WITH RAILWAY SERVICE (not yet built — confirm/adjust when it is):
//   POST {RAILWAY_SMART_CORRECT_URL}/correct-batch
//   Request body:  { batchId, images: [{ id, imageBase64, mimeType }] }
//   Response body: { batchId, results: [{ id, status: "done"|"error",
//                     correctedBase64?, modulesApplied?: string[], error? }] }
// This is a best-guess contract to unblock Netlify-side scaffolding first,
// per Sam's build-order choice. Adjust this function's response parsing to
// match whatever the Railway service actually returns once it exists.

const https = require("https");
const { getStore } = require("@netlify/blobs");

function getJobStore(siteID, token) {
  return getStore({ name: "smart-correct-jobs", siteID, token });
}

function callRailwayCorrectBatch(railwayUrl, batchId, images) {
  const bodyStr = JSON.stringify({ batchId, images });
  const bodyBuf = Buffer.from(bodyStr, "utf8");
  const url = new URL(railwayUrl.replace(/\/$/, "") + "/correct-batch");

  return new Promise((resolve, reject) => {
    const req = https.request({
      hostname: url.hostname,
      path: url.pathname + url.search,
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Content-Length": bodyBuf.length,
      },
      // Batch OpenCV work — give this a generous timeout since a background
      // function has up to 15 minutes, far more than the 26-30s sync limit.
      timeout: 600000,
    }, (res) => {
      const chunks = [];
      res.on("data", c => chunks.push(c));
      res.on("end", () => {
        try {
          const parsed = JSON.parse(Buffer.concat(chunks).toString("utf8"));
          if (res.statusCode !== 200) {
            reject(new Error(`Railway smart-correct error ${res.statusCode}: ${JSON.stringify(parsed).slice(0, 300)}`));
          } else {
            resolve(parsed);
          }
        } catch (e) {
          reject(new Error("Railway smart-correct parse error"));
        }
      });
    });
    req.on("timeout", () => req.destroy(new Error("Railway smart-correct request timed out")));
    req.on("error", reject);
    req.write(bodyBuf);
    req.end();
  });
}

exports.handler = async (event) => {
  const siteID = process.env.SZREG_SITE_ID || process.env.NETLIFY_SITE_ID;
  const token  = process.env.NETLIFY_ACCESS_TOKEN;
  const railwayUrl = process.env.RAILWAY_SMART_CORRECT_URL;
  let batchId;

  try {
    const { batchId: bId, images } = JSON.parse(event.body);
    batchId = bId;

    console.log(`Smart Correct batch ${batchId}: starting, ${Array.isArray(images) ? images.length : 0} images. siteID=${siteID ? "SET" : "MISSING"} token=${token ? "SET" : "MISSING"} railwayUrl=${railwayUrl ? "SET" : "MISSING"}`);

    if (!siteID) throw new Error("NETLIFY_SITE_ID not configured");
    if (!token) throw new Error("NETLIFY_ACCESS_TOKEN not configured");
    if (!railwayUrl) throw new Error("RAILWAY_SMART_CORRECT_URL not configured");
    if (!Array.isArray(images) || images.length === 0) throw new Error("No images provided in batch");

    const store = getJobStore(siteID, token);

    // Write heartbeat immediately — confirms background function is running,
    // same pattern as staging-jobs.
    await store.setJSON(batchId, { status: "processing", startedAt: Date.now(), imageCount: images.length });
    console.log(`Smart Correct batch ${batchId}: heartbeat written`);

    // Single call to Railway with the whole batch — Railway parallelizes
    // internally (worker pool), this function just waits for the full
    // result since Sam confirmed wait-for-batch UX over progressive display.
    const result = await callRailwayCorrectBatch(railwayUrl, batchId, images);
    const results = result?.results;
    if (!Array.isArray(results)) throw new Error("No results array in Railway response");

    const doneCount = results.filter(r => r.status === "done").length;
    const errorCount = results.filter(r => r.status === "error").length;
    console.log(`Smart Correct batch ${batchId}: complete — ${doneCount} done, ${errorCount} errored`);

    await store.setJSON(batchId, { status: "done", results });
    console.log(`Smart Correct batch ${batchId}: stored in Blobs`);

  } catch (err) {
    console.error(`Smart Correct batch ${batchId} error:`, err.message);
    try {
      const store = getJobStore(siteID, token);
      await store.setJSON(batchId, { status: "error", error: err.message });
    } catch (e) {}
  }
};
