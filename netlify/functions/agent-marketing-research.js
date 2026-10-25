// agent-marketing-research.js — Netlify Function. Local Market Insider research sessions (Oct 24, 2026).
// Behind AGENT_MARKETING_ENABLED (see lib/agent-marketing-lib.js): when the switch is off, or the user is not allowed,
// every call answers 404 as if the endpoint did not exist.
//
//   GET  ?projectId=<uuid>   → { research: [saved sets, newest first], session: { used, allowance, remaining, canStart } }
//                               Reopening saved research never costs a session.
//   GET  ?schema=1           → the choices the page shows (modes, audiences, geography types)
//   GET  ?id=<uuid>          → one saved set
//   POST { action: "start", projectId, request: { mode, audience, geography, focus?, dataSource?: "web"|"upload"|"both", uploadIds? } }
//        → 202 { research, session } and the work continues in the background; poll GET until status is not "running".
//        The same request on the same project reuses its saved set and uses no session.
//   POST { action: "select", projectId, researchId, topicId }
//        → freezes the chosen topic (with its sources and research date) on the project.
//
// A session is charged only when five validated topics are delivered (see agent-marketing-research-lib.js outcomeFields).
// Failures, timeouts and unusable results are never charged. The Perplexity key stays on the server.
const { supabase } = require("./lib/marketing-profile-lib");
const { requireUser } = require("./lib/reel-auth-lib");
const am = require("./lib/agent-marketing-lib");
const rl = require("./lib/agent-marketing-research-lib");
const runLib = require("./lib/agent-marketing-research-run-lib");
const quota = require("./lib/reel-quota-lib");

const headers = { "Access-Control-Allow-Origin": "*", "Content-Type": "application/json", "Cache-Control": "no-store" };
const reply = (statusCode, obj) => ({ statusCode, headers, body: JSON.stringify(obj) });
const STALE_RUNNING_MS = 6 * 60 * 1000;      // a run that never reported back is treated as failed (and was never charged)
const CHARGE_LOOKBACK_MS = 40 * 24 * 60 * 60 * 1000;

function forClient(row) {
  if (!row) return null;
  const out = {
    id: row.id, projectId: row.project_id, mode: row.mode, geography: row.geography, audience: row.audience, focus: row.focus || {},
    dataSource: row.data_source || "web", note: (row.usage && row.usage.reportNote) || null,
    status: row.status, model: row.model || null, topics: row.status === "ready" ? (row.topics || []) : [], researchDate: row.research_date || null,
    error: row.status === "failed" ? (row.error || "The research could not be completed.") : null,
    charged: !!row.charged_at, createdAt: row.created_at,
  };
  // Measured cost is for tuning during the beta only: AGENT_MARKETING_RESEARCH_DEBUG=true shows it, otherwise subscribers never see it.
  if (String(process.env.AGENT_MARKETING_RESEARCH_DEBUG || "").toLowerCase() === "true") out.usage = row.usage || null;
  return out;
}

async function loadProject(id, userId) {
  if (!am.UUID_RE.test(String(id || ""))) return { error: reply(400, { error: "Missing or invalid project id" }) };
  const r = await supabase("GET", "agent_marketing_projects", null, `?id=eq.${id}&user_id=eq.${userId}&select=*&limit=1`);
  const row = Array.isArray(r.data) ? r.data[0] : null;
  if (!row) return { error: reply(404, { error: "Project not found" }) };
  return { row };
}

// A "running" row that never finished is marked failed (uncharged) the next time anyone looks at it.
async function settleStale(rows) {
  const now = Date.now();
  for (const row of rows) {
    if (row.status === "running" && now - new Date(row.created_at).getTime() > STALE_RUNNING_MS) {
      await supabase("PATCH", "agent_marketing_research", { status: "failed", error: "The research timed out. This did not use a session.", charged_at: null, updated_at: new Date().toISOString() }, `?id=eq.${row.id}&status=eq.running`);
      row.status = "failed"; row.error = "The research timed out. This did not use a session."; row.charged_at = null;
    }
  }
  return rows;
}

// Which allowance applies, and whose pool it is drawn from. Same rule as Reels (Sam, Oct 24): a team's 30 and a brokerage's 100 are SHARED
// pools that every member draws from; everyone else (including trials and packages, for now) has their own 10. The pool is identified by
// its owner (team lead / brokerage admin, from getPlanContext), and each research row records it in pool_user_id.
async function poolFor(userId) {
  try {
    const ctx = await quota.getPlanContext(userId);
    return { planKey: runLib.planKeyFromContext(ctx), poolUserId: (ctx && ctx.poolUserId) || userId, kind: (ctx && ctx.poolKind) || "user" };
  } catch (e) {
    console.error("research plan lookup failed:", e.message);
    return { planKey: "solo", poolUserId: userId, kind: "user" };
  }
}

async function sessionFor(pool) {
  const since = new Date(Date.now() - CHARGE_LOOKBACK_MS).toISOString();
  const r = await supabase("GET", "agent_marketing_research", null, `?pool_user_id=eq.${pool.poolUserId}&charged_at=gte.${encodeURIComponent(since)}&select=charged_at`);
  return { ...rl.sessionStatus({ rows: Array.isArray(r.data) ? r.data : [], planKey: pool.planKey }), shared: pool.kind !== "user", pool: pool.kind };
}

const who = (session) => (session.pool === "brokerage" ? "Your brokerage has" : session.pool === "team" ? "Your team has" : "You've");

// The same request, rebuilt from a saved row, so "same request on the same project" is recognised without a second purchase.
function keyOfRow(row) {
  const refs = Array.isArray(row.upload_refs) ? row.upload_refs : [];
  return rl.requestKey({ mode: row.mode, audience: row.audience, geography: row.geography, focus: row.focus || {}, dataSource: row.data_source || "web", uploadIds: refs.map((x) => x && x.id).filter(Boolean) });
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
        // One copy of the choices lives in the research lib; the page reads it here instead of keeping its own.
        const GEO = { neighborhood: "Neighborhood", city: "City", zip: "ZIP code", county: "County", metro: "Metro area" };
        return reply(200, {
          modes: rl.MODES.map((k) => ({ key: k, label: rl.MODE_LABELS[k] })), audiences: rl.AUDIENCES,
          geoTypes: rl.GEO_TYPES.map((k) => ({ key: k, label: GEO[k] })), topicCount: rl.TOPIC_COUNT, maxUploads: rl.MAX_UPLOADS,
        });
      }
      if (qs.id) {
        if (!am.UUID_RE.test(String(qs.id))) return reply(400, { error: "Invalid id" });
        const r = await supabase("GET", "agent_marketing_research", null, `?id=eq.${qs.id}&user_id=eq.${userId}&select=*&limit=1`);
        const rows = await settleStale(Array.isArray(r.data) ? r.data : []);
        return rows[0] ? reply(200, { research: forClient(rows[0]) }) : reply(404, { error: "Research not found" });
      }
      const p = await loadProject(qs.projectId, userId);
      if (p.error) return p.error;
      const r = await supabase("GET", "agent_marketing_research", null, `?project_id=eq.${p.row.id}&user_id=eq.${userId}&select=*&order=created_at.desc&limit=10`);
      const rows = await settleStale(Array.isArray(r.data) ? r.data : []);
      return reply(200, { research: rows.map(forClient), selectedResearchId: p.row.selected_research_id || null, selectedTopic: p.row.selected_topic || null, session: await sessionFor(await poolFor(userId)) });
    }

    if (event.httpMethod !== "POST") return reply(405, { error: "Method not allowed" });
    let b;
    try { b = JSON.parse(event.body || "{}"); } catch { return reply(400, { error: "Invalid JSON" }); }
    const action = String(b.action || "");
    if (!["start", "select"].includes(action)) return reply(400, { error: "Unknown action" });

    const p = await loadProject(b.projectId, userId);
    if (p.error) return p.error;
    const project = p.row;
    if (project.template !== "local_market_insider") return reply(409, { error: "Research is only used by Local Market Insider." });
    if (am.NOT_EDITABLE_AFTER.includes(project.status)) return reply(409, { error: "This piece is already rendering or finished. Start a new one to change it." });

    if (action === "select") {
      if (!am.UUID_RE.test(String(b.researchId || ""))) return reply(400, { error: "Missing or invalid research id" });
      const rr = await supabase("GET", "agent_marketing_research", null, `?id=eq.${b.researchId}&user_id=eq.${userId}&project_id=eq.${project.id}&select=*&limit=1`);
      const row = Array.isArray(rr.data) ? rr.data[0] : null;
      if (!row || row.status !== "ready") return reply(404, { error: "That research set was not found." });
      const topic = (row.topics || []).find((t) => t && t.id === String(b.topicId || ""));
      if (!topic) return reply(400, { error: "Choose one of the five topics." });
      const frozen = { ...topic, researchId: row.id, researchDate: row.research_date, mode: row.mode, audience: row.audience, focus: row.focus || {}, geography: row.geography };
      // A different topic makes any earlier script stale: drop back to "draft" (the script is kept for the agent to see, never auto-approved).
      const prev = project.selected_topic;
      const changed = !!prev && (prev.id !== frozen.id || prev.researchId !== frozen.researchId);
      const fields = { selected_research_id: row.id, selected_topic: frozen, updated_at: new Date().toISOString() };
      if (changed && ["narrative_approved", "images"].includes(project.status)) fields.status = "draft";
      const saved = await supabase("PATCH", "agent_marketing_projects", fields, `?id=eq.${project.id}&user_id=eq.${userId}`);
      if (saved.status >= 300 || !Array.isArray(saved.data) || !saved.data[0]) return reply(500, { error: "Could not save your choice" });
      return reply(200, { selectedResearchId: row.id, selectedTopic: frozen });
    }

    // start
    const v = rl.validateResearchRequest(b.request);
    if (!v.ok) return reply(400, { error: v.errors[0].message, errors: v.errors });
    const existing = await settleStale((await supabase("GET", "agent_marketing_research", null, `?project_id=eq.${project.id}&user_id=eq.${userId}&select=*&order=created_at.desc&limit=10`)).data || []);
    const wantKey = rl.requestKey(v.request);
    // Saved results are reused, never re-bought. The agent asks for a NEW set with a different request (or "New Topics", below).
    const reuse = !b.newTopics && existing.find((r) => r.status === "ready" && keyOfRow(r) === wantKey);
    const pool = await poolFor(userId);
    if (reuse) return reply(200, { research: forClient(reuse), reused: true, session: await sessionFor(pool) });
    const mine = await supabase("GET", "agent_marketing_research", null, `?user_id=eq.${userId}&status=eq.running&created_at=gte.${encodeURIComponent(new Date(Date.now() - STALE_RUNNING_MS).toISOString())}&select=id&limit=1`);
    if (Array.isArray(mine.data) && mine.data[0]) return reply(409, { error: "A research request is already running. Please wait for it to finish." });
    const session = await sessionFor(pool);
    if (!session.canStart) return reply(429, { error: `${who(session)} used all ${session.allowance} research sessions included this month.`, session });
    const needsWeb = v.request.dataSource !== "upload", needsClaude = v.request.dataSource !== "web";
    if ((needsWeb && !process.env.PERPLEXITY_API_KEY) || (needsClaude && !process.env.ANTHROPIC_API_KEY) || !process.env.INTERNAL_API_KEY) return reply(500, { error: "Research is not set up yet." });
    // A report is used only when it is the agent's own, belongs to this project, and the agent confirmed "This report covers… Correct?".
    let refs = [];
    if (v.request.uploadIds.length) {
      const ids = v.request.uploadIds;
      const ur = await supabase("GET", "agent_marketing_uploads", null, `?id=in.(${ids.join(",")})&user_id=eq.${userId}&project_id=eq.${project.id}&status=eq.confirmed&select=id,scope_note`);
      const found = Array.isArray(ur.data) ? ur.data : [];
      if (found.length !== ids.length) return reply(400, { error: "A report you attached isn't confirmed yet, or was removed. Confirm it, or choose web research only." });
      refs = ids.map((id) => { const f = found.find((x) => x.id === id); return { id, scope_note: f.scope_note || "" }; });
    }

    const ins = await supabase("POST", "agent_marketing_research", {
      project_id: project.id, user_id: userId, pool_user_id: pool.poolUserId, mode: v.request.mode, geography: v.request.geography, audience: v.request.audience, focus: v.request.focus,
      data_source: v.request.dataSource, upload_refs: refs, status: "running", model: rl.researchModel(),
    });
    const row = Array.isArray(ins.data) ? ins.data[0] : null;
    if (ins.status >= 300 || !row) { console.error("agent-marketing-research insert failed:", ins.status, JSON.stringify(ins.data).slice(0, 200)); return reply(500, { error: "Could not start the research" }); }
    const siteUrl = process.env.URL || `https://${event.headers && event.headers.host}`;
    try {
      await fetch(`${siteUrl}/.netlify/functions/agent-marketing-research-background`, {
        method: "POST", headers: { "Content-Type": "application/json", "x-internal-key": process.env.INTERNAL_API_KEY },
        body: JSON.stringify({ researchId: row.id, owner: userId }),
      });
    } catch (e) {
      console.error("agent-marketing research dispatch failed:", e.message);
      await supabase("PATCH", "agent_marketing_research", { status: "failed", error: "Research failed to start.", charged_at: null, updated_at: new Date().toISOString() }, `?id=eq.${row.id}`);
      return reply(502, { error: "Research failed to start. Please try again. This did not use a session." });
    }
    return reply(202, { research: forClient(row), session });
  } catch (e) {
    console.error("agent-marketing-research error:", e.message);
    return reply(500, { error: "Something went wrong. Please try again." });
  }
};
