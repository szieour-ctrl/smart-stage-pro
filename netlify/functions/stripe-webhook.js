// stripe-webhook.js
// Smart Stage PRO™  |  Stripe Webhook Handler
// Handles: checkout.session.completed, invoice.paid,
//          customer.subscription.deleted, customer.subscription.updated
// No SDK — native HTTPS + Node.js built-in crypto for signature verification

const https  = require('https');
const crypto = require('crypto');

// ── Credit allotments per plan ────────────────────────────
// MUST match create-checkout-session.js
const PLAN_CREDITS = {
  solo:       100,
  team:       300,
  brokerage: 1000
};

function getRoleFromPlan(plan) {
  return { solo: 'individual_agent', team: 'team_lead', brokerage: 'broker_admin' }[plan] || 'individual_agent';
}

// ── Stripe webhook signature verification ─────────────────
// Uses Node built-in crypto — no Stripe SDK needed
function verifyStripeSignature(rawBody, sigHeader, secret) {
  try {
    const parts     = sigHeader.split(',');
    const timestamp = parts.find(p => p.startsWith('t=')).replace('t=', '');
    const sig       = parts.find(p => p.startsWith('v1=')).replace('v1=', '');
    // Reject webhooks older than 5 minutes
    if (Math.abs(Date.now() / 1000 - parseInt(timestamp)) > 300) return false;
    const expected  = crypto
      .createHmac('sha256', secret)
      .update(`${timestamp}.${rawBody}`)
      .digest('hex');
    return crypto.timingSafeEqual(Buffer.from(sig), Buffer.from(expected));
  } catch { return false; }
}

// ── Supabase REST API helper ─────────────────────────────
function db(method, table, body, queryParams = '') {
  return new Promise((resolve, reject) => {
    const url     = new URL(`${process.env.SUPABASE_URL}/rest/v1/${table}${queryParams}`);
    const bodyStr = body ? JSON.stringify(body) : null;
    const req = https.request({
      hostname: url.hostname,
      path:     url.pathname + url.search,
      method,
      headers: {
        'apikey':          process.env.SUPABASE_SERVICE_ROLE_KEY,
        'Authorization':   `Bearer ${process.env.SUPABASE_SERVICE_ROLE_KEY}`,
        'Content-Type':    'application/json',
        'Prefer':          'return=representation',
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

async function getCurrentBalance(userId) {
  const r = await db('GET', 'credit_ledger',
    null,
    `?user_id=eq.${userId}&select=balance_after&order=created_at.desc&limit=1`
  );
  return r.data?.[0]?.balance_after ?? 0;
}

// ── EVENT: checkout.session.completed ────────────────────
// Fires when user completes payment. Creates subscription record + initial credits.
async function onCheckoutComplete(session) {
  const userId         = session.metadata?.user_id;
  const plan           = session.metadata?.plan || 'solo';
  const role           = getRoleFromPlan(plan);
  const credits        = PLAN_CREDITS[plan];
  const customerId     = session.customer;
  const subscriptionId = session.subscription;
  const teamName       = session.metadata?.team_name       || null;
  const brokerageName  = session.metadata?.brokerage_name  || null;

  if (!userId) { console.error('stripe-webhook: no user_id in session metadata'); return; }

  // 1. Update user subscription status and role
  await db('PATCH', `users?id=eq.${userId}`, {
    stripe_customer_id:      customerId,
    stripe_subscription_id:  subscriptionId,
    subscription_status:     'active',
    role
  });

  // 2. Add initial credit allotment to ledger
  const balance = await getCurrentBalance(userId);
  await db('POST', 'credit_ledger', {
    user_id:           userId,
    type:              'monthly_allotment',
    amount:            credits,
    balance_after:     balance + credits,
    stripe_payment_id: session.id,
    description:       `Initial ${plan} plan — ${credits} credits`
  });

  // 3. Create team record (team plan)
  if (plan === 'team') {
    const teamResult = await db('POST', 'teams', {
      name:                   teamName || 'My Team',
      team_lead_id:           userId,
      stripe_customer_id:     customerId,
      stripe_subscription_id: subscriptionId,
      subscription_status:    'active'
    });
    const teamId = teamResult.data?.[0]?.id;
    if (teamId) {
      await db('PATCH', `users?id=eq.${userId}`, { team_id: teamId });
    }
  }

  // 4. Create brokerage record (brokerage plan)
  if (plan === 'brokerage') {
    const brokerageResult = await db('POST', 'brokerages', {
      name:                   brokerageName || 'My Brokerage',
      admin_user_id:          userId,
      stripe_customer_id:     customerId,
      stripe_subscription_id: subscriptionId,
      subscription_status:    'active'
    });
    const brokerageId = brokerageResult.data?.[0]?.id;
    if (brokerageId) {
      await db('PATCH', `users?id=eq.${userId}`, { brokerage_id: brokerageId });
    }
  }

  console.log(`stripe-webhook: checkout complete — user ${userId}, plan ${plan}, +${credits} credits`);
}

// ── EVENT: invoice.paid ───────────────────────────────────
// Fires on monthly renewal. Adds monthly credit allotment.
async function onInvoicePaid(invoice) {
  const customerId = invoice.customer;

  // Find user by Stripe customer ID
  const userResult = await db('GET', 'users',
    null,
    `?stripe_customer_id=eq.${customerId}&select=id,role,stripe_subscription_id`
  );
  const user = userResult.data?.[0];
  if (!user) { console.error(`stripe-webhook: invoice.paid — no user found for customer ${customerId}`); return; }

  // Determine plan from subscription metadata
  const plan    = await getPlanFromSubscriptionId(user.stripe_subscription_id) || 'solo';
  const credits = PLAN_CREDITS[plan];
  const balance = await getCurrentBalance(user.id);

  await db('POST', 'credit_ledger', {
    user_id:           user.id,
    type:              'monthly_allotment',
    amount:            credits,
    balance_after:     balance + credits,
    stripe_payment_id: invoice.id,
    description:       `Monthly renewal — ${plan} plan — ${credits} credits`
  });

  // Ensure subscription_status is active (catches reactivations)
  await db('PATCH', `users?id=eq.${user.id}`, { subscription_status: 'active' });

  console.log(`stripe-webhook: invoice paid — user ${user.id}, plan ${plan}, +${credits} credits`);
}

// ── EVENT: customer.subscription.deleted ─────────────────
async function onSubscriptionDeleted(subscription) {
  const customerId = subscription.customer;
  await db('PATCH', `users?stripe_customer_id=eq.${customerId}`, {
    subscription_status:    'cancelled',
    stripe_subscription_id: null
  });
  await db('PATCH', `teams?stripe_customer_id=eq.${customerId}`,      { subscription_status: 'cancelled' });
  await db('PATCH', `brokerages?stripe_customer_id=eq.${customerId}`, { subscription_status: 'cancelled' });
  console.log(`stripe-webhook: subscription deleted — customer ${customerId}`);
}

// ── EVENT: customer.subscription.updated ─────────────────
async function onSubscriptionUpdated(subscription) {
  const customerId = subscription.customer;
  const newStatus  = subscription.status;
  const statusMap  = { active: 'active', past_due: 'past_due', canceled: 'cancelled', unpaid: 'past_due' };
  await db('PATCH', `users?stripe_customer_id=eq.${customerId}`, {
    subscription_status: statusMap[newStatus] || newStatus
  });
}

// ── Retrieve plan from Stripe subscription ────────────────
// Calls Stripe API to get price ID from subscription, maps to plan name
async function getPlanFromSubscriptionId(subscriptionId) {
  if (!subscriptionId) return 'solo';
  return new Promise((resolve) => {
    const req = https.request({
      hostname: 'api.stripe.com',
      path:     `/v1/subscriptions/${subscriptionId}`,
      method:   'GET',
      headers:  { 'Authorization': `Bearer ${process.env.STRIPE_SECRET_KEY}` }
    }, res => {
      let data = '';
      res.on('data', c => data += c);
      res.on('end', () => {
        try {
          const sub    = JSON.parse(data);
          const price  = sub.items?.data?.[0]?.price?.id;
          const planMap = {
            [process.env.STRIPE_PRICE_SOLO]:      'solo',
            [process.env.STRIPE_PRICE_TEAM]:      'team',
            [process.env.STRIPE_PRICE_BROKERAGE]: 'brokerage'
          };
          resolve(planMap[price] || sub.metadata?.plan || 'solo');
        } catch { resolve('solo'); }
      });
    });
    req.on('error', () => resolve('solo'));
    req.end();
  });
}

// ── Main handler ─────────────────────────────────────────
exports.handler = async function(event) {
  if (event.httpMethod !== 'POST') {
    return { statusCode: 405, body: 'Method Not Allowed' };
  }

  const sigHeader     = event.headers['stripe-signature'];
  const webhookSecret = process.env.STRIPE_WEBHOOK_SECRET;

  if (!sigHeader || !webhookSecret) {
    return { statusCode: 400, body: JSON.stringify({ error: 'Missing signature or webhook secret' }) };
  }

  if (!verifyStripeSignature(event.body, sigHeader, webhookSecret)) {
    console.error('stripe-webhook: signature verification failed');
    return { statusCode: 400, body: JSON.stringify({ error: 'Invalid Stripe signature' }) };
  }

  let stripeEvent;
  try { stripeEvent = JSON.parse(event.body); }
  catch { return { statusCode: 400, body: JSON.stringify({ error: 'Invalid JSON' }) }; }

  try {
    switch (stripeEvent.type) {
      case 'checkout.session.completed':
        await onCheckoutComplete(stripeEvent.data.object);
        break;
      case 'invoice.paid':
        await onInvoicePaid(stripeEvent.data.object);
        break;
      case 'customer.subscription.deleted':
        await onSubscriptionDeleted(stripeEvent.data.object);
        break;
      case 'customer.subscription.updated':
        await onSubscriptionUpdated(stripeEvent.data.object);
        break;
      default:
        console.log(`stripe-webhook: unhandled event type — ${stripeEvent.type}`);
    }
    return { statusCode: 200, body: JSON.stringify({ received: true }) };
  } catch (err) {
    console.error('stripe-webhook handler error:', err);
    return { statusCode: 500, body: JSON.stringify({ error: err.message }) };
  }
};
