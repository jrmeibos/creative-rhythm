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
// they can't drift.
//
// FEATURES is the canonical list of everything the course offers, in the
// visual order the pricing table shows them. Each tier declares which
// features are `included`; the view renders a checkmark for included and
// a dimmed dash for excluded — so higher tiers visibly "contain" lower.
//
// To add a feature: add an entry here, then include its id on every tier
// that gets it. To adjust a price: edit priceCents on the tier.
//
// NOTE: 'coaching' is temporarily priced at $1,111 (111100 cents) as a
// demo discount from its intended $1,800 price. Revert to 180000 when the
// demo period ends — single line, no other code touches this.

const FEATURES = [
  { id: 'lifetime',     label: 'Lifetime access to the course materials' },
  { id: 'platform',     label: 'Full access to The Creative’s Garden platform' },
  { id: 'discord',      label: 'Community Discord' },
  { id: 'self_paced',   label: 'Go at your own pace' },
  { id: 'group_calls',  label: 'Monthly Group Calls (3)' },
  { id: 'coworking',    label: 'Monthly Coworking Calls (3)' },
  { id: 'julia_calls',  label: 'Group calls led by Julia' },
  { id: 'coaching',     label: 'Monthly 1-on-1 Coaching Sessions with Julia (3)' },
];

// `labelOverrides` lets a tier replace the default label for one of the
// features it includes. Used so the same feature slot ("how you move
// through the material") can read as "Go at your own pace" on Solo and
// "Stay on track with group pacing" on the group tiers — one row per card,
// no need to split into two separate features.

const TIERS = [
  {
    id:          'solo',
    name:        'Grow Solo',
    priceCents:  29900,
    tagline:     'Self-led, at your own pace',
    includes:    ['lifetime', 'platform', 'discord', 'self_paced'],
  },
  {
    id:          'community',
    name:        'Grow in Community',
    priceCents:  89900,
    tagline:     'The course + a monthly rhythm of shared work',
    includes:    ['lifetime', 'platform', 'discord', 'self_paced', 'group_calls', 'coworking', 'julia_calls'],
    labelOverrides: {
      self_paced: 'Stay on track with group pacing over 9 weeks',
    },
  },
  {
    id:          'coaching',
    name:        'Grow with Support',
    priceCents:  111100,          // TEMPORARY DEMO DISCOUNT
    originalPriceCents: 180000,   // Full price; strikethrough on the card.
    priceNote:   'Limited-time demo pricing',
    tagline:     '1-on-1 coaching, the deepest support',
    includes:    ['lifetime', 'platform', 'discord', 'self_paced', 'group_calls', 'coworking', 'julia_calls', 'coaching'],
    labelOverrides: {
      self_paced: 'Stay on track with group pacing over 9 weeks',
    },
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

function getFeatures() {
  return FEATURES;
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
  getFeatures,
  findTier,
  formatPrice,
  getCurrency,
  createUpgradePaymentIntent,
  constructWebhookEvent,
};
