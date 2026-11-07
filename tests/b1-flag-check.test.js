// b1-flag-check (temporary): answers only on the b1-stageb-dev branch deploy, returns a single boolean, never the value.
const test = require("node:test");
const assert = require("node:assert");
const fn = require("../netlify/functions/b1-flag-check");
const am = require("../netlify/functions/lib/agent-marketing-lib");
const { BRANCH_HOST } = fn._internals;

const base = { CONTEXT: "branch-deploy", BRANCH: "b1-stageb-dev" };
const call = (host, env) => fn.handler({ headers: { host } }, {}, { env });

test("b1-flag-check: 404 on every other host, context and branch", async () => {
  for (const h of ["smartstagepro.com", "smart-stage-pro.netlify.app", "main--smart-stage-pro.netlify.app", "deploy-preview-219--smart-stage-pro.netlify.app", ""]) {
    assert.strictEqual((await call(h, { ...base, AGENT_MARKETING_ENABLED: "true" })).statusCode, 404, h);
  }
  assert.strictEqual((await call(BRANCH_HOST, { ...base, CONTEXT: "production", AGENT_MARKETING_ENABLED: "true" })).statusCode, 404);
  assert.strictEqual((await call(BRANCH_HOST, { ...base, BRANCH: "main", AGENT_MARKETING_ENABLED: "true" })).statusCode, 404);
  assert.strictEqual((await call(BRANCH_HOST, { AGENT_MARKETING_ENABLED: "true" })).statusCode, 404);
});

test("b1-flag-check: one boolean, same rule as the feature switch, value never returned", async () => {
  const uid = "f3abd467-cf79-455d-bdae-a2b32bafaa17";
  for (const v of ["true", " TRUE ", "True", "false", "1", "yes", "", undefined, "SECRET-NEVER-SHOWN"]) {
    const env = { ...base, AGENT_MARKETING_ENABLED: v };
    const r = await call(BRANCH_HOST, env);
    assert.strictEqual(r.statusCode, 200);
    const b = JSON.parse(r.body);
    assert.deepStrictEqual(Object.keys(b), ["agentMarketingEnabled"]);
    assert.strictEqual(typeof b.agentMarketingEnabled, "boolean");
    assert.strictEqual(b.agentMarketingEnabled, am.isEnabledFor(uid, { AGENT_MARKETING_ENABLED: v }), String(v));
    if (v) assert.ok(!r.body.includes(v.trim()) || ["true", "false"].includes(v.trim().toLowerCase()), String(v));
  }
});
