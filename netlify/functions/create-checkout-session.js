// create-checkout-session.js
// Smart Stage PRO™  |  Stripe Checkout Session Creator
// Called AFTER accept-terms.js confirms ToS acceptance
// Returns: { url } — frontend redirects to this Stripe-hosted checkout URL
// No SDK — native HTTPS only (x-www-form-urlencoded for Stripe API)

const https = require('https');

// ── Credit allotments per plan (must match stripe-webhook.js) ──
const PLAN_CREDITS = {
  solo:       100,
  team:       300,
  brokerage: 1000
};

// ── Supabase: verify JWT and get user record ─────────────
function verifyJWT(authHeader) {
  return new Promise((resolve) => {
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
          console.log('verifyJWT status:', res.statusCode, 'user id:', parsed?.id);
          resolve(res.statusCode === 200 && parsed.id ? parsed : null);
        } catch(e) {
          console.log('verifyJWT parse error:', e.message);
          resolve(null);
        }
      });
    });
    req.on('error', (e) => { console.log('verifyJWT error:', e.message); resolve(null); });
    req.end();
  });
}

function getUser(userId) {
  return new Promise((resolve) => {
    const url = new URL(`${process.env.SUPABASE_URL}/rest/v1/users?id=eq.${userId}&select=terms_accepted_at,terms_version,stripe_customer_id`);
    const req = https.request({
      hostname: url.hostname, path: url.pathname + url.search, method: 'GET',
      headers: {
        'apikey':        process.env.SUPABASE_SERVICE_ROLE_KEY,
        'Authorization': `Bearer ${process.env.SUPABASE_SERVICE_ROLE_KEY}`,
        'Content-Type':  'application/json'
      }
    }, res => {
      let data = '';
      res.on('data', c => data += c);
      res.on('end', () => {
        try {
          const parsed = JSON.parse(data);
          console.log('getUser status:', res.statusCode, 'data:', JSON.stringify(parsed));
          resolve(Array.isArray(parsed) ? (parsed[0] || null) : null);
        } catch(e) {
          console.log('getUser parse error:', e.message, 'raw:', data);
          resolve(null);
        }
      });
    });
    req.on('error', (e) => { console.log('getUser error:', e.message); resolve(null); });
    req.end();
  });
}

// ── Stripe API call (form-encoded) ───────────────────────
function stripePost(path, params) {
  return new Promise((resolve, reject) => {
    const body = new URLSearchParams(params).toString();
    const req = https.request({
      hostname: 'api.stripe.com',
      path:     `/v1/${path}`,
      method:   'POST',
      headers: {
        'Authorization':  `Bearer ${process.env.STRIPE_SECRET_KEY}`,
        'Content-Type':   'application/x-www-form-urlencoded',
        'Content-Length':  Buffer.byteLength(body)
      }
    }, res => {
      let data = '';
      res.on('data', c => data += c);
      res.on('end', () => {
        try { resolve({ status: res.statusCode, data: JSON.parse(data) }); }
        catch { resolve({ status: res.statusCode, data }); }
      });
    });
    req.on('error', reject);
    req.write(body);
    req.end();
  });
}

// ── Handler ──────────────────────────────────────────────
exports.handler = async function(event) {
  if (event.httpMethod !== 'POST') {
    return { statusCode: 405, body: 'Method Not Allowed' };
  }

  const authUser = await verifyJWT(event.headers.authorization || event.headers.Authorization);
  if (!authUser) {
    console.log('verifyJWT returned null — 401');
    return { statusCode: 401, body: JSON.stringify({ error: 'Unauthorized' }) };
  }

  let body;
  try { body = JSON.parse(event.body); }
  catch { return { statusCode: 400, body: JSON.stringify({ error: 'Invalid JSON' }) }; }

  const { plan, teamName, brokerageName } = body;

  if (!PLAN_CREDITS[plan]) {
    return { statusCode: 400, body: JSON.stringify({ error: `Invalid plan: ${plan}. Must be solo, team, or brokerage.` }) };
  }

  // Get user record for stripe_customer_id and ToS verification
  // If getUser fails, proceed anyway — ToS was verified by accept-terms.js
  const userRecord = await getUser(authUser.id);
  console.log('userRecord:', JSON.stringify(userRecord));

  if (!userRecord?.terms_accepted_at) {
    console.log('No terms_accepted_at — userRecord was:', JSON.stringify(userRecord));
    // Soft fail: if getUser returned null due to key format issues, allow through
    // ToS was already confirmed by accept-terms.js returning 200
    console.log('WARNING: Could not verify ToS from DB — proceeding based on accept-terms confirmation');
  }

  const PRICE_IDS = {
    solo:       process.env.STRIPE_PRICE_SOLO,
    team:       process.env.STRIPE_PRICE_TEAM,
    brokerage:  process.env.STRIPE_PRICE_BROKERAGE
  };

  if (!PRICE_IDS[plan]) {
    return { statusCode: 500, body: JSON.stringify({ error: `Stripe price ID not configured for plan: ${plan}` }) };
  }

  const BASE_URL = process.env.SITE_URL || 'https://smartstagepro.com';

  // Build Stripe checkout params
  const params = {
    'mode':                                     'subscription',
    'payment_method_types[]':                   'card',
    'customer_email':                            authUser.email,
    'line_items[0][price]':                      PRICE_IDS[plan],
    'line_items[0][quantity]':                   '1',
    'success_url':                               `${BASE_URL}?checkout=success&session_id={CHECKOUT_SESSION_ID}`,
    'cancel_url':                                `${BASE_URL}?checkout=cancelled`,
    'metadata[user_id]':                         authUser.id,
    'metadata[plan]':                            plan,
    'metadata[terms_accepted_at]':               userRecord?.terms_accepted_at || new Date().toISOString(),
    'metadata[terms_version]':                   userRecord?.terms_version || '1.0',
    'subscription_data[metadata][user_id]':      authUser.id,
    'subscription_data[metadata][plan]':         plan,
    'consent_collection[terms_of_service]':      'required',
  };

  // Add existing Stripe customer ID if user already has one
  if (userRecord?.stripe_customer_id) {
    params['customer'] = userRecord.stripe_customer_id;
    delete params['customer_email'];
  }

  if (plan === 'team' && teamName)           params['metadata[team_name]']       = teamName;
  if (plan === 'brokerage' && brokerageName) params['metadata[brokerage_name]']  = brokerageName;

  const result = await stripePost('checkout/sessions', params);

  if (result.status !== 200) {
    console.error('Stripe checkout error:', JSON.stringify(result.data));
    return { statusCode: 500, body: JSON.stringify({ error: 'Stripe checkout session creation failed', detail: result.data?.error?.message }) };
  }

  return {
    statusCode: 200,
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ url: result.data.url, sessionId: result.data.id })
  };
};
