// upload-original.js — Netlify Function
// AB 723 §10140.8 Compliance — Step 1
// Uploads the original unaltered listing photo to S3.
// Returns a permanent public URL used in QR code and disclosure text.
//
// Called ONCE per photo, at the moment the agent uploads the image
// before any staging begins. The URL travels with the session.
//
// Input:  imageBase64, mimeType, projectId (optional slug for organized folders)
// Output: publicUrl, thumbnailUrl — permanent S3 URLs of the original and a
//         small resized copy for the photo-selection picker grid
//
// Public access comes from a bucket policy scoped to smart-stage-originals/*,
// smart-stage-finals/*, and smart-stage-thumbnails/*, NOT from object ACLs
// (this bucket has ACLs disabled — Bucket owner enforced).
// URL format: https://{bucket}.s3.{region}.amazonaws.com/smart-stage-originals/{projectId}/{id}.jpg
//
// THUMBNAIL (August 2026 — picker-grid slowness after the S3 migration):
// Cloudinary's on-the-fly URL transform used to let the app request a small
// resized copy without a real download; S3 has no equivalent, and the photo
// picker grid was found to be loading full-resolution originals (up to
// 12,000px, upscale-image.js's own ceiling) just to render 150px thumbnails.
// Generated here, once, at upload time — since this function already has
// the full image bytes in memory, no extra download/round-trip needed.

const crypto = require("crypto");
const sharp = require("sharp");
const { S3Client, PutObjectCommand } = require("@aws-sdk/client-s3");

const s3 = new S3Client({
  region: process.env.S3_REGION,
  credentials: {
    accessKeyId: process.env.S3_ACCESS_KEY_ID,
    secretAccessKey: process.env.S3_SECRET_ACCESS_KEY,
  },
});

const THUMBNAIL_MAX_DIM = 400;

exports.handler = async (event) => {
  if (event.httpMethod !== "POST") return { statusCode: 405, body: "Method Not Allowed" };

  const headers = {
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Headers": "Content-Type",
    "Content-Type": "application/json",
  };

  try {
    const { imageBase64, mimeType, projectId } = JSON.parse(event.body || "{}");
    if (!imageBase64) return {
      statusCode: 400, headers,
      body: JSON.stringify({ error: "Missing imageBase64" })
    };

    const bucket = process.env.S3_BUCKET_NAME;
    const region = process.env.S3_REGION;
    if (!bucket || !region) return {
      statusCode: 500, headers,
      body: JSON.stringify({ error: "S3_BUCKET_NAME or S3_REGION not configured" })
    };

    const contentType = mimeType || "image/jpeg";
    const ext = contentType.includes("png") ? "png" : "jpg";
    const folder = projectId ? `smart-stage-originals/${projectId}` : "smart-stage-originals/unfiled";
    const id = crypto.randomUUID();
    const key = `${folder}/${id}.${ext}`;
    const buffer = Buffer.from(imageBase64, "base64");

    console.log(`Uploading original to S3 — size: ${Math.round(buffer.length / 1024)}KB projectId: ${projectId || "none"}`);

    await s3.send(new PutObjectCommand({
      Bucket: bucket,
      Key: key,
      Body: buffer,
      ContentType: contentType,
      // No ACL here — this bucket has ACLs disabled. Public read for this
      // prefix comes entirely from the bucket policy (see setup notes).
    }));

    const publicUrl = `https://${bucket}.s3.${region}.amazonaws.com/${key}`;
    console.log(`S3 upload complete: ${publicUrl}`);

    // Thumbnail — non-fatal if it fails. A missing thumbnail should never
    // block the actual upload from succeeding; the picker grid falls back
    // to the full-res URL when thumbnailUrl is absent (see index.html).
    let thumbnailUrl = null;
    try {
      const thumbBuffer = await sharp(buffer)
        .resize({ width: THUMBNAIL_MAX_DIM, height: THUMBNAIL_MAX_DIM, fit: "inside", withoutEnlargement: true })
        .jpeg({ quality: 80 })
        .toBuffer();
      const thumbFolder = projectId ? `smart-stage-thumbnails/${projectId}` : "smart-stage-thumbnails/unfiled";
      const thumbKey = `${thumbFolder}/${id}.jpg`;
      await s3.send(new PutObjectCommand({
        Bucket: bucket,
        Key: thumbKey,
        Body: thumbBuffer,
        ContentType: "image/jpeg",
      }));
      thumbnailUrl = `https://${bucket}.s3.${region}.amazonaws.com/${thumbKey}`;
    } catch (thumbErr) {
      console.error("upload-original: thumbnail generation failed (non-fatal):", thumbErr.message);
    }

    return {
      statusCode: 200,
      headers,
      body: JSON.stringify({
        publicUrl,     // permanent public URL — used in QR code
        thumbnailUrl,  // small resized copy for the picker grid — may be null
        s3Key: key,    // stored for future deletion/access-mode changes
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
