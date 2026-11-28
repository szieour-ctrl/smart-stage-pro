// Run with: npm test — the Agent Marketing page wires the series templates (template picker, schema form, one follow-up entry point) (Nov 28, 2026)
const test = require("node:test");
const assert = require("node:assert");
const fs = require("fs");
const html = fs.readFileSync(require("path").join(__dirname, "..", "agent-marketing.html"), "utf8");

test("the page has the template picker, the series form and one follow-up action", () => {
  for (const id of ["tplChoices", "stepSeries", "serForm", "serSaveBtn", "serRecap"]) assert.ok(html.includes('id="' + id + '"'), id);
  assert.strictEqual((html.match(/action: "create_followup"/g) || []).length, 1);
  assert.ok(html.includes("data-followup"));
  assert.ok(html.includes("crypto.randomUUID"));
});

test("Local Market Insider keeps its research step; series projects skip it", () => {
  assert.match(html, /isSeries\(state\.project\) \? "stepSeries"/);
  assert.match(html, /if \(isSeries\(p\)\) return null;/);
  assert.match(html, /template: pickedValue\("tpl"\) \|\| "local_market_insider"/);
});

test("the page script parses", () => {
  const m = html.match(/<script[^>]*>[\s\S]*?<\/script>/g).map((x) => x.replace(/<\/?script[^>]*>/g, "")).filter((x) => x.length > 2000).join("\n");
  assert.doesNotThrow(() => new Function(m));
});
