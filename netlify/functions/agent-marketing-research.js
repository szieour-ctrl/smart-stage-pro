// agent-marketing-research.js — Netlify Function. Local Market Insider research sessions (Oct 24, 2026).
// Behind AGENT_MARKETING_ENABLED (see lib/agent-marketing-lib.js): when the switch is off, or the user is not allowed,
// every call answers 404 as if the endpoint did not exist.
//
//   GET  ?projectId=<uuid>   → { research: [saved sets, newest first], session: { used, allowance, remaining, canStart } }
//                               Reopening saved research never costs a session.
//   GET  ?schema=1           → the choices the page shows (modes, audiences, geography types)
//   GET  ?id=<uuid>          → one saved set
//   POST { action: "start", projectId, request: { mode, audience, geography, focus?, keywords?, dataSource?: "web"|"upload"|"both", uploadIds? } }
//        → 202 { research, session } and the work continues in the background; poll GET until status is not "running".
//        The same request on the same project reuses its saved set and uses no session.
//   POST { action: "select", projectId, researchId, topicId }
//        → freezes the chosen topic (with its sources and research date) on the project. A set built from a report that is not this project's own
//          answers 409 { code: "report_choice", reports } until the request carries reportChoice: "use".
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

// A saved set opened from another project points at that project's report. The report is the agent's own, so, once the agent says "use", it is copied into THIS project
// (confirmed as it was) and the set's references are remapped to the copy. Without it the project had no report: nothing showed on the page,
// it could not be replaced, and the script and cards had only what the topic had frozen (Oct 30, 2026).
// The reports a saved set was built from that are not yet this project's own. The agent decides what happens to them (use / update); nothing is copied silently.
async function pendingReports(row, project, userId) {
  const oldIds = (Array.isArray(row.upload_refs) ? row.upload_refs : []).map((x) => x && x.id).filter((id) => am.UUID_RE.test(String(id || "")));
  if (!oldIds.length) return [];
  const r = await supabase("GET", "agent_marketing_uploads", null, `?id=in.(${oldIds.join(",")})&user_id=eq.${userId}&status=eq.confirmed&select=id,project_id,scope_note,created_at`);
  return (Array.isArray(r.data) ? r.data : []).filter((u) => u.project_id !== project.id).map((u) => ({ id: u.id, scopeNote: u.scope_note || "", uploadedAt: u.created_at || null }));
}
async function attachReports(row, project, userId) {
  const refs = Array.isArray(row.upload_refs) ? row.upload_refs : [];
  const oldIds = refs.map((x) => x && x.id).filter((id) => am.UUID_RE.test(String(id || "")));
  if (!oldIds.length) return row;
  const [srcR, hereR] = await Promise.all([
    supabase("GET", "agent_marketing_uploads", null, `?id=in.(${oldIds.join(",")})&user_id=eq.${userId}&status=eq.confirmed&select=*`),
    supabase("GET", "agent_marketing_uploads", null, `?project_id=eq.${project.id}&user_id=eq.${userId}&select=*`),
  ]);
  const src = Array.isArray(srcR.data) ? srcR.data : [];
  const here = Array.isArray(hereR.data) ? hereR.data : [];
  const idMap = {};
  for (const u of src) {
    if (u.project_id === project.id) continue; // already this project's own report
    const same = here.find((h) => h.status === "confirmed" && h.file_bytes === u.file_bytes && (h.scope_note || "") === (u.scope_note || "") && JSON.stringify(h.facts) === JSON.stringify(u.facts));
    if (same) { idMap[u.id] = same.id; continue; }
    if (here.length >= rl.MAX_UPLOADS) continue;
    const ins = await supabase("POST", "agent_marketing_uploads", {
      project_id: project.id, user_id: userId, file_kind: u.file_kind, file_bytes: u.file_bytes, status: "confirmed", facts: u.facts, scope_note: u.scope_note,
      permission_at: u.permission_at, permission_version: u.permission_version, confirmed_at: u.confirmed_at || new Date().toISOString(),
    });
    const made = Array.isArray(ins.data) ? ins.data[0] : null;
    if (ins.status >= 300 || !made) { console.error("agent-marketing-research report copy failed:", ins.status, JSON.stringify(ins.data).slice(0, 200)); continue; }
    here.push(made); idMap[u.id] = made.id;
  }
  if (!Object.keys(idMap).length) return row;
  const remap = (v) => { let t = JSON.stringify(v); for (const [o, n] of Object.entries(idMap)) t = t.split(o).join(n); return JSON.parse(t); };
  const fields = { upload_refs: remap(refs), topics: remap(row.topics || []), updated_at: new Date().toISOString() };
  const up = await supabase("PATCH", "agent_marketing_research", fields, `?id=eq.${row.id}&user_id=eq.${userId}`);
  const out = Array.isArray(up.data) ? up.data[0] : null;
  return up.status < 300 && out ? out : row;
}

function forClient(row) {
  if (!row) return null;
  const out = {
    id: row.id, projectId: row.project_id, mode: row.mode, geography: row.geography, audience: row.audience, focus: row.focus || {},
    dataSource: row.data_source || "web", note: (row.usage && row.usage.reportNote) || null,
    status: row.status, model: row.model || null, topics: row.status === "ready" ? (row.topics || []) : [], researchDate: row.research_date || null,
    error: row.status === "failed" ? (row.error || "The research could not be completed.") : null,
    charged: !!row.charged_at, createdAt: row.created_at,
  };
  if (row.status === "ready") Object.assign(out, rl.setAge(row.research_date, row.created_at)); // ageDays, expired, expiresOn: a set is usable for 7 days
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
  return rl.requestKey({ mode: row.mode, audience: row.audience, geography: row.geography, focus: row.focus || {}, keywords: (row.focus && row.focus.keywords) || "", dataFocus: (row.focus && row.focus.dataFocus) || "all", period: (row.focus && row.focus.period) || null, dataSource: row.data_source || "web", uploadIds: refs.map((x) => x && x.id).filter(Boolean) });
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
          dataFocus: rl.DATA_FOCUS, modes: rl.MODES.map((k) => ({ key: k, label: rl.MODE_LABELS[k] })), audiences: rl.AUDIENCES,
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
      // Saved research from the agent's other projects (Sam, Oct 29, 2026): the Research Library is the agent's, so a fresh project still finds earlier sets.
      // Opening one costs nothing; choosing a topic from one copies the set into this project (see "select").
      let earlier = [];
      try {
        const er = await supabase("GET", "agent_marketing_research", null, `?user_id=eq.${userId}&project_id=neq.${p.row.id}&status=eq.ready&select=*&order=created_at.desc&limit=20`);
        earlier = (Array.isArray(er.data) ? er.data : []).filter((x) => !(x.usage && x.usage.copiedFrom)).map(forClient); // copies are hidden: the original is listed
      } catch (e) { /* the library still shows this project's own sets */ }
      return reply(200, { earlier, research: rows.map(forClient), selectedResearchId: p.row.selected_research_id || null, selectedTopic: p.row.selected_topic || null, session: await sessionFor(await poolFor(userId)) });
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
      let rr = await supabase("GET", "agent_marketing_research", null, `?id=eq.${b.researchId}&user_id=eq.${userId}&select=*&limit=1`);
      let row = Array.isArray(rr.data) ? rr.data[0] : null;
      // A set is usable for 7 days. After that it can be read but no topic can be chosen from it; the agent runs the same request again.
      // A set this project already chose its topic from keeps working (the Reel survives, with a warning on the page).
      if (row && row.status === "ready" && project.selected_research_id !== row.id && rl.setAge(row.research_date, row.created_at).expired) {
        return reply(409, { code: "research_expired", error: "This research is more than 7 days old and may be outdated. Run it again for current data.", research: forClient(row) });
      }
      // The report behind a saved set may be last month's. The agent chooses: "use" it as it is (it is copied into this project), or update it
      // (the page then asks for the newer report and researches again). Without the choice nothing is selected and nothing is copied.
      let pending = [];
      if (row && row.status === "ready") { try { pending = await pendingReports(row, project, userId); } catch (e) { console.error("agent-marketing-research pendingReports failed:", e.message); } }
      if (pending.length && b.reportChoice !== "use") return reply(409, { code: "report_choice", error: "Choose whether to use the report this research was built from, or update it.", reports: pending, researchId: row.id });
      if (row && row.status === "ready" && row.project_id !== project.id) {
        // A set saved under another of the agent's projects: copy it here, so this project owns it. No session is used.
        const copy = await supabase("POST", "agent_marketing_research", {
          project_id: project.id, user_id: userId, pool_user_id: row.pool_user_id, mode: row.mode, geography: row.geography, audience: row.audience, focus: row.focus || {},
          upload_refs: row.upload_refs || [], status: "ready", model: row.model, topics: row.topics, research_date: row.research_date, data_source: row.data_source || "web",
          usage: { copiedFrom: row.id }, charged_at: null,
        });
        row = Array.isArray(copy.data) ? copy.data[0] : null;
        if (!row) return reply(500, { error: "Could not open that saved set" });
      }
      if (!row || row.status !== "ready") return reply(404, { error: "That research set was not found." });
      if (pending.length) { try { row = await attachReports(row, project, userId); } catch (e) { console.error("agent-marketing-research attachReports failed:", e.message); } }
      const topic = (row.topics || []).find((t) => t && t.id === String(b.topicId || ""));
      if (!topic) return reply(400, { error: "Choose one of the five topics." });
      const frozen = { ...topic, researchId: row.id, researchDate: row.research_date, mode: row.mode, audience: row.audience, focus: row.focus || {}, geography: row.geography };
      // A different topic makes any earlier script stale: drop back to "draft" (the script is kept for the agent to see, never auto-approved).
      const prev = project.selected_topic;
      const changed = !!prev && (prev.id !== frozen.id || prev.researchId !== frozen.researchId);
      const fields = { selected_research_id: row.id, selected_topic: frozen, updated_at: new Date().toISOString() };
      if (changed && ["narrative_approved", "images"].includes(project.status)) fields.status = "draft";
      // The market and audience on the intake came from the earlier topic; the page saves them again from the new one when the agent continues.
      if (changed) fields.intake = {};
      const saved = await supabase("PATCH", "agent_marketing_projects", fields, `?id=eq.${project.id}&user_id=eq.${userId}`);
      if (saved.status >= 300 || !Array.isArray(saved.data) || !saved.data[0]) return reply(500, { error: "Could not save your choice" });
      return reply(200, { selectedResearchId: row.id, selectedTopic: frozen, reportAttached: Array.isArray(row.upload_refs) && row.upload_refs.length > 0 });
    }

    // start
    const v = rl.validateResearchRequest(b.request);
    if (!v.ok) return reply(400, { error: v.errors[0].message, errors: v.errors });
    // A Local Market Update is built on the subscriber's own confirmed MLS Trends/CMA report. Web articles supply the story, never the numbers
    // (Sam, Oct 30, 2026), so a request with no confirmed report is not run. Local Events do not use a report. (AGENT_MARKETING_ALLOW_WEB_MARKET_UPDATE=true lifts this; it exists for tests and is unset in production.)
    if (v.request.mode === "market_update" && v.request.dataSource === "web" && process.env.AGENT_MARKETING_ALLOW_WEB_MARKET_UPDATE !== "true") return reply(400, { code: "report_required", error: "Attach and confirm your MLS Trends or CMA report first. A Local Market Update uses your report for the numbers; web research only adds the story." });
    const existing = await settleStale((await supabase("GET", "agent_marketing_research", null, `?project_id=eq.${project.id}&user_id=eq.${userId}&select=*&order=created_at.desc&limit=10`)).data || []);
    const wantKey = rl.requestKey(v.request);
    // Saved results are reused, never re-bought. The agent asks for a NEW set with a different request (or "New Topics", below).
    const reuse = !b.newTopics && existing.find((r) => r.status === "ready" && keyOfRow(r) === wantKey && !rl.setAge(r.research_date, r.created_at).expired); // an expired set is never reused: the same request runs again
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
      project_id: project.id, user_id: userId, pool_user_id: pool.poolUserId, mode: v.request.mode, geography: v.request.geography, audience: v.request.audience, focus: { ...v.request.focus, keywords: v.request.keywords, dataFocus: v.request.dataFocus, period: v.request.period },
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
