// Shared digest logic, callable from both:
//   bin/send-weekly-cuttings-digest.js  — manual CLI / dry-run / local testing
//   server.js  POST /admin/run-weekly-digest  — what the external cron pings
//
// The CLI is still useful for manual + dry-run testing; the route is what
// fires automatically once a week via GitHub Actions hitting the live URL.

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

// Previous Mon-Sun window in Eastern time. Eastern shifts between EST/EDT;
// we use Intl.DateTimeFormat with America/New_York so DST is handled.
function previousWeekRangeEastern(now) {
  const fmt = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'America/New_York',
    year: 'numeric', month: '2-digit', day: '2-digit', weekday: 'short',
  });
  const parts = fmt.formatToParts(now);
  const get = (t) => parts.find(p => p.type === t).value;
  const yyyy = parseInt(get('year'), 10);
  const mm   = parseInt(get('month'), 10);
  const dd   = parseInt(get('day'), 10);
  const wday = get('weekday');
  const WDAY_INDEX = { Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6 };
  const wdayIdx = WDAY_INDEX[wday];

  const daysToThisMon = (wdayIdx + 6) % 7;
  const prevMon = new Date(Date.UTC(yyyy, mm - 1, dd));
  prevMon.setUTCDate(prevMon.getUTCDate() - daysToThisMon - 7);
  const prevSun = new Date(prevMon);
  prevSun.setUTCDate(prevSun.getUTCDate() + 6);

  return {
    from: prevMon.toISOString().slice(0, 10),
    to:   prevSun.toISOString().slice(0, 10),
  };
}

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

function isoWeekKey(from) {
  const d = new Date(from + 'T00:00:00Z');
  d.setUTCDate(d.getUTCDate() + 3); // Mon → Thu of the same ISO week
  const yearStart = new Date(Date.UTC(d.getUTCFullYear(), 0, 1));
  const weekNo = Math.ceil((((d - yearStart) / 86400000) + 1) / 7);
  return `${d.getUTCFullYear()}-W${String(weekNo).padStart(2, '0')}`;
}

function studentFilenameSlug(name) {
  return String(name || 'student').toLowerCase()
    .replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '') || 'student';
}

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

// Main entry point. Callers pass:
//   - dryRun:  if true, write PDFs to /tmp and don't email or claim milestones
//   - log:     function(string) — defaults to console.log; the HTTP caller
//              passes a buffer-capturing logger so the response can include
//              the line-by-line trace.
async function runDigest({ dryRun = false, log = console.log } = {}) {
  const startedAt = Date.now();
  const now = new Date();
  const { from, to } = previousWeekRangeEastern(now);
  const rangeLabel = formatRangeLabel(from, to);
  const weekKey    = isoWeekKey(from);
  const milestone  = `weekly_cuttings_${weekKey}`;

  log(`[digest] previous-week window: ${from} → ${to} (${rangeLabel})`);
  log(`[digest] milestone key: ${milestone}`);
  if (dryRun) log('[digest] DRY RUN — no emails will be sent and no milestones claimed.');

  const assets   = loadAssets();
  const students = db.getAllAccountsForDigest();
  let sent = 0, skippedEmpty = 0, skippedAlreadyClaimed = 0, failed = 0;

  for (const user of students) {
    const entries = db.getCuttingsForUserInRange(user.id, from, to);
    if (entries.length === 0) {
      skippedEmpty++;
      continue;
    }
    if (!dryRun && !db.tryClaimMilestone(user.id, milestone)) {
      skippedAlreadyClaimed++;
      continue;
    }
    try {
      const buffer = await renderWeeklyDigest({ assets, user, entries, rangeLabel });
      const filename = `${studentFilenameSlug(user.name)}-cuttings-${from}_to_${to}.pdf`;
      if (dryRun) {
        const outPath = path.join('/tmp', filename);
        fs.writeFileSync(outPath, buffer);
        log(`[digest] ${user.name}: ${entries.length} cuttings → ${outPath} (${buffer.length} bytes)`);
      } else {
        await sendAdminMilestoneEmail({
          studentName: user.name,
          subject:     `[Creative's Garden] ${user.name} — last week's cuttings`,
          bodyLine:    `${user.name} recorded ${entries.length} cutting${entries.length === 1 ? '' : 's'} during the week of ${rangeLabel}. A copy is attached.`,
          pdf:         { filename, buffer },
        });
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
    window:                 { from, to, rangeLabel },
    milestoneKey:           milestone,
    sent,
    skippedEmpty,
    skippedAlreadyClaimed,
    failed,
    durationMs,
  };
}

module.exports = { runDigest };
