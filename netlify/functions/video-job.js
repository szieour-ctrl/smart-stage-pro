// video-job.js — Netlify Function
// Smart Stage PRO Plus — video job creation, status polling, frame listing
//
// Routes via ?action= parameter, same pattern as project-manage.js
//
// action=frames  — returns staged images for a listing, for the agent's
//                   photo selection UI
// action=create  — validates credits, creates video_jobs + video_job_frames
//                   rows, sends the job to the Railway render service
// action=status  — polls Supabase for job status, returns progress + URLs
//
// CRITICAL: This function reads from listings/staged_images (existing
// PRO tables) but only ever WRITES to video_jobs/video_job_frames (new
// tables). Credit debits reuse the exact same ledger pattern as
// debit-credit.js — do not invent new credit math here.

const https = require("https");

// ── SUPABASE HELPER (same pattern as project-manage.js) ──────────────────

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

// ── RAILWAY DISPATCH ──────────────────────────────────────────────────────

function dispatchToRailway(payload) {
  return new Promise((resolve, reject) => {
    const url = new URL(`${process.env.RAILWAY_RENDER_URL}/render`);
    const bodyStr = JSON.stringify(payload);

    const req = https.request({
      hostname: url.hostname,
      path:     url.pathname,
      method:   "POST",
      headers: {
        "Content-Type":     "application/json",
        "x-railway-secret": process.env.RAILWAY_SECRET,
        "Content-Length":   Buffer.byteLength(bodyStr),
      }
    }, res => {
      let data = "";
      res.on("data", c => data += c);
      res.on("end", () => resolve({ status: res.statusCode, data }));
    });
    req.on("error", reject);
    req.write(bodyStr);
    req.end();
  });
}

// ── CREDIT HELPERS (same pattern as project-manage.js / debit-credit.js) ──

async function getCurrentCreditBalance(userId) {
  if (!userId || !process.env.SUPABASE_URL) return 0;
  const r = await supabase("GET", "credit_ledger", null,
    `?user_id=eq.${userId}&select=balance_after&order=created_at.desc&limit=1`
  );
  return r.data?.[0]?.balance_after ?? 0;
}

// Base cost per finished video (covers Cloudinary storage, Mubert music,
// FFmpeg assembly/compute — flat regardless of room count).
const BASE_VIDEO_COST = {
  "16x9":      2,
  "9x16":      2,
  "16x9+9x16": 3,
};

// Per-frame cost — charged once per room/frame in the job, since more
// rooms means more compute time and more underlying API cost (Kling
// specifically bills per second of real generated video).
const PER_FRAME_COST = {
  ken_burns: 1,   // FFmpeg only — negligible real cost, mostly margin
  ai_motion: 4,   // Kling-backed — real backend cost is ~$0.42-0.50 per 5-6s
                  // clip at $0.084/sec; 4 credits at $0.10-0.15/credit value
                  // covers that with healthy margin. Revisit if Kling pricing
                  // or typical clip duration changes materially.
  continuation_add: 1, // small surcharge for the optional Ken Burns push-in/
                        // parallax appended after Kling's transformation —
                        // extra FFmpeg compute, no extra Kling API cost.
};

function calculateCreditCost(formats, frames) {
  let cost = formats.length === 2
    ? BASE_VIDEO_COST["16x9+9x16"]
    : (BASE_VIDEO_COST[formats[0]] || BASE_VIDEO_COST["16x9"]);

  for (const frame of frames) {
    cost += frame.useAiMotion ? PER_FRAME_COST.ai_motion : PER_FRAME_COST.ken_burns;
    if (frame.useAiMotion && frame.addContinuationMotion) {
      cost += PER_FRAME_COST.continuation_add;
    }
  }

  return cost;
}

async function debitVideoCredits(userId, jobId, amount, description) {
  const balance = await getCurrentCreditBalance(userId);
  const newBalance = Math.max(0, balance - amount);
  await supabase("POST", "credit_ledger", {
    user_id:       userId,
    type:          "usage",
    amount:        -amount,
    balance_after: newBalance,
    description,
  });
  return newBalance;
}

// ── ACTION: FRAMES ───────────────────────────────────────────────────────
// Returns ALL images available for a listing's video tour — both staged
// rooms (from Smart Stage PRO's staging engine) and externally-referenced
// professional photography (MLS/Drive/agent's own site). Populates the
// agent's photo selection UI with everything in one place, matching the
// "find everything in one dashboard" platform goal.
//
// COMPLIANCE NOTE: the two sources are tagged with `source` so downstream
// code (and the frontend) can always tell them apart. staged_images carry
// AB 723 disclosure obligations; external_photos never do, since nothing
// was virtually altered. Never merge these into a single undifferentiated
// list without preserving that distinction — see external_photos table
// comment in the schema for the full reasoning.

async function getFramesForListing(listingId) {
  const [stagedResult, externalResult] = await Promise.all([
    supabase("GET", "staged_images", null,
      `?listing_id=eq.${listingId}&select=id,mode,cloudinary_original_url,cloudinary_staged_url,created_at&order=created_at.asc`
    ),
    supabase("GET", "external_photos", null,
      `?listing_id=eq.${listingId}&select=id,image_url,room_type,source_label,created_at&order=created_at.asc`
    ),
  ]);

  const stagedFrames = (stagedResult.data || []).map(row => ({
    id:            row.id,
    source:        "staged",
    mode:           row.mode,
    originalUrl:    row.cloudinary_original_url,
    stagedUrl:      row.cloudinary_staged_url,
    sourceLabel:    "Virtually Staged",
    createdAt:      row.created_at,
  }));

  const externalFrames = (externalResult.data || []).map(row => ({
    id:            row.id,
    source:        "external",
    imageUrl:       row.image_url,
    roomType:       row.room_type,
    sourceLabel:    row.source_label || "Professional Photography",
    createdAt:      row.created_at,
  }));

  return { stagedFrames, externalFrames };
}

// ── ACTION: ADD EXTERNAL PHOTO ───────────────────────────────────────────
// Lets an agent attach a photo they already have hosted elsewhere (MLS,
// Google Drive, their own site) to a listing, purely as a video-assembly
// input. Smart Stage PRO does not store or manage the file itself — only
// the URL reference. No AB 723 implications, since nothing is altered.

async function addExternalPhoto({ listingId, userId, imageUrl, roomType, sourceLabel }) {
  if (!imageUrl) throw new Error("Missing imageUrl");

  const result = await supabase("POST", "external_photos", {
    listing_id:       listingId,
    added_by_user_id: userId,
    image_url:        imageUrl,
    room_type:        roomType || null,
    source_label:     sourceLabel || null,
  });

  const row = result.data?.[0];
  if (!row) throw new Error("Failed to add external photo");

  return { added: true, id: row.id };
}

// ── AI MOTION ELIGIBILITY (mirrors klingMotion.js enforceScopeRules) ─────
// This is intentionally duplicated, not shared code — video-job.js (Netlify)
// and klingMotion.js (Railway) are separate deploys with separate trust
// boundaries. The Netlify check exists so a frame can never be BILLED for
// AI motion it isn't actually eligible for; the Railway check exists as a
// final, independent guard regardless of what Netlify validated. Both must
// stay in sync if this rule ever changes — see the reasoning in
// klingMotion.js's enforceScopeRules comment for the full explanation of
// why "known pair vs. single image" is the real safety boundary, not
// "interior vs. exterior."

function validateAiMotionEligibility(frames) {
  for (const frame of frames) {
    if (!frame.useAiMotion) continue;

    const hasKnownPair = !!(frame.isBeforeAfter && frame.beforeUrl);
    const isExterior = frame.roomType === "exterior";

    if (!hasKnownPair && !isExterior) {
      throw new Error(
        `AI motion requested for a frame with no paired image (room type "${frame.roomType}"). AI motion requires a real vacant+staged pair for interior rooms — single professional photos can only use standard motion.`
      );
    }
  }
}

// ── ACTION: CREATE ───────────────────────────────────────────────────────

async function createVideoJob({ listingId, projectId, userId, frames, formats, musicStyle }) {
  if (!frames || frames.length === 0) throw new Error("No frames provided");

  // Reject ineligible AI motion requests before any credits are touched —
  // see validateAiMotionEligibility for why this check exists independently
  // of the one inside klingMotion.js on the Railway side.
  validateAiMotionEligibility(frames);

  // Cost now scales with frame count and AI motion usage, not just a flat
  // before/after add-on — see calculateCreditCost for the per-frame logic.
  const creditCost = calculateCreditCost(formats, frames);

  const balance = await getCurrentCreditBalance(userId);
  if (balance < creditCost) {
    return { error: "insufficient_credits", required: creditCost, balance };
  }

  // Create the job row
  const jobResult = await supabase("POST", "video_jobs", {
    listing_id:   listingId,
    user_id:      userId,
    project_id:   projectId,
    status:       "queued",
    formats,
    music_style:  musicStyle || null,
    credits_used: creditCost,
  });

  const job = jobResult.data?.[0];
  if (!job) throw new Error("Failed to create video_jobs row");

  // Create frame rows, preserving sequence order
  const frameRows = frames.map((f, i) => ({
    job_id:           job.id,
    staged_image_id:  f.stagedImageId || null,
    image_url:        f.imageUrl,
    before_url:       f.beforeUrl || null,
    is_before_after:  !!f.isBeforeAfter,
    room_type:        f.roomType || "default",
    motion_preset:    f.motionPreset || "auto",
    duration_seconds: f.durationSeconds || 4.5,
    sequence_order:   i,
  }));

  await supabase("POST", "video_job_frames", frameRows);

  // Debit credits now — job is committed
  await debitVideoCredits(userId, job.id, creditCost, `Video tour — ${projectId}`);

  // Dispatch to Railway. If this fails, mark job failed but credits stay
  // debited — agent should contact support rather than silently retry,
  // since partial Railway failures need investigation.
  try {
    await dispatchToRailway({
      jobId:      job.id,
      projectId,
      formats,
      musicStyle: musicStyle || "default",
      frames: frameRows.map(f => ({
        imageUrl:        f.image_url,
        beforeUrl:       f.before_url,
        isBeforeAfter:   f.is_before_after,
        roomType:        f.room_type,
        motionPreset:    f.motion_preset,
        durationSeconds: f.duration_seconds,
        sequenceOrder:   f.sequence_order,
      })),
    });
  } catch (err) {
    console.error("Railway dispatch failed:", err.message);
    await supabase("PATCH", "video_jobs", { status: "failed", error_message: "Failed to reach render service" }, `?id=eq.${job.id}`);
    return { error: "dispatch_failed", jobId: job.id };
  }

  return { created: true, jobId: job.id, creditsUsed: creditCost };
}

// ── ACTION: STATUS ───────────────────────────────────────────────────────

async function getJobStatus(jobId) {
  const r = await supabase("GET", "video_jobs", null,
    `?id=eq.${jobId}&select=id,status,output_16x9_url,output_9x16_url,thumbnail_url,error_message,created_at,completed_at`
  );
  return r.data?.[0] || null;
}

// ── HANDLER ──────────────────────────────────────────────────────────────

exports.handler = async (event) => {
  const headers = {
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Headers": "Content-Type",
    "Content-Type": "application/json",
  };

  if (event.httpMethod === "OPTIONS") return { statusCode: 200, headers, body: "" };

  const action = event.queryStringParameters?.action;

  try {
    if (action === "frames") {
      const listingId = event.queryStringParameters?.listingId;
      if (!listingId) return { statusCode: 400, headers, body: JSON.stringify({ error: "Missing listingId" }) };
      const { stagedFrames, externalFrames } = await getFramesForListing(listingId);
      return { statusCode: 200, headers, body: JSON.stringify({ stagedFrames, externalFrames }) };
    }

    if (action === "add-external-photo") {
      const body = JSON.parse(event.body || "{}");
      const { listingId, userId, imageUrl, roomType, sourceLabel } = body;
      if (!listingId || !imageUrl) {
        return { statusCode: 400, headers, body: JSON.stringify({ error: "Missing listingId or imageUrl" }) };
      }
      const result = await addExternalPhoto({ listingId, userId, imageUrl, roomType, sourceLabel });
      return { statusCode: 200, headers, body: JSON.stringify(result) };
    }

    if (action === "create") {
      const body = JSON.parse(event.body || "{}");
      const { listingId, projectId, userId, frames, formats, musicStyle } = body;
      if (!listingId || !userId || !frames) {
        return { statusCode: 400, headers, body: JSON.stringify({ error: "Missing required fields" }) };
      }
      const result = await createVideoJob({
        listingId, projectId, userId, frames,
        formats: formats || ["16x9", "9x16"],
        musicStyle,
      });
      return { statusCode: result.error ? 402 : 200, headers, body: JSON.stringify(result) };
    }

    if (action === "status") {
      const jobId = event.queryStringParameters?.jobId;
      if (!jobId) return { statusCode: 400, headers, body: JSON.stringify({ error: "Missing jobId" }) };
      const job = await getJobStatus(jobId);
      if (!job) return { statusCode: 404, headers, body: JSON.stringify({ error: "Job not found" }) };
      return { statusCode: 200, headers, body: JSON.stringify(job) };
    }

    return { statusCode: 400, headers, body: JSON.stringify({ error: "Unknown action: " + action }) };

  } catch (err) {
    console.error("video-job error:", err.message);
    return { statusCode: 500, headers, body: JSON.stringify({ error: err.message }) };
  }
};
