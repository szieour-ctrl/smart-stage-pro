"use strict";
// Nov 12, 2026 (Sam): the approved article is credited on screen (never spoken, never in the captions) on a Reel that also carries the MetroList notice.
const test = require("node:test");
const assert = require("node:assert");
const fx = require("./fixtures/natomas-approved.json");
const lib = require("../netlify/functions/lib/agent-marketing-assets-lib");
const manifestLib = require("../netlify/functions/lib/agent-marketing-manifest-lib");
const am = require("../netlify/functions/lib/agent-marketing-lib");
const timing = require("../netlify/functions/lib/agent-marketing-timing-lib");

const CREDIT = "Source: Roseville Market Update September 2026: Prices Hold (thegoolsbygroup.com, Oct 12, 2026).";
const article = { kind: "article", title: "Roseville Market Update September 2026: Prices Hold", url: "https://thegoolsbygroup.com/blog/roseville-market-update-september-2026", published: "2026-10-12" };
const articleTopic = { origin: "web", sources: [article] };
const words = timing.captionWords(fx.narrative.narrationTagged).map((t, i) => ({ text: t, start: 0.3 + i * 0.4, end: 0.3 + i * 0.4 + 0.34 }));
const duration = Math.round((words[words.length - 1].end + 0.5) * 100) / 100;
const brand = { primary: "#B08D3F", secondary: "#1D2023", border: "#B08D3F", font: "Montserrat", headshot_key: "profiles/hs.png", agent: { name: "Sam Zieour", brokerage: "SZ Real Estate Group" } };
const keys = (s) => ({ "9x16": `i${s}_9`, "16x9": `i${s}_16` });
const base = (over) => ({
  projectId: "p1", formats: ["9x16", "16x9"], narrative: fx.narrative, intake: fx.intake, reportFigures: fx.reportFigures,
  notice: { period: lib.parseNoticePeriod(fx.narrative.notice || "Based on information from MetroList Services, Inc. for the period February 19, 2026 through October 19, 2026.") },
  brand, audio: { narration_key: "n.mp3", duration_sec: duration, words }, imageKeys: Object.fromEntries(fx.narrative.scenes.map((_, i) => [i, keys(i)])), narrationTagged: fx.narrative.narrationTagged, ...(over || {}),
});
const withArticleScene = (n) => ({ ...fx.narrative, scenes: fx.narrative.scenes.map((s, i) => (i === n ? { ...s, sourceRole: "article" } : s)) });

test("MetroList-only Reel: no article credit, notice unchanged", () => {
  const r = lib.buildManifest(base());
  assert.ok(r.manifest, JSON.stringify(r.validation));
  assert.strictEqual(r.manifest.source_credit, undefined);
  assert.strictEqual(r.manifest.notice_required, true);
  assert.match(r.manifest.notice.text, /^Based on information from MetroList Services, Inc\./);
  assert.deepStrictEqual(r.validation.errors, []);
});

test("Article-Led + MetroList Reel: the article is credited on its scene and the MetroList notice stays", () => {
  const r = lib.buildManifest(base({ narrative: withArticleScene(1), articleTopic }));
  assert.deepStrictEqual(r.validation.errors, [], JSON.stringify(r.validation.errors));
  assert.strictEqual(r.manifest.scenes[1].source_role, "article");
  assert.strictEqual(r.manifest.source_credit.text, CREDIT);
  assert.deepStrictEqual(r.manifest.source_credit.scenes, [2]);
  assert.strictEqual(r.manifest.source_credit.sources[0].url, article.url);
  assert.strictEqual(r.manifest.notice_required, true);
  assert.match(r.manifest.notice.text, /^Based on information from MetroList Services, Inc\./);
  assert.strictEqual(r.manifest.source_line, undefined, "the MetroList path does not borrow the web source line");
});

test("the credit never reaches the narration, the captions or the words on a card", () => {
  const r = lib.buildManifest(base({ narrative: withArticleScene(1), articleTopic }));
  const spoken = [r.manifest.narration_text, ...r.manifest.captions.map((c) => c.text), ...r.manifest.scenes.map((s) => s.narration_excerpt)].join(" ").toLowerCase();
  assert.ok(!spoken.includes("source:") && !spoken.includes("thegoolsbygroup") && !spoken.includes("goolsby"));
  const onCards = JSON.stringify(r.manifest.scenes.map((s) => s.data)).toLowerCase();
  assert.ok(!onCards.includes("thegoolsbygroup") && !onCards.includes("goolsby"));
});

test("an article with no article scene in the Reel adds no credit", () => {
  const r = lib.buildManifest(base({ articleTopic }));
  assert.strictEqual(r.manifest.source_credit, undefined);
});

test("article-only (web research) Reel keeps its source line and takes no separate credit", () => {
  const webTopic = { sources: [article], scopeNote: "" };
  const r = lib.buildManifest(base({ narrative: withArticleScene(1), webTopic, articleTopic }));
  assert.strictEqual(r.manifest.notice_required, false);
  assert.strictEqual(r.manifest.source_line.text, CREDIT);
  assert.strictEqual(r.manifest.source_credit, undefined);
});

test("the credit is rebuilt and checked: typed text, a wrong scene, or a source line beside it is refused", () => {
  const good = lib.buildManifest(base({ narrative: withArticleScene(1), articleTopic })).manifest;
  const check = (mut) => manifestLib.validateManifest(mut(JSON.parse(JSON.stringify(good)))).errors.filter((e) => e.code === "source_credit");
  assert.deepStrictEqual(check((m) => m), []);
  assert.strictEqual(check((m) => { m.source_credit.text = "Source: something else (example.com, Oct 12, 2026)."; return m; }).length, 1);
  assert.strictEqual(check((m) => { m.source_credit.scenes = [1]; return m; }).length, 1, "the opening scene cannot carry the article credit");
  assert.strictEqual(check((m) => { m.source_credit.scenes = [3]; return m; }).length, 1, "a data scene cannot carry it");
  assert.strictEqual(check((m) => { m.source_credit.sources = []; return m; }).length >= 1, true);
  assert.ok(check((m) => { m.notice_required = false; m.source_line = { sources: m.source_credit.sources, scope_note: "", text: m.source_credit.text }; return m; }).length >= 1);
});

test("a script edit keeps the notice on the opening and closing scenes and the credit on the article scene", () => {
  const project = { template: "local_market_insider", selected_topic: { reportNotice: "Based on information from MetroList Services, Inc. for the period Oct 1, 2026 through Oct 31, 2026.", b2: { article: { title: "x" } }, sources: [article] } };
  const n = { scenes: withArticleScene(1).scenes.map((s) => ({ sourceRole: s.sourceRole || "data" })) };
  am.attachNotice(project, n);
  assert.deepStrictEqual(n.noticeOverlay.scenes, [0, n.scenes.length - 1]);
  assert.strictEqual(n.sourceCredit.text, CREDIT);
  assert.deepStrictEqual(n.sourceCredit.scenes, [1]);
});
