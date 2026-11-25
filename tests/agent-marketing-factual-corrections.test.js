"use strict";
// Nov 14, 2026 (Sam, Option 2 beta): the measure-identity clause and the editor's attribution rule. Both act only BEFORE the subscriber approves a script;
// neither is a gate, and the production prompt is untouched.
const test = require("node:test");
const assert = require("node:assert");
const crypto = require("node:crypto");
const planLib = require("../netlify/functions/lib/agent-marketing-plan-lib");

const PROD_HASH = "25f3118fed1b9726fc4dc78b16dcc92233cef785d3c074ef89a6ee7aaf7b0495";
const withFlag = (on, fn) => { const keep = process.env.AGENT_MARKETING_B1_EVIDENCE; if (on) process.env.AGENT_MARKETING_B1_EVIDENCE = "dev"; else delete process.env.AGENT_MARKETING_B1_EVIDENCE; try { return fn(); } finally { if (keep === undefined) delete process.env.AGENT_MARKETING_B1_EVIDENCE; else process.env.AGENT_MARKETING_B1_EVIDENCE = keep; } };

test("measure identity: the Test planner prompt keeps a median a median and an average an average; the production prompt is byte-identical", () => {
  const t = withFlag(true, () => planLib.buildSystemPrompt());
  assert.match(t, /a median stays a median and an average stays an average/);
  assert.match(t, /never spoken as \\?"31 days on average\\?"/);
  assert.match(t, /a monthly payment difference is a payment difference, never a rate/, "the payment-versus-rate wording from rule 2h is still there");
  const prod = withFlag(false, () => planLib.buildSystemPrompt());
  assert.strictEqual(crypto.createHash("sha256").update(prod).digest("hex"), PROD_HASH);
  assert.ok(!/stays a median/.test(prod));
});

test("the length editor keeps a source named: a lead-in attribution is folded into the fact's sentence before the lead-in goes, and a measure keeps its name", () => {
  for (const d of [45, 60]) {
    const s = planLib.lengthEditSystem(d, true);
    assert.match(s, /fold its name into the sentence that states the fact before you remove the lead-in/);
    assert.match(s, /a median stays a median/);
    assert.match(s, /Do not add any fact/, "the editor still adds nothing");
  }
});

test("neither correction can touch an approved script: they live in the pre-approval planner and editor prompts only", () => {
  const fs = require("node:fs"), path = require("node:path");
  const lib = fs.readFileSync(path.join(__dirname, "..", "netlify/functions/lib/agent-marketing-plan-lib.js"), "utf8");
  const sb = lib.slice(lib.indexOf("function buildStoryboardSystemPrompt"), lib.indexOf("function buildStoryboardUserMessage"));
  assert.ok(!/fold its name|stays a median/.test(sb), "the storyboard prompt carries no rewriting instruction");
});
