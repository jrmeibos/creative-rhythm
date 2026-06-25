#!/usr/bin/env node
//
// Daily reminder push sender — CLI wrapper. The real work lives in
// lib/daily-reminders.js so this script and the
// POST /admin/run-daily-reminders route share one code path.
//
// In production, the route is what fires on schedule (GitHub Actions
// hits the live URL once an hour). This CLI is for manual triggers and
// --dry-run testing.
//
// Usage:
//   node bin/send-daily-reminders.js            # actually send
//   node bin/send-daily-reminders.js --dry-run  # log decisions, no send

const { runDailyReminders } = require('../lib/daily-reminders');

const dryRun = process.argv.includes('--dry-run');

runDailyReminders({ dryRun })
  .then(s => {
    console.log('Summary:', JSON.stringify(s));
    process.exit(0);
  })
  .catch(err => {
    console.error('[daily-reminders] fatal:', err);
    process.exit(1);
  });
