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
// One shared duration contract (Nov 12, 2026, Phase A: behavior-preserving; every value below is the value that was already in force).
//   range      recommended spoken words (production and Test); advisory, never blocks approval
//   devRange   recommended spoken words in the development Test environment, only where it differs from `range`
//   aim        editorial writing aim inside the range (Test only); none where absent
//   editorTarget  words the Test scene editor cuts toward (it runs only above the top of the range); none where the editor does not serve the duration
//   scenes     scene count range (addendum A2)
//   images     generated-image range: GPT_IMAGE_2_CONCEPT + AGENT_SCENE combined. Since Oct 23 ONE wide 16:9 image is generated per scene (the 9:16
//              version is cropped from it), so the same budget that used to buy 2 images x 2 formats now buys up to 4 different images.
// Spoken words per duration (addendum A2). Guidance only; the audio length decides final timing.
// Nov 9, 2026 (development only): measured ElevenLabs narration runs about 2.8 spoken words a second (118 words = 41-42 s), so 60 seconds needs 140-160 words.
// Production keeps `range`; the 30- and 45-second targets are the same everywhere.
// Nov 12, 2026 (Sam): Reels and Shorts, so 60 seconds is a ceiling (the Test top was 155; Phase B, Nov 13, sets it to 151).
// Nov 12, 2026 (Sam, Test only): the 45-second aim is 105-110 words, about 42-44 seconds at the measured pace of about 151 words a minute (not a guaranteed rate).
const DURATION_CONTRACT = {
  30: { range: [55, 70], scenes: [4, 4], images: [2, 3] },
  45: { range: [105, 125], aim: [105, 110], editorTarget: 110, scenes: [5, 6], images: [3, 4] },
  // Nov 13, 2026 (Sam, Phase B, Test only): 60 seconds aims at 140-146 words, advises 133-151, and the editor cuts toward 146 above 151.
  60: { range: [110, 130], devRange: [133, 151], aim: [140, 146], editorTarget: 146, scenes: [6, 8], images: [4, 6] },
};
const fromContract = (pick) => Object.fromEntries(Object.entries(DURATION_CONTRACT).filter(([, c]) => pick(c) !== undefined).map(([d, c]) => [d, pick(c)]));
const WORD_TARGETS = fromContract((c) => c.range);
const DEV_WORD_TARGETS = fromContract((c) => c.devRange || c.range);
const SCENE_RANGES = fromContract((c) => c.scenes);
const IMAGE_RANGES = fromContract((c) => c.images);
const WRITING_AIMS = fromContract((c) => c.aim);
const EDITOR_TARGETS = fromContract((c) => c.editorTarget);
function wordTargets(durationSec, env) {
  const dev = String((env || process.env).AGENT_MARKETING_B1_EVIDENCE || "").trim().toLowerCase() === "dev";
  return (dev ? DEV_WORD_TARGETS : WORD_TARGETS)[durationSec] || (dev ? DEV_WORD_TARGETS : WORD_TARGETS)[45];
}
// Nov 13, 2026 (Sam, Test only): a nonblocking estimate of the narration length from the word count, using the delivery range seen across stored renders
// (2.3 to 2.8 words a second). Advisory text only: it never changes the narration, the voice speed or any timing.
const PACE_WORDS_PER_SECOND = [2.3, 2.8];
function narrationEstimate(words) {
  const n = Math.max(0, Number(words) || 0);
  return [Math.round(n / PACE_WORDS_PER_SECOND[1]), Math.round(n / PACE_WORDS_PER_SECOND[0])];
}
function durationAdvisory(words, durationSec) {
  const [lo, hi] = narrationEstimate(words);
  return `${words} words · Estimated narration ${lo}–${hi} seconds · Target ${durationSec} seconds.`;
}
function devAdvisory(env) { return String((env || process.env).AGENT_MARKETING_B1_EVIDENCE || "").trim().toLowerCase() === "dev"; }
// Development only: AGENT_MARKETING_MARKET_REVIEW=dev routes supported Domus Market Review PDFs to the deterministic reader. Server environment only; no request field turns it on.
function marketReviewEnabled(env) { return String((env || process.env).AGENT_MARKETING_MARKET_REVIEW || "").trim().toLowerCase() === "dev"; }
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
  const [lo, hi] = wordTargets(durationSec);
  const warnings = [];
  if (words < lo) warnings.push(`About ${words} spoken words; a ${durationSec}-second piece usually runs ${lo}–${hi}. It may feel short.`);
  if (words > hi) warnings.push(`About ${words} spoken words; a ${durationSec}-second piece usually runs ${lo}–${hi}. Speech may run long.`);
  if (devAdvisory()) warnings.push(durationAdvisory(words, durationSec)); // Test only (Nov 13, Sam): nonblocking estimate
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
// Nov 12, 2026 (Sam): the article is credited in the on-screen source footer, never in the narration, captions or scene copy, and only when a scene
// actually draws on the article (source_role "article"). A Reel built only on the subscriber's confirmed report needs no article credit. The text is built
// by code from the checked source (title, site and date), like the source line of a web-research Reel. This is the contract field for the renderer.
function sourceCreditFor(project, narrative) {
  const t = project && project.template === "local_market_insider" && project.selected_topic;
  if (!t || !t.b2 || !t.b2.article) return null;
  const scenes = (Array.isArray(narrative && narrative.scenes) ? narrative.scenes : []).map((s, i) => (s && s.sourceRole === "article" ? i : -1)).filter((i) => i >= 0);
  if (!scenes.length) return null;
  const articles = (Array.isArray(t.sources) ? t.sources : []).filter((x) => x && x.kind === "article");
  const text = require("./agent-marketing-sources-lib").sourceLine(articles.slice(0, 1), "");
  return text ? { text, position: "bottom", scenes } : null;
}
// Sets (or removes) narrative.notice, narrative.noticeOverlay and narrative.sourceCredit from the stored topic. A script edit can never drop or change the notice.
function attachNotice(project, narrative) {
  const n = narrative || {};
  const overlay = noticeOverlayFor(project, n);
  if (overlay) { n.notice = overlay.text; n.noticeOverlay = overlay; }
  else { delete n.notice; delete n.noticeOverlay; }
  const credit = sourceCreditFor(project, n);
  if (credit) n.sourceCredit = credit; else delete n.sourceCredit;
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
  marketReviewEnabled,
  PACE_WORDS_PER_SECOND, narrationEstimate, durationAdvisory, DURATIONS, FORMATS, VOICES, MUSIC, DURATION_CONTRACT, WORD_TARGETS, DEV_WORD_TARGETS, SCENE_RANGES, IMAGE_RANGES, WRITING_AIMS, EDITOR_TARGETS, wordTargets, UUID_RE, NOT_EDITABLE_AFTER,
  isEnabledFor, validateCreate, stripAudioTags, countWords, validateNarrative, gateInputFor, topicNotice, noticeOverlayFor, sourceCreditFor, attachNotice,
};
