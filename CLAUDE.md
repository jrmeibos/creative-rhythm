# The Creative's Garden — Claude Code Reference

## Project Overview

**Name:** The Creative's Garden
**Owner:** Julia Meibos (The Meibos Touch)
**Purpose:** A private course platform for a pilot cohort of creative entrepreneurs learning "soul-led visibility" — showing up online authentically without burning out. Structured around four categories: Curiosity, Create, Share, Connect.
**Scale:** ~6 students, internal tool first, designed to later sell as a public course.

**Live URL:** Deployed on Railway (check Railway dashboard for current URL)
**GitHub:** https://github.com/jrmeibos/creative-rhythm.git
**Local dev:** `node server.js` → http://localhost:3000

---

## Tech Stack

| Layer | Choice | Notes |
|---|---|---|
| Runtime | Node.js 22.5+ | Required for `node:sqlite` built-in |
| Framework | Express.js | Server-side rendering only, no build step |
| Templates | EJS | Views in `views/`, partials in `views/partials/` |
| Database | `node:sqlite` (built-in) | Synchronous API, identical to better-sqlite3. Do NOT switch to better-sqlite3 — it needs Python/gyp for native compilation and has no prebuilt binaries for Node 25.x ARM64 |
| Sessions | session-file-store | Sessions saved to `./sessions/` folder |
| Auth | bcryptjs | Cost factor 12 in production |
| Deployment | Railway | Nixpacks builder, `node server.js` start command |
| DB location | `/data/creative-rhythm.db` on Railway | Set via `DB_PATH` env var. Local dev uses `./data/creative-rhythm.db` |

**No build steps, no bundlers, no transpilation.** Julia edits HTML/CSS directly.

### Key files
- `server.js` — all routes and middleware
- `db.js` — all database queries and migrations
- `auth.js` — `requireAuth` and `requireAdmin` middleware
- `public/css/main.css` — design tokens (CSS custom properties)
- `public/css/dashboard.css` — most component styles
- `views/partials/sidebar.ejs` — shared nav, rendered on every app page
- `views/partials/season-icon.ejs` — inline SVG icons for all 4 seasons

---

## Brand Colors

All defined as CSS custom properties in `public/css/main.css`:

```css
--color-bloem:           #705C6C   /* dark mauve — primary brand accent, buttons, links */
--color-understory:      #76856C   /* muted sage green */
--color-curiositys-kiss: #D8B0AB   /* dusty rose */
--color-apricity:        #F6C95C   /* warm gold */
--color-new-growth:      #E6EBE0   /* pale green — subtle backgrounds */
--color-pearl:           #F2EEE3   /* warm off-white — page backgrounds */
--color-blank-page:      #FAFAFA   /* near-white — card backgrounds */
--color-ink-stained:     #100F10   /* near-black — all body text */
--color-bloem-mid:       #574557   /* darker bloem, hover states */
```

**#a990a4** (soft mauve) appears in CSS as a raw hex — it's the Share category color and season-avatar--spring color. Not defined as a CSS variable.

### Fonts
- **Display / headings:** `Goldage` (custom webfont, loaded from `/fonts/`) — use for titles, key moments, category labels
- **Body:** `Jost` (Google Font, weight 300/400/700) — use for all body copy, form labels, nav

---

## Intention Categories

The four intention categories that structure the entire course and all goal-setting — Curiosity, Create, Share, Connect:

| Category | Season | Background color | Text color |
|---|---|---|---|
| **Curiosity** | Spring | `#D8B0AB` (--color-curiositys-kiss) | `#100F10` (dark) |
| **Create** | Summer | `#F6C95C` (--color-apricity) | `#100F10` (dark) |
| **Share** | Autumn / Fall | `#a990a4` | `#100F10` (dark) |
| **Connect** | Winter | `#76856C` (--color-understory) | `#100F10` (dark) |

**All four categories use dark (`#100F10`) text regardless of background.** This was explicitly approved — do not change text to white/light on Share or Connect even though they are darker backgrounds.

### Season avatars (sidebar + community)
These use a different set of direct hex values (not the same as category cards):
- Spring: `#a990a4` background, `#fff` text
- Summer: `#76856C` background, `#fff` text
- Autumn: `#D8B0AB` background, dark text
- Winter: `#F6C95C` background, dark text

### Season icon SVGs
Inline SVGs in `views/partials/season-icon.ejs`. Takes `season` (string) and `size` (number, default 40) props. Uses inline `fill="#hex"` attributes (not CSS classes) to avoid cross-season style conflicts when multiple icons appear on the same page. Include as:
```ejs
<%- include('partials/season-icon', { season: user.current_season, size: 16 }) %>
```
From within `views/partials/`, use `include('season-icon', ...)` without the `partials/` prefix (EJS resolves relative to the calling file's directory).

---

## Page Structure & Routes

### Public
| Route | View | Notes |
|---|---|---|
| `GET /` | `login.ejs` | Redirects to `/dashboard` if already logged in |
| `POST /login` | — | Sets session, redirects to `/onboarding` or `/dashboard` |
| `GET /logout` | — | Destroys session, redirects to `/` |

### Student (requireAuth)
| Route | View | Notes |
|---|---|---|
| `GET /dashboard` | `dashboard.ejs` | Weekly goals, season selector, progress |
| `GET /goals` | `goals.ejs` | Full goal cards for Curiosity, Create, Share, Connect |
| `GET /calendar` | `calendar.ejs` | 12-week view with goal status dots |
| `GET /lessons` | `lessons.ejs` | Lesson index |
| `GET /lessons/:slug` | `lesson.ejs` | Individual lesson |
| `GET /community` | `community.ejs` | Cohort progress circles |
| `GET /resources` | `coming-soon.ejs` | Placeholder — not yet built |
| `GET /profile` | `profile.ejs` | Season selector + growing seeds section |
| `GET /harvest` | `harvest.ejs` | Closing assessment + harvest reflection |
| `GET /onboarding` | `onboarding.ejs` | 4-step first-login flow (full screen, no sidebar) |

### Admin only (requireAdmin)
| Route | View | Notes |
|---|---|---|
| `GET /admin` | `admin.ejs` | User, lesson, resource management + harvest settings |

### API routes
- `POST /api/goals/*` — intention, checkin, reflection, complete, integration
- `POST /api/season` — update current season
- `POST /api/lessons/:id/complete` — mark lesson complete
- `POST /api/onboarding/assessment` — save opening self-assessment
- `POST /api/onboarding/seeds` — save 3 seeds
- `POST /api/onboarding/complete` — mark onboarding done, save session
- `POST /api/harvest` — save closing assessment + reflection
- `POST /api/admin/settings` — update course_start_date or harvest_unlocked
- `POST/PUT/DELETE /api/admin/users/:id` — CRUD users
- `POST/PUT/DELETE /api/admin/lessons/:id` — CRUD lessons
- `POST/PUT/DELETE /api/admin/resources/:id` — CRUD resources
- `GET /api/admin/student-data/:id` — fetch student's full assessment data

---

## Onboarding Flow

New students are gated by the **onboarding guard middleware** in `server.js`. Until `onboarding_completed = 1` in the DB, all routes except `/`, `/logout`, `/onboarding/*`, and `/api/onboarding/*` redirect to `/onboarding`.

The flow is 4 steps (single page, JS-toggled):
1. **Welcome** — intro screen
2. **Self-Assessment** — 10 questions (choice, rating 1-10, multi-choice, open text)
3. **Seeds** — 3 seed cards (feeling + looks_like for each)
4. **Done** — completion screen; clicking "Enter" POSTs to `/api/onboarding/complete` which calls `req.session.save()` before responding to avoid a race condition with session-file-store

Admins bypass onboarding entirely.

---

## Key Design Decisions (do not revisit without Julia's input)

- **No white text on category cards.** All four category card backgrounds (Curiosity, Create, Share, Connect) use `#100F10` ink-stained text. Even the darker cards (Share `#a990a4`, Connect `#76856C`).
- **`node:sqlite` not `better-sqlite3`.** Native compilation issues on Railway/ARM. Never switch.
- **No build steps.** No webpack, Vite, TypeScript, or transpilation. Plain JS and CSS only.
- **EJS unescaped (`<%-`) vs escaped (`<%=`) in onclick attributes.** Always use `<%= JSON.stringify(value) %>` (escaped) when injecting strings into HTML `onclick="..."` attributes. Using `<%-` breaks the attribute because raw `"` chars terminate it early. This was the cause of admin Edit/Delete buttons not working.
- **Session save before responding.** Any route that modifies `req.session.user` and then sends a response that triggers a client redirect must call `req.session.save(cb)` before `res.json()`. Otherwise session-file-store may not flush before the next request arrives (race condition with `resave: false`).
- **Onboarding guard must allow `/api/onboarding/*`.** The guard checks `req.path.startsWith('/onboarding')` — this does NOT match `/api/onboarding/...`. Both prefixes must be explicitly allowed.
- **Greenhouse (goal beds/planting) stays OPEN to trial + expired-trial users.** Julia's call (July 2026): goals are part of the free Winter experience, and expired trials keep it. Do not gate `/greenhouse` planting behind the paid course without asking her — it is intentionally ungated, unlike `/tending`, `/watch-yourself`, `/summer`, and `/grove` (all paid-gated).
- **Community is partitioned by cohort.** Full-course students (`course_length_weeks >= 12`) see only the full-course cohort; trial students see only fellow trial students. Admins are visible to both and see everyone. A $0 public signup must never see the pilot roster.
- **"Limited-time demo pricing" on the coaching tier is intentional for now** (Julia, July 2026) — do not reword without asking.

---

## Database Schema (key tables)

- **users** — id, name, email, password_hash, role (admin/student), avatar_initial, current_season, onboarding_completed
- **weekly_goals** — id, user_id, week_number, category (curiosity/create/share/connect), intention, checklist (JSON), reflection, completed, integrated_at
- **seeds** — id, user_id, seed_number (1-3), feeling, looks_like, created_at
- **self_assessments** — id, user_id, assessment_type (opening/closing), q1_choice through q10_text, harvest_reflection, completed_at
- **lessons** — id, slug, title, subtitle, category_tag, content, estimated_read_time, position, published
- **lesson_completions** — user_id, lesson_id, completed_at
- **community_posts** — id, user_id, week_number, category, content, created_at
- **community_reactions** — id, post_id, user_id, reaction
- **settings** — key, value (course_start_date, harvest_unlocked)

Migrations run automatically on server start in `db.js`. The migration block checks `PRAGMA table_info` and uses `ALTER TABLE` or DROP/CREATE as needed.

---

## Deployment

```bash
git add .
git commit -m "description"
git push origin main
```
Railway auto-deploys on push to `main`. No manual steps required.

**Railway env vars required:**
- `SESSION_SECRET` — long random string
- `DB_PATH` — `/data/creative-rhythm.db` (persistent volume)
- `NODE_ENV` — `production`
- `PORT` — set automatically by Railway

**Persistent volume** must be mounted at `/data/` in Railway settings. The SQLite file lives there and survives deploys.

---

## Accounts

### Admin
- **Email:** julia@meibostouch.com
- **Role:** admin (bypasses onboarding, sees Admin nav item)

### Students (pilot cohort)
| Name | Email | Onboarding |
|---|---|---|
| Danielle Masters | danielle.e.masters@gmail.com | Completed |
| Test Student | jrmeibos@yahoo.com | Pending |

---

## Outstanding / Not Yet Built

- **`/resources`** — renders `coming-soon.ejs`, not built yet
- **Password change UI** — no in-app password change for students; admin must reset directly in DB via `bcryptjs` (see `db.js` → `updateUser`)
- **Email notifications** — none implemented

## Recently Fixed Bugs (for context)

- **Onboarding redirect loop** — guard didn't allow `/api/onboarding/*` paths through; all API calls were silently intercepted and redirected. Fixed by adding `|| req.path.startsWith('/api/onboarding')` to the guard.
- **Admin Edit/Delete buttons did nothing** — `<%-` (unescaped) EJS in onclick attributes broke the HTML attribute parsing. Fixed to `<%=` on all JSON.stringify values in onclick attributes across users, lessons, and resources.
- **Session race condition on onboarding complete** — `req.session.save()` now called before `res.json()` so the session file is written before the browser redirect arrives.
