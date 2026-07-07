// generate-corrected-final.js — Netlify Function
// Smart Connect™ — SSC path: "Smart Correct™ Only" (clean MLS photo correction)
//
// Takes an already-corrected image (from the Smart Correct batch result —
// no second correction pass happens here) and uploads it to Cloudinary as
// a final, downloadable MLS-ready photo.
//
// CRITICAL: this function must NEVER call project-manage.js?action=add-image
// or otherwise touch the compliance page. Per the SSC path spec, photo
// correction alone (white balance, exposure, perspective, sharpening, noise,
// etc.) falls under AB 723's statutory exclusion for edits that don't change
// the representation of the property — so this path is explicitly
// "ab723_required: false, compliance_page_update: false", even when the
// same property already has an active compliance page from a staged image.
// That separation is deliberate: it keeps non-regulated corrected photos
// out of the AB 723 disclosure page entirely, rather than contaminating it.
//
// Input:  { imageBase64, mimeType, projectId, roomName }
// Output: { publicUrl, cloudinaryId, ab723_required: false, compliance_page_update: false }

const https = require("https");
const crypto = require("crypto");

function uploadToCloudinary(imageBase64, mimeType, cloudName, uploadPreset, apiKey, apiSecret, folder) {
  const dataUrl = `data:${mimeType || "image/jpeg"};base64,${imageBase64}`;

  let bodyObj;
  if (apiKey && apiSecret) {
    const timestamp = Math.floor(Date.now() / 1000).toString();
    const paramsToSign = `folder=${folder}&timestamp=${timestamp}`;
    const signature = crypto.createHash("sha1").update(paramsToSign + apiSecret).digest("hex");
    bodyObj = { file: dataUrl, folder, timestamp, api_key: apiKey, signature };
  } else {
    bodyObj = { file: dataUrl, folder, upload_preset: uploadPreset };
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

  if (event.httpMethod === "OPTIONS") return { statusCode: 200, headers, body: "" };
  if (event.httpMethod !== "POST") return { statusCode: 405, headers, body: "Method Not Allowed" };

  try {
    const { imageBase64, mimeType, projectId, roomName } = JSON.parse(event.body || "{}");
    if (!imageBase64) return { statusCode: 400, headers, body: JSON.stringify({ error: "Missing imageBase64" }) };

    const cloudName    = process.env.CLOUDINARY_CLOUD_NAME;
    const apiKey       = process.env.CLOUDINARY_API_KEY;
    const apiSecret    = process.env.CLOUDINARY_API_SECRET;
    const uploadPreset = process.env.CLOUDINARY_UPLOAD_PRESET;

    if (!cloudName) return { statusCode: 500, headers, body: JSON.stringify({ error: "CLOUDINARY_CLOUD_NAME not configured" }) };

    // Per spec: projects/{property_id}/smart-correct/finals — a dedicated
    // lane, separate from smart-stage-finals, so SSC output never mixes
    // with AB 723-regulated staged images in Cloudinary either.
    const folder = projectId
      ? `projects/${projectId}/smart-correct/finals`
      : "projects/unassigned/smart-correct/finals";

    console.log(`SSC: uploading corrected final for project ${projectId || "none"}, room: ${roomName || "Room"}`);
    const result = await uploadToCloudinary(imageBase64, mimeType || "image/jpeg", cloudName, uploadPreset, apiKey, apiSecret, folder);

    // Deliberately NOT calling project-manage?action=add-image here.
    // See file header — SSC is correction-only and must never touch the
    // compliance page, even if this property already has one active from
    // a staged image elsewhere.

    return {
      statusCode: 200, headers,
      body: JSON.stringify({
        publicUrl: result.secure_url,
        cloudinaryId: result.public_id,
        width: result.width,
        height: result.height,
        ab723_required: false,
        compliance_page_update: false,
      }),
    };
  } catch (err) {
    console.error("generate-corrected-final error:", err.message);
    return { statusCode: 500, headers, body: JSON.stringify({ error: err.message }) };
  }
};
