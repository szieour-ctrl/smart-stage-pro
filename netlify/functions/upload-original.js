// upload-original.js — Netlify Function
// AB 723 §10140.8 Compliance — Step 1
// Uploads the original unaltered listing photo to S3.
// Returns a permanent public URL used in QR code and disclosure text.
//
// Called ONCE per photo, lazily — at Generate Final time, not at initial
// photo-picker upload (confirmed directly in index.html: the only fetch
// call to this function is inside attachFinalToProject(), guarded by
// `if (orig && !orig.originalUrl && SESSION.projectId)`). By that point
// room.roomName is already known and already being sent in the request
// body — this function just wasn't reading it until now.
//
// Input:  imageBase64, mimeType, projectId, roomName
// Output: publicUrl, thumbnailUrl, s3Key
//
// Public access comes from a bucket policy scoped to smart-stage-originals/*,
// smart-stage-finals/*, listings/*, and smart-stage-thumbnails/*, NOT from
// object ACLs (this bucket has ACLs disabled — Bucket owner enforced).
//
// KEY NAMING (Aug 28, 2026 — readable-key migration):
// When the listing behind projectId has a resolvable slug (new listings,
// or old ones lazily backfilled by project-manage.js), the key is:
//   listings/{slug}/originals/{room-slug}-{seq}.{ext}
// and a matching row is written to Supabase media_assets, making the
// whole bucket queryable by listing/room/type instead of only browsable
// by UUID. If Supabase is unreachable or the listing has no slug yet
// (e.g. SUPABASE_URL not configured, or no listing row at all for this
// projectId), this falls back to the original UUID scheme so an upload
// NEVER fails just because the catalog side had a problem:
//   smart-stage-originals/{projectId}/{uuid}.{ext}
// Existing objects already written under the old scheme are untouched —
// this only affects new uploads going forward.
//
// HEIC HANDLING (added this session): the "original unaltered listing
// photo" this file stores is meant to be viewable everywhere (QR code,
// MLS disclosure links, agent's own browser) — but HEIC has no native
// browser decoder outside Safari, and sharp's build here typically has
// no libheif support, so resize()-based thumbnail generation below would
// throw on real HEIC bytes. Converting to JPEG up front, before the
// ext/contentType decision, fixes both that AND a separate mislabeling
// bug: previously a HEIC upload would fall through the ext ternary to
// ".jpg" while the actual stored bytes were still HEIC — this made the
// S3 object's extension lie about its own contents. Uses heic-convert
// (pure JS) rather than sharp, matching stage-image.js's approach.

const crypto = require("crypto");
const https = require("https");
const sharp = require("sharp");
const heicConvert = require("heic-convert");
const { S3Client, PutObjectCommand } = require("@aws-sdk/client-s3");

const s3 = new S3Client({
  region: process.env.S3_REGION,
  credentials: {
    accessKeyId: process.env.S3_ACCESS_KEY_ID,
    secretAccessKey: process.env.S3_SECRET_ACCESS_KEY,
  },
});

const THUMBNAIL_MAX_DIM = 400;

// ── HEIC DETECTION + CONVERSION (see file header note) ──────────────────────
// Same detection logic as stage-image.js: mimeType is checked first, but
// iPhone/Safari uploads can arrive with an empty or generic mimeType, so
// the actual file bytes (ISO-BMFF "ftyp" box + brand) are checked as a
// fallback rather than trusting mimeType alone.
function isHeic(buffer, mimeType) {
  if (mimeType && /^image\/(heic|heif)/i.test(mimeType)) return true;
  if (!buffer || buffer.length < 12) return false;
  if (buffer.toString("ascii", 4, 8) !== "ftyp") return false;
  const brand = buffer.toString("ascii", 8, 12).toLowerCase();
  return ["heic", "heix", "hevc", "hevx", "heim", "heis", "hevm", "hevs", "mif1", "msf1"].includes(brand);
}

async function convertHeicIfNeeded(buffer, mimeType) {
  if (!isHeic(buffer, mimeType)) return { buffer, mimeType: mimeType || "image/jpeg", converted: false };
  console.log("upload-original: HEIC input detected, converting to JPEG before storing");
  const jpegBuffer = await heicConvert({ buffer, format: "JPEG", quality: 0.92 });
  return { buffer: Buffer.from(jpegBuffer), mimeType: "image/jpeg", converted: true };
}

// ── SUPABASE HELPER (same shape as project-manage.js's) ─────────────────────

function supabase(method, table, body, queryParams = "") {
  return new Promise((resolve, reject) => {
    const url = new URL(`${process.env.SUPABASE_URL}/rest/v1/${table}${queryParams}`);
    const bodyStr = body ? JSON.stringify(body) : null;
    const req = https.request({
      hostname: url.hostname,
      path: url.pathname + url.search,
      method,
      headers: {
        "apikey": process.env.SUPABASE_SERVICE_ROLE_KEY,
        "Authorization": `Bearer ${process.env.SUPABASE_SERVICE_ROLE_KEY}`,
        "Content-Type": "application/json",
        "Prefer": "return=representation",
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

// ── SLUG HELPERS ──────────────────────────────────────────────────────────

function slugifyAddress(address) {
  return (address || "")
    .toLowerCase()
    .replace(/,.*$/, "")          // drop city/state — street address only
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 60);
}

function slugifyRoom(roomName) {
  return (roomName || "room")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 40) || "room";
}

// Resolves projectId -> listing slug + prospecting flag. Returns null
// (never throws) if Supabase isn't configured, the listing can't be found,
// or anything else goes wrong — every caller treats null as "use the
// legacy naming."
async function lookupListingSlug(projectId) {
  if (!projectId || !process.env.SUPABASE_URL) return null;
  try {
    const res = await supabase("GET", "listings", null,
      `?project_id=eq.${encodeURIComponent(projectId)}&select=slug,address,is_prospecting&limit=1`
    );
    const row = res.data?.[0];
    if (!row) {
      console.log("upload-original lookupListingSlug: no listings row found for projectId", projectId);
      return null;
    }
    const isProspecting = !!row.is_prospecting;
    // DIAGNOSTIC (Aug 29, 2026) — this is the value that actually decides
    // the S3 folder for THIS upload, read fresh from Supabase right now.
    // If this logs false while Supabase's own row shows true, projectId
    // here doesn't match the row you checked (e.g. an older/duplicate row
    // for the same address). If it logs true, the folder routing below is
    // correct and the bug is elsewhere.
    console.log("upload-original lookupListingSlug: projectId", projectId, "-> slug:", row.slug, "isProspecting:", isProspecting);
    if (row.slug) return { slug: row.slug, isProspecting };

    // Listing row predates the slug column — derive one now and best-effort
    // patch it back so future uploads for this listing skip this branch.
    const derived = slugifyAddress(row.address);
    if (derived) {
      // AWAITED (Aug 28, 2026 — fixed a real bug, not a hypothesis):
      // this used to be fire-and-forget (no await, just .catch()). Netlify
      // Functions can freeze/tear down the execution environment the
      // moment the handler's response is sent — confirmed directly via
      // live testing: the patch was silently losing that race almost
      // every time, so the write frequently never completed. Must be
      // awaited before this function (and therefore the handler) returns.
      try {
        await supabase("PATCH", "listings", { slug: derived }, `?project_id=eq.${encodeURIComponent(projectId)}`);
      } catch (e) {
        console.error("lookupListingSlug: slug backfill patch failed (non-fatal):", e.message);
      }
    }
    return derived ? { slug: derived, isProspecting } : null;
  } catch (err) {
    console.error("lookupListingSlug error (non-fatal, falling back to legacy naming):", err.message);
    return null;
  }
}

// Reserves a unique, readable S3 key by inserting the media_assets row
// FIRST (the table's unique constraint on s3_key is what actually
// prevents a collision) and only handing back the key once that insert
// succeeds. If two uploads for the same listing+room land at the same
// moment, the loser of the race just gets bumped to the next sequence
// number and retries — nothing ever gets silently overwritten in S3.
// Returns null (never throws) on repeated failure, so the caller can fall
// back to the legacy UUID key instead of blocking the whole upload.
//
// isProspecting (Aug 28, 2026): a prospecting shot (vacant home, single
// image sent to the listing agent, not yet a signed listing) routes to a
// separate staging-prospects/ top-level prefix instead of listings/, so it's
// never mixed into production inventory or the Gallery page, and can carry
// its own (shorter) S3 lifecycle rule.
async function reserveAssetKey({ listingSlug, room, imageType, ext, isProspecting }) {
  const roomSlug = slugifyRoom(room);
  const typeFolder = imageType === "original" ? "originals" : "finals";
  const rootFolder = isProspecting ? "staging-prospects" : "listings";
  const baseFolder = `${rootFolder}/${listingSlug}/${typeFolder}`;

  let seq = 1;
  try {
    const countRes = await supabase("GET", "media_assets", null,
      `?listing_slug=eq.${encodeURIComponent(listingSlug)}&room=eq.${encodeURIComponent(room)}&image_type=eq.${imageType}&select=id`
    );
    if (Array.isArray(countRes.data)) seq = countRes.data.length + 1;
  } catch (err) {
    console.error("reserveAssetKey: count lookup failed, starting at seq 1 (non-fatal):", err.message);
  }

  for (let attempt = 0; attempt < 5; attempt++) {
    const key = `${baseFolder}/${roomSlug}-${String(seq).padStart(2, "0")}.${ext}`;
    try {
      const insertRes = await supabase("POST", "media_assets", {
        listing_slug: listingSlug,
        room,
        image_type: imageType,
        s3_key: key,
      });
      if (insertRes.status === 201 || insertRes.status === 200) return key;
      // Any other status (most likely 409 — unique violation on s3_key,
      // another upload took this sequence number first) — bump and retry.
      console.warn(`reserveAssetKey: key ${key} unavailable (status ${insertRes.status}), trying seq ${seq + 1}`);
    } catch (err) {
      console.error(`reserveAssetKey: insert attempt failed for ${key} (non-fatal, retrying):`, err.message);
    }
    seq++;
  }
  console.error(`reserveAssetKey: failed to reserve a key after 5 attempts for ${listingSlug}/${room} — falling back to legacy naming`);
  return null;
}

exports.handler = async (event) => {
  if (event.httpMethod !== "POST") return { statusCode: 405, body: "Method Not Allowed" };

  const headers = {
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Headers": "Content-Type",
    "Content-Type": "application/json",
  };

  try {
    const { imageBase64, mimeType, projectId, roomName } = JSON.parse(event.body || "{}");
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

    // HEIC conversion happens FIRST, before contentType/ext are decided —
    // otherwise a HEIC upload gets mislabeled ".jpg" while still HEIC bytes.
    const rawBuffer = Buffer.from(imageBase64, "base64");
    const { buffer, mimeType: resolvedMimeType } = await convertHeicIfNeeded(rawBuffer, mimeType);

    const contentType = resolvedMimeType || "image/jpeg";
    const ext = contentType.includes("png") ? "png" : "jpg";

    // ── Determine key: readable if we can resolve a listing slug, legacy otherwise ──
    let key = null;
    let usedReadableKey = false;
    const listingInfo = await lookupListingSlug(projectId);
    if (listingInfo) {
      key = await reserveAssetKey({ listingSlug: listingInfo.slug, room: roomName || "Room", imageType: "original", ext, isProspecting: listingInfo.isProspecting });
      if (key) usedReadableKey = true;
    }
    if (!key) {
      const folder = projectId ? `smart-stage-originals/${projectId}` : "smart-stage-originals/unfiled";
      key = `${folder}/${crypto.randomUUID()}.${ext}`;
    }

    console.log(`Uploading original to S3 — size: ${Math.round(buffer.length / 1024)}KB projectId: ${projectId || "none"} key: ${key}`);

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

      const thumbKey = usedReadableKey
        ? key.replace("/originals/", "/thumbnails/")
        : `${projectId ? `smart-stage-thumbnails/${projectId}` : "smart-stage-thumbnails/unfiled"}/${crypto.randomUUID()}.jpg`;

      await s3.send(new PutObjectCommand({
        Bucket: bucket,
        Key: thumbKey,
        Body: thumbBuffer,
        ContentType: "image/jpeg",
      }));
      thumbnailUrl = `https://${bucket}.s3.${region}.amazonaws.com/${thumbKey}`;
      console.log(`Thumbnail uploaded: ${thumbnailUrl} (${Math.round(thumbBuffer.length / 1024)}KB)`);

      if (usedReadableKey) {
        // AWAITED — see lookupListingSlug's comment above for why this
        // can't be fire-and-forget in a serverless function.
        try {
          await supabase("PATCH", "media_assets", { thumbnail_key: thumbKey }, `?s3_key=eq.${encodeURIComponent(key)}`);
        } catch (e) {
          console.error("upload-original: thumbnail_key patch failed (non-fatal):", e.message);
        }
      }
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
