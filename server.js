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
const { sendPasswordResetEmail } = require('./email');
const { ANGLES, getAngle, getQuestion } = require('./lib/seed-packet-questions');
const { getCurricularSeason, getCurricularSeasonLabel, getCurricularSeasonDescriptor } = require('./lib/curricular-season');
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

// Auto-unlock: persist date-based unlock flags to DB once thresholds pass
app.use((req, res, next) => {
  const courseStart = db.getSetting('course_start_date');
  if (courseStart) {
    const daysDiff = Math.floor((Date.now() - new Date(courseStart + 'T00:00:00').getTime()) / 86400000);
    if (daysDiff >= 35 && db.getSetting('midcourse_unlocked') !== 'true') {
      db.setSetting('midcourse_unlocked', 'true');
      console.log('✓ Mid-course auto-unlocked (Week 6)');
    }
    if (daysDiff >= 77 && db.getSetting('harvest_unlocked') !== 'true') {
      db.setSetting('harvest_unlocked', 'true');
      console.log('✓ Harvest auto-unlocked (Week 12)');
    }
  }
  next();
});

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
    profile_photo: user.profile_photo || null
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

app.get('/dashboard', requireAuth, (req, res) => {
  const userId = req.session.user.id;
  const courseWeek = getCurrentCourseWeek(req.session.user);
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

  // Recording card initial state: did this user mark "recorded" today already?
  // "Today" uses the time-travel-aware now so admin Time Travel rolls it over.
  const today = toLocalDateString(getNow(req.session.user));
  const recordedToday = db.getLastRecordedDate(req.session.user.id) === today;

  res.render('dashboard', {
    title: 'Dashboard',
    page: 'dashboard',
    greeting: getGreeting(),
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
    recordedToday,
    quote: getRotatingQuote()
  });
});

// ─── Daily recording practice: save an optional reflection ("cutting") ─────
// No video is uploaded or stored — only the reflection text is persisted.
// Empty / whitespace-only text is treated as a skip and inserts nothing.
// Also stamps users.last_recorded_date so the card remembers the user
// recorded today, even if they reach this endpoint without hitting the
// /dashboard/recorded-today route first (belt-and-suspenders, idempotent).
app.post('/dashboard/cutting', requireAuth, (req, res) => {
  const text = (req.body && typeof req.body.reflection_text === 'string')
    ? req.body.reflection_text.trim()
    : '';
  if (!text) {
    return res.json({ saved: false });
  }
  const now = getNow(req.session.user);
  const today = toLocalDateString(now);
  const courseWeek = getCurrentCourseWeek(req.session.user);
  const season = getCurricularSeason(courseWeek.weekNumber);
  db.createCutting(req.session.user.id, season, 'What did you notice today?', text);
  db.markRecordedToday(req.session.user.id, today);
  res.json({ saved: true });
});

// ─── Mark "I recorded today" — stamp the date so the card remembers ────────
// Independent of saving a reflection. Setting the same date twice is a no-op
// (idempotent UPDATE). Resets naturally when today's date changes.
app.post('/dashboard/recorded-today', requireAuth, (req, res) => {
  const today = toLocalDateString(getNow(req.session.user));
  db.markRecordedToday(req.session.user.id, today);
  res.json({ ok: true, date: today });
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
  const courseStartDate = db.getSetting('course_start_date');
  const weekNames = {};
  if (courseStartDate) {
    generate12Weeks(courseStartDate).forEach((ws, i) => {
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
  const allWeekStarts = courseStartDate ? generate12Weeks(courseStartDate) : [];
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
  const lessons = db.getAllLessons();
  const completedIds = new Set(db.completedLessonIds(req.session.user.id));
  res.render('lessons', {
    title: 'Field Notes',
    page: 'lessons',
    lessons,
    completedIds,
    completedCount: completedIds.size
  });
});

app.get('/lessons/:slug', requireAuth, (req, res) => {
  const lesson = db.getLessonBySlug(req.params.slug);
  if (!lesson) return res.status(404).render('error', { title: '404', message: 'Lesson not found.', user: req.session.user });
  const completed = !!db.getLessonCompletion(req.session.user.id, lesson.id);
  const allLessons = db.getAllLessons();
  const idx = allLessons.findIndex(l => l.id === lesson.id);
  const prevLesson = idx > 0 ? allLessons[idx - 1] : null;
  const nextLesson = idx < allLessons.length - 1 ? allLessons[idx + 1] : null;
  const homework = db.getHomeworkForLesson(lesson.id);
  const homeworkDone = new Set(db.getHomeworkCompletions(req.session.user.id, lesson.id));
  const lessonNumber = idx + 1;
  const curricularSeason = getCurricularSeason(lessonNumber);
  const curricularSeasonLabel = getCurricularSeasonLabel(curricularSeason);
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
  const courseStartDate  = db.getSetting('course_start_date') || currentWeekStart;
  const weekStarts       = generate12Weeks(courseStartDate);
  const firstWeek        = weekStarts[0];
  const lastWeek         = weekStarts[11];

  // Accessible ceiling: can't exceed current week or Week 12
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

  const members = allUsers.map(u => ({
    id:                      u.id,
    name:                    u.name,
    avatar_initial:          u.avatar_initial || u.name.charAt(0),
    current_season:          u.current_season || null,
    profile_photo:           u.profile_photo || null,
    community_goals_public:  u.community_goals_public !== 0,
    community_season_public: u.community_season_public !== 0,
    goals:                   goalsMap[u.id] || {}
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

app.get('/calendar', requireAuth, (req, res) => {
  const userId               = req.session.user.id;
  const courseCurrentWeekStart = getCurrentCourseWeek(req.session.user).weekStart;
  const currentWeekStart     = courseCurrentWeekStart;
  const courseStartDate      = db.getSetting('course_start_date') || currentWeekStart;
  const weekStarts           = generate12Weeks(courseStartDate);
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
      goalsData,
      goalsMap,
      goalsExist,
      allGoalsSet,
      reflection:         reflectionsRaw[weekStart] || null
    };
  });

  res.render('calendar', {
    title:                "Your 12-Week Journey",
    page:                 'calendar',
    weeks,
    currentWeekStart,
    courseCurrentWeekStart,
    courseStartDate
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
    text: 'How congruent do you feel between who you are and how you show up online?',
    low: '1 = completely different people', high: '10 = exactly the same person'
  },
  { id: 'q3', type: 'choice', field: 'q3_choice',
    text: 'When you sit down to create — or even just think about creating — what\'s your default state?',
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
    text: 'What would feel most meaningful to track over the next 12 weeks?',
    choices: [
      { val: 'A', label: 'Engagement that feels like real connection' },
      { val: 'B', label: 'Showing up more consistently without burning out' },
      { val: 'C', label: 'Energy and nervous system wins — posting without dread' },
      { val: 'D', label: 'People finding my work and feeling something' },
      { val: 'E', label: 'Alignment — am I actually saying what I mean?' },
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

const CLOSING_QUESTIONS = [
  { id: 'q7', type: 'text', field: 'q7_choices',
    text: 'What surprised you most about this experience?',
    placeholder: 'What caught you off guard — in the best or hardest way?' },
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
    placeholder: 'Describe the shift — even if it\'s subtle.' },
  { id: 'q10', type: 'text', field: 'q10_text',
    text: 'What will you keep doing after this course ends?',
    placeholder: 'What rhythm will you carry forward?' },
  { id: 'q11', type: 'text', field: 'q11_text',
    text: 'What would you tell someone who is standing where you were 12 weeks ago?',
    placeholder: 'What do they need to hear?' },
  { id: 'q12', type: 'text', field: 'q12_text',
    text: 'Is there anything that would have improved your experience in The Creative\'s Garden?',
    placeholder: 'Your honesty helps the garden grow.' }
];

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

function getNow(user) {
  if (isTimeTravelUser(user)) {
    const simulated = db.getSetting('simulated_today');
    if (simulated && simulated.trim()) return new Date(simulated + 'T00:00:00');
  }
  return new Date();
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

function isGoalLocked(goal, user) {
  if (!goal || !goal.created_at) return false;
  const planted = new Date(goal.created_at);
  return getNow(user).getTime() < planted.getTime() + 28 * 24 * 60 * 60 * 1000;
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

  // Load goals only when tending
  let goals = null;
  if (state === 'tending') {
    goals = db.getGreenhouseGoals(userId);
    // Attach lock status to each slot
    for (const n of [1, 2, 3]) {
      const entry = goals[n];
      const activeGoal = entry.replacement || entry.original;
      entry.locked = isGoalLocked(activeGoal, req.session.user);
      if (entry.locked && activeGoal) {
        const unlockMs = new Date(activeGoal.created_at).getTime() + 28 * 24 * 60 * 60 * 1000;
        entry.unlockDate = new Date(unlockMs).toLocaleDateString('en-US', { month: 'long', day: 'numeric' });
      }
    }
  }

  // Growth Check: unlocks at day 77 from course start
  const courseStart = db.getSetting('course_start_date');
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
app.get('/greenhouse/cuttings', requireAuth, (req, res) => {
  const cuttings = db.getCuttingsForUser(req.session.user.id);

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

  // Null/unknown-season cuttings get a quiet "Other" group at the end.
  if (buckets._other_ && buckets._other_.length) {
    seasonGroups.push({
      season:     null,
      label:      'Other',
      descriptor: '',
      entries:    buckets._other_,
    });
  }

  res.render('greenhouse-cuttings', {
    title: 'Cuttings',
    page: 'greenhouse',
    user: req.session.user,
    totalCount: cuttings.length,
    seasonGroups,
  });
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
});

app.post('/api/greenhouse/plant', requireAuth, (req, res) => {
  const userId = req.session.user.id;
  if (!db.getLessonCompletion(userId, 1)) {
    return res.status(403).json({ error: 'Complete Lesson 1 first.' });
  }
  const { seeds } = req.body;
  if (!Array.isArray(seeds) || seeds.length !== 3) {
    return res.status(400).json({ error: 'Invalid seeds data.' });
  }
  // When time travel is active for admin, seeds are planted at the simulated date so
  // the 4-week lock window aligns with the simulated timeline.
  const now = getNow(req.session.user);
  const createdAt = now.toISOString().replace('T', ' ').split('.')[0];
  for (const s of seeds) {
    const num = parseInt(s.seed_number);
    if (![1, 2, 3].includes(num)) return res.status(400).json({ error: 'Invalid seed number.' });
    if (!s.feeling || !s.looks_like) return res.status(400).json({ error: 'All seed fields are required.' });
    db.upsertGreenhouseGoal(userId, num, s.feeling, s.looks_like, createdAt);
  }
  res.json({ ok: true });
});

app.post('/api/seeds/:id/keep', requireAuth, (req, res) => res.redirect(301, '/api/goals/' + req.params.id + '/keep'));

app.post('/api/goals/:id/keep', requireAuth, (req, res) => {
  const goalId = parseInt(req.params.id);
  if (!goalId) return res.status(400).json({ error: 'Invalid goal id.' });
  const goal = db.getGoalById(goalId, req.session.user.id);
  if (!goal) return res.status(404).json({ error: 'Goal not found.' });
  if (isGoalLocked(goal, req.session.user)) return res.status(403).json({ error: 'Goal is still in the lock period.' });
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
  const activeGoal = db.getActiveGoalByNumber(req.session.user.id, num);
  if (activeGoal && isGoalLocked(activeGoal, req.session.user)) {
    return res.status(403).json({ error: 'Goal is still in the lock period.' });
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
  const courseStart = db.getSetting('course_start_date');
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
    Number(req.body.sortOrder) || 0
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
    Number(req.body.sortOrder) || 0
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
  const allGoals           = db.getAllGoalsForAdmin();
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
    simulatedToday, allGoals,
    studentAssessments,
    questions: ASSESSMENT_QUESTIONS,
    closingQuestions: CLOSING_QUESTIONS
  });
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

app.post('/api/admin/seeds/:id/planted-at', requireAdmin, (req, res) => res.redirect(301, '/api/admin/goals/' + req.params.id + '/planted-at'));

app.post('/api/admin/goals/:id/planted-at', requireAdmin, (req, res) => {
  const { date } = req.body;
  if (!date || !/^\d{4}-\d{2}-\d{2}$/.test(date)) {
    return res.status(400).json({ error: 'Invalid date format. Use YYYY-MM-DD.' });
  }
  db.updateGoalCreatedAt(parseInt(req.params.id), date);
  res.json({ ok: true });
});


// ─── Admin: Students ───────────────────────────────────────────────────────

app.post('/api/admin/users', requireAdmin, (req, res) => {
  const { name, email, password, role } = req.body;
  if (!name || !email || !password) return res.status(400).json({ error: 'Name, email, and password are required.' });
  if (!['student', 'admin'].includes(role)) return res.status(400).json({ error: 'Invalid role.' });
  try {
    const result = db.createUser(name.trim(), email.trim().toLowerCase(), password, role);
    const newUser = db.getUserById(result.lastInsertRowid);
    res.json({ ok: true, user: newUser });
  } catch (e) {
    if (e.message && e.message.includes('UNIQUE')) return res.status(409).json({ error: 'That email is already in use.' });
    res.status(500).json({ error: 'Failed to create user.' });
  }
});

app.put('/api/admin/users/:id', requireAdmin, (req, res) => {
  const id = parseInt(req.params.id);
  const { name, email, role, password } = req.body;
  if (!name || !email) return res.status(400).json({ error: 'Name and email are required.' });
  if (!['student', 'admin'].includes(role)) return res.status(400).json({ error: 'Invalid role.' });
  try {
    db.updateUser(id, name, email, role, password || null);
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

// ─── Helpers ───────────────────────────────────────────────────────────────

function getUnlockState(user) {
  // Check date-based logic OR manual DB flags — whichever is true wins
  const courseStart = db.getSetting('course_start_date');
  let midcourseDate = false, closingDate = false;
  if (courseStart) {
    const now = getNow(user);
    const daysDiff = Math.floor((now.getTime() - new Date(courseStart + 'T00:00:00').getTime()) / 86400000);
    midcourseDate = daysDiff >= 35;
    closingDate   = daysDiff >= 77;
  }
  return {
    midcourseUnlocked: midcourseDate || db.getSetting('midcourse_unlocked') === 'true',
    harvestUnlocked:   closingDate   || db.getSetting('harvest_unlocked')   === 'true'
  };
}

function getGreeting() {
  const h = new Date().getHours();
  if (h < 12) return 'Good morning';
  if (h < 17) return 'Good afternoon';
  return 'Good evening';
}

function getWeekStart() {
  const now = new Date();
  const day = now.getDay();
  const diff = day === 0 ? -6 : 1 - day;
  const monday = new Date(now);
  monday.setDate(now.getDate() + diff);
  monday.setHours(0, 0, 0, 0);
  return monday.toISOString().split('T')[0];
}

// Returns { weekNumber, weekStart, weekEnd } relative to course_start_date.
// weekNumber is 1-based; 0 means before course start; null means no course start set.
// Uses getNow(user) so time-travel works correctly.
function getCurrentCourseWeek(user) {
  const courseStartStr = db.getSetting('course_start_date');
  if (!courseStartStr || !courseStartStr.trim()) {
    const ws = getWeekStart();
    const we = new Date(ws + 'T00:00:00');
    we.setDate(we.getDate() + 6);
    return { weekNumber: null, weekStart: ws, weekEnd: we.toISOString().split('T')[0] };
  }

  const courseStart = new Date(courseStartStr + 'T00:00:00');
  const now = getNow(user);
  const today = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  const daysSinceStart = Math.floor((today - courseStart) / 86400000);

  if (daysSinceStart < 0) {
    const ws = getWeekStart();
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

function generate12Weeks(startDate) {
  const weeks = [];
  const start = new Date(startDate + 'T00:00:00');
  for (let i = 0; i < 12; i++) {
    const d = new Date(start);
    d.setDate(d.getDate() + i * 7);
    weeks.push(d.toISOString().split('T')[0]);
  }
  return weeks;
}

function getRotatingQuote() {
  const quotes = [
    { text: "You already know what you want to say. Let's find it together.", source: "The Creative's Garden" },
    { text: "Visibility that feels like a return to self.", source: "The Meibos Touch" },
    { text: "You're not bad at marketing. You're just doing it wrong for who you are.", source: "The Creative's Garden" },
    { text: "Nobody creates well from an empty cup.", source: "The Creative's Garden" },
    { text: "Don't wait to be done to show up.", source: "The Creative's Garden" },
    { text: "Curiosity is not a luxury. It's load-bearing infrastructure for your creative life.", source: "The Creative's Garden" },
    { text: "The buffer isn't procrastination. It's wisdom.", source: "The Creative's Garden" },
  ];
  const today = new Date();
  const idx = (today.getFullYear() * 365 + today.getMonth() * 31 + today.getDate()) % quotes.length;
  return quotes[idx];
}

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`\n✨ The Creative's Garden is running at http://localhost:${PORT}\n`);
});
