// The report period printed in MetroList's disclosure (Oct 27, 2026): a metrics PDF with no other dates still gets the MetroList notice.
const test = require("node:test");
const assert = require("node:assert");
const rl = require("../netlify/functions/lib/agent-marketing-report-lib");
const asm = require("../netlify/functions/lib/agent-marketing-assets-lib");

const DISCLOSURE = "All reports are published October 2026, based on data available at the end of September 2026, except for the today's stats. All reports presented are based on data supplied by the MetroList MLS. The MetroList MLS does not guarantee or is not in anyway responsible for its accuracy.";

test("disclosurePeriod reads the month named in the MetroList disclosure", () => {
  assert.deepStrictEqual(
    (({ start, end, label }) => ({ start, end, label }))(rl.disclosurePeriod(DISCLOSURE)),
    { start: "2026-09-01", end: "2026-09-30", label: "September 2026" });
  assert.strictEqual(rl.disclosurePeriod("based on data available at the end of February 2028").end, "2028-02-29");
  assert.strictEqual(rl.disclosurePeriod("no disclosure here"), null);
  assert.strictEqual(rl.disclosurePeriod("data available at the end of Smarch 2026"), null);
});

test("a metrics PDF whose only date is the disclosure gets a period and the MetroList notice", () => {
  const page = ["Antelope Market Overview", "Closed Sales 24", "Average Days on Market 31", "", DISCLOSURE, "Data supplied by MetroList"].join("\n");
  const r = rl.analyzePages([page.repeat(3)]);
  assert.ok(r.facts, JSON.stringify(r));
  assert.strictEqual(r.facts.layout, "labeled_metrics");
  assert.deepStrictEqual([r.facts.period.start, r.facts.period.end], ["2026-09-01", "2026-09-30"]);
  const notice = rl.attributionNotice(r.facts);
  assert.match(notice || "", /MetroList Services, Inc\. for the period Sep 1, 2026 through Sep 30, 2026\./);
  assert.deepStrictEqual(asm.parseNoticePeriod(notice), { start: "2026-09-01", end: "2026-09-30" }, "the Reel builder can read the period back");
});

test("a MetroList report with no readable dates warns at upload, not at the last step", () => {
  const w = rl.summarize({ mlsSource: "MetroList", figures: [], statuses: {}, geography: {}, sample: {} }).warnings.join(" ");
  assert.match(w, /couldn't find the dates/);
  const ok = rl.summarize({ mlsSource: "MetroList", period: { start: "2026-09-01", end: "2026-09-30" }, figures: [], statuses: {}, geography: {}, sample: {} }).warnings.join(" ");
  assert.doesNotMatch(ok, /couldn't find the dates/);
});
