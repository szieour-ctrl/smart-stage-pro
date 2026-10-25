// agent-marketing-research-background.js — Netlify Background Function (15 min ceiling, see netlify.toml).
// Runs ONE Local Market Insider research session for a research row and writes the result back to that row.
// Dispatched only by agent-marketing-research.js (action "start"); it checks the shared internal key, re-checks the feature
// switch and ownership, and trusts nothing in the request body beyond the row id and the owner.
//   row.status = "running" → "ready" (five validated topics, charged_at set) | "failed" (never charged)
// The page polls GET agent-marketing-research?projectId= until the row is no longer "running".
const { supabase } = require("./lib/marketing-profile-lib");
const am = require("./lib/agent-marketing-lib");
const runLib = require("./lib/agent-marketing-research-run-lib");

async function writeRow(id, userId, fields) {
  // Only a row that is still "running" may be finished, so a late or duplicate worker can never overwrite a result or charge twice.
  return supabase("PATCH", "agent_marketing_research", fields, `?id=eq.${id}&user_id=eq.${userId}&status=eq.running`);
}

exports.handler = async (event) => {
  const h = event.headers || {};
  const key = process.env.INTERNAL_API_KEY || "";
  if (!key || h["x-internal-key"] !== key) return { statusCode: 401, body: "" };
  let id = null, userId = null;
  try {
    const body = JSON.parse(event.body || "{}");
    id = body.researchId; userId = body.owner;
    if (!am.UUID_RE.test(String(id || "")) || !am.UUID_RE.test(String(userId || ""))) return { statusCode: 400, body: "" };
    if (!am.isEnabledFor(userId)) return { statusCode: 404, body: "" };
    const r = await supabase("GET", "agent_marketing_research", null, `?id=eq.${id}&user_id=eq.${userId}&select=*&limit=1`);
    const row = Array.isArray(r.data) ? r.data[0] : null;
    if (!row) return { statusCode: 404, body: "" };
    if (row.status !== "running") return { statusCode: 200, body: "" }; // a duplicate dispatch does nothing
    const source = row.data_source || "web";
    if ((source !== "upload" && !process.env.PERPLEXITY_API_KEY) || (source !== "web" && !process.env.ANTHROPIC_API_KEY)) {
      await writeRow(id, userId, { status: "failed", error: "Research is not set up yet.", charged_at: null, updated_at: new Date().toISOString() });
      return { statusCode: 200, body: "" };
    }
    // The agent's confirmed report(s), read fresh by id and owner. If one was removed since the request started, nothing is charged.
    let uploads = [];
    const refs = Array.isArray(row.upload_refs) ? row.upload_refs.map((x) => x && x.id).filter((x) => am.UUID_RE.test(String(x || ""))) : [];
    if (source !== "web") {
      const ur = await supabase("GET", "agent_marketing_uploads", null, `?id=in.(${refs.join(",")})&user_id=eq.${userId}&status=eq.confirmed&select=id,facts`);
      uploads = Array.isArray(ur.data) ? ur.data : [];
      if (!refs.length || uploads.length !== refs.length) {
        await writeRow(id, userId, { status: "failed", error: "A report you attached was removed before the research finished. This did not use a session.", charged_at: null, updated_at: new Date().toISOString() });
        return { statusCode: 200, body: "" };
      }
    }
    const { fields, problems, attempts } = await runLib.runResearch({ row, apiKey: process.env.PERPLEXITY_API_KEY, uploads, anthropicKey: process.env.ANTHROPIC_API_KEY });
    if (fields.status === "failed") console.error(`[agent-marketing-research] ${id} failed after ${attempts} attempt(s): ${(problems || []).join("; ").slice(0, 400)} ${fields.error || ""}`);
    await writeRow(id, userId, fields);
  } catch (err) {
    console.error(`[agent-marketing-research-background] ${id || "unknown"} failed:`, err.message);
    if (id && userId) {
      try { await writeRow(id, userId, { status: "failed", error: "The research could not be completed.", charged_at: null, updated_at: new Date().toISOString() }); }
      catch (e) { console.error("[agent-marketing-research-background] could not write failed status:", e.message); }
    }
  }
  return { statusCode: 200, body: "" };
};
