// lib/agent-marketing-signage-lib.js — Netlify (shared). Sam's rule (Oct 27, 2026): no real estate sign of any kind (For Sale, open house, yard sign,
// blank or branded) is ever AI-generated, and the idea is never put in an image prompt, not even as a "do not draw" line.
// Claude is told not to write one; this is the code backstop that removes any sentence or clause that mentions one before text goes to the image model.
"use strict";

const SIGN_RE = /\b(?:yard[- ]?signs?|lawn[- ]?signs?|for[- ]?sale|for[- ]?lease|for[- ]?rent|open[- ]?house|sold[- ]sign|signs?|signage|placards?|billboards?)\b/i;
const hasSignage = (text) => SIGN_RE.test(String(text || ""));

/** Removes every clause or sentence that mentions a sign. Returns the cleaned text (possibly empty). */
function scrubSignage(text) {
  const t = String(text == null ? "" : text);
  if (!SIGN_RE.test(t)) return t;
  const sentences = t.split(/(?<=[.!?])\s+/);
  const kept = [];
  for (const s of sentences) {
    if (!SIGN_RE.test(s)) { kept.push(s); continue; }
    // drop only the offending clause when the sentence has others (commas, semicolons, dashes)
    const clauses = s.split(/(?<=[,;])\s+|\s+[—–-]\s+/).filter((c) => !SIGN_RE.test(c));
    if (clauses.length) {
      let joined = clauses.join(" ").replace(/[,;]\s*$/, "").trim();
      if (joined && !/[.!?]$/.test(joined)) joined += ".";
      if (joined.split(/\s+/).length >= 4) kept.push(joined);
    }
  }
  return kept.join(" ").replace(/\s{2,}/g, " ").trim();
}

module.exports = { hasSignage, scrubSignage, SIGN_RE };
