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
  const elig = reportLib.eligibleChanges(f);
  if (basis === "prior" && elig.length) return { pct: elig[0].pct, points: false, vs: elig[0].vs, kind: elig[0].kind };
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
/** What a "flat" reading may be called: a small decline is never described as unchanged ("edged lower"); "held steady" is only for a change of zero. */
function said(c, d) {
  if (d !== "flat") return word[d];
  const p = c && Number.isFinite(c.pct) ? c.pct : 0;
  return p < 0 ? "edged lower" : p > 0 ? "edged higher" : word.flat;
}

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
  const has = (k) => (facts.figures || []).some((f) => (k === "prior" ? f.prior != null || reportLib.eligibleChanges(f).length > 0 : f[k] != null || (f.printed && f.printed[k] != null)));
  if (has("yearAgo")) out.push({ type: "yearAgo", label: p.yearAgoLabel || "a year earlier" });
  if (has("prior")) out.push({ type: "prior", label: p.priorLabel || (((facts.figures || []).map((f) => reportLib.eligibleChanges(f)).find((e) => e.length) || [{ vs: "the earlier period" }])[0]).vs });
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
  const chg = (k) => { const f = F(k); return f ? changeOf(f, basis.type) : null; };
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
        statement: `${inv ? "Active listings" : "New listings"} ${said(chg(supplyKey), supplySide)} while ${sold ? "closed sales" : "pended sales"} ${said(chg(demandKey), demandSide)}.`,
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
      statement: `Months of inventory sit in the ${bal === "sellers" ? "seller's-market" : bal === "buyers" ? "buyer's-market" : "balanced"} range${d ? ` and ${said(c, d)}` : ""}.`,
      evidence: ev(key), balance: bal, direction: d });
  }
  // 3. Pricing against activity
  const flatPrice = () => { const c = chg(priceKey); return c && c.pct < 0 ? "Prices edged lower" : c && c.pct > 0 ? "Prices edged higher" : "Prices unchanged"; };
  if (price && demandSide && (price !== "flat" || demandSide !== "flat")) {
    const sig = price === "up" && demandSide === "down" ? "mixed" : price === "down" && demandSide === "up" ? "mixed" : price === "flat" ? "mixed" : price === "up" ? "seller_favoring" : price === "down" ? "buyer_favoring" : "neutral";
    add({ kind: "price_vs_activity", signal: sig, strength: sig === "mixed" ? 3 : 2,
      title: price === "up" && demandSide === "down" ? "Prices firm while sales slow" : price === "down" && demandSide === "up" ? "Sales up while prices ease" : price === "flat" ? (flatPrice() + (demandSide === "down" ? " while sales slow" : " while sales pick up")) : price === "up" ? (demandSide === "up" ? "Prices and sales rising together" : "Prices rising, sales steady") : (demandSide === "down" ? "Prices easing with sales" : "Prices easing, sales steady"),
      statement: `${labelOf(F(priceKey))} ${said(chg(priceKey), price)} while ${sold ? "closed sales" : "pended sales"} ${said(chg(demandKey), demandSide)}.`,
      evidence: ev(priceKey, demandKey) });
  }
  // 4. Speed of sale
  if (dom) {
    const sig = dom === "up" ? "buyer_favoring" : dom === "down" ? "seller_favoring" : "neutral";
    if (dom !== "flat") add({ kind: "sales_velocity", signal: sig, strength: 2, title: dom === "up" ? "Homes taking longer to sell" : "Homes selling faster",
      statement: `${labelOf(F(domKey))} ${said(chg(domKey), dom)}.`, evidence: ev(domKey) });
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
  // like with like: a median asking price against a median sold price, or an average against an average (never a mean against a median)
  const pair = F("median_list_price") && F("median_close_price") ? ["median_list_price", "median_close_price"] : F("avg_list_price") && F("avg_close_price") ? ["avg_list_price", "avg_close_price"] : null;
  const askF = pair ? F(pair[0]) : null, soldF = pair ? F(pair[1]) : null;
  if (askF && soldF && askF.unit === "usd" && soldF.unit === "usd" && soldF.value > 0) {
    const gap = (askF.value - soldF.value) / soldF.value * 100;
    if (Math.abs(gap) >= 3) {
      const askKey = pair[0], soldKey = pair[1];
      add({ kind: "asking_vs_sold", signal: gap > 0 ? "buyer_favoring" : "seller_favoring", strength: 1, title: gap > 0 ? "Asking prices sit above recent sold prices" : "Sold prices sit above current asking prices",
        statement: `The current ${labelOf(askF).toLowerCase()} is ${gap > 0 ? "above" : "below"} the ${labelOf(soldF).toLowerCase()}, so what sellers ask and what buyers have recently paid are not the same thing.`, evidence: ev(askKey, soldKey) });
    }
  }
  // 7. The month against the year to date (only reports that carry both)
  const ytdC = ytd.count_closed, monC = byKey.count_closed;
  if (ytdC && monC) {
    const m = dirOf(changeOf(monC.fig, "yearAgo"), "count"), y = dirOf(changeOf(ytdC.fig, "yearAgo"), "count");
    if (m && y && m !== y && (m !== "flat" || y !== "flat")) add({ kind: "month_vs_year", signal: "mixed", strength: 3, title: "This month differs from the year so far",
      statement: `Closed sales ${said(changeOf(monC.fig, "yearAgo"), m)} this month against a year ago, while the year to date ${said(changeOf(ytdC.fig, "yearAgo"), y)}.`, evidence: ev("count_closed").concat(evYtd("count_closed")) });
  }
  return out;
}
// A snapshot with no earlier-period figures (a CMA: active, pending, closed and canceled listings at one date) still has relationships ACROSS statuses.
function analyzeSnapshot(rep, figures, refOf) {
  const get = (status, key) => figures.find((cf) => cf.fig.status === status && cf.fig.key === key) || null;
  const basis = { type: "snapshot", label: "the other listings in this same report" };
  const out = [];
  const ev = (...cfs) => cfs.filter(Boolean).map((cf) => ({ ref: refOf(cf.ref), text: oneLine(rep, cf, basis) }));
  const add = (o) => out.push({ reportKey: rep.key, basis, ...o });
  const v = (cf) => (cf && Number.isFinite(cf.fig.value) ? cf.fig.value : null);
  const act = get("active", "count"), pen = get("pending", "count"), clo = get("closed", "count"), can = get("canceled", "count");
  if (v(act) > 0 && v(pen) != null) {
    const r = v(pen) / v(act);
    const sig = r < 0.25 ? "buyer_favoring" : r > 0.5 ? "seller_favoring" : "neutral";
    add({ kind: "pending_vs_active", signal: sig, strength: sig === "neutral" ? 1 : 3, title: sig === "buyer_favoring" ? "Few homes under contract for the number available" : sig === "seller_favoring" ? "Many homes under contract for the number available" : "A middling share of homes under contract",
      statement: `The number of pending listings is ${sig === "buyer_favoring" ? "small" : sig === "seller_favoring" ? "large" : "moderate"} next to the number of active listings.`, evidence: ev(act, pen) });
  }
  const aDom = get("active", "median_dom") || get("active", "avg_dom"), cDom = get("closed", "median_dom") || get("closed", "avg_dom");
  if (v(aDom) != null && v(cDom) > 0 && aDom.fig.key === cDom.fig.key) {
    const r = v(aDom) / v(cDom);
    if (r >= 1.4 || r <= 0.8) add({ kind: "pace_split", signal: r >= 1.4 ? "mixed" : "seller_favoring", strength: 3, title: r >= 1.4 ? "Sold homes went fast; what is still listed has waited longer" : "Active listings are newer than the homes that sold",
      statement: r >= 1.4 ? "Homes that closed spent fewer days on the market than the homes still active, so the market moves quickly for some homes and slowly for others." : "Active listings have been on the market for fewer days than the homes that closed.", evidence: ev(cDom, aDom) });
  }
  const red = get("active", "reduced_count");
  if (v(act) > 0 && v(red) != null) {
    const r = v(red) / v(act);
    if (r >= 0.4 || r <= 0.15) add({ kind: "price_reductions", signal: r >= 0.4 ? "buyer_favoring" : "seller_favoring", strength: 3, title: r >= 0.4 ? "A large share of active listings have cut their price" : "Few active listings have cut their price",
      statement: r >= 0.4 ? "A large share of active listings have already reduced their price, which says initial pricing is being corrected by the market." : "Few active listings have needed a price reduction.", evidence: ev(red, act) });
  }
  const s2l = get("closed", "avg_close_to_list_pct"), atAbove = get("closed", "at_or_above_list_count");
  if (v(s2l) != null) {
    const lvl = v(s2l) >= 100 ? "above" : v(s2l) >= 98 ? "near" : "below";
    const share = v(clo) > 0 && v(atAbove) != null ? v(atAbove) / v(clo) : null;
    add({ kind: "negotiation", signal: lvl === "above" || (share != null && share >= 0.5) ? "seller_favoring" : lvl === "below" ? "buyer_favoring" : "neutral", strength: 2,
      title: lvl === "below" ? "Room to negotiate" : share != null && share >= 0.5 ? "Many homes closing at or above list" : "Sales landing close to list",
      statement: `Sold prices are ${lvl === "above" ? "above" : lvl === "below" ? "meaningfully below" : "close to"} list prices${share != null ? `, and ${share >= 0.5 ? "a majority of" : "fewer than half of"} closed sales reached or beat list price` : ""}.`, evidence: ev(s2l, atAbove, clo) });
  }
  const aList = get("active", "median_list_price"), cSold = get("closed", "median_close_price");
  if (v(aList) != null && v(cSold) > 0) {
    const gap = (v(aList) - v(cSold)) / v(cSold) * 100;
    if (Math.abs(gap) >= 3) add({ kind: "asking_vs_sold", signal: gap > 0 ? "buyer_favoring" : "seller_favoring", strength: 2, title: gap > 0 ? "Asking prices sit above what homes sold for" : "Homes sold for more than current asking prices",
      statement: `The typical active asking price is ${gap > 0 ? "above" : "below"} the typical closed price, so what sellers ask and what buyers have recently paid are not the same thing.`, evidence: ev(aList, cSold) });
  }
  const pList = get("pending", "median_list_price");
  if (v(pList) != null && v(aList) > 0 && Math.abs((v(pList) - v(aList)) / v(aList)) * 100 >= 3) {
    const lower = v(pList) < v(aList);
    add({ kind: "price_tier", signal: lower ? "buyer_favoring" : "seller_favoring", strength: 2, title: lower ? "Homes going under contract are priced below those still available" : "Homes going under contract are priced above those still available",
      statement: lower ? "The typical pending listing is priced below the typical active listing, which suggests buyers are committing at the more modest price points." : "The typical pending listing is priced above the typical active listing.", evidence: ev(pList, aList) });
  }
  if (v(can) != null && v(clo) > 0 && v(can) / v(clo) >= 0.3) add({ kind: "cancellations", signal: "mixed", strength: 2, title: "Many listings left the market unsold",
    statement: "A notable number of listings were canceled in the same period that others closed, which says some sellers were not meeting the market where they priced.", evidence: ev(can, clo) });
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
    mixed: { realtor: "Prices and sales are not moving in step: the price has moved far less than sales activity. Prices tend to move more slowly than activity, so a price that has barely moved while sales slow can reflect owners who are not yet reducing prices and buyers who are waiting; it is a signal to watch rather than a conclusion.", homeowner: "A headline price that has barely moved does not mean a home will sell as it would have in a faster month; pace and presentation matter alongside price.", buyer: "A price that has barely moved while sales slow can leave room to negotiate on individual homes." },
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
  pending_vs_active: {
    buyer_favoring: { realtor: "When few homes are under contract next to the number for sale, supply is outrunning demand in this snapshot; the listings that do go under contract are the ones priced and presented to the market.", homeowner: "A long list of available homes with few contracts means an owner who sells competes for attention, so planning price and preparation ahead matters.", buyer: "Plenty of choice and less pressure can give a buyer time to compare." },
    seller_favoring: { realtor: "A large share of homes under contract next to those available says demand is absorbing supply.", homeowner: "When many homes go under contract, a well-prepared home tends to get attention quickly.", buyer: "With many homes going under contract, a buyer needs to be ready." },
    neutral: { realtor: "A moderate share under contract says neither side clearly dominates; individual pricing decides.", homeowner: "A balanced snapshot rewards realistic pricing.", buyer: "A balanced snapshot means choice, with some competition." },
  },
  pace_split: {
    mixed: { realtor: "A market where sold homes were quick but active homes have waited is really two markets: homes priced and prepared for today sell quickly, and the rest sit. The gap is the story.", homeowner: "Whether a home sells quickly or sits depends heavily on price and condition, not on the market as a whole.", buyer: "Longer-waiting listings may be open to negotiation, while the fresh ones move fast." },
    seller_favoring: { realtor: "Active listings that are newer than what sold say the market is turning over quickly.", homeowner: "Quick turnover favors a home that is ready on day one.", buyer: "A quick-turning market rewards decisiveness." },
  },
  price_reductions: {
    buyer_favoring: { realtor: "When a large share of active listings have cut their price, the market is correcting initial pricing; a seller who starts at the right number avoids the cut.", homeowner: "Price cuts are a sign that the first price matters; starting right is worth more than correcting later.", buyer: "Many price reductions mean sellers are adjusting, which can leave room to negotiate." },
    seller_favoring: { realtor: "Few price cuts say initial pricing is largely holding.", homeowner: "Few price cuts suggest sellers are pricing in line with buyers.", buyer: "Few price cuts mean less room to expect a discount." },
  },
  cancellations: {
    mixed: { realtor: "Listings that are canceled rather than sold are the quiet measure of overpricing or unready homes; they tell sellers how not to position a home.", homeowner: "A canceled listing is a costly lesson; preparation and pricing before listing avoid it.", buyer: "Canceled listings can come back at different prices." },
  },
  price_tier: {
    buyer_favoring: { realtor: "Contracts clustering below the price of what remains available suggests the pressure is at the more modest price points.", homeowner: "Where a home sits in the price range changes how quickly it draws a buyer.", buyer: "More modest price points may see the most competition." },
    seller_favoring: { realtor: "Contracts at higher price points than what remains available says buyers are committing at the upper end.", homeowner: "Upper-range homes are drawing buyers in this snapshot.", buyer: "Buyers at higher price points should expect competition." },
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
    if (!bases.length) { analyzeSnapshot(rep, figures, refOf).forEach((o) => obs.push(o)); return; }
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
  obs.filter((o) => o.signal === "mixed").slice(0, 2).forEach((o) => contrasts.push({ id: `TC${contrasts.length + 1}`, kind: "mixed_signal", between: [o.id], statement: `${o.title}: the price and the sales activity are not moving in step.` }));
  const interpretations = readingsFor(obs).map((r, i) => ({ ...r, id: `TR${i + 1}` }));
  const caveats = [];
  reports.forEach((r) => {
    if (r.geoStatus === "different" && r.geoMessage) caveats.push(r.geoMessage);
    if (r.facts.sample && r.facts.sample.small) caveats.push("The report has a small sample of closed sales: describe it as a snapshot, not a trend.");
    if (r.facts.period && r.facts.period.weekly) caveats.push("The report covers one week: describe the week and its changes, never a trend.");
    if (r.facts.period && r.facts.period.partial) caveats.push(`The report covers only part of the period (${r.facts.period.label}): never describe it as a completed ${r.facts.period.kind === "year" ? "year" : "period"}, and never compare its counts with a full prior period.`);
  });
  const usable = obs.length >= 2;
  return { version: VERSION, usable, reports: view, character: usable ? characterOf(obs) : null, observations: obs, contrasts, interpretations, caveats: [...new Set(caveats)] };
}

/** Rules every editorial prompt (Option 1 and Option 2) gives the model about periods, comparisons and interpretation. Prompt text only; nothing here is validated by code. */
const COMPARISON_RULES = [
  "PERIODS AND COMPARISONS",
  "- Every evidence line states what the change is measured against (for example \"from September 2026\"). Use exactly that comparison. A change from the prior month is a month-over-month change: never call it year over year, \"last year\", \"a year ago\" or \"last season\" unless an evidence line says so.",
  "- Never describe a measure that rose or fell as unchanged, steady or flat. A small move is \"edged lower\" or \"edged higher\", as the evidence reads; \"held steady\" only when the evidence says it did not change.",
  "- Do not introduce a historical comparison, season, earlier period or trend that the supplied report does not contain (no \"last spring\", \"recent months\", \"a faster market\" as if measured). If the report has no earlier period for a measure, do not compare it.",
  "- Keep two voices apart. REPORTED STATISTICS are the evidence lines, stated as written. PROFESSIONAL INTERPRETATION is what an experienced local Realtor would reasonably make of them: pricing strategy, competitive positioning, carrying costs, buyer behavior, negotiation room, preparation, timing. Interpretation is welcome, is phrased as a reading (\"this can mean\", \"a Realtor would weigh\"), and never carries a number that is not in the evidence.",
].join("\n");

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

module.exports = { COMPARISON_RULES, VERSION, CHARACTERS, MAX_OBSERVATIONS, analyze, promptBlock, editorialInput, changeOf, dirOf, balanceOf };
