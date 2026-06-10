// get-user-listings.js — Netlify Function
// Smart Stage PRO™  |  Subscriber Dashboard — My Listings
// Returns all projects belonging to the logged-in user
// Solo: own projects only
// Team lead: own projects + all team member projects (same team_id)
// Broker admin: all projects in brokerage
//
// Input:  GET with Authorization header
// Output: { listings: [...], stats: { totalListings, totalImageSets, creditsRemaining, subscriptionStatus, plan } }

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

function getProjectStore() {
  return getStore({
    name: "smart-stage-projects",
    siteID: process.env.NETLIFY_SITE_ID,
    token: process.env.NETLIFY_ACCESS_TOKEN,
  });
}

exports.handler = async (event) => {
  const headers = {
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Headers": "Content-Type, Authorization",
    "Content-Type": "application/json",
  };

  if (event.httpMethod === "OPTIONS") return { statusCode: 200, headers, body: "" };
  if (event.httpMethod !== "GET") return { statusCode: 405, headers, body: JSON.stringify({ error: "Method Not Allowed" }) };

  // Verify JWT
  const authUser = await verifyJWT(event.headers.authorization || event.headers.Authorization);
  if (!authUser) {
    return { statusCode: 401, headers, body: JSON.stringify({ error: "Unauthorized" }) };
  }

  try {
    // Get user record from Supabase for role + credit info
    const userResult = await supabase("GET", "users", null,
      `?id=eq.${authUser.id}&select=id,role,team_id,brokerage_id,subscription_status,full_name,email`
    );
    const user = userResult.data?.[0];

    if (!user) {
      return { statusCode: 404, headers, body: JSON.stringify({ error: "User record not found" }) };
    }

    // Get credit balance
    const creditResult = await supabase("GET", "credit_ledger", null,
      `?user_id=eq.${authUser.id}&select=balance_after&order=created_at.desc&limit=1`
    );
    const creditsRemaining = creditResult.data?.[0]?.balance_after ?? 0;

    // Determine plan label
    const planLabel =
      user.role === "broker_admin" ? "Brokerage" :
      user.role === "team_lead" || user.role === "team_member" ? "Team" :
      "Solo";

    // ── Fetch listings from Supabase based on role ────────────────────────
    let listingsQuery;
    if (user.role === "broker_admin" && user.brokerage_id) {
      listingsQuery = `?brokerage_id=eq.${user.brokerage_id}&status=neq.archived&select=id,address,project_id,compliance_page_url,mls_number,status,created_at,updated_at,user_id&order=updated_at.desc.nullsfirst&limit=100`;
    } else if (user.role === "team_lead" && user.team_id) {
      listingsQuery = `?team_id=eq.${user.team_id}&status=neq.archived&select=id,address,project_id,compliance_page_url,mls_number,status,created_at,updated_at,user_id&order=updated_at.desc.nullsfirst&limit=100`;
    } else {
      listingsQuery = `?user_id=eq.${authUser.id}&status=neq.archived&select=id,address,project_id,compliance_page_url,mls_number,status,created_at,updated_at,user_id&order=updated_at.desc.nullsfirst&limit=100`;
    }

    const listingsResult = await supabase("GET", "listings", null, listingsQuery);
    console.log('listings query status:', listingsResult.status, 'data type:', typeof listingsResult.data, 'isArray:', Array.isArray(listingsResult.data));
    const dbListings = Array.isArray(listingsResult.data) ? listingsResult.data : [];

    // ── Enrich from Netlify Blobs (image counts + thumbnails) ─────────────
    const store = getProjectStore();
    const enriched = await Promise.all(dbListings.map(async (listing) => {
      let imageCount = 0;
      let images = [];
      let lastStaged = listing.updated_at;
      let tier = "solo";

      if (listing.project_id) {
        try {
          const raw = await store.get("pid_" + listing.project_id);
          if (raw) {
            const project = JSON.parse(raw);
            images = (project.images || []).slice(0, 5); // first 5 for thumbnails
            imageCount = (project.images || []).length;
            lastStaged = project.updatedAt || project.createdAt;
            tier = project.tier || "solo";
          }
        } catch (e) {
          // Blob not found — project may be new
        }
      }

      return {
        id:             listing.id,
        address:        listing.address,
        projectId:      listing.project_id,
        complianceUrl:  listing.compliance_page_url,
        mlsNumber:      listing.mls_number || null,
        status:         listing.status || "active",
        createdAt:      listing.created_at,
        lastStaged:     lastStaged,
        imageCount,
        tier,
        thumbnails: images.map(img => ({
          roomName:  img.roomName || "Room",
          stagedUrl: img.stagedUrl || null,
        })),
      };
    }));

    // ── Stats ─────────────────────────────────────────────────────────────
    const totalImageSets = enriched.reduce((sum, l) => sum + l.imageCount, 0);

    return {
      statusCode: 200,
      headers,
      body: JSON.stringify({
        listings: enriched,
        stats: {
          totalListings:      enriched.length,
          totalImageSets,
          creditsRemaining,
          subscriptionStatus: user.subscription_status,
          plan:               planLabel,
          role:               user.role,
          userName:           user.full_name || user.email,
        }
      })
    };

  } catch (err) {
    console.error("get-user-listings error:", err.message);
    return { statusCode: 500, headers, body: JSON.stringify({ error: err.message }) };
  }
};
