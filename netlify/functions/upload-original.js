// upload-original.js — Netlify Function
// AB 723 §10140.8 Compliance — Step 1
// Uploads the original unaltered listing photo to S3.
// Returns a permanent public URL used in QR code and disclosure text.
//
// Called ONCE per photo, at the moment the agent uploads the image
// before any staging begins. The URL travels with the session.
//
// Input:  imageBase64, mimeType, listingId (optional slug for organized folders)
// Output: publicUrl — permanent S3/CloudFront URL of the original
//
// Public access comes from a bucket policy scoped to smart-stage-originals/*,
// NOT from object ACLs (this bucket has ACLs disabled — Bucket owner enforced).
// URL format: https://{bucket}.s3.{region}.amazonaws.com/smart-stage-originals/{listingId}/{id}.jpg

const crypto = require("crypto");
const { S3Client, PutObjectCommand } = require("@aws-sdk/client-s3");

const s3 = new S3Client({
  region: process.env.S3_REGION,
  credentials: {
    accessKeyId: process.env.S3_ACCESS_KEY_ID,
    secretAccessKey: process.env.S3_SECRET_ACCESS_KEY,
  },
});

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

    const bucket = process.env.S3_BUCKET_NAME;
    const region = process.env.S3_REGION;
    if (!bucket || !region) return {
      statusCode: 500, headers,
      body: JSON.stringify({ error: "S3_BUCKET_NAME or S3_REGION not configured" })
    };

    const contentType = mimeType || "image/jpeg";
    const ext = contentType.includes("png") ? "png" : "jpg";
    const folder = listingId ? `smart-stage-originals/${listingId}` : "smart-stage-originals/unfiled";
    const key = `${folder}/${crypto.randomUUID()}.${ext}`;
    const buffer = Buffer.from(imageBase64, "base64");

    console.log(`Uploading original to S3 — size: ${Math.round(buffer.length / 1024)}KB listingId: ${listingId || "none"}`);

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

    return {
      statusCode: 200,
      headers,
      body: JSON.stringify({
        publicUrl,   // permanent public URL — used in QR code
        s3Key: key,  // stored for future deletion/access-mode changes
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
