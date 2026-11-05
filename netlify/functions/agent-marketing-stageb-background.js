// agent-marketing-stageb-background.js — Netlify Background Function (15 min). DEVELOPMENT ONLY (Nov 5, 2026). The Stage B job:
// snapshot → atomic ledger reservation → provider (MOCK ONLY: the paid call is not implemented) → Python evidence gate via the worker → attach.
// Internal only: x-internal-key must equal INTERNAL_API_KEY. Same admission as the start (lib/agent-marketing-b1-stageb-run-lib.js).
const { supabase } = require("./lib/marketing-profile-lib");
const run = require("./lib/agent-marketing-b1-stageb-run-lib");
const st = require("./lib/agent-marketing-b1-store-lib");
const pv = require("./lib/agent-marketing-b1-provider-lib");
const am = require("./lib/agent-marketing-lib");

async function loadProject(id, userId) {
  const r = await supabase("GET", "agent_marketing_projects", null, `?id=eq.${encodeURIComponent(id)}&user_id=eq.${encodeURIComponent(userId)}&select=*&limit=1`);
  return Array.isArray(r.data) && r.data[0] ? r.data[0] : null;
}

exports.handler = async (event, context, deps) => {
  const d = deps || {};
  const env = d.env || process.env;
  const h = event.headers || {};
  const key = String(env.INTERNAL_API_KEY || "");
  if (!key || h["x-internal-key"] !== key) return { statusCode: 401, body: "" };
  let body = {}; try { body = JSON.parse(event.body || "{}"); } catch (e) { return { statusCode: 400, body: "" }; }
  if (!am.UUID_RE.test(String(body.projectId || "")) || !am.UUID_RE.test(String(body.userId || ""))) return { statusCode: 400, body: "" };
  let provider = null;
  try { provider = d.provider || pv.createProvider({ env }); } catch (e) { provider = null; }   // no provider: the run is marked failed, nothing is sent
  try {
    const result = await run.runJob({ userId: body.userId, projectId: body.projectId, store: d.store || st.createStore({ env }), loadProject: d.loadProject || loadProject,
      fetchFn: d.fetchFn, provider, env, now: d.now });
    console.log(`agent-marketing-stageb-background ${body.projectId.slice(0, 8)} ${result.state}${result.code ? ` ${result.code}` : ""}`);
    return { statusCode: 200, body: JSON.stringify(result) };
  } catch (e) {
    console.error("agent-marketing-stageb-background error:", e.code || e.message);
    return { statusCode: 500, body: "" };
  }
};
