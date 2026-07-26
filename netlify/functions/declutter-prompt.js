// declutter-prompt.js — Netlify Function (thin dispatcher)
// FIX (this session): this file used to run the entire Sonnet vision
// analysis synchronously. That worked on Haiku, but Sonnet's slower
// generation (plus the higher max_tokens needed for the fuller
// windowInventory requirements) pushed real duration to 30-35s — well past
// Netlify's synchronous function ceiling (10s default, 26s max even with an
// increase requested). Netlify kills the function at that point and returns
// its own HTML error page instead of JSON, which is what surfaced
// client-side as "Unexpected token '<'... is not valid JSON".
//
// This file now only fires declutter-prompt-background.js (which has no
// timeout ceiling) and returns a jobId immediately. The client polls
// check-declutter-prompt.js for the actual result. Same three-piece pattern
// already proven out by stage-openai.js + stage-openai-background.js +
// check-openai.js — this just applies it to the room-analysis step too.

const https = require("https");

function triggerBackground(payload, siteUrl, functionName) {
  const body = Buffer.from(JSON.stringify(payload));
  const url = new URL(`${siteUrl}/.netlify/functions/${functionName}`);
  console.log(`Triggering ${functionName}: payload ${Math.round(body.length / 1024)}KB → ${url.toString()}`);

  return new Promise((resolve, reject) => {
    const req = https.request({
      hostname: url.hostname,
      path: url.pathname,
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Content-Length": body.length,
      }
    }, (res) => {
      const chunks = [];
      res.on("data", (c) => chunks.push(c));
      res.on("end", () => {
        if (res.statusCode >= 300) {
          // Diagnostic (this session): previously only the bare status code
          // was logged, which left every prior 500 undiagnosable — this
          // surfaces Netlify's actual error/redirect response text.
          const bodyText = Buffer.concat(chunks).toString("utf8").slice(0, 500);
          console.error(`${functionName} response: status=${res.statusCode} body=${bodyText}`);
        } else {
          console.log(`${functionName} response: status=${res.statusCode}`);
        }
        resolve(res.statusCode);
      });
    });
    req.on("error", reject);
    req.write(body);
    req.end();
  });
}

exports.handler = async (event) => {
  if (event.httpMethod !== "POST") return { statusCode: 405, body: "Method Not Allowed" };

  const headers = {
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Headers": "Content-Type",
    "Content-Type": "application/json",
  };

  try {
    const { imageBase64, mimeType } = JSON.parse(event.body);
    if (!imageBase64) return { statusCode: 400, headers, body: JSON.stringify({ error: "Missing imageBase64" }) };

    // FIX (this session — real root cause of the persistent 500s): siteUrl
    // was previously process.env.NETLIFY_URL || process.env.DEPLOY_URL ||
    // a hardcoded fallback, a pattern copied from clean-and-stage-prompt.js
    // — but that file turned out to be dead code, never actually running
    // in production, so this exact pattern was never validated live.
    // Worse, the hardcoded fallback ("smart-stage-pro.netlify.app") is the
    // OLD domain netlify.toml force-redirects away from (301 to
    // smartstagepro.com) — if the env vars weren't resolving as assumed,
    // every trigger request would hit a redirect instead of the function.
    // Deriving siteUrl from the incoming request's own Host header is more
    // robust: it's guaranteed to be whatever domain the browser actually
    // used to reach this dispatcher, with no dependency on env vars.
    const hostHeader = event.headers?.host || event.headers?.Host;
    const siteUrl = hostHeader
      ? `https://${hostHeader}`
      : (process.env.URL || process.env.DEPLOY_URL || process.env.NETLIFY_URL || "https://smart-stage-pro.netlify.app");
    console.log(`declutter-prompt dispatcher: using siteUrl=${siteUrl} (from ${hostHeader ? 'request Host header' : 'env var / hardcoded fallback'})`);
    const jobId = "declutter-" + Date.now() + "-" + Math.random().toString(36).slice(2, 8);

    const triggerStatus = await triggerBackground(
      { jobId, imageBase64, mimeType },
      siteUrl,
      "declutter-prompt-background"
    );
    if (triggerStatus >= 300) {
      console.error(`declutter-prompt dispatcher: trigger returned unexpected status ${triggerStatus} — background function may not have been invoked`);
    }

    return {
      statusCode: 202,
      headers,
      body: JSON.stringify({ success: true, jobId, message: "Reading room for decluttering... (polling for result)" })
    };

  } catch (err) {
    console.error("declutter-prompt dispatcher error:", err.message);
    return { statusCode: 500, headers, body: JSON.stringify({ error: err.message }) };
  }
};
