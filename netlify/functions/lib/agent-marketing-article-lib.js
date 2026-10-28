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

/** articleFacts(topic) → { question, whyItMatters, scopeNote, trendSignals } for a web topic, minus market-statistic sentences. */
function articleFacts(topic) {
  const t = topic && typeof topic === "object" ? topic : {};
  return {
    question: withoutMarketStats(t.question),
    whyItMatters: withoutMarketStats(t.whyItMatters),
    scopeNote: withoutMarketStats(t.scopeNote),
    trendSignals: (Array.isArray(t.trendSignals) ? t.trendSignals : []).map(String).filter((s) => s && keep(s)),
  };
}

module.exports = { articleFacts, withoutMarketStats, MARKET_STAT };
