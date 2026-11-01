// lib/agent-marketing-outlet-registry-lib.js — Netlify (shared). Deterministic publisher classification for Article-Led research (PR 2).
//
// What kind of publisher a source is decides how much a claim can be trusted and how it should be described: original local reporting, trade
// aggregation, brokerage or agent commentary, syndicated material, government records, and so on. The model's own `kind` label is not reliable
// (it called a trade aggregator "local_news"). This registry classifies the HOST in code. It classifies; it never bans: a brokerage or agent blog is a
// legitimate source and stays usable.
//
// Classification order: official government and financing hosts (decided by agent-marketing-source-authority-lib), then the registry below (a reviewed
// list of named outlets), then a host PATTERN (brokerage-looking names; reported as lower confidence), else `unclassified`, which is kept for human review.
// Registry entries are judgments about named outlets and are meant to be reviewed and extended; add a host, never guess one.
"use strict";

const authority = require("./agent-marketing-source-authority-lib");

const CLASSES = Object.freeze(["government_record", "official_financing", "original_local_reporting", "trade_aggregation", "brokerage_or_agent_commentary", "syndicated_release", "housing_research", "association", "builder_developer", "portal", "unclassified"]);

const REGISTRY = Object.freeze({
  original_local_reporting: ["kcra.com", "abc10.com", "fox40.com", "sacbee.com", "capradio.org", "goldcountrymedia.com", "nsarrow.com", "goldmountaincanews.com", "sacramentostandard.com", "mytownview.com", "auburnjournal.com", "rosevillepresstribune.com", "lincolnnews.com"],
  trade_aggregation: ["cahousingmarketnews.com", "news.theregistrysf.com", "theregistrysf.com", "therealdeal.com", "housingwire.com", "bisnow.com", "hoodline.com", "connectcre.com"],
  brokerage_or_agent_commentary: ["thegoolsbygroup.com", "agentkee.com", "nextregroup.com", "richandkatsoldthat.com", "suzannevolkman.com", "sellingplacer.com", "havengroupsf.com", "windermerecalocal.com", "foundspacesrealty.ca"],
  syndicated_release: ["morningstar.com", "finance.yahoo.com", "prnewswire.com", "businesswire.com", "globenewswire.com", "einpresswire.com"],
  housing_research: ["zillow.com", "redfin.com", "realtor.com", "cbre.com", "corelogic.com", "cotality.com", "attomdata.com", "nahb.org"],
  association: ["car.org", "nar.realtor", "sacrealtor.org", "natomaschamber.org", "mba.org", "roseville.org"],
  builder_developer: ["lennar.com", "drhorton.com", "tollbrothers.com", "kbhome.com", "pulte.com", "taylormorrison.com", "meritagehomes.com", "shea.com"],
  portal: ["movoto.com", "homes.com", "trulia.com", "apartments.com", "compass.com", "55places.com"],
});
const INDEX = new Map();
Object.entries(REGISTRY).forEach(([cls, hosts]) => hosts.forEach((h) => INDEX.set(h, cls)));

const BROKERAGE_PATTERN = /(^|[.-])(realty|realtors?|realestate|real-estate|homesales|brokerage|remax|exprealty|coldwellbanker|century21|bhhs)([.-]|\d|$)|(realty|realestate|realtor)\.[a-z]{2,}$/i;

const hostOf = authority.hostOf;
function registryClass(host) {
  const parts = host.split(".");
  for (let i = 0; i < parts.length - 1; i++) { const c = INDEX.get(parts.slice(i).join(".")); if (c) return c; }
  return null;
}

/** classifyOutlet(hostOrUrl) -> { class, basis: "official_host"|"registry"|"pattern"|"none", host } */
function classifyOutlet(hostOrUrl) {
  const host = hostOf(hostOrUrl);
  if (!host) return { class: "unclassified", basis: "none", host: "" };
  const a = authority.publisherAuthority(host);
  if (a.tier === "official_government") return { class: "government_record", basis: "official_host", host };
  if (a.tier === "official_financing") return { class: "official_financing", basis: "official_host", host };
  const r = registryClass(host);
  if (r) return { class: r, basis: "registry", host };
  if (BROKERAGE_PATTERN.test(host)) return { class: "brokerage_or_agent_commentary", basis: "pattern", host };
  return { class: "unclassified", basis: "none", host };
}
const isOriginalLocalReporting = (c) => c && c.class === "original_local_reporting";

module.exports = { CLASSES, REGISTRY, classifyOutlet, isOriginalLocalReporting };
