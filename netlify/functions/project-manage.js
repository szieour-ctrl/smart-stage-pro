// project-manage.js — Netlify Function
// Handles: project lookup, project creation, image attachment — LISTINGS ONLY.
// Routes via ?action= parameter
//
// action=lookup    — check if project exists for address
// action=create    — create new project for address
// action=add-image — attach a staged image to existing project
//
// Supabase integration: createProject writes to listings table,
// addImage writes to staged_images table and debits credits.
// userId is required in body for create and add-image actions.
//
// PIPELINE SEPARATION (Sep 16, 2026): this file used to also handle
// Prospecting via an `isProspecting` flag threaded through nearly every
// function here — lookup/create branching on it, a one-directional
// false->true sync rule, a separate date-prefixed slug format, etc. That
// flag-on-Listings design was the direct cause of a real, live incident:
// searching an address with the Prospecting checkbox unchecked still
// surfaced an existing Prospecting contact for that address, because both
// shared the exact same Blobs key and the exact same `listings` row —
// there was no way for the same address to independently be BOTH a
// permanent Marketing contact and a real Listing under the same account.
// Per Sam: Prospecting exists to convert an AGENT into a subscriber, not
// to convert a PROPERTY into a listing — the two were never the same kind
// of thing and should never have shared a table. Prospecting now lives
// entirely in marketing-manage.js, its own `prospects` table, and its own
// Netlify Blobs store — this file no longer knows Prospecting exists.
// Existing `listings` rows with is_prospecting=true from before this
// migration are left untouched (out of scope, historical data) — nothing
// here reads or writes that column anymore.

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

// FIX (Sep 16, 2026 — real bug, confirmed live for 11625 Tortuguero Way):
// every place in this file that inserts a `listings` row used to be a
// single, unretried POST wrapped in try/catch that logged and moved on.
// One transient failure meant the row simply never existed — and since
// upload-original.js/upload-staged.js's lookupListingSlug() only ever
// receives a projectId (no address) with nothing to backfill from, that
// single miss cascaded into legacy S3 naming for the whole shot. A one-off
// insert failure is far more likely to be transient (a network blip, a
// brief Supabase hiccup) than a real, retry-proof error, so this retries a
// few times — same spirit as reserveAssetKey's retry loop elsewhere in
// this codebase — before giving up. Returns { listingId, status } on
// success, or { listingId: null, lastError } if every attempt failed;
// never throws, matching how callers already treat this as non-fatal (the
// Netlify Blobs write is the one that must not fail).
async function insertListingWithRetry(payload, label) {
  const MAX_ATTEMPTS = 3;
  let lastError = null;
  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    try {
      const res = await supabase("POST", "listings", payload);
      const listingId = res.data?.[0]?.id || null;
      console.log(
        `${label}: insert attempt ${attempt}/${MAX_ATTEMPTS} — status:`, res.status,
        "listingId:", listingId, "row returned:", JSON.stringify(res.data)
      );
      if (listingId) return { listingId, status: res.status };
      lastError = new Error(`insert returned no listingId (status ${res.status})`);
    } catch (err) {
      lastError = err;
      console.error(`${label}: insert attempt ${attempt}/${MAX_ATTEMPTS} failed:`, err.message);
    }
    if (attempt < MAX_ATTEMPTS) {
      await new Promise(resolve => setTimeout(resolve, attempt * 300));
    }
  }
  console.error(
    `${label}: FAILED after ${MAX_ATTEMPTS} attempts — no listings row exists for project_id ` +
    `${payload.project_id}. Downstream uploads will use legacy naming until this is backfilled. Last error:`,
    lastError.message
  );
  return { listingId: null, lastError };
}

async function getSupabaseUserContext(userId) {
  if (!userId || !process.env.SUPABASE_URL) return null;
  const r = await supabase("GET", "users", null,
    `?id=eq.${userId}&select=id,role,team_id,brokerage_id,subscription_status,created_at,data_expires_at`
  );
  return r.data?.[0] || null;
}

// ── PLAN RULES FOR LISTINGS (Sep 24, 2026) ──────────────────────────────────
// Trial listings: compliance page comes down with the trial's data window
//   (signup + 60 days = 30-day trial + 30 days to export). Stamped on the
//   listing row at insert.
// Listing Package ($59): each purchase is ONE listing slot. A package
//   account may only work on listings that a package has claimed; the first
//   listing it opens or creates while it holds an unclaimed slot claims it
//   (claim_listing_package() in Supabase — atomic, also stamps the 6-month
//   compliance expiry). No free slot → { packageRequired: true } and the app
//   offers another package for that address instead of a project.
// Subscribers: nothing changes (compliance_expires_at stays NULL).

const TRIAL_DATA_WINDOW_MS = 60 * 24 * 60 * 60 * 1000;

function trialComplianceExpiry(userContext) {
  if (userContext?.subscription_status !== "trial") return undefined;
  if (userContext.data_expires_at) return userContext.data_expires_at;
  if (userContext.created_at) return new Date(new Date(userContext.created_at).getTime() + TRIAL_DATA_WINDOW_MS).toISOString();
  return undefined;
}

// Adds compliance_expires_at to a listings insert payload for trial accounts.
function withPlanFields(payload, userContext) {
  const exp = trialComplianceExpiry(userContext);
  return exp ? { ...payload, compliance_expires_at: exp } : payload;
}

async function packageSlotAvailable(userId) {
  const r = await supabase("GET", "listing_packages", null,
    `?user_id=eq.${userId}&listing_id=is.null&access_expires_at=gt.${encodeURIComponent(new Date().toISOString())}&select=id&limit=1`
  );
  if (r.status >= 300) throw new Error(`package slot check failed (${r.status})`);
  return Array.isArray(r.data) && r.data.length > 0;
}

// Returns null when the account may use this listing, or the response the
// handler should send instead.
async function enforcePackage(userContext, userId, listingId, extra = {}) {
  if (userContext?.subscription_status !== "package") return null;
  if (!listingId) return { packageRequired: true, reason: "no_listing_row", ...extra };
  const r = await supabase("POST", "rpc/claim_listing_package", { p_user_id: userId, p_listing_id: listingId });
  if (r.status >= 300) throw new Error(`package claim failed (${r.status})`);
  const out = r.data && typeof r.data === "object" && !Array.isArray(r.data) ? r.data : (Array.isArray(r.data) ? r.data[0] : null);
  if (out?.ok) return null;
  return { packageRequired: true, reason: out?.reason || "no_free_package", ...extra };
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
  // FIX (Sep 10, 2026 — real bug: same physical property got 3 separate
  // listing rows in one evening, none of them duplicates of each other by
  // any fault of the user — Google Places returned slightly different
  // formatted text across searches: "...Sacramento, California" vs
  // "...Sacramento, CA", and once dropped the "N" directional prefix
  // entirely ("1619 N Breezy Meadow Dr" vs "1619 Breezy Meadow Dr"). The
  // old normalization only lowercased/collapsed whitespace/stripped
  // punctuation — none of which touches a full-state-name-vs-abbreviation
  // difference or a missing directional token, so each variant hashed to
  // a completely different key, and lookupProject() found nothing every
  // time. See Notion decision doc for the full incident.
  //
  // Two changes, both matching conventions already established elsewhere
  // in this file:
  //   1. Drop city/state/zip entirely before hashing — same "street
  //      address only" convention slugifyAddress() and generateProjectId()
  //      above already use. City/state formatting is exactly what varied
  //      between Google's responses tonight and should never affect
  //      whether this is "the same project" for one agent.
  //   2. Normalize a leading directional token (N/North, S/South, E/East,
  //      W/West) so "1619 N Breezy Meadow Dr" and "1619 North Breezy
  //      Meadow Dr" — or the same address with the directional dropped by
  //      a different autocomplete pass — all hash identically.
  //
  // Does NOT fix every possible Google Places formatting variance (unit
  // numbers, "St" vs "Street", etc.) — this addresses the two specific
  // variations confirmed causing real duplicates. The more complete fix
  // would key off Google's stable place_id instead of formatted address
  // text at all, but that requires the frontend to capture and pass
  // place_id through, which it doesn't currently do — worth a follow-up
  // if this class of bug recurs with a different formatting variant.
  const normalized = (address || "")
    .toLowerCase()
    .replace(/,.*$/, "")
    .replace(/^(\d+)\s+(n|north|s|south|e|east|w|west)\b\.?\s*/, "$1 ")
    .replace(/\s+/g, " ")
    .replace(/[^a-z0-9\s]/g, "")
    .trim();
  return crypto.createHash("md5").update(normalized).digest("hex").slice(0, 16);
}

// NEW (Aug 28, 2026 — readable S3 naming migration): a human-readable slug
// for the listings row, e.g. "2089 Thornecroft Ln, Roseville, CA" ->
// "2089-thornecroft-ln". Distinct from generateProjectId()'s output below
// (that one's a compliance-URL slug with an agent tier + date baked in,
// e.g. szregsolo_2089thornecroftln_082826) — this one is just the address,
// meant to be read directly in the S3 console and in Supabase. Same
// function is duplicated (not imported) in upload-original.js and
// upload-staged.js, matching this codebase's existing per-file style —
// they only ever need to derive one as a fallback if a listing row
// predates this column; the real value is written once, here.
function slugifyAddress(address) {
  return (address || "")
    .toLowerCase()
    .replace(/,.*$/, "")          // drop city/state — street address only
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 60);
}

function getRoleTier(role) {
  // Maps Supabase role to project ID tier label
  if (role === "team_lead" || role === "team_member") return "team";
  if (role === "broker_admin") return "brokerage";
  return "solo";
}

function generateProjectId(address, tier = "solo") {
  // Format: szreg{tier}_{streetaddr}_{MMDDYY}_{rand4}
  // e.g. szregsolo_201benttreect_060126_a3f9
  // rand4 (Aug 28, 2026 fix): two different agents staging the same
  // address on the same day at the same tier used to generate the exact
  // same projectId string — every downstream lookup that resolves a
  // listing by project_id alone (upload-original.js, upload-staged.js,
  // addImage's staged_images write, etc.) would then risk matching the
  // WRONG agent's row via `limit=1`. Appending 4 random base36 chars makes
  // every projectId effectively unique per creation event, independent of
  // address/date/tier collisions, so those downstream project_id-only
  // lookups stay safe without needing to thread userId through all of them.
  //
  // FIX (Sep 16, 2026 — real bug, confirmed against live Supabase
  // timestamps): now.getMonth()/getDate()/getFullYear() read the SERVER's
  // clock, which for Netlify Functions is UTC — not Sam's Pacific
  // timezone. Any project created after 5pm Pacific has already crossed
  // into the next UTC day, so it got tomorrow's date baked into its
  // projectId. Fixed by formatting explicitly in America/Los_Angeles
  // rather than relying on the server's own local clock.
  const now = new Date();
  const pacificParts = new Intl.DateTimeFormat("en-US", {
    timeZone: "America/Los_Angeles",
    year: "2-digit", month: "2-digit", day: "2-digit",
  }).formatToParts(now).reduce((acc, p) => { acc[p.type] = p.value; return acc; }, {});
  const mm = pacificParts.month;
  const dd = pacificParts.day;
  const yy = pacificParts.year;
  const addrSlug = (address || "")
    .toLowerCase()
    .replace(/,.*$/, "")
    .replace(/[^a-z0-9]+/g, "")
    .slice(0, 20);
  const rand4 = crypto.randomBytes(3).toString("hex").slice(0, 4);
  return `szreg${tier}_${addrSlug}_${mm}${dd}${yy}_${rand4}`;
}

function complianceUrl(projectId, siteUrl) {
  const base = siteUrl || "https://smartstagepro.com";
  return `${base}/compliance/${projectId}`;
}

// ── ACTION: LOOKUP ───────────────────────────────────────────────────────────

async function lookupProject(address, userId, env) {
  address = cleanAddress(address);
  const store = getProjectStore(env);
  // FIX (Aug 28, 2026 — real bug, per Sam's requirement: each agent login
  // owns their own listings, full stop): this key used to be address-only
  // ("addr_" + addressHash), so a second agent looking up an address you'd
  // already staged found YOUR Blobs record and got attached to your
  // projectId/listingId instead of starting their own. Scoping the key by
  // userId means two agents staging the same physical address each get
  // their own project, their own listing row, and — since compliance URLs
  // are derived 1:1 from projectId — their own separate compliance page.
  // "anon" fallback covers the (currently rare/legacy) case of a lookup
  // with no logged-in session; it deliberately does NOT collide with any
  // real userId's keyspace.
  const key = "addr_" + (userId || "anon") + "_" + addressHash(address);
  try {
    const raw = await store.get(key);
    if (!raw) return { exists: false };
    const project = JSON.parse(raw);
    // NEW: resolve the real Supabase listings.id here too — the lookup path
    // is how a returning session finds an already-created project, and it
    // needs SESSION.listingId exactly as much as a fresh create does (see
    // the matching fix in createProject's existing-project branch above).
    let listingId = null;
    let slug = null;
    if (process.env.SUPABASE_URL) {
      try {
        const listingLookup = await supabase("GET", "listings", null,
          `?project_id=eq.${project.projectId}&select=id,slug&limit=1`
        );
        listingId = listingLookup.data?.[0]?.id || null;
        slug = listingLookup.data?.[0]?.slug || null;

        // Listing predates the slug column — derive one now and best-effort
        // patch it back so future uploads for this listing skip this branch.
        if (listingId && !slug) {
          slug = slugifyAddress(project.address);
          if (slug) {
            // AWAITED (Aug 28, 2026 — fixed a real bug, not a hypothesis):
            // confirmed via live testing that Netlify Functions can tear
            // down before an un-awaited background write completes.
            try {
              await supabase("PATCH", "listings", { slug }, `?project_id=eq.${project.projectId}`);
            } catch (e) {
              console.error("lookupProject: slug backfill patch failed (non-fatal):", e.message);
            }
          }
        }
        // FIX (Sep 8, 2026): if listingId came back null because no
        // Supabase row exists at all for this project_id, nothing above
        // ever creates one — and since this lookup path is what EVERY
        // repeat search after the first hits, a project stuck in this
        // state stays stuck on every single visit, forever, with
        // upload-original.js/upload-staged.js unable to resolve a slug
        // and silently falling back to legacy projectId-based S3 naming.
        if (!listingId) {
          let backfillTier = "solo";
          let backfillUserContext = null;
          if (userId) {
            try {
              backfillUserContext = await getSupabaseUserContext(userId);
              if (backfillUserContext) backfillTier = getRoleTier(backfillUserContext.role);
            } catch (e) {
              console.error("lookupProject: could not resolve user context for backfill (non-fatal):", e.message);
            }
          }
          const backfillSlug = slugifyAddress(project.address);
          const result = await insertListingWithRetry(withPlanFields({
            address: project.address,
            project_id: project.projectId,
            slug: backfillSlug,
            compliance_page_url: project.complianceUrl,
            mls_number: null,
            user_id: userId || null,
            team_id: backfillUserContext?.team_id || null,
            brokerage_id: backfillUserContext?.brokerage_id || null,
            status: "active",
          }, backfillUserContext), "lookupProject (missing-row backfill)");
          listingId = result.listingId;
          if (listingId) slug = backfillSlug;
        }
      } catch (err) {
        console.error("Listing id lookup error (non-fatal):", err.message);
      }
    }
    // Listing Package accounts: this listing must hold (or now claim) a slot.
    // Errors here propagate (fail closed) — see the handler.
    if (userId) {
      const pkgCtx = await getSupabaseUserContext(userId);
      const blocked = await enforcePackage(pkgCtx, userId, listingId, { exists: true, address: project.address });
      if (blocked) return blocked;
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
      slug,
    };
  } catch (err) {
    if (/^package (claim|slot check) failed/.test(err.message)) throw err; // fail closed
    console.error("lookup error:", err.message);
    return { exists: false };
  }
}

// ── ACTION: CREATE ───────────────────────────────────────────────────────────

async function createProject(address, agentInfo, siteUrl, userId, env) {
  address = cleanAddress(address);
  const store   = getProjectStore(env);
  // Scoped by userId — see matching fix + comment in lookupProject above.
  const addrKey = "addr_" + (userId || "anon") + "_" + addressHash(address);

  let tier = "solo";
  let userContext = null;
  if (userId && process.env.SUPABASE_URL) {
    userContext = await getSupabaseUserContext(userId);
    if (userContext) tier = getRoleTier(userContext.role);
  }

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
    let slug = null;
    if (process.env.SUPABASE_URL) {
      try {
        const listingLookup = await supabase("GET", "listings", null,
          `?project_id=eq.${proj.projectId}&select=id,slug&limit=1`
        );
        listingId = listingLookup.data?.[0]?.id || null;
        slug = listingLookup.data?.[0]?.slug || null;

        if (listingId && !slug) {
          slug = slugifyAddress(proj.address);
          if (slug) {
            try {
              await supabase("PATCH", "listings", { slug }, `?project_id=eq.${proj.projectId}`);
            } catch (e) {
              console.error("createProject: slug backfill patch failed (non-fatal):", e.message);
            }
          }
        }
        // FIX (Sep 8, 2026): if listingId came back null because no row
        // exists at all (not "a row with stale data", genuinely no row),
        // create one now rather than perpetuating the gap on every retry.
        if (!listingId) {
          const backfillSlug = slugifyAddress(proj.address);
          const result = await insertListingWithRetry(withPlanFields({
            address: proj.address,
            project_id: proj.projectId,
            slug: backfillSlug,
            compliance_page_url: proj.complianceUrl,
            mls_number: agentInfo?.mlsNumber || null,
            user_id: userId || null,
            team_id: userContext?.team_id || null,
            brokerage_id: userContext?.brokerage_id || null,
            status: "active",
          }, userContext), "createProject (race-guard branch backfill)");
          listingId = result.listingId;
          if (listingId) slug = backfillSlug;
        }
      } catch (err) {
        console.error("Listing id lookup error (non-fatal):", err.message);
      }
    }
    const blockedExisting = await enforcePackage(userContext, userId, listingId, { created: false, address: proj.address });
    if (blockedExisting) return blockedExisting;
    return { created: false, existing: true, projectId: proj.projectId, complianceUrl: proj.complianceUrl, listingId, slug };
  }

  // Listing Package account with no unclaimed slot: never create a project.
  if (userContext?.subscription_status === "package" && !(await packageSlotAvailable(userId))) {
    return { created: false, packageRequired: true, reason: "no_free_package", address };
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

  // ── Write to Supabase listings table ──────────────────────────────────
  let listingId = null;
  const slug = slugifyAddress(address);
  if (process.env.SUPABASE_URL) {
    // FIX (Sep 16, 2026 — real bug, confirmed live for 11625 Tortuguero
    // Way): this used to be a single, unretried POST — a catch swallowed
    // any failure as "non-fatal" on the theory that the Blobs write
    // already succeeded and this write is best-effort. In practice, a
    // single failed attempt here means NO listings row ever exists for
    // this project — lookupListingSlug() in upload-original.js/
    // upload-staged.js then has nothing to find, so it falls back to the
    // legacy smart-stage-originals/smart-stage-finals/ naming. See
    // insertListingWithRetry() above for why this now retries.
    const result = await insertListingWithRetry(withPlanFields({
      address,
      project_id:          projectId,
      slug,
      compliance_page_url: cUrl,
      mls_number:          agentInfo.mlsNumber || null,
      user_id:             userId,
      team_id:             userContext?.team_id      || null,
      brokerage_id:        userContext?.brokerage_id || null,
      status:              "active",
    }, userContext), "createProject (fresh insert)");
    // NEW: capture the real Supabase id — this is what video-job.js's
    // action=frames/action=create actually need as "listingId". Distinct
    // from projectId (the human-readable compliance slug above) — the two
    // are different columns on this same row.
    listingId = result.listingId;
  }

  // Claim the slot checked above. Losing a race to another tab leaves the
  // listing unclaimed — the app then offers a package for it, same as lookup.
  const blockedNew = await enforcePackage(userContext, userId, listingId, { created: false, address });
  if (blockedNew) return blockedNew;

  return { created: true, projectId, complianceUrl: cUrl, listingId, slug };
}

// ── ACTION: ADD IMAGE ─────────────────────────────────────────────────────────

async function addImage(projectId, imageData, userId, ab723Prompt, env) {
  const store  = getProjectStore(env);
  const pidKey = "pid_" + projectId;

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

  // FIX (this session — confirmed real data-loss bug, not a hypothesis):
  // this was previously a plain read-modify-write on ONE shared Blobs key
  // with zero concurrency protection:
  //   const raw = await store.get(pidKey); ...push...; await store.set(pidKey, updated);
  // Firing several Generate Final calls in quick succession — exactly what
  // happens staging a batch of rooms — let a second call's GET land before
  // the first call's SET did, so the second call's in-memory array never
  // contained the first room's entry. When it wrote back, it silently
  // overwrote the first room's addition entirely — even though THAT call's
  // own "Image added to project" log line had already reported success.
  // Confirmed against real Netlify logs: multiple clean, sequential-looking
  // successes for Vacant Stage rooms that never actually appeared on the
  // compliance page, while Declutter and Exterior (run one at a time, no
  // batch) were unaffected.
  //
  // Fixed with optimistic concurrency using Blobs' native conditional
  // write support (@netlify/blobs v10.7+, confirmed against the installed
  // package's own type definitions): read the current entry AND its ETag,
  // write ONLY if that ETag still matches (onlyIfMatch) — i.e. nothing else
  // wrote in between. If it doesn't match, `modified` comes back false;
  // re-read the now-newer array and retry the whole append from scratch.
  // Small randomized backoff between attempts so multiple retrying calls
  // don't just re-collide in lockstep.
  const MAX_CAS_ATTEMPTS = 8;
  let project = null;
  let succeeded = false;

  for (let attempt = 1; attempt <= MAX_CAS_ATTEMPTS; attempt++) {
    const existing = await store.getWithMetadata(pidKey);
    if (!existing) throw new Error("Project not found: " + projectId);

    project = JSON.parse(existing.data);
    project.images = project.images || [];
    project.images.push(imageEntry);
    project.updatedAt = new Date().toISOString();

    const updated = JSON.stringify(project);
    const writeResult = await store.set(pidKey, updated, { onlyIfMatch: existing.etag });

    if (writeResult.modified === false) {
      console.warn(`addImage: CAS conflict on ${pidKey} (attempt ${attempt}/${MAX_CAS_ATTEMPTS}) — another write landed first, retrying`);
      await new Promise(r => setTimeout(r, 60 * attempt + Math.floor(Math.random() * 50)));
      continue;
    }

    // Won the write. Mirror to the secondary address-keyed lookup —
    // best-effort, unconditional. compliance-page.js and every other
    // reader use pidKey as the source of truth (confirmed directly in
    // compliance-page.js), so a rare race on addrKey is secondary-index
    // staleness, not data loss, and doesn't need the same CAS treatment.
    // Scoped by userId — must match the key scheme in lookupProject/
    // createProject above, or this secondary index silently falls out of
    // sync with the primary pidKey record.
    const addrKey = "addr_" + (project.userId || "anon") + "_" + addressHash(project.address);
    await store.set(addrKey, updated);
    console.log(
      "Image added to project:", projectId, "room:", imageEntry.roomName,
      "total:", project.images.length,
      attempt > 1 ? `(succeeded after ${attempt} CAS attempts)` : ""
    );
    succeeded = true;
    break;
  }

  if (!succeeded) {
    throw new Error(
      `addImage: failed to write after ${MAX_CAS_ATTEMPTS} CAS attempts on ${pidKey} — ` +
      `project is under unusually heavy concurrent write load, or something is retrying without backoff elsewhere`
    );
  }

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
  // FIX (Sep 2026 — real bug: 11 of 12 rooms on a real listing never
  // reached staged_images, with zero error surfaced anywhere, because
  // this whole block used to just silently no-op whenever userId was
  // falsy — most likely a session-token read race on the frontend
  // finalizing many rooms back-to-back. Blobs still succeeded every
  // time, so attachFinalToProject() reported "✓ Added to compliance
  // project" regardless — a false success. This is now tracked into
  // `complianceWarning` on every failure branch (missing userId,
  // missing listing row, insert returning no row, thrown exception)
  // and returned to the frontend instead of only ever reaching a
  // server log nobody was watching.
  let complianceWarning = null;

  if (!userId) {
    complianceWarning = "No userId available — compliance record was not written to Supabase (image is still saved).";
    console.error("addImage: Supabase write skipped, no userId — projectId:", projectId);
  } else if (process.env.SUPABASE_URL) {
    try {
      // Find listing ID from Supabase — filtered by user_id too, defense in
      // depth against any project_id string collision (see rand4 note on
      // generateProjectId above; this makes collision effectively
      // impossible going forward, but old rows created before this fix
      // won't have the suffix, so keep the extra filter).
      const listingResult = await supabase("GET", "listings", null,
        `?project_id=eq.${projectId}&user_id=eq.${userId}&select=id`
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
          hidden:                  false,
          // FIX (Sep 2026): explicitly false on insert. This row was never
          // setting `hidden` at all, so it fell through to whatever the
          // column default was (NULL) — and getFramesForListing()'s
          // `hidden=eq.false` filter silently excludes NULL, not just
          // true, so every normal final was invisible to PRO Plus Video
          // until manually toggled through hide-image.js once. See
          // hide-image.js's PATCH path for the only other place this
          // column is ever written.
          // NEW (Hero Shot B-Roll tagging) — ground truth captured at
          // Generate Final time in index.html, not reconstructed here.
          // is_hero_shot marks this row as a Cinematic Asset Generator
          // detail crop; parent_room_label is the literal source room name
          // (e.g. "Living Room") — PRO Plus's autoSelect.js uses this to
          // force-merge the hero shot into its parent room's narration
          // group when that parent frame is present in the same video
          // batch, deterministically rather than guessing from Vision.
          is_hero_shot:            !!imageData.isHeroShot,
          parent_room_label:       imageData.parentRoomLabel || null,
        });

        const stagedImageId = imgResult.data?.[0]?.id || null;
        if (!stagedImageId) {
          complianceWarning = "Compliance record insert returned no row — image is saved but may not appear in PRO Plus Video.";
          console.error(
            "staged_images insert returned no row — status:", imgResult.status,
            "| response:", JSON.stringify(imgResult.data),
            "| projectId:", projectId, "| mode sent:", imageData.mode || imageEntry.tier
          );
        }
      } else {
        complianceWarning = "No matching listing found in Supabase — compliance record was not written (image is still saved).";
        console.error("addImage: no listing found for projectId — Supabase write skipped:", projectId);
      }
    } catch (err) {
      // Blobs write already succeeded — this is real, just not fatal to
      // the image being saved. Still needs to reach the frontend now.
      complianceWarning = "Supabase compliance write failed: " + err.message;
      console.error("Supabase staged_images write error (non-fatal):", err.message);
    }
  }

  return {
    added:      true,
    imageId:    imageEntry.imageId,
    imageCount: project.images.length,
    complianceWarning,
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
      const { address, userId } = body;
      if (!address) return { statusCode: 400, headers, body: JSON.stringify({ error: "Missing address" }) };
      const result = await lookupProject(address, userId || null, process.env);
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
