// lib/agent-marketing-images-lib.js — settings, prompts and accounting for Agent Marketing concept images (Oct 22, 2026).
// Pure functions (no network); the endpoint and the background worker pass rows in. Unit-tested.
//
// Accounting (Sam's defaults): the first generation of each image slot (scene x format) and ONE redo are included;
// further redos are charged. A project has a hard cap on generations. Each number is an environment setting so it can
// be tuned from the Netlify dashboard without a code change:
//   AGENT_MARKETING_IMAGE_FREE_REDOS    default 1
//   AGENT_MARKETING_IMAGE_PROJECT_CAP   default 12   (generations per project, errors that were refunded excluded)
//   AGENT_MARKETING_IMAGE_CREDITS       default 1    (Images charged per extra generation)
//   AGENT_MARKETING_IMAGE_QUALITY       default "medium"  (low | medium | high)
"use strict";

const SIZES = { "9x16": "1024x1536", "16x9": "1536x1024" };
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
  };
}

// Scenes that need a newly generated image, in story order.
function imageScenes(narrative) {
  const scenes = (narrative && Array.isArray(narrative.scenes)) ? narrative.scenes : [];
  return scenes.map((s, i) => (s && IMAGE_SOURCES.includes(s.visualSource) ? { index: i, scene: s } : null)).filter(Boolean);
}

const fmtOf = (a) => (a && a.generation && a.generation.format) || null;
const stateOf = (a) => (a && a.generation && a.generation.state) || null;
// An attempt "counts" unless it failed (failed attempts are refunded, so they never use up a free redo or the cap).
const counts = (a) => a && a.source === "gpt_image_2" && stateOf(a) !== "error";

function slotAssets(assets, sceneIndex, format) {
  return (assets || []).filter((a) => counts(a) && a.scene_index === sceneIndex && fmtOf(a) === format);
}

// What the NEXT generation for this slot costs and whether it is allowed.
function quote(assets, sceneIndex, format, env) {
  const st = settings(env);
  const used = slotAssets(assets, sceneIndex, format).length;
  const projectTotal = (assets || []).filter(counts).length;
  const included = 1 + st.freeRedos;
  const charged = used >= included;
  return {
    used, included, charged, credits: charged ? st.credits : 0,
    capReached: projectTotal >= st.projectCap, projectTotal, projectCap: st.projectCap,
  };
}

const NO_REAL_THINGS = "No text, letters, numbers, signs, house numbers, street names, logos, brand names, watermarks, charts, rates or prices. No real landmarks, no identifiable real buildings or addresses. No people other than any person explicitly described below.";

// The prompt actually sent. `kind` is "concept" or "agent_scene"; `landscapeFromPortrait` is set for a 16:9 version built
// from an approved 9:16 image.
function buildPrompt({ kind, scenePrompt, format, fromApproved }) {
  const orient = format === "16x9" ? "horizontal 16:9 landscape composition" : "vertical 9:16 portrait composition";
  const base = String(scenePrompt || "").replace(/\s+/g, " ").trim().slice(0, 900);
  if (fromApproved) {
    return [
      "Recompose the reference image as a " + orient + ". Keep exactly the same scene, lighting, mood, colors and, if present, the same person (identical face, hair, beard, age, build and clothing). Extend the scene naturally to fill the new frame; do not crop awkwardly or change the subject.",
      "Keep the main subject clear of the lower third (captions go there) and leave calm space in the upper area.",
      NO_REAL_THINGS,
    ].join("\n");
  }
  if (kind === "agent_scene") {
    return [
      "Create a photorealistic editorial photograph, " + orient + ", showing the real person in the reference photo in this generic setting: " + base,
      "The person must look exactly like the reference photo: same face, hair, beard, age and build, natural skin texture, natural relaxed expression. Keep their clothing simple and similar to the reference. The person is the ONLY person in the image.",
      "Natural light, California residential aesthetic, believable proportions and hands. Keep the subject clear of the lower third (captions go there).",
      NO_REAL_THINGS,
    ].join("\n");
  }
  return [
    "Create a photorealistic editorial concept image, " + orient + ": " + base,
    "Soft natural light, California residential aesthetic, calm and uncluttered, room for captions in the lower third. It is a conceptual illustration, not a documentary photo of a real place.",
    NO_REAL_THINGS + " No people at all.",
  ].join("\n");
}

// Which profile photo to use as the agent reference (full body preferred when the scene is a full figure).
function pickReferenceKey(profileRow) {
  const r = profileRow || {};
  return r.fullbody_key || r.headshot_key || null;
}

module.exports = { SIZES, IMAGE_SOURCES, STALE_GENERATING_MS, settings, imageScenes, slotAssets, quote, buildPrompt, pickReferenceKey, counts, fmtOf, stateOf };
