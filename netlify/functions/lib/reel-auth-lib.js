// lib/reel-auth-lib.js — Netlify (shared helper)
// Reel endpoints (Oct 20, 2026): the user is taken from the verified login
// token, never from a userId in the request body/query. Listing access
// mirrors get-user-listings.js: the owner, a team_lead for their team's
// listings, or a broker_admin for their brokerage's listings.

const { supabase, verifyJWT } = require("./marketing-profile-lib");

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// Returns { user: { id, ...authUser } } or { error: { statusCode, body } }.
async function requireUser(event) {
  const h = event.headers || {};
  const authUser = await verifyJWT(h.authorization || h.Authorization);
  if (!authUser || !UUID_RE.test(String(authUser.id || ""))) {
    return { error: { status: 401, body: { error: "Please log in again to use Reels.", code: "unauthorized" } } };
  }
  return { user: authUser };
}

// True when this user may act on this listing row ({ user_id, team_id, brokerage_id }).
async function canAccessListing(userId, listing) {
  if (!listing) return false;
  if (listing.user_id === userId) return true;
  const ur = await supabase("GET", "users", null, `?id=eq.${userId}&select=role,team_id,brokerage_id&limit=1`);
  const u = Array.isArray(ur.data) ? ur.data[0] : null;
  if (!u) return false;
  if (u.role === "broker_admin" && u.brokerage_id && listing.brokerage_id === u.brokerage_id) return true;
  if (u.role === "team_lead" && u.team_id && listing.team_id === u.team_id) return true;
  return false;
}

module.exports = { requireUser, canAccessListing, UUID_RE };
