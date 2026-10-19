// reel-quota-lib.js — Reel allotments and the not-downloaded render counter (Oct 19, 2026).
//
// RULES (Sam):
//   Allotment per month, no roll-over: Solo 4, Team 10, Team lead 10, Brokerage 35.
//   Free Trial: 1 Reel total. Listing Package: 3 Reels per package purchased (lifetime).
//   A Reel is charged once, at DOWNLOAD (Branded + Unbranded together = one charge): against the
//   allotment first, then 1 Image per Reel beyond it.
//   Waste fee: each user has one counter of Reels rendered but not downloaded. A completed render
//   adds 1. Any download resets it to 0. The 5th undownloaded render charges 1 Image and resets to 0.
//   Failed renders do not count. Re-renders are ordinary renders and do count.
//
// All counter/quota decisions are made atomically in Postgres (reel_* functions, service_role only).
// getPlanContext mirrors video-job.js; keep the two in sync (follow-up: share one module).
const https = require("https");
const { supabase } = require("./marketing-profile-lib");

const MONTHLY_REEL_LIMIT = { individual_agent: 4, team_member: 10, team_lead: 10, broker_admin: 35 };
const TRIAL_REEL_LIMIT = 1;
const PACKAGE_REELS_PER_PACKAGE = 3;
const WASTE_RENDER_THRESHOLD = 5;
const LIFETIME_PERIOD = "1970-01-01";
const TRIAL_LENGTH_MS = 30 * 24 * 60 * 60 * 1000;

async function getPlanContext(userId) {
  const userRes = await supabase("GET", "users", null,
    `?id=eq.${userId}&select=role,subscription_status,created_at,package_access_expires_at`);
  const u = (Array.isArray(userRes.data) && userRes.data[0]) || {};
  const status = u.subscription_status || null;
  const isTrial = status === "trial";
  const isPackage = status === "package";
  let packageCount = 0;
  if (isPackage) {
    const pk = await supabase("GET", "listing_packages", null, `?user_id=eq.${userId}&select=id`);
    packageCount = Array.isArray(pk.data) ? pk.data.length : 0;
  }
  let accessOk;
  if (status === "active" || status === "past_due") accessOk = true;
  else if (isTrial) accessOk = !u.created_at || (Date.now() - new Date(u.created_at).getTime()) <= TRIAL_LENGTH_MS;
  else if (isPackage) accessOk = !!u.package_access_expires_at && new Date(u.package_access_expires_at).getTime() > Date.now();
  else accessOk = false;
  return { role: u.role, status, isTrial, isPackage, packageCount, accessOk };
}

function currentPeriodStart() {
  const now = new Date();
  return `${now.getUTCFullYear()}-${String(now.getUTCMonth() + 1).padStart(2, "0")}-01`;
}
// Trial and packages are lifetime pools (a trial Reel never renews at a month boundary).
function periodFor(ctx) { return (ctx.isPackage || ctx.isTrial) ? LIFETIME_PERIOD : currentPeriodStart(); }
function limitFor(ctx) {
  if (ctx.isTrial) return TRIAL_REEL_LIMIT;
  if (ctx.isPackage) return ctx.packageCount * PACKAGE_REELS_PER_PACKAGE;
  return MONTHLY_REEL_LIMIT[ctx.role] ?? MONTHLY_REEL_LIMIT.individual_agent;
}

async function rpc(name, args) {
  const r = await supabase("POST", `rpc/${name}`, args || {});
  if (r.status >= 300) throw new Error(`rpc ${name} failed (${r.status}): ${JSON.stringify(r.data).slice(0, 200)}`);
  return r.data;
}

function callDebitCredit(userId, cost, reason) {
  return new Promise((resolve, reject) => {
    const url = new URL(`${process.env.SITE_URL}/.netlify/functions/debit-credit`);
    const bodyStr = JSON.stringify({ userId, cost, reason, isRefund: false });
    const req = https.request({
      hostname: url.hostname, path: url.pathname, method: "POST",
      headers: { "Content-Type": "application/json", "Content-Length": Buffer.byteLength(bodyStr), "x-internal-key": process.env.INTERNAL_API_KEY || "" },
    }, (res) => {
      let d = ""; res.on("data", (c) => (d += c));
      res.on("end", () => { try { resolve({ status: res.statusCode, data: JSON.parse(d || "{}") }); } catch { resolve({ status: res.statusCode, data: d }); } });
    });
    req.on("error", reject); req.write(bodyStr); req.end();
  });
}

async function getCounter(userId) {
  const r = await supabase("GET", "reel_render_counter", null, `?user_id=eq.${userId}&select=undownloaded,owed_images`);
  const row = (Array.isArray(r.data) && r.data[0]) || {};
  return { undownloaded: row.undownloaded || 0, owed: row.owed_images || 0 };
}

// Called once a render completes (from the Railway webhook or the status poll — whichever comes first).
// Idempotent per job. On the 5th undownloaded render, charges 1 Image; if that debit fails
// (e.g. no Images left) the fee is recorded as owed and collected before the next render starts.
async function countCompletion(jobId, keys) {
  const res = await rpc("reel_count_completion", {
    p_job_id: jobId, p_branded: (keys && keys.branded) || null, p_unbranded: (keys && keys.unbranded) || null,
  });
  let wasteCharged = false, wasteOwed = false;
  if (res && res.counted && res.waste) {
    try {
      const d = await callDebitCredit(res.user_id, 1, "reel_unused_renders");
      if (d.status === 200) wasteCharged = true;
      else { await rpc("reel_owed_adjust", { p_user_id: res.user_id, p_delta: 1 }); wasteOwed = true; }
    } catch (e) {
      console.error("reel waste-fee debit error:", e.message);
      await rpc("reel_owed_adjust", { p_user_id: res.user_id, p_delta: 1 }).catch(() => {});
      wasteOwed = true;
    }
  }
  return { ...res, wasteCharged, wasteOwed };
}

// Before a new render starts: collect any waste fee that could not be charged earlier.
// Returns null when clear, or an error object { error, status } to block the render.
async function settleOwed(userId) {
  const { owed } = await getCounter(userId);
  if (!owed) return null;
  const d = await callDebitCredit(userId, 1, "reel_unused_renders");
  if (d.status === 200) { await rpc("reel_owed_adjust", { p_user_id: userId, p_delta: -1 }); return null; }
  return { status: 402, error: "insufficient_credits", message: "You have an unpaid Image charge for unused Reel renders (5 renders not downloaded = 1 Image). Add Images to continue." };
}

async function getQuotaSummary(userId) {
  const ctx = await getPlanContext(userId);
  const limit = limitFor(ctx);
  const period = periodFor(ctx);
  const u = await supabase("GET", "video_quota_usage", null, `?user_id=eq.${userId}&period_start=eq.${period}&select=reels_downloaded`);
  const used = (Array.isArray(u.data) && u.data[0] && u.data[0].reels_downloaded) || 0;
  const c = await getCounter(userId);
  return {
    plan: ctx.isTrial ? "trial" : ctx.isPackage ? "package" : "subscription",
    limit, used, remaining: Math.max(0, limit - used),
    undownloaded: c.undownloaded, threshold: WASTE_RENDER_THRESHOLD, accessOk: ctx.accessOk,
  };
}

// Charge-at-download. Returns { error } | { via, images, keys } (idempotent for a job already downloaded).
async function chargeDownload(jobId, userId) {
  const ctx = await getPlanContext(userId);
  if (!ctx.accessOk) return { error: "no_active_subscription" };
  const res = await rpc("reel_consume_download", { p_job_id: jobId, p_user_id: userId, p_period: periodFor(ctx), p_limit: limitFor(ctx) });
  if (res.error) return { error: res.error };
  const keys = { branded: res.branded_key || null, unbranded: res.unbranded_key || null };
  if (res.already) return { already: true, via: null, images: 0, keys };
  if (res.images > 0) {
    let d;
    try { d = await callDebitCredit(userId, res.images, "reel_download"); }
    catch (e) { d = { status: 500, data: { error: e.message } }; }
    if (d.status !== 200) {
      await rpc("reel_revert_download", { p_job_id: jobId, p_user_id: userId, p_prev: res.prev_undownloaded || 0 }).catch((e) => console.error("reel revert failed:", e.message));
      if (d.status === 402) return { error: d.data && d.data.code === "NO_SUB" ? "no_active_subscription" : "insufficient_credits", required: res.images, balance: d.data && d.data.balance };
      throw new Error(`Credit debit failed (status ${d.status})`);
    }
  }
  return { via: res.via, images: res.images, keys };
}

module.exports = {
  MONTHLY_REEL_LIMIT, TRIAL_REEL_LIMIT, PACKAGE_REELS_PER_PACKAGE, WASTE_RENDER_THRESHOLD,
  getPlanContext, limitFor, periodFor, rpc, getCounter, countCompletion, settleOwed, getQuotaSummary, chargeDownload,
};
