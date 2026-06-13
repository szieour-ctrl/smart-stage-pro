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

// Credit cost by quality tier — defined server-side so client cannot manipulate
const QUALITY_COST = { mls: 1, marketing: 2, print: 3 };

exports.handler = async (event) => {
  if (event.httpMethod !== 'POST') {
    return { statusCode: 405, body: JSON.stringify({ error: 'Method not allowed' }) };
  }

  // Resolve userId from Authorization header (JWT sub claim)
  let userId;
  try {
    const authHeader = event.headers['authorization'] || event.headers['Authorization'] || '';
    const token = authHeader.replace('Bearer ', '').trim();
    if (!token) throw new Error('No token');
    const payload = JSON.parse(Buffer.from(token.split('.')[1], 'base64').toString('utf8'));
    userId = payload.sub;
    if (!userId) throw new Error('No sub');
  } catch {
    return { statusCode: 401, body: JSON.stringify({ error: 'Unauthorized' }) };
  }

  let body;
  try { body = JSON.parse(event.body); }
  catch { return { statusCode: 400, body: JSON.stringify({ error: 'Invalid JSON' }) }; }

  const { quality } = body;
  const cost = QUALITY_COST[quality];
  if (!cost) {
    return { statusCode: 400, body: JSON.stringify({ error: 'Invalid quality value. Must be mls | marketing | print' }) };
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

    // Hard block — subscription must be active or trial
    if (!userRec || !['active', 'trial'].includes(userRec.subscription_status)) {
      return {
        statusCode: 402,
        body: JSON.stringify({ error: 'No active subscription', code: 'NO_SUB' }),
      };
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
      body: JSON.stringify({ balance_after: newBalance, cost, charged: true }),
    };

  } catch (err) {
    console.error('debit-credit error:', err.message);
    return { statusCode: 500, body: JSON.stringify({ error: err.message }) };
  }
};
