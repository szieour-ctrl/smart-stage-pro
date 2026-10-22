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
  if (session.mode === 'payment' && session.metadata?.plan === 'image_pack') {
    return onImagePackPurchased(session);
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
  let freshGrant = false;
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
    freshGrant = true;
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

  // Welcome email — first fulfilment of this checkout session only. Non-fatal.
  if (freshGrant) {
    const wRes = await db('GET', 'users', null, `?id=eq.${userId}&select=email,full_name`);
    const w = wRes.data?.[0] || {};
    await sendWelcomeEmail({
      email: w.email || session.customer_details?.email || session.customer_email,
      name:  w.full_name || session.customer_details?.name || '',
      plan, images: credits, sessionId: session.id
    });
  }
}

// ── EVENT: checkout.session.completed — Image Pack ────────
// One-time add-on for live subscribers. Image counts are fixed HERE (never read
// from Stripe metadata). Retry-safe: grant is keyed on the checkout session id.
const IMAGE_PACK_IMAGES = { solo: 20, team: 50, brokerage: 100 };
async function onImagePackPurchased(session) {
  const userId = session.metadata?.user_id;
  const images = IMAGE_PACK_IMAGES[session.metadata?.pack];
  if (!userId || !images) { console.error('stripe-webhook: image pack checkout missing user_id/pack', session.id); return; }
  if (session.payment_status !== 'paid') {
    console.log(`stripe-webhook: image pack ${session.id} not paid (${session.payment_status}) — skipping`);
    return;
  }
  const uRes = await db('GET', 'users', null, `?id=eq.${userId}&select=id,email,stripe_customer_id`);
  const user = uRes.data?.[0];
  if (!user) throw new Error(`image pack purchase for unknown user ${userId}`); // 500 → Stripe retries
  if (await alreadyCredited(session.id, 'purchase')) {
    console.log(`stripe-webhook: image pack ${session.id} already credited — skipping`);
    return;
  }
  const balance = await getCurrentBalance(userId);
  await dbStrict('POST', 'credit_ledger', {
    user_id:           userId,
    type:              'purchase',
    reason:            'image_pack',
    amount:            images,
    balance_after:     balance + images,
    stripe_payment_id: session.id,
    description:       `Image Pack (${session.metadata.pack}) — ${images} Images`
  });
  console.log(`stripe-webhook: image pack — user ${userId}, +${images} images`);

  // Remember the Stripe customer (created at checkout for accounts without one)
  // so Billing/receipts line up. Best-effort: the images are already granted.
  if (session.customer && !user.stripe_customer_id) {
    try { await db('PATCH', `users?id=eq.${userId}`, { stripe_customer_id: session.customer }); }
    catch (e) { console.error('stripe-webhook: could not save stripe_customer_id:', e.message); }
  }

  // Receipt email via Pabbly (sent once, on first fulfilment). Non-fatal.
  await sendImagePackReceipt({
    email:  user.email || session.customer_details?.email || session.customer_email,
    images, pack: session.metadata.pack,
    amount: session.amount_total, balance: balance + images, sessionId: session.id
  });
}

function escHtmlLocal(v) {
  return String(v ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

// ── Transactional email via Pabbly ────────────────────────
// One Pabbly workflow sends every email: it maps `to`, `subject` and
// `emailHtml` from this payload into a Gmail step. Env var (new name first,
// old name still honoured): PABBLY_TRANSACTIONAL_EMAIL_WEBHOOK_URL or
// PABBLY_IMAGE_PACK_WEBHOOK_URL. The call is awaited with a 5s cap (Netlify can
// freeze a function once it returns) and is NEVER fatal: purchases are already
// fulfilled before any email is attempted.
async function postTransactionalEmail({ to, subject, emailHtml, kind, extra }) {
  const hook = process.env.PABBLY_TRANSACTIONAL_EMAIL_WEBHOOK_URL || process.env.PABBLY_IMAGE_PACK_WEBHOOK_URL;
  if (!hook) { console.warn(`stripe-webhook: no Pabbly email webhook configured — ${kind} email not sent`); return; }
  if (!to) { console.error(`stripe-webhook: ${kind} email skipped — no recipient address`); return; }
  try {
    const url = new URL(hook);
    const body = JSON.stringify({ to, subject, emailHtml, kind, ...(extra || {}) });
    await new Promise((resolve) => {
      const req = https.request({
        hostname: url.hostname, path: url.pathname + url.search, method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) },
        timeout: 5000,
      }, (res) => {
        res.resume();
        res.on('end', () => { if (res.statusCode >= 400) console.error(`stripe-webhook: ${kind} email Pabbly returned HTTP`, res.statusCode); resolve(); });
      });
      req.on('timeout', () => { console.error(`stripe-webhook: ${kind} email Pabbly timed out (non-fatal)`); req.destroy(); resolve(); });
      req.on('error', (e) => { console.error(`stripe-webhook: ${kind} email Pabbly failed (non-fatal):`, e.message); resolve(); });
      req.write(body); req.end();
    });
  } catch (e) {
    console.error(`stripe-webhook: ${kind} email setup error (non-fatal):`, e.message);
  }
}

function emailDate() {
  return new Date().toLocaleDateString('en-US', { year: 'numeric', month: 'long', day: 'numeric', timeZone: 'America/Los_Angeles' });
}
function fmtEmailDate(d) {
  return new Date(d).toLocaleDateString('en-US', { year: 'numeric', month: 'long', day: 'numeric', timeZone: 'America/Los_Angeles' });
}

// Branded receipt layout shared by the image pack and Listing Package emails.
function receiptEmailHtml({ heading, intro, rows, extraHtml, sessionId }) {
  const row = ([label, value, bold]) => `<tr><td style="padding:10px 0;border-bottom:1px solid #eee;color:#666;font-size:14px;">${label}</td><td style="padding:10px 0;border-bottom:1px solid #eee;text-align:right;font-size:14px;color:#1a1a1a;${bold ? 'font-weight:700;' : ''}">${value}</td></tr>`;
  return `<div style="background:#f5f3ef;padding:24px 12px;font-family:Arial,Helvetica,sans-serif;">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="max-width:560px;margin:0 auto;background:#ffffff;border-radius:6px;overflow:hidden;">
<tr><td style="background:#1a1a1a;padding:22px 28px;text-align:center;"><span style="font-family:Georgia,'Times New Roman',serif;font-size:22px;letter-spacing:3px;color:#c9a84c;">SMART STAGE PRO</span></td></tr>
<tr><td style="padding:30px 28px 8px;">
<h1 style="font-family:Georgia,'Times New Roman',serif;font-size:24px;font-weight:600;margin:0 0 12px;color:#1a1a1a;">${escHtmlLocal(heading)}</h1>
<p style="font-size:15px;line-height:1.6;color:#333;margin:0 0 20px;">${escHtmlLocal(intro)}</p>
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="border-top:1px solid #eee;">
${rows.filter(Boolean).map(row).join('\n')}
</table>
${extraHtml || ''}
<p style="text-align:center;margin:28px 0 8px;"><a href="https://smartstagepro.com" style="display:inline-block;background:#c9a84c;color:#1a1a1a;text-decoration:none;font-weight:700;font-size:15px;padding:13px 28px;border-radius:4px;">Open Smart Stage PRO</a></p>
</td></tr>
<tr><td style="padding:18px 28px 28px;font-size:12px;color:#888;line-height:1.6;border-top:1px solid #f0f0f0;">
Receipt reference: ${escHtmlLocal(sessionId)}<br>
Questions about this purchase? Reply to this email or write <a href="mailto:support@smartstagepro.com" style="color:#b8963e;">support@smartstagepro.com</a>.<br>
Smart Stage PRO &middot; smartstagepro.com
</td></tr></table></div>`;
}

async function sendImagePackReceipt({ email, images, pack, amount, balance, sessionId }) {
  const packName = { solo: 'Solo', team: 'Team', brokerage: 'Brokerage' }[pack] || '';
  const price = amount != null ? `$${(amount / 100).toFixed(2)}` : '';
  const emailHtml = receiptEmailHtml({
    heading: 'Your images have been added',
    intro: 'Thank you for your purchase. Your image pack is on your account and ready to use now.',
    rows: [
      ['Item', `${escHtmlLocal(packName)} Image Pack`.trim()],
      ['Images added', `+${escHtmlLocal(images)}`, true],
      price && ['Amount paid', escHtmlLocal(price)],
      ['Date', escHtmlLocal(emailDate())],
      ['Your new image balance', `<strong>${escHtmlLocal(balance)}</strong>`],
    ],
    sessionId,
  });
  await postTransactionalEmail({
    to: email, kind: 'image_pack',
    subject: `Your Smart Stage PRO image pack: ${images} images added`,
    emailHtml, extra: { images, pack, amountCents: amount ?? null, balance, sessionId },
  });
}

async function sendListingPackageReceipt({ email, amount, balance, accessUntil, exportUntil, sessionId }) {
  const price = amount != null ? `$${(amount / 100).toFixed(2)}` : '';
  const emailHtml = receiptEmailHtml({
    heading: 'Your Listing Package is ready',
    intro: 'Thank you for your purchase. Your images are on your account and you can start staging your listing now.',
    rows: [
      ['Item', 'Listing Package'],
      ['Images added', `+${PACKAGE_IMAGES}`, true],
      price && ['Amount paid', escHtmlLocal(price)],
      ['Date', escHtmlLocal(emailDate())],
      ['Tools and images available through', escHtmlLocal(fmtEmailDate(accessUntil))],
      ['Download your images by', escHtmlLocal(fmtEmailDate(exportUntil))],
      ['Your image balance', `<strong>${escHtmlLocal(balance)}</strong>`],
    ],
    sessionId,
  });
  await postTransactionalEmail({
    to: email, kind: 'listing_package',
    subject: `Your Smart Stage PRO Listing Package: ${PACKAGE_IMAGES} images added`,
    emailHtml, extra: { images: PACKAGE_IMAGES, amountCents: amount ?? null, balance, sessionId },
  });
}

// Welcome email for a new subscription (sent once per checkout session).
async function sendWelcomeEmail({ email, name, plan, images, sessionId }) {
  const planLabel = { solo: 'Solo', team: 'Team', brokerage: 'Brokerage' }[plan] || '';
  const step = (n, title, body) => `<tr><td valign="top" style="padding:0 14px 18px 0;width:26px;"><div style="background:#c9a84c;color:#1a1a1a;font-weight:700;font-size:13px;width:26px;height:26px;line-height:26px;border-radius:13px;text-align:center;">${n}</div></td><td style="padding:0 0 18px;"><div style="font-weight:700;margin-bottom:3px;">${title}</div><div style="color:#555;font-size:14.5px;line-height:1.6;">${body}</div></td></tr>`;
  const emailHtml = `<div style="max-width:600px;margin:0 auto;font-family:Georgia,serif;color:#1a1a1a;background:#fff;">
<div style="background:#1a1a1a;padding:28px 32px;text-align:center;">
<div style="font-family:Georgia,serif;font-size:22px;color:#c9a84c;letter-spacing:0.08em;">SMART STAGE PRO&trade;</div>
<div style="font-size:11.5px;color:#888;letter-spacing:0.12em;margin-top:4px;">BY SZ REAL ESTATE GROUP</div>
</div>
<div style="padding:36px 32px 24px;">
<p style="font-size:16.5px;line-height:1.7;margin:0 0 16px;">Hi ${escHtmlLocal(name || 'there')},</p>
<p style="font-size:16.5px;line-height:1.7;margin:0 0 16px;">Welcome aboard &mdash; I'm genuinely glad you're here.</p>
<p style="font-size:16.5px;line-height:1.7;margin:0 0 16px;">I built Smart Stage PRO&trade; out of my own frustration as a listing agent. Virtual staging tools weren't built for how we actually work &mdash; and none of them were built with California AB 723 compliance in mind. This one is.</p>
<p style="font-size:16.5px;line-height:1.7;margin:0 0 32px;">Your${planLabel ? ' ' + escHtmlLocal(planLabel) + ' plan' : ' account'} is active${images ? ` and ${escHtmlLocal(images)} images have been added to your balance` : ''}. Let's get your first listing staged.</p>
</div>
<div style="height:1px;background:#e8e0d0;margin:0 32px;"></div>
<div style="padding:32px;">
<div style="font-family:Georgia,serif;font-size:18px;color:#1a1a1a;margin-bottom:20px;">Getting Started in 4 Steps</div>
<table role="presentation" cellpadding="0" cellspacing="0" width="100%">
${step(1, 'Sign in at smartstagepro.com', 'Use the email and password you created at checkout.')}
${step(2, 'Search your listing address', 'This creates your AB 723 compliance project and permanent QR code.')}
${step(3, 'Upload your photos and choose a staging style', 'The engine reads your space and builds a Master Staging Plan across all rooms.')}
${step(4, 'Generate Final &mdash; MLS Ready', 'Your compliant, watermark-free staged image is ready to upload to MetroList.')}
</table>
<div style="text-align:center;margin:12px 0 8px;"><a href="https://smartstagepro.com" style="background:#c9a84c;color:#1a1a1a;padding:14px 36px;text-decoration:none;font-weight:700;font-size:15px;border-radius:3px;display:inline-block;letter-spacing:0.04em;">Go to Smart Stage PRO&trade; &rarr;</a></div>
</div>
<div style="height:1px;background:#e8e0d0;margin:0 32px;"></div>
<div style="padding:28px 32px 36px;">
<p style="font-size:16px;line-height:1.7;margin:0 0 16px;">Questions? Reply to this email &mdash; it comes straight to me.</p>
<p style="font-size:16px;line-height:1.7;margin:0 0 4px;">Sam Zieour</p>
<p style="font-size:13.5px;color:#888;margin:0;">SZ Real Estate Group &middot; DRE #01397303 &middot; smartstagepro.com</p>
</div>
<div style="background:#f5f0e8;padding:16px 32px;text-align:center;">
<p style="font-size:11.5px;color:#888;margin:0;line-height:1.6;">California AB 723 &sect;10140.6 Compliant &middot; MetroList Rule 11.6.1<br>SZ Real Estate Group &middot; Sacramento, CA</p>
</div></div>`;
  await postTransactionalEmail({
    to: email, kind: 'welcome',
    subject: 'Welcome to Smart Stage PRO',
    emailHtml, extra: { plan, images: images || null, sessionId },
  });
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
    `?id=eq.${userId}&select=id,email,subscription_status,created_at,package_access_expires_at,data_expires_at,stripe_customer_id`);
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

  let pkgFresh = false, pkgBalance = null;
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
    pkgFresh = true; pkgBalance = balance + PACKAGE_IMAGES;
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

  // Receipt email — first fulfilment only. Non-fatal.
  if (pkgFresh) {
    await sendListingPackageReceipt({
      email: user.email || session.customer_details?.email || session.customer_email,
      amount: session.amount_total, balance: pkgBalance,
      accessUntil, exportUntil, sessionId: session.id
    });
  }
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
