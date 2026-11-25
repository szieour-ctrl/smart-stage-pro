// Run with: npm test
// Nov 25, 2026: with the beta switch on, image notes, picture descriptions and card text get no editorial claim checks (production as on Test); switch off is unchanged.
const test = require("node:test");
const assert = require("node:assert");
const elab = require("../netlify/functions/lib/agent-marketing-image-elaborate-lib");

const project = { template: "local_market_insider", intake: { market: "Natomas" }, selected_topic: null };
const TEXT = "Prices rose 14% last quarter in the area.";
function withSwitch(on, fn) {
  const prev = process.env.AGENT_MARKETING_B1_EVIDENCE;
  if (on) process.env.AGENT_MARKETING_B1_EVIDENCE = "dev"; else delete process.env.AGENT_MARKETING_B1_EVIDENCE;
  try { return fn(); } finally { if (prev === undefined) delete process.env.AGENT_MARKETING_B1_EVIDENCE; else process.env.AGENT_MARKETING_B1_EVIDENCE = prev; }
}

test("image text: switch on skips the editorial claim checks; switch off is unchanged", () => {
  const off = withSwitch(false, () => elab.checkText(project, TEXT, false));
  const on = withSwitch(true, () => elab.checkText(project, TEXT, false));
  assert.strictEqual(off.ok, false, "switch off: an unsourced figure is still flagged (production unchanged)");
  assert.strictEqual(on.ok, true, "switch on: no editorial claim check on image or card text");
});

test("image text: switch on still applies the Fair Housing rules", () => {
  const g = withSwitch(true, () => elab.checkText(project, "A quiet area, perfect for families without children.", false));
  assert.strictEqual(g.ok, false);
});
