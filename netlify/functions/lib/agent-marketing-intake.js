// lib/agent-marketing-intake.js — Netlify (shared, pure functions)
// Agent Marketing intake schema and validation (Oct 22, 2026). v1 = Local Market Insider only.
//
// The agent's own observation is the source of authority; the other fields are easy multiple choice.
// The schema is served to the browser by agent-marketing-project.js (?schema=1) so the page never keeps a second copy.
// Anything not in the schema is dropped by validateIntake(), so property-sale fields cannot ride along in `intake`.
"use strict";

const AUDIENCES = ["Home sellers", "Home buyers", "Both buyers and sellers"];
// Spec: Make a better decision / Compare options / Ask for a local perspective. "Understand the trade-off" comes from
// the sample prototype and is kept so the reference Roseville example is still expressible.
const ACTIONS = ["Make a better decision", "Compare options", "Ask for a local perspective", "Understand the trade-off"];

const LOCAL_MARKET_INSIDER = {
  template: "local_market_insider",
  label: "Local Market Insider",
  angles: {
    seller: {
      label: "What most sellers overlook",
      issueQuestion: "What are sellers overlooking?",
      issues: ["Pricing for today's buyers", "Preparation before listing", "Competition from nearby homes", "Timing their move"],
      observationPrompt: "What specific seller mistake or overlooked detail have you seen?",
      observationHint: "e.g. Sellers reference past sales but overlook nearby active listings",
      flow: "Overlooked factor → Why it matters now → Practical agent guidance → Helpful next step",
    },
    buyer: {
      label: "What buyers should know before purchasing",
      issueQuestion: "What should buyers understand first?",
      issues: ["True monthly payment", "Neighborhood trade-offs", "Condition and future expenses", "New construction vs resale"],
      observationPrompt: "What practical advice would you give a buyer?",
      observationHint: "e.g. Compare total ownership cost, not just the asking price",
      flow: "Unexpected reality → Consequence for buyers → Smart comparison → Helpful next step",
    },
    neighborhood: {
      label: "Why nearby neighborhoods perform differently",
      issueQuestion: "What creates the biggest difference?",
      issues: ["Location and access", "Home age and condition", "Floor plans and lot sizes", "Supply and buyer demand"],
      observationPrompt: "Which neighborhoods are you comparing, and what is the actual difference?",
      observationHint: "e.g. Older Roseville and West Roseville have different housing stock",
      flow: "Apparent similarity → Specific difference → Implication for buyers/sellers → Helpful next step",
    },
    misconception: {
      label: "A costly local-market misconception",
      issueQuestion: "What misconception do you hear?",
      issues: ["My neighbor's sale sets my price", "New homes always cost more", "A price cut always means a problem", "Every neighborhood follows the same market"],
      observationPrompt: "What is the misconception missing?",
      observationHint: "e.g. Current active competition and payment sensitivity affect offers",
      flow: "Common belief → Correction → Real-world consequence → Better decision",
    },
    opportunity: {
      label: "An emerging local opportunity",
      issueQuestion: "What opportunity are you noticing?",
      issues: ["More buyer negotiating room", "Underappreciated neighborhoods", "Builder incentives", "Homes with improvement potential"],
      observationPrompt: "What have you personally observed that supports the opportunity?",
      observationHint: "e.g. Specific builder incentives on recent quick-move-in releases",
      flow: "Observed change → Grounded evidence → Who may benefit → Responsible next step",
    },
  },
};

const SCHEMAS = { local_market_insider: LOCAL_MARKET_INSIDER };

const LIMITS = { market: 60, observation: 600 };

// Strip control characters and collapse whitespace; keep ordinary punctuation, quotes and emoji out of the way.
function cleanText(v, max) {
  const s = String(v == null ? "" : v).replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g, " ").replace(/[ \t]+/g, " ").replace(/\s*\n\s*/g, "\n").trim();
  return s.length > max ? s.slice(0, max) : s;
}

function schemaFor(template) { return SCHEMAS[template] || null; }

/**
 * validateIntake(template, values) → { ok, errors: [{field, message}], clean, needsInput: [field] }
 * `clean` contains ONLY the known keys. A blank observation is allowed but listed in needsInput: Claude must then
 * write cautious general framing and flag the missing evidence instead of inventing a firsthand story.
 */
function validateIntake(template, values) {
  const schema = schemaFor(template);
  if (!schema) return { ok: false, errors: [{ field: "template", message: "Unknown template." }], clean: {}, needsInput: [] };
  const v = values && typeof values === "object" ? values : {};
  const errors = [];
  const clean = {};

  const angleKey = String(v.angle || "");
  const angle = schema.angles[angleKey];
  if (!angle) errors.push({ field: "angle", message: "Choose an insider angle." });
  else clean.angle = angleKey;

  clean.market = cleanText(v.market, LIMITS.market);
  if (!clean.market) errors.push({ field: "market", message: "Enter the city, neighborhood or ZIP this is about." });
  else if (String(v.market || "").trim().length > LIMITS.market) errors.push({ field: "market", message: `Keep the market to ${LIMITS.market} characters or fewer.` });

  clean.audience = String(v.audience || AUDIENCES[0]);
  if (!AUDIENCES.includes(clean.audience)) errors.push({ field: "audience", message: "Choose an audience from the list." });

  clean.issue = String(v.issue || "");
  if (angle) {
    if (!angle.issues.includes(clean.issue)) errors.push({ field: "issue", message: "Choose an issue from the list." });
  }

  clean.action = String(v.action || ACTIONS[0]);
  if (!ACTIONS.includes(clean.action)) errors.push({ field: "action", message: "Choose what you want viewers to do." });

  clean.observation = cleanText(v.observation, LIMITS.observation + 1);
  if (clean.observation.length > LIMITS.observation) {
    errors.push({ field: "observation", message: `Keep your observation to ${LIMITS.observation} characters or fewer.` });
    clean.observation = clean.observation.slice(0, LIMITS.observation);
  }

  const needsInput = [];
  if (!clean.observation) needsInput.push("observation");
  return { ok: errors.length === 0, errors, clean, needsInput };
}

module.exports = { AUDIENCES, ACTIONS, LIMITS, SCHEMAS, schemaFor, validateIntake, cleanText };
