// video-job.js — Netlify Function
// Smart Stage PRO Plus — video job creation, status polling, frame listing
//
// Routes via ?action= parameter, same pattern as project-manage.js
//
// ── IMAGE ECONOMY v2 (June 20, 2026) — REPLACES the old "everything free
// until download" model. Kling AI Motion now charges Images IMMEDIATELY at
// generation time, not at download — see SmartStagePRO_Plus_Image_Economy_v2.md
// for the full spec and worked examples. The short version:
//
//   - Ken Burns frames: still free at generation, still only cost a flat
//     1 Image at download (see BASE_VIDEO_COST). Unchanged from before.
//   - Kling Motion frames: charged the MOMENT "Generate Video" is clicked,
//     synchronously, BEFORE the job is dispatched to Railway. Never
//     refundable, even if the user never downloads.
//     - First generation of a video (action=create): first 3 Kling frames
//       are free (counts toward the plan's monthly VIDEO quota instead,
//       at download — see downloadVideoJob). Every Kling frame beyond 3
//       costs 5 Images each, charged at action=create.
//     - Any later regeneration (action=regenerate): the 3-included
//       allowance is GONE. Every Kling frame in that run costs 5 Images,
//       including frames that were free the first time.
//   - generation_count on video_jobs tracks which of the above applies —
//     1 means this is the still-eligible-for-3-free-frames first
//     generation; 2+ means every regenerate from here on is full price.
//
// action=frames      — returns staged images for a listing, for the agent's
//                       photo selection UI
// action=create      — FIRST generation only (generation_count is set to 1
//                       here). Charges Images for Kling frames beyond the
//                       3 included — see calculateKlingChargeForGeneration.
//                       Ken Burns and the flat assembly fee are NOT charged
//                       here; those wait for action=download. If the Image
//                       debit fails (insufficient balance), the job is never
//                       created and Railway is never called.
// action=regenerate  — any generation after the first. Increments
//                       generation_count. Charges Images for EVERY Kling
//                       frame in this run, no included allowance. Same
//                       debit-before-dispatch pattern as action=create.
// action=status      — polls Supabase for job status/progress. Deliberately
//                       does NOT return the finished output URLs — see
//                       action=download for why.
// action=download    — charges the flat assembly fee + any Ken Burns frame
//                       cost (Kling was already charged at generation, see
//                       above). Charges once on first download, idempotent
//                       for repeat downloads, and is the only place the
//                       real output URLs are ever returned. ALSO consumes
//                       one slot from the plan's monthly video quota
//                       (5 Solo / 12 Team / 40 Brokerage) — see
//                       consumeVideoQuotaSlot. Video quota and Image
//                       balance are independent; running out of one does
//                       not block the other.
//
// CRITICAL: This function reads from listings/staged_images (existing
// PRO tables) but only ever WRITES to video_jobs/video_job_frames (new
// tables). Credit debits reuse the exact same ledger pattern as
// debit-credit.js — do not invent new credit math here.
//
// SCHEMA CHANGE NEEDED before this deploys — see migration note near
// MAX_FRAMES_PER_JOB below: video_jobs needs a new generation_count column
// (integer, default 0) and a video_quota_charged_at column (timestamp,
// nullable) alongside the existing credits_used/credits_charged_at.

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

// CHANGE (Image Economy v2): added isRefund parameter, passed straight
// through to debit-credit.js's new isRefund handling. Used ONLY by the
// narrow platform-failure refund paths in createVideoJob/regenerateVideoJob
// — see those functions' catch blocks. cost is always passed as a positive
// magnitude here regardless of direction; isRefund is what tells
// debit-credit.js to credit instead of debit.

function callDebitCredit(userId, cost, reason, isRefund = false) {
  return new Promise((resolve, reject) => {
    const url = new URL(`${process.env.SITE_URL}/.netlify/functions/debit-credit`);
    const bodyStr = JSON.stringify({ userId, cost, reason, isRefund });

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
// CHANGE (Image Economy v2): was 2, now 1 — matches the spec's "flat 1
// Image at download" rule exactly, separate from any Kling charges (which
// no longer touch this constant at all — see calculateKlingChargeForGeneration).
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
const BASE_VIDEO_COST = 1;

// Max images/frames per video job. Bounded by render time (Railway processes
// frames sequentially, not in parallel — see renderPipeline.js's for loop)
// and by what a real listing needs.
//
// CHANGE (Image Economy v2): raised from 15 to 20 — ~20 frames produces an
// approximately 75-second video, per the locked spec. Enforced server-side
// here, not just as a frontend UI limit, so a malformed or scripted request
// can't bypass it and overload Railway.
const MAX_FRAMES_PER_JOB = 20;

// ── IMAGE ECONOMY v2 — KLING CHARGE MODEL ────────────────────────────────
//
// Kling frames are no longer priced as a flat per-frame add-on inside
// calculateCreditCost(). They're now charged SEPARATELY and IMMEDIATELY at
// generation time (action=create or action=regenerate), never at download.
// See calculateKlingChargeForGeneration below for the actual formula.
//
// Ken Burns frames are unaffected by any of this — they stay folded into
// the flat BASE_VIDEO_COST charged at download (see calculateDownloadCost).

const KLING_INCLUDED_FRAMES_FIRST_GEN = 3; // free, but ONLY on generation_count === 1
const KLING_IMAGE_COST_PER_FRAME = 5;      // every billable Kling frame, no exceptions

// Per-frame cost for the DOWNLOAD-TIME charge only. Kling frames are
// deliberately absent from this map now — they're charged at generation,
// never again at download. Including them here would double-charge.
const PER_FRAME_COST = {
  ken_burns: 0, // CHANGE: Ken Burns is now bundled into the flat
                // BASE_VIDEO_COST at download, not charged per-frame —
                // "Ken Burns video = 1 Image" means the whole video, not
                // 1 Image per frame. Kept as an explicit 0 (rather than
                // removing the key) so calculateDownloadCost's loop logic
                // doesn't need a special case — multiplying by 0 is the
                // cleanest way to express "no per-frame charge."
};

// CHANGE (Image Economy v2): calculateCreditCost() is now split into two
// separate functions that fire at two separate times — see
// calculateKlingChargeForGeneration (action=create/regenerate) and
// calculateDownloadCost (action=download) below. There is no longer a
// single function that computes "the cost of a video," because a video no
// longer has one cost — it has a generation-time Kling cost (which can
// accumulate across multiple regenerations) and a separate, one-time
// download-time flat fee.

// Charged at action=create (generationCount will be 1) or action=regenerate
// (generationCount will be 2+). This is THE function that protects against
// runaway Kling spend — see the header comment and
// SmartStagePRO_Plus_Image_Economy_v2.md §3 for the full worked examples.
function calculateKlingChargeForGeneration(frames, generationCount) {
  const klingFrameCount = frames.filter(f => f.useAiMotion).length;

  if (generationCount === 1) {
    // First generation ever for this video — first 3 Kling frames are
    // free (they count against the monthly VIDEO quota at download
    // instead — see consumeVideoQuotaSlot). Only frames beyond 3 cost
    // Images here.
    const billableFrames = Math.max(0, klingFrameCount - KLING_INCLUDED_FRAMES_FIRST_GEN);
    return billableFrames * KLING_IMAGE_COST_PER_FRAME;
  }

  // Any regeneration: the included allowance is gone entirely. EVERY
  // Kling frame in this run is billed, including ones that were free on
  // generation #1. This is intentional and is the single most
  // counterintuitive part of the model — the frontend confirmation screen
  // (Image Economy v2 §6) must make this explicit before the user clicks,
  // since it's exactly the kind of "surprise charge on a minor fix"
  // VideoTour.ai users complained about.
  return klingFrameCount * KLING_IMAGE_COST_PER_FRAME;
}

// Charged once, at action=download, regardless of how many times the video
// was generated/regenerated before this point (Kling was already paid for
// at each of those generation events — this only covers Ken Burns + the
// flat assembly fee). Ken Burns frames currently cost 0 each per
// PER_FRAME_COST — the entire Ken Burns contribution to this video is the
// flat BASE_VIDEO_COST, per the locked "Ken Burns video = 1 Image" rule.
function calculateDownloadCost(frames) {
  let cost = BASE_VIDEO_COST;
  for (const frame of frames) {
    if (!frame.useAiMotion) cost += PER_FRAME_COST.ken_burns;
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

// SINGLE_IMAGE_INTERIOR_ALLOWED_PRESETS must mirror klingMotion.js's
// allowlist of the same name exactly — see that file's header comment for
// the full compliance reasoning (resolved: same disclosed-alteration
// category as a virtual pool or a wall removal, not a different risk).
// Applies regardless of whether the source frame is a staged image or an
// agent's external/professional photo — disclosure attaches to what Kling
// generates, not to whether the underlying photo was ever staged.
const SINGLE_IMAGE_INTERIOR_ALLOWED_PRESETS = new Set([
  "orbit_arc",
  "rack_focus",
  "fireplace_flicker",
]);

function validateAiMotionEligibility(frames) {
  for (const frame of frames) {
    if (!frame.useAiMotion) continue;

    const hasKnownPair = !!(frame.isBeforeAfter && frame.beforeUrl);
    const isExterior = frame.roomType === "exterior";
    const isAllowedSingleImageInteriorPreset =
      !!frame.motionPreset && SINGLE_IMAGE_INTERIOR_ALLOWED_PRESETS.has(frame.motionPreset);

    if (!hasKnownPair && !isExterior && !isAllowedSingleImageInteriorPreset) {
      throw new Error(
        `AI motion requested for a frame with no paired image and no allowed single-image preset (room type "${frame.roomType}", preset "${frame.motionPreset || "(none)"}"). AI motion requires a real vacant+staged pair for interior rooms, an exterior frame, or one of the allowed single-image presets (orbit_arc, rack_focus, fireplace_flicker) — otherwise only standard motion is available.`
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

// ── ACTION: CREATE (generation #1 ONLY) ──────────────────────────────────
//
// CHANGE (Image Economy v2): this used to be entirely free — credits were
// only ever a stored quote here, charged later at download. That's gone.
// Kling frames now charge Images RIGHT HERE, synchronously, BEFORE any
// video_jobs/video_job_frames rows are created and before Railway is ever
// called. This is the actual fix for the original risk this redesign
// exists to solve: a user must not be able to trigger real, billed Kling
// generations without first having the Images to pay for them.
//
// Order of operations matters a lot in this function — see inline comments.

async function createVideoJob({ listingId, projectId, userId, frames, formats, musicStyle }) {
  if (!frames || frames.length === 0) throw new Error("No frames provided");

  // Reject oversized jobs before anything else touches Supabase, Railway,
  // or the Image balance — cheapest possible rejection point.
  if (frames.length > MAX_FRAMES_PER_JOB) {
    throw new Error(
      `Too many frames: ${frames.length} requested, ${MAX_FRAMES_PER_JOB} max per video.`
    );
  }

  // Reject ineligible AI motion requests before any rows are touched or any
  // Images are charged — see validateAiMotionEligibility for why this check
  // exists independently of the one inside klingMotion.js on the Railway side.
  validateAiMotionEligibility(frames);

  // AI motion jobs must commit to one format — see comment above
  // validateFormatChoiceForAiMotion for why (composition risk, not cost).
  validateFormatChoiceForAiMotion(frames, formats);

  // generation_count is 1 here, always — action=create is BY DEFINITION
  // the first generation. Any later generation goes through
  // regenerateVideoJob() instead, which is the only place generation_count
  // ever goes to 2+. This is what makes the "first 3 Kling frames are free"
  // rule apply here and only here.
  const klingChargeForThisGeneration = calculateKlingChargeForGeneration(frames, 1);

  // ── THE GUARDRAIL ────────────────────────────────────────────────────
  // If there's anything to charge (i.e. more than 3 Kling frames), debit
  // it NOW, before any video_jobs row exists and before Railway is ever
  // contacted. If the user can't afford it, this returns immediately and
  // NOTHING downstream happens — no row, no Railway call, no risk.
  if (klingChargeForThisGeneration > 0) {
    const debitResult = await callDebitCredit(userId, klingChargeForThisGeneration, "kling_generation");
    if (debitResult.status === 402) {
      return {
        error:    debitResult.data?.code === "NO_SUB" ? "no_active_subscription" : "insufficient_credits",
        required: klingChargeForThisGeneration,
        balance:  debitResult.data?.balance,
      };
    }
    if (debitResult.status !== 200) {
      throw new Error(`Kling generation debit failed (status ${debitResult.status}): ${JSON.stringify(debitResult.data)}`);
    }
  }

  // From here on, if Images were charged above, they are SPENT — see the
  // header comment and Image Economy v2 §3: generation-time Kling charges
  // are never refundable for user-side reasons (didn't like the result,
  // changed their mind, etc.). The only refund case is a genuine platform
  // failure between the debit above and a successful Railway dispatch
  // below — see the catch block, which refunds ONLY in that narrow window.
  let job;
  try {
    // Create the job row. generation_count starts at 1 — this IS
    // generation #1. kling_images_charged tracks the running total spent
    // on Kling across this job's whole lifetime (this generation plus any
    // future regenerations), kept separate from credits_used (the
    // still-deferred download-time flat fee) so the two never get confused.
    const jobResult = await supabase("POST", "video_jobs", {
      listing_id:           listingId,
      user_id:              userId,
      project_id:           projectId,
      status:               "queued",
      formats,
      music_style:          musicStyle || null,
      generation_count:     1,
      kling_images_charged: klingChargeForThisGeneration,
      credits_used:         calculateDownloadCost(frames), // deferred — see downloadVideoJob
    });

    // CHANGE: log the real Supabase response when this fails, instead of
    // swallowing it into a generic message — exactly the same class of
    // silent-failure bug found twice already in project-manage.js this
    // session. Surface the actual status/body so the thrown error is
    // diagnosable from the Netlify log without needing a second round trip.
    job = jobResult.data?.[0];
    if (!job) {
      console.error(
        "video_jobs insert failed — status:", jobResult.status,
        "| response:", JSON.stringify(jobResult.data),
        "| projectId received:", projectId, "| listingId:", listingId
      );
      throw new Error(`Failed to create video_jobs row (status ${jobResult.status}): ${JSON.stringify(jobResult.data)}`);
    }

    // Create frame rows, preserving sequence order
    const frameRows = frames.map((f, i) => ({
      job_id:           job.id,
      staged_image_id:  f.stagedImageId || null,
      image_url:        f.imageUrl,
      before_url:       f.beforeUrl || null,
      is_before_after:  !!f.isBeforeAfter,
      use_ai_motion:    !!f.useAiMotion,
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
        useAiMotion:     f.use_ai_motion,
        roomType:        f.room_type,
        motionPreset:    f.motion_preset,
        durationSeconds: f.duration_seconds,
        sequenceOrder:   f.sequence_order,
      })),
    });

    return {
      created: true,
      jobId: job.id,
      generationCount: 1,
      klingImagesCharged: klingChargeForThisGeneration,
      quotedDownloadCost: job.credits_used,
    };

  } catch (err) {
    console.error("createVideoJob failed:", err.message, { jobId: job?.id });

    // CHANGE: refund path. This did not exist in the old free-until-download
    // model because nothing was ever charged before this point. Now it's
    // possible to have successfully debited Images above and THEN hit a
    // failure creating rows or reaching Railway — a pure platform failure,
    // not a user decision, so this is the one case where a refund is
    // correct rather than "no refunds, ever" (Image Economy v2 §7).
    if (klingChargeForThisGeneration > 0) {
      try {
        await callDebitCredit(userId, klingChargeForThisGeneration, "kling_generation_refund_dispatch_failed", true);
      } catch (refundErr) {
        // Refund itself failed — log loudly. This is the one scenario that
        // genuinely needs a "contact support" fallback, since the user was
        // charged for a video that never got created.
        console.error(
          "CRITICAL: Kling debit refund failed after dispatch failure — manual ledger correction needed.",
          { userId, amount: klingChargeForThisGeneration, originalError: err.message, refundError: refundErr.message }
        );
      }
    }

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

// ── ACTION: REGENERATE (any generation after the first) ──────────────────
//
// NEW (Image Economy v2). Same job, same listing/project — the user is
// going back into an existing video_jobs row to change something and
// re-render. The moment this is called, the 3-included-Kling-frames
// allowance from action=create no longer applies: EVERY Kling frame in
// this run is billed, including ones that were free the first time. See
// calculateKlingChargeForGeneration's generationCount !== 1 branch.
//
// This does NOT touch the monthly video quota at all — only action=download
// does that (see consumeVideoQuotaSlot). A user can regenerate the same
// video as many times as their Image balance allows without ever using up
// another one of their plan's monthly video slots.

async function regenerateVideoJob({ jobId, userId, frames, formats, musicStyle }) {
  if (!jobId || !userId) throw new Error("Missing jobId or userId");
  if (!frames || frames.length === 0) throw new Error("No frames provided");

  if (frames.length > MAX_FRAMES_PER_JOB) {
    throw new Error(
      `Too many frames: ${frames.length} requested, ${MAX_FRAMES_PER_JOB} max per video.`
    );
  }

  const existingRes = await supabase("GET", "video_jobs", null,
    `?id=eq.${jobId}&select=id,user_id,generation_count,kling_images_charged`
  );
  const existing = existingRes.data?.[0];
  if (!existing) return { error: "job_not_found" };
  if (existing.user_id !== userId) return { error: "forbidden" };

  validateAiMotionEligibility(frames);
  validateFormatChoiceForAiMotion(frames, formats);

  const nextGenerationCount = (existing.generation_count || 1) + 1;

  // generationCount is guaranteed >= 2 here, so calculateKlingChargeForGeneration
  // takes the "no included allowance" branch — every Kling frame in this
  // run is billed, full stop.
  const klingChargeForThisGeneration = calculateKlingChargeForGeneration(frames, nextGenerationCount);

  if (klingChargeForThisGeneration > 0) {
    const debitResult = await callDebitCredit(userId, klingChargeForThisGeneration, "kling_generation_iteration");
    if (debitResult.status === 402) {
      return {
        error:    debitResult.data?.code === "NO_SUB" ? "no_active_subscription" : "insufficient_credits",
        required: klingChargeForThisGeneration,
        balance:  debitResult.data?.balance,
      };
    }
    if (debitResult.status !== 200) {
      throw new Error(`Kling iteration debit failed (status ${debitResult.status}): ${JSON.stringify(debitResult.data)}`);
    }
  }

  try {
    // Update the job row: bump generation_count, accumulate the running
    // Kling spend total, refresh the deferred download-time quote (frame
    // mix may have changed), reset status to queued for the new render.
    await supabase("PATCH", "video_jobs", {
      status:               "queued",
      formats,
      music_style:          musicStyle || null,
      generation_count:     nextGenerationCount,
      kling_images_charged: (existing.kling_images_charged || 0) + klingChargeForThisGeneration,
      credits_used:         calculateDownloadCost(frames),
      // credits_charged_at and video_quota_charged_at are deliberately NOT
      // touched here — if this job was already downloaded once before
      // (re-edited after the fact), this regeneration does not re-charge
      // the flat download fee or re-consume a video quota slot. The next
      // action=download call for THIS job will see credits_charged_at is
      // already set and skip straight to idempotent URL hand-back, same
      // as before. If you want a re-download after a regenerate to charge
      // again, that's a deliberate product decision still open — flag it.
    }, `?id=eq.${jobId}`);

    // Replace frame rows entirely — old sequence may not match new one.
    await supabase("DELETE", "video_job_frames", null, `?job_id=eq.${jobId}`);

    const frameRows = frames.map((f, i) => ({
      job_id:           jobId,
      staged_image_id:  f.stagedImageId || null,
      image_url:        f.imageUrl,
      before_url:       f.beforeUrl || null,
      is_before_after:  !!f.isBeforeAfter,
      use_ai_motion:    !!f.useAiMotion,
      room_type:        f.roomType || "default",
      motion_preset:    f.motionPreset || "auto",
      duration_seconds: f.durationSeconds || 4.5,
      sequence_order:   i,
    }));

    await supabase("POST", "video_job_frames", frameRows);

    await dispatchToRailway({
      jobId,
      formats,
      musicStyle: musicStyle || "default",
      frames: frameRows.map(f => ({
        imageUrl:        f.image_url,
        beforeUrl:       f.before_url,
        isBeforeAfter:   f.is_before_after,
        useAiMotion:     f.use_ai_motion,
        roomType:        f.room_type,
        motionPreset:    f.motion_preset,
        durationSeconds: f.duration_seconds,
        sequenceOrder:   f.sequence_order,
      })),
    });

    return {
      created: true,
      jobId,
      generationCount: nextGenerationCount,
      klingImagesCharged: klingChargeForThisGeneration,
    };

  } catch (err) {
    console.error("regenerateVideoJob failed:", err.message, { jobId });

    // Same refund-on-platform-failure logic as createVideoJob — see that
    // function's catch block for the full reasoning.
    if (klingChargeForThisGeneration > 0) {
      try {
        await callDebitCredit(userId, klingChargeForThisGeneration, "kling_iteration_refund_dispatch_failed", true);
      } catch (refundErr) {
        console.error(
          "CRITICAL: Kling iteration debit refund failed after dispatch failure — manual ledger correction needed.",
          { userId, jobId, amount: klingChargeForThisGeneration, originalError: err.message, refundError: refundErr.message }
        );
      }
    }

    await supabase("PATCH", "video_jobs",
      { status: "failed", error_message: err.message },
      `?id=eq.${jobId}`
    );
    return { error: "dispatch_failed", jobId };
  }
}

// ── VIDEO QUOTA (monthly download cap — Solo 5 / Team 12 / Brokerage 40) ─
//
// NEW (Image Economy v2). Completely independent from the Image ledger —
// see header comment and Image Economy v2 §4. Consumed ONLY at download,
// never at generation/regeneration, regardless of how many times a video
// was iterated first.
//
// SCHEMA NOTE: this assumes a new `video_quota_usage` table:
//   user_id (uuid), period_start (date, first of the current month),
//   videos_downloaded (integer, default 0)
// One row per user per month. Not yet created — add via migration before
// this ships. monthly_video_limit comes from TIER_ALLOCATION-style lookup,
// mirrored here rather than imported from debit-credit.js since that file
// has no video-specific concept today; consider consolidating both
// allocation tables into one shared config file in a follow-up pass so
// Image allocation and video quota can't silently drift out of sync.
const MONTHLY_VIDEO_LIMIT = {
  individual_agent: 5,   // Solo
  team_member:      12,  // Team
  team_lead:         12,  // Team
  broker_admin:      40,  // Brokerage
};

function currentPeriodStart() {
  const now = new Date();
  return `${now.getUTCFullYear()}-${String(now.getUTCMonth() + 1).padStart(2, "0")}-01`;
}

// Returns { allowed: true, remaining } or { allowed: false, used, limit }.
// Does NOT increment anything — see consumeVideoQuotaSlot for the actual
// decrement, which only happens once the download is otherwise confirmed
// to proceed (Image debit, if any, already succeeded).
async function checkVideoQuota(userId) {
  const userRes = await supabase("GET", "users", null, `?id=eq.${userId}&select=role`);
  const role = userRes.data?.[0]?.role;
  const limit = MONTHLY_VIDEO_LIMIT[role] ?? 5;

  const periodStart = currentPeriodStart();
  const usageRes = await supabase("GET", "video_quota_usage", null,
    `?user_id=eq.${userId}&period_start=eq.${periodStart}&select=videos_downloaded`
  );
  const used = usageRes.data?.[0]?.videos_downloaded || 0;

  return used >= limit
    ? { allowed: false, used, limit }
    : { allowed: true, remaining: limit - used, used, limit };
}

// Increments the count, upserting the period row if it doesn't exist yet
// this month. Called only after every other download condition (status
// complete, not already charged, Image debit succeeded) has passed.
async function consumeVideoQuotaSlot(userId) {
  const periodStart = currentPeriodStart();
  const existingRes = await supabase("GET", "video_quota_usage", null,
    `?user_id=eq.${userId}&period_start=eq.${periodStart}&select=id,videos_downloaded`
  );
  const existing = existingRes.data?.[0];

  if (existing) {
    await supabase("PATCH", "video_quota_usage",
      { videos_downloaded: existing.videos_downloaded + 1 },
      `?id=eq.${existing.id}`
    );
  } else {
    await supabase("POST", "video_quota_usage", {
      user_id:           userId,
      period_start:      periodStart,
      videos_downloaded: 1,
    });
  }
}

// ── ACTION: DOWNLOAD ─────────────────────────────────────────────────────
// Charges the flat assembly fee (+ any download-time Ken Burns cost, which
// is currently always 0 per PER_FRAME_COST — see calculateDownloadCost) and
// consumes one monthly video quota slot. Kling was already fully paid for
// at generation/regeneration time — this never touches Kling cost again.
// Charges once, on first download, idempotent for any later re-download of
// the same job. This is also the only place the real output URLs get
// returned — see getJobStatus below, which deliberately does NOT include
// them, so polling status alone can never hand over the finished file
// before it's been paid for.
//
// CHANGE (Image Economy v2): video quota check now happens BEFORE the
// Image debit, not after — if the user is out of video quota for the
// month, fail fast without touching the Image ledger at all. If quota is
// fine but Images are insufficient, fail there next, before either is
// actually consumed. Only once both checks pass do we debit Images AND
// consume a quota slot, in that order — see inline comments for why that
// order specifically.

async function downloadVideoJob({ jobId, userId }) {
  if (!jobId || !userId) throw new Error("Missing jobId or userId");

  const jobRes = await supabase("GET", "video_jobs", null,
    `?id=eq.${jobId}&select=id,user_id,status,output_16x9_url,output_9x16_url,credits_used,credits_charged_at`
  );
  const job = jobRes.data?.[0];

  if (!job) return { error: "job_not_found" };
  if (job.user_id !== userId) return { error: "forbidden" };
  if (job.status !== "complete") return { error: "not_ready", status: job.status };

  // Already charged — idempotent, just hand back the URLs again. No debit,
  // no quota consumption — both already happened on the first download.
  if (job.credits_charged_at) {
    return {
      downloadReady: true,
      output16x9Url: job.output_16x9_url,
      output9x16Url: job.output_9x16_url,
    };
  }

  // First download for this job. Check video quota FIRST, before touching
  // Images at all — if the user is out of video downloads for the month,
  // there's no reason to even attempt an Image debit.
  const quota = await checkVideoQuota(userId);
  if (!quota.allowed) {
    return {
      error: "video_quota_exceeded",
      used:  quota.used,
      limit: quota.limit,
    };
  }

  // Quota has a slot available — now check/charge Images via debit-credit.js,
  // the exact same balance + active-subscription/trial check image staging
  // uses. job.credits_used here is ONLY the flat download-time fee
  // (calculateDownloadCost's output, stored at create/regenerate time) —
  // Kling is never part of this number anymore.
  const debitResult = await callDebitCredit(userId, job.credits_used, "video_download");

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

  // Both checks passed and the Image debit succeeded — NOW consume the
  // quota slot. Doing this after the debit (not before) means if the debit
  // had failed, we would not have wrongly burned a video quota slot for a
  // download that didn't actually go through.
  await consumeVideoQuotaSlot(userId);

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

// ── ACTION: QUOTE (read-only — never charges anything) ──────────────────
//
// NEW (Image Economy v2 §6). This is the function the frontend's
// mandatory pre-generation confirmation screen calls — it has to show the
// exact Image cost and resulting balance BEFORE the user clicks Generate
// Video or Iterate, since both of those now charge real, non-refundable
// Images the instant they're clicked. This endpoint computes the same
// numbers createVideoJob/regenerateVideoJob would charge, but touches
// nothing — no debit, no row creation, no Railway call.
//
// jobId is optional: omit it for a brand-new video (quotes as generation
// #1, the 3-included-frame rule applies); pass an existing jobId to quote
// an iteration (no included allowance, full price on every Kling frame).

async function quoteGeneration({ jobId, userId, frames }) {
  if (!frames || frames.length === 0) throw new Error("No frames provided");

  let generationCount = 1;
  if (jobId) {
    const existingRes = await supabase("GET", "video_jobs", null,
      `?id=eq.${jobId}&select=user_id,generation_count`
    );
    const existing = existingRes.data?.[0];
    if (!existing) return { error: "job_not_found" };
    if (existing.user_id !== userId) return { error: "forbidden" };
    generationCount = (existing.generation_count || 1) + 1;
  }

  const klingFrameCount = frames.filter(f => f.useAiMotion).length;
  const includedFrames = generationCount === 1
    ? Math.min(klingFrameCount, KLING_INCLUDED_FRAMES_FIRST_GEN)
    : 0;
  const billableKlingFrames = klingFrameCount - includedFrames;
  const klingCost = billableKlingFrames * KLING_IMAGE_COST_PER_FRAME;

  // Read current balance directly from the ledger — deliberately NOT
  // going through debit-credit.js for this, since that file's only
  // balance-check path requires a cost argument and is built to debit on
  // success. Reading the ledger directly here keeps this endpoint truly
  // side-effect-free.
  const ledgerRes = await supabase("GET", "credit_ledger", null,
    `?user_id=eq.${userId}&order=created_at.desc&limit=1&select=balance_after`
  );
  const currentBalance = ledgerRes.data?.[0]?.balance_after ?? null;

  return {
    generationCount,
    isIteration: generationCount > 1,
    klingFrameCount,
    includedFrames,
    billableKlingFrames,
    klingImageCost: klingCost,
    currentBalance,
    balanceAfter: currentBalance !== null ? currentBalance - klingCost : null,
    wouldExceedBalance: currentBalance !== null ? klingCost > currentBalance : null,
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
  //
  // generation_count and kling_images_charged now also included so the
  // frontend can show "you've spent N Images on Kling so far across M
  // generations" running context, even while the job is still rendering.
  const r = await supabase("GET", "video_jobs", null,
    `?id=eq.${jobId}&select=id,status,thumbnail_url,credits_used,credits_charged_at,generation_count,kling_images_charged,error_message,created_at,completed_at`
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

    if (action === "quote") {
      const body = JSON.parse(event.body || "{}");
      const { jobId, userId, frames } = body;
      if (!userId || !frames) {
        return { statusCode: 400, headers, body: JSON.stringify({ error: "Missing required fields" }) };
      }
      const result = await quoteGeneration({ jobId, userId, frames });
      const QUOTE_STATUS_CODES = { job_not_found: 404, forbidden: 403 };
      const statusCode = result.error ? (QUOTE_STATUS_CODES[result.error] || 500) : 200;
      return { statusCode, headers, body: JSON.stringify(result) };
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
      // CHANGE (Image Economy v2): create now CAN fail on payment — if
      // there are more than 3 Kling frames, Images are debited here before
      // anything is created. insufficient_credits/no_active_subscription
      // are real possible outcomes now, not just dispatch_failed.
      const CREATE_STATUS_CODES = {
        insufficient_credits:   402,
        no_active_subscription: 402,
        dispatch_failed:        500,
      };
      const statusCode = result.error ? (CREATE_STATUS_CODES[result.error] || 500) : 200;
      return { statusCode, headers, body: JSON.stringify(result) };
    }

    if (action === "regenerate") {
      const body = JSON.parse(event.body || "{}");
      const { jobId, userId, frames, formats, musicStyle } = body;
      if (!jobId || !userId || !frames) {
        return { statusCode: 400, headers, body: JSON.stringify({ error: "Missing required fields" }) };
      }
      const result = await regenerateVideoJob({
        jobId, userId, frames,
        formats: formats || ["16x9", "9x16"],
        musicStyle,
      });
      const REGENERATE_STATUS_CODES = {
        job_not_found:           404,
        forbidden:                403,
        insufficient_credits:     402,
        no_active_subscription:  402,
        dispatch_failed:          500,
      };
      const statusCode = result.error ? (REGENERATE_STATUS_CODES[result.error] || 500) : 200;
      return { statusCode, headers, body: JSON.stringify(result) };
    }

    if (action === "download") {
      const body = JSON.parse(event.body || "{}");
      const { jobId, userId } = body;
      if (!jobId || !userId) {
        return { statusCode: 400, headers, body: JSON.stringify({ error: "Missing jobId or userId" }) };
      }
      const result = await downloadVideoJob({ jobId, userId });
      const DOWNLOAD_STATUS_CODES = {
        job_not_found:           404,
        forbidden:                403,
        not_ready:                409, // job exists but isn't complete yet
        insufficient_credits:     402,
        no_active_subscription:  402,
        video_quota_exceeded:    403, // distinct from payment errors — this
                                       // is a plan-limit block, not a
                                       // balance problem; frontend should
                                       // show "upgrade plan" not "buy Images"
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
