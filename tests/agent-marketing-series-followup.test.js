// Run with: npm test — create_followup and series lineage through the project endpoint, with an in-memory fake database (no network). Nov 28, 2026.
const test = require("node:test");
const assert = require("node:assert");

const U1 = "11111111-1111-4111-8111-111111111111";
const U2 = "22222222-2222-4222-8222-222222222222";
let currentUser = U1, nextId = 1, tick = 0;
const db = { agent_marketing_projects: [], agent_marketing_jobs: [], agent_marketing_voices: [] };
const uuid = (n) => `dddddddd-dddd-4ddd-8ddd-${String(n).padStart(12, "0")}`;

// The fake understands the filters the endpoint uses: eq., in.(...), is.null, or=(a.eq.x,b.eq.y); and it enforces the migration's rules like the database does.
function matchOne(r, k, v) {
  if (v.startsWith("eq.")) return String(r[k]) === v.slice(3);
  if (v.startsWith("in.(")) return v.slice(4, -1).split(",").includes(String(r[k]));
  if (v === "is.null") return r[k] == null;
  return true;
}
function lineageCheck(row, rows) {
  if (row.source_project_id == null && row.series_root_project_id == null) return null;
  if (row.source_project_id == null || row.series_root_project_id == null) return "must be set together";
  if (row.source_project_id === row.id || row.series_root_project_id === row.id) return "self link";
  const src = rows.find((r) => r.id === row.source_project_id), root = rows.find((r) => r.id === row.series_root_project_id);
  if (!src || !root) return "not found";
  if (src.user_id !== row.user_id || root.user_id !== row.user_id) return "different owner";
  if (root.series_root_project_id) return "root is a follow-up";
  if (src.id !== root.id && src.series_root_project_id !== root.id) return "source not in series";
  return null;
}
function fakeSupabase(method, table, body, qs = "") {
  const rows = db[table];
  assert.ok(rows, "unexpected table " + table);
  const q = new URLSearchParams(String(qs).replace(/^\?/, ""));
  const matches = (r) => {
    for (const [k, v] of q.entries()) {
      if (["select", "order", "limit"].includes(k)) continue;
      if (k === "or") { const parts = v.slice(1, -1).split(","); if (!parts.some((p) => { const [col, op, val] = p.split("."); return String(r[col]) === val; })) return false; continue; }
      const m = k.match(/^(\w+)->>(\w+)$/);   // intake->>market=is.null: a JSON text field
      if (m) { const x = r[m[1]] && r[m[1]][m[2]]; const t = x == null ? null : typeof x === "object" ? JSON.stringify(x) : String(x); if (!matchOne({ [k]: t }, k, v)) return false; continue; }
      if (!matchOne(r, k, v)) return false;
    }
    return true;
  };
  if (method === "POST") {
    const row = { id: uuid(nextId++), created_at: new Date(1800000000000 + tick++ * 1000).toISOString(), updated_at: null, hidden_at: null, source_project_id: null, series_root_project_id: null, creation_key: null, ...body };
    if (table === "agent_marketing_projects") {
      if (row.creation_key && rows.some((r) => r.user_id === row.user_id && r.creation_key === row.creation_key)) return Promise.resolve({ status: 409, data: { code: "23505" } });
      const bad = lineageCheck(row, rows); if (bad) return Promise.resolve({ status: 400, data: { message: bad } });
    }
    rows.push(row); return Promise.resolve({ status: 201, data: [row] });
  }
  const found = rows.filter(matches);
  if (method === "GET") return Promise.resolve({ status: 200, data: found.slice().sort((a, b) => String(a.created_at).localeCompare(String(b.created_at))) });
  if (method === "PATCH") { found.forEach((r) => Object.assign(r, body)); return Promise.resolve({ status: 200, data: found }); }
  throw new Error("unexpected " + method);
}
const stub = (mod, exports) => { const p = require.resolve(mod); require.cache[p] = { id: p, filename: p, loaded: true, exports }; };
stub("../netlify/functions/lib/marketing-profile-lib", { supabase: fakeSupabase });
stub("../netlify/functions/lib/reel-auth-lib", { requireUser: async () => ({ user: { id: currentUser } }) });
const { handler } = require("../netlify/functions/agent-marketing-project");

const call = async (method, body, qs) => {
  const res = await handler({ httpMethod: method, headers: {}, body: body ? JSON.stringify(body) : null, queryStringParameters: qs || null });
  return { status: res.statusCode, json: JSON.parse(res.body) };
};
const reset = () => { Object.values(db).forEach((t) => (t.length = 0)); currentUser = U1; process.env.AGENT_MARKETING_ENABLED = "true"; delete process.env.AGENT_MARKETING_USER_IDS; };
const finish = (id, userId) => db.agent_marketing_jobs.push({ id: uuid(nextId++), project_id: id, user_id: userId || currentUser, status: "done", created_at: new Date(1800000000000 + tick++ * 1000).toISOString() });
const key = () => uuid(900000 + nextId++);
const create = async (template, intake, extra) => {
  const c = await call("POST", { action: "create", template, ...(extra || {}) });
  assert.strictEqual(c.status, 200, JSON.stringify(c.json));
  const s = await call("POST", { action: "save_intake", id: c.json.project.id, intake });
  assert.strictEqual(s.status, 200, JSON.stringify(s.json));
  return s.json.project;
};

test("Meet Your Agent: an introduction, a follow-up, and a third reel started from the second", async () => {
  reset();
  const ep1 = await create("meet_your_agent", { angle: "introduce", audience: "General audience", motivation: "Serving my community", clientStyle: "Warm and patient", firsthand: "Clients like that I explain each step." });
  assert.strictEqual(ep1.title, "Meet Your Agent");
  db.agent_marketing_projects.find((p) => p.id === ep1.id).narrative_approved = { editorialAngle: "Buying or selling is a personal decision, so the guide should be too.", captionText: "x" };

  // not finished: refused
  assert.strictEqual((await call("POST", { action: "create_followup", sourceId: ep1.id, creationKey: key() })).status, 409);
  finish(ep1.id);

  const k2 = key();
  const f2 = await call("POST", { action: "create_followup", sourceId: ep1.id, creationKey: k2 });
  assert.strictEqual(f2.status, 200, JSON.stringify(f2.json));
  const ep2 = f2.json.project;
  assert.strictEqual(ep2.sourceProjectId, ep1.id); assert.strictEqual(ep2.seriesRootProjectId, ep1.id);
  assert.strictEqual(ep2.status, "draft"); assert.strictEqual(ep2.narrative, null); assert.strictEqual(ep2.storyboard, null);
  assert.strictEqual(ep2.intake.audience, "General audience"); assert.strictEqual(ep2.intake.motivation, "Serving my community");
  assert.ok(!ep2.intake.angle && !ep2.intake.firsthand && !ep2.intake.topic, "angle, topic and firsthand input start fresh");
  assert.strictEqual(f2.json.recap.takeaway, "Buying or selling is a personal decision, so the guide should be too.");
  assert.strictEqual(f2.json.recap.title, "Meet Your Agent");
  assert.strictEqual(f2.json.recap.episodes.length, 1);

  // retry (double click / network failure): same draft, no second row
  const retry = await call("POST", { action: "create_followup", sourceId: ep1.id, creationKey: k2 });
  assert.strictEqual(retry.json.project.id, ep2.id); assert.strictEqual(retry.json.existing, true);
  assert.strictEqual(db.agent_marketing_projects.length, 2);

  // answer the fresh angle, keep the recap server-side
  const forged = await call("POST", { action: "save_intake", id: ep2.id, intake: { angle: "shaped", audience: "Sellers", firsthand: "I replaced rotted fascia before listing a home.", series_recap: { title: "forged" } } });
  assert.strictEqual(forged.status, 200, JSON.stringify(forged.json));
  assert.strictEqual(forged.json.project.intake.series_recap.title, "Meet Your Agent");
  assert.strictEqual(forged.json.project.title, "What shaped my approach");

  // episode three starts from episode two: source = episode two, root = the original
  finish(ep2.id);
  const f3 = await call("POST", { action: "create_followup", sourceId: ep2.id, creationKey: key() });
  assert.strictEqual(f3.status, 200, JSON.stringify(f3.json));
  const ep3 = f3.json.project;
  assert.strictEqual(ep3.sourceProjectId, ep2.id); assert.strictEqual(ep3.seriesRootProjectId, ep1.id);
  assert.deepStrictEqual(f3.json.recap.episodes.map((e) => e.id), [ep1.id, ep2.id]);
  assert.strictEqual(f3.json.recap.title, "What shaped my approach");
  const a = db.agent_marketing_projects.find((p) => p.id === ep1.id);
  assert.strictEqual(a.series_root_project_id, null, "the original has no lineage of its own");
  assert.ok(db.agent_marketing_jobs.filter((j) => j.project_id === ep2.id).length === 1, "the source keeps its own render history");
});

test("another subscriber cannot recall a project or attach a follow-up to it", async () => {
  reset();
  const ep1 = await create("your_buyer_advantage", { angle: "introduce", audience: "General buyers" });
  finish(ep1.id);
  currentUser = U2;
  assert.strictEqual((await call("POST", { action: "create_followup", sourceId: ep1.id, creationKey: key() })).status, 404);
  assert.strictEqual((await call("GET", null, { id: ep1.id })).status, 404);
  assert.strictEqual(db.agent_marketing_projects.length, 1);
});

test("the database rules reject a forged lineage (same owner, no self links, consistent root)", () => {
  const a = { id: "a", user_id: U1, series_root_project_id: null }, b = { id: "b", user_id: U2, series_root_project_id: null }, c = { id: "c", user_id: U1, series_root_project_id: "a" };
  const rows = [a, b, c];
  assert.strictEqual(lineageCheck({ id: "n", user_id: U1, source_project_id: "b", series_root_project_id: "b" }, rows), "different owner");
  assert.strictEqual(lineageCheck({ id: "n", user_id: U1, source_project_id: "n", series_root_project_id: "a" }, rows), "self link");
  assert.strictEqual(lineageCheck({ id: "n", user_id: U1, source_project_id: "a", series_root_project_id: "c" }, rows), "root is a follow-up");
  assert.strictEqual(lineageCheck({ id: "n", user_id: U1, source_project_id: "a" }, rows), "must be set together");
  assert.strictEqual(lineageCheck({ id: "n", user_id: U1, source_project_id: "c", series_root_project_id: "a" }, rows), null);
});

test("Your Buyer Advantage: broad introduction, a move-up episode, then a Buyer Pitfalls inspection episode", async () => {
  reset();
  const ep1 = await create("your_buyer_advantage", { angle: "introduce", audience: "General buyers", feel: "Prepared" });
  finish(ep1.id);
  const ep2 = (await call("POST", { action: "create_followup", sourceId: ep1.id, creationKey: key() })).json.project;
  assert.strictEqual(ep2.intake.feel, "Prepared");
  const s2 = await call("POST", { action: "save_intake", id: ep2.id, intake: { angle: "introduce", audience: "Move-up buyers" } });
  assert.strictEqual(s2.json.project.title, "Your Buyer Advantage for Move-Up Buyers");
  finish(ep2.id);
  const ep3 = (await call("POST", { action: "create_followup", sourceId: ep1.id, creationKey: key() })).json.project;
  assert.strictEqual(ep3.sourceProjectId, ep1.id); assert.strictEqual(ep3.seriesRootProjectId, ep1.id);
  const s3 = await call("POST", { action: "save_intake", id: ep3.id, intake: { angle: "pitfall", audience: "First-time buyers", topic: "Inspections", firsthand: "I sort the inspection report into must-fix, ask-the-specialist and monitor." } });
  assert.strictEqual(s3.status, 200, JSON.stringify(s3.json));
  assert.strictEqual(s3.json.project.title, "Buyer Pitfalls · Inspections");
  assert.strictEqual(s3.json.project.angle, "pitfall");
  // a focused angle without its topic and method is refused
  const bad = await call("POST", { action: "save_intake", id: ep3.id, intake: { angle: "pitfall", audience: "First-time buyers" } });
  assert.strictEqual(bad.status, 400);
});

test("the voice is checked again: a saved own voice that is gone falls back to SSP Male", async () => {
  reset();
  db.agent_marketing_voices.push({ user_id: U1 });
  const ep1 = await create("meet_your_agent", { angle: "introduce", audience: "Sellers" }, { voice: "custom" });
  assert.strictEqual(ep1.voice, "custom");
  finish(ep1.id);
  db.agent_marketing_voices.length = 0;
  const f = await call("POST", { action: "create_followup", sourceId: ep1.id, creationKey: key() });
  assert.strictEqual(f.json.project.voice, "ssp_male");
});

test("the project list says which reels can start a follow-up and how many episodes a series has", async () => {
  reset();
  const ep1 = await create("meet_your_agent", { angle: "introduce", audience: "Sellers" });
  const other = await create("why_list_with_me", { angle: "strategy", audience: "General sellers", topic: "Pricing", firsthand: "I price against active competition." });
  finish(ep1.id);
  const ep2 = (await call("POST", { action: "create_followup", sourceId: ep1.id, creationKey: key() })).json.project;
  const list = (await call("GET")).json.projects;
  const by = (id) => list.find((p) => p.id === id);
  assert.strictEqual(by(ep1.id).followupEligible, true); assert.strictEqual(by(ep1.id).episodeCount, 2);
  assert.strictEqual(by(ep2.id).followupEligible, false); assert.strictEqual(by(ep2.id).episodeCount, 2);
  assert.strictEqual(by(other.id).followupEligible, false); assert.strictEqual(by(other.id).episodeCount, 1);
  assert.strictEqual(by(ep1.id).reelType, "Meet Your Agent");
});

test("hide_drafts leaves a follow-up draft alone", async () => {
  reset();
  const ep1 = await create("meet_your_agent", { angle: "introduce", audience: "Sellers" });
  finish(ep1.id);
  const f = (await call("POST", { action: "create_followup", sourceId: ep1.id, creationKey: key() })).json.project;
  assert.strictEqual((await call("POST", { action: "hide_drafts" })).status, 200);
  assert.strictEqual(db.agent_marketing_projects.find((p) => p.id === f.id).hidden_at, null);
});
