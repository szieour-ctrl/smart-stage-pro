// upload-staged.js — Netlify Function
// Issues a presigned S3 PUT URL for a staged Final image (or a Hero Shot —
// same asset shape, just a different roomName value).
// Called after generateFinal completes, before project-manage add-image.
//
// Same reason this exists as before: a large final image in the request
// body can exceed the platform's payload ceiling before this function's
// own code ever runs. The image never passes through our infrastructure —
// the browser PUTs the bytes directly to the presigned URL.
//
// Input:  { projectId, roomName }
// Output: { uploadUrl, publicUrl, s3Key }
//
// NOTE: staged finals are PUBLIC by default (bucket policy covers
// smart-stage-finals/*, listings/*, staging-prospects/*, and
// smart-stage-thumbnails/* the same way) — this matches Cloudinary's
// prior default behavior. Per-image locking (the "hide this listing"
// case in hide-image.js) is a separate, later migration — it needs real
// per-object access control, not solved here.
//
// KEY NAMING (Aug 28, 2026 — readable-key migration):
// roomName is a NEW input — both call sites in index.html already have
// room.roomName / shot.name in scope at the moment they call this
// function, they just weren't sending it. When a listing slug can be
// resolved for projectId, the key becomes:
//   listings/{slug}/finals/{room-slug}-{seq}.jpg
// with a matching Supabase media_assets row. Falls back to the legacy
// UUID scheme (unchanged) if Supabase isn't configured, the listing has
// no slug, or roomName is missing — a presign request should never fail
// just because the catalog side had a problem.
//
// PIPELINE SEPARATION (Sep 16, 2026): mirrors the identical change in
// upload-original.js — see that file's header comment for the full
// reasoning. If projectId doesn't resolve to a Listing, this now tries
// the new lookupProspectSlug() sibling (querying the `prospects` table)
// before falling back to legacy naming. A Prospecting final lands in the
// same flat staging-prospects/{slug}/ folder as its original, meta.json,
// and qr.png — no media_assets row, no originals/finals subfolder split.

const crypto = require("crypto");
const https = require("https");
const { S3Client, PutObjectCommand } = require("@aws-sdk/client-s3");
const { getSignedUrl } = require("@aws-sdk/s3-request-presigner");

const s3 = new S3Client({
  region: process.env.S3_REGION,
  credentials: {
    accessKeyId: process.env.S3_ACCESS_KEY_ID,
    secretAccessKey: process.env.S3_SECRET_ACCESS_KEY,
  },
});

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
    .replace(/,.*$/, "")
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

// Mirrors upload-original.js's identical helper — see that file's comment.
function slugifyProspectAddress(address, projectId) {
  const m = /_(\d{2})(\d{2})(\d{2})_[a-z0-9]{4}$/i.exec(projectId || "");
  const datePrefix = m ? `20${m[3]}-${m[1]}-${m[2]}` : new Date().toISOString().slice(0, 10);
  return `${datePrefix}__${slugifyAddress(address)}`;
}

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
      // AWAITED (Aug 28, 2026 — fixed a real bug, not a hypothesis): see
      // upload-original.js's matching lookupListingSlug for the full
      // explanation — Netlify Functions can tear down before an
      // un-awaited background write like this one completes.
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

// NEW (Sep 16, 2026 — pipeline separation): see upload-original.js's
// identical sibling for the full reasoning.
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

// Same reserve-by-insert-first pattern as upload-original.js — see that
// file's comment for why the Supabase insert happens before the S3 write
// is even attempted. LISTINGS ONLY as of Sep 16, 2026 — Prospecting uses
// prospectAssetKey() below instead, which never touches media_assets.
async function reserveAssetKey({ listingSlug, room }) {
  const roomSlug = slugifyRoom(room);
  const baseFolder = `listings/${listingSlug}/finals`;

  let seq = 1;
  try {
    const countRes = await supabase("GET", "media_assets", null,
      `?listing_slug=eq.${encodeURIComponent(listingSlug)}&room=eq.${encodeURIComponent(room)}&image_type=eq.final&select=id`
    );
    if (Array.isArray(countRes.data)) seq = countRes.data.length + 1;
  } catch (err) {
    console.error("reserveAssetKey: count lookup failed, starting at seq 1 (non-fatal):", err.message);
  }

  for (let attempt = 0; attempt < 5; attempt++) {
    const key = `${baseFolder}/${roomSlug}-${String(seq).padStart(2, "0")}.jpg`;
    try {
      const insertRes = await supabase("POST", "media_assets", {
        listing_slug: listingSlug,
        room,
        image_type: "final",
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

// NEW (Sep 16, 2026): mirrors upload-original.js's prospectAssetKey() —
// see that file's comment for the full reasoning. "staged" prefix instead
// of "original", same flat folder.
function prospectAssetKey({ slug, room }) {
  const roomSlug = slugifyRoom(room);
  const rand = crypto.randomBytes(3).toString("hex").slice(0, 6);
  return `staging-prospects/${slug}/staged-${roomSlug}-${rand}.jpg`;
}

exports.handler = async (event) => {
  const headers = {
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Headers": "Content-Type",
    "Content-Type": "application/json",
  };

  if (event.httpMethod !== "POST") return { statusCode: 405, headers, body: "Method Not Allowed" };

  try {
    const { projectId, roomName } = JSON.parse(event.body || "{}");

    const bucket = process.env.S3_BUCKET_NAME;
    const region = process.env.S3_REGION;
    if (!bucket || !region) return {
      statusCode: 500, headers,
      body: JSON.stringify({ error: "S3_BUCKET_NAME or S3_REGION not configured" })
    };

    // ── Determine key: Listing, then Prospect, then legacy fallback ────────
    let key = null;
    if (roomName) {
      const listingInfo = await lookupListingSlug(projectId);
      if (listingInfo) {
        key = await reserveAssetKey({ listingSlug: listingInfo.slug, room: roomName });
      } else {
        const prospectInfo = await lookupProspectSlug(projectId);
        if (prospectInfo) key = prospectAssetKey({ slug: prospectInfo.slug, room: roomName });
      }
    }
    if (!key) {
      const folder = projectId ? `smart-stage-finals/${projectId}` : "smart-stage-finals";
      key = `${folder}/${crypto.randomUUID()}.jpg`;
    }

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
