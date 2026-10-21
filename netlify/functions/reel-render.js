// reel-render.js — Netlify Function. Reels v1 render dispatch + status. Reels are charged at download
// (reel-download.js); this file registers each render in reel_jobs and counts it when it completes.
//   POST { listingId, projectId, userId, event, lengthSec, intake, plan:{slots[],highlights[],supporting[]}, musicStyle }
//        → { jobId, brandedAvailable }
//   GET  ?jobId=...  → { status: "running", step } | { status: "done", branded, unbranded, durationSec, warnings }
//                      | { status: "error", error }
// Resolves the picked photos server-side (ids → URLs, clean unbadged copies + badge types), builds the brand
// block from the Marketing Profile (Branded only when licensed name + DRE + brokerage are all present), and
// hands everything to Railway POST /render-reel. Finished mp4s sit in the private smart-stage-reel-drafts/
// prefix; this function presigns them for 1 hour.
const https = require("https");
const { S3Client, GetObjectCommand } = require("@aws-sdk/client-s3");
const { getSignedUrl } = require("@aws-sdk/s3-request-presigner");
const { supabase, brandingForUser } = require("./lib/marketing-profile-lib");
const { SLOTS } = require("./lib/reel-plan-lib");
const quota = require("./lib/reel-quota-lib");
const { requireUser, canAccessListing } = require("./lib/reel-auth-lib");

const headers = { "Access-Control-Allow-Origin": "*", "Content-Type": "application/json", "Cache-Control": "no-store" };
const reply = (statusCode, obj) => ({ statusCode, headers, body: JSON.stringify(obj) });
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const DRAFT_PREFIX = "smart-stage-reel-drafts/";

const s3 = new S3Client({ region: process.env.S3_REGION, credentials: { accessKeyId: process.env.S3_ACCESS_KEY_ID, secretAccessKey: process.env.S3_SECRET_ACCESS_KEY } });
async function presign(key, secs) {
  if (!key || !String(key).startsWith(DRAFT_PREFIX)) return null;
  try { return await getSignedUrl(s3, new GetObjectCommand({ Bucket: process.env.S3_BUCKET_NAME, Key: key }), { expiresIn: secs }); }
  catch (e) { console.error("reel-render presign failed:", e.message); return null; }
}
// Clean (unbadged) staged copies live in a private prefix; give Railway a 12h link, same as the video flow.
async function presignAny(key, secs) {
  try { return await getSignedUrl(s3, new GetObjectCommand({ Bucket: process.env.S3_BUCKET_NAME, Key: key }), { expiresIn: secs }); }
  catch (e) { console.error("reel-render clean-copy presign failed:", e.message); return null; }
}

function railway(method, pathname, payload) {
  return new Promise((resolve, reject) => {
    const url = new URL(`${process.env.RAILWAY_RENDER_URL}${pathname}`);
    const bodyStr = payload ? JSON.stringify(payload) : null;
    const req = https.request({
      hostname: url.hostname, path: url.pathname, method,
      headers: { "x-railway-secret": process.env.RAILWAY_SECRET, ...(bodyStr ? { "Content-Type": "application/json", "Content-Length": Buffer.byteLength(bodyStr) } : {}) },
    }, (res) => { let d = ""; res.on("data", (c) => (d += c)); res.on("end", () => { let j = null; try { j = JSON.parse(d); } catch { /* non-JSON */ } resolve({ status: res.statusCode, json: j, raw: d }); }); });
    req.setTimeout(20000, () => req.destroy(new Error("Railway request timed out")));
    req.on("error", reject);
    if (bodyStr) req.write(bodyStr);
    req.end();
  });
}

const { allocateDurations, REVEAL_MIN, PRESETS } = require("./lib/reel-reveal");
const inList = (ids) => `in.(${ids.join(",")})`;

// Room Reveal (Original -> Staged) only when the photo has a real Original (not a hero shot).
function revealFor(r, preset, warnings) {
  if (!preset) return {};
  if (r.is_hero_shot || !/^https?:\/\//.test(r.cloudinary_original_url || "")) {
    warnings.push("A photo has no Original to reveal; it was shown as Standard Motion.");
    return {};
  }
  return { reveal: { beforeUrl: r.cloudinary_original_url, preset } };
}

async function resolveScenes(listingId, slots) {
  const ids = [...new Set(slots.map((s) => s.photoId))];
  const [st, ex] = await Promise.all([
    supabase("GET", "staged_images", null, `?id=${inList(ids)}&listing_id=eq.${listingId}&select=id,cloudinary_staged_url,cloudinary_original_url,is_hero_shot,clean_s3_key,badge_type,room_type`),
    supabase("GET", "external_photos", null, `?id=${inList(ids)}&listing_id=eq.${listingId}&select=id,image_url,room_type`),
  ]);
  const byId = new Map();
  (Array.isArray(st.data) ? st.data : []).forEach((r) => byId.set(r.id, { kind: "staged", r }));
  (Array.isArray(ex.data) ? ex.data : []).forEach((r) => byId.set(r.id, { kind: "external", r }));
  const warnings = [];
  const scenes = [];
  for (const s of slots) {
    const wantReveal = PRESETS.includes(s.reveal) ? s.reveal : null;
    const hit = byId.get(s.photoId);
    if (!hit) throw new Error("One of the selected photos is no longer available for this listing");
    const label = (hit.r.room_type || "").replace(/_/g, " ");
    if (hit.kind === "external") {
      scenes.push({ imageUrl: hit.r.image_url, motion: s.motion || "auto", badgeType: "none", roomLabel: label });
    } else if (hit.r.clean_s3_key && hit.r.badge_type) {
      const url = await presignAny(hit.r.clean_s3_key, 12 * 3600);
      if (!url) throw new Error("Could not prepare a staged photo for rendering");
      scenes.push({ imageUrl: url, motion: s.motion || "auto", badgeType: hit.r.badge_type, roomLabel: label, ...revealFor(hit.r, wantReveal, warnings) });
    } else {
      // Older Final without a clean copy: the AB 723 badge is already baked into this image, so no overlay badge.
      warnings.push("A staged photo has no clean copy; its built-in badge is used and may be cropped in 9:16. Re-run Generate Final to fix.");
      scenes.push({ imageUrl: hit.r.cloudinary_staged_url, motion: s.motion || "auto", badgeType: "none", roomLabel: label, ...revealFor(hit.r, wantReveal, warnings) });
    }
  }
  return { scenes, warnings };
}

exports.handler = async (event) => {
  if (event.httpMethod === "OPTIONS") return { statusCode: 204, headers: { ...headers, "Access-Control-Allow-Headers": "Content-Type, Authorization", "Access-Control-Allow-Methods": "GET, POST, OPTIONS" }, body: "" };
  if (!process.env.RAILWAY_RENDER_URL || !process.env.RAILWAY_SECRET) return reply(500, { error: "Reel rendering is not configured" });

  const auth = await requireUser(event);
  if (auth.error) return reply(auth.error.status, auth.error.body);
  const userId = auth.user.id;

  if (event.httpMethod === "GET") {
    const jobId = event.queryStringParameters && event.queryStringParameters.jobId;
    if (!jobId || !/^[\w-]{6,80}$/.test(jobId)) return reply(400, { error: "Missing or invalid jobId" });
    try {
      const own = await supabase("GET", "reel_jobs", null, `?id=eq.${encodeURIComponent(jobId)}&select=user_id&limit=1`);
      const ownerRow = Array.isArray(own.data) ? own.data[0] : null;
      if (!ownerRow) return reply(404, { error: "Render not found" });
      if (ownerRow.user_id !== userId) return reply(403, { error: "This render belongs to another account" });
      const r = await railway("GET", `/reel-status/${encodeURIComponent(jobId)}`);
      if (r.status === 404) return reply(200, { status: "error", error: "This render was interrupted. Please try again." });
      if (r.status !== 200 || !r.json) return reply(200, { status: "running", step: "Rendering" }); // transient; client keeps polling
      const j = r.json;
      if (j.status === "error") { quota.rpc("reel_mark_failed", { p_job_id: jobId }).catch(() => {}); return reply(200, { status: "error", error: j.error || "Render failed" }); }
      if (j.status !== "done") return reply(200, { status: "running", step: j.step || "Rendering" });
      const keys = (j.result && j.result.keys) || {};
      // Count this render toward the not-downloaded tally (idempotent; the Railway webhook may have done it already).
      let counter = null;
      try {
        const cnt = await quota.countCompletion(jobId, keys);
        if (cnt && cnt.user_id) {
          const c = await quota.getCounter(cnt.user_id);
          counter = { undownloaded: c.undownloaded, threshold: quota.WASTE_RENDER_THRESHOLD, wasteCharged: !!cnt.wasteCharged, wasteOwed: !!cnt.wasteOwed };
        }
      } catch (e) { console.error("reel-render count error:", e.message); }
      return reply(200, {
        status: "done", durationSec: j.result.durationSec, warnings: j.result.warnings || [],
        branded: await presign(keys.branded, 3600), unbranded: await presign(keys.unbranded, 3600),
        keys: { branded: keys.branded || null, unbranded: keys.unbranded || null },
        counter,
      });
    } catch (e) {
      console.error("reel-render status error:", e.message);
      return reply(200, { status: "running", step: "Rendering" });
    }
  }

  if (event.httpMethod !== "POST") return reply(405, { error: "Method not allowed" });
  let b;
  try { b = JSON.parse(event.body || "{}"); } catch { return reply(400, { error: "Invalid JSON" }); }
  const { listingId, projectId, event: evKey, lengthSec } = b; // userId comes from the login token, never the body
  const plan = b.plan || {};
  const slots = Array.isArray(plan.slots) ? plan.slots : [];
  if (!UUID_RE.test(String(listingId || ""))) return reply(400, { error: "Missing listingId" });
  // The user is the advertiser; SSP is the tool. Every render needs their confirmation.
  if (b.advertisingConfirmed !== true) return reply(400, { error: "Please confirm that the property details, amenities and marketing claims in this Reel are accurate and comply with applicable advertising requirements." });
  if (!SLOTS.events[evKey]) return reply(400, { error: `Unknown Reel event "${evKey}"` });
  const range = SLOTS.ranges[String(lengthSec)];
  if (!range) return reply(400, { error: "Unsupported Reel length" });
  if (slots.length < range[0] || slots.length > range[1]) return reply(400, { error: `A ${lengthSec}s Reel uses ${range[0] === range[1] ? range[0] : `${range[0]}-${range[1]}`} photos` });
  if (slots.some((s) => !UUID_RE.test(String(s.photoId || "")))) return reply(400, { error: "Invalid photo selection" });
  if (new Set(slots.map((s) => s.photoId)).size !== slots.length) return reply(400, { error: "Duplicate photo in selection" });

  try {
    const lst = await supabase("GET", "listings", null, `?id=eq.${listingId}&select=id,user_id,team_id,brokerage_id&limit=1`);
    if (!Array.isArray(lst.data) || !lst.data[0]) return reply(404, { error: "Listing not found" });
    if (!(await canAccessListing(userId, lst.data[0]))) return reply(403, { error: "You do not have access to this listing" });

    // Collect any waste fee (5 renders not downloaded = 1 Image) that could not be charged earlier.
    const owed = await quota.settleOwed(userId);
    if (owed) return reply(owed.status, { error: owed.message, code: owed.error });

    const { scenes, warnings } = await resolveScenes(listingId, slots);
    const revealFlags = scenes.map((sc) => !!sc.reveal);
    if (!allocateDurations(Number(lengthSec), revealFlags)) {
      const n = revealFlags.filter(Boolean).length;
      return reply(400, { error: `${n} Room Reveal photos need more time than a ${lengthSec}s Reel allows (each needs at least ${REVEAL_MIN}s). Switch some photos to Standard Motion or choose a longer Reel.` });
    }

    const br = await brandingForUser(userId);
    const complete = !!(br.hasProfile && br.licensedName && br.dreNumber && br.brokerageName);
    const brand = complete ? { licensedName: br.licensedName, dre: br.dreNumber, brokerage: br.brokerageName, primary: br.brandPrimary, secondary: br.brandSecondary, border: br.brandBorder, logoUrl: br.logoUrl || "", headshotUrl: br.headshotUrl || "" } : null;

    const intake = b.intake && typeof b.intake === "object" ? b.intake : {};
    const data = { ...intake, highlights: plan.highlights || [], supporting: plan.supporting || [], positional: true };
    delete data.event; delete data.lengthSec;
    const base = (process.env.SITE_URL || "https://smartstagepro.com").replace(/\/+$/, "");
    const music = /^[a-z0-9_]{1,40}$/.test(String(b.musicStyle || "")) ? b.musicStyle : "default";

    const jobId = `reel-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    // Register the render BEFORE dispatch so a user who leaves the page is still counted when Railway reports back.
    const jobRow = { id: jobId, user_id: userId, listing_id: listingId, event: evKey, length_sec: Number(lengthSec) };
    let ins = await supabase("POST", "reel_jobs", { ...jobRow, advertising_confirmed_at: new Date().toISOString() });
    if (ins.status >= 300 && /advertising_confirmed_at/.test(JSON.stringify(ins.data || ""))) {
      // Column not added yet: do not block the render; the confirmation is still enforced above.
      console.error("reel_jobs.advertising_confirmed_at is missing; run the migration. Rendering without recording it.");
      ins = await supabase("POST", "reel_jobs", jobRow);
    }
    if (ins.status >= 300) { console.error("reel_jobs insert failed:", ins.status, JSON.stringify(ins.data).slice(0, 200)); return reply(500, { error: "Could not start the render" }); }
    const r = await railway("POST", "/render-reel", { jobId, event: evKey, lengthSec, data, scenes, brand, qrUrl: projectId ? `${base}/compliance/${projectId}` : base, musicStyle: music });
    if (r.status !== 202) quota.rpc("reel_mark_failed", { p_job_id: jobId }).catch(() => {});
    if (r.status === 429) {
      const ahead = r.json && Number.isFinite(r.json.running) ? (r.json.running + (r.json.waiting || 0)) : null;
      const eta = ahead ? ` (roughly ${ahead * 3}\u2013${ahead * 5} minutes)` : "";
      return reply(429, { error: ahead
        ? `The Reel renderer is busy: ${ahead} render${ahead === 1 ? " is" : "s are"} ahead of you${eta}. Please try again in a few minutes.`
        : "The Reel renderer is busy. Please try again in a few minutes." });
    }
    if (r.status !== 202) { console.error("reel-render dispatch failed:", r.status, r.raw && r.raw.slice(0, 200)); return reply(502, { error: "Could not start the render" }); }
    return reply(200, { jobId, brandedAvailable: !!brand, warnings });
  } catch (e) {
    console.error("reel-render dispatch error:", e.message);
    return reply(500, { error: e.message });
  }
};
