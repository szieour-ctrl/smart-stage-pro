// lib/agent-marketing-source-authority-lib.js — Netlify (shared). Deterministic publisher-authority checks for Article-Led research (PR 2).
//
// Perplexity labels each source with a `role` and `kind`. Those labels are model-generated, so the extended freshness exception (government and other
// authoritative primary records up to 12 months old, and older records as confirmed background) must not rest on them alone. This module classifies the
// PUBLISHER from the host name, in code. It is deliberately conservative: only hosts that are unambiguous official domains are "official"; hosts that
// merely look official are "uncertain" and are preserved for review, never trusted.
//
//   official_government   a .gov host, or a California public-agency host (.ca.us)
//   official_financing    a recognized official financing or economic publisher that is not a .gov host
//   uncertain             looks official (a "city of ..." or "county" name on a .org or .com) but cannot be confirmed from the host alone
//   not_official          everything else (news, trade, association, brokerage or agent, builder, portal ...)
"use strict";

const OFFICIAL_FINANCING = /(^|\.)(freddiemac\.com|fanniemae\.com|frbsf\.org|newyorkfed\.org|stlouisfed\.org)$/;
const OFFICIAL_GOVERNMENT = /\.gov$|\.ca\.us$|\.k12\.ca\.us$/;
const LOOKS_OFFICIAL = /(^|[.-])(cityof[a-z-]+|countyof[a-z-]+|ci-[a-z-]+|co-[a-z-]+|[a-z-]+county|[a-z-]+cityhall)([.-]|\.)/i;

const hostOf = (u) => { try { return new URL(/^[a-z]+:\/\//i.test(String(u)) ? String(u) : `https://${u}`).hostname.toLowerCase().replace(/^www\./, ""); } catch { return ""; } };

function publisherAuthority(hostOrUrl) {
  const host = hostOf(hostOrUrl);
  if (!host) return { tier: "not_official", basis: "no host" };
  if (OFFICIAL_GOVERNMENT.test(host)) return { tier: "official_government", basis: host.endsWith(".gov") ? ".gov host" : "California public-agency host (.ca.us)" };
  if (OFFICIAL_FINANCING.test(host)) return { tier: "official_financing", basis: "recognized official financing or economic publisher" };
  if (LOOKS_OFFICIAL.test(host)) return { tier: "uncertain", basis: "the name looks official but the host is not a .gov or .ca.us domain" };
  return { tier: "not_official", basis: "not a recognized official publisher" };
}
const isOfficial = (a) => !!a && (a.tier === "official_government" || a.tier === "official_financing");

// A project, permit, case or ordinance identifier in a title or address: a deterministic signal that two pages are about the same item.
const norm = (x) => String(x).toLowerCase().replace(/[^a-z0-9]/g, "");
const ID_PATTERNS = [
  { re: /\b[A-Z]{2,6}-?\d{2}-\d{3,6}\b/g, id: (m) => norm(m[0]) },                                   // PLN24-00048, CUP-24-0012
  { re: /\b\d{2}-\d{4,6}\b/g, id: (m) => norm(m[0]) },                                                   // 24-00048
  { re: /\b(?:ordinance|resolution|ord\.?|res\.?)\s*(?:no\.?)?\s*#?\s*([A-Z]*-?\d[\w-]*)/gi, id: (m) => "n" + norm(m[1]) }, // Ordinance No. 2024-17 and Ordinance 2024-17 agree
];
function identifiersIn(text) {
  const t = String(text || "");
  const out = new Set();
  ID_PATTERNS.forEach(({ re, id }) => { for (const m of t.matchAll(re)) out.add(id(m)); });
  return out;
}
/** How two sources can be tied to the same development without trusting the model: a shared identifier, the same publisher, or only the model's word. */
function relationSignal(a, b) {
  const ia = identifiersIn(`${a.title} ${a.url}`), ib = identifiersIn(`${b.title} ${b.url}`);
  for (const x of ia) if (ib.has(x)) return "shared_identifier";
  if (hostOf(a.url) && hostOf(a.url) === hostOf(b.url)) return "same_publisher";
  return "model_asserted";
}

module.exports = { publisherAuthority, isOfficial, relationSignal, identifiersIn, hostOf };
