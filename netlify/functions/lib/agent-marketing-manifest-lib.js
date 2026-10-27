// lib/agent-marketing-manifest-lib.js — Netlify (shared). The Agent Marketing render manifest, version 2 (Oct 26, 2026).
//
// The manifest is the one document the Railway renderer reads: scenes with a narrative role AND a separate visual composition,
// the verified figures and calculations behind every number on screen, the notice, the audio and caption timing, and the keys of
// the prepared assets. This file builds nothing and calls nothing; it checks a manifest and applies the automatic small-sample wording rule.
//
// Two kinds of finding, kept apart on purpose:
//   errors   factual or technical problems that stop the job (a number with no source, a calculation that does not recompute, a missing asset)
//   warnings creative notes (the same composition twice in a row, thin visual context); recorded and shown, never blocking
//
// Numbers: every number on a card comes from a verified report figure or from a validated calculation (ratio, difference, percent change,
// sum) whose inputs are verified figures. A calculated number does not have to appear word for word in the research.
"use strict";

const treatments = require("./agent-marketing-treatments");
const { FONTS } = require("./brand-themes");

const sourcesLib = require("./agent-marketing-sources-lib");
const MANIFEST_VERSION = "am-manifest-2";
const FORMATS = ["9x16", "16x9"];
const SMALL_SAMPLE_BELOW = 10; // Sam, Oct 25: fewer than 10 listings is a count, never a trend on its own

const NUMERIC_FIELDS = new Set(["value", "percent", "highlighted", "total"]);
const OPS = {
  ratio_percent: (a, b) => (b === 0 ? NaN : (100 * a) / b),
  difference: (a, b) => a - b,
  percent_change: (a, b) => (a === 0 ? NaN : (100 * (b - a)) / a),
  sum: (...x) => x.reduce((s, v) => s + v, 0),
};
const OP_ARITY = { ratio_percent: 2, difference: 2, percent_change: 2 }; // sum takes two or more

/** The first number in a display string ("99.4%", "$1,250,000", "41 days"), or null. */
function parseNumber(display) {
  const m = /-?\d[\d,]*(?:\.\d+)?/.exec(String(display == null ? "" : display));
  return m ? Number(m[0].replace(/,/g, "")) : null;
}
const round = (v, d) => Math.round(v * 10 ** d) / 10 ** d;
const numTokens = (text) => (String(text || "").match(/\d[\d,]*(?:\.\d+)?/g) || []).map((t) => Number(t.replace(/,/g, "")));
const walk = (v, fn, path = "") => {
  if (typeof v === "string") fn(v, path);
  else if (Array.isArray(v)) v.forEach((x, i) => walk(x, fn, `${path}[${i}]`));
  else if (v && typeof v === "object") for (const [k, x] of Object.entries(v)) walk(x, fn, path ? `${path}.${k}` : k);
};

// ── MetroList notice from the report period (the same words Railway draws) ──────────────────────────────────────
const MONTHS = ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"];
function longDate(iso) {
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(String(iso || ""));
  if (!m || +m[2] < 1 || +m[2] > 12) return null;
  return `${MONTHS[+m[2] - 1]} ${+m[3]}, ${m[1]}`;
}
function metroListNotice(period) {
  const a = longDate(period && period.start), b = longDate(period && period.end);
  return a && b ? `Based on information from MetroList Services, Inc. for the period ${a} through ${b}.` : null;
}

// ── Calculations ───────────────────────────────────────────────────────────────────────────────────────────────
/**
 * verifyDerived(d, figuresByRef) → { ok, problems[], value }
 * d = { id, op, inputs:[{ref}], decimals, result, display? }. Inputs must be verified figures with a numeric value; the result is recomputed here.
 */
function verifyDerived(d, byRef) {
  const problems = [];
  if (!d || !OPS[d.op]) return { ok: false, problems: [`calculation ${d && d.id}: unknown operation "${d && d.op}"`] };
  const ins = Array.isArray(d.inputs) ? d.inputs : [];
  if (d.op === "sum" ? ins.length < 2 : ins.length !== OP_ARITY[d.op]) problems.push(`calculation ${d.id}: ${d.op} needs ${d.op === "sum" ? "two or more" : OP_ARITY[d.op]} inputs`);
  const vals = ins.map((i) => (byRef[i && i.ref] && Number.isFinite(byRef[i.ref].value) ? byRef[i.ref].value : null));
  ins.forEach((i, k) => { if (vals[k] == null) problems.push(`calculation ${d.id}: input "${i && i.ref}" is not a verified numeric figure`); });
  if (problems.length) return { ok: false, problems };
  const raw = OPS[d.op](...vals);
  if (!Number.isFinite(raw)) return { ok: false, problems: [`calculation ${d.id}: the result is not a number`] };
  const dec = Number.isInteger(d.decimals) && d.decimals >= 0 && d.decimals <= 4 ? d.decimals : 1;
  const value = round(raw, dec);
  if (Math.abs(value - Number(d.result)) > 1e-9) problems.push(`calculation ${d.id}: stated ${d.result} but the inputs give ${value}`);
  return { ok: problems.length === 0, problems, value };
}

// ── Small-sample wording (automatic, never a rejection) ────────────────────────────────────────────────────────
const TREND_WORDS = /\b(?:trend(?:s|ing)?|ris(?:e|es|ing)|rose|risen|fall(?:s|ing)?|fell|fallen|drop(?:s|ped|ping)?|climb(?:s|ed|ing)?|jump(?:s|ed)?|increas(?:e|es|ed|ing)|decreas(?:e|es|ed|ing)|declin(?:e|es|ed|ing)|surg(?:e|es|ed|ing)|shift(?:s|ed|ing)?|momentum)\b/i;
const QUALIFIED = /\bin (?:the |these )?\d+ (?:listings?|homes?|sales?) (?:reviewed|looked at|in this report|we looked at)\b/i;
/**
 * qualifySmallSample(text, n) → { text, changed }
 * For a sample under 10 listings, a sentence that reads as a market trend is kept and qualified: "In the 8 listings reviewed, …".
 * The count and any calculated proportion stay as written. Text with no trend wording, or a sample of 10 or more, is returned untouched.
 */
function qualifySmallSample(text, n) {
  const t = String(text == null ? "" : text);
  if (!Number.isFinite(n) || n >= SMALL_SAMPLE_BELOW || n < 1) return { text: t, changed: false };
  const parts = t.split(/(?<=[.!?])\s+/);
  let changed = false;
  const out = parts.map((s) => {
    if (!TREND_WORDS.test(s) || QUALIFIED.test(s)) return s;
    changed = true;
    const body = s.replace(/\btrends?\b/gi, (w) => (/s$/i.test(w) ? "patterns" : "pattern")).replace(/\btrending\b/gi, "showing a pattern");
    return `In the ${n} ${n === 1 ? "listing" : "listings"} reviewed, ${body.charAt(0).toLowerCase()}${body.slice(1)}`;
  });
  return { text: out.join(" "), changed };
}

/** The visible strings of a scene (not the numeric fields). */
function sceneStrings(scene) {
  const out = [];
  walk(scene && scene.data, (s, path) => { if (!NUMERIC_FIELDS.has(path.split(".").pop())) out.push({ path: `data.${path}`, text: s }); });
  (Array.isArray(scene && scene.supporting_lines) ? scene.supporting_lines : []).forEach((s, i) => { if (typeof s === "string") out.push({ path: `supporting_lines[${i}]`, text: s }); });
  return out;
}
/** The smallest sample behind a scene's claims (null when unknown). */
function sceneSample(scene, byRef, derivedById) {
  let n = null;
  const note = (v) => { if (Number.isFinite(v)) n = n == null ? v : Math.min(n, v); };
  for (const c of Array.isArray(scene && scene.claims) ? scene.claims : []) {
    if (c.figure && byRef[c.figure]) note(byRef[c.figure].n);
    if (c.derived && derivedById[c.derived]) (derivedById[c.derived].inputs || []).forEach((i) => byRef[i.ref] && note(byRef[i.ref].n));
  }
  return n;
}

/** applySmallSampleQualifiers(manifest) → { manifest, edits[] }. Rewrites trend wording on small samples in the scene text; never drops a statement. */
function applySmallSampleQualifiers(manifest) {
  const m = JSON.parse(JSON.stringify(manifest));
  const byRef = Object.fromEntries((m.figures || []).map((f) => [f.ref, f]));
  const derivedById = Object.fromEntries((m.derived || []).map((d) => [d.id, d]));
  const edits = [];
  (m.scenes || []).forEach((sc, idx) => {
    const n = sceneSample(sc, byRef, derivedById);
    if (n == null) return;
    for (const s of sceneStrings(sc)) {
      const q = qualifySmallSample(s.text, n);
      if (!q.changed) continue;
      setPath(sc, s.path, q.text);
      edits.push({ scene: idx + 1, path: s.path, before: s.text, after: q.text, reason: `sample of ${n} listings is under ${SMALL_SAMPLE_BELOW}` });
    }
  });
  return { manifest: m, edits };
}
function setPath(obj, path, value) {
  const keys = path.replace(/\[(\d+)\]/g, ".$1").split(".");
  let o = obj;
  for (let i = 0; i < keys.length - 1; i++) o = o[keys[i]];
  o[keys[keys.length - 1]] = value;
}

// ── Validation ─────────────────────────────────────────────────────────────────────────────────────────────────
const GENERIC_VISUAL = /^(?:a |an )?(?:beautiful|nice|pretty|generic|typical)?\s*(?:california )?(?:suburban )?(?:neighborhood|street|home|house)s?(?: photograph| photo| image)?\.?$/i;

/** validateManifest(manifest) → { ok, errors[], warnings[] } (each { code, where, message }). */
function validateManifest(manifest) {
  const errors = [], warnings = [];
  const err = (code, where, message) => errors.push({ code, where, message });
  const warn = (code, where, message) => warnings.push({ code, where, message });
  const m = manifest && typeof manifest === "object" ? manifest : null;
  if (!m) return { ok: false, errors: [{ code: "no_manifest", where: "manifest", message: "There is no manifest." }], warnings };
  if (m.version !== MANIFEST_VERSION) err("version", "version", `Expected ${MANIFEST_VERSION}.`);
  if (!m.project_id) err("project", "project_id", "The manifest has no project id.");

  // formats and brand
  const formats = Array.isArray(m.formats) ? m.formats : [];
  if (!formats.length || formats.some((f) => !FORMATS.includes(f))) err("formats", "formats", `Formats must be one or both of ${FORMATS.join(", ")}.`);
  const b = m.brand || {};
  if (b.font && !FONTS.includes(b.font)) err("font", "brand.font", `"${b.font}" is not one of the subscriber fonts.`);
  if (!b.agent || !b.agent.name) err("agent", "brand.agent", "The agent name is missing.");

  // figures, calculations
  const figures = Array.isArray(m.figures) ? m.figures : [];
  const byRef = Object.fromEntries(figures.map((f) => [f.ref, f]));
  const derived = Array.isArray(m.derived) ? m.derived : [];
  const derivedById = {};
  for (const d of derived) {
    const r = verifyDerived(d, byRef);
    r.problems.forEach((p) => err("calculation", `derived.${d.id}`, p));
    if (r.ok) derivedById[d.id] = { ...d, value: r.value };
  }
  const verifiedNumbers = new Set();
  figures.forEach((f) => { numTokens(f.display).forEach((v) => verifiedNumbers.add(v)); if (Number.isFinite(f.value)) verifiedNumbers.add(f.value); });
  Object.values(derivedById).forEach((d) => { verifiedNumbers.add(d.value); numTokens(d.display).forEach((v) => verifiedNumbers.add(v)); });

  // notice
  const noticeNeeded = m.notice_required !== false;
  const built = metroListNotice(m.notice && m.notice.period);
  if (!noticeNeeded) {
    // A web-research Reel (no MetroList report): the bottom bar is the source line, built by code from the checked sources.
    const sl = m.source_line || {};
    const want = sourcesLib.sourceLine(sl.sources, sl.scope_note);
    if (!want) err("source_line", "source_line", "A Reel without a MetroList report needs at least one checked, dated source for its on-screen source line.");
    else if (sl.text !== want) err("source_line", "source_line.text", "The source line must be built from the checked sources, not typed.");
  }
  // numbers the research step recorded for the topic count as verified for words on screen (the narration was already checked against them)
  (Array.isArray(m.verified_numbers) ? m.verified_numbers : []).forEach((v) => { if (Number.isFinite(v)) verifiedNumbers.add(v); });
  if (noticeNeeded) {
    if (!built) err("notice", "notice.period", "A report period is required to build the MetroList notice.");
    else if (!m.notice || m.notice.text !== built) err("notice", "notice.text", "The notice text must be built from the report period, not typed.");
  }

  // scenes
  const scenes = Array.isArray(m.scenes) ? m.scenes : [];
  if (scenes.length < 3) err("scenes", "scenes", "A Reel needs at least three scenes.");
  const audio = m.audio || {};
  let prevEnd = 0;
  scenes.forEach((sc, i) => {
    const where = `scenes[${i}]`;
    const comp = treatments.composition(sc.composition);
    if (!comp) { err("composition", where, `Unknown composition "${sc.composition}".`); return; }
    if (comp.status !== "built") err("composition", where, `"${sc.composition}" cannot be drawn yet.`);
    const expectRole = i === 0 ? "opening" : i === scenes.length - 1 ? "closing" : "middle";
    if (comp.role !== expectRole) err("composition_role", where, `Scene ${i + 1} is a ${expectRole} scene but "${sc.composition}" is a ${comp.role} composition.`);
    if (!sc.narrative_role) err("narrative_role", where, "Each scene needs a narrative role, separate from its composition.");
    // One source per scene (Oct 27, 2026): "data" (the agent's uploaded Trend/CMA/statistical report) or "article" (the approved local article). Opening and closing are always data.
    if (sc.source_role !== undefined && !["data", "article"].includes(sc.source_role)) err("source_role", where, 'A scene\'s source role is "data" or "article".');
    if ((expectRole === "opening" || expectRole === "closing") && sc.source_role === "article") err("source_role", where, "Opening and closing scenes source the market data, never the article.");
    if (!treatments.BRANDING.includes(sc.branding)) err("branding", where, `Branding must be one of ${treatments.BRANDING.join(", ")}.`);
    if ((expectRole === "opening" || expectRole === "closing") && sc.branding !== "full") err("branding", where, "Opening and closing scenes carry full branding.");
    if ((expectRole === "opening" || expectRole === "closing") && !(b.headshot_key)) err("headshot", "brand.headshot_key", "Opening and closing scenes use the agent's own headshot, and none is attached.");
    const w = sc.window || {};
    if (!(w.end > w.start) || Math.abs(w.start - prevEnd) > 0.05) err("timing", where, "Scene windows must run in order without gaps or overlap.");
    prevEnd = w.end;
    const visual = sc.visual || {};
    for (const f of formats) if (FORMATS.includes(f) && !(visual.image_keys && visual.image_keys[f])) err("asset", where, `Scene ${i + 1} has no ${f} background.`);
    if (!visual.research_visual_context || String(visual.research_visual_context).trim().length < 25 || GENERIC_VISUAL.test(String(visual.research_visual_context).trim())) {
      warn("visual_context", where, `Scene ${i + 1} has a thin or generic visual context; tie it to the research.`);
    }
    // claims: every numeric field on the card traces to a figure or a validated calculation
    const claimed = new Set();
    for (const c of Array.isArray(sc.claims) ? sc.claims : []) {
      const got = c.figure ? (byRef[c.figure] && byRef[c.figure].value) : (derivedById[c.derived] && derivedById[c.derived].value);
      const fieldVal = Number(String(c.field || "").split(".").reduce((o, k) => (o == null ? o : o[k]), sc.data));
      if (got == null || !Number.isFinite(got)) err("claim", where, `The claim on "${c.field}" points at ${c.figure ? `figure "${c.figure}"` : `calculation "${c.derived}"`}, which is not verified.`);
      else if (!Number.isFinite(fieldVal) || Math.abs(fieldVal - got) > 1e-9) err("claim", where, `"${c.field}" shows ${fieldVal} but its source says ${got}.`);
      claimed.add(c.field);
    }
    const numericLeaf = [];
    const collect = (v, path) => {
      if (Array.isArray(v)) v.forEach((x, k) => collect(x, `${path}[${k}]`));
      else if (v && typeof v === "object") for (const [k, x] of Object.entries(v)) {
        const p = path ? `${path}.${k}` : k;
        if (NUMERIC_FIELDS.has(k) && (typeof x === "number" || (typeof x === "string" && /\d/.test(x)))) numericLeaf.push(p); else collect(x, p);
      }
    };
    collect(sc.data, "");
    numericLeaf.forEach((p) => { if (!claimed.has(p)) err("claim", where, `The number in "${p}" has no source figure or calculation.`); });
    // numbers inside the words on screen
    for (const s of sceneStrings(sc)) for (const v of numTokens(s.text)) {
      if (verifiedNumbers.has(v) || (v >= 1900 && v <= 2100)) continue;
      err("number", where, `The number ${v} in "${s.path}" has no source figure or calculation.`);
    }
    // small-sample wording must already be qualified
    const n = sceneSample(sc, byRef, derivedById);
    if (n != null && n < SMALL_SAMPLE_BELOW) for (const s of sceneStrings(sc)) if (qualifySmallSample(s.text, n).changed) err("small_sample", where, `"${s.path}" reads as a trend on a sample of ${n} listings; run applySmallSampleQualifiers first.`);
    if (sceneStrings(sc).map((s) => s.text).join(" ").split(/\s+/).filter(Boolean).length > 60) warn("text_heavy", where, `Scene ${i + 1} carries a lot of on-screen text.`);
  });
  // rhythm
  for (let i = 1; i < scenes.length; i++) if (scenes[i].composition && scenes[i].composition === scenes[i - 1].composition) warn("repeat", `scenes[${i}]`, `Scenes ${i} and ${i + 1} use the same composition.`);
  const middles = scenes.slice(1, -1).map((s) => s.composition);
  if (middles.length >= 3 && new Set(middles).size === 1) warn("variety", "scenes", "Every middle scene uses the same composition.");

  // audio and captions
  if (!audio.narration_key) err("asset", "audio.narration_key", "The narration audio is not attached.");
  if (!(audio.duration_sec > 0)) err("timing", "audio.duration_sec", "The audio length is missing.");
  else if (scenes.length && Math.abs(prevEnd - audio.duration_sec) > 0.6) err("timing", "scenes", "The last scene must end where the audio ends.");
  const caps = Array.isArray(m.captions) ? m.captions : [];
  if (!caps.length) err("captions", "captions", "There are no caption lines.");
  let capPrev = 0;
  caps.forEach((c, i) => { if (!c.text || !(c.end > c.start) || c.start < capPrev - 0.02) err("captions", `captions[${i}]`, "Caption lines must be in order with a real start and end."); capPrev = c.end; });
  if (typeof m.narration_text === "string" && caps.length) {
    const want = m.narration_text.replace(/\[[^\]\n]{1,40}\]/g, " ").split(/\s+/).filter(Boolean);
    const have = caps.map((c) => c.text).join(" ").split(/\s+/).filter(Boolean);
    if (want.length !== have.length || want.some((w, i) => w !== have[i])) err("captions", "captions", "The captions are not the approved narration, word for word.");
  }
  return { ok: errors.length === 0, errors, warnings };
}

module.exports = { MANIFEST_VERSION, FORMATS, SMALL_SAMPLE_BELOW, parseNumber, metroListNotice, verifyDerived, qualifySmallSample, applySmallSampleQualifiers, validateManifest, sceneStrings };
