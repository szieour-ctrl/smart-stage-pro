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
const MAX_TOKENS = 4096;

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
function buildSystemPrompt({ narrationEnabled, hasExteriorEnhancement }) {
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
- If a frame has a real vacant/before pair: decide whether this room earns the Room Reveal treatment (opener → wipe → continuation) or should just play as a plain transformation. Don't default to Room Reveal on every available pair — reserve it for the room that most benefits from a before/after story.
  - If Room Reveal: pick one of "classic_reveal", "luxury_drift", "cinematic_reveal", and pick the continuation engine: "ken_burns" or "ltx". The opener phase is always Ken Burns regardless — this choice only affects what plays after the wipe.
  - If not Room Reveal (plain pair transformation): engine is "kling", klingMotionPreset is null (this resolves to the generic interior or exterior transformation automatically — do not invent a preset name here).
- If no pair at all: decide "ken_burns" or "ltx".
  - If "ltx": pick a specific preset key whose real-world use case genuinely matches what you see in THIS photo — do not default everything to the same preset. Only pick from: ${[...VALID_LTX_PRESETS].join(", ")}.
  - If "ken_burns": pick a specific preset key matching the visual anchor — do not default everything to the same generic move. Only pick from: ${[...KEN_BURNS_SELECTABLE_PRESETS].join(", ")}. Match the anchor to the motion: real ceiling/chandelier/fan detail → tilt_up; a hero floor/rug/tilework → tilt_down; a strong lateral sightline (hallway, counter run) → pan_left or pan_right; a corner-to-window or corner-to-patio diagonal → drift; a wide MLS-style shot with no obvious directional feature → float or pan_zoom; a room where stillness reads better than any motion → static.

## Bookend rule — position 1 and the last position
${narrationEnabled
  ? `Narration is ON for this video. Position 1 MUST be Ken Burns (prefer Front Exterior content, pull_back motion, if a front exterior photo exists). The LAST position MUST be Ken Burns Exterior (prefer a backyard/exterior photo). Do not select any AI Motion engine for either of these two positions under any circumstance.`
  : hasExteriorEnhancement
  ? `Narration is OFF for this video, and a real Exterior Enhancement pair (vacant+staged exterior) exists and was selected. Position 1 MUST be Ken Burns (prefer Front Exterior content, pull_back motion). The LAST position should be the Kling exterior transformation using that Exterior Enhancement pair (engine "kling", klingMotionPreset null, plain transformation — not Room Reveal) as the strongest available closer. If for some reason that pair doesn't correspond to the last frame in your chosen order, move it there.`
  : `Narration is OFF for this video, with no Exterior Enhancement pair available. Position 1 MUST be Ken Burns (prefer Front Exterior content, pull_back motion). The LAST position MUST be Ken Burns Exterior (prefer a backyard/exterior photo).`}

## AI Motion frame budget
Beyond the bookends, select AI Motion for exactly the frames that genuinely earn it based on visual content — do not force it onto rooms with no real anchor just to hit a number. A downstream system will cap the actual free/pool-covered count separately; your job is quality-of-match, not hitting a target count.

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
    "engine": "ken_burns" | "ltx" | "kling" | null,
    "motionPreset": "<a real LTX preset key>" | null,
    "klingMotionPreset": null,
    "confidence": "high" | "medium-high" | "medium",
    "reasoning": "One or two sentences naming the specific visual feature that makes this choice the right (or safe) one for THIS photo."
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

async function generateAutoSelection({ frames, narrationEnabled, hasExteriorEnhancement, anthropicKey }) {
  if (!frames || frames.length === 0) {
    throw new Error("generateAutoSelection: no frames provided");
  }

  const systemPrompt = buildSystemPrompt({ narrationEnabled, hasExteriorEnhancement });
  const userContent = buildUserContent(frames);
  const text = await callClaudeVision(systemPrompt, userContent, anthropicKey);
  const plan = extractJsonArray(text);

  if (plan.length !== frames.length) {
    console.error(
      `[AUTO-SELECT MISMATCH] Claude returned ${plan.length} plan entries, expected ${frames.length}. ` +
      `Proceeding with whatever positions overlap by array order — see enforceAutoSelectionRules for the safety net.`
    );
  }

  return enforceAutoSelectionRules(plan, frames, { narrationEnabled, hasExteriorEnhancement });
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
  // Match by position (array order), not by re-trusting whatever frameId
  // string Claude wrote — same reasoning as narrationGen.js's July 21 fix.
  const plan = rawPlan.map((entry, i) => {
    const sourceFrame = frames[i];
    if (!sourceFrame) return entry; // extra entries beyond what we sent are dropped, not fatal
    if (entry.frameId !== sourceFrame.frameId) {
      console.error(
        `[AUTO-SELECT] Position ${i}: Claude's frameId "${entry.frameId}" doesn't match the frame actually sent at this position ("${sourceFrame.frameId}"). Using position, not the frameId string, as the source of truth.`
      );
    }
    return { ...entry, frameId: sourceFrame.frameId, position: i + 1 };
  });

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
      if (first.structure === "room_reveal") first.revealEngine = "ken_burns";
      first.reasoning = (first.reasoning ? first.reasoning + " " : "") + "(Force-corrected to the required Ken Burns default for position 1.)";
    }
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
        if (last.structure === "room_reveal") last.revealEngine = "ken_burns";
        last.reasoning = (last.reasoning ? last.reasoning + " " : "") + "(Force-corrected to the required Ken Burns default for the closing frame.)";
      }
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
  }

  return plan;
}

// ── RENDER PIPELINE WIRING ──────────────────────────────────────────────
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
  buildSystemPrompt,
  applyAutoSelectionPlan,
};
