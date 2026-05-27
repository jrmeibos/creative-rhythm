const puppeteer = require('puppeteer');

// ─── Concurrency mutex ───────────────────────────────────────────────────
// Railway Hobby tier is 512MB. A single Puppeteer render spikes ~100-200MB
// (headless Chromium + a page). Two concurrent renders could OOM the
// server. This mutex serializes all PDF renders across the process.
//
// Pattern: a chain of promises. Each caller awaits the prior render's
// completion before launching, then signals its own completion when done.
// Waits longer than MUTEX_TIMEOUT_MS reject so a stuck render can't pile
// up an unbounded queue (caller-side: surface a friendly 503).
const MUTEX_TIMEOUT_MS = 30_000;
let renderQueue = Promise.resolve();

function acquireSlot() {
  const priorRender = renderQueue;
  let release;
  const myRender = new Promise(r => { release = r; });
  renderQueue = myRender;

  const waitForTurn = Promise.race([
    priorRender,
    new Promise((_, reject) => setTimeout(
      () => reject(new Error('PDF render queue timeout')),
      MUTEX_TIMEOUT_MS
    ))
  ]);
  return { waitForTurn, release };
}

// ─── Render: HTML string → PDF Buffer ────────────────────────────────────
// Launch per-request, close in finally — no singleton browser. Holding
// Chromium resident between renders would eat ~100MB continuously for a
// feature used a handful of times per week.
async function renderHtmlToPdf(html, pdfOptions = {}) {
  const slot = acquireSlot();
  await slot.waitForTurn;

  let browser;
  try {
    browser = await puppeteer.launch({
      headless: true,
      args: [
        '--no-sandbox',              // Required in most container envs
        '--disable-setuid-sandbox',
        '--disable-dev-shm-usage'    // /dev/shm is small in containers
      ]
    });

    const page = await browser.newPage();
    await page.setContent(html, { waitUntil: 'networkidle0' });
    // Belt-and-suspenders: ensure web fonts are fully ready before render
    // so the PDF doesn't fall back to system fonts mid-pour.
    await page.evaluateHandle('document.fonts.ready');

    return await page.pdf({
      format: 'Letter',
      printBackground: true,
      preferCSSPageSize: true,
      margin: { top: '0.75in', right: '0.75in', bottom: '0.75in', left: '0.75in' },
      ...pdfOptions
    });
  } finally {
    if (browser) await browser.close().catch(() => {});
    slot.release();
  }
}

module.exports = { renderHtmlToPdf, MUTEX_TIMEOUT_MS };
