// lib/agent-appearance-stage-lib.js — the generated stages of the Agent Appearance Sheet, slice 4 (Nov 27, 2026): what each stage is made from,
// the prompts (from Sam's V2 spec, Oct 23), the style choices and the retry note. Pure functions, no network. Unit-tested.
// Prompt placeholders are filled from what Claude Vision actually saw in the headshot and from the subscriber's own choices; nothing is assumed.
"use strict";
const A = require("./agent-appearance-lib");

// The subscriber says what they wear from the waist down (asked at the three-quarter step) and, later, their shoes. The model is never left to guess a garment
// (Sam's tests: it picked casual trousers with no belt; a style word alone added a sports coat). Quick picks only fill the box; the subscriber can type anything.
const LOWER_PICKS = ["Dress trousers with a belt", "Chinos with a belt", "Dark jeans with a belt", "A knee-length skirt"];
const OUTFIT_MAX = 120, SHOES_MAX = 80, HEIGHT_MAX = 30;
const oneLine = (raw, max) => { const t = String(raw == null ? "" : raw).replace(/[\u0000-\u001f\u007f]+/g, " ").replace(/\s+/g, " ").trim().slice(0, max); return t || null; };
const cleanOutfit = (raw) => oneLine(raw, OUTFIT_MAX);
const cleanShoes = (raw) => oneLine(raw, SHOES_MAX);
const cleanHeight = (raw) => oneLine(raw, HEIGHT_MAX);   // the subscriber's own words, e.g. 5'9" or 175 cm; never inferred

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

// The multi-panel stages: ONE generation each, cut with Sharp into separately usable pictures. All three need the approved full-length image and headshot, and none needs another.
const COMPOSITE_STAGES = {
  angles: { needs: "full_body", refs: ["enhanced_headshot", "full_body"], aspect: "3:2", grid: { cols: 3, rows: 1 }, title: "Three angles", noun: "angles",
    labels: ["Front", "Turned toward left", "Turned toward right"], intro: "One image with three full-length views of you: front, then turned about 45 degrees toward the left and toward the right of the picture. There is no rear view." },
  expressions: { needs: "full_body", refs: ["enhanced_headshot", "full_body"], aspect: "3:2", grid: { cols: 3, rows: 2 }, title: "Six expressions", noun: "expressions",
    labels: ["Warm smile", "Neutral professional", "Curious", "Engaged and listening", "Confident and approachable", "Conversational"], intro: "One image with six head-and-shoulders expressions, cut into six separate pictures." },
  poses: { needs: "full_body", refs: ["enhanced_headshot", "full_body"], aspect: "1:1", grid: { cols: 2, rows: 2 }, title: "Four poses", noun: "poses",
    labels: ["Standing, presenting", "Seated at a desk", "Standing with a folder", "Seated, listening"], intro: "One image with four professional poses, cut into four separate pictures." },
};
const ALL_STAGES = { ...SINGLE_STAGES, ...COMPOSITE_STAGES };

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
const FACE_AND_OUTFIT = "Image 1 is the approved headshot and controls the face, hairline, beard, eye shape, nose, mouth and apparent age; Image 2 is the approved full-length image and controls the body proportions and the exact outfit. ";
const TEXT = {
  angles: ({ attrs }) =>
    "Create ONE three-panel full-body studio contact sheet showing the same approved person. Panel 1 (left): front-facing, squared to the camera. " +
    "Panel 2 (middle): the body rotated about 45 degrees so the chest and toes point toward the LEFT edge of the image; the person's own LEFT shoulder and LEFT eye are the ones nearest the camera, and the face is turned toward the camera. " +
    "Panel 3 (right): the body rotated about 45 degrees the OPPOSITE way, so the chest and toes point toward the RIGHT edge of the image; the person's own RIGHT shoulder and RIGHT eye are the ones nearest the camera, and the face is turned toward the camera. " +
    "The two side panels must not match: panel 2 and panel 3 show the person turned in opposite directions. Do not copy the body angle of Image 2 into either panel. " + FACE_AND_OUTFIT +
(attrs ? `Visible features to keep: ${attrs}. ` : "") + "Every panel head-to-shoes, same scale, same exact approved outfit, hairstyle, grooming, background and soft studio lighting. No alternate wardrobe, labels, badges, logos, text, props, furniture or additional people.",
  expressions: ({ attrs }) =>
    "Create ONE 3-column x 2-row contact sheet of six head-and-shoulders portraits of the SAME person. " + FACE_AND_OUTFIT + (attrs ? `Visible features to keep: ${attrs}. ` : "") +
    "Expressions left-to-right, top-to-bottom: (1) warm, welcoming smile, (2) neutral professional, (3) CURIOUS with subtle raised-brow interest, (4) engaged and listening, (5) confident and approachable, (6) conversational, as if speaking. " +
    "Keep the exact face, clothing, shoulders, camera distance and soft studio lighting consistent. Hands and arms BELOW frame; curiosity must be expressed by the FACE, not a hand-on-chin pose. Neutral light-gray background. No logos, name tags, badges, objects, text, extra people or scene changes.",
  poses: ({ attrs }) =>
    "Create ONE 2 x 2 professional pose contact sheet of the SAME person. " + FACE_AND_OUTFIT + (attrs ? `Visible features to keep: ${attrs}. ` : "") +
    "Poses: TOP LEFT standing in a three-quarter stance with a natural open-palm conversational presenting gesture; TOP RIGHT seated at a simple desk reviewing one blank document; BOTTOM LEFT standing holding one plain notebook or folder; BOTTOM RIGHT seated in a plain chair, attentive and listening. " +
    "Natural hand anatomy, realistic body proportions, the same garments and grooming in every panel. Soft studio lighting, neutral light-gray background. Only the desk, chair or one prop strictly required by the named pose; no furnished rooms, decorative settings, extra people, branding, labels, name badges, logos or text.",
  three_quarter: ({ attrs, lower }) =>
    "Create a realistic three-quarter-length studio portrait of the person in Image 1, head through upper legs. Face and grooming must match Image 1" + (attrs ? ` (${attrs})` : "") + ". " +
    "Keep ALL visible clothing unchanged, including any jacket, blazer, sweater or other layer already worn. Do not add any clothing layer that is not visible in Image 1. " +
    `Lower body, exactly as the subscriber described: ${lower}. Show it clearly, including the belt if one is named. ` +
    "Relaxed arms, natural body proportions, soft studio light, seamless neutral light-gray backdrop. Plain unbranded clothing. " + NO_BRANDING,
  full_body: ({ shoes, height }) =>
    "Extend the approved three-quarter portrait (Image 1) to a complete head-to-shoes standing studio photograph. Keep the face, hairstyle, facial hair, torso build and shoulder width consistent with the approved reference; Image 2 is the approved headshot for the face. " +
    "Keep everything the person is wearing in Image 1 exactly as it is, including any jacket, blazer or sweater, the trousers or skirt and the belt; do not add, remove or change a garment. " +
    `Add only the shoes: ${shoes || "plain shoes that go with the outfit"}. ` +
    "Natural, realistic adult body proportions: arms end near mid-thigh and the legs are about half of the total height; do not elongate the limbs. " + (height ? `The person's height is ${height}. ` : "") +
    "Natural stance, arms relaxed, anatomically realistic hands. No logos, badges or name tags. Uniform soft light and neutral light-gray studio background.",
};

/** The full prompt for a stage. The retry note is added as ONE adjustment, with the likeness held fixed (spec: optional focused correction). */
function buildPrompt(stage, { attributes, note, lowerBody, shoes, height } = {}) {
  const f = TEXT[stage];
  if (!f) throw new Error("unknown stage");
  const lower = cleanOutfit(lowerBody);
  if (stage === "three_quarter" && !lower) throw new Error("the lower-body outfit is required");
  let p = f({ attrs: describeAttributes(attributes), lower, shoes: cleanShoes(shoes), height: cleanHeight(height) });
  const n = cleanNote(note);
  if (n) p += ` Adjustment requested by the subscriber: "${n}". Apply only this adjustment. Preserve the approved facial likeness, hairstyle, facial hair, clothing and studio lighting; do not redesign anything else.`;
  return p;
}

module.exports = { COMPOSITE_STAGES, ALL_STAGES, LOWER_PICKS, OUTFIT_MAX, SHOES_MAX, cleanOutfit, cleanShoes, cleanHeight, HEIGHT_MAX, NOTE_MAX, cleanNote, SINGLE_STAGES, describeAttributes, buildPrompt };
