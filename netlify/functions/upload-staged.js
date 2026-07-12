// upload-staged.js — Netlify Function
// Uploads a staged Final image to Cloudinary for permanent project storage
// Called after generateFinal completes, before project-manage add-image
//
// Input:  { imageBase64, mimeType, projectId, roomName, tier }
// Output: { publicUrl, cloudinaryId }
//
// July 12, 2026: every call site of this function (index.html's main
// staging flow, tiers "final"/"final-enhanced", and the Cinematic Asset
// Generator's "hero_shot") already represents a genuine final deliverable
// — drafts never reach this function at all, so the "Virtually Staged"
// badge below applies unconditionally, with no tier gating needed.

const https = require("https");
const crypto = require("crypto");
const sharp = require("sharp");
const { getBadgeBuffer } = require("./lib/virtually-staged-badge");

// Composites the pre-rendered badge onto the bottom-left corner, sized
// proportionally to the image's own width so it reads consistently
// whether the final is a compact draft-sized export or a fully upscaled
// MLS delivery. Clamped so it never gets comically large or unreadably
// small at extreme resolutions.
async function applyVirtuallyStagedBadge(imageBuffer) {
  const image = sharp(imageBuffer);
  const metadata = await image.metadata();
  const imgWidth = metadata.width || 1600;
  const imgHeight = metadata.height || 1200;

  const badgeBuffer = getBadgeBuffer();
  const badgeMeta = await sharp(badgeBuffer).metadata();

  const targetWidth = Math.max(160, Math.min(420, Math.round(imgWidth * 0.16)));
  const targetHeight = Math.round(badgeMeta.height * (targetWidth / badgeMeta.width));
  const resizedBadge = await sharp(badgeBuffer)
    .resize(targetWidth, targetHeight, { fit: "fill" })
    .toBuffer();

  const margin = Math.round(imgWidth * 0.02);

  return image
    .composite([{
      input: resizedBadge,
      left: margin,
      top: Math.max(0, imgHeight - targetHeight - margin),
    }])
    .toBuffer();
}

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

    let finalBase64 = imageBase64;
    try {
      const badgedBuffer = await applyVirtuallyStagedBadge(Buffer.from(imageBase64, "base64"));
      finalBase64 = badgedBuffer.toString("base64");
    } catch (badgeErr) {
      // A badge-compositing failure should never block the actual
      // deliverable from reaching the agent — log it and fall through to
      // uploading the clean, unbadged image rather than erroring the
      // whole request over a cosmetic step.
      console.error("Virtually Staged badge compositing failed (non-fatal, uploading unbadged image):", badgeErr.message);
    }

    console.log(`Uploading ${tier || "final"} staged image for project ${projectId || "none"}, room: ${roomName}`);
    const result = await uploadToCloudinary(finalBase64, mimeType || "image/jpeg", cloudName, uploadPreset, apiKey, apiSecret, folder);

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
