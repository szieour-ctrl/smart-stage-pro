// lib/agent-marketing-trend-intelligence-lib.js — Netlify (shared). Trend Intelligence: how the figures of a confirmed market report relate
// to each other (Nov 9, 2026). ONE implementation, used by Option 1 (Agent Market Update, report only) and Option 2 (Article-Led Market Update
// + Trend/CMA, inside B2). Pure and deterministic: no network, no model, no new extraction. It reads the structured figures that
// lib/agent-marketing-report-lib.js already produced and that lib/agent-marketing-research-report-lib.js buildContext() already namespaces.
//
// CONTRACT
//   analyze(ctx, opts?) → TrendAnalysis
//     ctx   = reportTopics.buildContext(uploads, request)   (the existing report context; nothing is re-read or re-extracted)
//     opts  = { refOf(ctxRef) → string }   how a figure is named to the caller ("r1.f3" by default; B2 passes its R<n> ids)
//
//   TrendAnalysis = {
//     version: 1, usable: boolean,
//     reports:  [{ key, places: [string], geoStatus: "match"|"different"|"not_named", geoMessage, period: { label, start, end, kind }, scopeSentence, notice }],
//     character:     { key, label, summary } | null     the market's overall character, one of CHARACTERS (derived from the relationships)
//     observations:  [{ id: "TI1", kind, signal, strength 1-3, title, statement, reportKey, basis: { type, label }, evidence: [{ ref, text }] }]
//                      statement carries NO numbers; every number lives in evidence[].text, which is the report's own figure text
//     contrasts:     [{ id, kind: "mixed_signal", between: [observation ids], statement }]
//     interpretations: [{ id, audience: "realtor"|"homeowner"|"buyer", status: "interpretation", text, basis: [observation ids] }]
//                      plausible professional readings of the observations; never forecasts, never stated as established fact
//     caveats:       [string]                            small sample, one week of data, a wider area than requested, ...
//   }
//   promptBlock(analysis) → string      what a model is shown (observations, contrasts, interpretations, caveats; data, not instructions)
//   editorialInput(analysis, ids)       → { character, observations, contrasts, interpretations, evidence } the subset a selected topic keeps
//
// Nothing here predicts. "Plausible readings" are labelled interpretation; forecasts, guarantees and invented figures are not produced.
"use strict";

const reportLib = require("./agent-marketing-report-lib");

const VERSION = 1;
const MAX_OBSERVATIONS = 8;
const CHARACTERS = {
  inventory_building: "Supply is building while sales slow",
  tight_supply: "Supply is tight and demand is absorbing it",
  firm_prices_slow_sales: "Prices are holding while activity slows",
  heating_up: "Demand is gaining on supply",
  balanced_steady: "A steady, balanced market",
  buyer_leverage: "Buyers have room to negotiate",
  mixed: "Mixed signals",
};

// ── Reading one report's figures ────────────────────────────────────────────────────────────────────────────────────────
const FLAT_BELOW = { pct: 0.5, default: 2.5 };
function changeOf(f, basis) {
  if (!f) return null;
  if (f.printed && Number.isFinite(f.printed[basis])) return { pct: f.printed[basis], points: f.unit === "pct" };
  if (basis === "prior" && Array.isArray(f.changes) && f.changes.length) return { pct: f.changes[0].pct, points: false, vs: f.changes[0].vs };
  const earlier = f[basis];
  if (earlier == null || !Number.isFinite(Number(earlier))) return null;
  const now = Number(f.value), then = Number(earlier);
  if (f.unit === "pct") return { pct: now - then, points: true };
  if (then === 0) return null;
  return { pct: ((now - then) / Math.abs(then)) * 100, points: false };
}
function dirOf(c, unit) {
  if (!c || !Number.isFinite(c.pct)) return null;
  const flat = unit === "pct" ? FLAT_BELOW.pct : FLAT_BELOW.default;
  return Math.abs(c.pct) < flat ? "flat" : c.pct > 0 ? "up" : "down";
}
const word = { up: "rose", down: "fell", flat: "held steady" };

/** The months of inventory a report shows, whatever it calls them (weeks are converted). */
function monthsSupply(figs) {
  const m = figs.months_supply || figs.months_supply_pended;
  if (m && Number.isFinite(m.value)) return { value: m.value, fig: m };
  const w = figs.weeks_supply;
  if (w && Number.isFinite(w.value)) return { value: w.value / 4.345, fig: w };
  return null;
}
const balanceOf = (months) => (months < 3 ? "sellers" : months > 6 ? "buyers" : "balanced");

function basesFor(facts) {
  const p = (facts && facts.period) || {};
  const out = [];
  const has = (k) => (facts.figures || []).some((f) => (k === "prior" ? f.prior != null || (f.changes && f.changes.length) : f[k] != null || (f.printed && f.printed[k] != null)));
  if (has("yearAgo")) out.push({ type: "yearAgo", label: p.yearAgoLabel || "a year earlier" });
  if (has("prior")) out.push({ type: "prior", label: p.priorLabel || ((facts.figures || []).find((f) => f.changes && f.changes.length) || { changes: [{ vs: "the earlier period" }] }).changes[0].vs });
  return out;
}

function analyzeReport(rep, figures, refOf, basis) {
  // figures: ctx figures of this report → by key (base measures only; year-to-date figures are kept apart)
  const byKey = {}, ytd = {};
  figures.forEach((cf) => { if (/_ytd$/.test(cf.fig.key)) ytd[cf.fig.key.replace(/_ytd$/, "")] = cf; else if (!byKey[cf.fig.key]) byKey[cf.fig.key] = cf; });
  const F = (k) => (byKey[k] ? byKey[k].fig : null);
  const figsOnly = {}; Object.keys(byKey).forEach((k) => { figsOnly[k] = byKey[k].fig; });
  const ev = (...keys) => keys.map((k) => byKey[k]).filter(Boolean).map((cf) => ({ ref: refOf(cf.ref), text: oneLine(rep, cf, basis) }));
  const evYtd = (...keys) => keys.map((k) => ytd[k]).filter(Boolean).map((cf) => ({ ref: refOf(cf.ref), text: oneLine(rep, cf, { type: "yearAgo" }) }));
  const dir = (k) => { const f = F(k); return f ? dirOf(changeOf(f, basis.type), f.unit) : null; };
  const out = [];
  const add = (o) => out.push({ reportKey: rep.key, basis: { type: basis.type, label: basis.label }, ...o });

  const inv = dir("count_active"), newL = dir("count_new"), sold = dir("count_closed"), pend = dir("count_pending");
  const price = dir("median_close_price") || dir("avg_close_price") || dir("median_ppsf") || dir("avg_ppsf");
  const priceKey = F("median_close_price") ? "median_close_price" : F("avg_close_price") ? "avg_close_price" : F("median_ppsf") ? "median_ppsf" : "avg_ppsf";
  const dom = dir("avg_dom") || dir("median_dom");
  const domKey = F("avg_dom") ? "avg_dom" : "median_dom";
  const s2l = dir("avg_close_to_list_pct");
  const supplySide = inv || newL;
  const demandSide = sold || pend;
  const supplyKey = inv ? "count_active" : "count_new", demandKey = sold ? "count_closed" : "count_pending";

  // 1. Supply against demand
  if (supplySide && demandSide) {
    const sig = supplySide === "up" && demandSide === "down" ? "buyer_favoring" : supplySide === "down" && demandSide === "up" ? "seller_favoring" : supplySide === "up" && demandSide === "up" ? "mixed" : supplySide === "down" && demandSide === "down" ? "mixed" : "neutral";
    if (sig !== "neutral" || supplySide !== "flat" || demandSide !== "flat") {
      add({ kind: "supply_demand", signal: sig, strength: sig === "buyer_favoring" || sig === "seller_favoring" ? 3 : 2,
        title: sig === "buyer_favoring" ? "More homes, fewer sales" : sig === "seller_favoring" ? "Fewer homes, more sales" : "Supply and sales moving together",
        statement: `${inv ? "Active listings" : "New listings"} ${word[supplySide]} while ${sold ? "closed sales" : "pended sales"} ${word[demandSide]}.`,
        evidence: ev(supplyKey, demandKey) });
    }
  }
  // 2. Months of inventory: the balance, and which way it is moving
  const ms = monthsSupply(figsOnly);
  if (ms) {
    const bal = balanceOf(ms.value), c = changeOf(ms.fig, basis.type), d = dirOf(c, ms.fig.unit);
    const key = Object.keys(byKey).find((k) => byKey[k].fig === ms.fig);
    add({ kind: "market_balance", signal: bal === "sellers" ? "seller_favoring" : bal === "buyers" ? "buyer_favoring" : "neutral", strength: bal === "balanced" ? 2 : 3,
      title: bal === "sellers" ? "Inventory is lean" : bal === "buyers" ? "Inventory is ample" : "Inventory is in the balanced range",
      statement: `Months of inventory sit in the ${bal === "sellers" ? "seller's-market" : bal === "buyers" ? "buyer's-market" : "balanced"} range${d ? ` and ${d === "flat" ? "held steady" : d === "up" ? "rose" : "fell"}` : ""}.`,
      evidence: ev(key), balance: bal, direction: d });
  }
  // 3. Pricing against activity
  if (price && demandSide && (price !== "flat" || demandSide !== "flat")) {
    const sig = price === "up" && demandSide === "down" ? "mixed" : price === "down" && demandSide === "up" ? "mixed" : price === "flat" ? "mixed" : price === "up" ? "seller_favoring" : price === "down" ? "buyer_favoring" : "neutral";
    add({ kind: "price_vs_activity", signal: sig, strength: sig === "mixed" ? 3 : 2,
      title: price === "up" && demandSide === "down" ? "Prices firm while sales slow" : price === "down" && demandSide === "up" ? "Sales up while prices ease" : price === "flat" ? (demandSide === "down" ? "Prices steady while sales slow" : "Prices steady while sales pick up") : price === "up" ? (demandSide === "up" ? "Prices and sales rising together" : "Prices rising, sales steady") : (demandSide === "down" ? "Prices easing with sales" : "Prices easing, sales steady"),
      statement: `${labelOf(F(priceKey))} ${word[price]} while ${sold ? "closed sales" : "pended sales"} ${word[demandSide]}.`,
      evidence: ev(priceKey, demandKey) });
  }
  // 4. Speed of sale
  if (dom) {
    const sig = dom === "up" ? "buyer_favoring" : dom === "down" ? "seller_favoring" : "neutral";
    if (dom !== "flat") add({ kind: "sales_velocity", signal: sig, strength: 2, title: dom === "up" ? "Homes taking longer to sell" : "Homes selling faster",
      statement: `${labelOf(F(domKey))} ${word[dom]}.`, evidence: ev(domKey) });
  }
  // 5. Negotiation room: the price actually received against the list price
  const s2lFig = F("avg_close_to_list_pct");
  if (s2lFig) {
    const lvl = s2lFig.value >= 100 ? "above" : s2lFig.value >= 98 ? "near" : "below";
    add({ kind: "negotiation", signal: lvl === "above" ? "seller_favoring" : lvl === "below" ? "buyer_favoring" : "neutral", strength: lvl === "near" ? 1 : 2,
      title: lvl === "above" ? "Homes selling above list" : lvl === "below" ? "Room to negotiate" : "Sales landing close to list",
      statement: `Sold prices are ${lvl === "above" ? "above" : lvl === "below" ? "meaningfully below" : "close to"} list prices${s2l && s2l !== "flat" ? ` and the gap ${s2l === "up" ? "narrowed in sellers' favor" : "widened in buyers' favor"}` : ""}.`,
      evidence: ev("avg_close_to_list_pct", "avg_close_to_orig_list_pct") });
  }
  // 6. Asking prices against sold prices
  const askF = F("median_list_price") || F("avg_list_price"), soldF = F("median_close_price") || F("avg_close_price");
  if (askF && soldF && askF.unit === "usd" && soldF.unit === "usd" && soldF.value > 0) {
    const gap = (askF.value - soldF.value) / soldF.value * 100;
    if (Math.abs(gap) >= 3) {
      const askKey = F("median_list_price") ? "median_list_price" : "avg_list_price", soldKey = F("median_close_price") ? "median_close_price" : "avg_close_price";
      add({ kind: "asking_vs_sold", signal: gap > 0 ? "buyer_favoring" : "seller_favoring", strength: 1, title: gap > 0 ? "Asking prices sit above recent sold prices" : "Sold prices sit above current asking prices",
        statement: `The current ${labelOf(askF).toLowerCase()} is ${gap > 0 ? "above" : "below"} the ${labelOf(soldF).toLowerCase()}, so what sellers ask and what buyers have recently paid are not the same thing.`, evidence: ev(askKey, soldKey) });
    }
  }
  // 7. The month against the year to date (only reports that carry both)
  const ytdC = ytd.count_closed, monC = byKey.count_closed;
  if (ytdC && monC) {
    const m = dirOf(changeOf(monC.fig, "yearAgo"), "count"), y = dirOf(changeOf(ytdC.fig, "yearAgo"), "count");
    if (m && y && m !== y && (m !== "flat" || y !== "flat")) add({ kind: "month_vs_year", signal: "mixed", strength: 3, title: "This month differs from the year so far",
      statement: `Closed sales ${word[m]} this month against a year ago, while the year to date ${word[y]}.`, evidence: ev("count_closed").concat(evYtd("count_closed")) });
  }
  return out;
}
function labelOf(f) { return f ? f.label.charAt(0).toUpperCase() + f.label.slice(1) : ""; }
function oneLine(rep, cf, basis) {
  const f = cf.fig;
  const all = reportLib.compareText(rep.facts, f);
  return `${f.label}: ${reportLib.formatFigure(f)}${all ? ` ${all}` : ""}`;
}

// ── From relationships to a character and Realtor readings ──────────────────────────────────────────────────────────────────
function characterOf(obs) {
  const has = (kind, sig) => obs.some((o) => o.kind === kind && (!sig || o.signal === sig));
  const bal = (obs.find((o) => o.kind === "market_balance") || {}).balance;
  const n = (sig) => obs.filter((o) => o.signal === sig).length;
  let key;
  if (has("supply_demand", "buyer_favoring") && has("price_vs_activity") && obs.find((o) => o.kind === "price_vs_activity").title === "Prices firm while sales slow") key = "firm_prices_slow_sales";
  else if (has("supply_demand", "buyer_favoring")) key = "inventory_building";
  else if (bal === "sellers" && n("seller_favoring") >= n("buyer_favoring")) key = "tight_supply";
  else if (has("supply_demand", "seller_favoring") || n("seller_favoring") > n("buyer_favoring") + 1) key = "heating_up";
  else if (bal === "buyers" || n("buyer_favoring") > n("seller_favoring") + 1) key = "buyer_leverage";
  else if (n("mixed") >= 2) key = "mixed";
  else key = "balanced_steady";
  return { key, label: CHARACTERS[key] };
}

const READINGS = {
  supply_demand: {
    buyer_favoring: { realtor: "When listings build faster than sales close, the same home faces more competition for fewer buyers. The conversation shifts from whether to list to how a home is positioned against what is already on the market.", homeowner: "More comparable homes for sale can mean a longer wait and more scrutiny of price and condition; an owner planning a sale in the next few years benefits from knowing where their home would sit among them.", buyer: "More choice and less competition can give a buyer time to compare and room to ask for terms." },
    seller_favoring: { realtor: "Fewer homes for sale with sales still closing means well-prepared homes draw attention quickly; the risk shifts to pricing too ambitiously and wasting the early days.", homeowner: "A thinner supply tends to reward a home that is priced and presented well from the first day.", buyer: "With few homes to choose from, a buyer who is ready to act and has financing lined up is better placed." },
    mixed: { realtor: "Supply and sales are moving in the same direction, which says activity as a whole is rising or falling rather than the balance shifting; the story is the pace of the market, not who holds the leverage.", homeowner: "A quieter or busier market overall affects how long a sale takes more than what it sells for.", buyer: "Because the balance has not clearly shifted, local detail on the specific price range matters more than the headline." },
  },
  market_balance: {
    seller_favoring: { realtor: "Inventory in the seller's range means each new listing is competing with few others.", homeowner: "Lean inventory generally supports an owner's position, though each home is still judged on price and condition.", buyer: "Lean inventory means moving quickly and decisively on a home that fits." },
    buyer_favoring: { realtor: "Inventory in the buyer's range means a seller is competing with many homes; presentation, price and terms carry more weight.", homeowner: "With more homes available, an owner thinking about selling benefits from planning the timing and preparation ahead of listing.", buyer: "Ample inventory gives a buyer room to compare homes and negotiate." },
    neutral: { realtor: "Inventory in the balanced range means neither side has a clear structural advantage; individual pricing and preparation decide results.", homeowner: "A balanced market rewards realistic pricing more than waiting for conditions to change.", buyer: "A balanced market means both choice and competition; knowing the specific neighborhood matters." },
  },
  price_vs_activity: {
    mixed: { realtor: "Prices and sales are pulling in different directions. Prices tend to move more slowly than activity, so a price that holds while sales slow can reflect owners who are not yet reducing prices and buyers who are waiting; it is a signal to watch rather than a conclusion.", homeowner: "A headline price that has held does not mean a home will sell as it would have last season; pace and presentation matter alongside price.", buyer: "A firm price with slower sales can leave room to negotiate on individual homes." },
    seller_favoring: { realtor: "Prices and sales rising together point to demand that is keeping up with, and lifting, what homes sell for.", homeowner: "Rising sold prices support an owner's equity, and still depend on the specific home and street.", buyer: "Rising prices with strong sales reward preparation and speed." },
    buyer_favoring: { realtor: "Sold prices easing with fewer sales suggests buyers have more say in the price.", homeowner: "Easing prices are worth knowing about before deciding when to sell or refinance.", buyer: "Easing prices can improve affordability, and good homes still sell." },
    neutral: { realtor: "Prices and sales are moving in step.", homeowner: "Steady prices reduce the guesswork about timing.", buyer: "Steady prices make planning easier." },
  },
  sales_velocity: {
    buyer_favoring: { realtor: "Homes taking longer to sell tells sellers and agents to price against the market that exists now, not the one that sold the last home on the street.", homeowner: "A longer time to sell is worth planning for, in both the timeline and the carrying costs.", buyer: "Longer market times give a buyer more time to decide." },
    seller_favoring: { realtor: "Homes selling faster means the first week of a listing matters more.", homeowner: "Faster sales favor an owner who has prepared the home and the paperwork ahead of listing.", buyer: "Faster sales mean a buyer needs to be decisive." },
  },
  negotiation: {
    buyer_favoring: { realtor: "Sold prices landing meaningfully below list is room to negotiate, and a signal that list price strategy matters.", homeowner: "Sales closing below list say that an overly ambitious list price is likely to be corrected by the market.", buyer: "Homes closing below list suggest a buyer can reasonably ask." },
    seller_favoring: { realtor: "Sold prices at or above list reflect competing buyers.", homeowner: "Sales above list reward a well-priced, well-prepared home.", buyer: "Homes closing above list mean offers need to be strong from the start." },
    neutral: { realtor: "Sold prices landing close to list says pricing is working when it is realistic.", homeowner: "A small gap between list and sold price rewards pricing at the market from the beginning.", buyer: "Little gap between list and sold price means little room to negotiate, but little overpricing to worry about." },
  },
  asking_vs_sold: {
    buyer_favoring: { realtor: "A gap between today's asking prices and what recently sold is the usual place where listings stall.", homeowner: "Asking prices are not sold prices; an owner is better served by what homes actually closed for.", buyer: "Sold prices, not asking prices, show what the market is paying." },
    seller_favoring: { realtor: "Recent sold prices running above current asking prices suggest new listings are priced conservatively.", homeowner: "Recent sold prices are a better guide to value than a few current listings.", buyer: "Recent sold prices running above asking prices mean list price alone understates what homes may fetch." },
  },
  month_vs_year: {
    mixed: { realtor: "When one month differs from the year so far, the month may be an interruption rather than a change of direction; both numbers belong in the story.", homeowner: "One month is a snapshot; the year to date gives the longer background.", buyer: "A single month is a snapshot, so weigh it against the year so far." },
  },
};

function readingsFor(obs) {
  const out = [];
  obs.forEach((o) => {
    const r = (READINGS[o.kind] || {})[o.signal] || (READINGS[o.kind] || {}).neutral;
    if (!r) return;
    ["realtor", "homeowner", "buyer"].forEach((aud) => { if (r[aud]) out.push({ id: "", audience: aud, status: "interpretation", text: r[aud], basis: [o.id] }); });
  });
  return out;
}

// ── analyze ───────────────────────────────────────────────────────────────────────────────────────────────────────────────
/**
 * analyze(ctx, { refOf }) → TrendAnalysis. Reports without comparisons (a CMA, a snapshot with no earlier figures) produce no relationships;
 * `usable` is then false and the caller says so rather than inventing an analysis.
 */
function analyze(ctx, opts) {
  const refOf = (opts && opts.refOf) || ((r) => r);
  const reports = (ctx && ctx.reports) || [];
  const view = reports.map((r) => ({ key: r.key, places: r.places, geoStatus: r.geoStatus, geoMessage: r.geoMessage || "",
    period: r.facts.period ? { label: r.facts.period.label, start: r.facts.period.start, end: r.facts.period.end, kind: r.facts.period.weekly ? "week" : r.facts.period.ytd ? "month_and_year_to_date" : "month" } : null,
    scopeSentence: r.scopeSentence, notice: r.notice || null }));
  let obs = [];
  reports.forEach((rep) => {
    const figures = [...((ctx.figures && ctx.figures.values && ctx.figures.values()) || [])].filter((cf) => cf.report === rep);
    const bases = basesFor(rep.facts);
    // The comparison against the same period a year earlier is the primary basis; the earlier month adds only what it says differently.
    const seen = new Set();
    bases.forEach((b) => {
      analyzeReport(rep, figures, refOf, b).forEach((o) => { const k = `${o.reportKey}|${o.kind}|${o.signal}`; if (seen.has(k) && b.type === "prior") return; seen.add(k); obs.push(o); });
    });
  });
  obs.sort((a, b) => b.strength - a.strength);
  obs = obs.slice(0, MAX_OBSERVATIONS).map((o, i) => ({ ...o, id: `TI${i + 1}` }));
  const contrasts = [];
  const sig = (s) => obs.filter((o) => o.signal === s);
  if (sig("buyer_favoring").length && sig("seller_favoring").length) {
    const a = sig("buyer_favoring")[0], b = sig("seller_favoring")[0];
    contrasts.push({ id: "TC1", kind: "mixed_signal", between: [a.id, b.id], statement: `"${a.title}" favors buyers, while "${b.title}" favors sellers: the report does not point one way.` });
  }
  obs.filter((o) => o.signal === "mixed").slice(0, 2).forEach((o) => contrasts.push({ id: `TC${contrasts.length + 1}`, kind: "mixed_signal", between: [o.id], statement: `${o.title}: the figures pull in different directions.` }));
  const interpretations = readingsFor(obs).map((r, i) => ({ ...r, id: `TR${i + 1}` }));
  const caveats = [];
  reports.forEach((r) => {
    if (r.geoStatus === "different" && r.geoMessage) caveats.push(r.geoMessage);
    if (r.facts.sample && r.facts.sample.small) caveats.push("The report has a small sample of closed sales: describe it as a snapshot, not a trend.");
    if (r.facts.period && r.facts.period.weekly) caveats.push("The report covers one week: describe the week and its changes, never a trend.");
  });
  const usable = obs.length >= 2;
  return { version: VERSION, usable, reports: view, character: usable ? characterOf(obs) : null, observations: obs, contrasts, interpretations, caveats: [...new Set(caveats)] };
}

/** What a model is shown. Observation statements carry no numbers; the evidence lines are the report's own figure text. */
function promptBlock(a) {
  if (!a || !a.usable) return "";
  const L = [];
  L.push("TREND INTELLIGENCE (derived from the agent's confirmed report; interpretations are plausible professional readings, not established facts or forecasts)");
  a.reports.forEach((r) => L.push(`Report ${r.key}: ${r.scopeSentence}`));
  if (a.character) L.push(`Market character: ${a.character.label}`);
  a.observations.forEach((o) => {
    L.push(`${o.id} [${o.kind}; ${o.signal}; compared with ${o.basis.label}] ${o.title}. ${o.statement}`);
    o.evidence.forEach((e) => L.push(`   evidence ${e.ref}: ${e.text}`));
  });
  a.contrasts.forEach((c) => L.push(`${c.id} [contrast: ${c.between.join(", ")}] ${c.statement}`));
  a.interpretations.forEach((i) => L.push(`${i.id} [${i.audience} reading of ${i.basis.join(", ")}] ${i.text}`));
  a.caveats.forEach((c) => L.push(`Caveat: ${c}`));
  return L.join("\n");
}

/** The slice of an analysis that one selected topic keeps: the observations it rests on, their evidence, contrasts and readings. */
function editorialInput(a, observationIds) {
  const ids = new Set((observationIds || []).map(String));
  if (!a || !a.usable) return null;
  const obs = a.observations.filter((o) => ids.has(o.id));
  if (!obs.length) return null;
  const refs = new Set(obs.map((o) => o.id));
  return {
    version: a.version, character: a.character, reports: a.reports.map((r) => ({ key: r.key, places: r.places, period: r.period, geoStatus: r.geoStatus })),
    observations: obs.map((o) => ({ id: o.id, kind: o.kind, signal: o.signal, title: o.title, statement: o.statement, basis: o.basis, evidence: o.evidence })),
    contrasts: a.contrasts.filter((c) => c.between.some((b) => refs.has(b))),
    interpretations: a.interpretations.filter((i) => i.basis.some((b) => refs.has(b))),
    caveats: a.caveats,
  };
}

module.exports = { VERSION, CHARACTERS, MAX_OBSERVATIONS, analyze, promptBlock, editorialInput, changeOf, dirOf, balanceOf };
