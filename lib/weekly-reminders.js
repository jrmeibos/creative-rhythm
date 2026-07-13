// Weekly reminder sender — the Monday "set your weekly intentions" nudge.
// Parallel to lib/daily-reminders.js and run by the SAME hourly job (the
// /admin/run-daily-reminders route calls both), so no extra cron/secret.
//
// Cadence model (mirrors daily, plus a day gate):
//   Each hourly run, for every user with weekly_reminder_enabled = 1, we check
//   (a) is it Monday in THEIR timezone, and (b) is the local hour at or past
//   their weekly_reminder_hour. If so they're due. The ">=" (not "==") makes it
//   resilient to GitHub Actions cron drift, same as the daily sender.
//
// Idempotency:
//   The milestone is keyed to THIS week's Monday date in the user's timezone
//   (weekly-reminder-YYYY-MM-DD), so a user gets at most one weekly nudge per
//   week even if the cron double-fires or catches up over several Monday hours.

const db   = require('../db');
const PUSH = require('./push');
const { getHourInTimezone, getDateInTimezone } = require('./daily-reminders');
const { sendWeeklyReminderEmail } = require('../email');

// Rotating weekly nudges so it stays fresh week to week. Chosen by the Monday
// date (see nudgeForDate). Used for both the push body and the email line.
const WEEKLY_NUDGES = [
  "A new week is unfolding. Ready to set your intentions?",
  "Fresh week, blank page. What matters most right now? Set your weekly intentions.",
  "Before the week gets loud, name what you want to focus on.",
  "What's one thing you'd love to nurture this week? It's time to set your weekly intentions.",
  "Set your intentions and let the week grow around them.",
  "New week, gentle start. Where would you like to put your energy this week? Log it when you're ready.",
  "What would make this a full week for you? Time to set your intentions",
  "A quiet Monday moment: choose what you're growing toward. Set your weekly intentions.",
  "Plant a few intentions today, and see what's blooming by Friday. Set your intentions.",
  "What's calling for your attention this week? Your weekly intention cards are waiting.",
  "Give the week some thought. Set your intentions when you're ready.",
  "Monday check-in: what do you want to say yes to this week? Set your weekly intentions.",
];

const PUSH_TITLE = "The Creative's Garden";
const PUSH_TAG   = 'weekly-reminder';
const PUSH_URL   = '/weekly-intentions';

// Weekday in the user's timezone as a 3-letter English abbreviation ('Mon').
function getWeekdayInTimezone(date, timezone) {
  try {
    return new Intl.DateTimeFormat('en-US', { weekday: 'short', timeZone: timezone }).format(date);
  } catch (e) {
    return new Intl.DateTimeFormat('en-US', { weekday: 'short', timeZone: 'UTC' }).format(date);
  }
}

function nudgeForDate(dateKey) {
  const dayNum = Math.floor(Date.parse(`${dateKey}T00:00:00Z`) / 86400000);
  const n = WEEKLY_NUDGES.length;
  return WEEKLY_NUDGES[((dayNum % n) + n) % n];
}

async function runWeeklyReminders({ now, dryRun = false, log } = {}) {
  const _log = log || console.log;
  const _now = now || new Date();

  const summary = {
    eligible: 0, matched: 0, claimed: 0,
    pushed: 0, failed: 0, pruned: 0,
    emailed: 0, emailFailed: 0,
    dryRun: !!dryRun,
  };

  const pushOn = PUSH.isPushConfigured();
  if (!pushOn) {
    _log('ℹ[weekly] Web Push not configured — push sends skipped; email reminders still send.');
  }

  const users = db.getUsersWithWeeklyReminderEnabled();
  summary.eligible = users.length;
  _log(`[weekly] Eligible users (toggle on): ${users.length}`);

  for (const u of users) {
    const tz = u.timezone || 'America/Denver';

    // Day gate: only Mondays (in the user's own timezone).
    const weekday = getWeekdayInTimezone(_now, tz);
    if (weekday !== 'Mon') {
      _log(`  ·[weekly] ${u.name} (${u.email}) — ${weekday} in ${tz}, not Monday → skip`);
      continue;
    }

    const targetHour  = u.weekly_reminder_hour;
    const currentHour = getHourInTimezone(_now, tz);
    if (currentHour < targetHour) {
      _log(`  ·[weekly] ${u.name} — target ${targetHour}, local hour ${currentHour} → not due yet`);
      continue;
    }
    summary.matched++;

    const wantEmail = !!u.weekly_reminder_email;
    if (!pushOn && !wantEmail) {
      _log(`  ·[weekly] ${u.name} — no active channel → skip`);
      continue;
    }

    const dateKey   = getDateInTimezone(_now, tz); // this Monday's date in their tz
    const milestone = `weekly-reminder-${dateKey}`;
    const nudge     = nudgeForDate(dateKey);

    if (dryRun) {
      const channels = [pushOn ? 'push' : null, wantEmail ? 'email' : null].filter(Boolean).join(' + ');
      _log(`  ✓[weekly] ${u.name} — WOULD claim ${milestone}, send via ${channels} — "${nudge}"`);
      continue;
    }

    const claimed = db.tryClaimMilestone(u.id, milestone);
    if (!claimed) {
      _log(`  ·[weekly] ${u.name} — already claimed ${milestone} → skip`);
      continue;
    }
    summary.claimed++;

    if (pushOn) {
      try {
        const result = await PUSH.sendPushToUser(u.id, {
          title: PUSH_TITLE, body: nudge, tag: PUSH_TAG, url: PUSH_URL,
        });
        summary.pushed += result.sent;
        summary.failed += result.failed;
        summary.pruned += result.pruned;
        _log(`  ✓[weekly] ${u.name} (${u.email}) — push sent: ${result.sent}, failed: ${result.failed}, pruned: ${result.pruned}`);
      } catch (err) {
        summary.failed++;
        _log(`  ✗[weekly] ${u.name} — push error: ${err.message}`);
      }
    }

    if (wantEmail) {
      try {
        const r = await sendWeeklyReminderEmail(u.email, u.name, nudge);
        if (r.ok) {
          summary.emailed++;
          _log(`  ✉[weekly] ${u.name} (${u.email}) — email sent`);
        } else {
          summary.emailFailed++;
          _log(`  ✗[weekly] ${u.name} — email failed: ${r.error}`);
        }
      } catch (err) {
        summary.emailFailed++;
        _log(`  ✗[weekly] ${u.name} — email error: ${err.message}`);
      }
    }
  }

  _log(`[weekly] Done. Matched ${summary.matched}, claimed ${summary.claimed}, ` +
    `pushed ${summary.pushed}, push-failed ${summary.failed}, pruned ${summary.pruned}, ` +
    `emailed ${summary.emailed}, email-failed ${summary.emailFailed}.`);
  return summary;
}

module.exports = {
  runWeeklyReminders,
  getWeekdayInTimezone,
};
