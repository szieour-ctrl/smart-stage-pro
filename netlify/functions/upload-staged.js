// upload-staged.js — Netlify Function
// Issues a presigned S3 PUT URL for a staged Final image.
// Called after generateFinal completes, before project-manage add-image.
//
// Same reason this exists as before: a large final image in the request
// body can exceed the platform's payload ceiling before this function's
// own code ever runs. The image never passes through our infrastructure —
// the browser PUTs the bytes directly to the presigned URL.
//
// Input:  { projectId }  — NO image data
// Output: { uploadUrl, publicUrl, s3Key }
//
// NOTE: staged finals are PUBLIC by default (bucket policy covers
// smart-stage-finals/* the same as smart-stage-originals/*) — this
// matches Cloudinary's prior default behavior. Per-image locking (the
// "hide this listing" case in hide-image.js) is a separate, later
// migration — it needs real per-object access control, not solved here.

const crypto = require("crypto");
const { S3Client, PutObjectCommand } = require("@aws-sdk/client-s3");
const { getSignedUrl } = require("@aws-sdk/s3-request-presigner");

const s3 = new S3Client({
  region: process.env.S3_REGION,
  credentials: {
    accessKeyId: process.env.S3_ACCESS_KEY_ID,
    secretAccessKey: process.env.S3_SECRET_ACCESS_KEY,
  },
});

exports.handler = async (event) => {
  const headers = {
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Headers": "Content-Type",
    "Content-Type": "application/json",
  };

  if (event.httpMethod !== "POST") return { statusCode: 405, headers, body: "Method Not Allowed" };

  try {
    const { projectId } = JSON.parse(event.body || "{}");

    const bucket = process.env.S3_BUCKET_NAME;
    const region = process.env.S3_REGION;
    if (!bucket || !region) return {
      statusCode: 500, headers,
      body: JSON.stringify({ error: "S3_BUCKET_NAME or S3_REGION not configured" })
    };

    const folder = projectId ? `smart-stage-finals/${projectId}` : "smart-stage-finals";
    const key = `${folder}/${crypto.randomUUID()}.jpg`;

    const uploadUrl = await getSignedUrl(
      s3,
      new PutObjectCommand({ Bucket: bucket, Key: key, ContentType: "image/jpeg" }),
      { expiresIn: 300 } // 5 minutes to complete the upload
    );
    const publicUrl = `https://${bucket}.s3.${region}.amazonaws.com/${key}`;

    return {
      statusCode: 200,
      headers,
      body: JSON.stringify({ uploadUrl, publicUrl, s3Key: key }),
    };
  } catch (err) {
    console.error("upload-staged (presign) error:", err.message);
    return { statusCode: 500, headers, body: JSON.stringify({ error: err.message }) };
  }
};
