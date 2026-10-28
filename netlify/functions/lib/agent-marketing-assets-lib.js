// lib/agent-marketing-assets-lib.js — Netlify (shared). Builds the render manifest (am-manifest-2) from a project's approved narrative,
// its verified report figures, the prepared assets and the narration timing. Pure functions; no network.
"use strict";

const sourcesLib = require("./agent-marketing-sources-lib");
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
  return e.AGENT_MARKETING_VOICE_SSP_MALE || "32k6j8e9sZJuuBXxDcVP";
}

/** What each scene needs, in story order. kind: "generate" (GPT Image 2), "reuse" (another scene's image), "plate" (brand plate drawn in code), "unsupported". */
// ownScenes: scene indexes where the agent chose their own photo on the Visuals step; that photo is the image for every format.
function imageNeeds(narrative, ownScenes) {
  const own = ownScenes instanceof Set ? ownScenes : new Set(ownScenes || []);
  return ((narrative && narrative.scenes) || []).map((s, i) => {
    const src = String(s.visualSource || "");
    if (src === "CONCEPT_REUSE" && Number.isInteger(s.reuseOfScene)) return { scene: i, kind: "reuse", owner: s.reuseOfScene };
    if (own.has(i)) return { scene: i, kind: "own" };
    if (src === "GPT_IMAGE_2_CONCEPT" && s.aiGenerationPrompt) return { scene: i, kind: "generate", imageKind: "concept", prompt: s.aiGenerationPrompt, framing: s.framing || {} };
    if (src === "AGENT_SCENE" && s.aiGenerationPrompt) return { scene: i, kind: "generate", imageKind: "agent_scene", prompt: s.aiGenerationPrompt, framing: s.framing || {} };
    if (src === "BRAND_CARD" || src === "AUTHENTIC_AGENT_ASSET") return { scene: i, kind: "plate" }; // an optional real photo the agent did not add
    return { scene: i, kind: "unsupported", source: src };
  });
}

/**
 * Numbers the uploaded report itself states (Oct 27, 2026): a statement or support line on a card repeats the narration, and the narration
 * may quote any figure from the subscriber's report, not only the ones a card claims. Each report figure counts as verified, and so does
 * its whole-number rounding ("a median of 19.5 days" may read "20 days"). Nothing calculated across figures is added here.
 */
function reportNumbers(figs) {
  const out = new Set();
  (figs || []).forEach((f) => {
    if (!Number.isFinite(f.value)) return;
    out.add(f.value);
    if (!Number.isInteger(f.value) && Math.abs(f.value) >= 10) out.add(Math.round(f.value));
  });
  return [...out];
}

/**
 * buildManifest(input) → { manifest, edits, plan, validation }
 *   input: { cardCopy (optional, { [sceneIndex]: { headline, statement, support } } from the card copy writer), projectId, formats, narrative (approved), intake, reportFigures, notice:{period}, brand:{primary,secondary,border,font,agent,headshot_key},
 *            audio:{ narration_key, duration_sec, words[] }, imageKeys: { [sceneIndex]: { "9x16": key, "16x9": key } }, narrationTagged }
 */
function buildManifest(input) {
  const { narrative, formats } = input;
  const figs = director.figuresFrom(input.reportFigures);
  const pl = director.plan(narrative, input.intake, figs, { cardCopy: input.cardCopy });
  const excerpts = pl.scenes.map((s) => s.narration_excerpt);
  const tw = timing.sceneWindows(input.audio.words, excerpts, input.audio.duration_sec);
  if (tw.error) return { manifest: null, validation: { ok: false, errors: [{ code: "timing", where: "scenes", message: tw.error }], warnings: [] }, plan: pl };
  const used = new Set();
  pl.scenes.forEach((s) => (s.claims || []).forEach((c) => c.figure && used.add(c.figure)));
  // A figure card should arrive when the number is spoken, not at the start of the sentence that leads up to it.
  const cardStart = (s, w) => {
    if (!/^(stat_big_number|compare_two_card)$/.test(s.composition) || !w) return undefined;
    const hit = (input.audio.words || []).find((x) => x.start >= w.start && x.start < w.end && /\d/.test(String(x.text || x.word || "")));
    if (!hit) return undefined;
    const t = Math.round(Math.max(w.start, hit.start - 0.6) * 100) / 100;
    return t - w.start >= 0.8 ? t : undefined;
  };
  const scenes = pl.scenes.map((s, i) => {
    const v = s.visual || {};
    const owner = v.visualSource === "CONCEPT_REUSE" && Number.isInteger(v.reuseOfScene) ? v.reuseOfScene : i;
    const keys = (input.imageKeys && input.imageKeys[owner]) || {};
    return {
      n: i + 1, composition: s.composition, narrative_role: s.narrative_role, branding: s.branding, source_role: v.sourceRole === "article" && i > 0 && i < pl.scenes.length - 1 ? "article" : "data",
      narration_excerpt: s.narration_excerpt, window: tw.windows[i], ...(cardStart(s, tw.windows[i]) !== undefined ? { card_start_sec: cardStart(s, tw.windows[i]) } : {}),
      visual: { research_visual_context: [v.purpose, v.visualBrief].filter(Boolean).join(" — "), image_keys: keys, motion: s.camera_motion || "static_hold", source: v.visualSource },
      claims: s.claims, data: s.data, reason: s.reason,
    };
  });
  const captions = timing.groupCaptionLines(input.audio.words);
  let manifest = {
    version: manifestLib.MANIFEST_VERSION, project_id: input.projectId, formats: formats.slice(), notice_required: true,
    ...(input.webTopic ? { notice_required: false, notice: {}, source_line: { sources: sourcesLib.usableSources(input.webTopic.sources).map((x) => ({ title: x.title, url: x.url, published: x.published })), scope_note: input.webTopic.scopeNote || "", text: sourcesLib.sourceLine(input.webTopic.sources, input.webTopic.scopeNote), label: sourcesLib.sourceLabel(input.webTopic.sources) }, verified_numbers: sourcesLib.topicNumbers(input.webTopic) } : { notice: { period: input.notice.period, text: manifestLib.metroListNotice(input.notice.period) }, verified_numbers: reportNumbers(figs) }),
    brand: input.brand,
    figures: figs.filter((f) => used.has(f.ref)).map((f) => ({ ref: f.ref, label: f.label, display: f.display, value: f.value, n: f.n })),
    derived: pl.derived, narration_text: input.narrationTagged,
    audio: { narration_key: input.audio.narration_key, duration_sec: input.audio.duration_sec, ...(input.voiceShape ? { voice_shape: input.voiceShape } : {}) },
    captions, scenes,
  };
  const q = manifestLib.applySmallSampleQualifiers(manifest);
  manifest = q.manifest;
  const validation = manifestLib.validateManifest(manifest);
  return { manifest, edits: q.edits, plan: pl, validation };
}

/** Narration shaping from the environment: AGENT_MARKETING_VOICE_SEMITONES (default -1.5, 0 to -4) and AGENT_MARKETING_VOICE_BASS_DB (default 3, 0 to 8). */
function voiceShapeFrom(env) {
  const num = (v, d) => (v === undefined || v === "" || !Number.isFinite(Number(v)) ? d : Number(v));
  const semitones = Math.max(-4, Math.min(0, num(env.AGENT_MARKETING_VOICE_SEMITONES, -1.5)));
  const bass_db = Math.max(0, Math.min(8, num(env.AGENT_MARKETING_VOICE_BASS_DB, 3)));
  return semitones || bass_db ? { semitones, bass_db } : null;
}

module.exports = { voiceShapeFrom, parseNoticePeriod, voiceIdFor, imageNeeds, buildManifest };
