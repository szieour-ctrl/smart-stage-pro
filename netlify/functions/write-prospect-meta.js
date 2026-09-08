// write-prospect-meta.js — Netlify Function
// NEW (Sep 8, 2026): writes staging-prospects/{slug}/meta.json directly to
// S3 — address + created date, nothing else. This is the ONLY piece of
// bookkeeping a prospecting shot gets beyond the images themselves, and it
// lives INSIDE the same S3 folder as the images (see the screenshot that
// prompted this: Sam's staging-prospects/ bucket view, one folder per
// address). No Supabase write, no Netlify Blobs project record — the
// Supabase `listings` row created earlier in the flow still exists (it's
// load-bearing for upload-original.js/upload-staged.js's slug + isProspecting
// resolution — see reserveAssetKey() in those files), but this function and
// prospect-page.js never read from it. The S3 folder is the single source
// of truth for everything a prospecting page needs to render.
//
// Input:  POST { slug, address }
// Output: { ok: true }
//
// Idempotent — called once per Generate Final on a prospecting shot, always
// overwrites. Since the prospect page only ever shows the one most recent
// staged image (Sam's spec: "The Page will only have 1 staged image"),
// there's nothing to merge or append — this file just reflects current
// state.

const { S3Client, PutObjectCommand } = require("@aws-sdk/client-s3");

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

  if (event.httpMethod === "OPTIONS") return { statusCode: 200, headers, body: "" };
  if (event.httpMethod !== "POST") {
    return { statusCode: 405, headers, body: JSON.stringify({ error: "POST only" }) };
  }

  try {
    const { slug, address } = JSON.parse(event.body || "{}");
    if (!slug) {
      return { statusCode: 400, headers, body: JSON.stringify({ error: "Missing slug" }) };
    }

    const meta = {
      address: address || "",
      createdAt: new Date().toISOString(),
    };

    await s3.send(new PutObjectCommand({
      Bucket: process.env.S3_BUCKET_NAME,
      Key: `staging-prospects/${slug}/meta.json`,
      Body: JSON.stringify(meta, null, 2),
      ContentType: "application/json",
    }));

    return { statusCode: 200, headers, body: JSON.stringify({ ok: true }) };
  } catch (err) {
    console.error("write-prospect-meta error:", err.message);
    return { statusCode: 500, headers, body: JSON.stringify({ error: err.message }) };
  }
};
