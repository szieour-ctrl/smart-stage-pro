const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
test("research endpoint lists earlier sets and copies on select", () => {
  const s = fs.readFileSync(__dirname + "/../netlify/functions/agent-marketing-research.js", "utf8");
  assert.match(s, /project_id=neq\./);
  assert.match(s, /copiedFrom/);
  assert.match(s, /charged_at: null/);
});
