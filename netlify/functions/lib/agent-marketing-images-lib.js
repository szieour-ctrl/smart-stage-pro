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
function quote(assets, sceneIndex, format, env) {
  const st = settings(env);
  const used = slotAssets(assets, sceneIndex, format).length;
  const projectTotal = (assets || []).filter(counts).length;
  const included = 1 + st.freeRedos;
  const charged = st.charging && used >= included;
  return {
    used, included, charged, credits: charged ? st.credits : 0,
    capReached: projectTotal >= st.projectCap, projectTotal, projectCap: st.projectCap,
  };
}

const NO_REAL_THINGS = "No text, letters, numbers, signs, house numbers, street names, logos, brand names, watermarks, charts, rates or prices. No real landmarks, no identifiable real buildings or addresses. No people other than any person explicitly described below.";

// The prompt actually sent. `kind` is "concept" or "agent_scene". Always ONE wide 16:9 frame: the vertical 9:16 Reel version is a
// window cropped from the middle of it, so the subject must sit in the central third and the sides must be plain scenery.
const WIDE_RULES = "Wide horizontal 16:9 landscape composition. IMPORTANT: a tall 9:16 vertical window will also be cropped from this same image, so place the main subject and every key detail inside the central third of the width; the left and right thirds should be simple, calm scenery that still reads well as a wide establishing view. Keep the lower third calm and uncluttered (captions go there).";
function buildPrompt({ kind, scenePrompt }) {
  const base = String(scenePrompt || "").replace(/\s+/g, " ").trim().slice(0, 900);
  if (kind === "agent_scene") {
    return [
      "Create a photorealistic editorial photograph showing the real person in the reference photo in this generic setting: " + base,
      WIDE_RULES + " Show the person standing or seated in the center of the frame, head to at least mid-thigh, filling a good part of the frame height.",
      "The person must look exactly like the reference photo: same face, hair, beard, age and build, natural skin texture, natural relaxed expression. Keep their clothing simple and similar to the reference. The person is the ONLY person in the image.",
      "Natural light, California residential aesthetic, believable proportions and hands.",
      NO_REAL_THINGS,
    ].join("\n");
  }
  return [
    "Create a photorealistic editorial concept image: " + base,
    WIDE_RULES,
    "Soft natural light, California residential aesthetic, calm and uncluttered. It is a conceptual illustration, not a documentary photo of a real place.",
    NO_REAL_THINGS + " No people at all.",
  ].join("\n");
}

// Which profile photo to use as the agent reference (full body preferred when the scene is a full figure).
function pickReferenceKey(profileRow) {
  const r = profileRow || {};
  return r.fullbody_key || r.headshot_key || null;
}

module.exports = { WIDE, DEFAULT_SIZE, validWideSize, SIZES, IMAGE_SOURCES, STALE_GENERATING_MS, settings, imageScenes, allScenes, plannedKind, slotAssets, quote, buildPrompt, pickReferenceKey, counts, fmtOf, stateOf };
