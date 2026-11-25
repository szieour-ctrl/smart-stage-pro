// lib/agent-marketing-article-lib.js — what the approved local article may contribute to a Reel that also uses the agent's own report (Oct 27, 2026).
// Sam's rule: a Reel's sources are the agent's market report AND the approved article. The article's own facts (a project's size, its place, a date,
// a decision) may be told as the article reports them. Market statistics (prices, days on market, inventory, sales counts) still come only from the
// agent's report, so any article sentence that pairs a number with one of those measures is left out here.
"use strict";

const MARKET_STAT = /\b(?:prices?|medians?|averages?|avg|days on market|dom|inventory|months? of (?:supply|inventory)|supply|listings?|sales?|sold|absorption|sq\.? ?ft|square f(?:ee|oo)t|list(?:ed)? price|sale-to-list|cuts?|reductions?|reduced|rates?|percent|%)\b|%/i;

const sentencesOf = (x) => String(x || "").split(/(?<=[.!?])\s+/).filter(Boolean);
const keep = (sentence) => !(/\d/.test(sentence) && MARKET_STAT.test(sentence));
/** The text with every "number + market measure" sentence removed. */
function withoutMarketStats(text) { return sentencesOf(text).filter(keep).join(" "); }

const areaContextOf = (t) => (Array.isArray(t.areaContext) ? t.areaContext : []).map((c) => ({ area: String(c && c.area || ""), text: String(c && c.text || "") })).filter((c) => c.area && c.text);
const answeredByOf = (t) => (Array.isArray(t.answeredBy) ? t.answeredBy : []).map((f) => String(f && f.text || "")).filter(Boolean);

/** articleFacts(topic) → { question, whyItMatters, scopeNote, trendSignals } for a web topic, minus market-statistic sentences. */
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
  return {
    question: withoutMarketStats(t.question),
    whyItMatters: withoutMarketStats(t.whyItMatters),
    scopeNote: withoutMarketStats(t.scopeNote),
    trendSignals: (Array.isArray(t.trendSignals) ? t.trendSignals : []).map(String).filter((s) => s && keep(s)),
    areaContext: [], answeredBy: [],
  };
}

module.exports = { articleFacts, withoutMarketStats, MARKET_STAT };
