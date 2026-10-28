// Oct 28, 2026: UTF-8 decoding of API replies, "area" wording, aerial image rule, the page renewing its own login.
const test = require("node:test");
const assert = require("node:assert");
const fs = require("fs");
const path = require("path");
const root = path.join(__dirname, "..");
const read = (f) => fs.readFileSync(path.join(root, f), "utf8");

test("every agent-marketing API reply is decoded as UTF-8 (no chunk-by-chunk Buffer concatenation)", () => {
  for (const f of ["netlify/functions/agent-marketing-image-background.js", "netlify/functions/agent-marketing-prepare-background.js", "netlify/functions/agent-marketing-render.js", "netlify/functions/lib/agent-marketing-plan-lib.js", "netlify/functions/lib/agent-marketing-research-run-lib.js"]) {
    const src = read(f);
    const concats = (src.match(/res\.on\("data", \(c\) => \((?:d|data) \+= c\)\)/g) || []).length;
    const sets = (src.match(/res\.setEncoding\("utf8"\)/g) || []).length;
    assert.ok(concats > 0 && sets >= concats, f);
  }
});

test("planner says 'the area', not 'neighborhood'; image brief shows home fronts, never backyards", () => {
  assert.match(require("../netlify/functions/lib/agent-marketing-plan-lib").buildSystemPrompt(), /call the place "the area"/);
  assert.match(require("../netlify/functions/lib/agent-marketing-image-elaborate-lib").buildSystemPrompt(), /FRONTS of homes[\s\S]*Never show a fenced backyard/);
});

test("the page renews its own Supabase session before it expires", () => {
  const html = read("agent-marketing.html");
  assert.match(html, /grant_type=refresh_token/);
  assert.match(html, /await renewSession\(/);
});
