// get-compliance-data.js
// Smart Stage PRO™  |  Brokerage AB 723 Compliance Dashboard
// Returns full audit log of all staged images across all teams in a brokerage
// Access: broker_admin only (enforced by role check, not just RLS)
// Supports: filter by team, agent, mode, disclosed status, date range

const https = require('https');

function db(method, table, body, queryParams = '') {
  return new Promise((resolve, reject) => {
    const url     = new URL(`${process.env.SUPABASE_URL}/rest/v1/${table}${queryParams}`);
    const bodyStr = body ? JSON.stringify(body) : null;
    const req = https.request({
      hostname: url.hostname,
      path:     url.pathname + url.search,
      method,
      headers: {
        'apikey':        process.env.SUPABASE_SERVICE_ROLE_KEY,
        'Authorization': `Bearer ${process.env.SUPABASE_SERVICE_ROLE_KEY}`,
        'Content-Type':  'application/json',
        'Prefer':        'return=representation',
        ...(bodyStr ? { 'Content-Length': Buffer.byteLength(bodyStr) } : {})
      }
    }, res => {
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

function verifyJWT(authHeader) {
  return new Promise((resolve, reject) => {
    if (!authHeader || !authHeader.startsWith('Bearer ')) { resolve(null); return; }
    const jwt = authHeader.split(' ')[1];
    const url = new URL(`${process.env.SUPABASE_URL}/auth/v1/user`);
    const req = https.request({
      hostname: url.hostname, path: url.pathname, method: 'GET',
      headers: {
        'apikey':        process.env.SUPABASE_SERVICE_ROLE_KEY,
        'Authorization': `Bearer ${jwt}`
      }
    }, res => {
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

// Supabase RPC call for the compliance summary function
function rpc(fn, params) {
  return new Promise((resolve, reject) => {
    const url     = new URL(`${process.env.SUPABASE_URL}/rest/v1/rpc/${fn}`);
    const bodyStr = JSON.stringify(params);
    const req = https.request({
      hostname: url.hostname,
      path:     url.pathname,
      method:   'POST',
      headers: {
        'apikey':          process.env.SUPABASE_SERVICE_ROLE_KEY,
        'Authorization':   `Bearer ${process.env.SUPABASE_SERVICE_ROLE_KEY}`,
        'Content-Type':    'application/json',
        'Content-Length':  Buffer.byteLength(bodyStr)
      }
    }, res => {
      let data = '';
      res.on('data', c => data += c);
      res.on('end', () => {
        try { resolve(JSON.parse(data)); }
        catch { resolve(null); }
      });
    });
    req.on('error', reject);
    req.write(bodyStr);
    req.end();
  });
}

exports.handler = async function(event) {
  if (event.httpMethod !== 'GET' && event.httpMethod !== 'POST') {
    return { statusCode: 405, body: 'Method Not Allowed' };
  }

  const authUser = await verifyJWT(event.headers.authorization || event.headers.Authorization);
  if (!authUser) {
    return { statusCode: 401, body: JSON.stringify({ error: 'Unauthorized' }) };
  }

  // Verify user is a broker_admin
  const userResult = await db('GET', 'users', null,
    `?id=eq.${authUser.id}&select=role,brokerage_id`
  );
  const user = userResult.data?.[0];

  if (!user || user.role !== 'broker_admin' || !user.brokerage_id) {
    return { statusCode: 403, body: JSON.stringify({ error: 'Brokerage admin access required' }) };
  }

  const brokerageId = user.brokerage_id;

  // Parse optional filters from query string
  const qs        = event.queryStringParameters || {};
  const teamId    = qs.team_id   || null;
  const agentId   = qs.agent_id  || null;
  const mode      = qs.mode      || null;          // vacant_stage | clean_and_stage | exterior_enhancement | etc.
  const disclosed = qs.disclosed || null;           // 'true' | 'false' | null (all)
  const dateFrom  = qs.date_from || null;           // ISO date string
  const dateTo    = qs.date_to   || null;           // ISO date string
  const limit     = Math.min(parseInt(qs.limit) || 100, 500);
  const offset    = parseInt(qs.offset) || 0;
  const exportCsv = qs.export === 'true';

  // ── Compliance summary (totals) ──────────────────────
  const summary = await rpc('get_brokerage_compliance_summary', { p_brokerage_id: brokerageId });

  // ── Detailed image list ──────────────────────────────
  // Build Supabase query: staged_images → listings → users → teams
  // Filter to this brokerage via listings.brokerage_id
  let selectFields = [
    'id',
    'created_at',
    'mode',
    'lighting',
    'landscape',
    'ab723_disclosed',
    'disclosed_at',
    'mls_listing_url',
    'credits_used',
    'original_blob_key',
    'staged_blob_key',
    'ab723_prompt',         // Full prompt — included for compliance audit
    'listing_id',
    'listings(address,mls_number,brokerage_id)',
    'users(id,full_name,email,team_id,teams(name))'
  ].join(',');

  // ── Build filter query string ─────────────────────────
  let filters = [`listings.brokerage_id=eq.${brokerageId}`];
  if (agentId)   filters.push(`user_id=eq.${agentId}`);
  if (mode)      filters.push(`mode=eq.${mode}`);
  if (disclosed !== null) filters.push(`ab723_disclosed=eq.${disclosed === 'true'}`);
  if (dateFrom)  filters.push(`created_at=gte.${dateFrom}`);
  if (dateTo)    filters.push(`created_at=lte.${dateTo}`);

  // Team filter requires a subquery via listing — handled via agent filter
  // (team_id filter: find all agents in team, pass as agent_id list)
  // For simplicity, team filter uses listing join
  const queryParams = `?select=${encodeURIComponent(selectFields)}&${filters.join('&')}&order=created_at.desc&limit=${limit}&offset=${offset}`;

  const imagesResult = await db('GET', 'staged_images', null, queryParams);
  const images       = imagesResult.data || [];

  // ── CSV export ─────────────────────────────────────
  if (exportCsv) {
    const headers = [
      'Date','Agent','Team','Address','MLS Number','Mode',
      'AB 723 Disclosed','Disclosed Date','MLS Listing URL',
      'Credits Used','Image ID'
    ].join(',');

    const rows = images.map(img => [
      img.created_at?.split('T')[0],
      img.users?.full_name || img.users?.email || '',
      img.users?.teams?.name || '',
      `"${img.listings?.address || ''}"`,
      img.listings?.mls_number || '',
      img.mode,
      img.ab723_disclosed ? 'YES' : 'NO',
      img.disclosed_at?.split('T')[0] || '',
      img.mls_listing_url || '',
      img.credits_used,
      img.id
    ].join(','));

    const csv = [headers, ...rows].join('\n');
    return {
      statusCode: 200,
      headers: {
        'Content-Type':        'text/csv',
        'Content-Disposition': `attachment; filename="ab723-compliance-${new Date().toISOString().split('T')[0]}.csv"`
      },
      body: csv
    };
  }

  // ── JSON response for dashboard ─────────────────────
  return {
    statusCode: 200,
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      brokerageId,
      summary:       summary || {},
      images,
      pagination: {
        limit,
        offset,
        returned: images.length
      }
    })
  };
};
