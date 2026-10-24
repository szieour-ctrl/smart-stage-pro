// Run with: npm test
const test = require("node:test");
const assert = require("node:assert");
const am = require("../netlify/functions/lib/agent-marketing-lib");
const intakeLib = require("../netlify/functions/lib/agent-marketing-intake");

test("feature switch: off by default, on only with the flag, optionally limited to listed users", () => {
  assert.strictEqual(am.isEnabledFor("u1", {}), false);
  assert.strictEqual(am.isEnabledFor("u1", { AGENT_MARKETING_ENABLED: "false" }), false);
  assert.strictEqual(am.isEnabledFor("u1", { AGENT_MARKETING_ENABLED: "true" }), true);
  const env = { AGENT_MARKETING_ENABLED: "true", AGENT_MARKETING_USER_IDS: "U1, u2" };
  assert.strictEqual(am.isEnabledFor("u1", env), true);
  assert.strictEqual(am.isEnabledFor("u3", env), false);
  assert.strictEqual(am.isEnabledFor("u1", { AGENT_MARKETING_USER_IDS: "u1" }), false); // ids alone never enable it
});

test("create: defaults, validation and the not-yet-available cases", () => {
  const ok = am.validateCreate({});
  assert.deepStrictEqual(ok.row, { template: "local_market_insider", duration_sec: 45, formats: ["9x16", "16x9"], voice: "ssp_male", music: "default" });
  assert.deepStrictEqual(am.validateCreate({ formats: "9x16", durationSec: 30, voice: "ssp_female" }).row.formats, ["9x16"]);
  assert.ok(am.validateCreate({ durationSec: 20 }).error);
  assert.ok(am.validateCreate({ formats: ["4x3"] }).error);
  assert.match(am.validateCreate({ voice: "custom" }).error, /coming soon/);
  assert.strictEqual(am.validateCreate({ music: "luxury_cinematic" }).row.music, "luxury_cinematic");
  assert.strictEqual(am.validateCreate({ music: "none" }).row.music, "none");
  assert.match(am.validateCreate({ music: "dubstep" }).error, /music/);
  assert.ok(am.validateCreate({ template: "meet_your_agent" }).error);
  assert.ok(am.validateCreate({ template: "bogus" }).error);
});

test("audio tags are removed from captions and word counts ignore them", () => {
  const t = "[conversational] Is new construction helping...[pauses] [emphasis] or hurting?";
  const plain = am.stripAudioTags(t);
  assert.ok(!/[\[\]]/.test(plain));
  assert.strictEqual(am.countWords(t), 6);
});

test("narrative: captions are derived from the tagged script, never taken from the client", () => {
  const v = am.validateNarrative({ narrationTagged: "[warm] Hello there.", captionText: "SOMETHING ELSE", cta: { text: "Ask me.", source: "user_inserted" } }, 45);
  assert.strictEqual(v.narrative.captionText, "Hello there.");
  assert.deepStrictEqual(v.narrative.cta, { text: "Ask me.", source: "user_inserted" });
  assert.ok(v.warnings.length > 0); // far below the 45s word target
  assert.ok(am.validateNarrative({ narrationTagged: "  " }, 45).error);
  // a client cannot claim the CTA came from Claude or the template
  assert.strictEqual(am.validateNarrative({ narrationTagged: "x y", cta: { text: "Hi", source: "claude" } }, 45).narrative.cta.source, "user_edited");
});

test("intake: angle-specific issues, required market, unknown keys dropped, blank observation flagged", () => {
  const good = intakeLib.validateIntake("local_market_insider", { angle: "neighborhood", market: "Roseville, CA", issue: "Supply and buyer demand", observation: "New homes nearby change the comparison.", address: "1 Main St" });
  assert.strictEqual(good.ok, true);
  assert.ok(!("address" in good.clean));
  assert.deepStrictEqual(Object.keys(good.clean).sort(), ["action", "angle", "audience", "issue", "market", "observation"]);
  assert.strictEqual(intakeLib.validateIntake("local_market_insider", { angle: "seller", market: "Roseville", issue: "Supply and buyer demand" }).ok, false); // issue belongs to another angle
  assert.strictEqual(intakeLib.validateIntake("local_market_insider", { angle: "seller", issue: "Timing their move" }).ok, false); // no market
  const blank = intakeLib.validateIntake("local_market_insider", { angle: "seller", market: "Roseville", issue: "Timing their move" });
  assert.strictEqual(blank.ok, true);
  assert.deepStrictEqual(blank.needsInput, ["observation"]);
  assert.strictEqual(intakeLib.validateIntake("nope", {}).ok, false);
});
