// agent-marketing-stageb-background.js — Netlify Background Function (15 min). DEVELOPMENT ONLY. The Stage B job:
// snapshot → atomic ledger reservation → provider (MOCK ONLY: the paid call is not implemented) → Python evidence gate via the worker → attach.
//
// Nov 7, 2026: started BY THE PAGE, not by another function. POST { projectId } with the user's own Supabase login token (Authorization: Bearer).
//   - The user is the token's user (verified against Supabase on every call). A userId in the body is ignored; there is no internal key.
//   - Same admission as the start request (lib/agent-marketing-b1-stageb-run-lib.js): AGENT_MARKETING_B1_EVIDENCE=dev, Agent Marketing enabled,
//     the explicit B1_STAGEB_USER_IDS allowlist, a non-production database, the project owned by this user, an Article-Led topic.
//   - Refused outright on a production host.
// A background function answers 202 to the page before this runs; the page learns the outcome from GET agent-marketing-stageb?projectId=.
// Nov 8, 2026: { projectId, mode: "script" } runs "Write my script" (scriptJob): evidence first, then the planning run, which writes the narrative the
// page polls through agent-marketing-project. The source re-check mode (verify_source) was removed; its attempt rows are kept.
const { supabase } = require("./lib/marketing-profile-lib");
const { requireUser } = require("./lib/reel-auth-lib");
const run = require("./lib/agent-marketing-b1-stageb-run-lib");
const st = require("./lib/agent-marketing-b1-store-lib");
const pv = require("./lib/agent-marketing-b1-provider-lib");
const am = require("./lib/agent-marketing-lib");

async function loadProject(id, userId) {
  const r = await supabase("GET", "agent_marketing_projects", null, `?id=eq.${encodeURIComponent(id)}&user_id=eq.${encodeURIComponent(userId)}&select=*&limit=1`);
  return Array.isArray(r.data) && r.data[0] ? r.data[0] : null;
}

exports.handler = async (event, context, deps) => {
  const d = deps || {};   // tests inject requireUser, store, loadProject, fetchFn, provider, env, now
  const env = d.env || process.env;
  if (event.httpMethod && event.httpMethod !== "POST") return { statusCode: 405, body: "" };
  const { requestHost } = require("./lib/self-dispatch-lib");
  if (require("./lib/public-config-lib").isProductionHost(requestHost(event), env)) return { statusCode: 503, body: "" };
  const auth = await (d.requireUser || requireUser)(event);
  if (auth.error) return { statusCode: auth.error.status, body: "" };
  const userId = auth.user.id;
  if (run.admit(userId, env)) return { statusCode: 404, body: "" };   // checked before reading the body: refused users learn nothing more
  let body = {}; try { body = JSON.parse(event.body || "{}"); } catch (e) { return { statusCode: 400, body: "" }; }
  if (!am.UUID_RE.test(String(body.projectId || ""))) return { statusCode: 400, body: "" };
  const script = body.mode === "script";
  if (body.mode !== undefined && !script) return { statusCode: 400, body: "" };
  let provider = null;
  try { provider = d.provider || pv.createProvider({ env }); } catch (e) { provider = null; }   // no provider: the run is marked failed, nothing is sent
  // Development fixture mode: B1_SNAPSHOT_SOURCE=worker-fixture takes the frozen FA/FB/FC article from the private fixture worker (no live fetch).
  let fetchFn = d.fetchFn;
  if (!fetchFn) {
    try { fetchFn = require("./lib/agent-marketing-b1-bridge-lib").fixtureSource(env) || undefined; }
    catch (e) { const err = e; fetchFn = async () => { throw err; }; }   // misconfigured fixture mode: the snapshot fails, never a live fetch
  }
  try {
    const store = d.store || st.createStore({ env }), load = d.loadProject || loadProject;
    const args = { userId, projectId: body.projectId, store, loadProject: load, fetchFn, provider, env, now: d.now };
    const result = script ? await run.scriptJob({ ...args, sleep: d.sleep, supabase: d.supabase }) : await run.startJob(args);
    console.log(`agent-marketing-stageb-background ${script ? "script " : ""}${body.projectId.slice(0, 8)} ${result.state}${result.code ? ` ${result.code}` : ""}${result.evidence ? ` evidence=${result.evidence}` : ""}`);
    return { statusCode: 200, body: JSON.stringify(result) };
  } catch (e) {
    console.error("agent-marketing-stageb-background error:", e.code || e.message);
    return { statusCode: 500, body: "" };
  }
};
