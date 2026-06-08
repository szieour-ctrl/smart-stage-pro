// accept-terms.js
// Smart Stage PRO™  |  Terms of Service Acceptance Recorder
// Called by frontend BEFORE create-checkout-session.js
// Stores: user_id, timestamp, version, IP address in users table
// Supabase service role key bypasses RLS — access is controlled by JWT verification

const https = require('https');

// ── Supabase helpers ─────────────────────────────────────
function supabaseQuery(method, table, body, queryParams = '') {
  return new Promise((resolve, reject) => {
    const urlStr = `${process.env.SUPABASE_URL}/rest/v1/${table}${queryParams}`;
    const url = new URL(urlStr);
    const bodyStr = body ? JSON.stringify(body) : null;
    const options = {
      hostname: url.hostname,
      path: url.pathname + url.search,
      method,
      headers: {
        'apikey':          process.env.SUPABASE_SERVICE_ROLE_KEY,
        'Authorization':   `Bearer ${process.env.SUPABASE_SERVICE_ROLE_KEY}`,
        'Content-Type':    'application/json',
        'Prefer':          'return=representation',
        ...(bodyStr ? { 'Content-Length': Buffer.byteLength(bodyStr) } : {})
      }
    };
    const req = https.request(options, res => {
      let data = '';
      res.on('data', c => data += c);
      res.on('end', () => {
        try { resolve({ status: res.statusCode, data: JSON.parse(data || '[]') }); }
        catch { resolve({ status: res.statusCode, data }); }
      });
    });
    req.on('error', reject);
    if (bodyStr) req.write(bodyStr);
    req.end();
  });
}

// Verify Supabase JWT and return user object, or null if invalid
function verifyJWT(authHeader) {
  return new Promise((resolve, reject) => {
    if (!authHeader || !authHeader.startsWith('Bearer ')) { resolve(null); return; }
    const jwt = authHeader.split(' ')[1];
    const url = new URL(`${process.env.SUPABASE_URL}/auth/v1/user`);
    const options = {
      hostname: url.hostname,
      path:     url.pathname,
      method:   'GET',
      headers: {
        'apikey':        process.env.SUPABASE_SERVICE_ROLE_KEY,
        'Authorization': `Bearer ${jwt}`
      }
    };
    const req = https.request(options, res => {
      let data = '';
      res.on('data', c => data += c);
      res.on('end', () => {
        try {
          const parsed = JSON.parse(data);
          resolve(res.statusCode === 200 && parsed.id ? parsed : null);
        } catch { resolve(null); }
      });
    });
    req.on('error', reject);
    req.end();
  });
}

// ── Handler ──────────────────────────────────────────────
exports.handler = async function(event) {
  if (event.httpMethod !== 'POST') {
    return { statusCode: 405, body: 'Method Not Allowed' };
  }

  // Verify caller is authenticated
  const authUser = await verifyJWT(event.headers.authorization || event.headers.Authorization);
  if (!authUser) {
    return { statusCode: 401, body: JSON.stringify({ error: 'Unauthorized' }) };
  }

  let body;
  try { body = JSON.parse(event.body); }
  catch { return { statusCode: 400, body: JSON.stringify({ error: 'Invalid JSON' }) }; }

  const { termsVersion = '1.0' } = body;
  const userId = authUser.id;

  // Capture IP for legal record (Netlify passes client IP in headers)
  const clientIp =
    event.headers['x-forwarded-for']?.split(',')[0]?.trim() ||
    event.headers['client-ip'] ||
    'unknown';

  // Write acceptance to Supabase
  const result = await supabaseQuery(
    'PATCH',
    `users?id=eq.${userId}`,
    {
      terms_accepted_at:  new Date().toISOString(),
      terms_version:      termsVersion,
      terms_accepted_ip:  clientIp
    }
  );

  if (result.status !== 200 && result.status !== 204) {
    console.error('Supabase error recording ToS acceptance:', result);
    return { statusCode: 500, body: JSON.stringify({ error: 'Failed to record acceptance' }) };
  }

  return {
    statusCode: 200,
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      accepted: true,
      userId,
      termsVersion,
      acceptedAt: new Date().toISOString()
    })
  };
};
