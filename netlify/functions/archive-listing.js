// archive-listing.js — Netlify Function
// Soft-deletes a listing from the subscriber dashboard
// Sets status = 'archived' — compliance page remains permanently active (AB 723)

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

exports.handler = async (event) => {
  const headers = { "Content-Type": "application/json" };
  if (event.httpMethod !== "POST") return { statusCode: 405, headers, body: "Method Not Allowed" };

  const authUser = await verifyJWT(event.headers.authorization || event.headers.Authorization);
  if (!authUser) return { statusCode: 401, headers, body: JSON.stringify({ error: "Unauthorized" }) };

  let body;
  try { body = JSON.parse(event.body || "{}"); }
  catch { return { statusCode: 400, headers, body: JSON.stringify({ error: "Invalid JSON" }) }; }

  const { listingId } = body;
  if (!listingId) return { statusCode: 400, headers, body: JSON.stringify({ error: "Missing listingId" }) };

  // Verify the listing belongs to this user before archiving
  const checkResult = await supabase("GET", "listings", null,
    `?id=eq.${listingId}&user_id=eq.${authUser.id}&select=id,address`
  );

  if (!Array.isArray(checkResult.data) || checkResult.data.length === 0) {
    return { statusCode: 403, headers, body: JSON.stringify({ error: "Listing not found or access denied" }) };
  }

  // Soft delete — set status to archived
  const result = await supabase("PATCH", "listings",
    { status: "archived", updated_at: new Date().toISOString() },
    `?id=eq.${listingId}&user_id=eq.${authUser.id}`
  );

  if (result.status !== 200 && result.status !== 204) {
    console.error("Archive failed:", result.status, result.data);
    return { statusCode: 500, headers, body: JSON.stringify({ error: "Archive failed" }) };
  }

  console.log("Archived listing:", listingId, checkResult.data[0]?.address);

  return {
    statusCode: 200, headers,
    body: JSON.stringify({ archived: true, listingId })
  };
};
