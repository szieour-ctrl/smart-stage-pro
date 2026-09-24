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

// CHANGE (Sep 24, 2026 — security + Listing Package):
//  • AUTH. This function used to trust whatever userId the request body
//    carried, with no login check — and the isRefund path skips the balance
//    check and ADDS Images, so anyone signed in could mint unlimited Images
//    for themselves with one request. Now:
//      - browser callers must send their Supabase JWT (Authorization:
//        Bearer …) and it must belong to body.userId;
//      - server callers (video-job.js, smart-correct-usage.js) send the
//        shared secret INTERNAL_API_KEY in the x-internal-key header;
//      - isRefund is accepted ONLY from server callers.
//  • ACCESS. Each account status has an explicit rule (spendAccess below).
//    The old check read balance_after from the 'signup_trial' ledger row —
//    a signup snapshot, not the real balance — for every non-active status.
//    New: 'package' (the $59 Listing Package) spends while
//    users.package_access_expires_at is in the future.

const https  = require('https');
const crypto = require('crypto');

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

// Trial length — 30 days from signup (users.created_at), per the pricing
// page copy ("Expires 30 days after signup") which nothing in the backend
// previously enforced. A trial user's created_at IS their trial start —
// trg_seed_trial_credits (the Postgres trigger that grants the 10 trial
// Images) fires unconditionally on every new users row, before any other
// status is ever set, so there's no separate "trial began" moment to track
// with a new column.
const TRIAL_LENGTH_MS = 30 * 24 * 60 * 60 * 1000;

function isTrialExpired(createdAt) {
  if (!createdAt) return false; // defensive — never block on missing data
  return (Date.now() - new Date(createdAt).getTime()) > TRIAL_LENGTH_MS;
}

// Who may spend Images right now. Refunds bypass this (see handler).
function spendAccess(u) {
  switch (u.subscription_status) {
    case 'active':
    case 'past_due':   // Stripe is still retrying the card — access is kept
      return { ok: true };
    case 'trial':
      return isTrialExpired(u.created_at)
        ? { ok: false, body: { error: 'Free trial has ended', code: 'NO_SUB', trialExpired: true } }
        : { ok: true };
    case 'package': {
      const until = u.package_access_expires_at ? new Date(u.package_access_expires_at).getTime() : 0;
      return until > Date.now()
        ? { ok: true }
        : { ok: false, body: { error: 'Listing Package access has ended', code: 'NO_SUB', packageExpired: true } };
    }
    default:
      return { ok: false, body: { error: 'No active subscription', code: 'NO_SUB' } };
  }
}

// ── Caller authentication ─────────────────────────────────
function isInternalCaller(event) {
  const expected = process.env.INTERNAL_API_KEY;
  const got = event.headers?.['x-internal-key'] || event.headers?.['X-Internal-Key'];
  if (!expected || !got) return false;
  const a = Buffer.from(String(got));
  const b = Buffer.from(String(expected));
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

function verifyJWT(authHeader) {
  return new Promise((resolve) => {
    if (!authHeader || !authHeader.startsWith('Bearer ')) { resolve(null); return; }
    const jwt = authHeader.split(' ')[1];
    const url = new URL(`${SUPABASE_URL}/auth/v1/user`);
    const req = https.request({
      hostname: url.hostname, path: url.pathname, method: 'GET',
      headers: { 'apikey': SERVICE_KEY, 'Authorization': `Bearer ${jwt}` },
    }, res => {
      let data = '';
      res.on('data', c => data += c);
      res.on('end', () => {
        try { const p = JSON.parse(data); resolve(res.statusCode === 200 && p.id ? p : null); }
        catch { resolve(null); }
      });
    });
    req.on('error', () => resolve(null));
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

  // Auth — see header comment. Server callers use the internal key; the
  // browser must prove it is the user being charged. Refunds are
  // server-only, full stop.
  const internal = isInternalCaller(event);
  if (!internal) {
    if (isRefund) {
      return { statusCode: 403, body: JSON.stringify({ error: 'Refunds are server-only' }) };
    }
    const authUser = await verifyJWT(event.headers?.authorization || event.headers?.Authorization);
    if (!authUser) {
      return { statusCode: 401, body: JSON.stringify({ error: 'Unauthorized', code: 'UNAUTHORIZED' }) };
    }
    if (authUser.id !== userId) {
      return { statusCode: 403, body: JSON.stringify({ error: 'Forbidden' }) };
    }
  }

  try {
    // 1. Get current balance — most recent ledger entry
    const ledgerRes = await sbRequest('GET',
      `/rest/v1/credit_ledger?user_id=eq.${userId}&order=created_at.desc&limit=1&select=balance_after`
    );

    // 2. Get user role + team for tier allocation and ledger attribution,
    // plus the fields spendAccess() needs.
    const userRes = await sbRequest('GET',
      `/rest/v1/users?id=eq.${userId}&select=role,subscription_status,team_id,created_at,package_access_expires_at&limit=1`
    );

    const userRec = Array.isArray(userRes.body) ? userRes.body[0] : null;

    if (!userRec) {
      return {
        statusCode: 402,
        body: JSON.stringify({ error: 'No active subscription', code: 'NO_SUB' }),
      };
    }

    // Refunds (server-only, platform failures) are never blocked by
    // account status — the user was charged for something that never ran.
    if (!isRefund) {
      const access = spendAccess(userRec);
      if (!access.ok) return { statusCode: 402, body: JSON.stringify(access.body) };
    }

    // No ledger rows at all: only a legacy active subscriber could be in
    // that state (trial/package/subscription grants always write a row).
    const currentBalance = Array.isArray(ledgerRes.body) && ledgerRes.body.length > 0
      ? ledgerRes.body[0].balance_after
      : (userRec.subscription_status === 'active' ? (TIER_ALLOCATION[userRec.role] ?? 50) : 0);

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
