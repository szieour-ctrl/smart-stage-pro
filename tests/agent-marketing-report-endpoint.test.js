// End-to-end test of the report upload endpoint with an in-memory fake database (no network).
const test = require("node:test");
const assert = require("node:assert");
const fx = require("./helpers/cma-fixture");
const { pdfFromPages } = require("./helpers/make-pdf");

const U1 = "11111111-1111-4111-8111-111111111111";
const U2 = "22222222-2222-4222-8222-222222222222";
let currentUser = U1;
const db = { agent_marketing_projects: [], agent_marketing_uploads: [], agent_marketing_feedback: [] };
let nextId = 1;
const uuid = (n) => `cccccccc-cccc-4ccc-8ccc-${String(n).padStart(12, "0")}`;

function fakeSupabase(method, table, body, qs = "") {
  const rows = db[table];
  assert.ok(rows, "unexpected table " + table);
  const q = new URLSearchParams(String(qs).replace(/^\?/, ""));
  const matches = (r) => { for (const [k, v] of q.entries()) { if (["select", "order", "limit"].includes(k)) continue; if (v.startsWith("eq.")) { if (String(r[k]) !== v.slice(3)) return false; } else throw new Error("unsupported filter " + k); } return true; };
  if (method === "POST") { const row = { id: uuid(nextId++), created_at: new Date(Date.now() + nextId).toISOString(), updated_at: new Date().toISOString(), confirmed_at: null, ...body }; rows.push(row); return Promise.resolve({ status: 201, data: [row] }); }
  const found = rows.filter(matches);
  if (method === "GET") return Promise.resolve({ status: 200, data: found.slice().sort((a, b) => String(b.created_at).localeCompare(String(a.created_at))) });
  if (method === "PATCH") { found.forEach((r) => Object.assign(r, body)); return Promise.resolve({ status: 200, data: found }); }
  if (method === "DELETE") { found.forEach((r) => rows.splice(rows.indexOf(r), 1)); return Promise.resolve({ status: 204, data: [] }); }
  throw new Error("unexpected " + method);
}
const stub = (mod, exports) => { const p = require.resolve(mod); require.cache[p] = { id: p, filename: p, loaded: true, exports }; };
stub("../netlify/functions/lib/marketing-profile-lib", { supabase: fakeSupabase });
stub("../netlify/functions/lib/reel-auth-lib", { requireUser: async () => ({ user: { id: currentUser } }) });
const { handler } = require("../netlify/functions/agent-marketing-report");

const call = async (method, body, qs) => {
  const res = await handler({ httpMethod: method, headers: {}, body: body ? JSON.stringify(body) : null, queryStringParameters: qs || null });
  return { status: res.statusCode, json: JSON.parse(res.body) };
};
const mkProject = (over) => { const row = { id: uuid(nextId++), user_id: currentUser, template: "local_market_insider", status: "draft", intake: {}, ...over }; db.agent_marketing_projects.push(row); return row; };
const reset = () => { db.agent_marketing_projects.length = 0; db.agent_marketing_uploads.length = 0; db.agent_marketing_feedback.length = 0; currentUser = U1; process.env.AGENT_MARKETING_ENABLED = "true"; };
let pdfB64 = null;
const cmaB64 = async () => (pdfB64 = pdfB64 || (await pdfFromPages(fx.standard().pages)).toString("base64"));
const upload = async (p, over) => call("POST", { action: "upload", projectId: p.id, fileName: "Smith CMA.pdf", fileBase64: await cmaB64(), permission: true, ...over });

test("switch off: every call answers 404", async () => {
  reset(); delete process.env.AGENT_MARKETING_ENABLED;
  assert.strictEqual((await call("GET", null, { projectId: uuid(1) })).status, 404);
  assert.strictEqual((await call("POST", { action: "upload" })).status, 404);
});

test("schema: the page reads the permission wording and limits from the server", async () => {
  reset();
  const r = await call("GET", null, { schema: "1" });
  assert.strictEqual(r.status, 200);
  assert.match(r.json.permissionText, /permitted to use this data in my marketing/);
  assert.strictEqual(r.json.maxBytes, 4 * 1024 * 1024);
  assert.deepStrictEqual(r.json.accepts, ["pdf", "csv", "xlsx"]);
});

test("the permission checkbox is required: without it nothing is read or stored", async () => {
  reset(); const p = mkProject();
  for (const permission of [undefined, false, "true", 1]) {
    const r = await upload(p, { permission });
    assert.strictEqual(r.status, 400); assert.strictEqual(r.json.code, "permission_required");
  }
  assert.strictEqual(db.agent_marketing_uploads.length, 0);
});

test("upload stores only the figures: not the file, not its text, not its name, no addresses or contact details", async () => {
  reset(); const p = mkProject();
  const r = await upload(p, { geography: { type: "city", name: "Roseville" } });
  assert.strictEqual(r.status, 201, JSON.stringify(r.json));
  assert.strictEqual(r.json.upload.status, "pending");
  assert.match(r.json.upload.summary.scopeSentence, /^This MetroList report covers Roseville/);
  assert.strictEqual(r.json.upload.summary.geography, "match");
  assert.ok(r.json.upload.summary.groups.length >= 3);
  const row = db.agent_marketing_uploads[0];
  assert.strictEqual(row.user_id, U1); assert.strictEqual(row.project_id, p.id);
  assert.strictEqual(row.file_kind, "pdf"); assert.ok(row.file_bytes > 1000);
  assert.strictEqual(row.permission_version, "agent-marketing-report-1"); assert.ok(row.permission_at);
  assert.ok(!/\$/.test(row.scope_note), "no prices in the note for the provider");
  const stored = JSON.stringify(row);
  for (const s of ["Smith", "Pat Fixture", "916-555", "example.com", "Alder", "Birch", "1007", await cmaB64(), "%PDF"]) assert.ok(!stored.includes(s), `stored row must not contain "${String(s).slice(0, 20)}"`);
  assert.ok(stored.length < 25000);
});

test("a report for a different place than the one chosen is called out", async () => {
  reset(); const p = mkProject();
  const r = await upload(p, { geography: { type: "city", name: "Folsom" } });
  assert.strictEqual(r.json.upload.summary.geography, "different");
  assert.ok(r.json.upload.summary.warnings.some((w) => /names Roseville, not Folsom/.test(w)));
});

test("confirm makes it usable; 'not right' deletes it; remove deletes it", async () => {
  reset(); const p = mkProject();
  const id = (await upload(p)).json.upload.id;
  assert.strictEqual((await call("POST", { action: "confirm", uploadId: id })).status, 400, "must say correct true or false");
  const ok = await call("POST", { action: "confirm", uploadId: id, correct: true });
  assert.strictEqual(ok.status, 200); assert.strictEqual(ok.json.upload.status, "confirmed"); assert.ok(db.agent_marketing_uploads[0].confirmed_at);
  const id2 = (await upload(p)).json.upload.id;
  const no = await call("POST", { action: "confirm", uploadId: id2, correct: false });
  assert.deepStrictEqual(no.json, { removed: true });
  assert.ok(!db.agent_marketing_uploads.some((x) => x.id === id2));
  const id3 = (await upload(p)).json.upload.id;
  assert.deepStrictEqual((await call("POST", { action: "remove", uploadId: id3 })).json, { removed: true });
  assert.strictEqual(db.agent_marketing_uploads.length, 1);
});

test("only the owner can see, confirm or remove a report", async () => {
  reset(); const p = mkProject();
  const id = (await upload(p)).json.upload.id;
  currentUser = U2;
  assert.strictEqual((await call("POST", { action: "confirm", uploadId: id, correct: true })).status, 404);
  assert.strictEqual((await call("POST", { action: "remove", uploadId: id })).status, 404);
  assert.strictEqual((await call("GET", null, { projectId: p.id })).status, 404);
  assert.strictEqual((await upload(p)).status, 404);
  assert.strictEqual(db.agent_marketing_uploads.length, 1);
});

test("limits: three reports per project, Local Market Insider only, nothing after rendering starts", async () => {
  reset(); const p = mkProject();
  for (let i = 0; i < 3; i++) assert.strictEqual((await upload(p)).status, 201);
  const fourth = await upload(p);
  assert.strictEqual(fourth.status, 409); assert.strictEqual(fourth.json.code, "too_many");
  const other = mkProject({ template: "meet_your_agent" });
  assert.strictEqual((await upload(other)).status, 409);
  const rendering = mkProject({ status: "rendering" });
  assert.strictEqual((await upload(rendering)).status, 409);
});

test("bad files get plain errors and store nothing", async () => {
  reset(); const p = mkProject();
  const bad = await call("POST", { action: "upload", projectId: p.id, fileName: "x.pdf", fileBase64: Buffer.from("%PDF-1.4 not a pdf").toString("base64"), permission: true });
  assert.strictEqual(bad.status, 422); assert.strictEqual(bad.json.code, "unreadable"); assert.ok(!/\.js/.test(bad.json.error));
  const xls = await call("POST", { action: "upload", projectId: p.id, fileName: "x.xls", fileBase64: Buffer.from([0xd0, 0xcf, 0x11, 0xe0, 1, 2, 3, 4]).toString("base64"), permission: true });
  assert.strictEqual(xls.status, 422); assert.strictEqual(xls.json.code, "xls");
  const none = await call("POST", { action: "upload", projectId: p.id, fileName: "x.pdf", fileBase64: "", permission: true });
  assert.strictEqual(none.status, 400);
  const huge = await call("POST", { action: "upload", projectId: p.id, fileName: "x.pdf", fileBase64: "A".repeat(6 * 1024 * 1024), permission: true });
  assert.strictEqual(huge.status, 413); assert.strictEqual(huge.json.code, "too_big");
  assert.strictEqual(db.agent_marketing_uploads.length, 0);
});

test("GET lists this project's reports newest first, with the confirmation summary", async () => {
  reset(); const p = mkProject(); const q = mkProject();
  await upload(p); await upload(p); await upload(q);
  const r = await call("GET", null, { projectId: p.id });
  assert.strictEqual(r.json.uploads.length, 2);
  assert.ok(r.json.uploads.every((u) => u.projectId === p.id && /MetroList report/.test(u.summary.scopeSentence)));
});

test("'not right' with a note: the reasons and note are kept with a file-free context, then the report is removed", async () => {
  reset();
  const p = mkProject();
  const up = (await upload(p)).json.upload;
  const bad = await call("POST", { action: "feedback", uploadId: up.id, reasons: [], message: "  " });
  assert.strictEqual(bad.status, 400);
  assert.strictEqual(db.agent_marketing_uploads.length, 1, "nothing removed without a reason or a note");
  const r = await call("POST", { action: "feedback", uploadId: up.id, reasons: ["wrong_area", "wrong_dates", "made_up", "wrong_area"], message: "This is North Natomas,\n95835, last 90 days. " + "x".repeat(900) });
  assert.strictEqual(r.status, 200);
  assert.deepStrictEqual([r.json.removed, r.json.saved], [true, true]);
  assert.strictEqual(db.agent_marketing_uploads.length, 0);
  assert.strictEqual(db.agent_marketing_feedback.length, 1);
  const fb = db.agent_marketing_feedback[0];
  assert.deepStrictEqual(fb.reasons, ["wrong_area", "wrong_dates"]);
  assert.ok(fb.message.length <= 600 && fb.message.startsWith("This is North Natomas, 95835, last 90 days."));
  assert.strictEqual(fb.stage, "report");
  assert.match(fb.context.scope, /^This MetroList report covers Roseville/);
  const json = JSON.stringify(fb);
  for (const x of [...fx.FAKE.streets.map((st) => st.split(" ")[0]), "Smith", "916-555", "@"]) assert.ok(!json.includes(x), `feedback must not contain "${x}"`);
});

test("only the owner can send a note about a report", async () => {
  reset();
  const p = mkProject();
  const up = (await upload(p)).json.upload;
  currentUser = U2;
  assert.strictEqual((await call("POST", { action: "feedback", uploadId: up.id, reasons: ["other"] })).status, 404);
  assert.strictEqual(db.agent_marketing_feedback.length, 0);
  assert.strictEqual(db.agent_marketing_uploads.length, 1);
});
