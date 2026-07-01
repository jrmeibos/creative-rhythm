// Stripe SDK wrapper. Single source of truth for Stripe config so the rest
// of the app stays out of the Stripe.js constructor + mode-detection logic.
//
// Configuration is read from env at boot:
//   STRIPE_SECRET_KEY       — sk_test_... or sk_live_...
//   STRIPE_PUBLISHABLE_KEY  — pk_test_... or pk_live_... (view templates need this)
//   STRIPE_WEBHOOK_SECRET   — whsec_... (Phase B webhook route uses this)
//
// The mode ("test" or "live") is derived from the secret key prefix. Nothing
// in the app switches behavior based on the mode — it just gets logged so
// you can eyeball the deploy logs and confirm you're running the right one.

const STRIPE_SECRET_KEY      = process.env.STRIPE_SECRET_KEY      || '';
const STRIPE_PUBLISHABLE_KEY = process.env.STRIPE_PUBLISHABLE_KEY || '';
const STRIPE_WEBHOOK_SECRET  = process.env.STRIPE_WEBHOOK_SECRET  || '';

// Placeholder price. Julia will finalize this later — you can also override
// via env (STRIPE_UPGRADE_PRICE_CENTS=29900 = $299) without a code change.
const UPGRADE_PRICE_CENTS = parseInt(process.env.STRIPE_UPGRADE_PRICE_CENTS, 10) || 29700;
const UPGRADE_CURRENCY    = (process.env.STRIPE_UPGRADE_CURRENCY || 'usd').toLowerCase();

let stripe = null;
let mode   = 'none';

if (STRIPE_SECRET_KEY) {
  const Stripe = require('stripe');
  stripe = new Stripe(STRIPE_SECRET_KEY, {
    // Pin the API version so a future Stripe library update doesn't quietly
    // change wire-level behavior. Update deliberately when you're ready.
    apiVersion: '2024-06-20',
    // Reasonable default; retries idempotent calls, avoids retrying non-
    // idempotent ones by default.
    maxNetworkRetries: 2,
    timeout: 15_000,
  });
  mode = STRIPE_SECRET_KEY.startsWith('sk_live_') ? 'live'
       : STRIPE_SECRET_KEY.startsWith('sk_test_') ? 'test'
       : 'unknown';

  if (mode === 'live') {
    console.log('✓ Stripe running in LIVE mode (real charges will process)');
  } else if (mode === 'test') {
    console.log('✓ Stripe running in TEST mode (payments will not be real)');
  } else {
    console.warn('⚠ Stripe key format not recognized — expected sk_test_... or sk_live_...');
  }
} else {
  console.log('ℹ Stripe not configured (STRIPE_SECRET_KEY missing — /api/checkout and /webhooks/stripe return 503)');
}

function isConfigured() {
  return !!stripe;
}

function getPublishableKey() {
  return STRIPE_PUBLISHABLE_KEY;
}

function getMode() {
  return mode;
}

function getUpgradePriceCents() {
  return UPGRADE_PRICE_CENTS;
}

function getUpgradeCurrency() {
  return UPGRADE_CURRENCY;
}

// Create a PaymentIntent for a single upgrade purchase. userId is stashed in
// metadata so the webhook can identify who paid without trusting the client.
async function createUpgradePaymentIntent(userId, userEmail) {
  if (!stripe) throw new Error('Stripe not configured');
  return stripe.paymentIntents.create({
    amount:   UPGRADE_PRICE_CENTS,
    currency: UPGRADE_CURRENCY,
    // Metadata is echoed back on payment_intent.succeeded so the webhook
    // handler can look up which user to upgrade.
    metadata: {
      app:     'creatives-garden',
      purpose: 'winter-to-full-upgrade',
      user_id: String(userId),
    },
    receipt_email: userEmail || undefined,
    // Automatic methods lets Stripe pick from configured card / etc. — you
    // enable the specific methods in the Stripe dashboard, not in code.
    automatic_payment_methods: { enabled: true },
  });
}

// Verify + parse a webhook event using the raw request body + signature
// header. Throws if the signature doesn't match — caller returns 400.
function constructWebhookEvent(rawBody, signatureHeader) {
  if (!stripe) throw new Error('Stripe not configured');
  if (!STRIPE_WEBHOOK_SECRET) {
    throw new Error('STRIPE_WEBHOOK_SECRET not set — cannot verify webhook signature');
  }
  return stripe.webhooks.constructEvent(rawBody, signatureHeader, STRIPE_WEBHOOK_SECRET);
}

module.exports = {
  isConfigured,
  getPublishableKey,
  getMode,
  getUpgradePriceCents,
  getUpgradeCurrency,
  createUpgradePaymentIntent,
  constructWebhookEvent,
};
