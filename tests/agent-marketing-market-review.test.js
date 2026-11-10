// Phase 1 of the format-independent Market Review reader: all five Domus Market Review layouts, the comparison / period / geography contract,
// and the coverage report. Synthetic fixtures only (made-up numbers); the licensed real exports are checked locally by scripts/read-market-review.js.
const test = require("node:test");
const assert = require("node:assert");
const lib = require("../netlify/functions/lib/agent-marketing-report-lib");
const mr = require("../netlify/functions/lib/agent-marketing-market-review-lib");
const fx = require("./helpers/market-review-fixture");

const read = (f, scope) => mr.readMarketReview(f.pages, { items: f.items, scope });
const facts = (f, scope) => { const r = read(f, scope); assert.ok(r && r.facts, JSON.stringify(r)); return r.facts; };
const get = (f, k) => f.figures.find((x) => x.key === k);
const printed = (fig) => fig.comparisons.map((c) => c.printed);
const scopeOf = (sel) => { const r = mr.confirmScope(sel); assert.ok(r.ok, JSON.stringify(r)); return r.confirmed; };
const ROSEVILLE = scopeOf({ type: "city", names: ["Roseville"] });
const SF = mr.confirmPropertyTypes(["Single Family Homes"]).confirmed;
// a fully attested read (area + property types), the only kind Trend Intelligence accepts
const attested = (f, scope, dataThrough) => mr.readMarketReview(f.pages, { items: f.items, scope: scope || ROSEVILLE, propertyTypes: SF, dataThrough }).facts;

// ── 1. Every printed figure, with its exact printed comparison labels ───────────────────────────────────────────────────
test("weekly: 8 figures, weeks of supply, comparisons keep the printed week-ending labels", () => {
  const f = facts(fx.weekly());
  assert.strictEqual(f.layout, "market_review");
  assert.strictEqual(f.figures.length, 8);
  assert.deepStrictEqual(f.figures.map((x) => x.value), [512000, 30, 25, 101.6, 310, 41, 420, 12.5]);
  assert.ok(get(f, "weeks_supply") && !get(f, "months_supply"));
  assert.deepStrictEqual(printed(get(f, "median_dom")), ["vs Wk ending 8 Aug 2026", "vs Wk ending 31 Oct 2026"]);
  assert.deepStrictEqual(get(f, "median_dom").comparisons.map((c) => c.pct), [88, -51]);
  assert.deepStrictEqual({ kind: f.period.kind, start: f.period.start, end: f.period.end }, { kind: "week", start: "2026-11-01", end: "2026-11-07" });
  assert.deepStrictEqual(f.period.comparisons.map((c) => c.kind), ["earlier_period", "prior_period"]);   // 13 weeks earlier is NOT a year ago
});

test("monthly: 8 figures including active inventory and months supply; October 2025 is the year-ago month, September 2026 the prior month", () => {
  const f = facts(fx.monthly());
  assert.strictEqual(f.figures.length, 8);
  assert.strictEqual(get(f, "months_supply").value, 3.1);
  assert.strictEqual(get(f, "count_active").value, 410);
  assert.deepStrictEqual(printed(get(f, "count_closed")), ["vs October 2025", "vs September 2026"]);
  assert.deepStrictEqual(f.period.comparisons.map((c) => c.kind), ["same_period_last_year", "prior_period"]);
  assert.deepStrictEqual({ start: f.period.start, end: f.period.end, label: f.period.label }, { start: "2026-10-01", end: "2026-10-31", label: "October 2026" });
});

test("quarterly: 6 figures; Q3 2023 is never read as year over year", () => {
  const f = facts(fx.quarterly());
  assert.strictEqual(f.figures.length, 6);
  assert.deepStrictEqual(printed(get(f, "median_close_price")), ["vs Q3 2023", "vs Q2 2026"]);
  assert.deepStrictEqual(f.period.comparisons.map((c) => c.kind), ["earlier_period", "prior_period"]);
  assert.ok(!JSON.stringify(f).includes("same_period_last_year"));
  assert.ok(!JSON.stringify(f.figures.map((x) => x.changes)).match(/year/i), "no change is described as a year-over-year comparison");
  assert.deepStrictEqual({ start: f.period.start, end: f.period.end }, { start: "2026-07-01", end: "2026-09-30" });
});

test("year to date: one comparison works; the earlier-year value is read and agrees with the printed change", () => {
  const f = facts(fx.ytd());
  assert.strictEqual(f.figures.length, 6);
  const c = get(f, "count_closed");
  assert.strictEqual(c.comparisons.length, 1);
  assert.deepStrictEqual({ printed: c.comparisons[0].printed, pct: c.comparisons[0].pct, earlier: c.comparisons[0].earlierValue }, { printed: "vs YTD 2025", pct: 0.6, earlier: 1790 });
  assert.ok(f.figures.every((x) => x.verification.length === 1 && x.verification[0].ok), JSON.stringify(f.figures.map((x) => x.verification)));
  assert.strictEqual(f.period.comparisons[0].kind, "same_period_last_year");
  assert.strictEqual(f.period.end, "2026-10-31");
});

test("yearly 2026: flagged partial, values equal the year-to-date report, and the full-prior-year comparison is not read as a full-year decline", () => {
  const y = facts(fx.yearly()), t = facts(fx.ytd());
  assert.strictEqual(y.period.kind, "year");
  assert.strictEqual(y.period.partial, true);
  assert.strictEqual(y.period.end, null, "December 31 is never claimed for a year in progress");
  assert.strictEqual(y.period.label, "2026 \u2014 Partial Year", "the update date is not proof of the last day covered");
  assert.deepStrictEqual(y.period.coverage, { through: null, provenance: null, independentlyVerified: false, updated: "2026-11-09" }, "the update date is not a coverage date");
  assert.ok(y.confirmation.needed.includes("dataThrough"));
  assert.deepStrictEqual(y.period.comparisons.map((c) => c.kind), ["earlier_period", "full_prior_year"]);
  assert.ok(y.warnings.some((w) => /only part of the year/.test(w) && /not a full-year decline/.test(w)));
  assert.deepStrictEqual(mr.crossCheckPeriods(y, t), { relation: "yearly_equals_year_to_date", yearlyIsPartial: true, valuesCoverThrough: "2026-10-31" });
  assert.strictEqual(lib.attributionNotice(y), null, "no end date is invented for the MetroList notice");
});

test("coverage date hierarchy: subscriber-attested date labels the period but is never called verified; an impossible date is refused", () => {
  const f = fx.yearly();
  const ok = mr.readMarketReview(f.pages, { items: f.items, dataThrough: "2026-11-09" }).facts;
  assert.strictEqual(ok.period.label, "2026 Year to Date (through November 9, 2026)");
  assert.deepStrictEqual([ok.period.coverage.through, ok.period.coverage.provenance, ok.period.coverage.independentlyVerified], ["2026-11-09", "subscriber_attested", false]);
  assert.strictEqual(ok.period.end, null, "the report's own end date is still not invented");
  assert.strictEqual(ok.period.disclosureEnd, "2026-11-09");
  const bad = mr.readMarketReview(f.pages, { items: f.items, dataThrough: "2026-12-30" });
  assert.strictEqual(bad.error, "bad_data_through");
  assert.strictEqual(bad.facts.period.label, "2026 \u2014 Partial Year");
  assert.strictEqual(bad.facts.period.coverage.through, null);
  const wrongYear = mr.readMarketReview(f.pages, { items: f.items, dataThrough: "2025-10-31" });
  assert.strictEqual(wrongYear.error, "bad_data_through");
});

test("a yearly report updated after the year ended is complete", () => {
  const f = fx.yearly({ updated: "01/05/27" });
  const y = facts(f);
  assert.strictEqual(y.period.partial, false);
  assert.strictEqual(y.period.end, "2026-12-31");
});

// ── 2. Values, percents, units ─────────────────────────────────────────────────────────────────────────────────────────
test("List price received: the value and its changes are percents as printed, never recomputed or turned into points", () => {
  const m = get(facts(fx.monthly()), "avg_close_to_list_pct");
  assert.strictEqual(m.value, 99.2);
  assert.deepStrictEqual(m.comparisons.map((c) => c.pct), [-0.1, 0.2]);
  const t = get(facts(fx.ytd()), "avg_close_to_list_pct");       // both the 2025 value (99.5%) and the change (-0.1%) end in a percent sign
  assert.strictEqual(t.value, 99.4);
  assert.strictEqual(t.comparisons[0].earlierValue, 99.5);
  assert.strictEqual(t.comparisons[0].pct, -0.1);
});

test("a printed change that disagrees with the two values beside it is left out and reported", () => {
  const f = fx.ytd();
  f.items.find((i) => i.s === "0.6%").s = "9.9%";
  const r = facts(f);
  const c = get(r, "count_closed");
  assert.strictEqual(c.comparisons[0].unverified, true);
  assert.strictEqual(c.changes, undefined);
  assert.strictEqual(c.value, 1800, "the figure itself is kept");
  assert.ok(r.warnings.some((w) => /did not agree/.test(w)));
});

// ── 3. Not printed vs unread ───────────────────────────────────────────────────────────────────────────────────────────
test("quarterly, year to date and yearly mark active inventory and months supply as NOT PRINTED, not missing", () => {
  [fx.quarterly(), fx.ytd(), fx.yearly()].forEach((f) => {
    const c = facts(f).coverage;
    assert.ok(c.notPrinted.includes("count_active") && c.notPrinted.includes("months_supply"));
    assert.deepStrictEqual(c.unread, []);
  });
  const m = facts(fx.monthly()).coverage;
  assert.deepStrictEqual(m.notPrinted, [], "a monthly report prints months of supply, not weeks; nothing it should print is missing");
});

test("a measure that should be printed but cannot be read is reported as unread, with a coverage message", () => {
  const f = fx.monthly();
  f.items = f.items.filter((i) => i.s !== "$301");           // the value of Median Sold $/SqFt
  const r = facts(f);
  assert.ok(!get(r, "median_ppsf"));
  assert.deepStrictEqual(r.coverage.unread.map((u) => u.key), ["median_ppsf"]);
  assert.ok(r.warnings.some((w) => /couldn't read 1 measure: Median sold price per square foot/.test(w)));
  assert.strictEqual(r.figures.length, 7);
});

test("a figure outside its expected form is rejected, never guessed", () => {
  const f = fx.monthly();
  f.items.find((i) => i.s === "$498,500").s = "498,500";       // a price without its dollar sign
  const r = facts(f);
  assert.ok(!get(r, "median_close_price"));
  assert.strictEqual(r.coverage.unread.find((u) => u.key === "median_close_price").reason, "value_outside_expected_form_or_range");
});

test("too few readable figures is an error, and a non-review dashboard is not claimed", () => {
  const f = fx.monthly();
  f.items = f.items.filter((i) => !/^\$|^\d/.test(i.s) || i.y < 140);
  assert.deepStrictEqual(read(f), { error: "no_figures" });
  assert.strictEqual(mr.readMarketReview(["some other report text ".repeat(20)], { items: [] }), null);
});

// ── 4. Period is established from the report ───────────────────────────────────────────────────────────────────────────
test("the report type comes from the printed comparison labels, so a different title wording does not change the reading", () => {
  const f = fx.quarterly({ title: "Market Review: Q3 2026" });
  assert.strictEqual(facts(f).period.kind, "quarter");
  const g = fx.monthly({ title: "Oct 2026 Market Review" });
  assert.strictEqual(facts(g).period.label, "October 2026");
});

test("a title that contradicts the comparison labels is an error, not a guess", () => {
  const r = read(fx.quarterly({ title: "Weekly Review 07 Nov 2026" }));
  assert.strictEqual(r.error, "period_conflict");
});

test("attribution: week, month and quarter give the MetroList notice with the actual reporting period", () => {
  assert.strictEqual(lib.attributionNotice(facts(fx.monthly())), "Based on information from MetroList Services, Inc. for the period Oct 1, 2026 through Oct 31, 2026.");
  assert.strictEqual(lib.attributionNotice(facts(fx.quarterly())), "Based on information from MetroList Services, Inc. for the period Jul 1, 2026 through Sep 30, 2026.");
  assert.strictEqual(lib.attributionNotice(facts(fx.weekly())), "Based on information from MetroList Services, Inc. for the period Nov 1, 2026 through Nov 7, 2026.");
  assert.strictEqual(lib.attributionNotice(facts(fx.ytd())), "Based on information from MetroList Services, Inc. for the period Jan 1, 2026 through Oct 31, 2026.");
});

// ── 5. Geography: displayed vs confirmed ───────────────────────────────────────────────────────────────────────────────
test("the header 'all Counties' is stored verbatim as DISPLAYED geography and never becomes the geography; a confirmed scope survives all five uploads", () => {
  ["weekly", "monthly", "quarterly", "ytd", "yearly"].forEach((k) => {
    const f = facts(fx[k](), ROSEVILLE);
    assert.strictEqual(f.geography.displayed.raw, "Includes all Property Types in all Counties");
    assert.strictEqual(f.geography.displayed.kind, "all_counties");
    assert.strictEqual(f.geography.displayed.unreliable, true);
    assert.deepStrictEqual(f.geography.cities, ["Roseville"]);
    assert.strictEqual(f.geography.source, "subscriber");
    assert.strictEqual(f.geography.confirmed.attestedBySubscriber, true);
    assert.strictEqual(f.geography.status, "ok");
    assert.ok(!JSON.stringify(f.geography.cities).includes("All MetroList"));
  });
});

test("with no confirmed scope the geography stays empty and ONE concise confirmation is raised; the data is still read", () => {
  const f = facts(fx.monthly());
  assert.deepStrictEqual([f.geography.cities, f.geography.zips, f.geography.counties], [[], [], []]);
  assert.strictEqual(f.geography.status, "needs_scope");
  assert.strictEqual(f.figures.length, 8);
  assert.deepStrictEqual(f.confirmation.needed, ["geography", "propertyTypes"]);
  assert.strictEqual(f.warnings.filter((w) => /confirm the area and the property types/.test(w)).length, 1);
  const g = facts(fx.monthly(), undefined);
  assert.strictEqual(g.warnings.filter((w) => /\?|confirm/.test(w)).length, 1, "a single question, not one per gap");
  const only = mr.readMarketReview(fx.monthly().pages, { items: fx.monthly().items, scope: ROSEVILLE }).facts;
  assert.deepStrictEqual(only.confirmation.needed, ["propertyTypes"]);
  assert.match(only.confirmation.question, /Which property types/);
});

// ── Review corrections (Nov 10) ────────────────────────────────────────────────────────────────────────────────────────
test("token pairing: an invalid nearby candidate does not consume the label or the valid token", () => {
  const f = fx.monthly();
  // A stray token nearer to "Closed Sales" than its real value, in the wrong form for a count (a decimal) and another out of range.
  const lab = f.items.find((i) => i.s === "Closed Sales");
  f.items.push({ s: "7.5", x: lab.x, y: lab.y + 8 }, { s: "999999999", x: lab.x + 5, y: lab.y + 12 });
  const r = facts(f, ROSEVILLE);
  assert.strictEqual(get(r, "count_closed").value, 150, "the valid token is still found");
  assert.deepStrictEqual(r.coverage.unread, []);
  // and the stray tokens did not displace any other tile's value
  assert.deepStrictEqual(r.figures.map((x) => x.value), [498500, 150, 29, 99.2, 301, 220, 410, 3.1]);
});

test("token pairing: an invalid token nearest a label cannot steal the label's only other candidate (the footer year is never a figure)", () => {
  const f = fx.quarterly();
  f.items = f.items.filter((i) => !["Inventory only applies for monthly and weekly calculations.", "MSI only applies for monthly and weekly calculations."].includes(i.s));
  const r = facts(f, ROSEVILLE);
  assert.ok(!get(r, "count_active") && !get(r, "months_supply"), "the footer's 2026 is not read as Active Inventory");
  assert.ok(r.coverage.unread.some((u) => u.key === "count_active"), "without the note, a missing value is reported unread, not guessed");
});

test("a measure the report marks 'only applies for monthly and weekly' is NOT PRINTED, with the report's own words kept", () => {
  const c = facts(fx.quarterly()).coverage;
  assert.deepStrictEqual(c.notPrinted, ["count_active", "months_supply"]);
  assert.strictEqual(c.notPrintedNotes.count_active, "Inventory only applies for monthly and weekly calculations.");
  assert.deepStrictEqual(c.unread, []);
});

test("year to date: each earlier value is the one beside the other year's tag, not the current value", () => {
  const f = facts(fx.ytd());
  assert.deepStrictEqual(f.figures.map((x) => [x.value, x.comparisons[0].earlierValue]), [[510000, 510000], [1800, 1790], [20, 19], [99.4, 99.5], [308, 309], [2500, 2600]]);
  assert.ok(f.figures.every((x) => !x.comparisons[0].unverified));
});

test("the quarter is read from the split header ('Q3' + 'Sep 2026'); a quarter and month that disagree are an error", () => {
  assert.strictEqual(facts(fx.quarterly()).period.label, "Q3 2026");
  const bad = fx.quarterly({ title: ["Market Review", "Q3", "Oct 2026"] });
  assert.strictEqual(read(bad).error, "period_conflict");
});

test("property type: the header value is shown as printed and a subscriber confirmation is requested; a confirmed list is an attestation", () => {
  const f = facts(fx.monthly(), ROSEVILLE);
  assert.deepStrictEqual([f.propertyTypeScope.displayed, f.propertyTypeScope.status, f.propertyTypeScope.reason], ["All Property Types", "needs_confirmation", "header_says_all_types_on_every_export"]);
  const pt = mr.confirmPropertyTypes(["Single Family Homes"]);
  const g = mr.readMarketReview(fx.monthly().pages, { items: fx.monthly().items, scope: ROSEVILLE, propertyTypes: pt.confirmed }).facts;
  assert.deepStrictEqual([g.propertyTypeScope.status, g.propertyTypeScope.confirmed.attestedBySubscriber, g.propertyTypeScope.displayed], ["ok", true, "All Property Types"]);
  assert.deepStrictEqual(g.confirmation.needed, []);
  assert.strictEqual(g.warnings.filter((w) => /confirm|\?/.test(w)).length, 0);
  assert.strictEqual(mr.confirmPropertyTypes([]).ok, false);
  const h = mr.readMarketReview(fx.monthly({ scopeLine: "Includes Condo in all Counties" }).pages, { items: fx.monthly({ scopeLine: "Includes Condo in all Counties" }).items, scope: ROSEVILLE, propertyTypes: pt.confirmed }).facts;
  assert.strictEqual(h.propertyTypeScope.status, "conflict");
});

test("Trend Intelligence and every consumer drop a change marked likeWithLike:false, whoever produced it", () => {
  const rr = require("../netlify/functions/lib/agent-marketing-research-report-lib");
  const ti = require("../netlify/functions/lib/agent-marketing-trend-intelligence-lib");
  const f = JSON.parse(JSON.stringify(attested(fx.yearly(), null, "2026-10-31")));
  // put the ineligible change back where a producer might have left it
  const closed = get(f, "count_closed");
  closed.changes = [{ pct: -15.4, vs: "Yr ending 2025", printed: "vs Yr ending 2025", kind: "full_prior_year", likeWithLike: false }];
  get(f, "count_new").changes = [{ pct: -14.1, vs: "Yr ending 2025", printed: "vs Yr ending 2025", kind: "full_prior_year", likeWithLike: false }];
  assert.deepStrictEqual(lib.eligibleChanges(closed), []);
  assert.strictEqual(lib.compareText(f, closed), "");
  const ctx = rr.buildContext([{ id: "u1", facts: f }], { geography: { type: "city", name: "Roseville", label: "Roseville" } });
  const a = ti.analyze(ctx);
  assert.ok(!/15\.4|14\.1/.test(JSON.stringify(a)));
  assert.ok(a.caveats.some((c) => /only part of the period/.test(c) && /never describe it as a completed year/.test(c)), JSON.stringify(a.caveats));
  assert.match(rr.userMessage(ctx, 3, "2026-11-10"), /only part of the period \(2026 Year to Date \(through October 31, 2026\)\)/);
  assert.ok(!/15\.4|14\.1/.test(rr.userMessage(ctx, 3, "2026-11-10")), "the model prompt never carries the full-year comparison of a count");
});

test("Trend Intelligence reads comparison kinds: the prior-period change leads for a complete report, and nothing is described as year over year for Q3 2023", () => {
  const rr = require("../netlify/functions/lib/agent-marketing-research-report-lib");
  const ti = require("../netlify/functions/lib/agent-marketing-trend-intelligence-lib");
  const f = attested(fx.quarterly());
  const a = ti.analyze(rr.buildContext([{ id: "u1", facts: f }], { geography: { type: "city", name: "Roseville", label: "Roseville" } }));
  assert.ok(a.observations.length >= 3);
  assert.ok(a.observations.every((o) => o.basis.label === "Q2 2026"));
});

test("the four selection types, and missing details produce one question rather than a rejection", () => {
  assert.deepStrictEqual(mr.confirmScope({ type: "city", names: ["Roseville"] }).confirmed, { type: "city", names: ["Roseville"], attestedBySubscriber: true, areasIncluded: "Roseville" });
  const multi = mr.confirmScope({ type: "cities", names: ["Roseville", "Rocklin", "Lincoln"] }).confirmed;   // may span counties
  assert.strictEqual(multi.areasIncluded, "Roseville, Rocklin, and Lincoln");
  assert.deepStrictEqual(mr.confirmScope({ type: "county", names: ["Placer"] }).confirmed.names, ["Placer County"]);
  assert.deepStrictEqual(mr.confirmScope({ type: "zips", names: ["95747", "95661"] }).confirmed.names, ["95747", "95661"]);
  ["city", "cities", "county", "zips", "custom", undefined].forEach((type) => {
    const r = mr.confirmScope({ type, names: [] });
    assert.strictEqual(r.ok, false);
    assert.strictEqual(typeof r.question, "string");
    assert.strictEqual((r.question.match(/\?/g) || []).length, 1, "one concise question");
  });
  assert.strictEqual(mr.confirmScope({ type: "cities", names: ["Roseville"] }).ok, false, "one name is not several cities");
  assert.strictEqual(mr.confirmScope({ type: "zips", names: ["957"] }).ok, false);
});

test("multiple cities: the statistics are marked as the combined selected market", () => {
  const f = facts(fx.monthly(), scopeOf({ type: "cities", names: ["Roseville", "Rocklin", "Lincoln"] }));
  assert.strictEqual(f.geography.combined, true);
  assert.deepStrictEqual(f.geography.cities, ["Roseville", "Rocklin", "Lincoln"]);
  assert.strictEqual(facts(fx.monthly(), ROSEVILLE).geography.combined, false);
});

test("a header such as '4 cities' is never expanded into names; a county beside selected cities only locates them", () => {
  const four = facts(fx.monthly({ scopeLine: "Includes all Property Types in 4 cities" }), scopeOf({ type: "cities", names: ["Roseville", "Rocklin", "Lincoln", "Loomis"] }));
  assert.strictEqual(four.geography.displayed.kind, "count");
  assert.strictEqual(four.geography.displayed.count, 4);
  assert.deepStrictEqual(four.geography.displayed.places, []);
  assert.strictEqual(four.geography.status, "ok");
  const placer = facts(fx.monthly({ scopeLine: "Includes all Property Types in Placer County" }), ROSEVILLE);
  assert.strictEqual(placer.geography.status, "ok", "Placer for a Roseville selection is not a mismatch");
  assert.deepStrictEqual(placer.geography.conflicts, []);
});

test("a header that explicitly names a DIFFERENT city raises a conflict; the count in '4 cities' must match the selection", () => {
  const other = facts(fx.monthly({ scopeLine: "Includes all Property Types in Folsom" }), ROSEVILLE);
  assert.strictEqual(other.geography.status, "conflict");
  assert.strictEqual(other.geography.conflicts[0].header, "Folsom");
  assert.ok(other.warnings.some((w) => /Folsom/.test(w)));
  const same = facts(fx.monthly({ scopeLine: "Includes all Property Types in Roseville" }), ROSEVILLE);
  assert.strictEqual(same.geography.status, "ok");
  const count = facts(fx.monthly({ scopeLine: "Includes all Property Types in 4 cities" }), scopeOf({ type: "cities", names: ["Roseville", "Rocklin"] }));
  assert.strictEqual(count.geography.status, "conflict");
  const county = facts(fx.monthly({ scopeLine: "Includes all Property Types in El Dorado County" }), scopeOf({ type: "county", names: ["Placer"] }));
  assert.strictEqual(county.geography.status, "conflict");
});

test("the header's property types are stored as displayed, not as a confirmed attestation", () => {
  const f = facts(fx.monthly({ scopeLine: "Includes Single Family Homes in all Counties" }), ROSEVILLE);
  assert.deepStrictEqual(f.propertyTypes, ["Single Family Homes"]);
  assert.strictEqual(f.propertyTypesSource, "report_header");
});

// ── 6. Wiring, read-back and nothing else changed ──────────────────────────────────────────────────────────────────────
test("analyzePages reads a Market Review only when asked; the default path is unchanged", () => {
  const f = fx.weekly();
  const off = lib.analyzePages(f.pages, { items: f.items });
  assert.strictEqual(off.facts.layout, "weekly_snapshot");
  const on = lib.analyzePages(f.pages, { items: f.items, marketReview: true, scope: ROSEVILLE });
  assert.strictEqual(on.facts.layout, "market_review");
  assert.deepStrictEqual(on.facts.geography.cities, ["Roseville"]);
});

test("the read-back shows period, exact comparison labels, what was read, not printed, unread, and displayed beside confirmed geography", () => {
  const rb = mr.readBack(facts(fx.quarterly(), ROSEVILLE));
  const by = (k) => rb.find((l) => l.kind === k);
  assert.strictEqual(by("period").text, "Q3 2026");
  assert.deepStrictEqual(by("comparisons").items.map((c) => c.printed), ["vs Q3 2023", "vs Q2 2026"]);
  assert.ok(by("not_printed").keys.includes("count_active"));
  assert.deepStrictEqual(by("unread").items, []);
  assert.deepStrictEqual({ d: by("geography").displayed, c: by("geography").confirmed, a: by("geography").attested }, { d: "Includes all Property Types in all Counties", c: "Roseville", a: true });
});

test("the original positioned text and page text are not retained in the facts beyond each figure's own label and value tokens", () => {
  const f = facts(fx.monthly(), ROSEVILLE);
  const s = JSON.stringify(f);
  assert.ok(!s.includes("Domus Analytics") && !s.includes("Monthly Review"));
  assert.ok(f.figures.every((x) => Object.keys(x.source).sort().join() === "label,value"));
});

// ── 7. Downstream: Trend Intelligence must not turn a partial year into a full-year decline ─────────────────────────────
test("partial yearly: counts compared with the FULL prior year are kept as printed but not offered as changes, so Trend Intelligence cannot call them a decline", () => {
  const rr = require("../netlify/functions/lib/agent-marketing-research-report-lib");
  const ti = require("../netlify/functions/lib/agent-marketing-trend-intelligence-lib");
  const f = attested(fx.yearly(), null, "2026-10-31");
  const closed = get(f, "count_closed");
  assert.deepStrictEqual(closed.comparisons.map((c) => [c.printed, c.pct, c.likeWithLike]), [["vs Yr ending 2016", -35.1, true], ["vs Yr ending 2025", -15.4, false]]);
  assert.ok(!(closed.changes || []).some((c) => c.printed === "vs Yr ending 2025"));
  assert.ok(get(f, "median_close_price").changes.some((c) => c.printed === "vs Yr ending 2025"), "price levels are comparable with a full year");
  const a = ti.analyze(rr.buildContext([{ id: "u1", facts: f }], { geography: { type: "city", name: "Roseville", label: "Roseville" } }));
  assert.ok(a.usable);
  assert.ok(!/15\.4%/.test(JSON.stringify(a)), "the -15.4% closed-sales figure never reaches the observations");
});

test("year to date keeps its counts: same-period-last-year is like with like", () => {
  const c = get(facts(fx.ytd()), "count_closed");
  assert.deepStrictEqual(c.changes.map((x) => [x.printed, x.kind, x.pct]), [["vs YTD 2025", "same_period_last_year", 0.6]]);
});
