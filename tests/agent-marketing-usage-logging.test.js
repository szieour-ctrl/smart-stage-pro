const test = require("node:test");
const assert = require("node:assert/strict");
const plan = require("../netlify/functions/lib/agent-marketing-plan-lib.js");
test("summarizeClaudeUsage totals calls and tokens", () => {
  const u = plan.summarizeClaudeUsage([{ model: "m", input_tokens: 100, output_tokens: 40 }, { model: "m", input_tokens: 50, output_tokens: 10 }]);
  assert.equal(u.claude_calls, 2); assert.equal(u.claude_input_tokens, 150); assert.equal(u.claude_output_tokens, 50);
  assert.equal(plan.summarizeClaudeUsage(null).claude_calls, 0);
});
