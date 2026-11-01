// lib/agent-marketing-development-identity-lib.js — Netlify (shared). The identity of the UNDERLYING development behind a discovery candidate (PR 2).
//
// Two candidates about the same development or action must count once, whatever editorial angle each takes (an agreement "for sellers" and the same
// agreement "for competition"). Wording similarity alone missed a real case: both Lincoln three-lane runs selected Parkwood twice. Identity is decided from
// deterministic signals, not the model's word:
//   identifiers      permit, application, case and ordinance numbers (PLN24-00048, DR26-197, Ordinance 2024-17) and official record references (a CEQAnet record)
//   project names    distinctive proper names in the development description and the primary record's title (Parkwood, Hidden Hills Phase 2), not place or generic words
//   source identity  the same official or primary record, or the same article, cited by both
// Two candidates are the same development when they share an identifier; or share a distinctive project name AND a source (or enough description overlap);
// or share a primary/official record and describe it alike. A shared secondary article alone is NOT enough (one article can report several projects), and a
// different project name keeps two candidates apart even when they cite the same article.
"use strict";

const auth = require("./agent-marketing-source-authority-lib");

const STOP = new Set(("the a an and or of at in on for to by with from as is are was were be been new proposed approved approval council city county commission commissioner planning board " +
  "agreement development project projects plan plans phase phases village villages specific area areas site sites homes home houses house lots lot units unit apartments apartment " +
  "road street avenue boulevard drive lane way court trail park parks center centre plaza downtown north south east west central northern southern eastern western " +
  "california placer sacramento roseville lincoln colfax natomas rocklin auburn county state national federal public notice record records report reports agenda meeting " +
  "january february march april may june july august september october november december monday tuesday wednesday thursday friday saturday sunday " +
  "acre acres square foot feet million billion percent single family multifamily residential commercial retail office mixed use affordable senior housing " +
  "water sewer storm drain traffic signal bus transit school schools district utility utilities construction approves approve approved considers considered reviewed review " +
  "amendment amendments ordinance resolution map subdivision tentative final vesting rezoning zoning general design designs production application applications").split(/\s+/));

const lc = (s) => String(s == null ? "" : s).toLowerCase();
const words = (s) => lc(s).replace(/[^a-z0-9\s]/g, " ").split(/\s+/).filter(Boolean);
const tokenSet = (s) => new Set(words(s).filter((w) => w.length > 2 && !STOP.has(w)));
const jaccard = (a, b) => { if (!a.size || !b.size) return 0; let i = 0; a.forEach((x) => { if (b.has(x)) i++; }); return i / (a.size + b.size - i); };

function urlKey(u) { try { const x = new URL(String(u)); return `${x.hostname.toLowerCase().replace(/^www\./, "")}${x.pathname.replace(/\/+$/, "")}`; } catch { return ""; } }

/** Official record references that a URL carries: a CEQAnet record is <SCH number>/<document number>. */
function recordRefsFromUrl(u) {
  const out = new Set(); const s = String(u || "");
  const m = /ceqanet\.lci\.ca\.gov\/(\d{10})(?:\/(\d+))?/i.exec(s);
  if (m) out.add(`sch${m[1]}${m[2] ? `/${m[2]}` : ""}`);
  return out;
}

/**
 * Distinctive project names: capitalized words in the development description (the identity of the thing), and the primary record's title, that are not
 * place names of the market's own hierarchy, generic planning words, months, or the first word of a sentence unless it recurs. "Phase 2" style qualifiers are
 * kept with their name so "Hidden Hills Phase 2" and "Hidden Hills Phase 1" stay apart.
 */
function projectNames(texts, hierarchyNames) {
  const hier = new Set(words((hierarchyNames || []).join(" ")));
  const names = new Set();
  (texts || []).forEach((t) => {
    const raw = String(t || "");
    const toks = raw.replace(/[(),;:]/g, " ").split(/\s+/).filter(Boolean);
    for (let i = 0; i < toks.length; i++) {
      const w = toks[i].replace(/[^A-Za-z0-9’'-]/g, "").replace(/[’']s$/i, "");
      if (!/^[A-Z][A-Za-z0-9-]{2,}$/.test(w)) continue;
      const lw = w.toLowerCase();
      if (STOP.has(lw) || hier.has(lw)) continue;
      // look ahead for a continuing name ("Hidden Hills") and a phase/subphase qualifier
      let phrase = [lw];
      let j = i + 1;
      while (j < toks.length && /^[A-Z][A-Za-z0-9-]{2,}[,.]?$/.test(toks[j]) && !STOP.has(toks[j].replace(/[^A-Za-z]/g, "").toLowerCase()) && !hier.has(toks[j].replace(/[^A-Za-z]/g, "").toLowerCase()) && phrase.length < 3) { phrase.push(toks[j].replace(/[^A-Za-z0-9-]/g, "").toLowerCase()); j++; }
      const q = /^(phase|subphase|village)$/i.test(toks[j] || "") && /^\d+[a-z]?$/i.test((toks[j + 1] || "").replace(/[^A-Za-z0-9]/g, "")) ? `${toks[j].toLowerCase()} ${(toks[j + 1] || "").replace(/[^A-Za-z0-9]/g, "").toLowerCase()}` : "";
      names.add(phrase.join(" ") + (q ? ` ${q}` : ""));
      i = j - 1;
    }
  });
  return names;
}

/** identityOf({ development, angle, question, sources:[{ title, url, role, whatItEstablishes, official }], hierarchyNames }) -> a plain, serializable identity */
function identityOf({ development, sources, hierarchyNames }) {
  const srcs = Array.isArray(sources) ? sources : [];
  const primary = srcs.filter((s) => s.role === "primary" || s.official);
  const idTexts = [development, ...srcs.map((s) => s.title), ...srcs.map((s) => s.whatItEstablishes)];
  const identifiers = new Set();
  idTexts.forEach((t) => auth.identifiersIn(t).forEach((x) => identifiers.add(x)));
  srcs.forEach((s) => recordRefsFromUrl(s.url).forEach((x) => identifiers.add(x)));
  const names = projectNames([development, ...primary.map((s) => s.title)], hierarchyNames);
  const urlKeys = srcs.map((s) => urlKey(s.url)).filter(Boolean);
  const primaryKeys = primary.map((s) => urlKey(s.url)).filter(Boolean);
  return { identifiers: [...identifiers].sort(), projectNames: [...names].sort(), sourceKeys: [...new Set(urlKeys)], primaryKeys: [...new Set(primaryKeys)], descTokens: [...tokenSet(development)] };
}

/** Why two identities are the same underlying development, or null. */
function sameIdentity(a, b) {
  const shared = (x, y) => x.filter((v) => y.includes(v));
  const ids = shared(a.identifiers, b.identifiers);
  if (ids.length) return { basis: "shared_identifier", detail: ids.slice(0, 3).join(", ") };
  const names = shared(a.projectNames, b.projectNames);
  const srcShared = shared(a.sourceKeys, b.sourceKeys);
  const sim = jaccard(new Set(a.descTokens), new Set(b.descTokens));
  if (names.length && (srcShared.length || sim >= 0.25)) return { basis: "shared_project_name", detail: `${names.slice(0, 2).join(", ")}${srcShared.length ? "; shared source" : "; similar description"}` };
  const prim = shared(a.primaryKeys, b.primaryKeys);
  if (prim.length && sim >= 0.2) return { basis: "shared_primary_record", detail: prim[0] };
  return null;
}

module.exports = { identityOf, sameIdentity, projectNames, recordRefsFromUrl, urlKey, STOP };
