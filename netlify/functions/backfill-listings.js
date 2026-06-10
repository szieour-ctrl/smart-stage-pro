// backfill-listings.js — Netlify Function (one-time use)
// Scans all Netlify Blob projects and writes them to Supabase listings table
// Call once via POST with Authorization header (must be Sam's JWT)
// Safe to run multiple times — uses ON CONFLICT DO NOTHING

const { getStore } = require("@netlify/blobs");
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
        "Prefer":        "resolution=ignore-duplicates,return=representation",
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

  try {
    const store = getStore({
      name: "smart-stage-projects",
      siteID: process.env.NETLIFY_SITE_ID,
      token: process.env.NETLIFY_ACCESS_TOKEN,
    });

    // List all blob keys
    const { blobs } = await store.list();
    console.log("Total blobs found:", blobs.length);

    const pidBlobs = blobs.filter(b => b.key.startsWith("pid_"));
    console.log("Project blobs (pid_*):", pidBlobs.length);

    let inserted = 0, skipped = 0, errors = 0;

    for (const blob of pidBlobs) {
      try {
        const raw = await store.get(blob.key);
        if (!raw) continue;
        const project = JSON.parse(raw);

        // Only backfill projects that belong to this user (or all if no userId)
        const userId = project.userId || authUser.id;

        const result = await supabase("POST", "listings", {
          address:             project.address,
          project_id:          project.projectId,
          compliance_page_url: project.complianceUrl || null,
          mls_number:          null,
          user_id:             userId,
          team_id:             null,
          brokerage_id:        null,
          status:              project.status || "active",
          created_at:          project.createdAt || new Date().toISOString(),
          updated_at:          project.updatedAt || project.createdAt || new Date().toISOString(),
        });

        if (result.status === 201 || result.status === 200) {
          inserted++;
          console.log("Inserted:", project.projectId, project.address);
        } else {
          skipped++;
          console.log("Skipped (duplicate?):", project.projectId, result.status);
        }
      } catch (err) {
        errors++;
        console.error("Error processing blob:", blob.key, err.message);
      }
    }

    return {
      statusCode: 200, headers,
      body: JSON.stringify({ success: true, total: pidBlobs.length, inserted, skipped, errors })
    };

  } catch (err) {
    console.error("backfill-listings error:", err.message);
    return { statusCode: 500, headers, body: JSON.stringify({ error: err.message }) };
  }
};
