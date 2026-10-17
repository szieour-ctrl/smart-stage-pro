// listing-details.js — Netlify Function
// Smart Stage PRO™ — Listing Details (Oct 17, 2026)
//
// Beds / baths / sqft / year built for a listing (no price). Same access
// model as archive-listing.js: the owner, a same-team team_lead, or a
// same-brokerage broker_admin.
//
//   GET  ?listingId=<uuid>            → { details: { beds, baths, sqft, year_built } }
//   POST { listingId, beds?, baths?, sqft?, year_built? }
//        Only fields that are sent are changed; "" or null clears a field.
//
// Requires Authorization: Bearer <supabase jwt>.

const https = require("https");
const { validateDetails } = require("./lib/listing-details-lib");

const REQUEST_TIMEOUT_MS = 8000;
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

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
        ...(bodyStr ? { "Content-Length": Buffer.byteLength(bodyStr) } : {}),
      },
    }, res => {
      let data = "";
      res.on("data", c => data += c);
      res.on("end", () => {
        try { resolve({ status: res.statusCode, data: JSON.parse(data || "[]") }); }
        catch { resolve({ status: res.statusCode, data }); }
      });
    });
    req.setTimeout(REQUEST_TIMEOUT_MS, () => req.destroy(new Error(`Supabase ${method} ${table} timed out`)));
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
      headers: { "apikey": process.env.SUPABASE_SERVICE_ROLE_KEY, "Authorization": `Bearer ${jwt}` },
    }, res => {
      let data = "";
      res.on("data", c => data += c);
      res.on("end", () => {
        try { const p = JSON.parse(data); resolve(res.statusCode === 200 && p.id ? p : null); }
        catch { resolve(null); }
      });
    });
    req.setTimeout(REQUEST_TIMEOUT_MS, () => req.destroy());
    req.on("error", () => resolve(null));
    req.end();
  });
}

async function checkAccess(listingId, authUser) {
  const userResult = await supabase("GET", "users", null, `?id=eq.${authUser.id}&select=id,role,team_id,brokerage_id`);
  const user = userResult.data?.[0];
  if (!user) return { error: "User record not found", status: 404 };

  const listingResult = await supabase("GET", "listings", null,
    `?id=eq.${listingId}&select=id,user_id,team_id,brokerage_id,beds,baths,sqft,year_built`);
  const listing = listingResult.data?.[0];
  if (!listing) return { error: "Listing not found", status: 404 };

  const owns =
    listing.user_id === authUser.id ||
    (user.role === "team_lead"    && user.team_id      && listing.team_id      === user.team_id) ||
    (user.role === "broker_admin" && user.brokerage_id && listing.brokerage_id === user.brokerage_id);
  if (!owns) return { error: "Access denied", status: 403 };
  return { listing };
}

const pick = l => ({ beds: l.beds ?? null, baths: l.baths ?? null, sqft: l.sqft ?? null, year_built: l.year_built ?? null });

exports.handler = async (event) => {
  const headers = {
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Headers": "Content-Type, Authorization",
    "Content-Type": "application/json",
    "Cache-Control": "no-store",
  };
  if (event.httpMethod === "OPTIONS") return { statusCode: 200, headers, body: "" };

  const authUser = await verifyJWT(event.headers.authorization || event.headers.Authorization);
  if (!authUser) return { statusCode: 401, headers, body: JSON.stringify({ error: "Unauthorized" }) };

  try {
    if (event.httpMethod === "GET") {
      const listingId = event.queryStringParameters?.listingId;
      if (!listingId || !UUID_RE.test(listingId)) return { statusCode: 400, headers, body: JSON.stringify({ error: "Missing or invalid listingId" }) };
      const access = await checkAccess(listingId, authUser);
      if (access.error) return { statusCode: access.status, headers, body: JSON.stringify({ error: access.error }) };
      return { statusCode: 200, headers, body: JSON.stringify({ details: pick(access.listing) }) };
    }

    if (event.httpMethod === "POST") {
      let body;
      try { body = JSON.parse(event.body || "{}"); }
      catch { return { statusCode: 400, headers, body: JSON.stringify({ error: "Invalid JSON" }) }; }

      const { listingId } = body;
      if (!listingId || !UUID_RE.test(listingId)) return { statusCode: 400, headers, body: JSON.stringify({ error: "Missing or invalid listingId" }) };

      const v = validateDetails(body);
      if (v.error) return { statusCode: 400, headers, body: JSON.stringify({ error: v.error }) };

      const access = await checkAccess(listingId, authUser);
      if (access.error) return { statusCode: access.status, headers, body: JSON.stringify({ error: access.error }) };

      const result = await supabase("PATCH", "listings", v.updates, `?id=eq.${listingId}`);
      if (result.status >= 300) {
        console.error("listing-details PATCH failed:", result.status, JSON.stringify(result.data));
        return { statusCode: 500, headers, body: JSON.stringify({ error: "Could not save listing details." }) };
      }
      return { statusCode: 200, headers, body: JSON.stringify({ details: pick(result.data?.[0] || { ...access.listing, ...v.updates }) }) };
    }

    return { statusCode: 405, headers, body: JSON.stringify({ error: "Method Not Allowed" }) };
  } catch (err) {
    console.error("listing-details error:", err.message);
    return { statusCode: 500, headers, body: JSON.stringify({ error: "Listing details request failed." }) };
  }
};
