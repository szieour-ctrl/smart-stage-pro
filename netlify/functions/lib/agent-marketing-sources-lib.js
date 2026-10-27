// agent-marketing-sources-lib.js — the on-screen source line for a Reel built from web research instead of an uploaded report (Oct 26, 2026).
// The text is built by code from the sources the research step already checked (https, dated, not paywalled) and the topic's own scope
// note. It replaces the MetroList notice, which belongs only to MetroList report data. It is shown on screen, never spoken.
"use strict";

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
const MAX_LINE = 240;
const hostOf = (u) => { try { return new URL(u).hostname.replace(/^www\./, ""); } catch { return ""; } };
function shortDate(iso) {
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(String(iso || ""));
  return m ? `${MONTHS[Number(m[2]) - 1]} ${Number(m[3])}, ${m[1]}` : "";
}
const trimTitle = (t, max) => {
  t = String(t || "").replace(/\s+/g, " ").trim();
  if (t.length <= max) return t;
  const cut = t.slice(0, max - 1);
  return cut.slice(0, Math.max(10, cut.lastIndexOf(" "))).replace(/[,:;\-–—\s]+$/, "") + "…";
};

/** The usable sources: a real https url, a title and a publication date. */
function usableSources(sources) {
  return (Array.isArray(sources) ? sources : []).filter((s) => s && /^https:\/\//.test(String(s.url || "")) && s.title && shortDate(s.published)).slice(0, 4);
}

/**
 * sourceLine(sources, scopeNote) -> "Source: Redfin 95834 Housing Market (redfin.com, Oct 20, 2026) + 1 more. Figures cover ZIP 95834, not all of Natomas."
 * The scope note is kept whole (it says what area the figures cover); the first source's title is shortened to fit.
 */
function sourceLine(sources, scopeNote) {
  const list = usableSources(sources);
  if (!list.length) return "";
  const first = list[0], more = list.length - 1;
  const scope = String(scopeNote || "").replace(/\s+/g, " ").trim();
  const tail = (more > 0 ? ` + ${more} more` : "") + "." + (scope ? ` ${/[.!?]$/.test(scope) ? scope : scope + "."}` : "");
  const meta = ` (${hostOf(first.url)}, ${shortDate(first.published)})`;
  const room = MAX_LINE - ("Source: ".length + meta.length + tail.length);
  if (room < 20) return "";
  return `Source: ${trimTitle(first.title, room)}${meta}${tail}`;
}

/** A short footer label for the figure cards: the publishers' names, e.g. "redfin.com · sacbee.com". */
function sourceLabel(sources) {
  const hosts = [...new Set(usableSources(sources).map((s) => hostOf(s.url)).filter(Boolean))].slice(0, 2);
  return hosts.join(" · ");
}

const numTokens = (text) => (String(text || "").match(/\d[\d,]*(?:\.\d+)?/g) || []).map((t) => Number(t.replace(/,/g, "")));
/** Numbers the research step recorded for a topic (its question, why-it-matters, scope note and signals). */
function topicNumbers(topic) {
  const t = topic || {};
  const texts = [t.question, t.whyItMatters, t.scopeNote, ...(Array.isArray(t.trendSignals) ? t.trendSignals : [])];
  return [...new Set(texts.flatMap(numTokens))];
}

module.exports = { MAX_LINE, shortDate, usableSources, sourceLine, sourceLabel, topicNumbers };
