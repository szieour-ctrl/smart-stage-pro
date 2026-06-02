// stage-decor8-background.js — Netlify Background Function
// Name ends in -background so Netlify treats it as async (up to 15 min, no timeout)
// Uses @netlify/blobs for result storage — auth handled automatically by Netlify context
// Client polls check-decor8?jobId=xxx every 3 seconds

const https = require("https");
const { getStore } = require("@netlify/blobs");

function httpsRequest(options, body) {
  return new Promise((resolve, reject) => {
    const req = https.request(options, (res) => {
      const chunks = [];
      res.on("data", (c) => chunks.push(c));
      res.on("end", () => {
        const raw = Buffer.concat(chunks).toString("utf8");
        try { resolve({ status: res.statusCode, body: JSON.parse(raw) }); }
        catch (e) { resolve({ status: res.statusCode, body: { raw } }); }
      });
    });
    req.on("error", reject);
    if (body) req.write(typeof body === "string" ? Buffer.from(body) : body);
    req.end();
  });
}

async function uploadToImgBB(imageBase64, mimeType, apiKey) {
  const imageBuffer = Buffer.from(imageBase64, "base64");
  const boundary = "----ImgBBBoundary" + Math.random().toString(36).slice(2);
  const ext = (mimeType || "image/jpeg").includes("png") ? "png" : "jpg";
  const partHeader = Buffer.from(
    `--${boundary}\r\nContent-Disposition: form-data; name="image"; filename="room_${Date.now()}_${Math.random().toString(36).slice(2,6)}.${ext}"\r\nContent-Type: ${mimeType || "image/jpeg"}\r\n\r\n`,
    "utf8"
  );
  const partFooter = Buffer.from(`\r\n--${boundary}--\r\n`, "utf8");
  const body = Buffer.concat([partHeader, imageBuffer, partFooter]);

  const result = await httpsRequest({
    hostname: "api.imgbb.com",
    path: `/1/upload?key=${apiKey}&expiration=3600`,
    method: "POST",
    headers: {
      "Content-Type": `multipart/form-data; boundary=${boundary}`,
      "Content-Length": body.length,
    }
  }, body);

  if (result.status !== 200) throw new Error(`ImgBB failed: ${result.status}`);
  const url = result.body?.data?.url;
  if (!url) throw new Error("No URL from ImgBB: " + JSON.stringify(result.body).slice(0, 100));
  return url;
}

async function callDecor8(imageUrl, roomType, designStyle, colorScheme, customPrompt, apiKey) {
  const payload = JSON.stringify({
    input_image_url: imageUrl,
    room_type: roomType || "livingroom",
    num_images: 1,
    scale_factor: 2,
    ...(customPrompt
      ? { prompt: customPrompt }
      : {
          design_style: designStyle || "transitional",
          color_scheme: colorScheme || "COLOR_SCHEME_9",
        }
    ),
  });

  console.log("Decor8 payload mode:", customPrompt ? "PROMPT" : "ENUM", "chars:", customPrompt ? customPrompt.length : 0);

  const result = await httpsRequest({
    hostname: "api.decor8.ai",
    path: "/generate_designs_for_room",
    method: "POST",
    headers: {
      Authorization: `Bearer ${apiKey}`,
      "Content-Type": "application/json",
      "Content-Length": Buffer.byteLength(payload),
    }
  }, payload);

  if (result.status !== 200) throw new Error(`Decor8 error: ${result.status} ${JSON.stringify(result.body).slice(0, 200)}`);
  const images = result.body?.info?.images;
  if (!images?.length) throw new Error("No images from Decor8: " + JSON.stringify(result.body).slice(0, 200));
  return images[0];
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

exports.handler = async (event, context) => {
  const decor8Key = process.env.DECOR8_API_KEY;
  const imgbbKey  = process.env.IMGBB_API_KEY;

  // Background functions require explicit credentials for @netlify/blobs
  const netlifyToken = process.env.NETLIFY_ACCESS_TOKEN;
  const netlifyId    = process.env.SZREG_SITE_ID || process.env.NETLIFY_SITE_ID;
  if (!netlifyToken || !netlifyId) {
    console.error("NETLIFY_ACCESS_TOKEN or NETLIFY_SITE_ID not set — cannot store results");
    return;
  }
  const store = getStore({ name: "staging-jobs", siteID: netlifyId, token: netlifyToken });

  let jobId;
  try {
    const {
      jobId: jId, imageBase64, mimeType,
      roomType, designStyle, colorScheme, customPrompt
    } = JSON.parse(event.body);
    jobId = jId;

    console.log(`Background job ${jobId} starting — room: ${roomType}`);

    // Upload to ImgBB
    const imageUrl = await uploadToImgBB(imageBase64, mimeType, imgbbKey);
    console.log(`Job ${jobId}: ImgBB URL obtained`);

    // Call Decor8 — no timeout risk, background function runs up to 15 min
    const imageResult = await callDecor8(imageUrl, roomType, designStyle, colorScheme, customPrompt, decor8Key);
    console.log(`Job ${jobId}: Decor8 complete, fetching result...`);

    // Fetch result as base64
    const stagedBase64 = await fetchAsBase64(imageResult.url);
    console.log(`Job ${jobId}: Result fetched — ${Math.round(stagedBase64.length / 1024)}KB`);

    // Store result in Netlify Blobs — auto-authenticated via context
    await store.set(jobId, JSON.stringify({
      status: "done",
      stagedBase64,
      width: imageResult.width,
      height: imageResult.height,
    }));
    console.log(`Job ${jobId}: Stored in Blobs — complete`);

  } catch (err) {
    console.error(`Job ${jobId || "unknown"} error:`, err.message);
    if (jobId) {
      try {
        await store.set(jobId, JSON.stringify({ status: "error", error: err.message }));
      } catch (storeErr) {
        console.error("Failed to store error result:", storeErr.message);
      }
    }
  }
};
