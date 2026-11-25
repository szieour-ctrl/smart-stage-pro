// lib/agent-marketing-article-lib.js — what an approved local article may contribute to a Reel (Oct 27, 2026; source-of-truth correction Nov 8, 2026).
//
// Market Update modes (Sam, Nov 8, 2026):
//   1. Market Trend Update (report only): no article.
//   2. Article-Led + Trend/CMA: the article is the editorial subject. Its facts, project counts, dates, milestones and narrative context may be told
//      as the article reports them. LOCAL MARKET PERFORMANCE STATISTICS (prices, days on market, inventory, listings, sales, pendings, price per square
//      foot, sale-to-list, price cuts, appreciation) come only from the agent's report. This file applies that rule to topic text.
//   3. Article-Led Editorial (no report): the article's supported facts and attributed figures may be told; this file is not applied.
//
// Earlier code dropped EVERY sentence pairing a digit with a word like "listings", "sales", "rates" or "%", which also removed planned-development
// counts and turned a question such as "Could 81 builder listings change what Lincoln resale sellers can ask?" into a placeholder. Now each number is
// judged by the words around it: a market-performance measure makes it a market statistic; a planned-development noun (homes, units, apartments, lots,
// acres, phases) or a date makes it an article fact. A question keeps its idea with only the market figure removed; other text drops only the
// sentences that state a market statistic.
"use strict";

// Measures of local market performance (the report's job in mode 2).
const MEASURE = /\b(?:median|average|avg|mean|prices?|priced|sold|sales?|sale-to-list|list-to-sale|list(?:ing)? prices?|asking|listings?|listed|inventory|months? of (?:supply|inventory)|supply|days on (?:the )?market|dom|pending|pendings|pended|closed|closings?|absorption|appreciation|values?|price cuts?|price reductions?|reductions?|reduced|per square f(?:oo|ee)t|\/\s?sq\.? ?ft|sq\.? ?ft|square f(?:oo|ee)t|offers?|turnover)\b/i;
// Planned or built development, places and milestones (article facts in mode 2).
const DEVELOPMENT = /\b(?:homes?|houses?|units?|apartments?|townhomes?|townhouses?|condos?|lots?|parcels?|acres?|phases?|villages?|subdivisions?|communit(?:y|ies)|buildings?|stor(?:y|ies)|beds?|bedrooms?|residents?|households?|jobs?|students?|seats?|rooms?|permits?|dwellings?|rooftops?)\b/i;
const NUMBER = /\$?\d[\d,]*(?:\.\d+)?\s?(?:%|percent\b|k\b|m\b|million\b|billion\b)?/gi;
const YEAR = /^(?:19|20)\d{2}$/;
const PLANNED = /\b(?:planned|proposed|approved|entitled|under construction|will (?:add|bring|build|include)|would (?:add|bring|build|include)|filed|plans? for|broke ground|opening|to be built|could add)\b/i;

const words = (s) => String(s || "").split(/\s+/).filter(Boolean);

/** Each number in a sentence with its role: "market" (a local market performance statistic), "fact" (development count, date, other article fact). */
function numberRoles(sentence) {
  const s = String(sentence || "");
  const out = [];
  NUMBER.lastIndex = 0;
  let m;
  while ((m = NUMBER.exec(s))) {
    const raw = m[0].trim();
    const bare = raw.replace(/[$,%\s]|percent|k|m|million|billion/gi, "");
    if (!/\d/.test(bare)) continue;
    const before = words(s.slice(Math.max(0, m.index - 60), m.index)).slice(-5).join(" ");
    const after = words(s.slice(m.index + m[0].length, m.index + m[0].length + 60)).slice(0, 5).join(" ");
    const near = `${before} ${after}`;
    let role = "fact";
    if (YEAR.test(bare) && !/[$%]/.test(raw)) role = "fact";                               // a year
    else if (/^(?:jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)/i.test(words(before).slice(-1)[0] || "")) role = "fact";   // "March 28"
    else {
      const measureNear = MEASURE.test(near), devAfter = DEVELOPMENT.test(words(after).slice(0, 3).join(" "));
      // "132 apartments planned", "2,000 homes": a count of things being built is an article fact even next to the word "sales" or "listings"
      // ("132 apartments planned near the sales office"), unless it is itself a listing/sales count ("81 builder listings", "93 home sales").
      const statAfter = /^\s*(?:\S+\s+){0,2}(?:listings?|sales|pendings?|closings?|offers?|days (?:on|to)|months? of)\b/i.test(after);
      if (statAfter) role = "market";
      else if (devAfter && (PLANNED.test(s) || !measureNear)) role = "fact";
      // A dollar amount or percentage is a market statistic only with a market measure beside it ("prices rose 3%", "$625,000 median").
      // Financing ("mortgage rates near 6.5%"), builder incentives and project budgets are article facts, told as the article reports them.
      else if (measureNear && !/\b(?:mortgage|interest|rates?|incentives?|credits?|buy-?downs?|fees?|bonds?|taxes|assessments?|budget|funding|grants?)\b/i.test(near)) role = "market";
    }
    out.push({ text: raw, index: m.index, length: m[0].length, role });
  }
  return out;
}

const statOf = (sentence) => numberRoles(sentence).some((n) => n.role === "market");
const sentencesOf = (x) => String(x || "").split(/(?<=[.!?])\s+/).filter(Boolean);

/**
 * Nov 12, 2026: the report is authoritative only for the measures it contains. measuredKeys (a Set of the report figures' keys, for example
 * "months_supply") lets a sentence about a measure the report does NOT supply stay as a distinct article fact; a sentence
 * that touches a measure the report supplies still goes to the report. Without measuredKeys every market statistic is removed, as before.
 */
function measuredKeysOf(topic) {
  if (!(topic && topic.b2)) return null; // only a topic built from validated article findings (B2) carries distinct article facts; a legacy web topic's free text stays report-only
  const f = topic && Array.isArray(topic.reportFigures) ? topic.reportFigures : [];
  const keys = f.map((x) => x && x.key).filter(Boolean);
  return keys.length ? new Set(keys) : null;
}
// Nov 12, 2026 (Sam): the subscriber's confirmed report is authoritative for a measure it supplies. A sentence stays as a distinct article fact when every
// measure it states is one the report does NOT supply; no category of article statistics is suppressed as a class.
function articleOnlyMeasure(sentence, measuredKeys) {
  if (!measuredKeys || !measuredKeys.size) return false;
  const M = require("./agent-marketing-research-report-lib").MEASURES;
  const s = String(sentence || "").toLowerCase();
  return !M.some((m) => m.re.test(s) && measuredKeys.has(m.key));
}
const keepWith = (measuredKeys) => (sentence) => !statOf(sentence) || articleOnlyMeasure(sentence, measuredKeys);
const keep = keepWith(null);
/** The text without the sentences that state a local market performance statistic (mode 2). Article facts and dates stay; so do (given measuredKeys) article-only measures. */
function withoutMarketStats(text, measuredKeys) { return sentencesOf(text).filter(keepWith(measuredKeys)).join(" "); }

/** A question keeps its idea: only the market-statistic figures are removed ("Could 81 builder listings change…" → "Could builder listings change…"). */
function neutralizeMarketFigures(text, measuredKeys) {
  const s = String(text || "");
  const roles = (articleOnlyMeasure(s, measuredKeys) ? [] : numberRoles(s).filter((n) => n.role === "market")).sort((a, b) => b.index - a.index);
  let out = s;
  for (const n of roles) out = out.slice(0, n.index) + out.slice(n.index + n.length);
  return out.replace(/\s+([,.;:?!)])/g, "$1").replace(/\(\s*\)/g, "").replace(/\s{2,}/g, " ").replace(/\b(?:of|by|to|at|about|nearly|roughly|around|up|down)\s+([,.;:?!])/gi, "$1").trim();
}

const areaContextOf = (t) => (Array.isArray(t.areaContext) ? t.areaContext : []).map((c) => ({ area: String(c && c.area || ""), text: String(c && c.text || "") })).filter((c) => c.area && c.text);
const answeredByOf = (t) => (Array.isArray(t.answeredBy) ? t.answeredBy : []).map((f) => String(f && f.text || "")).filter(Boolean);

/** articleFacts(topic) → { question, whyItMatters, scopeNote, trendSignals } for a mode-2 web topic, minus local market statistics. */
function articleFacts(topic) {
  const t = topic && typeof topic === "object" ? topic : {};
  if (t.reframed === true) {
    // Oct 28, 2026: a reframed topic's question and explanation were written around the agent's report figures (answeredBy), each number checked
    // in code, so they pass through whole. The article's own figures stay labeled by area (areaContext) and are never the agent's market.
    return {
      question: String(t.question || ""), whyItMatters: String(t.whyItMatters || ""), scopeNote: String(t.scopeNote || ""),
      trendSignals: (Array.isArray(t.trendSignals) ? t.trendSignals : []).map(String).filter((s) => s && keep(s)),
      reframed: true, areaContext: areaContextOf(t), answeredBy: answeredByOf(t), articleQuestion: String(t.articleQuestion || ""),
    };
  }
  const mk = measuredKeysOf(t), kp = keepWith(mk);
  return {
    question: neutralizeMarketFigures(t.question, mk),
    whyItMatters: withoutMarketStats(t.whyItMatters, mk),
    scopeNote: withoutMarketStats(t.scopeNote, mk),
    trendSignals: (Array.isArray(t.trendSignals) ? t.trendSignals : []).map(String).filter((s) => s && kp(s)),
    areaContext: [], answeredBy: [],
  };
}

// Kept for callers that only need a coarse test; the decision is numberRoles().
const MARKET_STAT = MEASURE;
module.exports = { articleFacts, withoutMarketStats, neutralizeMarketFigures, numberRoles, measuredKeysOf, articleOnlyMeasure, MARKET_STAT };
