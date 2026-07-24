// hide-image.js — Netlify Function
// Smart Stage PRO™ — lets an agent police their own compliance page.
//
// Soft-hides (or restores) a single staged image. Nothing is ever deleted —
// AB 723 §10140.6/§10140.8 requires a 3-year retention record, so the image
// stays in project.images permanently. "Hidden" only controls whether it
// renders on the public compliance page (compliance-page.js) or in the
// normal My Listings dashboard (get-user-listings.js). A full hiddenHistory
// audit trail is kept on the image entry itself — if a hide/unhide is ever
// questioned, you can show exactly when, by whom, and why.
//
// Access mirrors get-user-listings.js's role model: an owner can hide their
// own listing's images; a team_lead can hide any image on a same-team
// listing; a broker_admin can hide any image in the brokerage.
//
// Routes via ?action= parameter:
//   action=hide         — POST { projectId, imageId, reason? }
//   action=unhide        — POST { projectId, imageId, reason? }
//   action=list-hidden   — GET  ?projectId=proj_xxx
//
// Requires Authorization: Bearer <supabase jwt> for all actions.

const { getStore } = require("@netlify/blobs");
const https = require("https");

// Locks/unlocks the actual Cloudinary asset, not just our own page's
// reference to it. Hiding an image from compliance-page.js and
// get-user-listings.js is necessary but not sufficient — if the raw
// Cloudinary URL is still public, a cached link, a search index, or
// anyone who saved the direct URL earlier can still open it. Flipping
// access_mode to "authenticated" makes the CDN itself return 401 for the
// exact same URL, everywhere, immediately.
const cloudinary = require("cloudinary").v2;
cloudinary.config({
  cloud_name: process.env.CLOUDINARY_CLOUD_NAME,
  api_key:    process.env.CLOUDINARY_API_KEY,
  api_secret: process.env.CLOUDINARY_API_SECRET,
});

// Parses a standard (non-authenticated) Cloudinary delivery URL to recover
// its resource_type and public_id, e.g.:
//   https://res.cloudinary.com/{cloud}/image/upload/v169.../folder/name.jpg
// Assumes these stored URLs are plain secure_url values from upload (no
// transformation segments) — true for how project-manage.js stores them.
// Returns null on anything unexpected rather than throwing, since a parse
// miss must not block the Blobs-side hide from succeeding.
function parseCloudinaryAsset(url) {
  if (!url) return null;
  try {
    const match = url.match(/\/(image|video|raw)\/upload\/(?:v\d+\/)?(.+)\.(\w+)(?:\?.*)?$/);
    if (!match) return null;
    const [, resourceType, publicId] = match;
    return { resourceType, publicId };
  } catch (e) {
    return null;
  }
}

// Sets access_mode on one Cloudinary asset. Non-fatal by design — same
// pattern as every other Supabase/Cloudinary side-call in this codebase:
// the Blobs hidden flag is the authoritative state; this is defense in
// depth on top of it, and a Cloudinary API hiccup must never block the
// actual hide/unhide from completing.
async function setCloudinaryAccess(url, mode) {
  const parsed = parseCloudinaryAsset(url);
  if (!parsed) {
    console.error("hide-image: could not parse Cloudinary public_id from", url);
    return { ok: false, url };
  }
  try {
    await cloudinary.api.update(parsed.publicId, {
      resource_type: parsed.resourceType,
      type: "upload",
      access_mode: mode, // "authenticated" to lock, "public" to restore
    });
    return { ok: true, url };
  } catch (err) {
    console.error("hide-image: Cloudinary access_mode update failed for", url, "-", err.message);
    return { ok: false, url, error: err.message };
  }
}

// ── SUPABASE HELPER ──────────────────────────────────────────────────────────

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

function verifyJWT(authHeader) {
  return new Promise((resolve) => {
    if (!authHeader || !authHeader.startsWith("Bearer ")) { resolve(null); return; }
    const jwt = authHeader.split(" ")[1];
    const url = new URL(`${process.env.SUPABASE_URL}/auth/v1/user`);
    const req = https.request({
      hostname: url.hostname, path: url.pathname, method: "GET",
      headers: {
        "apikey":        process.env.SUPABASE_SERVICE_ROLE_KEY,
        "Authorization": `Bearer ${jwt}`
      }
    }, res => {
      let data = "";
      res.on("data", c => data += c);
      res.on("end", () => {
        try {
          const parsed = JSON.parse(data);
          resolve(res.statusCode === 200 && parsed.id ? parsed : null);
        } catch { resolve(null); }
      });
    });
    req.on("error", () => resolve(null));
    req.end();
  });
}

// ── NETLIFY BLOBS STORE ──────────────────────────────────────────────────────

function getProjectStore() {
  return getStore({
    name: "smart-stage-projects",
    siteID: process.env.NETLIFY_SITE_ID,
    token: process.env.NETLIFY_ACCESS_TOKEN,
  });
}

// Matches project-manage.js's addressHash exactly — needed to also update
// the addr_ key, since Blobs stores each project under two keys (pid_ and
// addr_) that must stay in sync.
function addressHash(address) {
  const crypto = require("crypto");
  const normalized = (address || "").toLowerCase()
    .replace(/\s+/g, " ")
    .replace(/[^a-z0-9\s,]/g, "")
    .trim();
  return crypto.createHash("md5").update(normalized).digest("hex").slice(0, 16);
}

// ── ACCESS CHECK ──────────────────────────────────────────────────────────
// Same role model as get-user-listings.js: owner, or team_lead over their
// team's listings, or broker_admin over their whole brokerage.

async function checkAccess(projectId, authUser) {
  const userResult = await supabase("GET", "users", null,
    `?id=eq.${authUser.id}&select=id,role,team_id,brokerage_id`
  );
  const user = userResult.data?.[0];
  if (!user) return { error: "User record not found", status: 404 };

  const listingResult = await supabase("GET", "listings", null,
    `?project_id=eq.${projectId}&select=id,user_id,team_id,brokerage_id,address`
  );
  const listing = listingResult.data?.[0];
  if (!listing) return { error: "Listing not found", status: 404 };

  const owns =
    listing.user_id === authUser.id ||
    (user.role === "team_lead"   && user.team_id      && listing.team_id      === user.team_id) ||
    (user.role === "broker_admin" && user.brokerage_id && listing.brokerage_id === user.brokerage_id);

  if (!owns) return { error: "Access denied", status: 403 };
  return { listing, user };
}

// ── HANDLER ──────────────────────────────────────────────────────────────────

exports.handler = async (event) => {
  const headers = {
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Headers": "Content-Type, Authorization",
    "Content-Type": "application/json",
  };

  if (event.httpMethod === "OPTIONS") return { statusCode: 200, headers, body: "" };

  const authUser = await verifyJWT(event.headers.authorization || event.headers.Authorization);
  if (!authUser) return { statusCode: 401, headers, body: JSON.stringify({ error: "Unauthorized" }) };

  const action = event.queryStringParameters?.action;

  try {
    // ── LIST HIDDEN — for the "Review Hidden" view, scoped to one property ──
    if (action === "list-hidden") {
      if (event.httpMethod !== "GET") return { statusCode: 405, headers, body: JSON.stringify({ error: "Method Not Allowed" }) };

      const projectId = event.queryStringParameters?.projectId;
      if (!projectId) return { statusCode: 400, headers, body: JSON.stringify({ error: "Missing projectId" }) };

      const access = await checkAccess(projectId, authUser);
      if (access.error) return { statusCode: access.status, headers, body: JSON.stringify({ error: access.error }) };

      const store = getProjectStore();
      const raw = await store.get("pid_" + projectId);
      if (!raw) return { statusCode: 404, headers, body: JSON.stringify({ error: "Project not found" }) };

      const project = JSON.parse(raw);
      const hiddenImages = (project.images || []).filter(img => img.hidden);

      return {
        statusCode: 200, headers,
        body: JSON.stringify({
          projectId,
          address: project.address,
          hiddenImages,
        })
      };
    }

    // ── LIST VISIBLE — the normal published gallery for one property, full
    // list (not the 5-thumbnail cap get-user-listings.js uses for the card
    // preview) — this is what backs the "Hide from Compliance Page" button
    // per image, kept as a separate call from list-hidden so the two views
    // never accidentally merge on the front end.
    if (action === "list-visible") {
      if (event.httpMethod !== "GET") return { statusCode: 405, headers, body: JSON.stringify({ error: "Method Not Allowed" }) };

      const projectId = event.queryStringParameters?.projectId;
      if (!projectId) return { statusCode: 400, headers, body: JSON.stringify({ error: "Missing projectId" }) };

      const access = await checkAccess(projectId, authUser);
      if (access.error) return { statusCode: access.status, headers, body: JSON.stringify({ error: access.error }) };

      const store = getProjectStore();
      const raw = await store.get("pid_" + projectId);
      if (!raw) return { statusCode: 404, headers, body: JSON.stringify({ error: "Project not found" }) };

      const project = JSON.parse(raw);
      const visibleImages = (project.images || []).filter(img => !img.hidden);

      return {
        statusCode: 200, headers,
        body: JSON.stringify({
          projectId,
          address: project.address,
          visibleImages,
        })
      };
    }

    // ── HIDE / UNHIDE ──────────────────────────────────────────────────────
    if (action === "hide" || action === "unhide") {
      if (event.httpMethod !== "POST") return { statusCode: 405, headers, body: JSON.stringify({ error: "Method Not Allowed" }) };

      let body;
      try { body = JSON.parse(event.body || "{}"); }
      catch { return { statusCode: 400, headers, body: JSON.stringify({ error: "Invalid JSON" }) }; }

      const { projectId, imageId, reason } = body;
      if (!projectId) return { statusCode: 400, headers, body: JSON.stringify({ error: "Missing projectId" }) };
      if (!imageId)   return { statusCode: 400, headers, body: JSON.stringify({ error: "Missing imageId" }) };

      const access = await checkAccess(projectId, authUser);
      if (access.error) return { statusCode: access.status, headers, body: JSON.stringify({ error: access.error }) };

      const store = getProjectStore();
      const pidKey = "pid_" + projectId;
      const raw = await store.get(pidKey);
      if (!raw) return { statusCode: 404, headers, body: JSON.stringify({ error: "Project not found" }) };

      const project = JSON.parse(raw);
      const images = project.images || [];
      const target = images.find(img => img.imageId === imageId);

      if (!target) return { statusCode: 404, headers, body: JSON.stringify({ error: "Image not found in project" }) };

      const nowHide = action === "hide";

      // Lock (or restore) the actual Cloudinary assets — original, staged,
      // and side-by-side — so the underlying URLs stop resolving publicly
      // too, not just our own rendering of them. Run in parallel; a failure
      // on one field must not block the others or the Blobs-side hide.
      const urlFields = ["originalUrl", "stagedUrl", "sbsUrl"];
      const cloudinaryResults = await Promise.allSettled(
        urlFields
          .filter(f => target[f])
          .map(f => setCloudinaryAccess(target[f], nowHide ? "authenticated" : "public"))
      );
      const cloudinaryFailures = cloudinaryResults
        .map(r => r.status === "fulfilled" ? r.value : { ok: false, error: r.reason?.message })
        .filter(r => !r.ok);
      if (cloudinaryFailures.length) {
        console.error("hide-image: Cloudinary lock incomplete for", imageId, "-", JSON.stringify(cloudinaryFailures));
      }

      // Mirror onto the matching staged_images row too — this is the row
      // PRO Plus's video builder actually reads (video-job.js's
      // getFramesForListing() queries staged_images directly, never
      // Netlify Blobs). Non-fatal: the Blobs flag + Cloudinary lock above
      // are already authoritative for the compliance page and dashboard;
      // this is defense in depth so a hidden image can't be pulled into a
      // video either. Matched by listing_id + the staged image URL, since
      // the original staged_images insert never stored this Blobs imageId
      // (see project-manage.js's addImage()). Requires a `hidden` boolean
      // column on staged_images — if it doesn't exist yet, this silently
      // no-ops (logged) rather than blocking the hide/unhide itself.
      if (target.stagedUrl) {
        try {
          await supabase("PATCH", "staged_images",
            { hidden: nowHide },
            `?listing_id=eq.${access.listing.id}&cloudinary_staged_url=eq.${encodeURIComponent(target.stagedUrl)}`
          );
        } catch (err) {
          console.error("hide-image: staged_images hidden sync failed (non-fatal) for", imageId, "-", err.message);
        }
      }

      // Idempotent — hiding an already-hidden image (or unhiding a visible
      // one) is a no-op on state but still logs the attempt in history,
      // since a repeated action can itself be meaningful in an audit trail.
      target.hidden = nowHide;
      target.hiddenHistory = target.hiddenHistory || [];
      target.hiddenHistory.push({
        action:   nowHide ? "hidden" : "unhidden",
        at:       new Date().toISOString(),
        by:       authUser.id,
        reason:   reason || null,
        cloudinaryLockIncomplete: cloudinaryFailures.length > 0 || undefined,
      });

      project.updatedAt = new Date().toISOString();

      const updated = JSON.stringify(project);
      const addrKey = "addr_" + addressHash(project.address);
      await store.set(pidKey, updated);
      await store.set(addrKey, updated);

      console.log(
        (nowHide ? "Hid" : "Unhid"), "image", imageId, "in project", projectId,
        "by user", authUser.id, reason ? ("— reason: " + reason) : ""
      );

      return {
        statusCode: 200, headers,
        body: JSON.stringify({
          success: true,
          imageId,
          hidden: nowHide,
          cloudinaryLockComplete: cloudinaryFailures.length === 0,
        })
      };
    }

    return { statusCode: 400, headers, body: JSON.stringify({ error: "Unknown action: " + action }) };

  } catch (err) {
    console.error("hide-image error:", err.message);
    return { statusCode: 500, headers, body: JSON.stringify({ error: err.message }) };
  }
};
