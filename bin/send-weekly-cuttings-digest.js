#!/usr/bin/env node
//
// Weekly cuttings digest — CLI wrapper. The real work lives in
// lib/weekly-cuttings-digest.js so both this script and the
// POST /admin/run-weekly-digest route share one code path.
//
// In production, the route is what fires on schedule (via GitHub
// Actions hitting the live URL once a week). This CLI stays useful
// for manual triggers and local --dry-run testing.
//
// Usage:
//   node bin/send-weekly-cuttings-digest.js            # actually send
//   node bin/send-weekly-cuttings-digest.js --dry-run  # render to /tmp, no email

const { runDigest } = require('../lib/weekly-cuttings-digest');

const dryRun = process.argv.includes('--dry-run');

runDigest({ dryRun })
  .then(() => process.exit(0))
  .catch(err => {
    console.error('[digest] fatal:', err);
    process.exit(1);
  });
