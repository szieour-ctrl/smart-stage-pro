// migrate-listing-media.js — Netlify Function
// ONE-TIME migration tool. Moves real listing data (not marketing assets —
// see migrate-marketing-media.js for those) off Cloudinary and onto S3:
//   1. Netlify Blobs project records (originalUrl/stagedUrl/sbsUrl per image)
//   2. Supabase staged_images rows (cloudinary_original_url/cloudinary_staged_url —
//      this is the table video-job.js's autoSelect path actually reads)
//   3. Supabase video_jobs rows (output_16x9_url/output_9x16_url)
//
// Auto-discovers everything that still points at Cloudinary rather than
// requiring hardcoded project IDs — safe to run once across your whole
// account regardless of exactly how many listings have legacy data.
// Idempotent: anything already on S3 is skipped, so re-running after a
// partial failure only retries what didn't finish.
//
// STILL NEEDS the old CLOUDINARY_* env vars (cloud name/key/secret) —
// videos were uploaded as type:"authenticated", so downloading them back
// OUT of Cloudinary requires signing a real request the same way
// signVideoUrl used to, before those functions were migrated. Don't
// remove the CLOUDINARY_* env vars until after this has run successfully.
//
// Protected by a shared secret query param, same pattern as
// migrate-marketing-media.js:
//   https://smartstagepro.com/.netlify/functions/migrate-listing-media?secret=YOUR_SECRET
//
// Delete this file once you've confirmed the summary shows 0 failures and
// spot-checked both listings actually still work — it has no ongoing
// purpose and it's the one function in this codebase that still touches
// the Cloudinary SDK.

const https = require("https");
const crypto = require("crypto");
const { getStore } = require("@netlify/blobs");
const { S3Client, PutObjectCommand } = require("@aws-sdk/client-s3");
const cloudinary = require("cloudinary").v2;

cloudinary.config({
  cloud_name: process.env.CLOUDINARY_CLOUD_NAME,
  api_key:    process.env.CLOUDINARY_API_KEY,
  api_secret: process.env.CLOUDINARY_API_SECRET,
});

const s3 = new S3Client({
  region: process.env.S3_REGION,
  credentials: {
    accessKeyId: process.env.S3_ACCESS_KEY_ID,
    secretAccessKey: process.env.S3_SECRET_ACCESS_KEY,
  },
});

// ── DOWNLOAD HELPERS ──────────────────────────────────────────────────────

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
      const contentType = res.headers["content-type"] || "application/octet-stream";
      const chunks = [];
      res.on("data", (c) => chunks.push(c));
      res.on("end", () => resolve({ buffer: Buffer.concat(chunks), contentType }));
      res.on("error", reject);
    }).on("error", reject);
  });
}

// Mints a working (signed) download URL for an old Cloudinary asset.
// Images uploaded plain "upload" type work with their stored URL as-is.
// Videos uploaded type:"authenticated" need a fresh signature — same
// public_id-parsing approach the old signVideoUrl() functions used
// before this migration, kept here ONLY for one-time reads.
function resolveDownloadUrl(rawUrl) {
  if (!rawUrl.includes("/authenticated/")) return rawUrl; // plain image, works as-is
  const match = rawUrl.match(/\/authenticated\/(?:s--[^/]+--\/)?(?:v(\d+)\/)?(.+)\.(\w+)$/);
  if (!match) return null;
  const [, version, publicId, format] = match;
  return cloudinary.url(publicId, {
    resource_type: "video",
    type: "authenticated",
    format,
    version: version || undefined,
    sign_url: true,
    secure: true,
    expires_at: Math.floor(Date.now() / 1000) + 3600, // 1 hour — this run only
  });
}

async function migrateOneAsset(rawUrl, s3Key, isVideo) {
  const downloadUrl = resolveDownloadUrl(rawUrl);
  if (!downloadUrl) throw new Error(`Could not resolve a download URL for ${rawUrl}`);
  const { buffer, contentType } = await downloadBuffer(downloadUrl);
  await s3.send(new PutObjectCommand({
    Bucket: process.env.S3_BUCKET_NAME,
    Key: s3Key,
    Body: buffer,
    ContentType: isVideo ? "video/mp4" : contentType,
  }));
  return `https://${process.env.S3_BUCKET_NAME}.s3.${process.env.S3_REGION}.amazonaws.com/${s3Key}`;
}

function isCloudinaryUrl(url) {
  return !!url && url.includes("cloudinary.com");
}

// ── SUPABASE HELPER (same pattern as every other function) ──────────────

function supabase(method, table, body, queryParams = "") {
  return new Promise((resolve, reject) => {
    const url = new URL(`${process.env.SUPABASE_URL}/rest/v1/${table}${queryParams}`);
    const bodyStr = body ? JSON.stringify(body) : null;
    const req = https.request({
      hostname: url.hostname,
      path: url.pathname + url.search,
      method,
      headers: {
        "apikey":        process.env.SUPABASE_SERVICE_ROLE_KEY,
        "Authorization": `Bearer ${process.env.SUPABASE_SERVICE_ROLE_KEY}`,
        "Content-Type":  "application/json",
        "Prefer":        "return=representation",
        ...(bodyStr ? { "Content-Length": Buffer.byteLength(bodyStr) } : {})
      }
    }, res => {
      let data = "";
      res.on("data", c => data += c);
      res.on("end", () => {
        try { resolve({ status: res.statusCode, data: JSON.parse(data || "[]") }); }
        catch { resolve({ status: res.statusCode, data }); }
      });
    });
    req.on("error", reject);
    if (bodyStr) req.write(bodyStr);
    req.end();
  });
}

function getProjectStore() {
  return getStore({
    name: "smart-stage-projects",
    siteID: process.env.NETLIFY_SITE_ID,
    token: process.env.NETLIFY_ACCESS_TOKEN,
  });
}

function addressHash(address) {
  const normalized = (address || "").toLowerCase()
    .replace(/\s+/g, " ")
    .replace(/[^a-z0-9\s,]/g, "")
    .trim();
  return crypto.createHash("md5").update(normalized).digest("hex").slice(0, 16);
}

// ── PART 1: BLOBS PROJECT IMAGES ─────────────────────────────────────────

async function migrateBlobsProjects(log) {
  const store = getProjectStore();
  const results = [];
  let cursor;

  do {
    const page = await store.list({ prefix: "pid_", cursor });
    cursor = page.cursor;

    for (const entry of page.blobs) {
      const projectId = entry.key.replace(/^pid_/, "");
      const raw = await store.get(entry.key);
      if (!raw) continue;
      const project = JSON.parse(raw);
      let changed = false;

      for (const img of (project.images || [])) {
        for (const field of ["originalUrl", "stagedUrl", "sbsUrl"]) {
          const val = img[field];
          if (!isCloudinaryUrl(val)) continue;

          const isOriginal = field === "originalUrl";
          const s3Key = `${isOriginal ? "smart-stage-originals" : "smart-stage-finals"}/${projectId}/${crypto.randomUUID()}.jpg`;

          try {
            const newUrl = await migrateOneAsset(val, s3Key, false);
            img[field] = newUrl;
            changed = true;
            results.push({ ok: true, projectId, imageId: img.imageId, field, s3Key });
            log(`Blobs OK: ${projectId} / ${img.imageId} / ${field}`);
          } catch (err) {
            results.push({ ok: false, projectId, imageId: img.imageId, field, error: err.message });
            log(`Blobs FAIL: ${projectId} / ${img.imageId} / ${field} - ${err.message}`);
          }
        }
      }

      if (changed) {
        const updated = JSON.stringify(project);
        await store.set(entry.key, updated);
        if (project.address) {
          await store.set("addr_" + addressHash(project.address), updated);
        }
      }
    }
  } while (cursor);

  return results;
}

// ── PART 2: SUPABASE staged_images ───────────────────────────────────────

async function migrateStagedImages(log) {
  const results = [];
  const res = await supabase("GET", "staged_images", null,
    `?or=(cloudinary_original_url.like.*cloudinary*,cloudinary_staged_url.like.*cloudinary*)&select=id,listing_id,cloudinary_original_url,cloudinary_staged_url`
  );
  const rows = res.data || [];

  for (const row of rows) {
    const patch = {};

    if (isCloudinaryUrl(row.cloudinary_original_url)) {
      const s3Key = `smart-stage-originals/${row.listing_id}/${crypto.randomUUID()}.jpg`;
      try {
        patch.cloudinary_original_url = await migrateOneAsset(row.cloudinary_original_url, s3Key, false);
        log(`staged_images OK: row ${row.id} / original`);
      } catch (err) {
        results.push({ ok: false, table: "staged_images", id: row.id, field: "cloudinary_original_url", error: err.message });
        log(`staged_images FAIL: row ${row.id} / original - ${err.message}`);
      }
    }
    if (isCloudinaryUrl(row.cloudinary_staged_url)) {
      const s3Key = `smart-stage-finals/${row.listing_id}/${crypto.randomUUID()}.jpg`;
      try {
        patch.cloudinary_staged_url = await migrateOneAsset(row.cloudinary_staged_url, s3Key, false);
        log(`staged_images OK: row ${row.id} / staged`);
      } catch (err) {
        results.push({ ok: false, table: "staged_images", id: row.id, field: "cloudinary_staged_url", error: err.message });
        log(`staged_images FAIL: row ${row.id} / staged - ${err.message}`);
      }
    }

    if (Object.keys(patch).length) {
      await supabase("PATCH", "staged_images", patch, `?id=eq.${row.id}`);
      results.push({ ok: true, table: "staged_images", id: row.id, patched: Object.keys(patch) });
    }
  }

  return results;
}

// ── PART 3: SUPABASE video_jobs ──────────────────────────────────────────

async function migrateVideoJobs(log) {
  const results = [];
  const res = await supabase("GET", "video_jobs", null,
    `?or=(output_16x9_url.like.*cloudinary*,output_9x16_url.like.*cloudinary*)&select=id,project_id,output_16x9_url,output_9x16_url`
  );
  const rows = res.data || [];

  for (const row of rows) {
    const patch = {};

    for (const [field, formatLabel] of [["output_16x9_url", "16x9"], ["output_9x16_url", "9x16"]]) {
      if (!isCloudinaryUrl(row[field])) continue;
      const s3Key = `smart-stage-videos/${row.project_id}/video_${formatLabel}_${Date.now()}_${crypto.randomUUID()}.mp4`;
      try {
        patch[field] = await migrateOneAsset(row[field], s3Key, true);
        log(`video_jobs OK: row ${row.id} / ${formatLabel}`);
      } catch (err) {
        results.push({ ok: false, table: "video_jobs", id: row.id, field, error: err.message });
        log(`video_jobs FAIL: row ${row.id} / ${formatLabel} - ${err.message}`);
      }
    }

    if (Object.keys(patch).length) {
      await supabase("PATCH", "video_jobs", patch, `?id=eq.${row.id}`);
      results.push({ ok: true, table: "video_jobs", id: row.id, patched: Object.keys(patch) });
    }
  }

  return results;
}

// ── HANDLER ──────────────────────────────────────────────────────────────

exports.handler = async (event) => {
  const headers = { "Content-Type": "application/json" };

  const providedSecret = event.queryStringParameters?.secret;
  if (!process.env.MIGRATION_SECRET || providedSecret !== process.env.MIGRATION_SECRET) {
    return { statusCode: 403, headers, body: JSON.stringify({ error: "Missing or incorrect ?secret=" }) };
  }

  const logLines = [];
  const log = (msg) => { console.log(msg); logLines.push(msg); };

  try {
    const blobsResults  = await migrateBlobsProjects(log);
    const stagedResults = await migrateStagedImages(log);
    const videoResults  = await migrateVideoJobs(log);

    const all = [...blobsResults, ...stagedResults, ...videoResults];
    const failures = all.filter(r => !r.ok);

    return {
      statusCode: 200,
      headers,
      body: JSON.stringify({
        totalOperations: all.length,
        succeeded: all.length - failures.length,
        failed: failures.length,
        failures,
        blobsResults,
        stagedResults,
        videoResults,
      }, null, 2),
    };
  } catch (err) {
    console.error("migrate-listing-media error:", err.message);
    return { statusCode: 500, headers, body: JSON.stringify({ error: err.message, log: logLines }) };
  }
};
