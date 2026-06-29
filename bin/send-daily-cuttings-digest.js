#!/usr/bin/env node
//
// Daily cuttings digest — CLI wrapper. The real work lives in
// lib/daily-cuttings-digest.js so both this script and the
// POST /admin/run-daily-digest route share one code path.
//
// In production, the route is what fires on schedule (via GitHub
// Actions hitting the live URL once a day). This CLI stays useful
// for manual triggers and local --dry-run testing.
//
// Usage:
//   node bin/send-daily-cuttings-digest.js            # actually send
//   node bin/send-daily-cuttings-digest.js --dry-run  # render to /tmp, no email

const { runDigest } = require('../lib/daily-cuttings-digest');

const dryRun = process.argv.includes('--dry-run');

runDigest({ dryRun })
  .then(() => process.exit(0))
  .catch(err => {
    console.error('[digest] fatal:', err);
    process.exit(1);
  });
