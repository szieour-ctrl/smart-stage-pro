// reel-quota.js — GET ?userId=... -> { plan, limit, used, remaining, undownloaded, threshold, accessOk }
// Read-only. Feeds the Reel render step ("3 of 4 Reels left", "2 of 5 renders not downloaded").
const quota = require("./lib/reel-quota-lib");
const { requireUser } = require("./lib/reel-auth-lib");
const headers = { "Access-Control-Allow-Origin": "*", "Content-Type": "application/json", "Cache-Control": "no-store" };
const reply = (statusCode, obj) => ({ statusCode, headers, body: JSON.stringify(obj) });
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

exports.handler = async (event) => {
  if (event.httpMethod === "OPTIONS") return { statusCode: 204, headers: { ...headers, "Access-Control-Allow-Headers": "Content-Type, Authorization", "Access-Control-Allow-Methods": "GET, OPTIONS" }, body: "" };
  if (event.httpMethod !== "GET") return reply(405, { error: "Method not allowed" });
  const auth = await requireUser(event);
  if (auth.error) return reply(auth.error.status, auth.error.body);
  const userId = auth.user.id; // the query's userId is ignored
  try { return reply(200, await quota.getQuotaSummary(userId)); }
  catch (e) { console.error("reel-quota error:", e.message); return reply(500, { error: "Could not load Reel usage" }); }
};
