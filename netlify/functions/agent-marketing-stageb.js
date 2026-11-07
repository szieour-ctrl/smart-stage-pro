// agent-marketing-stageb.js — Netlify Function. DEVELOPMENT ONLY (Nov 5, 2026): the owner-only Stage B action (B1 article evidence).
//   POST { action: "start", projectId } → 202 { state: "dispatch" }: the page then POSTs { projectId } to agent-marketing-stageb-background with
//        its own Bearer token (Nov 7, 2026: no server-to-server dispatch) | 202 { state: "reserved" | "running", code: "in_progress" } | 200 { state: "ready" }.
//        Poll GET until the state is "ready" or "failed".
//   GET  ?projectId=                    → { state, completeness, counts, error, reused, attached, createdAt, finishedAt } (no evidence text)
// Off (404 for everyone) unless AGENT_MARKETING_B1_EVIDENCE=dev, Agent Marketing is enabled for the user and the user is listed in
// B1_STAGEB_USER_IDS; refused (503) when the server's database is the production project. See lib/agent-marketing-b1-stageb-run-lib.js.
const { supabase } = require("./lib/marketing-profile-lib");
const { requireUser } = require("./lib/reel-auth-lib");
const run = require("./lib/agent-marketing-b1-stageb-run-lib");
const st = require("./lib/agent-marketing-b1-store-lib");

const headers = { "Access-Control-Allow-Origin": "*", "Content-Type": "application/json", "Cache-Control": "no-store" };
const reply = (statusCode, obj) => ({ statusCode, headers, body: JSON.stringify(obj) });

async function loadProject(id, userId) {
  const r = await supabase("GET", "agent_marketing_projects", null, `?id=eq.${encodeURIComponent(id)}&user_id=eq.${encodeURIComponent(userId)}&select=*&limit=1`);
  return Array.isArray(r.data) && r.data[0] ? r.data[0] : null;
}

exports.handler = async (event, context, deps) => {
  const d = deps || {};   // tests inject requireUser, store, loadProject, env
  if (event.httpMethod === "OPTIONS") return { statusCode: 204, headers: { ...headers, "Access-Control-Allow-Headers": "Content-Type, Authorization", "Access-Control-Allow-Methods": "GET, POST, OPTIONS" }, body: "" };
  const env = d.env || process.env;
  const auth = await (d.requireUser || requireUser)(event);
  if (auth.error) return reply(auth.error.status, auth.error.body);
  const userId = auth.user.id;
  const denied = run.admit(userId, env);
  if (denied) return reply(denied.status, { error: denied.message, code: denied.code });
  try {
    const store = d.store || st.createStore({ env });
    const load = d.loadProject || loadProject;
    if (event.httpMethod === "GET") {
      const r = await run.status({ userId, projectId: (event.queryStringParameters || {}).projectId, store, loadProject: load, env });
      return reply(r.status, r.body);
    }
    if (event.httpMethod !== "POST") return reply(405, { error: "Method not allowed" });
    let body = {}; try { body = JSON.parse(event.body || "{}"); } catch (e) { return reply(400, { error: "Invalid JSON" }); }
    if (body.action !== "start") return reply(400, { error: "Unknown action", code: "bad_request" });
    // Stage B never runs on a production host (the background function refuses it too).
    const { requestHost } = require("./lib/self-dispatch-lib");
    if (require("./lib/public-config-lib").isProductionHost(requestHost(event), env)) return reply(503, { error: "Stage B runs only on a development deploy.", code: "production_dispatch_refused" });
    const r = await run.startRequest({ userId, projectId: body.projectId, store, loadProject: load, env });
    return reply(r.status, r.body);
  } catch (e) {
    console.error("agent-marketing-stageb error:", e.code || e.message);
    return reply(e.code === "in_progress" ? 202 : 500, e.code === "in_progress" ? { state: "in_progress", code: "in_progress" } : { error: "Stage B is unavailable right now.", code: "error" });
  }
};
