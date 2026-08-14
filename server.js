require('dotenv').config();
const express = require('express');
const session = require('express-session');
const SQLiteStore = require('connect-sqlite3')(session);
const bcrypt = require('bcryptjs');
const crypto = require('crypto');
const path = require('path');
const fs = require('fs');
const multer = require('multer');
const db = require('./db');
const { requireAuth, requireAdmin } = require('./auth');
const { sendPasswordResetEmail, sendAdminMilestoneEmail } = require('./email');
const { ANGLES, getAngle, getQuestion } = require('./lib/seed-packet-questions');
const { getCurricularSeason, getCurricularSeasonLabel, getCurricularSeasonDescriptor } = require('./lib/curricular-season');
const { getSeasonPrompt } = require('./lib/season-prompts');
const { getDailyPrompt } = require('./lib/daily-prompts');
const CUTTING_PROMPTS = require('./lib/cutting-prompts');
const { CREATIVE_BLOCK_CATEGORIES, CATEGORY_SLUGS } = require('./lib/creative-blocks');
const { PROPAGATION_RUNGS, PROPAGATION_INTRO, PROPAGATION_FINISH } = require('./lib/propagation-table');
const { renderHtmlToPdf } = require('./lib/pdf-render');
const PUSH = require('./lib/push');
const VIDEO = require('./lib/video');
const STRIPE = require('./lib/stripe');
const ejs = require('ejs');
const ALL_QUESTION_IDS = new Set(ANGLES.flatMap(a => a.questions.map(q => q.id)));

const Anthropic = require('@anthropic-ai/sdk');
const anthropicClient = process.env.ANTHROPIC_API_KEY
  ? new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY })
  : null;

// Accounts that see simulated time when Time Travel is active.
// Admins always see it. Add test email addresses here to extend it.
const TEST_ACCOUNT_ALLOWLIST = [
  'jrmeibos@yahoo.com',
];

const AVATAR_DIR = process.env.NODE_ENV === 'production'
  ? '/data/avatars'
  : path.join(__dirname, 'public', 'uploads', 'avatars');
fs.mkdirSync(AVATAR_DIR, { recursive: true });

const upload = multer({
  storage: multer.diskStorage({
    destination: AVATAR_DIR,
    filename: (req, file, cb) => {
      const ext = path.extname(file.originalname).toLowerCase() || '.jpg';
      cb(null, `avatar-${req.session.user.id}-${Date.now()}${ext}`);
    }
  }),
  limits: { fileSize: 5 * 1024 * 1024 },
  fileFilter: (_, file, cb) => {
    if (['image/jpeg','image/png','image/gif','image/webp'].includes(file.mimetype)) cb(null, true);
    else cb(new Error('Only JPG, PNG, GIF, and WebP files are allowed.'));
  }
});

// Propagation Table uploads — students complete a rung by uploading the thing
// they made (image or video). Lives on the Railway volume in production; served
// only through the auth + ownership route below (never express.static in prod).
const PROPAGATION_DIR = process.env.NODE_ENV === 'production'
  ? '/data/propagation'
  : path.join(__dirname, 'public', 'uploads', 'propagation');
fs.mkdirSync(PROPAGATION_DIR, { recursive: true });

const PROPAGATION_UPLOAD_TYPES = [
  'image/jpeg', 'image/png', 'image/gif', 'image/webp',
  'video/mp4', 'video/quicktime', 'video/webm',
];
const propagationUpload = multer({
  storage: multer.diskStorage({
    destination: PROPAGATION_DIR,
    filename: (req, file, cb) => {
      const ext = (path.extname(file.originalname).toLowerCase() || '').slice(0, 10);
      const token = require('crypto').randomBytes(6).toString('hex');
      cb(null, `prop-${req.session.user.id}-${Date.now()}-${token}${ext}`);
    }
  }),
  limits: { fileSize: 50 * 1024 * 1024 },
  fileFilter: (_, file, cb) => {
    if (PROPAGATION_UPLOAD_TYPES.includes(file.mimetype)) cb(null, true);
    else cb(new Error('Please upload an image or a video (JPG, PNG, GIF, WebP, MP4, MOV, or WebM).'));
  }
});

const TIMEZONES = [
  { value: 'America/New_York',    label: 'Eastern Time (ET)' },
  { value: 'America/Chicago',     label: 'Central Time (CT)' },
  { value: 'America/Denver',      label: 'Mountain Time (MT)' },
  { value: 'America/Los_Angeles', label: 'Pacific Time (PT)' },
  { value: 'America/Anchorage',   label: 'Alaska Time (AKT)' },
  { value: 'America/Honolulu',    label: 'Hawaii Time (HST)' },
  { value: 'Europe/London',       label: 'London (GMT/BST)' },
  { value: 'Europe/Paris',        label: 'Paris (CET/CEST)' },
  { value: 'Australia/Sydney',    label: 'Sydney (AEST/AEDT)' },
  { value: 'Asia/Tokyo',          label: 'Tokyo (JST)' },
];

const app = express();

app.set('view engine', 'ejs');
app.set('views', path.join(__dirname, 'views'));

// Static, request-independent template data — exposed to every res.render call
// as `cuttingPrompts` so the form view, the archive view, and any future
// surface can read the field definitions without per-route plumbing.
app.locals.cuttingPrompts = CUTTING_PROMPTS;

app.use(express.static(path.join(__dirname, 'public')));
app.use(express.urlencoded({ extended: true }));
// Capture the raw request body while still parsing JSON. Stripe webhook
// signature verification needs the exact bytes Stripe signed, not the
// re-serialized version. Only 1 KB or so per request — negligible overhead.
app.use(express.json({
  verify: (req, res, buf) => { req.rawBody = buf; },
}));

app.set('trust proxy', 1);

// Sessions live in a SEPARATE file from the main DB so two different SQLite
// libraries (node:sqlite and connect-sqlite3's native sqlite3) never compete
// for the same file.
const SESSION_DIR = process.env.DB_PATH
  ? path.dirname(process.env.DB_PATH)
  : path.join(__dirname, 'data');
// Refuse to boot in production without a real session secret. The dev
// fallback below is public knowledge (it's in the repo) — silently using
// it in production would let anyone forge an admin session cookie.
if (process.env.NODE_ENV === 'production' && !process.env.SESSION_SECRET) {
  throw new Error('SESSION_SECRET must be set in production — refusing to start.');
}
app.use(session({
  store: new SQLiteStore({ db: 'sessions.db', dir: SESSION_DIR, table: 'sessions' }),
  secret: process.env.SESSION_SECRET || 'dev-secret-please-change-in-production',
  resave: false,
  saveUninitialized: false,
  cookie: {
    secure: process.env.NODE_ENV === 'production',
    httpOnly: true,
    maxAge: 7 * 24 * 60 * 60 * 1000
  }
}));

// Discord channel for the pilot cohort — set as COMMUNITY_DISCORD_URL
// on Railway. Read once at boot and cached; null if unset (dev without
// the env var). Used by the Grove page callout + the /grove/make/:id
// /cohort-share form to link students directly to the channel.
const COMMUNITY_DISCORD_URL = (process.env.COMMUNITY_DISCORD_URL || '').trim() || null;

app.use((req, res, next) => {
  res.locals.user = req.session.user || null;
  res.locals.communityDiscordUrl = COMMUNITY_DISCORD_URL;
  // Make simulatedToday available in every template for the sidebar banner.
  // Only set for admins and TEST_ACCOUNT_ALLOWLIST users; everyone else gets null.
  if (isTimeTravelUser(req.session.user)) {
    const simulated = db.getSetting('simulated_today');
    res.locals.simulatedToday = (simulated && simulated.trim()) ? simulated : null;
  } else {
    res.locals.simulatedToday = null;
  }

  next();
});

// ── Effective season ───────────────────────────────────────────────────
// Runs AFTER session-freshen (so u.current_season reflects any /api/season
// write from this or a prior request). The student's internal season drives
// feature gates (Tending prompts, future Summer/Autumn features). Trial
// students pre-Week-4 are locked to Winter regardless of any stray DB
// value. Curriculum-progress UI (calendar tiles, "Week X of 12", growth
// visual) still uses the curricular season — that's about the course's
// structure, not the student's pace.
//
// Eligibility to pick a season:
//   - Paid students (course_length_weeks >= 12) — always eligible.
//   - Trial students — eligible once their course week reaches 4.
//
// Auto-advance: when a newly eligible student has current_season = null,
// we write 'spring' server-side on first render. This keeps downstream
// code simple (effectiveSeason === current_season, no fallbacks) and
// makes community/sidebar avatar colors correct.
//
// NOTE: mounted here — after the session-freshen middleware defined below
// — so we read the fresh current_season, not the stale session value.

// Session-freshen middleware — re-syncs course_length_weeks + enrollment_tier
// from the DB on every authenticated request. Without this, a student's
// session still carries the pre-upgrade course_length_weeks=3 after the
// Stripe webhook flips them to 12, and their dashboard keeps saying
// "Week 1 of 3" until they log out and back in. Cheap read at pilot scale.
app.use((req, res, next) => {
  const s = req.session.user;
  if (s && s.id) {
    const fresh = db.getUserById(s.id);
    if (fresh) {
      s.course_length_weeks = fresh.course_length_weeks || 12;
      s.enrollment_tier     = fresh.enrollment_tier || null;
      s.current_season      = fresh.current_season || null;
      s.profile_photo       = fresh.profile_photo || null;
      s.course_start_date   = fresh.course_start_date || null;
    }
  }
  next();
});

// Effective-season middleware (see docblock above the session-freshen block).
app.use((req, res, next) => {
  res.locals.canPickSeason       = false;
  res.locals.effectiveSeason     = null;
  res.locals.showTending         = false;
  res.locals.showSeasonIntroCard = false;

  const u = req.session.user;
  if (u && u.id) {
    let weekNumber = null;
    try { weekNumber = getCurrentCourseWeek(u).weekNumber; } catch (_) {}
    const courseLen  = u.course_length_weeks || 12;
    const isPaid     = courseLen >= 12;
    // Spring unlocks for PAID students at week 4 (Winter = weeks 1-3).
    // Trial students stay Winter no matter how many weeks pass — the old
    // `isPaid || week >= 4` shape quietly unlocked every Spring+ feature
    // for expired trials at week 4, gutting the upgrade funnel. Admins
    // stay always-eligible so they can preview any season state.
    const pastWinter = typeof weekNumber === 'number' && weekNumber >= 4;
    const isEligible = u.role === 'admin' ? isPaid : (isPaid && pastWinter);

    res.locals.canPickSeason = isEligible;

    // ── Video upload gate — OFF ────────────────────────────────────────────
    // Experiment paused (July 2026). Uploading a 6-minute phone video took long
    // enough that it wasn't worth pursuing yet — real friction for a habit
    // that's meant to be daily. Admin now sees exactly what students see.
    //
    // The plumbing is intentionally left intact and dormant: lib/video.js, the
    // upload + playback routes, and cuttings.video_uid. Nothing runs while this
    // is false. To resume:
    //   admin-only trial → u.role === 'admin' && VIDEO.isVideoConfigured()
    //   paid students    → isPaid && VIDEO.isVideoConfigured()
    // If it ever reaches students, update the Privacy Policy first — it
    // currently promises we never store their videos.
    res.locals.canUploadVideo = false;

    if (isEligible) {
      // Auto-advance to Spring on first eligible render (students only —
      // admins get eligibility for testing/preview but no auto-write).
      if (!u.current_season && u.role === 'student') {
        db.updateUserSeason(u.id, 'spring');
        u.current_season = 'spring';
      }
      res.locals.effectiveSeason = u.current_season || 'spring';
      if (u.role === 'student' && !db.hasSeenSeasonIntro(u.id)) {
        res.locals.showSeasonIntroCard = true;
      }
    } else {
      res.locals.effectiveSeason = 'winter';
    }

    // Tending unlocks once the student is past Winter. Any Spring+ season
    // — including Autumn/Summer if they moved themselves there — keeps
    // Tending accessible.
    res.locals.showTending =
      ['spring', 'summer', 'autumn'].includes(res.locals.effectiveSeason);

    // Summer unlocks the Make-something practice — a student turns
    // Cultivate cuttings into content. Stays available in Autumn since
    // Autumn is Summer + a sharing layer on top (Fall's "post the link
    // to what you shared" flow reads from Cultivated Ideas / The Grove).
    res.locals.showSummer =
      ['summer', 'autumn'].includes(res.locals.effectiveSeason);

    // Autumn unlocks the sharing practice — students post the URLs of
    // what they've made out into the world. Strictly Autumn only for
    // the Greenhouse entry point; the /grove page itself is always
    // reachable via its URL so students can revisit later.
    res.locals.showAutumn = res.locals.effectiveSeason === 'autumn';
  }

  next();
});

// Onboarding guard — students who haven't completed onboarding can only access onboarding routes
app.use((req, res, next) => {
  const u = req.session.user;
  if (u && u.role === 'student' && !u.onboarding_completed) {
    const ok = req.path === '/' || req.path === '/logout'
      || req.path.startsWith('/onboarding')
      || req.path.startsWith('/api/onboarding')
      || req.path === '/privacy' || req.path === '/terms' || req.path === '/accessibility';
    if (!ok) return res.redirect('/onboarding');
  }
  next();
});

// Auto-unlock middleware was removed when start dates became per-user. The
// midcourse/harvest gating now reads each user's own course_start_date
// (see db.getUserCourseStartDate + isMidcourseUnlockedFor + getUnlockState).
// The global midcourse_unlocked / harvest_unlocked settings still exist as
// admin manual overrides ("force-unlock for everyone now").

// ─── Avatar files ─────────────────────────────────────────────────────────
// In production, avatars live in /data/avatars (Railway volume), not public/.
// This route serves them with correct content-type headers.

app.get('/avatars/:filename', requireAuth, (req, res) => {
  const filename = req.params.filename;
  if (filename.includes('..') || filename.includes('/') || filename.includes('\\')) {
    return res.status(400).send('Bad request');
  }
  const filepath = path.join(AVATAR_DIR, filename);
  if (!filepath.startsWith(path.resolve(AVATAR_DIR))) {
    return res.status(400).send('Bad request');
  }
  fs.access(filepath, fs.constants.R_OK, err => {
    if (err) return res.status(404).send('Not found');
    const ext = path.extname(filename).toLowerCase();
    const contentType = {
      '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg',
      '.png': 'image/png',  '.gif': 'image/gif',
      '.webp': 'image/webp'
    }[ext] || 'application/octet-stream';
    res.setHeader('Content-Type', contentType);
    res.setHeader('Cache-Control', 'public, max-age=300');
    fs.createReadStream(filepath).pipe(res);
  });
});

// ─── Auth ──────────────────────────────────────────────────────────────────

// Rate limiting for the three public credential endpoints. In-memory
// sliding window per IP — enough to stop password-guessing bots and
// reset-email spam. Resets on redeploy (fine: an attacker just gets a
// fresh window, a normal user never notices) and is single-instance by
// design, matching the one-box Railway deploy. `trust proxy` is set above,
// so req.ip is the real client IP behind Railway's proxy, not the proxy.
const RATE_BUCKETS = new Map(); // key → [timestamps]
function rateLimit(name, maxAttempts, windowMs, message) {
  return (req, res, next) => {
    const key = `${name}:${req.ip}`;
    const now = Date.now();
    const hits = (RATE_BUCKETS.get(key) || []).filter(t => now - t < windowMs);
    if (hits.length >= maxAttempts) {
      RATE_BUCKETS.set(key, hits);
      // HTML form posts get a friendly re-render; anything else gets 429 JSON.
      if (req.accepts('html')) {
        if (name === 'signup') {
          return res.status(429).render('signup', { error: message, name: '', email: '', returnTo: null });
        }
        if (name === 'forgot') {
          return res.status(429).render('forgot-password', { sent: false, error: message });
        }
        return res.status(429).render('login', { error: message, returnTo: null });
      }
      return res.status(429).json({ error: message });
    }
    hits.push(now);
    RATE_BUCKETS.set(key, hits);
    next();
  };
}
// Sweep stale buckets hourly so the Map can't grow unbounded.
setInterval(() => {
  const now = Date.now();
  for (const [key, hits] of RATE_BUCKETS) {
    if (!hits.length || now - hits[hits.length - 1] > 60 * 60 * 1000) RATE_BUCKETS.delete(key);
  }
}, 60 * 60 * 1000).unref();

const loginLimiter = rateLimit('login', 10, 15 * 60 * 1000,
  'Too many sign-in attempts. Take a breath and try again in about 15 minutes.');
const signupLimiter = rateLimit('signup', 5, 60 * 60 * 1000,
  'Too many sign-up attempts from this connection. Try again in an hour.');
const forgotLimiter = rateLimit('forgot', 5, 60 * 60 * 1000,
  'Too many reset requests. Try again in an hour, or reach out to Julia directly.');

app.get('/', (req, res) => {
  const returnTo = sanitizeReturnTo(req.query.returnTo);
  // Already signed in: honor a pending returnTo (e.g. the anon /upgrade
  // nav's "Sign in" link) instead of always bouncing to the dashboard.
  if (req.session.user) return res.redirect(returnTo || '/dashboard');
  res.render('login', { error: null, returnTo });
});

app.post('/login', loginLimiter, async (req, res) => {
  const { email, password } = req.body;
  const returnTo = sanitizeReturnTo(req.body.returnTo);
  const rerender = (error) => res.render('login', { error, returnTo });
  if (!email || !password) {
    return rerender('Please enter your email and password.');
  }
  const user = db.getUserByEmail(email.trim().toLowerCase());
  if (!user) {
    return rerender('Invalid email or password.');
  }
  const valid = await bcrypt.compare(password, user.password_hash);
  if (!valid) {
    return rerender('Invalid email or password.');
  }
  req.session.user = {
    id: user.id, name: user.name, email: user.email, role: user.role,
    avatar_initial: user.avatar_initial, current_season: user.current_season || null,
    onboarding_completed: !!user.onboarding_completed,
    profile_photo: user.profile_photo || null,
    timezone: user.timezone || null,
    course_start_date: user.course_start_date || null,
    course_length_weeks: user.course_length_weeks || 12,
    enrollment_tier: user.enrollment_tier || null,
  };
  // Admins never see returnTo, and a non-onboarded student must finish
  // onboarding first (returnTo will fire on the onboarding-complete side).
  if (user.role !== 'admin' && !user.onboarding_completed) {
    if (returnTo) req.session.postOnboardingReturnTo = returnTo;
    return res.redirect('/onboarding');
  }
  res.redirect(returnTo || '/dashboard');
});

// ─── Self-serve signup ─────────────────────────────────────────────────────
// Public route. New signups land as trial (course_length_weeks = 3) with
// today as their start date — this is the free Winter (weeks 1–3) tier.
// To upgrade past week 3 they hit /upgrade (Phase C, Stripe Elements).
//
// Existing pilot students keep their default course_length_weeks = 12 so
// they aren't affected by this change. Only NEW signups are trial-by-default.

// Same password rule the existing account-settings form uses, kept in sync
// so students who signed up under one path can change under the other.
function isPasswordValid(pw) {
  if (typeof pw !== 'string' || pw.length < 8) return false;
  return /[0-9!@#$%^&*()\-_=+\[\]{};:'",.<>/?\\|`~]/.test(pw);
}

// Only accept internal, same-site absolute paths as post-signup destinations.
// Anything else (protocol-relative, external, or containing whitespace) falls
// back to null so an attacker can't turn /signup into an open redirect.
function sanitizeReturnTo(raw) {
  if (typeof raw !== 'string') return null;
  const s = raw.trim();
  if (!s || !s.startsWith('/') || s.startsWith('//') || /\s/.test(s)) return null;
  if (s.length > 200) return null;
  return s;
}

app.get('/signup', (req, res) => {
  const returnTo = sanitizeReturnTo(req.query.returnTo);
  if (req.session.user) return res.redirect(returnTo || '/dashboard');
  res.render('signup', { error: null, firstName: '', lastName: '', email: '', returnTo });
});

// Legal pages — public, no auth (must be viewable by anyone, incl. logged out).
app.get('/privacy', (req, res) => res.render('privacy', { title: 'Privacy Policy' }));
app.get('/terms', (req, res) => res.render('terms', { title: 'Terms of Service' }));
app.get('/accessibility', (req, res) => res.render('accessibility', { title: 'Accessibility Statement' }));

// ─── Video (Cloudflare Stream) ─────────────────────────────────────────────
// Mint a one-time direct-upload URL. The browser uploads the file straight to
// Cloudflare with this — the bytes never pass through us, which is the only way
// a 500MB phone video uploads reliably.
app.post('/api/video/upload-url', requireAuth, async (req, res) => {
  if (!res.locals.canUploadVideo) return res.status(403).json({ error: 'not_enabled' });
  try {
    const { uploadURL, uid } = await VIDEO.createDirectUpload({
      userId: req.session.user.id,
      name: `${req.session.user.name} — ${(req.body && req.body.recorded_date) || 'recording'}`,
    });
    res.json({ ok: true, uploadURL, uid });
  } catch (e) {
    console.error('[video] direct upload failed:', e.message);
    res.status(502).json({ error: 'upload_url_failed', detail: e.message });
  }
});

// Signed playback for a private video. Videos are uploaded with
// requireSignedURLs, so they can't be watched without a short-lived token —
// and we only mint one for the user who owns the recording.
app.get('/api/video/:uid/playback', requireAuth, async (req, res) => {
  const uid = req.params.uid;
  if (!db.userOwnsVideo(req.session.user.id, uid)) {
    return res.status(403).json({ error: 'not_yours' });
  }
  try {
    const video = await VIDEO.getVideo(uid);
    if (!video.readyToStream) {
      return res.json({ ok: true, ready: false, state: video.status && video.status.state });
    }
    const token = await VIDEO.getPlaybackToken(uid);
    const host  = VIDEO.customerHostFromVideo(video) || 'iframe.videodelivery.net';
    res.json({
      ok: true,
      ready: true,
      iframeUrl: `https://${host}/${token}/iframe`,
      duration: video.duration,
    });
  } catch (e) {
    console.error('[video] playback failed for', uid, '—', e.message);
    res.status(502).json({ error: 'playback_failed', detail: e.message });
  }
});

app.post('/signup', signupLimiter, async (req, res) => {
  const firstName = (req.body.firstName || '').trim();
  const lastName  = (req.body.lastName  || '').trim();
  const name      = `${firstName} ${lastName}`.trim();
  const email     = (req.body.email || '').trim().toLowerCase();
  const password  = req.body.password || '';
  const returnTo  = sanitizeReturnTo(req.body.returnTo);

  // Validate the client-supplied IANA timezone BEFORE any DB write. An
  // invalid value used to throw mid-flow (after createUser) and strand a
  // half-configured account with no course_start_date — which falls back
  // to the pilot's global start date and looks instantly expired.
  let timezone = (req.body.timezone || 'America/Denver').trim();
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: timezone });
  } catch (_) {
    timezone = 'America/Denver';
  }

  const rerender = (error) => res.render('signup', { error, firstName, lastName, email, returnTo });

  if (!firstName || !lastName || !email || !password) return rerender('Please fill in all fields.');
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) return rerender('Please enter a valid email address.');
  if (!isPasswordValid(password)) return rerender('Password must be at least 8 characters and include a number or symbol.');
  if (db.getUserByEmail(email)) return rerender('An account with that email already exists. Try signing in.');

  try {
    const result = db.createUser(name, email, password, 'student');
    const userId = result.lastInsertRowid;

    // Every new self-serve signup starts on the free Winter (3-week) tier.
    // Course starts today so week 1 is today; timezone is the validated
    // form value (or the Denver fallback).
    db.setUserCourseLengthWeeks(userId, 3);
    const todayLocal = new Intl.DateTimeFormat('en-CA', {
      timeZone: timezone, year: 'numeric', month: '2-digit', day: '2-digit'
    }).format(new Date());
    db.setUserCourseStartDate(userId, todayLocal);
    if (timezone !== 'America/Denver') {
      db.setUserTimezone(userId, timezone);
    }

    const user = db.getUserById(userId);
    req.session.user = {
      id: user.id, name: user.name, email: user.email, role: user.role,
      avatar_initial: user.avatar_initial, current_season: null,
      onboarding_completed: false,
      profile_photo: null,
      // Session carries the validated form timezone directly — getUserById
      // doesn't SELECT timezone, and waiting for the sidebar beacon meant
      // the first dashboard render used Denver for everyone.
      timezone,
      course_start_date: user.course_start_date || null,
      course_length_weeks: user.course_length_weeks || 3,
    };
    // Sync to Mailchimp — fire-and-forget so it never blocks or breaks signup.
    // Every registrant gets the "New Registration" tag (triggers the onboarding
    // Journey); the newsletter tag is added only if they ticked the box.
    const mcTags = [MAILCHIMP_TAG_REGISTERED];
    if (req.body.newsletter) mcTags.push(MAILCHIMP_TAG_NEWSLETTER);
    addContactToMailchimp(email, firstName, lastName, mcTags).catch(() => {});

    // Stash post-onboarding destination (e.g. /upgrade?tier=X when they came
    // from the pricing page). Consumed by /api/onboarding/complete.
    if (returnTo) req.session.postOnboardingReturnTo = returnTo;
    req.session.save(() => res.redirect('/onboarding'));
  } catch (err) {
    console.error('[signup] failed:', err);
    return rerender('Sign-up failed. Try again in a moment, or reach out to Julia directly.');
  }
});

app.get('/logout', (req, res) => {
  req.session.destroy(() => res.redirect('/'));
});

// ─── Forgot password ───────────────────────────────────────────────────────

app.get('/forgot-password', (req, res) => {
  if (req.session.user) return res.redirect('/dashboard');
  res.render('forgot-password', { sent: false, error: null });
});

app.post('/forgot-password', forgotLimiter, async (req, res) => {
  const email = (req.body.email || '').trim().toLowerCase();
  const renderSent = () => res.render('forgot-password', { sent: true, error: null });

  if (!email) return res.render('forgot-password', { sent: false, error: 'Please enter your email address.' });

  const user = db.getUserByEmail(email);
  if (!user) return renderSent(); // don't reveal whether address is registered

  const token = crypto.randomBytes(24).toString('hex');
  const expiresAt = new Date(Date.now() + 60 * 60 * 1000)
    .toISOString().replace('T', ' ').split('.')[0];

  db.createPasswordResetToken(user.id, token, expiresAt);
  db.deleteExpiredPasswordResetTokens();

  const baseUrl = process.env.BASE_URL || `${req.protocol}://${req.get('host')}`;
  const resetLink = `${baseUrl}/reset-password?token=${token}`;

  sendPasswordResetEmail(user.email, resetLink, user.name).catch(err => {
    console.error('[email] Unhandled error sending reset email:', err);
  });

  renderSent();
});

// ─── Reset password ────────────────────────────────────────────────────────

app.get('/reset-password', (req, res) => {
  if (req.session.user) return res.redirect('/dashboard');
  const token = (req.query.token || '').trim();
  if (!token) return res.redirect('/forgot-password');

  const row = db.findValidPasswordResetToken(token);
  if (!row) {
    return res.render('reset-password', { valid: false, token: null, error: null, success: false });
  }
  res.render('reset-password', { valid: true, token, error: null, success: false });
});

app.post('/reset-password', async (req, res) => {
  if (req.session.user) return res.redirect('/dashboard');
  const { token, new_password, confirm_password } = req.body;

  const invalid = () => res.render('reset-password', { valid: false, token: null, error: null, success: false });
  const withError = (msg) => res.render('reset-password', { valid: true, token, error: msg, success: false });

  if (!token) return invalid();

  const row = db.findValidPasswordResetToken(token);
  if (!row) return invalid();

  if (!new_password || !confirm_password) return withError('All fields are required.');
  if (new_password !== confirm_password) return withError('Passwords do not match.');
  if (!isPasswordValid(new_password)) return withError('Password must be at least 8 characters and include a number or symbol.');

  db.updateUserPassword(row.user_id, new_password);
  db.markPasswordResetTokenUsed(row.id);

  res.render('reset-password', { valid: true, token: null, error: null, success: true });
});

// ─── Dashboard ─────────────────────────────────────────────────────────────

// Shared helper used by both /dashboard (full page) and /dashboard/day
// (HTML fragment for fetch-and-swap). Resolves the viewed day from a raw
// ?day= value, clamps to [course_start_date, today_in_user_tz], and
// returns the full dayview payload plus today's date string. The caller
// passes `courseStart` so this helper doesn't re-query db.getSetting.
function buildDayviewPayload(user, rawDay, courseStart) {
  const today = toLocalDateString(getNow(user));
  let viewed = today;
  const raw = typeof rawDay === 'string' ? rawDay.trim() : '';
  if (raw && /^\d{4}-\d{2}-\d{2}$/.test(raw)) {
    if (courseStart && raw < courseStart) viewed = courseStart;
    else if (raw > today)                 viewed = today;
    else                                  viewed = raw;
  }

  const dayInfo            = getCourseDayForDate(user, viewed, courseStart);
  const viewedSeason       = dayInfo.season;
  const viewedSeasonLabel  = getCurricularSeasonLabel(viewedSeason);
  const viewedSeasonPrompt = getSeasonPrompt(viewedSeason);
  const dayCuttings        = db.getCuttingsForUserOnDate(user.id, viewed);
  const isToday            = viewed === today;

  // Prev/next dates: walk one day in each direction and disable at the bounds.
  // Local midnight Date so the math doesn't drift across DST or TZ.
  const viewedDate = new Date(viewed + 'T00:00:00');
  const prevD = new Date(viewedDate); prevD.setDate(prevD.getDate() - 1);
  const nextD = new Date(viewedDate); nextD.setDate(nextD.getDate() + 1);
  const prevStr = toLocalDateString(prevD);
  const nextStr = toLocalDateString(nextD);
  const prevDate = (!courseStart || prevStr >= courseStart) ? prevStr : null;
  const nextDate = (nextStr <= today) ? nextStr : null;

  // "Tuesday, June 10" — wall-clock format the student reads.
  const dateLabel = viewedDate.toLocaleDateString('en-US', {
    weekday: 'long', month: 'long', day: 'numeric'
  });

  const dayview = {
    dayNumber:   dayInfo.dayNumber,
    dateStr:     viewed,
    dateLabel,
    isToday,
    season:      viewedSeason,
    seasonLabel: viewedSeasonLabel,
    aboutText:   viewedSeasonPrompt ? viewedSeasonPrompt.aboutText : null,
    topic:       getDailyPrompt(viewedSeason, dayInfo.dayInSeason),
    cuttings:    dayCuttings,
    prevDate,
    nextDate
  };

  return { dayview, today };
}

app.get('/dashboard', requireAuth, (req, res) => {
  const userId = req.session.user.id;

  // Single per-user start-date read per request — passed down into
  // getCurrentCourseWeek + buildDayviewPayload + getCourseDayForDate so they
  // don't each re-resolve. Was 3 reads per /dashboard before.
  const courseStart = db.getUserCourseStartDate(req.session.user);

  const courseWeek = getCurrentCourseWeek(req.session.user, courseStart);
  const weekStart = courseWeek.weekStart;
  const weekNumber = courseWeek.weekNumber;
  const goals = db.getGoalsForWeek(userId, weekStart);
  const goalsMap = {};
  for (const g of goals) goalsMap[g.category] = g;

  const currentLesson = db.getFirstUncompletedLesson(userId);
  const allLessons = db.getAllLessons();
  const completedIds = new Set(db.completedLessonIds(userId));
  const completedCount = completedIds.size;

  const goalsDataDash = {};
  for (const cat of ['curiosity','create','share','connect']) {
    goalsDataDash[cat] = parseGoalText(goalsMap[cat]?.goal_text);
  }

  const curricularSeason = getCurricularSeason(weekNumber);
  const curricularSeasonLabel = getCurricularSeasonLabel(curricularSeason);

  const { dayview, today } = buildDayviewPayload(req.session.user, req.query.day, courseStart);

  // Banners the student has snoozed ("remind me later") or removed for good.
  const hiddenBanners = db.getHiddenBannerKeys(req.session.user.id, today);

  // Mid-course check-in card: visible only when the global setting is
  // unlocked AND this specific student hasn't submitted yet. Admins never
  // see the card (they can't submit, and POST is 403-gated server-side).
  const midcourseCardVisible = (
    req.session.user.role !== 'admin' &&
    isMidcourseUnlockedFor(req.session.user) &&
    !db.hasMidcourseBeenSubmittedByUser(req.session.user.id) &&
    !hiddenBanners.has('midcourse')
  );

  // Trial-aware fields: total weeks for the "Week N of X" label, plus
  // flags driving the three trial-only dashboard states:
  //   • trialClosingCardVisible — week 3 reached, closing not yet submitted
  //   • trialComplete           — past week 3 (or closing already submitted),
  //                                show the "Want to keep going?" CTA
  const courseLengthWeeks = getCourseLengthWeeks(req.session.user);
  const isTrial           = courseLengthWeeks < 12;
  const trialClosingSubmitted = isTrial &&
    db.hasTrialClosingBeenSubmittedByUser(req.session.user.id);
  const trialClosingCardVisible = isTrial &&
    !trialClosingSubmitted &&
    isTrialClosingUnlockedFor(req.session.user) &&
    !hiddenBanners.has('trial_closing');

  // Season cards — one per season, each dismissible. effectiveSeason is the
  // student's current season (null until they're eligible to pick → no card).
  const effSeason = res.locals.effectiveSeason;
  const springCardVisible = effSeason === 'spring' && !hiddenBanners.has('season_spring');
  const summerCardVisible = effSeason === 'summer' && !hiddenBanners.has('season_summer');
  const fallCardVisible   = effSeason === 'autumn' && !hiddenBanners.has('season_autumn');
  const trialComplete = isTrial && (
    trialClosingSubmitted ||
    (typeof weekNumber === 'number' && weekNumber > courseLengthWeeks)
  );

  // Post-checkout confirmation banner. Set when /upgrade redirects here
  // after payment_intent.succeeded. Even if the webhook hasn't landed yet,
  // showing this banner is safe — worst case the user reloads once and it's
  // gone. The banner reads tier from ?tier=... query, and can include a
  // Discord invite pulled from env for immediate community access.
  let upgradeBanner = null;
  if (req.query.upgraded === '1') {
    const tierId  = String(req.query.tier || '');
    const tier    = STRIPE.findTier(tierId);
    upgradeBanner = {
      tierName:    tier ? tier.name : 'the full course',
      discordUrl:  process.env.COMMUNITY_DISCORD_URL || '',
    };
  }

  res.render('dashboard', {
    title: 'Dashboard',
    page: 'dashboard',
    greeting: getGreeting(req.session.user),
    upgradeBanner,
    weekStart,
    weekNumber,
    weekLabel: formatWeekLabel(weekStart),
    curricularSeason,
    curricularSeasonLabel,
    goals: goalsMap,
    goalsData: goalsDataDash,
    shareThisWeek: db.getWeekShareEffective(userId, weekStart),
    currentLesson,
    allLessons,
    completedCount,
    totalLessons: allLessons.length,
    dayview,
    today,
    quote: getRotatingQuote(req.session.user),
    midcourseCardVisible,
    courseLengthWeeks,
    isTrial,
    trialComplete,
    trialClosingCardVisible,
    springCardVisible,
    summerCardVisible,
    fallCardVisible,
  });
});

// ─── Day-view fragment endpoint ────────────────────────────────────────────
// Returns just the day-view partial — no sidebar, no layout — for the
// dashboard's fetch-and-swap day stepper. Same clamping rules as /dashboard
// so a malformed ?day= or a future date can't escape. The dashboard's
// inline controller calls this on prev/next clicks and on popstate.
app.get('/dashboard/day', requireAuth, (req, res) => {
  const courseStart = db.getUserCourseStartDate(req.session.user);
  const { dayview } = buildDayviewPayload(req.session.user, req.query.day, courseStart);
  res.render('partials/day-view', { dayview });
});

// ─── Daily recording practice: save an optional reflection ("cutting") ─────
// Accepts the four CUTTING_PROMPTS fields as optional strings + an optional
// recorded_date (YYYY-MM-DD) for backdating. All-empty fields → no row.
// When recorded_date is omitted, the cutting is stamped for today (the user's
// timezone-aware today). When recorded_date is supplied and valid, the cutting
// is stamped for that day.
app.post('/dashboard/cutting', requireAuth, (req, res) => {
  const body = req.body || {};
  const fields = {};
  let anyFilled = false;
  for (const { key } of CUTTING_PROMPTS) {
    const raw = typeof body[key] === 'string' ? body[key].trim() : '';
    fields[key] = raw || null;
    if (raw) anyFilled = true;
  }
  // An attached video counts as content on its own — someone who uploads the
  // recording but doesn't feel like writing notes has still logged the day.
  // Only trust the uid if this user is actually allowed to upload.
  const rawVideoUid = typeof body.video_uid === 'string' ? body.video_uid.trim() : '';
  const videoUid = (res.locals.canUploadVideo && /^[a-zA-Z0-9]{20,}$/.test(rawVideoUid))
    ? rawVideoUid : null;
  if (videoUid) anyFilled = true;

  if (!anyFilled) {
    return res.json({ saved: false });
  }

  const today = toLocalDateString(getNow(req.session.user));
  const courseStart = db.getUserCourseStartDate(req.session.user);

  // Resolve recorded_date + season. If client sent a recorded_date, validate
  // it's a real date string between course_start and today. Otherwise default
  // to today + current season.
  let recordedDate, season, isBackdated;
  const rawRecorded = typeof body.recorded_date === 'string' ? body.recorded_date.trim() : '';
  if (rawRecorded) {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(rawRecorded)) {
      return res.status(400).json({ error: 'Invalid recorded_date format.' });
    }
    if (courseStart && rawRecorded < courseStart) {
      return res.status(400).json({ error: 'recorded_date is before course start.' });
    }
    if (rawRecorded > today) {
      return res.status(400).json({ error: 'recorded_date is in the future.' });
    }
    recordedDate = rawRecorded;
    // Past the 12-week curriculum, getCurricularSeason() (via
    // seasonForRecordedDate) returns null. Fall back to the student's chosen
    // season so evergreen recordings still carry one. Weeks 1-12 keep the
    // curricular season exactly as before.
    season = seasonForRecordedDate(rawRecorded, courseStart)
      || res.locals.effectiveSeason || req.session.user.current_season || null;
    isBackdated = rawRecorded !== today;
  } else {
    recordedDate = today;
    season = getCurricularSeason(getCurrentCourseWeek(req.session.user).weekNumber)
      || res.locals.effectiveSeason || req.session.user.current_season || null;
    isBackdated = false;
  }

  // `prompt` column is vestigial — kept set to the first/noticed prompt for
  // continuity with legacy rows and any future direct queries.
  db.createCutting(req.session.user.id, season, CUTTING_PROMPTS[0].label, fields, recordedDate, videoUid);

  res.json({ saved: true, recorded_date: recordedDate, backdated: isBackdated });
});

// ─── Capture user's browser timezone ───────────────────────────────────────
// Fired on every authenticated page load from the sidebar partial. Stores the
// IANA TZ string so getNow() can compute the user's wall-clock "today" — fixes
// the daily recording card not resetting at the user's local midnight. Follow-
// the-body: if a student travels, their next page load updates their stored TZ.
// Session must be saved before responding (resave: false + cached
// req.session.user means a mutation alone won't flush to the session store).
app.post('/api/timezone', requireAuth, (req, res) => {
  const tz = (req.body && typeof req.body.timezone === 'string')
    ? req.body.timezone.trim()
    : '';
  if (!tz) return res.json({ ok: false });

  try {
    new Intl.DateTimeFormat('en-US', { timeZone: tz });
  } catch (e) {
    return res.json({ ok: false });
  }

  if (req.session.user.timezone === tz) return res.json({ ok: true, unchanged: true });

  db.setUserTimezone(req.session.user.id, tz);
  req.session.user.timezone = tz;
  req.session.save(() => res.json({ ok: true, timezone: tz }));
});

// ─── Upgrade page ──────────────────────────────────────────────────────────
// TEMPORARY "coming soon" mode (July 2026): the full course isn't built yet,
// but /upgrade is already advertised on meibostouch.com + in ads. While the
// `upgrade_mode` setting is 'coming_soon' (the default), the SAME URL serves a
// temporary page: free-Winter-trial CTA + a "full course coming soon, get
// notified" Mailchimp signup. The real pricing page below is untouched and
// returns the instant the admin flips the toggle to 'live' (or an admin loads
// /upgrade?preview=full to preview it). Flip it in Admin → Course Settings.
//
// Mailchimp embedded-form config for the notify-me box. Values come from the
// audience's embedded-form code (Mailchimp → Audience → Signup forms →
// Embedded forms). The form `action` looks like
//   https://<HOST>/subscribe/post?u=<U>&id=<ID>&f_id=<F_ID>
// `host` is that full list-manage host; u/id are the query params. Until all
// three are set the box shows a friendly "signups opening soon" placeholder
// instead of posting. The signup posts client-side straight to Mailchimp via
// its post-json (JSONP) endpoint — no API key, no server round-trip, no secret.
const MAILCHIMP_SIGNUP = {
  host: 'meibostouch.us21.list-manage.com',
  u:    '98929ca1fa616eb415f3694b2',
  id:   '86a4e164b2',
};

// Mailchimp tags applied from this platform. Both are created automatically
// the first time they're used — no need to pre-make them in Mailchimp.
//   REGISTERED — applied to EVERY registrant, whether or not they opt into the
//     newsletter. This is the trigger for the "Tag added" Customer Journey, so
//     everyone who signs up enters the onboarding automation.
//   NEWSLETTER — applied only to people who tick the newsletter box, so ongoing
//     newsletter campaigns can target just them (not every registrant).
const MAILCHIMP_TAG_REGISTERED = "Garden – New Registration"; // en dash
const MAILCHIMP_TAG_NEWSLETTER = "Meibos Touch";

// Upsert a contact into the Meibos Touch audience via the Mailchimp Marketing
// API and apply the given tags. Everyone who registers is added as a
// subscribed contact (so the tag-triggered Customer Journey can reach them);
// the newsletter tag is what actually gates ongoing newsletter sends. Requires
// MAILCHIMP_API_KEY (a Railway secret); the audience/list id is the same `id`
// the embed forms use. Fire-and-forget: a Mailchimp hiccup must never break
// account signup. If the key isn't set (e.g. local dev) it no-ops with a
// warning rather than erroring.
async function addContactToMailchimp(email, firstName, lastName, tags) {
  const apiKey = process.env.MAILCHIMP_API_KEY;
  const listId = MAILCHIMP_SIGNUP.id;
  if (!email || !listId || !tags || !tags.length) return;
  if (!apiKey) {
    console.warn('[mailchimp] MAILCHIMP_API_KEY not set — skipping contact sync for', email);
    return;
  }

  const dc   = apiKey.split('-').pop();            // datacenter, e.g. "us21"
  const base = `https://${dc}.api.mailchimp.com/3.0`;
  const hash = crypto.createHash('md5').update(email.toLowerCase()).digest('hex');
  const headers = {
    Authorization: 'Basic ' + Buffer.from(`anystring:${apiKey}`).toString('base64'),
    'Content-Type': 'application/json',
  };

  // Only send merge fields we actually have, so we never blank out an existing
  // contact's name on a repeat signup.
  const merge_fields = {};
  if (firstName) merge_fields.FNAME = firstName;
  if (lastName)  merge_fields.LNAME = lastName;

  try {
    // 1) Upsert the contact. `status_if_new: subscribed` so new registrants can
    //    receive the Journey; existing contacts keep their current status.
    const memberRes = await fetch(`${base}/lists/${listId}/members/${hash}`, {
      method: 'PUT',
      headers,
      body: JSON.stringify({ email_address: email, status_if_new: 'subscribed', merge_fields }),
    });
    if (!memberRes.ok) {
      console.error('[mailchimp] member upsert failed for', email, memberRes.status,
        await memberRes.text().catch(() => ''));
      return;
    }

    // 2) Apply the tags (each is created in the audience if it doesn't exist).
    const tagRes = await fetch(`${base}/lists/${listId}/members/${hash}/tags`, {
      method: 'POST',
      headers,
      body: JSON.stringify({ tags: tags.map((name) => ({ name, status: 'active' })) }),
    });
    if (!tagRes.ok) {
      console.error('[mailchimp] tagging failed for', email, tagRes.status,
        await tagRes.text().catch(() => ''));
    }
    console.log('[mailchimp] synced', email,
      tagRes.ok ? `— tags: ${tags.join(', ')}` : '(contact added; tag step failed)');
  } catch (e) {
    console.error('[mailchimp] contact sync failed for', email, '—', e.message);
  }
}

// Two-step visual flow on one page: pick a tier → Continue → card form
// (Stripe Elements). JS toggles between the two panels; server hands the
// tier catalog to the view once so we can't drift between UI and API.
// Public route. Signed-out visitors see the pricing + free-trial callout so
// the page doubles as a marketing surface; signed-in students see the same
// tiers with a Stripe checkout attached. Admins and already-upgraded students
// have no reason to view checkout, so they get bounced to dashboard.
app.get('/upgrade', (req, res) => {
  const sessionUser = req.session.user;

  // Temporary coming-soon page. Default to 'coming_soon' when unset so a fresh
  // deploy is safe (never accidentally exposes unfinished pricing). Admins can
  // bypass with ?preview=full to sanity-check the real page before going live.
  const upgradeMode = db.getSetting('upgrade_mode') || 'coming_soon';
  const adminPreviewFull = !!(sessionUser && sessionUser.role === 'admin' && req.query.preview === 'full');
  if (upgradeMode === 'coming_soon' && !adminPreviewFull) {
    const mailchimpConfigured = !!(MAILCHIMP_SIGNUP.host && MAILCHIMP_SIGNUP.u && MAILCHIMP_SIGNUP.id);
    return res.render('upgrade-coming-soon', {
      title: 'The full course is coming soon',
      page: 'upgrade',
      user: sessionUser || null,
      mailchimp: MAILCHIMP_SIGNUP,
      mailchimpConfigured,
    });
  }

  // adminPreviewFull lets an admin load the real pricing page to sanity-check
  // it before flipping the toggle live — so skip the usual admin/upgraded
  // redirects in that case and render the page as a visitor would see it.
  if (sessionUser && !adminPreviewFull) {
    if (sessionUser.role === 'admin') return res.redirect('/dashboard');
    const dbUser = db.getUserById(sessionUser.id);
    if (!dbUser) return res.redirect('/dashboard');
    if ((dbUser.course_length_weeks || 12) >= 12) {
      // Already upgraded — no need to see the checkout page. Fall through to
      // dashboard where they can see everything they have access to.
      return res.redirect('/dashboard');
    }
  }
  const features = STRIPE.getFeatures();
  res.render('upgrade', {
    title: 'Continue with the full course',
    page: 'upgrade',
    features,
    tiers: STRIPE.getTiers().map(t => ({
      id:                 t.id,
      name:               t.name,
      priceCents:         t.priceCents,
      priceLabel:         STRIPE.formatPrice(t.priceCents),
      originalPriceLabel: t.originalPriceCents ? STRIPE.formatPrice(t.originalPriceCents) : null,
      savingsLabel:       t.originalPriceCents
        ? STRIPE.formatPrice(t.originalPriceCents - t.priceCents)
        : null,
      priceNote:          t.priceNote || null,
      tagline:            t.tagline,
      includes:           t.includes,
      labelOverrides:     t.labelOverrides || {},
    })),
    stripeConfigured: STRIPE.isConfigured(),
    publishableKey:   STRIPE.getPublishableKey(),
  });
});

// Return URL Stripe redirects to after 3DS challenge / async payment
// methods complete. We look at ?payment_intent + ?payment_intent_client_secret
// query params Stripe appends, ask Stripe for the intent's final status,
// and route the student to the confirmation banner or an error state.
app.get('/upgrade/return', requireAuth, async (req, res) => {
  if (!STRIPE.isConfigured()) return res.redirect('/dashboard');
  const clientSecret = req.query.payment_intent_client_secret;
  if (!clientSecret) return res.redirect('/upgrade');
  // We don't have Stripe.js server-side; we re-render the upgrade page with
  // a small client-side script that polls the PaymentIntent status via
  // stripe.retrievePaymentIntent and forwards to /dashboard?upgraded=1 on
  // success. Simpler than round-tripping status via a server endpoint.
  // The tier comes from our own ?tier= param (validated against the
  // catalog) — client-side PaymentIntent retrieval doesn't expose metadata.
  const tier = STRIPE.findTier(String(req.query.tier || ''));
  res.render('upgrade-return', {
    title: 'Confirming your payment',
    page: 'upgrade',
    publishableKey: STRIPE.getPublishableKey(),
    clientSecret,
    tierId: tier ? tier.id : null,
  });
});

// ─── Stripe checkout + webhook ─────────────────────────────────────────────
// Two-endpoint model for Elements checkout:
//   1. Client POSTs /api/checkout/create-payment-intent → server creates a
//      PaymentIntent stamped with the user's id in metadata, returns the
//      client_secret. Client mounts Stripe Elements and confirms with that.
//   2. Stripe fires payment_intent.succeeded to /webhooks/stripe. We verify
//      signature, claim event.id (idempotent), then flip
//      course_length_weeks 3 → 12 for the user in metadata.user_id.
//
// Only trial students (course_length_weeks < 12) can initiate a checkout —
// keeps the "already paid" case from paying twice.

app.post('/api/checkout/create-payment-intent', requireAuth, async (req, res) => {
  if (!STRIPE.isConfigured()) {
    return res.status(503).json({ error: 'Payments are not configured yet.' });
  }
  const sessionUser = req.session.user;
  if (sessionUser.role === 'admin') {
    return res.status(400).json({ error: 'Admins do not need to upgrade.' });
  }
  // Re-read from DB in case course_length_weeks changed since login. The
  // session copy would be stale if an admin manually flipped their cohort.
  const dbUser = db.getUserById(sessionUser.id);
  if (!dbUser) return res.status(404).json({ error: 'User not found.' });
  if ((dbUser.course_length_weeks || 12) >= 12) {
    return res.status(409).json({ error: 'You already have full access to the course.' });
  }

  // Validate tier client-side value against server-side catalog.
  const tierId = (req.body && req.body.tier) || '';
  const tier = STRIPE.findTier(tierId);
  if (!tier) return res.status(400).json({ error: 'Please choose a tier before continuing.' });

  try {
    const intent = await STRIPE.createUpgradePaymentIntent(dbUser.id, dbUser.email, tier.id);
    res.json({
      ok: true,
      clientSecret: intent.client_secret,
      publishableKey: STRIPE.getPublishableKey(),
      amount: tier.priceCents,
      currency: STRIPE.getCurrency(),
      tier: { id: tier.id, name: tier.name },
    });
  } catch (err) {
    console.error('[stripe] createPaymentIntent failed:', err.message);
    res.status(500).json({ error: 'Could not start checkout. Try again in a moment.' });
  }
});

// Stripe posts here on payment_intent.succeeded (and other events). No
// session — the request comes from Stripe's servers, authenticated by the
// signature header we verify. Note this route DOES need JSON parsing (the
// event body is JSON) but ALSO needs the raw bytes for signature verify —
// captured earlier by express.json({ verify }).
app.post('/webhooks/stripe', async (req, res) => {
  if (!STRIPE.isConfigured()) return res.status(503).send('Stripe not configured');
  const sig = req.get('Stripe-Signature') || '';
  if (!sig || !req.rawBody) return res.status(400).send('Missing signature or body');

  let event;
  try {
    event = STRIPE.constructWebhookEvent(req.rawBody, sig);
  } catch (err) {
    console.warn('[stripe] webhook signature verification failed:', err.message);
    return res.status(400).send(`Signature failed: ${err.message}`);
  }

  // Idempotency + atomicity in one transaction: the event claim and the
  // upgrade writes either both land or neither does. A crash between them
  // used to leave the event marked processed with no upgrade — customer
  // paid, still on trial, and Stripe's retry hit "already processed". Every
  // DB call below is synchronous (node:sqlite), so no await splits the
  // BEGIN/COMMIT window.
  db.exec('BEGIN');
  try {
    const claimed = db.tryClaimStripeEvent(event.id, event.type);
    if (!claimed) {
      db.exec('COMMIT');
      console.log('[stripe] webhook already processed:', event.id, event.type);
      return res.json({ ok: true, alreadyProcessed: true });
    }

    if (event.type === 'payment_intent.succeeded') {
      const pi = event.data.object;
      const userIdStr = pi.metadata && pi.metadata.user_id;
      const tierId    = pi.metadata && pi.metadata.tier;
      const userId = parseInt(userIdStr, 10);
      if (!Number.isFinite(userId)) {
        console.warn('[stripe] payment_intent.succeeded without user_id metadata:', pi.id);
      } else {
        const user = db.getUserById(userId);
        if (user) {
          // Record the tier regardless of prior state (a re-purchase would
          // update the tier). Only flip course_length_weeks if not already
          // upgraded — avoids clobbering an admin-manually-flipped user.
          if (tierId && STRIPE.findTier(tierId)) {
            db.setUserEnrollmentTier(userId, tierId);
          }
          if ((user.course_length_weeks || 12) < 12) {
            db.setUserCourseLengthWeeks(userId, 12);
            console.log(`[stripe] upgraded user ${userId} (${user.email}) to full course [${tierId || 'no-tier'}] after ${pi.id}`);
          } else {
            console.log(`[stripe] payment for user ${userId} arrived but they're already at 12 — tier recorded, no length flip`);
          }
        }
      }
    } else {
      // Other event types are ignored for now — we still 200 so Stripe stops
      // retrying, and the id is stored in stripe_events so we never process
      // a stray event again.
      console.log('[stripe] ignoring event type:', event.type);
    }
    db.exec('COMMIT');
    res.json({ ok: true });
  } catch (err) {
    // Roll back the claim too, so this delivery didn't "count" — then 500 so
    // Stripe retries and the upgrade gets another chance. Loud log either way.
    try { db.exec('ROLLBACK'); } catch (_) {}
    console.error('[stripe] webhook handler failed for', event.id, event.type, ':', err);
    res.status(500).send('handler error — will retry');
  }
});

// ─── Push notifications ────────────────────────────────────────────────────
// Three lifecycle endpoints. Client flow:
//   1. fetch GET /api/push/vapid-public-key
//   2. registration.pushManager.subscribe({ applicationServerKey: <key> })
//   3. POST /api/push/subscribe  with the resulting subscription object
//   …or POST /api/push/unsubscribe to revoke a device.

app.get('/api/push/vapid-public-key', requireAuth, (req, res) => {
  if (!PUSH.isPushConfigured()) {
    return res.status(503).json({ ok: false, error: 'push_not_configured' });
  }
  res.json({ ok: true, key: PUSH.getVapidPublicKey() });
});

app.post('/api/push/subscribe', requireAuth, (req, res) => {
  if (!PUSH.isPushConfigured()) {
    return res.status(503).json({ ok: false, error: 'push_not_configured' });
  }

  const sub = req.body && req.body.subscription;
  // The browser subscription object always has the shape
  // { endpoint, keys: { p256dh, auth } }. Anything else is malformed input.
  if (!sub || typeof sub.endpoint !== 'string' || !sub.keys ||
      typeof sub.keys.p256dh !== 'string' || typeof sub.keys.auth !== 'string') {
    return res.status(400).json({ ok: false, error: 'invalid_subscription' });
  }

  const userAgent = (req.get('user-agent') || '').slice(0, 500);
  db.upsertPushSubscription({
    userId:   req.session.user.id,
    endpoint: sub.endpoint,
    p256dh:   sub.keys.p256dh,
    auth:     sub.keys.auth,
    userAgent,
  });

  res.json({ ok: true });
});

app.post('/api/push/unsubscribe', requireAuth, (req, res) => {
  const endpoint = req.body && req.body.endpoint;
  if (typeof endpoint !== 'string' || !endpoint) {
    return res.status(400).json({ ok: false, error: 'invalid_endpoint' });
  }
  db.deletePushSubscriptionByEndpoint(endpoint);
  res.json({ ok: true });
});

// ─── Weekly Intentions ──────────────────────────────────────────────────────

// Old /goals URL → permanent redirect to /weekly-intentions, preserving the
// ?week= param so any existing bookmarks/links keep working.
app.get('/goals', requireAuth, (req, res) => {
  const qs = req.query.week ? '?week=' + encodeURIComponent(req.query.week) : '';
  res.redirect(301, '/weekly-intentions' + qs);
});

app.get('/weekly-intentions', requireAuth, (req, res) => {
  const userId = req.session.user.id;
  const courseWeek = getCurrentCourseWeek(req.session.user);
  const currentWeekStart = courseWeek.weekStart;
  const requestedWeek = req.query.week || currentWeekStart;

  // Validate week format (YYYY-MM-DD)
  const weekStart = /^\d{4}-\d{2}-\d{2}$/.test(requestedWeek) ? requestedWeek : currentWeekStart;

  const goals = db.getGoalsForWeek(userId, weekStart);
  const goalsMap = {};
  for (const g of goals) goalsMap[g.category] = g;

  const history = db.getWeekHistory(userId, 12);

  // Pre-build weekStart → "Week One" label for history pills
  const courseStartDate = db.getUserCourseStartDate(req.session.user);
  const courseLengthWeeks = getCourseLengthWeeks(req.session.user);
  const weekNames = {};
  if (courseStartDate) {
    generateCourseWeeks(courseStartDate, courseLengthWeeks).forEach((ws, i) => {
      weekNames[ws] = 'Week ' + WEEK_ORDINALS[i];
    });
  }

  // Compute prev/next week dates
  const weekDate = new Date(weekStart + 'T00:00:00');
  const prevWeek = new Date(weekDate);
  prevWeek.setDate(weekDate.getDate() - 7);
  const nextWeek = new Date(weekDate);
  nextWeek.setDate(weekDate.getDate() + 7);

  const currentWeekDate = new Date(currentWeekStart + 'T00:00:00');
  const isPastWeek = weekDate < currentWeekDate;
  const isFutureWeek = weekDate > currentWeekDate;

  const goalsDataPage = {};
  for (const cat of ['curiosity','create','share','connect']) {
    goalsDataPage[cat] = parseGoalText(goalsMap[cat]?.goal_text);
  }

  const weeklyReflection = isPastWeek ? db.getWeeklyReflection(userId, weekStart) : null;

  // Determine curricular season for the viewed week
  const allWeekStarts = courseStartDate ? generateCourseWeeks(courseStartDate, courseLengthWeeks) : [];
  const viewedWeekIdx = allWeekStarts.indexOf(weekStart);
  const viewedWeekNumber = viewedWeekIdx >= 0 ? viewedWeekIdx + 1 : null;
  const curricularSeason = getCurricularSeason(viewedWeekNumber);
  const curricularSeasonLabel = getCurricularSeasonLabel(curricularSeason);

  res.render('goals', {
    title: 'Weekly Intentions',
    page: 'goals',
    weekStart,
    weekLabel: formatWeekLabel(weekStart),
    currentWeekStart,
    viewedWeekNumber,
    courseLengthWeeks: getCourseLengthWeeks(req.session.user),
    curricularSeason,
    curricularSeasonLabel,
    goals: goalsMap,
    goalsData: goalsDataPage,
    shareThisWeek: db.getWeekShareEffective(userId, weekStart),
    isPastWeek,
    isFutureWeek,
    prevWeek: prevWeek.toISOString().split('T')[0],
    nextWeek: nextWeek.toISOString().split('T')[0],
    history,
    weekNames,
    formatWeekLabel,
    weeklyReflection
  });
});

app.post('/api/goals/intention', requireAuth, (req, res) => {
  const { weekStart, category, goalText } = req.body;
  const validCategories = ['curiosity', 'create', 'share', 'connect'];
  if (!validCategories.includes(category)) return res.status(400).json({ error: 'Invalid category' });
  db.upsertGoal(req.session.user.id, weekStart, category, goalText || '');
  res.json({ ok: true });
});

app.post('/api/goals/checkin', requireAuth, (req, res) => {
  const { weekStart, category, reflection, completed } = req.body;
  const validCategories = ['curiosity', 'create', 'share', 'connect'];
  if (!validCategories.includes(category)) return res.status(400).json({ error: 'Invalid category' });
  db.saveCheckin(req.session.user.id, weekStart, category, { reflection, completed });
  res.json({ ok: true });
});

app.post('/api/goals/reflection', requireAuth, (req, res) => {
  const { weekStart, category, reflection } = req.body;
  const validCategories = ['curiosity', 'create', 'share', 'connect'];
  if (!validCategories.includes(category)) return res.status(400).json({ error: 'Invalid category' });
  db.saveReflection(req.session.user.id, weekStart, category, reflection);
  res.json({ ok: true });
});

app.post('/api/goals/complete', requireAuth, (req, res) => {
  const { weekStart, category, completed } = req.body;
  const validCategories = ['curiosity', 'create', 'share', 'connect'];
  if (!validCategories.includes(category)) return res.status(400).json({ error: 'Invalid category' });
  db.setGoalComplete(req.session.user.id, weekStart, category, completed);
  res.json({ ok: true });
});

// Per-week "share my intentions with the community" toggle. Writes an
// override row for this (user, week); the community page reads it, falling
// back to the user's default when a week hasn't been explicitly set.
app.post('/api/goals/share', requireAuth, (req, res) => {
  const { weekStart, shared } = req.body || {};
  if (!/^\d{4}-\d{2}-\d{2}$/.test(weekStart || '')) {
    return res.status(400).json({ error: 'Invalid week_start format.' });
  }
  db.setWeekShare(req.session.user.id, weekStart, !!shared);
  res.json({ ok: true });
});

app.post('/api/goals', requireAuth, (req, res) => {
  const { weekStart, category, goalText } = req.body;
  const validCategories = ['curiosity', 'create', 'share', 'connect'];
  if (!validCategories.includes(category)) return res.status(400).json({ error: 'Invalid category' });
  db.upsertGoal(req.session.user.id, weekStart, category, goalText || '');
  res.json({ ok: true });
});

app.post('/api/goals/:id/toggle', requireAuth, (req, res) => {
  const result = db.toggleGoalComplete(parseInt(req.params.id), req.session.user.id);
  if (!result) return res.status(404).json({ error: 'Goal not found' });
  res.json({ ok: true });
});

app.post('/api/reflections', requireAuth, (req, res) => {
  const { week_start, text, shared_with_cohort } = req.body;
  if (!/^\d{4}-\d{2}-\d{2}$/.test(week_start || '')) {
    return res.status(400).json({ error: 'Invalid week_start format.' });
  }
  const courseWeek = getCurrentCourseWeek(req.session.user);
  if (week_start >= courseWeek.weekStart) {
    return res.status(400).json({ error: 'Reflections can only be saved for past weeks.' });
  }
  db.upsertWeeklyReflection(req.session.user.id, week_start, text, shared_with_cohort);
  res.json({ ok: true, updated_at: new Date().toISOString() });
});

// ─── Season ────────────────────────────────────────────────────────────────

app.post('/api/season', requireAuth, (req, res) => {
  const { season } = req.body;
  if (season && !['spring', 'summer', 'autumn', 'winter'].includes(season)) {
    return res.status(400).json({ error: 'Invalid season.' });
  }
  // Belt-and-suspenders: refuse writes from pre-Week-4 trial students.
  // The UI already disables their picker (see profile.ejs canPickSeason),
  // but the API check makes it impossible to bypass via a hand-crafted
  // POST. Admins are always allowed through so they can preview any state.
  if (req.session.user.role !== 'admin' && !res.locals.canPickSeason) {
    return res.status(403).json({
      error: 'Your season unlocks after Week 3 or with the full course.',
    });
  }
  // A student deselecting their season means "step back into Winter" (the
  // dashboard copy promises exactly that). Storing NULL instead would get
  // silently rewritten to 'spring' by the auto-advance middleware on the
  // very next request. Admins may still clear to NULL for preview resets.
  const toStore = season || (req.session.user.role === 'admin' ? null : 'winter');
  db.updateUserSeason(req.session.user.id, toStore);
  req.session.user.current_season = toStore;
  res.json({ ok: true });
});

// Dismiss the one-time "Welcome to Spring" intro card on the dashboard.
// Idempotent — the flag is a boolean, not a counter.
app.post('/api/season/intro-seen', requireAuth, (req, res) => {
  db.markSeasonIntroSeen(req.session.user.id);
  res.json({ ok: true });
});

// Dismiss a dashboard banner. action='snooze' hides it until tomorrow (it
// re-shows the next calendar day); action='remove' hides it for good.
const DISMISSIBLE_BANNERS = ['midcourse', 'trial_closing', 'season_spring', 'season_summer', 'season_autumn'];
app.post('/api/banner/dismiss', requireAuth, (req, res) => {
  const key    = String((req.body && req.body.key) || '').trim();
  const action = String((req.body && req.body.action) || '').trim();
  if (!DISMISSIBLE_BANNERS.includes(key)) {
    return res.status(400).json({ error: 'Unknown banner.' });
  }
  const userId = req.session.user.id;
  if (action === 'snooze') {
    const today    = toLocalDateString(getNow(req.session.user));
    const tomorrow = toLocalDateString(new Date(new Date(today + 'T00:00:00').getTime() + 86400000));
    db.snoozeBanner(userId, key, tomorrow);
    return res.json({ ok: true, action: 'snooze', until: tomorrow });
  }
  if (action === 'remove') {
    db.dismissBannerPermanently(userId, key);
    return res.json({ ok: true, action: 'remove' });
  }
  return res.status(400).json({ error: 'Unknown action.' });
});

// ─── Lessons ───────────────────────────────────────────────────────────────

function normalizeVideoUrl(url) {
  if (!url || !url.trim()) return null;
  url = url.trim();
  // YouTube watch?v=
  let m = url.match(/[?&]v=([a-zA-Z0-9_-]+)/);
  if (m && url.includes('youtube')) return `https://www.youtube.com/embed/${m[1]}`;
  // YouTube short youtu.be/
  m = url.match(/youtu\.be\/([a-zA-Z0-9_-]+)/);
  if (m) return `https://www.youtube.com/embed/${m[1]}`;
  // Already a YouTube embed URL
  if (url.includes('youtube.com/embed/')) return url;
  // Vimeo vimeo.com/NNNN
  m = url.match(/vimeo\.com\/(\d+)/);
  if (m) return `https://player.vimeo.com/video/${m[1]}`;
  // Already a Vimeo player URL
  if (url.includes('player.vimeo.com')) return url;
  // Unknown — store as-is
  return url;
}

app.get('/lessons', requireAuth, (req, res) => {
  // Lessons are hidden from students during the trial run — not ready yet.
  // Admin-only for now (nav link + dashboard surfaces are hidden to match);
  // remove this guard to reopen lessons to students.
  if (req.session.user.role !== 'admin') return res.redirect('/dashboard');
  const allLessons = db.getAllLessons();
  const completedIds = new Set(db.completedLessonIds(req.session.user.id));
  // Trial students only see lessons within their course length. The
  // "Course Introduction" sits outside the numbered curriculum so it stays
  // visible to everyone. Numbered lessons N > length are hidden.
  const courseLengthWeeks = getCourseLengthWeeks(req.session.user);
  let visible = allLessons;
  if (req.session.user.role !== 'admin' && courseLengthWeeks < 12) {
    const numbered = allLessons.filter(l => l.slug !== 'course-introduction');
    const allowedNumbered = new Set(numbered.slice(0, courseLengthWeeks).map(l => l.id));
    visible = allLessons.filter(l => l.slug === 'course-introduction' || allowedNumbered.has(l.id));
  }
  res.render('lessons', {
    title: 'Lessons',
    page: 'lessons',
    lessons: visible,
    completedIds,
    completedCount: completedIds.size
  });
});

app.get('/lessons/:slug', requireAuth, (req, res) => {
  // Lessons hidden from students during the trial run (see /lessons above).
  if (req.session.user.role !== 'admin') return res.redirect('/dashboard');
  const lesson = db.getLessonBySlug(req.params.slug);
  if (!lesson) return res.status(404).render('error', { title: '404', message: 'Lesson not found.', user: req.session.user, page: 'lessons' });
  // Block trial students from URL-hacking into a lesson past their length.
  // Admins always pass; intro is always allowed; numbered lessons N > length
  // 404 with a friendly message instead of silently rendering.
  if (req.session.user.role !== 'admin' && lesson.slug !== 'course-introduction') {
    const courseLengthWeeks = getCourseLengthWeeks(req.session.user);
    if (courseLengthWeeks < 12) {
      const numbered = db.getAllLessons().filter(l => l.slug !== 'course-introduction');
      const numIdx = numbered.findIndex(l => l.id === lesson.id);
      if (numIdx >= 0 && numIdx + 1 > courseLengthWeeks) {
        return res.status(404).render('error', {
          title: 'Not yet',
          message: `This lesson is part of the full course. Your trial covers lessons 1–${courseLengthWeeks}.`,
          user: req.session.user,
          page: 'lessons',
        });
      }
    }
  }
  const completed = !!db.getLessonCompletion(req.session.user.id, lesson.id);
  const allLessons = db.getAllLessons();
  const idx = allLessons.findIndex(l => l.id === lesson.id);
  const prevLesson = idx > 0 ? allLessons[idx - 1] : null;
  const nextLesson = idx < allLessons.length - 1 ? allLessons[idx + 1] : null;
  const homework = db.getHomeworkForLesson(lesson.id);
  const homeworkDone = new Set(db.getHomeworkCompletions(req.session.user.id, lesson.id));

  // Course Introduction sits outside the numbered curriculum: Lesson 1
  // stays Lesson 1, the total stays "of 12", and the Introduction itself
  // has no "Lesson N of 12" or curricular season label. The view hides
  // both meta items when lessonNumber is null.
  const numberedLessons = allLessons.filter(l => l.slug !== 'course-introduction');
  const numberedIdx     = numberedLessons.findIndex(l => l.id === lesson.id);
  const lessonNumber    = numberedIdx >= 0 ? numberedIdx + 1 : null;
  const curricularSeason      = lessonNumber ? getCurricularSeason(lessonNumber) : null;
  const curricularSeasonLabel = lessonNumber ? getCurricularSeasonLabel(curricularSeason) : '';
  res.render('lesson', {
    title: lesson.title,
    page: 'lessons',
    lesson,
    completed,
    prevLesson,
    nextLesson,
    homework,
    homeworkDone,
    lessonNumber,
    curricularSeason,
    curricularSeasonLabel,
  });
});

app.post('/api/lessons/:lesson_id/homework/:homework_id/toggle', requireAuth, (req, res) => {
  const result = db.toggleHomework(req.session.user.id, parseInt(req.params.homework_id));
  res.json({ ok: true, completed: result.completed });
});

app.post('/api/lessons/:id/complete', requireAuth, (req, res) => {
  const { completed } = req.body;
  const lessonId = parseInt(req.params.id);
  if (completed) {
    db.markLessonComplete(req.session.user.id, lessonId);
  } else {
    db.unmarkLessonComplete(req.session.user.id, lessonId);
  }
  res.json({ ok: true });
});

// ─── Community ─────────────────────────────────────────────────────────────

app.get('/community', requireAuth, (req, res) => {
  const currentWeekStart = getCurrentCourseWeek(req.session.user).weekStart;
  const courseStartDate  = db.getUserCourseStartDate(req.session.user) || currentWeekStart;
  const courseLengthWeeks = getCourseLengthWeeks(req.session.user);
  const weekStarts       = generateCourseWeeks(courseStartDate, courseLengthWeeks);
  const firstWeek        = weekStarts[0];
  const lastWeek         = weekStarts[weekStarts.length - 1];

  // Accessible ceiling: can't exceed current week or final week
  const accessibleUpTo = currentWeekStart < lastWeek ? currentWeekStart : lastWeek;

  // Clamp requested week to [firstWeek, accessibleUpTo]
  let weekStart = req.query.week || currentWeekStart;
  if (weekStart < firstWeek)     weekStart = firstWeek;
  if (weekStart > accessibleUpTo) weekStart = accessibleUpTo;

  // Snap to nearest course week that is <= weekStart
  let weekIdx = weekStarts.indexOf(weekStart);
  if (weekIdx === -1) {
    weekIdx = weekStarts.reduce((best, w, i) => (w <= weekStart ? i : best), 0);
    weekStart = weekStarts[weekIdx];
  }

  const weekName    = 'Week ' + WEEK_ORDINALS[weekIdx];
  const hasPrevWeek = weekIdx > 0;
  const prevWeek    = hasPrevWeek ? weekStarts[weekIdx - 1] : null;
  const nextCandidate = weekIdx < 11 ? weekStarts[weekIdx + 1] : null;
  const hasNextWeek = !!(nextCandidate && nextCandidate <= accessibleUpTo);
  const nextWeek    = hasNextWeek ? nextCandidate : null;

  // Community access by tier:
  //   • Admin  → sees everyone.
  //   • Paid   → sees the full-course cohort (fellow paid students + admin).
  //   • Trial  → NOT a shared cohort. Other free signups are strangers, not
  //              their people, so a trial student sees only themselves plus
  //              the admin (their guide), with an upsell to unlock the real
  //              community. communityLocked drives that view state.
  const viewer        = req.session.user;
  const viewerIsAdmin = viewer.role === 'admin';
  const viewerPaid    = (viewer.course_length_weeks || 12) >= 12;
  const communityLocked = !viewerIsAdmin && !viewerPaid;
  const allUsers = db.getAllUsers().filter(u => {
    if (viewerIsAdmin) return true;         // admin sees everyone
    if (u.role === 'admin') return true;    // everyone sees the admin/guide
    if (viewerPaid) return (u.course_length_weeks || 12) >= 12;
    return u.id === viewer.id;              // trial: only themselves
  });
  const rows     = db.getAllUsersGoalsForWeek(weekStart);

  const goalsMap = {};
  for (const row of rows) {
    if (!goalsMap[row.user_id]) goalsMap[row.user_id] = {};
    const gd = parseGoalText(row.goal_text);
    goalsMap[row.user_id][row.category] = {
      goalData:   gd,
      hasGoal:    !!(gd.items && gd.items.length > 0),
      completed:  !!row.completed,
      reflection: row.reflection || ''
    };
  }

  // Per-card "recorded N days this week" — one camera per distinct day a
  // user logged a cutting in the viewed week's range. Derive weekEnd
  // (weekStart + 6) and pull a count Map keyed by user_id. The template
  // only sees a number per user (0..7) — no cutting text ever reaches a
  // public surface even though this is one.
  const weekEndDate = new Date(weekStart + 'T00:00:00');
  weekEndDate.setDate(weekEndDate.getDate() + 6);
  const weekEnd = toLocalDateString(weekEndDate);
  const dayCounts = db.getCuttingDayCountsByUser(weekStart, weekEnd);

  // Per-week sharing: an explicit override for this week wins; otherwise
  // fall back to the member's default (community_goals_public).
  const weekShareOverrides = db.getWeekSharesForWeek(weekStart);

  const members = allUsers.map(u => ({
    id:                      u.id,
    name:                    u.name,
    role:                    u.role,
    avatar_initial:          u.avatar_initial || u.name.charAt(0),
    current_season:          u.current_season || null,
    profile_photo:           u.profile_photo || null,
    community_goals_public:  weekShareOverrides.has(u.id)
                               ? weekShareOverrides.get(u.id)
                               : (u.community_goals_public !== 0),
    community_season_public: u.community_season_public !== 0,
    goals:                   goalsMap[u.id] || {},
    recordedDayCount:        dayCounts.get(u.id) || 0
  }));

  res.render('community', {
    title: 'Community',
    page:  'community',
    weekStart,
    weekName,
    dateRange:     formatDateRangeShort(weekStart),
    members,
    prevWeek,
    nextWeek,
    hasPrevWeek,
    hasNextWeek,
    isCurrentWeek: weekStart === currentWeekStart,
    currentUserId: req.session.user.id,
    communityLocked
  });
});

// ─── Calendar ──────────────────────────────────────────────────────────────

// Weekly meeting cadence — hardcoded per the course curriculum design.
// Meetings begin in Week 4 (Weeks 1-3 = Winter, self-led). From Week 4 on,
// a 3-week cadence (Group → 1:1 → Office Hours) repeats through Week 9;
// the final block (Weeks 10-12) breaks pattern: Group, 1:1, Group.
const WEEKLY_MEETINGS = {
  4:  { type: 'group',        label: 'Group Meeting', note: "Recorded if you can't attend" },
  5:  { type: 'one-on-one',   label: 'One-on-One' },
  6:  { type: 'office-hours', label: 'Office Hours' },
  7:  { type: 'group',        label: 'Group Meeting', note: "Recorded if you can't attend" },
  8:  { type: 'one-on-one',   label: 'One-on-One' },
  9:  { type: 'office-hours', label: 'Office Hours' },
  10: { type: 'group',        label: 'Group Meeting', note: "Recorded if you can't attend" },
  11: { type: 'one-on-one',   label: 'One-on-One' },
  12: { type: 'group',        label: 'Group Meeting', note: "Recorded if you can't attend" },
};

app.get('/calendar', requireAuth, (req, res) => {
  const userId               = req.session.user.id;
  const courseCurrentWeekStart = getCurrentCourseWeek(req.session.user).weekStart;
  const currentWeekStart     = courseCurrentWeekStart;
  const courseStartDate      = db.getUserCourseStartDate(req.session.user) || currentWeekStart;
  const courseLengthWeeks    = getCourseLengthWeeks(req.session.user);

  // Calendar always shows the full 12 weeks. Weeks beyond the student's
  // paid access get rendered as locked/greyed tiles that link to /upgrade.
  // This keeps the shape of the journey consistent and previews what's
  // available with an upgrade.
  const weekStarts           = generateCourseWeeks(courseStartDate, 12);
  const allGoalsRaw          = db.getGoalsForWeeks(userId, weekStarts);
  const reflectionsRaw       = db.getWeeklyReflections(userId, weekStarts);
  const cats                 = ['curiosity', 'create', 'share', 'connect'];

  // Which meeting types the student is entitled to see labels for.
  // Solo (course_length_weeks === 12 && tier === 'solo') and trial students
  // see no meeting labels — they have no calls with Julia. Community sees
  // group + office-hours. Coaching adds one-on-one.
  const tier = req.session.user.enrollment_tier;
  let visibleMeetingTypes;
  if (tier === 'coaching')       visibleMeetingTypes = new Set(['group', 'office-hours', 'one-on-one']);
  else if (tier === 'community') visibleMeetingTypes = new Set(['group', 'office-hours']);
  else                           visibleMeetingTypes = new Set();

  const weeks = weekStarts.map((weekStart, idx) => {
    const weekNum = idx + 1;
    const isLocked = weekNum > courseLengthWeeks;

    // Locked weeks skip the goals/reflections/season computation — nothing
    // to render inside the tile. We still emit a stub so the view can
    // iterate uniformly.
    if (isLocked) {
      return {
        weekStart,
        weekIndex:         idx,
        weekNum,
        weekName:          'Week ' + WEEK_ORDINALS[idx],
        dateRange:         formatDateRangeShort(weekStart),
        isLocked:          true,
        isCurrentWeek:     false,
        isPastWeek:        false,
        isFutureWeek:      true,
        isPastCourseWeek:  false,
        curricularSeason:  getCurricularSeason(weekNum),
        curricularSeasonLabel: getCurricularSeasonLabel(getCurricularSeason(weekNum)),
        meeting:           null,
        goalsData:         null,
        goalsMap:          {},
        goalsExist:        {},
        allGoalsSet:       false,
        reflection:        null,
      };
    }

    const goalsMap   = allGoalsRaw[weekStart] || {};
    const goalsData  = {};
    const goalsExist = {};
    for (const cat of cats) {
      goalsData[cat]  = parseGoalText(goalsMap[cat]?.goal_text);
      const gd        = goalsData[cat];
      goalsExist[cat] = !!(gd.items && gd.items.length > 0);
    }
    const allGoalsSet   = cats.every(cat => goalsExist[cat]);
    const curricularSeason = getCurricularSeason(weekNum);
    const curricularSeasonLabel = getCurricularSeasonLabel(curricularSeason);
    const meetingDef = WEEKLY_MEETINGS[weekNum] || null;
    // Only show the meeting label if this student's tier includes that
    // meeting type. Other tiers get a null → view hides the label row.
    const meeting = meetingDef && visibleMeetingTypes.has(meetingDef.type) ? meetingDef : null;
    return {
      weekStart,
      weekIndex:          idx,
      weekNum,
      weekName:           'Week ' + WEEK_ORDINALS[idx],
      dateRange:          formatDateRangeShort(weekStart),
      isLocked:           false,
      isCurrentWeek:      weekStart === currentWeekStart,
      isPastWeek:         weekStart < currentWeekStart,
      isFutureWeek:       weekStart > currentWeekStart,
      isPastCourseWeek:   weekStart < courseCurrentWeekStart,
      curricularSeason,
      curricularSeasonLabel,
      meeting,
      goalsData,
      goalsMap,
      goalsExist,
      allGoalsSet,
      reflection:         reflectionsRaw[weekStart] || null
    };
  });

  res.render('calendar', {
    title:                'Your 12-Week Journey',
    page:                 'calendar',
    weeks,
    currentWeekStart,
    courseCurrentWeekStart,
    courseStartDate,
    courseLengthWeeks,
    hasLockedWeeks:       courseLengthWeeks < 12,
    todayStr: toLocalDateString(getNow(req.session.user))
  });
});

// ─── Onboarding ────────────────────────────────────────────────────────────

const ASSESSMENT_QUESTIONS = [
  { id: 'q1', type: 'choice', field: 'q1_choice',
    text: 'How often are you currently sharing your creative work or perspective online?',
    choices: [
      { val: 'A', label: "I have never posted. (Or haven't in a long while)" },
      { val: 'B', label: 'I barely post' },
      { val: 'C', label: 'A few times a month' },
      { val: 'D', label: 'A few times a week' },
      { val: 'E', label: 'Daily' }
    ]
  },
  { id: 'q2', type: 'rating', field: 'q2_rating',
    text: 'How congruent do you feel between who you are and how you show up on camera?',
    low: '1 = completely different people', high: '10 = exactly the same person'
  },
  { id: 'q3', type: 'choice', field: 'q3_choice',
    text: 'When you sit down to create content — or even just think about creating — what\'s your default state?',
    choices: [
      { val: 'A', label: 'Frozen or avoidant' },
      { val: 'B', label: 'Forcing it, going through the motions' },
      { val: 'C', label: 'Flashes of clarity, mostly noise' },
      { val: 'D', label: 'Clear and intuitive, most of the time' },
      { val: 'E', label: 'Fully open — when I create, I\'m in flow' }
    ]
  },
  { id: 'q4', type: 'rating', field: 'q4_rating',
    text: 'How safe do you feel being seen online?',
    low: '1 = visibility feels like a threat', high: '10 = visibility feels like home'
  },
  { id: 'q5', type: 'choice', field: 'q5_choice',
    text: 'How clear are you on what you\'re actually trying to say online?',
    choices: [
      { val: 'A', label: "I'm figuring it out post by post" },
      { val: 'B', label: 'I have some themes but no real throughline' },
      { val: 'C', label: "I know my message, I just don't say it consistently" },
      { val: 'D', label: "I'm building something that feels cohesive" },
      { val: 'E', label: "I know exactly what I'm here to say — and why it matters" }
    ]
  },
  { id: 'q6', type: 'rating', field: 'q6_rating',
    text: 'How fully expressed do you feel in what you currently share online?',
    low: "1 = I'm holding almost everything back", high: '10 = what I share feels truly like me'
  },
  { id: 'q7', type: 'multi', field: 'q7_choices', max: 2,
    text: 'What would feel most meaningful to see by the end of this course?',
    choices: [
      { val: 'A', label: 'Engagement that feels like real connection' },
      { val: 'B', label: 'Showing up more consistently without burning out' },
      { val: 'C', label: 'Energy and nervous system wins (posting without dread)' },
      { val: 'D', label: 'People finding my work and feeling something' },
      { val: 'E', label: 'Alignment (am I actually saying what I mean?)' },
      { val: 'F', label: 'Building a community, not just an audience' }
    ]
  },
  { id: 'q8', type: 'choice', field: 'q8_choice',
    text: 'How do you best receive support?',
    choices: [
      { val: 'A', label: 'Loving accountability — call me in, gently' },
      { val: 'B', label: 'Encouragement and celebration of small wins' },
      { val: 'C', label: 'Direct, honest feedback on my work' },
      { val: 'D', label: 'Quiet witnessing — just knowing someone sees me' },
      { val: 'E', label: 'Space to figure it out myself, with guidance nearby' }
    ]
  },
  { id: 'q9', type: 'text', field: 'q9_text',
    text: 'If you could wave a wand, what would your relationship with sharing your work look and feel like at the end of this course?',
    placeholder: 'Describe the feeling, the freedom, the life...'
  },
  { id: 'q10', type: 'text', field: 'q10_text',
    text: 'What promise are you making to yourself for these 3 weeks?',
    placeholder: 'Write it like you mean it.'
  }
];

// Trial students see this at the end of their 3-week run instead of the
// 12-week harvest. Calibrated for a shorter window: lighter, more
// open-ended, with an explicit "continue with the full course?" question.
// Fields map into the existing self_assessments table — the schema is
// generous enough that we don't need a parallel table. Q7 ("anything else")
// reuses the q1_choice column as plain TEXT storage; SQLite is dynamically
// typed so the column type doesn't constrain us, and the admin View dialog
// renders by question-type lookup not column-name lookup.
const TRIAL_CLOSING_QUESTIONS = [
  { id: 'tq1', type: 'rating', field: 'q2_rating', scaleMin: 0, scaleMax: 10,
    text: 'How do you feel about your relationship with being on camera, three weeks in?',
    low:  '1 = worse than when I started',
    mid:  '0 = the same as when I started',
    high: '10 = something has shifted for the better'
  },
  { id: 'tq2', type: 'text', field: 'q9_text',
    text: "What's changed for you in these 3 weeks?",
    placeholder: "Is there anything that's different for you now than from when we started? Tell me more."
  },
  { id: 'tq3', type: 'text', field: 'q10_text',
    text: "Was there anything I could've done better as a program curator?",
    placeholder: 'Your honesty will help me improve this program for other people in the future.'
  },
  { id: 'tq4', type: 'text', field: 'q11_text',
    text: 'Is there anything from this experience that you intend to keep using?',
    placeholder: 'A practice, a question, a frame to come back to.'
  },
  { id: 'tq5', type: 'text', field: 'q12_text',
    text: 'Where did you get stuck, or where did the program fall short for you?',
    placeholder: 'Honesty here helps the next round of students.'
  },
  { id: 'tq6', type: 'choice', field: 'q8_choice',
    text: 'Would you like to continue with the full 12-week Creative’s Garden?',
    choices: [
      { val: 'A', label: 'Yes — I want to enroll in the full course' },
      { val: 'B', label: "Maybe — I'm interested, tell me more" },
      { val: 'C', label: 'Not right now — but glad I tried this' },
      { val: 'D', label: 'No thank you' },
    ]
  },
  { id: 'tq7', type: 'text', field: 'q1_choice', optional: true,
    text: 'Anything else you want me to know?',
    placeholder: 'Optional.'
  },
];

const CLOSING_QUESTIONS = [
  { id: 'q7', type: 'text', field: 'q7_choices',
    text: 'What surprised you most about this experience?',
    placeholder: 'What caught you off guard, in the best or hardest way?' },
  { id: 'q8', type: 'choice', field: 'q8_choice',
    text: 'What season do you feel you spent the most time in during this course?',
    choices: [
      { val: 'A', label: '🌸 Spring (Curiosity) — receiving, exploring' },
      { val: 'B', label: '☀️ Summer (Create) — making, producing' },
      { val: 'C', label: '🍂 Autumn (Share) — releasing, sharing' },
      { val: 'D', label: '❄️ Winter (Connect) — going deep, connecting' }
    ]
  },
  { id: 'q9', type: 'text', field: 'q9_text',
    text: 'What does showing up online feel like now compared to when you started?',
    placeholder: 'Describe the shift in your own words, even if it\'s subtle.' },
  { id: 'q10', type: 'text', field: 'q10_text',
    text: 'What will you keep doing after this program ends?',
    placeholder: 'Is there anything from this framework that you plan to keep using in the future?' },
  { id: 'q11', type: 'text', field: 'q11_text',
    text: 'What would you tell someone who is standing where you were 12 weeks ago?',
    placeholder: 'What do they need to hear?' },
  { id: 'q12', type: 'text', field: 'q12_text',
    text: 'Is there anything that would have improved your experience in The Creative\'s Garden?',
    placeholder: 'Your honesty helps the garden grow.' }
];

// ─── Mid-course check-in (anonymous feedback) ──────────────────────────────
// Shown as a dashboard card from day 35 (midcourse_unlocked setting) until
// the student submits. Responses are stored without a user_id; completion
// is tracked separately on users.midcourse_submitted_at. The admin email
// shows all responses received so far, anonymously labelled Response 1, 2,
// …, so Julia gets honest feedback she can act on without inferring who.
const MIDCOURSE_QUESTIONS = [
  { id: 'q1', type: 'rating', field: 'q1_rating',
    text: 'Overall, how is the course going for you so far?',
    low: '1 = struggling', high: '10 = exactly what I needed'
  },
  { id: 'q2', type: 'multi', field: 'q2_working', max: 8,
    text: "What's working for you?",
    choices: [
      { val: 'A', label: 'The lessons' },
      { val: 'B', label: 'The recording practice (cuttings)' },
      { val: 'C', label: 'The Greenhouse / goal beds' },
      { val: 'D', label: 'Weekly intentions' },
      { val: 'E', label: 'Seed Packets' },
      { val: 'F', label: 'The pace' },
      { val: 'G', label: 'The garden metaphor' },
      { val: 'H', label: 'The voice and tone of the course' },
    ]
  },
  { id: 'q3', type: 'multi', field: 'q3_resistance', max: 7,
    text: "If you're experiencing any resistance, where is it happening?",
    choices: [
      { val: 'A', label: 'The pace is too fast' },
      { val: 'B', label: 'The pace is too slow' },
      { val: 'C', label: "I'm not sure what to do day-to-day" },
      { val: 'D', label: 'I feel behind' },
      { val: 'E', label: 'Too much work' },
      { val: 'F', label: 'The tech / interface' },
      { val: 'G', label: "Nothing — it's all good" },
    ]
  },
  { id: 'q4', type: 'text', field: 'q4_improvement',
    text: 'Is there anything else I can do to improve your experience?',
    placeholder: 'Anything I could do, change, add, or remove.'
  },
  { id: 'q5', type: 'text', field: 'q5_other',
    text: 'Anything else you want me to know?',
    placeholder: 'This is anonymous to help you feel safe giving me honest feedback. I welcome it!'
  },
];

// True if THIS user's mid-course should be visible — either their own
// course_start_date is ≥35 days ago, or admin force-unlocked globally.
function isMidcourseUnlockedFor(user) {
  // Mid-course doesn't apply to short trials. Purely per-user timeline now —
  // the old global midcourse_unlocked "force on for everyone" override was
  // fine for the single-cohort pilot but is wrong once students start on
  // different dates. If an individual student needs an early unlock, adjust
  // their course_start_date on /admin.
  if (getCourseLengthWeeks(user) < 12) return false;
  const courseStart = db.getUserCourseStartDate(user);
  if (!courseStart) return false;
  // getNow (not Date.now) so time travel can QA this unlock and the day-35
  // boundary lands on the student's wall clock, not the server's.
  const daysDiff = Math.floor((getNow(user).getTime() - new Date(courseStart + 'T00:00:00').getTime()) / 86400000);
  return daysDiff >= 35;
}

app.get('/midcourse', requireAuth, (req, res) => {
  if (req.session.user.role === 'admin') return res.redirect('/dashboard');
  if (!isMidcourseUnlockedFor(req.session.user)) return res.redirect('/dashboard');
  if (db.hasMidcourseBeenSubmittedByUser(req.session.user.id)) return res.redirect('/dashboard');
  res.render('midcourse', {
    title: 'Mid-course check-in',
    page: 'dashboard',
    questions: MIDCOURSE_QUESTIONS,
  });
});

app.post('/api/midcourse/submit', requireAuth, async (req, res) => {
  const user = req.session.user;
  if (user.role === 'admin')         return res.status(403).json({ error: 'Admins do not submit feedback.' });
  if (!isMidcourseUnlockedFor(user)) return res.status(403).json({ error: 'Mid-course is not unlocked yet.' });
  if (db.hasMidcourseBeenSubmittedByUser(user.id)) {
    return res.status(409).json({ error: "You've already submitted your mid-course feedback. Thank you." });
  }
  const { answers } = req.body || {};
  if (!answers || typeof answers !== 'object') return res.status(400).json({ error: 'Missing answers.' });
  for (const q of MIDCOURSE_QUESTIONS) {
    const v = answers[q.field];
    if (q.type === 'rating') {
      const n = Number(v);
      if (!Number.isFinite(n) || n < 1 || n > 10) return res.status(400).json({ error: `Question ${q.id} requires a 1–10 rating.` });
    } else if (q.type === 'multi') {
      if (!Array.isArray(v) || v.length === 0)    return res.status(400).json({ error: `Question ${q.id} requires at least one choice.` });
    } else if (q.type === 'text') {
      if (typeof v !== 'string' || !v.trim())     return res.status(400).json({ error: `Question ${q.id} requires an answer.` });
    }
  }

  // Submit the anonymous row first, then flag the user. The two are in
  // separate statements (not a transaction) so even at the SQL level the
  // INSERT and the UPDATE can't be reconstructed into a single record by a
  // future admin who reads the DB.
  const dayString = toLocalDateString(getNow(user));
  db.submitMidcourseResponse(answers, dayString);
  db.markMidcourseSubmittedForUser(user.id);

  res.json({ ok: true });
  setImmediate(() => notifyAdminOfMidcourseSubmission(user));
});

// Fires after every submission. The email body is name-less by design — the
// PDF cover doesn't include a student name, and Julia gets a cumulative
// snapshot of all anonymous responses received so far. We bypass the usual
// notifyAdminOfMilestone helper because that one is structured around
// per-student emails and adds the student's name to subject + body.
async function notifyAdminOfMidcourseSubmission(submittingUser) {
  try {
    const { done, total } = db.countMidcourseSubmissionsByStudents();
    const pdf = await generateMidcoursePdfBuffer(submittingUser);
    await sendAdminMilestoneEmail({
      studentName: 'A student',  // logged only; not used in subject/body below
      subject:     '[Creative\'s Garden] Anonymous mid-course feedback received',
      bodyLine:    `A student just submitted mid-course feedback (${done} of ${total} students have submitted so far). A copy of all responses received so far is attached.`,
      pdf,
    });
  } catch (err) {
    console.error('[midcourse] notify failed:', err);
  }
}

// Trial students see this at the end of their 3-week run. Unlocks during
// week 3 (day 14 onward — mirrors the full course's harvest at day 77).
// Pilot students never reach this — gated to lengthWeeks < 12.
function isTrialClosingUnlockedFor(user) {
  if (getCourseLengthWeeks(user) >= 12) return false;
  const courseStart = db.getUserCourseStartDate(user);
  if (!courseStart) return false;
  // getNow (not Date.now) so time travel can QA this unlock and the day-14
  // boundary lands on the student's wall clock, not the server's.
  const daysDiff = Math.floor((getNow(user).getTime() - new Date(courseStart + 'T00:00:00').getTime()) / 86400000);
  return daysDiff >= (getCourseLengthWeeks(user) - 1) * 7;
}

app.get('/trial-closing', requireAuth, (req, res) => {
  if (req.session.user.role === 'admin') return res.redirect('/dashboard');
  if (!isTrialClosingUnlockedFor(req.session.user)) return res.redirect('/dashboard');
  if (db.hasTrialClosingBeenSubmittedByUser(req.session.user.id)) return res.redirect('/dashboard');
  res.render('trial-closing', {
    title: 'Closing Reflection',
    page: 'dashboard',
    questions: TRIAL_CLOSING_QUESTIONS,
  });
});

app.post('/api/trial-closing/submit', requireAuth, async (req, res) => {
  const user = req.session.user;
  if (user.role === 'admin')                    return res.status(403).json({ error: 'Admins do not submit reflections.' });
  if (!isTrialClosingUnlockedFor(user))         return res.status(403).json({ error: 'Trial closing is not unlocked yet.' });
  if (db.hasTrialClosingBeenSubmittedByUser(user.id)) {
    return res.status(409).json({ error: 'You have already submitted your trial reflection. Thank you.' });
  }

  const { answers } = req.body || {};
  if (!answers || typeof answers !== 'object') return res.status(400).json({ error: 'Missing answers.' });

  // Validate per question. tq7 is optional (anything-else); the rest are
  // required so the closing reflection feels like a complete artifact.
  for (const q of TRIAL_CLOSING_QUESTIONS) {
    if (q.optional) continue;
    const v = answers[q.field];
    if (q.type === 'rating') {
      const n = Number(v);
      const min = q.scaleMin != null ? q.scaleMin : 1;
      const max = q.scaleMax != null ? q.scaleMax : 10;
      if (!Number.isFinite(n) || n < min || n > max) return res.status(400).json({ error: `Question ${q.id} requires a ${min}–${max} rating.` });
    } else if (q.type === 'multi') {
      if (!Array.isArray(v) || v.length === 0)    return res.status(400).json({ error: `Question ${q.id} requires at least one choice.` });
    } else if (q.type === 'choice') {
      if (typeof v !== 'string' || !v)            return res.status(400).json({ error: `Question ${q.id} requires a selection.` });
    } else if (q.type === 'text') {
      if (typeof v !== 'string' || !v.trim())     return res.status(400).json({ error: `Question ${q.id} requires an answer.` });
    }
  }

  // Build the row in the shape upsertAssessment expects. Multi answers are
  // stored as a comma-joined string to match the existing closing q7_choices
  // convention; that keeps the admin View dialog rendering uniform.
  const row = {};
  for (const q of TRIAL_CLOSING_QUESTIONS) {
    const v = answers[q.field];
    if (q.type === 'rating')        row[q.field] = Number(v);
    else if (q.type === 'multi')    row[q.field] = Array.isArray(v) ? v.join(',') : '';
    else if (q.type === 'choice')   row[q.field] = String(v || '');
    else if (q.type === 'text')     row[q.field] = (typeof v === 'string' ? v : '').trim();
  }
  db.upsertAssessment(user.id, 'trial_closing', row);

  res.json({ ok: true });
  // Fire-and-forget admin notification so Julia gets each closing as it lands.
  setImmediate(() => notifyAdminOfTrialClosing(user, row));
});

async function notifyAdminOfTrialClosing(student, row) {
  try {
    // Format answers as a readable plaintext block. No PDF — keeps this
    // commit small; the admin View dialog renders the full set anyway.
    const lines = TRIAL_CLOSING_QUESTIONS.map(q => {
      const v = row[q.field];
      let label;
      if (q.type === 'choice') {
        const c = q.choices.find(c => c.val === v);
        label = c ? c.label : v;
      } else if (q.type === 'multi') {
        const vals = String(v || '').split(',').filter(Boolean);
        label = vals.map(val => {
          const c = q.choices.find(c => c.val === val);
          return c ? c.label : val;
        }).join(' • ');
      } else if (q.type === 'rating') {
        label = `${v}/10`;
      } else {
        label = v || '(no answer)';
      }
      return `${q.text}\n  → ${label}\n`;
    }).join('\n');

    await sendAdminMilestoneEmail({
      studentName: student.name,
      subject:     `[Creative's Garden] ${student.name} finished the 3-week trial`,
      bodyLine:    `${student.name} just submitted their trial closing reflection.\n\n${lines}`,
    });
  } catch (err) {
    console.error('[trial-closing] notify failed:', err);
  }
}

app.get('/onboarding', requireAuth, (req, res) => {
  // Admin preview: /onboarding?preview=1 lets Julia view the flow (e.g. to
  // check the welcome video) without a test account. It never writes — the
  // onboarding API routes below no-op for admins — so clicking through is safe.
  const adminPreview = req.session.user.role === 'admin' && req.query.preview === '1';
  if (req.session.user.role === 'admin' && !adminPreview) return res.redirect('/dashboard');
  if (req.session.user.onboarding_completed && !adminPreview) return res.redirect('/dashboard');
  res.render('onboarding', {
    title: 'Welcome',
    questions: ASSESSMENT_QUESTIONS,
    adminPreview
  });
});

app.post('/api/onboarding/assessment', requireAuth, (req, res) => {
  // Admin preview never persists — admins have no onboarding data.
  if (req.session.user.role === 'admin') return res.json({ ok: true, preview: true });
  db.upsertAssessment(req.session.user.id, 'opening', req.body);
  res.json({ ok: true });
});

app.post('/api/onboarding/complete', requireAuth, (req, res) => {
  // Admin preview never persists or emails a milestone — just bounce home.
  if (req.session.user.role === 'admin') return res.json({ ok: true, redirect: '/dashboard', preview: true });
  const userId = req.session.user.id;
  db.setOnboardingComplete(userId);
  console.log(`✓ Onboarding complete: user ${userId}`);
  req.session.user.onboarding_completed = true;
  // Consume any signup-time returnTo (e.g. /upgrade?tier=X) so the client
  // hops there instead of the default dashboard.
  const redirectTo = sanitizeReturnTo(req.session.postOnboardingReturnTo);
  if (req.session.postOnboardingReturnTo) delete req.session.postOnboardingReturnTo;
  req.session.save(err => {
    if (err) return res.status(500).json({ error: 'Session save failed.' });
    res.json({ ok: true, redirect: redirectTo || null });
    setImmediate(() => {
      notifyAdminOfMilestone({
        user: req.session.user,
        milestone: 'onboarding_completed',
        subject: `[Creative's Garden] ${req.session.user.name} finished onboarding`,
        bodyLine: `${req.session.user.name} just completed the onboarding self-assessment. A copy of their answers is attached.`,
        generatePdf: () => generateOnboardingPdfBuffer(req.session.user),
      });
    });
  });
});

// ─── Profile ───────────────────────────────────────────────────────────────

app.get('/profile', requireAuth, (req, res) => {
  const profile = db.getUserFullProfile(req.session.user.id);
  res.render('profile', {
    title: 'My Profile',
    page: 'profile',
    profile,
    timezones: TIMEZONES
  });
});

app.post('/api/profile/name', requireAuth, (req, res) => {
  const { display_name } = req.body;
  if (!display_name || !display_name.trim()) return res.status(400).json({ error: 'Name is required.' });
  const name = display_name.trim();
  if (name.length > 100) return res.status(400).json({ error: 'Name must be under 100 characters.' });
  db.updateUserName(req.session.user.id, name);
  req.session.user.name = name;
  req.session.user.avatar_initial = name.charAt(0).toUpperCase();
  req.session.save(err => {
    if (err) return res.status(500).json({ error: 'Session save failed.' });
    res.json({ ok: true, display_name: name, avatar_initial: name.charAt(0).toUpperCase() });
  });
});

app.post('/api/profile/email', requireAuth, async (req, res) => {
  const { current_password, new_email } = req.body;
  if (!current_password || !new_email) return res.status(400).json({ error: 'Current password and new email are required.' });
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(new_email.trim())) return res.status(400).json({ error: 'Invalid email address.' });
  const user = db.getUserByEmail(req.session.user.email);
  const valid = await bcrypt.compare(current_password, user.password_hash);
  if (!valid) return res.status(400).json({ error: 'Current password is incorrect.' });
  try {
    db.updateUserEmail(req.session.user.id, new_email.trim().toLowerCase());
    req.session.user.email = new_email.trim().toLowerCase();
    req.session.save(err => {
      if (err) return res.status(500).json({ error: 'Session save failed.' });
      res.json({ ok: true, email: new_email.trim().toLowerCase() });
    });
  } catch (e) {
    if (e.message && e.message.includes('UNIQUE')) return res.status(409).json({ error: 'That email is already in use.' });
    res.status(500).json({ error: 'Failed to update email.' });
  }
});

// ─── Greenhouse ────────────────────────────────────────────────────────────

// Returns the "current" date for business logic.
// Admins and TEST_ACCOUNT_ALLOWLIST users see simulated_today when it's set.
// All other students always see real time.
function isTimeTravelUser(user) {
  if (!user) return false;
  return user.role === 'admin' || TEST_ACCOUNT_ALLOWLIST.includes(user.email);
}

// Module-level cache so we don't pay the ~0.2ms Intl.DateTimeFormat
// construction cost on every getNow() call. Keyed by IANA timezone
// string — same options for every entry. With a small cohort the cache
// grows to at most one entry per distinct student TZ and stays warm.
const TZ_FORMATTER_CACHE = new Map();
function getTzFormatter(tz) {
  let f = TZ_FORMATTER_CACHE.get(tz);
  if (!f) {
    f = new Intl.DateTimeFormat('en-US', {
      timeZone: tz,
      year: 'numeric', month: '2-digit', day: '2-digit',
      hour: '2-digit', minute: '2-digit', second: '2-digit',
      hour12: false
    });
    TZ_FORMATTER_CACHE.set(tz, f);
  }
  return f;
}

function getNow(user) {
  // Step 1: pick the instant — time travel first, real clock otherwise.
  let now;
  if (isTimeTravelUser(user)) {
    const simulated = db.getSetting('simulated_today');
    if (simulated && simulated.trim()) {
      // The simulated value IS the intended wall-clock date. Return it
      // directly without the TZ re-projection below — projecting a
      // server-local midnight into the user's timezone shifts the date
      // back a day for any user west of the server (e.g. Denver accounts
      // on the UTC Railway box saw "the day before" the banner date).
      return new Date(simulated.trim() + 'T00:00:00');
    }
    now = new Date();
  } else {
    now = new Date();
  }

  // Step 2: re-project the instant into the user's wall-clock TZ so that
  // .getFullYear()/.getMonth()/.getDate() (used by toLocalDateString) reflect
  // the user's local midnight rollover, not the server's. NULL timezone =
  // legacy user who hasn't loaded a page since this shipped — fall back to
  // server time silently.
  const tz = user && user.timezone;
  if (!tz) return now;

  try {
    const parts = getTzFormatter(tz).formatToParts(now);
    const pick = (type) => parts.find(p => p.type === type).value;
    let hour = parseInt(pick('hour'), 10);
    if (hour === 24) hour = 0; // en-US hour12:false reports midnight as "24"
    return new Date(
      parseInt(pick('year'),   10),
      parseInt(pick('month'),  10) - 1,
      parseInt(pick('day'),    10),
      hour,
      parseInt(pick('minute'), 10),
      parseInt(pick('second'), 10)
    );
  } catch (e) {
    // Invalid TZ — likely a corrupted users.timezone. Surface in logs
    // (once per cache miss) and fall back to server time silently.
    return now;
  }
}

// "Today" as a wall-clock YYYY-MM-DD string from a Date — local components
// (not UTC) so it matches how `simulated_today` is parsed and how a student
// experiences their own day.
function toLocalDateString(d) {
  const yyyy = d.getFullYear();
  const mm   = String(d.getMonth() + 1).padStart(2, '0');
  const dd   = String(d.getDate()).padStart(2, '0');
  return `${yyyy}-${mm}-${dd}`;
}

// Map a backdated recorded_date to the curricular season of its course week.
// For backdated cuttings the archive/PDF should group by the SEASON the
// recording belongs to, not the season the row was written in. Returns null
// for dates before course start or beyond week 12.
function seasonForRecordedDate(recordedDateStr, courseStartStr) {
  if (!courseStartStr || !recordedDateStr) return null;
  const days = Math.floor(
    (new Date(recordedDateStr + 'T00:00:00').getTime() -
     new Date(courseStartStr  + 'T00:00:00').getTime()) / 86400000
  );
  if (days < 0) return null;
  return getCurricularSeason(Math.floor(days / 7) + 1);
}

app.get('/greenhouse', requireAuth, (req, res) => {
  const userId = req.session.user.id;

  // Welcome gate: first-visit only
  const hasVisited = db.hasVisitedGreenhouse(userId);
  if (!hasVisited) {
    const courseWeek = getCurrentCourseWeek(req.session.user);
    const weekNumber = courseWeek ? Math.min(courseWeek.weekNumber || 0, 12) || null : null;
    const curricularSeason = getCurricularSeason(weekNumber);
    return res.render('greenhouse', {
      title: 'The Greenhouse',
      page: 'greenhouse',
      state: 'welcome',
      goals: null, growthCheckUnlocked: false, growthCheckDate: null,
      opening: null, closing: null,
      questions: ASSESSMENT_QUESTIONS, closingQuestions: CLOSING_QUESTIONS,
      weekNumber, curricularSeason, isWinterLocked: false,
      emptyBedPositions: null,
      fallowBedNumbers: [],
    });
  }

  // State: beds-empty → tending (based on whether any goals exist)
  const plantedCount = db.getPlantedGoalCount(userId);

  let state;
  if (plantedCount === 0) state = 'beds-empty';
  else                    state = 'tending';

  // Load empty bed positions for beds-empty state
  let emptyBedPositions = null;
  if (state === 'beds-empty') {
    emptyBedPositions = db.getEmptyBedPositions(userId);
  }

  // Fallow beds — the student explicitly chose to leave these empty this
  // season. Needed in both beds-empty and tending states to render the
  // 'Resting this season' card variant.
  const fallowBedNumbers = db.getFallowBedNumbers(userId);

  // Load goals only when tending
  let goals = null;
  if (state === 'tending') {
    goals = db.getGreenhouseGoals(userId);
  }

  // Growth Check: unlocks at day 77 from this user's course start
  const courseStart = db.getUserCourseStartDate(req.session.user);
  let growthCheckUnlocked = false;
  let growthCheckDate = null;
  if (courseStart) {
    const now = getNow(req.session.user);
    const daysDiff = Math.floor((now.getTime() - new Date(courseStart + 'T00:00:00').getTime()) / 86400000);
    growthCheckUnlocked = daysDiff >= 77;
    if (!growthCheckUnlocked) {
      const unlockDay = new Date(new Date(courseStart + 'T00:00:00').getTime() + 77 * 86400000);
      growthCheckDate = unlockDay.toLocaleDateString('en-US', { month: 'long', day: 'numeric' });
    }
  }

  // Load harvest data only when growth check is unlocked
  let opening = null, closing = null;
  if (state === 'tending' && growthCheckUnlocked) {
    opening = db.getAssessment(userId, 'opening');
    closing  = db.getAssessment(userId, 'closing');
  }

  const courseWeek = getCurrentCourseWeek(req.session.user);
  const weekNumber = courseWeek ? Math.min(courseWeek.weekNumber || 0, 12) || null : null;
  const curricularSeason = getCurricularSeason(weekNumber);
  const isWinterLocked = curricularSeason === 'winter' && state === 'beds-empty';

  res.render('greenhouse', {
    title: 'The Greenhouse',
    page: 'greenhouse',
    state,
    goals,
    growthCheckUnlocked,
    growthCheckDate,
    opening,
    closing,
    questions: ASSESSMENT_QUESTIONS,
    closingQuestions: CLOSING_QUESTIONS,
    weekNumber,
    curricularSeason,
    isWinterLocked,
    emptyBedPositions,
    fallowBedNumbers,
  });
});

app.post('/greenhouse/enter', requireAuth, (req, res) => {
  db.markGreenhouseVisited(req.session.user.id);
  res.redirect('/greenhouse');
});

app.get('/greenhouse/plant', requireAuth, (req, res) => {
  const bed = parseInt(req.query.bed);
  if (![1, 2, 3].includes(bed)) return res.redirect('/greenhouse');
  res.render('greenhouse-plant', {
    title: `Plant a goal in Bed ${bed}`,
    page: 'greenhouse',
    bed,
  });
});

// ─── Cuttings archive: read-only, season-grouped reflections (Build 2) ────
// Optional query params (all default-friendly):
//   ?sort=newest|oldest  — day order within each season (default newest)
//   ?filter=all|watched|unwatched|edited|not-edited  — narrow the set
// Season order itself always stays in curricular sequence (Winter → Spring
// → Summer → Autumn) — the course's natural reading direction.
app.get('/greenhouse/cuttings', requireAuth, (req, res) => {
  // Two independent filter axes now: status (watch/edit state) and rating
  // (Tending category). Either can be null (no filter); a value in each
  // narrows the result set as an AND. The old single ?filter= param is
  // gone — status and rating replace it.
  const allowedSort   = new Set(['newest', 'oldest']);
  const allowedStatus = new Set(['watched', 'unwatched', 'edited', 'not-edited']);
  const allowedRating = new Set(['keep-growing', 'return-later', 'compost']);
  const sort   = allowedSort.has(req.query.sort)     ? req.query.sort     : 'newest';
  const status = allowedStatus.has(req.query.status) ? req.query.status   : null;
  const rating = allowedRating.has(req.query.rating) ? req.query.rating   : null;

  let cuttings = db.getCuttingsForUser(req.session.user.id);
  const totalCount = cuttings.length;

  // Status filter (mark state)
  if      (status === 'watched')    cuttings = cuttings.filter(c => c.watched);
  else if (status === 'unwatched')  cuttings = cuttings.filter(c => !c.watched);
  else if (status === 'edited')     cuttings = cuttings.filter(c => c.edited);
  else if (status === 'not-edited') cuttings = cuttings.filter(c => !c.edited);

  // Rating filter (Tending category — DB value 'archive' → 'compost' label)
  if      (rating === 'keep-growing') cuttings = cuttings.filter(c => c.tending_category === 'keep_growing');
  else if (rating === 'return-later') cuttings = cuttings.filter(c => c.tending_category === 'return_later');
  else if (rating === 'compost')      cuttings = cuttings.filter(c => c.tending_category === 'archive');
  else if (rating === 'just-for-me')  cuttings = cuttings.filter(c => c.tending_category === 'just_for_me');

  // Sort within-day order. getCuttingsForUser already returns rows in
  // recorded_date DESC + created_at ASC, so 'newest' is a no-op. For
  // 'oldest', re-sort by (recorded_date ASC, created_at ASC).
  if (sort === 'oldest') {
    cuttings = cuttings.slice().sort((a, b) => {
      const da = a.recorded_date || '';
      const db = b.recorded_date || '';
      if (da !== db) return da < db ? -1 : 1;
      const ca = a.created_at || '';
      const cb = b.created_at || '';
      return ca < cb ? -1 : ca > cb ? 1 : 0;
    });
  }

  // Group by season slug. null/empty -> '_other_' bucket.
  const buckets = {};
  for (const c of cuttings) {
    const key = c.season || '_other_';
    if (!buckets[key]) buckets[key] = [];
    buckets[key].push(c);
  }

  // Render in curricular order: Winter → Spring → Summer → Autumn.
  // Empty seasons omitted entirely (presence-only).
  const ORDER = ['winter', 'spring', 'summer', 'autumn'];
  const seasonGroups = ORDER
    .filter(s => buckets[s] && buckets[s].length)
    .map(s => ({
      season:     s,
      label:      getCurricularSeasonLabel(s),
      descriptor: getCurricularSeasonDescriptor(s),
      entries:    buckets[s],
    }));

  // Null/unknown-season cuttings get a quiet "Other" group at the end —
  // these are post-course entries (past week 12), chronologically newest.
  if (buckets._other_ && buckets._other_.length) {
    seasonGroups.push({
      season:     null,
      label:      'Other',
      descriptor: '',
      entries:    buckets._other_,
    });
  }

  // Reverse season-group order when sorting newest-first so the most recent
  // group leads. Default 'oldest' keeps the course's natural reading order
  // (Winter → Spring → Summer → Autumn → Other).
  if (sort === 'newest') seasonGroups.reverse();

  res.render('greenhouse-cuttings', {
    title: 'Cuttings',
    page: 'greenhouse',
    user: req.session.user,
    totalCount,                    // total before filtering — for the page-level empty state
    filteredCount: cuttings.length, // after filtering — for the empty-filter state
    sort,
    status,
    rating,
    seasonGroups,
    emptyExportNotice: req.query.empty === '1',
  });
});

// ─── Cuttings PDF export ──────────────────────────────────────────────────
// Streams a styled PDF keepsake. Chronological (oldest first), grouped by
// curricular season, presence-only. Renders via Puppeteer through a
// process-wide mutex (see lib/pdf-render.js — Hobby-tier memory safety).
const CUTTINGS_PDF_ASSETS = (() => {
  const fontsDir = path.join(__dirname, 'public', 'fonts');
  const read64 = (f) => fs.readFileSync(path.join(fontsDir, f)).toString('base64');
  const badgePngBase64 = fs.readFileSync(
    path.join(__dirname, 'public', 'images', 'brand', 'creatives-garden-badge-green.png')
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
})();

const SEASON_WEEKS_LABEL = {
  winter: 'Weeks 1–3',
  spring: 'Weeks 4–6',
  summer: 'Weeks 7–9',
  autumn: 'Weeks 10–12',
};

function formatEntryDate(createdAt) {
  try {
    const d = new Date(createdAt.replace(' ', 'T') + 'Z');
    return d.toLocaleDateString('en-US', {
      weekday: 'long', month: 'long', day: 'numeric',
    });
  } catch (_) {
    return createdAt || '';
  }
}

function formatDateRange(earliestStr, latestStr) {
  const a = new Date(earliestStr.replace(' ', 'T') + 'Z');
  const b = new Date(latestStr.replace(' ', 'T') + 'Z');
  const ay = a.getUTCFullYear(), by = b.getUTCFullYear();
  const am = a.getUTCMonth(),    bm = b.getUTCMonth();
  const monthName = (d) => d.toLocaleDateString('en-US', { month: 'long', timeZone: 'UTC' });
  if (ay === by && am === bm) return `${monthName(a)} ${by}`;
  if (ay === by)               return `${monthName(a)} – ${monthName(b)} ${by}`;
  return `${monthName(a)} ${ay} – ${monthName(b)} ${by}`;
}

// Mark a cutting as watched/edited (or unmark it). Latches on by default;
// clicking again un-marks for misclick recovery. Booleans only — no count
// or history.
app.post('/greenhouse/cuttings/:id/mark', requireAuth, (req, res) => {
  const cuttingId = parseInt(req.params.id, 10);
  if (!Number.isInteger(cuttingId) || cuttingId <= 0) {
    return res.status(400).json({ error: 'Invalid cutting id.' });
  }
  const { mark, value } = req.body || {};
  if (mark !== 'watched' && mark !== 'edited') {
    return res.status(400).json({ error: "mark must be 'watched' or 'edited'." });
  }
  const v = value === 1 || value === true || value === '1' ? 1 : 0;
  const changed = db.setCuttingMark(cuttingId, req.session.user.id, mark, v);
  if (changed === 0) {
    // Either the cutting doesn't exist, isn't owned by this user, or the
    // mark was already at v. Treat all three as a no-op success — the
    // client just wants to know the row is in the requested state.
    return res.json({ ok: true, mark, value: v, changed: 0 });
  }
  res.json({ ok: true, mark, value: v, changed });
});

// Hard-delete a cutting. Confirmation lives in the client (browser confirm
// dialog) — by the time we get here, the student has already confirmed.
// Ownership is enforced inside the DB helper via WHERE user_id = ?.
app.post('/greenhouse/cuttings/:id/delete', requireAuth, (req, res) => {
  const cuttingId = parseInt(req.params.id, 10);
  if (!Number.isInteger(cuttingId) || cuttingId <= 0) {
    return res.status(400).json({ error: 'Invalid cutting id.' });
  }
  const changed = db.deleteCutting(cuttingId, req.session.user.id);
  // 0 rows changed = either the row didn't exist or wasn't owned by this
  // user. Treat both as a no-op success — the caller just wants the row
  // gone, and from their perspective it now is.
  res.json({ ok: true, changed });
});

app.get('/greenhouse/cuttings/export', requireAuth, async (req, res) => {
  const userId = req.session.user.id;
  const cuttings = db.getCuttingsForUserChronological(userId);
  if (!cuttings.length) {
    return res.redirect('/greenhouse/cuttings?empty=1');
  }

  // Group by season in curricular order. Empty seasons omitted; null-
  // season entries (pre/post course) collected into a quiet "Other" group
  // at the end so they aren't lost from the keepsake.
  const buckets = {};
  for (const c of cuttings) {
    const key = c.season || '_other_';
    (buckets[key] = buckets[key] || []).push({
      ...c,
      dateLabel: formatEntryDate(c.created_at),
    });
  }
  const ORDER = ['winter', 'spring', 'summer', 'autumn'];
  const seasonGroups = ORDER
    .filter(s => buckets[s])
    .map(s => ({
      label:      getCurricularSeasonLabel(s),
      weeksLabel: SEASON_WEEKS_LABEL[s],
      entries:    buckets[s],
    }));
  if (buckets._other_) {
    seasonGroups.push({ label: 'Other', weeksLabel: '', entries: buckets._other_ });
  }

  const dateRangeLabel = formatDateRange(
    cuttings[0].created_at,
    cuttings[cuttings.length - 1].created_at
  );

  const html = await ejs.renderFile(
    path.join(__dirname, 'views', 'exports', 'cuttings-pdf.ejs'),
    {
      badgePngBase64: CUTTINGS_PDF_ASSETS.badgePngBase64,
      fontFaceCss:    CUTTINGS_PDF_ASSETS.fontFaceCss,
      cuttingPrompts: CUTTING_PROMPTS,  // ejs.renderFile bypasses app.locals
      dateRangeLabel,
      seasonGroups,
    }
  );

  let pdfBuffer;
  try {
    pdfBuffer = await renderHtmlToPdf(html);
  } catch (err) {
    if (err && err.message === 'PDF render queue timeout') {
      return res.status(503).type('text/plain').send(
        'The server is busy generating another PDF right now. Please try again in a moment.'
      );
    }
    console.error('[cuttings export] render failed:', err);
    return res.status(500).type('text/plain').send('Could not generate your PDF. Please try again.');
  }

  const todayFilename = toLocalDateString(getNow(req.session.user));
  res.setHeader('Content-Type', 'application/pdf');
  res.setHeader('Content-Disposition',
    `attachment; filename="creatives-garden-cuttings-${todayFilename}.pdf"`);
  res.setHeader('Cache-Control', 'private, no-store');
  res.send(pdfBuffer);
});

// "Generated June 22, 2026" — single-date label for keepsake PDFs that aren't
// tied to a date range. Same brand voice as the cuttings export's range line.
function formatGeneratedLabel(now) {
  return 'Generated ' + now.toLocaleDateString('en-US', {
    month: 'long', day: 'numeric', year: 'numeric',
  });
}

// ─── Admin milestone notifications ────────────────────────────────────────
// Trigger points (onboarding complete, advanced-to-naming, etc.) call this
// fire-and-forget. The helper itself handles:
//   - admin skip (Julia visiting the page shouldn't email Julia)
//   - atomic claim (each milestone fires at most once per student)
//   - PDF generation (single render behind the renderHtmlToPdf mutex)
//   - email send (Resend, errors logged but never thrown)
// Failures still RECORD the claim so we don't retry on every page visit and
// spam Julia's inbox if Resend has a recurring problem. Console logs surface
// the failure for debugging.
async function notifyAdminOfMilestone({ user, milestone, subject, bodyLine, generatePdf }) {
  if (!user || user.role === 'admin') return;
  const claimed = db.tryClaimMilestone(user.id, milestone);
  if (!claimed) return;
  try {
    const pdf = generatePdf ? await generatePdf() : null;
    await sendAdminMilestoneEmail({
      studentName: user.name,
      subject,
      bodyLine,
      pdf,
    });
  } catch (err) {
    console.error(`[milestone] "${milestone}" failed for user ${user.id} (${user.name}):`, err);
  }
}

// ─── PDF generators per milestone (each returns { filename, buffer }) ─────
// All reuse CUTTINGS_PDF_ASSETS so embedded fonts + the brand badge stay
// consistent across the four keepsake PDFs Julia receives.

function studentFilenameSlug(name) {
  return String(name || 'student').toLowerCase()
    .replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '') || 'student';
}

async function generateAnswersPdfBuffer(user) {
  const allAnswers = db.getSeedPacketAnswersByUser(user.id);
  const userAnswers = {};
  for (const row of allAnswers) userAnswers[row.question_id] = row.answer_text;
  const html = await ejs.renderFile(
    path.join(__dirname, 'views', 'exports', 'seed-packets-answers-pdf.ejs'),
    {
      badgePngBase64: CUTTINGS_PDF_ASSETS.badgePngBase64,
      fontFaceCss:    CUTTINGS_PDF_ASSETS.fontFaceCss,
      angles:         ANGLES,
      userAnswers,
      generatedLabel: formatGeneratedLabel(getNow(user)),
    }
  );
  const buffer = await renderHtmlToPdf(html);
  return {
    filename: `${studentFilenameSlug(user.name)}-answers-${toLocalDateString(getNow(user))}.pdf`,
    buffer,
  };
}

async function generateSeedsPdfBuffer(user) {
  const seeds = db.getSeedPacketSeeds(user.id);
  const html = await ejs.renderFile(
    path.join(__dirname, 'views', 'exports', 'seed-packets-seeds-pdf.ejs'),
    {
      badgePngBase64: CUTTINGS_PDF_ASSETS.badgePngBase64,
      fontFaceCss:    CUTTINGS_PDF_ASSETS.fontFaceCss,
      seeds,
      generatedLabel: formatGeneratedLabel(getNow(user)),
    }
  );
  const buffer = await renderHtmlToPdf(html);
  return {
    filename: `${studentFilenameSlug(user.name)}-seeds-${toLocalDateString(getNow(user))}.pdf`,
    buffer,
  };
}

async function generateOnboardingPdfBuffer(user) {
  const assessment = db.getAssessment(user.id, 'opening');
  const html = await ejs.renderFile(
    path.join(__dirname, 'views', 'exports', 'onboarding-pdf.ejs'),
    {
      badgePngBase64: CUTTINGS_PDF_ASSETS.badgePngBase64,
      fontFaceCss:    CUTTINGS_PDF_ASSETS.fontFaceCss,
      questions:      ASSESSMENT_QUESTIONS,
      assessment,
      studentName:    user.name || 'Student',
      generatedLabel: formatGeneratedLabel(getNow(user)),
    }
  );
  const buffer = await renderHtmlToPdf(html);
  return {
    filename: `${studentFilenameSlug(user.name)}-onboarding-${toLocalDateString(getNow(user))}.pdf`,
    buffer,
  };
}

async function generateMidcoursePdfBuffer(submittingUser) {
  // submittingUser provides timezone for the "generated" label + filename
  // date; the PDF body itself stays anonymous (no name, no email).
  const now = getNow(submittingUser);
  const responses = db.getAllMidcourseResponses();
  // The PDF renderer is name-less by design; we pass the current date as the
  // generated label and let the EJS print "Response 1 / 2 / …" with only the
  // submission day, no time, no user_id.
  const html = await ejs.renderFile(
    path.join(__dirname, 'views', 'exports', 'midcourse-pdf.ejs'),
    {
      badgePngBase64: CUTTINGS_PDF_ASSETS.badgePngBase64,
      fontFaceCss:    CUTTINGS_PDF_ASSETS.fontFaceCss,
      questions:      MIDCOURSE_QUESTIONS,
      responses,
      generatedLabel: formatGeneratedLabel(now),
    }
  );
  const buffer = await renderHtmlToPdf(html);
  return {
    filename: `creatives-garden-midcourse-feedback-${toLocalDateString(now)}.pdf`,
    buffer,
  };
}

async function generateGreenhousePdfBuffer(user) {
  // Build { number, status, goal } for each of the 3 beds. Status is
  // 'planted' if there's an active goal row, 'fallow' if the bed is in
  // fallow_beds, and 'empty' otherwise. (At trigger time both routes
  // gate on areAllBedsResolved, so 'empty' shouldn't appear in practice
  // — but render it defensively.)
  // getGreenhouseGoals returns { 1: {original, replacement}, 2: ..., 3: ... }.
  // Use the active goal (replacement if present, else original) for each bed.
  const goalsMap = db.getGreenhouseGoals(user.id);
  const goalsByBed = {};
  for (let n = 1; n <= 3; n++) {
    const g = goalsMap[n] ? (goalsMap[n].replacement || goalsMap[n].original) : null;
    if (g) goalsByBed[n] = g;
  }
  const fallowSet = new Set(db.getFallowBedNumbers(user.id));
  const beds = [];
  for (let n = 1; n <= 3; n++) {
    if (goalsByBed[n]) {
      beds.push({ number: n, status: 'planted', goal: goalsByBed[n] });
    } else if (fallowSet.has(n)) {
      beds.push({ number: n, status: 'fallow', goal: null });
    } else {
      beds.push({ number: n, status: 'empty', goal: null });
    }
  }
  const html = await ejs.renderFile(
    path.join(__dirname, 'views', 'exports', 'greenhouse-goals-pdf.ejs'),
    {
      badgePngBase64: CUTTINGS_PDF_ASSETS.badgePngBase64,
      fontFaceCss:    CUTTINGS_PDF_ASSETS.fontFaceCss,
      beds,
      studentName:    user.name || 'Student',
      generatedLabel: formatGeneratedLabel(getNow(user)),
    }
  );
  const buffer = await renderHtmlToPdf(html);
  return {
    filename: `${studentFilenameSlug(user.name)}-greenhouse-${toLocalDateString(getNow(user))}.pdf`,
    buffer,
  };
}

// ─── Seed Packets: Answers export ────────────────────────────────────────
// Reuses CUTTINGS_PDF_ASSETS (same fonts + brand badge) and the same
// puppeteer mutex. Same gating as the parent page (requireSynthesisEligible).
app.get('/seed-packets/synthesize/export', requireAuth, requireSynthesisEligible, async (req, res) => {
  const userId = req.session.user.id;
  const allAnswers = db.getSeedPacketAnswersByUser(userId);
  const userAnswers = {};
  for (const row of allAnswers) userAnswers[row.question_id] = row.answer_text;

  const html = await ejs.renderFile(
    path.join(__dirname, 'views', 'exports', 'seed-packets-answers-pdf.ejs'),
    {
      badgePngBase64: CUTTINGS_PDF_ASSETS.badgePngBase64,
      fontFaceCss:    CUTTINGS_PDF_ASSETS.fontFaceCss,
      angles:         ANGLES,
      userAnswers,
      generatedLabel: formatGeneratedLabel(getNow(req.session.user)),
    }
  );

  let pdfBuffer;
  try {
    pdfBuffer = await renderHtmlToPdf(html);
  } catch (err) {
    if (err && err.message === 'PDF render queue timeout') {
      return res.status(503).type('text/plain').send(
        'The server is busy generating another PDF right now. Please try again in a moment.'
      );
    }
    console.error('[seed-packets answers export] render failed:', err);
    return res.status(500).type('text/plain').send('Could not generate your PDF. Please try again.');
  }

  const todayFilename = toLocalDateString(getNow(req.session.user));
  res.setHeader('Content-Type', 'application/pdf');
  res.setHeader('Content-Disposition',
    `attachment; filename="creatives-garden-answers-${todayFilename}.pdf"`);
  res.setHeader('Cache-Control', 'private, no-store');
  res.send(pdfBuffer);
});

// ─── Seed Packets: Seeds export ──────────────────────────────────────────
// Same gating as the parent page (requireAuth — the seeds page itself does
// not require synthesis-eligibility since named seeds may already exist).
app.get('/seed-packets/seeds/export', requireAuth, async (req, res) => {
  const userId = req.session.user.id;
  const seeds = db.getSeedPacketSeeds(userId);

  const html = await ejs.renderFile(
    path.join(__dirname, 'views', 'exports', 'seed-packets-seeds-pdf.ejs'),
    {
      badgePngBase64: CUTTINGS_PDF_ASSETS.badgePngBase64,
      fontFaceCss:    CUTTINGS_PDF_ASSETS.fontFaceCss,
      seeds,
      generatedLabel: formatGeneratedLabel(getNow(req.session.user)),
    }
  );

  let pdfBuffer;
  try {
    pdfBuffer = await renderHtmlToPdf(html);
  } catch (err) {
    if (err && err.message === 'PDF render queue timeout') {
      return res.status(503).type('text/plain').send(
        'The server is busy generating another PDF right now. Please try again in a moment.'
      );
    }
    console.error('[seed-packets seeds export] render failed:', err);
    return res.status(500).type('text/plain').send('Could not generate your PDF. Please try again.');
  }

  const todayFilename = toLocalDateString(getNow(req.session.user));
  res.setHeader('Content-Type', 'application/pdf');
  res.setHeader('Content-Disposition',
    `attachment; filename="creatives-garden-seeds-${todayFilename}.pdf"`);
  res.setHeader('Cache-Control', 'private, no-store');
  res.send(pdfBuffer);
});

app.post('/api/greenhouse/plant-bed', requireAuth, (req, res) => {
  const userId = req.session.user.id;
  const { bed, soil, seed, water, bloom } = req.body;
  const bedNum = parseInt(bed);
  if (![1, 2, 3].includes(bedNum)) {
    return res.status(400).json({ error: 'Invalid bed number.' });
  }
  if (!soil || !seed || !water || !bloom) {
    return res.status(400).json({ error: 'All four fields are required.' });
  }
  const now = getNow(req.session.user);
  const createdAt = now.toISOString().replace('T', ' ').split('.')[0];
  db.upsertGreenhouseGoalFacets(userId, bedNum, { soil, seed, water, bloom }, createdAt, bedNum);
  res.json({ ok: true });
  maybeNotifyGreenhouseSetUp(req.session.user);
});

// Mark a bed as "fallow" (intentionally empty this season). The student can
// reverse this by re-entering the plant form for the bed — upsertGreenhouse-
// GoalFacets clears the fallow row automatically when a plant happens.
app.post('/api/greenhouse/leave-fallow', requireAuth, (req, res) => {
  const bedNum = parseInt(req.body.bed);
  if (![1, 2, 3].includes(bedNum)) {
    return res.status(400).json({ error: 'Invalid bed number.' });
  }
  db.setBedFallow(req.session.user.id, bedNum);
  res.json({ ok: true });
  maybeNotifyGreenhouseSetUp(req.session.user);
});

// Shared trigger for both plant-bed and leave-fallow: only fire the milestone
// when this action made every bed resolved (planted or fallow). Wrapped in
// setImmediate so the response goes out first and the PDF render happens off
// the request path.
function maybeNotifyGreenhouseSetUp(user) {
  if (!user || user.role === 'admin') return;
  if (!db.areAllBedsResolved(user.id)) return;
  setImmediate(() => {
    notifyAdminOfMilestone({
      user,
      milestone: 'greenhouse_goals_set',
      subject: `[Creative's Garden] ${user.name} set up their greenhouse`,
      bodyLine: `${user.name} just resolved all three greenhouse beds. A copy of what they planted (and any beds left fallow) is attached.`,
      generatePdf: () => generateGreenhousePdfBuffer(user),
    });
  });
}

app.post('/api/seeds/:id/keep', requireAuth, (req, res) => res.redirect(301, '/api/goals/' + req.params.id + '/keep'));

app.post('/api/goals/:id/keep', requireAuth, (req, res) => {
  const goalId = parseInt(req.params.id);
  if (!goalId) return res.status(400).json({ error: 'Invalid goal id.' });
  const goal = db.getGoalById(goalId, req.session.user.id);
  if (!goal) return res.status(404).json({ error: 'Goal not found.' });
  const { kept } = req.body;
  db.keepGoal(goalId, req.session.user.id, !!kept);
  res.json({ ok: true });
});

app.post('/api/greenhouse/replace', requireAuth, (req, res) => {
  const { seedNumber, soil, seed, water, bloom } = req.body;
  const num = parseInt(seedNumber);
  if (![1, 2, 3].includes(num)) return res.status(400).json({ error: 'Invalid seed number.' });
  if (!soil || !seed || !water || !bloom) {
    return res.status(400).json({ error: 'All four fields are required.' });
  }
  const now = getNow(req.session.user);
  const createdAt = now.toISOString().replace('T', ' ').split('.')[0];
  db.replaceGoalsFacets(req.session.user.id, num, { soil, seed, water, bloom }, createdAt);
  res.json({ ok: true });
});

app.post('/api/greenhouse/update', requireAuth, (req, res) => {
  const { seedId, soil, seed, water, bloom } = req.body;
  if (!seedId) return res.status(400).json({ error: 'seedId required.' });
  if (!soil || !seed || !water || !bloom) {
    return res.status(400).json({ error: 'All four fields are required.' });
  }
  db.updateGoalByIdFacets(parseInt(seedId), req.session.user.id, { soil, seed, water, bloom });
  res.json({ ok: true });
});

// ─── Tending: the Gardener's weekly review ────────────────────────────────
// The Spring-onward practice of re-watching past cuttings and sorting each
// into keep_growing / return_later / archive. Locked before Week 4. Queue
// lags 3 weeks (Week 4 reviews Week 1) and is week-anchored: only advances
// to Week N+1 once Week N is fully sorted. return_later cuttings resurface
// after 21 days. Pause is always available; the student's optional pause
// note is captured but not surfaced back to them.

app.get('/tending', requireAuth, (req, res) => {
  const user = req.session.user;
  const courseStartDate  = db.getUserCourseStartDate(user);
  const courseWeek       = getCurrentCourseWeek(user, courseStartDate);
  const currentCourseWeek = courseWeek.weekNumber;

  // Gate on effective season — matches what the Greenhouse "Tend Your
  // Cuttings" section shows. A Winter-set student (either pre-Week-4 or
  // deliberately stepped back) doesn't have access. res.locals.showTending
  // is set by the effective-season middleware and covers both cases.
  if (!res.locals.showTending) {
    return res.redirect('/dashboard?tending_locked=1');
  }

  // Optional "load another week" — students can opt in to reviewing a
  // recording-week closer to the present than the default 3-week buffer.
  // ahead=1 → maxReviewable = week-2; ahead=2 → week-1; ahead=3 → today.
  // Capped so a stray URL can't push into the future.
  const ahead = Math.max(0, Math.min(3, parseInt(req.query.ahead, 10) || 0));
  const effectiveCurrent = currentCourseWeek + ahead;
  const maxReviewable = effectiveCurrent - 3;

  // Every backlog week still holding uncurated cuttings, as [{week, count}].
  // Drives the "waiting to review" list so a behind student can jump around.
  const pendingWeeks = db.getTendingPendingWeeks(user.id, maxReviewable, courseStartDate);

  // Default queue = the oldest waiting week. A student can override it with
  // ?week=N, but only to a week that actually has cuttings waiting (guards
  // against a stray/stale URL pointing at an empty or future week).
  const requestedWeek = parseInt(req.query.week, 10);
  const reviewWeek = pendingWeeks.some(w => w.week === requestedWeek)
    ? requestedWeek
    : db.getTendingReviewWeek(user.id, effectiveCurrent, courseStartDate);
  const todayStr   = toLocalDateString(getNow(user));
  const queue      = db.getTendingQueue(user.id, reviewWeek, courseStartDate, todayStr);
  const counts     = db.getTendingDestinationCounts(user.id);
  const showIntro  = !db.hasSeenTendingIntro(user.id);

  // Empty-state discriminator: are there any never-tended cuttings still
  // waiting behind the 3-week (or ahead-adjusted) buffer? True → "load
  // another week" is a live option. False → student has tended every
  // logged cutting; no more surfacing later either.
  const hasMorePending = db.countUncuratedCuttings(user.id) > 0;

  res.render('tending', {
    title: 'Tending',
    page: 'tending',
    user,
    currentCourseWeek,
    reviewWeek,
    queue,
    counts,
    showIntro,
    ahead,
    hasMorePending,
    pendingWeeks,
  });
});

// Save a curation for one cutting. Body: { category, reflection }.
// category is one of keep_growing / return_later / archive. reflection is
// the optional right-side text field (student's while-watching thought).
// Returns { ok, category, resurfaceAfter } — client removes the card and
// advances to the next.
app.post('/tending/curate/:cuttingId', requireAuth, (req, res) => {
  const cuttingId = parseInt(req.params.cuttingId, 10);
  if (!Number.isInteger(cuttingId) || cuttingId <= 0) {
    return res.status(400).json({ error: 'Invalid cutting id.' });
  }
  const { category, reflection } = req.body || {};
  if (!['keep_growing', 'return_later', 'archive', 'just_for_me'].includes(category)) {
    return res.status(400).json({ error: 'Invalid category.' });
  }
  const todayStr = toLocalDateString(getNow(req.session.user));
  try {
    const resurfaceAfter = db.setCuttingCuration(
      cuttingId, req.session.user.id, category, todayStr, reflection
    );
    return res.json({ ok: true, category, resurfaceAfter });
  } catch (e) {
    if (e.code === 'NOT_OWNED') {
      return res.status(404).json({ error: 'Cutting not found.' });
    }
    console.error('setCuttingCuration failed:', e);
    return res.status(500).json({ error: 'Could not save.' });
  }
});

// Record a Tending pause event. Body: { note }. Optional single-line note
// ("what's here today?"). Response is a plain ok — the client redirects
// to /dashboard after receiving it.
app.post('/tending/pause', requireAuth, (req, res) => {
  const { note } = req.body || {};
  db.recordTendingPause(req.session.user.id, note);
  return res.json({ ok: true });
});

// Dismiss the first-time Meet-the-Gardener overlay. Idempotent — the flag
// is a boolean, not a counter.
app.post('/tending/intro-seen', requireAuth, (req, res) => {
  db.markTendingIntroSeen(req.session.user.id);
  return res.json({ ok: true });
});

// ─── Summer — turn Cultivate cuttings into content ────────────────────────
// The main Summer page: student's Cultivate pile on the left, a menu of
// content formats they can pick per cutting. Making a cutting inserts a
// cutting_makes row and reloads so the "Already made as…" chips update.
// The Grove is the downstream view of everything that's been made.

// Summer + Grove are paid-course features (a trial never leaves Winter).
// Pages redirect to /upgrade — same interception point as /watch-yourself —
// and JSON POSTs get a 403 so a hand-crafted request can't slip through.
// Paid students keep always-by-URL access across seasons (see the
// effective-season docblock); admins always pass.
function requireFullCourse(req, res, next) {
  const u = req.session.user;
  if (u.role === 'admin' || (u.course_length_weeks || 12) >= 12) return next();
  if (req.method === 'GET') return res.redirect('/upgrade');
  return res.status(403).json({ error: 'This is part of the full course. Upgrade to unlock it.' });
}
app.use(['/summer', '/grove'], requireAuth, requireFullCourse);

// The Propagation Table (making hub) opens in the making seasons — Summer and
// Autumn — for paid students in (or who've selected) either, plus admins for
// preview. effectiveSeason is forced to 'winter' for non-paid users, so
// summer/autumn already implies paid. Mirrors res.locals.showSummer.
function requireMakingSeason(req, res, next) {
  const u = req.session.user;
  const season = res.locals.effectiveSeason;
  if (u && (u.role === 'admin' || season === 'summer' || season === 'autumn')) return next();
  if (req.method === 'GET') return res.redirect('/greenhouse');
  return res.status(403).json({ error: 'The Propagation Table opens in Summer and Autumn.' });
}

// Cultivated Ideas moved onto the Propagation Table (the unified making hub).
// The old /summer page now redirects there.
app.get('/summer', requireAuth, (req, res) => {
  res.redirect(301, '/greenhouse/propagation-table');
});

// Load the Cultivate pile + formats + makes for the "Cultivated Ideas" section
// that now renders at the bottom of the Propagation Table. Shared by that route.
function loadCultivatedIdeas(userId) {
  const cuttings = db.getCuttingsForUser(userId)
    .filter(c => c.tending_category === 'keep_growing');
  const formats = db.getFormatsForUser(userId);
  const makes = db.getMakesForUser(userId);
  const makesByCutting = new Map();
  for (const m of makes) {
    if (!makesByCutting.has(m.cutting_id)) makesByCutting.set(m.cutting_id, []);
    makesByCutting.get(m.cutting_id).push(m);
  }
  return { cuttings, formats, makesByCutting };
}

// Manage custom formats — student-created + editable + archivable.
// Built-ins are shown read-only for context; the CRUD only touches the
// student's own rows.
app.get('/summer/formats', requireAuth, (req, res) => {
  const builtins = db.getFormatsForUser(req.session.user.id).filter(f => f.user_id === null);
  const customs  = db.getAllCustomFormats(req.session.user.id);
  // Attach a small "usedCount" per custom so the manage UI can decide
  // whether to offer delete (0 uses) or archive-only (≥1).
  for (const c of customs) c.usedCount = db.countMakesForFormat(c.id);
  res.render('summer-formats', {
    title: 'Content formats',
    page: 'summer',
    user: req.session.user,
    builtins,
    customs,
  });
});

app.post('/summer/formats', requireAuth, (req, res) => {
  const { name, emoji, description } = req.body || {};
  if (!name || !String(name).trim()) {
    return res.status(400).json({ error: 'Name required.' });
  }
  const id = db.createCustomFormat(req.session.user.id, name, emoji, description);
  res.json({ ok: true, id });
});

app.post('/summer/formats/:id/edit', requireAuth, (req, res) => {
  const id = parseInt(req.params.id, 10);
  if (!Number.isInteger(id) || id <= 0) {
    return res.status(400).json({ error: 'Invalid format id.' });
  }
  const { name, emoji, description } = req.body || {};
  if (!name || !String(name).trim()) {
    return res.status(400).json({ error: 'Name required.' });
  }
  // Ownership is enforced inside the helper's WHERE user_id = ?.
  const changed = db.updateCustomFormat(id, req.session.user.id, { name, emoji, description });
  res.json({ ok: true, changed });
});

// One route for "get rid of this format" — server decides delete vs
// archive based on whether any cutting_makes rows still reference it.
// Client sees the same success shape either way.
app.post('/summer/formats/:id/remove', requireAuth, (req, res) => {
  const id = parseInt(req.params.id, 10);
  if (!Number.isInteger(id) || id <= 0) {
    return res.status(400).json({ error: 'Invalid format id.' });
  }
  // Guard: format must belong to this user (built-ins have user_id NULL
  // so getFormatById already blocks them via the ownership check).
  const format = db.getFormatById(id, req.session.user.id);
  if (!format || format.user_id === null) {
    return res.status(403).json({ error: 'Format is not yours to remove.' });
  }
  const uses = db.countMakesForFormat(id);
  if (uses > 0) {
    db.archiveCustomFormat(id, req.session.user.id);
    return res.json({ ok: true, action: 'archived', uses });
  }
  db.deleteCustomFormat(id, req.session.user.id);
  res.json({ ok: true, action: 'deleted', uses: 0 });
});

app.post('/summer/formats/:id/unarchive', requireAuth, (req, res) => {
  const id = parseInt(req.params.id, 10);
  if (!Number.isInteger(id) || id <= 0) {
    return res.status(400).json({ error: 'Invalid format id.' });
  }
  db.unarchiveCustomFormat(id, req.session.user.id);
  res.json({ ok: true });
});

// Per-format "how to repurpose into this format" detail page. Built-ins
// only for now — URL is /summer/format/:slug. Custom formats surface
// their name + emoji + one-line "how I use this" note directly on the
// picker, so a dedicated detail page isn't needed for them yet.
app.get('/summer/format/:slug', requireAuth, (req, res) => {
  const format = db.getBuiltinFormatBySlug(req.params.slug);
  if (!format) return res.redirect('/summer');
  // Split detail on blank lines into paragraphs. View wraps each in <p>.
  const paragraphs = (format.detail_content || '')
    .split(/\n\s*\n/)
    .map(s => s.trim())
    .filter(Boolean);
  res.render('summer-format', {
    title: format.name,
    page: 'summer',
    user: req.session.user,
    format,
    paragraphs,
  });
});

// ─── The Propagation Table (Summer challenge) ─────────────────────────────
// Eight formats to make from their idea bank, gentlest → boldest. Open menu:
// every rung available, progress tracked per rung (not per cutting). Page is
// gated to the Summer experience by the /summer requireFullCourse mount above;
// the API POSTs re-apply requireFullCourse since they live under /api.
const PROPAGATION_SLUGS = PROPAGATION_RUNGS.map(r => r.slug);
const splitParas = (s) => (s || '').split(/\n\s*\n/).map(x => x.trim()).filter(Boolean);

// Lives in The Greenhouse's Summer/Autumn making seasons (see requireMakingSeason).
// The 7-rung challenge up top, then the "Cultivated Ideas" pile at the bottom.
app.get('/greenhouse/propagation-table', requireAuth, requireMakingSeason, (req, res) => {
  const userId = req.session.user.id;
  const made = db.getPropagationMakes(userId);
  const rungs = PROPAGATION_RUNGS.map(r => {
    const m = made.get(r.slug);
    return {
      ...r,
      paragraphs: splitParas(r.guide),
      made: !!m,
      fileName: m ? m.file_path : null,
      link: m ? m.published_url : null,
    };
  });
  const { cuttings, formats, makesByCutting } = loadCultivatedIdeas(userId);
  res.render('propagation-table', {
    title: 'The Propagation Table',
    page: 'greenhouse',
    user: req.session.user,
    rungs,
    introParagraphs: splitParas(PROPAGATION_INTRO),
    finishParagraphs: splitParas(PROPAGATION_FINISH),
    doneCount: rungs.filter(r => r.made).length,
    total: rungs.length,
    cuttings,
    formats,
    makesByCutting,
  });
});

// The Propagation Table moved from Summer into The Greenhouse — keep the old
// URL working for anyone who bookmarked it.
app.get('/summer/propagation-table', requireAuth, (req, res) => {
  res.redirect(301, '/greenhouse/propagation-table');
});

// Complete a rung by uploading a file and/or pasting a link (at least one).
// Multipart: field `file` (optional), fields `slug` + `link`.
app.post('/api/propagation-table/mark', requireAuth, requireMakingSeason, (req, res) => {
  propagationUpload.single('file')(req, res, err => {
    if (err) return res.status(400).json({ error: err.message });
    const userId = req.session.user.id;
    const { slug, link } = req.body || {};
    const cleanupUpload = () => { if (req.file) fs.unlink(req.file.path, () => {}); };

    if (!PROPAGATION_SLUGS.includes(slug)) { cleanupUpload(); return res.status(400).json({ error: 'Unknown rung.' }); }
    const fileName = req.file ? req.file.filename : null;
    const linkVal = link && String(link).trim() ? String(link).trim().slice(0, 500) : null;
    if (!fileName && !linkVal) { cleanupUpload(); return res.status(400).json({ error: 'Add a file or a link to complete this one.' }); }

    // Replacing a previous upload? Remove the old file so it doesn't orphan.
    const prev = db.getPropagationMakes(userId).get(slug);
    if (prev && prev.file_path && prev.file_path !== fileName) {
      fs.unlink(path.join(PROPAGATION_DIR, path.basename(prev.file_path)), () => {});
    }
    db.markPropagationRung(userId, slug, null, linkVal, fileName);
    res.json({ ok: true, fileName, link: linkVal, doneCount: db.getPropagationMakes(userId).size, total: PROPAGATION_SLUGS.length });
  });
});

app.post('/api/propagation-table/unmark', requireAuth, requireMakingSeason, (req, res) => {
  const { slug } = req.body || {};
  if (!PROPAGATION_SLUGS.includes(slug)) return res.status(400).json({ error: 'Unknown rung.' });
  const userId = req.session.user.id;
  const prev = db.getPropagationMakes(userId).get(slug);
  if (prev && prev.file_path) {
    fs.unlink(path.join(PROPAGATION_DIR, path.basename(prev.file_path)), () => {});
  }
  db.unmarkPropagationRung(userId, slug);
  res.json({ ok: true, doneCount: db.getPropagationMakes(userId).size, total: PROPAGATION_SLUGS.length });
});

// Serve a student's own propagation upload — auth + ownership + traversal guard.
app.get('/propagation-file/:filename', requireAuth, (req, res) => {
  const filename = req.params.filename;
  if (filename.includes('..') || filename.includes('/') || filename.includes('\\')) {
    return res.status(400).send('Bad request');
  }
  // Ownership: the requester must have a make row pointing at this file.
  const owns = [...db.getPropagationMakes(req.session.user.id).values()].some(m => m.file_path === filename);
  if (!owns) return res.status(404).send('Not found');

  const filepath = path.join(PROPAGATION_DIR, filename);
  if (!filepath.startsWith(path.resolve(PROPAGATION_DIR))) return res.status(400).send('Bad request');
  fs.access(filepath, fs.constants.R_OK, err => {
    if (err) return res.status(404).send('Not found');
    const ext = path.extname(filename).toLowerCase();
    const contentType = {
      '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.png': 'image/png',
      '.gif': 'image/gif', '.webp': 'image/webp',
      '.mp4': 'video/mp4', '.mov': 'video/quicktime', '.webm': 'video/webm',
    }[ext] || 'application/octet-stream';
    res.setHeader('Content-Type', contentType);
    res.setHeader('Cache-Control', 'private, max-age=300');
    fs.createReadStream(filepath).pipe(res);
  });
});

// Record a format-idea for a Cultivate cutting. Body:
//   { formatId, note, created }
// `created` is optional — default 0 = still an idea, 1 = already made.
// New row per POST (history preserved). Only Cultivate cuttings owned by
// the student can be posted against.
app.post('/summer/make/:cuttingId', requireAuth, (req, res) => {
  const cuttingId = parseInt(req.params.cuttingId, 10);
  if (!Number.isInteger(cuttingId) || cuttingId <= 0) {
    return res.status(400).json({ error: 'Invalid cutting id.' });
  }
  const { formatId, note, created } = req.body || {};
  const fid = parseInt(formatId, 10);
  if (!Number.isInteger(fid) || fid <= 0) {
    return res.status(400).json({ error: 'Invalid format id.' });
  }
  // Ownership + eligibility checks — only Cultivate cuttings the student
  // owns can be posted against. Ineligible cases (Sit-with, Compost,
  // other user's cutting) return 403 rather than silently succeeding.
  if (!db.isCuttingCultivateForUser(cuttingId, req.session.user.id)) {
    return res.status(403).json({ error: 'Cutting is not in your Cultivate pile.' });
  }
  const format = db.getFormatById(fid, req.session.user.id);
  if (!format) {
    return res.status(400).json({ error: 'Format not found.' });
  }
  const isCreated = created === true || created === 1 || created === '1';
  const makeId = db.recordCuttingMake(
    cuttingId, req.session.user.id, format.id, note, null, isCreated
  );
  return res.json({ ok: true, makeId, created: isCreated,
                    format: { emoji: format.emoji, name: format.name } });
});

// Flip an existing idea between "idea" and "created." Body: { created }.
// Ownership check inside setCuttingMakeCreated's WHERE clause.
app.post('/summer/make/:makeId/toggle-created', requireAuth, (req, res) => {
  const makeId = parseInt(req.params.makeId, 10);
  if (!Number.isInteger(makeId) || makeId <= 0) {
    return res.status(400).json({ error: 'Invalid make id.' });
  }
  const { created } = req.body || {};
  const value = created === true || created === 1 || created === '1';
  const changed = db.setCuttingMakeCreated(makeId, req.session.user.id, value);
  if (changed === 0) return res.status(404).json({ error: 'Not found.' });
  return res.json({ ok: true, created: value });
});

// Hard-delete a format idea. Confirmation is on the client (browser
// confirm dialog). Ownership enforced inside the DB helper's WHERE.
app.post('/summer/make/:makeId/delete', requireAuth, (req, res) => {
  const makeId = parseInt(req.params.makeId, 10);
  if (!Number.isInteger(makeId) || makeId <= 0) {
    return res.status(400).json({ error: 'Invalid make id.' });
  }
  const changed = db.deleteCuttingMake(makeId, req.session.user.id);
  // 0 rows changed = row didn't exist or wasn't owned. Treat as no-op
  // success so the client can reload without a scary error.
  return res.json({ ok: true, changed });
});

// ─── The Grove — where Cultivate cuttings that have been "made" live ──────
// Summer's downstream view: every cutting_makes row rendered as a card
// showing what the cutting was, what format it became, and when. Fully
// accessible before Summer — it just shows an empty state until the
// student starts making things. Fall will add published_url editing here.

app.get('/grove', requireAuth, (req, res) => {
  const userId  = req.session.user.id;
  const entries = db.getGroveEntries(userId);
  // Group published links by make_id in JS so each Grove entry can
  // render its own list inline without an extra DB round-trip per row.
  const links   = db.getMakeLinksForUser(userId);
  const linksByMake = new Map();
  for (const l of links) {
    if (!linksByMake.has(l.make_id)) linksByMake.set(l.make_id, []);
    linksByMake.get(l.make_id).push(l);
  }
  res.render('grove', {
    title: 'Share the Bounty',
    page: 'grove',
    user: req.session.user,
    entries,
    linksByMake,
  });
});

// Add a published link to a created make. Body: { url, label }. url is
// required; label is an optional platform tag ("Instagram", etc.). The
// share reflection lives on the make (see /grove/make/:makeId/share-note),
// not on each link.
app.post('/grove/link/:makeId', requireAuth, (req, res) => {
  const makeId = parseInt(req.params.makeId, 10);
  if (!Number.isInteger(makeId) || makeId <= 0) {
    return res.status(400).json({ error: 'Invalid make id.' });
  }
  const { url, label } = req.body || {};
  if (!url || !String(url).trim()) {
    return res.status(400).json({ error: 'URL required.' });
  }
  try {
    const id = db.createCuttingMakeLink(makeId, req.session.user.id, url, label);
    // If this was the first link on this make, assign a random stem
    // variant (1-12) so the bouquet blooms a flower. Subsequent links
    // leave the existing stem alone. `changes` = 1 only when a variant
    // was newly written, meaning this is the "bloom" moment.
    const newVariant = Math.floor(Math.random() * 12) + 1;
    const changed = db.setCuttingMakeStemVariantIfNull(makeId, req.session.user.id, newVariant);
    return res.json({ ok: true, id, stemVariant: changed === 1 ? newVariant : null });
  } catch (e) {
    return res.status(400).json({ error: e.message || 'Could not save.' });
  }
});

// Delete a single published link.
app.post('/grove/link/:linkId/delete', requireAuth, (req, res) => {
  const linkId = parseInt(req.params.linkId, 10);
  if (!Number.isInteger(linkId) || linkId <= 0) {
    return res.status(400).json({ error: 'Invalid link id.' });
  }
  db.deleteCuttingMakeLink(linkId, req.session.user.id);
  return res.json({ ok: true });
});

// Save the per-entry share reflection ("what was it like to share
// this?"). Body: { note }. Empty string clears the note.
app.post('/grove/make/:makeId/share-note', requireAuth, (req, res) => {
  const makeId = parseInt(req.params.makeId, 10);
  if (!Number.isInteger(makeId) || makeId <= 0) {
    return res.status(400).json({ error: 'Invalid make id.' });
  }
  const { note } = req.body || {};
  const changed = db.setCuttingMakeShareNote(makeId, req.session.user.id, note);
  if (changed === 0) return res.status(404).json({ error: 'Not found.' });
  return res.json({ ok: true });
});

// Toggle cohort-share on a make. Body: { shared: bool, discord_url?: string }.
// Same "first share blooms a flower" pattern as POST /grove/link/:makeId —
// if this share turns cohort_shared from 0→1 AND the make has no stem
// variant yet, assign a random 1-12 and return it so the client can
// trigger the bloom animation. Un-sharing (shared:false) clears the URL
// and timestamp but does NOT remove the stem variant (the bouquet already
// bloomed once — we don't take that back on un-share).
app.post('/grove/make/:makeId/cohort-share', requireAuth, (req, res) => {
  const makeId = parseInt(req.params.makeId, 10);
  if (!Number.isInteger(makeId) || makeId <= 0) {
    return res.status(400).json({ error: 'Invalid make id.' });
  }
  const { shared, discord_url } = req.body || {};
  const userId = req.session.user.id;
  const changed = db.setCuttingMakeCohortShare(makeId, userId, !!shared, discord_url);
  if (changed === 0) return res.status(404).json({ error: 'Not found.' });
  let stemVariant = null;
  if (shared) {
    const newVariant = Math.floor(Math.random() * 12) + 1;
    const varChanged = db.setCuttingMakeStemVariantIfNull(makeId, userId, newVariant);
    if (varChanged === 1) stemVariant = newVariant;
  }
  return res.json({ ok: true, stemVariant });
});

// Flip the just_for_me flag on a make. When true, /grove hides the
// links UI for that entry.
app.post('/grove/make/:makeId/just-for-me', requireAuth, (req, res) => {
  const makeId = parseInt(req.params.makeId, 10);
  if (!Number.isInteger(makeId) || makeId <= 0) {
    return res.status(400).json({ error: 'Invalid make id.' });
  }
  const { justForMe } = req.body || {};
  const value = justForMe === true || justForMe === 1 || justForMe === '1';
  const changed = db.setCuttingMakeJustForMe(makeId, req.session.user.id, value);
  if (changed === 0) return res.status(404).json({ error: 'Not found.' });
  return res.json({ ok: true, justForMe: value });
});

// ─── Harvest ───────────────────────────────────────────────────────────────

app.get('/harvest', requireAuth, (req, res) => {
  res.redirect('/greenhouse');
});

app.post('/api/harvest', requireAuth, (req, res) => {
  const courseStart = db.getUserCourseStartDate(req.session.user);
  let growthCheckUnlocked = false;
  if (courseStart) {
    const now = getNow(req.session.user);
    const daysDiff = Math.floor((now.getTime() - new Date(courseStart + 'T00:00:00').getTime()) / 86400000);
    growthCheckUnlocked = daysDiff >= 77;
  }
  if (!growthCheckUnlocked) return res.status(403).json({ error: 'Growth Check not yet available.' });
  db.upsertAssessment(req.session.user.id, 'closing', req.body);
  res.json({ ok: true });
});

// ─── Account ───────────────────────────────────────────────────────────────

// /account was merged into /profile — keep the path working for old links/
// bookmarks by redirecting. All settings now live on the single profile page.
app.get('/account', requireAuth, (req, res) => res.redirect(301, '/profile'));

app.post('/api/account/details', requireAuth, async (req, res) => {
  const { name, email } = req.body;
  if (!name || !email) return res.status(400).json({ error: 'Name and email are required.' });
  try {
    db.updateUserDetails(req.session.user.id, name.trim(), email.trim().toLowerCase());
    req.session.user.name         = name.trim();
    req.session.user.email        = email.trim().toLowerCase();
    req.session.user.avatar_initial = name.trim().charAt(0).toUpperCase();
    req.session.save(err => {
      if (err) return res.status(500).json({ error: 'Session save failed.' });
      res.json({ ok: true });
    });
  } catch (e) {
    if (e.message && e.message.includes('UNIQUE')) return res.status(409).json({ error: 'That email is already in use.' });
    res.status(500).json({ error: 'Failed to update details.' });
  }
});

app.post('/api/account/password', requireAuth, async (req, res) => {
  const { current_password, new_password, confirm_password } = req.body;
  if (!current_password || !new_password || !confirm_password) {
    return res.status(400).json({ error: 'All password fields are required.' });
  }
  if (new_password !== confirm_password) {
    return res.status(400).json({ error: 'New passwords do not match.' });
  }
  if (new_password.length < 8) {
    return res.status(400).json({ error: 'Password must be at least 8 characters.' });
  }
  if (!/[0-9!@#$%^&*()\-_=+\[\]{};:'",.<>/?\\|`~]/.test(new_password)) {
    return res.status(400).json({ error: 'Password must include at least one number or special character.' });
  }
  const user = db.getUserByEmail(req.session.user.email);
  const valid = await bcrypt.compare(current_password, user.password_hash);
  if (!valid) return res.status(400).json({ error: 'Current password is incorrect.' });
  db.updateUserPassword(req.session.user.id, new_password);
  res.json({ ok: true });
});

app.post('/api/account/photo', requireAuth, (req, res) => {
  upload.single('photo')(req, res, err => {
    if (err) return res.status(400).json({ error: err.message });
    if (!req.file) return res.status(400).json({ error: 'No file uploaded.' });
    const existing = db.getUserFullProfile(req.session.user.id);
    if (existing && existing.profile_photo) {
      fs.unlink(path.join(AVATAR_DIR, path.basename(existing.profile_photo)), () => {});
    }
    const photoPath = `/avatars/${req.file.filename}`;
    db.updateProfilePhoto(req.session.user.id, photoPath);
    req.session.user.profile_photo = photoPath;
    req.session.save(err2 => {
      if (err2) return res.status(500).json({ error: 'Session save failed.' });
      res.json({ ok: true, photoPath });
    });
  });
});

app.delete('/api/account/photo', requireAuth, (req, res) => {
  const existing = db.getUserFullProfile(req.session.user.id);
  if (existing && existing.profile_photo) {
    fs.unlink(path.join(AVATAR_DIR, path.basename(existing.profile_photo)), () => {});
  }
  db.removeProfilePhoto(req.session.user.id);
  req.session.user.profile_photo = null;
  req.session.save(err => {
    if (err) return res.status(500).json({ error: 'Session save failed.' });
    res.json({ ok: true });
  });
});

app.post('/api/account/timezone', requireAuth, (req, res) => {
  const { timezone } = req.body;
  if (!TIMEZONES.some(t => t.value === timezone)) return res.status(400).json({ error: 'Invalid timezone.' });
  db.updateUserTimezone(req.session.user.id, timezone);
  res.json({ ok: true });
});

app.post('/api/account/preference', requireAuth, (req, res) => {
  const { key, value } = req.body;
  try {
    db.updateUserPreference(req.session.user.id, key, value);
    res.json({ ok: true });
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
});

// Daily reminder lives outside the generic preference helper because `hour`
// is an integer (0–23), not a boolean — and the client wants to update both
// fields atomically when the student first enables the reminder.
app.post('/api/account/daily-reminder', requireAuth, (req, res) => {
  const { enabled, hour } = req.body || {};
  if (enabled !== undefined) db.setDailyReminderEnabled(req.session.user.id, !!enabled);
  if (hour    !== undefined) db.setDailyReminderHour(req.session.user.id, hour);
  res.json({ ok: true });
});

// Weekly reminder — same shape as the daily one (enabled + hour). Fixed to
// Mondays for now; the email channel is a separate boolean pref.
app.post('/api/account/weekly-reminder', requireAuth, (req, res) => {
  const { enabled, hour } = req.body || {};
  if (enabled !== undefined) db.setWeeklyReminderEnabled(req.session.user.id, !!enabled);
  if (hour    !== undefined) db.setWeeklyReminderHour(req.session.user.id, hour);
  res.json({ ok: true });
});

// ─── Resources ─────────────────────────────────────────────────────────────

app.get('/resources', requireAuth, (req, res) => {
  res.render('resources', { title: 'Resources', page: 'resources' });
});

// ─── The Creative Block Buster ─────────────────────────────────────────────
// Open to every student (blocks around getting on camera hit hardest early).
// Organized as categories → blocks → "ways through." Built-in content comes
// from lib/creative-blocks.js; each student layers their own options, their
// own blocks (filed into a category), and hides on top (block_buster_*
// tables). Built-in blocks keep their slug as the key; custom blocks use
// 'custom-<id>'.
app.get('/block-buster', requireAuth, (req, res) => {
  const userId = req.session.user.id;
  const added  = db.getAddedOptionsByBlock(userId);  // Map(key → [{id,text}])
  const hidden = db.getHiddenBlockKeys(userId);       // Set(key)
  const custom = db.getCustomBlocks(userId);          // [{id,title,category}]
  const bustCounts = db.getBustCountsByBlock(userId); // Map(key → times busted)

  // Group custom blocks by category slug so we can append them under the
  // matching built-in category. Anything with an unknown/blank category
  // falls under the first category as a safe default.
  const customByCat = new Map();
  for (const c of custom) {
    const cat = CATEGORY_SLUGS.includes(c.category) ? c.category : CATEGORY_SLUGS[0];
    if (!customByCat.has(cat)) customByCat.set(cat, []);
    customByCat.get(cat).push(c);
  }

  const buildBlock = (key, title, isCustom, defaultOptions, customId) => ({
    key, title, isCustom, customId: customId || null,
    defaultOptions,
    addedOptions: added.get(key) || [],
    hidden:       hidden.has(key),
    bustCount:    bustCounts.get(key) || 0,
  });

  const categories = CREATIVE_BLOCK_CATEGORIES.map(cat => {
    const builtinBlocks = cat.blocks.map(b =>
      buildBlock(b.slug, b.title, false, b.options));
    const customBlocks = (customByCat.get(cat.slug) || []).map(c =>
      buildBlock('custom-' + c.id, c.title, true, [], c.id));
    return {
      slug: cat.slug,
      name: cat.name,
      descriptor: cat.descriptor,
      blocks: [...builtinBlocks, ...customBlocks],
    };
  });

  res.render('block-buster', {
    title: 'The Creative Block Buster',
    page:  'resources',
    categories,
    bustedCount: db.getBustTotal(userId),
  });
});

// Add a personal option to any block (built-in slug or custom-<id> key).
app.post('/api/block-buster/option', requireAuth, (req, res) => {
  const { blockKey, text } = req.body || {};
  if (!blockKey || !String(blockKey).trim()) return res.status(400).json({ error: 'Missing block.' });
  if (!text || !String(text).trim())         return res.status(400).json({ error: 'Write an option first.' });
  const id = db.addBlockOption(req.session.user.id, String(blockKey).trim(), text);
  res.json({ ok: true, id });
});

// Delete one of the student's own added options.
app.post('/api/block-buster/option/:id/delete', requireAuth, (req, res) => {
  const optId = parseInt(req.params.id, 10);
  if (!Number.isInteger(optId)) return res.status(400).json({ error: 'Invalid option.' });
  db.deleteBlockOption(optId, req.session.user.id);
  res.json({ ok: true });
});

// Create a student's own block, filed into one of the built-in categories.
app.post('/api/block-buster/block', requireAuth, (req, res) => {
  const { title, category } = req.body || {};
  if (!title || !String(title).trim()) return res.status(400).json({ error: 'Give the block a name.' });
  if (!CATEGORY_SLUGS.includes(category)) return res.status(400).json({ error: 'Choose a category.' });
  const id = db.addCustomBlock(req.session.user.id, title, category);
  res.json({ ok: true, id, key: 'custom-' + id, category });
});

// Delete a student's own block (and its options).
app.post('/api/block-buster/block/:id/delete', requireAuth, (req, res) => {
  const blockId = parseInt(req.params.id, 10);
  if (!Number.isInteger(blockId)) return res.status(400).json({ error: 'Invalid block.' });
  db.deleteCustomBlock(blockId, req.session.user.id);
  res.json({ ok: true });
});

// Hide / unhide a block for this student.
app.post('/api/block-buster/hide', requireAuth, (req, res) => {
  const { blockKey, hidden } = req.body || {};
  if (!blockKey || !String(blockKey).trim()) return res.status(400).json({ error: 'Missing block.' });
  db.setBlockHidden(req.session.user.id, String(blockKey).trim(), !!hidden);
  res.json({ ok: true });
});

// Bust a block — logs a NEW breakthrough every time (a block can be busted
// repeatedly). optionText + reflection record this particular breakthrough.
app.post('/api/block-buster/bust', requireAuth, (req, res) => {
  const { blockKey, optionText, reflection } = req.body || {};
  if (!blockKey || !String(blockKey).trim()) return res.status(400).json({ error: 'Missing block.' });
  const text = optionText ? String(optionText).slice(0, 400) : null;
  const reflect = reflection ? String(reflection).slice(0, 2000) : null;
  const { count } = db.bustBlock(req.session.user.id, String(blockKey).trim(), text, reflect);
  res.json({ ok: true, bustCount: count, total: db.getBustTotal(req.session.user.id) });
});

// Delete one breakthrough from the log (from the Breakthroughs page).
app.post('/api/block-buster/breakthrough/:id/delete', requireAuth, (req, res) => {
  const id = parseInt(req.params.id, 10);
  if (!Number.isInteger(id)) return res.status(400).json({ error: 'Invalid entry.' });
  db.deleteBreakthrough(req.session.user.id, id);
  res.json({ ok: true, total: db.getBustTotal(req.session.user.id) });
});

// Breakthroughs — the running log of blocks a student has busted, the way
// through they tried, and what they wrote about how it went. Block titles are
// resolved here (built-ins from lib, custom from block_buster_blocks).
app.get('/block-buster/breakthroughs', requireAuth, (req, res) => {
  const userId = req.session.user.id;
  const titleByKey = new Map();
  const catByKey = new Map();
  CREATIVE_BLOCK_CATEGORIES.forEach(cat => {
    cat.blocks.forEach(b => { titleByKey.set(b.slug, b.title); catByKey.set(b.slug, cat.name); });
  });
  db.getCustomBlocks(userId).forEach(c => { titleByKey.set('custom-' + c.id, c.title); });

  const breakthroughs = db.getBreakthroughs(userId).map(r => ({
    id: r.id,
    title: titleByKey.get(r.block_key) || 'A block you added',
    category: catByKey.get(r.block_key) || null,
    optionText: r.option_text,
    reflection: r.reflection,
    bustedAt: r.busted_at,
  }));

  res.render('breakthroughs', {
    title: 'Your Breakthroughs',
    page: 'resources',
    breakthroughs,
  });
});

// ─── Watch Yourself — Spring+ only ─────────────────────────────────────────
// A guide to turning your inner critic into a helpful gardener. Available
// once the student reaches Spring (Week 4+). Pre-Spring / trial users are
// redirected to /upgrade so the paywall is the interception point, not a
// silent 404. The card on /resources shows a locked preview for them.
app.get('/watch-yourself', requireAuth, (req, res) => {
  if (!res.locals.showTending) return res.redirect('/upgrade');
  res.render('watch-yourself', { title: 'Watch Yourself', page: 'resources' });
});

// ─── Seed Packets ───────────────────────────────────────────────────────────

app.get('/seed-packets', requireAuth, (req, res) => {
  const userId = req.session.user.id;
  const counts = db.getSeedPacketAnswerCounts(userId);
  const totalAnswered = db.getSeedPacketTotalAnswered(userId);
  const userSeeds = db.getSeedPacketSeeds(userId);
  res.render('seed-packets', {
    title: 'Seed Packets',
    page: 'resources',
    angles: ANGLES,
    counts,
    totalAnswered,
    userSeeds,
  });
});

// ─── Seed Packets: 301 redirects for old URLs ───────────────────────────────

app.get('/curiosity-map', (req, res) => res.redirect(301, '/seed-packets'));
app.get('/curiosity-map/synthesize', (req, res) => res.redirect(301, '/seed-packets/synthesize'));
app.get('/curiosity-map/synthesize/observations', (req, res) => res.redirect(301, '/seed-packets/synthesize'));
app.get('/curiosity-map/synthesize/notice', (req, res) => res.redirect(301, '/seed-packets/synthesize/name'));
app.get('/curiosity-map/synthesize/name', (req, res) => res.redirect(301, '/seed-packets/synthesize/name'));
app.get('/curiosity-map/threads', (req, res) => res.redirect(301, '/seed-packets/seeds'));
app.get('/seed-packets/synthesize/observations', (req, res) => res.redirect(301, '/seed-packets/synthesize'));
app.get('/seed-packets/synthesize/notice', (req, res) => res.redirect(301, '/seed-packets/synthesize/name'));
app.get('/seed-packets/threads', (req, res) => res.redirect(301, '/seed-packets/seeds'));
app.get('/curiosity-map/:angleId/:questionId', (req, res) =>
  res.redirect(301, `/seed-packets/${req.params.angleId}/${req.params.questionId}`));
app.get('/curiosity-map/:angleId', (req, res) =>
  res.redirect(301, `/seed-packets/${req.params.angleId}`));

// ─── Seed Packets: synthesis flow ───────────────────────────────────────────

function requireSynthesisEligible(req, res, next) {
  if (db.getSeedPacketTotalAnswered(req.session.user.id) < 10) {
    return res.redirect('/seed-packets');
  }
  next();
}

app.get('/seed-packets/synthesize', requireAuth, requireSynthesisEligible, (req, res) => {
  const userId = req.session.user.id;
  const allAnswers = db.getSeedPacketAnswersByUser(userId);
  const userAnswers = {};
  for (const row of allAnswers) userAnswers[row.question_id] = row.answer_text;
  const highlights = db.getSeedPacketHighlights(userId);
  res.render('seed-packets-synthesize-read', {
    title: 'Begin Synthesizing',
    page: 'resources',
    angles: ANGLES,
    userAnswers,
    highlights,
  });
});

app.get('/seed-packets/synthesize/name', requireAuth, requireSynthesisEligible, (req, res) => {
  const userId = req.session.user.id;
  const existingSeeds = db.getSeedPacketSeeds(userId);
  const highlights = db.getSeedPacketHighlights(userId);
  res.render('seed-packets-synthesize-name', {
    title: 'Name Your Seeds',
    page: 'resources',
    existingSeeds,
    highlights,
  });
  setImmediate(() => {
    notifyAdminOfMilestone({
      user: req.session.user,
      milestone: 'advanced_to_naming',
      subject: `[Creative's Garden] ${req.session.user.name} just moved on to naming their seeds`,
      bodyLine: `${req.session.user.name} just moved from answering questions to naming their seeds. A copy of their answers so far is attached.`,
      generatePdf: () => generateAnswersPdfBuffer(req.session.user),
    });
  });
});

app.get('/seed-packets/seeds', requireAuth, (req, res) => {
  const userId = req.session.user.id;
  const seeds = db.getSeedPacketSeeds(userId);
  const highlights = db.getSeedPacketHighlights(userId);
  let lastUpdated = null;
  if (seeds.length) {
    const latest = seeds.reduce((a, b) => (a.updated_at > b.updated_at ? a : b));
    lastUpdated = latest.updated_at ? String(latest.updated_at).slice(0, 10) : null;
  }
  res.render('seed-packets-seeds', {
    title: 'Your Seeds',
    page: 'resources',
    seeds,
    highlights,
    lastUpdated,
  });
  // Trigger only when the student has actually named at least one seed —
  // otherwise the first visit (before they've done any naming) would email
  // an empty seeds PDF.
  if (seeds.length > 0) {
    setImmediate(() => {
      notifyAdminOfMilestone({
        user: req.session.user,
        milestone: 'advanced_to_seeds_view',
        subject: `[Creative's Garden] ${req.session.user.name} just moved on to viewing their seeds`,
        bodyLine: `${req.session.user.name} just finished naming their seeds and moved on to viewing them. A copy of their seeds is attached.`,
        generatePdf: () => generateSeedsPdfBuffer(req.session.user),
      });
    });
  }
});

// ─── Seed Packets API: highlights ───────────────────────────────────────────

app.post('/api/seed-packets/highlights', requireAuth, (req, res) => {
  const { questionId, highlightedText } = req.body;
  if (!ALL_QUESTION_IDS.has(questionId)) return res.status(400).json({ error: 'Invalid question.' });
  const text = (highlightedText || '').trim();
  if (!text) return res.status(400).json({ error: 'Highlight text is required.' });
  const result = db.addSeedPacketHighlight(req.session.user.id, questionId, text);
  res.json({ id: result.lastInsertRowid, questionId, highlightedText: text });
});

app.delete('/api/seed-packets/highlights/:id', requireAuth, (req, res) => {
  db.removeSeedPacketHighlight(Number(req.params.id), req.session.user.id);
  res.json({ ok: true });
});

// ─── Seed Packets API: seeds ─────────────────────────────────────────────────

app.post('/api/seed-packets/seeds', requireAuth, (req, res) => {
  const userId = req.session.user.id;
  const name = String(req.body.name || '').trim();
  if (!name) return res.status(400).json({ error: 'Seed name is required.' });
  const seed = db.createSeedPacketSeed(
    userId, name,
    req.body.description || '',
    Array.isArray(req.body.bullets) ? req.body.bullets : [],
    Number(req.body.sortOrder) || 0,
    req.body.application || ''
  );
  res.json(seed);
});

app.put('/api/seed-packets/seeds/:id', requireAuth, (req, res) => {
  const name = String(req.body.name || '').trim();
  if (!name) return res.status(400).json({ error: 'Seed name is required.' });
  db.updateSeedPacketSeed(
    Number(req.params.id), req.session.user.id,
    name,
    req.body.description || '',
    Array.isArray(req.body.bullets) ? req.body.bullets : [],
    Number(req.body.sortOrder) || 0,
    req.body.application || ''
  );
  res.json({ ok: true });
});

app.delete('/api/seed-packets/seeds/:id', requireAuth, (req, res) => {
  db.deleteSeedPacketSeed(Number(req.params.id), req.session.user.id);
  res.json({ ok: true });
});

app.get('/seed-packets/:angleId', requireAuth, (req, res) => {
  const angle = getAngle(req.params.angleId);
  if (!angle) return res.redirect('/seed-packets');
  const userId = req.session.user.id;
  const allAnswers = db.getSeedPacketAnswersByUser(userId);
  const questionIds = new Set(angle.questions.map(q => q.id));
  const userAnswers = {};
  for (const row of allAnswers) {
    if (questionIds.has(row.question_id)) userAnswers[row.question_id] = row.answer_text;
  }
  res.render('seed-packets-angle', {
    title: angle.name,
    page: 'resources',
    angle,
    userAnswers
  });
});

app.get('/seed-packets/:angleId/:questionId', requireAuth, (req, res) => {
  const { angleId, questionId } = req.params;
  const angle = getAngle(angleId);
  if (!angle) return res.redirect('/seed-packets');
  const question = getQuestion(angleId, questionId);
  if (!question) return res.redirect(`/seed-packets/${angleId}`);
  const existingAnswer = db.getSeedPacketAnswer(req.session.user.id, questionId);
  res.render('seed-packets-question', {
    title: 'Seed Packets',
    page: 'resources',
    angle,
    question,
    existingAnswer
  });
});

app.post('/seed-packets/:angleId/:questionId', requireAuth, (req, res) => {
  const { angleId, questionId } = req.params;
  const angle = getAngle(angleId);
  if (!angle) return res.redirect('/seed-packets');
  const question = getQuestion(angleId, questionId);
  if (!question) return res.redirect(`/seed-packets/${angleId}`);
  const answerText = (req.body.answer_text || '').trim();
  if (answerText) {
    db.upsertSeedPacketAnswer(req.session.user.id, questionId, answerText);
  }
  res.redirect(`/seed-packets/${angleId}`);
});

// ─── Admin ─────────────────────────────────────────────────────────────────

app.get('/admin', requireAdmin, (req, res) => {
  const users              = db.getAllUsers();
  const lessons            = db.getAllLessonsAdmin();
  const resources          = db.getAllResources();
  const lessonStats        = db.getLessonCompletionCounts();
  // The global course start date is retired — each gardener has their own.
  // For the admin's unlock-date preview + the Time Travel quick-jumps we use
  // a cohort reference: the earliest student start date currently on file.
  const courseStartDate    = users
    .filter(u => u.role === 'student' && u.course_start_date)
    .map(u => String(u.course_start_date).slice(0, 10))
    .sort()[0] || '';
  const harvestUnlocked    = db.getSetting('harvest_unlocked') === 'true';
  const midcourseUnlocked  = db.getSetting('midcourse_unlocked') === 'true';
  const upgradeMode        = db.getSetting('upgrade_mode') || 'coming_soon';
  const simulatedToday     = db.getSetting('simulated_today') || null;
  const studentAssessments = db.getAllStudentAssessmentStatus();

  // "Who needs tending" — per-gardener recording activity. Uses the admin's
  // own "today" (respects Time Travel + timezone) as the reference so the
  // 7-day window and quiet flag line up with what the admin sees elsewhere.
  const adminTodayStr  = toLocalDateString(getNow(req.session.user));
  const windowStartStr = toLocalDateString(
    new Date(new Date(adminTodayStr + 'T00:00:00').getTime() - 6 * 86400000)
  );
  const recordingActivity = db.getRecordingActivityByUser(windowStartStr, adminTodayStr);
  const recordingSummary = {};
  const todayMs = new Date(adminTodayStr + 'T00:00:00').getTime();
  for (const u of users) {
    const a = recordingActivity.get(u.id);
    if (a && a.lastRecordedDate) {
      const daysSince = Math.floor(
        (todayMs - new Date(a.lastRecordedDate + 'T00:00:00').getTime()) / 86400000
      );
      recordingSummary[u.id] = {
        lastRecordedDate: a.lastRecordedDate,
        recentCount: a.recentCount,
        daysSince,
        quiet: daysSince >= 7,
        everRecorded: true,
      };
    } else {
      recordingSummary[u.id] = {
        lastRecordedDate: null, recentCount: 0,
        daysSince: null, quiet: true, everRecorded: false,
      };
    }
  }

  // Attach homework to each lesson for the edit dialog
  const lessonHomework = {};
  for (const l of lessons) {
    lessonHomework[l.id] = db.getHomeworkForLesson(l.id);
  }

  let midcourseUnlockDate = null, closingUnlockDate = null;
  if (courseStartDate) {
    const start = new Date(courseStartDate + 'T00:00:00');
    const m = new Date(start); m.setDate(m.getDate() + 35);
    const c = new Date(start); c.setDate(c.getDate() + 77);
    const fmt = d => d.toLocaleDateString('en-US', { month: 'long', day: 'numeric', year: 'numeric' });
    midcourseUnlockDate = fmt(m);
    closingUnlockDate   = fmt(c);
  }

  // ── Enrollments overview ────────────────────────────────────────────────
  // Count paid students per tier and estimate revenue from the lib/stripe
  // price catalog (priceCents × paid users). This is a local estimate —
  // Stripe remains the source of truth for actual amounts, refunds, and
  // dates. Only students count; admins never carry a paid tier.
  const tierCatalog = STRIPE.getTiers();
  const enrollmentTiers = tierCatalog.map(t => {
    const count = users.filter(u => u.role === 'student' && u.enrollment_tier === t.id).length;
    return {
      id: t.id,
      name: t.name,
      priceCents: t.priceCents,
      priceLabel: STRIPE.formatPrice(t.priceCents),
      count,
      subtotalCents: count * t.priceCents,
    };
  });
  const paidCount   = enrollmentTiers.reduce((n, t) => n + t.count, 0);
  const freeCount   = users.filter(u => u.role === 'student' && !u.enrollment_tier).length;
  const revenueCents = enrollmentTiers.reduce((n, t) => n + t.subtotalCents, 0);
  const enrollments = {
    tiers: enrollmentTiers,
    paidCount,
    freeCount,
    revenueLabel: STRIPE.formatPrice(revenueCents),
    stripeConfigured: STRIPE.isConfigured(),
    stripeMode: STRIPE.getMode(),
  };

  res.render('admin', {
    title: 'Admin', page: 'admin',
    users, lessons, resources, lessonStats, lessonHomework, courseStartDate,
    recordingSummary, enrollments,
    harvestUnlocked, midcourseUnlocked, upgradeMode,
    midcourseUnlockDate, closingUnlockDate,
    simulatedToday,
    studentAssessments,
    questions: ASSESSMENT_QUESTIONS,
    closingQuestions: CLOSING_QUESTIONS,
    // Surfaced so the View-student dialog can join answers↔questions and
    // group by angle without doing a second fetch.
    seedPacketAngles: ANGLES,
    midcourseSubmittedCount: db.countMidcourseSubmissionsByStudents(),
    quotes: db.getAllQuotes(),
    // Trial closing question catalog — the View dialog needs the labels to
    // render readable answers (rating low/high, choice labels, etc).
    trialClosingQuestions: TRIAL_CLOSING_QUESTIONS,
  });
});

// ─── Admin: Quotes ────────────────────────────────────────────────────────
// Body validation is intentionally minimal: text is required; source and
// season are optional. season is gated to the four valid values in
// db.createQuote / db.updateQuote (anything else stored as NULL).

app.post('/api/admin/quotes', requireAdmin, (req, res) => {
  const { text, source, season } = req.body;
  if (!text || !text.trim()) return res.status(400).json({ error: 'Quote text is required.' });
  const result = db.createQuote(text, source, season);
  res.json({ ok: true, id: result.lastInsertRowid });
});

app.put('/api/admin/quotes/:id', requireAdmin, (req, res) => {
  const { text, source, season } = req.body;
  if (!text || !text.trim()) return res.status(400).json({ error: 'Quote text is required.' });
  db.updateQuote(parseInt(req.params.id, 10), text, source, season);
  res.json({ ok: true });
});

app.delete('/api/admin/quotes/:id', requireAdmin, (req, res) => {
  db.deleteQuote(parseInt(req.params.id, 10));
  res.json({ ok: true });
});

// All anonymous mid-course responses, oldest first. Per-student linkage is
// intentionally broken at the schema level, so the only way to read content
// is in aggregate.
app.get('/api/admin/midcourse-responses', requireAdmin, (req, res) => {
  res.json({ responses: db.getAllMidcourseResponses() });
});

// Admin-only diagnostic for the Mailchimp contact sync. Open in a browser when
// signups aren't showing up in Mailchimp. Reports whether the key is wired up,
// whether the account is reachable, and whether the configured audience id
// actually exists — WITHOUT ever exposing the key itself.
app.get('/admin/mailchimp-check', requireAdmin, async (req, res) => {
  const apiKey = process.env.MAILCHIMP_API_KEY;
  const configuredListId = MAILCHIMP_SIGNUP.id;
  const out = {
    keyPresent: !!apiKey,
    // Mailchimp keys end in a datacenter suffix like "-us21".
    keyHasDatacenterSuffix: !!apiKey && /-[a-z]+\d+$/.test(apiKey.trim()),
    datacenter: apiKey ? apiKey.trim().split('-').pop() : null,
    configuredListId,
    registrationTag: MAILCHIMP_TAG_REGISTERED,
    newsletterTag: MAILCHIMP_TAG_NEWSLETTER,
    ping: null,
    audiences: null,
    configuredAudienceFound: null,
    configuredAudienceMemberCount: null,
    notes: [],
  };

  if (!apiKey) {
    out.notes.push('MAILCHIMP_API_KEY is not set in this environment. Add it in Railway → Variables and redeploy.');
    return res.json(out);
  }

  const key  = apiKey.trim();
  const dc   = key.split('-').pop();
  const base = `https://${dc}.api.mailchimp.com/3.0`;
  const headers = { Authorization: 'Basic ' + Buffer.from(`anystring:${key}`).toString('base64') };

  try {
    const pingRes = await fetch(`${base}/ping`, { headers });
    out.ping = { ok: pingRes.ok, status: pingRes.status };
    if (pingRes.status === 401) {
      out.notes.push('401 Unauthorized — the API key is wrong, expired, or has stray spaces. Re-copy it from Mailchimp.');
    }

    const listsRes = await fetch(
      `${base}/lists?count=100&fields=lists.id,lists.name,lists.stats.member_count`, { headers });
    if (listsRes.ok) {
      const data = await listsRes.json();
      out.audiences = (data.lists || []).map((l) => ({
        id: l.id, name: l.name, member_count: l.stats && l.stats.member_count,
      }));
      const match = out.audiences.find((l) => l.id === configuredListId);
      out.configuredAudienceFound = !!match;
      out.configuredAudienceMemberCount = match ? match.member_count : null;
      if (!match) {
        out.notes.push(`Configured audience id "${configuredListId}" was NOT found on this account. ` +
          `Use the correct id from the "audiences" list below — tell it to me and I'll update the code.`);
      }
    } else {
      out.notes.push(`Could not list audiences (status ${listsRes.status}). ` +
        (listsRes.status === 401 ? 'Same auth problem as the ping.' : ''));
    }

    // Optional: look up one contact by email to confirm a specific signup
    // landed. Add ?email=someone@example.com to the URL.
    const lookupEmail = (req.query.email || '').trim().toLowerCase();
    if (lookupEmail) {
      const lhash = crypto.createHash('md5').update(lookupEmail).digest('hex');
      const memRes = await fetch(
        `${base}/lists/${configuredListId}/members/${lhash}?fields=email_address,status,tags,last_changed`,
        { headers });
      if (memRes.status === 404) {
        out.lookup = { email: lookupEmail, found: false };
        out.notes.push(`Contact "${lookupEmail}" is NOT in the audience — that signup never reached ` +
          `Mailchimp. Check the Railway logs for a "[mailchimp]" line from that signup.`);
      } else if (memRes.ok) {
        const m = await memRes.json();
        out.lookup = {
          email: m.email_address, found: true, status: m.status,
          tags: (m.tags || []).map((t) => t.name), last_changed: m.last_changed,
        };
        out.notes.push(`Contact "${lookupEmail}" IS in the audience (status: ${m.status}). ` +
          `Tags: ${(m.tags || []).map((t) => t.name).join(', ') || 'none'}.`);
      } else {
        out.notes.push(`Lookup for "${lookupEmail}" returned status ${memRes.status}.`);
      }
    }
  } catch (e) {
    out.notes.push('Request to Mailchimp failed: ' + e.message);
  }

  if (out.notes.length === 0) {
    out.notes.push('Everything looks wired up correctly. If contacts still aren\'t appearing, ' +
      'do a fresh signup and check the Railway logs for a "[mailchimp]" line.');
  }
  res.json(out);
});

// ─── Admin: Seed Packets export ───────────────────────────────────────────────

app.get('/admin/curiosity-map-export', requireAdmin, (req, res) => res.redirect(301, '/admin/seed-packets-export'));
app.get('/admin/curiosity-map-export/:userId', requireAdmin, (req, res) =>
  res.redirect(301, `/admin/seed-packets-export/${req.params.userId}`));

// ─── Owner export: read-only JSON backup of all goal data ─────────────────
app.get('/admin/export', requireAdmin, (req, res) => {
  // READ-ONLY: only SELECT statements; no writes, no schema changes.
  const users = db.getAllUsersForExport();
  const goals = db.getAllGoalsForExport();

  const payload = {
    exported_at: new Date().toISOString(),
    row_counts: { users: users.length, goals: goals.length },
    users,
    goals,
  };

  const date = new Date().toISOString().slice(0, 10);
  res.setHeader('Content-Type', 'application/json; charset=utf-8');
  res.setHeader('Content-Disposition', `attachment; filename="creative-rhythm-goals-export-${date}.json"`);
  res.send(JSON.stringify(payload, null, 2));
});

app.get('/admin/seed-packets-export', requireAdmin, (req, res) => {
  const allUsers = db.getAllUsers();
  const users = allUsers.map(u => ({
    ...u,
    answeredCount: db.getSeedPacketTotalAnswered(u.id),
  }));
  res.render('admin-seed-packets-export', {
    title: 'Export Seed Packet Answers',
    page: 'admin',
    users,
  });
});

app.get('/admin/seed-packets-export/:userId', requireAdmin, (req, res) => {
  const user = db.getUserById(Number(req.params.userId));
  if (!user) return res.redirect('/admin/seed-packets-export');

  const allAnswers = db.getSeedPacketAnswersByUser(user.id);
  const answersMap = {};
  for (const row of allAnswers) answersMap[row.question_id] = row;

  const today = new Date().toISOString().slice(0, 10);

  const fmtDate = raw => {
    if (!raw) return today;
    const s = String(raw);
    return s.length >= 10 ? s.slice(0, 10) : today;
  };

  const lines = [];

  lines.push('# Seed Packets', '');
  lines.push(`*An export of ${user.name}'s reflections*`);
  lines.push(`*Generated on ${today}*`, '');
  lines.push('---', '');

  const unanswered = {};

  for (const angle of ANGLES) {
    const answeredQs = angle.questions.filter(q => answersMap[q.id]);
    const unansweredQs = angle.questions.filter(q => !answersMap[q.id]);

    if (unansweredQs.length > 0) unanswered[angle.name] = unansweredQs;

    if (answeredQs.length === 0) continue;

    lines.push(`## ${angle.name}`, '');
    lines.push(`*${angle.subtitle}*`, '');

    for (const q of answeredQs) {
      const row = answersMap[q.id];
      lines.push(`### ${q.text}`, '');
      lines.push(`*Answered ${fmtDate(row.updated_at)}*`, '');
      lines.push(row.answer_text, '');
      lines.push('---', '');
    }
  }

  const unansweredAngles = Object.keys(unanswered);
  if (unansweredAngles.length > 0) {
    lines.push('## Not Yet Answered', '');
    lines.push('*Questions you haven\'t answered yet — return to them when something pulls you.*', '');
    for (const angleName of unansweredAngles) {
      lines.push(`### ${angleName}`, '');
      for (const q of unanswered[angleName]) {
        lines.push(`- ${q.text}`);
      }
      lines.push('');
    }
  }

  const raw = user.name || '';
  const safeName = raw.toLowerCase().replace(/\s+/g, '-').replace(/[^a-z0-9-]/g, '') || `user-${user.id}`;
  const filename = `seed-packets-${safeName}-${today}.md`;

  res.setHeader('Content-Type', 'text/markdown; charset=utf-8');
  res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
  res.send(lines.join('\n'));
});

app.post('/api/admin/settings', requireAdmin, (req, res) => {
  const { key, value } = req.body;
  const allowed = ['harvest_unlocked', 'midcourse_unlocked', 'simulated_today', 'upgrade_mode'];
  if (!allowed.includes(key)) return res.status(400).json({ error: 'Invalid key' });
  // upgrade_mode is a two-state switch — normalize anything unexpected to the
  // safe 'coming_soon' state so the unfinished pricing page can't leak.
  const finalValue = key === 'upgrade_mode'
    ? (value === 'live' ? 'live' : 'coming_soon')
    : value;
  db.setSetting(key, finalValue);
  res.json({ ok: true });
});

app.post('/api/admin/time-travel/clear', requireAdmin, (req, res) => {
  db.setSetting('simulated_today', '');
  const ref = req.get('Referer') || '/admin';
  res.redirect(ref);
});



// ─── Admin: Students ───────────────────────────────────────────────────────

app.post('/api/admin/users', requireAdmin, (req, res) => {
  const { name, email, password, role, course_length_weeks } = req.body;
  if (!name || !email || !password) return res.status(400).json({ error: 'Name, email, and password are required.' });
  if (!['student', 'admin'].includes(role)) return res.status(400).json({ error: 'Invalid role.' });
  try {
    const result = db.createUser(name.trim(), email.trim().toLowerCase(), password, role);
    // Set cohort length if it was passed and isn't the default (12). Helper
    // clamps to [1, 52].
    if (course_length_weeks !== undefined && parseInt(course_length_weeks, 10) !== 12) {
      db.setUserCourseLengthWeeks(result.lastInsertRowid, course_length_weeks);
    }
    // Every admin-created account gets its own start date (today) so it never
    // depends on the global default — adjustable afterward via the users
    // table. (The platform is retiring the global course start date.)
    db.setUserCourseStartDate(result.lastInsertRowid, toLocalDateString(new Date()));
    const newUser = db.getUserById(result.lastInsertRowid);
    res.json({ ok: true, user: newUser });
  } catch (e) {
    if (e.message && e.message.includes('UNIQUE')) return res.status(409).json({ error: 'That email is already in use.' });
    res.status(500).json({ error: 'Failed to create user.' });
  }
});

app.put('/api/admin/users/:id', requireAdmin, (req, res) => {
  const id = parseInt(req.params.id);
  const { name, email, role, password, course_length_weeks, notes, enrollment_tier } = req.body;
  if (!name || !email) return res.status(400).json({ error: 'Name and email are required.' });
  if (!['student', 'admin'].includes(role)) return res.status(400).json({ error: 'Invalid role.' });
  try {
    db.updateUser(id, name, email, role, password || null);
    if (course_length_weeks !== undefined) {
      db.setUserCourseLengthWeeks(id, course_length_weeks);
    }
    // Enrollment tier — lets the admin comp/gift a paid tier. setUserEnrollmentTier
    // maps anything outside solo/community/coaching to NULL (= none). Gifting a
    // paid tier also grants full access (12 weeks), overriding any trial clamp,
    // so the gift actually unlocks the whole course. Runs AFTER the
    // course_length_weeks set above so the paid-tier override wins.
    if (enrollment_tier !== undefined) {
      const paid = ['solo', 'community', 'coaching'].includes(enrollment_tier);
      db.setUserEnrollmentTier(id, paid ? enrollment_tier : null);
      if (paid) db.setUserCourseLengthWeeks(id, 12);
    }
    // Private admin note — always sent by the edit dialog (empty = clear).
    if (notes !== undefined) {
      db.setUserNotes(id, notes);
    }
    res.json({ ok: true });
  } catch (e) {
    if (e.message && e.message.includes('UNIQUE')) return res.status(409).json({ error: 'That email is already in use.' });
    res.status(500).json({ error: 'Failed to update user.' });
  }
});

app.delete('/api/admin/users/:id', requireAdmin, (req, res) => {
  const id = parseInt(req.params.id);
  if (id === req.session.user.id) return res.status(400).json({ error: "You can't delete your own account." });
  db.deleteUser(id);
  res.json({ ok: true });
});

// Admin-initiated password help. Generates a fresh temporary password, sets it
// on the account, and hands it back to the admin to relay however they like
// (text, call, in person). Chosen over "email a reset link" because email
// depends on RESEND_API_KEY being configured — a set-temp-password flow works
// unconditionally, which is what a locked-out student needs. The temp password
// always satisfies isPasswordValid so the student can immediately sign in and
// change it. Any outstanding reset tokens are invalidated so a stale link
// can't be used after the admin has intervened.
function generateTempPassword() {
  // 9 random bytes → ~12 url-safe chars; strip separators, take 8, then append
  // two digits so the result is ≥8 chars AND contains a number (isPasswordValid).
  const base = crypto.randomBytes(9).toString('base64')
    .replace(/[^a-zA-Z0-9]/g, '').slice(0, 8);
  const digits = String(crypto.randomInt(10, 100)); // 10–99
  return base + digits;
}

app.post('/api/admin/users/:id/reset-password', requireAdmin, (req, res) => {
  const id = parseInt(req.params.id);
  if (!id) return res.status(400).json({ error: 'Invalid user id.' });
  const target = db.getUserById(id);
  if (!target) return res.status(404).json({ error: 'Gardener not found.' });

  let tempPassword;
  do { tempPassword = generateTempPassword(); } while (!isPasswordValid(tempPassword));

  db.updateUserPassword(id, tempPassword);
  // Kill any live reset links for this account — the admin just took over.
  if (typeof db.deletePasswordResetTokensForUser === 'function') {
    db.deletePasswordResetTokensForUser(id);
  }

  res.json({ ok: true, name: target.name, email: target.email, tempPassword });
});

// Per-user course start date — the multi-cohort lever. Pass {date: 'YYYY-MM-DD'}
// to override; pass {date: null} to clear and fall back to the global default.
app.post('/api/admin/users/:id/course-start-date', requireAdmin, (req, res) => {
  const id = parseInt(req.params.id);
  if (!id) return res.status(400).json({ error: 'Invalid user id.' });
  const { date } = req.body || {};
  if (date !== null && !/^\d{4}-\d{2}-\d{2}$/.test(String(date || ''))) {
    return res.status(400).json({ error: 'date must be YYYY-MM-DD or null.' });
  }
  db.setUserCourseStartDate(id, date);
  res.json({ ok: true });
});

app.get('/api/admin/student-data/:id', requireAdmin, (req, res) => {
  const data = db.getStudentFullData(parseInt(req.params.id));
  if (!data.user) return res.status(404).json({ error: 'User not found.' });
  res.json(data);
});

// ─── Admin: Lessons ────────────────────────────────────────────────────────

app.post('/api/admin/lessons', requireAdmin, (req, res) => {
  const { slug, title, subtitle, category_tag, content, estimated_read_time } = req.body;
  if (!title || !slug) return res.status(400).json({ error: 'Title and slug are required.' });
  try {
    const result = db.createLesson(slug.trim(), title.trim(), subtitle, category_tag, content, parseInt(estimated_read_time) || 5);
    res.json({ ok: true, id: result.lastInsertRowid });
  } catch (e) {
    if (e.message && e.message.includes('UNIQUE')) return res.status(409).json({ error: 'That slug is already used by another lesson.' });
    res.status(500).json({ error: 'Failed to create lesson.' });
  }
});

app.put('/api/admin/lessons/:id', requireAdmin, (req, res) => {
  const id = parseInt(req.params.id);
  const { title, subtitle, category_tag, content, estimated_read_time, video_url, homework } = req.body;
  if (!title) return res.status(400).json({ error: 'Title is required.' });
  const normalizedVideo = normalizeVideoUrl(video_url);
  db.updateLesson(id, title.trim(), subtitle, category_tag, content, parseInt(estimated_read_time) || 5, normalizedVideo);
  if (Array.isArray(homework)) {
    db.setHomework(id, homework);
  }
  res.json({ ok: true });
});

app.delete('/api/admin/lessons/:id', requireAdmin, (req, res) => {
  db.deleteLesson(parseInt(req.params.id));
  res.json({ ok: true });
});

app.post('/api/admin/lessons/:id/move', requireAdmin, (req, res) => {
  const id = parseInt(req.params.id);
  const { direction } = req.body;
  const lessons = db.getAllLessonsAdmin();
  const idx = lessons.findIndex(l => l.id === id);
  if (idx === -1) return res.status(404).json({ error: 'Lesson not found.' });
  const swapIdx = direction === 'up' ? idx - 1 : idx + 1;
  if (swapIdx < 0 || swapIdx >= lessons.length) return res.json({ ok: true });
  [lessons[idx], lessons[swapIdx]] = [lessons[swapIdx], lessons[idx]];
  db.updateLessonSortOrders(lessons.map((l, i) => ({ id: l.id, sort_order: (i + 1) * 10 })));
  res.json({ ok: true });
});

// ─── Admin: Resources ──────────────────────────────────────────────────────

app.post('/api/admin/resources', requireAdmin, (req, res) => {
  const { title, description, category_tag, url } = req.body;
  if (!title) return res.status(400).json({ error: 'Title is required.' });
  const result = db.createResource(title.trim(), description || '', category_tag || '', url || '', null);
  res.json({ ok: true, id: result.lastInsertRowid });
});

app.put('/api/admin/resources/:id', requireAdmin, (req, res) => {
  const id = parseInt(req.params.id);
  const { title, description, category_tag, url } = req.body;
  if (!title) return res.status(400).json({ error: 'Title is required.' });
  db.updateResource(id, title.trim(), description || '', category_tag || '', url || '');
  res.json({ ok: true });
});

app.delete('/api/admin/resources/:id', requireAdmin, (req, res) => {
  db.deleteResource(parseInt(req.params.id));
  res.json({ ok: true });
});

// ─── Shared cron auth ──────────────────────────────────────────────────────
// Constant-time compare for the X-Cron-Secret header used by the cron-driven
// routes below (nightly backup, daily reminders). Bails on length mismatch.
//
// NOTE: The daily *cuttings digest* automation was removed (July 2026). It
// emailed the admin a PDF of each student's private daily reflections, which
// conflicted with the platform's "grow in private" promise. Engagement is now
// tracked without content via the admin "Who needs tending" view.
function safeEqual(a, b) {
  const ab = Buffer.from(String(a), 'utf8');
  const bb = Buffer.from(String(b), 'utf8');
  if (ab.length !== bb.length) return false;
  return require('crypto').timingSafeEqual(ab, bb);
}

// ─── Nightly backup ────────────────────────────────────────────────────────
// Triggered daily by GitHub Actions (nightly-backup.yml). Takes a VACUUM
// INTO snapshot of the live database and streams it back as the response
// body; the workflow saves it as a repo artifact, giving an off-platform
// copy that survives a Railway volume loss. Snapshots also rotate locally
// in /data/backups (last 7) as a second layer. CRON_SECRET-authed like the
// other cron routes.
app.post('/admin/run-backup', (req, res) => {
  const expected = process.env.CRON_SECRET;
  if (!expected) {
    return res.status(503).json({ error: 'CRON_SECRET not configured on this server.' });
  }
  const provided = req.get('X-Cron-Secret') || '';
  if (!safeEqual(provided, expected)) {
    return res.status(401).json({ error: 'Invalid or missing X-Cron-Secret.' });
  }
  try {
    const snap = db.createBackupSnapshot();
    console.log(`[backup] snapshot ${snap.filename} (${snap.bytes} bytes)`);
    res.setHeader('Content-Type', 'application/octet-stream');
    res.setHeader('Content-Disposition', `attachment; filename="${snap.filename}"`);
    res.setHeader('Content-Length', snap.bytes);
    fs.createReadStream(snap.path).pipe(res);
  } catch (err) {
    console.error('[backup] failed:', err);
    res.status(500).json({ error: err.message });
  }
});

// Same snapshot, but session-authed so Julia can pull a full copy from the
// admin page whenever she wants one (e.g. before a risky change).
app.get('/admin/download-backup', requireAdmin, (req, res) => {
  try {
    const snap = db.createBackupSnapshot();
    res.setHeader('Content-Type', 'application/octet-stream');
    res.setHeader('Content-Disposition', `attachment; filename="${snap.filename}"`);
    res.setHeader('Content-Length', snap.bytes);
    fs.createReadStream(snap.path).pipe(res);
  } catch (err) {
    console.error('[backup] failed:', err);
    res.status(500).render('error', {
      title: 'Backup failed',
      message: 'Could not create the backup snapshot. Check the server logs.',
      user: req.session.user,
      page: 'admin',
    });
  }
});

// ─── Daily push reminders ──────────────────────────────────────────────────
// Triggered hourly by GitHub Actions. The lib decides per-user whether the
// current UTC hour maps to that student's chosen local hour, so this route
// is dumb — it just runs the lib and reports.
const { runDailyReminders } = require('./lib/daily-reminders');
const { runWeeklyReminders } = require('./lib/weekly-reminders');

app.post('/admin/run-daily-reminders', async (req, res) => {
  const expected = process.env.CRON_SECRET;
  if (!expected) {
    return res.status(503).json({ error: 'CRON_SECRET not configured on this server.' });
  }
  const provided = req.get('X-Cron-Secret') || '';
  if (!safeEqual(provided, expected)) {
    return res.status(401).json({ error: 'Invalid or missing X-Cron-Secret.' });
  }
  const dryRun = req.query.dryRun === '1' || req.query.dryRun === 'true';

  const log = [];
  const capture = (line) => { log.push(line); console.log(line); };

  try {
    // One hourly job runs both cadences. Weekly self-gates to Mondays, so it's
    // a cheap no-op on other days.
    const daily  = await runDailyReminders({ dryRun, log: capture });
    const weekly = await runWeeklyReminders({ dryRun, log: capture });
    res.json({ ok: true, dryRun, summary: { daily, weekly }, log });
  } catch (err) {
    console.error('[daily-reminders route] fatal:', err);
    res.status(500).json({ ok: false, error: err.message, log });
  }
});

// Admin-only diagnostic for the Cloudflare Stream video integration. Open in a
// browser after setting the Railway variables to confirm the credentials work
// BEFORE we build anything on top of them. Add ?testUpload=1 to also mint a
// throwaway direct-upload URL — that exercises the exact call the feature
// depends on. (An unused direct upload just expires; it costs nothing.)
app.get('/admin/video-check', requireAdmin, async (req, res) => {
  const cfg = VIDEO._accountConfigured();
  const out = {
    configured: VIDEO.isVideoConfigured(),
    accountIdSet: cfg.accountId,
    tokenSet: cfg.token,
    apiReachable: null,
    videosOnAccount: null,
    directUploadTest: null,
    notes: [],
  };

  if (!out.configured) {
    out.notes.push('❌ Not configured. Set CLOUDFLARE_ACCOUNT_ID and CLOUDFLARE_STREAM_TOKEN as Railway variables, then redeploy.');
    return res.json(out);
  }

  try {
    const videos = await VIDEO.listVideos(1);
    out.apiReachable = true;
    out.videosOnAccount = Array.isArray(videos) ? videos.length : 0;
    out.notes.push('✅ Credentials work — Cloudflare Stream is reachable.');
  } catch (e) {
    out.apiReachable = false;
    out.notes.push(`❌ Stream API call failed: ${e.message}`);
    out.notes.push('Common causes: the token lacks Stream:Read/Edit permission, the Account ID is wrong, or Stream isn\'t enabled on the account.');
    return res.json(out);
  }

  if (req.query.testUpload === '1') {
    try {
      const { uid } = await VIDEO.createDirectUpload({ userId: req.session.user.id, name: 'diagnostic test' });
      out.directUploadTest = { ok: true, uid };
      out.notes.push('✅ Direct-upload URL minted successfully — the upload path will work. (This placeholder expires unused.)');
    } catch (e) {
      out.directUploadTest = { ok: false, error: e.message };
      out.notes.push(`❌ Could not mint a direct-upload URL: ${e.message}`);
    }
  } else {
    out.notes.push('Tip: add ?testUpload=1 to also verify the direct-upload call.');
  }

  res.json(out);
});

// Admin-only diagnostic for the daily reminder. Open in a browser when a
// reminder didn't arrive. Reports the target user's settings, whether each
// channel is configured server-side, and — the key signal — whether today's
// reminder was already claimed (which tells us if the hourly job actually
// reached this user). Defaults to yourself; add ?email=someone@example.com to
// check a student.
app.get('/admin/reminder-check', requireAdmin, (req, res) => {
  const { getHourInTimezone, getDateInTimezone } = require('./lib/daily-reminders');
  const { getWeekdayInTimezone } = require('./lib/weekly-reminders');

  const lookupEmail = (req.query.email || '').trim().toLowerCase();
  const target = lookupEmail ? db.getUserByEmail(lookupEmail) : db.getUserById(req.session.user.id);
  if (!target) return res.json({ error: `No user found for "${lookupEmail}".` });
  const u = db.getUserFullProfile(target.id);

  const now = new Date();
  const tz  = u.timezone || 'America/Denver';
  const currentHour = getHourInTimezone(now, tz);
  const milestone   = `daily-reminder-${getDateInTimezone(now, tz)}`;
  const claimed     = db.hasMilestoneBeenClaimed(u.id, milestone);
  const pushCount   = db.countPushSubscriptionsForUser(u.id);

  const weekday        = getWeekdayInTimezone(now, tz);
  const weeklyMilestone = `weekly-reminder-${getDateInTimezone(now, tz)}`;
  const weeklyClaimed   = db.hasMilestoneBeenClaimed(u.id, weeklyMilestone);

  const out = {
    server: {
      cronSecretConfigured: !!process.env.CRON_SECRET,
      vapidConfigured: PUSH.isPushConfigured(),
      resendConfigured: !!process.env.RESEND_API_KEY,
      appUrl: process.env.APP_URL || 'https://www.creativesgarden.com (default)',
      nowUtc: now.toISOString(),
    },
    user: {
      email: u.email,
      timezone: tz,
      masterToggleOn: u.daily_reminder_enabled === 1,
      reminderHour: u.daily_reminder_hour,
      emailChannelOn: u.reminder_email_enabled === 1,
      pushDevicesRegistered: pushCount,
      pushDevices: db.getPushSubscriptionsForUser(u.id).map((s) => ({ device: s.user_agent, added: s.created_at })),
      currentHourInYourTimezone: currentHour,
      hourMatchesRightNow: currentHour === u.daily_reminder_hour,
      todaysReminderAlreadyProcessed: claimed,
      milestoneKey: milestone,
      weekly: {
        enabled: u.weekly_reminder_enabled === 1,
        hour: u.weekly_reminder_hour,
        emailChannelOn: u.weekly_reminder_email === 1,
        todayIsMonday: weekday === 'Mon',
        weekdayInYourTimezone: weekday,
        thisWeekAlreadyProcessed: weeklyClaimed,
        milestoneKey: weeklyMilestone,
        // Weekly uses the same registered push devices as the daily reminder.
        pushDevicesRegistered: pushCount,
      },
    },
    notes: [],
  };
  const n = out.notes;

  if (!out.server.cronSecretConfigured) n.push('❌ CRON_SECRET is NOT set on this server — the hourly job\'s requests are rejected (503/401), so nothing ever sends. Set it on Railway AND as a GitHub Actions repository secret (same value).');
  if (!u.daily_reminder_enabled) n.push('❌ The master "Send me a daily reminder" toggle is OFF for this user — nothing sends until it\'s on.');
  if (u.daily_reminder_hour === null || u.daily_reminder_hour === undefined) n.push('❌ No reminder hour saved.');
  if (pushCount === 0) n.push('⚠ No push devices registered — "Enable on this device" never completed on any phone/desktop, so there\'s no push to send. (Email still works if enabled.)');
  if (!u.reminder_email_enabled) n.push('⚠ Email channel is OFF for this user.');
  if (!out.server.vapidConfigured) n.push('❌ VAPID keys not configured — push cannot send from this server.');
  if (!out.server.resendConfigured) n.push('❌ RESEND_API_KEY not set — email cannot send from this server.');

  if (claimed) {
    n.push('✅ Today\'s reminder WAS already processed by the job (milestone claimed) — so the hourly job IS reaching the server and matched this user\'s hour. If nothing arrived, the issue is delivery: no push devices, email off, or the email landed in spam.');
  } else {
    n.push('⚠ Today\'s reminder has NOT been processed yet. Either (a) the hourly GitHub Actions job isn\'t reaching the server — check the Actions tab for failed/absent runs and confirm CRON_SECRET matches on both sides; (b) the job hasn\'t hit your target hour yet; or (c) your reminder hour / timezone don\'t line up (see currentHourInYourTimezone vs reminderHour above).');
  }

  res.json(out);
});

// ─── Helpers ───────────────────────────────────────────────────────────────

function getUnlockState(user) {
  // Date-based (per-user) OR admin manual override — whichever is true wins.
  // Trial students (course_length_weeks < 12) never see midcourse — the
  // concept doesn't apply to a 3-week run. Closing always scales to (length-1)
  // weeks since start so trial users get it during their final week.
  const courseStart  = db.getUserCourseStartDate(user);
  const lengthWeeks  = getCourseLengthWeeks(user);
  const isFullCourse = lengthWeeks >= 12;
  let midcourseDate = false, closingDate = false;
  if (courseStart) {
    const now = getNow(user);
    const daysDiff = Math.floor((now.getTime() - new Date(courseStart + 'T00:00:00').getTime()) / 86400000);
    midcourseDate = isFullCourse && daysDiff >= 35;
    closingDate   = daysDiff >= (lengthWeeks - 1) * 7;
  }
  return {
    // Purely per-user timeline — the old global "unlocked for everyone"
    // override was appropriate for one synchronized cohort but is wrong
    // with rolling signups. Timing is driven by each student's own
    // course_start_date; adjust that on /admin if you need to shift one.
    midcourseUnlocked: isFullCourse && midcourseDate,
    harvestUnlocked:   closingDate
  };
}

function getGreeting(user) {
  // new Date().getHours() reads the SERVER's local hour — on Railway that's
  // UTC, so a user in Denver at noon saw "Good evening" (UTC 18:00). Resolve
  // the current hour in the user's saved timezone instead.
  const tz = (user && user.timezone) || 'America/Denver';
  let h;
  try {
    h = parseInt(new Intl.DateTimeFormat('en-US', {
      hour: 'numeric', hour12: false, timeZone: tz,
    }).format(new Date()), 10);
    if (h === 24) h = 0;
  } catch (_) {
    h = new Date().getUTCHours();
  }
  if (h < 12) return 'Good morning';
  if (h < 17) return 'Good afternoon';
  return 'Good evening';
}

function getWeekStart(user) {
  // Resolve "now" in the user's wall-clock TZ so a Sunday-evening student in
  // Denver doesn't see the upcoming Monday because Railway already ticked
  // over to UTC Monday.
  const now = getNow(user);
  const day = now.getDay();
  const diff = day === 0 ? -6 : 1 - day;
  const monday = new Date(now);
  monday.setDate(now.getDate() + diff);
  monday.setHours(0, 0, 0, 0);
  return toLocalDateString(monday);
}

// Resolve a user's course length (in weeks). Trial students get a smaller
// number (typically 3); full course is 12. Default 12 covers legacy rows /
// admin sessions that never set the field. Centralized so any future
// fallback rule lives in one place.
function getCourseLengthWeeks(user) {
  const w = user && user.course_length_weeks;
  return (typeof w === 'number' && w > 0) ? w : 12;
}

// Returns { weekNumber, weekStart, weekEnd } relative to course_start_date.
// weekNumber is 1-based; 0 means before course start; null means no course start set.
// Uses getNow(user) so time-travel works correctly. Optional second arg lets
// the caller hoist the db.getSetting('course_start_date') read so a route
// doing both week + day math doesn't hit the same setting twice.
function getCurrentCourseWeek(user, courseStartArg) {
  // Fallback resolves through the per-user helper so callers that don't
  // pre-hoist the start date still respect cohort overrides. The helper
  // itself falls back to the global setting when the user has no override.
  const courseStartStr = (courseStartArg !== undefined) ? courseStartArg : db.getUserCourseStartDate(user);
  if (!courseStartStr || !courseStartStr.trim()) {
    const ws = getWeekStart(user);
    const we = new Date(ws + 'T00:00:00');
    we.setDate(we.getDate() + 6);
    return { weekNumber: null, weekStart: ws, weekEnd: we.toISOString().split('T')[0] };
  }

  const courseStart = new Date(courseStartStr + 'T00:00:00');
  const now = getNow(user);
  const today = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  const daysSinceStart = Math.floor((today - courseStart) / 86400000);

  if (daysSinceStart < 0) {
    const ws = getWeekStart(user);
    const we = new Date(ws + 'T00:00:00');
    we.setDate(we.getDate() + 6);
    return { weekNumber: 0, weekStart: ws, weekEnd: we.toISOString().split('T')[0] };
  }

  const weekIndex = Math.floor(daysSinceStart / 7);
  const weekNumber = weekIndex + 1;
  const weekStart = new Date(courseStart);
  weekStart.setDate(courseStart.getDate() + weekIndex * 7);
  const ws = weekStart.toISOString().split('T')[0];
  const weekEnd = new Date(weekStart);
  weekEnd.setDate(weekStart.getDate() + 6);
  return { weekNumber, weekStart: ws, weekEnd: weekEnd.toISOString().split('T')[0] };
}

// Today's course-day details. Mirrors getCurrentCourseWeek — same getNow(user)
// + course_start_date flow, same pre/post-course edge cases — so the day-view
// and the week-view share one clock. Returns:
//   dayNumber   1-based day-of-course (1..N); null if no course_start_date set;
//               0 if before course start
//   weekNumber  1-based week-of-course; null/0 mirroring dayNumber
//   dayInWeek   1..7 for in-course days; 0 pre-course; null without start
//   dateStr     today's wall-clock YYYY-MM-DD in the user's TZ
//   isPreCourse / isPostCourse  edge flags
function getCurrentCourseDay(user, courseStartArg) {
  const courseStartStr = (courseStartArg !== undefined) ? courseStartArg : db.getUserCourseStartDate(user);
  const dateStr = toLocalDateString(getNow(user));
  if (!courseStartStr || !courseStartStr.trim()) {
    return { dayNumber: null, weekNumber: null, dayInWeek: null,
             dateStr, isPreCourse: false, isPostCourse: false };
  }
  const courseStart = new Date(courseStartStr + 'T00:00:00');
  const now = getNow(user);
  const today = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  const daysSinceStart = Math.floor((today - courseStart) / 86400000);
  if (daysSinceStart < 0) {
    return { dayNumber: 0, weekNumber: 0, dayInWeek: 0,
             dateStr, isPreCourse: true, isPostCourse: false };
  }
  const dayNumber  = daysSinceStart + 1;
  const weekNumber = Math.floor(daysSinceStart / 7) + 1;
  const dayInWeek  = (daysSinceStart % 7) + 1;
  return { dayNumber, weekNumber, dayInWeek, dateStr,
           isPreCourse: false, isPostCourse: dayNumber > 84 };
}

// Pure date-to-course-day mapping for the viewed ?day= URL param. The user
// arg is accepted for API symmetry with getCurrentCourseDay but the result
// depends only on dateStr + course_start_date. Returns nulls for dates
// before course start or when no course_start_date is set; dayInSeason uses
// modulo 21 so it stays valid for post-course dates that admins might reach
// via time travel.
function getCourseDayForDate(user, dateStr, courseStartArg) {
  const courseStartStr = (courseStartArg !== undefined) ? courseStartArg : db.getUserCourseStartDate(user);
  if (!courseStartStr || !dateStr) {
    return { dayNumber: null, season: null, dayInSeason: null };
  }
  const courseStart = new Date(courseStartStr + 'T00:00:00');
  const date = new Date(dateStr + 'T00:00:00');
  const days = Math.floor((date - courseStart) / 86400000);
  if (days < 0) {
    return { dayNumber: null, season: null, dayInSeason: null };
  }
  const dayNumber   = days + 1;
  const weekNumber  = Math.floor(days / 7) + 1;
  const season      = getCurricularSeason(weekNumber);
  const dayInSeason = (dayNumber - 1) % 21;
  return { dayNumber, season, dayInSeason };
}

function formatWeekLabel(weekStart) {
  const start = new Date(weekStart + 'T00:00:00');
  const end = new Date(start);
  end.setDate(start.getDate() + 6);
  const startStr = start.toLocaleDateString('en-US', { month: 'long', day: 'numeric' });
  const endOpts = start.getMonth() === end.getMonth()
    ? { day: 'numeric' }
    : { month: 'long', day: 'numeric' };
  const endStr = end.toLocaleDateString('en-US', endOpts);
  return `${startStr}–${endStr}`;
}

function parseGoalText(goalText) {
  if (!goalText || !goalText.trim()) return { mode: 'checklist', items: [] };
  try {
    const parsed = JSON.parse(goalText);
    if (parsed && parsed.mode === 'checklist' && Array.isArray(parsed.items)) {
      return { mode: 'checklist', items: parsed.items };
    }
  } catch (e) {}
  // Legacy single-text: wrap as one checklist item
  return { mode: 'checklist', items: [{ text: goalText.trim(), checked: false }] };
}

function formatDateRangeShort(weekStart) {
  const start = new Date(weekStart + 'T00:00:00');
  const end   = new Date(start);
  end.setDate(start.getDate() + 6);
  const opts = { month: 'short', day: 'numeric' };
  return start.toLocaleDateString('en-US', opts) + ' – ' + end.toLocaleDateString('en-US', opts);
}

const WEEK_ORDINALS = ['One','Two','Three','Four','Five','Six','Seven','Eight','Nine','Ten','Eleven','Twelve'];

// Generate the Monday of each course week as a YYYY-MM-DD string.
// Length defaults to 12 (full course) so old call sites that haven't been
// threaded a user keep working. Trial students pass 3.
function generateCourseWeeks(startDate, lengthWeeks = 12) {
  const weeks = [];
  const start = new Date(startDate + 'T00:00:00');
  for (let i = 0; i < lengthWeeks; i++) {
    const d = new Date(start);
    d.setDate(d.getDate() + i * 7);
    weeks.push(d.toISOString().split('T')[0]);
  }
  return weeks;
}

function getRotatingQuote(user) {
  // Pool comes from the DB (managed by admin via /admin → Quotes) and is
  // filtered to the user's current_season + any "untagged" quotes — see
  // db.getQuotesForUser. Defensive fallback for the unlikely case of an
  // empty pool (e.g. all quotes deleted, no untagged left) so the dashboard
  // never renders a blank quote box.
  const pool = db.getQuotesForUser(user);
  if (!pool.length) {
    return { text: "Visibility that feels like a return to self.", source: "The Meibos Touch" };
  }
  // Rotate at the user's local midnight, not server (UTC) midnight, so the
  // quote doesn't change mid-evening for anyone west of UTC.
  const today = getNow(user);
  const idx = (today.getFullYear() * 365 + today.getMonth() * 31 + today.getDate()) % pool.length;
  return pool[idx];
}

// Catch-all 404 — a branded page instead of Express's bare "Cannot GET /x".
// Must sit after every route. res.locals.user is set by the middleware above,
// so the sidebar renders for signed-in visitors and is omitted otherwise.
app.use((req, res) => {
  res.status(404).render('error', {
    title: 'Not found',
    message: "We couldn't find that page. It may have moved, or the link was mistyped.",
    user: req.session.user || null,
    page: '',
  });
});

// Last-resort error handler. A thrown/rejected route lands here as a branded
// 500 instead of a raw stack trace. Keeps one bad row or template from
// leaking internals to a student.
app.use((err, req, res, next) => {
  console.error('[unhandled route error]', err);
  if (res.headersSent) return next(err);
  res.status(500).render('error', {
    title: 'Something went wrong',
    message: 'Something went wrong on our end. Please try again in a moment.',
    user: (req.session && req.session.user) || null,
    page: '',
  });
});

// Process-level safety net: an unhandled promise rejection (e.g. a throw in
// an async handler before its own try/catch) would otherwise crash the whole
// server for every student. Log loudly and stay up; Railway keeps serving.
process.on('unhandledRejection', (reason) => {
  console.error('[unhandledRejection]', reason);
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`\n✨ The Creative's Garden is running at http://localhost:${PORT}\n`);
});
