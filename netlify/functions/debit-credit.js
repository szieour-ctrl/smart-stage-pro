// netlify/functions/debit-credit.js
// Debits credits from credit_ledger on Generate Final.
// Returns new balance. Blocks if insufficient credits.
// Uses service role key — never call with frontend publishable key.

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

  const { userId, cost } = body;
  if (!userId || typeof cost !== 'number' || cost < 1) {
    return { statusCode: 400, body: JSON.stringify({ error: 'Missing userId or cost' }) };
  }

  try {
    // 1. Get current balance — most recent ledger entry
    const ledgerRes = await sbRequest('GET',
      `/rest/v1/credit_ledger?user_id=eq.${userId}&order=created_at.desc&limit=1&select=balance_after`
    );

    // 2. Get user role for tier allocation
    const userRes = await sbRequest('GET',
      `/rest/v1/users?id=eq.${userId}&select=role,subscription_status&limit=1`
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

    // 3. Check sufficient balance
    if (currentBalance < cost) {
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

    const newBalance = currentBalance - cost;

    // 4. Write debit entry to ledger
    const insertRes = await sbRequest('POST', '/rest/v1/credit_ledger', {
      user_id:       userId,
      amount:        -cost,
      balance_after: newBalance,
      type:          'usage',
      reason:        'generate_final',
    });

    if (insertRes.status !== 201) {
      console.error('Ledger insert failed:', insertRes.body);
      return { statusCode: 500, body: JSON.stringify({ error: 'Ledger write failed' }) };
    }

    return {
      statusCode: 200,
      body: JSON.stringify({ balance: newBalance, cost, charged: true }),
    };

  } catch (err) {
    console.error('debit-credit error:', err.message);
    return { statusCode: 500, body: JSON.stringify({ error: err.message }) };
  }
};
