// upload-staged.js — Netlify Function
// Uploads a staged Final image to Cloudinary for permanent project storage
// Called after generateFinal completes, before project-manage add-image
//
// Input:  { imageBase64, mimeType, projectId, roomName, tier }
// Output: { publicUrl, cloudinaryId }

const https = require("https");
const crypto = require("crypto");

// Builds a multipart/form-data body. Previously this function built the
// request as application/x-www-form-urlencoded, running the base64 image
// string through encodeURIComponent — base64 is full of +, /, and =
// characters, and percent-encoding turns each of those into a 3-character
// escape sequence, meaningfully inflating an already-large string. At the
// same time, the old code held the raw base64, a "data:...;base64,..."
// prefixed copy, AND the percent-encoded copy in memory simultaneously.
// Multipart avoids all of this — the image goes in as raw bytes, no
// re-encoding, and only one buffer copy exists at a time. This directly
// reduces peak memory for exactly the large/ultra-wide-lens images that
// have been the recurring problem across this pipeline.
function buildMultipartBody(fields, fileBuffer, fileFieldName, filename, contentType, boundary) {
  const CRLF = "\r\n";
  const parts = [];
  for (const [key, value] of Object.entries(fields)) {
    parts.push(Buffer.from(
      `--${boundary}${CRLF}Content-Disposition: form-data; name="${key}"${CRLF}${CRLF}${value}${CRLF}`,
      "utf8"
    ));
  }
  parts.push(Buffer.from(
    `--${boundary}${CRLF}Content-Disposition: form-data; name="${fileFieldName}"; filename="${filename}"${CRLF}Content-Type: ${contentType}${CRLF}${CRLF}`,
    "utf8"
  ));
  parts.push(fileBuffer);
  parts.push(Buffer.from(`${CRLF}--${boundary}--${CRLF}`, "utf8"));
  return Buffer.concat(parts);
}

async function uploadToCloudinary(imageBase64, mimeType, cloudName, uploadPreset, apiKey, apiSecret, folder) {
  // Decode ONCE to a raw buffer — this is what actually goes over the
  // wire now, not a base64 string wrapped in a data: URI.
  const imageBuffer = Buffer.from(imageBase64, "base64");
  const folderParam = folder || "smart-stage-finals";

  const fields = {};
  if (apiKey && apiSecret) {
    const timestamp = Math.floor(Date.now() / 1000).toString();
    // Signature is computed over non-file params only, alphabetical order
    // (folder, timestamp) — unchanged from the previous implementation,
    // still correct with a multipart body.
    const paramsToSign = `folder=${folderParam}&timestamp=${timestamp}`;
    const signature = crypto.createHash("sha1").update(paramsToSign + apiSecret).digest("hex");
    fields.folder    = folderParam;
    fields.timestamp = timestamp;
    fields.api_key   = apiKey;
    fields.signature = signature;
  } else {
    fields.folder        = folderParam;
    fields.upload_preset = uploadPreset;
  }

  const boundary = "----SmartStageBoundary" + crypto.randomBytes(16).toString("hex");
  const ext = (mimeType || "image/jpeg").split("/")[1] || "jpg";
  const bodyBuf = buildMultipartBody(fields, imageBuffer, "file", `staged.${ext}`, mimeType || "image/jpeg", boundary);

  return new Promise((resolve, reject) => {
    const req = https.request({
      hostname: "api.cloudinary.com",
      path: `/v1_1/${cloudName}/image/upload`,
      method: "POST",
      headers: {
        "Content-Type": `multipart/form-data; boundary=${boundary}`,
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
