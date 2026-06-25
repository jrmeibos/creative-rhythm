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

const PUSH_PAYLOAD = {
  title: "The Creative's Garden",
  body:  'Have you logged your recording for the day?',
  tag:   'daily-reminder',
  url:   '/dashboard',
};

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
    dryRun: !!dryRun,
  };

  if (!PUSH.isPushConfigured() && !dryRun) {
    // In production this short-circuits so a misconfigured deploy doesn't
    // claim milestones it never sent. Dry-run still iterates so the operator
    // can preview eligibility even when VAPID isn't wired up locally.
    _log('ℹ Web Push not configured (VAPID env vars missing) — skipping.');
    return summary;
  }
  if (!PUSH.isPushConfigured()) {
    _log('ℹ Web Push not configured — running in eligibility-only preview mode.');
  }

  const users = db.getUsersWithDailyReminderEnabled();
  summary.eligible = users.length;
  _log(`Eligible users (toggle on): ${users.length}`);

  for (const u of users) {
    const tz = u.timezone || 'America/Denver';
    const targetHour  = u.daily_reminder_hour;
    const currentHour = getHourInTimezone(_now, tz);

    if (currentHour !== targetHour) {
      _log(`  · ${u.name} (${u.email}) — target ${targetHour}, local hour ${currentHour} → skip`);
      continue;
    }
    summary.matched++;

    const dateKey   = getDateInTimezone(_now, tz);
    const milestone = `daily-reminder-${dateKey}`;

    if (dryRun) {
      _log(`  ✓ ${u.name} — WOULD claim ${milestone} and push`);
      continue;
    }

    const claimed = db.tryClaimMilestone(u.id, milestone);
    if (!claimed) {
      _log(`  · ${u.name} — already claimed ${milestone} → skip`);
      continue;
    }
    summary.claimed++;

    try {
      const result = await PUSH.sendPushToUser(u.id, PUSH_PAYLOAD);
      summary.pushed += result.sent;
      summary.failed += result.failed;
      summary.pruned += result.pruned;
      _log(`  ✓ ${u.name} (${u.email}) — sent: ${result.sent}, failed: ${result.failed}, pruned: ${result.pruned}`);
    } catch (err) {
      summary.failed++;
      _log(`  ✗ ${u.name} — send error: ${err.message}`);
    }
  }

  _log(`Done. Matched ${summary.matched}, claimed ${summary.claimed}, pushed ${summary.pushed}, failed ${summary.failed}, pruned ${summary.pruned}.`);
  return summary;
}

module.exports = {
  runDailyReminders,
  // exported for unit testing
  getHourInTimezone,
  getDateInTimezone,
};
