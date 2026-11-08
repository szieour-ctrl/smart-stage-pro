// agent-marketing-plan-background.js — Netlify Background Function (15 min ceiling, see netlify.toml).
// Runs the ONE Claude planning call for an Agent Marketing project and writes the result into the project row.
// Dispatched only by agent-marketing-project.js (action "plan"); it checks the shared internal key, re-checks ownership
// and the feature switch, and never trusts anything in the request body beyond the project id and owner.
//   narrative = { status: "planning" | "error" | "ready", ... }  — the page polls GET agent-marketing-project?id=
const am = require("./lib/agent-marketing-lib");
const planRun = require("./lib/agent-marketing-plan-run-lib");   // Nov 8, 2026: the planning run itself, shared with the development script mode

exports.handler = async (event) => {
  const h = event.headers || {};
  const key = process.env.INTERNAL_API_KEY || "";
  if (!key || h["x-internal-key"] !== key) return { statusCode: 401, body: "" };
  let body;
  try { body = JSON.parse(event.body || "{}"); } catch (e) { return { statusCode: 200, body: "" }; }
  const id = body.projectId, userId = body.owner;
  if (!am.UUID_RE.test(String(id || "")) || !am.UUID_RE.test(String(userId || ""))) return { statusCode: 400, body: "" };
  if (!am.isEnabledFor(userId)) return { statusCode: 404, body: "" };
  const r = await planRun.runPlan({ id, userId });
  if (r.state === "skipped" && r.code === "not_found") return { statusCode: 404, body: "" };
  return { statusCode: 200, body: "" };
};
