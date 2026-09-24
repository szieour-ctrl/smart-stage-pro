// stripe-webhook.js
// Smart Stage PRO™  |  Stripe Webhook Handler
// Handles: checkout.session.completed, invoice.paid,
//          customer.subscription.deleted, customer.subscription.updated
// No SDK — native HTTPS + Node.js built-in crypto for signature verification
//
// Sep 22, 2026 — cancellation support + credit-grant fixes:
//  • subscription.updated records a scheduled cancellation (users.cancel_at)
//    so the app can show "ends <date>". Cancelling in the Stripe portal keeps
//    status 'active' until the paid period actually ends.
//  • subscription.deleted (paid period over) stamps cancelled_at and
//    data_expires_at = cancelled_at + 30 days (ToS §6: compliance pages stay
//    live, and the ZIP export stays available, for 30 days), and forfeits the
//    remaining credit balance with an 'adjustment' ledger row.
//  • Both handlers match on the SUBSCRIPTION id, not just the customer id, so
//    a late event for an old subscription can't cancel a newer one after a
//    resubscribe.
//  • invoice.paid skips the first invoice (billing_reason
//    'subscription_create') — checkout.session.completed already granted
//    those credits. Confirmed live: this double-granted before.
//  • Every credit grant is idempotent on stripe_payment_id, so Stripe
//    retries/resends can't add credits twice. Confirmed live: one checkout
//    session had been credited 9 times.
//  • Stripe statuses the users table's CHECK constraint doesn't allow
//    (incomplete, paused, …) are no longer written raw — previously that
//    PATCH failed silently.
//
// Sep 24, 2026 — $59 Listing Package (one-time payment, mode 'payment'):
//  • checkout.session.completed with metadata.plan 'listing_package' is
//    routed to onPackagePurchased() instead of the subscription path.
//  • Each purchase = one listing_packages row (one listing slot) + 18 Images.
//    App access runs 30 days from purchase; the claimed listing's compliance
//    page stays live 6 months from purchase (ToS 2.1). Unused Images from an
//    earlier, already-expired trial/package window are forfeited first.
//  • Subscribing clears every per-listing compliance expiry the user has
//    (trial/package listings become ordinary subscriber listings).

const https  = require('https');
const crypto = require('crypto');

// ── Credit allotments per plan ────────────────────────────
// 1 platform credit = 1 staged image
// Must match subscription allotments: Solo 50, Team 125, Brokerage 400
const PLAN_CREDITS = {
  solo:       50,
  team:       125,
  brokerage:  400
};

// ToS §6 — compliance pages + ZIP export stay available this long after the
// paid period ends. compliance-page.js enforces it via users.data_expires_at.
const POST_CANCEL_WINDOW_MS = 30 * 24 * 60 * 60 * 1000;

// ── Listing Package ($59, one-time) ───────────────────────
const PACKAGE_IMAGES          = 18;                              // 15 staged + 3 (15 Smart Correct corrections)
const PACKAGE_ACCESS_MS       = 30 * 24 * 60 * 60 * 1000;        // app access / slot-claim window
const PACKAGE_EXPORT_MS       = 30 * 24 * 60 * 60 * 1000;        // ZIP export window after access ends
const PACKAGE_COMPLIANCE_MONTHS = 6;                             // compliance page lifespan (ToS 2.1)
const TRIAL_LENGTH_MS         = 30 * 24 * 60 * 60 * 1000;

function getRoleFromPlan(plan) {
  return { solo: 'individual_agent', team: 'team_lead', brokerage: 'broker_admin' }[plan] || 'individual_agent';
}

// ── Stripe webhook signature verification ─────────────────
// Uses Node built-in crypto — no Stripe SDK needed. Accepts any of the v1
// signatures in the header (Stripe sends more than one while a signing
// secret is being rolled).
function verifyStripeSignature(rawBody, sigHeader, secret) {
  try {
    const parts     = sigHeader.split(',');
    const timestamp = parts.find(p => p.startsWith('t=')).slice(2);
    const sigs      = parts.filter(p => p.startsWith('v1=')).map(p => p.slice(3));
    if (!timestamp || !sigs.length) return false;
    // Reject webhooks older than 5 minutes
    if (Math.abs(Date.now() / 1000 - parseInt(timestamp, 10)) > 300) return false;
    const expected = Buffer.from(
      crypto.createHmac('sha256', secret).update(`${timestamp}.${rawBody}`).digest('hex')
    );
    return sigs.some(sig => {
      const b = Buffer.from(sig);
      return b.length === expected.length && crypto.timingSafeEqual(b, expected);
    });
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
        let parsed;
        try { parsed = JSON.parse(data || '[]'); } catch { parsed = data; }
        if (res.statusCode >= 300) {
          console.error(`stripe-webhook: db ${method} ${table}${queryParams} → ${res.statusCode}`, typeof parsed === 'string' ? parsed.slice(0, 300) : JSON.stringify(parsed).slice(0, 300));
        }
        resolve({ status: res.statusCode, data: parsed });
      });
    });
    req.on('error', reject);
    if (bodyStr) req.write(bodyStr);
    req.end();
  });
}

// Throws on a failed write, so the handler returns 500 and Stripe retries.
// Safe to retry: every credit grant below is idempotent.
async function dbStrict(method, table, body, queryParams = '') {
  const r = await db(method, table, body, queryParams);
  if (r.status >= 300) throw new Error(`db ${method} ${table} failed with ${r.status}`);
  return r;
}

async function getCurrentBalance(userId) {
  const r = await db('GET', 'credit_ledger',
    null,
    `?user_id=eq.${userId}&select=balance_after&order=created_at.desc&limit=1`
  );
  return r.data?.[0]?.balance_after ?? 0;
}

async function alreadyCredited(stripePaymentId, type = 'monthly_allotment') {
  if (!stripePaymentId) return false;
  const r = await db('GET', 'credit_ledger', null,
    `?stripe_payment_id=eq.${encodeURIComponent(stripePaymentId)}&type=eq.${type}&select=id&limit=1`);
  return Array.isArray(r.data) && r.data.length > 0;
}

// ── EVENT: checkout.session.completed ────────────────────
// Fires when user completes payment. Creates subscription record + initial credits.
async function onCheckoutComplete(session) {
  if (session.mode === 'payment' && session.metadata?.plan === 'listing_package') {
    return onPackagePurchased(session);
  }
  if (session.mode === 'payment') {
    console.log(`stripe-webhook: payment-mode checkout ${session.id} with no known plan — ignored`);
    return;
  }

  const userId         = session.metadata?.user_id;
  const plan           = session.metadata?.plan || 'solo';
  const role           = getRoleFromPlan(plan);
  const credits        = PLAN_CREDITS[plan] || PLAN_CREDITS.solo;
  const customerId     = session.customer;
  const subscriptionId = session.subscription;
  const teamName       = session.metadata?.team_name       || null;
  const brokerageName  = session.metadata?.brokerage_name  || null;

  if (!userId) { console.error('stripe-webhook: no user_id in session metadata'); return; }

  // 1. Update user subscription status and role. Clearing the cancellation
  //    fields makes a resubscribe restore compliance pages immediately.
  await dbStrict('PATCH', `users?id=eq.${userId}`, {
    stripe_customer_id:      customerId,
    stripe_subscription_id:  subscriptionId,
    subscription_status:     'active',
    role,
    cancel_at:               null,
    cancelled_at:            null,
    data_expires_at:         null,
    package_access_expires_at: null
  });

  // 1b. Trial / package listings become ordinary subscriber listings — their
  //     per-listing compliance expiry no longer applies.
  await dbStrict('PATCH', `listings?user_id=eq.${userId}&compliance_expires_at=not.is.null`, {
    compliance_expires_at: null
  });

  // 2. Add initial credit allotment to ledger (once per checkout session)
  if (await alreadyCredited(session.id)) {
    console.log(`stripe-webhook: checkout ${session.id} already credited — skipping grant`);
  } else {
    const balance = await getCurrentBalance(userId);
    await dbStrict('POST', 'credit_ledger', {
      user_id:           userId,
      type:              'monthly_allotment',
      reason:            'subscription_start',
      amount:            credits,
      balance_after:     balance + credits,
      stripe_payment_id: session.id,
      description:       `Initial ${plan} plan — ${credits} credits`
    });
  }

  // 3. Team plan — reuse this lead's existing team on resubscribe
  if (plan === 'team') {
    const existing = await db('GET', 'teams', null, `?team_lead_id=eq.${userId}&select=id&limit=1`);
    let teamId = existing.data?.[0]?.id;
    const teamFields = { stripe_customer_id: customerId, stripe_subscription_id: subscriptionId, subscription_status: 'active' };
    if (teamId) {
      await db('PATCH', `teams?id=eq.${teamId}`, teamFields);
    } else {
      const teamResult = await db('POST', 'teams', { name: teamName || 'My Team', team_lead_id: userId, ...teamFields });
      teamId = teamResult.data?.[0]?.id;
    }
    if (teamId) await db('PATCH', `users?id=eq.${userId}`, { team_id: teamId });
  }

  // 4. Brokerage plan — reuse this admin's existing brokerage on resubscribe
  if (plan === 'brokerage') {
    const existing = await db('GET', 'brokerages', null, `?admin_user_id=eq.${userId}&select=id&limit=1`);
    let brokerageId = existing.data?.[0]?.id;
    const bFields = { stripe_customer_id: customerId, stripe_subscription_id: subscriptionId, subscription_status: 'active' };
    if (brokerageId) {
      await db('PATCH', `brokerages?id=eq.${brokerageId}`, bFields);
    } else {
      const bResult = await db('POST', 'brokerages', { name: brokerageName || 'My Brokerage', admin_user_id: userId, ...bFields });
      brokerageId = bResult.data?.[0]?.id;
    }
    if (brokerageId) await db('PATCH', `users?id=eq.${userId}`, { brokerage_id: brokerageId });
  }

  console.log(`stripe-webhook: checkout complete — user ${userId}, plan ${plan}, +${credits} credits`);
}

// ── EVENT: checkout.session.completed — Listing Package ───
// One-time $59 payment. Retry-safe: the Image grant is keyed on the checkout
// session id (credit_ledger.stripe_payment_id), and listing_packages has a
// UNIQUE stripe_session_id, so a Stripe resend changes nothing.
async function onPackagePurchased(session) {
  const userId = session.metadata?.user_id;
  if (!userId) { console.error('stripe-webhook: package checkout with no user_id'); return; }
  if (session.payment_status !== 'paid') {
    console.log(`stripe-webhook: package checkout ${session.id} not paid (${session.payment_status}) — skipping`);
    return;
  }

  const uRes = await db('GET', 'users', null,
    `?id=eq.${userId}&select=id,subscription_status,created_at,package_access_expires_at,data_expires_at,stripe_customer_id`);
  const user = uRes.data?.[0];
  if (!user) throw new Error(`package purchase for unknown user ${userId}`); // 500 → Stripe retries

  const now          = Date.now();
  const purchasedAt  = new Date(now);
  const accessUntil  = new Date(now + PACKAGE_ACCESS_MS);
  const exportUntil  = new Date(now + PACKAGE_ACCESS_MS + PACKAGE_EXPORT_MS);
  const complianceUntil = new Date(purchasedAt);
  complianceUntil.setUTCMonth(complianceUntil.getUTCMonth() + PACKAGE_COMPLIANCE_MONTHS);

  // Does the user still have a live window whose Images should carry over?
  const status = user.subscription_status;
  const trialLive   = status === 'trial' && user.created_at &&
                      (now - new Date(user.created_at).getTime()) <= TRIAL_LENGTH_MS;
  const packageLive = status === 'package' && user.package_access_expires_at &&
                      new Date(user.package_access_expires_at).getTime() > now;

  if (await alreadyCredited(session.id, 'purchase')) {
    console.log(`stripe-webhook: package ${session.id} already credited — skipping grant`);
  } else {
    let balance = await getCurrentBalance(userId);
    // Leftover Images from an expired trial/package window don't ride along.
    if (!trialLive && !packageLive && balance > 0) {
      await dbStrict('POST', 'credit_ledger', {
        user_id:           userId,
        type:              'adjustment',
        reason:            'expired_window_forfeit',
        amount:            -balance,
        balance_after:     0,
        stripe_payment_id: `forfeit_${session.id}`,
        description:       `Access window had ended — ${balance} unused Images forfeited before Listing Package`
      });
      balance = 0;
    }
    await dbStrict('POST', 'credit_ledger', {
      user_id:           userId,
      type:              'purchase',
      reason:            'listing_package',
      amount:            PACKAGE_IMAGES,
      balance_after:     balance + PACKAGE_IMAGES,
      stripe_payment_id: session.id,
      description:       `Listing Package — ${PACKAGE_IMAGES} Images`
    });
  }

  // The slot. ignore-duplicates on the UNIQUE stripe_session_id makes this retry-safe.
  const pkgRes = await new Promise((resolve, reject) => {
    const body = JSON.stringify({
      user_id:                  userId,
      stripe_session_id:        session.id,
      stripe_payment_intent_id: session.payment_intent || null,
      amount_cents:             session.amount_total ?? null,
      images_granted:           PACKAGE_IMAGES,
      purchased_at:             purchasedAt.toISOString(),
      access_expires_at:        accessUntil.toISOString(),
      compliance_expires_at:    complianceUntil.toISOString()
    });
    const url = new URL(`${process.env.SUPABASE_URL}/rest/v1/listing_packages?on_conflict=stripe_session_id`);
    const req = https.request({
      hostname: url.hostname, path: url.pathname + url.search, method: 'POST',
      headers: {
        'apikey':         process.env.SUPABASE_SERVICE_ROLE_KEY,
        'Authorization':  `Bearer ${process.env.SUPABASE_SERVICE_ROLE_KEY}`,
        'Content-Type':   'application/json',
        'Prefer':         'resolution=ignore-duplicates,return=minimal',
        'Content-Length': Buffer.byteLength(body)
      }
    }, res => { res.resume(); res.on('end', () => resolve(res.statusCode)); });
    req.on('error', reject);
    req.write(body);
    req.end();
  });
  if (pkgRes >= 300) throw new Error(`listing_packages insert failed with ${pkgRes}`);

  // A cancelled subscriber's old listings were governed by the account-level
  // 30-day window. Pin that date onto each listing before the status flip, so
  // buying a package never revives pages that were scheduled to come down.
  if (status === 'cancelled' && user.data_expires_at) {
    await dbStrict('PATCH',
      `listings?user_id=eq.${userId}&compliance_expires_at=is.null&package_id=is.null`,
      { compliance_expires_at: user.data_expires_at });
  }

  // Latest window wins. Never downgrade a live subscriber (checkout blocks
  // that, but a stale session could still land here).
  const userPatch = {
    package_access_expires_at: accessUntil.toISOString(),
    data_expires_at:           exportUntil.toISOString()
  };
  if (session.customer && !user.stripe_customer_id) userPatch.stripe_customer_id = session.customer;
  if (!['active', 'past_due'].includes(status)) userPatch.subscription_status = 'package';
  await dbStrict('PATCH', `users?id=eq.${userId}`, userPatch);

  console.log(`stripe-webhook: listing package — user ${userId}, +${PACKAGE_IMAGES} Images, access until ${accessUntil.toISOString()}, compliance until ${complianceUntil.toISOString()}`);
}

// ── EVENT: invoice.paid ───────────────────────────────────
// Fires on monthly renewal. Adds monthly credit allotment.
async function onInvoicePaid(invoice) {
  // The first invoice of a new subscription is already covered by
  // checkout.session.completed's initial grant.
  if (invoice.billing_reason === 'subscription_create') {
    console.log(`stripe-webhook: invoice ${invoice.id} is the first invoice — credits granted at checkout, skipping`);
    return;
  }
  // Only regular renewals grant a monthly allotment (not proration or
  // manual invoices).
  if (invoice.billing_reason !== 'subscription_cycle') {
    console.log(`stripe-webhook: invoice ${invoice.id} (${invoice.billing_reason}) is not a renewal — skipping`);
    return;
  }

  const customerId = invoice.customer;
  const userResult = await db('GET', 'users',
    null,
    `?stripe_customer_id=eq.${customerId}&select=id,role,stripe_subscription_id`
  );
  const user = userResult.data?.[0];
  if (!user) { console.error(`stripe-webhook: invoice.paid — no user found for customer ${customerId}`); return; }

  if (await alreadyCredited(invoice.id)) {
    console.log(`stripe-webhook: invoice ${invoice.id} already credited — skipping`);
    return;
  }

  const plan    = await getPlanFromSubscriptionId(user.stripe_subscription_id) || 'solo';
  const credits = PLAN_CREDITS[plan] || PLAN_CREDITS.solo;
  const balance = await getCurrentBalance(user.id);

  await dbStrict('POST', 'credit_ledger', {
    user_id:           user.id,
    type:              'monthly_allotment',
    reason:            'subscription_renewal',
    amount:            credits,
    balance_after:     balance + credits,
    stripe_payment_id: invoice.id,
    description:       `Monthly renewal — ${plan} plan — ${credits} credits`
  });

  // Ensure subscription_status is active (catches recovery from past_due)
  await db('PATCH', `users?id=eq.${user.id}`, { subscription_status: 'active' });

  console.log(`stripe-webhook: invoice paid — user ${user.id}, plan ${plan}, +${credits} credits`);
}

// ── EVENT: customer.subscription.deleted ─────────────────
// Fires when the subscription actually ends (end of the paid period for a
// portal cancellation, or immediately if cancelled from the Stripe dashboard).
async function onSubscriptionDeleted(subscription) {
  const subId = subscription.id;
  const userResult = await db('GET', 'users', null,
    `?stripe_subscription_id=eq.${subId}&select=id`);
  const user = userResult.data?.[0];
  if (!user) {
    // Either an old subscription the user has already replaced, or a retry
    // of an event we already processed (stripe_subscription_id is nulled below).
    console.log(`stripe-webhook: subscription.deleted ${subId} — no user currently on it, nothing to do`);
    return;
  }

  const endedMs      = subscription.ended_at ? subscription.ended_at * 1000 : Date.now();
  const cancelledAt  = new Date(endedMs).toISOString();
  const dataExpires  = new Date(endedMs + POST_CANCEL_WINDOW_MS).toISOString();

  // Forfeit the remaining balance (ToS §6 / FAQ). Done before the status
  // flip so a failure here returns 500 and Stripe retries the whole event.
  const balance = await getCurrentBalance(user.id);
  if (balance > 0) {
    await dbStrict('POST', 'credit_ledger', {
      user_id:           user.id,
      type:              'adjustment',
      reason:            'cancellation_forfeit',
      amount:            -balance,
      balance_after:     0,
      stripe_payment_id: subId,
      description:       `Subscription ended — ${balance} unused credits forfeited`
    });
  }

  await dbStrict('PATCH', `users?id=eq.${user.id}`, {
    subscription_status:    'cancelled',
    stripe_subscription_id: null,
    cancel_at:              null,
    cancelled_at:           cancelledAt,
    data_expires_at:        dataExpires
  });
  await db('PATCH', `teams?stripe_subscription_id=eq.${subId}`,      { subscription_status: 'cancelled' });
  await db('PATCH', `brokerages?stripe_subscription_id=eq.${subId}`, { subscription_status: 'cancelled' });

  console.log(`stripe-webhook: subscription ended — user ${user.id}, forfeited ${balance}, compliance pages until ${dataExpires}`);
}

// ── EVENT: customer.subscription.updated ─────────────────
// Portal cancellation lands here first: status stays 'active' and Stripe
// sets cancel_at (+ cancel_at_period_end). Undoing it in the portal clears
// cancel_at, which clears ours too.
async function onSubscriptionUpdated(subscription) {
  const subId = subscription.id;
  const statusMap = {
    active:   'active',
    trialing: 'active',
    past_due: 'past_due',
    unpaid:   'past_due',
    canceled: 'cancelled'   // final state is handled by subscription.deleted
  };
  const fields = {
    cancel_at: subscription.cancel_at ? new Date(subscription.cancel_at * 1000).toISOString() : null
  };
  const mapped = statusMap[subscription.status];
  if (mapped && mapped !== 'cancelled') fields.subscription_status = mapped;
  // incomplete / incomplete_expired / paused: leave status alone — those
  // values aren't allowed by users_subscription_status_check.

  const r = await dbStrict('PATCH', `users?stripe_subscription_id=eq.${subId}`, fields);
  const n = Array.isArray(r.data) ? r.data.length : 0;
  console.log(`stripe-webhook: subscription.updated ${subId} — status ${subscription.status}, cancel_at ${fields.cancel_at}, ${n} user row(s) updated`);
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

  const sigHeader     = event.headers['stripe-signature'] || event.headers['Stripe-Signature'];
  const webhookSecret = process.env.STRIPE_WEBHOOK_SECRET;

  if (!sigHeader || !webhookSecret) {
    return { statusCode: 400, body: JSON.stringify({ error: 'Missing signature or webhook secret' }) };
  }

  // Signature must be checked against the exact raw bytes Stripe sent.
  const rawBody = event.isBase64Encoded
    ? Buffer.from(event.body || '', 'base64').toString('utf8')
    : (event.body || '');

  if (!verifyStripeSignature(rawBody, sigHeader, webhookSecret)) {
    console.error('stripe-webhook: signature verification failed');
    return { statusCode: 400, body: JSON.stringify({ error: 'Invalid Stripe signature' }) };
  }

  let stripeEvent;
  try { stripeEvent = JSON.parse(rawBody); }
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
