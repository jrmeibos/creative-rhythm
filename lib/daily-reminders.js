// Daily push reminder sender. Called from two places:
//   • bin/send-daily-reminders.js  — CLI for manual + dry-run testing
//   • server.js  POST /admin/run-daily-reminders  — hit hourly by GitHub
//                                                   Actions in production
//
// Cadence model:
//   GitHub Actions runs us at the top of every UTC hour. For each user with
//   `daily_reminder_enabled = 1`, we compute "what hour is it right now in
//   THEIR timezone" using Intl.DateTimeFormat. If that hour equals their
//   saved `daily_reminder_hour`, the user is eligible to receive the push
//   this round.
//
// Idempotency:
//   notification_log has a UNIQUE(user_id, milestone) constraint. We claim
//   the milestone `daily-reminder-YYYY-MM-DD` (date computed in the user's
//   timezone). A double-fire of the cron — or a slightly-fast-running clock
//   that ticks the same hour twice — still results in at most one push per
//   student per day.

const db   = require('../db');
const PUSH = require('./push');
const { sendDailyReminderEmail } = require('../email');

// Rotating daily nudges so the reminder doesn't go stale. One is chosen per
// day (by date — see nudgeForDate) and used for BOTH the push body and the
// email nudge line, so a student who gets both sees the same message that day.
// Edit these freely; keep them short so phones don't truncate. The push title
// stays the app name for recognition — only the body rotates.
const DAILY_NUDGES = [
  // Julia's originals
  "Have you logged your recording for the day?",
  "A few minutes, just you and the camera. Log today's recording when you're ready.",
  "Here's a gentle nudge to press record today, even if it feels inconvenient.",
  "Have you done your recording for the day yet? There's still time.",
  "It's time for a li'l one-on-one chat with yourself.",
  "What's on your mind? Your daily ritual awaits.",
  "What did you talk about in your recording today? Don't forget to log it.",
  "Time to press record!",
  "Share what's on your mind. The garden is waiting.",
  "It's all in the small, daily steps. Have you recorded yet?",
  // Additions in the same voice
  "What's stirring under the surface today? Your daily ritual is ready when you are.",
  "No script needed. Ready to record?",
  "Show up as you are. (Pajamas more than welcome)",
  "A tiny act of courage today: say how you REALLY feel. (even if you're the only one who hears it)",
  "Your future self might watch this back. Let's give them something real.",
  "What's alive for you right now? Tell the camera, then log it.",
  "Even a messy recording counts. (Especially a messy one)",
  "Come sit with yourself for a few minutes today.",
  "The hardest part is starting. Simply press record and see what comes up.",
  "What would you say if no one was watching? Well, no one is! Say it.",
  "One small recording today. That's how this garden grows.",
  "Your daily check-in is waiting.",
  "Just you, the camera, and whatever's true today.",
  "Log today's recording and watch yourself grow.",
  "One day at a time. Ready when you are!",
  "A few unfiltered minutes can work wonders for the soul.",
  "What's authentic for you today?",
];

const PUSH_TITLE = "The Creative's Garden";
const PUSH_TAG   = 'daily-reminder';
const PUSH_URL   = '/dashboard';

// Pick the day's nudge from the local date string (YYYY-MM-DD). Rotating by
// day means it never repeats two days in a row and cycles through the whole
// list. Everyone on the same local date gets the same nudge.
function nudgeForDate(dateKey) {
  const dayNum = Math.floor(Date.parse(`${dateKey}T00:00:00Z`) / 86400000);
  const n = DAILY_NUDGES.length;
  return DAILY_NUDGES[((dayNum % n) + n) % n];
}

// Intl.DateTimeFormat handles DST correctly per-timezone, so a saved
// daily_reminder_hour of 8 stays "8 AM local" across spring-forward /
// fall-back even though the UTC offset changes underneath.
function getHourInTimezone(date, timezone) {
  try {
    const fmt = new Intl.DateTimeFormat('en-US', {
      hour: 'numeric', hour12: false, timeZone: timezone,
    });
    // 'en-US' with hour12:false returns '0'..'23' (or '24' for the rare
    // midnight edge — strip to 0–23 to be safe).
    const h = parseInt(fmt.format(date), 10);
    return h === 24 ? 0 : h;
  } catch (e) {
    // Bad timezone — fall back to UTC so we still attempt delivery.
    return date.getUTCHours();
  }
}

// YYYY-MM-DD computed in the user's local timezone. 'en-CA' gives ISO format
// directly without us reaching for toISOString + offset math.
function getDateInTimezone(date, timezone) {
  try {
    const fmt = new Intl.DateTimeFormat('en-CA', {
      year: 'numeric', month: '2-digit', day: '2-digit',
      timeZone: timezone,
    });
    return fmt.format(date);
  } catch (e) {
    return date.toISOString().slice(0, 10);
  }
}

async function runDailyReminders({ now, dryRun = false, log } = {}) {
  const _log = log || console.log;
  const _now = now || new Date();

  const summary = {
    eligible: 0, matched: 0, claimed: 0,
    pushed: 0, failed: 0, pruned: 0,
    emailed: 0, emailFailed: 0,
    dryRun: !!dryRun,
  };

  // Push and email are independent channels now, so a missing VAPID config no
  // longer short-circuits the whole run — email reminders still go out. Push
  // sends are simply skipped when it isn't configured.
  const pushOn = PUSH.isPushConfigured();
  if (!pushOn) {
    _log('ℹ Web Push not configured (VAPID env vars missing) — push sends skipped; email reminders still send.');
  }

  const users = db.getUsersWithDailyReminderEnabled();
  summary.eligible = users.length;
  _log(`Eligible users (toggle on): ${users.length}`);

  for (const u of users) {
    const tz = u.timezone || 'America/Denver';
    const targetHour  = u.daily_reminder_hour;
    const currentHour = getHourInTimezone(_now, tz);

    // Fire when we're at OR PAST the target hour (same local day), not only on
    // an exact match. GitHub Actions cron drifts — a run scheduled for the top
    // of the hour often lands 15–60 min late, sometimes slipping into the next
    // hour entirely. With an exact match that meant a silently missed day; with
    // ">=", the next hourly run catches it (a little late beats never). The
    // per-day milestone below still guarantees exactly one reminder per day, so
    // later runs that same day claim-and-skip rather than re-sending.
    if (currentHour < targetHour) {
      _log(`  · ${u.name} (${u.email}) — target ${targetHour}, local hour ${currentHour} → not due yet`);
      continue;
    }
    summary.matched++;

    // Which channels does this user actually have? Push whenever it's
    // configured (sendPushToUser no-ops for users with no devices); email only
    // if they opted in. If neither, don't claim a milestone we can't fulfil.
    const wantEmail = !!u.reminder_email_enabled;
    if (!pushOn && !wantEmail) {
      _log(`  · ${u.name} — no active reminder channel → skip`);
      continue;
    }

    const dateKey   = getDateInTimezone(_now, tz);
    const milestone = `daily-reminder-${dateKey}`;
    const nudge     = nudgeForDate(dateKey);

    if (dryRun) {
      const channels = [pushOn ? 'push' : null, wantEmail ? 'email' : null].filter(Boolean).join(' + ');
      _log(`  ✓ ${u.name} — WOULD claim ${milestone}, send via ${channels} — "${nudge}"`);
      continue;
    }

    const claimed = db.tryClaimMilestone(u.id, milestone);
    if (!claimed) {
      _log(`  · ${u.name} — already claimed ${milestone} → skip`);
      continue;
    }
    summary.claimed++;

    // Push channel
    if (pushOn) {
      try {
        const result = await PUSH.sendPushToUser(u.id, {
          title: PUSH_TITLE, body: nudge, tag: PUSH_TAG, url: PUSH_URL,
        });
        summary.pushed += result.sent;
        summary.failed += result.failed;
        summary.pruned += result.pruned;
        _log(`  ✓ ${u.name} (${u.email}) — push sent: ${result.sent}, failed: ${result.failed}, pruned: ${result.pruned}`);
      } catch (err) {
        summary.failed++;
        _log(`  ✗ ${u.name} — push error: ${err.message}`);
      }
    }

    // Email channel
    if (wantEmail) {
      try {
        const r = await sendDailyReminderEmail(u.email, u.name, nudge);
        if (r.ok) {
          summary.emailed++;
          _log(`  ✉ ${u.name} (${u.email}) — email sent`);
        } else {
          summary.emailFailed++;
          _log(`  ✗ ${u.name} — email failed: ${r.error}`);
        }
      } catch (err) {
        summary.emailFailed++;
        _log(`  ✗ ${u.name} — email error: ${err.message}`);
      }
    }
  }

  _log(`Done. Matched ${summary.matched}, claimed ${summary.claimed}, ` +
    `pushed ${summary.pushed}, push-failed ${summary.failed}, pruned ${summary.pruned}, ` +
    `emailed ${summary.emailed}, email-failed ${summary.emailFailed}.`);
  return summary;
}

module.exports = {
  runDailyReminders,
  // exported for unit testing
  getHourInTimezone,
  getDateInTimezone,
};
