// upscale-image.js — Netlify Function
// Calls Decor8 /upscale_image on the approved staged draft
// Input:  imageBase64, mimeType, scaleFactor (2|4|6|8)
// Output: upscaledBase64
// Uses multipart/form-data — image sent as binary, no ImgBB needed
// Scale factor cost: 1-2 = free, 3-4 = 1 credit ($0.20), 5-6 = 2 credits, 7-8 = 3 credits

const https = require("https");

function buildMultipart(imageBuffer, mimeType, scaleFactor) {
  const boundary = "----D8UpscaleBoundary" + Math.random().toString(36).slice(2);
  const crlf = "\r\n";
  const parts = [];

  // image field
  parts.push(Buffer.from(
    `--${boundary}${crlf}` +
    `Content-Disposition: form-data; name="input_image"; filename="staged.jpg"${crlf}` +
    `Content-Type: ${mimeType || "image/jpeg"}${crlf}${crlf}`,
    "utf8"
  ));
  parts.push(imageBuffer);
  parts.push(Buffer.from(crlf, "utf8"));

  // scale_factor field
  parts.push(Buffer.from(
    `--${boundary}${crlf}` +
    `Content-Disposition: form-data; name="scale_factor"${crlf}${crlf}` +
    `${scaleFactor}${crlf}`,
    "utf8"
  ));

  // closing boundary
  parts.push(Buffer.from(`--${boundary}--${crlf}`, "utf8"));

  const body = Buffer.concat(parts);
  return { body, boundary };
}

exports.handler = async (event) => {
  if (event.httpMethod !== "POST") return { statusCode: 405, body: "Method Not Allowed" };
  const headers = {
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Headers": "Content-Type",
    "Content-Type": "application/json",
  };

  try {
    const { imageBase64, mimeType, scaleFactor } = JSON.parse(event.body);
    if (!imageBase64) return { statusCode: 400, headers, body: JSON.stringify({ error: "Missing imageBase64" }) };

    const decor8Key = process.env.DECOR8_API_KEY;
    if (!decor8Key) return { statusCode: 500, headers, body: JSON.stringify({ error: "DECOR8_API_KEY not configured" }) };

    const scale = Math.min(Math.max(parseInt(scaleFactor) || 4, 1), 8);
    const imageBuffer = Buffer.from(imageBase64, "base64");

    // Check 4MB limit
    if (imageBuffer.length > 4 * 1024 * 1024) {
      return { statusCode: 400, headers, body: JSON.stringify({ error: "Image exceeds 4MB limit for upscaling" }) };
    }

    const { body, boundary } = buildMultipart(imageBuffer, mimeType || "image/jpeg", scale);
    console.log(`Upscaling: scale=${scale} inputSize=${Math.round(imageBuffer.length/1024)}KB`);

    const result = await new Promise((resolve, reject) => {
      const req = https.request({
        hostname: "api.decor8.ai",
        path: "/upscale_image",
        method: "POST",
        headers: {
          Authorization: `Bearer ${decor8Key}`,
          "Content-Type": `multipart/form-data; boundary=${boundary}`,
          "Content-Length": body.length,
        }
      }, (res) => {
        const chunks = [];
        res.on("data", c => chunks.push(c));
        res.on("end", () => {
          try {
            const parsed = JSON.parse(Buffer.concat(chunks).toString("utf8"));
            if (res.statusCode !== 200) reject(new Error(`Decor8 upscale error ${res.statusCode}: ${JSON.stringify(parsed).slice(0,200)}`));
            else resolve(parsed);
          } catch(e) { reject(new Error("Decor8 parse error")); }
        });
      });
      req.on("error", reject);
      req.write(body);
      req.end();
    });

    // Decor8 returns base64 directly in info.upscaled_image
    const upscaledBase64 = result?.info?.upscaled_image;
    if (!upscaledBase64) throw new Error("No upscaled image in response: " + JSON.stringify(result).slice(0,200));

    console.log(`Upscale complete: ${Math.round(upscaledBase64.length/1024)}KB`);

    return {
      statusCode: 200,
      headers,
      body: JSON.stringify({ upscaledBase64, scaleFactor: scale }),
    };

  } catch (err) {
    console.error("upscale-image error:", err.message);
    return { statusCode: 500, headers, body: JSON.stringify({ error: err.message }) };
  }
};
