// Run with: node --test tests/
const test = require("node:test");
const assert = require("node:assert");
const fs = require("fs");
const path = require("path");

const read = (f) => fs.readFileSync(path.join(__dirname, "..", f), "utf8");

// Two scripts share one page. When two elements share an id, $("id") returns the first one in the page, so one script silently fills or
// reads the other's field (the Research "Who is this for?" list was overwritten by the Your Insight list, Oct 25, 2026).
test("agent-marketing.html: every id is unique, including inputs the page's own scripts create", () => {
  const html = read("agent-marketing.html");
  const ids = [...html.matchAll(/\bid=\\?"([A-Za-z][\w-]*)\\?"/g)].map((m) => m[1]);
  const seen = new Set(), dupes = new Set();
  ids.forEach((id) => (seen.has(id) ? dupes.add(id) : seen.add(id)));
  assert.deepStrictEqual([...dupes], []);
});

test("the Research step and the Your Insight step each have their own audience list", () => {
  const html = read("agent-marketing.html");
  const research = read("agent-marketing-research-ui.js");
  assert.match(html, /id="audience"/);
  assert.match(html, /id="intakeAudience"/);
  assert.match(research, /\$\("audience"\)\.value/);
  assert.doesNotMatch(html, /\$\("audience"\)/); // the page's own script never touches the Research list
});
