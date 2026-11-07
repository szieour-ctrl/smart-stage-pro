// b1-env-check: answers only on the b1-stageb-dev branch host, reports states (never values), and fails when a production value leaked through.
const test = require("node:test");
const assert = require("node:assert");
const fn = require("../netlify/functions/b1-env-check");
const { CUT_OFF, BRANCH_HOST, BRANCH_URL } = fn._internals;

const SECRET = "sk-THIS-MUST-NEVER-APPEAR-0123456789";
const blockedStore = () => ({ async get() { const e = new Error("missing"); e.name = "MissingBlobsEnvironmentError"; throw e; } });
const openStore = () => ({ async get() { return null; } });
const isolated = () => ({ CONTEXT: "branch-deploy", BRANCH: "b1-stageb-dev", SITE_URL: BRANCH_URL, NETLIFY_URL: BRANCH_URL, INTERNAL_API_KEY: SECRET,
  ...Object.fromEntries(CUT_OFF.map((n) => [n, ""])), SUPABASE_URL: "", NETLIFY_SITE_ID: "site" });
const call = (host, env, getStore) => fn.handler({ headers: { host } }, {}, { env, getStore: getStore || blockedStore });

test("b1-env-check: 404 on every host but the branch deploy, and in any other context", async () => {
  for (const h of ["smartstagepro.com", "smart-stage-pro.netlify.app", "main--smart-stage-pro.netlify.app", "deploy-preview-219--smart-stage-pro.netlify.app", ""]) {
    assert.strictEqual((await call(h, isolated())).statusCode, 404, h);
  }
  assert.strictEqual((await call(BRANCH_HOST, { ...isolated(), CONTEXT: "production" })).statusCode, 404);
  assert.strictEqual((await call(BRANCH_HOST, { ...isolated(), BRANCH: "main" })).statusCode, 404);
});

test("b1-env-check: an isolated branch passes, and no value is ever returned", async () => {
  const r = await call(BRANCH_HOST, isolated());
  const body = JSON.parse(r.body);
  assert.strictEqual(r.statusCode, 200); assert.strictEqual(body.ok, true, JSON.stringify(body.checks.filter((c) => !c.ok)));
  assert.ok(!r.body.includes(SECRET), "no value in the output");
  assert.ok(!r.body.includes("site\""), "no site id in the output");
  assert.deepStrictEqual(body.blobs, { result: "blocked", error: "MissingBlobsEnvironmentError", ok: true });
});

test("b1-env-check: an inherited production value, the production database, a wrong call-back URL or reachable Blobs all fail", async () => {
  for (const [over, name] of [[{ ANTHROPIC_API_KEY: SECRET }, "ANTHROPIC_API_KEY"], [{ SUPABASE_SERVICE_ROLE_KEY: SECRET }, "SUPABASE_SERVICE_ROLE_KEY"],
    [{ NETLIFY_ACCESS_TOKEN: SECRET }, "NETLIFY_ACCESS_TOKEN"], [{ SUPABASE_URL: "https://dnpaenpwdhjmslymgkse.supabase.co" }, "SUPABASE_URL"],
    [{ SITE_URL: "https://smartstagepro.com" }, "SITE_URL"], [{ AGENT_MARKETING_B1_EVIDENCE: "dev" }, "AGENT_MARKETING_B1_EVIDENCE"], [{ INTERNAL_API_KEY: "" }, "INTERNAL_API_KEY"]]) {
    const r = await call(BRANCH_HOST, { ...isolated(), ...over });
    const body = JSON.parse(r.body);
    assert.strictEqual(body.ok, false, name);
    assert.strictEqual(body.checks.find((c) => c.name === name).ok, false, name);
    assert.ok(!r.body.includes(SECRET), `no value in the output (${name})`);
  }
  const reach = JSON.parse((await call(BRANCH_HOST, isolated(), openStore)).body);
  assert.strictEqual(reach.ok, false); assert.strictEqual(reach.blobs.result, "reachable");
});

test("b1-env-check: NETLIFY_URL may be absent (it is not a Netlify built-in, so it only exists if the site defined it)", async () => {
  const env = isolated(); delete env.NETLIFY_URL;
  assert.strictEqual(JSON.parse((await call(BRANCH_HOST, env)).body).ok, true);
});

test("b1-env-check: the log line carries names and states only", async () => {
  const lines = []; const keep = console.log; console.log = (m) => lines.push(String(m));
  try { await call(BRANCH_HOST, { ...isolated(), ANTHROPIC_API_KEY: SECRET }); } finally { console.log = keep; }
  assert.strictEqual(lines.length, 1);
  assert.match(lines[0], /^b1-env-check FAIL checks=\d+ failing=\[ANTHROPIC_API_KEY:set\] blobs=blocked context=branch-deploy branch=b1-stageb-dev$/);
  assert.ok(!lines[0].includes(SECRET));
});
