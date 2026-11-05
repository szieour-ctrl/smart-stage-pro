// lib/agent-marketing-b1-claims-lib.js — Netlify (shared). DEVELOPMENT ONLY (Nov 5, 2026). Decision D1: content-gate checks for B1 article evidence.
//
// Used by agent-marketing-gate.js ONLY when the topic carries a B1 evidence bundle and AGENT_MARKETING_B1_EVIDENCE=dev (verifiedFromTopic then
// adds a `b1` context). With B1 disabled nothing here runs and the legacy gate is unchanged.
//
// Two checks, deliberately narrow (no semantic inference, no n-word overlap rule):
//   1. held_quote: a held or excluded B1 quotation restored word for word is blocked, unless a validated quotation contains it too
//      (independently authorized). Only quotations of MIN_HELD_WORDS words or more are matched, so a validated statement that merely shares
//      common words with a held one is never blocked.
//   2. claim context: a matching number does not authorize a claim. Every market figure in a sentence that appears anywhere in the B1 evidence
//      (validated, held or excluded) must be authorized by ONE applicable validated claim finding: its quotations contain every such figure in
//      the sentence, and every geography, period or comparison basis, measurement, direction and proper name the sentence states appears in
//      that finding's own quotations or attribution. A hedge the quotation puts on the figure ("a slight", "around") must be kept, and a
//      measurement basis it states (median, average) must not be dropped. Held and excluded findings are never support.
//      Figures the agent supplied (intake, uploaded report, report-derived calculations) are not checked here: rule 2f and the legacy gate own them.
//      If the bundle is BLOCKED, no figure outside the agent's own numbers is authorized.
"use strict";

const b1 = require("./agent-marketing-b1-evidence-lib");

const MIN_HELD_WORDS = 5;
const MONTHS = ["january", "february", "march", "april", "may", "june", "july", "august", "september", "october", "november", "december"];
const PERIOD_PHRASES = ["year to date", "this year", "last year", "a year earlier", "a year ago", "year over year", "month over month", "this month",
  "last month", "past 12 months", "past year", "annual", "annually", "monthly", "quarterly", "quarter", "decade", "weekly", "spring", "summer", "autumn", "winter"];
const GEO_WORDS = ["county", "counties", "region", "regional", "statewide", "state", "nationwide", "national", "nationally", "nation", "country",
  "metro", "metropolitan", "city", "citywide", "downtown", "valley", "suburb", "suburbs"];
const STAT_WORDS = ["median", "average", "mean", "typical"];
const MEASURES = ["sales volume", "sales price", "sale price", "list price", "listing price", "asking price", "price per square foot", "days on market",
  "closed sales", "pending sales", "pendings", "inventory", "listings", "listing", "homeownership rate", "mortgage", "interest rate", "rate", "jobs",
  "employment", "unemployment", "rents", "rent", "offers", "prices", "price", "sales", "permits", "foreclosures", "supply", "values", "value"];
const UP = ["rose", "risen", "rise", "rises", "rising", "up", "increase", "increased", "increases", "increasing", "higher", "gain", "gained", "gains",
  "climb", "climbed", "climbing", "jump", "jumped", "grew", "grow", "growing", "growth", "above"];
const DOWN = ["fell", "falls", "falling", "down", "decrease", "decreased", "decreases", "decline", "declined", "declines", "declining", "lower",
  "drop", "dropped", "drops", "dip", "dipped", "slipped", "shrank", "below", "less", "fewer"];
const HEDGES = ["slight", "slightly", "roughly", "about", "approximately", "around", "nearly", "almost", "estimated", "some"];
// Capitalized words that commonly open a sentence and are not names (sentence-initial capitals are otherwise read as names, e.g. "Sacramento's").
const STARTERS = new Set(("according the a an in this that these those so but and here data what homes home prices price inventory it it's its we " +
  "you your our buyers sellers right now over last since at for with as if when meanwhile still today recent recently overall across locally " +
  "there they their sales listings median average jobs mortgage rates rate one two three four five six seven eight nine ten while even also " +
  "which where why how who more fewer only just about around nearly roughly some many most all both each every on of to from by after before " +
  "during until compared within year this's that's what's let's let me my i'm i've").split(/\s+/));

const ent = (s) => String(s == null ? "" : s).replace(/&#39;|&apos;/g, "'").replace(/&quot;/g, '"').replace(/&amp;/g, "&");
const norm = (s) => ent(s).replace(/[‘’]/g, "'").replace(/[“”]/g, '"').replace(/\s+/g, " ").trim();
/** Lowercase word stream for verbatim matching: punctuation dropped except what belongs to a figure. */
const words = (s) => norm(s).toLowerCase().replace(/(\d),(\d)/g, "$1$2").replace(/[^a-z0-9%.'\s-]/g, " ").replace(/(?<!\d)\.|\.(?!\d)/g, " ")
  .replace(/-/g, " ").split(/\s+/).filter(Boolean);
const phraseText = (s) => ` ${words(s).join(" ")} `;
const has = (hay, phrase) => hay.includes(` ${phrase} `);

function numbersIn(text) {
  const out = new Set(); const re = /\d[\d,]*(?:\.\d+)?/g; let m; const t = norm(text);
  while ((m = re.exec(t))) out.add(m[0].replace(/,/g, "").replace(/\.0+$/, ""));
  return out;
}

/** The gate's B1 context for a topic's B1 view (server-side only; never sent to the Planner or the client). */
function contextFromView(view) {
  if (!view) return null;
  if (view.status === b1.BLOCKED) return { blocked: true, validated: [], held: [], numbers: new Set() };
  const claims = view.validated.filter((x) => b1.CLAIM_SECTIONS.includes(x.section));
  const validated = claims.map((x) => {
    const quotes = b1.quotesOf(x.finding).map(norm);
    // Attribution names a source; it never supplies geography, period or measurement. A name in it counts only as the whole name
    // (e.g. "Riverside Housing Blog"), so a place word inside a source's title never authorizes that place on its own.
    const attribution = norm(b1.attributionOf(x.section, x.finding) || "");
    const attrNames = (attribution.match(/[A-Z][A-Za-z.'’-]*(?:\s+[A-Z][A-Za-z.'’-]*)*/g) || []).map((n) => words(n).join(" ")).filter(Boolean);
    return { section: x.section, quotes, support: phraseText(quotes.join(" \n ")), attrNames, numbers: numbersIn(quotes.join(" \n ")) };
  });
  const validatedText = phraseText(validated.flatMap((v) => v.quotes).join(" | "));
  const held = [...view.held, ...view.excluded].flatMap((x) => b1.quotesOf(x.finding)).map(norm)
    .filter((q) => words(q).length >= MIN_HELD_WORDS && !validatedText.includes(phraseText(q))); // independently authorized held text is not "held"
  const numbers = new Set();
  [...view.validated, ...view.held, ...view.excluded].forEach((x) => b1.quotesOf(x.finding).forEach((q) => numbersIn(q).forEach((n) => numbers.add(n))));
  return { blocked: false, validated, held, numbers };
}

function sentences(text) {
  return norm(String(text).replace(/\[[a-z_ ]+\]/gi, " ")).split(/(?<=[.!?…])\s+(?=[^a-z])/).map((s) => s.trim()).filter(Boolean);
}

/** What a sentence states besides its figures: the descriptors the authorizing finding must support. */
function descriptors(sentence) {
  const p = phraseText(sentence);
  const d = { period: [], geography: [], measurement: [], stat: [], direction: [], names: [], hedge: false };
  MONTHS.forEach((m) => { if (has(p, m) && !(m === "may" && !/\bMay\b/.test(sentence))) d.period.push(m); });
  PERIOD_PHRASES.forEach((x) => { if (has(p, x)) d.period.push(x); });
  (sentence.match(/\b(?:19|20)\d{2}\b(?!\s*%)/g) || []).forEach((y) => d.period.push(y));
  GEO_WORDS.forEach((x) => { if (has(p, x)) d.geography.push(x); });
  let rest = p;
  MEASURES.forEach((x) => { if (has(rest, x)) { d.measurement.push(x); rest = rest.split(` ${x} `).join("  "); } });   // longest phrases first
  STAT_WORDS.forEach((x) => { if (has(p, x)) d.stat.push(x); });
  if (UP.some((x) => has(p, x))) d.direction.push("up");
  if (DOWN.some((x) => has(p, x))) d.direction.push("down");
  d.hedge = HEDGES.some((x) => has(p, x));
  const toks = norm(sentence).replace(/^[^A-Za-z0-9]+/, "").split(/\s+/);
  toks.forEach((tok, i) => {
    const w = tok.replace(/^[^A-Za-z]+|[^A-Za-z.'’]+$/g, "").replace(/['’]s$/, "").replace(/\.$/, "");
    if (!/^[A-Z][A-Za-z.'’-]*$/.test(w) || /^I(?:'m|'ve|'d|'ll)?$/.test(w)) return;
    if (MONTHS.includes(w.toLowerCase()) || GEO_WORDS.includes(w.toLowerCase())) return;   // a period or geography word, checked above
    if (i === 0 && STARTERS.has(w.toLowerCase())) return;
    d.names.push(w.toLowerCase());
  });
  return d;
}

/** Why `finding` does not authorize the sentence's descriptors for the figure(s) (empty = authorized). */
function unsupported(d, finding, figures, sentence) {
  const s = finding.support, why = [];
  const sp = phraseText(sentence);
  const named = (x) => has(s, x) || finding.attrNames.some((a) => has(` ${a} `, x) && has(sp, a));
  const stem = (x) => x.replace(/s$/, "");
  d.period.forEach((x) => { if (!has(s, x)) why.push(`period "${x}"`); });
  d.geography.forEach((x) => { if (!has(s, x) && !has(s, stem(x))) why.push(`geography "${x}"`); });
  d.names.forEach((x) => { if (!named(x)) why.push(`"${x}"`); });
  d.measurement.forEach((x) => { if (!has(s, x) && !s.includes(` ${stem(x)}`)) why.push(`measurement "${x}"`); });
  d.stat.forEach((x) => { if (!has(s, x)) why.push(`measurement "${x}"`); });
  const fStat = STAT_WORDS.filter((x) => has(s, x));
  if (fStat.length && !d.stat.some((x) => fStat.includes(x))) why.push(`the measurement basis (${fStat.join("/")}) is dropped`);
  const fDir = [UP.some((x) => has(s, x)) && "up", DOWN.some((x) => has(s, x)) && "down"].filter(Boolean);
  d.direction.forEach((x) => { if (!fDir.includes(x)) why.push(`direction "${x}"`); });
  // A hedge the source puts on the figure itself ("a slight 3%", "around 9,000") must be kept.
  const hedged = finding.quotes.some((q) => [...figures].some((n) => {
    const t = norm(q).replace(/(\d),(\d)/g, "$1$2"); const i = t.indexOf(n); if (i < 0) return false;
    return HEDGES.some((h) => new RegExp(`\\b${h}\\b`, "i").test(t.slice(Math.max(0, i - 25), i)));
  }));
  if (hedged && !d.hedge) why.push("the source's qualifier on the figure is dropped");
  return why;
}

/**
 * scan(text, field, ctx, opts, blocks, sourcedFacts)
 *   ctx: contextFromView(); opts: { figureTokens(text) -> Set, agentNumbers: Set }.
 */
function scan(text, field, ctx, opts, blocks, sourcedFacts) {
  if (!ctx || !text) return;
  const whole = phraseText(text);
  for (const q of ctx.held) {
    if (whole.includes(phraseText(q))) blocks.push({ rule: "b1_held_quote", field, match: norm(q).slice(0, 80),
      message: "This repeats an article statement that is held for review and not verified. Leave it out unless it is approved." });
  }
  for (const sentence of sentences(text)) {
    const figures = [...opts.figureTokens(sentence)].filter((n) => !opts.agentNumbers.has(n) && (ctx.blocked || ctx.numbers.has(n)));
    if (!figures.length) continue;
    if (ctx.blocked) { figures.forEach((n) => blocks.push({ rule: "b1_unsupported_figure", field, match: n, message: `The article evidence is blocked, so ${n} cannot be stated.` })); continue; }
    const candidates = ctx.validated.filter((f) => figures.every((n) => f.numbers.has(n)));
    if (!candidates.length) {
      const one = figures.filter((n) => !ctx.validated.some((f) => f.numbers.has(n)));
      if (one.length) one.forEach((n) => blocks.push({ rule: "b1_unsupported_figure", field, match: n,
        message: `${n} comes only from article statements that are held for review or excluded. Leave it out.` }));
      else blocks.push({ rule: "b1_unsupported_figure", field, match: figures.join(" + "),
        message: `${figures.join(" and ")} come from different verified article statements. State each in its own sentence, as the article gives it.` });
      continue;
    }
    const d = descriptors(sentence);
    const reasons = candidates.map((f) => unsupported(d, f, figures, sentence));
    if (reasons.some((r) => r.length === 0)) { figures.forEach((n) => sourcedFacts.push(`${field}: ${n} (B1 validated)`)); continue; }
    const best = reasons.reduce((a, b) => (b.length < a.length ? b : a));
    blocks.push({ rule: "b1_claim_context", field, match: sentence.slice(0, 80),
      message: `No verified article statement supports ${figures.join(", ")} as written here (unsupported: ${best.join("; ")}). State it the way the verified article statement does.` });
  }
}

module.exports = { MIN_HELD_WORDS, contextFromView, scan, descriptors, sentences };
