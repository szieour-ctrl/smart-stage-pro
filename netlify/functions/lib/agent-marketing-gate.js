// lib/agent-marketing-gate.js — Netlify (shared, pure functions, no network or database access)
// Smart Stage PRO™ Agent Marketing — Non-Property-Sale Content Policy (Oct 22, 2026)
//
// Agent Marketing templates are for educational, professional, general real estate marketing and social content.
// They are NOT property-sale ads. Property-sale campaigns use the Listing Video / Listing Reel workflows
// (which burn AB 723 badges and publish to the Property Compliance Page).
//
// Three controls (Sam, Oct 22):
//   1. Template purpose  — no listing ID, MLS number, address, price, availability, open-house or sale CTA.
//   2. Content integrity — Claude cannot invent results, testimonials, numbers, staging outcomes or property facts.
//                          Anything the AGENT typed themselves passes through and is recorded as an agent-supplied
//                          claim (covered by the attestation checkbox).
//   3. Media authorization — one checkbox, handled elsewhere (see ATTESTATION_TEXT / ATTESTATION_VERSION).
//
// This module is the deterministic server-side check. It runs at storyboard approval and again before render, on
// the intake answers, Claude's script, captions, CTA and any overlay text. It never calls an AI model.
//
// Result shape: { ok, version, blocks: [issue], warnings: [issue], agentSuppliedClaims: [string] }
//   issue = { rule, field, match, message }
// `ok` is false when there is at least one block. Warnings never block; they are stored on the advertising record.

"use strict";

const GATE_VERSION = "2026-10-24.1";

// One checkbox, extending the existing Reel advertising-accuracy confirmation. Store the version with the timestamp.
const ATTESTATION_VERSION = "agent-marketing-1";
const ATTESTATION_TEXT =
  "I confirm that I have reviewed and approved this marketing content, that the information I provided is accurate " +
  "and complies with applicable advertising requirements, and that I have the right to use the submitted images and materials.";

const TEMPLATES = [
  "meet_your_agent", "why_list_with_me", "your_buyer_advantage", "new_construction_specialist",
  "active_adult_55_specialist", "my_proven_process", "agent_review_highlights", "local_market_insider",
];
// v1 ships Local Market Insider only (Sam, Oct 21). Widen this list as each template is built.
const ENABLED_TEMPLATES = ["local_market_insider"];

// ── Structural control: property-sale fields are never accepted anywhere in an Agent Marketing payload ──
const FORBIDDEN_KEYS = new Set([
  "listingid", "listing_id", "mls", "mlsnumber", "mls_number", "mlsid", "mls_id", "mlsurl", "mls_listing_url",
  "address", "propertyaddress", "property_address", "streetaddress", "street_address",
  "price", "listprice", "list_price", "askingprice", "asking_price", "saleprice", "sale_price", "newprice", "oldprice",
  "rent", "openhouse", "open_house", "opendate", "availability", "showinginstructions", "showing_instructions",
]);

function findForbiddenKeys(obj, path, out, depth) {
  if (!obj || typeof obj !== "object" || depth > 6) return;
  if (Array.isArray(obj)) { obj.forEach((v, i) => findForbiddenKeys(v, `${path}[${i}]`, out, depth + 1)); return; }
  for (const [k, v] of Object.entries(obj)) {
    const norm = k.toLowerCase().replace(/[\s-]/g, "");
    if (FORBIDDEN_KEYS.has(norm) && v !== null && v !== undefined && v !== "") out.push(`${path}${path ? "." : ""}${k}`);
    findForbiddenKeys(v, `${path}${path ? "." : ""}${k}`, out, depth + 1);
  }
}

// ── Text rules ─────────────────────────────────────────────────────────────────────────────────────────────────
const STREET_SUFFIX = "St|Street|Ave|Avenue|Blvd|Boulevard|Dr|Drive|Rd|Road|Ln|Lane|Ct|Court|Way|Pl|Place|Cir|Circle|Ter|Terrace|Pkwy|Parkway|Hwy|Loop|Trl|Trail";
const BLOCK_RULES = [
  { rule: "mls_reference", message: "Mentions an MLS number or listing ID.",
    re: /\b(?:MLS|listing)\s*(?:#|no\.?|number|id)\s*[:#]?\s*[A-Za-z0-9-]{4,}|\bMLS\s*[:#]\s*[A-Za-z0-9-]{4,}/i },
  { rule: "street_address", message: "Looks like a specific property address.",
    // Capitalized street name (case-sensitive), or a 3+ digit house number followed by up to 3 words and a street suffix.
    re: new RegExp(`\\b\\d{2,6}\\s+(?:[NSEW]\\.?\\s+)?(?:[A-Z][A-Za-z0-9'.-]*\\s+){1,3}(?:${STREET_SUFFIX})\\b`) },
  { rule: "street_address", message: "Looks like a specific property address.",
    re: new RegExp(`\\b\\d{3,6}\\s+(?:[NSEWnsew]\\.?\\s+)?(?:[A-Za-z0-9'.-]+\\s+){1,3}(?:${STREET_SUFFIX.toLowerCase()})\\b`, "i") },
  { rule: "listing_price", message: "States a listing-specific price.",
    re: /\b(?:listed|asking|reduced|marked\s+down)\s+(?:at|for|to)\s*\$\s?\d|\blist(?:ing)?\s+price\b|\bnew\s+price\s*[:\-]\s*\$/i },
  { rule: "listing_announcement", message: "Reads like a listing announcement. Use a Listing Reel for a specific home.",
    re: /\b(?:just\s+listed|new\s+listing|coming\s+soon|now\s+selling|under\s+contract|just\s+sold|back\s+on\s+(?:the\s+)?market|price\s+(?:drop|improvement|reduction|cut)|open\s+house)\b/i },
  { rule: "property_availability", message: "Describes a particular home as currently available.",
    re: /\b(?:this|the|our)\s+(?:home|house|property|listing|condo|townhome|townhouse)\s+(?:is|'s)\s+(?:now\s+|currently\s+|still\s+)?(?:available|on\s+the\s+market|for\s+sale|for\s+rent|for\s+lease|listed)\b/i },
  { rule: "property_sale_cta", message: "Contains a property-sale call to action.",
    re: /\b(?:schedule|book|request|set\s+up)\s+(?:a\s+)?(?:private\s+)?(?:tour|showing|viewing)\b|\bmake\s+an\s+offer\b|\bsee\s+this\s+(?:home|house|property)\b/i },
];

// Ambiguous in educational copy ("when your home is for sale"): warn, never block.
const WARN_RULES = [
  { rule: "price_wording", message: "Mentions a price; make sure it is general market context, not one home's price.",
    re: /\b(?:priced|offered)\s+(?:at|for|to)\s*\$\s?\d/i },
  { rule: "sale_language", message: "Uses sale/lease wording; make sure it is general, not about one home.",
    re: /\bfor\s+(?:sale|lease|rent)\b/i },
];

// Fair Housing: steering language. Blocks Claude's output (it can regenerate); warns on text the agent typed.
const FAIR_HOUSING = [
  { rule: "fair_housing", message: "Possible Fair Housing steering language.",
    re: /\b(?:perfect|ideal|great|best)\s+for\s+(?:young\s+)?(?:families|singles|couples|bachelors?|retirees|seniors)\b|\bno\s+(?:kids|children)\b|\badults?\s+only\b|\b(?:safe|exclusive|desirable)\s+(?:neighborhood|area|community)\b|\b(?:good|great|top|best|excellent)\s+schools?\b/i },
];

// Claude may not originate results, testimonials or client stories (control 2).
const CLAIM_RULES = [
  { rule: "transaction_result", message: "States a sale result that the agent did not provide.",
    re: /\bsold\s+(?:in|within|over|above|for|at)\b|\b(?:over|above|under)\s+asking\b|\bmultiple\s+offers\b|\bdays\s+on\s+market\b|\bclosed\s+(?:in|within)\b/i },
  { rule: "client_story", message: "Describes a client or client result that the agent did not provide.",
    re: /\b(?:my|our|past|recent|happy)\s+clients?\b|\bclients?\s+(?:said|told|loved|saw|got|received)\b|\btestimonial\b|\bfive[-\s]?star\b|\b5[-\s]?star\b/i },
  { rule: "staging_outcome", message: "Claims a staging result that the agent did not provide.",
    re: /\b(?:staging|staged)\b[^.!?]{0,60}\b(?:sold|sell|sells|selling|increased|boosted|raised|added)\b/i },
];

const norm = (s) => String(s == null ? "" : s).replace(/[‘’]/g, "'").replace(/[“”]/g, '"').replace(/\s+/g, " ").trim();
const lower = (s) => norm(s).toLowerCase();

function snippet(m) { return norm(m[0]).slice(0, 80); }

function scan(text, field, rules, bucket) {
  const t = norm(text);
  if (!t) return;
  for (const r of rules) {
    const m = t.match(r.re);
    if (m) bucket.push({ rule: r.rule, field, match: snippet(m), message: r.message });
  }
}

// ── Verified facts (Local Market Insider only, Oct 24) ──────────────────────────────────────────────────────────
// Local Market Insider scripts are built on a research topic whose sources were checked server-side (https, dated,
// fresh, not paywalled; events with a real date, time, venue and organizer). Text that traces to that frozen topic is
// "verified": its figures, market vocabulary and event venue address are allowed in Claude's output. Everything that
// does NOT trace to the topic (or to what the agent typed) is still blocked exactly as before. Other templates never
// receive verified facts, and the client cannot supply them: callers derive them from the stored project row.
const VERIFIED_TEMPLATE = "local_market_insider";

/**
 * verifiedFromTopic(topic) → { texts: [string], addresses: [string] } | null
 * `topic` is the frozen selected_topic saved by agent-marketing-research.js (question, whyItMatters, trendSignals,
 * scopeNote, sources, event). Only fields the research validator already checked are used.
 */
function verifiedFromTopic(topic) {
  const t = topic && typeof topic === "object" ? topic : null;
  if (!t || !Array.isArray(t.sources) || t.sources.length === 0) return null; // no validated source, nothing is verified
  const texts = [t.question, t.whyItMatters, t.scopeNote, ...(Array.isArray(t.trendSignals) ? t.trendSignals : [])];
  const addresses = [];
  const e = t.event && typeof t.event === "object" ? t.event : null;
  if (e) {
    texts.push(e.name, e.date, e.endDate, e.time, e.location, e.organizer);
    if (e.location) addresses.push(e.location);
  }
  const clean = texts.filter((x) => typeof x === "string" && x.trim()).map(norm);
  return clean.length ? { texts: clean, addresses: addresses.map(norm) } : null;
}

/** verifiedFromProject(project) → verified facts for a stored project row, or null (any other template, no topic). */
function verifiedFromProject(project) {
  const p = project && typeof project === "object" ? project : null;
  if (!p || p.template !== VERIFIED_TEMPLATE) return null;
  return verifiedFromTopic(p.selected_topic);
}

// An address in Claude's text is a verified event venue when its house number and street-name words all appear in the
// venue address the research validated ("1550 Maidu Drive" matches "1550 Maidu Dr, Roseville").
function addressIsVerified(matchText, addresses) {
  if (!addresses.length) return false;
  const words = lower(matchText).replace(/[^a-z0-9\s]/g, " ").split(/\s+/).filter(Boolean);
  if (words.length < 2) return false;
  const name = words.slice(0, -1); // drop the street-suffix word ("drive" / "dr"), which may be abbreviated differently
  return addresses.some((a) => {
    const have = new Set(lower(a).replace(/[^a-z0-9\s]/g, " ").split(/\s+/).filter(Boolean));
    return name.every((w) => have.has(w));
  });
}

// Same as scan(text, field, BLOCK_RULES, ...) but a street address that matches the verified event venue is allowed
// (and recorded). Every match is checked, so an unverified address next to the venue is still blocked.
function scanBlocksWithVenue(text, field, addresses, blocks, sourcedFacts) {
  const t = norm(text);
  if (!t) return;
  for (const r of BLOCK_RULES) {
    if (r.rule !== "street_address") { scan(t, field, [r], blocks); continue; }
    const re = new RegExp(r.re.source, r.re.flags.includes("g") ? r.re.flags : r.re.flags + "g");
    let m;
    while ((m = re.exec(t))) {
      if (addressIsVerified(m[0], addresses)) sourcedFacts.push(`${field}: ${snippet(m)}`);
      else blocks.push({ rule: r.rule, field, match: snippet(m), message: r.message });
      if (m[0].length === 0) re.lastIndex++;
    }
  }
}

// Numeric tokens such as 55, 55+, 3.5%, 4,000. Used to stop Claude inventing figures.
function numberTokens(text) {
  const out = new Set();
  const re = /\d[\d,]*(?:\.\d+)?/g;
  let m;
  const t = norm(text);
  while ((m = re.exec(t))) out.add(m[0].replace(/,/g, "").replace(/\.0+$/, ""));
  return out;
}

/**
 * evaluate(input) → result
 *   input = {
 *     template,                       // template key
 *     payload,                        // anything structured the client sent (checked for forbidden property-sale keys)
 *     intake: { field: string },      // the agent's own words; the source of authority for facts and claims
 *     generated: { narration, captions, sceneTexts: [], overlays: [] },   // text written by Claude
 *     cta: { text, source },          // final CTA; source = template_default | claude | user_edited | user_inserted
 *     userText: { field: string },    // any other agent-typed text (titles, overlay edits)
 *     verified: { texts, addresses }, // Local Market Insider only: facts from the validated research topic (verifiedFromProject)
 *   }
 */
function evaluate(input) {
  const blocks = [];
  const warnings = [];
  const agentSuppliedClaims = [];
  const i = input || {};

  // Template allowlist
  if (!TEMPLATES.includes(i.template)) blocks.push({ rule: "template", field: "template", match: String(i.template || ""), message: "Unknown Agent Marketing template." });
  else if (!ENABLED_TEMPLATES.includes(i.template)) blocks.push({ rule: "template", field: "template", match: i.template, message: "This template is not available yet." });

  // Structural: forbidden property-sale keys anywhere in the payload / intake
  const bad = [];
  findForbiddenKeys(i.payload, "payload", bad, 0);
  findForbiddenKeys(i.intake, "intake", bad, 0);
  for (const k of bad) blocks.push({ rule: "property_field", field: k, match: k, message: "Property-sale fields are not accepted in Agent Marketing. Use a Listing Reel for a specific home." });

  const intake = i.intake && typeof i.intake === "object" ? i.intake : {};
  const intakeText = Object.values(intake).filter((v) => typeof v === "string").map(norm).join(" \n ");
  const intakeLower = intakeText.toLowerCase();
  const intakeNumbers = numberTokens(intakeText);

  // Everything the AGENT typed: property-sale rules block; Fair Housing only warns; claims pass through.
  const userFields = { ...(i.userText || {}) };
  for (const [k, v] of Object.entries(intake)) if (typeof v === "string") userFields[`intake.${k}`] = v;
  if (i.cta && (i.cta.source === "user_edited" || i.cta.source === "user_inserted")) userFields["cta"] = i.cta.text;
  for (const [field, text] of Object.entries(userFields)) {
    scan(text, field, BLOCK_RULES, blocks);
    scan(text, field, WARN_RULES, warnings);
    scan(text, field, FAIR_HOUSING, warnings);
    for (const r of CLAIM_RULES) {
      const m = norm(text).match(r.re);
      if (m) agentSuppliedClaims.push(`${field}: ${snippet(m)}`);
    }
  }

  // Verified facts: honored only for Local Market Insider, and only in the shape verifiedFromTopic() produces.
  const vIn = i.template === VERIFIED_TEMPLATE && i.verified && typeof i.verified === "object" ? i.verified : null;
  const vTexts = vIn && Array.isArray(vIn.texts) ? vIn.texts.filter((x) => typeof x === "string" && x.trim()).map(norm) : [];
  const vAddresses = vIn && Array.isArray(vIn.addresses) ? vIn.addresses.filter((x) => typeof x === "string" && x.trim()).map(norm) : [];
  const hasVerified = vTexts.length > 0;
  const verifiedText = vTexts.join(" \n ");
  const verifiedLower = verifiedText.toLowerCase();
  const verifiedNumbers = numberTokens(verifiedText);
  const sourcedFacts = [];

  // Everything CLAUDE wrote (and the default CTA): property-sale rules block, Fair Housing blocks, and Claude may not
  // add claims or numbers the agent did not supply. Local Market Insider text may also use what traces to the verified topic.
  const g = i.generated || {};
  const genFields = {
    "narration": g.narration, "captions": g.captions,
    ...Object.fromEntries((g.sceneTexts || []).map((t, n) => [`sceneText[${n}]`, t])),
    ...Object.fromEntries((g.overlays || []).map((t, n) => [`overlay[${n}]`, t])),
  };
  if (i.cta && i.cta.source !== "user_edited" && i.cta.source !== "user_inserted") genFields["cta"] = i.cta.text;
  for (const [field, text] of Object.entries(genFields)) {
    if (!text) continue;
    if (vAddresses.length) scanBlocksWithVenue(text, field, vAddresses, blocks, sourcedFacts);
    else scan(text, field, BLOCK_RULES, blocks);
    scan(text, field, WARN_RULES, warnings);
    scan(text, field, FAIR_HOUSING, blocks);
    for (const r of CLAIM_RULES) {
      const m = norm(text).match(r.re);
      if (!m) continue;
      if (intakeLower.includes(lower(m[0]))) agentSuppliedClaims.push(`${field}: ${snippet(m)}`); // the agent said it first
      else if (hasVerified && r.rule === "transaction_result" && (verifiedLower.includes(lower(m[0])) || /^days on market$/i.test(m[0]))) {
        sourcedFacts.push(`${field}: ${snippet(m)}`); // market vocabulary that the sourced topic itself uses
      } else blocks.push({ rule: r.rule, field, match: snippet(m), message: r.message });
    }
    for (const n of numberTokens(text)) {
      if (intakeNumbers.has(n)) continue;
      if (hasVerified && verifiedNumbers.has(n)) sourcedFacts.push(`${field}: ${n}`); // the figure is in the validated source topic
      else blocks.push({ rule: "invented_number", field, match: n, message: "Contains a number the agent did not provide." });
    }
  }

  // De-duplicate identical issues
  const uniq = (arr) => { const seen = new Set(); return arr.filter((x) => { const k = `${x.rule}|${x.field}|${x.match}`; if (seen.has(k)) return false; seen.add(k); return true; }); };
  const b = uniq(blocks);
  return { ok: b.length === 0, version: GATE_VERSION, blocks: b, warnings: uniq(warnings), agentSuppliedClaims: [...new Set(agentSuppliedClaims)], sourcedFacts: [...new Set(sourcedFacts)] };
}

// Friendly message for the UI when the gate blocks.
function explain(result) {
  if (!result || result.ok) return "";
  const first = result.blocks[0];
  const where = first.field ? ` (${first.field})` : "";
  const more = result.blocks.length > 1 ? ` and ${result.blocks.length - 1} more` : "";
  return `${first.message}${where}${first.match ? ` — “${first.match}”` : ""}${more}. Agent Marketing is for your expertise and services; use a Listing Reel to advertise a specific home.`;
}

module.exports = { GATE_VERSION, ATTESTATION_VERSION, ATTESTATION_TEXT, TEMPLATES, ENABLED_TEMPLATES, evaluate, explain, verifiedFromTopic, verifiedFromProject };
