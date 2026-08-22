// analyze-open-plan-zones.js — Vision-based Open Plan fixture-anchor reader.
//
// REBUILT Aug 21 -- replaces the reasoning-order/taxonomy version. Root cause
// of that version's failures, confirmed this session on two different
// models: Haiku filled zones with no real anchor via adjacency guessing
// ("next to the kitchen" = Living Room); Sonnet went the opposite way and
// returned 0 zones on photos with an unmissable fireplace and chandelier,
// most likely because the REASONING ORDER chain gated everything behind
// resolving camera-position/foreground FIRST -- the one genuinely ambiguous
// part of this task -- before it would commit to anything, including the
// easy, unambiguous fixture reads.
//
// FIX: split the task across the two things actually good at each half.
//   - VISION'S JOB, NOW: pure fixture inventory. Report only physically
//     present fixtures it can actually see -- fireplace, ceiling fan,
//     chandelier/pendant over open floor. No zone-list awareness, no
//     foreground/camera-position reasoning, no sequencing, no confidence
//     hedging beyond "don't report a fixture that isn't there." Nothing
//     asks it to resolve ambiguity, so nothing gives it a reason to bail
//     out the way the old prompt's "leave blank if not confident" clause
//     did.
//   - CODE'S JOB, NEW: elimination math (mergeRoomAssignment, below). Cross-
//     reference the user's actual room.zoneList selections against what
//     Vision found. Exactly one selected zone with no fixture match means
//     that's where the camera is standing, by elimination -- zero model
//     guessing required. Two or more unclaimed zones means elimination
//     can't resolve it either; those zones are still listed (so GPT Image 2
//     knows to stage them, per ROOMS AND ZONES TO STAGE's "not listed =
//     vacant" rule) but with no anchor text, handing placement to
//     spatial-zone-template.js's existing ZONE IDENTIFICATION RULES /
//     CIRCULATION-ZONE FRAME BEHAVIOR / MANDATORY ZONE COVERAGE -- the
//     fallback path that's already built and validated for an unanchored
//     listed zone, no new logic needed downstream.
//
// Kitchen is still never sent to Vision and still always hardcoded --
// cabinetry/island self-identifies architecturally, confirmed reliable
// every test this session and prior. Kitchen also counts as permanently
// "claimed" for the elimination math below (it always has an anchor), so
// it never enters the unclaimed count.
//
// Living Room anchors (either qualifies independently, neither depends on
// the other being present):
//   - Fireplace
//   - Ceiling fan -- mounted over general room space, not a light fixture,
//     not positioned over a dining/kitchen area. Added this session per
//     Sam: "fireplaces are going away... ceiling fans are in rooms and not
//     over tables" -- newer builds increasingly skip the fireplace, so a
//     fan-anchored read keeps Living Room detectable without leaning on
//     the two-connected-walls anchor, which was flagged and deliberately
//     left out of this rebuild (see sample1a.jpg, prior session -- generic
//     "two connected walls" was never reliably distinguishable from
//     ordinary architecture, and that ambiguity was never resolved).
//
// Dining Zone / Flex Room anchor:
//   - Chandelier or pendant cluster over OPEN FLOOR (not over a kitchen
//     island/counter -- that's task lighting, excluded, same rule as
//     always). In an enclosed/semi-enclosed room this is a Flex Room
//     (Formal Dining Room) instead of Dining Zone -- Vision still just
//     reports the fixture; which label it becomes is still decided the
//     same way as before (closed FLEX_ROOM_TYPES enum, defensive fallback
//     if the model drifts outside it).
//
// Explicitly NOT in this version, on purpose: WALL anchor type (two
// connected walls), FOREGROUND anchor type, and the REASONING ORDER chain.
// All three are removed, not just reworded -- foreground is now handled by
// mergeRoomAssignment() below instead of asked of the model at all.

const https = require("https");

// Closed set, matching the app's Single Room list minus "Great Room" (Great
// Room isn't a valid Flex Room subtype -- it's effectively what Living Room
// already covers in an open-plan context). Free text was tried and
// explicitly rejected -- "user types in a room... blows our controlled
// naming and potential duplication of rooms" -- so this stays a closed
// enum, not a suggestion.
const FLEX_ROOM_TYPES = [
  "Office", "Formal Dining Room", "Media Room", "Play Room",
  "Music Room", "Den", "Study Room", "Gym", "Reading Nook",
];

// zoneList checkbox keys (set in index.html) -> the zone label Vision uses
// in its JSON output. Kitchen deliberately excluded -- it's never matched
// against Vision output, it's always claimed by the hardcoded line.
const ZONE_KEY_TO_LABEL = {
  dining: "Dining Zone",
  living: "Living Room",
  flex: "Flex Room",
};

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

const OPEN_PLAN_ZONE_PROMPT = `Look at this real estate interior photo. Identify these fixtures if present, and which zone each one anchors:

- Fireplace -> Living Room
- Ceiling fan -> Living Room (a fan mounted over general room space, not a chandelier or pendant light -- and not positioned over an open dining area or kitchen island, which are lighting fixtures, not fans)
- Chandelier or pendant cluster hanging over OPEN FLOOR (not over a kitchen island or counter -- that is task lighting, not a zone anchor) -> Dining Zone, unless the space is an enclosed or semi-enclosed room separate from the main open area, in which case it anchors a Flex Room. If it anchors a Flex Room, select the type from this exact list ONLY: Office, Formal Dining Room, Media Room, Play Room, Music Room, Den, Study Room, Gym, Reading Nook. A chandelier in an enclosed room is a strong signal for "Formal Dining Room." Never invent a type outside this list -- if unsure which type, omit flexRoomType and leave it as an empty string.

For each fixture you find, report the zone, what the fixture is, and where it sits in the frame (e.g. "fireplace, left wall" or "chandelier, center, over open floor").

Return ONLY this JSON shape, no markdown, no explanation:
{
  "zones": [
    {"zone": "Living Room", "anchorType": "FIXTURE", "anchorText": "fireplace, left wall"},
    {"zone": "Dining Zone", "anchorType": "FIXTURE", "anchorText": "chandelier, center, over open floor"},
    {"zone": "Flex Room", "flexRoomType": "Formal Dining Room", "anchorType": "FIXTURE", "anchorText": "chandelier, enclosed room, mid-frame"}
  ]
}

zone must be exactly one of "Living Room", "Dining Zone", "Flex Room" (never Kitchen -- Kitchen is handled separately and must never appear in your output). Only include a zone if you can actually see its fixture, physically present in this specific photo. Do not include a zone because it seems likely to be there, because the room type suggests it, or because a similar photo usually has one -- only report what you actually see. If you do not see a fireplace, ceiling fan, or dining/flex fixture at all, return {"zones": []}. Do not reason about camera position, room layout, or which zone the photo was taken from -- that is not part of this task.`;

async function analyzeOpenPlanZones(base64, mimeType, claudeKey, opts = {}) {
  // Default model: claude-sonnet-5 (swapped from claude-haiku-4-5-20251001
  // Aug 21, same session -- see mergeRoomAssignment below for why the
  // stripped prompt matters more than the model choice here). opts.model
  // still overrides if the caller passes one.
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

  return { zones: parsed.zones || [] };
}

// Resolves a Vision-reported zone entry to its display name + validated
// flexRoomType, same defensive logic as before: never let an out-of-enum
// flexRoomType value through, even though the prompt states it as closed --
// models can drift.
function displayNameFor(z) {
  if (z.zone !== "Flex Room") return z.zone;
  const rawType = (z.flexRoomType || "").trim();
  const validType = FLEX_ROOM_TYPES.includes(rawType) ? rawType : "";
  return validType || "Flex Room";
}

// ── Elimination merge ────────────────────────────────────────────────────
// Cross-references the user's actual zoneList selections against Vision's
// fixture findings. This is where foreground/camera-position gets resolved
// now -- by code, not by asking the model to reason about it.
//
//   0 unclaimed zones  -> nothing to add, every selection has a real anchor
//   1 unclaimed zone   -> that's where the camera is standing, by
//                         elimination -- gets "foreground of the frame,
//                         camera position."
//   2+ unclaimed zones -> elimination can't resolve which one is actually
//                         foreground. Do NOT guess in code or ask Vision to
//                         guess. List those zones by name only, no anchor
//                         text -- they still appear in "Find and stage" (so
//                         they get furnished, not left vacant), but with no
//                         anchor guidance. spatial-zone-template.js's
//                         existing ZONE IDENTIFICATION RULES and
//                         CIRCULATION-ZONE FRAME BEHAVIOR already own
//                         placement for exactly this case.
function mergeRoomAssignment(visionZones, zoneList, flexNote) {
  const lines = ["Kitchen: Anchor: island."];
  const list = zoneList || [];

  // Map each non-kitchen selected key to its zone label, and find whether
  // Vision reported a matching fixture for it.
  const selections = list
    .filter((key) => key !== "kitchen")
    .map((key) => {
      const label = ZONE_KEY_TO_LABEL[key] || key;
      const match = (visionZones || []).find((z) => z && z.zone === label);
      return { key, label, match };
    });

  const claimed = selections.filter((s) => s.match);
  const unclaimed = selections.filter((s) => !s.match);

  for (const s of claimed) {
    const displayName = s.key === "flex"
      ? (displayNameFor(s.match) === "Flex Room" && flexNote ? `${flexNote} (Flex Room)` : displayNameFor(s.match))
      : s.label;
    lines.push(`${displayName}: Anchor: ${s.match.anchorText || "(unspecified)"}.`);
  }

  if (unclaimed.length === 1) {
    const s = unclaimed[0];
    const displayName = s.key === "flex" && flexNote ? `${flexNote} (Flex Room)` : s.label;
    lines.push(`${displayName}: Anchor: foreground of the frame, camera position.`);
  } else if (unclaimed.length >= 2) {
    for (const s of unclaimed) {
      const displayName = s.key === "flex" && flexNote ? `${flexNote} (Flex Room)` : s.label;
      lines.push(`${displayName}.`);
    }
  }

  return lines.join("\n");
}

// ── Netlify handler ──────────────────────────────────────────────────────
// Called once per Open Plan photo, BEFORE stage-vacant-prompt.js. Returns
// roomAssignmentText, fully resolved (including elimination-derived
// foreground line where applicable) -- ready to pass straight through as
// the roomAssignmentText override to stage-vacant-prompt.js. No change
// needed downstream: spatial-zone-template.js's buildRoomAssignmentVariable
// already uses this verbatim when present.
//
// CACHING NOTE (enforced in index.html, not here): cache per photoId once
// computed, same as before. Anchors should stay stable across
// Iterate/Enhance-with-AI passes on the same photo.
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

    const { imageBase64, mimeType, model, zoneList, flexNote } = JSON.parse(event.body);
    if (!imageBase64) return { statusCode: 400, headers, body: JSON.stringify({ error: "Missing imageBase64" }) };

    const { zones } = await analyzeOpenPlanZones(imageBase64, mimeType, claudeKey, { model });
    const roomAssignmentText = mergeRoomAssignment(zones, zoneList, flexNote);

    console.log(
      "analyze-open-plan-zones: " + zones.length + " fixture(s) found -- " +
      zones.map(z => z.zone + "/" + z.anchorType).join(", ") +
      " | zoneList=" + JSON.stringify(zoneList || []) +
      " | resolved=" + JSON.stringify(roomAssignmentText)
    );

    return { statusCode: 200, headers, body: JSON.stringify({ zones, roomAssignmentText }) };

  } catch (err) {
    console.error("analyze-open-plan-zones error:", err.message);
    return { statusCode: 500, headers, body: JSON.stringify({ error: err.message, details: err.stack }) };
  }
}

// Single combined export, at the very end of the file, after everything it
// references is defined -- deliberate, see prior handler-export bug this
// session (module.exports reassigned before exports.handler was set,
// orphaning it). One export statement, one object, no possibility of a
// second assignment shadowing the first.
module.exports = { analyzeOpenPlanZones, mergeRoomAssignment, OPEN_PLAN_ZONE_PROMPT, FLEX_ROOM_TYPES, handler };
