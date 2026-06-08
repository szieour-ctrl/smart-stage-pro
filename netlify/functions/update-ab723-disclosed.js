// update-ab723-disclosed.js
// Smart Stage PRO™  |  AB 723 Disclosure Status Updater
// Marks a staged image as disclosed (or undisclosed) on MLS
// Access: image owner, team lead of agent, or brokerage admin
// Records who marked it disclosed and when — part of compliance audit trail

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

exports.handler = async function(event) {
  if (event.httpMethod !== 'POST' && event.httpMethod !== 'PATCH') {
    return { statusCode: 405, body: 'Method Not Allowed' };
  }

  const authUser = await verifyJWT(event.headers.authorization || event.headers.Authorization);
  if (!authUser) {
    return { statusCode: 401, body: JSON.stringify({ error: 'Unauthorized' }) };
  }

  let body;
  try { body = JSON.parse(event.body); }
  catch { return { statusCode: 400, body: JSON.stringify({ error: 'Invalid JSON' }) }; }

  const {
    stagedImageId,          // Required — UUID of the staged_images row
    disclosed = true,       // Boolean — true = mark disclosed, false = un-disclose
    mlsListingUrl = null    // Optional — URL of the MLS listing where image appears
  } = body;

  if (!stagedImageId) {
    return { statusCode: 400, body: JSON.stringify({ error: 'stagedImageId is required' }) };
  }

  // Fetch the image and its listing to verify access
  const imageResult = await db('GET', 'staged_images', null,
    `?id=eq.${stagedImageId}&select=id,user_id,listing_id,listings(user_id,team_id,brokerage_id)`
  );
  const image = imageResult.data?.[0];
  if (!image) {
    return { statusCode: 404, body: JSON.stringify({ error: 'Image not found' }) };
  }

  // Verify access: owner, team lead of owner's team, or brokerage admin
  const userResult = await db('GET', 'users', null,
    `?id=eq.${authUser.id}&select=role,team_id,brokerage_id`
  );
  const user = userResult.data?.[0];
  if (!user) {
    return { statusCode: 403, body: JSON.stringify({ error: 'User record not found' }) };
  }

  const listing      = image.listings;
  const isOwner      = image.user_id === authUser.id;
  const isTeamLead   = user.role === 'team_lead'    && listing?.team_id      === user.team_id;
  const isBroker     = user.role === 'broker_admin' && listing?.brokerage_id === user.brokerage_id;

  if (!isOwner && !isTeamLead && !isBroker) {
    return { statusCode: 403, body: JSON.stringify({ error: 'Access denied — not authorized for this image' }) };
  }

  // Update the disclosure record
  const updatePayload = {
    ab723_disclosed: disclosed,
    disclosed_by:    disclosed ? authUser.id     : null,
    disclosed_at:    disclosed ? new Date().toISOString() : null,
    mls_listing_url: disclosed ? (mlsListingUrl  || null) : null
  };

  const updateResult = await db('PATCH',
    `staged_images?id=eq.${stagedImageId}`,
    updatePayload
  );

  if (updateResult.status !== 200 && updateResult.status !== 204) {
    return { statusCode: 500, body: JSON.stringify({ error: 'Failed to update disclosure status' }) };
  }

  return {
    statusCode: 200,
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      success:       true,
      stagedImageId,
      disclosed,
      disclosedAt:   disclosed ? updatePayload.disclosed_at : null,
      disclosedBy:   disclosed ? authUser.id : null,
      mlsListingUrl: updatePayload.mls_listing_url
    })
  };
};
