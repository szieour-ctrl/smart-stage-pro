// autoSelect.js — Claude Vision auto-selection: room order, grouping, and
// motion preset for every frame in a video job.
//
// BACKGROUND (July 21, 2026 design conversation): today, a user builds a
// video by hand-picking room order and a motion preset per frame with no
// guidance on which presets actually suit which rooms, and no visibility
// into which frames are free (pool-covered) vs. billable until the quote
// screen. This module replaces that blind process with a single Claude
// Vision call that proposes a strong, free default — the user can still
// override anything, but overriding is now an informed, deliberate choice
// instead of the *only* option.
//
// THIS FILE ONLY PRODUCES AND VALIDATES THE PLAN. It does not call
// ltxMotion.js/klingMotion.js's actual render functions, and it does not
// touch billing/quote code — those are separate integration passes.
//
// ── THE RULES THIS ENCODES (all decided across the July 21 conversation) ──
//
// 1. ORDERING: natural walkthrough flow. Two hard constraints, not
//    negotiable by Claude: (a) a real vacant/staged pair must stay
//    adjacent to itself — it's one room, shown twice; (b) multiple photos
//    Claude judges to be the SAME physical room must stay grouped
//    together, because narration (narrationGen.js's groupContiguousByRoom)
//    narrates one contiguous room-label run as a single segment. Two
//    physically different rooms of the same TYPE (e.g. a primary bedroom
//    in a main house and a casita) must NOT share a group.
//
// 2. GROUPING KEY vs. ROOM TYPE: roomType is a category ("primary_bedroom").
//    roomGroup is the actual grouping/narration key — identical across
//    every frame Claude judges to be the same physical room, distinct
//    otherwise. This is what narrationGen.js's groupContiguousByRoom keys
//    off of (frame.roomLabel in that file). The existing manual "another
//    view of X" UI control is NOT retired by this feature — it remains a
//    user override for when Claude's same-room-vs-different-room judgment
//    is wrong (a real, fallible visual call). Intra-group PLAYBACK order
//    (groupOrder) is separate again, freely user-editable, no cost/warning
//    ever attached — it's cosmetic sequencing within an already-decided
//    group, not a narration or billing decision.
//
// 3. BOOKENDS (position 1 and the last position) — Claude's DEFAULT output
//    for these two positions must be free:
//      - Position 1: Ken Burns, Front Exterior content preferred if
//        available (pull_back, approximating a drone boom-up).
//      - Last position: Ken Burns Exterior by default. EXCEPTION — if
//        narration is OFF for this video AND a real Exterior Enhancement
//        pair (a vacant+staged exterior pair the user already built in
//        Smart Stage PRO) exists and was selected, the free default
//        becomes the Kling exterior transformation on that pair instead
//        (still free, still the default — not an override). The logic:
//        the user already did real work creating that pair in PRO: PRO
//        PLUS rewards that by making the strongest closer free when it's
//        available and there's no narration-padding cost concern.
//    Both bookends run at the plain 6s floor either way (no narration
//    padding ever applies to a Ken Burns clip, and the Kling exterior
//    exception only fires when narration is off in the first place).
//    THIS MODULE ENFORCES THESE TWO DEFAULTS IN CODE — it does not trust
//    Claude's own compliance, same reasoning as every other scope-
//    enforcement function in this codebase (isStandaloneEligible,
//    enforceLtxScopeRules, klingMotion.js's enforceScopeRules): if Claude's
//    plan violates the bookend default, this module force-corrects it
//    before returning, rather than surfacing a bad plan or crashing.
//
// 4. OVERRIDE COST/WARNING (NOT built in this file — frontend/quote-engine
//    work, later pass): once a user overrides ANY frame away from what
//    this module proposed — bookend or not — that's always a real cost
//    (pool frame becomes billable, or a bookend override adds real
//    padding-driven infra cost) and always surfaces a risk warning built
//    from THIS frame's own `reasoning` field, compared against the
//    preset's `safeWhen` criteria. This file's job ends at producing the
//    plan and each frame's reasoning text — the warning UI quotes that
//    reasoning back to the user verbatim when they override.
//
// 5. STRUCTURE DECISION: for any frame with a real vacant/staged pair,
//    Claude also decides whether it's worth the Room Reveal treatment
//    (opener/wipe/continuation) or should just play as a plain generic
//    Kling transformation — not every available pair should default to
//    Room Reveal just because the photos exist.

const https = require("https");

const MODEL = "claude-sonnet-4-6";
// CHANGED (this session — real bug, strongly suspected root cause: a
// 13-photo listing failed after the background function ran a full 80s
// (nowhere near its own 900s ceiling, so this isn't a timeout — the
// failure is inside the Claude call/JSON parsing itself). This was
// flagged as an unconfirmed risk from the very first handoff: MAX_TOKENS
// was never stress-tested against a large listing. 13 frames' worth of
// "one or two sentences" of reasoning each (verbose in every real test
// so far) plausibly exceeded 4096 output tokens, truncating the JSON
// mid-response — extractJsonArray throws cleanly on that (no closing "]"
// found), which is exactly the fail-open path this went down. Raised
// with real headroom rather than a minimal bump, plus the reasoning field
// itself is now tightened (see its schema comment below) so per-frame
// cost scales better as listings approach the real max frame count.
const MAX_TOKENS = 8192;

// ── LOCAL, DUPLICATED PRESET LISTS ──────────────────────────────────────
// CORRECTED (July 21, 2026): an earlier draft of this file did
// `require("./ltxMotion")` and `require("./klingMotion")` to reuse their
// real scope-enforcement functions (isStandaloneEligible,
// enforceLtxScopeRules, enforceScopeRules). That's impossible as written —
// this module has to run as a NETLIFY function (smart-stage-pro repo),
// since it needs to produce a plan BEFORE the quote screen, using only the
// remote Cloudinary URLs the frontend already has — nothing local exists
// at that point. ltxMotion.js/klingMotion.js live in a completely
// different repo and deployment (Railway, smart-stage-pro-plus-render).
// Cross-repo require() isn't just impractical here, it's not possible —
// different filesystems entirely.
//
// This is NOT a gap that needs filling by duplicating that enforcement
// logic here. Railway's renderPipeline.js ALREADY runs isStandaloneEligible/
// enforceLtxScopeRules/enforceScopeRules on every single frame at render
// time, completely independent of whether the preset came from
// auto-selection or a manual user click — that's the existing, proven
// safety net, and it stays the authoritative one. Duplicating full scope
// enforcement into a second repo would only create a second copy that can
// drift out of sync with the real one — exactly the failure mode that
// caused the klingMotion.js/assemble.js mixup earlier this session.
//
// What IS kept here, deliberately minimal: just the preset NAME lists, for
// an early, cheap sanity check (catch an obviously-invalid preset key
// before it round-trips all the way to Railway) — not the actual
// eligibility/scope rules themselves. These are small, low-churn lists;
// if ltxMotion.js's real list changes, this one needs a matching update —
// flagged here explicitly so that's not forgotten.
const VALID_LTX_PRESETS = new Set([
  "cinematic_push", "rack_focus", "luxury_drift", "architectural_glide",
  "corner_to_corner_drift", "floating_camera_drift", "parallax_push",
  "pan_zoom_reveal", "orbit_arc", "crane_up", "crane_down",
  "micro_zoom_out", "micro_dolly_back", "open_plan_reveal",
  "living_room_ambient", "fireplace_flicker", "water_motion", "outdoor_breeze",
]);

// NEW (this session — real bug found via a live frontend crash: "Cannot
// read properties of undefined (reading 'allowedEndMotions')"). The three
// valid Room Reveal identity keys — matches REVEAL_PRESETS' keys exactly
// in build-video-demo.html and assemble.js. Unlike motionPreset/
// klingMotionPreset below, revealPreset was never sanity-checked here at
// all — if Claude's JSON output for revealPreset ever deviated even
// slightly from one of these three exact strings (casing, using the label
// instead of the key, anything), nothing caught it before it reached the
// frontend, where REVEAL_PRESETS[badValue] resolves to undefined and
// renderRevealPresetControls() crashes immediately trying to read
// .allowedEndMotions off it — taking down the ENTIRE motion-assignment
// step with it, since that crash happens mid-way through a single
// frames.map() call whose failure aborts everything after it in the same
// render function (format row, audio dropdowns included). Same failure
// SHAPE as the luxury_parallax bug documented in KEN_BURNS_PRESETS'
// comment in build-video-demo.html — different missing validation, same
// "don't trust the model's compliance" lesson.
const VALID_REVEAL_PRESETS = new Set(["classic_reveal", "luxury_drift", "cinematic_reveal"]);

// NEW (this session — real bug, not a prompt-wording issue: Claude was
// NEVER given a field to choose a Room Reveal's end motion at all. It was
// 100% computed client-side (build-video-demo.html's
// defaultEndMotionForEngine) as "whichever motion is first in the allowed
// list for this preset+engine" — a fixed, deterministic default with zero
// visual judgment involved, which is exactly why it was always push_in
// for classic/cinematic reveal and always drift for luxury_drift,
// regardless of what the STAGED photo actually showed. Mirrors
// build-video-demo.html's REVEAL_PRESETS[key].allowedEndMotions arrays
// EXACTLY — kept in sync manually (two different runtimes, no shared
// import path) rather than computed differently in each place. Used to
// validate Claude's new revealEndMotion pick below.
const REVEAL_PRESET_END_MOTIONS = {
  classic_reveal: [
    "push_in", "pan_left", "pan_right", "tilt_up", "tilt_down", "drift", "float", "luxury_parallax",
    "cinematic_push", "luxury_drift", "floating_camera_drift", "architectural_glide", "corner_to_corner_drift",
    "orbit_arc", "rack_focus", "drone_boom_up", "crane_up", "crane_down", "parallax_push", "pan_zoom_reveal",
    "living_room_ambient", "fireplace_flicker", "water_motion", "outdoor_breeze",
    "micro_zoom_out", "micro_dolly_back", "open_plan_reveal",
  ],
  luxury_drift: [
    "drift", "pan_left", "pan_right", "float", "luxury_parallax",
    "luxury_drift", "floating_camera_drift", "architectural_glide", "corner_to_corner_drift",
    "orbit_arc", "drone_boom_up", "crane_up", "crane_down", "pan_zoom_reveal",
    "living_room_ambient", "fireplace_flicker", "water_motion", "outdoor_breeze",
    "micro_zoom_out", "micro_dolly_back", "open_plan_reveal",
  ],
  cinematic_reveal: [
    "push_in", "pan_left", "pan_right", "tilt_up", "tilt_down", "drift", "float", "luxury_parallax",
    "cinematic_push", "luxury_drift", "floating_camera_drift", "architectural_glide", "corner_to_corner_drift",
    "orbit_arc", "rack_focus", "drone_boom_up", "crane_up", "crane_down", "parallax_push", "pan_zoom_reveal",
    "living_room_ambient", "fireplace_flicker", "water_motion", "outdoor_breeze",
    "micro_zoom_out", "micro_dolly_back", "open_plan_reveal",
  ],
};

// Returns the subset of a reveal preset's allowed end motions that
// actually belong to the requested engine's vocabulary — Ken Burns names
// for "ken_burns", real LTX preset names for "ltx". Computed from
// REVEAL_PRESET_END_MOTIONS + VALID_LTX_PRESETS rather than hand-copied a
// third time, so the two can't drift apart from each other. This is the
// real "8 movements" Sam's referring to, for classic_reveal/
// cinematic_reveal's Ken-Burns-filtered subset specifically.
function endMotionsForEngine(revealPreset, engine) {
  const all = REVEAL_PRESET_END_MOTIONS[revealPreset] || [];
  return all.filter((key) => (engine === "ltx" ? VALID_LTX_PRESETS.has(key) : !VALID_LTX_PRESETS.has(key)));
}

// NEW (this session — Sam's rule, confirmed explicitly): the subscriber's
// plan includes automatic AI Motion for at most this many frames per
// video, REGARDLESS of how many real vacant/staged pairs exist or how
// many the pool could technically still cover. This is a plan-inclusion
// limit, not the same thing as the monthly pool balance (kling_motion_
// usage) — the real cap applied is whichever is SMALLER: this constant,
// or however many pool frames the subscriber actually has left this
// period. Counts EVERY AI-motion-consuming pick uniformly — standalone
// AI Motion (ltx), standalone AI Transformations (kling), and a Room
// Reveal's continuation running under either engine — including the two
// bookend positions, since those draw from the exact same pool/plan
// allotment as any other frame, not a separate budget.
const MAX_AUTO_SELECTED_AI_MOTION_FRAMES = 3;

// Ken Burns presets Claude may select for a "ken_burns" engine frame — the
// user-selectable subset of motionPresets.js's VALID_PRESETS. Excludes
// "luxury_parallax" (Kling-continuation-only, never a standalone pick) and
// "soft_hold"/"restrained_push" (Room Reveal opener-only, set automatically
// by the reveal machinery itself, never chosen directly here).
const KEN_BURNS_SELECTABLE_PRESETS = new Set([
  "push_in", "pull_back", "pan_left", "pan_right",
  "tilt_up", "tilt_down", "drift", "pan_zoom", "float", "static",
]);

// ── SYSTEM PROMPT ──────────────────────────────────────────────────────
// Kept as a template function (not a flat string) because the bookend
// section genuinely depends on narrationEnabled/hasExteriorEnhancement —
// see rule 3 above. Everything else is static.
function buildSystemPrompt({ narrationEnabled, hasExteriorEnhancement, aiMotionCap }) {
  return `You are planning the shot order and camera motion for a real estate walkthrough video. You will see every staged photo for this listing, one at a time, each labeled with a frame ID. Some frames have a real vacant/before photo of the same room available — those will be marked explicitly.

## Your job, per frame
For each photo, identify:
- roomType: a plain category (e.g. "kitchen", "primary_bedroom", "exterior_front", "exterior_backyard").
- roomGroup: a grouping key. Set this IDENTICALLY across every frame you judge to be the SAME physical room (e.g. three angles of one kitchen), and DIFFERENTLY for two rooms that merely share a type (e.g. a primary bedroom in a main house vs. a casita — same roomType, must NOT share roomGroup). Getting this right matters: frames sharing a roomGroup get narrated as one continuous segment, so a wrong merge or wrong split directly breaks the narration script.
- visualAnchor: the single clearest visual feature a camera-motion preset could key off — an island, a fireplace, a chandelier, a hallway sightline, a rug, whatever is genuinely the most prominent thing in this specific photo. Be concrete and specific, not generic.

## Ordering
Produce a natural walkthrough sequence, following this category priority — front exterior first, then the home's strongest lifestyle/hero spaces, then private spaces, then the closing exterior shot:
1. Exterior front (if present).
2. Open Plan / multi-room lifestyle spaces — these lead the interior tour, before any single room.
3. Kitchen, Living Room, Dining Room, and other hero living/lifestyle spaces.
4. Office / Flex / other specialty spaces.
5. Primary Bedroom, then Primary Bathroom.
6. Secondary Bedrooms, then Secondary Bathrooms / Utility.
7. Strongest available exterior/backyard shot, last.
This category order is a hard constraint, same weight as the two below it — categories 2-6 must not interleave (e.g. Office must never land after a bedroom just because a bedroom photo "felt" like it belonged earlier; category 4 always precedes category 5 and 6, full stop). Your judgment applies WITHIN a category only — deciding which specific photo leads when a category has several (e.g. which of two hero living-space shots goes first), never whether a category as a whole jumps the queue. Two further hard constraints:
1. A real vacant/staged pair must stay adjacent to itself.
2. Frames sharing a roomGroup must stay contiguous — never split a room's photos apart with a different room in between.

## Structure and motion, per frame
First decide structure:
- If a frame has a real vacant/before pair: this frame should almost always be Room Reveal, not a plain transformation. This isn't primarily a stylistic choice — the brief unstaged frame plus the "Virtually Staged" wipe satisfies a real digital-alteration disclosure, the video equivalent of the original-adjacent-to-staged requirement California law, NAR, and MLS associations already require for photos. A real pair playing as an undisclosed plain transformation is the outcome to avoid, not the default. Reserve plain "standalone" transformation for a pair ONLY in a genuine edge case — e.g. a near-duplicate angle of a room that already got its own Room Reveal elsewhere in this listing, where a second reveal of the same room would feel redundant. Room Reveal is the default; skipping it is the rare exception, not the other way around.
  - Pick one of "classic_reveal", "luxury_drift", "cinematic_reveal" — and VARY this choice across the different Room Reveal frames in this listing rather than repeating the same one throughout. Judge these as a set that will be watched in sequence, not scored independently; a listing where every reveal uses the same preset reads as repetitive even if each individual pick was defensible on its own.
  - Pick the continuation engine: "ken_burns" (free, deterministic) or "ltx" (real AI Motion, billable — subject to the frame budget below). Most reveals should continue on Ken Burns; reserve the LTX continuation for the handful of frames that most deserve the paid upgrade.
  - Pick revealEndMotion by reading the STAGED (after) photo's own visual content — the SAME anchor-matching judgment you'd use for a standalone pick below, not a generic "whatever this preset defaults to" choice. This matters: leaving it to a fixed per-preset default is the exact bug that made every Classic/Cinematic Reveal end on push_in and every Luxury Drift end on drift regardless of what the room actually looked like — the point of this field is that it varies with the photo.
    - If the continuation engine is "ken_burns": match the STAGED photo's real anchor the same way as a standalone Ken Burns pick — real ceiling/chandelier/fan detail → tilt_up; a hero floor/rug/tilework → tilt_down; a strong lateral sightline (hallway, counter run) → pan_left or pan_right; a corner-to-window or corner-to-patio diagonal → drift; a wide MLS-style shot with no obvious directional feature → float or pan_zoom; a room where stillness reads better than any motion → static; a genuinely high-end/luxury finish → luxury_parallax. Only pick from: ${[...KEN_BURNS_SELECTABLE_PRESETS].join(", ")}, luxury_parallax.
    - If the continuation engine is "ltx": pick a specific LTX preset key whose real-world use case genuinely matches the STAGED photo, same judgment as a standalone LTX pick. Only pick from: ${[...VALID_LTX_PRESETS].join(", ")}.
    - VARY this choice across the different Room Reveal frames in this listing, same reasoning as the reveal preset itself above — judge these as a set watched in sequence, not scored independently.
  - If truly not Room Reveal (the rare edge-case exception above): engine is "kling", klingMotionPreset is null (this resolves to the generic interior or exterior transformation automatically — do not invent a preset name here).
- If no pair at all (a single image with nothing to disclose): decide "ken_burns" or "ltx", picking the specific best-matching motion the same way as always.
  - If "ltx": pick a specific preset key whose real-world use case genuinely matches what you see in THIS photo — do not default everything to the same preset. Only pick from: ${[...VALID_LTX_PRESETS].join(", ")}.
  - If "ken_burns": pick a specific preset key matching the visual anchor — do not default everything to the same generic move. Only pick from: ${[...KEN_BURNS_SELECTABLE_PRESETS].join(", ")}. Match the anchor to the motion: real ceiling/chandelier/fan detail → tilt_up; a hero floor/rug/tilework → tilt_down; a strong lateral sightline (hallway, counter run) → pan_left or pan_right; a corner-to-window or corner-to-patio diagonal → drift; a wide MLS-style shot with no obvious directional feature → float or pan_zoom; a room where stillness reads better than any motion → static.

## Bookend rule — position 1 and the last position
${narrationEnabled
  ? `Narration is ON for this video. Position 1 MUST be Ken Burns (prefer Front Exterior content, pull_back motion, if a front exterior photo exists). The LAST position MUST be Ken Burns Exterior (prefer a backyard/exterior photo). Do not select any AI Motion engine for either of these two positions under any circumstance.`
  : hasExteriorEnhancement
  ? `Narration is OFF for this video, and a real Exterior Enhancement pair (vacant+staged exterior) exists and was selected. Position 1 MUST be Ken Burns (prefer Front Exterior content, pull_back motion). The LAST position should be the Kling exterior transformation using that Exterior Enhancement pair (engine "kling", klingMotionPreset null, plain transformation — not Room Reveal) as the strongest available closer. If for some reason that pair doesn't correspond to the last frame in your chosen order, move it there.`
  : `Narration is OFF for this video, with no Exterior Enhancement pair available. Position 1 MUST be Ken Burns (prefer Front Exterior content, pull_back motion). The LAST position MUST be Ken Burns Exterior (prefer a backyard/exterior photo).`}

## AI Motion frame budget
You may select AI Motion or AI Transformations (including a Room Reveal's continuation running under either engine) for AT MOST ${aiMotionCap} frames total across this entire video — this includes the bookends if either of them lands on AI Motion under the exception rules above, not a separate allotment. This is a hard cap: the subscriber's plan only includes automatic AI Motion for ${aiMotionCap} frames per video, regardless of how many real vacant/staged pairs exist. Choose your ${aiMotionCap} STRONGEST opportunities — the frames where a real pair and a genuinely compelling visual anchor coincide — rather than assigning it to every frame that merely qualifies. Every frame you don't select for AI Motion still needs a real Ken Burns pick; don't leave weaker candidates without a placement, just place them under Ken Burns instead. A downstream system will still enforce this cap even if you exceed it, but a plan that already respects it needs no correction and better reflects your own judgment of which ${aiMotionCap} rooms deserve it most.

## Output
Return ONLY a JSON array, one object per frame, in the exact shape below. No prose before or after, no markdown fences.
[
  {
    "frameId": "...",
    "position": 1,
    "roomType": "...",
    "roomGroup": "...",
    "groupOrder": 0,
    "visualAnchor": "...",
    "structure": "standalone" | "room_reveal",
    "revealPreset": "classic_reveal" | "luxury_drift" | "cinematic_reveal" | null,
    "revealEngine": "ken_burns" | "ltx" | null,
    "revealEndMotion": "<a real Ken Burns or LTX preset key, matching whichever engine revealEngine is>" | null,
    "engine": "ken_burns" | "ltx" | "kling" | null,
    "motionPreset": "<a real LTX preset key>" | null,
    "klingMotionPreset": null,
    "confidence": "high" | "medium-high" | "medium",
    "reasoning": "ONE concise sentence (aim for under 25 words) naming the specific visual feature that makes this choice the right (or safe) one for THIS photo. Long, multi-clause explanations cost real output budget across a full listing — say the one thing that matters, not everything you noticed."
  }
]`;
}

// ── BUILD THE VISION MESSAGE ───────────────────────────────────────────
// Images sent by URL, NOT as local base64 files. CORRECTED (July 21, 2026)
// — an earlier draft matched narrationGen.js's local-file/base64
// convention, which is wrong for THIS module specifically. narrationGen.js
// legitimately runs on Railway, after frames are already downloaded
// locally, because it analyzes rendered clip output. Auto-selection has
// to run at a completely different point: BEFORE the quote screen, in the
// browser/Netlify layer, so the user can see the proposed plan and cost
// before committing to anything — at that point nothing exists locally
// anywhere, only the remote Cloudinary URLs the frontend already has
// (f.realUrl in build-video-demo.html). Confirmed the Anthropic Messages
// API supports `source: {type: "url", url: ...}` directly on the
// standard API (not Bedrock/Vertex, which only take base64 — irrelevant
// here since this project calls api.anthropic.com directly) — no need to
// fetch-then-base64-encode inside the function at all.
// frame.stagedImageUrl / frame.beforeImageUrl are remote URLs, not paths.
function buildUserContent(frames) {
  const content = [];
  content.push({
    type: "text",
    text: `Here are ${frames.length} staged photos for this listing. Frame IDs and pair information follow each image.`,
  });
  for (const frame of frames) {
    content.push({
      type: "image",
      source: { type: "url", url: frame.stagedImageUrl },
    });
    const pairNote = frame.beforeImageUrl
      ? `This frame HAS a real vacant/before pair available.`
      : `This frame has NO before pair — single image only.`;
    content.push({
      type: "text",
      text: `Frame ID: ${frame.frameId}. ${pairNote}${frame.userProvidedRoomLabel ? ` User-provided label: "${frame.userProvidedRoomLabel}".` : ""}`,
    });
  }
  content.push({
    type: "text",
    text: "Now return the JSON array as instructed — order, grouping, structure, and motion for every frame.",
  });
  return content;
}

// ── ROBUST JSON EXTRACTION ──────────────────────────────────────────────
// Same fix as narrationGen.js's July 21 parse bug: never assume the whole
// trimmed response IS the array. A vision call reasoning through "is this
// the same room as frame 3 or a different one?" has even more reason to
// think out loud before answering than the narration script call did —
// don't re-learn that lesson a second time in a second file.
function extractJsonArray(text) {
  const cleaned = text.trim().replace(/^```(json)?/i, "").replace(/```$/, "").trim();
  const start = cleaned.indexOf("[");
  const end = cleaned.lastIndexOf("]");
  if (start === -1 || end === -1 || end < start) {
    throw new Error(`No JSON array found in auto-selection response. Raw: ${cleaned.slice(0, 500)}`);
  }
  return JSON.parse(cleaned.slice(start, end + 1));
}

// ── THE CLAUDE CALL ─────────────────────────────────────────────────────
// Raw https.request to api.anthropic.com — this codebase never uses the
// @anthropic-ai/sdk package anywhere (confirmed against narrationGen.js),
// so this matches that convention rather than introducing a new dependency.
function callClaudeVision(systemPrompt, userContent, anthropicKey) {
  return new Promise((resolve, reject) => {
    const bodyStr = JSON.stringify({
      model: MODEL,
      max_tokens: MAX_TOKENS,
      system: systemPrompt,
      messages: [{ role: "user", content: userContent }],
    });

    const req = https.request({
      hostname: "api.anthropic.com",
      path: "/v1/messages",
      method: "POST",
      headers: {
        "x-api-key": anthropicKey,
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
          if (!text) return reject(new Error(`Auto-selection call returned no text content: ${data.slice(0, 300)}`));
          // NEW (this session) — a 13-photo listing failed with only a
          // generic "no JSON array found" error, leaving real uncertainty
          // about whether it was actually a max_tokens truncation (raised
          // MAX_TOKENS above to fix that) or something else entirely.
          // Checking stop_reason directly removes that ambiguity for any
          // future occurrence — no more guessing from circumstantial
          // evidence (frame count, verbosity) after the fact.
          if (parsed.stop_reason === "max_tokens") {
            console.error(
              `[AUTO-SELECT] Response was cut off at max_tokens (${MAX_TOKENS}) — this WILL fail JSON parsing. If this recurs, MAX_TOKENS needs raising further or the reasoning field needs trimming more aggressively.`
            );
          }
          resolve(text);
        } catch (err) {
          reject(new Error(`Auto-selection response parse error: ${err.message}. Raw: ${data.slice(0, 500)}`));
        }
      });
    });
    req.on("error", reject);
    req.write(bodyStr);
    req.end();
  });
}

async function generateAutoSelection({ frames, narrationEnabled, hasExteriorEnhancement, anthropicKey, poolRemaining }) {
  if (!frames || frames.length === 0) {
    throw new Error("generateAutoSelection: no frames provided");
  }

  // NEW (this session) — effective cap is whichever is SMALLER: the
  // subscriber's plan-inclusion max (MAX_AUTO_SELECTED_AI_MOTION_FRAMES),
  // or however many pool frames they actually have left this period. If
  // poolRemaining wasn't provided (e.g. the balance lookup upstream
  // failed), fail toward the safe/conservative side — the plan max, not
  // unlimited — rather than silently assuming plenty of pool room exists.
  const aiMotionCap = Math.max(0, Math.min(
    MAX_AUTO_SELECTED_AI_MOTION_FRAMES,
    typeof poolRemaining === "number" ? poolRemaining : MAX_AUTO_SELECTED_AI_MOTION_FRAMES
  ));

  const systemPrompt = buildSystemPrompt({ narrationEnabled, hasExteriorEnhancement, aiMotionCap });
  const userContent = buildUserContent(frames);
  const text = await callClaudeVision(systemPrompt, userContent, anthropicKey);
  const plan = extractJsonArray(text);

  if (plan.length !== frames.length) {
    console.error(
      `[AUTO-SELECT MISMATCH] Claude returned ${plan.length} plan entries, expected ${frames.length}. ` +
      `enforceAutoSelectionRules will identify which frames are missing/duplicated by frameId (not array position) and backfill anything omitted with a safe Ken Burns default.`
    );
  }

  const enforced = enforceAutoSelectionRules(plan, frames, { narrationEnabled, hasExteriorEnhancement });
  return enforceAiMotionPoolCap(enforced, aiMotionCap);
}

// ── HARD ENFORCEMENT ────────────────────────────────────────────────────
// Per this file's header: Claude's plan is a proposal, not a trusted
// output. Every rule that has a real cost/compliance implication gets
// checked and force-corrected here — same "don't trust the model's
// compliance" posture as the rest of this codebase (e.g. narrationGen.js's
// silent-skip fix), scoped to what's actually checkable from THIS repo
// (bookend defaults, preset name sanity) — real eligibility/scope
// enforcement (isStandaloneEligible, enforceLtxScopeRules, klingMotion.js's
// enforceScopeRules) lives on Railway and is out of reach here; see the
// VALID_LTX_PRESETS comment above for why that's not duplicated. A
// force-correction here should be loud (console.error), never silent —
// the exact lesson narrationGen.js's silent-skip bug taught.
function enforceAutoSelectionRules(rawPlan, frames, { narrationEnabled, hasExteriorEnhancement }) {
  // FIXED (this session — real bug, confirmed from a live test: reasoning
  // text and room labels were correct for the photo Claude actually
  // analyzed, but attached to a DIFFERENT frame whenever Claude reordered
  // anything, producing exactly what Sam reported — "images don't match
  // the labels"). The old logic here re-keyed entry.frameId to
  // frames[i].frameId — i.e. whichever frame occupied array position i in
  // the ORIGINAL INPUT order — copied from narrationGen.js's July 21 fix.
  // That's correct THERE because narrationGen.js never reorders, only
  // annotates frames in place; array position and original input position
  // are always the same thing in that file. Auto-select's entire purpose
  // is to REORDER frames, so the moment Claude's output array legitimately
  // differs from input order (the normal, desired case, not an edge case),
  // the old logic silently reattached one photo's real analysis to a
  // completely different photo's frameId.
  //
  // Correct fix: trust Claude's own echoed frameId as the identity link —
  // that's literally what it's for, and buildUserContent() explicitly
  // labels each image with it. Validate against the real set of frameIds
  // sent (catches a hallucinated/malformed ID) rather than assuming
  // position encodes identity. Final walkthrough ORDER comes from the
  // plan array's order itself (same as applyAutoSelectionPlan/
  // applyAutoSelectionPlanClient already assume — both iterate the plan
  // array in order and push in that order), not from any position field.
  const validFrameIds = new Set(frames.map((f) => f.frameId));
  const seenFrameIds = new Set();
  const deduped = [];
  for (const entry of rawPlan) {
    if (!validFrameIds.has(entry.frameId)) {
      console.error(
        `[AUTO-SELECT] Dropping plan entry with frameId "${entry.frameId}" — doesn't match any frame actually sent. (This is what the old position-based re-keying was silently papering over, by reattaching this entry's content to a real but WRONG frame instead of dropping it — the actual bug this fix addresses.)`
      );
      continue;
    }
    if (seenFrameIds.has(entry.frameId)) {
      console.error(`[AUTO-SELECT] Dropping duplicate plan entry for frameId "${entry.frameId}" — already seen once in this plan.`);
      continue;
    }
    seenFrameIds.add(entry.frameId);
    deduped.push(entry);
  }

  // Claude omitting a frame entirely is different from a bad/duplicate ID
  // — that frame still needs to be IN the video somewhere. Append with a
  // safe, loud, Ken Burns default rather than silently dropping it.
  for (const f of frames) {
    if (!seenFrameIds.has(f.frameId)) {
      console.error(
        `[AUTO-SELECT] Frame "${f.frameId}" is missing from Claude's plan entirely — appending it at the end with a safe Ken Burns default rather than silently dropping it from the video.`
      );
      deduped.push({
        frameId: f.frameId,
        roomType: f.userProvidedRoomLabel || "unknown",
        roomGroup: f.userProvidedRoomLabel || f.frameId,
        groupOrder: 0,
        visualAnchor: "",
        structure: "standalone",
        revealPreset: null,
        revealEngine: null,
        engine: "ken_burns",
        motionPreset: null,
        klingMotionPreset: null,
        confidence: "low",
        reasoning: "Auto-added — Claude's plan omitted this frame entirely.",
      });
    }
  }

  const plan = deduped.map((entry, i) => ({ ...entry, position: i + 1 }));

  const first = plan[0];
  const last = plan[plan.length - 1];

  // ── BOOKEND RULE 1: position 1 is always Ken Burns, no exceptions ────
  if (first) {
    const violatesBookend1 = first.structure === "room_reveal"
      ? first.revealEngine !== "ken_burns"
      : first.engine !== "ken_burns";
    if (violatesBookend1) {
      console.error(
        `[AUTO-SELECT] Position 1 violated the bookend default (was engine="${first.engine}", revealEngine="${first.revealEngine}") — force-correcting to Ken Burns. This default is never optional; only an explicit user override may change it, and that happens downstream of this module, not here.`
      );
      first.engine = "ken_burns";
      first.motionPreset = null;
      first.klingMotionPreset = null;
      if (first.structure === "room_reveal") { first.revealEngine = "ken_burns"; first.revealEndMotion = null; }
    }
    // NEW (this session — Sam's request: deterministic, consistent
    // wording here, not Claude's own varying paraphrase of the rule).
    // Set every time, whether or not a correction was needed above — the
    // RULE itself is fixed regardless of photo content, so the stated
    // reason for it shouldn't vary either. Claude still owns which
    // SPECIFIC Ken Burns preset was picked (visual-anchor judgment) —
    // this only fixes the wording of WHY the engine itself is Ken Burns.
    first.reasoning = "Bookend rule: the opening shot is always Ken Burns on the front exterior, regardless of visual content — this default is fixed, not a per-photo judgment call.";
  }

  // ── BOOKEND RULE 2: last position, conditional default ───────────────
  if (last) {
    const isKlingExteriorTransformation =
      last.engine === "kling" && !last.klingMotionPreset && last.structure !== "room_reveal";
    const exteriorExceptionApplies = !narrationEnabled && hasExteriorEnhancement;

    if (!exteriorExceptionApplies) {
      // Must be Ken Burns.
      const violatesBookendLast = last.structure === "room_reveal"
        ? last.revealEngine !== "ken_burns"
        : last.engine !== "ken_burns";
      if (violatesBookendLast) {
        console.error(
          `[AUTO-SELECT] Last position violated the bookend default (narrationEnabled=${narrationEnabled}, hasExteriorEnhancement=${hasExteriorEnhancement} — exception does not apply) — force-correcting to Ken Burns Exterior.`
        );
        last.engine = "ken_burns";
        last.motionPreset = null;
        last.klingMotionPreset = null;
        if (last.structure === "room_reveal") { last.revealEngine = "ken_burns"; last.revealEndMotion = null; }
      }
      // NEW (this session) — same deterministic-wording treatment as
      // position 1, set unconditionally regardless of whether a
      // correction was actually needed.
      last.reasoning = "Bookend rule: the closing shot is always Ken Burns, regardless of visual content — this default is fixed, not a per-photo judgment call.";
    } else if (last.engine !== "ken_burns" && !isKlingExteriorTransformation) {
      // Exception applies (narration off + real exterior enhancement pair),
      // but Claude picked neither Ken Burns nor the specific exterior
      // transformation it was told to prefer — correct to the intended
      // free default rather than leave an unexpected engine/preset here.
      console.error(
        `[AUTO-SELECT] Last position: exterior-enhancement exception applies but Claude picked engine="${last.engine}"/preset="${last.motionPreset || last.klingMotionPreset}" instead of the generic Kling exterior transformation — force-correcting.`
      );
      last.engine = "kling";
      last.motionPreset = null;
      last.klingMotionPreset = null;
      last.structure = "standalone";
      last.reasoning = "Narration is off and a real Exterior Enhancement pair is available — using the earned free exterior transformation closer.";
    } else {
      // NEW (this session) — exception applies AND Claude already
      // complied correctly on its own; still set the same clean, fixed
      // wording rather than leaving whatever Claude happened to phrase.
      last.reasoning = "Narration is off and a real Exterior Enhancement pair is available — using the earned free exterior transformation closer.";
    }
  }

  // ── ROOM-GROUP CONSISTENCY for before/after pairs ────────────────────
  // A pair is one physical room shown twice — if Claude somehow gave the
  // paired frame's own before/after halves different roomGroup values
  // (shouldn't happen given they're presented as one frame, but this is a
  // Claude output, not a guarantee), that's a data-integrity problem for
  // narration grouping. Not expected to fire often; logged loudly if it does.
  // (Left as a detection/log point rather than a silent merge — a
  // structural mismatch here is significant enough to want a human to see it.)

  // ── LIGHTWEIGHT SANITY CHECKS ONLY ────────────────────────────────────
  // Deliberately NOT re-running the real scope rules here (isStandaloneEligible's
  // confidence floor, enforceLtxScopeRules' exterior/open-plan gates,
  // klingMotion.js's known-pair-or-exterior requirement) — see this file's
  // header comment on VALID_LTX_PRESETS for why: those live in a different
  // repo/deployment (Railway) that this Netlify-side module can't reach,
  // and duplicating them here would just create a second copy that can
  // drift out of sync with the real one. Railway's renderPipeline.js
  // already runs that exact enforcement on every single frame at render
  // time, regardless of whether the pick came from auto-selection or a
  // manual click, and already degrades gracefully to Ken Burns when a
  // pick fails (see renderPipeline.js's "Rejected standalone use of..."
  // fallback) — that's the real, authoritative safety net, unchanged by
  // this feature. All this loop does is catch an obviously-misspelled or
  // hallucinated preset NAME early and cheaply, before it round-trips all
  // the way to a render job.
  for (const entry of plan) {
    if (entry.engine === "ken_burns" && entry.motionPreset && !KEN_BURNS_SELECTABLE_PRESETS.has(entry.motionPreset)) {
      console.error(
        `[AUTO-SELECT] Frame ${entry.frameId}: Ken Burns pick "${entry.motionPreset}" isn't a real preset name — clearing to let the render pipeline default to "auto".`
      );
      entry.motionPreset = null;
    }
    if (entry.engine === "ltx" && entry.motionPreset && !VALID_LTX_PRESETS.has(entry.motionPreset)) {
      console.error(
        `[AUTO-SELECT] Frame ${entry.frameId}: LTX pick "${entry.motionPreset}" isn't a real preset name — degrading to Ken Burns "auto". (Real eligibility/scope rules — confidence floor, exterior/open-plan gates — are enforced authoritatively on Railway at render time, not here.)`
      );
      entry.engine = "ken_burns";
      entry.motionPreset = null;
    }
    // NEW (this session — see VALID_REVEAL_PRESETS' header comment for the
    // real crash this prevents). Only checked when structure is actually
    // room_reveal — a standalone frame's revealPreset field is expected to
    // be null/absent and shouldn't trigger a false-positive correction.
    if (entry.structure === "room_reveal" && entry.revealPreset && !VALID_REVEAL_PRESETS.has(entry.revealPreset)) {
      console.error(
        `[AUTO-SELECT] Frame ${entry.frameId}: reveal pick "${entry.revealPreset}" isn't a real preset name — force-correcting to "classic_reveal" rather than letting it reach the frontend, where an unresolvable key crashes the entire motion-assignment step (confirmed: REVEAL_PRESETS[badValue] is undefined, and renderRevealPresetControls() reads .allowedEndMotions off it unguarded).`
      );
      entry.revealPreset = "classic_reveal";
    }
    // NEW (this session — Sam's report: reveal end motions were always
    // push_in/drift regardless of the photo, root cause being that
    // Claude was never given this field to begin with. Now that it is,
    // validate it the same defensive way as every other preset field —
    // if Claude's pick doesn't actually belong to this preset+engine
    // combo's allowed set, clear it to null rather than let a bad value
    // reach the frontend. A null here isn't a failure state: build-video-
    // demo.html's defaultEndMotionForEngine already provides a safe
    // (if generic) fallback for exactly this case.
    if (entry.structure === "room_reveal" && entry.revealEndMotion) {
      const allowed = endMotionsForEngine(entry.revealPreset, entry.revealEngine);
      if (!allowed.includes(entry.revealEndMotion)) {
        console.error(
          `[AUTO-SELECT] Frame ${entry.frameId}: reveal end motion "${entry.revealEndMotion}" isn't valid for ${entry.revealPreset}/${entry.revealEngine} — clearing to let the frontend's generic default apply instead.`
        );
        entry.revealEndMotion = null;
      }
    }
  }

  return plan;
}

// ── AI MOTION POOL CAP ────────────────────────────────────────────────
// Hard-enforces MAX_AUTO_SELECTED_AI_MOTION_FRAMES (or the real, smaller
// pool balance) regardless of what the prompt asked for — same "don't
// trust the model's compliance" posture as every other rule in this file.
// Downgrades the LOWEST-confidence AI-motion picks first, preserving a
// Room Reveal's identity/preset when downgrading it (just switches its
// continuation engine to Ken Burns — the reveal story survives, only the
// paid engine choice changes), and touches the two bookend positions
// last, since an AI-motion bookend only exists via a deliberate, rare
// exception (see BOOKEND RULE 2) and shouldn't be sacrificed before every
// ordinary interior pick has already been tried.
const CONFIDENCE_RANK = { "high": 3, "medium-high": 2, "medium": 1, "low": 0 };

function usesAiMotion(entry) {
  if (entry.structure === "room_reveal") return entry.revealEngine === "ltx";
  return entry.engine === "kling" || entry.engine === "ltx";
}

function downgradeToKenBurns(entry) {
  if (entry.structure === "room_reveal") {
    entry.revealEngine = "ken_burns";
    entry.revealEndMotion = null;
  } else {
    entry.engine = "ken_burns";
    entry.klingMotionPreset = null;
  }
  entry.motionPreset = null;
  entry.reasoning = (entry.reasoning ? entry.reasoning + " " : "") +
    `(Downgraded to Ken Burns — the plan only includes automatic AI Motion for ${MAX_AUTO_SELECTED_AI_MOTION_FRAMES} frames per video, and this was not among the strongest picks once the pool balance was applied.)`;
}

function enforceAiMotionPoolCap(plan, cap) {
  const aiMotionEntries = plan.filter(usesAiMotion);
  if (aiMotionEntries.length <= cap) return plan; // already within budget, nothing to do

  console.error(
    `[AUTO-SELECT] Plan selected ${aiMotionEntries.length} AI Motion frames, over the cap of ${cap} — downgrading the lowest-confidence excess picks to Ken Burns.`
  );

  const isBookend = (entry) => entry === plan[0] || entry === plan[plan.length - 1];
  const interior = aiMotionEntries.filter((e) => !isBookend(e));
  const bookends = aiMotionEntries.filter(isBookend);

  // Lowest confidence first within each group — interior picks are all
  // fair game equally, sorted purely by how sure Claude was; bookends are
  // a last resort, only touched if downgrading every interior pick still
  // isn't enough (only possible when the pool balance itself is under 1).
  const byConfidenceAscending = (a, b) => (CONFIDENCE_RANK[a.confidence] ?? 1) - (CONFIDENCE_RANK[b.confidence] ?? 1);
  interior.sort(byConfidenceAscending);
  bookends.sort(byConfidenceAscending);

  let excess = aiMotionEntries.length - cap;
  for (const entry of [...interior, ...bookends]) {
    if (excess <= 0) break;
    downgradeToKenBurns(entry);
    excess--;
  }

  return plan;
}


// Maps a plan (from generateAutoSelection, or a user-edited version of one)
// onto the EXACT frame fields renderPipeline.js's existing per-frame
// dispatch already reads — useAiMotion, useRevealEffect, isBeforeAfter,
// beforeLocalPath, revealPreset, revealEngine, klingMotionPreset,
// ltxMotionPreset, motionPreset, roomLabel. Deliberately does NOT change
// renderPipeline.js's dispatch logic itself (the if/else chain on
// frame.useAiMotion / frame.useRevealEffect / frame.ltxMotionPreset stays
// exactly as-is) — this function's whole job is populating those same
// fields correctly ahead of time, whether they came from auto-selection or
// from a user's manual override of specific frames.
//
// IMPORTANT: this also REORDERS the frames array into the plan's position
// order. Order is part of what auto-selection decides (adjacency/grouping
// constraints), so the plan's order must become the real frame order, not
// just an annotation layered on top of whatever order frames arrived in.
//
// roomLabel mapping: plan.roomGroup becomes frame.roomLabel directly — that
// field is narrationGen.js's actual grouping key (groupContiguousByRoom
// merges strictly on `prior.roomLabel === roomLabel`), not just a display
// name. Auto-selection's guarantee that same-roomGroup frames are placed
// CONTIGUOUSLY is what makes this actually merge correctly downstream —
// identical labels alone are not sufficient if the frames aren't adjacent.
function applyAutoSelectionPlan(localFrames, plan) {
  const frameById = new Map(localFrames.map((f) => [f.frameId, f]));

  const ordered = plan.map((entry) => {
    const frame = frameById.get(entry.frameId);
    if (!frame) {
      throw new Error(`applyAutoSelectionPlan: plan entry references unknown frameId "${entry.frameId}"`);
    }

    const updated = { ...frame, roomLabel: entry.roomGroup, groupOrder: entry.groupOrder ?? 0 };

    if (entry.structure === "room_reveal") {
      updated.useRevealEffect = true;
      updated.isBeforeAfter = true;
      updated.useAiMotion = false;
      updated.ltxMotionPreset = undefined;
      updated.klingMotionPreset = undefined;
      updated.revealPreset = entry.revealPreset || "classic_reveal";
      updated.revealEngine = entry.revealEngine === "ltx" ? "ltx" : "ken_burns";
      // frame.endMotion intentionally left as whatever it already was (or
      // unset) — renderPipeline.js's existing clamp/fallback
      // (preset.allowedEndMotions.includes(...) → "push_in" fallback)
      // already handles this; auto-selection doesn't pick a specific end
      // motion within a reveal preset, only the continuation ENGINE.
    } else {
      updated.useRevealEffect = false;
      if (entry.engine === "kling") {
        updated.useAiMotion = true;
        updated.ltxMotionPreset = undefined;
        updated.klingMotionPreset = entry.klingMotionPreset || undefined; // undefined = generic known-pair fallback (Hero/Exterior Transformation)
      } else if (entry.engine === "ltx") {
        updated.useAiMotion = false;
        updated.klingMotionPreset = undefined;
        updated.ltxMotionPreset = entry.motionPreset || undefined;
      } else {
        // ken_burns
        updated.useAiMotion = false;
        updated.ltxMotionPreset = undefined;
        updated.klingMotionPreset = undefined;
        updated.motionPreset = entry.motionPreset || "auto";
      }
    }

    return updated;
  });

  return ordered;
}

module.exports = {
  generateAutoSelection,
  enforceAutoSelectionRules,
  enforceAiMotionPoolCap,
  buildSystemPrompt,
  applyAutoSelectionPlan,
};
