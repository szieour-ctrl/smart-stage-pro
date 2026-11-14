// lib/agent-marketing-plan-run-lib.js — Netlify (shared). The ONE planning run for an Agent Marketing project, shared by two callers (Nov 8, 2026):
//   - agent-marketing-plan-background (production path): dispatched by agent-marketing-project.js { action: "plan" } with the internal key;
//   - agent-marketing-stageb-background { mode: "script" } (DEVELOPMENT ONLY, B1 article evidence): started by the page with the user's own login
//     token, because a development deploy behind team login cannot call its own functions over HTTP (docs/b1-stage-b-step3-browser-dispatch.md).
// The code below is the body agent-marketing-plan-background had before this split, unchanged in behaviour.
"use strict";

const am = require("./agent-marketing-lib");
const planLib = require("./agent-marketing-plan-lib");

function defaultSupabase() { return require("./marketing-profile-lib").supabase; }

/**
 * planStart(project) → { error: { status, message } } | { stub, hash }
 * The checks agent-marketing-project.js { action: "plan" } has always made before writing the "planning" stub (the API keys are checked by
 * each caller). One planning call per distinct set of answers; at most MAX_ATTEMPTS per project.
 */
function planStart(project, nowMs) {
  const deny = (status, message, code) => ({ error: { status, message, ...(code ? { code } : {}) } });
  if (!project.intake || !project.intake.market) return deny(409, "Answer the intake questions first.");
  if (project.template === "local_market_insider" && !project.selected_topic) return deny(409, "Choose one of the five topics first.");
  const n = project.narrative;
  const hash = planLib.intakeHash(project.intake, project.selected_topic);
  const attempts = (n && Number(n.attempts)) || 0;
  const now = nowMs == null ? Date.now() : nowMs;
  if (n && n.status === "planning" && now - Number(n.startedAt || 0) < planLib.STALE_PLANNING_MS) return deny(409, "Your script is already being written.", "in_progress");
  if (n && n.narrationTagged && n.intakeHash === hash) return deny(409, "A script already exists for these answers. Edit it, or change your answers to plan again.", "script_exists");
  if (attempts >= planLib.MAX_ATTEMPTS) return deny(429, "This project has used all of its planning attempts. Start a new one.", "attempts_used");
  return { stub: { status: "planning", startedAt: now, attempts: attempts + 1, intakeHash: hash }, hash };
}

async function writeNarrative(supabase, id, userId, narrative, extra) {
  return supabase("PATCH", "agent_marketing_projects", { narrative, updated_at: new Date().toISOString(), ...(extra || {}) }, `?id=eq.${id}&user_id=eq.${userId}`);
}

/** The error narrative the page shows; the stub's counters are kept so a retry is counted correctly. */
function errorNarrative(prev, message, extra) {
  return { status: "error", error: message, attempts: prev && prev.attempts, intakeHash: prev && prev.intakeHash, ...(extra || {}) };
}

/**
 * runPlan({ id, userId, deps }) → { state: "ready" | "error" | "skipped", code? }
 * Loads the project (owned by userId), runs only for the "planning" stub its caller just wrote, plans and writes the narrative or the error.
 * deps (all optional): supabase, env, anthropicKey, callFn (the planner model call; the development fixture script writer replaces it),
 * extraWarnings / narrativeExtra (shown with / stored on the narrative), withEvidence(project) → the project to plan from (defaults to the B1 Stage B lookup, which leaves the project unchanged with the switch off).
 */
async function runPlan({ id, userId, deps }) {
  const d = deps || {};
  const supabase = d.supabase || defaultSupabase();
  const env = d.env || process.env;
  let prev = null;
  try {
    if (!am.isEnabledFor(userId, env)) return { state: "skipped", code: "not_enabled" };
    const r = await supabase("GET", "agent_marketing_projects", null, `?id=eq.${id}&user_id=eq.${userId}&select=*&limit=1`);
    const project = Array.isArray(r.data) ? r.data[0] : null;
    if (!project) return { state: "skipped", code: "not_found" };
    const stub = project.narrative;
    // Only run for a stub the dispatcher just wrote; a late or duplicate call does nothing.
    if (!stub || stub.status !== "planning") return { state: "skipped", code: "no_stub" };
    prev = stub;
    const anthropicKey = d.anthropicKey !== undefined ? d.anthropicKey : env.ANTHROPIC_API_KEY;
    if (!anthropicKey && !d.callFn) {
      await writeNarrative(supabase, id, userId, errorNarrative(stub, "Planning is not configured."));
      return { state: "error", code: "not_configured" };
    }
    // CTA rotation: how many of this agent's projects came before this one (tracked by project order, not by anything the agent can edit).
    let ctaAngleCount = null;
    try {
      const prior = await supabase("GET", "agent_marketing_projects", null, `?user_id=eq.${userId}&created_at=lt.${encodeURIComponent(project.created_at)}&select=id&limit=1000`);
      if (Array.isArray(prior.data)) ctaAngleCount = prior.data.length;
    } catch (e) { /* the hash-based pick is used instead */ }
    // B1 Stage B (development only, AGENT_MARKETING_B1_EVIDENCE=dev): an Article-Led topic is planned only with its checked evidence row; a missing or
    // invalid row is BLOCKED and generatePlan stops before any model call. With the switch off the project is unchanged.
    const withEvidence = d.withEvidence || ((p) => require("./agent-marketing-b1-stageb-run-lib").withPlanEvidence(p, { env }));
    const planProject = await withEvidence(project);
    const { narrative, warnings, gate, usage: planUsage } = await planLib.generatePlan({ project: ctaAngleCount == null ? planProject : { ...planProject, cta_angle_index: ctaAngleCount }, anthropicKey, ...(d.callFn ? { callFn: d.callFn } : {}) });
    const gateSummary = { ok: gate.ok, version: gate.version, blocks: gate.blocks, warnings: gate.warnings, agentSuppliedClaims: gate.agentSuppliedClaims, sourcedFacts: gate.sourcedFacts || [] };
    await writeNarrative(supabase, id, userId, { ...narrative, warnings: (d.extraWarnings || []).concat(warnings), plan_usage: planUsage, attempts: stub.attempts, intakeHash: stub.intakeHash, ...(d.narrativeExtra || {}) },
      { status: "narrative_ready", gate_version: gate.version, gate_result: gateSummary });
    return { state: "ready" };
  } catch (err) {
    console.error(`[agent-marketing-plan] project ${id || "unknown"} failed:`, err.message);
    if (id && userId) {
      try { await writeNarrative(supabase, id, userId, errorNarrative(prev, err.message, { ...(err.gate && err.gate.blocks ? { blocked: err.gate.blocks.slice(0, 6).map((b) => ({ rule: b.rule, field: b.field, match: b.match, message: b.message })) } : {}), ...(err.experiment ? { experiment: err.experiment } : {}) })); }
      catch (e) { console.error("[agent-marketing-plan] could not write error status:", e.message); }
    }
    return { state: "error", code: err.code || "plan_error" };
  }
}

module.exports = { planStart, runPlan, writeNarrative, errorNarrative };
