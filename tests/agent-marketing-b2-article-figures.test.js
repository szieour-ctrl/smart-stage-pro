"use strict";
// Nov 12, 2026: the editorial prompt says how an article's figure may appear in a question or angle (period, source, not current, not
// a measured transition against a differently calculated report figure). Prompt wording only; no number checking is added.
const test = require("node:test");
const assert = require("node:assert/strict");
const b2 = require("../netlify/functions/lib/agent-marketing-b2-lib");

const WITH_REPORT = b2.systemPrompt("article_report", true);
const NO_TREND = b2.systemPrompt("article_report", false);
const NO_REPORT = b2.systemPrompt("article_editorial", false);

test("every mode carries the article-figure period, source and not-current rules", () => {
  for (const p of [WITH_REPORT, NO_TREND, NO_REPORT]) {
    assert.match(p, /ARTICLE FIGURES IN A QUESTION OR ANGLE/);
    assert.match(p, /carry that article's reporting period with it/);
    assert.match(p, /name the source where leaving it out would be ambiguous/);
    assert.match(p, /Never write an article's figure as if it were the current state of the market/);
    assert.match(p, /do not imply a period/);
  }
});

test("report modes distinguish periods and methods and refuse an unmeasured transition", () => {
  for (const p of [WITH_REPORT, NO_TREND]) {
    assert.match(p, /cover different periods, or are measured differently/);
    assert.match(p, /two readings, each with its own period and source, not as one series/);
    assert.match(p, /Do not claim a measured change, crossing, shift or transition/);
    assert.match(p, /unless both are for the same measure and the report's own comparison states the change/);
  }
});

test("the article-only mode gets no report-comparison wording", () => {
  assert.ok(!/report's|agent's report figure|two readings/.test(b2.articleFigureRules(false).join("\n")));
  assert.equal(b2.articleFigureRules(true).length, b2.articleFigureRules(false).length + 2);
});

test("the correction leaves the workflow, candidate count and existing rules in place", () => {
  assert.equal(b2.MAX_CANDIDATES, 10);
  assert.equal(b2.SELECT, 5);
  assert.match(WITH_REPORT, /Explore 10 meaningfully different editorial perspectives/);
  assert.match(WITH_REPORT, /LOCAL MARKET PERFORMANCE STATISTICS .* come ONLY from the agent's report/s);
  assert.match(WITH_REPORT, /PERIODS AND COMPARISONS/);
  assert.match(WITH_REPORT, /Ground every candidate in ONE article/);
  assert.match(NO_REPORT, /keeping their place, period and qualifiers/);
});

test("it is wording only: no number-matching check was added to validate or the module", () => {
  const src = require("node:fs").readFileSync(require.resolve("../netlify/functions/lib/agent-marketing-b2-lib.js"), "utf8");
  const fn = src.slice(src.indexOf("function articleFigureRules"), src.indexOf("function systemPrompt"));
  assert.ok(!/numbersOf|\.test\(|match\(|new RegExp/.test(fn), "articleFigureRules only builds prompt text");
});
