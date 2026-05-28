// stage-openai-background.js — Netlify Background Function
// Stores only ImgBB URL in blob (tiny payload) — client fetches and converts to base64
// Mirrors stage-decor8-background.js REST API pattern exactly

const https = require("https");

function buildOpenAIMultipart(imageBuffer, imageMime, prompt) {
  const boundary = "----OAIBoundary" + Math.random().toString(36).slice(2);
  const parts = [];
  parts.push(`--${boundary}\r\nContent-Disposition: form-data; name="model"\r\n\r\ngpt-image-1`);
  parts.push(`--${boundary}\r\nContent-Disposition: form-data; name="prompt"\r\n\r\n${prompt}`);
  parts.push(`--${boundary}\r\nContent-Disposition: form-data; name="n"\r\n\r\n1`);
  parts.push(`--${boundary}\r\nContent-Disposition: form-data; name="size"\r\n\r\n1536x1024`);
  parts.push(`--${boundary}\r\nContent-Disposition: form-data; name="quality"\r\n\r\nmedium`);
  const textBuf = Buffer.from(parts.join("\r\n") + "\r\n", "utf8");
  const fileHdr = Buffer.from(
    `--${boundary}\r\nContent-Disposition: form-data; name="image"; filename="room.jpg"\r\nContent-Type: ${imageMime}\r\n\r\n`,
    "utf8"
  );
  const closing = Buffer.from(`\r\n--${boundary}--\r\n`, "utf8");
  return { body: Buffer.concat([textBuf, fileHdr, imageBuffer, closing]), boundary };
}

async function callOpenAI(imageBase64, mimeType, prompt, apiKey) {
  const imageBuffer = Buffer.from(imageBase64, "base64");
  const { body, boundary } = buildOpenAIMultipart(imageBuffer, mimeType || "image/jpeg", prompt);
  console.log(`OpenAI: prompt ${prompt.length} chars, image ${Math.round(imageBuffer.length/1024)}KB`);
  return new Promise((resolve, reject) => {
    const req = https.request({
      hostname: "api.openai.com",
      path: "/v1/images/edits",
      method: "POST",
      headers: {
        "Authorization": `Bearer ${apiKey}`,
        "Content-Type": `multipart/form-data; boundary=${boundary}`,
        "Content-Length": body.length,
      }
    }, (res) => {
      const chunks = [];
      res.on("data", c => chunks.push(c));
      res.on("end", () => {
        try {
          const parsed = JSON.parse(Buffer.concat(chunks).toString("utf8"));
          if (res.statusCode !== 200) reject(new Error(`OpenAI error ${res.statusCode}: ${JSON.stringify(parsed).slice(0,300)}`));
          else resolve(parsed);
        } catch(e) { reject(new Error(`OpenAI parse error`)); }
      });
    });
    req.on("error", reject);
    req.write(body);
    req.end();
  });
}

async function uploadToImgBB(imageBase64, apiKey) {
  const imageBuffer = Buffer.from(imageBase64, "base64");
  const boundary = "----ImgBBBoundary" + Math.random().toString(36).slice(2);
  const partHeader = Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="image"; filename="staged.jpg"\r\nContent-Type: image/jpeg\r\n\r\n`, "utf8");
  const partFooter = Buffer.from(`\r\n--${boundary}--\r\n`, "utf8");
  const body = Buffer.concat([partHeader, imageBuffer, partFooter]);
  return new Promise((resolve, reject) => {
    const req = https.request({
      hostname: "api.imgbb.com",
      path: `/1/upload?key=${apiKey}&expiration=86400`,
      method: "POST",
      headers: { "Content-Type": `multipart/form-data; boundary=${boundary}`, "Content-Length": body.length }
    }, (res) => {
      const chunks = [];
      res.on("data", c => chunks.push(c));
      res.on("end", () => {
        try {
          const parsed = JSON.parse(Buffer.concat(chunks).toString("utf8"));
          if (res.statusCode !== 200) reject(new Error(`ImgBB error ${res.statusCode}`));
          else resolve(parsed?.data?.url);
        } catch(e) { reject(new Error("ImgBB parse error")); }
      });
    });
    req.on("error", reject);
    req.write(body);
    req.end();
  });
}

async function fetchAsBase64(url, hops = 0) {
  return new Promise((resolve, reject) => {
    if (hops > 5) { reject(new Error("Too many redirects")); return; }
    const u = new URL(url);
    https.request({ hostname: u.hostname, path: u.pathname + u.search, method: "GET" }, (res) => {
      if (res.statusCode === 301 || res.statusCode === 302) {
        fetchAsBase64(res.headers.location, hops + 1).then(resolve).catch(reject);
        return;
      }
      const chunks = [];
      res.on("data", c => chunks.push(c));
      res.on("end", () => resolve(Buffer.concat(chunks).toString("base64")));
    }).on("error", reject).end();
  });
}

// Store tiny JSON blob via REST API — same as stage-decor8-background
async function storeResult(jobId, data, token, siteId) {
  const body = Buffer.from(JSON.stringify(data));
  await new Promise((resolve, reject) => {
    const req = https.request({
      hostname: "api.netlify.com",
      path: `/api/v1/sites/${siteId}/blobs/${encodeURIComponent("job-" + jobId)}`,
      method: "PUT",
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json",
        "Content-Length": body.length,
      }
    }, (res) => { res.resume(); res.on("end", resolve); });
    req.on("error", reject);
    req.write(body);
    req.end();
  });
}

exports.handler = async (event) => {
  const token     = process.env.NETLIFY_ACCESS_TOKEN;
  const siteId    = process.env.NETLIFY_SITE_ID;
  const openAIKey = process.env.OPENAI_API_KEY;
  const imgbbKey  = process.env.IMGBB_API_KEY;

  let jobId;
  try {
    const { jobId: jId, imageBase64, mimeType, customPrompt } = JSON.parse(event.body);
    jobId = jId;
    console.log(`Job ${jobId} starting...`);

    // Step 1: Call OpenAI
    const result = await callOpenAI(imageBase64, mimeType, customPrompt, openAIKey);
    const stagedBase64 = result?.data?.[0]?.b64_json;
    if (!stagedBase64) throw new Error("No image data in OpenAI response");
    console.log(`Job ${jobId}: OpenAI complete ${Math.round(stagedBase64.length/1024)}KB`);

    // Step 2: Upload to ImgBB — get hosted URL
    const imageUrl = await uploadToImgBB(stagedBase64, imgbbKey);
    console.log(`Job ${jobId}: ImgBB URL: ${imageUrl}`);

    // Step 3: Fetch back as base64 from ImgBB
    const finalBase64 = await fetchAsBase64(imageUrl);
    console.log(`Job ${jobId}: Fetched back ${Math.round(finalBase64.length/1024)}KB`);

    // Step 4: Store ONLY the URL in blob — tiny payload, same as Decor8 pattern
    await storeResult(jobId, { status: "done", stagedBase64: finalBase64, width: 1536, height: 1024 }, token, siteId);
    console.log(`Job ${jobId}: Stored in Blobs`);

  } catch (err) {
    console.error(`Job ${jobId} error:`, err.message);
    if (jobId && token && siteId) {
      try { await storeResult(jobId, { status: "error", error: err.message }, token, siteId); } catch(e) {}
    }
  }
};
