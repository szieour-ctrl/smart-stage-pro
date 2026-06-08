// save-staged-image.js
// Smart Stage PRO™  |  Staging Pipeline → Supabase Connector
// Called by frontend AFTER check-openai.js returns the staged image
// Creates/finds the listing, writes staged_images record, debits credits
// This is the bridge between the staging pipeline and the dashboard/AB 723 system

const https = require('https');

// ── Supabase helper ──────────────────────────────────────
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

// Verify Supabase JWT
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

async function getCurrentBalance(userId) {
  const r = await db('GET', 'credit_ledger', null,
    `?user_id=eq.${userId}&select=balance_after&order=created_at.desc&limit=1`
  );
  return r.data?.[0]?.balance_after ?? 0;
}

// ── Handler ──────────────────────────────────────────────
exports.handler = async function(event) {
  if (event.httpMethod !== 'POST') {
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
    address,          // Required — property address
    mlsNumber,        // Optional
    mode,             // Required — vacant_stage | clean_and_stage | exterior_enhancement | declutter | group_staging
    ab723Prompt,      // Required — the FULL prompt sent to GPT Image 2
    spatialReadJson,  // Optional — Haiku spatial read JSON object
    originalBlobKey,  // Required — Netlify Blob key for the original photo
    stagedBlobKey,    // Required — Netlify Blob key for the staged output
    creditsUsed = 1, // 1 platform credit = 1 staged image
    // Exterior enhancement fields (optional)
    lighting, landscape, outdoorLiving, intensity, propertyTier
  } = body;

  if (!address || !mode || !ab723Prompt || !originalBlobKey || !stagedBlobKey) {
    return { statusCode: 400, body: JSON.stringify({
      error: 'Required: address, mode, ab723Prompt, originalBlobKey, stagedBlobKey'
    }) };
  }

  // Verify user has active subscription
  const userResult = await db('GET', 'users', null,
    `?id=eq.${authUser.id}&select=subscription_status,team_id,brokerage_id`
  );
  const user = userResult.data?.[0];
  if (!user || user.subscription_status !== 'active') {
    return { statusCode: 403, body: JSON.stringify({ error: 'Active subscription required' }) };
  }

  // Check credit balance
  const balance = await getCurrentBalance(authUser.id);
  if (balance < creditsUsed) {
    return { statusCode: 402, body: JSON.stringify({
      error: 'Insufficient credits',
      balance,
      creditsRequired: creditsUsed
    }) };
  }

  // Find or create listing by address + user_id
  let listingId;
  const existingListing = await db('GET', 'listings', null,
    `?user_id=eq.${authUser.id}&address=eq.${encodeURIComponent(address)}&status=eq.active&limit=1`
  );

  if (existingListing.data?.[0]?.id) {
    listingId = existingListing.data[0].id;
    // Update MLS number if now provided
    if (mlsNumber && !existingListing.data[0].mls_number) {
      await db('PATCH', `listings?id=eq.${listingId}`, { mls_number: mlsNumber });
    }
  } else {
    // Create new listing
    const newListing = await db('POST', 'listings', {
      address,
      mls_number:   mlsNumber || null,
      user_id:      authUser.id,
      team_id:      user.team_id      || null,
      brokerage_id: user.brokerage_id || null,
      status:       'active'
    });
    if (!newListing.data?.[0]?.id) {
      return { statusCode: 500, body: JSON.stringify({ error: 'Failed to create listing' }) };
    }
    listingId = newListing.data[0].id;
  }

  // Write staged_images record — this is the AB 723 compliance record
  const imageResult = await db('POST', 'staged_images', {
    listing_id:        listingId,
    user_id:           authUser.id,
    mode,
    lighting:          lighting       || null,
    landscape:         landscape      || null,
    outdoor_living:    outdoorLiving  || null,
    intensity:         intensity      || null,
    property_tier:     propertyTier   || null,
    ab723_prompt:      ab723Prompt,            // Full prompt — the legal compliance record
    spatial_read_json: spatialReadJson || null,
    original_blob_key: originalBlobKey,
    staged_blob_key:   stagedBlobKey,
    credits_used:      creditsUsed,
    ab723_disclosed:   false
  });

  const stagedImageId = imageResult.data?.[0]?.id;
  if (!stagedImageId) {
    return { statusCode: 500, body: JSON.stringify({ error: 'Failed to create staged_images record' }) };
  }

  // Debit credits from ledger
  const newBalance = balance - creditsUsed;
  await db('POST', 'credit_ledger', {
    user_id:          authUser.id,
    team_id:          user.team_id || null,
    type:             'usage',
    amount:           -creditsUsed,
    balance_after:    newBalance,
    staged_image_id:  stagedImageId,
    description:      `${mode} — ${address}`
  });

  return {
    statusCode: 200,
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      success: true,
      stagedImageId,
      listingId,
      creditsUsed,
      newBalance
    })
  };
};
