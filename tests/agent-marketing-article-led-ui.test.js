// Run with: npm test
// PR 2: the minimal visible MLS Market Trend option. Static checks of the page and its script (the page has no DOM test harness).
const test = require("node:test");
const assert = require("node:assert");
const fs = require("fs"), path = require("path");
const read = (f) => fs.readFileSync(path.join(__dirname, "..", f), "utf8");
const html = read("agent-marketing.html"), ui = read("agent-marketing-research-ui.js");

test("the page has one container for the MLS option and every id is still unique", () => {
  const ids = [...html.matchAll(/\bid=\\?"([A-Za-z][\w-]*)\\?"/g)].map((m) => m[1]);
  assert.strictEqual(ids.filter((i) => i === "resMlsOption").length, 1);
  assert.strictEqual(new Set(ids).size, ids.length);
  assert.ok(html.indexOf('id="resNote"') < html.indexOf('id="resMlsOption"') && html.indexOf('id="resMlsOption"') < html.indexOf('id="resTopics"'));
});

test("the option reads 'Create an MLS Market Trend Reel' and shows only for an Article-Led result when the pathway is on", () => {
  assert.match(ui, />Create an MLS Market Trend Reel</);
  const fn = ui.slice(ui.indexOf("function renderMlsOption"), ui.indexOf("function renderFailOptions"));
  assert.match(fn, /state\.schema\.articleLed/);
  assert.match(fn, /r\.pathway !== "article_led"/);
  assert.match(fn, /r\.status !== "ready" && r\.status !== "failed"/);
});

test("it is a separate, deliberate workflow: it needs a confirmed report, goes through the same confirmation step, and never starts by itself", () => {
  const fn = ui.slice(ui.indexOf("function renderMlsOption"), ui.indexOf("function renderFailOptions"));
  assert.match(fn, /u\.status !== "confirmed"/);
  assert.match(fn, /state\.mlsTrend = true;[^}]*review\(\)/);       // opens the confirmation summary; only "Confirm and research" starts it
  assert.doesNotMatch(fn, /\bstart\(\)/);
  assert.match(ui, /dataSource: state\.mlsTrend \? "upload" : reportSource\(\)\.dataSource/);   // report only: it never takes one of the article-led positions
  assert.match(ui, /function hideConfirm\(keepMls\) \{ if \(keepMls !== true\) state\.mlsTrend = false;/);   // cancelling or editing clears it
  assert.match(ui, /hideConfirm\(true\);\n\s+\$\("startBtn"\)\.disabled = true;/);
});

test("the confirmation says when a session is used, and the result title shows how many opportunities were delivered", () => {
  assert.match(ui, /A research session is used only when five opportunities are delivered/);
  assert.match(ui, /r\.delivered \+ " of 5 opportunities"/);
  assert.match(ui, /Your confirmed MLS report only \(no web research\)/);
});

test("the script still parses", () => { assert.doesNotThrow(() => new Function(ui)); });
