// Shared digest logic, callable from both:
//   bin/send-daily-cuttings-digest.js  — manual CLI / dry-run / local testing
//   server.js  POST /admin/run-daily-digest  — what the external cron pings
//
// Runs once a day (target: morning admin time). Reports yesterday's cuttings
// from every user; one email per user who recorded something, milestone-
// claimed by (user, date) so a re-fire of the cron in the same day is a
// no-op.

const fs   = require('fs');
const path = require('path');
const ejs  = require('ejs');

const db = require('../db');
const { renderHtmlToPdf } = require('./pdf-render');
const CUTTING_PROMPTS = require('./cutting-prompts');
const { sendAdminMilestoneEmail } = require('../email');

// ─── Embedded brand assets (mirrors server.js CUTTINGS_PDF_ASSETS) ──────────
function loadAssets() {
  const fontsDir = path.join(__dirname, '..', 'public', 'fonts');
  const read64 = (f) => fs.readFileSync(path.join(fontsDir, f)).toString('base64');
  const badgePngBase64 = fs.readFileSync(
    path.join(__dirname, '..', 'public', 'images', 'brand', 'creatives-garden-badge-green.png')
  ).toString('base64');
  const fontFaceCss = `
    @font-face {
      font-family: 'Goldage';
      src: url(data:font/woff;base64,${read64('goldage-regular-webfont.woff')}) format('woff');
      font-weight: 400; font-style: normal; font-display: block;
    }
    @font-face {
      font-family: 'Goldage';
      src: url(data:font/woff;base64,${read64('goldage-italic-webfont.woff')}) format('woff');
      font-weight: 400; font-style: italic; font-display: block;
    }
    @font-face {
      font-family: 'Jost';
      src: url(data:font/woff2;base64,${read64('jost-normal-latin.woff2')}) format('woff2');
      font-weight: 300 700; font-style: normal; font-display: block;
    }
    @font-face {
      font-family: 'Jost';
      src: url(data:font/woff2;base64,${read64('jost-italic-latin.woff2')}) format('woff2');
      font-weight: 300; font-style: italic; font-display: block;
    }
  `;
  return { badgePngBase64, fontFaceCss };
}

// Yesterday's date in Eastern time. Eastern shifts between EST/EDT;
// Intl.DateTimeFormat with America/New_York handles DST automatically.
function yesterdayEastern(now) {
  const fmt = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'America/New_York',
    year: 'numeric', month: '2-digit', day: '2-digit',
  });
  const parts = fmt.formatToParts(now);
  const get = (t) => parts.find(p => p.type === t).value;
  const today = new Date(Date.UTC(
    parseInt(get('year'),  10),
    parseInt(get('month'), 10) - 1,
    parseInt(get('day'),   10),
  ));
  today.setUTCDate(today.getUTCDate() - 1);
  return today.toISOString().slice(0, 10);  // YYYY-MM-DD
}

function formatDateLabel(dateStr) {
  const d = new Date(dateStr + 'T00:00:00Z');
  return d.toLocaleDateString('en-US', {
    weekday: 'long', month: 'long', day: 'numeric', year: 'numeric', timeZone: 'UTC',
  });
}

function studentFilenameSlug(name) {
  return String(name || 'student').toLowerCase()
    .replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '') || 'student';
}

async function renderDailyDigest({ assets, user, entries, dateLabel }) {
  const seasonGroups = [{
    label:      'Yesterday',
    weeksLabel: dateLabel,
    entries,
  }];
  const html = await ejs.renderFile(
    path.join(__dirname, '..', 'views', 'exports', 'cuttings-pdf.ejs'),
    {
      coverTitle:     `Yesterday's cuttings: ${user.name}`,
      badgePngBase64: assets.badgePngBase64,
      fontFaceCss:    assets.fontFaceCss,
      cuttingPrompts: CUTTING_PROMPTS,
      dateRangeLabel: dateLabel,
      seasonGroups,
    }
  );
  return await renderHtmlToPdf(html);
}

// Main entry point. Callers pass:
//   - dryRun:  if true, write PDFs to /tmp and don't email or claim milestones
//   - log:     function(string) — defaults to console.log; the HTTP caller
//              passes a buffer-capturing logger so the response can include
//              the line-by-line trace.
async function runDigest({ dryRun = false, log = console.log } = {}) {
  const startedAt = Date.now();
  const now = new Date();
  const dateStr   = yesterdayEastern(now);
  const dateLabel = formatDateLabel(dateStr);
  // One milestone per (user, day) so a re-fire of the cron in the same
  // morning is a no-op for everyone who already received an email.
  const milestone = `daily_cuttings_${dateStr}`;

  log(`[digest] yesterday: ${dateStr} (${dateLabel})`);
  log(`[digest] milestone key: ${milestone}`);
  if (dryRun) log('[digest] DRY RUN — no emails will be sent and no milestones claimed.');

  const assets   = loadAssets();
  const students = db.getAllAccountsForDigest();
  let sent = 0, skippedEmpty = 0, skippedAlreadyClaimed = 0, failed = 0;

  for (const user of students) {
    const entries = db.getCuttingsForUserInRange(user.id, dateStr, dateStr);
    if (entries.length === 0) {
      skippedEmpty++;
      continue;
    }
    if (!dryRun && !db.tryClaimMilestone(user.id, milestone)) {
      skippedAlreadyClaimed++;
      continue;
    }
    try {
      const buffer = await renderDailyDigest({ assets, user, entries, dateLabel });
      const filename = `${studentFilenameSlug(user.name)}-cuttings-${dateStr}.pdf`;
      if (dryRun) {
        const outPath = path.join('/tmp', filename);
        fs.writeFileSync(outPath, buffer);
        log(`[digest] ${user.name}: ${entries.length} cuttings → ${outPath} (${buffer.length} bytes)`);
      } else {
        const result = await sendAdminMilestoneEmail({
          studentName: user.name,
          subject:     `[Creative's Garden] ${user.name} — yesterday's cuttings`,
          bodyLine:    `${user.name} recorded ${entries.length} cutting${entries.length === 1 ? '' : 's'} on ${dateLabel}. A copy is attached.`,
          pdf:         { filename, buffer },
        });
        // sendAdminMilestoneEmail returns {ok:false} instead of throwing
        // (e.g. missing/invalid RESEND_API_KEY). Without this check a failed
        // send counted as "sent" AND kept the claim, so Julia silently got
        // nothing and no retry was possible. Release the claim so tomorrow's
        // run re-attempts it.
        if (!result || !result.ok) {
          db.releaseMilestone(user.id, milestone);
          throw new Error(result && result.error ? result.error : 'email send failed');
        }
        log(`[digest] ${user.name}: ${entries.length} cuttings → emailed`);
        sent++;
      }
    } catch (err) {
      failed++;
      log(`[digest] ${user.name} (id=${user.id}) FAILED: ${err.message}`);
    }
  }

  const durationMs = Date.now() - startedAt;
  log(`[digest] done. sent=${sent} skippedEmpty=${skippedEmpty} skippedAlreadyClaimed=${skippedAlreadyClaimed} failed=${failed} (${durationMs}ms)`);
  return {
    window:                 { date: dateStr, label: dateLabel },
    milestoneKey:           milestone,
    sent,
    skippedEmpty,
    skippedAlreadyClaimed,
    failed,
    durationMs,
  };
}

module.exports = { runDigest };
