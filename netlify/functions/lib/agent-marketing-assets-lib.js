// lib/agent-marketing-assets-lib.js — Netlify (shared). Builds the render manifest (am-manifest-2) from a project's approved narrative,
// its verified report figures, the prepared assets and the narration timing. Pure functions; no network.
"use strict";

const director = require("./agent-marketing-director-lib");
const timing = require("./agent-marketing-timing-lib");
const manifestLib = require("./agent-marketing-manifest-lib");

const MONTHS = { jan: 1, feb: 2, mar: 3, apr: 4, may: 5, jun: 6, jul: 7, aug: 8, sep: 9, oct: 10, nov: 11, dec: 12 };
const isoOf = (txt) => { const m = /^([A-Za-z]{3,9})\.? (\d{1,2}), (\d{4})$/.exec(String(txt).trim()); const mo = m && MONTHS[m[1].slice(0, 3).toLowerCase()]; return mo ? `${m[3]}-${String(mo).padStart(2, "0")}-${String(+m[2]).padStart(2, "0")}` : null; };
/** The report period from the stored notice sentence ("... for the period Feb 19, 2026 through Oct 19, 2026."), as ISO dates, or null. */
function parseNoticePeriod(text) {
  const m = /for the period (.+?) through (.+?)\.?$/.exec(String(text || "").trim());
  const start = m && isoOf(m[1]), end = m && isoOf(m[2]);
  return start && end ? { start, end } : null;
}

// ElevenLabs voice ids behind the two Agent Marketing voice choices. Set AGENT_MARKETING_VOICE_SSP_MALE / _SSP_FEMALE in Netlify.
// ssp_male defaults to the narrator Sam already uses for ssp-prospect.
function voiceIdFor(voice, env) {
  const e = env || process.env;
  if (voice === "ssp_female") return e.AGENT_MARKETING_VOICE_SSP_FEMALE || null;
  return e.AGENT_MARKETING_VOICE_SSP_MALE || "J7X6yWhJQlWW5OoUeuP1";
}

/** What each scene needs, in story order. kind: "generate" (GPT Image 2), "reuse" (another scene's image), "plate" (brand plate drawn in code), "unsupported". */
function imageNeeds(narrative) {
  return ((narrative && narrative.scenes) || []).map((s, i) => {
    const src = String(s.visualSource || "");
    if (src === "GPT_IMAGE_2_CONCEPT" && s.aiGenerationPrompt) return { scene: i, kind: "generate", imageKind: "concept", prompt: s.aiGenerationPrompt, framing: s.framing || {} };
    if (src === "CONCEPT_REUSE" && Number.isInteger(s.reuseOfScene)) return { scene: i, kind: "reuse", owner: s.reuseOfScene };
    if (src === "BRAND_CARD") return { scene: i, kind: "plate" };
    return { scene: i, kind: "unsupported", source: src };
  });
}

/**
 * buildManifest(input) → { manifest, edits, plan, validation }
 *   input: { projectId, formats, narrative (approved), intake, reportFigures, notice:{period}, brand:{primary,secondary,border,font,agent,headshot_key},
 *            audio:{ narration_key, duration_sec, words[] }, imageKeys: { [sceneIndex]: { "9x16": key, "16x9": key } }, narrationTagged }
 */
function buildManifest(input) {
  const { narrative, formats } = input;
  const figs = director.figuresFrom(input.reportFigures);
  const pl = director.plan(narrative, input.intake, figs);
  const excerpts = pl.scenes.map((s) => s.narration_excerpt);
  const tw = timing.sceneWindows(input.audio.words, excerpts, input.audio.duration_sec);
  if (tw.error) return { manifest: null, validation: { ok: false, errors: [{ code: "timing", where: "scenes", message: tw.error }], warnings: [] }, plan: pl };
  const used = new Set();
  pl.scenes.forEach((s) => (s.claims || []).forEach((c) => c.figure && used.add(c.figure)));
  const scenes = pl.scenes.map((s, i) => {
    const v = s.visual || {};
    const owner = v.visualSource === "CONCEPT_REUSE" && Number.isInteger(v.reuseOfScene) ? v.reuseOfScene : i;
    const keys = (input.imageKeys && input.imageKeys[owner]) || {};
    return {
      n: i + 1, composition: s.composition, narrative_role: s.narrative_role, branding: s.branding,
      narration_excerpt: s.narration_excerpt, window: tw.windows[i],
      visual: { research_visual_context: [v.purpose, v.visualBrief].filter(Boolean).join(" — "), image_keys: keys, motion: s.camera_motion || "static_hold", source: v.visualSource },
      claims: s.claims, data: s.data, reason: s.reason,
    };
  });
  const captions = timing.groupCaptionLines(input.audio.words);
  let manifest = {
    version: manifestLib.MANIFEST_VERSION, project_id: input.projectId, formats: formats.slice(), notice_required: true,
    notice: { period: input.notice.period, text: manifestLib.metroListNotice(input.notice.period) },
    brand: input.brand,
    figures: figs.filter((f) => used.has(f.ref)).map((f) => ({ ref: f.ref, label: f.label, display: f.display, value: f.value, n: f.n })),
    derived: pl.derived, narration_text: input.narrationTagged,
    audio: { narration_key: input.audio.narration_key, duration_sec: input.audio.duration_sec },
    captions, scenes,
  };
  const q = manifestLib.applySmallSampleQualifiers(manifest);
  manifest = q.manifest;
  const validation = manifestLib.validateManifest(manifest);
  return { manifest, edits: q.edits, plan: pl, validation };
}

module.exports = { parseNoticePeriod, voiceIdFor, imageNeeds, buildManifest };
