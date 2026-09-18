// get-user-listings.js — Netlify Function
// Smart Stage PRO™  |  Subscriber Dashboard — My Listings
// Returns all projects belonging to the logged-in user
// Solo: own projects only
// Team lead: own projects + all team member projects (same team_id)
// Broker admin: all projects in brokerage
//
// Input:  GET with Authorization header
// Output: { listings: [...], stats: { totalListings, totalImageSets, creditsRemaining, subscriptionStatus, plan } }
//
// FIX (Sep 16, 2026 — confirmed real, not a hypothesis): a property search
// creates a real `listings` row and a real `compliance_page_url` the
// moment the address is looked up (see index.html's createNewProject() —
// this is deliberate, per Sam's Aug 11 requirement: Create Video needs a
// projectId "after property address lookup / create property id," full
// stop, independent of whether staging ever happens). That's still
// correct and unchanged here. The problem was this dashboard passing
// `compliance_page_url` straight through as `complianceUrl` regardless of
// whether anything was ever actually staged — so a listing that was only
// ever searched, never staged, showed up on My Listings claiming "✓ QR
// active · ✓ Compliance page active" alongside 3 other genuinely
// unstaged Bent Tree Ct properties. The row and its Blobs project are
// still created eagerly and are still fully reachable via a repeat
// Property Search (lookupProject() finds them by address+userId exactly
// as before, unaffected by this change) — they just don't clutter this
// dashboard LIST until something real exists. A listing that WAS staged
// and later had every image hidden (see hide-image.js) is a different,
// legitimate case and must still show — so the exclusion checks BOTH
// visible and hidden image counts, not just the visible one, and only
// drops a listing when neither has ever been non-zero.
//
// FIX (Sep 18, 2026 — real bug found live): this used to exclude
// status='archived' rows at the SQL level (`status=neq.archived`). That
// broke address search — an archived listing could never be found no
// matter what was typed, since it never even reached the frontend. Fixed
// by dropping that filter here: EVERY listing (any status) is now
// returned to the frontend, and archived-hiding moved to the dashboard's
// display logic instead (renderListingsOnly() in index.html) — which can
// tell the difference between "hide archived by default" and "the user
// is searching for something, so search everything." Stats below still
// exclude archived, so "Total Listings"/"Staged Image Sets" continue to
// reflect what's actually active on the dashboard, not everything ever
// archived.

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
    // PROSPECTING (Sep 2026): prospecting rows (is_prospecting=true) are
    // deliberately excluded from every branch below — this dashboard is
    // "My Listings" for real listings, not a running log of every address
    // ever prospected. `not.is.true` (rather than `eq.false`) is used so
    // older rows where is_prospecting is still NULL are treated as regular
    // listings and still show up, instead of silently disappearing.
    //
    // STATUS (Sep 18, 2026): no longer filters on `status` at all here —
    // see file header. Every status, including archived, comes back; the
    // dashboard decides what to show by default vs. what a search reveals.
    let listingsQuery;
    if (user.role === "broker_admin" && user.brokerage_id) {
      listingsQuery = `?brokerage_id=eq.${user.brokerage_id}&is_prospecting=not.is.true&select=id,address,project_id,compliance_page_url,mls_number,status,created_at,updated_at,user_id&order=updated_at.desc.nullsfirst&limit=100`;
    } else if (user.role === "team_lead" && user.team_id) {
      listingsQuery = `?team_id=eq.${user.team_id}&is_prospecting=not.is.true&select=id,address,project_id,compliance_page_url,mls_number,status,created_at,updated_at,user_id&order=updated_at.desc.nullsfirst&limit=100`;
    } else {
      listingsQuery = `?user_id=eq.${authUser.id}&is_prospecting=not.is.true&select=id,address,project_id,compliance_page_url,mls_number,status,created_at,updated_at,user_id&order=updated_at.desc.nullsfirst&limit=100`;
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

      let hiddenCount = 0;

      if (listing.project_id) {
        try {
          const raw = await store.get("pid_" + listing.project_id);
          if (raw) {
            const project = JSON.parse(raw);
            const allImages = project.images || [];
            // Soft-hidden images (see hide-image.js) never show up in the
            // normal dashboard view or its thumbnails/counts — they only
            // appear via the separate "Review Hidden" action for this
            // listing, so a pulled image never gets mixed back in with
            // what's actually published.
            const visibleImages = allImages.filter(img => !img.hidden);
            hiddenCount = allImages.length - visibleImages.length;
            images = visibleImages.slice(0, 5); // first 5 for thumbnails
            imageCount = visibleImages.length;
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
        hiddenCount,
        tier,
        thumbnails: images.map(img => ({
          roomName:  img.roomName || "Room",
          stagedUrl: img.stagedUrl || null,
        })),
      };
    }));

    // FIX (Sep 16, 2026) — see file header comment for the full
    // explanation. A listing that has NEVER had anything staged into it
    // (no visible images AND no hidden ones — i.e. it was only ever
    // property-searched, never staged) is excluded from what the
    // dashboard displays. The underlying listings row, project_id, and
    // compliance_page_url are untouched by this — Create Video and a
    // repeat Property Search both keep working exactly as before, this
    // only changes what shows up as a card on this page.
    const displayable = enriched.filter(l => l.imageCount > 0 || l.hiddenCount > 0);

    // ── Stats ─────────────────────────────────────────────────────────────
    // Derived from displayable EXCLUDING archived — an archived listing is
    // returned in `listings` below (so search/the Archived filter tab can
    // find it) but shouldn't inflate "Total Listings"/"Staged Image Sets,"
    // which are meant to reflect what's actually active on the dashboard.
    const statsBasis = displayable.filter(l => l.status !== "archived");
    const totalImageSets = statsBasis.reduce((sum, l) => sum + l.imageCount, 0);

    return {
      statusCode: 200,
      headers,
      body: JSON.stringify({
        listings: displayable,
        stats: {
          totalListings:      statsBasis.length,
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
