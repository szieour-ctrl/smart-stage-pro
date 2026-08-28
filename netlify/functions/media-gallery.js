// media-gallery.js — Netlify Function
// Backend for gallery.html — the "Listing -> thumbnails -> room -> click ->
// copy URL" browsing tool. Reads ONLY from the media_assets/listings
// catalog added in the readable-S3-naming migration (Aug 28, 2026); it
// doesn't touch S3 or Netlify Blobs directly. Listings/photos uploaded
// before that migration simply won't have a slug/catalog rows and won't
// appear here — this is a browsing tool for the new naming scheme, not a
// replacement for the S3 console for old data.
//
// AUTH + SCOPING (Aug 28, 2026 — added after the first version of this
// file had NO auth at all and returned every subscriber's listings to
// anyone with the URL): every request needs a Supabase JWT, and results
// are scoped exactly the way get-user-listings.js already scopes the
// subscriber dashboard — solo sees own listings, team_lead sees the team,
// broker_admin sees the brokerage. Duplicated rather than shared, same
// per-file convention as the rest of this codebase.
//
// PLATFORM_ADMIN_USER_IDS is a NEW, separate mechanism — not a role in
// the users table. It's a comma-separated list of Supabase user IDs (set
// as a Netlify env var) that bypasses the team/brokerage scope entirely
// and sees every subscriber's listings. Deliberately kept out of the
// database and out of the normal role system: this only exists for Sam's
// own login, and an env var means it can be changed without a SQL
// migration and can never leak into the regular per-subscriber
// permission logic that scopeFilter() below implements for everyone else.
//
// action=search-listings  — { q } -> matching listings within the
//                            caller's scope (address search)
// action=assets            — { slug } -> catalog rows for one listing,
//                            WITH an ownership check against the same
//                            scope before returning anything — a signed-in
//                            subscriber can't bypass search and pull
//                            another subscriber's slug directly

const https = require("https");

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

// Same pattern as get-user-listings.js's verifyJWT — validates the bearer
// token directly against Supabase Auth rather than trusting anything the
// client claims about itself.
function verifyJWT(authHeader) {
  return new Promise((resolve) => {
    if (!authHeader || !authHeader.startsWith("Bearer ")) { resolve(null); return; }
    const jwt = authHeader.split(" ")[1];
    const url = new URL(`${process.env.SUPABASE_URL}/auth/v1/user`);
    const req = https.request({
      hostname: url.hostname, path: url.pathname, method: "GET",
      headers: {
        "apikey": process.env.SUPABASE_SERVICE_ROLE_KEY,
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

// Resolves the caller's authorization scope: their role/team/brokerage,
// and whether they're on the platform-admin allowlist. Returns null if
// there's no matching users row (mirrors get-user-listings.js's identical
// "User record not found" case).
async function getAuthorizedScope(authUser) {
  const userResult = await supabase("GET", "users", null,
    `?id=eq.${authUser.id}&select=id,role,team_id,brokerage_id`
  );
  const user = userResult.data?.[0];
  if (!user) return null;

  const adminIds = (process.env.PLATFORM_ADMIN_USER_IDS || "")
    .split(",").map(s => s.trim()).filter(Boolean);
  const isPlatformAdmin = adminIds.includes(authUser.id);

  return { user, isPlatformAdmin };
}

// Same three-tier logic as get-user-listings.js's listingsQuery branches,
// expressed as a PostgREST filter fragment instead of duplicated per call
// site. Empty string (platform admin) means no filter — sees everything.
function scopeFilter({ user, isPlatformAdmin }) {
  if (isPlatformAdmin) return "";
  if (user.role === "broker_admin" && user.brokerage_id) return `&brokerage_id=eq.${user.brokerage_id}`;
  if (user.role === "team_lead" && user.team_id) return `&team_id=eq.${user.team_id}`;
  return `&user_id=eq.${user.id}`;
}

function publicUrl(key) {
  if (!key) return null;
  const bucket = process.env.S3_BUCKET_NAME;
  const region = process.env.S3_REGION;
  return `https://${bucket}.s3.${region}.amazonaws.com/${key}`;
}

exports.handler = async (event) => {
  const headers = {
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Headers": "Content-Type, Authorization",
    "Content-Type": "application/json",
  };

  if (event.httpMethod === "OPTIONS") return { statusCode: 200, headers, body: "" };

  if (!process.env.SUPABASE_URL) {
    return { statusCode: 500, headers, body: JSON.stringify({ error: "SUPABASE_URL not configured" }) };
  }

  const authUser = await verifyJWT(event.headers.authorization || event.headers.Authorization);
  if (!authUser) {
    return { statusCode: 401, headers, body: JSON.stringify({ error: "Unauthorized" }) };
  }

  const scope = await getAuthorizedScope(authUser);
  if (!scope) {
    return { statusCode: 404, headers, body: JSON.stringify({ error: "User record not found" }) };
  }
  const filter = scopeFilter(scope);

  const action = event.queryStringParameters?.action;

  try {
    if (action === "search-listings") {
      const q = (event.queryStringParameters?.q || "").trim();
      const query = q
        ? `?slug=not.is.null${filter}&address=ilike.*${encodeURIComponent(q)}*&select=address,slug,project_id,created_at&order=created_at.desc&limit=25`
        : `?slug=not.is.null${filter}&select=address,slug,project_id,created_at&order=created_at.desc&limit=25`;
      const res = await supabase("GET", "listings", null, query);
      if (res.status >= 400) {
        return { statusCode: 500, headers, body: JSON.stringify({ error: "Listing search failed", detail: res.data }) };
      }
      return { statusCode: 200, headers, body: JSON.stringify({ listings: res.data || [] }) };
    }

    if (action === "assets") {
      const slug = event.queryStringParameters?.slug;
      if (!slug) return { statusCode: 400, headers, body: JSON.stringify({ error: "Missing slug" }) };

      // Ownership check BEFORE returning anything — without this, a
      // signed-in subscriber could bypass search-listings entirely by
      // guessing or being handed another subscriber's slug directly.
      const ownCheck = await supabase("GET", "listings", null,
        `?slug=eq.${encodeURIComponent(slug)}${filter}&select=id&limit=1`
      );
      if (!ownCheck.data?.[0]) {
        return { statusCode: 403, headers, body: JSON.stringify({ error: "Not authorized for this listing" }) };
      }

      const res = await supabase("GET", "media_assets", null,
        `?listing_slug=eq.${encodeURIComponent(slug)}&select=room,image_type,s3_key,thumbnail_key,created_at&order=room.asc,image_type.asc,s3_key.asc`
      );
      if (res.status >= 400) {
        return { statusCode: 500, headers, body: JSON.stringify({ error: "Asset lookup failed", detail: res.data }) };
      }

      const assets = (res.data || []).map(row => ({
        room: row.room || "Unassigned",
        imageType: row.image_type,
        url: publicUrl(row.s3_key),
        thumbnailUrl: publicUrl(row.thumbnail_key) || publicUrl(row.s3_key),
        s3Key: row.s3_key,
      }));

      return { statusCode: 200, headers, body: JSON.stringify({ assets }) };
    }

    return { statusCode: 400, headers, body: JSON.stringify({ error: "Unknown action: " + action }) };

  } catch (err) {
    console.error("media-gallery error:", err.message);
    return { statusCode: 500, headers, body: JSON.stringify({ error: err.message }) };
  }
};
