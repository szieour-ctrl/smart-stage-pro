// Run with: npm test
// Development deploys sit behind Netlify team login, so the render endpoint cannot call agent-marketing-prepare-background itself there:
// the page starts it with the subscriber's own login token (Nov 9, 2026). Production keeps its server-to-server dispatch unchanged.
"use strict";
const test = require("node:test");
const assert = require("node:assert");

Object.assign(process.env, { S3_REGION: "us-west-2", S3_BUCKET_NAME: "b", S3_ACCESS_KEY_ID: "k", S3_SECRET_ACCESS_KEY: "s", RAILWAY_RENDER_URL: "https://railway.test",
  RAILWAY_SECRET: "rs", INTERNAL_API_KEY: "ik", AGENT_MARKETING_ENABLED: "true", URL: "https://site.test" });

const U1 = "11111111-1111-4111-8111-111111111111", U2 = "22222222-2222-4222-8222-222222222222";
const P1 = "aaaaaaaa-aaaa-4aaa-8aaa-000000000001";
const db = { agent_marketing_projects: [], agent_marketing_jobs: [] };
function fake(method, table, body, qs = "") {
  const q = new URLSearchParams(qs.replace(/^\?/, "")); const t = db[table];
  const keep = (r, k) => { const v = q.get(k); if (!v) return true; if (v.startsWith("in.(")) return v.slice(4, -1).split(",").includes(String(r[k])); return String(r[k]) === v.replace(/^eq\./, ""); };
  const rows = t.filter((r) => ["id", "user_id", "project_id", "status"].every((k) => keep(r, k)));
  if (method === "POST") { t.push({ ...body }); return Promise.resolve({ status: 201, data: [body] }); }
  if (method === "PATCH") { rows.forEach((r) => Object.assign(r, body)); return Promise.resolve({ status: 200, data: rows }); }
  return Promise.resolve({ status: 200, data: rows });
}
const stub = (rel, exports) => { const p = require.resolve(rel); require.cache[p] = { id: p, filename: p, loaded: true, exports }; };
stub("../netlify/functions/lib/marketing-profile-lib", { supabase: fake });
let currentUser = U1;
stub("../netlify/functions/lib/reel-auth-lib", { requireUser: async () => ({ user: { id: currentUser } }) });
const fetched = [];
global.fetch = async (url) => { fetched.push(String(url)); return { ok: true, status: 202 }; };

const render = require("../netlify/functions/agent-marketing-render");
const prepare = require("../netlify/functions/agent-marketing-prepare-background");
const call = async (host, body) => { const r = await render.handler({ httpMethod: "POST", headers: { host }, body: JSON.stringify(body) }); return { status: r.statusCode, json: JSON.parse(r.body) }; };
const DEV = { AGENT_MARKETING_B1_EVIDENCE: "dev", SUPABASE_URL: "https://abcdefghijklmnopqrst.supabase.co" };
const withEnv = async (vars, fn) => { const old = {}; for (const k of Object.keys(vars)) { old[k] = process.env[k]; process.env[k] = vars[k]; } try { return await fn(); } finally { for (const k of Object.keys(old)) { if (old[k] === undefined) delete process.env[k]; else process.env[k] = old[k]; } } };
const reset = () => { db.agent_marketing_jobs.length = 0; db.agent_marketing_projects.length = 0; fetched.length = 0;
  db.agent_marketing_projects.push({ id: P1, user_id: U1, formats: ["9x16"], music: "default", narrative_approved_at: "2026-11-09T00:00:00Z", status: "narrative_approved" }); };

test("production: the render endpoint starts preparation server to server, as before", async () => {
  reset();
  await withEnv({ AGENT_MARKETING_B1_EVIDENCE: "", SUPABASE_URL: "https://dnpaenpwdhjmslymgkse.supabase.co" }, async () => {
    const r = await call("smartstagepro.com", { projectId: P1, formats: ["9x16"], advertisingConfirmed: true });
    assert.strictEqual(r.status, 200, JSON.stringify(r.json));
    assert.strictEqual(r.json.dispatch, undefined);
    assert.ok(fetched.some((u) => u.endsWith("/.netlify/functions/agent-marketing-prepare-background")));
  });
});

test("development deploy: no server-to-server call; the page is told to start preparation, a queued job can be started again, and the job only accepts its owner's login", async () => {
  reset();
  await withEnv(DEV, async () => {
    const host = "b1-stageb-dev--smart-stage-pro.netlify.app";
    const r = await call(host, { projectId: P1, formats: ["9x16"], advertisingConfirmed: true });
    assert.strictEqual(r.status, 200, JSON.stringify(r.json));
    assert.strictEqual(r.json.dispatch, true);
    assert.strictEqual(fetched.length, 0, "nothing is dispatched server to server");
    // the page's start never arrived: the queued job can be started again (development only)
    const again = await call(host, { jobId: r.json.jobId, retry: true });
    assert.deepStrictEqual([again.status, again.json.dispatch], [200, true]);
    // prepare-background: someone else's login is refused; without a login, 401; on the production host, 401
    currentUser = U2;
    assert.strictEqual((await prepare.handler({ headers: { host }, body: JSON.stringify({ jobId: r.json.jobId }) })).statusCode, 404);
    currentUser = U1;
    assert.strictEqual((await prepare.handler({ headers: { host: "smartstagepro.com" }, body: JSON.stringify({ jobId: r.json.jobId }) })).statusCode, 401);
  });
  // outside development a queued job still cannot be retried
  await withEnv({ AGENT_MARKETING_B1_EVIDENCE: "", SUPABASE_URL: "https://dnpaenpwdhjmslymgkse.supabase.co" }, async () => {
    const job = db.agent_marketing_jobs[0];
    assert.strictEqual((await call("smartstagepro.com", { jobId: job.id, retry: true })).status, 409);
  });
});
