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

// Oct 30, 2026 (Sam, Directive A): with a report attached, the approved article supplies perspective, the idea behind its question and the
// opinion it invites, never a data figure. The old rule deleted every article sentence that paired a number with a market word, which also
// deleted the article's idea ("builder homes are a big share of what's for sale") and left the planner an empty question. The idea now passes
// through whole and only the figure is neutralized; the gate still refuses any figure that is not in the agent's report.
const FIGURE = "[article figure]";
const MONTH_BEFORE = /\b(?:jan|feb|mar|apr|may|jun|jul|aug|sep|sept|oct|nov|dec)[a-z]*\.?\s$/i;
/** Every figure-like number in the text: dollars, percents, decimals and any number of two or more digits, except a year or a day after a month name. */
function figureMatches(text) {
  const out = [], re = /(\$\s?)?(\d(?:[\d,]*\d)?(?:\.\d+)?)(\s?%)?/g, t = String(text == null ? "" : text);
  let m;
  while ((m = re.exec(t))) {
    const n = m[2].replace(/,/g, "");
    const isYear = /^(?:19|20)\d{2}$/.test(n) && !m[1] && !m[3];
    const isDay = n.length <= 2 && MONTH_BEFORE.test(t.slice(Math.max(0, m.index - 12), m.index));
    const small = n.length === 1 && !m[1] && !m[3] && !m[2].includes(".");
    if (isYear || isDay || small) continue;
    out.push({ index: m.index, length: m[0].length, value: n.replace(/\.0+$/, "") });
  }
  return out;
}
/**
 * The text with the figures of every MARKET-STATISTIC sentence (a number paired with prices, listings, sales, days on market, % and the like)
 * replaced by "[article figure]". The idea in the sentence stays. A project fact with no market measure ("a 132-unit apartment complex",
 * a date, a decision) is left as written: it is the article's story, not data (Sam's Oct 27 rule), and it stays verified.
 */
function neutralizeFigures(text) {
  return sentencesOf(text).map((sent) => {
    if (keep(sent)) return sent; // no number paired with a market measure
    let out = "", at = 0;
    for (const f of figureMatches(sent)) { out += sent.slice(at, f.index) + FIGURE; at = f.index + f.length; }
    return out + sent.slice(at);
  }).join(" ");
}
/** The figures the article states about the market (never the agent's report, never a project fact): the numbers a script must not repeat. */
function articleNumbers(topic) {
  const t = topic && typeof topic === "object" ? topic : {};
  const fields = [t.question, t.whyItMatters, t.scopeNote, ...(Array.isArray(t.trendSignals) ? t.trendSignals : []), t.articleText]; // articleText: the page itself, when it was read
  return [...new Set(fields.flatMap((x) => sentencesOf(x).filter((sent) => !keep(sent)).flatMap((sent) => figureMatches(sent).map((f) => f.value))))];
}

/** articleFacts(topic) → { question, whyItMatters, scopeNote, trendSignals } for a web topic, with the article's figures neutralized (its idea is kept whole). */
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
    question: neutralizeFigures(t.question),
    whyItMatters: neutralizeFigures(t.whyItMatters),
    scopeNote: neutralizeFigures(t.scopeNote),
    trendSignals: (Array.isArray(t.trendSignals) ? t.trendSignals : []).map(String).filter(Boolean).map(neutralizeFigures),
    areaContext: [], answeredBy: [],
  };
}

module.exports = { articleFacts, withoutMarketStats, MARKET_STAT, neutralizeFigures, articleNumbers, figureMatches, FIGURE };
