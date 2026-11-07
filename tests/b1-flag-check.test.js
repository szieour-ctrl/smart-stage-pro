// b1-flag-check (temporary): answers only on the b1-stageb-dev branch deploy against the development database, returns a single boolean
// (plus whether Netlify's CONTEXT/BRANCH were seen at runtime), never the value.
const test = require("node:test");
const assert = require("node:assert");
const fn = require("../netlify/functions/b1-flag-check");
const am = require("../netlify/functions/lib/agent-marketing-lib");
const { BRANCH_HOST, DEV_URL } = fn._internals;

const base = { CONTEXT: "branch-deploy", BRANCH: "b1-stageb-dev", SUPABASE_URL: DEV_URL };
const call = (host, env) => fn.handler({ headers: { host } }, {}, { env });

test("b1-flag-check: 404 on every other host, a present-but-different context or branch, and any non-development database", async () => {
  for (const h of ["smartstagepro.com", "smart-stage-pro.netlify.app", "main--smart-stage-pro.netlify.app", "deploy-preview-219--smart-stage-pro.netlify.app", ""]) {
    assert.strictEqual((await call(h, { ...base, AGENT_MARKETING_ENABLED: "true" })).statusCode, 404, h);
  }
  assert.strictEqual((await call(BRANCH_HOST, { ...base, CONTEXT: "production", AGENT_MARKETING_ENABLED: "true" })).statusCode, 404);
  assert.strictEqual((await call(BRANCH_HOST, { ...base, CONTEXT: "deploy-preview", AGENT_MARKETING_ENABLED: "true" })).statusCode, 404);
  assert.strictEqual((await call(BRANCH_HOST, { ...base, BRANCH: "main", AGENT_MARKETING_ENABLED: "true" })).statusCode, 404);
  for (const db of ["https://dnpaenpwdhjmslymgkse.supabase.co", "https://other.supabase.co", "", undefined]) {
    assert.strictEqual((await call(BRANCH_HOST, { ...base, SUPABASE_URL: db, AGENT_MARKETING_ENABLED: "true" })).statusCode, 404, String(db));
  }
});

test("b1-flag-check: answers when Netlify does not expose CONTEXT/BRANCH to the function at runtime, and says so", async () => {
  for (const [env, runtime] of [
    [{ SUPABASE_URL: DEV_URL }, { context: "unset", branch: "unset" }],
    [{ SUPABASE_URL: DEV_URL, CONTEXT: "branch-deploy" }, { context: "branch-deploy", branch: "unset" }],
    [{ SUPABASE_URL: DEV_URL, BRANCH: "b1-stageb-dev" }, { context: "unset", branch: "b1-stageb-dev" }],
    [base, { context: "branch-deploy", branch: "b1-stageb-dev" }],
  ]) {
    const r = await call(BRANCH_HOST, { ...env, AGENT_MARKETING_ENABLED: "true" });
    assert.strictEqual(r.statusCode, 200, JSON.stringify(env));
    assert.deepStrictEqual(JSON.parse(r.body), { agentMarketingEnabled: true, runtime });
  }
});

test("b1-flag-check: one boolean, same rule as the feature switch, value never returned", async () => {
  const uid = "f3abd467-cf79-455d-bdae-a2b32bafaa17";
  for (const v of ["true", " TRUE ", "True", "false", "1", "yes", "", undefined, "SECRET-NEVER-SHOWN"]) {
    const r = await call(BRANCH_HOST, { ...base, AGENT_MARKETING_ENABLED: v });
    assert.strictEqual(r.statusCode, 200);
    const b = JSON.parse(r.body);
    assert.deepStrictEqual(Object.keys(b), ["agentMarketingEnabled", "runtime"]);
    assert.strictEqual(typeof b.agentMarketingEnabled, "boolean");
    assert.strictEqual(b.agentMarketingEnabled, am.isEnabledFor(uid, { AGENT_MARKETING_ENABLED: v }), String(v));
    assert.ok(!r.body.includes("SECRET-NEVER-SHOWN") && !r.body.includes(DEV_URL));
  }
});
