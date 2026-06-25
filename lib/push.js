// Web Push wrapper. One configured webpush instance, used by:
//   • POST /api/push/subscribe and /unsubscribe  (subscription lifecycle)
//   • bin/send-daily-reminders.js + the cron route  (actual delivery)
//
// Designed to fail soft on missing VAPID env vars so the app still boots in
// local dev or on Railway before the vars are set. Routes can check
// isPushConfigured() and return a friendly "not configured" response instead
// of throwing a 500.

const webpush = require('web-push');
const db      = require('../db');

const VAPID_PUBLIC  = process.env.VAPID_PUBLIC_KEY  || '';
const VAPID_PRIVATE = process.env.VAPID_PRIVATE_KEY || '';
const VAPID_CONTACT = process.env.VAPID_CONTACT     || 'mailto:julia@meibostouch.com';

let configured = false;
if (VAPID_PUBLIC && VAPID_PRIVATE) {
  try {
    webpush.setVapidDetails(VAPID_CONTACT, VAPID_PUBLIC, VAPID_PRIVATE);
    configured = true;
    console.log('✓ Web Push configured');
  } catch (err) {
    // Most likely cause: malformed key. Don't crash — let routes report the
    // mis-configuration cleanly.
    console.warn('⚠️  Web Push setVapidDetails failed:', err.message);
  }
} else {
  console.log('ℹ Web Push not configured (VAPID_PUBLIC_KEY / VAPID_PRIVATE_KEY missing — push routes will return 503)');
}

function isPushConfigured() {
  return configured;
}

function getVapidPublicKey() {
  return VAPID_PUBLIC;
}

// Send one notification to every subscription registered for this user.
// Returns { sent, failed, pruned } counts so callers can log a summary.
// Dead-endpoint cleanup (HTTP 404 / 410) happens inline so stale rows don't
// accumulate.
async function sendPushToUser(userId, payload) {
  if (!configured) {
    return { sent: 0, failed: 0, pruned: 0, skipped: true };
  }

  const subs = db.getPushSubscriptionsForUser(userId);
  let sent = 0, failed = 0, pruned = 0;
  const body = JSON.stringify(payload);

  for (const sub of subs) {
    try {
      await webpush.sendNotification({
        endpoint: sub.endpoint,
        keys: { p256dh: sub.p256dh, auth: sub.auth },
      }, body);
      sent++;
    } catch (err) {
      const code = err && err.statusCode;
      if (code === 404 || code === 410) {
        db.deletePushSubscriptionByEndpoint(sub.endpoint);
        pruned++;
      } else {
        console.warn('[push] send failed for sub', sub.id, '— status', code, '—', err.message);
        failed++;
      }
    }
  }

  return { sent, failed, pruned, skipped: false };
}

module.exports = {
  isPushConfigured,
  getVapidPublicKey,
  sendPushToUser,
};
