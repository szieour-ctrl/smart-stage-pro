const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const html = fs.readFileSync(__dirname + "/../agent-marketing.html", "utf8");
test("Also apply this change to 16:9: only for both formats, 9:16 drafts with a note, off by default, cost shown", () => {
  assert.match(html, /Also apply this change to 16:9 \(/);
  assert.match(html, /s\.format === "9x16" && \(state\.project\.formats \|\| \[\]\)\.length > 1/);
  assert.match(html, /dnote/);
  assert.doesNotMatch(html, /id="imgmAlso" checked/);
  assert.match(html, /\? " checked" : ""/);
  assert.match(html, /costs " \+ plural\(other\.nextCredits\)/);
  assert.match(html, /async function applyToWide/);
});
