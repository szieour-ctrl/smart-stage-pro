// marketing-manage.js — Netlify Function
// Handles: prospect lookup, prospect creation — MARKETING/PROSPECTING ONLY.
// Routes via ?action= parameter
//
// action=lookup — check if a prospect record exists for address + userId
// action=create — create a new prospect record for address + userId
//
// NEW (Sep 16, 2026 — pipeline separation): this is the direct result of a
// long design conversation, not a copy of project-manage.js with a flag
// swapped. Per Sam: Prospecting/Marketing exists to convert an AGENT into
// a subscriber — it has nothing to do with converting a PROPERTY into a
// listing. A prospect record and a real Listing for the exact same
// address, under the exact same account, are two entirely independent,
// permanent things — neither ever becomes the other. That's why this is
// its own file, its own Supabase table (`prospects`, not `listings`), and
// its own Netlify Blobs store (`smart-stage-marketing`, not
// `smart-stage-projects`) — sharing any of those with project-manage.js
// was the direct cause of a real incident: searching an address with the
// Prospecting checkbox UNCHECKED still surfaced an existing prospect
// contact for that address and refused to create a real Listing, because
// both were forced through the same key and the same row.
//
// Per Sam, Marketing is also simpler than Listings in every real way:
//   - No compliance page, no QR-for-legal-disclosure, no AB 723 anything —
//     a prospect record is an outreach asset, not a disclosure document.
//   - No originals/finals/thumbnails folder split — "all data, images,
//     and meta can be written and saved in the same folder." One flat
//     folder per prospect: staging-prospects/{date}__{address-slug}/.
//   - No thumbnail generation at all — Gallery already excludes
//     Prospecting entirely (see media-gallery.js), and the only consumer
//     of these images is Sam/his team manually pulling full-res URLs into
//     the GPT/Pabbly/Dubb workflow. A resized picker-grid thumbnail buys
//     nothing here and was the exact mechanism behind the Sep 16
//     originals/finals thumbnail-collision bug — simplest fix is not
//     having that mechanism exist for this pipeline at all.
//
// IDENTITY (per Sam, point 2 of the Sep 16 design conversation): "To be an
// existing listing the address AND User Id must match" — the exact same
// rule Listings already uses, just its own independent instance of it.
// userId is REQUIRED here, not defensively coalesced to "anon" the way
// project-manage.js's legacy paths do — this app requires login to use at
// all, so a request reaching this file with no userId means the frontend's
// auth guard (see index.html's requireLiveSession()) failed to do its job,
// not that an anonymous prospecting session is a normal case to support.

const { getStore } = require("@netlify/blobs");
const crypto = require("crypto");
const https  = require("https");

// ── SUPABASE HELPER (same shape as project-manage.js's) ─────────────────────

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

// Same retry pattern as project-manage.js's insertListingWithRetry — a
// single transient failure here would leave a prospect with a Blobs
// record but no Supabase row, which is exactly the class of bug the Sep
// 16 session spent hours root-causing on the Listings side. Applying the
// fix here from day one rather than waiting for this pipeline's own
// version of that incident.
async function insertProspectWithRetry(payload, label) {
  const MAX_ATTEMPTS = 3;
  let lastError = null;
  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    try {
      const res = await supabase("POST", "prospects", payload);
      const prospectId = res.data?.[0]?.id || null;
      console.log(
        `${label}: insert attempt ${attempt}/${MAX_ATTEMPTS} — status:`, res.status,
        "prospectId:", prospectId
      );
      if (prospectId) return { prospectId, status: res.status };
      lastError = new Error(`insert returned no prospectId (status ${res.status})`);
    } catch (err) {
      lastError = err;
      console.error(`${label}: insert attempt ${attempt}/${MAX_ATTEMPTS} failed:`, err.message);
    }
    if (attempt < MAX_ATTEMPTS) {
      await new Promise(resolve => setTimeout(resolve, attempt * 300));
    }
  }
  console.error(
    `${label}: FAILED after ${MAX_ATTEMPTS} attempts — no prospects row exists for project_id ` +
    `${payload.project_id}. Last error:`, lastError.message
  );
  return { prospectId: null, lastError };
}

// ── NETLIFY BLOBS STORE ──────────────────────────────────────────────────────
// Deliberately its own store name, separate from project-manage.js's
// "smart-stage-projects" — see file header. Nothing in this file ever
// reads or writes to that store, and nothing in project-manage.js ever
// touches this one.

function getMarketingStore(env) {
  return getStore({
    name: "smart-stage-marketing",
    siteID: env.NETLIFY_SITE_ID,
    token: env.NETLIFY_ACCESS_TOKEN,
  });
}

// ── HELPERS ──────────────────────────────────────────────────────────────────

function cleanAddress(address) {
  return (address || "").replace(/,\s*USA\s*$/i, "").trim();
}

// Same normalization as project-manage.js's addressHash — duplicated
// rather than shared, matching this codebase's existing per-file
// convention. Kept identical on purpose: if the two pipelines' hashing
// ever drifted apart, two visually-identical addresses could hash
// differently between Listings and Marketing for no visible reason.
function addressHash(address) {
  const normalized = (address || "")
    .toLowerCase()
    .replace(/,.*$/, "")
    .replace(/^(\d+)\s+(n|north|s|south|e|east|w|west)\b\.?\s*/, "$1 ")
    .replace(/\s+/g, " ")
    .replace(/[^a-z0-9\s]/g, "")
    .trim();
  return crypto.createHash("md5").update(normalized).digest("hex").slice(0, 16);
}

function slugifyAddress(address) {
  return (address || "")
    .toLowerCase()
    .replace(/,.*$/, "")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 60);
}

// Date-prefixed slug — e.g. "2026-09-16__201-bent-tree-ct" — so
// staging-prospects/ folders sort chronologically in the S3 console, per
// Sam's Sep 13 request on the old prospecting-under-Listings design.
// Computed directly from "now" in Pacific time at creation — unlike
// project-manage.js's old slugifyProspectAddress(), this file mints its
// own projectId in the same call, so there's no need to parse a date back
// out of an existing ID later; the date is simply generated once, here,
// and used for both.
function todayPacific() {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: "America/Los_Angeles",
    year: "numeric", month: "2-digit", day: "2-digit",
  }).formatToParts(new Date()).reduce((acc, p) => { acc[p.type] = p.value; return acc; }, {});
  return `${parts.year}-${parts.month}-${parts.day}`;
}

function slugifyProspectAddress(address) {
  return `${todayPacific()}__${slugifyAddress(address)}`;
}

// projectId format: prospect_{streetaddr}_{MMDDYY}_{rand4} — visually
// distinct from Listings' "szreg{tier}_..." at a glance, since tier/role
// has no meaning for Marketing (no team/brokerage scoping — see file
// header's identity note). Same rand4 collision-avoidance as
// project-manage.js's generateProjectId.
function generateProjectId(address) {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: "America/Los_Angeles",
    year: "2-digit", month: "2-digit", day: "2-digit",
  }).formatToParts(new Date()).reduce((acc, p) => { acc[p.type] = p.value; return acc; }, {});
  const addrSlug = (address || "")
    .toLowerCase()
    .replace(/,.*$/, "")
    .replace(/[^a-z0-9]+/g, "")
    .slice(0, 20);
  const rand4 = crypto.randomBytes(3).toString("hex").slice(0, 4);
  return `prospect_${addrSlug}_${parts.month}${parts.day}${parts.year}_${rand4}`;
}

// ── ACTION: LOOKUP ───────────────────────────────────────────────────────────

async function lookupProspect(address, userId, env) {
  address = cleanAddress(address);
  const store = getMarketingStore(env);
  // Same (userId + address) identity rule as Listings — its own
  // independent key in its own store, so a Marketing record and a real
  // Listing for the same address never share or contend for anything.
  const key = "addr_" + userId + "_" + addressHash(address);
  try {
    const raw = await store.get(key);
    if (!raw) return { exists: false };
    const prospect = JSON.parse(raw);

    let prospectRowId = null;
    let slug = null;
    if (process.env.SUPABASE_URL) {
      try {
        const lookup = await supabase("GET", "prospects", null,
          `?project_id=eq.${prospect.projectId}&select=id,slug&limit=1`
        );
        prospectRowId = lookup.data?.[0]?.id || null;
        slug = lookup.data?.[0]?.slug || null;

        // Missing-row backfill — same reasoning as project-manage.js's
        // matching branch: a Blobs record with no Supabase row would
        // otherwise stay stuck that way on every future visit.
        if (!prospectRowId) {
          const backfillSlug = slug || slugifyProspectAddress(prospect.address);
          const result = await insertProspectWithRetry({
            address: prospect.address,
            project_id: prospect.projectId,
            slug: backfillSlug,
            user_id: userId,
          }, "lookupProspect (missing-row backfill)");
          prospectRowId = result.prospectId;
          if (prospectRowId) slug = backfillSlug;
        }
      } catch (err) {
        console.error("lookupProspect: Supabase lookup error (non-fatal):", err.message);
      }
    }

    return {
      exists:     true,
      projectId:  prospect.projectId,
      address:    prospect.address,
      createdAt:  prospect.createdAt,
      prospectId: prospectRowId,
      slug,
      isProspecting: true, // kept for frontend render-branch compatibility — see index.html
    };
  } catch (err) {
    console.error("lookupProspect error:", err.message);
    return { exists: false };
  }
}

// ── ACTION: CREATE ───────────────────────────────────────────────────────────

async function createProspect(address, userId, siteUrl, env) {
  address = cleanAddress(address);
  const store   = getMarketingStore(env);
  const addrKey = "addr_" + userId + "_" + addressHash(address);

  const projectId = generateProjectId(address);
  const slug       = slugifyProspectAddress(address);
  const prospect = {
    projectId,
    address,
    userId,
    slug,
    createdAt: new Date().toISOString(),
  };

  // FIX (Sep 16, 2026 — applied proactively, not after an incident):
  // project-manage.js's createProject() has a known, still-unpatched race
  // — a plain get-then-set with no concurrency guard, so two
  // near-simultaneous creates for the same brand-new address can both
  // read "doesn't exist yet" and both write, with the second silently
  // winning and orphaning the first. Rather than copy that gap into a
  // brand-new file, this uses Blobs' onlyIfNew: the write only succeeds
  // if nothing else has claimed this key first. If it loses that race,
  // it re-reads whatever the winner wrote and returns THAT as the
  // existing record — exactly like finding it via a normal lookup —
  // instead of ever producing two competing Blobs records or two
  // `prospects` rows for the same (userId, address) pair.
  const writeResult = await store.set(addrKey, JSON.stringify(prospect), { onlyIfNew: true });

  if (writeResult && writeResult.modified === false) {
    console.warn("createProspect: lost the create race for", addrKey, "— returning the winning record instead");
    const raw = await store.get(addrKey);
    const existing = JSON.parse(raw);
    let prospectRowId = null;
    let existingSlug = null;
    if (process.env.SUPABASE_URL) {
      try {
        const lookup = await supabase("GET", "prospects", null,
          `?project_id=eq.${existing.projectId}&select=id,slug&limit=1`
        );
        prospectRowId = lookup.data?.[0]?.id || null;
        existingSlug = lookup.data?.[0]?.slug || null;
      } catch (err) {
        console.error("createProspect: race-loser lookup error (non-fatal):", err.message);
      }
    }
    return { created: false, existing: true, projectId: existing.projectId, prospectId: prospectRowId, slug: existingSlug, isProspecting: true };
  }

  await store.set("pid_" + projectId, JSON.stringify(prospect));
  console.log("Prospect created:", projectId, "address:", address, "userId:", userId);

  let prospectRowId = null;
  if (process.env.SUPABASE_URL) {
    const result = await insertProspectWithRetry({
      address,
      project_id: projectId,
      slug,
      user_id:    userId,
    }, "createProspect (fresh insert)");
    prospectRowId = result.prospectId;
  }

  return { created: true, projectId, prospectId: prospectRowId, slug, isProspecting: true };
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
    const { address, userId } = body;

    if (!address) return { statusCode: 400, headers, body: JSON.stringify({ error: "Missing address" }) };
    // Hard requirement, not a defensive fallback — see file header's
    // identity note. Login is mandatory to reach this app at all, so a
    // request with no userId means the frontend's auth guard didn't do
    // its job, not that this is a normal anonymous-prospecting case.
    if (!userId) return { statusCode: 401, headers, body: JSON.stringify({ error: "Missing userId — a live login session is required to use Prospecting" }) };

    if (action === "lookup") {
      const result = await lookupProspect(address, userId, process.env);
      return { statusCode: 200, headers, body: JSON.stringify(result) };
    }

    if (action === "create") {
      const result = await createProspect(address, userId, body.siteUrl, process.env);
      return { statusCode: 200, headers, body: JSON.stringify(result) };
    }

    return { statusCode: 400, headers, body: JSON.stringify({ error: "Unknown action: " + action }) };

  } catch (err) {
    console.error("marketing-manage error:", err.message);
    return { statusCode: 500, headers, body: JSON.stringify({ error: err.message }) };
  }
};
