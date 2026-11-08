// lib/agent-marketing-b1-fixture-planner-lib.js — Netlify (shared). DEVELOPMENT ONLY (Nov 8, 2026): a deterministic stand-in for the paid
// script-writer model call, for end-to-end tests of "Write my script" on b1-stageb-dev without an Anthropic call.
//
// It returns planner JSON built only from the planner input it is given (the same user message the real model would get), so whatever it states
// is what the evidence pipeline passed through: one validated finding's exact source quotation in an "article" scene, and no other figures.
// The result still goes through generatePlan's normal checks: plan normalization, the content gate (verified text, D1 held-claim and figure checks)
// and the length check. It is clearly marked: narrative.plannerFixture = true and a warning the agent sees.
//
// Available only when ALL hold: AGENT_MARKETING_B1_EVIDENCE=dev, B1_PLANNER=fixture, and the server's database is not the production project.
// Never used by agent-marketing-plan-background (the production planning path).
"use strict";

const b1 = require("./agent-marketing-b1-evidence-lib");
const am = require("./agent-marketing-lib");
const { PRODUCTION_REF } = require("./public-config-lib");

const WARNING = "Development fixture script writer: this script was assembled automatically from the checked article evidence, without the script-writing model. It is for testing only.";

function enabled(env) {
  const e = env || process.env;
  if (!b1.enabled(e)) return false;
  if (String(e.B1_PLANNER || "").trim().toLowerCase() !== "fixture") return false;
  const db = String(e.SUPABASE_URL || "");
  return !!db && !db.includes(PRODUCTION_REF);
}

/** The planner input: the JSON user message (a corrective retry appends plain text after it). */
function inputOf(userText) {
  const s = String(userText || "");
  const end = s.indexOf("\n\nYour ");
  try { return JSON.parse(end > 0 ? s.slice(0, end) : s); } catch (e) { return {}; }
}

const words = (s) => String(s).trim().split(/\s+/).filter(Boolean).length;

/** The one validated finding the fixture states: a figure first, then any claim; quotations of at most 45 words. On a report-first topic (mode 2)
 *  only a quotation without a local market statistic qualifies: those come from the agent's report. */
function pickFinding(ae, reportFirst) {
  const list = ae && Array.isArray(ae.validated_findings) ? ae.validated_findings : [];
  const art = require("./agent-marketing-article-lib");
  const ok = (x) => typeof x === "string" && x.trim() && words(x) <= 45 && (!reportFirst || !art.numberRoles(x).some((n) => n.role === "market"));
  const usable = list.map((f) => ({ f, q: (Array.isArray(f.source_quotes) ? f.source_quotes : []).find(ok) })).filter((x) => x.q);
  return usable.find((x) => x.f.kind === "figure") || usable.find((x) => x.f.kind === "headline_claim") || usable[0] || null;
}

const FILLER = [
  "I look at this the same way I would for my own home, starting with the details that actually move a decision.",
  "It's worth reading closely, because the headline and the full picture are not always the same thing.",
  "So the useful question is how it lines up with what you're seeing on your own street.",
  "That's where a calm, local look at the details helps more than any single headline.",
  "Every home is different, and the right plan depends on your timing and your goals.",
  "I'd rather you have the context now than guess later.",
];

/**
 * planJson(input, durationSec) → the planner JSON (as an object). 30 s: 4 scenes (2 concept images); 45 s: 6 (3); 60 s: 6 (4).
 */
function planJson(input, durationSec) {
  const dur = [30, 45, 60].includes(Number(durationSec)) ? Number(durationSec) : 45;
  const t = (input && input.selected_topic) || {};
  const reportFirst = t.report_is_source_of_truth_for_market_numbers === true;
  const pick = pickFinding(t.article_evidence, reportFirst);
  const figure = Array.isArray(t.figures_you_may_state) && t.figures_you_may_state.length ? String(t.figures_you_may_state[0]).trim() : "";
  const att = pick && typeof pick.f.attribution === "string" && pick.f.attribution.trim() && words(pick.f.attribution) <= 8 ? pick.f.attribution.trim() : "";
  const quote = pick ? pick.q.trim().replace(/\s+/g, " ") : "";
  // The quotation is one sentence of its own: a quotation that stops mid-sentence still ends here, so it never runs into the next scene's words.
  const articleLine = pick ? `${att ? `According to ${att}, ` : "A recent local article reports this: "}${quote}${/[.!?]["”’)]*$/.test(quote) ? "" : "."}` : "A recent local article looked at what is changing here, and it's worth a careful read.";
  const hook = "Here's what I'm watching in the area right now, and why it matters if you're thinking about selling.";
  const close = "If you want to talk through what this means for your home, I'm happy to help.";
  const n = dur === 30 ? 4 : 6;
  // A report figure, stated as the report gives it, in a data scene (modes 1 and 2).
  const dataLine = figure ? `My market report shows this. ${figure}${/[.!?]$/.test(figure) ? "" : "."}` : "";
  const middle = pick || !figure ? [articleLine] : [];
  if (dataLine) middle.push(dataLine);
  for (let i = 0; middle.length < n - 2; i++) middle.push(FILLER[i % FILLER.length]);
  const ex = [hook, ...middle, close];
  // Pad the middle scenes (never the quotation scene) with plain sentences until the spoken length reaches the target's lower bound.
  const [lo] = am.WORD_TARGETS[dur];
  let k = 0;
  while (words(ex.join(" ")) < lo && k < 12) { const i = 2 + (k % Math.max(1, n - 3)); ex[i] = `${ex[i]} ${FILLER[(k + 3) % FILLER.length]}`; k++; }
  const gpt = dur === 30 ? 2 : dur === 45 ? 3 : 4;
  const kinds = ex.map((_, i) => (i === n - 1 ? "BRAND_CARD" : i === n - 2 ? "AGENT_PROFILE" : i < gpt ? "GPT_IMAGE_2_CONCEPT" : "CONCEPT_REUSE"));
  const roles = ["local_hook", "article_point", "context", "insight", "advice", "cta"];
  const scenes = ex.map((x, i) => ({
    role: i === n - 1 ? "cta" : roles[Math.min(i, roles.length - 2)], narration_excerpt: x, purpose: `Scene ${i + 1}`,
    source_role: pick && x === articleLine ? "article" : "data", visual_source: kinds[i], visual_brief: "An ordinary residential street of single-story and two-story homes in soft daylight.",
    reuse_of_scene: kinds[i] === "CONCEPT_REUSE" ? 1 : null, card_text: kinds[i] === "BRAND_CARD" ? "Let's talk about your home" : null, authentic_photo_request: null,
    ai_generation_prompt: kinds[i] === "GPT_IMAGE_2_CONCEPT" ? "Photorealistic editorial view of ordinary single-story and two-story stucco homes on a residential street, soft daylight, no people, no text, wide composition" : null,
    camera_motion: "push_in", framing_9x16: "Centered", framing_16x9: "Centered", text_safe_placement: "lower middle",
  }));
  return { editorial_angle: "What the checked article evidence says, in the agent's voice.", hook, narration_with_audio_tags: `[conversational] ${ex.join(" ")}`,
    scenes, cta_suggestion: close, claims_to_verify: [], missing_agent_inputs: [] };
}

/** callFn with generatePlan's model-call signature: (systemPrompt, userText, key, usageSink) → planner JSON text. No network. */
function createCallFn(durationSec) {
  return async (systemPrompt, userText) => JSON.stringify(planJson(inputOf(userText), durationSec));
}

module.exports = { WARNING, enabled, inputOf, pickFinding, planJson, createCallFn };
