// agent-marketing-project.js — Netlify Function. Agent Marketing project model (Oct 22, 2026).
// Behind AGENT_MARKETING_ENABLED (see lib/agent-marketing-lib.js): when the switch is off, or the user is not allowed,
// every call answers 404 as if the endpoint did not exist.
//
//   GET  ?schema=1                          → intake schema for the page (no project needed)
//   GET  ?id=<uuid>                         → one of the caller's projects
//   GET                                     → the caller's latest projects
//   POST { action: "create", template?, durationSec?, formats?, voice?, music? }
//   POST { action: "save_intake", id, intake }          → validates + runs the content gate
//   POST { action: "save_narrative", id, narrative }    → the agent's own edit of the script (Claude's plan is saved by the planner)
//   POST { action: "plan", id }                         → starts the ONE Claude planning call (background); poll GET ?id= until
//                                                          project.narrative.status is "ready" or "error"
//   POST { action: "approve_narrative", id }            → gate again, then freezes narrative_approved
//
// The user always comes from the login token. A project is only visible to its owner. No listing, address, price or MLS
// field is accepted anywhere (the gate rejects them structurally).
const { supabase } = require("./lib/marketing-profile-lib");
const { requireUser } = require("./lib/reel-auth-lib");
const gate = require("./lib/agent-marketing-gate");
const intakeLib = require("./lib/agent-marketing-intake");
const am = require("./lib/agent-marketing-lib");
const planLib = require("./lib/agent-marketing-plan-lib");
const mediaLib = require("./lib/agent-marketing-media-lib");

const headers = { "Access-Control-Allow-Origin": "*", "Content-Type": "application/json", "Cache-Control": "no-store" };
const reply = (statusCode, obj) => ({ statusCode, headers, body: JSON.stringify(obj) });
const PUBLIC_COLS = "id,template,angle,formats,duration_sec,voice,music,intake,narrative,narrative_approved_at,storyboard,selected_topic,status,gate_version,gate_result,created_at,updated_at,hidden_at";

// A saved script written for another topic or other answers is kept for the agent to see, but the page must offer "Write my script" again (Sam, Oct 29, 2026).
function scriptStale(row) {
  const n = row && row.narrative;
  if (!n || !n.narrationTagged || !n.intakeHash || !row.selected_topic) return false;
  try { return n.intakeHash !== planLib.intakeHash(row.intake || {}, row.selected_topic); } catch (e) { return false; }
}

function forClient(row) {
  if (!row) return null;
  return {
    scriptStale: scriptStale(row),
    id: row.id, template: row.template, angle: row.angle, formats: row.formats, durationSec: row.duration_sec, voice: row.voice, music: row.music || "default",
    intake: row.intake || {}, narrative: row.narrative || null, narrativeApprovedAt: row.narrative_approved_at || null,
    storyboard: row.storyboard || null, selectedTopic: row.selected_topic || null, status: row.status, gate: row.gate_result || null,
    createdAt: row.created_at, updatedAt: row.updated_at, hidden: !!row.hidden_at,
  };
}

async function loadOwned(id, userId) {
  if (!am.UUID_RE.test(String(id || ""))) return { error: reply(400, { error: "Missing or invalid project id" }) };
  const r = await supabase("GET", "agent_marketing_projects", null, `?id=eq.${id}&user_id=eq.${userId}&select=*&limit=1`);
  const row = Array.isArray(r.data) ? r.data[0] : null;
  if (!row) return { error: reply(404, { error: "Project not found" }) };
  return { row };
}

async function patch(id, userId, fields) {
  const r = await supabase("PATCH", "agent_marketing_projects", { ...fields, updated_at: new Date().toISOString() }, `?id=eq.${id}&user_id=eq.${userId}`);
  const row = Array.isArray(r.data) ? r.data[0] : null;
  if (r.status >= 300 || !row) { console.error("agent-marketing patch failed:", r.status, JSON.stringify(r.data).slice(0, 200)); return null; }
  return row;
}

function gateSummary(result) {
  return { ok: result.ok, version: result.version, blocks: result.blocks, warnings: result.warnings, agentSuppliedClaims: result.agentSuppliedClaims, sourcedFacts: result.sourcedFacts || [] };
}

exports.handler = async (event) => {
  if (event.httpMethod === "OPTIONS") return { statusCode: 204, headers: { ...headers, "Access-Control-Allow-Headers": "Content-Type, Authorization", "Access-Control-Allow-Methods": "GET, POST, OPTIONS" }, body: "" };
  const auth = await requireUser(event);
  if (auth.error) return reply(auth.error.status, auth.error.body);
  const userId = auth.user.id;
  if (!am.isEnabledFor(userId)) return reply(404, { error: "Not found" });

  try {
    if (event.httpMethod === "GET") {
      const qs = event.queryStringParameters || {};
      if (qs.schema) {
        return reply(200, {
          templates: gate.ENABLED_TEMPLATES.map((t) => ({ key: t, ...intakeLib.schemaFor(t) })),
          audiences: intakeLib.AUDIENCES, actions: intakeLib.ACTIONS, limits: intakeLib.LIMITS,
          durations: am.DURATIONS, formats: am.FORMATS, voices: am.VOICES, music: am.MUSIC, wordTargets: am.WORD_TARGETS,
          attestation: { version: gate.ATTESTATION_VERSION, text: gate.ATTESTATION_TEXT },
          uploadAttestation: { version: mediaLib.UPLOAD_ATTESTATION_VERSION, text: mediaLib.UPLOAD_ATTESTATION_TEXT },
        });
      }
      if (qs.id) {
        const o = await loadOwned(qs.id, userId);
        return o.error || reply(200, { project: forClient(o.row) });
      }
      const r = await supabase("GET", "agent_marketing_projects", null, `?user_id=eq.${userId}&select=${PUBLIC_COLS}&order=created_at.desc&limit=60`);
      const rows = Array.isArray(r.data) ? r.data : [];
      // The newest Reel job per project, so each card can say whether the Reel is being made, done or failed (Oct 27).
      const reel = {};
      if (rows.length) {
        const j = await supabase("GET", "agent_marketing_jobs", null, `?user_id=eq.${userId}&project_id=in.(${rows.map((x) => x.id).join(",")})&select=project_id,status,created_at&order=created_at.desc&limit=200`);
        (Array.isArray(j.data) ? j.data : []).forEach((x) => { if (!reel[x.project_id]) reel[x.project_id] = x.status === "done" ? "done" : x.status === "error" ? "failed" : "making"; });
      }
      return reply(200, { projects: rows.map((x) => ({ ...forClient(x), reel: reel[x.id] || null })) });
    }

    if (event.httpMethod !== "POST") return reply(405, { error: "Method not allowed" });
    let b;
    try { b = JSON.parse(event.body || "{}"); } catch { return reply(400, { error: "Invalid JSON" }); }
    const action = String(b.action || "");

    if (action === "create") {
      const v = am.validateCreate(b);
      if (v.error) return reply(400, { error: v.error });
      const g = gate.evaluate({ template: v.row.template, payload: b });
      if (!g.ok) return reply(422, { error: gate.explain(g), gate: gateSummary(g) });
      const ins = await supabase("POST", "agent_marketing_projects", { ...v.row, user_id: userId });
      const row = Array.isArray(ins.data) ? ins.data[0] : null;
      if (ins.status >= 300 || !row) { console.error("agent-marketing create failed:", ins.status, JSON.stringify(ins.data).slice(0, 200)); return reply(500, { error: "Could not start the project" }); }
      return reply(200, { project: forClient(row) });
    }

    // Hiding only tidies the list; it never deletes anything and works on any project, even a finished one.
    if (action === "hide" || action === "unhide") {
      const h = await loadOwned(b.id, userId);
      if (h.error) return h.error;
      const saved = await supabase("PATCH", "agent_marketing_projects", { hidden_at: action === "hide" ? new Date().toISOString() : null }, `?id=eq.${h.row.id}&user_id=eq.${userId}`);
      if (saved.status >= 300) return reply(500, { error: "Could not update the project" });
      return reply(200, { ok: true });
    }
    if (action === "hide_drafts") { // every project that never got past an empty draft
      const saved = await supabase("PATCH", "agent_marketing_projects", { hidden_at: new Date().toISOString() }, `?user_id=eq.${userId}&status=eq.draft&hidden_at=is.null&intake-%3E%3Emarket=is.null`);
      if (saved.status >= 300) return reply(500, { error: "Could not update the projects" });
      return reply(200, { ok: true, hidden: Array.isArray(saved.data) ? saved.data.length : null });
    }

    if (!["save_intake", "save_narrative", "approve_narrative", "plan"].includes(action)) return reply(400, { error: "Unknown action" });
    const o = await loadOwned(b.id, userId);
    if (o.error) return o.error;
    const project = o.row;
    if (am.NOT_EDITABLE_AFTER.includes(project.status)) return reply(409, { error: "This piece is already rendering or finished. Start a new one to change it." });

    if (action === "save_intake") {
      // Local Market Insider starts from one of the five researched topics; its figures and sources are on the project, never from the browser.
      if (project.template === "local_market_insider" && !project.selected_topic) return reply(409, { error: "Choose one of the five topics first." });
      const v = intakeLib.validateIntake(project.template, b.intake, { topic: project.selected_topic });
      if (!v.ok) return reply(400, { error: v.errors[0].message, errors: v.errors });
      const g = gate.evaluate({ template: project.template, payload: b.intake, intake: v.clean });
      if (!g.ok) return reply(422, { error: gate.explain(g), gate: gateSummary(g) });
      // New facts mean any earlier script is stale: keep it as a draft, drop back to "draft", never touch narrative_approved.
      const saved = await patch(project.id, userId, { intake: v.clean, angle: v.clean.angle || null, status: "draft", gate_version: g.version, gate_result: gateSummary(g) });
      if (!saved) return reply(500, { error: "Could not save your answers" });
      return reply(200, { project: forClient(saved), needsInput: v.needsInput, gate: gateSummary(g) });
    }

    if (action === "save_narrative") {
      if (!project.intake || !project.intake.market) return reply(409, { error: "Answer the intake questions first." });
      const v = am.validateNarrative(b.narrative, project.duration_sec);
      if (v.error) return reply(400, { error: v.error });
      am.attachNotice(project, v.narrative); // a script edit must never drop the required notice (on-screen overlay, never spoken)
      const g = gate.evaluate(am.gateInputFor(project, v.narrative, "edited"));
      if (!g.ok) return reply(422, { error: gate.explain(g), gate: gateSummary(g) });
      // Keep what the planner produced (scene plan, photo shopping list, claims to verify, planning counters) and replace only
      // what the agent edited. If the words changed, the scene excerpts no longer match them: flag that for the next step.
      const prev = project.narrative && typeof project.narrative === "object" ? project.narrative : {};
      const clientScenes = v.narrative.scenes && v.narrative.scenes.length ? v.narrative.scenes : (prev.scenes || []);
      const narrative = {
        editorialAngle: prev.editorialAngle, hook: prev.hook, claimsToVerify: prev.claimsToVerify, missingAgentInputs: prev.missingAgentInputs,
        attempts: prev.attempts, intakeHash: prev.intakeHash,
        ...v.narrative, scenes: clientScenes, cta: v.narrative.cta || prev.cta || null,
        scenesStale: !!(prev.narrationTagged && prev.narrationTagged !== v.narrative.narrationTagged) || !!prev.scenesStale,
        source: "edited", status: "ready", savedAt: new Date().toISOString(),
      };
      const saved = await patch(project.id, userId, { narrative, status: "narrative_ready", gate_version: g.version, gate_result: gateSummary(g) });
      if (!saved) return reply(500, { error: "Could not save the script" });
      return reply(200, { project: forClient(saved), warnings: v.warnings, gate: gateSummary(g) });
    }

    if (action === "plan") {
      if (!project.intake || !project.intake.market) return reply(409, { error: "Answer the intake questions first." });
      if (project.template === "local_market_insider" && !project.selected_topic) return reply(409, { error: "Choose one of the five topics first." });
      if (!process.env.ANTHROPIC_API_KEY || !process.env.INTERNAL_API_KEY) return reply(500, { error: "Planning is not configured." });
      const n = project.narrative;
      const hash = planLib.intakeHash(project.intake, project.selected_topic);
      const attempts = (n && Number(n.attempts)) || 0;
      if (n && n.status === "planning" && Date.now() - Number(n.startedAt || 0) < planLib.STALE_PLANNING_MS) return reply(409, { error: "Your script is already being written." });
      // One planning call per distinct set of answers: a ready script for the same answers is reused, not re-bought.
      if (n && n.narrationTagged && n.intakeHash === hash) return reply(409, { error: "A script already exists for these answers. Edit it, or change your answers to plan again." });
      if (attempts >= planLib.MAX_ATTEMPTS) return reply(429, { error: "This project has used all of its planning attempts. Start a new one." });
      const stub = { status: "planning", startedAt: Date.now(), attempts: attempts + 1, intakeHash: hash };
      const saved = await patch(project.id, userId, { narrative: stub });
      if (!saved) return reply(500, { error: "Could not start planning" });
      const siteUrl = process.env.URL || `https://${event.headers && event.headers.host}`;
      try {
        await fetch(`${siteUrl}/.netlify/functions/agent-marketing-plan-background`, {
          method: "POST", headers: { "Content-Type": "application/json", "x-internal-key": process.env.INTERNAL_API_KEY },
          body: JSON.stringify({ projectId: project.id, owner: userId }),
        });
      } catch (e) {
        console.error("agent-marketing plan dispatch failed:", e.message);
        await patch(project.id, userId, { narrative: { status: "error", error: "Planning failed to start.", attempts: stub.attempts, intakeHash: hash } });
        return reply(502, { error: "Planning failed to start. Please try again." });
      }
      return reply(202, { project: forClient(saved) });
    }

    // approve_narrative
    const n = project.narrative;
    if (!n || !n.narrationTagged) return reply(409, { error: "There is no script to approve yet." });
    // A script written for another topic or other answers must not be approved for this one (its numbers would have no source here).
    if (project.template === "local_market_insider" && project.selected_topic && n.intakeHash && n.intakeHash !== planLib.intakeHash(project.intake, project.selected_topic)) {
      return reply(409, { error: "This script was written for a different topic or different answers. Write a new script for the topic you chose, then approve it.", code: "script_stale" });
    }
    am.attachNotice(project, n); // scripts saved before the notice was kept still carry it
    const g = gate.evaluate(am.gateInputFor(project, n, n.source === "claude" ? "claude" : "edited"));
    if (!g.ok) return reply(422, { error: gate.explain(g), gate: gateSummary(g) });
    const now = new Date().toISOString();
    const saved = await patch(project.id, userId, { narrative_approved: { ...n, approvedAt: now, gateVersion: g.version }, narrative_approved_at: now, status: "narrative_approved", gate_version: g.version, gate_result: gateSummary(g) });
    if (!saved) return reply(500, { error: "Could not approve the script" });
    return reply(200, { project: forClient(saved), gate: gateSummary(g) });
  } catch (e) {
    console.error("agent-marketing-project error:", e.message);
    return reply(500, { error: "Something went wrong. Please try again." });
  }
};
