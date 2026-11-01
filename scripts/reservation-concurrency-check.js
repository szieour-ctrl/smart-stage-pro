#!/usr/bin/env node
// Proves the proposed atomic reservation (docs/proposed-migrations) against a THROWAWAY local Postgres. It never touches Supabase or any real database.
// Run:  npm i --no-save embedded-postgres pg   (once, outside package.json)   then   node scripts/reservation-concurrency-check.js
const fs = require("fs"), os = require("os"), path = require("path"), assert = require("assert");
const root = path.join(__dirname, "..");
const UP = fs.readFileSync(path.join(root, "docs/proposed-migrations/20261101_agent_marketing_provider_request_reservation.up.sql"), "utf8");
const DOWN = fs.readFileSync(path.join(root, "docs/proposed-migrations/20261101_agent_marketing_provider_request_reservation.down.sql"), "utf8");
const RESEARCH = fs.readFileSync(path.join(root, "supabase/migrations/20261024_agent_marketing_research.sql"), "utf8");
const STUBS = `create role service_role nologin; create role anon nologin; create role authenticated nologin;
 create table public.users (id uuid primary key); create table public.agent_marketing_projects (id uuid primary key default gen_random_uuid());
 grant usage on schema public to service_role, anon, authenticated;`;

(async () => {
  const EmbeddedPostgres = require("embedded-postgres").default || require("embedded-postgres"); const { Pool } = require("pg");
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pgres-"));
  if (process.getuid && process.getuid() === 0) {   // Postgres refuses to run as root: the library runs it as the "postgres" OS user, which must own the throwaway dir
    const cp = require("child_process"); try { cp.execSync("id -u postgres", { stdio: "ignore" }); } catch (_) { cp.execSync("groupadd postgres; useradd -g postgres postgres", { stdio: "ignore", shell: "/bin/bash" }); }
    fs.chownSync(dir, Number(cp.execSync("id -u postgres")), Number(cp.execSync("id -g postgres")));
  }
  const port = 54000 + Math.floor(Math.random() * 900);
  const server = new EmbeddedPostgres({ databaseDir: dir, user: "postgres", password: "pw", port, persistent: false, onLog: () => {}, onError: () => {} });
  await server.initialise(); await server.start();
  const pool = new Pool({ host: "localhost", port, user: "postgres", password: "pw", database: "postgres", max: 80 });
  const q = (sql, args) => pool.query(sql, args);
  const results = [];
  const check = async (name, fn) => { try { await fn(); results.push([name, "PASS"]); } catch (e) { results.push([name, "FAIL: " + e.message]); } };
  const uuid = () => (require("crypto").randomUUID());
  const reserve = (user, research, seq, d = 15, m = 100) => q("select public.agent_marketing_reserve_provider_request($1,$2,$3,$4,$5) as r", [user, research, seq, d, m]).then((x) => x.rows[0].r);
  const newUser = async () => { const id = uuid(); await q("insert into public.users(id) values ($1)", [id]); return id; };
  const newResearch = async (user, usage, status = "ready", ageSql = "now()") => { const id = uuid(), proj = uuid(); await q("insert into public.agent_marketing_projects(id) values ($1)", [proj]);
    await q(`insert into public.agent_marketing_research(id,project_id,user_id,mode,geography,audience,status,usage,created_at) values ($1,$2,$3,'market_update','{}','sellers',$4,$5,${ageSql})`, [id, proj, user, status, JSON.stringify(usage)]); return id; };
  const seedLedger = async (user, n, ageSql) => { for (let i = 1; i <= n; i++) await q(`insert into public.agent_marketing_provider_requests(user_id,research_id,seq,reserved_at) values ($1,null,$2,${ageSql})`, [user, i]); };
  const count = async (user) => Number((await q("select count(*) c from public.agent_marketing_provider_requests where user_id=$1", [user])).rows[0].c);
  try {
    await q(STUBS); await q(RESEARCH);
    const colsBefore = Number((await q("select count(*) c from information_schema.columns where table_name in ('agent_marketing_research','agent_marketing_projects','users')")).rows[0].c);
    await q(UP);
    await q("grant select, insert on all tables in schema public to service_role");   // stand-in for Supabase's default service_role privileges
    await check("migration is idempotent (applied twice)", async () => { await q(UP); });

    await check("50 simultaneous reservations against a 15 limit: exactly 15 allowed, 35 refused, 15 ledger rows", async () => {
      const u = await newUser(); const rs = await Promise.all(Array.from({ length: 50 }, (_, i) => reserve(u, null, i + 1)));
      assert.strictEqual(rs.filter((r) => r.allowed).length, 15); assert.strictEqual(rs.filter((r) => !r.allowed && r.scope === "daily").length, 35); assert.strictEqual(await count(u), 15);
    });
    await check("starting at 14/15: ten simultaneous sessions' requests -> exactly one is allowed", async () => {
      const u = await newUser(); await seedLedger(u, 14, "now() - interval '1 hour'"); const sessions = await Promise.all(Array.from({ length: 10 }, () => newResearch(u, { pathway: "article_led" }, "running"))); const rs = await Promise.all(sessions.map((r) => reserve(u, r, 1)));
      assert.strictEqual(rs.filter((r) => r.allowed).length, 1); assert.strictEqual(await count(u), 15);
    });
    await check("two users do not share or block each other's limits (20 each concurrently -> 15 each)", async () => {
      const a = await newUser(), b = await newUser(); const rs = await Promise.all([...Array.from({ length: 20 }, () => reserve(a, null, 1 + Math.floor(Math.random() * 1e6))), ...Array.from({ length: 20 }, () => reserve(b, null, 1 + Math.floor(Math.random() * 1e6)))]);
      assert.ok((await count(a)) <= 15 && (await count(b)) <= 15); assert.strictEqual(await count(a), 15); assert.strictEqual(await count(b), 15);
    });
    await check("a retried reservation call (same research and seq) is idempotent: one row, replayed=true", async () => {
      const u = await newUser(), r = await newResearch(u, { pathway: "article_led" }); const x = await reserve(u, r, 1), y = await reserve(u, r, 1);
      assert.ok(x.allowed && !x.replayed && y.allowed && y.replayed && x.reservation_id === y.reservation_id); assert.strictEqual(await count(u), 1);
    });
    await check("monthly limit binds on its own: 99/100 over three days -> one more allowed, then 'monthly'", async () => {
      const u = await newUser(); await seedLedger(u, 99, "now() - interval '3 days'"); const rs = await Promise.all(Array.from({ length: 5 }, (_, i) => reserve(u, null, 1000 + i)));
      assert.strictEqual(rs.filter((r) => r.allowed).length, 1); assert.ok(rs.filter((r) => !r.allowed).every((r) => r.scope === "monthly"));
    });
    await check("windows roll: 14 requests 25h old do not count against the daily limit; 40 requests 31 days old count for nothing", async () => {
      const u = await newUser(); await seedLedger(u, 14, "now() - interval '25 hours'"); const rs = await Promise.all(Array.from({ length: 20 }, (_, i) => reserve(u, null, 2000 + i)));
      assert.strictEqual(rs.filter((r) => r.allowed).length, 15);
      const v = await newUser(); await seedLedger(v, 40, "now() - interval '31 days'"); assert.ok((await reserve(v, null, 9999)).allowed);
    });
    await check("pre-ledger Article-Led rows count exactly like the application's requestsOf (providerRequests, else attempts, running >= 1, withdrawn 0)", async () => {
      const u = await newUser(); await q("update public.agent_marketing_provider_request_cutover set at = now() + interval '1 hour'");   // these rows stand for rows that predate the ledger
      await newResearch(u, { pathway: "article_led", providerRequests: 6 }); await newResearch(u, { pathway: "article_led", attempts: 3 }, "failed");
      await newResearch(u, { pathway: "article_led" }, "running"); await newResearch(u, { pathway: "article_led", providerRequests: 9, withdrawn: true }, "failed");
      await newResearch(u, { pathway: "legacy", providerRequests: 50 }); await newResearch(u, { pathway: "article_led", providerRequests: 40 }, "ready", "now() - interval '2 days'");
      // day = 6 + 3 + 1 = 10; legacy and withdrawn rows count 0; the 2-day-old row counts for the month only
      const first = await reserve(u, null, 1); assert.strictEqual(first.used_day, 11); assert.strictEqual(first.used_month, 51);
      const rs = await Promise.all(Array.from({ length: 10 }, (_, i) => reserve(u, null, 10 + i))); assert.strictEqual(rs.filter((r) => r.allowed).length, 4);   // 11 -> 15
      await q("update public.agent_marketing_provider_request_cutover set at = now() - interval '1 second'");
    });
    await check("a research row created AFTER the cutover is not double-counted before its first reservation: ten concurrent running sessions at 14/15 -> one allowed", async () => {
      const u = await newUser(); await seedLedger(u, 14, "now() - interval '1 hour'");
      const sessions = await Promise.all(Array.from({ length: 10 }, () => newResearch(u, { pathway: "article_led" }, "running")));
      const rs = await Promise.all(sessions.map((r) => reserve(u, r, 1))); assert.strictEqual(rs.filter((r) => r.allowed).length, 1); assert.strictEqual(await count(u), 15);
    });
    await check("a pre-cutover research row's own ledger rows replace its legacy count (no double counting)", async () => {
      await q("update public.agent_marketing_provider_request_cutover set at = now() + interval '1 hour'");
      const u = await newUser(), r = await newResearch(u, { pathway: "article_led", providerRequests: 5 }, "running"); const a = await reserve(u, r, 1);
      await q("update public.agent_marketing_provider_request_cutover set at = now() - interval '1 second'"); assert.strictEqual(a.used_day, 1);
    });
    await check("privileges: anon and authenticated cannot execute the function or read the ledger; service_role can", async () => {
      const u = await newUser(); const as = async (role, sql) => { const c = await pool.connect(); try { await c.query(`set role ${role}`); return await c.query(sql, [u]); } finally { await c.query("reset role"); c.release(); } };
      for (const role of ["anon", "authenticated"]) {
        await assert.rejects(as(role, "select public.agent_marketing_reserve_provider_request($1,null,1,15,100)"), /permission denied/);
        await assert.rejects(as(role, "select * from public.agent_marketing_provider_requests where user_id=$1"), /permission denied/);
      }
      assert.ok((await as("service_role", "select public.agent_marketing_reserve_provider_request($1,null,77,15,100) r")).rows[0].r.allowed);
      const rls = await q("select relrowsecurity from pg_class where oid = 'public.agent_marketing_provider_requests'::regclass"); assert.strictEqual(rls.rows[0].relrowsecurity, true);
    });
    await check("invalid arguments are rejected, not counted", async () => { const u = await newUser(); await assert.rejects(reserve(u, null, 0), /invalid reservation arguments/); await assert.rejects(reserve(u, null, 1, 0, 100), /invalid/); assert.strictEqual(await count(u), 0); });
    await check("deleting a research row does not release its usage (research_id is set null, the ledger row stays)", async () => {
      const u = await newUser(), r = await newResearch(u, { pathway: "article_led" }); await reserve(u, r, 1); await q("delete from public.agent_marketing_research where id=$1", [r]);
      assert.strictEqual(await count(u), 1);
    });
    await check("prune removes only rows older than the retention window", async () => {
      const u = await newUser(); await seedLedger(u, 3, "now() - interval '50 days'"); await reserve(u, null, 500); await q("select public.agent_marketing_prune_provider_requests()"); assert.strictEqual(await count(u), 1);
    });
    await check("existing tables are untouched by the migration (same columns and row counts as before)", async () => {
      const cols = Number((await q("select count(*) c from information_schema.columns where table_name in ('agent_marketing_research','agent_marketing_projects','users')")).rows[0].c); assert.strictEqual(cols, colsBefore);
    });
    await check("rollback removes everything the migration created, leaves the research table intact, and the migration can be re-applied", async () => {
      const before = Number((await q("select count(*) c from public.agent_marketing_research")).rows[0].c);
      await q(DOWN);
      const left = await q("select (select count(*) from pg_proc where proname like 'agent_marketing_%provider_request%' or proname='agent_marketing_safe_int') f, (select count(*) from information_schema.tables where table_name in ('agent_marketing_provider_requests','agent_marketing_provider_request_cutover')) t");
      assert.deepStrictEqual([Number(left.rows[0].f), Number(left.rows[0].t)], [0, 0]);
      assert.strictEqual(Number((await q("select count(*) c from public.agent_marketing_research")).rows[0].c), before);
      await q(DOWN); await q(UP); const u = await newUser(); assert.ok((await reserve(u, null, 1)).allowed);
    });
  } finally { await pool.end(); await server.stop(); fs.rmSync(dir, { recursive: true, force: true }); }
  for (const [n, r] of results) console.log((r === "PASS" ? "PASS  " : "FAIL  ") + n + (r === "PASS" ? "" : "\n      " + r));
  const failed = results.filter(([, r]) => r !== "PASS").length; console.log(`\n${results.length - failed}/${results.length} passed`); process.exit(failed ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(2); });
