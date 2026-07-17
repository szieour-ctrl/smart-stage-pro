// outro-frame-start.js — Job dispatcher for the Outro End Frame feature
// Fires generate-outro-frame-background.js and returns jobId immediately.
//
// WHY THIS FILE EXISTS (found the hard way, July 17, 2026): the outro-
// frame feature originally had the BROWSER call
// generate-outro-frame-background.js directly — every single attempt
// failed with a bare 500, no custom error body, nothing in the logs.
// Root cause, confirmed by reading stage-openai.js's own comments (this
// exact lesson was already learned and documented in this codebase):
//   1. "Always use Netlify subdomain for function-to-function calls —
//      custom domain redirects break background function 202 handshake."
//      The browser was hitting whatever domain the page loaded on
//      (smartstagepro.com), not the raw .netlify.app subdomain the
//      background-function handshake actually needs.
//   2. "Netlify background functions intermittently return 500" — even
//      correctly triggered, a single attempt can fail; every other
//      background job in this codebase retries up to 3 times for
//      exactly this reason. The outro-frame feature had zero retry logic
//      at all.
// This dispatcher matches stage-openai.js's proven pattern exactly:
// thin, synchronous, triggers the background job server-side against
// the correct subdomain, retries on failure, returns a jobId immediately.

const https = require("https");

function triggerBackground(payload, siteUrl) {
  const body = Buffer.from(JSON.stringify(payload));
  const url = new URL(`${siteUrl}/.netlify/functions/generate-outro-frame-background`);
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
      res.on("data", c => chunks.push(c));
      res.on("end", () => {
        const responseBody = Buffer.concat(chunks).toString("utf8").slice(0, 500);
        console.log(`Outro frame background response: status=${res.statusCode} body=${responseBody}`);
        resolve(res.statusCode);
      });
    });
    req.on("error", (err) => {
      console.error(`Outro frame background trigger network error: ${err.message}`);
      reject(err);
    });
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
    const { imageBase64, address, ctaText } = JSON.parse(event.body);
    if (!imageBase64) return { statusCode: 400, headers, body: JSON.stringify({ error: "Missing imageBase64" }) };
    if (!address)     return { statusCode: 400, headers, body: JSON.stringify({ error: "Missing address" }) };

    // Same reasoning as stage-openai.js — the custom domain's redirect
    // handling breaks the background function 202 handshake, so this
    // MUST go through the raw Netlify subdomain regardless of what
    // domain this dispatcher itself was called on.
    const siteUrl = process.env.NETLIFY_URL || "https://smart-stage-pro.netlify.app";

    const jobId = "outro_" + Date.now() + "_" + Math.random().toString(36).slice(2, 8);

    // Retry up to 3 times — same known intermittent-500 behavior
    // documented in stage-openai.js.
    let triggerStatus;
    for (let attempt = 1; attempt <= 3; attempt++) {
      triggerStatus = await triggerBackground({ jobId, imageBase64, address, ctaText }, siteUrl);
      console.log(`Outro frame job ${jobId}: attempt ${attempt} background trigger status = ${triggerStatus}`);

      if (triggerStatus === 202) break;
      if (attempt < 3) {
        console.log(`Outro frame job ${jobId}: retrying in 2 seconds...`);
        await new Promise(r => setTimeout(r, 2000));
      }
    }

    if (triggerStatus !== 202) {
      console.error(`Outro frame job ${jobId}: background trigger FAILED after 3 attempts, last status ${triggerStatus}`);
      return { statusCode: 500, headers, body: JSON.stringify({ error: `Background function trigger failed after 3 attempts: ${triggerStatus}` }) };
    }

    return { statusCode: 200, headers, body: JSON.stringify({ jobId }) };

  } catch (err) {
    console.error("outro-frame-start error:", err.message);
    return { statusCode: 500, headers, body: JSON.stringify({ error: err.message }) };
  }
};
