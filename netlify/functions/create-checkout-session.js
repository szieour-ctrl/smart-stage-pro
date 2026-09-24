// create-checkout-session.js
// Smart Stage PRO™  |  Stripe Checkout Session Creator
// Called AFTER accept-terms.js confirms ToS acceptance
// Returns: { url } — frontend redirects to this Stripe-hosted checkout URL
// No SDK — native HTTPS only (x-www-form-urlencoded for Stripe API)

const https = require('https');

// Valid plan names. Credit amounts live only in stripe-webhook.js
// (Solo 50 / Team 125 / Brokerage 400) — the stale 100/300/1000 table that
// used to be here was only ever used for validation.
// 'listing_package' (Sep 24, 2026) is the $59 one-time Listing Package —
// Stripe mode 'payment', price STRIPE_PRICE_LISTING_PACKAGE. stripe-webhook.js
// routes it by metadata.plan.
const VALID_PLANS = ['solo', 'team', 'brokerage', 'listing_package'];

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
    const url = new URL(`${process.env.SUPABASE_URL}/rest/v1/users?id=eq.${userId}&select=terms_accepted_at,terms_version,stripe_customer_id,stripe_subscription_id,subscription_status`);
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
          console.log('getUser status:', res.statusCode);
          resolve(Array.isArray(parsed) ? (parsed[0] || null) : null);
        } catch(e) {
          console.log('getUser parse error:', e.message);
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

  if (!VALID_PLANS.includes(plan)) {
    return { statusCode: 400, body: JSON.stringify({ error: `Invalid plan: ${plan}. Must be solo, team, brokerage, or listing_package.` }) };
  }

  // ToS acceptance is REQUIRED and must be verifiable from the database.
  // (Sep 22, 2026: this used to soft-fail and stamp the current time into
  // Stripe metadata as terms_accepted_at — i.e. record an acceptance that
  // never happened. Now a hard 403.)
  const userRecord = await getUser(authUser.id);
  if (!userRecord) {
    return { statusCode: 500, body: JSON.stringify({ error: 'Could not load your account. Please try again.' }) };
  }
  if (!userRecord.terms_accepted_at) {
    return { statusCode: 403, body: JSON.stringify({ error: 'Please accept the Terms of Service before subscribing.' }) };
  }

  // Never start a second subscription on top of a live one (e.g. a
  // past_due user landing on pricing). They manage it in Billing instead.
  // Same rule for the Listing Package: a live subscriber already has
  // everything it includes.
  if (userRecord.stripe_subscription_id && ['active', 'past_due'].includes(userRecord.subscription_status)) {
    return { statusCode: 409, body: JSON.stringify({ error: plan === 'listing_package'
      ? 'Your subscription already covers every listing — no package needed.'
      : 'You already have a subscription. Use Billing to manage it.' }) };
  }

  const BASE_URL = process.env.SITE_URL || 'https://smartstagepro.com';

  // ── Listing Package: one-time payment ──────────────────
  if (plan === 'listing_package') {
    const packagePrice = process.env.STRIPE_PRICE_LISTING_PACKAGE;
    if (!packagePrice) {
      return { statusCode: 500, body: JSON.stringify({ error: 'Stripe price ID not configured for the Listing Package' }) };
    }
    const pParams = {
      'mode':                                'payment',
      'payment_method_types[]':              'card',
      'customer_email':                      authUser.email,
      'line_items[0][price]':                packagePrice,
      'line_items[0][quantity]':             '1',
      'success_url':                         `${BASE_URL}?checkout=success&purchase=package&session_id={CHECKOUT_SESSION_ID}`,
      'cancel_url':                          `${BASE_URL}?checkout=cancelled`,
      'metadata[user_id]':                   authUser.id,
      'metadata[plan]':                      'listing_package',
      'metadata[terms_accepted_at]':         userRecord.terms_accepted_at,
      'metadata[terms_version]':             userRecord.terms_version || '',
      'payment_intent_data[metadata][user_id]': authUser.id,
      'payment_intent_data[metadata][plan]':    'listing_package',
    };
    if (userRecord.stripe_customer_id) {
      pParams['customer'] = userRecord.stripe_customer_id;
      delete pParams['customer_email'];
    } else {
      // Payment mode doesn't create a Customer by default — we want one so
      // receipts, the Billing portal and a later subscription all line up.
      pParams['customer_creation'] = 'always';
    }
    const pResult = await stripePost('checkout/sessions', pParams);
    if (pResult.status !== 200) {
      console.error('Stripe package checkout error:', JSON.stringify(pResult.data));
      return { statusCode: 500, body: JSON.stringify({ error: 'Stripe checkout session creation failed', detail: pResult.data?.error?.message }) };
    }
    return {
      statusCode: 200,
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ url: pResult.data.url, sessionId: pResult.data.id })
    };
  }

  const PRICE_IDS = {
    solo:       process.env.STRIPE_PRICE_SOLO,
    team:       process.env.STRIPE_PRICE_TEAM,
    brokerage:  process.env.STRIPE_PRICE_BROKERAGE
  };

  if (!PRICE_IDS[plan]) {
    return { statusCode: 500, body: JSON.stringify({ error: `Stripe price ID not configured for plan: ${plan}` }) };
  }

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
    'metadata[terms_accepted_at]':               userRecord.terms_accepted_at,
    'metadata[terms_version]':                   userRecord.terms_version || '',
    'subscription_data[metadata][user_id]':      authUser.id,
    'subscription_data[metadata][plan]':         plan,
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
