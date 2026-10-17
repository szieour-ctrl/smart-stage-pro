// reel-plan-lib.js — Reel "Vision plan" (Oct 17, 2026).
//
// One Claude Vision call looks at the photos the agent picked for a Reel and returns the
// storyboard: which photo goes in which scene slot, plus a short caption for the scenes that carry
// one. Slots come from reel-slots.json, which is GENERATED from the Railway storyboard engine
// (resolveScenes) so the roles / caption positions here always match what gets rendered.
//
// Rules the model is given (and that this file re-enforces in code, never trusting the model):
//  - every picked photo is used exactly once, scene order = slot order
//  - slot 0 = the strongest opening image, last slot = a strong closing image
//  - captions the agent typed are kept VERBATIM and the best-matching photo is placed with them
//  - model-written captions describe only what is visible and permanent (architecture, light,
//    finishes, layout) — never furniture/decor (it may be virtually staged, AB 723) and never
//    invented facts (age of roof, school district, price, etc.)

const SLOTS = require("./reel-slots.json");
const { callClaudeVision, fetchAndResizeForVision, CLAUDE_VISION_MAX_DIM, KEN_BURNS_SELECTABLE_PRESETS, COMPOUND_KEN_BURNS_PRESETS } = require("../autoSelect");

// Ken Burns only (Reels have no AI Motion). Same vocabulary as the video builder.
const ALLOWED_MOTION = new Set([...KEN_BURNS_SELECTABLE_PRESETS, ...COMPOUND_KEN_BURNS_PRESETS, "luxury_parallax"]);

const MAX_CAPTION = 60;

function photoRange(lengthSec) { return SLOTS.ranges[String(lengthSec)] || null; }

function slotsFor(event, n) {
  const ev = SLOTS.events[event];
  if (!ev) return null;
  return ev.byCount[String(n)] || null;
}

// Validates the request shape; returns an error string or null.
function validateRequest({ event, lengthSec, photos }) {
  if (!SLOTS.events[event]) return `Unknown Reel event "${event}"`;
  const range = photoRange(lengthSec);
  if (!range) return `Reel length must be one of ${Object.keys(SLOTS.ranges).join(", ")} seconds`;
  if (!Array.isArray(photos)) return "Missing photos";
  const n = photos.length;
  if (n < range[0] || n > range[1]) {
    return `A ${lengthSec}s Reel uses ${range[0] === range[1] ? range[0] : `${range[0]}–${range[1]}`} photos (you chose ${n})`;
  }
  const ids = new Set();
  for (const p of photos) {
    if (!p || !p.id || !/^https:\/\//i.test(String(p.url || ""))) return "Each photo needs an id and an https url";
    if (ids.has(p.id)) return "Duplicate photo in selection";
    ids.add(p.id);
  }
  return null;
}

function userCaption(intake, cap) {
  if (!cap) return "";
  const v = ((intake || {})[cap.key] || [])[cap.idx];
  return typeof v === "string" ? v.trim() : "";
}

function buildSystemPrompt() {
  return `You are the storyboard editor for a real-estate social media Reel (vertical 9:16, short, photo-based). You are shown the photos an agent picked and a list of scene slots. Assign every photo to exactly one slot and write short captions where asked.

Rules:
1. Use every photo exactly once. Never invent photo ids.
2. Slot 0 is the opening: use the single strongest, most scroll-stopping image (usually the front exterior or the best hero room). The LAST slot is the closing: use a strong, welcoming image (an exterior, a view, or an inviting living space).
3. Match each middle slot to its "image" hint as well as you can. Keep rooms that belong together adjacent.
4. Where a slot has a FIXED caption (typed by the agent), choose the photo that best matches that caption's meaning. Do not rewrite fixed captions.
5. Where a slot asks for a caption, write 3-8 words (max ${MAX_CAPTION} characters) describing only what is clearly visible and permanent in that photo: architecture, natural light, layout, finishes, views, indoor-outdoor flow. Do NOT mention furniture, decor or staging (it may be virtually staged), and do NOT state anything you cannot see (no ages, upgrades, schools, prices, square footage). No emojis, no hashtags, no exclamation marks.
6. Slots with no caption request get an empty caption.
7. Motion: for EVERY slot also pick ONE Ken Burns camera movement for its photo, only from: ${[...ALLOWED_MOTION].join(", ")}. Match the photo's visual anchor: ceiling, chandelier or fan detail -> tilt_up; hero floor, rug or tilework -> tilt_down; main feature wall, island or fireplace -> push_in; a front exterior or wide open reveal -> pull_back; a strong lateral sightline (hallway, counter run) -> pan_left or pan_right; a corner-to-window or corner-to-patio diagonal -> drift; a wide shot with no directional feature -> float or pan_zoom; static only for a key clarity shot. Compound movements (names with several parts, e.g. soft_push_float_push, push_tilt_up, float_pull_back) only for hero spaces: front exterior, open-plan living, kitchen/living/dining, office/flex, primary bedroom or bath, and the strongest closing exterior. Never use a compound for a secondary bedroom, secondary bath or utility room. Use soft_push_float_strong_push for at most one scene. The Reel is a tall 9:16 crop, so favor push_in, pull_back, tilt and gentle drift, and use pan_left/pan_right sparingly. Judge the movements as a sequence: vary them and avoid the same move in two scenes in a row.

Return ONLY a JSON object, no other text:
{"slots":[{"slot":0,"photoId":"<id>","caption":"","motion":"push_in"}, ...one entry per slot in order...],"notes":"<one short sentence on any weak spot, e.g. no kitchen photo, or empty string>"}`;
}

async function buildUserContent({ event, slots, photos, intake }) {
  const evLabel = SLOTS.events[event].label;
  const resized = await Promise.all(photos.map((p) => fetchAndResizeForVision(p.url, CLAUDE_VISION_MAX_DIM)));
  const content = [{ type: "text", text: `Reel type: ${evLabel}. ${photos.length} photos follow, then the ${slots.length} scene slots.` }];
  photos.forEach((p, i) => {
    content.push({ type: "image", source: { type: "base64", media_type: resized[i].mediaType, data: resized[i].base64 } });
    content.push({ type: "text", text: `Photo id: ${p.id}.${p.label ? ` Agent/room label: "${p.label}".` : ""}` });
  });
  const lines = slots.map((s, i) => {
    let cap = "no caption";
    if (s.caption) {
      const fixed = userCaption(intake, s.caption);
      cap = fixed ? `FIXED caption: "${fixed}"` : "write a caption";
    }
    return `Slot ${i}: ${s.role}${s.closing ? " (closing)" : ""} — wants: ${s.image}. ${cap}.`;
  });
  content.push({ type: "text", text: `Scene slots:\n${lines.join("\n")}\n\nReturn the JSON object now.` });
  return content;
}

function extractJsonObject(text) {
  const a = text.indexOf("{"), b = text.lastIndexOf("}");
  if (a === -1 || b < a) throw new Error(`No JSON object in Reel plan response. Raw: ${String(text).slice(0, 400)}`);
  return JSON.parse(text.slice(a, b + 1));
}

// Never trust the model: fix duplicates / omissions / unknown ids, force fixed captions.
function normalizePlan(raw, { event, slots, photos, intake }) {
  const valid = new Set(photos.map((p) => p.id));
  const used = new Set();
  const byIdx = {};
  for (const e of (raw && raw.slots) || []) {
    const i = Number(e && e.slot);
    if (!Number.isInteger(i) || i < 0 || i >= slots.length || byIdx[i]) continue;
    if (!valid.has(e.photoId) || used.has(e.photoId)) continue;
    used.add(e.photoId);
    byIdx[i] = e;
  }
  const leftover = photos.filter((p) => !used.has(p.id)).map((p) => p.id); // original order
  const out = slots.map((s, i) => {
    const e = byIdx[i] || {};
    const photoId = e.photoId || leftover.shift();
    let caption = "", fixed = false;
    if (s.caption) {
      const typed = userCaption(intake, s.caption);
      if (typed) { caption = typed; fixed = true; }
      else caption = String(e.caption || "").replace(/[!#]/g, "").replace(/\s+/g, " ").trim().slice(0, MAX_CAPTION).trim();
    }
    const motion = ALLOWED_MOTION.has(e.motion) ? e.motion : "auto";
    return { slot: i, role: s.role, closing: !!s.closing, photoId, caption, motion, captionKey: s.caption ? s.caption.key : null, captionIdx: s.caption ? s.caption.idx : null, fixedCaption: fixed };
  });
  // Arrays the Railway storyboard engine reads (aligned to its caption positions).
  const arrays = { highlights: [], supporting: [] };
  out.forEach((o) => { if (o.captionKey) arrays[o.captionKey][o.captionIdx] = o.caption; });
  for (const k of ["highlights", "supporting"]) for (let i = 0; i < arrays[k].length; i++) if (arrays[k][i] == null) arrays[k][i] = "";
  return { event, sceneCount: slots.length, slots: out, highlights: arrays.highlights, supporting: arrays.supporting, notes: String((raw && raw.notes) || "").slice(0, 200) };
}

async function generateReelPlan({ event, lengthSec, photos, intake, anthropicKey }) {
  const err = validateRequest({ event, lengthSec, photos });
  if (err) throw new Error(err);
  const slots = slotsFor(event, photos.length);
  if (!slots) throw new Error(`No scene layout for ${event} with ${photos.length} photos`);
  const userContent = await buildUserContent({ event, slots, photos, intake });
  const text = await callClaudeVision(buildSystemPrompt(), userContent, anthropicKey);
  return normalizePlan(extractJsonObject(text), { event, slots, photos, intake });
}

module.exports = { ALLOWED_MOTION, SLOTS, photoRange, slotsFor, validateRequest, normalizePlan, extractJsonObject, buildSystemPrompt, generateReelPlan };
