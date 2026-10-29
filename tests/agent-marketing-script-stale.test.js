const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
test("project payload flags a script written for another topic, and the page offers Write my script again", () => {
  const api = fs.readFileSync(__dirname + "/../netlify/functions/agent-marketing-project.js", "utf8");
  assert.match(api, /scriptStale: scriptStale\(row\)/);
  const html = fs.readFileSync(__dirname + "/../agent-marketing.html", "utf8");
  assert.match(html, /!state\.project\.scriptStale/);
  assert.match(html, /Choosing a different topic makes the server reset the intake/);
});
