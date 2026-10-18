// create-promo-link.js
// Smart Stage PRO™ | Per-agent promo link for the Listing Package special
// ("Better Late Than Never", $20 off). Called by Pabbly when it sends email 2.
//
// POST  header  x-promo-secret: <PROMO_LINK_SECRET>
//       body    { "email": "agent@example.com" }   (email optional — stored as metadata)
// 200  → { link, code, expires_at (ISO), expires_text ("Thu Oct 22, 5:07 PM PT") }
//
// Creates a Stripe promotion code on the special's coupon: single use,
// expires PROMO_WINDOW_HOURS (default 72) after this call. Stripe enforces
// both limits at checkout; create-checkout-session looks the code up.
// Env: STRIPE_SECRET_KEY, PROMO_LINK_SECRET, STRIPE_COUPON_LISTING_PACKAGE
//      (default FthMCKtG), PROMO_WINDOW_HOURS, PROMO_CODE_PREFIX, SITE_URL.

const https = require('https');
const crypto = require('crypto');

const COUPON_ID = process.env.STRIPE_COUPON_LISTING_PACKAGE || 'FthMCKtG';
const PREFIX    = (process.env.PROMO_CODE_PREFIX || 'BETTERLATE').toUpperCase().replace(/[^A-Z0-9]/g, '');
const ALPHABET  = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789'; // no 0/O/1/I/L

function stripePost(path, params) {
  return new Promise((resolve, reject) => {
    const body = new URLSearchParams(params).toString();
    const req = https.request({
      hostname: 'api.stripe.com', path: `/v1/${path}`, method: 'POST',
      headers: {
        'Authorization': `Bearer ${process.env.STRIPE_SECRET_KEY}`,
        'Content-Type': 'application/x-www-form-urlencoded',
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

function safeEqual(a, b) {
  const x = Buffer.from(String(a || '')), y = Buffer.from(String(b || ''));
  return x.length === y.length && crypto.timingSafeEqual(x, y);
}

function randomSuffix(n) {
  const bytes = crypto.randomBytes(n);
  let s = '';
  for (let i = 0; i < n; i++) s += ALPHABET[bytes[i] % ALPHABET.length];
  return s;
}

function pacificText(date) {
  const day = date.toLocaleDateString('en-US', { timeZone: 'America/Los_Angeles', weekday: 'short', month: 'short', day: 'numeric' });
  const time = date.toLocaleTimeString('en-US', { timeZone: 'America/Los_Angeles', hour: 'numeric', minute: '2-digit' });
  return `${day}, ${time} PT`;
}

exports.handler = async function (event) {
  if (event.httpMethod !== 'POST') return { statusCode: 405, body: 'Method Not Allowed' };

  const secret = process.env.PROMO_LINK_SECRET;
  const given = event.headers['x-promo-secret'] || event.headers['X-Promo-Secret'];
  if (!secret || !safeEqual(given, secret)) {
    return { statusCode: 401, body: JSON.stringify({ error: 'Unauthorized' }) };
  }
  if (!process.env.STRIPE_SECRET_KEY) {
    return { statusCode: 500, body: JSON.stringify({ error: 'Stripe not configured' }) };
  }

  let body = {};
  try { body = event.body ? JSON.parse(event.body) : {}; } catch { /* email is optional */ }
  const email = String(body.email || '').trim().slice(0, 200);

  const hours = Math.max(1, Math.min(24 * 30, Number(process.env.PROMO_WINDOW_HOURS) || 72));
  const expires = new Date(Date.now() + hours * 3600 * 1000);

  // A collision on the random suffix is ~1 in 800k per pair; retry a few times.
  for (let attempt = 0; attempt < 4; attempt++) {
    const code = `${PREFIX}-${randomSuffix(4)}`;
    const params = {
      'coupon':          COUPON_ID,
      'code':            code,
      'max_redemptions': '1',
      'expires_at':      String(Math.floor(expires.getTime() / 1000)),
      'metadata[source]': 'better_late_email2',
    };
    if (email) params['metadata[email]'] = email;
    const r = await stripePost('promotion_codes', params);
    if (r.status === 200) {
      const base = (process.env.SITE_URL || 'https://smartstagepro.com').replace(/\/$/, '');
      return {
        statusCode: 200,
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          link: `${base}/?promo=${code}`,
          code,
          expires_at: expires.toISOString(),
          expires_text: pacificText(expires)
        })
      };
    }
    const msg = r.data && r.data.error && r.data.error.message || '';
    if (!/already exists/i.test(msg)) {
      console.error('create-promo-link Stripe error:', JSON.stringify(r.data));
      return { statusCode: 502, body: JSON.stringify({ error: 'Stripe promotion code creation failed', detail: msg }) };
    }
  }
  return { statusCode: 500, body: JSON.stringify({ error: 'Could not generate a unique code' }) };
};
