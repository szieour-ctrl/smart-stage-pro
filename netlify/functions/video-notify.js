// video-notify.js — Netlify Function
// Webhook receiver — Railway calls this when a render job completes or fails.
// Updates the video_jobs row in Supabase. This is the ONLY way Railway's
// result reaches Supabase — Railway never writes to Supabase directly.

const https = require("https");
const crypto = require("crypto");

function supabase(method, table, body, queryParams = "") {
  return new Promise((resolve, reject) => {
    const url     = new URL(`${process.env.SUPABASE_URL}/rest/v1/${table}${queryParams}`);
    const bodyStr = body ? JSON.stringify(body) : null;
    const req = https.request({
      hostname: url.hostname,
      path:     url.pathname + url.search,
      method,
      headers: {
        "apikey":        process.env.SUPABASE_SERVICE_ROLE_KEY,
        "Authorization": `Bearer ${process.env.SUPABASE_SERVICE_ROLE_KEY}`,
        "Content-Type":  "application/json",
        "Prefer":        "return=representation",
        ...(bodyStr ? { "Content-Length": Buffer.byteLength(bodyStr) } : {})
      }
    }, res => {
      let data = "";
      res.on("data", c => data += c);
      res.on("end", () => {
        try { resolve({ status: res.statusCode, data: JSON.parse(data || "[]") }); }
        catch { resolve({ status: res.statusCode, data }); }
      });
    });
    req.on("error", reject);
    if (bodyStr) req.write(bodyStr);
    req.end();
  });
}

// Constant-time comparison to avoid timing attacks on the shared secret
function safeEqual(a, b) {
  if (!a || !b || a.length !== b.length) return false;
  return crypto.timingSafeEqual(Buffer.from(a), Buffer.from(b));
}

exports.handler = async (event) => {
  const headers = { "Content-Type": "application/json" };

  if (event.httpMethod !== "POST") {
    return { statusCode: 405, headers, body: JSON.stringify({ error: "Method not allowed" }) };
  }

  const providedSecret = event.headers["x-webhook-secret"];
  if (!safeEqual(providedSecret, process.env.WEBHOOK_SECRET || "")) {
    return { statusCode: 401, headers, body: JSON.stringify({ error: "Unauthorized" }) };
  }

  try {
    const { jobId, status, urls, error } = JSON.parse(event.body || "{}");
    if (!jobId || !status) {
      return { statusCode: 400, headers, body: JSON.stringify({ error: "Missing jobId or status" }) };
    }

    const updateFields = { status };

    if (status === "complete") {
      updateFields.output_16x9_url = urls?.["16x9"] || null;
      updateFields.output_9x16_url = urls?.["9x16"] || null;
      updateFields.completed_at = new Date().toISOString();
    }

    if (status === "failed") {
      updateFields.error_message = error || "Unknown render failure";
      updateFields.completed_at = new Date().toISOString();
    }

    await supabase("PATCH", "video_jobs", updateFields, `?id=eq.${jobId}`);

    console.log(`Video job ${jobId} updated to status: ${status}`);

    return { statusCode: 200, headers, body: JSON.stringify({ received: true }) };

  } catch (err) {
    console.error("video-notify error:", err.message);
    return { statusCode: 500, headers, body: JSON.stringify({ error: err.message }) };
  }
};
