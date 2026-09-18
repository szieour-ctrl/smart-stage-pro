// archive-listing.js — Netlify Function
// Smart Stage PRO™ — full listing status lifecycle, not just archive/restore
//
// Originally a one-way soft-delete (status: 'active' -> 'archived'). Extended
// Sep 18, 2026 into the general status setter for a listing's whole
// lifecycle: active, marketing, pending, sold, canceled, expired, withdrawn,
// archived. Kept the existing `status` column rather than adding a parallel
// `hidden` boolean — `status` was single-purpose (only 'active'/'archived'
// ever touched it, confirmed by inventory of every listing.status reference
// in index.html/get-user-listings.js) so there was no real risk of two
// flags disagreeing, and every place that already filters on
// `status=neq.archived` (get-user-listings.js) keeps working with zero
// changes — only 'archived' is ever excluded from My Listings; every other
// status (including the new ones) stays visible by default.
//
// Every status change is optionally reasoned and appended to status_history
// (jsonb column — see listings-status-history-migration.sql) — same shape
// as hide-image.js's per-image hiddenHistory: { action, fromStatus, status,
// at, by, reason }.
//
// Access mirrors get-user-listings.js / hide-image.js's role model: an
// owner can change their own listing's status; a team_lead can act on any
// same-team listing; a broker_admin can act on any listing in the
// brokerage. FIX (Sep 18, 2026): the original archive-only version checked
// user_id only — a team_lead/broker_admin could not archive a teammate's
// listing, unlike every other listing-scoped function in this codebase.
// That gap is closed here.
//
// Routes via ?action= (GET) or plain POST (defaults to "set-status"):
//   POST ?action=set-status (or no action) — body { listingId, status, reason? }
//   GET  ?action=list-by-status&status=archived — for the "Archived
//        Listings" review view; returns every listing at that status the
//        caller can see, same role scoping as get-user-listings.js. Works
//        for any status, not just archived, in case that's ever useful.
//
// Requires Authorization: Bearer <supabase jwt> for all actions.

const https = require("https");

const VALID_STATUSES = ["active", "marketing", "pending", "sold", "canceled", "expired", "withdrawn", "archived"];

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
      headers: { "apikey": process.env.SUPABASE_SERVICE_ROLE_KEY, "Authorization": `Bearer ${jwt}` }
    }, res => {
      let data = "";
      res.on("data", c => data += c);
      res.on("end", () => {
        try { const p = JSON.parse(data); resolve(res.statusCode === 200 && p.id ? p : null); }
        catch { resolve(null); }
      });
    });
    req.on("error", () => resolve(null));
    req.end();
  });
}

// Same role model as get-user-listings.js / hide-image.js.
async function checkAccess(listingId, authUser) {
  const userResult = await supabase("GET", "users", null,
    `?id=eq.${authUser.id}&select=id,role,team_id,brokerage_id`
  );
  const user = userResult.data?.[0];
  if (!user) return { error: "User record not found", status: 404 };

  const listingResult = await supabase("GET", "listings", null,
    `?id=eq.${listingId}&select=id,user_id,team_id,brokerage_id,address,status,status_history`
  );
  const listing = listingResult.data?.[0];
  if (!listing) return { error: "Listing not found", status: 404 };

  const owns =
    listing.user_id === authUser.id ||
    (user.role === "team_lead"    && user.team_id      && listing.team_id      === user.team_id) ||
    (user.role === "broker_admin" && user.brokerage_id && listing.brokerage_id === user.brokerage_id);

  if (!owns) return { error: "Access denied", status: 403 };
  return { listing, user };
}

exports.handler = async (event) => {
  const headers = {
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Headers": "Content-Type, Authorization",
    "Content-Type": "application/json",
  };

  if (event.httpMethod === "OPTIONS") return { statusCode: 200, headers, body: "" };

  const authUser = await verifyJWT(event.headers.authorization || event.headers.Authorization);
  if (!authUser) return { statusCode: 401, headers, body: JSON.stringify({ error: "Unauthorized" }) };

  const action = event.queryStringParameters?.action || "set-status";

  try {
    // ── LIST BY STATUS — for the "Archived Listings" review view ──────────
    if (action === "list-by-status") {
      if (event.httpMethod !== "GET") return { statusCode: 405, headers, body: JSON.stringify({ error: "Method Not Allowed" }) };

      const status = event.queryStringParameters?.status;
      if (!status || !VALID_STATUSES.includes(status)) {
        return { statusCode: 400, headers, body: JSON.stringify({ error: "Missing or invalid status" }) };
      }

      const userResult = await supabase("GET", "users", null,
        `?id=eq.${authUser.id}&select=id,role,team_id,brokerage_id`
      );
      const user = userResult.data?.[0];
      if (!user) return { statusCode: 404, headers, body: JSON.stringify({ error: "User record not found" }) };

      // Same role-scoped visibility as get-user-listings.js.
      let listingsQuery;
      if (user.role === "broker_admin" && user.brokerage_id) {
        listingsQuery = `?brokerage_id=eq.${user.brokerage_id}&status=eq.${status}&select=id,address,project_id,compliance_page_url,status,status_history,updated_at&order=updated_at.desc.nullsfirst&limit=100`;
      } else if (user.role === "team_lead" && user.team_id) {
        listingsQuery = `?team_id=eq.${user.team_id}&status=eq.${status}&select=id,address,project_id,compliance_page_url,status,status_history,updated_at&order=updated_at.desc.nullsfirst&limit=100`;
      } else {
        listingsQuery = `?user_id=eq.${authUser.id}&status=eq.${status}&select=id,address,project_id,compliance_page_url,status,status_history,updated_at&order=updated_at.desc.nullsfirst&limit=100`;
      }

      const result = await supabase("GET", "listings", null, listingsQuery);
      const rows = Array.isArray(result.data) ? result.data : [];

      return {
        statusCode: 200, headers,
        body: JSON.stringify({
          status,
          listings: rows.map(l => ({
            id:            l.id,
            address:       l.address,
            projectId:     l.project_id,
            complianceUrl: l.compliance_page_url,
            status:        l.status,
            // updated_at doubles as "when this status was set" — accurate
            // here specifically because this list is already scoped to one
            // status, so the most recent update IS the transition into it.
            archivedAt:    l.updated_at,
            statusHistory: l.status_history || [],
          })),
        })
      };
    }

    // ── SET STATUS ─────────────────────────────────────────────────────────
    if (action === "set-status") {
      if (event.httpMethod !== "POST") return { statusCode: 405, headers, body: JSON.stringify({ error: "Method Not Allowed" }) };

      let body;
      try { body = JSON.parse(event.body || "{}"); }
      catch { return { statusCode: 400, headers, body: JSON.stringify({ error: "Invalid JSON" }) }; }

      const { listingId, status, reason } = body;
      if (!listingId) return { statusCode: 400, headers, body: JSON.stringify({ error: "Missing listingId" }) };
      if (!status || !VALID_STATUSES.includes(status)) {
        return { statusCode: 400, headers, body: JSON.stringify({ error: "Missing or invalid status. Must be one of: " + VALID_STATUSES.join(", ") }) };
      }

      const access = await checkAccess(listingId, authUser);
      if (access.error) return { statusCode: access.status, headers, body: JSON.stringify({ error: access.error }) };

      const { listing } = access;

      // Idempotent, same as hide-image.js — setting the same status twice
      // is a no-op on state but still logs the attempt, since a repeated
      // action can itself be meaningful in an audit trail.
      const history = Array.isArray(listing.status_history) ? listing.status_history : [];
      history.push({
        action:     "status-change",
        fromStatus: listing.status || "active",
        status,
        at:         new Date().toISOString(),
        by:         authUser.id,
        reason:     reason || null,
      });

      const result = await supabase("PATCH", "listings",
        { status, status_history: history, updated_at: new Date().toISOString() },
        `?id=eq.${listingId}`
      );

      if (result.status !== 200 && result.status !== 204) {
        console.error("Status change failed:", result.status, result.data);
        return { statusCode: 500, headers, body: JSON.stringify({ error: "Status change failed" }) };
      }

      console.log(
        "Listing", listingId, listing.address, "status:", listing.status || "active", "->", status,
        "by", authUser.id, reason ? ("— reason: " + reason) : ""
      );

      return {
        statusCode: 200, headers,
        body: JSON.stringify({ success: true, listingId, status })
      };
    }

    return { statusCode: 400, headers, body: JSON.stringify({ error: "Unknown action: " + action }) };

  } catch (err) {
    console.error("archive-listing error:", err.message);
    return { statusCode: 500, headers, body: JSON.stringify({ error: err.message }) };
  }
};
