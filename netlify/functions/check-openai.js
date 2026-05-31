// check-openai.js — Polling endpoint for OpenAI background jobs
// Identical pattern to check-decor8.js — preserved separately to keep Decor8 flow intact
// Returns: {status: "pending"} | {status: "done", stagedBase64} | {status: "error", error}

const https = require("https");

async function getResult(jobId, token, siteId) {
  return new Promise((resolve, reject) => {
    const req = https.request({
      hostname: "api.netlify.com",
      path: `/api/v1/sites/${siteId}/blobs/${encodeURIComponent("job-" + jobId)}`,
      method: "GET",
      headers: { Authorization: `Bearer ${token}`, Accept: "application/json" }
    }, (res) => {
      console.log(`Blob status: ${res.statusCode}`);
      if (res.statusCode === 404) { resolve(null); return; }
      if (res.statusCode === 301 || res.statusCode === 302) {
        const loc = res.headers.location;
        console.log(`Redirect to S3: ${loc?.slice(0,80)}`);
        https.request(new URL(loc), (res2) => {
          const chunks = [];
          res2.on("data", c => chunks.push(c));
          res2.on("end", () => {
            const raw = Buffer.concat(chunks).toString("utf8");
            console.log(`S3 response: ${res2.statusCode} size: ${raw.length}`);
            try { resolve(JSON.parse(raw)); }
            catch(e) { console.error("S3 parse error:", e.message); resolve(null); }
          });
        }).on("error", reject).end();
        return;
      }
      const chunks = [];
      res.on("data", c => chunks.push(c));
      res.on("end", () => {
        const raw = Buffer.concat(chunks).toString("utf8");
        console.log(`Direct response size: ${raw.length} preview: ${raw.slice(0,100)}`);
        try {
          const parsed = JSON.parse(raw);
          // Netlify Blobs returns {"url":"https://s3..."} — follow it to get actual data
          if (parsed?.url && parsed.url.includes("s3") && !parsed.status) {
            console.log(`S3 indirect URL, fetching: ${parsed.url.slice(0,80)}`);
            https.request(new URL(parsed.url), (res2) => {
              const chunks2 = [];
              res2.on("data", c => chunks2.push(c));
              res2.on("end", () => {
                const raw2 = Buffer.concat(chunks2).toString("utf8");
                console.log(`S3 fetch: ${res2.statusCode} size: ${raw2.length}`);
                try { resolve(JSON.parse(raw2)); }
                catch(e) { console.error("S3 parse error:", e.message); resolve(null); }
              });
            }).on("error", reject).end();
            return;
          }
          resolve(parsed);
        }
        catch(e) { resolve(null); }
      });
    });
    req.on("error", reject);
    req.end();
  });
}

exports.handler = async (event) => {
  const headers = { "Access-Control-Allow-Origin": "*", "Content-Type": "application/json" };

  const jobId = event.queryStringParameters?.jobId;
  if (!jobId) return { statusCode: 400, headers, body: JSON.stringify({ error: "Missing jobId" }) };

  const token = process.env.NETLIFY_ACCESS_TOKEN;
  const siteId = process.env.NETLIFY_SITE_ID;
  if (!token || !siteId) return { statusCode: 500, headers, body: JSON.stringify({ error: "Storage not configured" }) };

  console.log(`check-openai: jobId=${jobId} siteId=${siteId?.slice(0,8)}`);

  try {
    const result = await getResult(jobId, token, siteId);
    if (!result) return { statusCode: 200, headers, body: JSON.stringify({ status: "pending" }) };
    console.log(`Result status: ${result.status} stagedBase64: ${result.stagedBase64?.length || 0}`);
    return { statusCode: 200, headers, body: JSON.stringify(result) };
  } catch (err) {
    console.error("check-openai error:", err.message);
    return { statusCode: 500, headers, body: JSON.stringify({ error: err.message }) };
  }
};
