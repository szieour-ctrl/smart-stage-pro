const test = require("node:test");
const assert = require("node:assert/strict");
const research = require("../netlify/functions/lib/agent-marketing-research-lib");
const plan = require("../netlify/functions/lib/agent-marketing-plan-lib");

test("research: district events name the business behind each detail, with its own date and status", () => {
  const sp = research.systemPrompt("local_events");
  assert.match(sp, /MANY-BUSINESS EVENTS/);
  assert.match(sp, /name the business that offers it/);
  assert.match(sp, /sold out, ticketed with a price, 21\+/);
});

test("planner: items that belong to a business are attributed to it; sold-out items are not offered as open", () => {
  const sys = plan.buildSystemPrompt();
  assert.match(sys, /the script names that business and says the item belongs to it/);
  assert.match(sys, /sold out or ticketed, do not invite viewers to it as if it were open or free/);
});
