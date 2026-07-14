// generate-narration-background.js — Netlify Background Function
// Generates a narration script (Claude) + speech (ElevenLabs v3) + uploads
// the result (Cloudinary), and stores it in Netlify Blobs for polling.
//
// WHY THIS EXISTS (July 2026 postmortem): narration generation was
// originally built INLINE inside video-job.js's action=create/regenerate —
// Claude script call, then ElevenLabs TTS, then Cloudinary upload, all
// sequentially, awaited, in one synchronous function call. Real-world
// logs showed this taking 37+ seconds. Netlify hard-caps SYNCHRONOUS
// functions at 26 seconds maximum — not the `timeout` value in
// netlify.toml, which is silently capped regardless of what's configured
// there, and even reaching 26s requires a Pro-tier plan plus a support
// ticket to activate. No amount of raising that number fixes a call that
// structurally takes longer than the hard ceiling.
//
// This mirrors stage-openai-background.js's exact pattern (same repo,
// same problem, already solved once): a Background Function (Netlify
// auto-detects the "-background" filename suffix and grants up to 15
// minutes), writes a "processing" heartbeat to Netlify Blobs immediately,
// does the real work, then writes "done" or "error". check-narration.js
// (new, alongside this file) is the polling counterpart, mirroring
// check-openai.js exactly.
//
// CALLED FROM: build-video-demo.html, as soon as the user picks a
// narration voice in Step 3 — NOT from video-job.js's create/regenerate.
// By the time action=create/regenerate is actually called, narration
// (if requested) has ALREADY finished generating; those functions now
// just attach the already-ready audioUrl and handle billing. This
// decouples the slow work from the billing/dispatch path entirely.

const https = require("https");
const crypto = require("crypto");
const { getStore } = require("@netlify/blobs");

// Duplicated from video-job.js's identical helper — same reasoning as the
// other duplication in this file: no shared server-side lib in this repo
// for this kind of thing, each Netlify function is self-contained.
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

// ── NARRATION VOICE LIBRARY — PLACEHOLDER DATA ──────────────────────────
// MUST stay in sync with NARRATION_VOICE_LIBRARY in video-job.js and
// NARRATION_VOICES in build-video-demo.html — same caveat as before,
// duplicated here (not imported) because this repo's Netlify functions
// are each self-contained bundles with no shared server-side lib for
// this kind of logic (the only existing shared file, lib/virtually-
// staged-badge.js, is a client-side canvas helper, not applicable here).
const NARRATION_VOICE_LIBRARY = {
  "voice_male_1":   { label: "Male — Audiobook Narrator",     voiceId: "pVYHFs8oaIDPWJxvmXWW" },
  "voice_female_1": { label: "Female — Adeline, Conversational", voiceId: "5l5f8iK3YPeGga21rQIX" },
};

// CHANGE (July 14, 2026 — real test failure): NARRATION_MAX_WORDS was a
// FIXED cap regardless of how long the actual video was. Sam's videos are
// typically 4-6 rooms × ~4.5s each ≈ 20-30 seconds — nowhere near the
// ~90 seconds a 225-word script takes to read. The result: narration was
// still talking when the video's own "-shortest" flag (assemble.js)
// hard-cut the whole audio track at the video's visual end, chopping off
// mid-sentence. Fixed properly now: script length is DERIVED from the
// real estimated video duration for THIS job, not a fixed number.
//
// Mirrors DEFAULT_DURATIONS from motionPresets.js (Railway) — duplicated
// here for the same reason as everything else in this file (no shared
// server-side lib in this repo). If Sam ever changes the real per-room
// defaults there, this estimate will drift out of sync — worth keeping
// in mind, though a rough estimate here is fine since this only sizes
// the script target, not the actual video render.
const ROOM_DURATION_ESTIMATES = {
  exterior: 5.5, living: 5.5, kitchen: 4.5, dining: 4.0,
  bedroom: 4.5, bathroom: 3.0, flex: 4.0, default: 4.5,
};
const NARRATION_END_BUFFER_SECONDS = 2; // narration should finish this long before the video ends
const SPEAKING_RATE_WORDS_PER_MINUTE = 150;
const MIN_NARRATION_WORDS = 25; // floor — even a single short room shouldn't produce a 3-word script

function estimateVideoDurationSeconds(roomTypeCodes) {
  if (!roomTypeCodes || roomTypeCodes.length === 0) return 20; // reasonable fallback guess
  return roomTypeCodes.reduce((sum, code) => sum + (ROOM_DURATION_ESTIMATES[code] || ROOM_DURATION_ESTIMATES.default), 0);
}

function wordBudgetForDuration(estimatedVideoSeconds) {
  const availableSeconds = Math.max(5, estimatedVideoSeconds - NARRATION_END_BUFFER_SECONDS);
  const words = Math.round((availableSeconds / 60) * SPEAKING_RATE_WORDS_PER_MINUTE);
  return Math.max(MIN_NARRATION_WORDS, words);
}

function generateNarrationScript(address, roomLabels, maxWords, apiKey) {
  return new Promise((resolve, reject) => {
    const roomList = roomLabels.length ? roomLabels.join(", ") : "the property";
    const prompt = `Write a warm, professional real estate video narration script for a listing tour.
Address: ${address || "this property"}
Rooms featured, in order: ${roomList}

Requirements:
- Maximum ${maxWords} words (hard limit — this script is timed to this specific video's length; going over means it will be cut off mid-sentence when the video ends).
- Conversational, inviting tone, third person (never "I" or "my listing").
- Reference the rooms in the order given, briefly, without inventing specific features you weren't told about (no fabricated square footage, bedroom/bathroom counts, or amenities).
- End with a simple, natural closing line inviting the viewer to schedule a showing — the closing line must fit fully within the word limit, not get cut off.
- This will be read by ElevenLabs' eleven_v3 model, which supports inline delivery tags like [warmly] or [pause]. Use AT MOST ONE such tag, at the very start of the script, to set a warm tone — do not use tags anywhere else. This is a real estate walkthrough, not a dramatic reading; restraint matters more than expressiveness here.
- Return ONLY the script text — no headers, no stage directions beyond the one optional opening tag, no markdown.`;

    const bodyStr = JSON.stringify({
      model: "claude-sonnet-4-6",
      max_tokens: 500,
      messages: [{ role: "user", content: prompt }],
    });

    const req = https.request({
      hostname: "api.anthropic.com",
      path: "/v1/messages",
      method: "POST",
      headers: {
        "x-api-key": apiKey,
        "anthropic-version": "2023-06-01",
        "Content-Type": "application/json",
        "Content-Length": Buffer.byteLength(bodyStr),
      },
    }, (res) => {
      let data = "";
      res.on("data", (c) => (data += c));
      res.on("end", () => {
        try {
          const parsed = JSON.parse(data);
          const text = parsed?.content?.find((b) => b.type === "text")?.text;
          if (!text) return reject(new Error(`Claude returned no script text: ${data.slice(0, 300)}`));
          resolve(text.trim());
        } catch (e) {
          reject(new Error(`Claude script response parse error: ${e.message}`));
        }
      });
    });
    req.on("error", reject);
    req.write(bodyStr);
    req.end();
  });
}

function generateNarrationAudio(script, voiceId, apiKey) {
  return new Promise((resolve, reject) => {
    const bodyStr = JSON.stringify({ text: script, model_id: "eleven_v3" });
    const req = https.request({
      hostname: "api.elevenlabs.io",
      path: `/v1/text-to-speech/${voiceId}`,
      method: "POST",
      headers: {
        "xi-api-key": apiKey,
        "Content-Type": "application/json",
        "Accept": "audio/mpeg",
        "Content-Length": Buffer.byteLength(bodyStr),
      },
    }, (res) => {
      const chunks = [];
      res.on("data", (c) => chunks.push(c));
      res.on("end", () => {
        if (res.statusCode !== 200) {
          return reject(new Error(`ElevenLabs error (status ${res.statusCode}): ${Buffer.concat(chunks).toString("utf8").slice(0, 300)}`));
        }
        resolve(Buffer.concat(chunks));
      });
    });
    req.on("error", reject);
    req.write(bodyStr);
    req.end();
  });
}

function uploadNarrationToCloudinary(audioBuffer) {
  return new Promise((resolve, reject) => {
    const cloudName = process.env.CLOUDINARY_CLOUD_NAME;
    const apiKey = process.env.CLOUDINARY_API_KEY;
    const apiSecret = process.env.CLOUDINARY_API_SECRET;
    if (!cloudName || !apiKey || !apiSecret) {
      return reject(new Error("Cloudinary env vars not fully configured."));
    }

    const dataUrl = `data:audio/mpeg;base64,${audioBuffer.toString("base64")}`;
    const timestamp = Math.floor(Date.now() / 1000).toString();
    const folder = "smart-stage-narration";
    const paramsToSign = `folder=${folder}&timestamp=${timestamp}`;
    const signature = crypto.createHash("sha1").update(paramsToSign + apiSecret).digest("hex");

    const bodyObj = { file: dataUrl, folder, timestamp, api_key: apiKey, signature };
    const bodyStr = Object.entries(bodyObj)
      .map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(v)}`)
      .join("&");
    const bodyBuf = Buffer.from(bodyStr, "utf8");

    const req = https.request({
      hostname: "api.cloudinary.com",
      path: `/v1_1/${cloudName}/raw/upload`,
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded", "Content-Length": bodyBuf.length },
    }, (res) => {
      const chunks = [];
      res.on("data", (c) => chunks.push(c));
      res.on("end", () => {
        try {
          const parsed = JSON.parse(Buffer.concat(chunks).toString("utf8"));
          if (res.statusCode !== 200) reject(new Error(`Cloudinary error: ${parsed?.error?.message}`));
          else resolve(parsed.secure_url);
        } catch (e) { reject(new Error("Cloudinary parse error")); }
      });
    });
    req.on("error", reject);
    req.write(bodyBuf);
    req.end();
  });
}

// ── DURABLE AUDIT TRAIL (new — Netlify background-function logs are a
// known, longstanding platform gap: multiple Netlify support threads
// describe logs simply not being available for background/scheduled
// functions, sometimes for days at a time, with no ETA. Rather than
// depend on ever seeing those logs, every attempt now writes a real row
// to a new `narration_attempts` Supabase table — the same place Sam
// already looks at everything else in this app. This is the ONLY
// reliable way to answer "was I charged for that failed attempt?" after
// the fact, since ElevenLabs bills the instant generateNarrationAudio
// succeeds, regardless of what happens afterward (a Cloudinary failure,
// a dropped connection, anything) — elevenlabs_likely_charged is set to
// true at exactly that moment, not inferred after the fact. ──────────
//
// SCHEMA NOTE — new table, not yet created:
//   create table narration_attempts (
//     id uuid primary key default gen_random_uuid(),
//     narration_job_id text not null,
//     listing_id uuid,
//     voice_key text,
//     stage_reached text not null,        -- see STAGE constants below
//     elevenlabs_likely_charged boolean not null default false,
//     script_char_count integer,
//     error_message text,
//     created_at timestamptz default now(),
//     updated_at timestamptz default now()
//   );
const STAGE = {
  STARTED:            "started",
  SCRIPT_GENERATED:   "script_generated",
  ELEVENLABS_CHARGED: "elevenlabs_charged",   // audio buffer received — billing already happened, no matter what comes next
  UPLOADED_COMPLETE:  "uploaded_complete",
  FAILED:             "failed",
};

async function logAttempt(rowId, fields) {
  try {
    if (!rowId) {
      const res = await supabase("POST", "narration_attempts", { ...fields, updated_at: new Date().toISOString() });
      return res.data?.[0]?.id || null;
    }
    await supabase("PATCH", "narration_attempts", { ...fields, updated_at: new Date().toISOString() }, `?id=eq.${rowId}`);
    return rowId;
  } catch (e) {
    // Audit logging itself failing should never take down the real
    // narration attempt — log to console as a last resort and move on.
    console.error("narration_attempts logging failed (non-fatal):", e.message);
    return rowId;
  }
}

exports.handler = async (event) => {
  const siteID = process.env.SZREG_SITE_ID || process.env.NETLIFY_SITE_ID;
  const token  = process.env.NETLIFY_ACCESS_TOKEN;
  let narrationJobId;
  let auditRowId = null;

  try {
    const { narrationJobId: jId, listingId, roomLabels, roomTypeCodes, voiceKey } = JSON.parse(event.body);
    narrationJobId = jId;
    console.log(`Narration job ${narrationJobId} starting — voiceKey=${voiceKey}`);

    auditRowId = await logAttempt(null, {
      narration_job_id: narrationJobId,
      listing_id: listingId || null,
      voice_key: voiceKey || null,
      stage_reached: STAGE.STARTED,
      elevenlabs_likely_charged: false,
    });

    if (!siteID) throw new Error("NETLIFY_SITE_ID not configured");
    if (!token)  throw new Error("NETLIFY_ACCESS_TOKEN not configured");

    const store = getStore({ name: "narration-jobs", siteID, token });

    // Heartbeat immediately — confirms the background function is actually
    // running, same as stage-openai-background.js.
    await store.setJSON(narrationJobId, { status: "processing", startedAt: Date.now() });

    const voice = NARRATION_VOICE_LIBRARY[voiceKey];
    if (!voice || voice.voiceId.startsWith("REPLACE_WITH_REAL_")) {
      throw new Error(`Voice "${voiceKey}" is not configured with a real ElevenLabs voice_id yet.`);
    }

    const anthropicKey = process.env.ANTHROPIC_API_KEY;
    const elevenLabsKey = process.env.ELEVENLABS_API_KEY;
    if (!anthropicKey) throw new Error("ANTHROPIC_API_KEY not configured");
    if (!elevenLabsKey) throw new Error("ELEVENLABS_API_KEY not configured");

    // NEW — fetch the address here rather than requiring the frontend to
    // already know it. `address` is the only field confirmed reliable on
    // `listings` (see the July 13 schema conversation) — no bedrooms/
    // bathrooms/amenities data exists anywhere in this app's schema.
    let address = null;
    if (listingId) {
      const listingRes = await supabase("GET", "listings", null, `?id=eq.${listingId}&select=address`);
      address = listingRes.data?.[0]?.address || null;
    }

    // NEW (July 14, 2026) — size the script to THIS video's actual
    // estimated length, not a fixed cap. See ROOM_DURATION_ESTIMATES'
    // header comment for the full reasoning.
    const estimatedVideoSeconds = estimateVideoDurationSeconds(roomTypeCodes || []);
    const maxWords = wordBudgetForDuration(estimatedVideoSeconds);
    console.log(`Narration job ${narrationJobId}: estimated video ${estimatedVideoSeconds.toFixed(1)}s → word budget ${maxWords}`);

    const script = await generateNarrationScript(address, roomLabels || [], maxWords, anthropicKey);
    console.log(`Narration job ${narrationJobId}: script generated (${script.length} chars)`);
    auditRowId = await logAttempt(auditRowId, {
      stage_reached: STAGE.SCRIPT_GENERATED,
      script_char_count: script.length,
    });

    const audioBuffer = await generateNarrationAudio(script, voice.voiceId, elevenLabsKey);
    console.log(`Narration job ${narrationJobId}: audio generated (${Math.round(audioBuffer.length / 1024)}KB)`);
    // CRITICAL: this is the exact moment ElevenLabs bills, regardless of
    // whatever happens next. Logged immediately, not deferred until after
    // the upload step, so a Cloudinary failure right after this point
    // still leaves an accurate "yes, this one really did cost credits" record.
    auditRowId = await logAttempt(auditRowId, {
      stage_reached: STAGE.ELEVENLABS_CHARGED,
      elevenlabs_likely_charged: true,
    });

    const audioUrl = await uploadNarrationToCloudinary(audioBuffer);
    console.log(`Narration job ${narrationJobId}: uploaded to ${audioUrl}`);
    auditRowId = await logAttempt(auditRowId, { stage_reached: STAGE.UPLOADED_COMPLETE });

    await store.setJSON(narrationJobId, { status: "done", script, audioUrl });

  } catch (err) {
    console.error(`Narration job ${narrationJobId} error:`, err.message);
    await logAttempt(auditRowId, {
      stage_reached: STAGE.FAILED,
      error_message: err.message?.slice(0, 500),
    });
    try {
      const store = getStore({ name: "narration-jobs", siteID, token });
      await store.setJSON(narrationJobId, { status: "error", error: err.message });
    } catch (e) { /* nothing more we can do if even the error write fails */ }
  }
};
