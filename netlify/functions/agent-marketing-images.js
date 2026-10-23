// agent-marketing-images.js — Netlify Function. Concept images (GPT Image 2) for Agent Marketing (Oct 22, 2026).
// Same switch as the rest of the feature; 404 when off.
//
//   GET  ?projectId=                       → every image slot (scene x format): latest state, preview link, what the next
//                                            generation costs, and the project's generation count and cap
//   POST { action: "generate", projectId, sceneIndex, format, confirmCharge? }
//        Starts one generation. The first image of a slot and one redo are included; later redos cost Images and are only
//        started when confirmCharge is true (otherwise the call answers 402 with the exact price so the page can ask).
//   POST { action: "accept", projectId, assetId }            → makes it the approved image for that scene + format
//   POST { action: "reject", projectId, assetId }            → discards a draft
//   POST { action: "keep", projectId, assetId }              → saves an image to My Marketing Photos for reuse
//
// Rules in code: only scenes the planner marked as new images (GPT_IMAGE_2_CONCEPT or AGENT_SCENE); the agent scene needs a
// photo in the user's Marketing Profile; the 16:9 version of a scene is built from the approved 9:16 image when there is one;
// a hard cap on generations per project; charges are made before the call and refunded if it fails.
const { S3Client, GetObjectCommand } = require("@aws-sdk/client-s3");
const { getSignedUrl } = require("@aws-sdk/s3-request-presigner");
const { supabase } = require("./lib/marketing-profile-lib");
const { requireUser } = require("./lib/reel-auth-lib");
const quota = require("./lib/reel-quota-lib");
const am = require("./lib/agent-marketing-lib");
const img = require("./lib/agent-marketing-images-lib");

const headers = { "Access-Control-Allow-Origin": "*", "Content-Type": "application/json", "Cache-Control": "no-store" };
const reply = (statusCode, obj) => ({ statusCode, headers, body: JSON.stringify(obj) });
const rowsOf = (r) => (r && Array.isArray(r.data) ? r.data : []);
const s3 = new S3Client({ region: process.env.S3_REGION, credentials: { accessKeyId: process.env.S3_ACCESS_KEY_ID, secretAccessKey: process.env.S3_SECRET_ACCESS_KEY } });
async function presignGet(key) {
  try { return await getSignedUrl(s3, new GetObjectCommand({ Bucket: process.env.S3_BUCKET_NAME, Key: key }), { expiresIn: 3600 }); } catch (e) { return null; }
}
const SELECTABLE = ["narrative_approved", "images", "ready_to_render"];

async function loadProject(id, userId) {
  if (!am.UUID_RE.test(String(id || ""))) return { error: reply(400, { error: "Missing or invalid project id" }) };
  const r = await supabase("GET", "agent_marketing_projects", null, `?id=eq.${id}&user_id=eq.${userId}&select=id,status,formats,narrative&limit=1`);
  const row = rowsOf(r)[0];
  if (!row) return { error: reply(404, { error: "Project not found" }) };
  return { row };
}
const loadAssets = async (projectId, userId) => rowsOf(await supabase("GET", "agent_marketing_assets", null, `?project_id=eq.${projectId}&user_id=eq.${userId}&source=eq.gpt_image_2&select=*&order=created_at.asc&limit=200`));

// A generation that never finished (worker died) is closed out and its charge refunded, so it cannot block the slot.
async function reapStale(assets, userId) {
  const now = Date.now();
  for (const a of assets) {
    const g = a.generation || {};
    if (g.state === "generating" && g.startedAt && now - Date.parse(g.startedAt) > img.STALE_GENERATING_MS) {
      const gen = { ...g, state: "error", error: "Timed out", finishedAt: new Date().toISOString() };
      await supabase("PATCH", "agent_marketing_assets", { generation: gen, status: "rejected" }, `?id=eq.${a.id}&user_id=eq.${userId}`);
      if (g.charged && g.charged.credits && !g.refunded) {
        try { const r = await quota.callDebitCredit(userId, g.charged.credits, "agent_marketing_image_refund_dispatch_failed", true); if (r.status === 200) gen.refunded = true; } catch (e) { console.error("stale refund failed:", e.message); }
        await supabase("PATCH", "agent_marketing_assets", { generation: gen }, `?id=eq.${a.id}&user_id=eq.${userId}`);
      }
      a.generation = gen; a.status = "rejected";
    }
  }
}

async function viewOf(a) {
  const g = a.generation || {};
  return { id: a.id, sceneIndex: a.scene_index, format: g.format, state: g.state, status: a.status, version: a.version, error: g.state === "error" ? g.error : null, url: g.state === "done" && a.asset_key ? await presignGet(a.asset_key) : null };
}

exports.handler = async (event) => {
  if (event.httpMethod === "OPTIONS") return { statusCode: 204, headers: { ...headers, "Access-Control-Allow-Headers": "Content-Type, Authorization", "Access-Control-Allow-Methods": "GET, POST, OPTIONS" }, body: "" };
  const auth = await requireUser(event);
  if (auth.error) return reply(auth.error.status, auth.error.body);
  const userId = auth.user.id;
  if (!am.isEnabledFor(userId)) return reply(404, { error: "Not found" });

  try {
    if (event.httpMethod === "GET") {
      const p = await loadProject((event.queryStringParameters || {}).projectId, userId);
      if (p.error) return p.error;
      const assets = await loadAssets(p.row.id, userId);
      await reapStale(assets, userId);
      const st = img.settings();
      const slots = [];
      for (const { index, scene } of img.imageScenes(p.row.narrative)) {
        for (const format of p.row.formats || []) {
          const mine = assets.filter((a) => a.scene_index === index && img.fmtOf(a) === format);
          const latest = mine[mine.length - 1];
          const approved = mine.filter((a) => a.status === "approved").pop();
          const q = img.quote(assets, index, format);
          slots.push({ sceneIndex: index, kind: scene.visualSource, format, latest: latest ? await viewOf(latest) : null, approved: approved ? await viewOf(approved) : null, used: q.used, included: q.included, nextCredits: q.credits, capReached: q.capReached });
        }
      }
      return reply(200, { slots, projectTotal: assets.filter(img.counts).length, projectCap: st.projectCap, creditsPerExtra: st.credits });
    }

    if (event.httpMethod !== "POST") return reply(405, { error: "Method not allowed" });
    let b; try { b = JSON.parse(event.body || "{}"); } catch { return reply(400, { error: "Invalid JSON" }); }
    const p = await loadProject(b.projectId, userId);
    if (p.error) return p.error;
    const project = p.row;
    const assets = await loadAssets(project.id, userId);
    await reapStale(assets, userId);

    if (["accept", "reject", "keep"].includes(b.action)) {
      const a = assets.find((x) => x.id === b.assetId);
      if (!a) return reply(404, { error: "Image not found" });
      if (img.stateOf(a) !== "done") return reply(409, { error: "That image is not ready." });
      if (b.action === "reject") { await supabase("PATCH", "agent_marketing_assets", { status: "rejected" }, `?id=eq.${a.id}&user_id=eq.${userId}`); return reply(200, { ok: true }); }
      if (b.action === "keep") {
        const ins = await supabase("POST", "agent_marketing_library", { user_id: userId, kind: "generated", asset_key: a.asset_key, content_type: "image/png", label: null, rights: { route: "generated", model: (a.generation || {}).model || null, aiGenerated: true, sourceProject: project.id }, project_id: project.id, generation: { prompt: (a.generation || {}).prompt || null, format: img.fmtOf(a) } });
        return ins && ins.status < 300 ? reply(200, { ok: true }) : reply(500, { error: "Could not save that image" });
      }
      // accept: one approved image per scene + format
      for (const o of assets) {
        if (o.id !== a.id && o.scene_index === a.scene_index && img.fmtOf(o) === img.fmtOf(a) && o.status === "approved") await supabase("PATCH", "agent_marketing_assets", { status: "rejected" }, `?id=eq.${o.id}&user_id=eq.${userId}`);
      }
      await supabase("PATCH", "agent_marketing_assets", { status: "approved" }, `?id=eq.${a.id}&user_id=eq.${userId}`);
      if (project.status === "narrative_approved") await supabase("PATCH", "agent_marketing_projects", { status: "images", updated_at: new Date().toISOString() }, `?id=eq.${project.id}&user_id=eq.${userId}`);
      return reply(200, { ok: true });
    }

    if (b.action !== "generate") return reply(400, { error: "Unknown action" });
    if (!SELECTABLE.includes(project.status)) return reply(409, { error: "Approve your script before creating images." });
    if (!process.env.OPENAI_API_KEY) return reply(500, { error: "Image generation is not configured." });
    const sceneIndex = Number(b.sceneIndex), format = String(b.format || "");
    const target = img.imageScenes(project.narrative).find((x) => x.index === sceneIndex);
    if (!target) return reply(400, { error: "That scene does not use a generated image." });
    if (!(project.formats || []).includes(format) || !img.SIZES[format]) return reply(400, { error: "Choose one of this project's formats." });
    if ((assets.filter((a) => a.scene_index === sceneIndex && img.fmtOf(a) === format && img.stateOf(a) === "generating")).length) return reply(409, { error: "This image is already being created." });

    const q = img.quote(assets, sceneIndex, format);
    if (q.capReached) return reply(409, { error: `This project has reached its limit of ${q.projectCap} generated images.`, code: "cap_reached" });

    // Reference: the agent scene uses the agent's own profile photo; a 16:9 version uses the approved 9:16 image.
    let referenceKey = null, fromApproved = false;
    const approvedPortrait = assets.filter((a) => a.scene_index === sceneIndex && img.fmtOf(a) === "9x16" && a.status === "approved" && img.stateOf(a) === "done" && a.asset_key).pop();
    if (format === "16x9" && approvedPortrait) { referenceKey = approvedPortrait.asset_key; fromApproved = true; }
    else if (target.scene.visualSource === "AGENT_SCENE") {
      const pr = rowsOf(await supabase("GET", "marketing_profiles", null, `?user_id=eq.${userId}&select=headshot_key,fullbody_key&limit=1`))[0];
      referenceKey = img.pickReferenceKey(pr);
      if (!referenceKey) return reply(409, { error: "Add a headshot or full-body photo to your Marketing Profile first.", code: "profile_photo_needed" });
    }
    if (q.charged && b.confirmCharge !== true) return reply(402, { error: "This image costs extra.", code: "confirm_charge", credits: q.credits });
    const st = img.settings();
    const prompt = img.buildPrompt({ kind: target.scene.visualSource === "AGENT_SCENE" ? "agent_scene" : "concept", scenePrompt: target.scene.aiGenerationPrompt, format, fromApproved });

    // Charge first (only for extras); refunded by the worker or the stale check if the image never arrives.
    let charged = null;
    if (q.charged) {
      let d;
      try { d = await quota.callDebitCredit(userId, q.credits, "agent_marketing_image"); } catch (e) { d = { status: 500, data: {} }; }
      if (d.status === 402) return reply(402, { error: "You don't have enough Images for this.", code: "insufficient_credits", credits: q.credits });
      if (d.status !== 200) return reply(502, { error: "Could not process the charge. Please try again." });
      charged = { credits: q.credits };
    }
    const version = Math.max(0, ...assets.filter((a) => a.scene_index === sceneIndex).map((a) => a.version || 0)) + 1;
    // A new draft replaces any unaccepted earlier draft for this slot.
    for (const o of assets) if (o.scene_index === sceneIndex && img.fmtOf(o) === format && o.status === "proposed") await supabase("PATCH", "agent_marketing_assets", { status: "rejected" }, `?id=eq.${o.id}&user_id=eq.${userId}`);
    const generation = { state: "generating", format, kind: target.scene.visualSource === "AGENT_SCENE" ? "agent_scene" : "concept", prompt, scenePrompt: target.scene.aiGenerationPrompt || null, referenceKey, fromApproved, quality: st.quality, size: img.SIZES[format], charged, startedAt: new Date().toISOString(), attempt: q.used + 1 };
    const ins = await supabase("POST", "agent_marketing_assets", { project_id: project.id, user_id: userId, scene_index: sceneIndex, version, source: "gpt_image_2", ai_generated: true, status: "proposed", asset_key: null, generation, rights: { route: "generated", aiGenerated: true } });
    const row = rowsOf(ins)[0];
    if (!ins || ins.status >= 300 || !row) {
      if (charged) { try { await quota.callDebitCredit(userId, charged.credits, "agent_marketing_image_refund_dispatch_failed", true); } catch (e) { console.error("refund failed:", e.message); } }
      return reply(500, { error: "Could not start the image." });
    }
    const siteUrl = process.env.URL || `https://${event.headers && event.headers.host}`;
    try {
      await fetch(`${siteUrl}/.netlify/functions/agent-marketing-image-background`, { method: "POST", headers: { "Content-Type": "application/json", "x-internal-key": process.env.INTERNAL_API_KEY }, body: JSON.stringify({ assetId: row.id, owner: userId }) });
    } catch (e) {
      console.error("agent-marketing image dispatch failed:", e.message);
      await supabase("PATCH", "agent_marketing_assets", { generation: { ...generation, state: "error", error: "Failed to start" }, status: "rejected" }, `?id=eq.${row.id}&user_id=eq.${userId}`);
      if (charged) { try { await quota.callDebitCredit(userId, charged.credits, "agent_marketing_image_refund_dispatch_failed", true); } catch (e2) { console.error("refund failed:", e2.message); } }
      return reply(502, { error: "The image could not be started. Please try again." });
    }
    return reply(202, { assetId: row.id, charged: !!charged, credits: charged ? charged.credits : 0 });
  } catch (e) {
    console.error("agent-marketing-images error:", e.message);
    return reply(500, { error: "Something went wrong. Please try again." });
  }
};
