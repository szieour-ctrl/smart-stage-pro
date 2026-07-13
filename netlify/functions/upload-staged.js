// upload-staged.js — Netlify Function
// Uploads a staged Final image to Cloudinary for permanent project storage
// Called after generateFinal completes, before project-manage add-image
//
// Input:  { imageBase64, mimeType, projectId, roomName, tier }
// Output: { publicUrl, cloudinaryId }

const https = require("https");
const crypto = require("crypto");

async function uploadToCloudinary(imageBase64, mimeType, cloudName, uploadPreset, apiKey, apiSecret, folder) {
  const dataUrl = `data:${mimeType || "image/jpeg"};base64,${imageBase64}`;

  let bodyObj;
  if (apiKey && apiSecret) {
    const timestamp = Math.floor(Date.now() / 1000).toString();
    const folderParam = folder || "smart-stage-finals";
    const paramsToSign = `folder=${folderParam}&timestamp=${timestamp}`;
    const signature = crypto.createHash("sha1").update(paramsToSign + apiSecret).digest("hex");
    bodyObj = { file: dataUrl, folder: folderParam, timestamp, api_key: apiKey, signature };
  } else {
    bodyObj = { file: dataUrl, folder: folder || "smart-stage-finals", upload_preset: uploadPreset };
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
          if (res.statusCode !== 200) reject(new Error(`Cloudinary error: ${parsed?.error?.message}`));
          else resolve(parsed);
        } catch (e) { reject(new Error("Cloudinary parse error")); }
      });
    });
    req.on("error", reject);
    req.write(bodyBuf);
    req.end();
  });
}

exports.handler = async (event) => {
  const headers = {
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Headers": "Content-Type",
    "Content-Type": "application/json",
  };

  if (event.httpMethod !== "POST") return { statusCode: 405, headers, body: "Method Not Allowed" };

  try {
    const { imageBase64, mimeType, projectId, roomName, tier } = JSON.parse(event.body || "{}");
    if (!imageBase64) return { statusCode: 400, headers, body: JSON.stringify({ error: "Missing imageBase64" }) };

    const cloudName   = process.env.CLOUDINARY_CLOUD_NAME;
    const apiKey      = process.env.CLOUDINARY_API_KEY;
    const apiSecret   = process.env.CLOUDINARY_API_SECRET;
    const uploadPreset = process.env.CLOUDINARY_UPLOAD_PRESET;

    if (!cloudName) return { statusCode: 500, headers, body: JSON.stringify({ error: "CLOUDINARY_CLOUD_NAME not configured" }) };

    // Organize by project in Cloudinary folder
    const folder = projectId ? `smart-stage-finals/${projectId}` : "smart-stage-finals";

    console.log(`Uploading ${tier || "final"} staged image for project ${projectId || "none"}, room: ${roomName}`);
    const result = await uploadToCloudinary(imageBase64, mimeType || "image/jpeg", cloudName, uploadPreset, apiKey, apiSecret, folder);

    return {
      statusCode: 200, headers,
      body: JSON.stringify({
        publicUrl: result.secure_url,
        cloudinaryId: result.public_id,
        width: result.width,
        height: result.height,
      }),
    };
  } catch (err) {
    console.error("upload-staged error:", err.message);
    return { statusCode: 500, headers, body: JSON.stringify({ error: err.message }) };
  }
};
