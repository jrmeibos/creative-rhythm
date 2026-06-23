#!/usr/bin/env node
//
// Weekly cuttings digest — fires Mon ~13:00 UTC (= 8am EST / 9am EDT).
// For each student with ≥1 cutting in the previous calendar week (Mon-Sun
// in Eastern), generate a small branded PDF of those cuttings and email it
// to ADMIN_EMAIL. Idempotent via notification_log — milestone string is
// week-scoped (e.g. weekly_cuttings_2026-W26) so re-running same week is a
// no-op, but next week's run sends fresh.
//
// Manual usage:
//   node bin/send-weekly-cuttings-digest.js            # actually send
//   node bin/send-weekly-cuttings-digest.js --dry-run  # render PDFs but skip email + claim
//
// Railway: add a cron service with command
//   node bin/send-weekly-cuttings-digest.js
// and schedule "0 13 * * 1" (Monday 13:00 UTC). See COMMIT MESSAGE for the
// DST note.

const fs   = require('fs');
const path = require('path');
const ejs  = require('ejs');

const db = require('../db');
const { renderHtmlToPdf } = require('../lib/pdf-render');
const CUTTING_PROMPTS = require('../lib/cutting-prompts');
const { sendAdminMilestoneEmail } = require('../email');

const DRY_RUN = process.argv.includes('--dry-run');

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

// ─── Date math: previous Mon-Sun window, in Eastern time ────────────────────
// Eastern shifts between EST (UTC-5) and EDT (UTC-4). We compute the window
// in ET by formatting via toLocaleString('en-US', { timeZone: 'America/New_York' }).
// The result is a pair of YYYY-MM-DD strings to feed db.getCuttingsForUserInRange.
function previousWeekRangeEastern(now) {
  // Get today's ET calendar date as a Date object (interpreted in local TZ
  // of this script, but mathematically anchored to ET 00:00).
  const fmt = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'America/New_York',
    year: 'numeric', month: '2-digit', day: '2-digit', weekday: 'short',
  });
  const parts = fmt.formatToParts(now);
  const get = (t) => parts.find(p => p.type === t).value;
  const yyyy = parseInt(get('year'), 10);
  const mm   = parseInt(get('month'), 10);
  const dd   = parseInt(get('day'), 10);
  const wday = get('weekday'); // 'Mon', 'Tue', ...
  const WDAY_INDEX = { Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6 };
  const wdayIdx = WDAY_INDEX[wday];

  // Days back to *this* week's Monday (Mon = 0 days back, Sun = 6 days back).
  const daysToThisMon = (wdayIdx + 6) % 7;
  // Previous Monday = this Monday - 7 days.
  const prevMon = new Date(Date.UTC(yyyy, mm - 1, dd));
  prevMon.setUTCDate(prevMon.getUTCDate() - daysToThisMon - 7);
  const prevSun = new Date(prevMon);
  prevSun.setUTCDate(prevSun.getUTCDate() + 6);

  return {
    from: prevMon.toISOString().slice(0, 10),
    to:   prevSun.toISOString().slice(0, 10),
  };
}

// "June 16 – 22, 2026" or "June 30 – July 6, 2026" — used on the PDF cover.
function formatRangeLabel(from, to) {
  const a = new Date(from + 'T00:00:00Z');
  const b = new Date(to   + 'T00:00:00Z');
  const month = (d) => d.toLocaleDateString('en-US', { month: 'long', timeZone: 'UTC' });
  const day   = (d) => d.getUTCDate();
  const year  = b.getUTCFullYear();
  if (a.getUTCMonth() === b.getUTCMonth()) {
    return `${month(a)} ${day(a)} – ${day(b)}, ${year}`;
  }
  return `${month(a)} ${day(a)} – ${month(b)} ${day(b)}, ${year}`;
}

// ISO week number for the milestone key: "2026-W26".
function isoWeekKey(from) {
  // `from` is a Monday (YYYY-MM-DD). ISO week = the week containing the
  // Thursday of this week.
  const d = new Date(from + 'T00:00:00Z');
  d.setUTCDate(d.getUTCDate() + 3); // Mon → Thu
  const yearStart = new Date(Date.UTC(d.getUTCFullYear(), 0, 1));
  const weekNo = Math.ceil((((d - yearStart) / 86400000) + 1) / 7);
  return `${d.getUTCFullYear()}-W${String(weekNo).padStart(2, '0')}`;
}

function studentFilenameSlug(name) {
  return String(name || 'student').toLowerCase()
    .replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '') || 'student';
}

// ─── Render a single student's digest PDF ───────────────────────────────────
async function renderWeeklyDigest({ assets, user, entries, rangeLabel }) {
  const seasonGroups = [{
    label:      'Last week',
    weeksLabel: rangeLabel,
    entries,
  }];
  const html = await ejs.renderFile(
    path.join(__dirname, '..', 'views', 'exports', 'cuttings-pdf.ejs'),
    {
      coverTitle:     `Last week's cuttings: ${user.name}`,
      badgePngBase64: assets.badgePngBase64,
      fontFaceCss:    assets.fontFaceCss,
      cuttingPrompts: CUTTING_PROMPTS,
      dateRangeLabel: rangeLabel,
      seasonGroups,
    }
  );
  return await renderHtmlToPdf(html);
}

// ─── Entry point ────────────────────────────────────────────────────────────
async function main() {
  const now = new Date();
  const { from, to } = previousWeekRangeEastern(now);
  const rangeLabel = formatRangeLabel(from, to);
  const weekKey    = isoWeekKey(from);
  const milestone  = `weekly_cuttings_${weekKey}`;

  console.log(`[digest] previous-week window: ${from} → ${to} (${rangeLabel})`);
  console.log(`[digest] milestone key: ${milestone}`);
  if (DRY_RUN) console.log('[digest] DRY RUN — no emails will be sent and no milestones claimed.');

  const assets   = loadAssets();
  // Active students only — admins don't write cuttings.
  const students = db.getAllStudents();
  let sent = 0, skippedEmpty = 0, skippedAlreadyClaimed = 0;

  for (const user of students) {
    const entries = db.getCuttingsForUserInRange(user.id, from, to);
    if (entries.length === 0) {
      skippedEmpty++;
      continue;
    }
    if (!DRY_RUN && !db.tryClaimMilestone(user.id, milestone)) {
      skippedAlreadyClaimed++;
      continue;
    }
    try {
      const buffer = await renderWeeklyDigest({ assets, user, entries, rangeLabel });
      const filename = `${studentFilenameSlug(user.name)}-cuttings-${from}_to_${to}.pdf`;
      if (DRY_RUN) {
        // Write the PDF to /tmp for manual inspection instead of mailing it.
        const outPath = path.join('/tmp', filename);
        fs.writeFileSync(outPath, buffer);
        console.log(`[digest] ${user.name}: ${entries.length} cuttings → ${outPath} (${buffer.length} bytes)`);
      } else {
        await sendAdminMilestoneEmail({
          studentName: user.name,
          subject:     `[Creative's Garden] ${user.name} — last week's cuttings`,
          bodyLine:    `${user.name} recorded ${entries.length} cutting${entries.length === 1 ? '' : 's'} during the week of ${rangeLabel}. A copy is attached.`,
          pdf:         { filename, buffer },
        });
        console.log(`[digest] ${user.name}: ${entries.length} cuttings → emailed`);
        sent++;
      }
    } catch (err) {
      console.error(`[digest] ${user.name} (id=${user.id}) FAILED:`, err.message);
    }
  }

  console.log(`[digest] done. sent=${sent} skippedEmpty=${skippedEmpty} skippedAlreadyClaimed=${skippedAlreadyClaimed}`);
}

main().then(() => process.exit(0)).catch(err => {
  console.error('[digest] fatal:', err);
  process.exit(1);
});
