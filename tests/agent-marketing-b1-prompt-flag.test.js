// Run with: npm test
// DEVELOPMENT ONLY (Nov 5, 2026): the Planner system prompt differs from production ONLY when the server sets AGENT_MARKETING_B1_EVIDENCE=dev.
// No fixtures, no provider call.
const test = require("node:test");
const assert = require("node:assert");
const crypto = require("crypto");
const planLib = require("../netlify/functions/lib/agent-marketing-plan-lib");

const sha = (s) => crypto.createHash("sha256").update(s, "utf8").digest("hex");
// sha256 of buildSystemPrompt() on production main (622f96e), and of the B1 development prompt (rules 2b, 2g, 2h as approved in commit 83fb916, plus
// rule 2i, the B2 editorial direction, Nov 8, 2026).
const PRODUCTION_SHA256 = "25f3118fed1b9726fc4dc78b16dcc92233cef785d3c074ef89a6ee7aaf7b0495";
const B1_DEV_SHA256 = "1dc61b5987b8518cec8d365e130353cfd64e134de9d3f00515a2d39c16c76bae";   // Nov 12, 2026: + rule 2o (take a position; confidence matches the evidence), 2i/2j/2l/2n no longer push hedging
const rule = (prompt, id) => prompt.split("\n").filter((l) => l.startsWith(`${id}. `));
const withEnv = async (value, fn) => {
  const old = process.env.AGENT_MARKETING_B1_EVIDENCE;
  if (value === undefined) delete process.env.AGENT_MARKETING_B1_EVIDENCE; else process.env.AGENT_MARKETING_B1_EVIDENCE = value;
  try { return await fn(); } finally { if (old === undefined) delete process.env.AGENT_MARKETING_B1_EVIDENCE; else process.env.AGENT_MARKETING_B1_EVIDENCE = old; }
};

test("prompt flag: unset (or any value but dev), the whole system prompt is byte-identical to production", async () => {
  for (const env of [{}, { AGENT_MARKETING_B1_EVIDENCE: "" }, { AGENT_MARKETING_B1_EVIDENCE: "true" }, { AGENT_MARKETING_B1_EVIDENCE: "1" }, { AGENT_MARKETING_B1_EVIDENCE: "production" }]) {
    assert.strictEqual(sha(planLib.buildSystemPrompt(env)), PRODUCTION_SHA256, JSON.stringify(env));
  }
  await withEnv(undefined, () => assert.strictEqual(sha(planLib.buildSystemPrompt()), PRODUCTION_SHA256, "default: the server environment, unset"));
  const p = planLib.buildSystemPrompt({});
  assert.deepStrictEqual(rule(p, "2h"), [], "no rule 2h in production");
  assert.ok(!/article_evidence/.test(p), "production never mentions article_evidence");
});

test("prompt flag: AGENT_MARKETING_B1_EVIDENCE=dev gives the B1 prompt, which differs only in rules 2b, 2g, 2h, 2i, 2j, 2k, 2l, 2n and 2o", async () => {
  const dev = planLib.buildSystemPrompt({ AGENT_MARKETING_B1_EVIDENCE: "dev" }), prod = planLib.buildSystemPrompt({});
  assert.strictEqual(sha(dev), B1_DEV_SHA256);
  await withEnv("dev", () => assert.strictEqual(sha(planLib.buildSystemPrompt()), B1_DEV_SHA256));
  const d = dev.split("\n"), q = prod.split("\n");
  assert.deepStrictEqual(d.filter((l) => !q.includes(l)).map((l) => l.slice(0, 3)), ["2b.", "2g.", "2h.", "2i.", "2j.", "2k.", "2l.", "2n.", "2o."], "only 2b, 2g and the new 2h, 2i, 2j, 2k, 2l, 2n and 2o are new");
  assert.deepStrictEqual(q.filter((l) => !d.includes(l)).map((l) => l.slice(0, 3)), ["2b.", "2g."], "only production's 2b and 2g are replaced");
  // same order otherwise; 2h sits right after 2g
  const strip = (lines) => lines.filter((l) => !/^2[bghijklno]\. /.test(l));
  assert.deepStrictEqual(strip(d), strip(q));
  assert.strictEqual(d.indexOf(rule(dev, "2h")[0]), d.indexOf(rule(dev, "2g")[0]) + 1);
  assert.strictEqual(d.indexOf(rule(dev, "2i")[0]), d.indexOf(rule(dev, "2h")[0]) + 1);
  assert.strictEqual(d.indexOf(rule(dev, "2k")[0]), d.indexOf(rule(dev, "2j")[0]) + 1);
  assert.strictEqual(d.indexOf(rule(dev, "2n")[0]), d.indexOf(rule(dev, "2l")[0]) + 1);
  assert.strictEqual(d.indexOf(rule(dev, "2o")[0]), d.indexOf(rule(dev, "2n")[0]) + 1);
  assert.match(rule(dev, "2j")[0], /not the boundary of the agent's professional interpretation/);
  assert.match(rule(dev, "2k")[0], /2 to 5 years/); assert.match(rule(dev, "2k")[0], /do not enumerate the stages/);
});

test("prompt flag: rule 2f (market-number priority) is identical in both", () => {
  const dev = planLib.buildSystemPrompt({ AGENT_MARKETING_B1_EVIDENCE: "dev" }), prod = planLib.buildSystemPrompt({});
  assert.strictEqual(rule(prod, "2f").length, 1);
  assert.deepStrictEqual(rule(dev, "2f"), rule(prod, "2f"));
  assert.match(rule(dev, "2h")[0], /rule 2f decides every measure that figures_you_may_state contains/);
});

test("prompt flag: generatePlan sends the production prompt with the flag unset, the B1 prompt only with dev", async () => {
  const project = { template: "local_market_insider", duration_sec: 45, formats: ["9x16"], intake: { market: "Riverside", audience: "Home sellers", observation: "Buyers are taking their time." } };
  for (const [value, want] of [[undefined, PRODUCTION_SHA256], ["true", PRODUCTION_SHA256], ["dev", B1_DEV_SHA256]]) {
    const seen = [];
    await withEnv(value, async () => {
      await planLib.generatePlan({ project, anthropicKey: "k", callFn: async (system) => { seen.push(sha(system)); return "{}"; } }).catch(() => {});
    });
    assert.ok(seen.length >= 1, "the model call was reached");
    assert.ok(seen.every((h) => h === want), `${value}: ${seen}`);
  }
});
