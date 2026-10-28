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
// Local Market Insider with a validated research topic is reviewed by the market-insider rules below (SaaS Production Model and
// Compliance Architecture, Oct 25, 2026): it checks meaning and factual support, never vocabulary. Every other template, and Local Market
// Insider without a validated topic, keeps the strict property-ad rules.
//
// Result shape: { ok, version, blocks: [issue], warnings: [issue], agentSuppliedClaims: [string] }
//   issue = { rule, field, match, message }
// `ok` is false when there is at least one block. Warnings never block; they are stored on the advertising record.

"use strict";

const GATE_VERSION = "2026-10-25.1";

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
// Ownership: the agent made the seller or listing agent, or the sentence is about one particular home. Context, not vocabulary: "homes sold
// at 99% of list price" is a market statistic; "I sold a home" and "this home is pending" are not Local Market Insider content.
const ST = "sold|listed|pending|under\\s+contract|in\\s+escrow|closed|active|for\\s+sale|on\\s+the\\s+market";
const OWNERSHIP_RE = new RegExp([
  `\\b(?:i|we)(?:'ve|'d)?\\s+(?:(?:just|recently|also|already)\\s+)?(?:sold|listed|closed|put\\s+(?:\\w+\\s+){0,3}under\\s+contract)\\b`,
  `\\b(?:i|we)\\s+(?:currently\\s+)?(?:have|has|got|represent|hold)\\s+(?:a|an|\\d+|several|some|two|three|four|five)\\s+(?:\\w+\\s+){0,3}(?:home|homes|house|houses|listing|listings|propert(?:y|ies)|condo|condos)\\b`,
  `\\b(?:my|our)\\s+(?:\\w+\\s+){0,2}(?:listings?|homes?|houses?|propert(?:y|ies))\\b[^.!?;]{0,30}\\b(?:${ST})\\b`,
  `\\b(?:this|that|the)\\s+(?:home|house|property|condo|townhome|townhouse|listing)\\s+(?:is|was|has|just|recently|will\\s+be)\\s+(?:\\w+\\s+){0,2}(?:${ST})\\b`,
].join("|"), "i");
const BLOCK_RULES = [
  { rule: "ownership_claim", message: "Reads as though you sold, listed or hold a specific home. Use a Listing Reel for a specific home.", re: OWNERSHIP_RE },
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
    re: /\b(?:perfect|ideal|great|best)\s+for\s+(?:young\s+)?(?:families|singles|couples|bachelors?)\b|\bno\s+(?:kids|children)\b|\badults?\s+only\b|\b(?:safe|exclusive|desirable)\s+(?:neighborhood|area|community)\b|\b(?:good|great|top|best|excellent)\s+schools?\b/i },
];

// "55+ Active Adult Lifestyle community" and "senior" describe an age-restricted community, not steering (Sam, Oct 28). "Quiet" is the risky word: a warning, never a block.
const FAIR_HOUSING_SOFT = [
  { rule: "fair_housing_soft", message: "\u201cQuiet\u201d can read as describing who lives in a place; make sure it describes the place, not the people.",
    re: /\bquiet\s+(?:neighborhoods?|areas?|communit(?:y|ies)|streets?|enclaves?)\b/i },
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
  // reportFirst (a web topic when the agent chose "Both"): the agent's uploaded report is the only source of numbers. The web topic's own
  // wording gives the narrative and idea, but its figures are NOT verified; only the report's figures (carried on the topic) are.
  const reportFirst = t.reportFirst === true;
  // Oct 27, 2026 (Sam): the approved article is a source too, so its own wording and figures are verified for the script. The report still wins a conflict
  // (reportPrecedence below), and the planner keeps each scene to one source.
  const af = reportFirst ? require("./agent-marketing-article-lib").articleFacts(t) : t; // a "Both" topic: the article's market statistics stay out, the report's are the only ones
  const texts = [af.question, af.whyItMatters, af.scopeNote, ...(Array.isArray(af.trendSignals) ? af.trendSignals : [])];
  // A topic written from the agent's own MLS report carries the exact figures it cited (frozen by agent-marketing-research-report-lib.js)
  // and, for MetroList data, the notice Rule 12.9 requires on anything published with them. Only those figures are verified, not the whole report.
  (Array.isArray(t.reportFigures) ? t.reportFigures : []).forEach((f) => { if (f && typeof f.text === "string") texts.push(f.text); });
  const reportNotice = typeof t.reportNotice === "string" ? norm(t.reportNotice) : "";
  if (reportNotice) texts.push(reportNotice);
  // Figures from the agent's own report that take priority over a conflicting web figure on a web topic (see applyReportPrecedence).
  const precedence = (Array.isArray(t.reportPrecedence) ? t.reportPrecedence : []).map((p) => ({
    label: norm(p && p.label), reportText: norm(p && p.reportText),
    supersededNumbers: (Array.isArray(p && p.supersededNumbers) ? p.supersededNumbers : []).map(String).filter(Boolean),
  })).filter((p) => p.reportText);
  precedence.forEach((p) => texts.push(p.reportText));
  const addresses = [];
  const e = t.event && typeof t.event === "object" ? t.event : null;
  if (e) {
    texts.push(e.name, e.date, e.endDate, e.time, e.location, e.organizer);
    if (e.location) addresses.push(e.location);
  }
  const clean = texts.filter((x) => typeof x === "string" && x.trim()).map(norm);
  return clean.length ? { texts: clean, addresses: addresses.map(norm), reportNotice, precedence, reportFirst } : null;
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

// ── Local Market Insider review (Oct 25, 2026) ────────────────────────────────────────────────────────────────────
// Governing rule (SSP Agent Marketing — SaaS Production Model and Compliance Architecture): review the meaning, factual support and
// advertising context of a statement, not its words. sold, pending, active, price reduction, list price, open house, inventory and days on
// market are ordinary market vocabulary. A block must cite one of the approved rules below and say what is actually wrong. Source
// acceptance (may this report be used?) is decided at upload, never here: this module never second-guesses an accepted source.
//
// The approved rules for a piece with a validated topic:
//   1. No specific home      ownership_claim, mls_reference, street_address, specific_home_price, specific_home_announcement,
//                            property_availability, property_sale_cta, property_field (structural)
//   2. Every number traces   invented_number (to the intake, the validated topic or the agent's report), unsupported_outcome, client_story,
//                            staging_outcome; report_priority (the agent's own report wins over a conflicting web figure)
//   3. Required notice       missing_notice (MetroList Rule 12.9, an on-screen overlay) and notice_spoken (never read aloud)
//   4. Fair Housing          fair_housing
const HOME_RULES = new Set(["mls_reference", "street_address", "property_availability", "property_sale_cta"]);
const MARKET_HOME_RULES = [
  { rule: "ownership_claim", message: "Reads as though you sold, listed or hold a specific home. Use a Listing Reel for a specific home.", re: OWNERSHIP_RE },
  ...BLOCK_RULES.filter((r) => HOME_RULES.has(r.rule)),
  { rule: "specific_home_price", message: "States a price tied to one home. Market figures (a median, an average, a percent of list price) are fine; one listing's price belongs in a Listing Reel.",
    re: /\b(?:listed|asking|reduced|marked\s+down)\s+(?:at|for|to)\s*\$\s?\d|\bnew\s+price\s*[:\-]\s*\$|\b(?:this|that|our|my)\s+(?:home|house|property|listing|condo|townhome|townhouse)\b[^.!?]{0,40}\$\s?\d/i },
  { rule: "specific_home_announcement", message: "Reads like an announcement of one home. Use a Listing Reel for a specific home.",
    re: /(?:^|[.!?]\s+)(?:just\s+listed|just\s+sold|new\s+listing|coming\s+soon|now\s+selling|back\s+on\s+(?:the\s+)?market)\b|\b(?:my|our|this|that)\s+open\s+house\b/i },
];
// Wording alone is never flagged: "open house", "just listed" and the rest are only a problem as an announcement of one home (blocked above).
const MARKET_WARN_RULES = WARN_RULES;
// Outcome claims need support: a testimonial or staging result nobody supplied, or "over asking" with no figure behind it.
const MARKET_CLAIM_RULES = CLAIM_RULES.filter((r) => r.rule !== "transaction_result");
const OUTCOME_RE = /\b(?:over|above|under)\s+asking\b|\bmultiple\s+offers\b|\bbidding\s+wars?\b/gi;
const isSpokenField = (f) => f === "narration" || f === "captions" || f.startsWith("sceneText[");

function sentenceAround(t, index, len) {
  const start = Math.max(t.lastIndexOf(".", index - 1), t.lastIndexOf("!", index - 1), t.lastIndexOf("?", index - 1)) + 1;
  const ends = [".", "!", "?"].map((c) => t.indexOf(c, index + len)).filter((x) => x >= 0);
  return t.slice(start, ends.length ? Math.min(...ends) + 1 : t.length);
}

// "132 apartments at Poker Lane" is a count of homes and a street, not an address (Sam, Oct 28): the words between the number and the street
// suffix read as a sentence, not a street name.
const COUNT_WORD = /^(?:homes?|houses?|apartments?|units?|listings?|sales?|sold|new|planned|proposed|more|fewer|buyers?|sellers?|offers?|properties|condos?|lots?|permits?|days?|months?|weeks?|at|on|near|in|of|for|from|to|with|and|that|are|were|have|has)$/i;
function readsAsCount(matched) {
  const words = matched.replace(/^\d[\d,]*\s+/, "").split(/\s+/).slice(0, -1);
  return words.some((w) => COUNT_WORD.test(w));
}

// Rule 1. An address is fine only when it is the verified event venue ("1550 Maidu Drive" vs "1550 Maidu Dr, Roseville").
function scanSpecificHome(text, field, addresses, blocks, sourcedFacts) {
  const t = norm(text);
  if (!t) return;
  for (const r of MARKET_HOME_RULES) {
    if (r.rule === "street_address") {
      const re0 = new RegExp(r.re.source, r.re.flags.includes("g") ? r.re.flags : r.re.flags + "g");
      let m0;
      let flagged = null;
      while ((m0 = re0.exec(t))) { if (!readsAsCount(m0[0]) && !(addresses.length && addressIsVerified(m0[0], addresses))) { flagged = m0; break; } if (m0[0].length === 0) re0.lastIndex++; }
      if (flagged) blocks.push({ rule: r.rule, field, match: snippet(flagged), message: r.message });
      else if (addresses.length) { const re1 = new RegExp(r.re.source, re0.flags); let m1; while ((m1 = re1.exec(t))) { if (addressIsVerified(m1[0], addresses)) sourcedFacts.push(`${field}: ${snippet(m1)}`); if (m1[0].length === 0) re1.lastIndex++; } }
      continue;
    }
    if (r.rule !== "street_address" || !addresses.length) { scan(t, field, [r], blocks); continue; }
    const re = new RegExp(r.re.source, r.re.flags.includes("g") ? r.re.flags : r.re.flags + "g");
    let m;
    while ((m = re.exec(t))) {
      if (addressIsVerified(m[0], addresses)) sourcedFacts.push(`${field}: ${snippet(m)}`);
      else blocks.push({ rule: r.rule, field, match: snippet(m), message: r.message });
      if (m[0].length === 0) re.lastIndex++;
    }
  }
}

// Rule 2. The agent's own report is the source of truth. A web figure for a measure the report also covers, and that disagrees with it,
// was recorded on the topic (reportPrecedence) when the topics were built; using it in the script blocks.
function scanReportPriority(text, field, precedence, blocks) {
  if (!precedence.length) return;
  const nums = numberTokens(text);
  for (const p of precedence) {
    for (const n of p.supersededNumbers) {
      if (nums.has(n)) blocks.push({ rule: "report_priority", field, match: n, message: `Your uploaded report is the source of truth for ${p.label} (${p.reportText}). Use that figure, not ${n}.` });
    }
  }
}

// Claude's own text for a sourced piece. Returns nothing; pushes into blocks / sourcedFacts / agentSuppliedClaims.
function scanMarketClaims(text, field, ctx, blocks, sourcedFacts, claims, warnings) {
  const t = norm(text);
  for (const r of MARKET_CLAIM_RULES) {
    const m = t.match(r.re);
    if (!m) continue;
    if (ctx.intakeLower.includes(lower(m[0]))) claims.push(`${field}: ${snippet(m)}`); // the agent said it first
    else blocks.push({ rule: r.rule, field, match: snippet(m), message: r.message });
  }
  const re = new RegExp(OUTCOME_RE.source, "gi");
  let m;
  while ((m = re.exec(t))) {
    const sentence = sentenceAround(t, m.index, m[0].length);
    if (ctx.intakeLower.includes(lower(m[0]))) claims.push(`${field}: ${snippet(m)}`);
    else if (!OWNERSHIP_RE.test(sentence) && (ctx.verifiedLower.includes(lower(m[0])) || [...numberTokens(sentence)].some((n) => ctx.verifiedNumbers.has(n)))) sourcedFacts.push(`${field}: ${snippet(m)}`);
    else if (OWNERSHIP_RE.test(sentence)) blocks.push({ rule: "unsupported_outcome", field, match: snippet(m), message: `"${m[0]}" is written as the agent's own result, which belongs in a Listing Reel.` });
    else if (warnings) warnings.push({ rule: "outcome_unsupported", field, match: snippet(m), message: `"${m[0]}" is an opinion about the market with no figure behind it. That is allowed; add a figure if you can.` }); // characterizing the market is allowed (Sam, Oct 28)
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

// Only figures that read as market claims must trace to a source: a dollar amount, a percent, a decimal, a figure of 100 or more, or a count with a
// market unit (22 days, 40 sales). A year, "55+", "3 things" or "9:16" is just a number (Sam, Oct 28).
const FIGURE_UNIT = /^\s*(?:%|percent\b|per\s?cent\b|[kKmMbB]\b|(?:days?|weeks?|months?|homes?|houses?|listings?|sales?|sold|units?|apartments?|properties|condos?|permits?|buyers?|sellers?|offers?|basis\s+points?|points?)\b)/i;
const FIGURE_CUE = /(?:median|average|avg|typical|reached|reaches|rose|rises?|fell|falls?|dropped|climbed|sits?|stood|stands?|about|around|roughly|nearly|almost|over|under|up|down|from|to|at|by|of)\s+(?:an?\s+|the\s+)?$/i;
function marketFigureTokens(text) {
  const out = new Set();
  const t = norm(text);
  const re = /(\$\s?)?(\d[\d,]*(?:\.\d+)?)/g;
  let m;
  while ((m = re.exec(t))) {
    const n = m[2].replace(/,/g, "").replace(/\.0+$/, "");
    const after = t.slice(m.index + m[0].length);
    const isYear = /^(?:19|20)\d{2}$/.test(n) && !m[1] && !/^\s*(?:%|percent)/i.test(after);
    const before = t.slice(Math.max(0, m.index - 30), m.index);
    const cued = Number(n) >= 10 && Number.isInteger(Number(n)) && !isYear && FIGURE_CUE.test(before);   // "reached 31", "up to 45", "around 60"
    if (m[1] || m[2].includes(".") || FIGURE_UNIT.test(after) || (!isYear && Number(n) >= 100) || cued) out.add(n);
  }
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

  // Verified facts: honored only for Local Market Insider, and only in the shape verifiedFromTopic() produces.
  const vIn = i.template === VERIFIED_TEMPLATE && i.verified && typeof i.verified === "object" ? i.verified : null;
  const vTexts = vIn && Array.isArray(vIn.texts) ? vIn.texts.filter((x) => typeof x === "string" && x.trim()).map(norm) : [];
  const vAddresses = vIn && Array.isArray(vIn.addresses) ? vIn.addresses.filter((x) => typeof x === "string" && x.trim()).map(norm) : [];
  const precedence = vIn && Array.isArray(vIn.precedence) ? vIn.precedence.filter((p) => p && Array.isArray(p.supersededNumbers)) : [];
  const verifiedText = vTexts.join(" \n ");
  const verifiedLower = verifiedText.toLowerCase();
  const verifiedNumbers = numberTokens(verifiedText);
  const sourcedFacts = [];
  const market = vTexts.length > 0; // a validated topic exists: review the meaning (market rules); otherwise the strict property-ad rules apply
  // Validated calculations (a ratio, difference or percent change whose inputs are verified figures, recomputed by agent-marketing-manifest-lib.js)
  // are as good as a figure written in the research. Callers pass the results as input.derivedNumbers; nothing is accepted without them.
  if (market && Array.isArray(i.derivedNumbers)) i.derivedNumbers.forEach((n) => { if (n !== null && n !== undefined && n !== "") verifiedNumbers.add(String(n).replace(/,/g, "").replace(/\.0+$/, "")); });
  const ctx = { intakeLower, verifiedLower, verifiedNumbers };

  // Everything the AGENT typed: property-sale rules block; Fair Housing only warns; claims pass through.
  const userFields = { ...(i.userText || {}) };
  for (const [k, v] of Object.entries(intake)) if (typeof v === "string") userFields[`intake.${k}`] = v;
  if (i.cta && (i.cta.source === "user_edited" || i.cta.source === "user_inserted")) userFields["cta"] = i.cta.text;
  for (const [field, text] of Object.entries(userFields)) {
    if (market) scanSpecificHome(text, field, vAddresses, blocks, sourcedFacts);
    else scan(text, field, BLOCK_RULES, blocks);
    scan(text, field, market ? MARKET_WARN_RULES : WARN_RULES, warnings);
    scan(text, field, FAIR_HOUSING, warnings);
    scan(text, field, FAIR_HOUSING_SOFT, warnings);
    for (const r of CLAIM_RULES) {
      const m = norm(text).match(r.re);
      if (m) agentSuppliedClaims.push(`${field}: ${snippet(m)}`);
    }
    // Approving or saving a script sends Claude's words back as the agent's own text. On a sourced piece the same context rules apply to it
    // (the agent's own intake answers are theirs and are not held to them).
    if (market && !field.startsWith("intake.") && field !== "cta") {
      scanMarketClaims(text, field, ctx, blocks, sourcedFacts, agentSuppliedClaims, warnings);
      scanReportPriority(text, field, precedence, blocks);
    }
  }

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
    if (market) scanSpecificHome(text, field, vAddresses, blocks, sourcedFacts);
    else scan(text, field, BLOCK_RULES, blocks);
    scan(text, field, market ? MARKET_WARN_RULES : WARN_RULES, warnings);
    scan(text, field, FAIR_HOUSING, blocks);
    scan(text, field, FAIR_HOUSING_SOFT, warnings);
    if (market) {
      scanMarketClaims(text, field, ctx, blocks, sourcedFacts, agentSuppliedClaims, warnings);
      scanReportPriority(text, field, precedence, blocks);
    } else {
      for (const r of CLAIM_RULES) {
        const t = norm(text);
        const re = new RegExp(r.re.source, r.re.flags.includes("g") ? r.re.flags : r.re.flags + "g");
        let m;
        while ((m = re.exec(t))) {
          if (m[0].length === 0) { re.lastIndex++; continue; }
          if (intakeLower.includes(lower(m[0]))) agentSuppliedClaims.push(`${field}: ${snippet(m)}`); // the agent said it first
          else blocks.push({ rule: r.rule, field, match: snippet(m), message: r.message });
        }
      }
    }
    for (const n of (market ? marketFigureTokens(text) : numberTokens(text))) {
      if (intakeNumbers.has(n)) continue;
      if (market && verifiedNumbers.has(n)) sourcedFacts.push(`${field}: ${n}`); // the figure is in the validated source topic
      else blocks.push({ rule: "invented_number", field, match: n, message: market ? (vIn && vIn.reportFirst ? `The number ${n} is not in your uploaded report. You chose to use your report with web research, so your report is the source of truth: use only its figures.` : `The number ${n} is not in your research topic, your uploaded report or your answers. Use only figures from those sources.`) : "Contains a number the agent did not provide." });
    }
  }

  // MetroList Rule 12.9: advertising that uses its statistics must carry "Based on information from MetroList Services, Inc. for the period
  // (date) through (date)." When the verified topic came from a MetroList report, a complete piece must carry that notice as an on-screen
  // overlay (overlay / notice fields), never as spoken words. Callers that check a whole piece pass fullPiece: true (a partial check, such as
  // one image caption, is not held to it).
  const noticeText = vIn && typeof vIn.reportNotice === "string" ? lower(norm(vIn.reportNotice)) : "";
  if (noticeText) {
    const all = { ...userFields, ...genFields };
    const spoken = Object.entries(all).filter(([f, t]) => isSpokenField(f) && typeof t === "string" && lower(t).includes(noticeText)).map(([f]) => f);
    spoken.forEach((f) => blocks.push({ rule: "notice_spoken", field: f, match: "", message: "MetroList's notice is shown on screen, not spoken. Remove it from the script; it is added to the video automatically." }));
    if (i.fullPiece === true) {
      const onScreen = Object.entries(all).some(([f, t]) => (f === "notice" || f.startsWith("overlay[")) && typeof t === "string" && lower(norm(t)).includes(noticeText));
      if (!onScreen) blocks.push({ rule: "missing_notice", field: "notice", match: "", message: "A piece that uses MetroList report figures must carry MetroList's required notice." });
    }
  }

  // De-duplicate identical issues
  const uniq = (arr) => { const seen = new Set(); return arr.filter((x) => { const k = `${x.rule}|${x.field}|${x.match}`; if (seen.has(k)) return false; seen.add(k); return true; }); };
  const b = uniq(blocks);
  return { ok: b.length === 0, version: GATE_VERSION, review: market ? "market_insider" : "strict", blocks: b, warnings: uniq(warnings), agentSuppliedClaims: [...new Set(agentSuppliedClaims)], sourcedFacts: [...new Set(sourcedFacts)] };
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
