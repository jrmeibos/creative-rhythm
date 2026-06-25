// The Creative's Garden — service worker
//
// Commit 1 (this file) provides the minimum needed to make the app
// installable as a PWA: a registered service worker with no offline cache
// strategy yet, plus stub handlers for push + notificationclick. The real
// push handling logic will land in Commit 2 alongside the subscription
// endpoints.
//
// We intentionally do NOT add a caching/offline strategy here — for a small
// cohort on stable home Wi-Fi the complexity isn't worth the staleness risk
// (you ship a fix, students see the old version cached for a week). If we
// ever need offline reflection writing we'll add it as a focused follow-up.

const SW_VERSION = '2026-06-24-01';

self.addEventListener('install', (event) => {
  // Activate the new SW as soon as it's installed, even if older tabs are
  // open. Combined with clients.claim() in 'activate', this keeps the live
  // version in sync with the deployed code without a hard reload.
  self.skipWaiting();
});

self.addEventListener('activate', (event) => {
  event.waitUntil(self.clients.claim());
});

// ─── Push notifications ────────────────────────────────────────────────────
// On Android (and iOS 16.4+) the OS wakes this handler when the server
// delivers a push. Right now the server isn't sending anything — this stub
// just shows a sensible default so we can sanity-test the pipeline.

self.addEventListener('push', (event) => {
  let payload = {
    title: "The Creative's Garden",
    body:  'You have a new notification.',
    tag:   'daily-reminder',
    url:   '/dashboard',
  };
  try {
    if (event.data) payload = { ...payload, ...event.data.json() };
  } catch (_) {
    // Server sent plain text — keep the defaults but use the text as the body
    if (event.data) {
      try { payload.body = event.data.text() || payload.body; } catch (_) {}
    }
  }

  event.waitUntil(self.registration.showNotification(payload.title, {
    body:   payload.body,
    icon:   '/icons/icon-192.png',
    badge:  '/icons/icon-192.png',
    tag:    payload.tag,
    data:   { url: payload.url || '/dashboard' },
  }));
});

// Tap a notification → open the dashboard (or whatever url the push set).
// Reuse an existing tab if one is open to avoid stacking duplicates.
self.addEventListener('notificationclick', (event) => {
  event.notification.close();
  const targetUrl = (event.notification.data && event.notification.data.url) || '/dashboard';

  event.waitUntil((async () => {
    const allClients = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
    for (const client of allClients) {
      const url = new URL(client.url);
      if (url.origin === self.location.origin) {
        await client.focus();
        return client.navigate(targetUrl);
      }
    }
    return self.clients.openWindow(targetUrl);
  })());
});
