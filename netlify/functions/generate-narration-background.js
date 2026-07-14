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

const NARRATION_MAX_WORDS = 225;

function generateNarrationScript(address, roomTypes, apiKey) {
  return new Promise((resolve, reject) => {
    const roomList = roomTypes.length ? roomTypes.join(", ") : "the property";
    const prompt = `Write a warm, professional real estate video narration script for a listing tour.
Address: ${address || "this property"}
Rooms featured, in order: ${roomList}

Requirements:
- Maximum ${NARRATION_MAX_WORDS} words (hard limit — this will be read aloud in under 90 seconds).
- Conversational, inviting tone, third person (never "I" or "my listing").
- Reference the rooms in the order given, briefly, without inventing specific features you weren't told about (no fabricated square footage, bedroom/bathroom counts, or amenities).
- End with a simple, natural closing line inviting the viewer to schedule a showing.
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

exports.handler = async (event) => {
  const siteID = process.env.SZREG_SITE_ID || process.env.NETLIFY_SITE_ID;
  const token  = process.env.NETLIFY_ACCESS_TOKEN;
  let narrationJobId;

  try {
    const { narrationJobId: jId, listingId, roomTypes, voiceKey } = JSON.parse(event.body);
    narrationJobId = jId;
    console.log(`Narration job ${narrationJobId} starting — voiceKey=${voiceKey}`);

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

    const script = await generateNarrationScript(address, roomTypes || [], anthropicKey);
    console.log(`Narration job ${narrationJobId}: script generated (${script.length} chars)`);

    const audioBuffer = await generateNarrationAudio(script, voice.voiceId, elevenLabsKey);
    console.log(`Narration job ${narrationJobId}: audio generated (${Math.round(audioBuffer.length / 1024)}KB)`);

    const audioUrl = await uploadNarrationToCloudinary(audioBuffer);
    console.log(`Narration job ${narrationJobId}: uploaded to ${audioUrl}`);

    await store.setJSON(narrationJobId, { status: "done", script, audioUrl });

  } catch (err) {
    console.error(`Narration job ${narrationJobId} error:`, err.message);
    try {
      const store = getStore({ name: "narration-jobs", siteID, token });
      await store.setJSON(narrationJobId, { status: "error", error: err.message });
    } catch (e) { /* nothing more we can do if even the error write fails */ }
  }
};
