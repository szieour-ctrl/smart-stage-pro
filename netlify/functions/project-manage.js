// project-manage.js — Netlify Function
// Handles: project lookup, project creation, image attachment
// Routes via ?action= parameter
//
// action=lookup    — check if project exists for address
// action=create    — create new project for address
// action=add-image — attach a staged image to existing project
//
// Supabase integration: createProject writes to listings table,
// addImage writes to staged_images table and debits credits.
// userId is required in body for create and add-image actions.

const { getStore } = require("@netlify/blobs");
const crypto = require("crypto");
const https  = require("https");

// ── SUPABASE HELPER ──────────────────────────────────────────────────────────

function supabase(method, table, body, queryParams = "") {
  return new Promise((resolve, reject) => {
    const url     = new URL(`${process.env.SUPABASE_URL}/rest/v1/${table}${queryParams}`);
    const bodyStr = body ? JSON.stringify(body) : null;
    const req = https.request({
      hostname: url.hostname,
      path:     url.pathname + url.search,
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

async function getSupabaseUserContext(userId) {
  if (!userId || !process.env.SUPABASE_URL) return null;
  const r = await supabase("GET", "users", null,
    `?id=eq.${userId}&select=id,role,team_id,brokerage_id,subscription_status`
  );
  return r.data?.[0] || null;
}

async function getCurrentCreditBalance(userId) {
  if (!userId || !process.env.SUPABASE_URL) return 999; // fallback if Supabase not set up yet
  const r = await supabase("GET", "credit_ledger", null,
    `?user_id=eq.${userId}&select=balance_after&order=created_at.desc&limit=1`
  );
  return r.data?.[0]?.balance_after ?? 0;
}

// ── NETLIFY BLOBS STORE ──────────────────────────────────────────────────────

function getProjectStore(env) {
  return getStore({
    name: "smart-stage-projects",
    siteID: env.NETLIFY_SITE_ID,
    token: env.NETLIFY_ACCESS_TOKEN,
  });
}

// ── PROJECT ID HELPERS ───────────────────────────────────────────────────────

function cleanAddress(address) {
  // Strip ", USA" suffix appended by Google Places autocomplete
  return (address || "").replace(/,\s*USA\s*$/i, "").trim();
}

function addressHash(address) {
  const normalized = address.toLowerCase()
    .replace(/\s+/g, " ")
    .replace(/[^a-z0-9\s,]/g, "")
    .trim();
  return crypto.createHash("md5").update(normalized).digest("hex").slice(0, 16);
}

function getRoleTier(role) {
  // Maps Supabase role to project ID tier label
  if (role === "team_lead" || role === "team_member") return "team";
  if (role === "broker_admin") return "brokerage";
  return "solo";
}

function generateProjectId(address, tier = "solo") {
  // Format: szreg{tier}_{streetaddr}_{MMDDYY}
  // e.g. szregsolo_201benttreect_060126
  const now = new Date();
  const mm  = String(now.getMonth() + 1).padStart(2, "0");
  const dd  = String(now.getDate()).padStart(2, "0");
  const yy  = String(now.getFullYear()).slice(2);
  const addrSlug = (address || "")
    .toLowerCase()
    .replace(/,.*$/, "")
    .replace(/[^a-z0-9]+/g, "")
    .slice(0, 20);
  return `szreg${tier}_${addrSlug}_${mm}${dd}${yy}`;
}

function complianceUrl(projectId, siteUrl) {
  const base = siteUrl || "https://smartstagepro.com";
  return `${base}/compliance/${projectId}`;
}

// ── ACTION: LOOKUP ───────────────────────────────────────────────────────────

async function lookupProject(address, env) {
  address = cleanAddress(address);
  const store = getProjectStore(env);
  const key   = "addr_" + addressHash(address);
  try {
    const raw = await store.get(key);
    if (!raw) return { exists: false };
    const project = JSON.parse(raw);
    // NEW: resolve the real Supabase listings.id here too — the lookup path
    // is how a returning session finds an already-created project, and it
    // needs SESSION.listingId exactly as much as a fresh create does (see
    // the matching fix in createProject's existing-project branch above).
    let listingId = null;
    if (process.env.SUPABASE_URL) {
      try {
        const listingLookup = await supabase("GET", "listings", null,
          `?project_id=eq.${project.projectId}&select=id&limit=1`
        );
        listingId = listingLookup.data?.[0]?.id || null;
      } catch (err) {
        console.error("Listing id lookup error (non-fatal):", err.message);
      }
    }
    return {
      exists:        true,
      projectId:     project.projectId,
      address:       project.address,
      imageCount:    (project.images || []).length,
      complianceUrl: project.complianceUrl,
      qrCodeTarget:  project.complianceUrl,
      createdAt:     project.createdAt,
      status:        project.status,
      listingId,
    };
  } catch (err) {
    console.error("lookup error:", err.message);
    return { exists: false };
  }
}

// ── ACTION: CREATE ───────────────────────────────────────────────────────────

async function createProject(address, agentInfo, siteUrl, userId, env) {
  address = cleanAddress(address);
  const store   = getProjectStore(env);
  const addrKey = "addr_" + addressHash(address);

  // Race condition guard
  const existing = await store.get(addrKey);
  if (existing) {
    const proj = JSON.parse(existing);
    // NEW: also resolve the real Supabase listings.id here, not just on the
    // fresh-creation path below — a returning session (very common, since
    // most listings get revisited across multiple staging sessions) needs
    // SESSION.listingId just as much as a brand-new one does. video-job.js
    // needs this literal Supabase primary key, NOT proj.projectId (that's a
    // separate text column — see the write below for why these differ).
    let listingId = null;
    if (process.env.SUPABASE_URL) {
      try {
        const listingLookup = await supabase("GET", "listings", null,
          `?project_id=eq.${proj.projectId}&select=id&limit=1`
        );
        listingId = listingLookup.data?.[0]?.id || null;
      } catch (err) {
        console.error("Listing id lookup error (non-fatal):", err.message);
      }
    }
    return { created: false, existing: true, projectId: proj.projectId, complianceUrl: proj.complianceUrl, listingId };
  }

  // Determine tier from Supabase user context if userId provided
  let tier = "solo";
  let userContext = null;
  if (userId && process.env.SUPABASE_URL) {
    userContext = await getSupabaseUserContext(userId);
    if (userContext) tier = getRoleTier(userContext.role);
  }

  const projectId = generateProjectId(address, tier);
  const cUrl      = complianceUrl(projectId, siteUrl);

  const project = {
    projectId,
    address,
    complianceUrl: cUrl,
    tier,
    userId:         userId     || null,
    agentName:      agentInfo.agentName      || env.AGENT_NAME      || "",
    agentBrokerage: agentInfo.agentBrokerage || env.AGENT_BROKERAGE || "",
    agentDRE:       agentInfo.agentDRE       || env.AGENT_DRE       || "",
    agentLogoUrl:   agentInfo.agentLogoUrl   || env.AGENT_LOGO_URL  || "",
    createdAt: new Date().toISOString(),
    status: "active",
    images: [],
  };

  // Write to Netlify Blobs (existing system — do not change)
  await store.set(addrKey, JSON.stringify(project));
  await store.set("pid_" + projectId, JSON.stringify(project));
  console.log("Project created:", projectId, "tier:", tier, "address:", address);

  // ── Write to Supabase listings table (new) ────────────────────────────────
  let listingId = null;
  if (userId && process.env.SUPABASE_URL) {
    try {
      const listingWrite = await supabase("POST", "listings", {
        address,
        project_id:          projectId,
        compliance_page_url: cUrl,
        mls_number:          agentInfo.mlsNumber || null,
        user_id:             userId,
        team_id:             userContext?.team_id      || null,
        brokerage_id:        userContext?.brokerage_id || null,
        status:              "active",
      });
      // NEW: capture the real Supabase id — this is what video-job.js's
      // action=frames/action=create actually need as "listingId". Distinct
      // from projectId (the human-readable compliance slug above) — the two
      // are different columns on this same row, confirmed against
      // get-user-listings.js's explicit `select=id,...,project_id,...`.
      // Never returned to the frontend before this change, even though the
      // row itself has always existed the moment a project is created.
      listingId = listingWrite.data?.[0]?.id || null;
    } catch (err) {
      // Non-fatal — Blobs write already succeeded
      console.error("Supabase listing write error (non-fatal):", err.message);
    }
  }

  return { created: true, projectId, complianceUrl: cUrl, listingId };
}

// ── ACTION: ADD IMAGE ─────────────────────────────────────────────────────────

async function addImage(projectId, imageData, userId, ab723Prompt, env) {
  const store  = getProjectStore(env);
  const pidKey = "pid_" + projectId;

  const raw = await store.get(pidKey);
  if (!raw) throw new Error("Project not found: " + projectId);

  const project = JSON.parse(raw);
  const addrKey = "addr_" + addressHash(project.address);

  const imageEntry = {
    imageId:     "img_" + Date.now().toString(36) + "_" + Math.random().toString(36).slice(2, 5),
    roomName:    imageData.roomName    || "Room",
    tier:        imageData.tier        || "final",
    originalUrl: imageData.originalUrl || null,
    stagedUrl:   imageData.stagedUrl   || null,
    sbsUrl:      imageData.sbsUrl      || null,
    stagedAt:    new Date().toISOString(),
    fileName:    imageData.fileName    || "",
  };

  project.images    = project.images || [];
  project.images.push(imageEntry);
  project.updatedAt = new Date().toISOString();

  // Update Netlify Blobs (existing system — do not change)
  const updated = JSON.stringify(project);
  await store.set(pidKey, updated);
  await store.set(addrKey, updated);
  console.log("Image added to project:", projectId, "room:", imageEntry.roomName, "total:", project.images.length);

  // ── Write to Supabase staged_images (compliance record ONLY) ─────────────
  // CHANGE: removed the credit_ledger debit that used to live in this block
  // entirely. This was a real, serious bug: generateFinal() in index.html
  // already debits 1 Image at click time via debit-credit.js — that's the
  // correct, only billing event for a staged image. This second debit
  // (defaulting to 25 Images, completely independent of the first) existed
  // in the code from an earlier, since-abandoned architecture and had been
  // silently failing (blocked by the staged_images_mode_check constraint
  // violation, fixed separately) until that fix accidentally un-silenced
  // it — at which point every single Generate Final started being charged
  // TWICE: 1 Image via debit-credit.js, then 25 more Images moments later
  // via this block. Confirmed directly via credit_ledger query showing
  // paired -1/-25 entries for the same Generate Final action. addImage()
  // now ONLY writes the staged_images compliance record — it must never
  // touch credit_ledger again. If a future session wants to consolidate
  // billing logic, do it by removing the debit-credit.js call, not by
  // re-adding one here.
  if (userId && process.env.SUPABASE_URL) {
    try {
      // Find listing ID from Supabase
      const listingResult = await supabase("GET", "listings", null,
        `?project_id=eq.${projectId}&select=id`
      );
      const listingId = listingResult.data?.[0]?.id;

      if (listingId) {
        // Write staged_images compliance record — no credit_used value is
        // meaningful here anymore since this path never debits; kept at 0
        // rather than removed, since the column itself may still be read
        // elsewhere (e.g. compliance audit reports) and NULL could break
        // a report expecting a number.
        // room_type column added to staged_images July 15, 2026 (confirmed
        // via direct schema inspection) — imageEntry.roomName (set above)
        // already holds the real human-readable room label from Smart
        // Stage PRO's own staging flow; now actually carried into this
        // insert instead of only living in Netlify Blobs.
        const imgResult = await supabase("POST", "staged_images", {
          listing_id:             listingId,
          user_id:                userId,
          mode:                   imageData.mode || imageEntry.tier,
          room_type:              imageEntry.roomName || null,
          ab723_prompt:           ab723Prompt    || imageData.ab723Prompt || "",
          cloudinary_original_url: imageData.originalUrl || null,
          cloudinary_staged_url:   imageData.stagedUrl   || null,
          cloudinary_sbs_url:      imageData.sbsUrl       || null,
          credits_used:            0,
          ab723_disclosed:         false,
        });

        const stagedImageId = imgResult.data?.[0]?.id || null;
        if (!stagedImageId) {
          console.error(
            "staged_images insert returned no row — status:", imgResult.status,
            "| response:", JSON.stringify(imgResult.data),
            "| projectId:", projectId, "| mode sent:", imageData.mode || imageEntry.tier
          );
        }
      } else {
        console.error("addImage: no listing found for projectId — Supabase write skipped:", projectId);
      }
    } catch (err) {
      // Non-fatal — Blobs write already succeeded
      console.error("Supabase staged_images write error (non-fatal):", err.message);
    }
  }

  return {
    added:      true,
    imageId:    imageEntry.imageId,
    imageCount: project.images.length,
  };
}

// ── HANDLER ──────────────────────────────────────────────────────────────────

exports.handler = async (event) => {
  const headers = {
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Headers": "Content-Type",
    "Content-Type": "application/json",
  };

  if (event.httpMethod === "OPTIONS") return { statusCode: 200, headers, body: "" };

  const action = event.queryStringParameters?.action;

  try {
    const body = JSON.parse(event.body || "{}");

    if (action === "lookup") {
      const { address } = body;
      if (!address) return { statusCode: 400, headers, body: JSON.stringify({ error: "Missing address" }) };
      const result = await lookupProject(address, process.env);
      return { statusCode: 200, headers, body: JSON.stringify(result) };
    }

    if (action === "create") {
      const { address, agentInfo, siteUrl, userId } = body;
      if (!address) return { statusCode: 400, headers, body: JSON.stringify({ error: "Missing address" }) };
      const result = await createProject(address, agentInfo || {}, siteUrl, userId || null, process.env);
      return { statusCode: 200, headers, body: JSON.stringify(result) };
    }

    if (action === "add-image") {
      const { projectId, imageData, userId, ab723Prompt } = body;
      if (!projectId) return { statusCode: 400, headers, body: JSON.stringify({ error: "Missing projectId" }) };
      const result = await addImage(projectId, imageData || {}, userId || null, ab723Prompt || null, process.env);
      return { statusCode: 200, headers, body: JSON.stringify(result) };
    }

    return { statusCode: 400, headers, body: JSON.stringify({ error: "Unknown action: " + action }) };

  } catch (err) {
    console.error("project-manage error:", err.message);
    return { statusCode: 500, headers, body: JSON.stringify({ error: err.message }) };
  }
};
