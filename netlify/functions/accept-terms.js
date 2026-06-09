// accept-terms.js
// Smart Stage PRO™  |  Terms of Service Acceptance Recorder

const https = require('https');

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
    console.log('supabaseQuery:', method, urlStr, 'key prefix:', process.env.SUPABASE_SERVICE_ROLE_KEY?.slice(0,20));
    const req = https.request(options, res => {
      let data = '';
      res.on('data', c => data += c);
      res.on('end', () => {
        console.log('supabaseQuery response status:', res.statusCode, 'body:', data.slice(0, 200));
        try { resolve({ status: res.statusCode, data: JSON.parse(data || '[]') }); }
        catch { resolve({ status: res.statusCode, data }); }
      });
    });
    req.on('error', (e) => { console.log('supabaseQuery error:', e.message); reject(e); });
    if (bodyStr) req.write(bodyStr);
    req.end();
  });
}

function verifyJWT(authHeader) {
  return new Promise((resolve) => {
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
        console.log('verifyJWT status:', res.statusCode, 'body:', data.slice(0,100));
        try {
          const parsed = JSON.parse(data);
          resolve(res.statusCode === 200 && parsed.id ? parsed : null);
        } catch { resolve(null); }
      });
    });
    req.on('error', (e) => { console.log('verifyJWT error:', e.message); resolve(null); });
    req.end();
  });
}

exports.handler = async function(event) {
  if (event.httpMethod !== 'POST') {
    return { statusCode: 405, body: 'Method Not Allowed' };
  }

  console.log('SUPABASE_URL:', process.env.SUPABASE_URL);
  console.log('SERVICE_ROLE_KEY prefix:', process.env.SUPABASE_SERVICE_ROLE_KEY?.slice(0,20));

  const authUser = await verifyJWT(event.headers.authorization || event.headers.Authorization);
  if (!authUser) {
    console.log('verifyJWT failed — returning 401');
    return { statusCode: 401, body: JSON.stringify({ error: 'Unauthorized' }) };
  }

  console.log('Authenticated user:', authUser.id);

  let body;
  try { body = JSON.parse(event.body); }
  catch { return { statusCode: 400, body: JSON.stringify({ error: 'Invalid JSON' }) }; }

  const { termsVersion = '1.0' } = body;
  const userId = authUser.id;

  const clientIp =
    event.headers['x-forwarded-for']?.split(',')[0]?.trim() ||
    event.headers['client-ip'] ||
    'unknown';

  const result = await supabaseQuery(
    'PATCH',
    `users?id=eq.${userId}`,
    {
      terms_accepted_at:  new Date().toISOString(),
      terms_version:      termsVersion,
      terms_accepted_ip:  clientIp
    }
  );

  console.log('PATCH result:', result.status, JSON.stringify(result.data));

  if (result.status !== 200 && result.status !== 204) {
    console.error('Supabase PATCH failed:', result.status, result.data);
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
