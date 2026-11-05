// Run with: npm test
// Step 2 (Nov 5, 2026): production isolation. Background jobs stay on the deploy that received the request; production routing is unchanged;
// development configuration fails closed. No network: fetch is stubbed.
const test = require("node:test");
const assert = require("node:assert");
const fs = require("fs");
const path = require("path");
const { selfBase } = require("../netlify/functions/lib/self-dispatch-lib");
const L = require("../netlify/functions/lib/public-config-lib");
const run = require("../netlify/functions/lib/agent-marketing-b1-stageb-run-lib");
const stagebFn = require("../netlify/functions/agent-marketing-stageb");

const FN = path.join(__dirname, "..", "netlify", "functions");
const ev = (host) => ({ headers: host == null ? {} : { host } });
const PREVIEW = "deploy-preview-219--smart-stage-pro.netlify.app", BRANCH = "b1-stageb-dev--smart-stage-pro.netlify.app";

test("self-dispatch: production hosts keep each call site's exact existing value (routing unchanged)", () => {
  const legacies = ["https://smartstagepro.com", "https://smart-stage-pro.netlify.app", undefined, "", "https://x.example"];
  for (const h of [...L.PRODUCTION_HOSTS, "SmartStagePro.com"]) for (const legacy of legacies) assert.strictEqual(selfBase(ev(h), legacy, {}), legacy, `${h} ${legacy}`);
  for (const legacy of legacies) assert.strictEqual(selfBase(ev(null), legacy, {}), legacy, "no request host: unchanged");
});

test("self-dispatch: previews, branch deploys and local dev use their own deploy, never URL / SITE_URL / NETLIFY_URL", () => {
  const prodEnv = { URL: "https://smartstagepro.com", SITE_URL: "https://smartstagepro.com", NETLIFY_URL: "https://smart-stage-pro.netlify.app" };
  assert.strictEqual(selfBase(ev(PREVIEW), "https://smartstagepro.com", prodEnv), `https://${PREVIEW}`);
  assert.strictEqual(selfBase(ev(BRANCH), "https://smart-stage-pro.netlify.app", prodEnv), `https://${BRANCH}`);
  assert.strictEqual(selfBase(ev("6af0123abc--smart-stage-pro.netlify.app"), "https://smartstagepro.com", prodEnv), "https://6af0123abc--smart-stage-pro.netlify.app");
  assert.strictEqual(selfBase(ev("localhost:8888"), "http://localhost:8888", {}), "http://localhost:8888");
  for (const bad of ["evil.com/x", "a b", "-x.netlify.app", "x@y"]) assert.throws(() => selfBase(ev(bad), "https://smartstagepro.com", prodEnv), (e) => e.code === "dispatch_host_invalid", bad);
});

test("self-dispatch: every background dispatcher in the repository goes through selfBase", () => {
  const files = fs.readdirSync(FN).filter((f) => f.endsWith(".js") && !f.endsWith("-background.js"));
  const dispatchers = files.filter((f) => /\.netlify\/functions\/[A-Za-z0-9-]*(-background|\$\{functionName\})/.test(fs.readFileSync(path.join(FN, f), "utf8")));
  assert.ok(dispatchers.length >= 10, `found ${dispatchers.length}`);
  for (const f of dispatchers) {
    const src = fs.readFileSync(path.join(FN, f), "utf8");
    const viaHost = /const siteUrl = hostHeader\s*\?\s*`https:\/\/\$\{hostHeader\}`/.test(src);   // declutter-prompt: already uses the request host
    assert.ok(/selfBase\(/.test(src) || viaHost, `${f} dispatches a background job without selfBase`);
    assert.ok(!/fetch\(`\$\{process\.env\.(URL|SITE_URL|NETLIFY_URL)\}\/\.netlify\/functions\/[a-z0-9-]+-background/.test(src), `${f} dispatches straight to a production URL`);
  }
});

test("Stage B dispatch: its own deploy only; refused on a production host even if everything else is wrong", async () => {
  const U = "aaaaaaaa-0000-4000-8000-000000000001", P = "22222222-0000-4000-8000-0000000000a1";
  const project = { id: P, user_id: U, template: "local_market_insider", selected_research_id: "11111111-0000-4000-8000-000000000001",
    selected_topic: { id: "t", researchId: "11111111-0000-4000-8000-000000000001", candidate: { id: "c" }, sources: [] } };
  const env = { AGENT_MARKETING_B1_EVIDENCE: "dev", AGENT_MARKETING_ENABLED: "true", B1_STAGEB_USER_IDS: U, SUPABASE_URL: "https://abcdefghijklmnopqrst.supabase.co",
    INTERNAL_API_KEY: "k", URL: "https://smartstagepro.com", SITE_URL: "https://smartstagepro.com" };   // URL names production, as on Netlify
  const store = { async findForProject() { return null; } };
  const calls = []; const keep = global.fetch;
  global.fetch = async (url, opts) => { calls.push(url); return { ok: true, status: 202 }; };
  try {
    const call = (host) => stagebFn.handler({ httpMethod: "POST", headers: { host, authorization: "Bearer t" }, body: JSON.stringify({ action: "start", projectId: P }) }, {},
      { env, store, loadProject: async () => project, requireUser: async () => ({ user: { id: U } }) });
    const ok = await call(BRANCH);
    assert.deepStrictEqual([ok.statusCode, JSON.parse(ok.body).state], [202, "queued"]);
    assert.deepStrictEqual(calls, [`https://${BRANCH}/.netlify/functions/agent-marketing-stageb-background`], "the branch deploy's own background function");
    for (const h of ["smartstagepro.com", "smart-stage-pro.netlify.app", "main--smart-stage-pro.netlify.app"]) {
      const r = await call(h);
      assert.deepStrictEqual([r.statusCode, JSON.parse(r.body).code], [503, "production_dispatch_refused"], h);
    }
    assert.strictEqual(calls.length, 1, "nothing was ever sent to production");
  } finally { global.fetch = keep; }
});

test("fail closed: missing development configuration stops Stage B before anything is written or sent", async () => {
  const U = "aaaaaaaa-0000-4000-8000-000000000001";
  const base = { AGENT_MARKETING_B1_EVIDENCE: "dev", AGENT_MARKETING_ENABLED: "true", B1_STAGEB_USER_IDS: U, SUPABASE_URL: "https://abcdefghijklmnopqrst.supabase.co" };
  assert.strictEqual(run.admit(U, base), null);
  assert.strictEqual(run.admit(U, { ...base, SUPABASE_URL: "" }).code, "production_database_refused", "no database configured");
  assert.strictEqual(run.admit(U, { ...base, SUPABASE_URL: `https://${L.PRODUCTION_REF}.supabase.co` }).status, 503, "never the production database");
  assert.strictEqual(run.admit(U, { ...base, B1_STAGEB_USER_IDS: undefined }).status, 404, "a missing allowlist denies");
  assert.strictEqual(run.admit(U, { ...base, B1_STAGEB_USER_IDS: "" }).status, 404, "an empty allowlist denies");
  assert.strictEqual(run.admit(U, { ...base, AGENT_MARKETING_B1_EVIDENCE: undefined }).status, 404, "the flag is off by default");
  // no INTERNAL_API_KEY: the start refuses (no dispatch possible)
  const r = await stagebFn.handler({ httpMethod: "POST", headers: { host: BRANCH }, body: JSON.stringify({ action: "start", projectId: "22222222-0000-4000-8000-0000000000a1" }) }, {},
    { env: base, store: {}, loadProject: async () => null, requireUser: async () => ({ user: { id: U } }) });
  assert.deepStrictEqual([r.statusCode, JSON.parse(r.body).code], [503, "not_configured"]);
  // no worker configured: the job stops at the snapshot; no row, no reservation, no provider call
  const writes = []; const store = { async findForProject() { return null; }, async insert(x) { writes.push(x); }, async update(...a) { writes.push(a); }, async reserveProvider(x) { writes.push(x); } };
  const provider = { calls: 0, async call() { this.calls++; } };
  const project = { id: "22222222-0000-4000-8000-0000000000a1", user_id: U, template: "local_market_insider", selected_topic: { id: "t", researchId: "11111111-0000-4000-8000-000000000001", candidate: { id: "c" },
    sources: [{ url: "https://example.org/a", role: "primary" }] } };
  const out = await run.runJob({ userId: U, projectId: project.id, store, loadProject: async () => project, provider, env: base,
    fetchFn: async (url) => ({ status: 200, url, headers: { get: () => "text/html" }, arrayBuffer: async () => Buffer.from("<html><body>" + "word ".repeat(600) + "</body></html>") }) });
  assert.deepStrictEqual(out, { state: "failed", code: "not_configured" });
  assert.deepStrictEqual(writes, []); assert.strictEqual(provider.calls, 0);
});

test("fail closed: no service-role or secret key in any browser-served file; previews never get production Supabase", () => {
  const root = path.join(__dirname, "..");
  const browser = fs.readdirSync(root).filter((f) => /\.(html|js)$/.test(f));
  for (const f of browser) {
    const s = fs.readFileSync(path.join(root, f), "utf8");
    for (const m of s.matchAll(/eyJ[A-Za-z0-9_-]{10,}\.eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}/g)) assert.notStrictEqual(L.keyInfo(m[0]).kind, "service_role", `${f} ships a service-role key`);
    assert.ok(!/sb_secret_|SUPABASE_SERVICE_ROLE_KEY\s*[:=]\s*["'`]/.test(s), `${f} references a secret key`);
  }
  const r = L.publicConfig({ host: PREVIEW, env: { SUPABASE_URL: L.PRODUCTION.supabaseUrl, SSP_PUBLIC_SUPABASE_URL: L.PRODUCTION.supabaseUrl, SSP_PUBLIC_SUPABASE_ANON_KEY: L.PRODUCTION.supabaseAnonKey } });
  assert.deepStrictEqual([r.ok, r.code], [false, "production_refused"], "a preview configured with production values is refused");
  assert.deepStrictEqual([L.publicConfig({ host: PREVIEW, env: {} }).ok], [false], "an unconfigured preview gets nothing");
});
