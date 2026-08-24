require('dotenv').config();
const { DatabaseSync } = require('node:sqlite');
const bcrypt = require('bcryptjs');
const path = require('path');
const fs = require('fs');

const DB_PATH = process.env.DB_PATH || path.join(__dirname, 'data', 'creative-rhythm.db');
const dataDir = path.dirname(DB_PATH);
if (!fs.existsSync(dataDir)) fs.mkdirSync(dataDir, { recursive: true });

// Warn loudly in production if DB_PATH isn't pointing at the Railway Volume.
// If this fires, data will be written to the ephemeral container filesystem
// and wiped on every redeploy.
if (process.env.NODE_ENV === 'production' && (!process.env.DB_PATH || !process.env.DB_PATH.startsWith('/data'))) {
  console.error('');
  console.error('⚠️  CRITICAL: DB_PATH is not pointing to /data Volume!');
  console.error(`   Data will not persist. Current value: ${process.env.DB_PATH || '(unset)'}`);
  console.error('   Set DB_PATH=/data/creative-rhythm.db in Railway Variables.');
  console.error('');
}

const db = new DatabaseSync(DB_PATH);
db.exec('PRAGMA journal_mode = WAL');
db.exec('PRAGMA foreign_keys = ON');

// Parse a JSON column defensively. A single corrupted row (bad JSON in a
// bullets/checklist field) must not throw and 500 every page that lists
// that user's data — fall back to an empty array and log once.
function safeParseArray(raw) {
  if (!raw) return [];
  try {
    const v = JSON.parse(raw);
    return Array.isArray(v) ? v : [];
  } catch (e) {
    console.error('[db] corrupt JSON array column, defaulting to []:', String(raw).slice(0, 80));
    return [];
  }
}

db.exec(`
  CREATE TABLE IF NOT EXISTS users (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT NOT NULL,
    email TEXT UNIQUE NOT NULL,
    password_hash TEXT NOT NULL,
    role TEXT NOT NULL DEFAULT 'student',
    avatar_initial TEXT,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP
  );

  CREATE TABLE IF NOT EXISTS weekly_goals (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id INTEGER NOT NULL,
    week_start TEXT NOT NULL,
    category TEXT NOT NULL,
    goal_text TEXT DEFAULT '',
    completed INTEGER DEFAULT 0,
    reflection TEXT DEFAULT '',
    reflection_at DATETIME,
    is_integration_week INTEGER DEFAULT 0,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (user_id) REFERENCES users(id),
    UNIQUE(user_id, week_start, category)
  );

  -- Per-week override for "share my intentions with the community". One row
  -- per (user, week) that the student has explicitly set. When no row exists
  -- for a week, the effective value falls back to users.community_goals_public
  -- (the per-user default, still editable in Account settings).
  CREATE TABLE IF NOT EXISTS weekly_goal_shares (
    user_id INTEGER NOT NULL,
    week_start TEXT NOT NULL,
    shared INTEGER NOT NULL DEFAULT 1,
    updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    PRIMARY KEY (user_id, week_start),
    FOREIGN KEY (user_id) REFERENCES users(id)
  );

  -- Per-user dismissal state for dismissible dashboard banners (mid-course
  -- survey, closing reflection, season cards). One row per (user, banner_key):
  --   snooze_until = YYYY-MM-DD; the banner reappears on/after this date.
  --   dismissed    = 1 when removed for good (a permanent dismissal wins).
  CREATE TABLE IF NOT EXISTS banner_dismissals (
    user_id INTEGER NOT NULL,
    banner_key TEXT NOT NULL,
    snooze_until TEXT,
    dismissed INTEGER NOT NULL DEFAULT 0,
    updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    PRIMARY KEY (user_id, banner_key),
    FOREIGN KEY (user_id) REFERENCES users(id)
  );

  -- "The Creative Block Buster" — per-student personalization on top of the
  -- built-in blocks defined in lib/creative-blocks.js. block_key is either a
  -- built-in block's slug or 'custom-<id>' for a student's own block.
  CREATE TABLE IF NOT EXISTS block_buster_blocks (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id INTEGER NOT NULL,
    title TEXT NOT NULL,
    category TEXT,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (user_id) REFERENCES users(id)
  );
  CREATE TABLE IF NOT EXISTS block_buster_options (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id INTEGER NOT NULL,
    block_key TEXT NOT NULL,
    text TEXT NOT NULL,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (user_id) REFERENCES users(id)
  );
  CREATE TABLE IF NOT EXISTS block_buster_hidden (
    user_id INTEGER NOT NULL,
    block_key TEXT NOT NULL,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    PRIMARY KEY (user_id, block_key),
    FOREIGN KEY (user_id) REFERENCES users(id)
  );
  -- Every time a student busts a block (works a way through), it logs a NEW
  -- row here — a block can be busted many times, since real blocks recur.
  -- option_text + reflection record that particular breakthrough. Older installs
  -- had a UNIQUE (user_id, block_key) shape; migrated to this log below.
  CREATE TABLE IF NOT EXISTS block_buster_busted (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id INTEGER NOT NULL,
    block_key TEXT NOT NULL,
    option_text TEXT,
    reflection TEXT,
    busted_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (user_id) REFERENCES users(id)
  );
  -- The Propagation Table (Summer challenge): one row per rung a student has
  -- marked "made." Progress is per-rung, deliberately NOT tied to a specific
  -- cutting — the point is making from their whole idea bank. Rungs are defined
  -- in lib/propagation-table.js; note/published_url are reserved for later.
  CREATE TABLE IF NOT EXISTS propagation_makes (
    user_id INTEGER NOT NULL,
    rung_slug TEXT NOT NULL,
    note TEXT,
    published_url TEXT,
    file_path TEXT,
    made_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    PRIMARY KEY (user_id, rung_slug),
    FOREIGN KEY (user_id) REFERENCES users(id)
  );

  CREATE TABLE IF NOT EXISTS lessons (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    slug TEXT UNIQUE NOT NULL,
    title TEXT NOT NULL,
    subtitle TEXT,
    category_tag TEXT,
    content TEXT,
    estimated_read_time INTEGER DEFAULT 5,
    video_url TEXT,
    published INTEGER DEFAULT 1,
    sort_order INTEGER DEFAULT 0,
    published_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP
  );

  CREATE TABLE IF NOT EXISTS lesson_completions (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id INTEGER NOT NULL,
    lesson_id INTEGER NOT NULL,
    completed_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (user_id) REFERENCES users(id),
    FOREIGN KEY (lesson_id) REFERENCES lessons(id),
    UNIQUE(user_id, lesson_id)
  );

  CREATE TABLE IF NOT EXISTS resources (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    title TEXT NOT NULL,
    description TEXT,
    category_tag TEXT,
    url TEXT,
    file_path TEXT,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP
  );

  CREATE TABLE IF NOT EXISTS community_posts (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id INTEGER NOT NULL,
    content TEXT NOT NULL,
    category_tag TEXT,
    pinned INTEGER DEFAULT 0,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (user_id) REFERENCES users(id)
  );

  CREATE TABLE IF NOT EXISTS community_reactions (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    post_id INTEGER NOT NULL,
    user_id INTEGER NOT NULL,
    reaction_type TEXT NOT NULL DEFAULT 'heart',
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (post_id) REFERENCES community_posts(id),
    FOREIGN KEY (user_id) REFERENCES users(id),
    UNIQUE(post_id, user_id, reaction_type)
  );

  CREATE TABLE IF NOT EXISTS settings (
    key TEXT PRIMARY KEY,
    value TEXT NOT NULL DEFAULT ''
  );

  CREATE TABLE IF NOT EXISTS weekly_reflections (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id INTEGER NOT NULL,
    week_start TEXT NOT NULL,
    text TEXT DEFAULT '',
    shared_with_cohort INTEGER DEFAULT 0,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (user_id) REFERENCES users(id),
    UNIQUE(user_id, week_start)
  );

  CREATE TABLE IF NOT EXISTS goals (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id INTEGER NOT NULL,
    seed_number INTEGER NOT NULL,
    feeling TEXT DEFAULT '',
    looks_like TEXT DEFAULT '',
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (user_id) REFERENCES users(id),
    UNIQUE(user_id, seed_number)
  );

  CREATE TABLE IF NOT EXISTS fallow_beds (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id     INTEGER NOT NULL,
    bed_number  INTEGER NOT NULL,
    set_at      DATETIME DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (user_id) REFERENCES users(id),
    UNIQUE(user_id, bed_number)
  );

  -- Admin notification ledger. One row per (user, milestone) — the UNIQUE
  -- constraint guarantees each milestone email fires at most once per
  -- student, even under concurrent requests, because the atomic INSERT
  -- itself decides whether we send.
  CREATE TABLE IF NOT EXISTS notification_log (
    id         INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id    INTEGER NOT NULL,
    milestone  TEXT    NOT NULL,
    sent_at    DATETIME DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (user_id) REFERENCES users(id),
    UNIQUE(user_id, milestone)
  );

  -- Anonymous mid-course feedback. No user_id column — the structural link
  -- between "who submitted" and "what they said" is broken on purpose so
  -- students can be honest. Completion tracking lives separately on
  -- users.midcourse_submitted_at. submitted_at_day is YYYY-MM-DD so timing
  -- correlation is blurred to the day.
  CREATE TABLE IF NOT EXISTS midcourse_responses (
    id                INTEGER PRIMARY KEY AUTOINCREMENT,
    submitted_at_day  TEXT    NOT NULL,
    q1_rating         INTEGER,
    q2_working        TEXT DEFAULT '',
    q3_resistance     TEXT DEFAULT '',
    q4_improvement    TEXT DEFAULT '',
    q5_other          TEXT DEFAULT ''
  );

  CREATE TABLE IF NOT EXISTS self_assessments (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id INTEGER NOT NULL,
    assessment_type TEXT NOT NULL,
    q1_choice TEXT DEFAULT '',
    q2_rating INTEGER,
    q3_choice TEXT DEFAULT '',
    q4_rating INTEGER,
    q5_choice TEXT DEFAULT '',
    q6_rating INTEGER,
    q7_choices TEXT DEFAULT '',
    q8_choice TEXT DEFAULT '',
    q9_text TEXT DEFAULT '',
    q10_text TEXT DEFAULT '',
    harvest_reflection TEXT DEFAULT '',
    completed_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (user_id) REFERENCES users(id),
    UNIQUE(user_id, assessment_type)
  );

  -- One row per (user, device/browser) subscription to Web Push. The browser
  -- generates a unique endpoint URL on subscribe() and re-uses it on
  -- subsequent calls from the same install, so UNIQUE(endpoint) lets re-subs
  -- update in place. user_agent is captured at subscribe-time only so the
  -- student can identify which device a row corresponds to if we ever
  -- expose a per-device list.
  CREATE TABLE IF NOT EXISTS push_subscriptions (
    id            INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id       INTEGER NOT NULL,
    endpoint      TEXT    NOT NULL UNIQUE,
    p256dh        TEXT    NOT NULL,
    auth          TEXT    NOT NULL,
    user_agent    TEXT,
    created_at    DATETIME DEFAULT CURRENT_TIMESTAMP,
    last_seen_at  DATETIME DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
  );
  CREATE INDEX IF NOT EXISTS idx_push_subscriptions_user ON push_subscriptions(user_id);

  -- Stripe webhook event ledger. One row per successfully-processed event
  -- (identified by the Stripe event.id, which is globally unique). Guards
  -- against double-processing when Stripe retries a webhook delivery — the
  -- webhook handler inserts here inside a transaction with the upgrade, so
  -- either both happen or neither does.
  CREATE TABLE IF NOT EXISTS stripe_events (
    id             TEXT    PRIMARY KEY,
    type           TEXT    NOT NULL,
    processed_at   DATETIME DEFAULT CURRENT_TIMESTAMP
  );

  -- Rotating dashboard quotes. season is one of spring|summer|autumn|winter
  -- or NULL ("any season"). The dashboard helper filters to (user's chosen
  -- season OR NULL) so a student who hasn't picked a season still gets the
  -- generic pool. Curated by the admin via /admin → Quotes.
  CREATE TABLE IF NOT EXISTS quotes (
    id         INTEGER PRIMARY KEY AUTOINCREMENT,
    text       TEXT    NOT NULL,
    source     TEXT    DEFAULT '',
    season     TEXT,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
  );
`);

// Migrate existing databases to add new columns
(function migrate() {
  try {
    // 3B-i: Rename seeds → goals (Greenhouse planted commitments vocabulary migration)
    //
    // Idempotency notes:
    // - The schema block above always runs CREATE TABLE IF NOT EXISTS goals
    //   with the *old* UNIQUE(user_id, seed_number) constraint. If `seeds`
    //   already exists with post-rebuild multi-row data (replacements), copying
    //   via INSERT will violate that constraint and crash the migration.
    // - So when we see "stub goals + populated seeds", we drop the stub and
    //   rename seeds → goals, letting the post-rename schema (no UNIQUE,
    //   includes replacement columns) survive intact. The downstream
    //   "rebuild + add columns" migrations below are already idempotent and
    //   run cleanly on the renamed table.
    {
      const goalsTableExists = db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='goals'").get();
      const seedsTableExists = db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='seeds'").get();

      if (!goalsTableExists && seedsTableExists) {
        db.exec('ALTER TABLE seeds RENAME TO goals');
        console.log('✓ Migrated: renamed seeds → goals (Greenhouse planted commitments)');
      } else if (goalsTableExists && seedsTableExists) {
        const goalsCount = db.prepare('SELECT COUNT(*) as c FROM goals').get().c;
        const seedsCount = db.prepare('SELECT COUNT(*) as c FROM seeds').get().c;
        const goalsHasReplCol = db.prepare("PRAGMA table_info(goals)").all().some(c => c.name === 'is_replacement');

        if (goalsCount === 0 && seedsCount > 0 && !goalsHasReplCol) {
          // Goals is the freshly-created stub from this boot's schema block,
          // carrying the old UNIQUE(user_id, seed_number) constraint. Seeds is
          // the real data (likely already rebuilt to multi-row form). Drop the
          // stub and rename — preserves seeds' current schema and contents.
          db.exec('DROP TABLE goals');
          db.exec('ALTER TABLE seeds RENAME TO goals');
          console.log('✓ Migrated: dropped stub goals, renamed seeds → goals (preserved schema)');
        } else if (goalsCount > 0 && seedsCount === 0) {
          db.exec('DROP TABLE seeds');
          console.log('✓ Cleanup: dropped empty seeds table (migration was already complete)');
        } else if (goalsCount === 0 && seedsCount === 0) {
          db.exec('DROP TABLE seeds');
          console.log('✓ Cleanup: dropped empty seeds table');
        } else {
          // goalsCount > 0 && seedsCount > 0 — true conflict, or goals already
          // has is_replacement column. Don't crash boot; leave both tables in
          // place and warn loudly. Manual cleanup may be needed.
          console.warn('⚠️  Both seeds and goals tables have data — leaving both in place.');
          console.warn('   goals rows: ' + goalsCount + ', seeds rows: ' + seedsCount);
          console.warn('   Resolve manually: choose canonical source, then DROP the other.');
        }
      }
      // else: only goals exists (normal post-migration state) — nothing to do
    }

  const goalCols = db.prepare("PRAGMA table_info(weekly_goals)").all().map(r => r.name);
  if (!goalCols.includes('reflection')) {
    db.exec("ALTER TABLE weekly_goals ADD COLUMN reflection TEXT DEFAULT ''");
    console.log('✓ Migrated: added reflection column');
  }
  if (!goalCols.includes('reflection_at')) {
    db.exec("ALTER TABLE weekly_goals ADD COLUMN reflection_at DATETIME");
    console.log('✓ Migrated: added reflection_at column');
  }

  const userCols = db.prepare("PRAGMA table_info(users)").all().map(r => r.name);
  if (!userCols.includes('current_season')) {
    db.exec("ALTER TABLE users ADD COLUMN current_season TEXT");
    console.log('✓ Migrated: added current_season column');
  }
  if (!userCols.includes('season_updated_at')) {
    db.exec("ALTER TABLE users ADD COLUMN season_updated_at DATETIME");
    console.log('✓ Migrated: added season_updated_at column');
  }

  // Onboarding completion flag
  if (!userCols.includes('onboarding_completed')) {
    db.exec("ALTER TABLE users ADD COLUMN onboarding_completed INTEGER DEFAULT 0");
    console.log('✓ Migrated: added onboarding_completed column');
  }
  // Mid-course feedback submission flag (one-shot per user). Presence of a
  // value here hides the dashboard card and prevents re-submission. Kept
  // structurally separate from midcourse_responses so admin can see "who
  // has submitted" without being able to link it to "what they said".
  if (!userCols.includes('midcourse_submitted_at')) {
    db.exec("ALTER TABLE users ADD COLUMN midcourse_submitted_at DATETIME");
    console.log('✓ Migrated: added midcourse_submitted_at column');
  }
  if (!userCols.includes('profile_photo')) {
    db.exec("ALTER TABLE users ADD COLUMN profile_photo TEXT");
    console.log('✓ Migrated: added profile_photo column');
  }
  if (!userCols.includes('timezone')) {
    db.exec("ALTER TABLE users ADD COLUMN timezone TEXT DEFAULT 'America/Denver'");
    console.log('✓ Migrated: added timezone column');
  }
  // Trial-run support. Default 12 = full course. Admin sets to 3 (or any
  // smaller number) for trial students so the dashboard / calendar / lesson
  // gating clamp at the shorter length.
  if (!userCols.includes('course_length_weeks')) {
    db.exec("ALTER TABLE users ADD COLUMN course_length_weeks INTEGER DEFAULT 12");
    console.log('✓ Migrated: added course_length_weeks column');
  }
  // Enrollment tier — which paid tier the student purchased, if any.
  // Values: 'solo' | 'community' | 'coaching' | NULL (= free Winter tier).
  // Course access itself gates on course_length_weeks; this column exists so
  // admin can see who's on which tier and the dashboard banner can name it.
  if (!userCols.includes('enrollment_tier')) {
    db.exec("ALTER TABLE users ADD COLUMN enrollment_tier TEXT");
    console.log('✓ Migrated: added enrollment_tier column');
  }
  // Private admin notes — a freeform, admin-only memo per gardener (e.g.
  // "prefers gentle accountability"). NEVER surfaced to students; only read
  // back into the admin edit dialog. NULL/empty = no note.
  if (!userCols.includes('notes')) {
    db.exec("ALTER TABLE users ADD COLUMN notes TEXT");
    console.log('✓ Migrated: added notes column to users');
  }
  // Block Buster custom blocks gained a `category` column when the resource
  // was reorganized into categories. Guarded add for DBs created before that.
  const bbBlockCols = db.prepare("PRAGMA table_info(block_buster_blocks)").all().map(r => r.name);
  if (bbBlockCols.length && !bbBlockCols.includes('category')) {
    db.exec("ALTER TABLE block_buster_blocks ADD COLUMN category TEXT");
    console.log('✓ Migrated: added category column to block_buster_blocks');
  }
  // Reflection column on busted blocks — students write how a way through went
  // when they complete it, collected in the Breakthroughs log.
  const bbBustedCols = db.prepare("PRAGMA table_info(block_buster_busted)").all().map(r => r.name);
  if (bbBustedCols.length && !bbBustedCols.includes('reflection')) {
    db.exec("ALTER TABLE block_buster_busted ADD COLUMN reflection TEXT");
    console.log('✓ Migrated: added reflection column to block_buster_busted');
  }
  // Old shape had UNIQUE (user_id, block_key) so a block could only be busted
  // once. Rebuild as an id-keyed log so blocks can be busted repeatedly,
  // preserving existing rows as the first breakthrough for each.
  const bbBustedInfo = db.prepare("PRAGMA table_info(block_buster_busted)").all();
  if (bbBustedInfo.length && !bbBustedInfo.some(c => c.name === 'id')) {
    db.exec(`
      CREATE TABLE block_buster_busted_new (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        user_id INTEGER NOT NULL,
        block_key TEXT NOT NULL,
        option_text TEXT,
        reflection TEXT,
        busted_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        FOREIGN KEY (user_id) REFERENCES users(id)
      );
      INSERT INTO block_buster_busted_new (user_id, block_key, option_text, reflection, busted_at)
        SELECT user_id, block_key, option_text, reflection, busted_at FROM block_buster_busted;
      DROP TABLE block_buster_busted;
      ALTER TABLE block_buster_busted_new RENAME TO block_buster_busted;
    `);
    console.log('✓ Migrated: block_buster_busted is now a repeatable log (added id)');
  }
  db.exec("CREATE INDEX IF NOT EXISTS idx_bbb_user ON block_buster_busted (user_id)");
  // file_path on propagation_makes — students complete a rung by uploading the
  // thing they made (or pasting a link).
  const propCols = db.prepare("PRAGMA table_info(propagation_makes)").all().map(r => r.name);
  if (propCols.length && !propCols.includes('file_path')) {
    db.exec("ALTER TABLE propagation_makes ADD COLUMN file_path TEXT");
    console.log('✓ Migrated: added file_path column to propagation_makes');
  }
  // Per-user course start date for multi-cohort support. NULL means "fall
  // back to the global settings.course_start_date" so existing students keep
  // their current timeline observable behavior without a one-time backfill
  // (the helper db.getUserCourseStartDate handles the fallback). Admin can
  // override per user via the admin UI; new students inherit the global.
  if (!userCols.includes('course_start_date')) {
    db.exec("ALTER TABLE users ADD COLUMN course_start_date DATETIME");
    console.log('✓ Migrated: added course_start_date column');
  }
  if (!userCols.includes('notify_new_fieldnotes')) {
    db.exec("ALTER TABLE users ADD COLUMN notify_new_fieldnotes INTEGER DEFAULT 1");
    console.log('✓ Migrated: added notify_new_fieldnotes column');
  }
  if (!userCols.includes('notify_community')) {
    db.exec("ALTER TABLE users ADD COLUMN notify_community INTEGER DEFAULT 1");
    console.log('✓ Migrated: added notify_community column');
  }
  if (!userCols.includes('notify_weekly_reminder')) {
    db.exec("ALTER TABLE users ADD COLUMN notify_weekly_reminder INTEGER DEFAULT 1");
    console.log('✓ Migrated: added notify_weekly_reminder column');
  }
  if (!userCols.includes('community_goals_public')) {
    db.exec("ALTER TABLE users ADD COLUMN community_goals_public INTEGER DEFAULT 1");
    console.log('✓ Migrated: added community_goals_public column');
  }
  // Daily push reminder — opt-in server-side switch (cron sender checks this)
  // plus the local-hour the student wants the nudge delivered (0–23, resolved
  // against users.timezone). Default OFF so brand-new students don't get
  // surprise pushes; they flip it on from /account.
  if (!userCols.includes('daily_reminder_enabled')) {
    db.exec("ALTER TABLE users ADD COLUMN daily_reminder_enabled INTEGER DEFAULT 0");
    console.log('✓ Migrated: added daily_reminder_enabled column');
  }
  if (!userCols.includes('daily_reminder_hour')) {
    db.exec("ALTER TABLE users ADD COLUMN daily_reminder_hour INTEGER DEFAULT 8");
    console.log('✓ Migrated: added daily_reminder_hour column');
  }
  // Email is a second delivery channel for the daily reminder, independent of
  // push. Off by default — students opt in from their profile.
  if (!userCols.includes('reminder_email_enabled')) {
    db.exec("ALTER TABLE users ADD COLUMN reminder_email_enabled INTEGER DEFAULT 0");
    console.log('✓ Migrated: added reminder_email_enabled column');
  }
  // Weekly reminder (Monday nudge to set weekly intentions). Self-contained,
  // parallel to the daily reminder: its own on/off, hour, and email channel.
  // All off by default — opt-in, like the daily one.
  if (!userCols.includes('weekly_reminder_enabled')) {
    db.exec("ALTER TABLE users ADD COLUMN weekly_reminder_enabled INTEGER DEFAULT 0");
    console.log('✓ Migrated: added weekly_reminder_enabled column');
  }
  if (!userCols.includes('weekly_reminder_hour')) {
    db.exec("ALTER TABLE users ADD COLUMN weekly_reminder_hour INTEGER DEFAULT 9");
    console.log('✓ Migrated: added weekly_reminder_hour column');
  }
  if (!userCols.includes('weekly_reminder_email')) {
    db.exec("ALTER TABLE users ADD COLUMN weekly_reminder_email INTEGER DEFAULT 0");
    console.log('✓ Migrated: added weekly_reminder_email column');
  }

  if (!userCols.includes('community_season_public')) {
    db.exec("ALTER TABLE users ADD COLUMN community_season_public INTEGER DEFAULT 1");
    console.log('✓ Migrated: added community_season_public column');
  }

  // Rebuild self_assessments if it has old column schema
  const saCols = db.prepare("PRAGMA table_info(self_assessments)").all().map(r => r.name);
  if (saCols.length > 0 && saCols.includes('q1_rating')) {
    db.exec("DROP TABLE self_assessments");
    db.exec(`CREATE TABLE self_assessments (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id INTEGER NOT NULL,
      assessment_type TEXT NOT NULL,
      q1_choice TEXT DEFAULT '',
      q2_rating INTEGER,
      q3_choice TEXT DEFAULT '',
      q4_rating INTEGER,
      q5_choice TEXT DEFAULT '',
      q6_rating INTEGER,
      q7_choices TEXT DEFAULT '',
      q8_choice TEXT DEFAULT '',
      q9_text TEXT DEFAULT '',
      q10_text TEXT DEFAULT '',
      harvest_reflection TEXT DEFAULT '',
      completed_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY (user_id) REFERENCES users(id),
      UNIQUE(user_id, assessment_type)
    )`);
    console.log('✓ Migrated: rebuilt self_assessments with new schema');
  }
  // Add closing assessment columns (q11, q12)
  const saColsNow = db.prepare("PRAGMA table_info(self_assessments)").all().map(r => r.name);
  if (!saColsNow.includes('q11_text')) {
    db.exec("ALTER TABLE self_assessments ADD COLUMN q11_text TEXT DEFAULT ''");
    console.log('✓ Migrated: added q11_text to self_assessments');
  }
  if (!saColsNow.includes('q12_text')) {
    db.exec("ALTER TABLE self_assessments ADD COLUMN q12_text TEXT DEFAULT ''");
    console.log('✓ Migrated: added q12_text to self_assessments');
  }

  // Goals: add legacy tending columns if missing (for tables created before the rebuild)
  const seedCols = db.prepare("PRAGMA table_info(goals)").all().map(r => r.name);
  if (!seedCols.includes('status')) {
    db.exec("ALTER TABLE goals ADD COLUMN status TEXT DEFAULT 'active'");
    console.log('✓ Migrated: added status to goals');
  }
  if (!seedCols.includes('updated_feeling')) {
    db.exec("ALTER TABLE goals ADD COLUMN updated_feeling TEXT DEFAULT ''");
    console.log('✓ Migrated: added updated_feeling to goals');
  }
  if (!seedCols.includes('updated_looks_like')) {
    db.exec("ALTER TABLE goals ADD COLUMN updated_looks_like TEXT DEFAULT ''");
    console.log('✓ Migrated: added updated_looks_like to goals');
  }

  // Goals: rebuild to support multi-row replacements (removes UNIQUE constraint)
  const seedCols2 = db.prepare("PRAGMA table_info(goals)").all().map(r => r.name);
  if (!seedCols2.includes('is_active')) {
    const existingSeeds = db.prepare('SELECT * FROM goals').all();
    const hasStatus  = seedCols2.includes('status');
    const hasUpdated = seedCols2.includes('updated_feeling');
    db.exec(`
      CREATE TABLE seeds_new (
        id               INTEGER PRIMARY KEY AUTOINCREMENT,
        user_id          INTEGER NOT NULL,
        seed_number      INTEGER NOT NULL,
        feeling          TEXT    DEFAULT '',
        looks_like       TEXT    DEFAULT '',
        status           TEXT    DEFAULT 'active',
        updated_feeling  TEXT    DEFAULT '',
        updated_looks_like TEXT  DEFAULT '',
        is_active        INTEGER DEFAULT 1,
        is_replacement   INTEGER DEFAULT 0,
        replaces_seed_id INTEGER,
        created_at       DATETIME DEFAULT CURRENT_TIMESTAMP,
        updated_at       DATETIME DEFAULT CURRENT_TIMESTAMP,
        FOREIGN KEY (user_id) REFERENCES users(id)
      )
    `);
    const ins = db.prepare(`
      INSERT INTO seeds_new
        (id, user_id, seed_number, feeling, looks_like,
         status, updated_feeling, updated_looks_like,
         is_active, is_replacement, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, 1, 0, ?, ?)
    `);
    for (const s of existingSeeds) {
      ins.run(
        s.id, s.user_id, s.seed_number, s.feeling || '', s.looks_like || '',
        hasStatus  ? (s.status           || 'active') : 'active',
        hasUpdated ? (s.updated_feeling   || '')       : '',
        hasUpdated ? (s.updated_looks_like || '')      : '',
        s.created_at, s.updated_at
      );
    }
    db.exec('DROP TABLE goals');
    db.exec('ALTER TABLE seeds_new RENAME TO goals');
    console.log('✓ Migrated: rebuilt goals table with multi-row replacement support');
  }

  // Goals: add kept_at for "keep growing" persistence
  const seedColsFinal = db.prepare("PRAGMA table_info(goals)").all().map(r => r.name);
  if (!seedColsFinal.includes('kept_at')) {
    db.exec("ALTER TABLE goals ADD COLUMN kept_at DATETIME");
    console.log('✓ Migrated: added kept_at to goals');
  }

  // Goals: add bed_position for three-bed Greenhouse flow (Phase 3A)
  const seedColsBed = db.prepare("PRAGMA table_info(goals)").all().map(r => r.name);
  if (!seedColsBed.includes('bed_position')) {
    db.exec("ALTER TABLE goals ADD COLUMN bed_position INTEGER DEFAULT NULL");
    console.log('✓ Migrated: added bed_position to goals');
  }

  // Goals: add 4-facet columns (soil/seed/water/bloom) for Greenhouse planting flow
  const seedColsFacets = db.prepare("PRAGMA table_info(goals)").all().map(r => r.name);
  for (const col of ['soil', 'seed', 'water', 'bloom']) {
    if (!seedColsFacets.includes(col)) {
      db.exec(`ALTER TABLE goals ADD COLUMN ${col} TEXT DEFAULT ''`);
      console.log(`✓ Migrated: added ${col} to goals`);
    }
  }

  // Users: add has_visited_greenhouse for first-visit welcome gate
  const userColsGH = db.prepare("PRAGMA table_info(users)").all().map(r => r.name);
  if (!userColsGH.includes('has_visited_greenhouse')) {
    db.exec("ALTER TABLE users ADD COLUMN has_visited_greenhouse INTEGER DEFAULT 0");
    console.log('✓ Migrated: added has_visited_greenhouse to users');
  }

  // Users: add last_recorded_date for the Dashboard "I recorded today" memory.
  // A single overwritable YYYY-MM-DD string per user — not a count, streak, or
  // history. When today's date equals this column, the card renders in its
  // done state; once the (time-travel-aware) date rolls over, it resets.
  const userColsRec = db.prepare("PRAGMA table_info(users)").all().map(r => r.name);
  if (!userColsRec.includes('last_recorded_date')) {
    db.exec("ALTER TABLE users ADD COLUMN last_recorded_date TEXT");
    console.log('✓ Migrated: added last_recorded_date to users');
  }

  // Users: add IANA timezone so getNow() can compute the user's local
  // wall-clock for date comparisons. NULL until the browser first posts
  // /api/timezone; getNow() falls back to server time when NULL.
  const userColsTz = db.prepare("PRAGMA table_info(users)").all().map(r => r.name);
  if (!userColsTz.includes('timezone')) {
    db.exec("ALTER TABLE users ADD COLUMN timezone TEXT");
    console.log('✓ Migrated: added timezone to users');
  }

  // Default settings for unlock flags
  db.prepare("INSERT OR IGNORE INTO settings (key, value) VALUES ('midcourse_unlocked', 'false')").run();
  db.prepare("INSERT OR IGNORE INTO settings (key, value) VALUES ('harvest_unlocked', 'false')").run();

  // Lesson video_url column (column exists in CREATE TABLE but may be missing from old DBs)
  const lessonCols = db.prepare("PRAGMA table_info(lessons)").all().map(r => r.name);
  if (!lessonCols.includes('video_url')) {
    db.exec("ALTER TABLE lessons ADD COLUMN video_url TEXT");
    console.log('✓ Migrated: added video_url to lessons');
  }

  // Homework tables
  db.exec(`
    CREATE TABLE IF NOT EXISTS lesson_homework (
      id         INTEGER PRIMARY KEY AUTOINCREMENT,
      lesson_id  INTEGER NOT NULL,
      position   INTEGER NOT NULL DEFAULT 0,
      title      TEXT NOT NULL DEFAULT '',
      link_url   TEXT,
      link_label TEXT,
      FOREIGN KEY (lesson_id) REFERENCES lessons(id)
    );
    CREATE TABLE IF NOT EXISTS homework_completions (
      id           INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id      INTEGER NOT NULL,
      homework_id  INTEGER NOT NULL,
      completed_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY (user_id) REFERENCES users(id),
      FOREIGN KEY (homework_id) REFERENCES lesson_homework(id),
      UNIQUE(user_id, homework_id)
    );
  `);

  // Cuttings: daily reflection captures from the Dashboard recording practice.
  // Presence-only — only days the student chose to write a reflection exist here.
  // No video is uploaded or stored; only the optional text + season stamp.
  db.exec(`
    CREATE TABLE IF NOT EXISTS cuttings (
      id              INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id         INTEGER NOT NULL,
      created_at      DATETIME DEFAULT CURRENT_TIMESTAMP,
      season          TEXT,
      prompt          TEXT,
      reflection_text TEXT,
      FOREIGN KEY (user_id) REFERENCES users(id)
    );
    CREATE INDEX IF NOT EXISTS idx_cuttings_user_created
      ON cuttings (user_id, created_at);
  `);

  // Cuttings: three additional optional reflection columns. Existing rows
  // keep reflection_text and have NULL for the new columns — the archive
  // and PDF render only-populated fields, so legacy rows look unchanged.
  const cuttingCols = db.prepare("PRAGMA table_info(cuttings)").all().map(r => r.name);
  if (!cuttingCols.includes('talked_about')) {
    db.exec("ALTER TABLE cuttings ADD COLUMN talked_about TEXT");
    console.log('✓ Migrated: added talked_about to cuttings');
  }
  if (!cuttingCols.includes('how_it_felt')) {
    db.exec("ALTER TABLE cuttings ADD COLUMN how_it_felt TEXT");
    console.log('✓ Migrated: added how_it_felt to cuttings');
  }
  if (!cuttingCols.includes('takeaway')) {
    db.exec("ALTER TABLE cuttings ADD COLUMN takeaway TEXT");
    console.log('✓ Migrated: added takeaway to cuttings');
  }

  // Cuttings: recorded_date stores the day-it-happened (YYYY-MM-DD),
  // separate from created_at (when the row was written). Lets students
  // backdate a recording without losing the audit trail. Existing rows
  // are backfilled to DATE(created_at) so the archive/PDF group correctly
  // for legacy data. Index added for grouping queries.
  if (!cuttingCols.includes('recorded_date')) {
    db.exec("ALTER TABLE cuttings ADD COLUMN recorded_date TEXT");
    db.exec("UPDATE cuttings SET recorded_date = DATE(created_at) WHERE recorded_date IS NULL");
    db.exec("CREATE INDEX IF NOT EXISTS idx_cuttings_user_recorded ON cuttings (user_id, recorded_date)");
    console.log('✓ Migrated: added recorded_date to cuttings + backfilled from created_at');
  }

  // Cuttings: optional Cloudflare Stream video attached to a logged recording.
  // Stores only the Stream uid — the bytes live at Cloudflare, and playback
  // requires a signed token minted for the owner (see lib/video.js).
  if (!cuttingCols.includes('video_uid')) {
    db.exec("ALTER TABLE cuttings ADD COLUMN video_uid TEXT");
    console.log('✓ Migrated: added video_uid to cuttings');
  }

  // Cuttings: watched/edited marks — booleans (0/1) per cutting so the
  // student can flag that they rewatched a past take or edited it externally.
  // Default 0 so existing rows seamlessly read as unmarked.
  const cuttingCols2 = db.prepare("PRAGMA table_info(cuttings)").all().map(r => r.name);
  if (!cuttingCols2.includes('watched')) {
    db.exec("ALTER TABLE cuttings ADD COLUMN watched INTEGER DEFAULT 0");
    console.log('✓ Migrated: added watched to cuttings');
  }
  if (!cuttingCols2.includes('edited')) {
    db.exec("ALTER TABLE cuttings ADD COLUMN edited INTEGER DEFAULT 0");
    console.log('✓ Migrated: added edited to cuttings');
  }
  // Recording kind: 'daily' = a daily-practice recording (the default, and what
  // every existing row is); 'bonus' = an intentional recording made outside the
  // practice, logged straight to the workbench "to edit". `title` names bonus
  // recordings (daily ones are identified by their date).
  if (!cuttingCols2.includes('kind')) {
    db.exec("ALTER TABLE cuttings ADD COLUMN kind TEXT DEFAULT 'daily'");
    console.log('✓ Migrated: added kind to cuttings');
  }
  if (!cuttingCols2.includes('title')) {
    db.exec("ALTER TABLE cuttings ADD COLUMN title TEXT");
    console.log('✓ Migrated: added title to cuttings');
  }

  // Tending: the Gardener's weekly review of past cuttings. Unlocks in Spring
  // (Week 4+). Each curation event is a row (history-preserving) so a cutting
  // can move between categories over time — latest row wins as the "current"
  // state. return_later carries a resurface_after date (curated_at + 21 days)
  // so the queue can re-serve it for another look. reflection_text is the
  // right-side reflection written during the watching session.
  db.exec(`
    CREATE TABLE IF NOT EXISTS cutting_curations (
      id              INTEGER PRIMARY KEY AUTOINCREMENT,
      cutting_id      INTEGER NOT NULL,
      user_id         INTEGER NOT NULL,
      category        TEXT NOT NULL CHECK (category IN ('keep_growing','return_later','archive','just_for_me')),
      curated_at      DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
      resurface_after TEXT,
      reflection_text TEXT,
      FOREIGN KEY (cutting_id) REFERENCES cuttings(id),
      FOREIGN KEY (user_id)    REFERENCES users(id)
    );
    CREATE INDEX IF NOT EXISTS idx_cutting_curations_cutting  ON cutting_curations (cutting_id);
    CREATE INDEX IF NOT EXISTS idx_cutting_curations_user     ON cutting_curations (user_id);
    CREATE INDEX IF NOT EXISTS idx_cutting_curations_resurface ON cutting_curations (resurface_after);
  `);

  // Tending: add the 'just_for_me' bucket ("this one was just for me" — it
  // mattered, it's simply not for sharing; distinct from Compost's "there's
  // nothing more here"). The category is pinned by a CHECK constraint, and
  // SQLite can't alter a CHECK in place — so on databases created before this
  // bucket existed, rebuild the table and copy every row across. Detected by
  // reading the stored DDL rather than a column check, since the shape is the
  // same; only the constraint differs.
  const curationDdl = db.prepare(
    "SELECT sql FROM sqlite_master WHERE type='table' AND name='cutting_curations'"
  ).get();
  if (curationDdl && curationDdl.sql && !curationDdl.sql.includes('just_for_me')) {
    db.exec(`
      BEGIN TRANSACTION;
      CREATE TABLE cutting_curations_new (
        id              INTEGER PRIMARY KEY AUTOINCREMENT,
        cutting_id      INTEGER NOT NULL,
        user_id         INTEGER NOT NULL,
        category        TEXT NOT NULL CHECK (category IN ('keep_growing','return_later','archive','just_for_me')),
        curated_at      DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
        resurface_after TEXT,
        reflection_text TEXT,
        FOREIGN KEY (cutting_id) REFERENCES cuttings(id),
        FOREIGN KEY (user_id)    REFERENCES users(id)
      );
      INSERT INTO cutting_curations_new
        (id, cutting_id, user_id, category, curated_at, resurface_after, reflection_text)
        SELECT id, cutting_id, user_id, category, curated_at, resurface_after, reflection_text
        FROM cutting_curations;
      DROP TABLE cutting_curations;
      ALTER TABLE cutting_curations_new RENAME TO cutting_curations;
      CREATE INDEX IF NOT EXISTS idx_cutting_curations_cutting   ON cutting_curations (cutting_id);
      CREATE INDEX IF NOT EXISTS idx_cutting_curations_user      ON cutting_curations (user_id);
      CREATE INDEX IF NOT EXISTS idx_cutting_curations_resurface ON cutting_curations (resurface_after);
      COMMIT;
    `);
    console.log('✓ Migrated: cutting_curations now allows just_for_me');
  }

  // Tending: pause events. Small append-only log so we can see how often
  // students choose to pause vs push through, and let the student leave a
  // one-line "what's here today" note if they want. No stats surfaced yet —
  // just captured for later study.
  db.exec(`
    CREATE TABLE IF NOT EXISTS tending_pauses (
      id        INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id   INTEGER NOT NULL,
      paused_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
      note      TEXT,
      FOREIGN KEY (user_id) REFERENCES users(id)
    );
    CREATE INDEX IF NOT EXISTS idx_tending_pauses_user ON tending_pauses (user_id);
  `);

  // Users: first-time Meet-the-Gardener flag so the intro overlay only shows
  // once per student. Existing rows read as 0 (haven't seen); flipped to 1
  // when the student dismisses the intro.
  const userCols2 = db.prepare("PRAGMA table_info(users)").all().map(r => r.name);
  if (!userCols2.includes('tending_intro_seen')) {
    db.exec("ALTER TABLE users ADD COLUMN tending_intro_seen INTEGER DEFAULT 0");
    console.log('✓ Migrated: added tending_intro_seen to users');
  }

  // Users: one-time "Welcome to Spring" intro card flag. Fires the first time
  // a student becomes eligible for the season selector — either their course
  // week crosses into 4 or they upgrade to the full 12-week course. Set to 1
  // when they dismiss the card so it doesn't keep re-appearing.
  if (!userCols2.includes('season_intro_seen')) {
    db.exec("ALTER TABLE users ADD COLUMN season_intro_seen INTEGER DEFAULT 0");
    console.log('✓ Migrated: added season_intro_seen to users');
  }

  // Summer: content formats a cutting can be turned into. user_id NULL means
  // a Julia-authored built-in ("Written carousel", "Talk-to-camera snippet",
  // …). Non-null user_id is a student's custom format — only that student
  // sees it in their menu. `slug` is URL-safe and unique across built-ins.
  // `detail_content` holds the long-form "how to repurpose" markdown for
  // built-ins (custom formats leave it null and just use `description`).
  // `archived` hides a custom format from the picker without breaking any
  // cutting_makes rows that already reference it.
  db.exec(`
    CREATE TABLE IF NOT EXISTS content_formats (
      id             INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id        INTEGER,
      slug           TEXT NOT NULL,
      name           TEXT NOT NULL,
      emoji          TEXT,
      description    TEXT,
      detail_content TEXT,
      position       INTEGER NOT NULL DEFAULT 0,
      archived       INTEGER NOT NULL DEFAULT 0,
      created_at     DATETIME DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY (user_id) REFERENCES users(id)
    );
    CREATE INDEX IF NOT EXISTS idx_content_formats_user ON content_formats (user_id);
  `);

  // Summer: history-preserving log of "made as X" events. Each row records
  // a format IDEA — the student has planned to (or already has) turn
  // this cutting into a specific format. `created` distinguishes the two
  // states: 0 = idea (planned, not yet made), 1 = actually created.
  // Students can flip the flag any time. published_url is reserved for
  // Fall — student pastes the actual posted URL once they've shared it.
  db.exec(`
    CREATE TABLE IF NOT EXISTS cutting_makes (
      id            INTEGER PRIMARY KEY AUTOINCREMENT,
      cutting_id    INTEGER NOT NULL,
      user_id       INTEGER NOT NULL,
      format_id     INTEGER NOT NULL,
      made_at       DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
      note          TEXT,
      published_url TEXT,
      FOREIGN KEY (cutting_id) REFERENCES cuttings(id),
      FOREIGN KEY (user_id)    REFERENCES users(id),
      FOREIGN KEY (format_id)  REFERENCES content_formats(id)
    );
    CREATE INDEX IF NOT EXISTS idx_cutting_makes_user    ON cutting_makes (user_id);
    CREATE INDEX IF NOT EXISTS idx_cutting_makes_cutting ON cutting_makes (cutting_id);
    CREATE INDEX IF NOT EXISTS idx_cutting_makes_format  ON cutting_makes (format_id);
  `);

  // Content ideas — the top of the workbench funnel: things you want to make
  // but haven't filmed yet (no recording). "Mark as filmed" promotes an idea
  // into a Bonus Recording on the to-edit pile. Deliberately its own table so
  // idea-with-no-footage never touches the practice's cuttings/Tending flow.
  db.exec(`
    CREATE TABLE IF NOT EXISTS content_ideas (
      id         INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id    INTEGER NOT NULL,
      title      TEXT,
      note       TEXT,
      materials  TEXT,
      created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY (user_id) REFERENCES users(id)
    );
    CREATE INDEX IF NOT EXISTS idx_content_ideas_user ON content_ideas (user_id);
  `);
  // `materials` — what raw material already exists for an idea, as a CSV of
  // any of: writing, audio, photos, video. Empty/null = just an idea, nothing
  // tied to it yet. Guarded add for DBs that created the table before this.
  const ideaCols = db.prepare("PRAGMA table_info(content_ideas)").all().map(r => r.name);
  if (!ideaCols.includes('materials')) {
    db.exec("ALTER TABLE content_ideas ADD COLUMN materials TEXT");
    console.log('✓ Migrated: added materials to content_ideas');
  }

  // Guarded add of the created flag for existing installs — new rows land
  // as ideas (0) by default. Backfill leaves any pre-existing rows at 0;
  // there are no such rows in production (Summer just shipped), so this
  // is safe.
  const makesCols = db.prepare("PRAGMA table_info(cutting_makes)").all().map(r => r.name);
  if (!makesCols.includes('created')) {
    db.exec("ALTER TABLE cutting_makes ADD COLUMN created INTEGER NOT NULL DEFAULT 0");
    console.log('✓ Migrated: added created flag to cutting_makes');
  }
  // just_for_me: student's private-vs-shareable choice on each created
  // make. When 1, the links section on /grove renders greyed out and no
  // links can be added. Default 0 so existing rows stay sharable.
  if (!makesCols.includes('just_for_me')) {
    db.exec("ALTER TABLE cutting_makes ADD COLUMN just_for_me INTEGER NOT NULL DEFAULT 0");
    console.log('✓ Migrated: added just_for_me flag to cutting_makes');
  }
  // share_note: one reflection per created piece about what it was like
  // to share it — separate from the idea-note on cutting_makes.note
  // (which is written at Cultivated-Ideas time). Nullable; default null.
  if (!makesCols.includes('share_note')) {
    db.exec("ALTER TABLE cutting_makes ADD COLUMN share_note TEXT");
    console.log('✓ Migrated: added share_note to cutting_makes');
  }
  // Cohort share: when a student shares a creation with the pilot
  // cohort (via Discord) instead of, or alongside, a public link.
  // discord_url is optional — the student may share to Discord without
  // pasting the message permalink back. cohort_shared_at is the moment
  // they marked it shared. Bouquet counts a make as "bloomed" if it has
  // links OR cohort_shared = 1 (and isn't just_for_me).
  if (!makesCols.includes('cohort_shared')) {
    db.exec("ALTER TABLE cutting_makes ADD COLUMN cohort_shared INTEGER NOT NULL DEFAULT 0");
    console.log('✓ Migrated: added cohort_shared to cutting_makes');
  }
  if (!makesCols.includes('cohort_shared_at')) {
    db.exec("ALTER TABLE cutting_makes ADD COLUMN cohort_shared_at DATETIME");
    console.log('✓ Migrated: added cohort_shared_at to cutting_makes');
  }
  if (!makesCols.includes('discord_url')) {
    db.exec("ALTER TABLE cutting_makes ADD COLUMN discord_url TEXT");
    console.log('✓ Migrated: added discord_url to cutting_makes');
  }

  // stem_variant: which of the 12 flower-stem SVGs this creation blooms
  // as in the /grove bouquet. Assigned once, on the student's first link
  // add for this make, and persists forever. NULL until first link.
  // Backfill: any make that already has links but no variant gets a
  // random 1-12 so existing bouquets aren't blank on first load.
  if (!makesCols.includes('stem_variant')) {
    db.exec("ALTER TABLE cutting_makes ADD COLUMN stem_variant INTEGER");
    // The backfill JOINs cutting_make_links, which is CREATEd ~20 lines
    // below. On a brand-new database that table doesn't exist yet, so the
    // JOIN would throw "no such table" and abort the whole migration
    // (the outer catch swallows it, booting a half-built DB). Skip the
    // backfill when the table isn't there — a fresh DB has no rows to
    // backfill anyway.
    const linksTableExists = db.prepare(
      "SELECT name FROM sqlite_master WHERE type='table' AND name='cutting_make_links'"
    ).get();
    let backfilled = 0;
    if (linksTableExists) {
      const backfillRows = db.prepare(`
        SELECT DISTINCT m.id
        FROM cutting_makes m
        JOIN cutting_make_links l ON l.make_id = m.id
        WHERE m.stem_variant IS NULL
      `).all();
      const upd = db.prepare('UPDATE cutting_makes SET stem_variant = ? WHERE id = ?');
      for (const row of backfillRows) {
        upd.run(Math.floor(Math.random() * 12) + 1, row.id);
      }
      backfilled = backfillRows.length;
    }
    console.log(`✓ Migrated: added stem_variant to cutting_makes (backfilled ${backfilled} rows)`);
  }

  // Fall: multiple published-URL links per make. Each row is one link,
  // ordered by posted_at ASC so the earliest post reads first. `label`
  // is an optional platform tag ("Instagram", "LinkedIn"). `note` is an
  // optional reflection the student can leave about what it was like to
  // share this post. Deletions are hard because a link is just a URL,
  // no important history.
  db.exec(`
    CREATE TABLE IF NOT EXISTS cutting_make_links (
      id        INTEGER PRIMARY KEY AUTOINCREMENT,
      make_id   INTEGER NOT NULL,
      user_id   INTEGER NOT NULL,
      url       TEXT NOT NULL,
      label     TEXT,
      note      TEXT,
      posted_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY (make_id) REFERENCES cutting_makes(id),
      FOREIGN KEY (user_id) REFERENCES users(id)
    );
    CREATE INDEX IF NOT EXISTS idx_cutting_make_links_make ON cutting_make_links (make_id);
    CREATE INDEX IF NOT EXISTS idx_cutting_make_links_user ON cutting_make_links (user_id);
  `);
  // Guarded add for the reflection column so a fresh boot on an existing
  // install picks it up.
  const linkCols = db.prepare("PRAGMA table_info(cutting_make_links)").all().map(r => r.name);
  if (!linkCols.includes('note')) {
    db.exec("ALTER TABLE cutting_make_links ADD COLUMN note TEXT");
    console.log('✓ Migrated: added note to cutting_make_links');
  }

  // Avatars moved to /data/avatars — old paths pointing to /uploads/avatars/ are now broken.
  // Reset them so users see initials until they re-upload.
  db.exec("UPDATE users SET profile_photo = NULL WHERE profile_photo LIKE '/uploads/avatars/%'");

  // Rename curiosity_map_* → seed_packet_* (idempotent — runs only once)
  for (const [oldName, newName] of [
    ['curiosity_map_answers',        'seed_packet_answers'],
    ['curiosity_map_highlights',      'seed_packet_highlights'],
    ['curiosity_map_threads',         'seed_packet_threads'],
    ['curiosity_map_synthesis_state', 'seed_packet_synthesis_state'],
  ]) {
    const hasOld = db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name=?").get(oldName);
    const hasNew = db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name=?").get(newName);
    if (hasOld && !hasNew) db.exec(`ALTER TABLE ${oldName} RENAME TO ${newName}`);
  }

  // Seed Packet answers
  db.exec(`
    CREATE TABLE IF NOT EXISTS seed_packet_answers (
      id          INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id     INTEGER NOT NULL,
      question_id TEXT NOT NULL,
      answer_text TEXT NOT NULL,
      created_at  DATETIME DEFAULT CURRENT_TIMESTAMP,
      updated_at  DATETIME DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY (user_id) REFERENCES users(id),
      UNIQUE (user_id, question_id)
    );
    CREATE INDEX IF NOT EXISTS idx_spa_user ON seed_packet_answers(user_id);
  `);

  // Password reset tokens
  db.exec(`
    CREATE TABLE IF NOT EXISTS password_reset_tokens (
      id         INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id    INTEGER NOT NULL,
      token      TEXT NOT NULL UNIQUE,
      expires_at DATETIME NOT NULL,
      used_at    DATETIME,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY (user_id) REFERENCES users(id)
    );
    CREATE INDEX IF NOT EXISTS idx_password_reset_tokens_token ON password_reset_tokens(token);
  `);

  // Seed Packet highlights
  db.exec(`
    CREATE TABLE IF NOT EXISTS seed_packet_highlights (
      id               INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id          INTEGER NOT NULL,
      question_id      TEXT    NOT NULL,
      highlighted_text TEXT    NOT NULL,
      created_at       DATETIME DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY (user_id) REFERENCES users(id)
    );
    CREATE INDEX IF NOT EXISTS idx_sph_user ON seed_packet_highlights(user_id);
  `);

  // Seed Packet threads
  db.exec(`
    CREATE TABLE IF NOT EXISTS seed_packet_threads (
      id          INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id     INTEGER NOT NULL,
      name        TEXT    NOT NULL,
      description TEXT    DEFAULT '',
      bullets     TEXT    DEFAULT '[]',
      sort_order  INTEGER NOT NULL DEFAULT 0,
      created_at  DATETIME DEFAULT CURRENT_TIMESTAMP,
      updated_at  DATETIME DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY (user_id) REFERENCES users(id)
    );
    CREATE INDEX IF NOT EXISTS idx_spt_user_order ON seed_packet_threads(user_id, sort_order);
  `);

  // Seed Packet synthesis state
  db.exec(`
    CREATE TABLE IF NOT EXISTS seed_packet_synthesis_state (
      user_id                 INTEGER PRIMARY KEY,
      has_seen_observations   INTEGER DEFAULT 0,
      last_observations       TEXT    DEFAULT NULL,
      last_observations_at    DATETIME DEFAULT NULL,
      has_completed_synthesis INTEGER DEFAULT 0,
      FOREIGN KEY (user_id) REFERENCES users(id)
    );
  `);

  // Seed Packet seeds (named synthesis output, replaces threads)
  db.exec(`
    CREATE TABLE IF NOT EXISTS seed_packet_seeds (
      id          INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id     INTEGER NOT NULL,
      name        TEXT    NOT NULL,
      description TEXT    DEFAULT '',
      bullets     TEXT    DEFAULT '[]',
      sort_order  INTEGER NOT NULL DEFAULT 0,
      created_at  DATETIME DEFAULT CURRENT_TIMESTAMP,
      updated_at  DATETIME DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY (user_id) REFERENCES users(id)
    );
    CREATE INDEX IF NOT EXISTS idx_spse_user_order ON seed_packet_seeds(user_id, sort_order);
  `);

  // Seeds: add `application` for the "How this shows up in my content" field
  // on the seed-packets/seeds page. Optional free text per seed.
  const spseCols = db.prepare("PRAGMA table_info(seed_packet_seeds)").all().map(r => r.name);
  if (!spseCols.includes('application')) {
    db.exec("ALTER TABLE seed_packet_seeds ADD COLUMN application TEXT DEFAULT ''");
    console.log('✓ Migrated: added application to seed_packet_seeds');
  }

  // Add curricular_season column to lessons (idempotent)
  const hasLessonSeason = db.prepare("PRAGMA table_info(lessons)").all().some(c => c.name === 'curricular_season');
  if (!hasLessonSeason) {
    db.exec("ALTER TABLE lessons ADD COLUMN curricular_season TEXT DEFAULT NULL");
    const seasons = ['winter','winter','winter','spring','spring','spring','summer','summer','summer','autumn','autumn','autumn'];
    const lessons = db.prepare('SELECT id FROM lessons ORDER BY sort_order ASC, id ASC').all();
    lessons.forEach((l, i) => {
      if (i < seasons.length) db.prepare('UPDATE lessons SET curricular_season = ? WHERE id = ?').run(seasons[i], l.id);
    });
    console.log('✓ Migrated: Added curricular_season to lessons');
  }

  // V2: wipe all goals planted during onboarding — goals are now planted via Greenhouse after Lesson 1
  const v2SeedsFlag = db.prepare("SELECT value FROM settings WHERE key='seeds_v2_migrated'").get();
  if (!v2SeedsFlag) {
    db.exec('DELETE FROM goals');
    db.prepare("INSERT OR IGNORE INTO settings (key, value) VALUES ('seeds_v2_migrated', 'true')").run();
    console.log('✓ Migrated: Wiped goal data — V2 model resets all goals; users will re-plant after Lesson 1');
  }

  // Evergreen backfill: cuttings logged past the 12-week curriculum were
  // stamped with a NULL season, because getCurricularSeason() only spans
  // weeks 1-12. Now that logging falls back to the student's chosen season,
  // repair the existing orphans by setting each to its owner's current_season
  // so they group correctly in Cultivate and on community cards. One-time and
  // flag-guarded; the UPDATE only touches NULL seasons, so a re-run is a no-op.
  const seasonBackfillFlag = db.prepare("SELECT value FROM settings WHERE key='cuttings_null_season_backfilled'").get();
  if (!seasonBackfillFlag) {
    const r = db.prepare(`
      UPDATE cuttings
      SET season = (SELECT current_season FROM users WHERE users.id = cuttings.user_id)
      WHERE season IS NULL
        AND (SELECT current_season FROM users WHERE users.id = cuttings.user_id) IS NOT NULL
    `).run();
    db.prepare("INSERT OR IGNORE INTO settings (key, value) VALUES ('cuttings_null_season_backfilled', 'true')").run();
    console.log(`✓ Migrated: backfilled ${r.changes} null-season cutting(s) to owner's current_season`);
  }

  // Backfill notification_log for existing students.
  //
  // Without this, when the admin-milestone trigger code rolls out, the first
  // time Danielle next visits /seed-packets/synthesize/name, Julia gets an
  // 'advanced_to_naming' email retroactively — even though Danielle did that
  // months ago. Pre-claim every milestone every student is ALREADY past.
  // tryClaimMilestone is idempotent (INSERT OR IGNORE on the UNIQUE
  // constraint), so this is safe to re-run on every boot.
  const claim = db.prepare(
    'INSERT OR IGNORE INTO notification_log (user_id, milestone) VALUES (?, ?)'
  );
  let backfilled = 0;
  for (const u of db.prepare("SELECT id FROM users WHERE role='student'").all()) {
    // Onboarding done? — flag is one-way.
    const ob = db.prepare('SELECT onboarding_completed FROM users WHERE id=?').get(u.id);
    if (ob && ob.onboarding_completed) {
      backfilled += claim.run(u.id, 'onboarding_completed').changes;
    }
    // Has any named seed? — they've necessarily been to /synthesize/name and
    // (since the seeds page is where they edit them) to /seeds.
    const seedCount = db.prepare(
      'SELECT COUNT(*) AS c FROM seed_packet_seeds WHERE user_id=?'
    ).get(u.id).c;
    if (seedCount > 0) {
      backfilled += claim.run(u.id, 'advanced_to_naming').changes;
      backfilled += claim.run(u.id, 'advanced_to_seeds_view').changes;
    }
    // All greenhouse beds resolved? — every bed planted or fallow.
    const plantedBeds = new Set(db.prepare(
      'SELECT DISTINCT seed_number FROM goals WHERE user_id=? AND is_active=1'
    ).all(u.id).map(r => r.seed_number));
    const fallowBeds = new Set(db.prepare(
      'SELECT bed_number FROM fallow_beds WHERE user_id=?'
    ).all(u.id).map(r => r.bed_number));
    let allResolved = true;
    for (let n = 1; n <= 3; n++) {
      if (!plantedBeds.has(n) && !fallowBeds.has(n)) { allResolved = false; break; }
    }
    if (allResolved) {
      backfilled += claim.run(u.id, 'greenhouse_goals_set').changes;
    }
  }
  if (backfilled > 0) {
    console.log(`✓ Backfilled ${backfilled} notification_log rows for existing students`);
  }

  // Seed the quotes table on first boot only. Empty pool = brand-new install,
  // so we land the 7 original hardcoded quotes (all general, no season) to
  // preserve the existing dashboard experience. Idempotent because we gate
  // on row count; later boots see rows already present and skip.
  const quoteRowCount = db.prepare('SELECT COUNT(*) AS c FROM quotes').get().c;
  if (quoteRowCount === 0) {
    const seedStmt = db.prepare('INSERT INTO quotes (text, source, season) VALUES (?, ?, NULL)');
    const seeds = [
      { text: "You already know what you want to say. Let's find it together.", source: "The Creative's Garden" },
      { text: "Visibility that feels like a return to self.", source: "The Meibos Touch" },
      { text: "You're not bad at marketing. You're just doing it wrong for who you are.", source: "The Creative's Garden" },
      { text: "Nobody creates well from an empty cup.", source: "The Creative's Garden" },
      { text: "Don't wait to be done to show up.", source: "The Creative's Garden" },
      { text: "Curiosity is not a luxury. It's load-bearing infrastructure for your creative life.", source: "The Creative's Garden" },
      { text: "The buffer isn't procrastination. It's wisdom.", source: "The Creative's Garden" },
    ];
    for (const q of seeds) seedStmt.run(q.text, q.source);
    console.log(`✓ Seeded quotes table with ${seeds.length} default entries`);
  }
  } catch (err) {
    // Boot survives migration failure. Some queries may fail at runtime if
    // expected columns/tables aren't where they should be — check this log.
    console.error('');
    console.error('━'.repeat(70));
    console.error('⚠️  DB MIGRATION FAILED — app will boot with current schema state');
    console.error('   Error:', err && err.message);
    if (err && err.stack) console.error(err.stack);
    console.error('   Check Railway logs and run /admin/export to back up before retrying.');
    console.error('━'.repeat(70));
    console.error('');
  }
})();

function seedDefaultAccounts() {
  const anyUser = db.prepare('SELECT id FROM users LIMIT 1').get();
  if (anyUser) return;

  const students = [
    { name: 'Danielle Masters', email: 'danielle.e.masters@gmail.com', password: 'danielle123', initial: 'D' },
    { name: 'Test Student',     email: 'jrmeibos@yahoo.com',           password: 'testing123',  initial: 'T' },
  ];

  // Seeded students get their own start date (today) so they never depend on
  // the global default — the platform is moving to per-user start dates.
  const today = new Date().toISOString().split('T')[0];
  const ins = db.prepare('INSERT INTO users (name, email, password_hash, role, avatar_initial, course_start_date) VALUES (?, ?, ?, ?, ?, ?)');
  for (const a of students) {
    const hash = bcrypt.hashSync(a.password, 12);
    ins.run(a.name, a.email, hash, 'student', a.initial, today);
    console.log(`✓ Seeded student: ${a.name} (${a.email})`);
  }
}

function syncAdminAccount() {
  const email    = process.env.ADMIN_EMAIL    || 'julia@meibostouch.com';
  const password = process.env.ADMIN_PASSWORD;

  if (!password) {
    console.warn('⚠ ADMIN_PASSWORD env var not set — skipping admin password sync');
    return;
  }

  const hash     = bcrypt.hashSync(password, 12);
  const existing = db.prepare('SELECT id FROM users WHERE email = ?').get(email);

  if (existing) {
    db.prepare('UPDATE users SET password_hash = ?, role = ? WHERE email = ?')
      .run(hash, 'admin', email);
  } else {
    db.prepare('INSERT INTO users (name, email, password_hash, role, avatar_initial) VALUES (?, ?, ?, ?, ?)')
      .run('Julia M.', email, hash, 'admin', 'J');
  }
  console.log(`✓ Admin user synced: ${email}`);
}

function seedLessons() {
  if (db.prepare('SELECT COUNT(*) as c FROM lessons').get().c > 0) return;

  const lessons = [
    {
      slug: 'welcome-to-the-rhythm',
      title: "Welcome to The Creative's Garden",
      subtitle: "You already know what you want to say. Let's find it together.",
      category_tag: 'Mindset',
      estimated_read_time: 8,
      sort_order: 1,
      content: `<p class="lesson-lead">This is not a content calendar. It's a permission slip.</p>

<p>You're here because something in you knows that the way you've been trying to show up online—or avoiding showing up altogether—isn't working. Not because you're doing it wrong, exactly. But because you might be doing it for the wrong reasons, in the wrong order, with the wrong framework.</p>

<p>You're not a product. You're a person making things. And this platform was built for that difference.</p>

<h2>The Four Seasons</h2>

<p>This course is built around four categories of creative life. We call them The 4 C's:</p>

<div class="lesson-4cs">
  <div class="lesson-4c curiosity">
    <span class="lesson-4c-label">Curiosity</span>
    <p>Feed your artist's soul. Artist dates, following whims, filling the well.</p>
  </div>
  <div class="lesson-4c create">
    <span class="lesson-4c-label">Create</span>
    <p>Make the thing. Art, posts, writing, recordings—whatever your medium is.</p>
  </div>
  <div class="lesson-4c share">
    <span class="lesson-4c-label">Share</span>
    <p>Put it into the world. Publish, post, show up as the creative you are.</p>
  </div>
  <div class="lesson-4c connect">
    <span class="lesson-4c-label">Connect</span>
    <p>Reach out (or in). Collaborations, residencies, community, relationships.</p>
  </div>
</div>

<blockquote class="lesson-pullquote">These aren't a hierarchy. They're seasons. Some weeks you're deep in Curiosity. Some weeks you're in a full Create bloom. The goal is to notice what's alive in you—not force a schedule.</blockquote>

<h2>Integration Weeks</h2>

<p>Every few weeks, you'll encounter something we call an Integration Week. This is a week with no goals—just a reflection prompt and permission to let what you've been learning settle in.</p>

<p>Integration is not falling behind. Integration <em>is</em> the work.</p>

<h2>How to Use This Platform</h2>

<p>Each week, you'll set loose intentions across the 4 C's. Not SMART goals. Not deliverables. Intentions. Things you'd love to move toward.</p>

<p>Then you'll show up—here, in the community, in your creative life—and let the garden grow.</p>`
    },
    {
      slug: 'gap-between-artist-and-marketer',
      title: 'The Gap Between Artist and Marketer',
      subtitle: "You're not bad at marketing. You're just doing it wrong for who you are.",
      category_tag: 'Mindset',
      estimated_read_time: 7,
      sort_order: 2,
      content: `<p class="lesson-lead">Here's the thing nobody told you: marketing wasn't designed for artists.</p>

<p>It was designed for products. For things that need to be explained, compared, and chosen from a shelf. The language of marketing—target audience, value proposition, content calendar—comes from a world where the thing being sold has nothing to do with the soul of the person selling it.</p>

<h2>The Central Tension</h2>

<p>When you try to market yourself the "right" way, you end up performing a version of yourself that doesn't quite fit. You write captions that sound like captions. You post on schedule because you're supposed to. You create content instead of creating work.</p>

<p>And then you feel like a fraud. Or exhausted. Or both.</p>

<blockquote class="lesson-pullquote">This is not a character flaw. This is a framework problem.</blockquote>

<h2>Performing vs. Revealing</h2>

<p>There's a difference between performing a brand and revealing your truth.</p>

<p><strong>Performing</strong> means you're calculating: <em>What does my audience want to see? What's going to get engagement? What makes me look credible?</em></p>

<p><strong>Revealing</strong> means you're sharing: <em>What am I actually thinking about? What's alive in my work right now? What do I want people to know about how I see the world?</em></p>

<p>One depletes you. One fills you. The paradox is that the revealing version is also more compelling to the people who need to find you.</p>

<blockquote class="lesson-pullquote">I'm not performing. I'm revealing.</blockquote>

<h2>The Invitation</h2>

<p>In this course, we're going to dismantle the marketing framework that doesn't fit you and build something that does. Something that starts from who you are rather than who you think you should be.</p>`
    },
    {
      slug: 'curiosity-first',
      title: 'Curiosity First',
      subtitle: 'Nobody creates well from an empty cup.',
      category_tag: 'Practical',
      estimated_read_time: 6,
      sort_order: 3,
      content: `<p class="lesson-lead">Before we talk about creating. Before we talk about sharing. We have to talk about filling.</p>

<p>Julia Cameron calls them artist dates—solo adventures you take with yourself to refill your creative well. A museum trip. A long walk somewhere new. An afternoon in a bookstore. Time in a garden. Anything that feeds the part of you that makes things.</p>

<h2>Why Input Matters as Much as Output</h2>

<p>We're in a culture obsessed with output. Post more. Create more. Share more. The implicit message is that the creative well is infinite if you just hustle hard enough.</p>

<p>It isn't.</p>

<p>The artists who sustain long, rich creative lives aren't just working harder. They're investing in their inputs as deliberately as their outputs. They protect their ability to be surprised, delighted, and moved—because that's what they draw on when they make.</p>

<blockquote class="lesson-pullquote">Curiosity is not a luxury. It's load-bearing infrastructure for your creative life.</blockquote>

<h2>What Curiosity Goals Actually Look Like</h2>

<p>Curiosity goals are easy to get wrong. Here's the difference:</p>

<p><strong>Not this:</strong> "Read 3 books this month" <em>(output-oriented, pressure-y)</em><br>
<strong>This:</strong> "Spend time in the art section of the library with no agenda" <em>(input-oriented, open)</em></p>

<p><strong>Not this:</strong> "Research my industry for content ideas" <em>(strategic, functional)</em><br>
<strong>This:</strong> "Follow a thread of genuine curiosity wherever it goes" <em>(exploratory, alive)</em></p>

<p>The goal is to feel something. To be surprised. To encounter something that makes you think <em>oh, I didn't know that</em> or <em>oh, I didn't know I cared about that.</em></p>

<h2>This Week</h2>

<p>Set one Curiosity intention that genuinely interests you. Not what you think would be good for your art. What would be fun. What would feel like play. Start there.</p>`
    },
    {
      slug: 'the-buffer',
      title: 'The Buffer',
      subtitle: 'Creation and sharing are intentionally separate. The buffer is protection, not procrastination.',
      category_tag: 'Practical',
      estimated_read_time: 7,
      sort_order: 4,
      content: `<p class="lesson-lead">One of the most relieving things I can tell you: you don't have to share everything immediately after you make it.</p>

<p>In fact, I'd argue that sharing immediately is often the problem.</p>

<h2>Why Create and Share Are Separate Categories</h2>

<p>When creation and sharing are collapsed into the same moment—make it, post it, watch for reactions—you're not just publishing. You're performing. Every creative act is immediately evaluated by an invisible audience (real or imagined), and that evaluation feeds back into the next creative act.</p>

<p>This is a nervous system problem. Your body can't tell the difference between real threat and social threat. The anxiety of "will people like this?" is physically real, and it subtly shapes what you make and how you make it.</p>

<blockquote class="lesson-pullquote">The buffer is the space between making and sharing. It's protection for your creative process.</blockquote>

<h2>Building a Library</h2>

<p>Here's the practical version: before you start posting consistently, spend a season just making. Create without the pressure of imminent publication. Build a small library of things you're genuinely proud of.</p>

<p>Then, when you do start sharing, you're sharing from abundance. You're not one bad week away from running out of things to say. You have options. You have a buffer.</p>

<p>Danielle had a beautiful insight about this—she called it "delaying gratification." Not holding back to be mysterious, but genuinely waiting until something is ready. Until you've had time to love it a little before you release it.</p>

<h2>What This Looks Like Practically</h2>

<ul>
  <li>Write several posts before publishing any</li>
  <li>Finish a body of work before announcing it</li>
  <li>Record multiple videos before releasing the first</li>
  <li>Give yourself a week between finishing something and deciding whether to share it</li>
</ul>

<p>The buffer isn't procrastination. It's wisdom.</p>`
    },
    {
      slug: 'showing-up-in-process',
      title: 'Showing Up In Process',
      subtitle: "Don't wait to be done to show up.",
      category_tag: 'Perspective',
      estimated_read_time: 6,
      sort_order: 5,
      content: `<p class="lesson-lead">Here's the mindset shift that changes everything: you don't have to wait until you're finished.</p>

<p>Most creatives operate from a finished-work model of sharing. You make the thing. You polish the thing. The thing is done. Then you share the thing. This feels safe. Responsible. Professional.</p>

<p>It's also where most people never actually show up, because the thing is never quite done enough.</p>

<h2>Why Process Content Is Often More Powerful</h2>

<p>The people who need to find you aren't looking for a finished product. They're looking for someone who thinks the way they think, cares about what they care about, sees the world through a lens that resonates with them.</p>

<p>That's visible in process. Sometimes it's only visible in process.</p>

<blockquote class="lesson-pullquote">The sketch on your studio floor tells people more about who you are than the framed print on the gallery wall.</blockquote>

<h2>What "Showing Up In Process" Actually Looks Like</h2>

<p>Process sharing doesn't mean oversharing every messy moment. It means inviting people into the journey in ways that feel true to you:</p>

<ul>
  <li>A photo of your workspace mid-project</li>
  <li>A question you're wrestling with in your work</li>
  <li>Something you tried that didn't work and what you learned</li>
  <li>The thing you're currently excited about, even before it's shareable</li>
  <li>A decision point you're navigating—what stays in, what comes out</li>
</ul>

<h2>The Permission</h2>

<p>This is your explicit permission to show up before you're done. Before you're polished. Before you have it all figured out.</p>

<p>The creative who shows up in process is not less professional. They're more human. And human is what your people are looking for.</p>`
    }
  ];

  const insert = db.prepare(
    'INSERT INTO lessons (slug, title, subtitle, category_tag, content, estimated_read_time, sort_order, published) VALUES (?, ?, ?, ?, ?, ?, ?, 1)'
  );
  for (const l of lessons) {
    insert.run(l.slug, l.title, l.subtitle, l.category_tag, l.content, l.estimated_read_time, l.sort_order);
  }
  console.log('✓ Lessons seeded');
}

// Course Introduction: idempotent additive insert. seedLessons() above only
// runs on an empty table, so this is the right shape for a single new lesson
// added after the initial seed. INSERT OR IGNORE relies on slug UNIQUE — if
// the row already exists (manual admin edit, prior boot), this no-ops and
// preserves whatever edits the admin made via the admin UI.
function seedCourseIntroduction() {
  db.prepare(`
    INSERT OR IGNORE INTO lessons
      (slug, title, subtitle, category_tag, content, estimated_read_time, sort_order, published)
    VALUES (?, ?, ?, ?, ?, ?, ?, 1)
  `).run(
    'course-introduction',
    'Course Introduction',
    "An orientation to the Creative's Garden — our philosophy, our rhythms, and how to use this space.",
    'Introduction',
    `<p class="lesson-lead">Here is your orientation. We'll get straight on what we're trying to do here together. There are a few moving pieces to this program, so let's get into how they all work together.</p>`,
    5,
    0
  );
}

function seedLesson1Homework() {
  const lesson = db.prepare("SELECT id FROM lessons WHERE slug='welcome-to-the-rhythm'").get();
  if (!lesson) return;
  const existing = db.prepare('SELECT COUNT(*) as c FROM lesson_homework WHERE lesson_id=?').get(lesson.id).c;
  if (existing > 0) return;
  db.prepare('INSERT INTO lesson_homework (lesson_id, position, title, link_url, link_label) VALUES (?, ?, ?, ?, ?)')
    .run(lesson.id, 1, 'Choose your current season on the dashboard.', '/dashboard', 'Go to Dashboard');
  db.prepare('INSERT INTO lesson_homework (lesson_id, position, title, link_url, link_label) VALUES (?, ?, ?, ?, ?)')
    .run(lesson.id, 2, 'Plant your three goals in The Greenhouse.', '/greenhouse', 'Open The Greenhouse');
  console.log('✓ Seeded Lesson 1 homework tasks');
}

// Built-in Summer content formats. Seeded on first boot after the
// content_formats migration. Placeholder detail_content is a heading + a
// short teaser paragraph — Julia will edit each one with real "how to
// repurpose" guidance later. Emojis mirror the Tending/Cultivate
// vocabulary the student already knows.
const BUILTIN_CONTENT_FORMATS = [
  { slug: 'carousel',         emoji: '📱', name: 'Written carousel',       description: 'A multi-slide post — words on stacked cards.' },
  { slug: 'talk-to-camera',   emoji: '🎥', name: 'Talk-to-camera snippet', description: 'A short video of you speaking directly to the lens.' },
  { slug: 'video-with-text',  emoji: '📝', name: 'Video with text overlay', description: 'A clip with captions or key words shown over it.' },
  { slug: 'video-voice-over', emoji: '🎙️', name: 'Video with voice-over',   description: 'B-roll or footage with your voice narrating.' },
  { slug: 'essay',            emoji: '✍️', name: 'Written post',            description: 'A long-form essay, blog post, or newsletter piece.' },
  { slug: 'short-post',       emoji: '💬', name: 'Short written post',      description: 'A quick post for Threads, X, or LinkedIn.' },
  { slug: 'audio',            emoji: '🎧', name: 'Audio clip',              description: 'A podcast segment or voice note.' },
  { slug: 'story',            emoji: '📖', name: 'Story / ephemeral',       description: 'A story-format post that expires (IG, LinkedIn).' },
  { slug: 'newsletter',       emoji: '✉️', name: 'Newsletter / email',      description: 'A direct-to-inbox letter to your list.' },
  { slug: 'quote-graphic',    emoji: '🖼️', name: 'Quote graphic',           description: 'A single image with one of your lines as text.' },
  { slug: 'q-and-a',          emoji: '💭', name: 'Q&A / response post',     description: 'A post that answers a question, real or imagined.' },
  { slug: 'photo-caption',    emoji: '📷', name: 'Photo + caption',         description: 'A still image with your words underneath.' },
];

function seedContentFormats() {
  const existing = db.prepare(
    'SELECT COUNT(*) AS c FROM content_formats WHERE user_id IS NULL'
  ).get().c;
  if (existing === 0) {
    const ins = db.prepare(`
      INSERT INTO content_formats
        (user_id, slug, name, emoji, description, detail_content, position)
      VALUES (NULL, ?, ?, ?, ?, ?, ?)
    `);
    BUILTIN_CONTENT_FORMATS.forEach((f, i) => {
      // Placeholder detail — plain paragraphs, blank line between them. Julia
      // will replace with real "how to repurpose" guidance later. Keep it
      // simple: no markdown parser needed, the view splits on \n\n.
      const detail =
        `${f.description}\n\n` +
        `How to repurpose a cutting into this format — coming soon.`;
      ins.run(f.slug, f.name, f.emoji, f.description, detail, i);
    });
    console.log(`✓ Seeded ${BUILTIN_CONTENT_FORMATS.length} built-in content formats`);
  }

  // Reserved "No format yet" format. Formatless idea saves (someone jots a
  // note before deciding on a format) point at this so cutting_makes.format_id
  // stays a valid, non-null FK. Hidden from the picker via getFormatsForUser.
  // Added after the original seed, so ensure it on every boot (idempotent by
  // slug) rather than only on a fresh DB.
  const unassigned = db.prepare(
    "SELECT id FROM content_formats WHERE user_id IS NULL AND slug = 'unassigned'"
  ).get();
  if (!unassigned) {
    db.prepare(`
      INSERT INTO content_formats
        (user_id, slug, name, emoji, description, detail_content, position)
      VALUES (NULL, 'unassigned', 'No format yet', '💭',
              'An idea saved before choosing a format.', '', 999)
    `).run();
    console.log('✓ Seeded reserved "No format yet" format');
  }
}

// Each init call wrapped so a failure (often caused by an upstream migration
// not finishing) logs loudly but lets the app boot anyway. Pairs with the
// try/catch around migrate() above.
function safeInit(label, fn) {
  try {
    fn();
  } catch (err) {
    console.error('');
    console.error('━'.repeat(70));
    console.error(`⚠️  INIT STEP FAILED: ${label} — app will boot without this step`);
    console.error('   Error:', err && err.message);
    if (err && err.stack) console.error(err.stack);
    console.error('━'.repeat(70));
    console.error('');
  }
}
// One-time backfill: materialize the global course start date onto every
// user who doesn't have their own yet. This makes per-user start dates the
// single source of truth so the global fallback can be retired. Idempotent —
// once a user has a date, subsequent boots leave them alone; if there's no
// global setting (fresh install), there's nothing to copy and it no-ops.
function backfillUserStartDates() {
  const row = db.prepare("SELECT value FROM settings WHERE key = 'course_start_date'").get();
  const globalStart = row && row.value ? row.value : null;
  if (!globalStart) return;
  const res = db.prepare(
    "UPDATE users SET course_start_date = ? WHERE course_start_date IS NULL OR course_start_date = ''"
  ).run(globalStart);
  if (res.changes) {
    console.log(`✓ Migrated: backfilled course_start_date for ${res.changes} user(s) from the global default (${globalStart})`);
  }
}

safeInit('syncAdminAccount',    syncAdminAccount);
safeInit('seedDefaultAccounts', seedDefaultAccounts);
safeInit('backfillUserStartDates', backfillUserStartDates);
safeInit('seedLessons',             seedLessons);
safeInit('seedCourseIntroduction',  seedCourseIntroduction);
safeInit('seedLesson1Homework',     seedLesson1Homework);
safeInit('seedContentFormats',      seedContentFormats);

module.exports = {
  getUserByEmail(email) {
    return db.prepare('SELECT * FROM users WHERE email = ?').get(email);
  },

  getUserById(id) {
    return db.prepare('SELECT id, name, email, role, avatar_initial, current_season, profile_photo, course_start_date, course_length_weeks, enrollment_tier, community_goals_public FROM users WHERE id = ?').get(id);
  },

  // ─── Per-user course start date ───────────────────────────────────────────
  // The single source of truth: each user carries their own start date (set
  // at signup / admin-create, backfilled for everyone earlier). The old
  // global course_start_date fallback has been retired. Returns null if the
  // user somehow has no date — every time-based feature (week number,
  // midcourse/harvest unlock, garden stage, day-view bounds) reads through
  // this helper and degrades gracefully to a "not started" state on null.
  getUserCourseStartDate(user) {
    return (user && user.course_start_date) || null;
  },

  setUserCourseStartDate(userId, dateString) {
    return db.prepare(
      'UPDATE users SET course_start_date = ? WHERE id = ?'
    ).run(dateString || null, userId);
  },

  // Trial students get a shorter clamp (typically 3). Server-side accessor
  // mirrors getUserCourseStartDate: fall back to the column default of 12
  // if anything goes wrong, so a missing/null value can never produce a
  // 0-week course math edge case.
  setUserCourseLengthWeeks(userId, weeks) {
    const w = Math.max(1, Math.min(52, parseInt(weeks, 10) || 12));
    return db.prepare(
      'UPDATE users SET course_length_weeks = ? WHERE id = ?'
    ).run(w, userId);
  },

  // Paid tier the student purchased. Values kept in sync with the TIERS
  // catalog in lib/stripe.js — the webhook writes here on
  // payment_intent.succeeded, admin roster reads it to show a chip.
  setUserEnrollmentTier(userId, tier) {
    const allowed = ['solo', 'community', 'coaching'];
    const t = allowed.includes(tier) ? tier : null;
    return db.prepare(
      'UPDATE users SET enrollment_tier = ? WHERE id = ?'
    ).run(t, userId);
  },

  // Private admin note per gardener. Stored as-is (trimmed); empty string is
  // normalized to NULL. Admin-only — never read into any student-facing view.
  setUserNotes(userId, notes) {
    const val = (typeof notes === 'string' && notes.trim()) ? notes.trim() : null;
    return db.prepare('UPDATE users SET notes = ? WHERE id = ?').run(val, userId);
  },

  hasVisitedGreenhouse(userId) {
    const row = db.prepare('SELECT has_visited_greenhouse FROM users WHERE id = ?').get(userId);
    return !!(row && row.has_visited_greenhouse);
  },

  markGreenhouseVisited(userId) {
    db.prepare('UPDATE users SET has_visited_greenhouse = 1 WHERE id = ?').run(userId);
  },

  getAllUsers() {
    return db.prepare('SELECT id, name, email, role, avatar_initial, current_season, profile_photo, community_goals_public, community_season_public, course_start_date, course_length_weeks, enrollment_tier, notes, created_at FROM users ORDER BY role DESC, name ASC').all();
  },

  getUserFullProfile(id) {
    return db.prepare('SELECT id, name, email, role, avatar_initial, current_season, profile_photo, timezone, notify_new_fieldnotes, notify_community, notify_weekly_reminder, community_goals_public, community_season_public, daily_reminder_enabled, daily_reminder_hour, reminder_email_enabled, weekly_reminder_enabled, weekly_reminder_hour, weekly_reminder_email FROM users WHERE id = ?').get(id);
  },

  updateUserDetails(userId, name, email) {
    const initial = name.trim().charAt(0).toUpperCase();
    return db.prepare('UPDATE users SET name=?, email=?, avatar_initial=? WHERE id=?')
      .run(name.trim(), email.trim().toLowerCase(), initial, userId);
  },

  updateUserName(userId, name) {
    const initial = name.trim().charAt(0).toUpperCase();
    return db.prepare('UPDATE users SET name=?, avatar_initial=? WHERE id=?')
      .run(name.trim(), initial, userId);
  },

  updateUserEmail(userId, email) {
    return db.prepare('UPDATE users SET email=? WHERE id=?')
      .run(email.trim().toLowerCase(), userId);
  },

  updateUserTimezone(userId, timezone) {
    return db.prepare('UPDATE users SET timezone=? WHERE id=?').run(timezone, userId);
  },

  updateUserPreference(userId, key, value) {
    const allowed = ['notify_new_fieldnotes','notify_community','notify_weekly_reminder','community_goals_public','community_season_public','reminder_email_enabled','weekly_reminder_email'];
    if (!allowed.includes(key)) throw new Error('Invalid preference key');
    return db.prepare(`UPDATE users SET ${key}=? WHERE id=?`).run(value ? 1 : 0, userId);
  },

  updateProfilePhoto(userId, photoPath) {
    return db.prepare('UPDATE users SET profile_photo=? WHERE id=?').run(photoPath, userId);
  },

  removeProfilePhoto(userId) {
    return db.prepare('UPDATE users SET profile_photo=NULL WHERE id=?').run(userId);
  },

  updateUserSeason(userId, season) {
    return db.prepare(
      'UPDATE users SET current_season=?, season_updated_at=CURRENT_TIMESTAMP WHERE id=?'
    ).run(season || null, userId);
  },

  createUser(name, email, password, role = 'student') {
    const hash = bcrypt.hashSync(password, 12);
    const initial = name.trim().charAt(0).toUpperCase();
    return db.prepare('INSERT INTO users (name, email, password_hash, role, avatar_initial) VALUES (?, ?, ?, ?, ?)')
      .run(name, email, hash, role, initial);
  },

  updateUserPassword(userId, newPassword) {
    const hash = bcrypt.hashSync(newPassword, 12);
    return db.prepare('UPDATE users SET password_hash = ? WHERE id = ?').run(hash, userId);
  },

  getAllLessons() {
    return db.prepare('SELECT * FROM lessons WHERE published = 1 ORDER BY sort_order ASC').all();
  },

  getLessonBySlug(slug) {
    return db.prepare('SELECT * FROM lessons WHERE slug = ? AND published = 1').get(slug);
  },

  getFirstUncompletedLesson(userId) {
    return db.prepare(`
      SELECT l.* FROM lessons l
      LEFT JOIN lesson_completions lc ON l.id = lc.lesson_id AND lc.user_id = ?
      WHERE l.published = 1 AND lc.id IS NULL
      ORDER BY l.sort_order ASC LIMIT 1
    `).get(userId);
  },

  getLessonCompletion(userId, lessonId) {
    return db.prepare('SELECT * FROM lesson_completions WHERE user_id = ? AND lesson_id = ?').get(userId, lessonId);
  },

  completedLessonIds(userId) {
    return db.prepare('SELECT lesson_id FROM lesson_completions WHERE user_id = ?')
      .all(userId).map(r => r.lesson_id);
  },

  markLessonComplete(userId, lessonId) {
    return db.prepare('INSERT OR IGNORE INTO lesson_completions (user_id, lesson_id) VALUES (?, ?)').run(userId, lessonId);
  },

  unmarkLessonComplete(userId, lessonId) {
    return db.prepare('DELETE FROM lesson_completions WHERE user_id = ? AND lesson_id = ?').run(userId, lessonId);
  },

  getGoalsForWeek(userId, weekStart) {
    return db.prepare('SELECT * FROM weekly_goals WHERE user_id = ? AND week_start = ?').all(userId, weekStart);
  },

  upsertGoal(userId, weekStart, category, goalText) {
    return db.prepare(`
      INSERT INTO weekly_goals (user_id, week_start, category, goal_text)
      VALUES (?, ?, ?, ?)
      ON CONFLICT(user_id, week_start, category) DO UPDATE SET
        goal_text = excluded.goal_text,
        updated_at = CURRENT_TIMESTAMP
    `).run(userId, weekStart, category, goalText);
  },

  saveCheckin(userId, weekStart, category, { reflection, completed }) {
    return db.prepare(`
      INSERT INTO weekly_goals (user_id, week_start, category, reflection, completed, reflection_at)
      VALUES (?, ?, ?, ?, ?, CURRENT_TIMESTAMP)
      ON CONFLICT(user_id, week_start, category) DO UPDATE SET
        reflection = excluded.reflection,
        completed  = excluded.completed,
        reflection_at = CURRENT_TIMESTAMP,
        updated_at = CURRENT_TIMESTAMP
    `).run(userId, weekStart, category, reflection, completed ? 1 : 0);
  },

  saveReflection(userId, weekStart, category, reflection) {
    return db.prepare(`
      INSERT INTO weekly_goals (user_id, week_start, category, reflection, reflection_at)
      VALUES (?, ?, ?, ?, CURRENT_TIMESTAMP)
      ON CONFLICT(user_id, week_start, category) DO UPDATE SET
        reflection = excluded.reflection,
        reflection_at = CURRENT_TIMESTAMP,
        updated_at = CURRENT_TIMESTAMP
    `).run(userId, weekStart, category, reflection || '');
  },

  setGoalComplete(userId, weekStart, category, completed) {
    return db.prepare(`
      INSERT INTO weekly_goals (user_id, week_start, category, completed)
      VALUES (?, ?, ?, ?)
      ON CONFLICT(user_id, week_start, category) DO UPDATE SET
        completed = excluded.completed,
        updated_at = CURRENT_TIMESTAMP
    `).run(userId, weekStart, category, completed ? 1 : 0);
  },

  toggleGoalComplete(goalId, userId) {
    const goal = db.prepare('SELECT * FROM weekly_goals WHERE id = ? AND user_id = ?').get(goalId, userId);
    if (!goal) return null;
    return db.prepare('UPDATE weekly_goals SET completed = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?')
      .run(goal.completed ? 0 : 1, goalId);
  },

  getWeekHistory(userId, limit = 10) {
    return db.prepare(`
      SELECT DISTINCT week_start FROM weekly_goals
      WHERE user_id = ?
      ORDER BY week_start DESC
      LIMIT ?
    `).all(userId, limit).map(r => r.week_start);
  },

  // ── Per-week community sharing ──────────────────────────────────────────
  // Effective "is this week's intentions shared" for one user+week: an
  // explicit per-week row wins; otherwise fall back to the user's default
  // (community_goals_public, itself defaulting to on). Returns a boolean.
  getWeekShareEffective(userId, weekStart) {
    const row = db.prepare(
      'SELECT shared FROM weekly_goal_shares WHERE user_id = ? AND week_start = ?'
    ).get(userId, weekStart);
    if (row) return row.shared !== 0;
    const u = db.prepare('SELECT community_goals_public FROM users WHERE id = ?').get(userId);
    return u ? u.community_goals_public !== 0 : true;
  },

  setWeekShare(userId, weekStart, shared) {
    return db.prepare(`
      INSERT INTO weekly_goal_shares (user_id, week_start, shared)
      VALUES (?, ?, ?)
      ON CONFLICT(user_id, week_start) DO UPDATE SET
        shared = excluded.shared,
        updated_at = CURRENT_TIMESTAMP
    `).run(userId, weekStart, shared ? 1 : 0);
  },

  // ─── Dismissible dashboard banners ────────────────────────────────────────
  // A banner is hidden when it's been permanently dismissed OR snoozed to a
  // future date. Returns the set of banner_keys to hide for this user today.
  getHiddenBannerKeys(userId, todayStr) {
    const rows = db.prepare(
      `SELECT banner_key FROM banner_dismissals
       WHERE user_id = ?
         AND (dismissed = 1 OR (snooze_until IS NOT NULL AND snooze_until > ?))`
    ).all(userId, todayStr);
    return new Set(rows.map(r => r.banner_key));
  },

  // "Remind me later" — hide until untilStr (typically tomorrow); it re-shows
  // on/after that date. Clears any prior permanent dismissal.
  snoozeBanner(userId, bannerKey, untilStr) {
    return db.prepare(`
      INSERT INTO banner_dismissals (user_id, banner_key, snooze_until, dismissed)
      VALUES (?, ?, ?, 0)
      ON CONFLICT(user_id, banner_key) DO UPDATE SET
        snooze_until = excluded.snooze_until,
        dismissed = 0,
        updated_at = CURRENT_TIMESTAMP
    `).run(userId, bannerKey, untilStr);
  },

  // "Remove this reminder / I'd rather not" — hide for good.
  dismissBannerPermanently(userId, bannerKey) {
    return db.prepare(`
      INSERT INTO banner_dismissals (user_id, banner_key, snooze_until, dismissed)
      VALUES (?, ?, NULL, 1)
      ON CONFLICT(user_id, banner_key) DO UPDATE SET
        dismissed = 1,
        snooze_until = NULL,
        updated_at = CURRENT_TIMESTAMP
    `).run(userId, bannerKey);
  },

  // All explicit per-week overrides for one week, as a Map(user_id → bool).
  // The community page uses this + each member's default to resolve who's
  // sharing that week without a query per member.
  getWeekSharesForWeek(weekStart) {
    const m = new Map();
    for (const r of db.prepare(
      'SELECT user_id, shared FROM weekly_goal_shares WHERE week_start = ?'
    ).all(weekStart)) {
      m.set(r.user_id, r.shared !== 0);
    }
    return m;
  },

  // ── The Creative Block Buster ───────────────────────────────────────────
  // A student's custom blocks (their own additions to the built-in set),
  // each filed into one of the built-in category slugs.
  getCustomBlocks(userId) {
    return db.prepare(
      'SELECT id, title, category FROM block_buster_blocks WHERE user_id = ? ORDER BY created_at ASC, id ASC'
    ).all(userId);
  },
  addCustomBlock(userId, title, category) {
    return db.prepare(
      'INSERT INTO block_buster_blocks (user_id, title, category) VALUES (?, ?, ?)'
    ).run(userId, String(title).trim(), category || null).lastInsertRowid;
  },
  // Delete a custom block plus everything attached to it (its added options
  // and any hide row), scoped to the owner.
  deleteCustomBlock(blockId, userId) {
    const key = 'custom-' + blockId;
    db.exec('BEGIN');
    try {
      db.prepare('DELETE FROM block_buster_options WHERE user_id = ? AND block_key = ?').run(userId, key);
      db.prepare('DELETE FROM block_buster_hidden  WHERE user_id = ? AND block_key = ?').run(userId, key);
      const r = db.prepare('DELETE FROM block_buster_blocks WHERE id = ? AND user_id = ?').run(blockId, userId);
      db.exec('COMMIT');
      return r.changes;
    } catch (e) {
      try { db.exec('ROLLBACK'); } catch (_) {}
      throw e;
    }
  },

  // Student-added options across all blocks, grouped as Map(block_key → [{id,text}]).
  getAddedOptionsByBlock(userId) {
    const m = new Map();
    for (const r of db.prepare(
      'SELECT id, block_key, text FROM block_buster_options WHERE user_id = ? ORDER BY created_at ASC, id ASC'
    ).all(userId)) {
      if (!m.has(r.block_key)) m.set(r.block_key, []);
      m.get(r.block_key).push({ id: r.id, text: r.text });
    }
    return m;
  },
  addBlockOption(userId, blockKey, text) {
    return db.prepare(
      'INSERT INTO block_buster_options (user_id, block_key, text) VALUES (?, ?, ?)'
    ).run(userId, String(blockKey), String(text).trim()).lastInsertRowid;
  },
  deleteBlockOption(optionId, userId) {
    return db.prepare(
      'DELETE FROM block_buster_options WHERE id = ? AND user_id = ?'
    ).run(optionId, userId).changes;
  },

  // Hidden blocks for a student, as a Set of block_key.
  getHiddenBlockKeys(userId) {
    return new Set(
      db.prepare('SELECT block_key FROM block_buster_hidden WHERE user_id = ?')
        .all(userId).map(r => r.block_key)
    );
  },
  setBlockHidden(userId, blockKey, hidden) {
    if (hidden) {
      db.prepare(
        'INSERT OR IGNORE INTO block_buster_hidden (user_id, block_key) VALUES (?, ?)'
      ).run(userId, String(blockKey));
    } else {
      db.prepare(
        'DELETE FROM block_buster_hidden WHERE user_id = ? AND block_key = ?'
      ).run(userId, String(blockKey));
    }
  },

  // How many times each block has been busted, as a Map(block_key → count).
  getBustCountsByBlock(userId) {
    const rows = db.prepare(
      'SELECT block_key, COUNT(*) AS n FROM block_buster_busted WHERE user_id = ? GROUP BY block_key'
    ).all(userId);
    const map = new Map();
    for (const r of rows) map.set(r.block_key, r.n);
    return map;
  },
  // Total breakthroughs across all blocks (drives the tally).
  getBustTotal(userId) {
    return db.prepare('SELECT COUNT(*) AS n FROM block_buster_busted WHERE user_id = ?').get(userId).n;
  },
  // All of a student's breakthroughs, newest first — the Breakthroughs log.
  // Block titles are resolved by the caller (built-ins live in lib, custom in
  // block_buster_blocks).
  getBreakthroughs(userId) {
    return db.prepare(
      `SELECT id, block_key, option_text, reflection, busted_at
         FROM block_buster_busted WHERE user_id = ?
        ORDER BY busted_at DESC, id DESC`
    ).all(userId);
  },
  // Log a NEW breakthrough — a block can be busted any number of times.
  // Returns the new row's id and this block's running count.
  bustBlock(userId, blockKey, optionText, reflection) {
    const info = db.prepare(
      `INSERT INTO block_buster_busted (user_id, block_key, option_text, reflection)
       VALUES (?, ?, ?, ?)`
    ).run(userId, String(blockKey), optionText ? String(optionText) : null, reflection ? String(reflection) : null);
    const count = db.prepare(
      'SELECT COUNT(*) AS n FROM block_buster_busted WHERE user_id = ? AND block_key = ?'
    ).get(userId, String(blockKey)).n;
    return { id: info.lastInsertRowid, count };
  },
  // Delete one breakthrough entry from the log (ownership enforced in WHERE).
  deleteBreakthrough(userId, id) {
    return db.prepare(
      'DELETE FROM block_buster_busted WHERE id = ? AND user_id = ?'
    ).run(id, userId).changes;
  },

  // ── The Propagation Table (Summer challenge) ────────────────────────────
  // Rungs a student has marked "made", as a Map(rung_slug → { file_path, published_url, made_at }).
  getPropagationMakes(userId) {
    const rows = db.prepare(
      'SELECT rung_slug, note, published_url, file_path, made_at FROM propagation_makes WHERE user_id = ?'
    ).all(userId);
    const map = new Map();
    for (const r of rows) map.set(r.rung_slug, {
      note: r.note, published_url: r.published_url, file_path: r.file_path, made_at: r.made_at,
    });
    return map;
  },
  markPropagationRung(userId, rungSlug, note, publishedUrl, filePath) {
    db.prepare(
      `INSERT INTO propagation_makes (user_id, rung_slug, note, published_url, file_path)
       VALUES (?, ?, ?, ?, ?)
       ON CONFLICT(user_id, rung_slug)
       DO UPDATE SET note = excluded.note, published_url = excluded.published_url,
                     file_path = excluded.file_path, made_at = CURRENT_TIMESTAMP`
    ).run(userId, String(rungSlug), note ? String(note) : null,
      publishedUrl ? String(publishedUrl) : null, filePath ? String(filePath) : null);
  },
  unmarkPropagationRung(userId, rungSlug) {
    return db.prepare(
      'DELETE FROM propagation_makes WHERE user_id = ? AND rung_slug = ?'
    ).run(userId, String(rungSlug)).changes;
  },

  getAllUsersGoalsForWeek(weekStart) {
    return db.prepare(`
      SELECT wg.*, u.name, u.avatar_initial FROM weekly_goals wg
      JOIN users u ON wg.user_id = u.id
      WHERE wg.week_start = ?
      ORDER BY u.name, wg.category
    `).all(weekStart);
  },

  getGoalsFeedWeeks(limit = 8) {
    return db.prepare(`
      SELECT DISTINCT week_start FROM weekly_goals
      WHERE goal_text != '' OR reflection != ''
      ORDER BY week_start DESC
      LIMIT ?
    `).all(limit).map(r => r.week_start);
  },

  getAllUsersGoalsAllWeeks(weeks) {
    if (!weeks.length) return {};
    const placeholders = weeks.map(() => '?').join(',');
    const rows = db.prepare(`
      SELECT wg.*, u.name as user_name, u.id as user_id_join, u.avatar_initial
      FROM weekly_goals wg
      JOIN users u ON wg.user_id = u.id
      WHERE wg.week_start IN (${placeholders})
        AND (wg.goal_text != '' OR wg.reflection != '')
      ORDER BY wg.week_start DESC, u.name ASC, wg.category ASC
    `).all(...weeks);

    // Group by week_start → user_id → category
    const grouped = {};
    for (const row of rows) {
      if (!grouped[row.week_start]) grouped[row.week_start] = {};
      if (!grouped[row.week_start][row.user_id]) {
        grouped[row.week_start][row.user_id] = {
          name: row.user_name,
          avatar_initial: row.avatar_initial,
          goals: {}
        };
      }
      grouped[row.week_start][row.user_id].goals[row.category] = row;
    }
    return grouped;
  },

  getCommunityPosts(limit = 20) {
    return db.prepare(`
      SELECT cp.*, u.name as author_name, u.avatar_initial,
        (SELECT COUNT(*) FROM community_reactions WHERE post_id = cp.id AND reaction_type = 'heart') as heart_count,
        (SELECT COUNT(*) FROM community_reactions WHERE post_id = cp.id AND reaction_type = 'spark') as spark_count
      FROM community_posts cp
      JOIN users u ON cp.user_id = u.id
      ORDER BY cp.pinned DESC, cp.created_at DESC
      LIMIT ?
    `).all(limit);
  },

  createPost(userId, content, categoryTag) {
    return db.prepare('INSERT INTO community_posts (user_id, content, category_tag) VALUES (?, ?, ?)').run(userId, content, categoryTag);
  },

  toggleReaction(postId, userId, reactionType) {
    const existing = db.prepare('SELECT id FROM community_reactions WHERE post_id = ? AND user_id = ? AND reaction_type = ?')
      .get(postId, userId, reactionType);
    if (existing) {
      db.prepare('DELETE FROM community_reactions WHERE id = ?').run(existing.id);
      return false;
    } else {
      db.prepare('INSERT INTO community_reactions (post_id, user_id, reaction_type) VALUES (?, ?, ?)').run(postId, userId, reactionType);
      return true;
    }
  },

  getAllResources() {
    return db.prepare('SELECT * FROM resources ORDER BY category_tag, title').all();
  },

  createResource(title, description, categoryTag, url, filePath) {
    return db.prepare('INSERT INTO resources (title, description, category_tag, url, file_path) VALUES (?, ?, ?, ?, ?)')
      .run(title, description, categoryTag, url, filePath);
  },

  getLessonCompletionCounts() {
    return db.prepare(`
      SELECT l.id, l.title, COUNT(lc.user_id) as completion_count
      FROM lessons l LEFT JOIN lesson_completions lc ON l.id = lc.lesson_id
      GROUP BY l.id ORDER BY l.sort_order
    `).all();
  },

  getSetting(key) {
    const row = db.prepare('SELECT value FROM settings WHERE key = ?').get(key);
    return row ? row.value : null;
  },

  setSetting(key, value) {
    db.prepare(`
      INSERT INTO settings (key, value) VALUES (?, ?)
      ON CONFLICT(key) DO UPDATE SET value = excluded.value
    `).run(key, value || '');
  },

  getGoalsForWeeks(userId, weekStarts) {
    if (!weekStarts.length) return {};
    const placeholders = weekStarts.map(() => '?').join(',');
    const rows = db.prepare(
      `SELECT * FROM weekly_goals WHERE user_id = ? AND week_start IN (${placeholders})`
    ).all(userId, ...weekStarts);
    const grouped = {};
    for (const row of rows) {
      if (!grouped[row.week_start]) grouped[row.week_start] = {};
      grouped[row.week_start][row.category] = row;
    }
    return grouped;
  },

  // ─── Admin: users ──────────────────────────────────────────────────────────

  updateUser(id, name, email, role, newPassword) {
    const initial = name.trim().charAt(0).toUpperCase();
    if (newPassword && newPassword.trim()) {
      const hash = bcrypt.hashSync(newPassword.trim(), 12);
      return db.prepare(
        'UPDATE users SET name=?, email=?, role=?, avatar_initial=?, password_hash=? WHERE id=?'
      ).run(name.trim(), email.trim().toLowerCase(), role, initial, hash, id);
    }
    return db.prepare(
      'UPDATE users SET name=?, email=?, role=?, avatar_initial=? WHERE id=?'
    ).run(name.trim(), email.trim().toLowerCase(), role, initial, id);
  },

  deleteUser(id) {
    // Foreign keys are enforced (PRAGMA foreign_keys=ON), so every table
    // that references users(id) must be cleared before the user row — and
    // in child-before-parent order for the tables that also reference each
    // other (make_links → makes → cuttings; reactions → posts). Doing this
    // in a single transaction means a partial failure rolls back rather
    // than leaving the account half-deleted. Missing any one of these was
    // making every real student undeletable (FK constraint failed).
    db.exec('BEGIN');
    try {
      // Other students' reactions ON this user's posts, then this user's
      // own reactions, then their posts.
      db.prepare(
        'DELETE FROM community_reactions WHERE post_id IN (SELECT id FROM community_posts WHERE user_id=?)'
      ).run(id);
      db.prepare('DELETE FROM community_reactions WHERE user_id=?').run(id);
      db.prepare('DELETE FROM community_posts WHERE user_id=?').run(id);

      // Cutting graph: links → makes → curations → cuttings, then the
      // content_formats that makes referenced.
      db.prepare('DELETE FROM cutting_make_links WHERE user_id=?').run(id);
      db.prepare('DELETE FROM cutting_makes WHERE user_id=?').run(id);
      db.prepare('DELETE FROM cutting_curations WHERE user_id=?').run(id);
      db.prepare('DELETE FROM cuttings WHERE user_id=?').run(id);
      db.prepare('DELETE FROM content_formats WHERE user_id=?').run(id);
      db.prepare('DELETE FROM tending_pauses WHERE user_id=?').run(id);
      db.prepare('DELETE FROM fallow_beds WHERE user_id=?').run(id);

      // Seed packets (independent per-user tables).
      db.prepare('DELETE FROM seed_packet_highlights WHERE user_id=?').run(id);
      db.prepare('DELETE FROM seed_packet_threads WHERE user_id=?').run(id);
      db.prepare('DELETE FROM seed_packet_seeds WHERE user_id=?').run(id);
      db.prepare('DELETE FROM seed_packet_synthesis_state WHERE user_id=?').run(id);
      db.prepare('DELETE FROM seed_packet_answers WHERE user_id=?').run(id);

      // Everything else keyed by user_id.
      db.prepare('DELETE FROM lesson_completions WHERE user_id=?').run(id);
      db.prepare('DELETE FROM homework_completions WHERE user_id=?').run(id);
      db.prepare('DELETE FROM weekly_goal_shares WHERE user_id=?').run(id);
      db.prepare('DELETE FROM block_buster_options WHERE user_id=?').run(id);
      db.prepare('DELETE FROM block_buster_hidden WHERE user_id=?').run(id);
      db.prepare('DELETE FROM block_buster_busted WHERE user_id=?').run(id);
      db.prepare('DELETE FROM block_buster_blocks WHERE user_id=?').run(id);
      db.prepare('DELETE FROM propagation_makes WHERE user_id=?').run(id);
      db.prepare('DELETE FROM banner_dismissals WHERE user_id=?').run(id);
      db.prepare('DELETE FROM weekly_goals WHERE user_id=?').run(id);
      db.prepare('DELETE FROM goals WHERE user_id=?').run(id);
      db.prepare('DELETE FROM weekly_reflections WHERE user_id=?').run(id);
      db.prepare('DELETE FROM self_assessments WHERE user_id=?').run(id);
      db.prepare('DELETE FROM notification_log WHERE user_id=?').run(id);
      db.prepare('DELETE FROM password_reset_tokens WHERE user_id=?').run(id);
      db.prepare('DELETE FROM push_subscriptions WHERE user_id=?').run(id);

      const result = db.prepare('DELETE FROM users WHERE id=?').run(id);
      db.exec('COMMIT');
      return result;
    } catch (e) {
      try { db.exec('ROLLBACK'); } catch (_) {}
      throw e;
    }
  },

  // ─── Admin: lessons ────────────────────────────────────────────────────────

  getAllLessonsAdmin() {
    return db.prepare('SELECT * FROM lessons ORDER BY sort_order ASC, id ASC').all();
  },

  getLessonById(id) {
    return db.prepare('SELECT * FROM lessons WHERE id=?').get(id);
  },

  createLesson(slug, title, subtitle, categoryTag, content, estimatedReadTime) {
    const maxRow = db.prepare('SELECT MAX(sort_order) as m FROM lessons').get();
    const sortOrder = (maxRow.m || 0) + 10;
    return db.prepare(`
      INSERT INTO lessons (slug, title, subtitle, category_tag, content, estimated_read_time, sort_order, published)
      VALUES (?, ?, ?, ?, ?, ?, ?, 1)
    `).run(slug, title, subtitle || '', categoryTag || '', content || '', estimatedReadTime || 5, sortOrder);
  },

  updateLesson(id, title, subtitle, categoryTag, content, estimatedReadTime, videoUrl) {
    return db.prepare(`
      UPDATE lessons SET title=?, subtitle=?, category_tag=?, content=?, estimated_read_time=?, video_url=? WHERE id=?
    `).run(title, subtitle || '', categoryTag || '', content || '', estimatedReadTime || 5, videoUrl || null, id);
  },

  // ─── Homework ──────────────────────────────────────────────────────────────

  getHomeworkForLesson(lessonId) {
    return db.prepare(
      'SELECT * FROM lesson_homework WHERE lesson_id=? ORDER BY position ASC, id ASC'
    ).all(lessonId);
  },

  getHomeworkCompletions(userId, lessonId) {
    return db.prepare(`
      SELECT hc.homework_id FROM homework_completions hc
      JOIN lesson_homework lh ON lh.id = hc.homework_id
      WHERE hc.user_id=? AND lh.lesson_id=?
    `).all(userId, lessonId).map(r => r.homework_id);
  },

  setHomework(lessonId, items) {
    const existing = db.prepare('SELECT id FROM lesson_homework WHERE lesson_id=?').all(lessonId);
    const existingIds = new Set(existing.map(r => r.id));
    const keptIds = new Set();

    for (let i = 0; i < items.length; i++) {
      const { id, title, link_url, link_label } = items[i];
      const position = i + 1;
      if (id && existingIds.has(parseInt(id))) {
        db.prepare('UPDATE lesson_homework SET title=?, link_url=?, link_label=?, position=? WHERE id=? AND lesson_id=?')
          .run(title || '', link_url || null, link_label || null, position, parseInt(id), lessonId);
        keptIds.add(parseInt(id));
      } else {
        const r = db.prepare('INSERT INTO lesson_homework (lesson_id, position, title, link_url, link_label) VALUES (?, ?, ?, ?, ?)')
          .run(lessonId, position, title || '', link_url || null, link_label || null);
        keptIds.add(r.lastInsertRowid);
      }
    }

    for (const existingId of existingIds) {
      if (!keptIds.has(existingId)) {
        db.prepare('DELETE FROM homework_completions WHERE homework_id=?').run(existingId);
        db.prepare('DELETE FROM lesson_homework WHERE id=?').run(existingId);
      }
    }
  },

  toggleHomework(userId, homeworkId) {
    const existing = db.prepare('SELECT id FROM homework_completions WHERE user_id=? AND homework_id=?').get(userId, homeworkId);
    if (existing) {
      db.prepare('DELETE FROM homework_completions WHERE user_id=? AND homework_id=?').run(userId, homeworkId);
      return { completed: false };
    }
    db.prepare('INSERT OR IGNORE INTO homework_completions (user_id, homework_id) VALUES (?, ?)').run(userId, homeworkId);
    return { completed: true };
  },

  deleteLesson(id) {
    const homework = db.prepare('SELECT id FROM lesson_homework WHERE lesson_id=?').all(id);
    for (const h of homework) {
      db.prepare('DELETE FROM homework_completions WHERE homework_id=?').run(h.id);
    }
    db.prepare('DELETE FROM lesson_homework WHERE lesson_id=?').run(id);
    db.prepare('DELETE FROM lesson_completions WHERE lesson_id=?').run(id);
    return db.prepare('DELETE FROM lessons WHERE id=?').run(id);
  },

  updateLessonSortOrders(orders) {
    const stmt = db.prepare('UPDATE lessons SET sort_order=? WHERE id=?');
    for (const { id, sort_order } of orders) stmt.run(sort_order, id);
  },

  // ─── Admin: resources ──────────────────────────────────────────────────────

  updateResource(id, title, description, categoryTag, url) {
    return db.prepare(
      'UPDATE resources SET title=?, description=?, category_tag=?, url=? WHERE id=?'
    ).run(title, description || '', categoryTag || '', url || '', id);
  },

  deleteResource(id) {
    return db.prepare('DELETE FROM resources WHERE id=?').run(id);
  },

  // ─── Goals ─────────────────────────────────────────────────────────────────

  getUserGoals(userId) {
    // Returns the original (non-replacement) goal per seed_number — used by profile route
    return db.prepare(
      'SELECT * FROM goals WHERE user_id=? AND is_replacement=0 ORDER BY seed_number ASC'
    ).all(userId);
  },

  getGreenhouseGoals(userId) {
    // Returns { 1: { original, replacement }, 2: ..., 3: ... }
    const all = db.prepare(
      'SELECT * FROM goals WHERE user_id=? ORDER BY seed_number ASC, id ASC'
    ).all(userId);
    const map = { 1: { original: null, replacement: null },
                  2: { original: null, replacement: null },
                  3: { original: null, replacement: null } };
    for (const s of all) {
      if (!s.is_replacement) {
        map[s.seed_number].original = s;
      } else if (s.is_active) {
        map[s.seed_number].replacement = s;
      }
    }
    return map;
  },

  upsertGreenhouseGoal(userId, seedNumber, feeling, looksLike, createdAt, bedPosition = null) {
    // Find existing original goal and update, or insert new
    const existing = db.prepare(
      'SELECT id FROM goals WHERE user_id=? AND seed_number=? AND is_replacement=0'
    ).get(userId, seedNumber);
    if (existing) {
      return db.prepare(
        'UPDATE goals SET feeling=?, looks_like=?, updated_at=CURRENT_TIMESTAMP WHERE id=?'
      ).run(feeling || '', looksLike || '', existing.id);
    }
    if (createdAt) {
      return db.prepare(
        'INSERT INTO goals (user_id, seed_number, feeling, looks_like, is_active, is_replacement, created_at, bed_position) VALUES (?, ?, ?, ?, 1, 0, ?, ?)'
      ).run(userId, seedNumber, feeling || '', looksLike || '', createdAt, bedPosition);
    }
    return db.prepare(
      'INSERT INTO goals (user_id, seed_number, feeling, looks_like, is_active, is_replacement, bed_position) VALUES (?, ?, ?, ?, 1, 0, ?)'
    ).run(userId, seedNumber, feeling || '', looksLike || '', bedPosition);
  },

  replaceGoals(userId, seedNumber, feeling, looksLike, createdAt) {
    // Mark current active goal as inactive
    db.prepare(
      'UPDATE goals SET is_active=0, updated_at=CURRENT_TIMESTAMP WHERE user_id=? AND seed_number=? AND is_active=1'
    ).run(userId, seedNumber);
    // Get original goal id for the replaces_seed_id reference
    const original = db.prepare(
      'SELECT id FROM goals WHERE user_id=? AND seed_number=? AND is_replacement=0 ORDER BY id ASC LIMIT 1'
    ).get(userId, seedNumber);
    if (createdAt) {
      return db.prepare(
        'INSERT INTO goals (user_id, seed_number, feeling, looks_like, is_active, is_replacement, replaces_seed_id, created_at) VALUES (?, ?, ?, ?, 1, 1, ?, ?)'
      ).run(userId, seedNumber, feeling || '', looksLike || '', original?.id || null, createdAt);
    }
    return db.prepare(
      'INSERT INTO goals (user_id, seed_number, feeling, looks_like, is_active, is_replacement, replaces_seed_id) VALUES (?, ?, ?, ?, 1, 1, ?)'
    ).run(userId, seedNumber, feeling || '', looksLike || '', original?.id || null);
  },

  updateGoalById(seedId, userId, feeling, looksLike) {
    return db.prepare(
      'UPDATE goals SET feeling=?, looks_like=?, updated_at=CURRENT_TIMESTAMP WHERE id=? AND user_id=?'
    ).run(feeling || '', looksLike || '', seedId, userId);
  },

  upsertGreenhouseGoalFacets(userId, seedNumber, facets, createdAt, bedPosition = null) {
    const { soil = '', seed = '', water = '', bloom = '' } = facets;
    // Planting and being fallow are mutually exclusive: clear any fallow row
    // for this bed when planting it, so a student who marked a bed fallow can
    // change their mind by re-entering the plant form.
    db.prepare('DELETE FROM fallow_beds WHERE user_id=? AND bed_number=?')
      .run(userId, seedNumber);
    const existing = db.prepare(
      'SELECT id FROM goals WHERE user_id=? AND seed_number=? AND is_replacement=0'
    ).get(userId, seedNumber);
    if (existing) {
      return db.prepare(
        'UPDATE goals SET soil=?, seed=?, water=?, bloom=?, updated_at=CURRENT_TIMESTAMP WHERE id=?'
      ).run(soil, seed, water, bloom, existing.id);
    }
    if (createdAt) {
      return db.prepare(
        'INSERT INTO goals (user_id, seed_number, soil, seed, water, bloom, is_active, is_replacement, created_at, bed_position) VALUES (?, ?, ?, ?, ?, ?, 1, 0, ?, ?)'
      ).run(userId, seedNumber, soil, seed, water, bloom, createdAt, bedPosition);
    }
    return db.prepare(
      'INSERT INTO goals (user_id, seed_number, soil, seed, water, bloom, is_active, is_replacement, bed_position) VALUES (?, ?, ?, ?, ?, ?, 1, 0, ?)'
    ).run(userId, seedNumber, soil, seed, water, bloom, bedPosition);
  },

  // ─── Fallow beds: a row here means "student chose to leave this bed empty
  // this season." Planting that bed clears the row (see upsertGreenhouseGoal-
  // Facets). Used by the "all beds resolved" milestone for the admin email.
  setBedFallow(userId, bedNumber) {
    return db.prepare(
      'INSERT OR IGNORE INTO fallow_beds (user_id, bed_number) VALUES (?, ?)'
    ).run(userId, bedNumber);
  },

  getFallowBedNumbers(userId) {
    return db.prepare(
      'SELECT bed_number FROM fallow_beds WHERE user_id=? ORDER BY bed_number ASC'
    ).all(userId).map(r => r.bed_number);
  },

  // True when every bed (1, 2, 3) is either planted (a goal row exists) or
  // explicitly fallow. Drives the greenhouse_goals_set milestone.
  areAllBedsResolved(userId) {
    const plantedBeds = new Set(db.prepare(
      'SELECT DISTINCT seed_number FROM goals WHERE user_id=? AND is_active=1'
    ).all(userId).map(r => r.seed_number));
    const fallowBeds = new Set(this.getFallowBedNumbers(userId));
    for (let n = 1; n <= 3; n++) {
      if (!plantedBeds.has(n) && !fallowBeds.has(n)) return false;
    }
    return true;
  },

  // ─── Admin notification ledger ────────────────────────────────────────────
  // Try to claim a milestone for this user. Returns true if it was the first
  // time (caller should send the email) or false if it was already claimed
  // (caller should skip). The UNIQUE constraint + INSERT OR IGNORE is what
  // makes this atomic: two concurrent requests can race and only one will
  // see lastInsertRowid > 0.
  tryClaimMilestone(userId, milestone) {
    const result = db.prepare(
      'INSERT OR IGNORE INTO notification_log (user_id, milestone) VALUES (?, ?)'
    ).run(userId, milestone);
    return result.changes > 0;
  },

  hasMilestoneBeenClaimed(userId, milestone) {
    return !!db.prepare(
      'SELECT 1 FROM notification_log WHERE user_id=? AND milestone=?'
    ).get(userId, milestone);
  },

  // Undo a claim — used when a send fails after tryClaimMilestone succeeded,
  // so the next run re-attempts it instead of the claim silently swallowing
  // the notification forever.
  releaseMilestone(userId, milestone) {
    return db.prepare(
      'DELETE FROM notification_log WHERE user_id=? AND milestone=?'
    ).run(userId, milestone).changes;
  },

  replaceGoalsFacets(userId, seedNumber, facets, createdAt) {
    const { soil = '', seed = '', water = '', bloom = '' } = facets;
    db.prepare(
      'UPDATE goals SET is_active=0, updated_at=CURRENT_TIMESTAMP WHERE user_id=? AND seed_number=? AND is_active=1'
    ).run(userId, seedNumber);
    const original = db.prepare(
      'SELECT id FROM goals WHERE user_id=? AND seed_number=? AND is_replacement=0 ORDER BY id ASC LIMIT 1'
    ).get(userId, seedNumber);
    if (createdAt) {
      return db.prepare(
        'INSERT INTO goals (user_id, seed_number, soil, seed, water, bloom, is_active, is_replacement, replaces_seed_id, created_at) VALUES (?, ?, ?, ?, ?, ?, 1, 1, ?, ?)'
      ).run(userId, seedNumber, soil, seed, water, bloom, original?.id || null, createdAt);
    }
    return db.prepare(
      'INSERT INTO goals (user_id, seed_number, soil, seed, water, bloom, is_active, is_replacement, replaces_seed_id) VALUES (?, ?, ?, ?, ?, ?, 1, 1, ?)'
    ).run(userId, seedNumber, soil, seed, water, bloom, original?.id || null);
  },

  updateGoalByIdFacets(seedId, userId, facets) {
    const { soil = '', seed = '', water = '', bloom = '' } = facets;
    return db.prepare(
      'UPDATE goals SET soil=?, seed=?, water=?, bloom=?, updated_at=CURRENT_TIMESTAMP WHERE id=? AND user_id=?'
    ).run(soil, seed, water, bloom, seedId, userId);
  },

  getGoalById(seedId, userId) {
    return db.prepare('SELECT * FROM goals WHERE id = ? AND user_id = ?').get(seedId, userId);
  },

  getActiveGoalByNumber(userId, seedNumber) {
    return db.prepare(
      'SELECT * FROM goals WHERE user_id = ? AND seed_number = ? AND is_active = 1 ORDER BY id DESC LIMIT 1'
    ).get(userId, seedNumber);
  },

  getPlantedGoalCount(userId) {
    return db.prepare(
      'SELECT COUNT(*) as c FROM goals WHERE user_id = ? AND is_replacement = 0'
    ).get(userId).c;
  },

  getEmptyBedPositions(userId) {
    const filled = db.prepare(
      'SELECT DISTINCT bed_position FROM goals WHERE user_id = ? AND bed_position IS NOT NULL'
    ).all(userId).map(r => r.bed_position);
    return [1, 2, 3].filter(n => !filled.includes(n));
  },

  getAllUsersGoals() {
    return db.prepare(`
      SELECT s.*, u.name as user_name, u.avatar_initial
      FROM goals s
      JOIN users u ON s.user_id = u.id
      WHERE s.is_replacement = 0
      ORDER BY u.name ASC, s.seed_number ASC
    `).all();
  },

  // Owner-only export helpers — read-only, SELECT only.
  // Used by GET /admin/export. Never called during migrations or boot.
  getAllUsersForExport() {
    return db.prepare(`
      SELECT id, name, email, role, current_season,
             onboarding_completed, has_visited_greenhouse,
             created_at
      FROM users
      ORDER BY id ASC
    `).all();
  },

  getAllGoalsForExport() {
    return db.prepare(`
      SELECT *
      FROM goals
      ORDER BY user_id ASC, seed_number ASC, id ASC
    `).all();
  },

  // ─── Self-Assessments ──────────────────────────────────────────────────────

  getAssessment(userId, type) {
    return db.prepare('SELECT * FROM self_assessments WHERE user_id = ? AND assessment_type = ?').get(userId, type);
  },

  upsertAssessment(userId, type, data) {
    const { q1_choice, q2_rating, q3_choice, q4_rating, q5_choice, q6_rating,
            q7_choices, q8_choice, q9_text, q10_text, q11_text, q12_text,
            harvest_reflection } = data;
    return db.prepare(`
      INSERT INTO self_assessments
        (user_id, assessment_type, q1_choice, q2_rating, q3_choice, q4_rating,
         q5_choice, q6_rating, q7_choices, q8_choice, q9_text, q10_text,
         q11_text, q12_text, harvest_reflection, completed_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP)
      ON CONFLICT(user_id, assessment_type) DO UPDATE SET
        q1_choice          = excluded.q1_choice,
        q2_rating          = excluded.q2_rating,
        q3_choice          = excluded.q3_choice,
        q4_rating          = excluded.q4_rating,
        q5_choice          = excluded.q5_choice,
        q6_rating          = excluded.q6_rating,
        q7_choices         = excluded.q7_choices,
        q8_choice          = excluded.q8_choice,
        q9_text            = excluded.q9_text,
        q10_text           = excluded.q10_text,
        q11_text           = excluded.q11_text,
        q12_text           = excluded.q12_text,
        harvest_reflection = excluded.harvest_reflection,
        completed_at       = CURRENT_TIMESTAMP
    `)
    // Ratings use ?? not || because 0 is a valid rating (the trial closing's
    // scale starts at 0 = "the same as when I started"). With ||, 0 would
    // coerce to null and the row would lose the user's actual answer.
    .run(userId, type,
      q1_choice || '', q2_rating ?? null, q3_choice || '', q4_rating ?? null,
      q5_choice || '', q6_rating ?? null, q7_choices || '', q8_choice || '',
      q9_text || '', q10_text || '', q11_text || '', q12_text || '',
      harvest_reflection || '');
  },

  keepGoal(seedId, userId, kept) {
    if (kept) {
      return db.prepare(
        'UPDATE goals SET kept_at=CURRENT_TIMESTAMP, updated_at=CURRENT_TIMESTAMP WHERE id=? AND user_id=?'
      ).run(seedId, userId);
    }
    return db.prepare(
      'UPDATE goals SET kept_at=NULL, updated_at=CURRENT_TIMESTAMP WHERE id=? AND user_id=?'
    ).run(seedId, userId);
  },

  markMidcourseComplete(userId) {
    return db.prepare(`
      INSERT INTO self_assessments (user_id, assessment_type, completed_at)
      VALUES (?, 'midcourse', CURRENT_TIMESTAMP)
      ON CONFLICT(user_id, assessment_type) DO UPDATE SET completed_at = CURRENT_TIMESTAMP
    `).run(userId);
  },

  // ─── Mid-course feedback (anonymous) ───────────────────────────────────────
  // submitMidcourseResponse writes the actual answers to a table that has NO
  // user_id column. markMidcourseSubmittedForUser writes a flag to the users
  // table. The two are intentionally separate. Both should be called inside
  // the same request handler, but never in a single transaction that joins
  // them — so even at the SQL level the link can't be reconstructed.
  submitMidcourseResponse(answers, dayString) {
    const a = answers || {};
    return db.prepare(`
      INSERT INTO midcourse_responses
        (submitted_at_day, q1_rating, q2_working, q3_resistance, q4_improvement, q5_other)
      VALUES (?, ?, ?, ?, ?, ?)
    `).run(
      dayString,
      a.q1_rating != null ? Number(a.q1_rating) : null,
      Array.isArray(a.q2_working)    ? a.q2_working.join(',')    : (a.q2_working || ''),
      Array.isArray(a.q3_resistance) ? a.q3_resistance.join(',') : (a.q3_resistance || ''),
      a.q4_improvement || '',
      a.q5_other || ''
    );
  },

  markMidcourseSubmittedForUser(userId) {
    return db.prepare(
      'UPDATE users SET midcourse_submitted_at = CURRENT_TIMESTAMP WHERE id = ? AND midcourse_submitted_at IS NULL'
    ).run(userId);
  },

  hasMidcourseBeenSubmittedByUser(userId) {
    const r = db.prepare(
      'SELECT midcourse_submitted_at FROM users WHERE id = ?'
    ).get(userId);
    return !!(r && r.midcourse_submitted_at);
  },

  // Trial students store their closing reflection in self_assessments with
  // assessment_type = 'trial_closing'. Mirrors the existing opening/closing
  // row pattern so getStudentFullData can surface it in the admin view.
  hasTrialClosingBeenSubmittedByUser(userId) {
    return !!db.prepare(
      "SELECT id FROM self_assessments WHERE user_id = ? AND assessment_type = 'trial_closing'"
    ).get(userId);
  },

  getTrialClosingForUser(userId) {
    return db.prepare(
      "SELECT * FROM self_assessments WHERE user_id = ? AND assessment_type = 'trial_closing'"
    ).get(userId) || null;
  },

  // All anonymous responses, oldest first. Used by the PDF generator each
  // time a new response lands — Julia gets a cumulative snapshot per email.
  getAllMidcourseResponses() {
    return db.prepare(
      'SELECT id, submitted_at_day, q1_rating, q2_working, q3_resistance, q4_improvement, q5_other FROM midcourse_responses ORDER BY id ASC'
    ).all();
  },

  countMidcourseSubmissionsByStudents() {
    const total    = db.prepare("SELECT COUNT(*) AS c FROM users WHERE role='student'").get().c;
    const done     = db.prepare("SELECT COUNT(*) AS c FROM users WHERE role='student' AND midcourse_submitted_at IS NOT NULL").get().c;
    return { done, total };
  },

  setOnboardingComplete(userId) {
    return db.prepare('UPDATE users SET onboarding_completed = 1 WHERE id = ?').run(userId);
  },

  getWeeklyReflection(userId, weekStart) {
    return db.prepare('SELECT * FROM weekly_reflections WHERE user_id = ? AND week_start = ?').get(userId, weekStart) || null;
  },

  getWeeklyReflections(userId, weekStarts) {
    if (!weekStarts.length) return {};
    const placeholders = weekStarts.map(() => '?').join(',');
    const rows = db.prepare(
      `SELECT * FROM weekly_reflections WHERE user_id = ? AND week_start IN (${placeholders})`
    ).all(userId, ...weekStarts);
    const map = {};
    for (const r of rows) map[r.week_start] = r;
    return map;
  },

  upsertWeeklyReflection(userId, weekStart, text, sharedWithCohort) {
    return db.prepare(`
      INSERT INTO weekly_reflections (user_id, week_start, text, shared_with_cohort)
      VALUES (?, ?, ?, ?)
      ON CONFLICT(user_id, week_start) DO UPDATE SET
        text = excluded.text,
        shared_with_cohort = excluded.shared_with_cohort,
        updated_at = CURRENT_TIMESTAMP
    `).run(userId, weekStart, text || '', sharedWithCohort ? 1 : 0);
  },

  // Cuttings: daily reflection from the Dashboard recording practice.
  // Caller is responsible for trimming each field + the all-empty check;
  // this just inserts. `fields` is { reflection_text, talked_about,
  // how_it_felt, takeaway } — any/all may be null. `recordedDate` is the
  // day-it-happened (YYYY-MM-DD) — caller stamps it explicitly (today for
  // normal logging, a backdated date for backdating). `prompt` is the
  // vestigial legacy column. `videoUid` is an optional Cloudflare Stream uid
  // when the student attached a video to this entry.
  createCutting(userId, season, prompt, fields, recordedDate, videoUid) {
    return db.prepare(`
      INSERT INTO cuttings
        (user_id, season, prompt, recorded_date,
         reflection_text, talked_about, how_it_felt, takeaway, video_uid)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      userId,
      season || null,
      prompt || null,
      recordedDate || null,
      fields.reflection_text || null,
      fields.talked_about    || null,
      fields.how_it_felt     || null,
      fields.takeaway        || null,
      videoUid || null
    );
  },

  // Create a "bonus" recording — something filmed outside the daily practice —
  // and drop it straight onto the workbench "to edit" pile by giving it an
  // immediate keep_growing curation. That skips the practice's Tending review
  // (which only surfaces uncurated daily recordings). title names it; note is
  // free text (what it is / where the footage lives). Returns the cutting id.
  createBonusRecording(userId, title, note, season, recordedDate) {
    db.exec('BEGIN');
    try {
      const id = db.prepare(`
        INSERT INTO cuttings
          (user_id, kind, title, season, recorded_date, talked_about, watched)
        VALUES (?, 'bonus', ?, ?, ?, ?, 1)
      `).run(
        userId,
        (title || '').trim() || null,
        season || null,
        recordedDate || null,
        (note || '').trim() || null
      ).lastInsertRowid;
      db.prepare(`
        INSERT INTO cutting_curations (cutting_id, user_id, category)
        VALUES (?, ?, 'keep_growing')
      `).run(id, userId);
      db.exec('COMMIT');
      return id;
    } catch (e) {
      try { db.exec('ROLLBACK'); } catch (_) {}
      throw e;
    }
  },

  // ── Content ideas (want-to-make; may already have material, or none) ─────
  getContentIdeas(userId) {
    return db.prepare(
      'SELECT id, title, note, materials, created_at FROM content_ideas WHERE user_id = ? ORDER BY created_at DESC, id DESC'
    ).all(userId);
  },
  // materials: CSV string of any of writing|audio|photos|video (already
  // validated/normalised by the caller); '' or null = just an idea.
  createContentIdea(userId, title, note, materials) {
    return db.prepare(
      'INSERT INTO content_ideas (user_id, title, note, materials) VALUES (?, ?, ?, ?)'
    ).run(
      userId,
      (title || '').trim() || null,
      (note || '').trim() || null,
      (materials || '').trim() || null
    ).lastInsertRowid;
  },
  deleteContentIdea(ideaId, userId) {
    return db.prepare('DELETE FROM content_ideas WHERE id = ? AND user_id = ?').run(ideaId, userId).changes;
  },
  // "Mark as filmed" — turn an idea into a Bonus Recording on the to-edit pile
  // and remove the idea. Returns the new cutting id, or null if not owned.
  promoteIdeaToBonus(ideaId, userId, season, recordedDate) {
    const idea = db.prepare('SELECT title, note FROM content_ideas WHERE id = ? AND user_id = ?').get(ideaId, userId);
    if (!idea) return null;
    const cuttingId = this.createBonusRecording(userId, idea.title, idea.note, season, recordedDate);
    db.prepare('DELETE FROM content_ideas WHERE id = ? AND user_id = ?').run(ideaId, userId);
    return cuttingId;
  },

  // Does this Stream video belong to this user? Gate for minting playback
  // tokens — without this check, any signed-in user could request a token for
  // someone else's private recording.
  userOwnsVideo(userId, videoUid) {
    return !!db.prepare(
      'SELECT 1 FROM cuttings WHERE user_id = ? AND video_uid = ? LIMIT 1'
    ).get(userId, videoUid);
  },

  // Has this user already logged a recording for a given local day
  // (YYYY-MM-DD)? Used by the daily reminder so we don't nag someone who's
  // already done it. Hits the (user_id, recorded_date) index.
  hasCuttingForDate(userId, dateStr) {
    return !!db.prepare(
      'SELECT 1 FROM cuttings WHERE user_id = ? AND recorded_date = ? LIMIT 1'
    ).get(userId, dateStr);
  },

  // Read-only: all cuttings for a user. Ordered by recorded_date DESC
  // (newest day first across days) then created_at ASC (within a day,
  // earliest-written first — morning entry above evening entry).
  //
  // Joins in the most recent Tending curation per cutting (if any) so
  // the archive UI can show a rating badge + the Gardener reflection
  // right on the cutting card. Fields are aliased to tending_* so they
  // don't collide with the cutting's own reflection_text column.
  getCuttingsForUser(userId) {
    return db.prepare(
      `SELECT c.id, c.created_at, c.recorded_date, c.season, c.prompt,
              c.reflection_text, c.talked_about, c.how_it_felt, c.takeaway,
              c.watched, c.edited, c.kind, c.title,
              latest.category        AS tending_category,
              latest.reflection_text AS tending_reflection,
              latest.curated_at      AS tending_curated_at
       FROM cuttings c
       LEFT JOIN (
         SELECT cc1.cutting_id, cc1.category, cc1.reflection_text, cc1.curated_at
         FROM cutting_curations cc1
         WHERE cc1.id = (
           SELECT cc2.id FROM cutting_curations cc2
           WHERE cc2.cutting_id = cc1.cutting_id
           ORDER BY cc2.curated_at DESC, cc2.id DESC
           LIMIT 1
         )
       ) latest ON latest.cutting_id = c.id
       WHERE c.user_id = ?
       ORDER BY c.recorded_date DESC, c.created_at ASC`
    ).all(userId);
  },

  // Chronological — for the PDF export, which tells a forward-moving
  // story. Within a day: earliest-written-first (same rule as the archive).
  getCuttingsForUserChronological(userId) {
    return db.prepare(
      `SELECT id, created_at, recorded_date, season, prompt,
              reflection_text, talked_about, how_it_felt, takeaway,
              watched, edited
       FROM cuttings WHERE user_id = ?
       ORDER BY recorded_date ASC, created_at ASC`
    ).all(userId);
  },

  // All accounts that should be iterated by the weekly cuttings digest.
  // Originally student-only, but admins also use the recording feature
  // and would otherwise be invisible in their own digest. The digest's
  // per-row gate is "has the user recorded any cuttings in the window?",
  // so admins who don't record produce no email — no noise added.
  getAllAccountsForDigest() {
    return db.prepare(
      "SELECT id, name, email, role FROM users ORDER BY role DESC, id ASC"
    ).all();
  },

  // Inclusive date window [fromDate, toDate], both YYYY-MM-DD strings.
  // Used by the weekly cuttings digest cron — pass the previous Mon and Sun
  // and you get exactly that week's entries, chronologically.
  getCuttingsForUserInRange(userId, fromDate, toDate) {
    return db.prepare(
      `SELECT id, created_at, recorded_date, season, prompt,
              reflection_text, talked_about, how_it_felt, takeaway,
              watched, edited
       FROM cuttings WHERE user_id = ?
         AND recorded_date BETWEEN ? AND ?
       ORDER BY recorded_date ASC, created_at ASC`
    ).all(userId, fromDate, toDate);
  },

  // All cuttings for a single day — for the Dashboard day-view. Multiple
  // entries per day allowed (no uniqueness constraint); within the day
  // they're ordered earliest-written-first.
  getCuttingsForUserOnDate(userId, recordedDate) {
    return db.prepare(
      `SELECT id, created_at, recorded_date, season, prompt,
              reflection_text, talked_about, how_it_felt, takeaway,
              watched, edited, video_uid
       FROM cuttings WHERE user_id = ? AND recorded_date = ?
       ORDER BY created_at ASC`
    ).all(userId, recordedDate);
  },

  // Update the watched/edited mark on a cutting. Whitelists `mark` so it can
  // safely interpolate into the SQL column name; coerces value to 0|1; scopes
  // the UPDATE by user_id so a student can only mark their own rows. Returns
  // the rows-changed count (0 if no row matched or the value was already set).
  setCuttingMark(cuttingId, userId, mark, value) {
    if (mark !== 'watched' && mark !== 'edited') {
      throw new Error('Invalid mark: ' + mark);
    }
    const v = value ? 1 : 0;
    return db.prepare(
      `UPDATE cuttings SET ${mark} = ? WHERE id = ? AND user_id = ?`
    ).run(v, cuttingId, userId).changes;
  },

  // Hard-delete a cutting. Ownership scoped via the WHERE so a student can
  // only delete their own rows. Returns the rows-changed count (0 if no
  // matching row — handled as a no-op success at the route level).
  deleteCutting(cuttingId, userId) {
    return db.prepare(
      'DELETE FROM cuttings WHERE id = ? AND user_id = ?'
    ).run(cuttingId, userId).changes;
  },

  // ── Tending helpers ─────────────────────────────────────────────────────
  // Related tables: cutting_curations (history-preserving; latest row per
  // cutting_id defines its "current" bucket), tending_pauses (append-only
  // log of pause events). Week math is computed in-JS from the user's
  // course_start_date since it's cheap (≤ ~84 cuttings/user).

  // Compute a cutting's recording week (1-based) relative to the user's
  // course_start_date. Returns null if either input is missing or the
  // cutting is pre-course.
  _cuttingWeekNumber(recordedDate, courseStartDate) {
    if (!recordedDate || !courseStartDate) return null;
    const start = new Date(courseStartDate + 'T00:00:00');
    const rd    = new Date(recordedDate    + 'T00:00:00');
    const days  = Math.floor((rd - start) / 86400000);
    if (days < 0) return null;
    return Math.floor(days / 7) + 1;
  },

  // Which recording-week's queue should the student see this session?
  //   currentCourseWeek — the student's 1-based week-of-course (from the
  //     server's getCurrentCourseWeek helper). Tending starts Week 4, and
  //     the queue lags 3 weeks (Week 4 reviews Week 1, Week 5 reviews Week 2).
  //   courseStartDate  — user's per-user override or the global default.
  // Returns the earliest recording-week (1..maxReviewable) that still has
  // any uncurated cuttings. If everything up to maxReviewable is sorted,
  // returns null (queue is caught up; only resurfacing cuttings, if any,
  // remain to show).
  getTendingReviewWeek(userId, currentCourseWeek, courseStartDate) {
    if (!courseStartDate || !currentCourseWeek || currentCourseWeek < 4) return null;
    const maxReviewable = currentCourseWeek - 3;
    if (maxReviewable < 1) return null;

    const rows = db.prepare(`
      SELECT c.id, c.recorded_date
      FROM cuttings c
      WHERE c.user_id = ?
        AND NOT EXISTS (
          SELECT 1 FROM cutting_curations cc
          WHERE cc.cutting_id = c.id
        )
      ORDER BY c.recorded_date ASC
    `).all(userId);

    let minWeek = null;
    for (const r of rows) {
      const wk = this._cuttingWeekNumber(r.recorded_date, courseStartDate);
      if (wk === null) continue;
      if (wk > maxReviewable) continue;
      if (minWeek === null || wk < minWeek) minWeek = wk;
    }
    return minWeek;
  },

  // Every recording-week (1..maxReviewable) that still has uncurated cuttings,
  // as [{ week, count }] ascending. Powers the /tending backlog list, which
  // lets a student who has fallen behind jump to any waiting week instead of
  // being served only the oldest one. maxReviewable = effectiveCurrent - 3,
  // matching getTendingReviewWeek's buffer so the list and the default pick
  // stay in agreement. Returns [] before Tending opens or when nothing waits.
  getTendingPendingWeeks(userId, maxReviewable, courseStartDate) {
    if (!courseStartDate || !maxReviewable || maxReviewable < 1) return [];
    const rows = db.prepare(`
      SELECT c.recorded_date
      FROM cuttings c
      WHERE c.user_id = ?
        AND NOT EXISTS (
          SELECT 1 FROM cutting_curations cc WHERE cc.cutting_id = c.id
        )
    `).all(userId);

    const counts = new Map();
    for (const r of rows) {
      const wk = this._cuttingWeekNumber(r.recorded_date, courseStartDate);
      if (wk === null || wk > maxReviewable) continue;
      counts.set(wk, (counts.get(wk) || 0) + 1);
    }
    return [...counts.entries()]
      .map(([week, count]) => ({ week, count }))
      .sort((a, b) => a.week - b.week);
  },

  // Build the Tending queue for a session:
  //   A) all uncurated cuttings whose recording-week == reviewWeek
  //   B) all cuttings whose latest curation is return_later AND
  //      resurface_after ≤ todayStr (any recording-week they've reached)
  // Each item comes back as { cutting: {...}, isResurfacing, lastCategory,
  // lastCuratedAt } so the view can render a small "returning to" badge
  // on resurfacing cards. todayStr is YYYY-MM-DD in the user's timezone.
  getTendingQueue(userId, reviewWeek, courseStartDate, todayStr) {
    const items = [];

    // ── (A) Uncurated cuttings from the review week ──────────────────────
    if (reviewWeek) {
      const uncurated = db.prepare(`
        SELECT c.id, c.created_at, c.recorded_date, c.season, c.prompt,
               c.reflection_text, c.talked_about, c.how_it_felt, c.takeaway
        FROM cuttings c
        WHERE c.user_id = ?
          AND NOT EXISTS (
            SELECT 1 FROM cutting_curations cc WHERE cc.cutting_id = c.id
          )
        ORDER BY c.recorded_date ASC, c.created_at ASC
      `).all(userId);
      for (const c of uncurated) {
        const wk = this._cuttingWeekNumber(c.recorded_date, courseStartDate);
        if (wk === reviewWeek) {
          items.push({ cutting: c, isResurfacing: false, lastCategory: null, lastCuratedAt: null });
        }
      }
    }

    // ── (B) Resurfacing return_later cuttings ────────────────────────────
    // "Latest curation per cutting" via a correlated subquery. Filtered
    // to those still in return_later and past their resurface date.
    const resurfacing = db.prepare(`
      SELECT c.id, c.created_at, c.recorded_date, c.season, c.prompt,
             c.reflection_text, c.talked_about, c.how_it_felt, c.takeaway,
             latest.category  AS last_category,
             latest.curated_at AS last_curated_at
      FROM cuttings c
      JOIN (
        SELECT cc1.*
        FROM cutting_curations cc1
        WHERE cc1.id = (
          SELECT cc2.id FROM cutting_curations cc2
          WHERE cc2.cutting_id = cc1.cutting_id
          ORDER BY cc2.curated_at DESC, cc2.id DESC
          LIMIT 1
        )
      ) latest ON latest.cutting_id = c.id
      WHERE c.user_id = ?
        AND latest.category = 'return_later'
        AND latest.resurface_after IS NOT NULL
        AND latest.resurface_after <= ?
      ORDER BY latest.resurface_after ASC, c.recorded_date ASC
    `).all(userId, todayStr);
    for (const r of resurfacing) {
      const { last_category, last_curated_at, ...cut } = r;
      items.push({
        cutting:       cut,
        isResurfacing: true,
        lastCategory:  last_category,
        lastCuratedAt: last_curated_at,
      });
    }

    return items;
  },

  // Record a curation event. New row per event, so history is preserved and
  // "latest wins" everywhere else. For return_later, resurface_after is
  // stamped to todayStr + 21 days so the queue re-serves it later. Optional
  // reflection is the right-side text the student wrote while watching.
  // Also flips cuttings.watched = 1 as a side effect (auto-mark on curate),
  // wrapped in a single transaction so the two writes stay consistent.
  setCuttingCuration(cuttingId, userId, category, todayStr, reflectionText) {
    if (!['keep_growing', 'return_later', 'archive', 'just_for_me'].includes(category)) {
      throw new Error('Invalid curation category: ' + category);
    }
    // Ownership gate: a curation row silently becomes the cutting's "latest"
    // state everywhere, so writing one against someone else's cutting would
    // let any student rewrite another student's Tending decisions.
    const owned = db.prepare(
      'SELECT 1 FROM cuttings WHERE id = ? AND user_id = ?'
    ).get(cuttingId, userId);
    if (!owned) {
      const err = new Error('Cutting not found for this user');
      err.code = 'NOT_OWNED';
      throw err;
    }
    let resurfaceAfter = null;
    if (category === 'return_later') {
      const d = new Date(todayStr + 'T00:00:00');
      d.setDate(d.getDate() + 21);
      resurfaceAfter = d.toISOString().split('T')[0];
    }
    // node:sqlite has no better-sqlite3-style .transaction(); use explicit
    // BEGIN/COMMIT so the insert + watched flag land atomically. On any
    // error, ROLLBACK is best-effort — the throw still surfaces to the
    // caller either way.
    db.exec('BEGIN');
    try {
      db.prepare(`
        INSERT INTO cutting_curations
          (cutting_id, user_id, category, resurface_after, reflection_text)
        VALUES (?, ?, ?, ?, ?)
      `).run(cuttingId, userId, category, resurfaceAfter, reflectionText || null);
      db.prepare(
        `UPDATE cuttings SET watched = 1 WHERE id = ? AND user_id = ?`
      ).run(cuttingId, userId);
      db.exec('COMMIT');
    } catch (e) {
      try { db.exec('ROLLBACK'); } catch (_) {}
      throw e;
    }
    return resurfaceAfter;
  },

  // Append a Tending pause event. `note` is optional (the "what's here
  // today?" text field on the pause modal — one line, may be null).
  recordTendingPause(userId, note) {
    return db.prepare(
      'INSERT INTO tending_pauses (user_id, note) VALUES (?, ?)'
    ).run(userId, (note || '').trim() || null).lastInsertRowid;
  },

  // Whether the student has dismissed the "Meet the Gardener" intro overlay.
  hasSeenTendingIntro(userId) {
    const row = db.prepare('SELECT tending_intro_seen FROM users WHERE id = ?').get(userId);
    return !!(row && row.tending_intro_seen);
  },
  markTendingIntroSeen(userId) {
    return db.prepare(
      'UPDATE users SET tending_intro_seen = 1 WHERE id = ?'
    ).run(userId).changes;
  },

  // Whether the student has dismissed the "Welcome to Spring" intro card.
  // Returns true if they have OR if the flag column doesn't exist yet
  // (safe fallback that suppresses the card rather than showing it in a
  // half-migrated state).
  hasSeenSeasonIntro(userId) {
    const row = db.prepare('SELECT season_intro_seen FROM users WHERE id = ?').get(userId);
    return !!(row && row.season_intro_seen);
  },
  markSeasonIntroSeen(userId) {
    return db.prepare(
      'UPDATE users SET season_intro_seen = 1 WHERE id = ?'
    ).run(userId).changes;
  },

  // Count of cuttings that have NEVER been curated (any category, any
  // week). Used by /tending's empty state to distinguish "you're caught
  // up but more will surface as they age" from "you have tended every
  // logged cutting." Cheap — indexed by user_id.
  countUncuratedCuttings(userId) {
    const row = db.prepare(`
      SELECT COUNT(*) AS c
      FROM cuttings c
      WHERE c.user_id = ?
        AND NOT EXISTS (
          SELECT 1 FROM cutting_curations cc WHERE cc.cutting_id = c.id
        )
    `).get(userId);
    return row ? row.c : 0;
  },

  // ── Summer helpers ─────────────────────────────────────────────────────

  // All formats a user can pick from — built-ins (user_id IS NULL) plus
  // their own non-archived customs. Ordered by (built-in first, then
  // position). Archived customs are excluded from the picker but stay in
  // the DB so cutting_makes rows that reference them still render.
  getFormatsForUser(userId) {
    return db.prepare(`
      SELECT id, user_id, slug, name, emoji, description, detail_content,
             position, archived
      FROM content_formats
      WHERE (user_id IS NULL OR user_id = ?)
        AND archived = 0
        AND slug != 'unassigned'
      ORDER BY (user_id IS NULL) DESC, position ASC, id ASC
    `).all(userId);
  },

  // The reserved "No format yet" format that formatless idea saves point at.
  // Returns null if it somehow isn't seeded (route treats that as an error).
  getUnassignedFormat() {
    return db.prepare(
      "SELECT id, slug, name, emoji FROM content_formats WHERE user_id IS NULL AND slug = 'unassigned'"
    ).get() || null;
  },

  // Look up a single format by id. Ownership check: built-ins (user_id
  // IS NULL) are visible to everyone; custom formats only to their owner.
  // Returns null if not found or not owned.
  getFormatById(formatId, userId) {
    const row = db.prepare(`
      SELECT id, user_id, slug, name, emoji, description, detail_content,
             position, archived
      FROM content_formats
      WHERE id = ?
        AND (user_id IS NULL OR user_id = ?)
    `).get(formatId, userId);
    return row || null;
  },

  // Look up a built-in format by its stable slug (used by the per-format
  // detail-page URL /summer/format/:slug).
  getBuiltinFormatBySlug(slug) {
    return db.prepare(`
      SELECT id, user_id, slug, name, emoji, description, detail_content,
             position, archived
      FROM content_formats
      WHERE user_id IS NULL AND slug = ?
    `).get(slug) || null;
  },

  // Every "made as X" record for this user, joined with the format so the
  // view can render the emoji+name inline. Ordered newest-make first.
  // The Grove renders one row per cutting_make, so a cutting made as three
  // formats produces three entries.
  // Grove entries — only shows format ideas the student marked as
  // created (m.created = 1). Ideas still in the "planned" state live on
  // the Cultivated Ideas page and don't appear here.
  getGroveEntries(userId) {
    return db.prepare(`
      SELECT m.id                AS make_id,
             m.made_at           AS made_at,
             m.note              AS make_note,
             m.share_note        AS share_note,
             m.just_for_me       AS just_for_me,
             m.created           AS created,
             m.stem_variant      AS stem_variant,
             m.cohort_shared     AS cohort_shared,
             m.cohort_shared_at  AS cohort_shared_at,
             m.discord_url       AS discord_url,
             c.id            AS cutting_id,
             c.recorded_date, c.season, c.talked_about, c.how_it_felt, c.takeaway,
             f.id            AS format_id,
             f.slug          AS format_slug,
             f.name          AS format_name,
             f.emoji         AS format_emoji
      FROM cutting_makes m
      JOIN cuttings       c ON c.id = m.cutting_id
      JOIN content_formats f ON f.id = m.format_id
      WHERE m.user_id = ?
        AND m.created = 1
      ORDER BY m.made_at DESC, m.id DESC
    `).all(userId);
  },

  // ── Custom-format CRUD (per-student) ───────────────────────────────────
  // Student-created formats live in the same content_formats table with
  // a non-null user_id. slug is auto-derived from the name (kebab-case,
  // uniqueness scoped per user); Julia's built-ins have their own slug
  // namespace via user_id IS NULL.

  createCustomFormat(userId, name, emoji, description) {
    const clean = String(name || '').trim();
    if (!clean) throw new Error('Format name required');
    // Slug — kebab-case, alnum only, uniquified per user by appending a
    // short suffix if a collision exists. Not shown in UI; used only if
    // we later add /summer/format/custom/:slug pages.
    const base = clean.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '') || 'custom';
    let slug = base;
    let n = 2;
    while (db.prepare('SELECT id FROM content_formats WHERE user_id = ? AND slug = ?').get(userId, slug)) {
      slug = base + '-' + n++;
    }
    // New rows go to the end of the user's list by default (position >
    // any existing user format).
    const maxPos = db.prepare(
      'SELECT COALESCE(MAX(position), 0) AS m FROM content_formats WHERE user_id = ?'
    ).get(userId).m;
    return db.prepare(`
      INSERT INTO content_formats
        (user_id, slug, name, emoji, description, position)
      VALUES (?, ?, ?, ?, ?, ?)
    `).run(userId, slug, clean, (emoji || '').trim() || null, (description || '').trim() || null, maxPos + 1).lastInsertRowid;
  },

  updateCustomFormat(formatId, userId, { name, emoji, description }) {
    const clean = String(name || '').trim();
    if (!clean) throw new Error('Format name required');
    return db.prepare(`
      UPDATE content_formats
      SET name = ?, emoji = ?, description = ?
      WHERE id = ? AND user_id = ?
    `).run(clean, (emoji || '').trim() || null, (description || '').trim() || null, formatId, userId).changes;
  },

  // Any references from cutting_makes prevent a hard delete — archiving
  // preserves history. Route decides delete vs archive based on this.
  countMakesForFormat(formatId) {
    return db.prepare('SELECT COUNT(*) AS c FROM cutting_makes WHERE format_id = ?').get(formatId).c;
  },

  deleteCustomFormat(formatId, userId) {
    return db.prepare(
      'DELETE FROM content_formats WHERE id = ? AND user_id = ?'
    ).run(formatId, userId).changes;
  },
  archiveCustomFormat(formatId, userId) {
    return db.prepare(
      'UPDATE content_formats SET archived = 1 WHERE id = ? AND user_id = ?'
    ).run(formatId, userId).changes;
  },
  unarchiveCustomFormat(formatId, userId) {
    return db.prepare(
      'UPDATE content_formats SET archived = 0 WHERE id = ? AND user_id = ?'
    ).run(formatId, userId).changes;
  },

  // All custom formats for a user, both live and archived. Used by
  // /summer/formats management page. Ordered by position then id.
  getAllCustomFormats(userId) {
    return db.prepare(`
      SELECT id, user_id, slug, name, emoji, description, position, archived
      FROM content_formats
      WHERE user_id = ?
      ORDER BY archived ASC, position ASC, id ASC
    `).all(userId);
  },

  // All makes for a user, joined with the format they used. Ordered
  // newest-first. The /summer view groups these by cutting_id in JS so
  // each Cultivate entry can render "already made as ..." chips inline.
  getMakesForUser(userId) {
    return db.prepare(`
      SELECT m.id, m.cutting_id, m.format_id, m.made_at, m.note, m.published_url,
             m.created,
             f.slug  AS format_slug,
             f.name  AS format_name,
             f.emoji AS format_emoji
      FROM cutting_makes m
      JOIN content_formats f ON f.id = m.format_id
      WHERE m.user_id = ?
      ORDER BY m.made_at DESC, m.id DESC
    `).all(userId);
  },

  // Sanity check used by the /summer/make route: does this cutting exist,
  // belong to this user, AND have Cultivate as its current category? Only
  // Cultivate cuttings are eligible to be "made" — Sit-with and Compost
  // cuttings are ineligible. Returns the cutting id on success, null
  // otherwise. Uses the same "latest curation wins" rule as everywhere.
  isCuttingCultivateForUser(cuttingId, userId) {
    const row = db.prepare(`
      SELECT c.id
      FROM cuttings c
      JOIN (
        SELECT cc1.cutting_id, cc1.category
        FROM cutting_curations cc1
        WHERE cc1.id = (
          SELECT cc2.id FROM cutting_curations cc2
          WHERE cc2.cutting_id = cc1.cutting_id
          ORDER BY cc2.curated_at DESC, cc2.id DESC
          LIMIT 1
        )
      ) latest ON latest.cutting_id = c.id
      WHERE c.id = ? AND c.user_id = ? AND latest.category = 'keep_growing'
    `).get(cuttingId, userId);
    return row ? row.id : null;
  },

  // Insert a fresh format-idea row. `created` defaults to false (an idea);
  // pass true to mark it as already made at insert time. `note` and
  // `publishedUrl` remain optional. Never overwrites — each add is its
  // own row so a student's history is preserved.
  recordCuttingMake(cuttingId, userId, formatId, note, publishedUrl, created) {
    return db.prepare(`
      INSERT INTO cutting_makes
        (cutting_id, user_id, format_id, note, published_url, created)
      VALUES (?, ?, ?, ?, ?, ?)
    `).run(
      cuttingId, userId, formatId,
      (note || '').trim() || null,
      (publishedUrl || '').trim() || null,
      created ? 1 : 0,
    ).lastInsertRowid;
  },

  // Flip the created flag on an existing make. Ownership scoped via the
  // WHERE clause so a student can only touch their own rows.
  setCuttingMakeCreated(makeId, userId, created) {
    return db.prepare(
      'UPDATE cutting_makes SET created = ? WHERE id = ? AND user_id = ?'
    ).run(created ? 1 : 0, makeId, userId).changes;
  },

  // Hard delete a make. Ideas are cheap and disposable — no archive
  // step for now. Ownership scoped via the WHERE clause. Also cascades
  // to any published-links rows so the make + its links vanish together.
  deleteCuttingMake(makeId, userId) {
    db.prepare('DELETE FROM cutting_make_links WHERE make_id = ? AND user_id = ?').run(makeId, userId);
    return db.prepare(
      'DELETE FROM cutting_makes WHERE id = ? AND user_id = ?'
    ).run(makeId, userId).changes;
  },

  // Flip the just_for_me flag on a make. When 1, the /grove entry hides
  // its link-add UI ("this one is just for you").
  setCuttingMakeJustForMe(makeId, userId, value) {
    return db.prepare(
      'UPDATE cutting_makes SET just_for_me = ? WHERE id = ? AND user_id = ?'
    ).run(value ? 1 : 0, makeId, userId).changes;
  },

  // Flip the cohort-shared flag on a make and optionally set the Discord
  // message URL. Passing shared=false clears the timestamp and URL.
  // Ownership scoped via the WHERE clause. Returns rows changed.
  setCuttingMakeCohortShare(makeId, userId, shared, discordUrl) {
    if (shared) {
      const cleanUrl = (discordUrl || '').trim() || null;
      return db.prepare(
        "UPDATE cutting_makes " +
        "SET cohort_shared = 1, " +
        "    cohort_shared_at = CURRENT_TIMESTAMP, " +
        "    discord_url = ? " +
        "WHERE id = ? AND user_id = ?"
      ).run(cleanUrl, makeId, userId).changes;
    }
    return db.prepare(
      "UPDATE cutting_makes " +
      "SET cohort_shared = 0, " +
      "    cohort_shared_at = NULL, " +
      "    discord_url = NULL " +
      "WHERE id = ? AND user_id = ?"
    ).run(makeId, userId).changes;
  },

  // Assign a stem variant to a make, but only if it doesn't have one yet.
  // Called from POST /grove/link/:makeId so the first link on a creation
  // "blooms" the bouquet with a random flower; subsequent links leave the
  // stem alone. Returns 1 if a variant was newly written, 0 if the make
  // already had one (or doesn't belong to this user).
  setCuttingMakeStemVariantIfNull(makeId, userId, variant) {
    return db.prepare(
      'UPDATE cutting_makes SET stem_variant = ? WHERE id = ? AND user_id = ? AND stem_variant IS NULL'
    ).run(variant, makeId, userId).changes;
  },

  // Write the per-entry share reflection ("what was it like to share
  // this?"). One note per make. Empty string clears the note.
  setCuttingMakeShareNote(makeId, userId, note) {
    const clean = (note || '').trim() || null;
    return db.prepare(
      'UPDATE cutting_makes SET share_note = ? WHERE id = ? AND user_id = ?'
    ).run(clean, makeId, userId).changes;
  },

  // ── Published links (Fall) ─────────────────────────────────────────────
  // A single make can hold many published links (multiple platforms).
  // Ownership scoped in every helper.
  createCuttingMakeLink(makeId, userId, url, label, note) {
    const clean = String(url || '').trim();
    if (!clean) throw new Error('URL required');
    // Ownership gate — an INSERT has no WHERE clause to scope, so verify
    // the make belongs to this user before writing.
    const owned = db.prepare(
      'SELECT 1 FROM cutting_makes WHERE id = ? AND user_id = ?'
    ).get(makeId, userId);
    if (!owned) {
      const err = new Error('Make not found for this user');
      err.code = 'NOT_OWNED';
      throw err;
    }
    return db.prepare(`
      INSERT INTO cutting_make_links (make_id, user_id, url, label, note)
      VALUES (?, ?, ?, ?, ?)
    `).run(
      makeId, userId, clean,
      (label || '').trim() || null,
      (note  || '').trim() || null,
    ).lastInsertRowid;
  },
  deleteCuttingMakeLink(linkId, userId) {
    return db.prepare(
      'DELETE FROM cutting_make_links WHERE id = ? AND user_id = ?'
    ).run(linkId, userId).changes;
  },
  // All links for a user, joined onto a { make_id → [links] } shape by
  // the /grove route so each entry can render its own list without an
  // extra round-trip per make.
  getMakeLinksForUser(userId) {
    return db.prepare(`
      SELECT id, make_id, url, label, note, posted_at
      FROM cutting_make_links
      WHERE user_id = ?
      ORDER BY posted_at ASC, id ASC
    `).all(userId);
  },

  // Rollup counts for the destination summary displayed on /tending
  // ("since you started: N growing / M returning / K archived"). Uses the
  // latest curation per cutting so cuttings that moved between categories
  // count only in their current bucket.
  getTendingDestinationCounts(userId) {
    const rows = db.prepare(`
      SELECT latest.category AS category, COUNT(*) AS n
      FROM (
        SELECT cc1.cutting_id, cc1.category
        FROM cutting_curations cc1
        WHERE cc1.user_id = ?
          AND cc1.id = (
            SELECT cc2.id FROM cutting_curations cc2
            WHERE cc2.cutting_id = cc1.cutting_id
            ORDER BY cc2.curated_at DESC, cc2.id DESC
            LIMIT 1
          )
      ) latest
      GROUP BY latest.category
    `).all(userId);
    const counts = { keep_growing: 0, return_later: 0, archive: 0, just_for_me: 0 };
    for (const r of rows) counts[r.category] = r.n;
    return counts;
  },

  // Count-only: for each user, how many DISTINCT days within [startDate,
  // endDate] did they log at least one cutting? Returns a Map keyed by
  // user_id, value = day count (1..7 for a week-sized range). Used by the
  // Community page to render N camera icons per card — no cutting text
  // ever leaves the DB layer. Uses recorded_date (the day-it-happened) so
  // a backdated cutting counts in its real week. Users with zero days
  // simply don't appear in the Map (route treats missing as 0).
  getCuttingDayCountsByUser(startDate, endDate) {
    const rows = db.prepare(
      `SELECT user_id, COUNT(DISTINCT recorded_date) AS days
       FROM cuttings WHERE recorded_date BETWEEN ? AND ?
       GROUP BY user_id`
    ).all(startDate, endDate);
    return new Map(rows.map(r => [r.user_id, r.days]));
  },

  // Admin "who needs tending" overview: for every user who has ever recorded,
  // their most recent recorded_date (overall) plus a count of recordings made
  // inside the given window (inclusive). Sibling of getCuttingDayCountsByUser,
  // but counts rows (each cutting) rather than distinct days, and always
  // surfaces the last-ever date so the admin can spot who's gone quiet.
  // Users with zero cuttings simply don't appear in the Map (route treats
  // missing as never-recorded).
  getRecordingActivityByUser(windowStart, windowEnd) {
    const lastRows = db.prepare(
      `SELECT user_id, MAX(recorded_date) AS last_date
       FROM cuttings GROUP BY user_id`
    ).all();
    const countRows = db.prepare(
      `SELECT user_id, COUNT(*) AS cnt
       FROM cuttings WHERE recorded_date BETWEEN ? AND ?
       GROUP BY user_id`
    ).all(windowStart, windowEnd);
    const map = new Map();
    for (const r of lastRows) {
      map.set(r.user_id, { lastRecordedDate: r.last_date, recentCount: 0 });
    }
    for (const r of countRows) {
      const e = map.get(r.user_id) || { lastRecordedDate: null, recentCount: 0 };
      e.recentCount = r.cnt;
      map.set(r.user_id, e);
    }
    return map;
  },

  getUserTimezone(userId) {
    const row = db.prepare('SELECT timezone FROM users WHERE id = ?').get(userId);
    return row ? row.timezone : null;
  },

  setUserTimezone(userId, tz) {
    return db.prepare('UPDATE users SET timezone = ? WHERE id = ?').run(tz, userId);
  },

  getAllStudentAssessmentStatus() {
    return db.prepare(`
      SELECT u.id, u.name, u.avatar_initial, u.role,
        (SELECT completed_at FROM self_assessments WHERE user_id=u.id AND assessment_type='opening') as opening_at,
        (SELECT completed_at FROM self_assessments WHERE user_id=u.id AND assessment_type='midcourse') as midcourse_at,
        (SELECT completed_at FROM self_assessments WHERE user_id=u.id AND assessment_type='closing') as closing_at,
        (SELECT COUNT(*) FROM goals WHERE user_id=u.id AND (feeling!='' OR looks_like!='')) as goals_count
      FROM users u
      WHERE u.role = 'student'
      ORDER BY u.name ASC
    `).all();
  },

  getStudentFullData(userId) {
    const user = db.prepare(
      'SELECT id, name, email, avatar_initial, midcourse_submitted_at, course_length_weeks FROM users WHERE id=?'
    ).get(userId);
    const opening = db.prepare(
      "SELECT * FROM self_assessments WHERE user_id=? AND assessment_type='opening'"
    ).get(userId);
    const closing = db.prepare(
      "SELECT * FROM self_assessments WHERE user_id=? AND assessment_type='closing'"
    ).get(userId);
    const trialClosing = db.prepare(
      "SELECT * FROM self_assessments WHERE user_id=? AND assessment_type='trial_closing'"
    ).get(userId);
    const goals    = db.prepare('SELECT * FROM goals WHERE user_id=? ORDER BY seed_number').all(userId);

    // Reach for the existing seed-packet + cuttings helpers so this method
    // stays a thin aggregator — no duplicated SQL.
    const seedPacketAnswers = this.getSeedPacketAnswersByUser(userId);
    const seedPacketSeeds   = this.getSeedPacketSeeds(userId);
    const cuttings          = this.getCuttingsForUserChronological(userId);

    // Mid-course content is structurally anonymous (no user_id link). The
    // only per-student fact available is "have they submitted?", which lives
    // on users.midcourse_submitted_at. Surface just that — the dialog turns
    // it into a "✓ Submitted on DATE" line.
    return {
      user, opening, closing, trialClosing, goals,
      midcourseSubmittedAt: user ? user.midcourse_submitted_at : null,
      courseLengthWeeks:    user ? (user.course_length_weeks || 12) : 12,
      seedPacketAnswers, seedPacketSeeds, cuttings,
    };
  },

  // ─── Seed Packets ──────────────────────────────────────────────────────────

  getSeedPacketAnswer(userId, questionId) {
    return db.prepare(
      'SELECT * FROM seed_packet_answers WHERE user_id = ? AND question_id = ?'
    ).get(userId, questionId) || null;
  },

  getSeedPacketAnswersByUser(userId) {
    return db.prepare(
      'SELECT * FROM seed_packet_answers WHERE user_id = ? ORDER BY question_id ASC'
    ).all(userId);
  },

  upsertSeedPacketAnswer(userId, questionId, text) {
    return db.prepare(`
      INSERT INTO seed_packet_answers (user_id, question_id, answer_text)
      VALUES (?, ?, ?)
      ON CONFLICT(user_id, question_id) DO UPDATE SET
        answer_text = excluded.answer_text,
        updated_at  = CURRENT_TIMESTAMP
    `).run(userId, questionId, text);
  },

  getSeedPacketAnswerCounts(userId) {
    const prefixMap = { r: 'remembering', n: 'noticing', a: 'allowing', i: 'imagining', k: 'knowing' };
    const rows = db.prepare(`
      SELECT SUBSTR(question_id, 1, 1) as prefix, COUNT(*) as count
      FROM seed_packet_answers WHERE user_id = ? GROUP BY prefix
    `).all(userId);
    const counts = { remembering: 0, noticing: 0, allowing: 0, imagining: 0, knowing: 0 };
    for (const row of rows) {
      const angleId = prefixMap[row.prefix];
      if (angleId) counts[angleId] = row.count;
    }
    return counts;
  },

  getSeedPacketTotalAnswered(userId) {
    return db.prepare(
      'SELECT COUNT(*) as c FROM seed_packet_answers WHERE user_id = ?'
    ).get(userId).c;
  },

  // ─── Password reset tokens ─────────────────────────────────────────────────

  createPasswordResetToken(userId, token, expiresAt) {
    return db.prepare(
      'INSERT INTO password_reset_tokens (user_id, token, expires_at) VALUES (?, ?, ?)'
    ).run(userId, token, expiresAt);
  },

  findValidPasswordResetToken(token) {
    return db.prepare(`
      SELECT * FROM password_reset_tokens
      WHERE token = ?
        AND expires_at > datetime('now')
        AND used_at IS NULL
    `).get(token) || null;
  },

  markPasswordResetTokenUsed(tokenId) {
    return db.prepare(
      "UPDATE password_reset_tokens SET used_at = datetime('now') WHERE id = ?"
    ).run(tokenId);
  },

  deleteExpiredPasswordResetTokens() {
    return db.prepare(
      "DELETE FROM password_reset_tokens WHERE expires_at < datetime('now')"
    ).run();
  },

  // Invalidate every outstanding reset link for one user — called when an admin
  // sets a temporary password, so a previously-emailed link can't be replayed
  // after the intervention.
  deletePasswordResetTokensForUser(userId) {
    return db.prepare(
      'DELETE FROM password_reset_tokens WHERE user_id = ?'
    ).run(userId);
  },

  // ─── Seed Packet highlights ─────────────────────────────────────────────────

  getSeedPacketHighlights(userId) {
    return db.prepare(
      'SELECT * FROM seed_packet_highlights WHERE user_id = ? ORDER BY created_at ASC'
    ).all(userId);
  },

  addSeedPacketHighlight(userId, questionId, highlightedText) {
    return db.prepare(
      'INSERT INTO seed_packet_highlights (user_id, question_id, highlighted_text) VALUES (?, ?, ?)'
    ).run(userId, questionId, highlightedText);
  },

  removeSeedPacketHighlight(highlightId, userId) {
    return db.prepare(
      'DELETE FROM seed_packet_highlights WHERE id = ? AND user_id = ?'
    ).run(highlightId, userId);
  },

  // ─── Seed Packet threads ────────────────────────────────────────────────────

  getSeedPacketThreads(userId) {
    const rows = db.prepare(
      'SELECT * FROM seed_packet_threads WHERE user_id = ? ORDER BY sort_order ASC'
    ).all(userId);
    return rows.map(r => ({ ...r, bullets: safeParseArray(r.bullets) }));
  },

  createSeedPacketThread(userId, name, description, bullets, sortOrder) {
    const bulletsJson = JSON.stringify(Array.isArray(bullets) ? bullets : []);
    const result = db.prepare(
      'INSERT INTO seed_packet_threads (user_id, name, description, bullets, sort_order) VALUES (?, ?, ?, ?, ?)'
    ).run(userId, name, description || '', bulletsJson, sortOrder || 0);
    const row = db.prepare('SELECT * FROM seed_packet_threads WHERE id = ?').get(result.lastInsertRowid);
    return { ...row, bullets: safeParseArray(row.bullets) };
  },

  updateSeedPacketThread(threadId, userId, name, description, bullets, sortOrder) {
    const bulletsJson = JSON.stringify(Array.isArray(bullets) ? bullets : []);
    return db.prepare(`
      UPDATE seed_packet_threads
      SET name = ?, description = ?, bullets = ?, sort_order = ?, updated_at = CURRENT_TIMESTAMP
      WHERE id = ? AND user_id = ?
    `).run(name, description || '', bulletsJson, sortOrder || 0, threadId, userId);
  },

  deleteSeedPacketThread(threadId, userId) {
    return db.prepare(
      'DELETE FROM seed_packet_threads WHERE id = ? AND user_id = ?'
    ).run(threadId, userId);
  },

  // ─── Seed Packet seeds ──────────────────────────────────────────────────────

  getSeedPacketSeeds(userId) {
    const rows = db.prepare(
      'SELECT * FROM seed_packet_seeds WHERE user_id = ? ORDER BY sort_order ASC, id ASC'
    ).all(userId);
    return rows.map(r => ({ ...r, bullets: safeParseArray(r.bullets) }));
  },

  getSeedPacketSeedsCount(userId) {
    return db.prepare(
      'SELECT COUNT(*) as c FROM seed_packet_seeds WHERE user_id = ?'
    ).get(userId).c;
  },

  createSeedPacketSeed(userId, name, description, bullets, sortOrder, application) {
    const bulletsJson = JSON.stringify(Array.isArray(bullets) ? bullets : []);
    const result = db.prepare(
      'INSERT INTO seed_packet_seeds (user_id, name, description, bullets, sort_order, application) VALUES (?, ?, ?, ?, ?, ?)'
    ).run(userId, name, description || '', bulletsJson, sortOrder || 0, application || '');
    const row = db.prepare('SELECT * FROM seed_packet_seeds WHERE id = ?').get(result.lastInsertRowid);
    return { ...row, bullets: safeParseArray(row.bullets) };
  },

  updateSeedPacketSeed(seedId, userId, name, description, bullets, sortOrder, application) {
    const bulletsJson = JSON.stringify(Array.isArray(bullets) ? bullets : []);
    return db.prepare(`
      UPDATE seed_packet_seeds
      SET name = ?, description = ?, bullets = ?, sort_order = ?, application = ?, updated_at = CURRENT_TIMESTAMP
      WHERE id = ? AND user_id = ?
    `).run(name, description || '', bulletsJson, sortOrder || 0, application || '', seedId, userId);
  },

  deleteSeedPacketSeed(seedId, userId) {
    return db.prepare(
      'DELETE FROM seed_packet_seeds WHERE id = ? AND user_id = ?'
    ).run(seedId, userId);
  },

  // ─── Seed Packet synthesis state ───────────────────────────────────────────

  getSeedPacketSynthesisState(userId) {
    return db.prepare(
      'SELECT * FROM seed_packet_synthesis_state WHERE user_id = ?'
    ).get(userId) || {
      user_id: userId,
      has_seen_observations: 0,
      last_observations: null,
      last_observations_at: null,
      has_completed_synthesis: 0,
    };
  },

  upsertSeedPacketSynthesisState(userId, partial) {
    db.prepare(
      'INSERT OR IGNORE INTO seed_packet_synthesis_state (user_id) VALUES (?)'
    ).run(userId);
    const fields = Object.keys(partial).map(k => `${k} = ?`).join(', ');
    if (!fields) return;
    db.prepare(
      `UPDATE seed_packet_synthesis_state SET ${fields} WHERE user_id = ?`
    ).run(...Object.values(partial), userId);
  },

  // ─── Web Push subscriptions ────────────────────────────────────────────────

  // Insert a new subscription, or refresh ownership+timestamps if the same
  // endpoint already exists. UPSERT on endpoint covers the common case where
  // a user re-subscribes from the same install — keys may rotate, ownership
  // may change (rare, but if a different account installs on the same
  // browser, the subscription should now belong to that user).
  upsertPushSubscription({ userId, endpoint, p256dh, auth, userAgent }) {
    db.prepare(`
      INSERT INTO push_subscriptions (user_id, endpoint, p256dh, auth, user_agent)
      VALUES (?, ?, ?, ?, ?)
      ON CONFLICT(endpoint) DO UPDATE SET
        user_id      = excluded.user_id,
        p256dh       = excluded.p256dh,
        auth         = excluded.auth,
        user_agent   = excluded.user_agent,
        last_seen_at = CURRENT_TIMESTAMP
    `).run(userId, endpoint, p256dh, auth, userAgent || null);
  },

  // Used by /api/push/unsubscribe and by the send-helper to prune dead
  // subscriptions when the push service returns 404/410.
  deletePushSubscriptionByEndpoint(endpoint) {
    return db.prepare(
      'DELETE FROM push_subscriptions WHERE endpoint = ?'
    ).run(endpoint);
  },

  getPushSubscriptionsForUser(userId) {
    return db.prepare(
      'SELECT id, endpoint, p256dh, auth, user_agent, created_at FROM push_subscriptions WHERE user_id = ?'
    ).all(userId);
  },

  countPushSubscriptionsForUser(userId) {
    return db.prepare(
      'SELECT COUNT(*) AS c FROM push_subscriptions WHERE user_id = ?'
    ).get(userId).c;
  },

  // ─── Daily reminder preferences ───────────────────────────────────────────

  setDailyReminderEnabled(userId, enabled) {
    return db.prepare(
      'UPDATE users SET daily_reminder_enabled = ? WHERE id = ?'
    ).run(enabled ? 1 : 0, userId);
  },

  setDailyReminderHour(userId, hour) {
    const h = Math.max(0, Math.min(23, parseInt(hour, 10) || 0));
    return db.prepare(
      'UPDATE users SET daily_reminder_hour = ? WHERE id = ?'
    ).run(h, userId);
  },

  // Used by the cron in commit 4 — return every user whose toggle is on,
  // along with their preferred hour and timezone (so the sender can decide
  // "is it 8 AM in their timezone right now?").
  getUsersWithDailyReminderEnabled() {
    return db.prepare(
      'SELECT id, name, email, timezone, daily_reminder_hour, reminder_email_enabled FROM users WHERE daily_reminder_enabled = 1'
    ).all();
  },

  // ─── Weekly reminder preferences (Monday "set your intentions" nudge) ──────

  setWeeklyReminderEnabled(userId, enabled) {
    return db.prepare(
      'UPDATE users SET weekly_reminder_enabled = ? WHERE id = ?'
    ).run(enabled ? 1 : 0, userId);
  },

  setWeeklyReminderHour(userId, hour) {
    const h = Math.max(0, Math.min(23, parseInt(hour, 10) || 0));
    return db.prepare(
      'UPDATE users SET weekly_reminder_hour = ? WHERE id = ?'
    ).run(h, userId);
  },

  getUsersWithWeeklyReminderEnabled() {
    return db.prepare(
      'SELECT id, name, email, timezone, weekly_reminder_hour, weekly_reminder_email FROM users WHERE weekly_reminder_enabled = 1'
    ).all();
  },

  // ─── Dashboard quotes ─────────────────────────────────────────────────────

  // The pool that getRotatingQuote rotates through for a given user.
  // Includes: quotes tagged with the user's current_season + untagged
  // "any season" quotes. If the user hasn't picked a season, returns only
  // the untagged pool so they still see something.
  getQuotesForUser(user) {
    const season = user && user.current_season;
    if (season) {
      return db.prepare(
        'SELECT id, text, source, season FROM quotes WHERE season = ? OR season IS NULL ORDER BY id ASC'
      ).all(season);
    }
    return db.prepare(
      'SELECT id, text, source, season FROM quotes WHERE season IS NULL ORDER BY id ASC'
    ).all();
  },

  // Full list for the admin Quotes UI. NULL-season ("any") first, then per
  // season alphabetically — keeps the admin table organized.
  getAllQuotes() {
    return db.prepare(
      'SELECT id, text, source, season, created_at, updated_at FROM quotes ' +
      'ORDER BY CASE WHEN season IS NULL THEN 0 ELSE 1 END, season ASC, id ASC'
    ).all();
  },

  createQuote(text, source, season) {
    const s = ['spring','summer','autumn','winter'].includes(season) ? season : null;
    return db.prepare(
      'INSERT INTO quotes (text, source, season) VALUES (?, ?, ?)'
    ).run((text || '').trim(), (source || '').trim(), s);
  },

  updateQuote(id, text, source, season) {
    const s = ['spring','summer','autumn','winter'].includes(season) ? season : null;
    return db.prepare(
      'UPDATE quotes SET text = ?, source = ?, season = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?'
    ).run((text || '').trim(), (source || '').trim(), s, id);
  },

  deleteQuote(id) {
    return db.prepare('DELETE FROM quotes WHERE id = ?').run(id);
  },

  // ─── Stripe events (webhook idempotency) ──────────────────────────────────

  // INSERT OR IGNORE returns changes>0 only if the event is new. Callers use
  // that as "should I process this event now" — if the row already exists,
  // we've already handled it and the webhook should ack without acting again.
  tryClaimStripeEvent(eventId, eventType) {
    const r = db.prepare(
      'INSERT OR IGNORE INTO stripe_events (id, type) VALUES (?, ?)'
    ).run(eventId, eventType);
    return r.changes > 0;
  },

  // ─── Backups ───────────────────────────────────────────────────────────────

  // Full-database snapshot via VACUUM INTO — safe to run on a live WAL-mode
  // database (SQLite takes a consistent read snapshot; no lock on writers)
  // and the output is a compact, self-contained .db file. Snapshots land in
  // <data-dir>/backups (on Railway: /data/backups, on the persistent
  // volume); the newest `keep` are retained, older ones pruned. Returns
  // { path, filename, bytes } for the caller to stream or report.
  createBackupSnapshot(keep = 7) {
    const backupDir = path.join(dataDir, 'backups');
    if (!fs.existsSync(backupDir)) fs.mkdirSync(backupDir, { recursive: true });

    const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
    const filename = `creative-rhythm-${stamp}.db`;
    const target = path.join(backupDir, filename);
    // VACUUM INTO refuses to overwrite; the second-resolution stamp is
    // unique enough, but clear a collision just in case (manual + cron
    // firing in the same second).
    if (fs.existsSync(target)) fs.unlinkSync(target);

    // Path is server-built (timestamp only), but single-quote-escape anyway
    // since VACUUM INTO can't take a bound parameter.
    db.exec(`VACUUM INTO '${target.replace(/'/g, "''")}'`);

    // Prune: newest `keep` stay, the rest go.
    const existing = fs.readdirSync(backupDir)
      .filter(f => f.startsWith('creative-rhythm-') && f.endsWith('.db'))
      .sort()
      .reverse();
    for (const old of existing.slice(keep)) {
      try { fs.unlinkSync(path.join(backupDir, old)); } catch (_) {}
    }

    return { path: target, filename, bytes: fs.statSync(target).size };
  },
};
