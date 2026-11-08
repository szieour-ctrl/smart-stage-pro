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

/**
 * Development deploys only (Nov 8, 2026): a branch deploy behind Netlify team login cannot call its own functions over HTTP, so there the PAGE
 * starts this job with the user's own login token (as it does for the B1 job). Accepted only with AGENT_MARKETING_B1_EVIDENCE=dev, on a
 * non-production host, against a non-production database; the user is always the token's user, never one named in the body.
 */
async function pageDispatchUser(event) {
  const env = process.env;
  if (!require("./lib/agent-marketing-b1-evidence-lib").enabled(env)) return null;
  const { requestHost } = require("./lib/self-dispatch-lib");
  const pc = require("./lib/public-config-lib");
  if (pc.isProductionHost(requestHost(event), env) || !env.SUPABASE_URL || String(env.SUPABASE_URL).includes(pc.PRODUCTION_REF)) return null;
  const auth = await require("./lib/reel-auth-lib").requireUser(event);
  return auth && !auth.error && auth.user ? auth.user.id : null;
}

exports.handler = async (event) => {
  const h = event.headers || {};
  const key = process.env.INTERNAL_API_KEY || "";
  let pageUser = null;
  if (!key || h["x-internal-key"] !== key) {
    pageUser = await pageDispatchUser(event);
    if (!pageUser) return { statusCode: 401, body: "" };
  }
  let id = null, userId = null;
  try {
    const body = JSON.parse(event.body || "{}");
    id = body.researchId; userId = pageUser || body.owner;
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
    // Article-Led only: every outbound provider request is checked against the 15-per-24-hours and 100-per-30-days limits BEFORE it is sent (fail closed if the rows cannot be
    // read), and the running row's count is written BEFORE each dispatch, so a crashed function still leaves its true count. Legacy research is not affected.
    const articleLed = require("./lib/agent-marketing-article-led-lib");
    const isAL = !!(row.usage && row.usage.pathway === "article_led");
    const rowsSelect = "id,created_at,charged_at,status,pathway:usage->>pathway,attempts:usage->>attempts,providerRequests:usage->>providerRequests,withdrawn:usage->>withdrawn";
    const quotaFn = isAL ? async (dispatched) => {
      const since = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000).toISOString();
      const pr = await supabase("GET", "agent_marketing_research", null, `?user_id=eq.${userId}&created_at=gte.${encodeURIComponent(since)}&select=${rowsSelect}&order=created_at.asc&limit=500`);
      if (!(pr.status < 300 && Array.isArray(pr.data))) return { allowed: false, scope: "unverifiable", used: null, limit: null };
      return articleLed.requestAllowance(pr.data, Date.now(), process.env, id, dispatched);
    } : undefined;
    const onDispatch = isAL ? async (n) => { await supabase("PATCH", "agent_marketing_research", { usage: { pathway: "article_led", providerRequests: n } }, `?id=eq.${id}&user_id=eq.${userId}&status=eq.running`); } : undefined;
    const { fields, problems, attempts } = await runLib.runResearch({ row, apiKey: process.env.PERPLEXITY_API_KEY, uploads, anthropicKey: process.env.ANTHROPIC_API_KEY, quotaFn, onDispatch, startingRequests: isAL ? (Number.isInteger(Number(row.usage && row.usage.providerRequests)) ? Number(row.usage.providerRequests) : 0) : 0 });
    if (fields.status === "failed") console.error(`[agent-marketing-research] ${id} failed after ${attempts} attempt(s): ${(problems || []).join("; ").slice(0, 400)} ${fields.error || ""}`);
    // Article-Led Market Update (modes 2 and 3, development switch AGENT_MARKETING_B1_EVIDENCE=dev): B1 reads the articles discovery found, and B2
    // turns B1's validated records into the five research cards (lib/agent-marketing-b2-lib.js). Off, or nothing usable: the discovery cards stay.
    const b2lib = require("./lib/agent-marketing-b2-lib");
    let finalFields = fields;
    try { finalFields = await b2lib.enrich({ row, fields, uploads, userId }); }
    catch (e) {
      console.error(`[agent-marketing-research] ${id} B1/B2 step failed:`, e.code || e.message);
      // Article-Led research never falls back to discovery cards: the set ends incomplete, uncharged, with the reason.
      if (fields.status === "ready" && b2lib.applies(row, process.env)) finalFields = { ...fields, status: "failed", topics: null, charged_at: null, error: "The Article-Led research could not be completed. This did not use a session. Start new research to try again.", usage: { ...(fields.usage || {}), b1b2: { state: "error" } } };
    }
    await writeRow(id, userId, finalFields);
  } catch (err) {
    console.error(`[agent-marketing-research-background] ${id || "unknown"} failed:`, err.message);
    if (id && userId) {
      try { await writeRow(id, userId, { status: "failed", error: "The research could not be completed.", charged_at: null, updated_at: new Date().toISOString() }); }
      catch (e) { console.error("[agent-marketing-research-background] could not write failed status:", e.message); }
    }
  }
  return { statusCode: 200, body: "" };
};
