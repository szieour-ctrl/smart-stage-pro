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
// smart-stage-finals/*, listings/*, staging-prospects/*, and
// smart-stage-thumbnails/* (this bucket has ACLs disabled — Bucket owner
// enforced).
//
// KEY NAMING (Aug 28, 2026 — readable-key migration):
// When the listing behind projectId has a resolvable slug (new listings,
// or old ones lazily backfilled by project-manage.js), the key is:
//   listings/{slug}/originals/{room-slug}-{seq}.{ext}
// and a matching row is written to Supabase media_assets, making the
// whole bucket queryable by listing/room/type instead of only browsable
// by UUID. If Supabase is unreachable or the listing has no slug yet, this
// falls back to the original UUID scheme so an upload NEVER fails just
// because the catalog side had a problem:
//   smart-stage-originals/{projectId}/{uuid}.{ext}
// Existing objects already written under the old scheme are untouched —
// this only affects new uploads going forward.
//
// PIPELINE SEPARATION (Sep 16, 2026): Prospecting no longer lives in the
// `listings` table at all — see marketing-manage.js and the new
// `prospects` table. This file now tries lookupListingSlug() first, and
// only if that finds nothing does it try the new lookupProspectSlug()
// sibling below. A prospecting upload gets its own, much simpler
// treatment per Sam's explicit direction: "all data, images, and meta can
// be written and saved in the same folder" — one flat folder per
// prospect (staging-prospects/{slug}/), no originals/finals subfolder
// split, no media_assets row (that catalog exists for Gallery browsing,
// which already excludes Prospecting entirely — see media-gallery.js),
// and no thumbnail generation (nothing consumes a resized prospecting
// thumbnail; Sam/team pull full-res URLs directly). Skipping the whole
// media_assets/thumbnail mechanism for this pipeline also means it can
// never repeat the Sep 16 originals/finals thumbnail-collision bug —
// there's no shared sequence-numbering scheme left for two uploads to
// collide on.
//
// HEIC HANDLING (added this session): the "original unaltered listing
// photo" this file stores is meant to be viewable everywhere (QR code,
// MLS disclosure links, agent's own browser) — but HEIC has no native
// browser decoder outside Safari, and sharp's build here typically has
// no libheif support, so resize()-based thumbnail generation below would
// throw on real HEIC bytes. Converting to JPEG up front, before the
// ext/contentType decision, fixes both that AND a separate mislabeling
// bug: previously a HEIC upload would fall through the ext ternary to
// ".jpg" while the actual stored bytes were still HEIC. Uses heic-convert
// (pure JS) rather than sharp, matching stage-image.js's approach.
//
// THUMBNAIL COLLISION FIX (Sep 16, 2026 — Listings path only, see the
// header comment above for why Prospecting skips thumbnails entirely):
// the inline thumbKey used to collapse "/originals/" down to a flat
// "/thumbnails/" folder — generate-thumbnail.js did the same collapse for
// "/finals/" — and since seq numbers are counted independently per
// image_type, a room's original and final each started at seq 1
// independently, so the ordinary case of one original + one final per
// room produced the IDENTICAL thumbnail key from both files. The final's
// write always landed second and silently overwrote the original's
// thumbnail. Preserving the type segment (thumbnails/originals/... vs
// thumbnails/finals/...) makes the two paths structurally incapable of
// colliding.

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

// Date-prefixed slug for a prospect predating the slug column — mirrors
// marketing-manage.js's slugifyProspectAddress(). Tries to recover the
// TRUE creation date from the projectId itself (format:
// prospect_{addr}_{MMDDYY}_{rand4}) rather than defaulting to today's
// date, for the same reason project-manage.js's old extractProjectDate()
// did: this can run days after the shot was actually taken.
function slugifyProspectAddress(address, projectId) {
  const m = /_(\d{2})(\d{2})(\d{2})_[a-z0-9]{4}$/i.exec(projectId || "");
  const datePrefix = m ? `20${m[3]}-${m[1]}-${m[2]}` : new Date().toISOString().slice(0, 10);
  return `${datePrefix}__${slugifyAddress(address)}`;
}

// Resolves projectId -> listing slug. Returns null (never throws) if
// Supabase isn't configured, no listings row matches, or anything else
// goes wrong — callers treat null as "try lookupProspectSlug() next, then
// legacy naming as a last resort."
async function lookupListingSlug(projectId) {
  if (!projectId || !process.env.SUPABASE_URL) return null;
  try {
    const res = await supabase("GET", "listings", null,
      `?project_id=eq.${encodeURIComponent(projectId)}&select=slug,address&limit=1`
    );
    const row = res.data?.[0];
    if (!row) return null;
    if (row.slug) return { slug: row.slug };

    const derived = slugifyAddress(row.address);
    if (derived) {
      // AWAITED (Aug 28, 2026 — fixed a real bug, not a hypothesis):
      // Netlify Functions can freeze/tear down the execution environment
      // the moment the handler's response is sent — this must be awaited
      // before this function (and therefore the handler) returns.
      try {
        await supabase("PATCH", "listings", { slug: derived }, `?project_id=eq.${encodeURIComponent(projectId)}`);
      } catch (e) {
        console.error("lookupListingSlug: slug backfill patch failed (non-fatal):", e.message);
      }
    }
    return derived ? { slug: derived } : null;
  } catch (err) {
    console.error("lookupListingSlug error (non-fatal, trying prospects next):", err.message);
    return null;
  }
}

// NEW (Sep 16, 2026 — pipeline separation): the Marketing-side sibling of
// lookupListingSlug() above, querying the new `prospects` table instead
// of `listings`. Only ever reached when lookupListingSlug() found
// nothing — a projectId is either a Listing's or a Prospect's, never
// both, so trying the second table is cheap and only happens once per
// upload.
async function lookupProspectSlug(projectId) {
  if (!projectId || !process.env.SUPABASE_URL) return null;
  try {
    const res = await supabase("GET", "prospects", null,
      `?project_id=eq.${encodeURIComponent(projectId)}&select=slug,address&limit=1`
    );
    const row = res.data?.[0];
    if (!row) return null;
    if (row.slug) return { slug: row.slug };

    const derived = slugifyProspectAddress(row.address, projectId);
    if (derived) {
      try {
        await supabase("PATCH", "prospects", { slug: derived }, `?project_id=eq.${encodeURIComponent(projectId)}`);
      } catch (e) {
        console.error("lookupProspectSlug: slug backfill patch failed (non-fatal):", e.message);
      }
    }
    return derived ? { slug: derived } : null;
  } catch (err) {
    console.error("lookupProspectSlug error (non-fatal, falling back to legacy naming):", err.message);
    return null;
  }
}

// Reserves a unique, readable S3 key for a LISTING by inserting the
// media_assets row FIRST (the table's unique constraint on s3_key is what
// actually prevents a collision) and only handing back the key once that
// insert succeeds. If two uploads for the same listing+room land at the
// same moment, the loser of the race just gets bumped to the next
// sequence number and retries — nothing ever gets silently overwritten in
// S3. Returns null (never throws) on repeated failure, so the caller can
// fall back to the legacy UUID key instead of blocking the whole upload.
//
// LISTINGS ONLY (Sep 16, 2026): this used to also handle Prospecting via
// an isProspecting flag routing to a separate staging-prospects/ root.
// Prospecting now has its own, much simpler key function below
// (prospectAssetKey) that never touches media_assets at all — see file
// header for why.
async function reserveAssetKey({ listingSlug, room, imageType, ext }) {
  const roomSlug = slugifyRoom(room);
  const typeFolder = imageType === "original" ? "originals" : "finals";
  const baseFolder = `listings/${listingSlug}/${typeFolder}`;

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
      console.warn(`reserveAssetKey: key ${key} unavailable (status ${insertRes.status}), trying seq ${seq + 1}`);
    } catch (err) {
      console.error(`reserveAssetKey: insert attempt failed for ${key} (non-fatal, retrying):`, err.message);
    }
    seq++;
  }
  console.error(`reserveAssetKey: failed to reserve a key after 5 attempts for ${listingSlug}/${room} — falling back to legacy naming`);
  return null;
}

// NEW (Sep 16, 2026): the Prospecting/Marketing equivalent of
// reserveAssetKey() above — deliberately much simpler, per Sam's
// direction that Marketing has no compliance/disclosure ordering
// requirements at all. No media_assets row, no sequence counting, no
// Supabase round-trip before the key is usable — a random suffix is
// enough to avoid a same-room collision without needing to ask anything
// first, and no ordering guarantee is needed since nothing displays these
// images in a numbered sequence the way a Listing's Room Staging Queue
// does. Flat folder, one level: staging-prospects/{slug}/original-{room}-{rand}.{ext}
// or staging-prospects/{slug}/staged-{room}-{rand}.jpg — meta.json and
// qr.png (written by write-prospect-meta.js/generate-qr.js) already land
// in this exact same folder, satisfying "all data, images, and meta...
// in the same folder" literally.
function prospectAssetKey({ slug, room, imageType, ext }) {
  const roomSlug = slugifyRoom(room);
  const typePrefix = imageType === "original" ? "original" : "staged";
  const rand = crypto.randomBytes(3).toString("hex").slice(0, 6);
  return `staging-prospects/${slug}/${typePrefix}-${roomSlug}-${rand}.${ext}`;
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

    // ── Determine key: Listing, then Prospect, then legacy fallback ────────
    let key = null;
    let usedReadableKey = false;
    let isProspectUpload = false;

    const listingInfo = await lookupListingSlug(projectId);
    if (listingInfo) {
      key = await reserveAssetKey({ listingSlug: listingInfo.slug, room: roomName || "Room", imageType: "original", ext });
      if (key) usedReadableKey = true;
    } else {
      const prospectInfo = await lookupProspectSlug(projectId);
      if (prospectInfo) {
        key = prospectAssetKey({ slug: prospectInfo.slug, room: roomName || "Room", imageType: "original", ext });
        isProspectUpload = true;
      }
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

    // Thumbnail — LISTINGS ONLY. See file header for why Prospecting
    // skips this entirely. A missing thumbnail should never block the
    // actual upload from succeeding either way; the picker grid falls
    // back to the full-res URL when thumbnailUrl is absent (see index.html).
    let thumbnailUrl = null;
    if (!isProspectUpload) {
      try {
        const thumbBuffer = await sharp(buffer)
          .resize({ width: THUMBNAIL_MAX_DIM, height: THUMBNAIL_MAX_DIM, fit: "inside", withoutEnlargement: true })
          .jpeg({ quality: 80 })
          .toBuffer();

        // FIX (Sep 16, 2026) — see file header comment for the full
        // collision explanation. Preserves the "originals" segment
        // instead of collapsing it to a flat "/thumbnails/" folder,
        // matching the equivalent fix in generate-thumbnail.js for finals.
        const thumbKey = usedReadableKey
          ? key.replace(/\/(originals|finals)\//, "/thumbnails/$1/")
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
    }

    return {
      statusCode: 200,
      headers,
      body: JSON.stringify({
        publicUrl,     // permanent public URL — used in QR code (Listings) or the GPT/Pabbly pull (Prospecting)
        thumbnailUrl,  // small resized copy for the picker grid — null for Prospecting, and may be null for Listings on failure
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
