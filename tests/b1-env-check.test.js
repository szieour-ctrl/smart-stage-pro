// b1-env-check: answers only on the b1-stageb-dev branch host, reports states (never values), accepts the approved placeholders for cut-off
// variables, requires private values for inbound-verification secrets, and fails when a production value leaked through.
const test = require("node:test");
const assert = require("node:assert");
const fn = require("../netlify/functions/b1-env-check");
const { CUT_OFF, PRIVATE_SECRETS, OPTIONAL_SECRETS, PLACEHOLDER, BRANCH_HOST, BRANCH_URL, DEV_URL } = fn._internals;
const PLACEHOLDER_URL = `https://${PLACEHOLDER}.invalid`;

const SECRET = "test-value-THIS-MUST-NEVER-APPEAR-0123456789abcdef";
const jwt = (claims) => ["eyJhbGciOiJIUzI1NiJ9", Buffer.from(JSON.stringify(claims)).toString("base64url"), "sig-NEVER-SHOWN"].join(".");
const DEV_SERVICE = jwt({ ref: "ooxigbxthabstahrexia", role: "service_role" });
const DEV_ANON = jwt({ ref: "ooxigbxthabstahrexia", role: "anon" });
const PROD_SERVICE = jwt({ ref: "dnpaenpwdhjmslymgkse", role: "service_role" });
const blockedStore = () => ({ async get() { const e = new Error("unauthorized"); e.name = "BlobsInternalError"; throw e; } });
const openStore = () => ({ async get() { return null; } });
const isolated = () => ({
  CONTEXT: "branch-deploy", BRANCH: "b1-stageb-dev", SITE_URL: BRANCH_URL, NETLIFY_URL: BRANCH_URL,
  ...Object.fromEntries(CUT_OFF.filter((n) => n !== "AGENT_MARKETING_B1_EVIDENCE").map((n) => [n, /URL$/.test(n) ? PLACEHOLDER_URL : PLACEHOLDER])),
  ...Object.fromEntries(PRIVATE_SECRETS.map((n, i) => [n, `${SECRET}-${i}`])),
  SUPABASE_URL: DEV_URL, SSP_PUBLIC_SUPABASE_URL: DEV_URL, SUPABASE_SERVICE_ROLE_KEY: DEV_SERVICE, SSP_PUBLIC_SUPABASE_ANON_KEY: DEV_ANON, NETLIFY_SITE_ID: "site",
});
const call = (host, env, getStore) => fn.handler({ headers: { host } }, {}, { env, getStore: getStore || blockedStore });
const body = async (env, getStore) => JSON.parse((await call(BRANCH_HOST, env, getStore)).body);
const check = (b, name) => b.checks.find((c) => c.name === name);

test("b1-env-check: 404 on every host but the branch deploy, and in any other context", async () => {
  for (const h of ["smartstagepro.com", "smart-stage-pro.netlify.app", "main--smart-stage-pro.netlify.app", "deploy-preview-219--smart-stage-pro.netlify.app", ""]) {
    assert.strictEqual((await call(h, isolated())).statusCode, 404, h);
  }
  assert.strictEqual((await call(BRANCH_HOST, { ...isolated(), CONTEXT: "production" })).statusCode, 404);
  assert.strictEqual((await call(BRANCH_HOST, { ...isolated(), BRANCH: "main" })).statusCode, 404);
});

test("b1-env-check: the placeholder literal never appears in the repository (Netlify secret scan)", () => {
  const fs = require("fs"), path = require("path");
  const lit = ["b1", "dev", "disabled"].join("-");
  for (const f of ["netlify/functions/b1-env-check.js", "tests/b1-env-check.test.js", "docs/b1-stage-b-infra-plan.md"]) {
    assert.ok(!fs.readFileSync(path.join(__dirname, "..", f), "utf8").includes(lit), f);
  }
  assert.strictEqual(PLACEHOLDER, lit);
});

test("b1-env-check: the approved placeholders count as cut off; an isolated branch passes; no value is ever returned", async () => {
  const r = await call(BRANCH_HOST, isolated());
  const b = JSON.parse(r.body);
  assert.strictEqual(b.ok, true, JSON.stringify(b.checks.filter((c) => !c.ok)));
  assert.strictEqual(check(b, "ANTHROPIC_API_KEY").state, "disabled");
  assert.strictEqual(check(b, "RAILWAY_RENDER_URL").state, "disabled");
  assert.strictEqual(check(b, "CLOUDINARY_API_SECRET").state, "disabled");
  assert.strictEqual(check(b, "AGENT_MARKETING_B1_EVIDENCE").state, "unset");
  assert.strictEqual(check(b, "SUPABASE_SERVICE_ROLE_KEY").state, "dev-project");
  for (const leak of [SECRET, "sig-NEVER-SHOWN", PLACEHOLDER, "\"site\""]) assert.ok(!r.body.includes(leak), `no value in the output: ${leak}`);
});

test("b1-env-check: a leaked production value fails, including legacy credentials and Blobs access", async () => {
  for (const name of ["ANTHROPIC_API_KEY", "NETLIFY_ACCESS_TOKEN", "S3_SECRET_ACCESS_KEY", "STRIPE_SECRET_KEY", "CLOUDINARY_API_SECRET", "MIGRATION_SECRET", "PABBLY_IMAGE_PACK_WEBHOOK_URL"]) {
    const b = await body({ ...isolated(), [name]: SECRET });
    assert.strictEqual(b.ok, false, name); assert.deepStrictEqual([check(b, name).state, check(b, name).ok], ["set", false], name);
  }
  const unsetLegacy = isolated(); delete unsetLegacy.CLOUDINARY_API_KEY;
  assert.strictEqual((await body(unsetLegacy)).ok, true, "an absent legacy variable is fine");
  const reach = await body(isolated(), openStore);
  assert.strictEqual(reach.ok, false); assert.strictEqual(reach.blobs.result, "reachable");
  assert.strictEqual((await body({ ...isolated(), AGENT_MARKETING_B1_EVIDENCE: "dev" })).ok, false, "Stage B must stay off");
});

test("b1-env-check: inbound-verification secrets must be private values, never the published placeholder", async () => {
  for (const name of PRIVATE_SECRETS) {
    for (const [v, state] of [[PLACEHOLDER, "placeholder"], ["", "empty"], [undefined, "unset"], ["short", "short"]]) {
      const env = isolated(); if (v === undefined) delete env[name]; else env[name] = v;
      const b = await body(env);
      assert.deepStrictEqual([b.ok, check(b, name).state], [false, state], `${name}=${state}`);
    }
  }
});

test("b1-env-check: Supabase must be the development project, URL and keys alike", async () => {
  for (const [over, name, state] of [
    [{ SUPABASE_URL: "https://dnpaenpwdhjmslymgkse.supabase.co" }, "SUPABASE_URL", "production-project"],
    [{ SSP_PUBLIC_SUPABASE_URL: "https://otherprojectrefxxxxx.supabase.co" }, "SSP_PUBLIC_SUPABASE_URL", "other"],
    [{ SUPABASE_SERVICE_ROLE_KEY: PROD_SERVICE }, "SUPABASE_SERVICE_ROLE_KEY", "production-project"],
    [{ SUPABASE_SERVICE_ROLE_KEY: DEV_ANON }, "SUPABASE_SERVICE_ROLE_KEY", "dev-project (role anon)"],
    [{ SSP_PUBLIC_SUPABASE_ANON_KEY: DEV_SERVICE }, "SSP_PUBLIC_SUPABASE_ANON_KEY", "dev-project (role service_role)"],
    [{ SUPABASE_SERVICE_ROLE_KEY: PLACEHOLDER }, "SUPABASE_SERVICE_ROLE_KEY", "disabled"]]) {
    const r = await call(BRANCH_HOST, { ...isolated(), ...over });
    const b = JSON.parse(r.body);
    assert.deepStrictEqual([b.ok, check(b, name).state], [false, state], name);
    assert.ok(!r.body.includes("sig-NEVER-SHOWN"));
  }
  const nonJwt = await body({ ...isolated(), SUPABASE_SERVICE_ROLE_KEY: "sb_secret_" + "x".repeat(40) });
  assert.strictEqual(nonJwt.ok, true, "a new-format key is accepted when the URL is the development project");
});

test("b1-env-check: call-back URLs must point at this branch; NETLIFY_URL may be absent", async () => {
  assert.strictEqual(check(await body({ ...isolated(), SITE_URL: "https://smartstagepro.com" }), "SITE_URL").ok, false);
  const env = isolated(); delete env.NETLIFY_URL;
  assert.strictEqual((await body(env)).ok, true);
});

test("b1-env-check: the log line carries names and states only", async () => {
  const lines = []; const keep = console.log; console.log = (m) => lines.push(String(m));
  try { await call(BRANCH_HOST, { ...isolated(), ANTHROPIC_API_KEY: SECRET, WEBHOOK_SECRET: PLACEHOLDER }); } finally { console.log = keep; }
  assert.strictEqual(lines.length, 1);
  assert.match(lines[0], /^b1-env-check FAIL checks=\d+ failing=\[ANTHROPIC_API_KEY:set,WEBHOOK_SECRET:placeholder\] blobs=blocked context=branch-deploy branch=b1-stageb-dev$/);
  assert.ok(!lines[0].includes(SECRET));
});

test("b1-env-check: the optional signing secrets may be absent (fail closed), never the placeholder", async () => {
  assert.deepStrictEqual(OPTIONAL_SECRETS, ["REEL_SHARE_SECRET", "PROMO_LINK_SECRET"]);
  const b = await body(isolated());   // isolated() leaves both absent, as on the site
  assert.strictEqual(b.ok, true, JSON.stringify(b.checks.filter((c) => !c.ok)));
  assert.strictEqual(check(b, "REEL_SHARE_SECRET").state, "unset (derived from the development service-role key)");
  assert.strictEqual(check(b, "PROMO_LINK_SECRET").state, "unset (endpoint refuses every request)");
  for (const name of OPTIONAL_SECRETS) {
    assert.deepStrictEqual([(await body({ ...isolated(), [name]: PLACEHOLDER })).ok, check(await body({ ...isolated(), [name]: PLACEHOLDER }), name).state], [false, "placeholder"], name);
    assert.strictEqual((await body({ ...isolated(), [name]: SECRET })).ok, true, `${name} private value`);
  }
  // an absent REEL_SHARE_SECRET is only safe while the service-role key is the development one
  const r = await body({ ...isolated(), SUPABASE_SERVICE_ROLE_KEY: PROD_SERVICE });
  assert.strictEqual(check(r, "REEL_SHARE_SECRET").ok, false);
});

