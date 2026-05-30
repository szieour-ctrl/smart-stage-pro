// Single synchronous function — does everything inline
// ImgBB upload + Decor8 call + return result
// Client handles timeout with retry

const https = require("https");

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

  console.log(`ImgBB upload: ${Math.round(body.length / 1024)}KB`);
  const result = await httpsRequest({
    hostname: "api.imgbb.com",
    path: `/1/upload?key=${apiKey}&expiration=3600`,
    method: "POST",
    headers: {
      "Content-Type": `multipart/form-data; boundary=${boundary}`,
      "Content-Length": body.length,
    }
  }, body);

  console.log("ImgBB status:", result.status);
  if (result.status !== 200) throw new Error(`ImgBB failed: ${result.status} ${JSON.stringify(result.body).slice(0, 200)}`);
  const url = result.body?.data?.url;
  if (!url) throw new Error("No URL from ImgBB: " + JSON.stringify(result.body).slice(0, 200));
  console.log("ImgBB URL:", url);
  return url;
}

async function callDecor8(imageUrl, roomType, designStyle, colorScheme, customPrompt, apiKey) {
  // Per Decor8 API spec: when prompt is provided, room_type/design_style/color_scheme
  // are ignored — but sending them alongside the prompt influences diffusion anyway.
  // Strip them entirely when prompt is present to match API Playground behavior.
  // null prompt = Strategy A (native Decor8) — use enums only
  // non-null prompt = Strategy B/C (guided/full) — strip enums per API spec
  // When a custom prompt is sent, design_style and color_scheme are ignored per API spec.
  // However room_type is NOT truly ignored — Decor8 uses it to activate structural
  // preservation and spatial segmentation logic (especially "openplan").
  // Always send room_type. Only strip design_style and color_scheme when prompt is present.
  const payload = (customPrompt && customPrompt.length > 0)
    ? JSON.stringify({
        input_image_url: imageUrl,
        room_type: roomType || "livingroom",  // keeps Decor8 structural logic active
        prompt: customPrompt,
        num_images: 1,
        scale_factor: 2,
      })
    : JSON.stringify({
        input_image_url: imageUrl,
        room_type: roomType || "livingroom",
        design_style: designStyle || "organicmodern",
        num_images: 1,
        scale_factor: 2,
        color_scheme: colorScheme || "COLOR_SCHEME_9",
      });

  const decor8Payload = JSON.parse(payload);
  console.log("Decor8 API payload:", JSON.stringify(decor8Payload, null, 2));
  console.log(`Decor8: ${(customPrompt && customPrompt.length > 0) ? `PROMPT mode (${customPrompt.length} chars)` : `ENUM mode room=${roomType} style=${designStyle}`}`);
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

  console.log("Decor8 status:", result.status);
  if (result.status !== 200) throw new Error(`Decor8 error ${result.status}: ${JSON.stringify(result.body).slice(0, 200)}`);
  const images = result.body?.info?.images;
  if (!images?.length) throw new Error("No images from Decor8: " + JSON.stringify(result.body).slice(0, 300));
  return { image: images[0], decor8ImageUrl: images[0].url, decor8Payload };
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

exports.handler = async (event) => {
  if (event.httpMethod !== "POST") return { statusCode: 405, body: "Method Not Allowed" };
  const headers = {
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Headers": "Content-Type",
    "Content-Type": "application/json",
  };

  try {
    const { imageBase64, mimeType, roomType, designStyle, colorScheme, customPrompt } = JSON.parse(event.body);
    if (!imageBase64) return { statusCode: 400, headers, body: JSON.stringify({ error: "Missing imageBase64" }) };

    const decor8Key = process.env.DECOR8_API_KEY;
    const imgbbKey = process.env.IMGBB_API_KEY;
    if (!decor8Key) return { statusCode: 500, headers, body: JSON.stringify({ error: "DECOR8_API_KEY not configured" }) };
    if (!imgbbKey) return { statusCode: 500, headers, body: JSON.stringify({ error: "IMGBB_API_KEY not configured" }) };

    // Step 1: Upload to ImgBB
    const imageUrl = await uploadToImgBB(imageBase64, mimeType, imgbbKey);

    // Step 2: Call Decor8
    const { image: imageResult, decor8Payload } = await callDecor8(imageUrl, roomType, designStyle, colorScheme, customPrompt, decor8Key);

    // Step 3: Fetch result as base64
    console.log("Fetching result from:", imageResult.url?.slice(0, 60));
    const stagedBase64 = await fetchAsBase64(imageResult.url);
    console.log("Done. Result size:", Math.round(stagedBase64.length / 1024), "KB");

    return {
      statusCode: 200,
      headers,
      body: JSON.stringify({ stagedBase64, width: imageResult.width, height: imageResult.height, decor8Payload, decor8ImageUrl: imageResult.url }),
    };

  } catch (err) {
    console.error("stage-decor8 error:", err.message);
    return { statusCode: 500, headers, body: JSON.stringify({ error: err.message, retryable: true }) };
  }
};
