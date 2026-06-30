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
const { renderHtmlToPdf } = require('./lib/pdf-render');
const PUSH = require('./lib/push');
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
app.use(express.json());

app.set('trust proxy', 1);

// Sessions live in a SEPARATE file from the main DB so two different SQLite
// libraries (node:sqlite and connect-sqlite3's native sqlite3) never compete
// for the same file.
const SESSION_DIR = process.env.DB_PATH
  ? path.dirname(process.env.DB_PATH)
  : path.join(__dirname, 'data');
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

app.use((req, res, next) => {
  res.locals.user = req.session.user || null;
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

// Onboarding guard — students who haven't completed onboarding can only access onboarding routes
app.use((req, res, next) => {
  const u = req.session.user;
  if (u && u.role === 'student' && !u.onboarding_completed) {
    const ok = req.path === '/' || req.path === '/logout'
      || req.path.startsWith('/onboarding')
      || req.path.startsWith('/api/onboarding');
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

app.get('/', (req, res) => {
  if (req.session.user) return res.redirect('/dashboard');
  res.render('login', { error: null });
});

app.post('/login', async (req, res) => {
  const { email, password } = req.body;
  if (!email || !password) {
    return res.render('login', { error: 'Please enter your email and password.' });
  }
  const user = db.getUserByEmail(email.trim().toLowerCase());
  if (!user) {
    return res.render('login', { error: 'Invalid email or password.' });
  }
  const valid = await bcrypt.compare(password, user.password_hash);
  if (!valid) {
    return res.render('login', { error: 'Invalid email or password.' });
  }
  req.session.user = {
    id: user.id, name: user.name, email: user.email, role: user.role,
    avatar_initial: user.avatar_initial, current_season: user.current_season || null,
    onboarding_completed: !!user.onboarding_completed,
    profile_photo: user.profile_photo || null,
    timezone: user.timezone || null,
    course_start_date: user.course_start_date || null,
    course_length_weeks: user.course_length_weeks || 12,
  };
  if (user.role !== 'admin' && !user.onboarding_completed) {
    return res.redirect('/onboarding');
  }
  res.redirect('/dashboard');
});

app.get('/logout', (req, res) => {
  req.session.destroy(() => res.redirect('/'));
});

// ─── Forgot password ───────────────────────────────────────────────────────

app.get('/forgot-password', (req, res) => {
  if (req.session.user) return res.redirect('/dashboard');
  res.render('forgot-password', { sent: false, error: null });
});

app.post('/forgot-password', async (req, res) => {
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
  if (new_password.length < 8) return withError('Password must be at least 8 characters.');

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
  const isIntegrationWeek = goals.some(g => g.is_integration_week);

  const goalsDataDash = {};
  for (const cat of ['curiosity','create','share','connect']) {
    goalsDataDash[cat] = parseGoalText(goalsMap[cat]?.goal_text);
  }

  const curricularSeason = getCurricularSeason(weekNumber);
  const curricularSeasonLabel = getCurricularSeasonLabel(curricularSeason);

  const { dayview, today } = buildDayviewPayload(req.session.user, req.query.day, courseStart);

  // Mid-course check-in card: visible only when the global setting is
  // unlocked AND this specific student hasn't submitted yet. Admins never
  // see the card (they can't submit, and POST is 403-gated server-side).
  const midcourseCardVisible = (
    req.session.user.role !== 'admin' &&
    isMidcourseUnlockedFor(req.session.user) &&
    !db.hasMidcourseBeenSubmittedByUser(req.session.user.id)
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
    isTrialClosingUnlockedFor(req.session.user);
  const trialComplete = isTrial && (
    trialClosingSubmitted ||
    (typeof weekNumber === 'number' && weekNumber > courseLengthWeeks)
  );

  res.render('dashboard', {
    title: 'Dashboard',
    page: 'dashboard',
    greeting: getGreeting(req.session.user),
    weekStart,
    weekNumber,
    weekLabel: formatWeekLabel(weekStart),
    curricularSeason,
    curricularSeasonLabel,
    goals: goalsMap,
    goalsData: goalsDataDash,
    currentLesson,
    allLessons,
    completedCount,
    totalLessons: allLessons.length,
    isIntegrationWeek,
    dayview,
    today,
    quote: getRotatingQuote(req.session.user),
    midcourseCardVisible,
    courseLengthWeeks,
    isTrial,
    trialComplete,
    trialClosingCardVisible,
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
    season = seasonForRecordedDate(rawRecorded, courseStart);
    isBackdated = rawRecorded !== today;
  } else {
    recordedDate = today;
    season = getCurricularSeason(getCurrentCourseWeek(req.session.user).weekNumber);
    isBackdated = false;
  }

  // `prompt` column is vestigial — kept set to the first/noticed prompt for
  // continuity with legacy rows and any future direct queries.
  db.createCutting(req.session.user.id, season, CUTTING_PROMPTS[0].label, fields, recordedDate);

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

// ─── Goals ─────────────────────────────────────────────────────────────────

app.get('/goals', requireAuth, (req, res) => {
  const userId = req.session.user.id;
  const courseWeek = getCurrentCourseWeek(req.session.user);
  const currentWeekStart = courseWeek.weekStart;
  const requestedWeek = req.query.week || currentWeekStart;

  // Validate week format (YYYY-MM-DD)
  const weekStart = /^\d{4}-\d{2}-\d{2}$/.test(requestedWeek) ? requestedWeek : currentWeekStart;

  const goals = db.getGoalsForWeek(userId, weekStart);
  const goalsMap = {};
  for (const g of goals) goalsMap[g.category] = g;

  const isIntegrationWeek = goals.some(g => g.is_integration_week);
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
    curricularSeason,
    curricularSeasonLabel,
    goals: goalsMap,
    goalsData: goalsDataPage,
    isIntegrationWeek,
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

app.post('/api/goals/integration', requireAuth, (req, res) => {
  const { weekStart, isIntegration } = req.body;
  db.setIntegrationWeek(req.session.user.id, weekStart, isIntegration);
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
  db.updateUserSeason(req.session.user.id, season || null);
  req.session.user.current_season = season || null;
  res.json({ ok: true });
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
  const lesson = db.getLessonBySlug(req.params.slug);
  if (!lesson) return res.status(404).render('error', { title: '404', message: 'Lesson not found.', user: req.session.user });
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

  const allUsers = db.getAllUsers();
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

  const members = allUsers.map(u => ({
    id:                      u.id,
    name:                    u.name,
    avatar_initial:          u.avatar_initial || u.name.charAt(0),
    current_season:          u.current_season || null,
    profile_photo:           u.profile_photo || null,
    community_goals_public:  u.community_goals_public !== 0,
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
    currentUserId: req.session.user.id
  });
});

// ─── Calendar ──────────────────────────────────────────────────────────────

// Weekly meeting cadence — hardcoded per the course curriculum design.
// 3-week cadence (Group → 1:1 → Office Hours) repeats Weeks 1-9, then the
// final block (Weeks 10-12) breaks pattern: Group, 1:1, Group.
const WEEKLY_MEETINGS = {
  1:  { type: 'group',        label: 'Group Meeting', note: "Recorded if you can't attend" },
  2:  { type: 'one-on-one',   label: 'One-on-One' },
  3:  { type: 'office-hours', label: 'Office Hours' },
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
  const weekStarts           = generateCourseWeeks(courseStartDate, courseLengthWeeks);
  const allGoalsRaw          = db.getGoalsForWeeks(userId, weekStarts);
  const reflectionsRaw       = db.getWeeklyReflections(userId, weekStarts);
  const cats                 = ['curiosity', 'create', 'share', 'connect'];

  const weeks = weekStarts.map((weekStart, idx) => {
    const goalsMap   = allGoalsRaw[weekStart] || {};
    const goalsData  = {};
    const goalsExist = {};
    for (const cat of cats) {
      goalsData[cat]  = parseGoalText(goalsMap[cat]?.goal_text);
      const gd        = goalsData[cat];
      goalsExist[cat] = !!(gd.items && gd.items.length > 0);
    }
    const allGoalsSet   = cats.every(cat => goalsExist[cat]);
    const isIntegration = cats.some(cat => goalsMap[cat]?.is_integration_week);
    const weekNum = idx + 1;
    const curricularSeason = getCurricularSeason(weekNum);
    const curricularSeasonLabel = getCurricularSeasonLabel(curricularSeason);
    return {
      weekStart,
      weekIndex:          idx,
      weekNum,
      weekName:           'Week ' + WEEK_ORDINALS[idx],
      dateRange:          formatDateRangeShort(weekStart),
      isCurrentWeek:      weekStart === currentWeekStart,
      isPastWeek:         weekStart < currentWeekStart,
      isFutureWeek:       weekStart > currentWeekStart,
      isPastCourseWeek:   weekStart < courseCurrentWeekStart,
      isIntegration,
      curricularSeason,
      curricularSeasonLabel,
      meeting:            WEEKLY_MEETINGS[weekNum] || null,
      goalsData,
      goalsMap,
      goalsExist,
      allGoalsSet,
      reflection:         reflectionsRaw[weekStart] || null
    };
  });

  res.render('calendar', {
    title:                courseLengthWeeks < 12 ? `Your ${courseLengthWeeks}-Week Trial` : 'Your 12-Week Journey',
    page:                 'calendar',
    weeks,
    currentWeekStart,
    courseCurrentWeekStart,
    courseStartDate,
    courseLengthWeeks,
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
    text: 'What would feel most meaningful to see by the end of these next 12 weeks?',
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
    text: 'What promise are you making to yourself for these 12 weeks?',
    placeholder: 'Write it like you mean it.'
  }
];

// Trial students see this at the end of their 3-week run instead of the
// 12-week harvest. Calibrated for a shorter window: lighter, more
// open-ended, with an explicit "continue with the full course?" question.
// Fields map into the existing self_assessments table — the schema is
// generous enough that we don't need a parallel table.
const TRIAL_CLOSING_QUESTIONS = [
  { id: 'tq1', type: 'rating', field: 'q2_rating',
    text: 'How do you feel about your relationship with sharing your work, three weeks in?',
    low:  '1 = the same as when I started',
    high: '10 = something has shifted'
  },
  { id: 'tq2', type: 'multi', field: 'q7_choices', max: 2,
    text: "What's changed for you in these 3 weeks?",
    choices: [
      { val: 'A', label: 'I see my creative practice differently' },
      { val: 'B', label: "I'm sharing with more intention" },
      { val: 'C', label: 'My nervous system feels less reactive about being seen' },
      { val: 'D', label: 'I have a clearer sense of what I want to say' },
      { val: 'E', label: 'The way I think about visibility has shifted' },
      { val: 'F', label: "Nothing has changed yet — I'd need more time" },
    ]
  },
  { id: 'tq3', type: 'text', field: 'q9_text',
    text: 'What surprised you most in these 3 weeks?',
    placeholder: 'A small moment, a shift, anything you didn\'t expect.'
  },
  { id: 'tq4', type: 'text', field: 'q10_text',
    text: "Is there anything from this trial you'll keep using?",
    placeholder: 'A practice, a question, a frame to come back to.'
  },
  { id: 'tq5', type: 'text', field: 'q11_text',
    text: 'Where did you get stuck, or where did the trial fall short for you?',
    placeholder: 'Honesty here helps the next round of students.'
  },
  { id: 'tq6', type: 'choice', field: 'q8_choice',
    text: 'Would you like to continue with the full 12-week Creative’s Garden?',
    choices: [
      { val: 'A', label: 'Yes — I want to enroll in the full course' },
      { val: 'B', label: "Maybe — I'm interested, tell me more" },
      { val: 'C', label: 'Not right now — but glad I tried this' },
      { val: 'D', label: 'No' },
    ]
  },
  { id: 'tq7', type: 'text', field: 'q12_text', optional: true,
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
  // Mid-course doesn't apply to short trials. Gating here prevents both the
  // global admin override AND the date-based unlock from leaking the
  // mid-course card / route to a 3-week trial student.
  if (getCourseLengthWeeks(user) < 12) return false;
  if (db.getSetting('midcourse_unlocked') === 'true') return true; // admin manual override
  const courseStart = db.getUserCourseStartDate(user);
  if (!courseStart) return false;
  const daysDiff = Math.floor((Date.now() - new Date(courseStart + 'T00:00:00').getTime()) / 86400000);
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
  const daysDiff = Math.floor((Date.now() - new Date(courseStart + 'T00:00:00').getTime()) / 86400000);
  return daysDiff >= (getCourseLengthWeeks(user) - 1) * 7;
}

app.get('/trial-closing', requireAuth, (req, res) => {
  if (req.session.user.role === 'admin') return res.redirect('/dashboard');
  if (!isTrialClosingUnlockedFor(req.session.user)) return res.redirect('/dashboard');
  if (db.hasTrialClosingBeenSubmittedByUser(req.session.user.id)) return res.redirect('/dashboard');
  res.render('trial-closing', {
    title: 'Trial closing reflection',
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
      if (!Number.isFinite(n) || n < 1 || n > 10) return res.status(400).json({ error: `Question ${q.id} requires a 1–10 rating.` });
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
  if (req.session.user.role === 'admin') return res.redirect('/dashboard');
  if (req.session.user.onboarding_completed) return res.redirect('/dashboard');
  res.render('onboarding', {
    title: 'Welcome',
    questions: ASSESSMENT_QUESTIONS
  });
});

app.post('/api/onboarding/assessment', requireAuth, (req, res) => {
  db.upsertAssessment(req.session.user.id, 'opening', req.body);
  res.json({ ok: true });
});

app.post('/api/onboarding/complete', requireAuth, (req, res) => {
  const userId = req.session.user.id;
  db.setOnboardingComplete(userId);
  console.log(`✓ Onboarding complete: user ${userId}`);
  req.session.user.onboarding_completed = true;
  req.session.save(err => {
    if (err) return res.status(500).json({ error: 'Session save failed.' });
    res.json({ ok: true });
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
    profile
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
    now = (simulated && simulated.trim())
      ? new Date(simulated + 'T00:00:00')
      : new Date();
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

const STAGE_LABELS = {
  1: { slug: 'just-planted', label: 'Just planted'  },
  2: { slug: 'first-sprout', label: 'First sprout'  },
  3: { slug: 'young-plant',  label: 'Young plant'   },
  4: { slug: 'growing',      label: 'Growing'       },
  5: { slug: 'established',  label: 'Established'   },
  6: { slug: 'buds',         label: 'Buds forming'  },
  7: { slug: 'in-bloom',     label: 'In bloom'      }
};

function getGardenStage(user) {
  const now = getNow(user);

  const goalMap = db.getGreenhouseGoals(user.id);
  const activeGoals = [1, 2, 3]
    .map(n => goalMap[n].replacement || goalMap[n].original)
    .filter(Boolean)
    .filter(s => new Date(s.created_at) <= now);
  if (activeGoals.length === 0) return null;

  const earliest = activeGoals.reduce(
    (min, s) => s.created_at < min.created_at ? s : min,
    activeGoals[0]
  );

  const closing = db.getAssessment(user.id, 'closing');
  const growthCheckDone = closing && new Date(closing.completed_at) <= now;
  if (growthCheckDone) return 7;

  const planted = new Date(earliest.created_at);
  const weeksElapsed = Math.floor((now - planted) / (7 * 24 * 60 * 60 * 1000));

  if (weeksElapsed < 2)  return 1;
  if (weeksElapsed < 4)  return 2;
  if (weeksElapsed < 6)  return 3;
  if (weeksElapsed < 8)  return 4;
  if (weeksElapsed < 10) return 5;
  return 6;
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
      gardenStage: null, stageSlug: null, stageLabel: null,
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

  const gardenStage = getGardenStage(req.session.user);
  const stageInfo = gardenStage ? STAGE_LABELS[gardenStage] : null;
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
    gardenStage,
    stageSlug:  stageInfo ? stageInfo.slug  : null,
    stageLabel: stageInfo ? stageInfo.label : null,
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
  const allowedSort   = new Set(['newest', 'oldest']);
  const allowedFilter = new Set(['all', 'watched', 'unwatched', 'edited', 'not-edited']);
  const sort   = allowedSort.has(req.query.sort)     ? req.query.sort   : 'newest';
  const filter = allowedFilter.has(req.query.filter) ? req.query.filter : 'all';

  let cuttings = db.getCuttingsForUser(req.session.user.id);
  const totalCount = cuttings.length;

  // Filter by mark state.
  if (filter === 'watched')      cuttings = cuttings.filter(c => c.watched);
  else if (filter === 'unwatched') cuttings = cuttings.filter(c => !c.watched);
  else if (filter === 'edited')    cuttings = cuttings.filter(c => c.edited);
  else if (filter === 'not-edited') cuttings = cuttings.filter(c => !c.edited);

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
    filter,
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

app.get('/account', requireAuth, (req, res) => {
  const profile = db.getUserFullProfile(req.session.user.id);
  res.render('account', {
    title: 'My Account',
    page: 'account',
    profile,
    timezones: TIMEZONES
  });
});

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

// ─── Resources ─────────────────────────────────────────────────────────────

app.get('/resources', requireAuth, (req, res) => {
  res.render('resources', { title: 'Resources', page: 'resources' });
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
  const courseStartDate    = db.getSetting('course_start_date') || '';
  const harvestUnlocked    = db.getSetting('harvest_unlocked') === 'true';
  const midcourseUnlocked  = db.getSetting('midcourse_unlocked') === 'true';
  const simulatedToday     = db.getSetting('simulated_today') || null;
  const studentAssessments = db.getAllStudentAssessmentStatus();

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

  res.render('admin', {
    title: 'Admin', page: 'admin',
    users, lessons, resources, lessonStats, lessonHomework, courseStartDate,
    harvestUnlocked, midcourseUnlocked,
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
  const allowed = ['course_start_date', 'harvest_unlocked', 'midcourse_unlocked', 'simulated_today'];
  if (!allowed.includes(key)) return res.status(400).json({ error: 'Invalid key' });
  db.setSetting(key, value);
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
    const newUser = db.getUserById(result.lastInsertRowid);
    res.json({ ok: true, user: newUser });
  } catch (e) {
    if (e.message && e.message.includes('UNIQUE')) return res.status(409).json({ error: 'That email is already in use.' });
    res.status(500).json({ error: 'Failed to create user.' });
  }
});

app.put('/api/admin/users/:id', requireAdmin, (req, res) => {
  const id = parseInt(req.params.id);
  const { name, email, role, password, course_length_weeks } = req.body;
  if (!name || !email) return res.status(400).json({ error: 'Name and email are required.' });
  if (!['student', 'admin'].includes(role)) return res.status(400).json({ error: 'Invalid role.' });
  try {
    db.updateUser(id, name, email, role, password || null);
    if (course_length_weeks !== undefined) {
      db.setUserCourseLengthWeeks(id, course_length_weeks);
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

// ─── Daily cuttings digest ─────────────────────────────────────────────────
// Triggered by an external cron (GitHub Actions) hitting this route every
// morning. Reports yesterday's cuttings — one email per student who
// recorded something. Protected by CRON_SECRET in the X-Cron-Secret header
// instead of the admin session, because the cron caller doesn't have one.
//
// Gated by a constant-time compare on the secret to avoid timing-based
// guessing, and bails fast with 503 if CRON_SECRET isn't set (so a
// misconfigured production never silently accepts unauthenticated requests).
// Response body includes the per-line trace so you can read it in the
// GitHub Actions logs.
const { runDigest: runDailyDigest } = require('./lib/daily-cuttings-digest');

function safeEqual(a, b) {
  const ab = Buffer.from(String(a), 'utf8');
  const bb = Buffer.from(String(b), 'utf8');
  if (ab.length !== bb.length) return false;
  return require('crypto').timingSafeEqual(ab, bb);
}

app.post('/admin/run-daily-digest', async (req, res) => {
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
    const summary = await runDailyDigest({ dryRun, log: capture });
    res.json({ ok: true, dryRun, summary, log });
  } catch (err) {
    console.error('[digest route] fatal:', err);
    res.status(500).json({ ok: false, error: err.message, log });
  }
});

// ─── Daily push reminders ──────────────────────────────────────────────────
// Triggered hourly by GitHub Actions. The lib decides per-user whether the
// current UTC hour maps to that student's chosen local hour, so this route
// is dumb — it just runs the lib and reports.
const { runDailyReminders } = require('./lib/daily-reminders');

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
    const summary = await runDailyReminders({ dryRun, log: capture });
    res.json({ ok: true, dryRun, summary, log });
  } catch (err) {
    console.error('[daily-reminders route] fatal:', err);
    res.status(500).json({ ok: false, error: err.message, log });
  }
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
    midcourseUnlocked: isFullCourse && (midcourseDate || db.getSetting('midcourse_unlocked') === 'true'),
    harvestUnlocked:   closingDate || db.getSetting('harvest_unlocked')   === 'true'
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

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`\n✨ The Creative's Garden is running at http://localhost:${PORT}\n`);
});
