// agent-marketing-sources-lib.js — the on-screen source line for a Reel built from web research instead of an uploaded report (Oct 26, 2026).
// The text is built by code from the sources the research step already checked (https, dated, not paywalled) and the topic's own scope
// note. It replaces the MetroList notice, which belongs only to MetroList report data. It is shown on screen, never spoken.
"use strict";

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
const MAX_LINE = 170; // the 9:16 bar holds 3 lines (about 190 characters of ordinary text); 170 leaves room for wide words
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
  const meta = ` (${hostOf(first.url)}, ${shortDate(first.published)})`;
  const end = (t) => (/[.!?]$/.test(t) ? t : t + ".");
  // A long scope note is cut back to the part that says what the figures cover (never mid-word) so the source title still has room;
  // the coverage statement is kept ahead of anything else, and with no such part the opening clauses are kept.
  const pieces = scope.split(/(?<=[.!?])\s+|;\s+|\s+[—–]\s+/).map((x) => x.trim()).filter(Boolean);
  const COVERS = /\b(cover|covers|covering|national|nationwide|statewide|not all|not lincoln|only|limited to)\b/i;
  const coverage = pieces.filter((x) => COVERS.test(x));
  const lead = pieces.map((_, i) => pieces.slice(0, pieces.length - 1 - i).join("; ")).filter(Boolean);
  const candidates = [scope, ...coverage, ...lead];
  for (const c of candidates.length ? candidates : [""]) {
    const tail = (more > 0 ? ` + ${more} more` : "") + "." + (c ? ` ${end(c)}` : "");
    const room = MAX_LINE - ("Source: ".length + meta.length + tail.length);
    if (room >= 20) return `Source: ${trimTitle(first.title, room)}${meta}${tail}`;
  }
  return "";
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
  // An event's own date, time and place were confirmed from the organizer's page during research, so their numbers are verified ("November 14", "10 am to 2 pm").
  const e = t.event && typeof t.event === "object" ? t.event : null;
  if (e) texts.push(e.name, e.date, e.endDate, e.time, e.location, e.organizer);
  if (t.reframed === true) {
    (Array.isArray(t.areaContext) ? t.areaContext : []).forEach((c) => texts.push(c && c.text));
    (Array.isArray(t.answeredBy) ? t.answeredBy : []).forEach((f) => texts.push(f && f.text));
  }
  return [...new Set(texts.flatMap(numTokens))];
}

module.exports = { MAX_LINE, shortDate, usableSources, sourceLine, sourceLabel, topicNumbers };
