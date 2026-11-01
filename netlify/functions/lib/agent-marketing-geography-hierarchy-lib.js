// lib/agent-marketing-geography-hierarchy-lib.js — Netlify (shared). Where a selected market sits (PR 2, compact Stage A).
//
// A market is not just a name: Crocker Ranch is a subdivision within West Roseville, ZIP 95747, the City of Roseville and Placer County. Sources are
// classified by the level of that hierarchy they actually cover, and a source about a wider level is context, never the selected market's own
// statistic or development. This module knows the hierarchy for a few markets (a small registry, below) and otherwise derives what it can from the
// request (name, city, ZIP) and says so.
//
// Levels, narrowest to widest: market, district, zip, city, county, region, state, national. "district" is a named area that contains the market
// (West Roseville). Levels are NOT assumed to share boundaries: West Roseville and ZIP 95747 are separate levels and neither is treated as the other.
// Matching names against a source's title, address or host shows only that the name appears; it is not verification of project or boundary location.
"use strict";

const LEVELS = Object.freeze(["market", "district", "zip", "city", "county", "region", "state", "national"]);

// City -> county for the counties the product serves (a small, reviewable table; anything else has no county and is marked derived).
const CITY_COUNTY = Object.freeze({
  roseville: "Placer", lincoln: "Placer", rocklin: "Placer", loomis: "Placer", auburn: "Placer", colfax: "Placer", granite_bay: "Placer",
  sacramento: "Sacramento", "elk grove": "Sacramento", folsom: "Sacramento", "citrus heights": "Sacramento", "rancho cordova": "Sacramento", "galt": "Sacramento",
  placerville: "El Dorado", "el dorado hills": "El Dorado", "south lake tahoe": "El Dorado", "cameron park": "El Dorado",
  "yuba city": "Sutter", "live oak": "Sutter",
});

// Registry of markets whose hierarchy is known. key: lowercase market name + "|" + lowercase containing city ("" for a city market).
const REGISTRY = Object.freeze({
  "crocker ranch|roseville": { type: "subdivision", district: "West Roseville", zip: "95747", city: "Roseville", county: "Placer",
    note: "Crocker Ranch is a subdivision within West Roseville, ZIP 95747, the City of Roseville and Placer County. West Roseville and ZIP 95747 are not assumed to share boundaries." },
  "lincoln|": { type: "city", zip: "95648", city: null, county: "Placer", note: "The City of Lincoln, Placer County." },
  "colfax|": { type: "city", zip: "95713", city: null, county: "Placer", note: "The City of Colfax, Placer County." },
  "natomas|sacramento": { type: "neighborhood", district: null, zip: "95834", city: "Sacramento", county: "Sacramento",
    // Sub-areas and named developments inside the Natomas market. They are NOT equivalent to ZIP 95834 (Natomas spans several ZIP codes) and none is a boundary verification.
    subareas: ["North Natomas", "South Natomas", "Northlake", "Westlake", "Greenbriar", "ParkBridge", "Innovation Park", "Metro Air Park", "Gateway Park", "Natomas Park", "Natomas Crossing"],
    note: "Natomas is a neighborhood within the City of Sacramento, Sacramento County; ZIP 95834 is one of several Natomas ZIP codes." },
});

const norm = (s) => String(s == null ? "" : s).toLowerCase().replace(/\s+/g, " ").trim();
const stripCityWords = (s) => norm(s).replace(/^city of /, "").replace(/, ca$| ca$|, california$/, "");

/** hierarchyFor(geography) -> { market, levels:[{ level, name, names:[...] }], derived, note, marketIsCity } */
function hierarchyFor(geography) {
  const g = geography && typeof geography === "object" ? geography : {};
  const name = String(g.name || "").trim();
  const city = String(g.city || "").trim();
  const type = String(g.type || "");
  const zipOnly = /^\d{5}$/.test(name) ? name : null;
  const key = `${stripCityWords(name)}|${type === "city" ? "" : stripCityWords(city)}`;
  const reg = REGISTRY[key] || null;
  const marketIsCity = type === "city" || (reg && reg.type === "city");
  const levels = [];
  const add = (level, label, names) => { if (label) levels.push({ level, name: label, names: [...new Set((names || [label]).map((x) => String(x).trim()).filter(Boolean))] }); };
  if (zipOnly) add("market", `ZIP ${zipOnly}`, [zipOnly, `ZIP ${zipOnly}`]);
  else add("market", name, [name]);
  const zip = /^\d{5}$/.test(String(g.zip || "")) ? String(g.zip) : reg && reg.zip || null;
  const district = reg && reg.district || null;
  const cityName = marketIsCity ? stripCityWords(name) : (reg && reg.city) || (city ? stripCityWords(city) : null);
  const cityLabel = cityName ? cityName.replace(/\b\w/g, (c) => c.toUpperCase()) : null;
  const county = reg && reg.county || (cityName && CITY_COUNTY[cityName]) || null;
  if (district) add("district", district, [district]);
  if (zip && !zipOnly) add("zip", `ZIP ${zip}`, [zip, `ZIP ${zip}`]);
  if (cityLabel && !marketIsCity) add("city", `City of ${cityLabel}`, [`City of ${cityLabel}`, cityLabel]);
  if (county) add("county", `${county} County`, [`${county} County`, `County of ${county}`]);
  const derived = !reg;
  const note = reg ? reg.note : `Derived from the request${county ? "" : " (no county known)"}: ${levels.map((l) => l.name).join(" > ")}.`;
  const subareas = reg && Array.isArray(reg.subareas) ? reg.subareas.slice() : [];
  return { market: name || (zipOnly ? `ZIP ${zipOnly}` : ""), marketType: reg ? reg.type : type, marketIsCity: !!marketIsCity, levels, subareas, derived, note };
}

/** The relationships a source can be given for this market: city is the market itself for a city market, so it is not offered separately. */
function normalizeRelationship(rel, hierarchy) {
  const r = norm(rel);
  if (!LEVELS.includes(r)) return null;
  if (r === "city" && hierarchy && hierarchy.marketIsCity) return "market";
  return r;
}

/** One line for the prompt: the chain from the market outward, and a reminder that levels are not the same area. */
function hierarchyLine(h) {
  const chain = h.levels.map((l) => `${l.name}${l.level === "market" ? ` (the selected market${h.marketType && h.marketType !== "city" ? `, a ${h.marketType}` : h.marketIsCity ? ", a city" : ""})` : ` (${l.level})`}`).join(" > ");
  const sub = h.subareas && h.subareas.length ? ` Known sub-areas and named developments inside the market: ${h.subareas.join(", ")}; they are not equivalent to the ZIP code or to each other, and a sub-area is not verified to be inside a boundary.` : "";
  return `Where the market sits: ${chain}. ${h.note}${sub} Treat each level as its own area; do not assume two levels share boundaries.`;
}

const pathOf = (u) => { try { const x = new URL(/^[a-z]+:\/\//i.test(String(u)) ? String(u) : `https://${u}`); return `${x.pathname}${x.search}`; } catch { return String(u || ""); } };
const esc = (x) => String(x).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
/**
 * Names of the claimed level found in a source's title, address or host. This shows a NAME appears, not that the project or boundary is in the market
 * (boundaryVerified is always false). For levels above the market, the market's own names do not count (a ZIP-level claim needs the ZIP).
 */
function nameEvidence(hierarchy, level, source) {
  const lv = hierarchy.levels.find((l) => l.level === level);
  const marketLv = hierarchy.levels.find((l) => l.level === "market");
  const subareas = hierarchy.subareas || [];
  // A missing hierarchy entry is not grounds for rejecting a relevant development. When the claimed level has no entry (a "district" for a market with none), or
  // the claim is about the market itself, the market's own name and its known sub-areas are the names to look for, and the result stays provisional.
  const fallback = !lv && (level === "district" || level === "market") && marketLv;
  const sets = lv && level !== "market" ? [{ via: "level", names: lv.names }]
    : [{ via: fallback || level === "market" ? "market_name" : "level", names: (lv || marketLv || { names: [] }).names }, { via: "subarea", names: subareas }];
  if (!lv && !fallback) return { level, found: false, where: null, names: [], boundaryVerified: false, reason: level === "region" || level === "state" || level === "national" ? "not_checked" : "level_not_in_hierarchy" };
  // COVERAGE evidence is a name in the title or in the address PATH. The publisher's host is deliberately not coverage evidence: an official municipal domain says who
  // published the page (see publisherJurisdiction), not where the development is or whether it matters to this audience.
  const places = { title: String(source && source.title || ""), url: pathOf(source && source.url) };
  const slug = (x) => x.toLowerCase().replace(/[-_/.+%20]+/g, " ");
  for (const set of sets) for (const where of ["title", "url"]) {
    const text = where === "title" ? places.title : slug(places[where]);
    const hit = set.names.filter((n) => new RegExp(`(^|[^a-z0-9])${esc(n.toLowerCase().replace(/[-_]+/g, " "))}($|[^a-z0-9])`, "i").test(text.toLowerCase()));
    if (hit.length) return { level, found: true, where, names: hit, via: set.via, provisional: set.via !== "level" || undefined, boundaryVerified: false, reason: null };
  }
  return { level, found: false, where: null, names: [], boundaryVerified: false, reason: "name_not_found" };
}
/**
 * The JURISDICTION OF THE PUBLISHER: a recognized official municipal or county domain whose agency is in the market's own hierarchy (lincolnca.gov, roseville.ca.gov,
 * cityofsacramento.gov, colfax-ca.gov, placer.ca.gov). It corroborates who published a page. It does NOT verify a project's boundaries, its location, or its relevance to the
 * audience, and a same-named agency elsewhere (lincoln.ne.gov) never matches. Returns { level, name, host, basis } or null.
 */
function publisherJurisdiction(host, hierarchy) {
  const h = String(host || "").toLowerCase().replace(/^www\./, "");
  const m = /^(.+?)\.(ca\.gov|ca\.us|gov)$/.exec(h);
  if (!m || !hierarchy || !Array.isArray(hierarchy.levels)) return null;
  // a bare ".gov" host is only a California agency when its label says so (lincolnca, colfax-ca, cityofsacramento); lincoln.ne.gov has label "lincoln.ne" and never matches
  const label = m[1], suffix = m[2], squash = (x) => String(x).toLowerCase().replace(/^(city|county) of /, "").replace(/ (city|county)$/, "").replace(/[^a-z0-9]/g, "");
  for (const l of hierarchy.levels) {
    if (!["market", "city", "county"].includes(l.level)) continue;
    if (l.level === "market" && !hierarchy.marketIsCity) continue;       // a subdivision's own name is not an agency
    for (const nm of [l.name, ...(l.names || [])]) {
      const n = squash(nm); if (!n) continue;
      const forms = suffix === "gov" ? [`${n}ca`, `${n}-ca`, `cityof${n}`, `countyof${n}`, `${n}countyca`, `${n}-county-ca`] : [n, `ci.${n}`, `cityof${n}`, `co.${n}`, `${n}city`];
      if (forms.includes(label.replace(/-/g, "-"))) return { level: l.level, name: l.name, host: h, basis: "official_municipal_domain" };
      if (suffix === "gov" && label === `${n}.ca`) return { level: l.level, name: l.name, host: h, basis: "official_municipal_domain" };
    }
  }
  return null;
}
// the market's own name in a source also covers a claim of any wider level only when the wider level's name is present; never the reverse
const SPECIFICITY = Object.freeze({ market: 3, district: 2, zip: 2, city: 1, county: 0, region: 0, state: 0, national: 0 });

module.exports = { LEVELS, REGISTRY, CITY_COUNTY, hierarchyFor, normalizeRelationship, hierarchyLine, nameEvidence, publisherJurisdiction, SPECIFICITY };
