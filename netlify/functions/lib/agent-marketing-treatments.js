// lib/agent-marketing-treatments.js — Netlify (shared). The five editorial treatments for Local Market Insider (Oct 26, 2026).
//
// Pure data plus lookups. A treatment is a design approach (visual language, type hierarchy, image-to-graphic balance, motion,
// branding level, the compositions it supports), NOT a template and NOT a brand: every treatment uses the subscriber's own
// Brand DNA (headshot, logo, colors, ONE font family from brand-themes.js, contact details), which is never changed here.
//
// The Editorial Style Director (a later PR) chooses among these; the resolved definition travels inside the render manifest, so
// Railway needs no copy of this file. Listing Reel v1 does not import it.
"use strict";

const BRANDING = ["full", "subtle", "minimal"];

// Compositions: one drawn layout of one scene. `status` says whether the Railway renderer can draw it today.
//   role   — the kind of scene it suits (opening, middle, closing)
//   data   — the verified data shape it needs: none | one_value | two_measures | proportion | series | statement | location
//   renderer — the Railway card function that draws it (null while planned)
const COMPOSITIONS = {
  opening_headline_focus:   { role: "opening", data: "none",        status: "built",   renderer: "renderOpeningCard", note: "Market name and headline over the plate, headshot circle and name lockup below." },
  opening_editorial_portrait: { role: "opening", data: "none",      status: "planned", renderer: null, note: "Large headshot (crop, scale and side vary), market name and headline beside it." },
  opening_news_brief:       { role: "opening", data: "none",        status: "planned", renderer: null, note: "News-style lower third with a MARKET UPDATE tag and a dated line." },
  stat_big_number:          { role: "middle",  data: "one_value",   status: "built",   renderer: "renderStatCard", note: "One large verified number with a short lead and trail." },
  stat_image_headline:      { role: "middle",  data: "statement",   status: "planned", renderer: null, note: "Cinematic image with one short headline and no graphic." },
  compare_two_card:         { role: "middle",  data: "two_measures", status: "built",  renderer: "renderCompareCard", note: "Two cards: a percentage bar and a dot grid, side by side." },
  compare_split:            { role: "middle",  data: "two_measures", status: "planned", renderer: null, note: "Split screen with an animated divider and one statistic per half." },
  chart_time_series:        { role: "middle",  data: "series",      status: "planned", renderer: null, note: "Line or bar series drawn by code from verified monthly figures." },
  chart_percent_ring:       { role: "middle",  data: "proportion",  status: "planned", renderer: null, note: "A ring or bar filling to a verified percentage." },
  chart_dot_grid:           { role: "middle",  data: "proportion",  status: "planned", renderer: null, note: "N units with K highlighted, drawn from the two verified counts." },
  news_headline_brief:      { role: "middle",  data: "statement",   status: "planned", renderer: null, note: "Headline slate with a location tag and a short brief." },
  news_location_slate:      { role: "middle",  data: "location",    status: "planned", renderer: null, note: "Market name, county and period on a news slate; a real map is a later option." },
  expert_takeaway:          { role: "middle",  data: "statement",   status: "built",   renderer: "renderExpertCard", note: "Editorial statement, a support line and up to three titled points." },
  expert_statement:         { role: "middle",  data: "statement",   status: "planned", renderer: null, note: "One statement at reading size over a restrained background." },
  closing_headline_focus:   { role: "closing", data: "none",        status: "built",   renderer: "renderClosingCard", note: "Call-to-action headline, support line, headshot circle and lockup." },
  closing_editorial_portrait: { role: "closing", data: "none",      status: "planned", renderer: null, note: "Large headshot with the call to action beside it." },
  closing_news_brief:       { role: "closing", data: "none",        status: "planned", renderer: null, note: "Ticker-style call to action with the agent lockup." },
};

const TREATMENTS = {
  cinematic_editorial: {
    label: "Cinematic Editorial",
    bestFor: ["neighborhood competition", "new construction", "changing market conditions"],
    visualLanguage: "Full-bleed neighborhood photography under a soft gradient, one large statistic or short headline, generous space.",
    typography: { headline: "large, two lines at most", hero: "one hero number", label: "small uppercase label", font: "subscriber" },
    imageGraphicBalance: { image: 75, graphic: 25 },
    motion: { background: "slow Ken Burns, push in or gentle pan, small travel", graphics: "none", text: "fade in" },
    branding: { opening: "full", middle: "minimal", closing: "full" },
    compositions: ["opening_headline_focus", "opening_editorial_portrait", "stat_big_number", "stat_image_headline", "closing_headline_focus", "closing_editorial_portrait"],
    compatible: ["side_by_side", "expert_perspective", "market_intelligence"],
  },
  market_intelligence: {
    label: "Market Intelligence",
    bestFor: ["inventory", "days on market", "median prices", "absorption", "historical comparisons"],
    visualLanguage: "Clean panel with white space, restrained photography as a darkened strip or soft corner, charts drawn by code from verified numbers.",
    typography: { headline: "small", hero: "hero number or axis labels", label: "thin source line", font: "subscriber" },
    imageGraphicBalance: { image: 25, graphic: 75 },
    motion: { background: "nearly still", graphics: "bars grow, line draws, count-up in about one second then hold", text: "fade in" },
    branding: { opening: "full", middle: "subtle", closing: "full" },
    compositions: ["opening_headline_focus", "opening_news_brief", "stat_big_number", "chart_time_series", "chart_percent_ring", "chart_dot_grid", "closing_headline_focus"],
    compatible: ["cinematic_editorial", "side_by_side"],
  },
  side_by_side: {
    label: "Side-by-Side Comparison",
    bestFor: ["resale versus new construction", "this year versus last", "buyers versus sellers"],
    visualLanguage: "Two halves with an animated divider; each half has its own statistic.",
    typography: { headline: "matched per side, equal weight", hero: "one number per side", label: "one shared label", font: "subscriber" },
    imageGraphicBalance: { image: 50, graphic: 50 },
    motion: { background: "gentle", graphics: "divider wipes in, halves fill in turn, then hold", text: "fade in" },
    branding: { opening: "full", middle: "subtle", closing: "full" },
    compositions: ["opening_headline_focus", "compare_two_card", "compare_split", "chart_percent_ring", "chart_dot_grid", "closing_headline_focus"],
    compatible: ["cinematic_editorial", "market_intelligence", "expert_perspective"],
    plates: "One background plate by default; two only when the sides show different things (two images).",
  },
  local_news_brief: {
    label: "Local News Brief",
    bestFor: ["city-specific updates", "neighborhood changes", "community development", "local events"],
    visualLanguage: "News-style lower third, headline slate, location tag, neighborhood photography.",
    typography: { headline: "short, news style", hero: "none or one number", label: "dated tag line, ticker call to action", font: "subscriber" },
    imageGraphicBalance: { image: 65, graphic: 35 },
    motion: { background: "gentle photo movement", graphics: "lower thirds slide in, ticker line", text: "slide in" },
    branding: { opening: "full", middle: "subtle", closing: "full" },
    compositions: ["opening_news_brief", "opening_headline_focus", "news_headline_brief", "news_location_slate", "stat_big_number", "closing_news_brief", "closing_headline_focus"],
    compatible: ["cinematic_editorial", "market_intelligence", "expert_perspective"],
    note: "A real map needs a map source; the first version uses a location slate.",
  },
  expert_perspective: {
    label: "Expert Perspective",
    bestFor: ["pricing strategy", "seller preparation", "buyer advice", "55+ transition topics"],
    visualLanguage: "Cinematic background with one editorial statement and up to three short supporting points; the agent's interpretation leads.",
    typography: { headline: "statement at reading size", hero: "none", label: "titled points", font: "subscriber" },
    imageGraphicBalance: { image: 70, graphic: 30 },
    motion: { background: "slow drift", graphics: "none", text: "statement and points appear one at a time" },
    branding: { opening: "full", middle: "subtle", closing: "full" },
    compositions: ["opening_headline_focus", "opening_editorial_portrait", "expert_takeaway", "expert_statement", "closing_headline_focus", "closing_editorial_portrait"],
    compatible: ["cinematic_editorial", "side_by_side"],
  },
};

const ids = () => Object.keys(TREATMENTS);
const get = (id) => TREATMENTS[id] ? { id, ...TREATMENTS[id] } : null;
const composition = (id) => COMPOSITIONS[id] ? { id, ...COMPOSITIONS[id] } : null;
const isBuilt = (compositionId) => !!(COMPOSITIONS[compositionId] && COMPOSITIONS[compositionId].status === "built");

/** Compositions a primary treatment offers, plus (optionally) those of its compatible secondary treatments. Optionally only built ones. */
function allowedCompositions(primaryId, { secondaries = [], builtOnly = false } = {}) {
  const p = TREATMENTS[primaryId];
  if (!p) return [];
  const set = new Set(p.compositions);
  for (const s of secondaries) if (p.compatible.includes(s) && TREATMENTS[s]) TREATMENTS[s].compositions.forEach((c) => set.add(c));
  return [...set].filter((c) => !builtOnly || isBuilt(c));
}

/** Problems with the library itself ([] when sound). Run by the tests so a typo cannot ship. */
function validateLibrary() {
  const problems = [];
  for (const [id, t] of Object.entries(TREATMENTS)) {
    for (const k of ["label", "bestFor", "visualLanguage", "typography", "imageGraphicBalance", "motion", "branding", "compositions", "compatible"]) if (!t[k]) problems.push(`${id}: missing ${k}`);
    const b = t.imageGraphicBalance;
    if (b && b.image + b.graphic !== 100) problems.push(`${id}: image and graphic must add to 100`);
    for (const lvl of Object.values(t.branding || {})) if (!BRANDING.includes(lvl)) problems.push(`${id}: bad branding level ${lvl}`);
    if (t.branding && (t.branding.opening !== "full" || t.branding.closing !== "full")) problems.push(`${id}: opening and closing carry full branding`);
    for (const c of t.compositions || []) if (!COMPOSITIONS[c]) problems.push(`${id}: unknown composition ${c}`);
    for (const role of ["opening", "closing"]) if (!(t.compositions || []).some((c) => COMPOSITIONS[c] && COMPOSITIONS[c].role === role)) problems.push(`${id}: no ${role} composition`);
    if (!(t.compositions || []).some((c) => COMPOSITIONS[c] && COMPOSITIONS[c].role === "middle")) problems.push(`${id}: no middle composition`);
    for (const c of t.compatible || []) if (!TREATMENTS[c]) problems.push(`${id}: unknown compatible treatment ${c}`);
    if (t.typography && t.typography.font !== "subscriber") problems.push(`${id}: type must use the subscriber font`);
  }
  for (const [id, c] of Object.entries(COMPOSITIONS)) {
    if (c.status === "built" && !c.renderer) problems.push(`${id}: built without a renderer`);
    if (c.status === "planned" && c.renderer) problems.push(`${id}: planned but names a renderer`);
  }
  return problems;
}

module.exports = { BRANDING, TREATMENTS, COMPOSITIONS, ids, get, composition, isBuilt, allowedCompositions, validateLibrary };
