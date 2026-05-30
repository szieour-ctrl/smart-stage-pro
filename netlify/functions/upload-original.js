// upload-original.js — Netlify Function
// AB 723 §10140.8 Compliance — Step 1
// Uploads the original unaltered listing photo to Cloudinary
// Returns a permanent public URL used in QR code and disclosure text
//
// Called ONCE per photo, at the moment the agent uploads the image
// before any staging begins. The URL travels with the session.
//
// Input:  imageBase64, mimeType, listingId (optional slug for organized folders)
// Output: publicUrl — permanent Cloudinary URL of the original
//
// Cloudinary free tier: 25GB storage, 25GB bandwidth/month
// No expiry on uploaded assets — satisfies "publicly accessible" requirement
// URL format: https://res.cloudinary.com/[cloud]/image/upload/[id].jpg

const https = require("https");
const crypto = require("crypto");

// ── CLOUDINARY UPLOAD ────────────────────────────────────────────────────────
// Uses unsigned upload preset or signed upload depending on config
// Signed upload recommended for production (prevents unauthorized uploads)

async function uploadToCloudinary(imageBase64, mimeType, cloudName, uploadPreset, apiKey, apiSecret) {
  const ext  = (mimeType || "image/jpeg").includes("png") ? "png" : "jpg";
  const folder = "smart-stage-originals";

  // Build data URL for Cloudinary's base64 upload
  const dataUrl = `data:${mimeType || "image/jpeg"};base64,${imageBase64}`;

  let bodyObj;

  if (apiKey && apiSecret) {
    // Signed upload — more secure, required for private clouds
    const timestamp = Math.floor(Date.now() / 1000).toString();
    const paramsToSign = `folder=${folder}&timestamp=${timestamp}`;
    const signature = crypto
      .createHash("sha1")
      .update(paramsToSign + apiSecret)
      .digest("hex");

    bodyObj = {
      file: dataUrl,
      folder,
      timestamp,
      api_key: apiKey,
      signature,
    };
  } else {
    // Unsigned upload — requires upload preset configured in Cloudinary dashboard
    bodyObj = {
      file: dataUrl,
      folder,
      upload_preset: uploadPreset,
    };
  }

  const bodyStr = Object.entries(bodyObj)
    .map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(v)}`)
    .join("&");
  const bodyBuf = Buffer.from(bodyStr, "utf8");

  return new Promise((resolve, reject) => {
    const req = https.request({
      hostname: "api.cloudinary.com",
      path: `/v1_1/${cloudName}/image/upload`,
      method: "POST",
      headers: {
        "Content-Type": "application/x-www-form-urlencoded",
        "Content-Length": bodyBuf.length,
      },
    }, (res) => {
      const chunks = [];
      res.on("data", c => chunks.push(c));
      res.on("end", () => {
        try {
          const parsed = JSON.parse(Buffer.concat(chunks).toString("utf8"));
          if (res.statusCode !== 200) {
            reject(new Error(`Cloudinary error ${res.statusCode}: ${parsed?.error?.message || JSON.stringify(parsed).slice(0, 200)}`));
          } else {
            resolve(parsed);
          }
        } catch (e) {
          reject(new Error("Cloudinary parse error"));
        }
      });
    });
    req.on("error", reject);
    req.write(bodyBuf);
    req.end();
  });
}

// ── HANDLER ──────────────────────────────────────────────────────────────────
exports.handler = async (event) => {
  if (event.httpMethod !== "POST") return { statusCode: 405, body: "Method Not Allowed" };

  const headers = {
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Headers": "Content-Type",
    "Content-Type": "application/json",
  };

  try {
    const { imageBase64, mimeType, listingId } = JSON.parse(event.body || "{}");
    if (!imageBase64) return {
      statusCode: 400, headers,
      body: JSON.stringify({ error: "Missing imageBase64" })
    };

    const cloudName    = process.env.CLOUDINARY_CLOUD_NAME;
    const uploadPreset = process.env.CLOUDINARY_UPLOAD_PRESET;
    const apiKey       = process.env.CLOUDINARY_API_KEY;
    const apiSecret    = process.env.CLOUDINARY_API_SECRET;

    if (!cloudName) return {
      statusCode: 500, headers,
      body: JSON.stringify({ error: "CLOUDINARY_CLOUD_NAME not configured" })
    };

    if (!apiKey && !uploadPreset) return {
      statusCode: 500, headers,
      body: JSON.stringify({ error: "Cloudinary credentials not configured — set CLOUDINARY_API_KEY + CLOUDINARY_API_SECRET or CLOUDINARY_UPLOAD_PRESET" })
    };

    console.log(`Uploading original to Cloudinary — size: ${Math.round(imageBase64.length / 1024)}KB listingId: ${listingId || "none"}`);

    const result = await uploadToCloudinary(
      imageBase64,
      mimeType || "image/jpeg",
      cloudName,
      uploadPreset,
      apiKey,
      apiSecret
    );

    const publicUrl = result?.secure_url;
    if (!publicUrl) throw new Error("No secure_url in Cloudinary response: " + JSON.stringify(result).slice(0, 200));

    console.log(`Cloudinary upload complete: ${publicUrl}`);

    return {
      statusCode: 200,
      headers,
      body: JSON.stringify({
        publicUrl,                          // permanent public URL — used in QR code
        cloudinaryId: result.public_id,     // stored for future deletion if needed
        width: result.width,
        height: result.height,
        format: result.format,
      }),
    };

  } catch (err) {
    console.error("upload-original error:", err.message);
    return {
      statusCode: 500, headers,
      body: JSON.stringify({ error: err.message })
    };
  }
};
