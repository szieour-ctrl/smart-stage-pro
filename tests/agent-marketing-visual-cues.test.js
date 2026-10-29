const test = require("node:test");
const assert = require("node:assert/strict");
const research = require("../netlify/functions/lib/agent-marketing-research-lib.js");
const plan = require("../netlify/functions/lib/agent-marketing-plan-lib.js");

test("cues are kept only with a verified basis", () => {
  const c = research.cleanVisualCues({ official_image_url: "https://x.org/a.jpg", seasonal_theme: "Holiday", dominant_colors: ["red", "green"], visible_items: ["wreaths"], visual_mood: "cozy", event_setting: "indoor", basis: "image_inspected" });
  assert.equal(c.verification_status, "verified");
  assert.equal(c.source_type, "official_event_image");
  assert.equal(c.official_image_url, "https://x.org/a.jpg");
  assert.equal(research.cleanVisualCues({ seasonal_theme: "Holiday", basis: "unknown" }), null);
  assert.equal(research.cleanVisualCues({ official_image_url: "https://x.org/a.jpg", basis: "image_inspected" }), null);
  assert.equal(research.cleanVisualCues(null), null);
});

test("bad URL and setting are neutralised", () => {
  const c = research.cleanVisualCues({ official_image_url: "http://x.org/a.jpg", seasonal_theme: "Fall", event_setting: "rooftop", basis: "page_text" });
  assert.equal(c.official_image_url, null);
  assert.equal(c.event_setting, "unknown");
  assert.equal(c.source_type, "official_event_page_text");
});

test("planner rule 9f exists and mentions no invention", () => {
  assert.match(plan.buildSystemPrompt ? plan.buildSystemPrompt({}) : "", /VERIFIED VISUAL CUES/);
});
