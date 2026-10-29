// lib/agent-marketing-images-lib.js — settings, prompts and accounting for Agent Marketing concept images (Oct 22, 2026).
// Pure functions (no network); the endpoint and the background worker pass rows in. Unit-tested.
//
// Oct 23: ONE wide 16:9 image is generated per scene. The vertical 9:16 Reel version is cropped from it (Claude Vision picks the
// sweet spot; the Railway renderer applies it), so there is a single image slot per scene and no per-format generation.
// Accounting (Sam's defaults): the first generation of each scene's image and ONE redo are included;
// further redos are charged. A project has a hard cap on generations. Each number is an environment setting so it can
// be tuned from the Netlify dashboard without a code change:
//   AGENT_MARKETING_IMAGE_FREE_REDOS    default 1
//   AGENT_MARKETING_IMAGE_PROJECT_CAP   default 12   (generations per project, errors that were refunded excluded)
//   AGENT_MARKETING_IMAGE_CREDITS       default 1    (Images charged per extra generation)
//   AGENT_MARKETING_IMAGE_QUALITY       default "medium"  (low | medium | high)
//   AGENT_MARKETING_IMAGE_CHARGING      default "on"      ("off" = every try is free during beta; the project cap still applies)
//   AGENT_MARKETING_IMAGE_SIZE          default "2560x1440" (a 16:9 size; edges multiples of 16, max 3840; above 2560x1440 is experimental)
"use strict";

const WIDE = "16x9"; // the one generated format; stored on every generation
const DEFAULT_SIZE = "2560x1440";
// A usable wide size: both edges multiples of 16, longest edge <= 3840, 16:9 (within 2%), pixels in OpenAI's allowed range.
function validWideSize(v) {
  const m = /^(\d{3,4})x(\d{3,4})$/.exec(String(v || "").trim());
  if (!m) return null;
  const w = Number(m[1]), h = Number(m[2]);
  if (w % 16 || h % 16 || Math.max(w, h) > 3840 || Math.abs(w / h - 16 / 9) > 0.02 || w * h < 655360 || w * h > 8294400) return null;
  return w + "x" + h;
}
const SIZES = { [WIDE]: validWideSize(process.env.AGENT_MARKETING_IMAGE_SIZE) || DEFAULT_SIZE };
const TALL = "9x16";
const FORMATS = [TALL, WIDE];
// The formats an agent ordered for a project, in a fixed order; a project with none recorded gets the wide one.
function formatsOf(project) {
  const f = project && Array.isArray(project.formats) ? project.formats.filter((x) => FORMATS.includes(x)) : [];
  const out = FORMATS.filter((x) => f.includes(x));
  return out.length ? out : [WIDE];
}
const IMAGE_SOURCES = ["GPT_IMAGE_2_CONCEPT", "AGENT_SCENE"];
const STALE_GENERATING_MS = 8 * 60 * 1000;
const num = (v, d, min, max) => { const n = Number(v); return Number.isFinite(n) && n >= min && n <= max ? Math.floor(n) : d; };

function settings(env) {
  const e = env || process.env;
  const q = String(e.AGENT_MARKETING_IMAGE_QUALITY || "medium").toLowerCase();
  return {
    freeRedos: num(e.AGENT_MARKETING_IMAGE_FREE_REDOS, 1, 0, 5),
    projectCap: num(e.AGENT_MARKETING_IMAGE_PROJECT_CAP, 12, 1, 60),
    credits: num(e.AGENT_MARKETING_IMAGE_CREDITS, 1, 1, 20),
    quality: ["low", "medium", "high"].includes(q) ? q : "medium",
    charging: String(e.AGENT_MARKETING_IMAGE_CHARGING || "on").trim().toLowerCase() !== "off",
  };
}

// Scenes that need a newly generated image, in story order.
function imageScenes(narrative) {
  const scenes = (narrative && Array.isArray(narrative.scenes)) ? narrative.scenes : [];
  return scenes.map((s, i) => (s && IMAGE_SOURCES.includes(s.visualSource) ? { index: i, scene: s } : null)).filter(Boolean);
}

// Every scene, in story order. Since Oct 23 the agent can choose to generate an image for ANY scene (or use their own
// photo), so the Images step lists all of them; imageScenes() above is only what the planner itself asked for.
function allScenes(narrative) {
  const scenes = (narrative && Array.isArray(narrative.scenes)) ? narrative.scenes : [];
  return scenes.map((s, i) => (s ? { index: i, scene: s } : null)).filter(Boolean);
}
// "concept" | "agent_scene" when the planner wrote a ready image prompt for this scene, else null.
function plannedKind(scene) {
  if (!scene || !scene.aiGenerationPrompt) return null;
  return scene.visualSource === "AGENT_SCENE" ? "agent_scene" : scene.visualSource === "GPT_IMAGE_2_CONCEPT" ? "concept" : null;
}

const fmtOf = (a) => (a && a.generation && a.generation.format) || null;
const stateOf = (a) => (a && a.generation && a.generation.state) || null;
// An attempt "counts" unless it failed (failed attempts are refunded, so they never use up a free redo or the cap).
const counts = (a) => a && a.source === "gpt_image_2" && stateOf(a) !== "error";

// Only the wide images count as a scene's image slot (older 9:16 test images from before Oct 23 are ignored here).
function slotAssets(assets, sceneIndex, format) {
  return (assets || []).filter((a) => counts(a) && a.scene_index === sceneIndex && fmtOf(a) === (format || WIDE));
}

// What the NEXT generation for this slot costs and whether it is allowed.
function quote(assets, sceneIndex, format, env, formatsCount) {
  const st = settings(env);
  const used = slotAssets(assets, sceneIndex, format).length;
  const projectTotal = (assets || []).filter(counts).length;
  const included = 1 + st.freeRedos;
  const charged = st.charging && used >= included;
  return {
    used, included, charged, credits: charged ? st.credits : 0,
    // The project limit is per format ordered: a Reel in both formats needs twice the first images.
    capReached: projectTotal >= st.projectCap * Math.max(1, formatsCount || 1), projectTotal, projectCap: st.projectCap * Math.max(1, formatsCount || 1),
  };
}

const NO_REAL_THINGS = "No text, letters, numbers, house numbers, street names, logos, brand names, watermarks, charts, rates or prices. No real landmarks, no identifiable real buildings or addresses. No people other than any person explicitly described below.";

// Local Events Reels may show people (Sam, Oct 28): ordinary people enjoying the event, shown naturally. Every other Reel keeps concept images people-free.
function peopleAllowedFor(project) {
  const t = project && project.selected_topic;
  return !!(t && typeof t === "object" && (t.kind === "local_events" || (t.event && typeof t.event === "object")));
}
const NO_REAL_THINGS_PEOPLE_OK = NO_REAL_THINGS.replace(/ No people other than.*$/, "");
const conceptTail = (people) => people ? NO_REAL_THINGS_PEOPLE_OK + " Ordinary people may appear naturally as part of the scene." : NO_REAL_THINGS + " No people at all.";

// The prompt actually sent. `kind` is "concept" or "agent_scene". Always ONE wide 16:9 frame: the vertical 9:16 Reel version is a
// window cropped from the middle of it, so the subject must sit in the central third and the sides must be plain scenery.
const WIDE_RULES = "Wide horizontal 16:9 landscape composition. IMPORTANT: a tall 9:16 vertical window will also be cropped from this same image, so place the main subject and every key detail inside the central third of the width; the left and right thirds should be simple, calm scenery that still reads well as a wide establishing view. Keep the lower third calm and uncluttered (captions go there).";
const AGENT_RULES = "Wide horizontal 16:9 landscape composition shot like a real editorial photo, NOT a portrait or headshot. A tall 9:16 vertical window will also be cropped from this same image, so place the person about one third of the way in from the left edge, standing or seated naturally and shown full length or at least to the knees, filling only about 55 to 65 percent of the frame height. Show plenty of the surrounding environment on both sides and above them. Keep the lower third calm and uncluttered (captions go there).";
// The vertical 9:16 window is 81/256 of the wide image's width. Its centre (0..1) is saved per image; the agent can slide it.
const CROP_WIDTH = 81 / 256;
function clampCrop(x) { const n = Number(x); if (!isFinite(n)) return 0.5; return Math.min(1 - CROP_WIDTH / 2, Math.max(CROP_WIDTH / 2, Math.round(n * 1000) / 1000)); }
function defaultCropX(kind) { return kind === "agent_scene" ? 0.34 : 0.5; }
function buildPrompt({ kind, scenePrompt, people }) {
  const base = require("./agent-marketing-signage-lib").scrubSignage(String(scenePrompt || "").replace(/\s+/g, " ").trim().slice(0, 900));
  if (kind === "agent_scene") {
    return [
      "Create a photorealistic editorial photograph showing the real person in the reference photo in this generic setting: " + base,
      AGENT_RULES,
      "The person must look exactly like the reference photo: same face, hair, beard, age and build, natural skin texture, natural relaxed expression. Keep their clothing simple and similar to the reference. The person is the ONLY person in the image.",
      "Natural light, California residential aesthetic, believable proportions and hands.",
      NO_REAL_THINGS,
    ].join("\n");
  }
  return [
    "Create a photorealistic editorial concept image: " + base,
    WIDE_RULES,
    "Soft natural light, California residential aesthetic, calm and uncluttered. It is a conceptual illustration, not a documentary photo of a real place.",
    conceptTail(people),
  ].join("\n");
}

// Revision (Oct 28, 2026, Sam): when the scene already has an image and the agent adds a note, the note is an EDIT of that image, like a
// virtual-staging revision: the picture is sent to the image model as the thing to edit and everything the note does not name stays locked.
function buildRevisionPrompt({ instruction }) {
  const base = require("./agent-marketing-signage-lib").scrubSignage(String(instruction || "").replace(/\s+/g, " ").trim().slice(0, 700));
  return [
    "Edit the provided image. Make ONLY this change: " + base,
    "Keep everything else exactly as it is in the provided image: the same composition, camera angle and framing, the same home or subject, building shapes, colors, materials, landscaping, objects, layout and image size. For a person, keep exactly the same face, hair, build and clothing. Change only what the instruction names and what that change directly affects (for example the light, shadows and sky when the time of day changes). Do not add, remove or move anything else.",
    "Keep the calm, uncluttered areas of the frame calm (open sky or wall at the top, a clear lower third for captions).",
    NO_REAL_THINGS,
  ].join("\n");
}

// Which profile photo to use as the agent reference (full body preferred when the scene is a full figure).
function pickReferenceKey(profileRow) {
  const r = profileRow || {};
  return r.fullbody_key || r.headshot_key || null;
}


// Agent Marketing asset preparation (Oct 26, 2026): each SELECTED format gets its own image. The wide prompt is the one above;
// the tall prompt keeps the subject centred with calm bands at the top (headline) and bottom (captions). `framing` is the planner's
// per-format framing note for the scene.
const TALL_SIZE = "1440x2560";
const TALL_RULES = "Tall vertical 9:16 portrait-orientation composition. Text will be laid over the top 45% of the frame, so keep that whole upper area calm and simple: soft wall, sky, window light or blurred background only, with no objects, props, plants or strong edges in it. That upper area must be one continuous surface edge to edge: no window frames, door frames, curtains, shelves, corners or any vertical edge or change of brightness crossing it, especially near the left and right sides. Place the main subject and every key detail in the band between 48% and 78% of the frame height, and keep the lower fifth calm and uncluttered (captions sit there).";
const TALL_AGENT_RULES = "Tall vertical 9:16 portrait-orientation photograph shot like a real editorial photo, NOT a headshot. Text will be laid over the top 45% of the frame, so keep that whole upper area calm and simple: soft sky, wall or blurred background only, one continuous surface edge to edge with no objects, strong edges or vertical lines in it. Show the person standing or seated naturally, full length or at least to the knees, with their head and body inside the band between 48% and 85% of the frame height, centred horizontally, with the surrounding environment visible around them. Keep the lower fifth calm and uncluttered (captions sit there).";
function buildFormatPrompt({ kind, scenePrompt, format, framing, people }) {
  if (format !== "9x16") return buildPrompt({ kind, scenePrompt, people });
  const base = String(scenePrompt || "").replace(/\s+/g, " ").trim().slice(0, 900);
  const note = framing ? String(framing).replace(/\s+/g, " ").trim().slice(0, 300) : "";
  if (kind === "agent_scene") {
    return [
      "Create a photorealistic editorial photograph showing the real person in the reference photo in this generic setting: " + base,
      TALL_AGENT_RULES,
      note ? "Framing: " + note : "",
      "The person must look exactly like the reference photo: same face, hair, beard, age and build, natural skin texture, natural relaxed expression. Keep their clothing simple and similar to the reference. The person is the ONLY person in the image.",
      "Natural light, California residential aesthetic, believable proportions and hands.",
      NO_REAL_THINGS,
    ].filter(Boolean).join("\n");
  }
  return [
    "Create a photorealistic editorial concept image: " + base,
    TALL_RULES,
    note ? "Framing: " + note : "",
    "Soft natural light, California residential aesthetic, calm and uncluttered. It is a conceptual illustration, not a documentary photo of a real place.",
    conceptTail(people),
  ].filter(Boolean).join("\n");
}
const tallSize = () => validTallSize(process.env.AGENT_MARKETING_IMAGE_SIZE_TALL) || TALL_SIZE;
const sizeFor = (format) => (format === TALL ? tallSize() : SIZES[WIDE]);
function validTallSize(v) {
  const m = /^(\d{3,4})x(\d{3,4})$/.exec(String(v || "").trim());
  if (!m) return null;
  const w = Number(m[1]), h = Number(m[2]);
  if (w % 16 || h % 16 || Math.max(w, h) > 3840 || Math.abs(h / w - 16 / 9) > 0.02 || w * h < 655360 || w * h > 8294400) return null;
  return w + "x" + h;
}

module.exports = { buildFormatPrompt, tallSize, sizeFor, formatsOf, TALL, FORMATS, TALL_SIZE, CROP_WIDTH, clampCrop, defaultCropX, WIDE, DEFAULT_SIZE, validWideSize, SIZES, IMAGE_SOURCES, STALE_GENERATING_MS, settings, imageScenes, allScenes, plannedKind, slotAssets, quote, buildPrompt, buildRevisionPrompt, peopleAllowedFor, pickReferenceKey, counts, fmtOf, stateOf };
