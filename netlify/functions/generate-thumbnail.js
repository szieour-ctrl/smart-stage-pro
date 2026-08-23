// generate-thumbnail.js — Netlify Function
// Generates a small resized thumbnail for an already-uploaded S3 image.
//
// WHY THIS EXISTS AS A SEPARATE FUNCTION (August 2026 — picker-grid
// slowness after the S3 migration): upload-original.js can generate its
// thumbnail inline because it receives the image bytes directly in the
// request body. Staged finals don't work that way — upload-staged.js
// issues a presigned S3 PUT URL and the browser uploads the bytes DIRECTLY
// to S3 (see that file's own comments on why: avoiding the platform's
// payload ceiling). That function never has the actual image bytes to
// resize. This function is the follow-up step: called AFTER the direct
// browser→S3 upload finishes, given the resulting public URL, it downloads
// that image back down, resizes it, and uploads the thumbnail — the only
// way to get a server-side resize without restructuring the whole upload
// flow.
//
// Input:  { sourceUrl, projectId }
// Output: { thumbnailUrl } — null if generation fails (non-fatal by design,
//         same as upload-original.js's inline version — the picker grid
//         falls back to the full-res image when this is null)

const https = require("https");
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

function downloadBuffer(url) {
  return new Promise((resolve, reject) => {
    https.get(url, (res) => {
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
        return downloadBuffer(res.headers.location).then(resolve, reject);
      }
      if (res.statusCode !== 200) {
        reject(new Error(`HTTP ${res.statusCode} fetching ${url}`));
        res.resume();
        return;
      }
      const chunks = [];
      res.on("data", (c) => chunks.push(c));
      res.on("end", () => resolve(Buffer.concat(chunks)));
      res.on("error", reject);
    }).on("error", reject);
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
    const { sourceUrl, projectId } = JSON.parse(event.body || "{}");
    if (!sourceUrl) return { statusCode: 400, headers, body: JSON.stringify({ error: "Missing sourceUrl" }) };

    const bucket = process.env.S3_BUCKET_NAME;
    const region = process.env.S3_REGION;
    if (!bucket || !region) return {
      statusCode: 500, headers,
      body: JSON.stringify({ error: "S3_BUCKET_NAME or S3_REGION not configured" })
    };

    const original = await downloadBuffer(sourceUrl);
    const thumbBuffer = await sharp(original)
      .resize({ width: THUMBNAIL_MAX_DIM, height: THUMBNAIL_MAX_DIM, fit: "inside", withoutEnlargement: true })
      .jpeg({ quality: 80 })
      .toBuffer();

    const thumbFolder = projectId ? `smart-stage-thumbnails/${projectId}` : "smart-stage-thumbnails/unfiled";
    const thumbKey = `${thumbFolder}/${crypto.randomUUID()}.jpg`;

    await s3.send(new PutObjectCommand({
      Bucket: bucket,
      Key: thumbKey,
      Body: thumbBuffer,
      ContentType: "image/jpeg",
    }));

    const thumbnailUrl = `https://${bucket}.s3.${region}.amazonaws.com/${thumbKey}`;

    return { statusCode: 200, headers, body: JSON.stringify({ thumbnailUrl }) };

  } catch (err) {
    // Non-fatal by design from the CALLER's side — this function itself
    // still reports the real error for debugging, but index.html treats a
    // failure here as "no thumbnail available," not as blocking the whole
    // staged-image attach from completing.
    console.error("generate-thumbnail error:", err.message);
    return { statusCode: 500, headers, body: JSON.stringify({ error: err.message }) };
  }
};
