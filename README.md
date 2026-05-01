# The Creative's Rhythm

Soul-Led Visibility for Artists — a course platform for The Meibos Touch.

## Quick Start

### 1. Install dependencies
```bash
npm install
```

### 2. Set up your environment
```bash
cp .env.example .env
```
Open `.env` and set:
- `SESSION_SECRET` — any long random string (required for security)
- `ADMIN_EMAIL` — your email address
- `ADMIN_PASSWORD` — your admin password (change this before inviting anyone!)

### 3. Add your logo files
Place these files in `public/images/logo/`:
- `Circle_Logo_Icon1500x.png`
- `Main_Logo__Bloem1500x.png`

Then run the logo processor to remove the black backgrounds:
```bash
npm install sharp
node scripts/process-logos.js
```

### 4. Start the server
```bash
# Development (auto-restarts on file changes)
npm run dev

# Production
npm start
```

Visit `http://localhost:3000` — you'll see the login page.

---

## Accounts

The first time the server starts, it creates:
- **Admin account** — uses `ADMIN_EMAIL` + `ADMIN_PASSWORD` from your `.env`
- **Test student** — `student@example.com` / `student123` (delete this before launch)

To add real student accounts, use the Admin panel at `/admin` (once it's built).

---

## Deployment on Railway

1. Push this project to a GitHub repo
2. Create a new Railway project → "Deploy from GitHub repo"
3. Add environment variables in Railway's dashboard:
   - `SESSION_SECRET`
   - `ADMIN_EMAIL`
   - `ADMIN_PASSWORD`
   - `NODE_ENV=production`
   - `DB_PATH=/data/creative-rhythm.db`
4. Add a **Volume** in Railway, mounted at `/data` — this keeps your database persistent across deploys
5. Deploy

---

## File Structure

```
creative-rhythm/
├── public/
│   ├── css/
│   │   ├── main.css        ← Global styles, color palette, buttons, forms
│   │   ├── login.css       ← Login page styles
│   │   └── dashboard.css   ← App layout, sidebar, dashboard components
│   ├── js/                 ← Client-side JavaScript (goals, lessons, community)
│   └── images/logo/        ← Place logo files here
├── views/
│   ├── partials/
│   │   ├── head.ejs        ← <head> tag content (fonts, CSS links)
│   │   └── sidebar.ejs     ← Navigation sidebar
│   ├── login.ejs           ← Login page
│   ├── dashboard.ejs       ← Main dashboard
│   └── coming-soon.ejs     ← Placeholder for pages under construction
├── scripts/
│   └── process-logos.js    ← Removes black background from logo PNGs
├── data/                   ← SQLite database lives here (auto-created)
├── sessions/               ← Session files (auto-created)
├── server.js               ← Express server + all routes
├── db.js                   ← Database setup + all queries
├── auth.js                 ← Authentication middleware
└── .env                    ← Your secrets (never commit this)
```

---

## Editing the Platform

**Colors** — all defined as CSS variables in `public/css/main.css` at the top. Change once, updates everywhere.

**Fonts** — loaded from Google Fonts in `views/partials/head.ejs`. To change fonts, update the Google Fonts URL and the `--font-display`/`--font-body` variables in `main.css`.

**Page content** — EJS templates in `views/`. The `<%= variable %>` tags pull in data from the server. Everything else is regular HTML/CSS.

**Adding a lesson** — currently done through the Admin panel (coming soon). For now, add directly to the database or add to the seed data in `db.js`.

---

*Built for The Meibos Touch. "Visibility that feels like a return to self."*
