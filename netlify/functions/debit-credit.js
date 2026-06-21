// netlify/functions/debit-credit.js
// Debits credits from credit_ledger on Generate Final (images), video
// generation/iteration (Kling), or video download. Returns new balance.
// Blocks if insufficient credits. Uses service role key — never call with
// frontend publishable key.
//
// CHANGE (Image Economy v2): added isRefund support. This exists ONLY for
// the narrow platform-failure case in video-job.js — a Kling generation
// debit succeeded, but row creation or Railway dispatch failed afterward,
// so the user was charged for a video that never got created. This is NOT
// a general-purpose "undo any charge" mechanism — user-side regret (didn't
// like the result, changed their mind) is never refundable, per the locked
// spec. isRefund:true skips the balance-sufficiency check (a refund should
// never be blocked by "insufficient balance" — that's nonsensical for a
// credit) and writes a positive ledger entry instead of a negative one.

const https = require('https');

const SUPABASE_URL    = process.env.SUPABASE_URL;
const SERVICE_KEY     = process.env.SUPABASE_SERVICE_ROLE_KEY;

// Monthly allocations by role
const TIER_ALLOCATION = {
  individual_agent: 50,   // Solo $49
  team_member:      125,  // Team $99
  team_lead:        125,  // Team $99
  broker_admin:     400,  // Brokerage $279
};

function sbRequest(method, path, body) {
  return new Promise((resolve, reject) => {
    const url = new URL(SUPABASE_URL + path);
    const payload = body ? JSON.stringify(body) : null;
    const options = {
      hostname: url.hostname,
      path: url.pathname + url.search,
      method,
      headers: {
        'apikey': SERVICE_KEY,
        'Authorization': 'Bearer ' + SERVICE_KEY,
        'Content-Type': 'application/json',
        'Prefer': 'return=representation',
        ...(payload ? { 'Content-Length': Buffer.byteLength(payload) } : {}),
      },
    };
    const req = https.request(options, (res) => {
      let data = '';
      res.on('data', d => data += d);
      res.on('end', () => {
        try { resolve({ status: res.statusCode, body: JSON.parse(data) }); }
        catch { resolve({ status: res.statusCode, body: data }); }
      });
    });
    req.on('error', reject);
    if (payload) req.write(payload);
    req.end();
  });
}

exports.handler = async (event) => {
  if (event.httpMethod !== 'POST') {
    return { statusCode: 405, body: JSON.stringify({ error: 'Method not allowed' }) };
  }

  let body;
  try { body = JSON.parse(event.body); }
  catch { return { statusCode: 400, body: JSON.stringify({ error: 'Invalid JSON' }) }; }

  // CHANGE: destructure `reason` and the new `isRefund` flag from the
  // request body. reason defaults to 'generate_final' below at the insert
  // step, so the existing image-staging caller (which never sends `reason`)
  // behaves identically to before. video-job.js passes reason values like
  // 'kling_generation', 'kling_generation_iteration', 'video_download', and
  // on the narrow refund path, isRefund: true with a reason ending in
  // '_refund_dispatch_failed'.
  const { userId, cost, reason, isRefund } = body;
  // cost is always given as a positive magnitude regardless of direction —
  // isRefund determines whether it's added or subtracted below. This keeps
  // the validation simple and prevents any caller from passing a negative
  // number to sneak around the balance check on a real debit.
  if (!userId || typeof cost !== 'number' || cost < 1) {
    return { statusCode: 400, body: JSON.stringify({ error: 'Missing userId or cost' }) };
  }

  try {
    // 1. Get current balance — most recent ledger entry
    const ledgerRes = await sbRequest('GET',
      `/rest/v1/credit_ledger?user_id=eq.${userId}&order=created_at.desc&limit=1&select=balance_after`
    );

    // 2. Get user role + team for tier allocation and ledger attribution.
    // CHANGE (Image Economy v2): added team_id to this existing query — no
    // new round-trip, just one more column. Needed so video/Kling spend
    // can be attributed to a team for team-admin spend rollups (existing
    // image-staging debits never populated this; see ledger insert below
    // for why that path is intentionally left unchanged).
    const userRes = await sbRequest('GET',
      `/rest/v1/users?id=eq.${userId}&select=role,subscription_status,team_id&limit=1`
    );

    const userRec = Array.isArray(userRes.body) ? userRes.body[0] : null;

    // Hard block — must be active subscriber OR have free trial credits
    if (!userRec) {
      return {
        statusCode: 402,
        body: JSON.stringify({ error: 'No active subscription', code: 'NO_SUB' }),
      };
    }
    if (userRec.subscription_status !== 'active') {
      // Check for free trial credits before blocking
      const trialRes = await sbRequest('GET',
        `/rest/v1/credit_ledger?user_id=eq.${userId}&reason=eq.signup_trial&order=created_at.desc&limit=1&select=balance_after`
      );
      const trialBalance = Array.isArray(trialRes.body) && trialRes.body.length > 0
        ? trialRes.body[0].balance_after : 0;
      if (trialBalance <= 0) {
        return {
          statusCode: 402,
          body: JSON.stringify({ error: 'No active subscription', code: 'NO_SUB' }),
        };
      }
    }

    const currentBalance = Array.isArray(ledgerRes.body) && ledgerRes.body.length > 0
      ? ledgerRes.body[0].balance_after
      : (TIER_ALLOCATION[userRec.role] ?? 50); // First ever — use full allocation

    // 3. Check sufficient balance — SKIPPED for refunds. A refund credits
    // Images back; there's no version of "insufficient balance" that makes
    // sense for an operation that only ever increases the balance.
    if (!isRefund && currentBalance < cost) {
      return {
        statusCode: 402,
        body: JSON.stringify({
          error: 'Insufficient credits',
          code: 'NO_CREDITS',
          balance: currentBalance,
          cost,
        }),
      };
    }

    const newBalance = isRefund ? currentBalance + cost : currentBalance - cost;

    // CHANGE (Image Economy v2): video/Kling reasons attribute this ledger
    // row to the user's team, so a team admin's spend dashboard can roll
    // up Kling spend per team. Deliberately scoped to VIDEO_REASONS only —
    // the existing image-staging path (reason defaults to 'generate_final')
    // continues writing team_id as null, exactly as it always has. This
    // was a deliberate choice, not an oversight: extending team attribution
    // to image-staging charges too is a separate, bigger decision involving
    // a backfill of historical rows, and wasn't asked for here.
    const VIDEO_REASONS = new Set([
      'kling_generation', 'kling_generation_iteration', 'video_download',
      'kling_generation_refund_dispatch_failed', 'kling_iteration_refund_dispatch_failed',
    ]);
    const attributedTeamId = VIDEO_REASONS.has(reason) ? (userRec.team_id || null) : null;

    // 4. Write entry to ledger. CHANGE: amount is now signed based on
    // isRefund — positive for a refund credit, negative for a normal
    // debit, same as before. reason comes from the request, falling back
    // to 'generate_final' for callers that don't send it (unchanged
    // behavior for existing image-staging calls). team_id is new — see
    // VIDEO_REASONS above for exactly when it's populated.
    const insertRes = await sbRequest('POST', '/rest/v1/credit_ledger', {
      user_id:       userId,
      amount:        isRefund ? cost : -cost,
      balance_after: newBalance,
      type:          isRefund ? 'refund' : 'usage',
      reason:        reason || 'generate_final',
      team_id:       attributedTeamId,
    });

    if (insertRes.status !== 201) {
      console.error('Ledger insert failed:', insertRes.body);
      return { statusCode: 500, body: JSON.stringify({ error: 'Ledger write failed' }) };
    }

    return {
      statusCode: 200,
      body: JSON.stringify({ balance: newBalance, cost, charged: !isRefund, refunded: !!isRefund, reason: reason || 'generate_final' }),
    };

  } catch (err) {
    console.error('debit-credit error:', err.message);
    return { statusCode: 500, body: JSON.stringify({ error: err.message }) };
  }
};
