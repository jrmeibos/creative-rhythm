require('dotenv').config();
const { DatabaseSync } = require('node:sqlite');
const bcrypt = require('bcryptjs');
const path = require('path');
const fs = require('fs');

const DB_PATH = process.env.DB_PATH || path.join(__dirname, 'data', 'creative-rhythm.db');
const dataDir = path.dirname(DB_PATH);
if (!fs.existsSync(dataDir)) fs.mkdirSync(dataDir, { recursive: true });

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

  CREATE TABLE IF NOT EXISTS seeds (
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

  // Seeds: add legacy tending columns if missing (for tables created before the rebuild)
  const seedCols = db.prepare("PRAGMA table_info(seeds)").all().map(r => r.name);
  if (!seedCols.includes('status')) {
    db.exec("ALTER TABLE seeds ADD COLUMN status TEXT DEFAULT 'active'");
    console.log('✓ Migrated: added status to seeds');
  }
  if (!seedCols.includes('updated_feeling')) {
    db.exec("ALTER TABLE seeds ADD COLUMN updated_feeling TEXT DEFAULT ''");
    console.log('✓ Migrated: added updated_feeling to seeds');
  }
  if (!seedCols.includes('updated_looks_like')) {
    db.exec("ALTER TABLE seeds ADD COLUMN updated_looks_like TEXT DEFAULT ''");
    console.log('✓ Migrated: added updated_looks_like to seeds');
  }

  // Seeds: rebuild to support multi-row replacements (removes UNIQUE constraint)
  const seedCols2 = db.prepare("PRAGMA table_info(seeds)").all().map(r => r.name);
  if (!seedCols2.includes('is_active')) {
    const existingSeeds = db.prepare('SELECT * FROM seeds').all();
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
    db.exec('DROP TABLE seeds');
    db.exec('ALTER TABLE seeds_new RENAME TO seeds');
    console.log('✓ Migrated: rebuilt seeds table with multi-row replacement support');
  }

  // Seeds: add kept_at for "keep growing" persistence
  const seedColsFinal = db.prepare("PRAGMA table_info(seeds)").all().map(r => r.name);
  if (!seedColsFinal.includes('kept_at')) {
    db.exec("ALTER TABLE seeds ADD COLUMN kept_at DATETIME");
    console.log('✓ Migrated: added kept_at to seeds');
  }

  // Default settings for unlock flags
  db.prepare("INSERT OR IGNORE INTO settings (key, value) VALUES ('midcourse_unlocked', 'false')").run();
  db.prepare("INSERT OR IGNORE INTO settings (key, value) VALUES ('harvest_unlocked', 'false')").run();

  // V2: wipe all seeds planted during onboarding — seeds are now planted via Greenhouse after Lesson 1
  const v2SeedsFlag = db.prepare("SELECT value FROM settings WHERE key='seeds_v2_migrated'").get();
  if (!v2SeedsFlag) {
    db.exec('DELETE FROM seeds');
    db.prepare("INSERT OR IGNORE INTO settings (key, value) VALUES ('seeds_v2_migrated', 'true')").run();
    console.log('✓ Migrated: Wiped seed data — V2 model resets all seeds; users will re-plant after Lesson 1');
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

syncAdminAccount();
seedDefaultAccounts();
seedLessons();

module.exports = {
  getUserByEmail(email) {
    return db.prepare('SELECT * FROM users WHERE email = ?').get(email);
  },

  getUserById(id) {
    return db.prepare('SELECT id, name, email, role, avatar_initial, current_season, profile_photo FROM users WHERE id = ?').get(id);
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
      console.log(`[admin-pw-reset] DB UPDATE attempted with password_hash for id=${id}`);
      const result = db.prepare(
        'UPDATE users SET name=?, email=?, role=?, avatar_initial=?, password_hash=? WHERE id=?'
      ).run(name.trim(), email.trim().toLowerCase(), role, initial, hash, id);
      console.log(`[admin-pw-reset] DB UPDATE result: changes=${result.changes}`);
      return result;
    }
    console.log(`[admin-pw-reset] DB UPDATE attempted WITHOUT password for id=${id}`);
    return db.prepare(
      'UPDATE users SET name=?, email=?, role=?, avatar_initial=? WHERE id=?'
    ).run(name.trim(), email.trim().toLowerCase(), role, initial, id);
  },

  deleteUser(id) {
    db.prepare('DELETE FROM community_reactions WHERE user_id=?').run(id);
    db.prepare('DELETE FROM community_posts WHERE user_id=?').run(id);
    db.prepare('DELETE FROM lesson_completions WHERE user_id=?').run(id);
    db.prepare('DELETE FROM weekly_goals WHERE user_id=?').run(id);
    db.prepare('DELETE FROM seeds WHERE user_id=?').run(id);
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

  updateLesson(id, title, subtitle, categoryTag, content, estimatedReadTime) {
    return db.prepare(`
      UPDATE lessons SET title=?, subtitle=?, category_tag=?, content=?, estimated_read_time=? WHERE id=?
    `).run(title, subtitle || '', categoryTag || '', content || '', estimatedReadTime || 5, id);
  },

  deleteLesson(id) {
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

  // ─── Seeds ─────────────────────────────────────────────────────────────────

  getUserSeeds(userId) {
    // Returns the original (non-replacement) seed per seed_number — used by profile route
    return db.prepare(
      'SELECT * FROM seeds WHERE user_id=? AND is_replacement=0 ORDER BY seed_number ASC'
    ).all(userId);
  },

  getGreenhouseSeeds(userId) {
    // Returns { 1: { original, replacement }, 2: ..., 3: ... }
    const all = db.prepare(
      'SELECT * FROM seeds WHERE user_id=? ORDER BY seed_number ASC, id ASC'
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

  upsertSeed(userId, seedNumber, feeling, looksLike) {
    // Find existing original seed and update, or insert new
    const existing = db.prepare(
      'SELECT id FROM seeds WHERE user_id=? AND seed_number=? AND is_replacement=0'
    ).get(userId, seedNumber);
    if (existing) {
      return db.prepare(
        'UPDATE seeds SET feeling=?, looks_like=?, updated_at=CURRENT_TIMESTAMP WHERE id=?'
      ).run(feeling || '', looksLike || '', existing.id);
    }
    return db.prepare(
      'INSERT INTO seeds (user_id, seed_number, feeling, looks_like, is_active, is_replacement) VALUES (?, ?, ?, ?, 1, 0)'
    ).run(userId, seedNumber, feeling || '', looksLike || '');
  },

  replaceSeeds(userId, seedNumber, feeling, looksLike) {
    // Mark current active seed as inactive
    db.prepare(
      'UPDATE seeds SET is_active=0, updated_at=CURRENT_TIMESTAMP WHERE user_id=? AND seed_number=? AND is_active=1'
    ).run(userId, seedNumber);
    // Get original seed id for the replaces_seed_id reference
    const original = db.prepare(
      'SELECT id FROM seeds WHERE user_id=? AND seed_number=? AND is_replacement=0 ORDER BY id ASC LIMIT 1'
    ).get(userId, seedNumber);
    // Insert new active replacement
    return db.prepare(
      'INSERT INTO seeds (user_id, seed_number, feeling, looks_like, is_active, is_replacement, replaces_seed_id) VALUES (?, ?, ?, ?, 1, 1, ?)'
    ).run(userId, seedNumber, feeling || '', looksLike || '', original?.id || null);
  },

  updateSeedById(seedId, userId, feeling, looksLike) {
    return db.prepare(
      'UPDATE seeds SET feeling=?, looks_like=?, updated_at=CURRENT_TIMESTAMP WHERE id=? AND user_id=?'
    ).run(feeling || '', looksLike || '', seedId, userId);
  },

  getSeedById(seedId, userId) {
    return db.prepare('SELECT * FROM seeds WHERE id = ? AND user_id = ?').get(seedId, userId);
  },

  getActiveSeedByNumber(userId, seedNumber) {
    return db.prepare(
      'SELECT * FROM seeds WHERE user_id = ? AND seed_number = ? AND is_active = 1 ORDER BY id DESC LIMIT 1'
    ).get(userId, seedNumber);
  },

  getPlantedSeedCount(userId) {
    return db.prepare(
      'SELECT COUNT(*) as c FROM seeds WHERE user_id = ? AND is_replacement = 0'
    ).get(userId).c;
  },

  getAllUsersSeeds() {
    return db.prepare(`
      SELECT s.*, u.name as user_name, u.avatar_initial
      FROM seeds s
      JOIN users u ON s.user_id = u.id
      WHERE s.is_replacement = 0
      ORDER BY u.name ASC, s.seed_number ASC
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
    `).run(userId, type,
      q1_choice || '', q2_rating || null, q3_choice || '', q4_rating || null,
      q5_choice || '', q6_rating || null, q7_choices || '', q8_choice || '',
      q9_text || '', q10_text || '', q11_text || '', q12_text || '',
      harvest_reflection || '');
  },

  keepSeed(seedId, userId, kept) {
    if (kept) {
      return db.prepare(
        'UPDATE seeds SET kept_at=CURRENT_TIMESTAMP, updated_at=CURRENT_TIMESTAMP WHERE id=? AND user_id=?'
      ).run(seedId, userId);
    }
    return db.prepare(
      'UPDATE seeds SET kept_at=NULL, updated_at=CURRENT_TIMESTAMP WHERE id=? AND user_id=?'
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

  getAllStudentAssessmentStatus() {
    return db.prepare(`
      SELECT u.id, u.name, u.avatar_initial, u.role,
        (SELECT completed_at FROM self_assessments WHERE user_id=u.id AND assessment_type='opening') as opening_at,
        (SELECT completed_at FROM self_assessments WHERE user_id=u.id AND assessment_type='midcourse') as midcourse_at,
        (SELECT completed_at FROM self_assessments WHERE user_id=u.id AND assessment_type='closing') as closing_at,
        (SELECT COUNT(*) FROM seeds WHERE user_id=u.id AND (feeling!='' OR looks_like!='')) as seeds_count
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
    const seeds    = db.prepare('SELECT * FROM seeds WHERE user_id=? ORDER BY seed_number').all(userId);
    return { user, opening, midcourse, closing, seeds };
  },
};
