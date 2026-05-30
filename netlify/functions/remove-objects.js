// remove-objects.js — Netlify Function
// Tests Decor8 /remove_objects_from_room endpoint
// Input:  imageBase64, mimeType
// Output: removedBase64 — empty room result

const https = require("https");

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

  return new Promise((resolve, reject) => {
    const req = https.request({
      hostname: "api.imgbb.com",
      path: `/1/upload?key=${apiKey}&expiration=3600`,
      method: "POST",
      headers: {
        "Content-Type": `multipart/form-data; boundary=${boundary}`,
        "Content-Length": body.length,
      }
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

async function removeObjects(imageUrl, apiKey) {
  const payload = JSON.stringify({ input_image_url: imageUrl });
  return new Promise((resolve, reject) => {
    const req = https.request({
      hostname: "api.decor8.ai",
      path: "/remove_objects_from_room",
      method: "POST",
      headers: {
        Authorization: `Bearer ${apiKey}`,
        "Content-Type": "application/json",
        "Content-Length": Buffer.byteLength(payload),
      }
    }, (res) => {
      const chunks = [];
      res.on("data", c => chunks.push(c));
      res.on("end", () => {
        try {
          const parsed = JSON.parse(Buffer.concat(chunks).toString("utf8"));
          if (res.statusCode !== 200) reject(new Error(`Decor8 remove error ${res.statusCode}: ${JSON.stringify(parsed).slice(0,200)}`));
          else resolve(parsed);
        } catch(e) { reject(new Error("Decor8 parse error")); }
      });
    });
    req.on("error", reject);
    req.write(payload);
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

    const decor8Key = process.env.DECOR8_API_KEY;
    const imgbbKey  = process.env.IMGBB_API_KEY;
    if (!decor8Key) return { statusCode: 500, headers, body: JSON.stringify({ error: "DECOR8_API_KEY not configured" }) };
    if (!imgbbKey)  return { statusCode: 500, headers, body: JSON.stringify({ error: "IMGBB_API_KEY not configured" }) };

    // Step 1: Upload to ImgBB
    console.log("Uploading to ImgBB...");
    const imageUrl = await uploadToImgBB(imageBase64, mimeType, imgbbKey);
    console.log("ImgBB URL:", imageUrl);

    // Step 2: Call Decor8 remove objects
    console.log("Calling Decor8 remove objects...");
    const result = await removeObjects(imageUrl, decor8Key);
    console.log("Decor8 remove complete");

    // Step 3: Get result image URL
    const removedImageUrl = result?.info?.image?.url;
    if (!removedImageUrl) throw new Error("No image URL in Decor8 response: " + JSON.stringify(result).slice(0,200));

    // Step 4: Fetch result as base64
    const removedBase64 = await fetchAsBase64(removedImageUrl);
    console.log("Result size:", Math.round(removedBase64.length/1024), "KB");

    return {
      statusCode: 200,
      headers,
      body: JSON.stringify({
        removedBase64,
        removedImageUrl,
        width: result?.info?.image?.width,
        height: result?.info?.image?.height,
      }),
    };

  } catch (err) {
    console.error("test-remove-objects error:", err.message);
    return { statusCode: 500, headers, body: JSON.stringify({ error: err.message }) };
  }
};
