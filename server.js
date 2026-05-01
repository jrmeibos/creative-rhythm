require('dotenv').config();
const express = require('express');
const session = require('express-session');
const FileStore = require('session-file-store')(session);
const bcrypt = require('bcryptjs');
const path = require('path');
const db = require('./db');
const { requireAuth, requireAdmin } = require('./auth');

const app = express();

app.set('view engine', 'ejs');
app.set('views', path.join(__dirname, 'views'));
app.use(express.static(path.join(__dirname, 'public')));
app.use(express.urlencoded({ extended: true }));
app.use(express.json());

app.use(session({
  store: new FileStore({ path: './sessions', ttl: 86400 * 7, reapInterval: 3600 }),
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
  next();
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
  req.session.user = { id: user.id, name: user.name, email: user.email, role: user.role, avatar_initial: user.avatar_initial };
  res.redirect('/dashboard');
});

app.get('/logout', (req, res) => {
  req.session.destroy(() => res.redirect('/'));
});

// ─── Dashboard ─────────────────────────────────────────────────────────────

app.get('/dashboard', requireAuth, (req, res) => {
  const userId = req.session.user.id;
  const weekStart = getWeekStart();
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

  res.render('dashboard', {
    title: 'Dashboard',
    page: 'dashboard',
    greeting: getGreeting(),
    weekStart,
    weekLabel: formatWeekLabel(weekStart),
    goals: goalsMap,
    goalsData: goalsDataDash,
    currentLesson,
    allLessons,
    completedCount,
    totalLessons: allLessons.length,
    isIntegrationWeek,
    quote: getRotatingQuote()
  });
});

// ─── Goals ─────────────────────────────────────────────────────────────────

app.get('/goals', requireAuth, (req, res) => {
  const userId = req.session.user.id;
  const currentWeekStart = getWeekStart();
  const requestedWeek = req.query.week || currentWeekStart;

  // Validate week format (YYYY-MM-DD)
  const weekStart = /^\d{4}-\d{2}-\d{2}$/.test(requestedWeek) ? requestedWeek : currentWeekStart;

  const goals = db.getGoalsForWeek(userId, weekStart);
  const goalsMap = {};
  for (const g of goals) goalsMap[g.category] = g;

  const isIntegrationWeek = goals.some(g => g.is_integration_week);
  const history = db.getWeekHistory(userId, 12);

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

  res.render('goals', {
    title: 'My Goals',
    page: 'goals',
    weekStart,
    weekLabel: formatWeekLabel(weekStart),
    currentWeekStart,
    goals: goalsMap,
    goalsData: goalsDataPage,
    isIntegrationWeek,
    isPastWeek,
    isFutureWeek,
    prevWeek: prevWeek.toISOString().split('T')[0],
    nextWeek: nextWeek.toISOString().split('T')[0],
    history,
    formatWeekLabel
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

// ─── Lessons ───────────────────────────────────────────────────────────────

app.get('/lessons', requireAuth, (req, res) => {
  const lessons = db.getAllLessons();
  const completedIds = new Set(db.completedLessonIds(req.session.user.id));
  res.render('lessons', {
    title: 'Lessons',
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
  res.render('lesson', {
    title: lesson.title,
    page: 'lessons',
    lesson,
    completed,
    prevLesson,
    nextLesson
  });
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
  const currentWeekStart = getWeekStart();
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

  const allUsers = db.getAllUsers().filter(u => u.role === 'student');
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
    id:             u.id,
    name:           u.name,
    avatar_initial: u.avatar_initial || u.name.charAt(0),
    goals:          goalsMap[u.id] || {}
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
  const userId         = req.session.user.id;
  const currentWeekStart = getWeekStart();
  const courseStartDate  = db.getSetting('course_start_date') || currentWeekStart;
  const weekStarts       = generate12Weeks(courseStartDate);
  const allGoalsRaw      = db.getGoalsForWeeks(userId, weekStarts);
  const cats             = ['curiosity', 'create', 'share', 'connect'];

  const weeks = weekStarts.map((weekStart, idx) => {
    const goalsMap   = allGoalsRaw[weekStart] || {};
    const goalsData  = {};
    const goalsExist = {};
    for (const cat of cats) {
      goalsData[cat]  = parseGoalText(goalsMap[cat]?.goal_text);
      const gd        = goalsData[cat];
      goalsExist[cat] = !!(gd.items && gd.items.length > 0);
    }
    const allGoalsSet  = cats.every(cat => goalsExist[cat]);
    const isIntegration = cats.some(cat => goalsMap[cat]?.is_integration_week);
    return {
      weekStart,
      weekIndex:     idx,
      weekName:      'Week ' + WEEK_ORDINALS[idx],
      dateRange:     formatDateRangeShort(weekStart),
      isCurrentWeek: weekStart === currentWeekStart,
      isPastWeek:    weekStart < currentWeekStart,
      isFutureWeek:  weekStart > currentWeekStart,
      isIntegration,
      goalsData,
      goalsMap,
      goalsExist,
      allGoalsSet
    };
  });

  res.render('calendar', {
    title:           "Your 12-Week Journey",
    page:            'calendar',
    weeks,
    currentWeekStart,
    courseStartDate
  });
});

// ─── Resources ─────────────────────────────────────────────────────────────

app.get('/resources', requireAuth, (req, res) => {
  res.render('coming-soon', { title: 'Resources', page: 'resources' });
});

// ─── Admin ─────────────────────────────────────────────────────────────────

app.get('/admin', requireAdmin, (req, res) => {
  const users           = db.getAllUsers();
  const lessonStats     = db.getLessonCompletionCounts();
  const courseStartDate = db.getSetting('course_start_date') || '';
  res.render('admin', { title: 'Admin', page: 'admin', users, lessonStats, courseStartDate });
});

app.post('/api/admin/settings', requireAdmin, (req, res) => {
  const { key, value } = req.body;
  if (!['course_start_date'].includes(key)) return res.status(400).json({ error: 'Invalid key' });
  db.setSetting(key, value);
  res.json({ ok: true });
});

// ─── Helpers ───────────────────────────────────────────────────────────────

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
    { text: "You already know what you want to say. Let's find it together.", source: "The Creative's Rhythm" },
    { text: "Visibility that feels like a return to self.", source: "The Meibos Touch" },
    { text: "You're not bad at marketing. You're just doing it wrong for who you are.", source: "The Creative's Rhythm" },
    { text: "Nobody creates well from an empty cup.", source: "The Creative's Rhythm" },
    { text: "Don't wait to be done to show up.", source: "The Creative's Rhythm" },
    { text: "Curiosity is not a luxury. It's load-bearing infrastructure for your creative life.", source: "The Creative's Rhythm" },
    { text: "The buffer isn't procrastination. It's wisdom.", source: "The Creative's Rhythm" },
  ];
  const today = new Date();
  const idx = (today.getFullYear() * 365 + today.getMonth() * 31 + today.getDate()) % quotes.length;
  return quotes[idx];
}

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`\n✨ The Creative's Rhythm is running at http://localhost:${PORT}\n`);
});
