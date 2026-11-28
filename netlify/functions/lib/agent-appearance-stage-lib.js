// lib/agent-appearance-stage-lib.js — the generated stages of the Agent Appearance Sheet, slice 4 (Nov 27, 2026): what each stage is made from,
// the prompts (from Sam's V2 spec, Oct 23), the style choices and the retry note. Pure functions, no network. Unit-tested.
// Prompt placeholders are filled from what Claude Vision actually saw in the headshot and from the subscriber's own choices; nothing is assumed.
"use strict";
const A = require("./agent-appearance-lib");

// Style: concerns the LOWER body only (trousers, belt, shoes), chosen to go with whatever top is already visible and approved. It is never put in the
// three-quarter prompt, and it never adds or changes a top layer: a style word like "professional" alone made the model add a sports coat (Sam's test, Nov 27).
const STYLES = {
  approachable_local_agent: { label: "Approachable Local Agent", text: "chinos or khakis with casual leather shoes" },
  professional_consultant: { label: "Professional Consultant", text: "tailored dress trousers with dress shoes" },
  modern_ceo: { label: "Modern CEO", text: "slim dark trousers with clean, minimal shoes" },
};
const DEFAULT_STYLE = "approachable_local_agent";
const styleText = (key) => (STYLES[key] || STYLES[DEFAULT_STYLE]).text;

const NOTE_MAX = 300;
/** The subscriber's own words for a retry: trimmed, one line, no control characters, capped. Empty → null. */
function cleanNote(raw) {
  const t = String(raw == null ? "" : raw).replace(/[\u0000-\u001f\u007f]+/g, " ").replace(/\s+/g, " ").trim().slice(0, NOTE_MAX);
  return t || null;
}

// What each single-image stage needs approved first, and which approved images it is made from (in the order the prompt names them: Image 1, Image 2).
const SINGLE_STAGES = {
  three_quarter: { needs: "enhanced_headshot", refs: ["enhanced_headshot"], aspect: "3:4", title: "Three-quarter image" },
  full_body:     { needs: "three_quarter", refs: ["three_quarter", "enhanced_headshot"], aspect: "2:3", title: "Full-length image" },
};

/** "wearing a blue shirt; short gray hair; no glasses" — only what Claude Vision saw in the headshot. */
function describeAttributes(attrs) {
  const a = attrs && typeof attrs === "object" ? attrs : {};
  const bits = [];
  if (a.hair) bits.push(`hair: ${a.hair}`);
  if (a.facial_hair && !/^none$/i.test(a.facial_hair)) bits.push(`facial hair: ${a.facial_hair}`);
  else if (a.facial_hair) bits.push("no facial hair");
  if (a.glasses === "yes") bits.push("glasses"); else if (a.glasses === "no") bits.push("no glasses");
  const clothing = a.clothing || a.shirt;   // sheets saved before Nov 27 recorded only a shirt
  if (clothing) bits.push(`clothing: ${clothing}`);
  return bits.join("; ");
}

const NO_BRANDING = "No badge, name tag, logo, text, extra people or accessories.";
const TEXT = {
  three_quarter: ({ attrs }) =>
    "Create a realistic three-quarter-length studio portrait of the person in Image 1, head through upper legs. Face and grooming must match Image 1" + (attrs ? ` (${attrs})` : "") + ". " +
    "Keep ALL visible clothing unchanged, including any jacket, blazer, sweater or other layer already worn. Do not add any clothing layer that is not visible in Image 1. " +
    "Complete unseen clothing naturally to go with the visible top, as a proposal, not a verified fact. Relaxed arms, natural body proportions, soft studio light, seamless neutral light-gray backdrop. Plain unbranded clothing. " + NO_BRANDING,
  full_body: ({ style }) =>
    "Extend the approved three-quarter portrait (Image 1) to a complete head-to-shoes standing studio photograph. Keep the face, hairstyle, facial hair, torso build and shoulder width consistent with the approved reference; Image 2 is the approved headshot for the face. " +
    "Keep everything the person is wearing from the waist up exactly as in Image 1, including any jacket, blazer or sweater; do not add or remove a layer. " +
    "Complete the lower body to go with that top: " + style + ". Keep any already-approved garment unchanged. Natural stance, arms relaxed, anatomically realistic hands, belt, trousers and shoes. " +
    "No logos, badges or name tags. Uniform soft light and neutral light-gray studio background.",
};

/** The full prompt for a stage. The retry note is added as ONE adjustment, with the likeness held fixed (spec: optional focused correction). */
function buildPrompt(stage, { styleKey, attributes, note } = {}) {
  const f = TEXT[stage];
  if (!f) throw new Error("unknown stage");
  let p = f({ style: styleText(styleKey), attrs: describeAttributes(attributes) });   // the style only reaches the full-length prompt
  const n = cleanNote(note);
  if (n) p += ` Adjustment requested by the subscriber: "${n}". Apply only this adjustment. Preserve the approved facial likeness, hairstyle, facial hair, body proportions, clothing and studio lighting; do not redesign anything else.`;
  return p;
}

module.exports = { STYLES, DEFAULT_STYLE, styleText, NOTE_MAX, cleanNote, SINGLE_STAGES, describeAttributes, buildPrompt };
