// smart-correct-usage.js — Netlify Function
// Smart Correct™ charge model: 5 corrections = 1 image credit, billed as a
// lifetime running counter with a carried remainder (Sam's decision, Aug 16
// 2026) — NOT per-session, NOT per-period. Sam's explicit call: "block and
// prompt the user to buy extra images. No free lunch" — same overage-modal
// convention every other credit-consuming action in this app already uses
// (Generate Final, Kling generation, video download), via debit-credit.js's
// NO_CREDITS code. Smart Correct is the only action that debits in
// increments smaller than 1-per-use, so the block has to be computed against
// a *prospective* batch rather than a fixed per-action cost.
//
// Two actions, mirroring video-job.js's ?action=balance GET pattern:
//   GET  ?action=quote&userId=...&count=N
//     Read-only. Tells the frontend whether a batch of N photos can run
//     without ever mutating smart_correct_usage or credit_ledger. Called
//     BEFORE runSmartCorrectBatch() dispatches anything to Railway.
//   POST { userId, correctionsCompleted }
//     Called AFTER a batch actually finishes, with the number of photos
//     that ACTUALLY corrected successfully (not the requested batch size —
//     a photo that errors server-side never counts). Atomically increments
//     the lifetime counter, and if that crosses a new multiple of 5, debits
//     the owed credit(s) through debit-credit.js (same subscription/trial/
//     balance checks every other Image charge gets) and commits the charge.
//
// Two-phase commit (increment → debit → commit) is deliberate: if the debit
// somehow fails after the pre-flight quote passed (e.g. a concurrent batch
// from another tab drained the balance in between), the correction count
// still advances but credits_charged does not — so the shortfall is simply
// picked up and re-blocked on the NEXT quote call, never silently lost or
// double-charged. See increment_smart_correct_usage / commit_smart_correct_
// charge in Supabase for the atomic halves of this.

const https = require("https");

function supabase(method, path, body) {
  return new Promise((resolve, reject) => {
    const url = new URL(`${process.env.SUPABASE_URL}/rest/v1/${path}`);
    const bodyStr = body ? JSON.stringify(body) : null;
    const req = https.request({
      hostname: url.hostname,
      path:     url.pathname + url.search,
      method,
      headers: {
        "apikey":        process.env.SUPABASE_SERVICE_ROLE_KEY,
        "Authorization": `Bearer ${process.env.SUPABASE_SERVICE_ROLE_KEY}`,
        "Content-Type":  "application/json",
        "Prefer":        "return=representation",
        ...(bodyStr ? { "Content-Length": Buffer.byteLength(bodyStr) } : {}),
      },
    }, res => {
      let data = "";
      res.on("data", c => data += c);
      res.on("end", () => {
        try { resolve({ status: res.statusCode, data: JSON.parse(data || "[]") }); }
        catch { resolve({ status: res.statusCode, data }); }
      });
    });
    req.on("error", reject);
    if (bodyStr) req.write(bodyStr);
    req.end();
  });
}

// Same pattern as video-job.js's callDebitCredit — same balance/subscription/
// trial checks and same ledger write every other Image charge in this app
// goes through. Never duplicate that logic here.
function callDebitCredit(userId, cost, reason) {
  return new Promise((resolve, reject) => {
    const url = new URL(`${process.env.SITE_URL}/.netlify/functions/debit-credit`);
    const bodyStr = JSON.stringify({ userId, cost, reason });
    const req = https.request({
      hostname: url.hostname,
      path:     url.pathname,
      method:   "POST",
      headers: {
        "Content-Type":   "application/json",
        "Content-Length": Buffer.byteLength(bodyStr),
      },
    }, res => {
      let data = "";
      res.on("data", c => data += c);
      res.on("end", () => {
        try { resolve({ status: res.statusCode, data: JSON.parse(data || "{}") }); }
        catch { resolve({ status: res.statusCode, data }); }
      });
    });
    req.on("error", reject);
    req.write(bodyStr);
    req.end();
  });
}

async function getCurrentBalance(userId) {
  const res = await supabase("GET",
    `credit_ledger?user_id=eq.${userId}&order=created_at.desc&limit=1&select=balance_after`
  );
  return res.data?.[0]?.balance_after ?? 0;
}

exports.handler = async (event) => {
  const headers = {
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Headers": "Content-Type",
    "Content-Type": "application/json",
  };

  if (event.httpMethod === "OPTIONS") return { statusCode: 200, headers, body: "" };

  try {
    // ── QUOTE (read-only, pre-flight block check) ─────────────────────────
    if (event.httpMethod === "GET" && event.queryStringParameters?.action === "quote") {
      const userId = event.queryStringParameters?.userId;
      const count = parseInt(event.queryStringParameters?.count, 10);
      if (!userId || !Number.isFinite(count) || count < 1) {
        return { statusCode: 400, headers, body: JSON.stringify({ error: "Missing userId or count" }) };
      }

      const quoteRes = await supabase("POST", "rpc/quote_smart_correct_charge", {
        p_user_id: userId,
        p_count: count,
      });
      const q = Array.isArray(quoteRes.data) ? quoteRes.data[0] : null;
      if (!q) return { statusCode: 500, headers, body: JSON.stringify({ error: "Quote failed" }) };

      const balance = await getCurrentBalance(userId);
      const creditsOwed = Math.max(0, q.credits_owed);
      const sufficient = balance >= creditsOwed;

      return {
        statusCode: 200,
        headers,
        body: JSON.stringify({
          totalBefore: q.total_before,
          creditsChargedBefore: q.credits_charged_before,
          creditsOwedIfRun: creditsOwed,
          balance,
          sufficient,
        }),
      };
    }

    // ── STATUS (read-only, for the header chip — no prospective batch) ────
    if (event.httpMethod === "GET" && event.queryStringParameters?.action === "status") {
      const userId = event.queryStringParameters?.userId;
      if (!userId) return { statusCode: 400, headers, body: JSON.stringify({ error: "Missing userId" }) };

      const quoteRes = await supabase("POST", "rpc/quote_smart_correct_charge", {
        p_user_id: userId,
        p_count: 0,
      });
      const q = Array.isArray(quoteRes.data) ? quoteRes.data[0] : null;
      if (!q) return { statusCode: 500, headers, body: JSON.stringify({ error: "Status check failed" }) };

      const remainder = q.total_before - (q.credits_charged_before * 5);
      return {
        statusCode: 200,
        headers,
        body: JSON.stringify({
          totalCorrections: q.total_before,
          creditsCharged: q.credits_charged_before,
          correctionsTowardNextCredit: remainder, // 0-4
        }),
      };
    }

    // ── COMMIT (called after a batch actually completes) ─────────────────
    if (event.httpMethod === "POST") {
      const { userId, correctionsCompleted } = JSON.parse(event.body || "{}");
      const count = parseInt(correctionsCompleted, 10);
      if (!userId || !Number.isFinite(count) || count < 1) {
        return { statusCode: 400, headers, body: JSON.stringify({ error: "Missing userId or correctionsCompleted" }) };
      }

      const incRes = await supabase("POST", "rpc/increment_smart_correct_usage", {
        p_user_id: userId,
        p_count: count,
      });
      const inc = Array.isArray(incRes.data) ? incRes.data[0] : null;
      if (!inc) return { statusCode: 500, headers, body: JSON.stringify({ error: "Usage increment failed" }) };

      const owed = Math.max(0, inc.credits_owed);
      if (owed === 0) {
        return {
          statusCode: 200,
          headers,
          body: JSON.stringify({
            totalCorrections: inc.total_corrections,
            creditsCharged: inc.credits_charged,
            creditsChargedThisBatch: 0,
          }),
        };
      }

      // Pre-flight quote should have guaranteed this succeeds — see the
      // two-phase-commit note at the top of this file for what happens if
      // it doesn't (rare race, self-heals on next quote/commit cycle).
      const debitRes = await callDebitCredit(userId, owed, "smart_correct_batch");
      if (debitRes.status !== 200) {
        return {
          statusCode: 200,
          headers,
          body: JSON.stringify({
            totalCorrections: inc.total_corrections,
            creditsCharged: inc.credits_charged,
            creditsChargedThisBatch: 0,
            chargeDeferred: true,
            chargeError: debitRes.data?.error || "Charge deferred — will retry on next batch",
          }),
        };
      }

      await supabase("POST", "rpc/commit_smart_correct_charge", {
        p_user_id: userId,
        p_amount: owed,
      });

      return {
        statusCode: 200,
        headers,
        body: JSON.stringify({
          totalCorrections: inc.total_corrections,
          creditsCharged: inc.credits_charged + owed,
          creditsChargedThisBatch: owed,
          newBalance: debitRes.data?.balance,
        }),
      };
    }

    return { statusCode: 405, headers, body: JSON.stringify({ error: "Method not allowed" }) };
  } catch (err) {
    console.error("smart-correct-usage error:", err.message);
    return { statusCode: 500, headers, body: JSON.stringify({ error: err.message }) };
  }
};
