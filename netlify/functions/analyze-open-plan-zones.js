// analyze-open-plan-zones.js — Vision-based Open Plan zone/anchor reader.
//
// Produces the exact "Simple Anchor" text validated by hand this session
// (Test_3, 2089 Thornecroft, 206 Granite Park, CLEAN_sample, CLEAN_sample7,
// CLEAN_sample6 — 6/6 correct zone identification against real photos) —
// for direct substitution into spatial-zone-template.js's
// {{room_assignment_variables}} slot.
//
// SCOPE, per this session's finding: Vision's job is ONLY zone + anchor
// identification. It does NOT reason about circulation, cropping, or
// furniture placement -- CIRCULATION-ZONE FRAME BEHAVIOR in
// spatial-zone-template.js already owns that, and GPT Image 2 handles it
// correctly on its own once a zone is flagged as having no fixture/wall
// anchor. Vision writing circulation logic was tried and explicitly
// rejected this session ("That is NOT YOUR JOB, that is the render's").
//
// Zone set (per the actual Open Plan zone-selection UI, four categories
// only): Kitchen, Dining Zone, Living Room, Flex Room (user-typed subtype --
// office, formal dining room, media room, etc.). "Family Room" and "Formal
// Dining Room" are NOT their own hardcoded zone names -- they are Flex Room
// instances, distinguished by a typically-present open entrance / pony wall
// / half-wall pass-through, and by whatever fixture (most commonly a
// chandelier) suggests their specific type.
//
// Anchor taxonomy (three types, matching every example validated this
// session):
//   1. FIXTURE  -- chandelier, pendant cluster, or fireplace. Locks the zone
//      directly under/at that fixture, regardless of where the camera is
//      standing.
//   2. WALL     -- TWO OR MORE connected walls forming a corner (with or
//      without windows). This is a structural fact about the room, not
//      about camera position -- a true two-connected-wall corner is NEVER
//      described as foreground, even when that corner also happens to be
//      nearest the camera. Living Room / Flex Room are always WALL-anchored
//      when this two-wall corner is present.
//   3. FOREGROUND -- NOT a fallback category. Every open-plan photo has a
//      foreground, full stop: interiors are typically shot ~4-5ft off the
//      ground, so the camera is always standing inside SOME zone's nearest
//      0-4ft. Determining which zone that is comes FIRST, before any
//      per-zone classification -- see REASONING ORDER in the prompt below.
//      A foreground zone can stand alone (no fixture, no wall -- most
//      commonly Dining Zone, "the floater," per this session's finding)
//      OR combine with a SINGLE wall not already claimed by another zone
//      (e.g. Living Room anchored to foreground + one window wall -- see
//      sample7). Two connected walls forming a corner is always WALL type
//      instead, even for the foreground zone.
//
// Kitchen is intentionally excluded from the Vision read: cabinetry/island
// self-identifies the Kitchen zone architecturally, and every test this
// session confirmed Vision doesn't need to be asked about it.
//
// Kitchen is intentionally excluded from the Vision read: cabinetry/island
// self-identifies the Kitchen zone architecturally, and every test this
// session confirmed Vision doesn't need to be asked about it.
//
// Output shape is deliberately the plain text line that gets inserted at
// {{room_assignment_variables}} -- not structured JSON that a second step
// has to reformat. One Vision call, one string, ready to substitute.

const https = require("https");

// Closed set, matching the app's Single Room list minus "Great Room" (Great
// Room isn't a valid Flex Room subtype -- it's effectively what Living Room
// already covers in an open-plan context). This is the ONLY list Vision may
// select flexRoomType from. Free text was tried and explicitly rejected --
// "user types in a room... blows our controlled naming and potential
// duplication of rooms" -- so this is now a closed enum, not a suggestion.
const FLEX_ROOM_TYPES = [
  "Office", "Formal Dining Room", "Media Room", "Play Room",
  "Music Room", "Den", "Study Room", "Gym", "Reading Nook",
];

function httpsRequest(options, body) {
  return new Promise((resolve, reject) => {
    const req = https.request(options, (res) => {
      const chunks = [];
      res.on("data", (c) => chunks.push(c));
      res.on("end", () => {
        const raw = Buffer.concat(chunks).toString("utf8");
        try { resolve({ status: res.statusCode, body: JSON.parse(raw) }); }
        catch (e) { resolve({ status: res.statusCode, body: { raw } }); }
      });
    });
    req.on("error", reject);
    if (body) req.write(body);
    req.end();
  });
}

const OPEN_PLAN_ZONE_PROMPT = `You are identifying furnishing zones and their anchors in an open-plan real estate interior photo. This is a classification task, not a design task -- you are not deciding how furniture should be arranged, only where each zone belongs and what anchors it.

Return ONLY valid JSON, no markdown, no explanation.

TASK
Open Plan photos have at most four possible zones: Kitchen, Dining Zone, Living Room, and Flex Room. Identify which are genuinely present and visible -- do not force a zone that isn't there. Skip Kitchen entirely; it is handled separately and should never appear in your output.

Flex Room covers any additional walled zone that isn't Living Room or Dining Zone. A Flex Room typically (not always) has an open entrance, a third pony wall, or a half-wall pass-through, distinguishing it from Living Room's more fully-open connection to the rest of the space. If a Flex Room is present, select its type from this exact list ONLY: Office, Formal Dining Room, Media Room, Play Room, Music Room, Den, Study Room, Gym, Reading Nook. Never write a type outside this list, and never invent your own phrasing for one that's close but not exact (e.g. do not write "Home Office" -- select "Office"). If none of these fit confidently, leave flexRoomType as an empty string -- the user selects it themselves from a dropdown built from this same list, so guessing wrong is worse than leaving it blank. A chandelier in an enclosed/semi-enclosed Flex Room is a strong signal for "Formal Dining Room."

FIRST, BEFORE CLASSIFYING ANYTHING: determine which zone occupies the foreground of the frame.
Every open-plan photo has a foreground, full stop -- real estate interiors are typically shot from about 4-5 feet off the ground, meaning the camera itself is standing inside whichever zone occupies the frame's nearest 0-4 feet. This is not a special case that sometimes applies -- some zone in this photo occupies the foreground, always, and identifying which one is your first task, before you classify any zone's anchor type. Hold that answer in mind; it directly resolves ambiguity in the steps below.

For each zone you identify, classify its anchor as exactly ONE of these three types:

1. FIXTURE -- a chandelier, pendant light cluster, or fireplace visible in the photo that this zone is built around. State which fixture and, briefly, where it sits in the frame (e.g. "left of the island, over open floor" or "wall, mid-frame").
   - A chandelier or pendant cluster over open floor (not over a kitchen island/counter) anchors a Dining Zone.
   - A fireplace anchors a Living Room or Flex Room.

2. WALL -- TWO OR MORE connected walls forming a corner (state which -- e.g. "fireplace wall and the connected wall with windows", or "wall with two windows near the entry and the connected wall to the right"). This is a structural fact about the room's architecture, not about where the camera is standing -- a true two-connected-wall corner is ALWAYS this type, even if that corner also happens to be nearest the camera (i.e. even if it's also the foreground zone). Living Room and Flex Room are WALL-anchored whenever this two-wall corner is present, regardless of fixture or camera position.

3. FOREGROUND -- used for whichever zone you determined, in your first step above, occupies the frame's foreground. This is not a fallback for zones with nothing else -- it is simply naming the zone the camera is standing in. A foreground zone can stand alone with no wall at all (state only "foreground of the frame" plus brief adjacency if helpful, e.g. "close to the kitchen"), OR it can combine with a SINGLE wall that no other zone has already claimed (e.g. "foreground of the frame, and the wall on the right with a window"). The dividing line versus WALL: ONE wall can appear together with foreground; TWO connected walls forming a corner never can -- that is always WALL type on its own, no foreground language, even for the foreground zone.

REASONING ORDER -- follow this in sequence, do not guess at each zone independently:
Step 1: Determine which zone occupies the foreground (see above). Hold this answer.
Step 2: Identify every FIXTURE-anchored zone (a chandelier or pendant cluster over open floor, separate from any kitchen island lighting, anchors Dining Zone; a fireplace anchors Living Room or Flex Room).
Step 3: Kitchen is excluded entirely from your output -- do not analyze it.
Step 4: Identify any remaining WALL-anchored zone (two connected walls, not already accounted for by a fixture in Step 2).
Step 5: Whatever zone from Step 1 (the foreground zone) has not already been fully accounted for by Steps 2 or 4 gets FOREGROUND as part of its anchor, plus any single unclaimed wall present in that same area. In practice, this step is what resolves Dining Zone most reliably: it is the zone most likely to have no fixture and no wall pair of its own, and confirming it occupies the foreground (Step 1) is what identifies it correctly rather than guessing.

RULES
- Do not reason about circulation, walkways, traffic patterns, or whether a zone "should" be cropped. That is not your task -- only identify the zone and its anchor type.
- Do not invent an anchor by describing a zone's position relative to another zone (e.g. never say "between the kitchen and living room" -- that is not a real anchor, it depends on correctly reading two other zones first and breaks if either is wrong). Every zone's anchor must be independently identifiable: a fixture, a two-connected-wall corner, or camera position (optionally plus one unclaimed wall).
- A kitchen island's task lighting (small pendants directly over the island/counter) is NOT a Dining Zone anchor -- only a fixture over OPEN FLOOR, separate from the island, counts.
- If a chandelier is visible, it always anchors Dining Zone, even if it is not centered in the frame.
- Wall descriptions should name what's on the wall if relevant (windows, fireplace) but should stay brief -- one clause, not a paragraph.

OUTPUT SHAPE
Return this exact JSON shape:
{
  "zones": [
    {"zone": "Dining Zone", "anchorType": "FIXTURE", "anchorText": "chandelier, left of the island, over open floor"},
    {"zone": "Living Room", "anchorType": "WALL", "anchorText": "fireplace wall, and the connected wall with windows"},
    {"zone": "Flex Room", "flexRoomType": "Formal Dining Room", "anchorType": "FIXTURE", "anchorText": "chandelier, mid-frame"}
  ]
}

zone must be exactly one of "Dining Zone", "Living Room", "Flex Room" (never Kitchen). flexRoomType is only used when zone is "Flex Room" -- it must be exactly one of: Office, Formal Dining Room, Media Room, Play Room, Music Room, Den, Study Room, Gym, Reading Nook, or an empty string if none fit confidently. No other value is valid. anchorType must be exactly "FIXTURE", "WALL", or "FOREGROUND". anchorText should read naturally as a short phrase, matching the style of the examples above -- no full sentences, no restating the zone name.`;

async function analyzeOpenPlanZones(base64, mimeType, claudeKey, opts = {}) {
  // Swapped default from claude-haiku-4-5-20251001 -> claude-sonnet-5 (Aug 21
  // rewire): sample9.jpg's fireplace anchor was skipped entirely at the
  // detection stage on Haiku, under both the old prompt and the new
  // Foreground/Contradiction rewrite -- the same anchor was correctly
  // resolved by hand under Sonnet. Isolated swap, no other change in this
  // edit, so any behavior shift is attributable to the model alone (same
  // discipline as the gpt-image-1 -> gpt-image-2 swap in stage-image.js).
  // opts.model still overrides if passed by the caller, unchanged.
  const model = opts.model || "claude-sonnet-5";

  const payload = JSON.stringify({
    model,
    max_tokens: 1024,
    messages: [{
      role: "user",
      content: [
        {
          type: "image",
          source: { type: "base64", media_type: mimeType || "image/jpeg", data: base64 }
        },
        { type: "text", text: OPEN_PLAN_ZONE_PROMPT }
      ]
    }]
  });

  const result = await httpsRequest({
    hostname: "api.anthropic.com",
    path: "/v1/messages",
    method: "POST",
    headers: {
      "x-api-key": claudeKey,
      "anthropic-version": "2023-06-01",
      "content-type": "application/json",
      "content-length": Buffer.byteLength(payload)
    }
  }, payload);

  if (result.status !== 200) {
    throw new Error("Claude error: " + JSON.stringify(result.body).slice(0, 300));
  }

  const text = result.body?.content?.[0]?.text || "{}";
  const clean = text.replace(/```json|```/g, "").trim();
  const parsed = JSON.parse(clean);

  return {
    raw: parsed,
    // The actual string to substitute into {{room_assignment_variables}} --
    // this is the deliverable, everything else is intermediate.
    roomAssignmentText: buildRoomAssignmentText(parsed.zones || []),
  };
}

// Converts the structured Vision output into the exact plain-text format
// validated by hand this session -- e.g.:
//
//   Kitchen: Anchor: island.
//   Living Room: Anchor: fireplace wall, and the connected wall with windows. Size the furnishings with circulation appropriate to the available space.
//   Dining Zone: Anchor: chandelier, left of the island, over open floor.
//
// Kitchen line is always injected here (not by Vision -- see prompt notes).
function buildRoomAssignmentText(zones) {
  const lines = ["Kitchen: Anchor: island."];

  for (const z of zones) {
    if (!z || !z.zone || !z.anchorType) continue;
    // Defensive: even though the prompt states this as a closed enum,
    // models can drift. Never let an out-of-list value reach the template --
    // that's exactly the uncontrolled-naming/duplication problem this
    // whole enum was built to prevent. Silently fall back to the generic
    // "Flex Room" label (matching what the UI shows before the user picks
    // from the dropdown) rather than passing an unrecognized string through.
    const rawType = z.zone === "Flex Room" ? (z.flexRoomType || "").trim() : "";
    const validType = FLEX_ROOM_TYPES.includes(rawType) ? rawType : "";
    const displayName = validType || z.zone;
    let line = `${displayName}: Anchor: ${z.anchorText || "(unspecified)"}.`;
    if (z.anchorType === "WALL") {
      line += " Size the furnishings with circulation appropriate to the available space.";
    }
    lines.push(line);
  }

  return lines.join("\n");
}

// ── Netlify handler ──────────────────────────────────────────────────────
// Called once per Open Plan photo, BEFORE stage-vacant-prompt.js. Returns
// roomAssignmentText, which index.html passes straight through as the
// roomAssignmentText override on the stage-vacant-prompt.js request --
// see buildRoomAssignmentVariable() in spatial-zone-template.js, which
// uses this verbatim instead of auto-building a plain zone-label list.
//
// CACHING NOTE (not implemented here -- this handler is stateless, same
// as analyzeFloorplan in stage-image.js): the caller should cache this
// result per photoId once computed, the same way zoneList is already
// cached in SESSION.photoRoomMap. Anchors should stay stable across
// Iterate/Enhance-with-AI passes on the same photo -- re-running Vision on
// every stage call risks the read drifting between iterations of what
// should be the same room.
async function handler(event) {
  if (event.httpMethod !== "POST") return { statusCode: 405, body: "Method Not Allowed" };

  const headers = {
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Headers": "Content-Type",
    "Content-Type": "application/json",
  };

  try {
    const claudeKey = process.env.ANTHROPIC_API_KEY;
    if (!claudeKey) return { statusCode: 500, headers, body: JSON.stringify({ error: "ANTHROPIC_API_KEY not configured" }) };

    const { imageBase64, mimeType, model } = JSON.parse(event.body);
    if (!imageBase64) return { statusCode: 400, headers, body: JSON.stringify({ error: "Missing imageBase64" }) };

    const result = await analyzeOpenPlanZones(imageBase64, mimeType, claudeKey, { model });

    console.log(
      "analyze-open-plan-zones: " + (result.raw?.zones?.length || 0) + " zone(s) identified -- " +
      (result.raw?.zones || []).map(z => z.zone + "/" + z.anchorType).join(", ")
    );

    return { statusCode: 200, headers, body: JSON.stringify(result) };

  } catch (err) {
    console.error("analyze-open-plan-zones error:", err.message);
    return { statusCode: 500, headers, body: JSON.stringify({ error: err.message, details: err.stack }) };
  }
}

// Single combined export, at the very end of the file, after everything it
// references is defined. This is deliberate: module.exports = {...} was
// previously set earlier in the file, THEN exports.handler = ... was
// assigned after it -- module.exports = {...} reassigns exports.exports to
// a brand-new object, decoupling it from the original `exports` reference,
// so the later exports.handler = ... assignment was silently attaching to
// an orphaned object nothing ever reads. Netlify's loader does
// require(...).handler and found nothing, causing
// "analyze-open-plan-zones.handler is undefined or not exported" in
// production. Fix: one export statement, one object, handler included in
// it directly -- no possibility of a second assignment shadowing the first.
module.exports = { analyzeOpenPlanZones, buildRoomAssignmentText, OPEN_PLAN_ZONE_PROMPT, FLEX_ROOM_TYPES, handler };
