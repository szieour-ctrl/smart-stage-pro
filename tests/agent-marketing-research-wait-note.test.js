// Nov 25, 2026: the research wait note names the real time for each research type.
const test = require("node:test");
const assert = require("node:assert");
const fs = require("fs");
const ui = fs.readFileSync(require("path").join(__dirname, "..", "agent-marketing-research-ui.js"), "utf8");
test("wait note: Market Update 2 to 3 minutes, Local Events 1 to 3 minutes, used in the status bar and the result panel", () => {
  assert.match(ui, /mode === "local_events" \? "This usually takes 1 to 3 minutes" : "This usually takes 2 to 3 minutes"/);
  assert.match(ui, /"<b>Researching…<\/b> " \+ waitNote\(cur\.mode\)/);
  assert.match(ui, /textContent = "Researching… " \+ waitNote\(r\.mode\)/);
  assert.ok(!/usually takes under a minute/.test(ui));
});
