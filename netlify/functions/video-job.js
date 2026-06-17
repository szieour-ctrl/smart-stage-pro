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

const VIDEO_CREDIT_COSTS = {
  "16x9":          3,
  "9x16":          3,
  "16x9+9x16":     5,
  before_after_add: 1,
};

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

function calculateCreditCost(formats, hasBeforeAfter) {
  let cost;
  if (formats.length === 2) cost = VIDEO_CREDIT_COSTS["16x9+9x16"];
  else cost = VIDEO_CREDIT_COSTS[formats[0]] || 3;

  if (hasBeforeAfter) cost += VIDEO_CREDIT_COSTS.before_after_add;
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
// Returns all staged images for a listing — populates the agent's photo
// selection UI. Read-only against the existing staged_images table.

async function getFramesForListing(listingId) {
  const r = await supabase("GET", "staged_images", null,
    `?listing_id=eq.${listingId}&select=id,mode,cloudinary_original_url,cloudinary_staged_url,created_at&order=created_at.asc`
  );
  return r.data || [];
}

// ── ACTION: CREATE ───────────────────────────────────────────────────────

async function createVideoJob({ listingId, projectId, userId, frames, formats, musicStyle }) {
  if (!frames || frames.length === 0) throw new Error("No frames provided");

  const hasBeforeAfter = frames.some(f => f.isBeforeAfter);
  const creditCost = calculateCreditCost(formats, hasBeforeAfter);

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
      const frames = await getFramesForListing(listingId);
      return { statusCode: 200, headers, body: JSON.stringify({ frames }) };
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
