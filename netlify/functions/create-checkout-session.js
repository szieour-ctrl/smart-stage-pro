// create-portal-session.js
// Smart Stage PRO™  |  Stripe Customer Portal Session Creator
// Called from the in-app "Billing" menu. Returns { url } — the frontend
// redirects to Stripe's hosted portal, where the user can update their card,
// view invoices, or cancel (configured in Stripe as "cancel at end of
// billing period"). stripe-webhook.js picks up the resulting
// customer.subscription.updated / .deleted events.
// No SDK — native HTTPS only (x-www-form-urlencoded for Stripe API)

const https = require('https');

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
          resolve(res.statusCode === 200 && parsed.id ? parsed : null);
        } catch { resolve(null); }
      });
    });
    req.on('error', () => resolve(null));
    req.end();
  });
}

function getStripeCustomerId(userId) {
  return new Promise((resolve) => {
    const url = new URL(`${process.env.SUPABASE_URL}/rest/v1/users?id=eq.${userId}&select=stripe_customer_id`);
    const req = https.request({
      hostname: url.hostname, path: url.pathname + url.search, method: 'GET',
      headers: {
        'apikey':        process.env.SUPABASE_SERVICE_ROLE_KEY,
        'Authorization': `Bearer ${process.env.SUPABASE_SERVICE_ROLE_KEY}`
      }
    }, res => {
      let data = '';
      res.on('data', c => data += c);
      res.on('end', () => {
        try { resolve(JSON.parse(data)?.[0]?.stripe_customer_id || null); }
        catch { resolve(null); }
      });
    });
    req.on('error', () => resolve(null));
    req.end();
  });
}

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
        'Content-Length': Buffer.byteLength(body)
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

const json = (statusCode, obj) => ({
  statusCode,
  headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' },
  body: JSON.stringify(obj)
});

exports.handler = async function(event) {
  if (event.httpMethod !== 'POST') return json(405, { error: 'Method Not Allowed' });

  const authUser = await verifyJWT(event.headers.authorization || event.headers.Authorization);
  if (!authUser) return json(401, { error: 'Unauthorized' });

  // Customer id always comes from the database for the authenticated user —
  // never from the request body.
  const customerId = await getStripeCustomerId(authUser.id);
  if (!customerId) return json(404, { error: 'No billing account found for this user.' });

  const BASE_URL = process.env.SITE_URL || 'https://smartstagepro.com';
  const result = await stripePost('billing_portal/sessions', {
    customer:   customerId,
    return_url: `${BASE_URL}?billing=return`
  });

  if (result.status !== 200 || !result.data?.url) {
    console.error('create-portal-session: Stripe error', result.status, JSON.stringify(result.data).slice(0, 300));
    return json(500, { error: 'Could not open billing portal', detail: result.data?.error?.message });
  }

  return json(200, { url: result.data.url });
};
