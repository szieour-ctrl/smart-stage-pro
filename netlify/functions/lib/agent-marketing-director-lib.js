// lib/agent-marketing-director-lib.js — Netlify (shared). Editorial Style Director, first version (Oct 26, 2026).
//
// Turns an APPROVED narrative plus the verified report figures into the scene cards of an am-manifest-2: which composition each scene
// uses and the words and numbers on it. Deterministic and rule-based; it writes nothing the approved narration does not already say.
//   - A number on a card is a verified figure that the scene's own narration states (matched by value), or a validated calculation.
//   - Card wording comes from the narration, the report labels and the hook; it never adds a claim.
//   - Every choice carries a plain-language reason, so the agent (and later the preview step) can see why.
// The AI Recommended default lives here; subscriber overrides (a later PR) change compositions, never narration or statistics.
"use strict";

const { parseNumber } = require("./agent-marketing-manifest-lib");

const KEY_TEMPLATES = {
  // key + group → how a lone figure reads as a big-number card
  median_dom: { active: { lead: "Active Listings Are Sitting a Median of", unit: "days", trail: "Before Going Under Contract" }, closed: { lead: "Homes That Sold Took a Median of", unit: "days", trail: "To Go Under Contract" } },
  avg_dom: { active: { lead: "Active Listings Have Averaged", unit: "days", trail: "On the Market" }, closed: { lead: "Homes That Sold Averaged", unit: "days", trail: "On the Market" } },
};

const titleCase = (s) => String(s || "").replace(/\w\S*/g, (w) => (/^(a|an|and|as|at|but|by|for|in|of|on|or|the|to)$/i.test(w) ? w.toLowerCase() : w[0].toUpperCase() + w.slice(1)));
const stripTags = (s) => String(s || "").replace(/\[[^\]\n]{1,40}\]/g, " ").replace(/\s+/g, " ").trim();
const numbersIn = (text) => (String(text || "").match(/\d[\d,]*(?:\.\d+)?/g) || []).map((t) => Number(t.replace(/,/g, "")));
const groupOf = (label) => (/closed/i.test(label) ? "closed" : /active/i.test(label) ? "active" : /pending/i.test(label) ? "pending" : "other");

/** Report figures → manifest figures. n (the listings behind a figure) is the count figure that shares its period. */

// A change figure's display is "down 5.9%" / "up 3.1%", but the big number keeps only 5.9, so the direction has to be in the card's own words
// (Oct 29, 2026: "For-sale listings, change from a year earlier 5.9%" read as growth when inventory was down).
function changeLead(f) {
  const dir = /^\s*(down|up)\b/i.exec(String(f.display || ""));
  if (!dir) return f.label;
  const d = dir[1].toLowerCase();
  return /change from/i.test(f.label) ? f.label.replace(/change from/i, `${d} from`) : `${f.label}, ${d}`;
}
function figuresFrom(reportFigures) {
  const rows = Array.isArray(reportFigures) ? reportFigures : [];
  const periodOf = (r) => (/\(([^)]+)\)\s*$/.exec(r.text || "") || [])[1] || "";
  const counts = {};
  rows.forEach((r) => { if (r.key === "count" && r.ref) counts[periodOf(r)] = counts[periodOf(r)] || parseNumber(r.display); });
  return rows.filter((r) => r.ref).map((r) => ({ ref: r.ref, key: r.key, label: r.label, display: r.display, value: parseNumber(r.display), n: counts[periodOf(r)] ?? null, group: groupOf(r.label) }));
}

/** The figures a scene's narration states, matched by number (and by % when the narration says "percent of list"). */
function figuresInExcerpt(excerpt, figures) {
  const text = stripTags(excerpt);
  const found = [];
  const taken = new Set();
  const wordsBefore = (num) => { const i = text.indexOf(String(num)); return i < 0 ? "" : text.slice(Math.max(0, i - 60), i + String(num).length + 40).toLowerCase(); };
  for (const num of numbersIn(text)) {
    const cands = figures.filter((f) => f.value === num && !taken.has(f.ref));
    if (!cands.length) continue;
    const ctx = wordsBefore(num);
    const score = (f) => (/closed|sold/.test(ctx) && f.group === "closed" ? 2 : 0) + (/active|listings|sitting/.test(ctx) && f.group === "active" ? 2 : 0) + (/day/.test(ctx) && /dom/.test(f.key) ? 2 : 0) + (/%|percent/.test(ctx) && /pct|percent/.test(f.key) ? 3 : 0) + (/reduc/.test(ctx) && /reduc/.test(f.key) ? 3 : 0) + (/median/.test(ctx) && /median/.test(f.key) ? 1 : 0);
    const best = cands.slice().sort((a, b) => score(b) - score(a))[0];
    taken.add(best.ref);
    found.push(best);
  }
  return found;
}

/** The hook as a card headline: drops the "if you're thinking about selling in X," lead-in. */
function headlineFromHook(hook, market) {
  let t = stripTags(hook).replace(/[.!?]+$/, "");
  t = t.replace(/^if you(?:'|’)re (?:thinking about )?(?:selling|buying)[^,]*,\s*/i, "");
  return titleCase(t.charAt(0).toUpperCase() + t.slice(1));
}

// The opening headline comes from the planner's hook. When the agent has EDITED the script, that hook may describe the old wording (Oct 29, 2026: an edited
// event script still opened with "Free Cars and Coffee"), so it is used only while every word of it is still in the first scene's text; otherwise the
// headline is taken from the edited first sentence, whole and not cut off.
function openingHook(narrative, excerpt) {
  const hook = narrative && narrative.hook;
  if (hook && !(narrative.source === "edited")) return hook;
  const words = (t) => String(t || "").toLowerCase().replace(/[\u2019']/g, "'").match(/[a-z0-9$%']{4,}/g) || [];
  const have = new Set(words(excerpt));
  if (hook && words(stripTags(hook)).every((w) => have.has(w))) return hook;
  const first = (String(excerpt || "").split(/(?<=[.!?\u2026])\s+/)[0] || excerpt || "");
  const clause = first.split(/\s*[\u2014\u2013,:;\u2026]\s*|\s+-\s+/)[0].replace(/[.!?]+$/, "").trim() || first;
  return wc(clause) <= 11 ? clause : fitWords(clause, CARD_CAPS.headline);
}
const marketName = (intake) => String((intake && intake.market) || "").split(",")[0].trim();

/** A whole sentence, or a whole clause of it, that fits `cap` words (never a sentence cut off mid-thought); null when none does. */
function wholePart(sentence, cap) {
  const whole = String(sentence || "").trim();
  if (!whole) return null;
  if (wc(whole) <= cap) return whole;                       // fits as written, punctuation included
  const t = dropLead(whole.replace(/[.!?…]+$/, "").trim());
  const clause = t.split(/\s*[,;:—–]\s*|\s+-\s+/).map((c) => c.trim()).find((c) => wc(c) >= 3 && wc(c) <= cap);
  return clause ? upFirst(clause) : null;
}

function closingHeadline(excerpt) {
  const t = stripTags(excerpt).replace(/\s+/g, " ");
  const q = /^(.*?\?)\s*(.*)$/.exec(t);
  // The headline is held to the closing cap (Sam's word caps, Oct 27): a long invitation shows a clause that carries the point instead of
  // the whole sentence, so the card always fits both frames. Oct 29 (Eskaton test): it must also read as a complete thought, so when the first
  // sentence has no clause that fits, the next sentence that does is used; only when nothing fits is the first sentence shortened.
  const sentences = q ? [q[1]] : t.split(/(?<=[.!?…])\s+/).filter(Boolean);
  const first = (sentences[0] || t).replace(/^want to /i, "Want to ");
  let short = null;
  for (const s of sentences) { short = wholePart(s, CARD_CAPS.closing); if (short) break; }
  if (!short) short = upFirst(fitWords(first, CARD_CAPS.closing));
  const words = short.split(" ").filter(Boolean), cut = Math.ceil(words.length / 2);
  return { headline: [words.slice(0, cut).join(" "), words.slice(cut).join(" ")], support: capSupport(q ? q[2] : "") };
}

/** A support line within the support cap: the first sentence that fits whole, else its first clause that does; "" when none. */
function capSupport(text) {
  const sentence = stripTags(text).split(/(?<=[.!?…])\s+/).filter(Boolean).find((x) => wc(dropLead(x)) <= CARD_CAPS.support);
  if (sentence) return upFirst(dropLead(sentence));
  const first = stripTags(text).split(/(?<=[.!?…])\s+/)[0] || "";
  const clause = first ? fitWords(first, CARD_CAPS.support) : "";
  return clause && wc(clause) <= CARD_CAPS.support ? upFirst(clause) : "";
}

// The opening card of a Local Events Reel carries when the event happens (Sam, Oct 29 Eskaton test): "Saturday, Nov 14 · 10 a.m. to 2 p.m.".
// Built from the research step's confirmed date and time, so every number on it is already verified.
const WEEKDAY = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];
const MON = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
const ymd = (v) => { const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(String(v || "")); return m && +m[2] >= 1 && +m[2] <= 12 ? { y: +m[1], m: +m[2], d: +m[3] } : null; };
function niceTime(t) {
  // The card shows the published time only: the first clause, never a research note ("all day; page also describes ...").
  let x = String(t || "").replace(/\s+/g, " ").trim().split(/\s*[;(]\s*/)[0];
  if (x.length > 26) x = "";
  return x.replace(/(\d{1,2})(?::00)?\s*([ap])\.?m\b\.?/gi, (_, h, ap) => `${h} ${ap.toLowerCase()}.m.`);
}
function eventWhen(e) {
  // The page's own wording of when the event runs wins over a date range built from the research window.
  const pub = e && e.datesAsPublished ? String(e.datesAsPublished).replace(/\s+/g, " ").trim() : "";
  if (pub && pub.length <= 30) return pub.charAt(0).toUpperCase() + pub.slice(1);
  const a = ymd(e && e.date);
  if (!a) return "";
  const b = ymd(e.endDate);
  let day = `${WEEKDAY[new Date(Date.UTC(a.y, a.m - 1, a.d)).getUTCDay()]}, ${MON[a.m - 1]} ${a.d}`;
  if (b && (b.y !== a.y || b.m !== a.m || b.d !== a.d)) day = a.m === b.m ? `${MON[a.m - 1]} ${a.d}\u2013${b.d}` : `${MON[a.m - 1]} ${a.d} \u2013 ${MON[b.m - 1]} ${b.d}`;
  return [day, niceTime(e.time)].filter(Boolean).join(" \u00b7 ");
}

/**
 * plan(narrative, intake, figures) → { scenes[], derived[], reasons[], problems[] }
 * Each scene: { composition, narrative_role, branding, data, claims[], reason }. Windows, images and audio are added later.
 */
function plan(narrative, intake, figures, opts) {
  const cardCopy = (opts && opts.cardCopy) || {};
  const eventReel = !!(opts && opts.eventReel);   // a Local Events Reel is not a market update: its cards say so
  const scenes = (narrative && narrative.scenes) || [];
  const market = marketName(intake);
  const out = [], derived = [], problems = [];
  scenes.forEach((s, i) => {
    const first = i === 0, last = i === scenes.length - 1;
    const hits = figuresInExcerpt(s.narrationExcerpt, figures);
    const base = { narrative_role: s.role, branding: first || last ? "full" : "subtle", narration_excerpt: s.narrationExcerpt, camera_motion: s.cameraMotion, visual: s, claims: [] };
    if (first) {
      out.push({ ...base, composition: "opening_headline_focus", data: { market, kind: eventReel ? "Local Events" : "Market Update", headline: headlineFromHook(openingHook(narrative, s.narrationExcerpt), market), eyebrow: eventReel ? (eventWhen(opts && opts.event) || "Happening Locally") : "Seller Insight" }, reason: "Opening scene: the hook sets the competitive context over a cinematic establishing image." });
    } else if (last) {
      const c = closingHeadline(s.narrationExcerpt);
      out.push({ ...base, composition: "closing_headline_focus", data: { headline: c.headline, support: c.support || capSupport(narrative.cta && narrative.cta.text) || "", tagline: eventReel ? "Local Life · Community" : "Pricing · Condition · Competition" }, reason: "Closing scene: the agent's low-pressure invitation with full branding." });
    } else if (hits.length === 1) {
      const f = hits[0], t = (KEY_TEMPLATES[f.key] || {})[f.group];
      const unit = t ? t.unit : /%/.test(f.display) ? "%" : "";
      out.push({ ...base, composition: "stat_big_number", data: { lead: t ? t.lead : changeLead(f), value: String(f.value), ...(/^\s*\$/.test(f.display) ? { prefix: "$" } : {}), ...(unit ? { unit } : {}), ...(/^\s*(down|up)\b/i.test(f.display) ? { direction: /^\s*down/i.test(f.display) ? "down" : "up" } : {}), ...(t ? { trail: t.trail } : {}), icon: /dom/.test(f.key) ? "calendar" : "none" }, claims: [{ field: "value", figure: f.ref }], reason: `One verified figure (${f.label}: ${f.display}) is the point of this scene, so it gets the big-number treatment.` });
    } else if (hits.length >= 2) {
      const pct = hits.find((f) => /%/.test(f.display)), red = hits.find((f) => /reduc/.test(f.key));
      const totalFig = red ? (figures.find((f) => f.key === "count" && f.group === "active" && f.n === parseNumber(f.display)) || hits.find((f) => f !== red && f !== pct)) : null;
      if (pct && red && totalFig && numbersIn(s.narrationExcerpt).includes(totalFig.value)) {
        out.push({ ...base, composition: "compare_two_card", data: { market: (sceneHeadline(s.narrationExcerpt) || [])[0] || market, kind: (sceneHeadline(s.narrationExcerpt) || [])[1] || "Market Update", left: { lead: "Homes That Closed Sold At", percent: pct.value, caption: "of list price on average", icon: "sold" }, right: { lead: "But Here in the Active Market,", highlighted: red.value, total: totalFig.value, caption: "listings have already taken a price reduction.", icon: "reduced" } }, claims: [{ field: "left.percent", figure: pct.ref }, { field: "right.highlighted", figure: red.ref }, { field: "right.total", figure: totalFig.ref }], reason: "The scene contrasts two verified figures (sold-to-list and price reductions), so it is shown side by side." });
      } else {
        problems.push(`Scene ${i + 1} states ${hits.length} figures but no comparison layout fits them; it uses the statement card without numbers.`);
        out.push({ ...base, composition: "expert_takeaway", data: statement(s, cardCopy[i]), reason: "Several figures with no matching comparison layout; the numbers stay in the narration." + (cardCopy[i] ? " Card text is the agent's perspective." : "") });
      }
    } else {
      out.push({ ...base, composition: "expert_takeaway", data: statement(s, cardCopy[i]), reason: "No figure is stated here, so the scene carries the takeaway as a statement." + (cardCopy[i] ? " Card text is the agent's perspective." : "") });
    }
  });
  return { scenes: out, derived, problems };
}

// A short headline for a comparison scene, taken from the script's own words: the closing sentence of the scene (when it has no
// numbers), with a long "between ..." clause folded away ("That gap between homes ... tells a real story" -> "That gap tells a real
// story"). Returns null when no short sentence like that exists, and the card keeps its market title.
function sceneHeadline(excerpt) {
  const sentences = stripTags(excerpt).split(/(?<=[.!?…])\s+/).filter(Boolean);
  let last = (sentences[sentences.length - 1] || "").replace(/[.!?…]+$/, "").trim();
  if (!last || /\d/.test(last)) return null;
  const m = /^(.+?)\s+between\s+.+?\s+((?:tells|shows|means|says|reveals)\s+.+)$/i.exec(last);
  if (m) last = `${m[1]} ${m[2]}`;
  const w = last.split(" ");
  if (w.length < 3 || w.length > 8) return null;
  const c = Math.ceil(w.length / 2), up = (t) => t.charAt(0).toUpperCase() + t.slice(1);
  return [up(titleCase(w.slice(0, c).join(" "))), up(titleCase(w.slice(c).join(" ")))];
}

// Word caps for the card lines (Sam, Oct 27): headline 9, statement 7, support 8; the closing headline 8 (the closing card also carries the name lockup).
const CARD_CAPS = { headline: 9, statement: 7, support: 8, closing: 8 };
const wc = (t) => (String(t || "").match(/[A-Za-z0-9À-ɏ][A-Za-z0-9À-ɏ'’\-]*/g) || []).length;
const upFirst = (t) => String(t || "").replace(/^\S/, (c) => c.toUpperCase());
const dropLead = (t) => String(t || "").replace(/^(?:because|and|but|so)\s+/i, "");
/** The first clause that fits the cap (a whole sentence if it fits), else the first `n` words. */
function fitWords(sentence, n) {
  const t = dropLead(String(sentence || "").replace(/[.!?…]+$/, "").trim());
  if (wc(t) <= n) return t;
  const clause = t.split(/\s*[,;:—–]\s*|\s+-\s+/).map((c) => c.trim()).find((c) => wc(c) >= 3 && wc(c) <= n);
  if (clause) return clause;
  // no clause fits: drop a lead-in like "this means", keep the first words, and never end on a dangling joining word
  let words = t.replace(/^(?:this|that|which) means\s+/i, "").split(/\s+/).slice(0, n);
  while (words.length > 3 && /^(?:the|a|an|is|are|was|what|that|of|and|or|to|for|from|in|on|with|than|as|by)$/i.test(words[words.length - 1])) words.pop();
  return words.join(" ");
}
/** The headline as the two lines the card draws, each starting with a capital. */
function headlineLines(text) {
  const w = String(text || "").split(" ").filter(Boolean), c = Math.ceil(w.length / 2);
  return [upFirst(titleCase(w.slice(0, c).join(" "))), upFirst(titleCase(w.slice(c).join(" ")))];
}

/** Statement card text. `copy` is Claude-written text that already passed its checks; without it, whole narration sentences within the caps are used. */
function statement(scene, copy) {
  if (copy && copy.headline) return { headline: headlineLines(copy.headline), statement: upFirst(copy.statement || ""), support: upFirst(copy.support || "") };
  const sentences = stripTags(scene.narrationExcerpt).split(/(?<=[.!?…])\s+/).filter(Boolean);
  const pick = (list, n) => { const s = list.find((x) => wc(dropLead(x)) <= n); return s ? upFirst(dropLead(s)) : ""; };
  const headline = fitWords(sentences[0] || "", CARD_CAPS.headline);
  return { headline: headlineLines(headline), statement: pick(sentences.slice(1), CARD_CAPS.statement), support: pick(sentences.slice(2), CARD_CAPS.support) };
}

module.exports = { CARD_CAPS, headlineLines, sceneHeadline, figuresFrom, figuresInExcerpt, headlineFromHook, closingHeadline, eventWhen, plan, titleCase, stripTags };
