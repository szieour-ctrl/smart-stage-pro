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
// Music choices. Keys MUST match MUSIC_LIBRARY in build-video-demo.html (the renderer's music library).
const MUSIC = [
  { key: "default", label: "Default: Neutral Ambient" },
  { key: "japandi_calm", label: "Calm Piano" },
  { key: "luxury_cinematic", label: "Cinematic Strings" },
  { key: "modern_uplifting", label: "Warm & Uplifting" },
  { key: "farmhouse_acoustic", label: "Light Acoustic" },
  { key: "paper_lantern_court", label: "Paper Lantern Court" },
  { key: "breezy", label: "Breezy" },
  { key: "aperture_rising", label: "Aperture Rising" },
  { key: "open_house_glow", label: "Open House Glow" },
  { key: "open_door_plans", label: "Open Door Plans" },
  { key: "fresh_keyframes", label: "Fresh Keyframes" },
  { key: "twilight_terrace", label: "Twilight Terrace" },
  { key: "sunshine_tour", label: "Sunshine Tour" },
  { key: "sunshine", label: "Sunshine" },
  { key: "sunlit_keychain", label: "Sunlit Keychain" },
  { key: "none", label: "No music (silent)" },
];
const MUSIC_KEYS = MUSIC.map((m) => m.key);
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
  const music = String(b.music == null || b.music === "" ? "default" : b.music);
  if (!MUSIC_KEYS.includes(music)) return { error: "Choose one of the music options." };
  return { row: { template, duration_sec: duration, formats, voice, music } };
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

// MetroList's required notice comes from the frozen research topic and is attached by code, never by the client or the model.
function topicNotice(project) {
  const t = project && project.template === "local_market_insider" && project.selected_topic;
  return t && typeof t.reportNotice === "string" ? t.reportNotice : "";
}

// On screen, never spoken (Sam, Oct 24-25): the notice sits at the bottom of the opening and the closing scene, together with the agent's
// headshot from their Marketing Profile. This is the contract for the Railway renderer; the text always comes from the frozen topic.
function noticeOverlayFor(project, narrative) {
  const text = topicNotice(project);
  if (!text) return null;
  const count = Array.isArray(narrative && narrative.scenes) ? narrative.scenes.length : 0;
  return { text, position: "bottom", scenes: count > 1 ? [0, count - 1] : [0], showHeadshot: true, headshotSource: "marketing_profile" };
}
// Sets (or removes) narrative.notice and narrative.noticeOverlay from the stored topic. A script edit can never drop or change the notice.
function attachNotice(project, narrative) {
  const n = narrative || {};
  const overlay = noticeOverlayFor(project, n);
  if (overlay) { n.notice = overlay.text; n.noticeOverlay = overlay; }
  else { delete n.notice; delete n.noticeOverlay; }
  return n;
}

// Build the gate input for a stored project + narrative. Text the agent wrote or edited is checked as the agent's own;
// text Claude wrote (source "claude") is held to the stricter rules (no invented claims or numbers).
function gateInputFor(project, narrative, source) {
  const n = narrative || {};
  const base = { template: project.template, intake: project.intake || {}, verified: gate.verifiedFromProject(project) }; // verified: Local Market Insider only, from the stored research topic
  const sceneTexts = (n.scenes || []).map((s) => s.narrationExcerpt).filter(Boolean);
  if (source === "claude") {
    return { ...base, fullPiece: true, generated: { narration: n.captionText || stripAudioTags(n.narrationTagged), captions: n.captionText, sceneTexts, overlays: n.notice ? [n.notice] : [] }, cta: n.cta || null };
  }
  return { ...base, fullPiece: true, userText: { narration: n.captionText || stripAudioTags(n.narrationTagged), ...Object.fromEntries(sceneTexts.map((t, i) => [`sceneText[${i}]`, t])), ...(n.notice ? { notice: n.notice } : {}) }, cta: n.cta || null };
}

const NOT_EDITABLE_AFTER = ["rendering", "rendered", "published"];

module.exports = {
  DURATIONS, FORMATS, VOICES, MUSIC, WORD_TARGETS, UUID_RE, NOT_EDITABLE_AFTER,
  isEnabledFor, validateCreate, stripAudioTags, countWords, validateNarrative, gateInputFor, topicNotice, noticeOverlayFor, attachNotice,
};
