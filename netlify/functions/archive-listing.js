// archive-listing.js — Netlify Function
// Smart Stage PRO™ — listing status (six real lifecycle stages) and
// archiving (a hide flag) are two separate, independent concerns.
//
// STATUS holds exactly six real values: active, pending, sold, canceled,
// expired, marketing. There is no "archived" status — archiving something
// never touches status at all. This exists because the first version of
// this feature (earlier today) made "archived" a seventh status value,
// which meant archiving a Sold listing silently overwrote and lost the
// fact that it had been Sold. Split apart per Sam's explicit correction:
// a Sold/Canceled/Expired/Marketing listing that gets archived is STILL
// that status underneath — archiving only ever changes visibility.
//
// HIDDEN is that visibility flag (mirrors staged_images.hidden /
// hide-image.js exactly). Business rule (Sam's, Sep 18 2026): a listing
// can only be archived (hidden=true) from Sold, Canceled, Expired, or
// Marketing — Active/Pending listings carry real disclosure and public
// marketing and must be moved to one of those four first. Enforced here
// server-side, not just in the UI dropdown, same reasoning as every other
// access/business rule in this codebase (a client-only rule isn't a rule).
// Unhiding (hidden=false) has no such restriction — you can always restore
// a listing to visibility.
//
// Each action keeps its own audit trail: status_history for real lifecycle
// changes, hidden_history for archive/restore — kept separate so a hide
// event never gets mixed in with a real status transition. Both mirror
// hide-image.js's hiddenHistory shape (action/at/by/reason).
//
// Access mirrors get-user-listings.js / hide-image.js's role model: an
// owner can act on their own listing; a team_lead can act on any
// same-team listing; a broker_admin can act on any listing in the
// brokerage.
//
// Routes via ?action= (GET) or plain POST (defaults to "set-status"):
//   POST ?action=set-status (or no action) — body { listingId, status, reason? }
//   POST ?action=set-hidden              — body { listingId, hidden, reason? }
//
// Requires Authorization: Bearer <supabase jwt>.

const https = require("https");

const VALID_STATUSES = ["active", "pending", "sold", "canceled", "expired", "marketing"];
const ARCHIVABLE_FROM = ["sold", "canceled", "expired", "marketing"];

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
    `?id=eq.${listingId}&select=id,user_id,team_id,brokerage_id,address,status,status_history,hidden,hidden_history`
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
    // ── SET STATUS — one of the six real lifecycle values. Never touches
    // `hidden` — a hidden listing keeps whatever status it's given here. ──
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

    // ── SET HIDDEN — archive (hidden=true) or restore (hidden=false).
    // Archiving is gated server-side on the listing's CURRENT status;
    // restoring is never gated. ────────────────────────────────────────────
    if (action === "set-hidden") {
      if (event.httpMethod !== "POST") return { statusCode: 405, headers, body: JSON.stringify({ error: "Method Not Allowed" }) };

      let body;
      try { body = JSON.parse(event.body || "{}"); }
      catch { return { statusCode: 400, headers, body: JSON.stringify({ error: "Invalid JSON" }) }; }

      const { listingId, hidden, reason } = body;
      if (!listingId) return { statusCode: 400, headers, body: JSON.stringify({ error: "Missing listingId" }) };
      if (typeof hidden !== "boolean") return { statusCode: 400, headers, body: JSON.stringify({ error: "Missing or invalid hidden (must be true or false)" }) };

      const access = await checkAccess(listingId, authUser);
      if (access.error) return { statusCode: access.status, headers, body: JSON.stringify({ error: access.error }) };

      const { listing } = access;

      // Server-side enforcement of Sam's business rule — checked against
      // the listing's status as it stands right now in the database, not
      // whatever the client claims. Only applies when archiving; restoring
      // is always allowed.
      if (hidden && !ARCHIVABLE_FROM.includes(listing.status)) {
        return {
          statusCode: 400, headers,
          body: JSON.stringify({
            error: `Cannot archive a listing while it's "${listing.status}." Move it to Sold, Canceled, Expired, or Marketing first — Active and Pending listings carry real disclosure and public marketing.`
          })
        };
      }

      // Idempotent, same as hide-image.js.
      const history = Array.isArray(listing.hidden_history) ? listing.hidden_history : [];
      history.push({
        action: hidden ? "hidden" : "unhidden",
        at:     new Date().toISOString(),
        by:     authUser.id,
        reason: reason || null,
      });

      const result = await supabase("PATCH", "listings",
        { hidden, hidden_history: history, updated_at: new Date().toISOString() },
        `?id=eq.${listingId}`
      );

      if (result.status !== 200 && result.status !== 204) {
        console.error("Hidden change failed:", result.status, result.data);
        return { statusCode: 500, headers, body: JSON.stringify({ error: "Archive/restore failed" }) };
      }

      console.log(
        (hidden ? "Archived" : "Restored"), "listing", listingId, listing.address,
        "(status:", listing.status + ")", "by", authUser.id, reason ? ("— reason: " + reason) : ""
      );

      return {
        statusCode: 200, headers,
        body: JSON.stringify({ success: true, listingId, hidden })
      };
    }

    return { statusCode: 400, headers, body: JSON.stringify({ error: "Unknown action: " + action }) };

  } catch (err) {
    console.error("archive-listing error:", err.message);
    return { statusCode: 500, headers, body: JSON.stringify({ error: err.message }) };
  }
};
