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
`);

// Migrate existing databases to add new columns
(function migrate() {
  const columns = db.prepare("PRAGMA table_info(weekly_goals)").all().map(r => r.name);
  if (!columns.includes('reflection')) {
    db.exec("ALTER TABLE weekly_goals ADD COLUMN reflection TEXT DEFAULT ''");
    console.log('✓ Migrated: added reflection column');
  }
  if (!columns.includes('reflection_at')) {
    db.exec("ALTER TABLE weekly_goals ADD COLUMN reflection_at DATETIME");
    console.log('✓ Migrated: added reflection_at column');
  }
})();

function seedAdmin() {
  const email = process.env.ADMIN_EMAIL || 'julia@meibostouch.com';
  if (db.prepare('SELECT id FROM users WHERE email = ?').get(email)) return;
  const hash = bcrypt.hashSync(process.env.ADMIN_PASSWORD || 'changeme', 12);
  db.prepare('INSERT INTO users (name, email, password_hash, role, avatar_initial) VALUES (?, ?, ?, ?, ?)')
    .run('Julia M.', email, hash, 'admin', 'J');
  console.log('✓ Admin user created');
}

function seedLessons() {
  if (db.prepare('SELECT COUNT(*) as c FROM lessons').get().c > 0) return;

  const lessons = [
    {
      slug: 'welcome-to-the-rhythm',
      title: "Welcome to The Creative's Rhythm",
      subtitle: "You already know what you want to say. Let's find it together.",
      category_tag: 'Mindset',
      estimated_read_time: 8,
      sort_order: 1,
      content: `<p class="lesson-lead">This is not a content calendar. It's a permission slip.</p>

<p>You're here because something in you knows that the way you've been trying to show up online—or avoiding showing up altogether—isn't working. Not because you're doing it wrong, exactly. But because you might be doing it for the wrong reasons, in the wrong order, with the wrong framework.</p>

<p>You're not a product. You're a person making things. And this platform was built for that difference.</p>

<h2>The Four Rhythms</h2>

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

<blockquote class="lesson-pullquote">These aren't a hierarchy. They're a rhythm. Some weeks are heavy on Curiosity. Some weeks you're deep in a Create phase. The goal is to notice your rhythm—not force a schedule.</blockquote>

<h2>Integration Weeks</h2>

<p>Every few weeks, you'll encounter something we call an Integration Week. This is a week with no goals—just a reflection prompt and permission to let what you've been learning settle in.</p>

<p>Integration is not falling behind. Integration <em>is</em> the work.</p>

<h2>How to Use This Platform</h2>

<p>Each week, you'll set loose intentions across the 4 C's. Not SMART goals. Not deliverables. Intentions. Things you'd love to move toward.</p>

<p>Then you'll show up—here, in the community, in your creative life—and let the rhythm carry you.</p>`
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

function seedTestStudent() {
  if (db.prepare("SELECT id FROM users WHERE email = 'student@example.com'").get()) return;
  const hash = bcrypt.hashSync('student123', 12);
  db.prepare('INSERT INTO users (name, email, password_hash, role, avatar_initial) VALUES (?, ?, ?, ?, ?)')
    .run('Alex C.', 'student@example.com', hash, 'student', 'A');
  console.log('✓ Test student created (student@example.com / student123)');
}

seedAdmin();
seedLessons();
seedTestStudent();

module.exports = {
  getUserByEmail(email) {
    return db.prepare('SELECT * FROM users WHERE email = ?').get(email);
  },

  getUserById(id) {
    return db.prepare('SELECT id, name, email, role, avatar_initial FROM users WHERE id = ?').get(id);
  },

  getAllUsers() {
    return db.prepare('SELECT id, name, email, role, created_at FROM users ORDER BY role DESC, name ASC').all();
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
  }
};
