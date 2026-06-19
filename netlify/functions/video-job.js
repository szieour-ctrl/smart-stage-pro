// video-job.js — Netlify Function
// Smart Stage PRO Plus — video job creation, status polling, frame listing
//
// Routes via ?action= parameter, same pattern as project-manage.js
//
// action=frames    — returns staged images for a listing, for the agent's
//                     photo selection UI
// action=create    — creates video_jobs + video_job_frames rows, sends the
//                     job to the Railway render service. FREE — no credits
//                     touched here. Stores a quoted cost (credits_used) for
//                     the frontend's running "cart total," but does not debit.
// action=status     — polls Supabase for job status/progress. Deliberately
//                     does NOT return the finished output URLs — see
//                     action=download for why.
// action=download   — the ONLY action that touches credits. Charges once on
//                     first download (mirrors how image staging charges at
//                     "Generate Final," not at generation time), idempotent
//                     for repeat downloads of the same job, and is the only
//                     place the real output URLs are ever returned.
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

// ── CREDIT DEBIT (calls debit-credit.js — same path image staging uses) ──
//
// CHANGE: video-job.js used to write directly to credit_ledger via its own
// getCurrentCreditBalance()/debitVideoCredits() pair, duplicating logic that
// already existed in debit-credit.js — and missing debit-credit.js's
// active-subscription/trial check entirely (a user with a cancelled
// subscription but leftover credit balance could still generate videos,
// even though the same user staging a single image would be blocked).
//
// This now calls debit-credit.js directly over HTTP, so video jobs get the
// exact same balance check, subscription/trial check, and ledger write that
// image staging already uses — one implementation, not two diverging ones.

function callDebitCredit(userId, cost, reason) {
  return new Promise((resolve, reject) => {
    const url = new URL(`${process.env.SITE_URL}/.netlify/functions/debit-credit`);
    const bodyStr = JSON.stringify({ userId, cost, reason });

    const req = https.request({
      hostname: url.hostname,
      path:     url.pathname,
      method:   "POST",
      headers: {
        "Content-Type":   "application/json",
        "Content-Length": Buffer.byteLength(bodyStr),
      }
    }, res => {
      let data = "";
      res.on("data", c => data += c);
      res.on("end", () => {
        try { resolve({ status: res.statusCode, data: JSON.parse(data || "{}") }); }
        catch { resolve({ status: res.statusCode, data }); }
      });
    });
    req.on("error", reject);
    req.write(bodyStr);
    req.end();
  });
}

// Base cost per finished video (covers Cloudinary storage, Mubert music,
// FFmpeg assembly/compute). Flat regardless of room count AND regardless of
// how many output formats are delivered for Ken Burns-only jobs.
//
// CONFIRMED via assemble.js: concatenateClips() and mixAudio() run ONCE,
// then renderFormat() is called separately per format as a cheap crop/scale
// pass on the same already-assembled master (9:16 is just
// `crop=ih*9/16:ih,scale=...` on the 16:9 output) — never a second Kling
// generation. So bundling both formats for Ken Burns-only jobs is genuinely
// cheap, not a margin giveaway.
//
// AI motion jobs are still restricted to exactly one format regardless —
// see validateFormatChoiceForAiMotion below. Not a cost issue (confirmed
// above), a quality issue: that same center-crop is fine on Ken Burns
// geometry we control, but risky on Kling's AI-chosen composition, which
// could put the actual generated motion off-center and get cropped out.
const BASE_VIDEO_COST = 2;

// Max images/frames per video job. Bounded by render time (Railway processes
// frames sequentially, not in parallel — see renderPipeline.js's for loop)
// and by what a real listing needs (most top out around 10-15 distinct
// rooms/areas). Enforced server-side here, not just as a frontend UI limit,
// so a malformed or scripted request can't bypass it and overload Railway.
const MAX_FRAMES_PER_JOB = 15;

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
  // CHANGE: BASE_VIDEO_COST is now a flat number, not a per-format lookup —
  // same cost whether the job delivers one format or both.
  let cost = BASE_VIDEO_COST;

  for (const frame of frames) {
    cost += frame.useAiMotion ? PER_FRAME_COST.ai_motion : PER_FRAME_COST.ken_burns;
    if (frame.useAiMotion && frame.addContinuationMotion) {
      cost += PER_FRAME_COST.continuation_add;
    }
  }

  return cost;
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

// ── FORMAT RESTRICTION FOR AI MOTION ─────────────────────────────────────
// Ken Burns clips can safely bundle both 16:9 and 9:16 for one price — see
// BASE_VIDEO_COST comment, confirmed via assemble.js that the 9:16 version
// is just a cheap center crop of the same rendered frames. Kling-generated
// clips are real AI motion with composition Kling chose, not us — blindly
// center-cropping that to 9:16 risks cutting off whatever Kling actually
// rendered (a fireplace sitting off-center, a window view, etc.). So any
// job containing AI motion must commit to exactly one format up front,
// rather than risk an automatic crop that could look broken on the premium
// feature. Enforced server-side so a frontend bug that omits `formats`
// can't silently default to two formats for an AI motion job.

function validateFormatChoiceForAiMotion(frames, formats) {
  const hasAiMotion = frames.some(f => f.useAiMotion);
  if (hasAiMotion && formats.length !== 1) {
    throw new Error(
      "AI motion videos must be delivered in a single format — choose 16:9 or 9:16 before submitting. The AI-generated motion can't be safely auto-cropped to a second aspect ratio."
    );
  }
}

// ── ACTION: CREATE ───────────────────────────────────────────────────────

async function createVideoJob({ listingId, projectId, userId, frames, formats, musicStyle }) {
  if (!frames || frames.length === 0) throw new Error("No frames provided");

  // Reject oversized jobs before any AI motion validation or credit cost
  // calculation — cheapest possible rejection point, no Supabase/Railway
  // calls made yet.
  if (frames.length > MAX_FRAMES_PER_JOB) {
    throw new Error(
      `Too many frames: ${frames.length} requested, ${MAX_FRAMES_PER_JOB} max per video.`
    );
  }

  // Reject ineligible AI motion requests before any rows are touched —
  // see validateAiMotionEligibility for why this check exists independently
  // of the one inside klingMotion.js on the Railway side.
  validateAiMotionEligibility(frames);

  // AI motion jobs must commit to one format — see comment above
  // validateFormatChoiceForAiMotion for why (composition risk, not cost).
  validateFormatChoiceForAiMotion(frames, formats);

  // CHANGE: this is now a QUOTE, not a charge. Job creation and rendering
  // are free — credits are only actually debited at first MP4 download,
  // via downloadVideoJob() below. This mirrors how image staging already
  // works: generation is free, only "Generate Final" (the download moment)
  // charges. creditCost gets stored on the job row as credits_used so the
  // frontend can show a running "cart total" while building/rendering,
  // but no debit-credit.js call happens here anymore.
  const creditCost = calculateCreditCost(formats, frames);

  // No credits are at stake in this try block anymore, so failures here
  // are just "the job didn't start" — not a billing problem. Mark the row
  // failed if it exists; otherwise let the error bubble to the outer
  // handler for a clean 500.
  let job;
  try {
    // Create the job row
    const jobResult = await supabase("POST", "video_jobs", {
      listing_id:   listingId,
      user_id:      userId,
      project_id:   projectId,
      status:       "queued",
      formats,
      music_style:  musicStyle || null,
      credits_used: creditCost, // quoted cost — see credits_charged_at for actual charge
    });

    job = jobResult.data?.[0];
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

    // Dispatch to Railway.
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

    return { created: true, jobId: job.id, quotedCost: creditCost };

  } catch (err) {
    console.error("createVideoJob failed:", err.message, { jobId: job?.id });
    if (job?.id) {
      await supabase("PATCH", "video_jobs",
        { status: "failed", error_message: err.message },
        `?id=eq.${job.id}`
      );
      return { error: "dispatch_failed", jobId: job.id };
    }
    throw err; // no job row exists at all — outer handler returns a clean 500
  }
}

// ── ACTION: DOWNLOAD ─────────────────────────────────────────────────────
// The ONLY place credits actually get debited for video. Charges once, on
// first download, idempotent for any later re-download of the same job.
// This is also the only place the real output URLs get returned — see
// getJobStatus below, which deliberately does NOT include them, so polling
// status alone can never hand over the finished file before it's been paid for.

async function downloadVideoJob({ jobId, userId }) {
  if (!jobId || !userId) throw new Error("Missing jobId or userId");

  const jobRes = await supabase("GET", "video_jobs", null,
    `?id=eq.${jobId}&select=id,user_id,status,output_16x9_url,output_9x16_url,credits_used,credits_charged_at`
  );
  const job = jobRes.data?.[0];

  if (!job) return { error: "job_not_found" };
  if (job.user_id !== userId) return { error: "forbidden" };
  if (job.status !== "complete") return { error: "not_ready", status: job.status };

  // Already charged — idempotent, just hand back the URLs again, no debit.
  if (job.credits_charged_at) {
    return {
      downloadReady: true,
      output16x9Url: job.output_16x9_url,
      output9x16Url: job.output_9x16_url,
    };
  }

  // First download for this job — charge now via debit-credit.js, the
  // exact same balance + active-subscription/trial check image staging uses.
  const debitResult = await callDebitCredit(userId, job.credits_used, "video_render");

  if (debitResult.status === 402) {
    return {
      error:    debitResult.data?.code === "NO_SUB" ? "no_active_subscription" : "insufficient_credits",
      required: job.credits_used,
      balance:  debitResult.data?.balance,
    };
  }
  if (debitResult.status !== 200) {
    throw new Error(`Credit debit failed (status ${debitResult.status}): ${JSON.stringify(debitResult.data)}`);
  }

  await supabase("PATCH", "video_jobs",
    { credits_charged_at: new Date().toISOString() },
    `?id=eq.${jobId}`
  );

  return {
    downloadReady: true,
    output16x9Url: job.output_16x9_url,
    output9x16Url: job.output_9x16_url,
  };
}

// ── ACTION: STATUS ───────────────────────────────────────────────────────

async function getJobStatus(jobId) {
  // CHANGE: output_16x9_url/output_9x16_url removed from this select.
  // Those now only ever come back from downloadVideoJob() — the one place
  // that charges. If status polling could hand them over directly, a user
  // could grab the finished file the moment it's ready, before any charge
  // happens, making the whole download-time-charging model pointless.
  // thumbnail_url stays — that's the watermarked preview, fine to show
  // freely regardless of charge state, same pattern as image staging drafts.
  const r = await supabase("GET", "video_jobs", null,
    `?id=eq.${jobId}&select=id,status,thumbnail_url,credits_used,credits_charged_at,error_message,created_at,completed_at`
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
      // CHANGE: create no longer touches credits, so the only possible
      // error here is dispatch_failed — a server problem, not a payment
      // problem. Always 500 on error now, no PAYMENT_ERRORS map needed.
      return { statusCode: result.error ? 500 : 200, headers, body: JSON.stringify(result) };
    }

    if (action === "download") {
      const body = JSON.parse(event.body || "{}");
      const { jobId, userId } = body;
      if (!jobId || !userId) {
        return { statusCode: 400, headers, body: JSON.stringify({ error: "Missing jobId or userId" }) };
      }
      const result = await downloadVideoJob({ jobId, userId });
      const DOWNLOAD_STATUS_CODES = {
        job_not_found:         404,
        forbidden:              403,
        not_ready:              409, // job exists but isn't complete yet
        insufficient_credits:   402,
        no_active_subscription: 402,
      };
      const statusCode = result.error ? (DOWNLOAD_STATUS_CODES[result.error] || 500) : 200;
      return { statusCode, headers, body: JSON.stringify(result) };
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
