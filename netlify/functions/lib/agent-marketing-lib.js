// lib/agent-marketing-lib.js — Netlify (shared helpers for Agent Marketing)
// Feature switch, project validation, narrative handling. Pure functions are unit-tested (tests/agent-marketing-lib.test.js);
// the database helpers use the same supabase() wrapper as the rest of the app.
"use strict";

const gate = require("./agent-marketing-gate");
const intakeLib = require("./agent-marketing-intake");

const DURATIONS = [30, 45, 60];
const FORMATS = ["9x16", "16x9"];
// v1 voices: SSP Male / SSP Female. "custom" (subscriber's own ElevenLabs voice) is in the table's check constraint
// already but is rejected here until the encrypted-credential work is built.
const VOICES = ["ssp_male", "ssp_female"];
// Spoken words per duration (addendum A2). Guidance only; the audio length decides final timing.
const WORD_TARGETS = { 30: [55, 70], 45: [85, 100], 60: [110, 130] };
const CTA_SOURCES_FROM_CLIENT = ["user_edited", "user_inserted"];
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// AGENT_MARKETING_ENABLED=true turns the feature on. If AGENT_MARKETING_USER_IDS (comma-separated user ids) is set,
// only those users get it. Unset or anything else = off, and the endpoints answer as if they do not exist.
function isEnabledFor(userId, env) {
  const e = env || process.env;
  if (String(e.AGENT_MARKETING_ENABLED || "").trim().toLowerCase() !== "true") return false;
  const ids = String(e.AGENT_MARKETING_USER_IDS || "").split(",").map((s) => s.trim().toLowerCase()).filter(Boolean);
  return ids.length === 0 || ids.includes(String(userId || "").toLowerCase());
}

function validateCreate(body) {
  const b = body && typeof body === "object" ? body : {};
  const template = String(b.template || "local_market_insider");
  if (!gate.TEMPLATES.includes(template)) return { error: "Unknown template." };
  if (!gate.ENABLED_TEMPLATES.includes(template)) return { error: "This template is not available yet." };
  const duration = b.durationSec == null ? 45 : Number(b.durationSec);
  if (!DURATIONS.includes(duration)) return { error: "Choose a 30, 45 or 60 second length." };
  let formats = b.formats;
  if (formats === "both" || formats === "Both" || formats == null) formats = FORMATS.slice();
  if (typeof formats === "string") formats = [formats];
  if (!Array.isArray(formats) || formats.length === 0 || !formats.every((f) => FORMATS.includes(f))) return { error: "Choose 9:16, 16:9 or both." };
  formats = FORMATS.filter((f) => formats.includes(f)); // stable order, no duplicates
  const voice = String(b.voice || "ssp_male");
  if (!VOICES.includes(voice)) return { error: voice === "custom" ? "Your own ElevenLabs voice is coming soon." : "Choose SSP Male or SSP Female." };
  return { row: { template, duration_sec: duration, formats, voice } };
}

// Audio tags such as [warm] or [emphasis] are delivery cues for ElevenLabs. They must never reach a caption.
function stripAudioTags(text) {
  return String(text == null ? "" : text).replace(/\[[^\]\n]{1,40}\]/g, " ").replace(/[ \t]+/g, " ").replace(/\s+([,.;:!?])/g, "$1").replace(/\s*\n\s*/g, "\n").trim();
}
function countWords(text) {
  const t = stripAudioTags(text).replace(/\.{2,}/g, " ");
  const m = t.match(/[A-Za-z0-9À-ɏ][A-Za-z0-9À-ɏ'’\-]*/g);
  return m ? m.length : 0;
}

/**
 * validateNarrative(body, durationSec) → { error } | { narrative, warnings }
 * The caption text is ALWAYS derived from the tagged narration (never taken from the client), so captions are exactly the
 * spoken words with the audio tags removed.
 */
function validateNarrative(body, durationSec) {
  const b = body && typeof body === "object" ? body : {};
  const tagged = String(b.narrationTagged == null ? "" : b.narrationTagged).replace(/\r/g, "").trim();
  if (!tagged) return { error: "The narration is empty." };
  if (tagged.length > 2500) return { error: "The narration is too long." };
  const captionText = stripAudioTags(tagged);
  const words = countWords(tagged);
  const [lo, hi] = WORD_TARGETS[durationSec] || WORD_TARGETS[45];
  const warnings = [];
  if (words < lo) warnings.push(`About ${words} spoken words; a ${durationSec}-second piece usually runs ${lo}–${hi}. It may feel short.`);
  if (words > hi) warnings.push(`About ${words} spoken words; a ${durationSec}-second piece usually runs ${lo}–${hi}. Speech may run long.`);
  const ctaText = intakeLib.cleanText(b.cta && b.cta.text, 80);
  const ctaSource = CTA_SOURCES_FROM_CLIENT.includes(b.cta && b.cta.source) ? b.cta.source : "user_edited";
  const scenes = Array.isArray(b.scenes) ? b.scenes.slice(0, 12).map((s, i) => ({
    index: i,
    role: intakeLib.cleanText(s && s.role, 40),
    narrationExcerpt: intakeLib.cleanText(s && s.narrationExcerpt, 400),
    visualSource: s && ["GPT_IMAGE_2_CONCEPT", "AGENT_SCENE", "CONCEPT_REUSE", "AGENT_PROFILE", "BRAND_CARD"].includes(s.visualSource) ? s.visualSource : "AUTHENTIC_AGENT_ASSET",
    visualBrief: intakeLib.cleanText(s && s.visualBrief, 400),
  })) : [];
  return {
    narrative: { narrationTagged: tagged, captionText, wordCount: words, cta: ctaText ? { text: ctaText, source: ctaSource } : null, scenes },
    warnings,
  };
}

// Build the gate input for a stored project + narrative. Text the agent wrote or edited is checked as the agent's own;
// text Claude wrote (source "claude") is held to the stricter rules (no invented claims or numbers).
function gateInputFor(project, narrative, source) {
  const n = narrative || {};
  const base = { template: project.template, intake: project.intake || {} };
  const sceneTexts = (n.scenes || []).map((s) => s.narrationExcerpt).filter(Boolean);
  if (source === "claude") {
    return { ...base, generated: { narration: n.captionText || stripAudioTags(n.narrationTagged), captions: n.captionText, sceneTexts, overlays: [] }, cta: n.cta || null };
  }
  return { ...base, userText: { narration: n.captionText || stripAudioTags(n.narrationTagged), ...Object.fromEntries(sceneTexts.map((t, i) => [`sceneText[${i}]`, t])) }, cta: n.cta || null };
}

const NOT_EDITABLE_AFTER = ["rendering", "rendered", "published"];

module.exports = {
  DURATIONS, FORMATS, VOICES, WORD_TARGETS, UUID_RE, NOT_EDITABLE_AFTER,
  isEnabledFor, validateCreate, stripAudioTags, countWords, validateNarrative, gateInputFor,
};
