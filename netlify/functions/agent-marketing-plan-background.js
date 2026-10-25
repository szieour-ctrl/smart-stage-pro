// agent-marketing-plan-background.js — Netlify Background Function (15 min ceiling, see netlify.toml).
// Runs the ONE Claude planning call for an Agent Marketing project and writes the result into the project row.
// Dispatched only by agent-marketing-project.js (action "plan"); it checks the shared internal key, re-checks ownership
// and the feature switch, and never trusts anything in the request body beyond the project id and owner.
//   narrative = { status: "planning" | "error" | "ready", ... }  — the page polls GET agent-marketing-project?id=
const { supabase } = require("./lib/marketing-profile-lib");
const am = require("./lib/agent-marketing-lib");
const planLib = require("./lib/agent-marketing-plan-lib");

async function writeNarrative(id, userId, narrative, extra) {
  return supabase("PATCH", "agent_marketing_projects", { narrative, updated_at: new Date().toISOString(), ...(extra || {}) }, `?id=eq.${id}&user_id=eq.${userId}`);
}

exports.handler = async (event) => {
  const h = event.headers || {};
  const key = process.env.INTERNAL_API_KEY || "";
  if (!key || h["x-internal-key"] !== key) return { statusCode: 401, body: "" };
  let id = null, userId = null, prev = null;
  try {
    const body = JSON.parse(event.body || "{}");
    id = body.projectId; userId = body.owner;
    if (!am.UUID_RE.test(String(id || "")) || !am.UUID_RE.test(String(userId || ""))) return { statusCode: 400, body: "" };
    if (!am.isEnabledFor(userId)) return { statusCode: 404, body: "" };
    const r = await supabase("GET", "agent_marketing_projects", null, `?id=eq.${id}&user_id=eq.${userId}&select=*&limit=1`);
    const project = Array.isArray(r.data) ? r.data[0] : null;
    if (!project) return { statusCode: 404, body: "" };
    const stub = project.narrative;
    // Only run for a stub the dispatcher just wrote; a late or duplicate call does nothing.
    if (!stub || stub.status !== "planning") return { statusCode: 200, body: "" };
    prev = stub;
    if (!process.env.ANTHROPIC_API_KEY) {
      await writeNarrative(id, userId, { status: "error", error: "Planning is not configured.", attempts: stub.attempts, intakeHash: stub.intakeHash });
      return { statusCode: 200, body: "" };
    }
    const { narrative, warnings, gate } = await planLib.generatePlan({ project, anthropicKey: process.env.ANTHROPIC_API_KEY });
    const gateSummary = { ok: gate.ok, version: gate.version, blocks: gate.blocks, warnings: gate.warnings, agentSuppliedClaims: gate.agentSuppliedClaims, sourcedFacts: gate.sourcedFacts || [] };
    await writeNarrative(id, userId, { ...narrative, warnings, attempts: stub.attempts, intakeHash: stub.intakeHash },
      { status: "narrative_ready", gate_version: gate.version, gate_result: gateSummary });
  } catch (err) {
    console.error(`[agent-marketing-plan-background] project ${id || "unknown"} failed:`, err.message);
    if (id && userId) {
      try { await writeNarrative(id, userId, { status: "error", error: err.message, attempts: prev && prev.attempts, intakeHash: prev && prev.intakeHash, ...(err.gate && err.gate.blocks ? { blocked: err.gate.blocks.slice(0, 6).map((b) => ({ rule: b.rule, field: b.field, match: b.match })) } : {}) }); }
      catch (e) { console.error("[agent-marketing-plan-background] could not write error status:", e.message); }
    }
  }
  return { statusCode: 200, body: "" };
};
