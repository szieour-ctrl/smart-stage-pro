// Public image proxy for Decor8 API
// Stores image temporarily in Netlify Blobs (via REST API with auth)
// Serves it publicly via this function endpoint
// Decor8 calls: GET /.netlify/functions/serve-image?key=xxx

const https = require("https");

function httpsRequest(options, body) {
  return new Promise((resolve, reject) => {
    const req = https.request(options, (res) => {
      const chunks = [];
      res.on("data", c => chunks.push(c));
      res.on("end", () => resolve({ status: res.statusCode, headers: res.headers, buffer: Buffer.concat(chunks) }));
    });
    req.on("error", reject);
    if (body) req.write(typeof body === "string" ? Buffer.from(body) : body);
    req.end();
  });
}

async function storeImage(key, imageBuffer, token, siteId) {
  const result = await new Promise((resolve, reject) => {
    const options = {
      hostname: "api.netlify.com",
      path: `/api/v1/sites/${siteId}/blobs/${encodeURIComponent(key)}`,
      method: "PUT",
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": "image/jpeg",
        "Content-Length": imageBuffer.length,
      }
    };
    const req = https.request(options, (res) => {
      const chunks = [];
      res.on("data", c => chunks.push(c));
      res.on("end", () => resolve({ status: res.statusCode }));
    });
    req.on("error", reject);
    req.write(imageBuffer);
    req.end();
  });
  return result;
}

async function fetchImage(key, token, siteId) {
  return new Promise((resolve, reject) => {
    const options = {
      hostname: "api.netlify.com",
      path: `/api/v1/sites/${siteId}/blobs/${encodeURIComponent(key)}`,
      method: "GET",
      headers: { Authorization: `Bearer ${token}` }
    };
    const req = https.request(options, (res) => {
      if (res.statusCode === 301 || res.statusCode === 302) {
        // Follow redirect
        const loc = res.headers.location;
        const u = new URL(loc);
        https.request({ hostname: u.hostname, path: u.pathname + u.search, method: "GET" }, (res2) => {
          const chunks = [];
          res2.on("data", c => chunks.push(c));
          res2.on("end", () => resolve({ status: res2.statusCode, buffer: Buffer.concat(chunks) }));
        }).on("error", reject).end();
        return;
      }
      const chunks = [];
      res.on("data", c => chunks.push(c));
      res.on("end", () => resolve({ status: res.statusCode, buffer: Buffer.concat(chunks) }));
    });
    req.on("error", reject);
    req.end();
  });
}

exports.handler = async (event) => {
  const corsHeaders = {
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Headers": "Content-Type",
  };
  const jsonHeaders = { ...corsHeaders, "Content-Type": "application/json" };

  const token = process.env.NETLIFY_ACCESS_TOKEN;
  const siteId = process.env.SZREG_SITE_ID || process.env.NETLIFY_SITE_ID;

  // GET — serve image publicly (called by Decor8)
  if (event.httpMethod === "GET") {
    const key = event.queryStringParameters?.key;
    if (!key) return { statusCode: 400, headers: jsonHeaders, body: JSON.stringify({ error: "Missing key" }) };
    if (!token || !siteId) return { statusCode: 500, headers: jsonHeaders, body: JSON.stringify({ error: "Storage not configured" }) };
    try {
      const result = await fetchImage(key, token, siteId);
      if (result.status !== 200) return { statusCode: 404, headers: jsonHeaders, body: JSON.stringify({ error: "Image not found" }) };
      return {
        statusCode: 200,
        headers: { ...corsHeaders, "Content-Type": "image/jpeg", "Cache-Control": "public, max-age=3600" },
        body: result.buffer.toString("base64"),
        isBase64Encoded: true,
      };
    } catch(err) {
      return { statusCode: 500, headers: jsonHeaders, body: JSON.stringify({ error: err.message }) };
    }
  }

  // POST — store image, return public URL
  if (event.httpMethod === "POST") {
    if (!token || !siteId) return { statusCode: 500, headers: jsonHeaders, body: JSON.stringify({ error: "NETLIFY_ACCESS_TOKEN and NETLIFY_SITE_ID required" }) };
    try {
      const { imageBase64, mimeType } = JSON.parse(event.body);
      const key = `img-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
      const buf = Buffer.from(imageBase64, "base64");
      await storeImage(key, buf, token, siteId);
      // Build public URL using our own function
      const siteUrl = process.env.URL || `https://smart-stage-ai.netlify.app`;
      const publicUrl = `${siteUrl}/.netlify/functions/serve-image?key=${key}`;
      console.log("Image stored, public URL:", publicUrl);
      return { statusCode: 200, headers: jsonHeaders, body: JSON.stringify({ url: publicUrl, key }) };
    } catch(err) {
      return { statusCode: 500, headers: jsonHeaders, body: JSON.stringify({ error: err.message }) };
    }
  }

  return { statusCode: 405, body: "Method Not Allowed" };
};
