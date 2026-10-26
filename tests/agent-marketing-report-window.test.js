// Run with: node --test tests/*.test.js
// The date window (Sam, Oct 25): a report with dated rows can be narrowed to the last 30/60/90 days or custom dates while it is read.
const test = require("node:test");
const assert = require("node:assert");
const lib = require("../netlify/functions/lib/agent-marketing-report-lib");
const fx = require("./helpers/cma-fixture");

const fig = (facts, status, key) => (facts.figures.find((f) => f.status === status && f.key === key) || {}).value;
const HEAD = ["Status", "Address", "City", "List Price", "Close Price", "DOM", "Close Date", "SqFt"];
const rows = () => [
  HEAD,
  ["Closed", "1 Secret Ln", "Roseville", "$600,000", "$610,000", "12", "08/01/2026", "2,000"],
  ["Closed", "2 Secret Ln", "Roseville", "$650,000", "$640,000", "20", "09/15/2026", "2,100"],
  ["Closed", "3 Secret Ln", "Roseville", "$700,000", "$700,000", "8", "10/10/2026", "2,300"],
  ["Closed", "4 Secret Ln", "Roseville", "$720,000", "$725,000", "5", "10/20/2026", "2,400"],
  ["Active", "5 Secret Ln", "Roseville", "$800,000", "", "3", "", "2,500"],
];

test("validateWindow: nothing or all means no window; presets and dates are checked", () => {
  for (const ok of [null, undefined, "", "all", {}]) assert.deepStrictEqual(lib.validateWindow(ok), { window: null });
  assert.deepStrictEqual(lib.validateWindow({ days: 30 }), { window: { days: 30 } });
  assert.deepStrictEqual(lib.validateWindow({ days: "90" }), { window: { days: 90 } });
  assert.deepStrictEqual(lib.validateWindow({ start: "2026-07-01", end: "2026-09-30" }), { window: { start: "2026-07-01", end: "2026-09-30" } });
  for (const bad of [{ days: 45 }, { start: "2026-10-01", end: "2026-09-01" }, { start: "x", end: "y" }, { start: "2026-07-01" }, { start: "2020-01-01", end: "2026-01-01" }, { start: "2026-02-30", end: "2026-03-01" }, "last month"]) {
    assert.ok(lib.validateWindow(bad).error, JSON.stringify(bad));
  }
});

test("rows: the window counts closed sales inside it, keeps active listings, ends at the newest dated row, and records what it did", () => {
  const all = lib.analyzeRows(rows(), "csv").facts;
  assert.strictEqual(all.statuses.closed.count, 4);
  assert.strictEqual(all.window, undefined);
  const w = lib.analyzeRows(rows(), "csv", { window: { days: 30 } }).facts; // ends Oct 20 (newest row): Sep 21 to Oct 20
  assert.strictEqual(w.statuses.closed.count, 2);
  assert.strictEqual(fig(w, "closed", "median_close_price"), undefined); // under ten sales: a count only
  const w60 = lib.analyzeRows(rows(), "csv", { window: { days: 60 } }).facts; // Aug 22 to Oct 20: three closed sales
  assert.strictEqual(w60.statuses.closed.count, 3);
  assert.strictEqual(fig(w60, "closed", "median_close_price"), undefined);
  assert.strictEqual(w.statuses.active.count, 1);
  assert.deepStrictEqual([w.window.start, w.window.end, w.window.closedInFile, w.window.closedInWindow], ["2026-09-21", "2026-10-20", 4, 2]);
  assert.match(lib.scopeSentence(w), /limited to the last 30 days, Sep 21, 2026 to Oct 20, 2026/);
  assert.ok(w.warnings.some((x) => /2 of the 4 closed sales in the file/.test(x)));
  const c = lib.analyzeRows(rows(), "csv", { window: { start: "2026-08-15", end: "2026-09-30" } }).facts;
  assert.strictEqual(c.statuses.closed.count, 1);
  assert.strictEqual(c.window.closedInWindow, 1);
});

test("rows: an empty window says so and uses small-sample wording; a window with no rows at all is an error", () => {
  const z = lib.analyzeRows(rows(), "csv", { window: { start: "2025-01-01", end: "2025-01-31" } }).facts;
  assert.strictEqual(z.statuses.closed, undefined);
  assert.ok(z.warnings.some((x) => /No closed sales fall in/.test(x)));
  const onlyClosed = rows().filter((r) => r[0] !== "Active");
  assert.strictEqual(lib.analyzeRows(onlyClosed, "csv", { window: { start: "2025-01-01", end: "2025-01-31" } }).error, "no_window_rows");
  assert.match(lib.errorMessage("no_window_rows"), /No listings in this file fall inside those dates/);
});

test("nothing identifying is kept when a window is used", () => {
  const w = lib.analyzeRows(rows(), "csv", { window: { days: 60 } }).facts;
  assert.ok(!/Secret|\bLn\b/.test(JSON.stringify(w)));
});

test("CMA pages: the window starts from the report's own as-of date; the whole file is still checked against the report's printed counts", () => {
  const f = fx.standard();
  const full = lib.analyzePages(f.pages).facts;
  const closedAll = full.statuses.closed.count;
  const w = lib.analyzePages(f.pages, { window: { days: 90 } }).facts;
  assert.ok(w.window && w.window.end === full.reportDate, "window ends on the report date");
  assert.ok(w.statuses.closed ? w.statuses.closed.count <= closedAll : true);
  assert.strictEqual(w.window.closedInFile, closedAll);
  assert.strictEqual(lib.summarize(w).window.label, w.window.label);
});

test("a thin window suggests the next longer one, counted from the same file and only when it has more", () => {
  const w30 = lib.analyzeRows(rows(), "csv", { window: { days: 30 } }).facts; // 2 closed; 60 days has 3, 90 has 4
  assert.deepStrictEqual(w30.window.suggest, { days: 90, closed: 4 });
  assert.ok(w30.warnings.some((x) => /Only 2 closed sales in that window\. The last 90 days has 4\./.test(x)));
  assert.ok(!w30.warnings.some((x) => /enough for statistics/.test(x)));
  const many = [HEAD, ...Array.from({ length: 12 }, (_, i) => ["Closed", `${i} Secret Ln`, "Roseville", "$600,000", "$610,000", "10", `${i < 3 ? "10" : "08"}/${String(10 + i).padStart(2, "0")}/2026`, "2,000"])];
  const t = lib.analyzeRows(many, "csv", { window: { days: 30 } }).facts;
  assert.strictEqual(t.window.suggest.closed >= 10, true);
  assert.ok(t.warnings.some((x) => /enough for statistics/.test(x)));
  assert.strictEqual(lib.analyzeRows(rows(), "csv").facts.window, undefined, "no window, no suggestion");
  const ninety = lib.analyzeRows(rows(), "csv", { window: { days: 90 } }).facts;
  assert.strictEqual(ninety.window.suggest, null, "nothing longer to offer");
  assert.ok(!ninety.warnings.some((x) => /The last \d+ days has/.test(x)));
});
