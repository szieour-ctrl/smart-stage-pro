// Run with: npm test
// Per-deployment browser Supabase configuration (Nov 5, 2026): production values unchanged; any other deployment must be configured explicitly,
// use the same project as the server functions, never the production project, never a service-role key; otherwise the page stops.
const test = require("node:test");
const assert = require("node:assert");
const fs = require("fs");
const path = require("path");
const vm = require("vm");
const L = require("../netlify/functions/lib/public-config-lib");
const fn = require("../netlify/functions/public-config");

const ROOT = path.join(__dirname, "..");
const DEV_REF = "abcdefghijklmnopqrst";
const DEV_URL = `https://${DEV_REF}.supabase.co`;
const jwt = (payload) => `${Buffer.from('{"alg":"HS256","typ":"JWT"}').toString("base64url")}.${Buffer.from(JSON.stringify(payload)).toString("base64url")}.sig`;
const DEV_ANON = jwt({ iss: "supabase", ref: DEV_REF, role: "anon" });
const DEV_SERVICE = jwt({ iss: "supabase", ref: DEV_REF, role: "service_role" });
const devEnv = (over) => ({ SUPABASE_URL: DEV_URL, SUPABASE_SERVICE_ROLE_KEY: DEV_SERVICE, SSP_PUBLIC_SUPABASE_URL: DEV_URL, SSP_PUBLIC_SUPABASE_ANON_KEY: DEV_ANON, ...(over || {}) });
const PREVIEW = "deploy-preview-219--smart-stage-pro.netlify.app";

test("public config: production hosts get the exact production values the pages had hardcoded", () => {
  const html = fs.readFileSync(path.join(ROOT, "index.html"), "utf8");
  assert.ok(!html.includes(L.PRODUCTION_REF), "no project ref hardcoded in index.html any more");
  for (const h of L.PRODUCTION_HOSTS) {
    const r = L.publicConfig({ host: h, env: {} });   // no environment needed: production does not depend on new settings
    assert.ok(r.ok); assert.deepStrictEqual(r.config, L.PRODUCTION);
  }
  assert.strictEqual(L.keyInfo(L.PRODUCTION.supabaseAnonKey).kind, "anon");
  assert.strictEqual(L.keyInfo(L.PRODUCTION.supabaseAnonKey).ref, L.PRODUCTION_REF);
  // another production alias: Netlify's production URL, production context
  assert.ok(L.publicConfig({ host: "alias.example.com", env: { URL: "https://alias.example.com", CONTEXT: "production" } }).ok);
  assert.ok(!L.publicConfig({ host: "alias.example.com", env: { URL: "https://alias.example.com", CONTEXT: "deploy-preview" } }).ok);
});

test("public config: a correctly configured development deployment gets its own project, matching the server", () => {
  const r = L.publicConfig({ host: PREVIEW, env: devEnv() });
  assert.ok(r.ok, JSON.stringify(r));
  assert.deepStrictEqual(r.config, { env: "development", supabaseUrl: DEV_URL, supabaseAnonKey: DEV_ANON, projectRef: DEV_REF });
  assert.ok(L.publicConfig({ host: "localhost:8888", env: devEnv() }).ok);
  assert.ok(L.publicConfig({ host: PREVIEW, env: devEnv({ SSP_PUBLIC_SUPABASE_ANON_KEY: "sb_publishable_abc123" }) }).ok, "publishable keys are browser-safe");
});

test("public config: missing or inconsistent development configuration fails closed, never production", () => {
  const cases = [
    [{}, "unconfigured"],
    [devEnv({ SSP_PUBLIC_SUPABASE_URL: "" }), "unconfigured"],
    [devEnv({ SSP_PUBLIC_SUPABASE_ANON_KEY: "" }), "unconfigured"],
    [devEnv({ SSP_PUBLIC_SUPABASE_URL: "https://example.com" }), "bad_url"],
    [devEnv({ SSP_PUBLIC_SUPABASE_URL: L.PRODUCTION.supabaseUrl, SUPABASE_URL: L.PRODUCTION.supabaseUrl, SSP_PUBLIC_SUPABASE_ANON_KEY: L.PRODUCTION.supabaseAnonKey }), "production_refused"],
    [devEnv({ SUPABASE_URL: "https://zzzzzzzzzzzzzzzzzzzz.supabase.co" }), "mismatch"],          // browser and server would differ
    [devEnv({ SSP_PUBLIC_SUPABASE_ANON_KEY: jwt({ ref: "zzzzzzzzzzzzzzzzzzzz", role: "anon" }) }), "mismatch"],
    [devEnv({ SSP_PUBLIC_SUPABASE_ANON_KEY: DEV_SERVICE }), "secret_key_refused"],               // equals the service-role key
    [devEnv({ SSP_PUBLIC_SUPABASE_ANON_KEY: jwt({ ref: DEV_REF, role: "service_role" }) }), "secret_key_refused"],
    [devEnv({ SSP_PUBLIC_SUPABASE_ANON_KEY: "sb_secret_abc" }), "secret_key_refused"],
    [devEnv({ SSP_PUBLIC_SUPABASE_ANON_KEY: "not-a-key" }), "secret_key_refused"],
  ];
  for (const [env, code] of cases) {
    const r = L.publicConfig({ host: PREVIEW, env });
    assert.deepStrictEqual([r.ok, r.code], [false, code], JSON.stringify(env));
  }
});

test("public-config function: 200 with public values only, 503 otherwise; never a secret", async () => {
  const keep = { ...process.env };
  try {
    Object.assign(process.env, devEnv());
    const ok = await fn.handler({ httpMethod: "GET", headers: { host: PREVIEW } });
    assert.strictEqual(ok.statusCode, 200);
    assert.deepStrictEqual(Object.keys(JSON.parse(ok.body)).sort(), ["env", "projectRef", "supabaseAnonKey", "supabaseUrl"]);
    assert.ok(!ok.body.includes(DEV_SERVICE), "the service-role key never leaves the server");
    assert.strictEqual(ok.headers["Cache-Control"], "no-store");
    delete process.env.SSP_PUBLIC_SUPABASE_URL;
    const bad = await fn.handler({ httpMethod: "GET", headers: { host: PREVIEW } });
    assert.strictEqual(bad.statusCode, 503); assert.deepStrictEqual(JSON.parse(bad.body), { error: "unconfigured" });
    assert.strictEqual((await fn.handler({ httpMethod: "POST", headers: { host: PREVIEW } })).statusCode, 405);
  } finally { for (const k of Object.keys(process.env)) if (!(k in keep)) delete process.env[k]; Object.assign(process.env, keep); }
});

// The static browser script, run in a sandbox with a fake XMLHttpRequest.
function runStatic(host, reply) {
  const calls = [];
  const window = { location: { hostname: host } };
  class XHR { open(m, u, a) { calls.push({ m, u, a }); } send() { if (reply instanceof Error) throw reply; this.status = reply.status; this.responseText = reply.body; } }
  const document = { createElement: () => ({ setAttribute() {}, style: {}, textContent: "" }), body: { appendChild() {} } };
  vm.runInNewContext(fs.readFileSync(path.join(ROOT, "ssp-public-config.js"), "utf8"), { window, XMLHttpRequest: XHR, document, JSON, String, Object });
  return { window, calls };
}

test("static script: production values equal the server library's and need no request", () => {
  for (const h of L.PRODUCTION_HOSTS) {
    const { window, calls } = runStatic(h, null);
    assert.deepStrictEqual({ ...window.SSP_PUBLIC_CONFIG }, { ...L.PRODUCTION }); assert.strictEqual(calls.length, 0);
    assert.deepStrictEqual({ ...window.sspPublicConfig() }, { ...L.PRODUCTION });
  }
});

test("static script: development uses the server's answer synchronously; anything wrong stops the page", () => {
  const good = runStatic(PREVIEW, { status: 200, body: JSON.stringify({ env: "development", supabaseUrl: DEV_URL, supabaseAnonKey: DEV_ANON, projectRef: DEV_REF }) });
  assert.deepStrictEqual(good.calls, [{ m: "GET", u: "/.netlify/functions/public-config", a: false }]);
  assert.strictEqual(good.window.sspPublicConfig().supabaseUrl, DEV_URL);
  const bads = [
    { status: 503, body: '{"error":"unconfigured"}' },
    new Error("network down"),
    { status: 200, body: "not json" },
    { status: 200, body: JSON.stringify({ env: "development", supabaseUrl: L.PRODUCTION.supabaseUrl, supabaseAnonKey: L.PRODUCTION.supabaseAnonKey, projectRef: L.PRODUCTION_REF }) },
    { status: 200, body: JSON.stringify({ env: "development", supabaseUrl: "https://evil.example.com", supabaseAnonKey: "x", projectRef: DEV_REF }) },
  ];
  for (const b of bads) {
    const { window } = runStatic(PREVIEW, b);
    assert.ok(window.SSP_PUBLIC_CONFIG.error, JSON.stringify(b));
    assert.throws(() => window.sspPublicConfig(), /SSP public configuration unavailable/);
  }
});

// The real pages in Chromium (offline): routes serve the repo files under a chosen host; Supabase calls are recorded, never sent.
let chromium = null; try { ({ chromium } = require("playwright")); } catch (e) { /* not installed */ }
test("pages in a browser: production unchanged; a misconfigured preview stops and never contacts production", { skip: !chromium && "playwright not available", timeout: 120000 }, async () => {
  const browser = await chromium.launch();
  const SUPA_STUB = "window.supabase={createClient:function(u,k){window.__created={u:u,k:k};return{auth:{onAuthStateChange:function(){return{data:{subscription:{unsubscribe:function(){}}}}},getSession:async function(){return{data:{session:null}}},getUser:async function(){return{data:{user:null}}},signOut:async function(){}},from:function(){return{select:function(){return this},eq:function(){return this},single:async function(){return{data:null}}}}}}};";
  async function open(host, page, cfgReply) {
    const ctx = await browser.newContext(); const p = await ctx.newPage(); const supa = [];
    await ctx.route("**/*", async (route) => {
      const u = new URL(route.request().url());
      if (/\.supabase\.co$/.test(u.hostname)) { supa.push(u.hostname); return route.fulfill({ status: 200, contentType: "application/json", body: "{}" }); }
      if (u.hostname === "cdn.jsdelivr.net" && /supabase-js/.test(u.pathname)) return route.fulfill({ status: 200, contentType: "application/javascript", body: SUPA_STUB });
      if (u.hostname !== host) return route.fulfill({ status: 204, body: "" });
      if (u.pathname === "/.netlify/functions/public-config") return route.fulfill(cfgReply || { status: 503, contentType: "application/json", body: '{"error":"unconfigured"}' });
      if (u.pathname.startsWith("/.netlify/functions/")) return route.fulfill({ status: 401, contentType: "application/json", body: "{}" });
      const f = path.join(ROOT, u.pathname === "/" ? "index.html" : u.pathname);
      if (!f.startsWith(ROOT) || !fs.existsSync(f) || fs.statSync(f).isDirectory()) return route.fulfill({ status: 404, body: "" });
      return route.fulfill({ status: 200, contentType: f.endsWith(".js") ? "application/javascript" : f.endsWith(".html") ? "text/html" : "application/octet-stream", body: fs.readFileSync(f) });
    });
    await p.goto(`https://${host}/${page}`, { waitUntil: "domcontentloaded" }); await p.waitForTimeout(500);
    const state = await p.evaluate(() => ({ cfg: window.SSP_PUBLIC_CONFIG, created: window.__created || null, alert: !!document.querySelector('[role="alert"]') && /not configured for sign-in/.test(document.body.innerText),
      pageUrl: (() => { try { return SUPABASE_URL; } catch (e) { return null; } })() }));   // the page's own constant (null when the page stopped before it)
    await ctx.close();
    return { ...state, supa };
  }
  try {
    for (const page of ["index.html", "agent-marketing.html", "gallery.html"]) {
      const prod = await open("smartstagepro.com", page);
      assert.strictEqual(prod.cfg.env, "production", page); assert.strictEqual(prod.cfg.supabaseUrl, L.PRODUCTION.supabaseUrl, page);
      assert.strictEqual(prod.alert, false, `${page}: production page runs normally`);
      if (page === "index.html") assert.deepStrictEqual(prod.created, { u: L.PRODUCTION.supabaseUrl, k: L.PRODUCTION.supabaseAnonKey }, "the app's client uses exactly the production URL and key");
      if (page !== "agent-marketing.html") assert.strictEqual(prod.pageUrl, L.PRODUCTION.supabaseUrl, `${page}: SUPABASE_URL unchanged`);
      const off = await open(PREVIEW, page);
      assert.ok(off.cfg.error, `${page}: a preview without configuration has none`); assert.strictEqual(off.alert, true, `${page}: and says so`);
      assert.strictEqual(off.created, null, `${page}: no Supabase client is created`);
      assert.ok(!off.supa.some((h) => h.startsWith(L.PRODUCTION_REF)), `${page}: production is never contacted`);
      const dev = await open(PREVIEW, page, { status: 200, contentType: "application/json", body: JSON.stringify({ env: "development", supabaseUrl: DEV_URL, supabaseAnonKey: DEV_ANON, projectRef: DEV_REF }) });
      assert.strictEqual(dev.cfg.supabaseUrl, DEV_URL, page); assert.strictEqual(dev.alert, false, page);
      if (page === "index.html") assert.deepStrictEqual(dev.created, { u: DEV_URL, k: DEV_ANON }, "the dev client uses the dev project");
      if (page !== "agent-marketing.html") assert.strictEqual(dev.pageUrl, DEV_URL, page);
      assert.ok(!dev.supa.some((h) => h.startsWith(L.PRODUCTION_REF)), `${page}: a configured preview only talks to its own project`);
    }
  } finally { await browser.close(); }
});
