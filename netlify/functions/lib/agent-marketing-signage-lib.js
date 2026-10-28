// lib/agent-marketing-signage-lib.js — Netlify (shared). Sam's rule (Oct 27, 2026): no real estate sign of any kind (For Sale, open house, yard sign,
// blank or branded) is ever AI-generated, and the idea is never put in an image prompt, not even as a "do not draw" line.
// Claude is told not to write one; this is the code backstop that removes any sentence or clause that mentions one before text goes to the image model.
"use strict";

// Only a real estate sign is removed (Sam, Oct 28): "signs of a cooling market" or "a design detail" is ordinary wording and stays.
const SIGN_RE = /\b(?:(?:yard|lawn|curb|real[- ]estate|for[- ]?sale|for[- ]?lease|for[- ]?rent|open[- ]?house|sold|realtor|brokerage|listing|agent'?s?|broker'?s?)[- ]signs?|signs?\s+(?:says?|reads?|reading|saying)\s+(?:["'\u201c]?\s*)?(?:for[- ]sale|open[- ]house|sold|just[- ]listed)|signage|placards?|billboards?)\b/i;
// A bare "sign" next to real estate or yard words in the same piece ("a sign leaning in the front yard", "a sign at the curb").
const SIGN_CONTEXT = /\b(?:yard|lawn|curb|stake|for[- ]sale|open[- ]house|real[- ]estate|listing)\b/i;
const BARE_SIGN = /\bsigns?\b/i;
const mentions = (t) => SIGN_RE.test(t) || (BARE_SIGN.test(t) && SIGN_CONTEXT.test(t));
const hasSignage = (text) => mentions(String(text || ""));

/** Removes every clause or sentence that mentions a sign. Returns the cleaned text (possibly empty). */
function scrubSignage(text) {
  const t = String(text == null ? "" : text);
  if (!mentions(t)) return t;
  const sentences = t.split(/(?<=[.!?])\s+/);
  const kept = [];
  for (const s of sentences) {
    if (!mentions(s)) { kept.push(s); continue; }
    // drop only the offending clause when the sentence has others (commas, semicolons, dashes)
    const clauses = s.split(/(?<=[,;])\s+|\s+[—–-]\s+/).filter((c) => !mentions(c));
    if (clauses.length) {
      let joined = clauses.join(" ").replace(/[,;]\s*$/, "").trim();
      if (joined && !/[.!?]$/.test(joined)) joined += ".";
      if (joined.split(/\s+/).length >= 4) kept.push(joined);
    }
  }
  return kept.join(" ").replace(/\s{2,}/g, " ").trim();
}

module.exports = { hasSignage, scrubSignage, SIGN_RE };
