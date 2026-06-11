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
  if (!userCols.includes('profile_photo')) {
    db.exec("ALTER TABLE users ADD COLUMN profile_photo TEXT");
    console.log('✓ Migrated: added profile_photo column');
  }
  if (!userCols.includes('timezone')) {
    db.exec("ALTER TABLE users ADD COLUMN timezone TEXT DEFAULT 'America/Denver'");
    console.log('✓ Migrated: added timezone column');
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

  const ins = db.prepare('INSERT INTO users (name, email, password_hash, role, avatar_initial) VALUES (?, ?, ?, ?, ?)');
  for (const a of students) {
    const hash = bcrypt.hashSync(a.password, 12);
    ins.run(a.name, a.email, hash, 'student', a.initial);
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
    <p>Reach outward. Collaborations, residencies, community, relationships.</p>
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
safeInit('syncAdminAccount',    syncAdminAccount);
safeInit('seedDefaultAccounts', seedDefaultAccounts);
safeInit('seedLessons',             seedLessons);
safeInit('seedCourseIntroduction',  seedCourseIntroduction);
safeInit('seedLesson1Homework',     seedLesson1Homework);

module.exports = {
  getUserByEmail(email) {
    return db.prepare('SELECT * FROM users WHERE email = ?').get(email);
  },

  getUserById(id) {
    return db.prepare('SELECT id, name, email, role, avatar_initial, current_season, profile_photo FROM users WHERE id = ?').get(id);
  },

  hasVisitedGreenhouse(userId) {
    const row = db.prepare('SELECT has_visited_greenhouse FROM users WHERE id = ?').get(userId);
    return !!(row && row.has_visited_greenhouse);
  },

  markGreenhouseVisited(userId) {
    db.prepare('UPDATE users SET has_visited_greenhouse = 1 WHERE id = ?').run(userId);
  },

  getAllUsers() {
    return db.prepare('SELECT id, name, email, role, avatar_initial, current_season, profile_photo, community_goals_public, community_season_public, created_at FROM users ORDER BY role DESC, name ASC').all();
  },

  getUserFullProfile(id) {
    return db.prepare('SELECT id, name, email, role, avatar_initial, current_season, profile_photo, timezone, notify_new_fieldnotes, notify_community, notify_weekly_reminder, community_goals_public, community_season_public FROM users WHERE id = ?').get(id);
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
    const allowed = ['notify_new_fieldnotes','notify_community','notify_weekly_reminder','community_goals_public','community_season_public'];
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

  setIntegrationWeek(userId, weekStart, isIntegration) {
    const categories = ['curiosity', 'create', 'share', 'connect'];
    for (const cat of categories) {
      db.prepare(`
        INSERT INTO weekly_goals (user_id, week_start, category, is_integration_week)
        VALUES (?, ?, ?, ?)
        ON CONFLICT(user_id, week_start, category) DO UPDATE SET
          is_integration_week = excluded.is_integration_week,
          updated_at = CURRENT_TIMESTAMP
      `).run(userId, weekStart, cat, isIntegration ? 1 : 0);
    }
  },

  getWeekHistory(userId, limit = 10) {
    return db.prepare(`
      SELECT DISTINCT week_start FROM weekly_goals
      WHERE user_id = ?
      ORDER BY week_start DESC
      LIMIT ?
    `).all(userId, limit).map(r => r.week_start);
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
    db.prepare('DELETE FROM community_reactions WHERE user_id=?').run(id);
    db.prepare('DELETE FROM community_posts WHERE user_id=?').run(id);
    db.prepare('DELETE FROM lesson_completions WHERE user_id=?').run(id);
    db.prepare('DELETE FROM weekly_goals WHERE user_id=?').run(id);
    db.prepare('DELETE FROM goals WHERE user_id=?').run(id);
    db.prepare('DELETE FROM self_assessments WHERE user_id=?').run(id);
    return db.prepare('DELETE FROM users WHERE id=?').run(id);
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

  getAllGoalsForAdmin() {
    return db.prepare(`
      SELECT s.id, s.user_id, s.seed_number,
             s.feeling, s.looks_like,
             s.soil, s.seed, s.water, s.bloom,
             s.created_at, s.is_active, u.email
      FROM goals s
      JOIN users u ON s.user_id = u.id
      ORDER BY u.name ASC, s.seed_number ASC, s.id ASC
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

  updateGoalCreatedAt(seedId, dateStr) {
    return db.prepare("UPDATE goals SET created_at = ? WHERE id = ?").run(dateStr + ' 00:00:00', seedId);
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
    `).run(userId, type,
      q1_choice || '', q2_rating || null, q3_choice || '', q4_rating || null,
      q5_choice || '', q6_rating || null, q7_choices || '', q8_choice || '',
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
  // vestigial legacy column.
  createCutting(userId, season, prompt, fields, recordedDate) {
    return db.prepare(`
      INSERT INTO cuttings
        (user_id, season, prompt, recorded_date,
         reflection_text, talked_about, how_it_felt, takeaway)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      userId,
      season || null,
      prompt || null,
      recordedDate || null,
      fields.reflection_text || null,
      fields.talked_about    || null,
      fields.how_it_felt     || null,
      fields.takeaway        || null
    );
  },

  // Read-only: all cuttings for a user. Ordered by recorded_date DESC
  // (newest day first across days) then created_at ASC (within a day,
  // earliest-written first — morning entry above evening entry).
  getCuttingsForUser(userId) {
    return db.prepare(
      `SELECT id, created_at, recorded_date, season, prompt,
              reflection_text, talked_about, how_it_felt, takeaway
       FROM cuttings WHERE user_id = ?
       ORDER BY recorded_date DESC, created_at ASC`
    ).all(userId);
  },

  // Chronological — for the PDF export, which tells a forward-moving
  // story. Within a day: earliest-written-first (same rule as the archive).
  getCuttingsForUserChronological(userId) {
    return db.prepare(
      `SELECT id, created_at, recorded_date, season, prompt,
              reflection_text, talked_about, how_it_felt, takeaway
       FROM cuttings WHERE user_id = ?
       ORDER BY recorded_date ASC, created_at ASC`
    ).all(userId);
  },

  // All cuttings for a single day — for the Dashboard day-view. Multiple
  // entries per day allowed (no uniqueness constraint); within the day
  // they're ordered earliest-written-first.
  getCuttingsForUserOnDate(userId, recordedDate) {
    return db.prepare(
      `SELECT id, created_at, recorded_date, season, prompt,
              reflection_text, talked_about, how_it_felt, takeaway
       FROM cuttings WHERE user_id = ? AND recorded_date = ?
       ORDER BY created_at ASC`
    ).all(userId, recordedDate);
  },

  // Presence-only: which users have at least one cutting whose recorded_date
  // falls in [startDate, endDate]? Returns a Set of user_ids. Used by the
  // Community page to surface a single "recorded this week" boolean per
  // user — no cutting text leaves the DB layer, ever. Uses recorded_date
  // (the day-it-happened) so a backdated cutting counts in its real week.
  getUserIdsWithCuttingInRange(startDate, endDate) {
    const rows = db.prepare(
      `SELECT DISTINCT user_id FROM cuttings
       WHERE recorded_date BETWEEN ? AND ?`
    ).all(startDate, endDate);
    return new Set(rows.map(r => r.user_id));
  },

  // Recording memory: a single overwritable YYYY-MM-DD per user.
  // Not a streak, not a count, not a history — one column, set & forget.
  markRecordedToday(userId, dateStr) {
    return db.prepare(
      'UPDATE users SET last_recorded_date = ? WHERE id = ?'
    ).run(dateStr, userId);
  },

  getLastRecordedDate(userId) {
    const row = db.prepare(
      'SELECT last_recorded_date FROM users WHERE id = ?'
    ).get(userId);
    return row ? row.last_recorded_date : null;
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
    const user = db.prepare('SELECT id, name, email, avatar_initial FROM users WHERE id=?').get(userId);
    const opening  = db.prepare("SELECT * FROM self_assessments WHERE user_id=? AND assessment_type='opening'").get(userId);
    const midcourse = db.prepare("SELECT * FROM self_assessments WHERE user_id=? AND assessment_type='midcourse'").get(userId);
    const closing  = db.prepare("SELECT * FROM self_assessments WHERE user_id=? AND assessment_type='closing'").get(userId);
    const goals    = db.prepare('SELECT * FROM goals WHERE user_id=? ORDER BY seed_number').all(userId);
    return { user, opening, midcourse, closing, goals };
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
    return rows.map(r => ({ ...r, bullets: JSON.parse(r.bullets || '[]') }));
  },

  createSeedPacketThread(userId, name, description, bullets, sortOrder) {
    const bulletsJson = JSON.stringify(Array.isArray(bullets) ? bullets : []);
    const result = db.prepare(
      'INSERT INTO seed_packet_threads (user_id, name, description, bullets, sort_order) VALUES (?, ?, ?, ?, ?)'
    ).run(userId, name, description || '', bulletsJson, sortOrder || 0);
    const row = db.prepare('SELECT * FROM seed_packet_threads WHERE id = ?').get(result.lastInsertRowid);
    return { ...row, bullets: JSON.parse(row.bullets || '[]') };
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
    return rows.map(r => ({ ...r, bullets: JSON.parse(r.bullets || '[]') }));
  },

  getSeedPacketSeedsCount(userId) {
    return db.prepare(
      'SELECT COUNT(*) as c FROM seed_packet_seeds WHERE user_id = ?'
    ).get(userId).c;
  },

  createSeedPacketSeed(userId, name, description, bullets, sortOrder) {
    const bulletsJson = JSON.stringify(Array.isArray(bullets) ? bullets : []);
    const result = db.prepare(
      'INSERT INTO seed_packet_seeds (user_id, name, description, bullets, sort_order) VALUES (?, ?, ?, ?, ?)'
    ).run(userId, name, description || '', bulletsJson, sortOrder || 0);
    const row = db.prepare('SELECT * FROM seed_packet_seeds WHERE id = ?').get(result.lastInsertRowid);
    return { ...row, bullets: JSON.parse(row.bullets || '[]') };
  },

  updateSeedPacketSeed(seedId, userId, name, description, bullets, sortOrder) {
    const bulletsJson = JSON.stringify(Array.isArray(bullets) ? bullets : []);
    return db.prepare(`
      UPDATE seed_packet_seeds
      SET name = ?, description = ?, bullets = ?, sort_order = ?, updated_at = CURRENT_TIMESTAMP
      WHERE id = ? AND user_id = ?
    `).run(name, description || '', bulletsJson, sortOrder || 0, seedId, userId);
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
};
