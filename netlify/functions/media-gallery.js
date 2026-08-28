// media-gallery.js — Netlify Function
// Backend for gallery.html — the "Listing -> thumbnails -> room -> click ->
// copy URL" browsing tool. Reads ONLY from the media_assets/listings
// catalog added in the readable-S3-naming migration (Aug 28, 2026); it
// doesn't touch S3 or Netlify Blobs directly. Listings/photos uploaded
// before that migration simply won't have a slug/catalog rows and won't
// appear here — this is a browsing tool for the new naming scheme, not a
// replacement for the S3 console for old data.
//
// Uses the same service-role Supabase access as project-manage.js — kept
// server-side so the service role key is never exposed to the browser.
//
// action=search-listings  — { q } -> matching listings (address search)
// action=assets            — { slug } -> all catalog rows for one listing,
//                             with full public URLs built from the S3
//                             bucket/region env vars (not stored per-row,
//                             so a bucket/region change never requires
//                             touching stored data)

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

function publicUrl(key) {
  if (!key) return null;
  const bucket = process.env.S3_BUCKET_NAME;
  const region = process.env.S3_REGION;
  return `https://${bucket}.s3.${region}.amazonaws.com/${key}`;
}

exports.handler = async (event) => {
  const headers = {
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Headers": "Content-Type",
    "Content-Type": "application/json",
  };

  if (event.httpMethod === "OPTIONS") return { statusCode: 200, headers, body: "" };

  if (!process.env.SUPABASE_URL) {
    return { statusCode: 500, headers, body: JSON.stringify({ error: "SUPABASE_URL not configured" }) };
  }

  const action = event.queryStringParameters?.action;

  try {
    if (action === "search-listings") {
      const q = (event.queryStringParameters?.q || "").trim();
      const query = q
        ? `?slug=not.is.null&address=ilike.*${encodeURIComponent(q)}*&select=address,slug,project_id,created_at&order=created_at.desc&limit=25`
        : `?slug=not.is.null&select=address,slug,project_id,created_at&order=created_at.desc&limit=25`;
      const res = await supabase("GET", "listings", null, query);
      if (res.status >= 400) {
        return { statusCode: 500, headers, body: JSON.stringify({ error: "Listing search failed", detail: res.data }) };
      }
      return { statusCode: 200, headers, body: JSON.stringify({ listings: res.data || [] }) };
    }

    if (action === "assets") {
      const slug = event.queryStringParameters?.slug;
      if (!slug) return { statusCode: 400, headers, body: JSON.stringify({ error: "Missing slug" }) };

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
