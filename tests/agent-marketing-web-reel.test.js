"use strict";
const test = require("node:test");
const assert = require("node:assert");
const fx = require("./fixtures/natomas-approved.json");
const lib = require("../netlify/functions/lib/agent-marketing-assets-lib");
const src = require("../netlify/functions/lib/agent-marketing-sources-lib");
const manifestLib = require("../netlify/functions/lib/agent-marketing-manifest-lib");
const timing = require("../netlify/functions/lib/agent-marketing-timing-lib");

const topic = {
  id: "t1", origin: "web", kind: "market_update", question: "What is happening in Natomas 95834?", whyItMatters: "Sellers face new construction.",
  trendSignals: ["Median days on market is 41, 4 days longer year over year", "Homes that sold went for 99.4% of list price", "6 of 14 active listings took a price reduction"],
  scope: "broader_context", scopeNote: "Figures cover ZIP 95834, not all of Natomas.",
  sources: [{ title: "Redfin 95834 Housing Market", url: "https://www.redfin.com/zipcode/95834/housing-market", published: "2026-10-20" }, { title: "Second source", url: "https://example.org/a", published: "2026-10-22" }],
};
const words = timing.captionWords(fx.narrative.narrationTagged).map((t, i) => ({ text: t, start: 0.3 + i * 0.36, end: 0.3 + i * 0.36 + 0.3 }));
const duration = words[words.length - 1].end + 0.5;
const keys = (s) => ({ "9x16": `i${s}_9`, "16x9": `i${s}_16` });
const input = (over) => ({ projectId: "p1", formats: ["9x16"], narrative: fx.narrative, intake: fx.intake, reportFigures: [], webTopic: topic, brand: { agent: { name: "Sam Zieour", brokerage: "SZ" }, headshot_key: "hs" },
  narrationTagged: fx.narrative.narrationTagged, audio: { narration_key: "n", duration_sec: duration, words }, imageKeys: { 0: keys(0), 1: keys(1), 2: keys(2), 4: keys(4) }, ...over });

test("the source line is built from the checked sources and keeps the scope note whole", () => {
  assert.strictEqual(src.sourceLine(topic.sources, topic.scopeNote), "Source: Redfin 95834 Housing Market (redfin.com, Oct 20, 2026) + 1 more. Figures cover ZIP 95834, not all of Natomas.");
  assert.strictEqual(src.sourceLine([], ""), "");
  assert.strictEqual(src.sourceLine([{ title: "x", url: "http://insecure.com/a", published: "2026-10-20" }], ""), "", "https only");
  assert.strictEqual(src.sourceLine([{ title: "x", url: "https://a.com/a" }], ""), "", "dated only");
  const long = src.sourceLine([{ title: "A very long headline ".repeat(20), url: "https://a.com/a", published: "2026-10-20" }], "Figures cover ZIP 95834, not all of Natomas.");
  assert.ok(long.length <= src.MAX_LINE && long.endsWith("not all of Natomas."), long);
  assert.strictEqual(src.sourceLabel(topic.sources), "redfin.com · example.org");
});

test("a web-research project builds a valid manifest: no MetroList notice, a source line, text cards only", () => {
  const r = lib.buildManifest(input());
  assert.ok(r.manifest, JSON.stringify(r.validation));
  assert.deepStrictEqual(r.validation.errors, [], JSON.stringify(r.validation.errors));
  const m = r.manifest;
  assert.strictEqual(m.notice_required, false);
  assert.strictEqual(m.notice.period, undefined);
  assert.strictEqual(m.source_line.text, src.sourceLine(topic.sources, topic.scopeNote));
  assert.ok(!/MetroList/i.test(JSON.stringify(m.source_line)));
  assert.deepStrictEqual(m.scenes.map((s) => s.composition), ["opening_headline_focus", "expert_takeaway", "expert_takeaway", "expert_takeaway", "closing_headline_focus"]);
  assert.deepStrictEqual(m.figures, []);
});

test("a typed or missing source line, or a number the research did not record, stops the Reel", () => {
  const m = lib.buildManifest(input()).manifest;
  const typed = JSON.parse(JSON.stringify(m)); typed.source_line.text = "Source: trust me.";
  assert.ok(manifestLib.validateManifest(typed).errors.some((e) => e.code === "source_line"));
  const none = JSON.parse(JSON.stringify(m)); none.source_line.sources = []; none.source_line.text = "";
  assert.ok(manifestLib.validateManifest(none).errors.some((e) => e.code === "source_line"));
  const wrongNums = lib.buildManifest(input({ webTopic: { ...topic, trendSignals: ["Prices rose in Natomas"] } }));
  assert.ok(wrongNums.validation.errors.some((e) => e.code === "number"), "numbers on screen must trace to the research");
});

test("a report Reel is unchanged: MetroList notice, report figures", () => {
  const r = lib.buildManifest({ ...input(), webTopic: undefined, reportFigures: fx.reportFigures, notice: { period: lib.parseNoticePeriod(fx.narrative.notice) } });
  assert.notStrictEqual(r.manifest.notice_required, false);
  assert.match(r.manifest.notice.text, /MetroList Services, Inc\./);
  assert.strictEqual(r.manifest.source_line, undefined);
});

test("a long scope note is cut back at a clause boundary instead of losing the whole source line", () => {
  const sl = require("../netlify/functions/lib/agent-marketing-sources-lib");
  const src = [{ url: "https://freddiemac.gcs-web.com/news-releases/news-release-details/mortgage-rates-decrease-732", title: "Mortgage Rates Decrease to 7.32%", published: "2026-10-22" }];
  const note = "The rate figure is national and dated 2026-10-22; no source found in the available results establishes Lincoln-specific buydown activity or data for the full requested period.";
  const t = sl.sourceLine(src, note);
  assert.ok(t && t.length <= sl.MAX_LINE);
  assert.match(t, /^Source: Mortgage Rates Decrease to 7\.32% \(freddiemac\.gcs-web\.com, Oct 22, 2026\)\./);
  assert.match(t, /The rate figure is national and dated 2026-10-22\.$/);
  assert.strictEqual(sl.sourceLine(src, "Figures cover ZIP 95834."), "Source: Mortgage Rates Decrease to 7.32% (freddiemac.gcs-web.com, Oct 22, 2026). Figures cover ZIP 95834.");
});

test("source lines stay within the bar and always keep the sentence that says what the figures cover", () => {
  const sl = require("../netlify/functions/lib/agent-marketing-sources-lib");
  const z = sl.sourceLine([{ url: "https://www.zillow.com/research/september-2026-market-report/", title: "Winter Has Arrived Early in the Housing Market as Newly Pending Sales Fall 8.5% (Zillow September Market Report)", published: "2026-10-06" }],
    "These figures cover the United States, not Lincoln, CA; September 2026 data does not cover the full requested September 27–October 26 period, and the closed-sales nowcast is preliminary.");
  assert.ok(z.length <= sl.MAX_LINE, z); assert.match(z, /…\s\(zillow\.com, Oct 6, 2026\)/); assert.match(z, /These figures cover the United States, not Lincoln, CA\.$/);
  const n = sl.sourceLine([{ url: "https://www.redfin.com/a", title: "Redfin 95834 Housing Market", published: "2026-10-20" }, { url: "https://www.sacbee.com/b", title: "B", published: "2026-10-19" }],
    "Median price is based on the three-month reporting period ending September; closed-sale count is for September. Figures cover ZIP 95834, not all of Natomas.");
  assert.match(n, /Figures cover ZIP 95834, not all of Natomas\.$/); assert.ok(n.length <= sl.MAX_LINE);
});
