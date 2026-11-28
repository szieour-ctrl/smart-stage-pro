// lib/agent-appearance-stage-lib.js — the generated stages of the Agent Appearance Sheet, slice 4 (Nov 27, 2026): what each stage is made from,
// the prompts (from Sam's V2 spec, Oct 23), the style choices and the retry note. Pure functions, no network. Unit-tested.
// Prompt placeholders are filled from what Claude Vision actually saw in the headshot and from the subscriber's own choices; nothing is assumed.
"use strict";
const A = require("./agent-appearance-lib");

// The subscriber says what they wear from the waist down (asked at the three-quarter step) and, later, their shoes. The model is never left to guess a garment
// (Sam's tests: it picked casual trousers with no belt; a style word alone added a sports coat). Quick picks only fill the box; the subscriber can type anything.
const LOWER_PICKS = ["Dress trousers with a belt", "Chinos with a belt", "Dark jeans with a belt", "A knee-length skirt"];
const OUTFIT_MAX = 120, SHOES_MAX = 80;
const oneLine = (raw, max) => { const t = String(raw == null ? "" : raw).replace(/[\u0000-\u001f\u007f]+/g, " ").replace(/\s+/g, " ").trim().slice(0, max); return t || null; };
const cleanOutfit = (raw) => oneLine(raw, OUTFIT_MAX);
const cleanShoes = (raw) => oneLine(raw, SHOES_MAX);

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
  three_quarter: ({ attrs, lower }) =>
    "Create a realistic three-quarter-length studio portrait of the person in Image 1, head through upper legs. Face and grooming must match Image 1" + (attrs ? ` (${attrs})` : "") + ". " +
    "Keep ALL visible clothing unchanged, including any jacket, blazer, sweater or other layer already worn. Do not add any clothing layer that is not visible in Image 1. " +
    `Lower body, exactly as the subscriber described: ${lower}. Show it clearly, including the belt if one is named. ` +
    "Relaxed arms, natural body proportions, soft studio light, seamless neutral light-gray backdrop. Plain unbranded clothing. " + NO_BRANDING,
  full_body: ({ shoes }) =>
    "Extend the approved three-quarter portrait (Image 1) to a complete head-to-shoes standing studio photograph. Keep the face, hairstyle, facial hair, torso build and shoulder width consistent with the approved reference; Image 2 is the approved headshot for the face. " +
    "Keep everything the person is wearing in Image 1 exactly as it is, including any jacket, blazer or sweater, the trousers or skirt and the belt; do not add, remove or change a garment. " +
    `Add only the shoes: ${shoes || "plain shoes that go with the outfit"}. ` +
    "Natural stance, arms relaxed, anatomically realistic hands. No logos, badges or name tags. Uniform soft light and neutral light-gray studio background.",
};

/** The full prompt for a stage. The retry note is added as ONE adjustment, with the likeness held fixed (spec: optional focused correction). */
function buildPrompt(stage, { attributes, note, lowerBody, shoes } = {}) {
  const f = TEXT[stage];
  if (!f) throw new Error("unknown stage");
  const lower = cleanOutfit(lowerBody);
  if (stage === "three_quarter" && !lower) throw new Error("the lower-body outfit is required");
  let p = f({ attrs: describeAttributes(attributes), lower, shoes: cleanShoes(shoes) });
  const n = cleanNote(note);
  if (n) p += ` Adjustment requested by the subscriber: "${n}". Apply only this adjustment. Preserve the approved facial likeness, hairstyle, facial hair, body proportions, clothing and studio lighting; do not redesign anything else.`;
  return p;
}

module.exports = { LOWER_PICKS, OUTFIT_MAX, SHOES_MAX, cleanOutfit, cleanShoes, NOTE_MAX, cleanNote, SINGLE_STAGES, describeAttributes, buildPrompt };
