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

// Payment currency. USD unless overridden via env.
const CURRENCY = (process.env.STRIPE_UPGRADE_CURRENCY || 'usd').toLowerCase();

// Enrollment tiers. Single source of truth for prices + copy — the /upgrade
// view, the server-side validator, and the webhook all pull from here so
// they can't drift. To adjust a price, edit priceCents; to add a tier, add
// an object here and matching UI copy (view auto-iterates).
//
// NOTE: 'coaching' is temporarily priced at $1,111 (111100 cents) as a
// demo discount from its intended $1,800 price. Revert to 180000 when the
// demo period ends — single line, no other code touches this.
const TIERS = [
  {
    id:          'solo',
    name:        'Grow Solo',
    priceCents:  29900,
    tagline:     'Self-led, at your own pace',
    bullets: [
      'Lifetime access to the recorded course materials',
      'Full access to The Creative’s Garden platform',
      'Access to the community Discord',
      'Go at your own pace — all the promises of the course, self-led',
    ],
  },
  {
    id:          'community',
    name:        'Grow in Community',
    priceCents:  99900,
    tagline:     'Course + monthly group calls + coworking',
    bullets: [
      'Everything in Grow Solo',
      'Three monthly group calls — ask questions, hear from peers',
      'Three monthly coworking calls — work through the material together',
      'Julia present for guidance during every call',
    ],
  },
  {
    id:          'coaching',
    name:        'Grow with Me',
    priceCents:  111100,  // TEMPORARY DEMO DISCOUNT — revert to 180000 = $1,800 after demo
    priceNote:   'Demo discount — usually $1,800',
    tagline:     '1-on-1 coaching, deepest support',
    bullets: [
      'Everything in Grow in Community',
      'Three monthly 1-on-1 coaching sessions with Julia',
      'Personalized guidance on your creative visibility',
    ],
  },
];

function findTier(tierId) {
  return TIERS.find(t => t.id === tierId) || null;
}

function formatPrice(priceCents) {
  // Simple USD formatting. Adjust if you support other currencies later.
  return '$' + (priceCents / 100).toLocaleString('en-US', {
    minimumFractionDigits: (priceCents % 100 === 0) ? 0 : 2,
    maximumFractionDigits: 2,
  });
}

let stripe = null;
let mode   = 'none';

if (STRIPE_SECRET_KEY) {
  const Stripe = require('stripe');
  stripe = new Stripe(STRIPE_SECRET_KEY, {
    // Pinned to match the webhook's API version so the PaymentIntent shape
    // Stripe sends us in payment_intent.succeeded matches what we created.
    // Update deliberately (both here AND the webhook destination in Stripe)
    // when you're ready to move to a newer version.
    apiVersion: '2026-06-24.dahlia',
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

function getTiers() {
  return TIERS;
}

function getCurrency() {
  return CURRENCY;
}

// Create a PaymentIntent for the selected tier. userId + tier both go into
// metadata so the webhook can identify who paid AND which tier they picked,
// without trusting the client's own POST.
async function createUpgradePaymentIntent(userId, userEmail, tierId) {
  if (!stripe) throw new Error('Stripe not configured');
  const tier = findTier(tierId);
  if (!tier) throw new Error('Unknown tier: ' + tierId);
  return stripe.paymentIntents.create({
    amount:   tier.priceCents,
    currency: CURRENCY,
    metadata: {
      app:     'creatives-garden',
      purpose: 'winter-to-full-upgrade',
      user_id: String(userId),
      tier:    tier.id,
    },
    receipt_email: userEmail || undefined,
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
  getTiers,
  findTier,
  formatPrice,
  getCurrency,
  createUpgradePaymentIntent,
  constructWebhookEvent,
};
