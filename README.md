# TeacherOn Job Scraper

A desktop application built with **Electron** that scrapes public tutor job listings from [TeacherOn.com](https://www.teacheron.com) and stores them locally in SQLite.

---

## Features

- 🔍 **Multi-page scraping** — Automatically navigates through paginated job listings
- 🗄️ **Local SQLite storage** — Jobs persist in Electron's userData directory with deduplication
- ⏰ **Scheduled scanning** — Cron-based auto-scan every 30 or 60 minutes
- 🚀 **Multiple browser modes** — Supports Playwright Firefox and Camoufox (anti-detect)
- 🛡️ **Cloudflare detection** — Detects anti-bot challenges and stops gracefully
- 📋 **User-friendly UI** — Scan controls, job results, status badges, error log panel
- 🔒 **Secure by default** — contextIsolation, sandbox, no nodeIntegration in renderer
- 🛑 **Graceful cancellation** — Abort controllers to stop scans mid-flight

---

## Tech Stack

| Technology | Purpose |
|------------|---------|
| **Electron** | Desktop app shell |
| **Node.js ≥ 20** | Runtime |
| **Playwright** | Browser automation |
| **Camoufox** | Optional anti-detect Firefox fork |
| **better-sqlite3** | Local SQLite storage |
| **node-cron** | Scheduled scanning |

---

## Prerequisites

- **Node.js ≥ 20 LTS**
- **npm ≥ 10**
- (Optional) **Camoufox** binary for anti-detect browsing mode

---

## Setup

```bash
# Clone the repository
git clone https://github.com/simranchoubey-bit/TeacherOnJobScraper.git
cd TeacherOnJobScraper

# Install dependencies (includes native module rebuild for Electron)
npm install

# Run the app
npm start

# Run with DevTools open
npm run dev
```

### Browser Modes

| Mode | Env Variable | Description |
|------|-------------|-------------|
| **Firefox** | `BROWSER_MODE=firefox` | Playwright's managed Firefox (default fallback) |
| **Camoufox** | `BROWSER_MODE=camoufox` | Anti-detect browser — requires `CAMOUFOX_EXECUTABLE_PATH` |

```bash
# Use Camoufox (production)
BROWSER_MODE=camoufox CAMOUFOX_EXECUTABLE_PATH=/Applications/Camoufox.app/Contents/MacOS/camoufox npm start
```

---

## Project Structure

```
TeacherOnJobScraper/
├── package.json
├── README.md
├── .gitignore
├── docs/
│   └── teacheron-scraper-implementation-plan.md
├── e2e-render-test.js          # End-to-end renderer test
├── e2e-test.js                 # End-to-end test script
├── src/
│   ├── main/                   # Electron main process
│   │   ├── main.js             # Entry point — window creation, app lifecycle
│   │   ├── preload.js          # Secure contextBridge API for renderer
│   │   ├── ipc-handlers.js     # IPC channel registration & validation
│   │   ├── database.js         # SQLite layer (better-sqlite3)
│   │   ├── scraper.js          # Playwright/Camoufox scraping logic
│   │   ├── scheduler.js        # Cron-based periodic scan (30/60 min)
│   │   ├── config.js           # Browser/env configuration & CSS selectors
│   │   └── logger.js           # Structured file + renderer logging
│   ├── renderer/               # Renderer process (UI)
│   │   ├── index.html          # Main window markup
│   │   ├── renderer.js         # Frontend logic (DOM manipulation)
│   │   └── styles.css          # Application styling
│   ├── scripts/                # Utility/test scripts
│   │   ├── seed-test.js        # Database seeding & test script
│   │   ├── browser-test.js     # Browser automation test
│   │   ├── camoufox-test.js    # Camoufox launch test
│   │   └── scraper-test.js     # Scraper extraction test
│   └── shared/
│       └── constants.js        # Shared IPC channel names & job fields
└── data/                       # (gitignored) Runtime data
    └── teacheron.db            # Created at runtime
```

---

## How It Works

### Architecture Flow

```
Renderer (UI)
    ↓  window.scraperAPI (contextBridge)
Preload (isolated bridge)
    ↓  IPC channels
Main Process (Electron)
    ├── ipc-handlers.js    → scan:start, scan:stop, jobs:*, scheduler:*
    ├── scraper.js         → Playwright/Camoufox → TeacherOn.com
    ├── database.js        → better-sqlite3 → userData/teacheron.db
    ├── scheduler.js       → node-cron → periodic scan triggers
    └── logger.js          → structured logs → daily .log files + renderer panel
```

### How Scraping Works

1. **Search URL** — Uses TeacherOn's URL routing: `https://www.teacheron.com/{subject}-tutor-jobs`
2. **Page 1** — Opens the base URL and extracts listing cards
3. **Pagination** — Follows `ul.pagination a[title="Next page"]` links via `?p=N`
4. **Deduplication** — `job_url` UNIQUE constraint + in-memory `Set` prevent duplicates
5. **Cloudflare protection** — Detects challenges via page title/body signals and stops cleanly (no bypass attempted)
6. **Pacing** — Configurable delay (default 2000ms) between page navigations to avoid blocking

### Key Scraper Functions

| Function | Purpose |
|----------|---------|
| `scrapePages(page, options)` | Orchestrates multi-page extraction |
| `getNextPageUrl(page)` | Extracts next-page URL from pagination DOM |
| `navigateToNextPage(page, url, delayMs)` | Navigates with pacing delay |
| `isBlockedByCloudflare(page)` | Detects CF challenges via page signals |

### Stopped Reasons

| Condition | `stoppedReason` |
|-----------|-----------------|
| Max pages reached | `max-pages` |
| No next-page link | `no-next-page` |
| Empty page returned | `empty-page` |
| Cloudflare challenge | `cloudflare` |
| Navigation error | `navigation-error` |
| Loop protection | `duplicate-page` |
| Page/browser closed | `page-closed` |

---

## Database

- **Location:** Electron `userData` directory (per-OS standard path)
  - macOS: `~/Library/Application Support/teacheron-scraper/teacheron.db`
  - Windows: `%APPDATA%/teacheron-scraper/teacheron.db`
  - Linux: `~/.config/teacheron-scraper/teacheron.db`
- **Deduplication:** `job_url` has a UNIQUE constraint — duplicate entries are rejected
- **Native modules:** `@electron/rebuild` runs after `npm install` to compile `better-sqlite3` against Electron's ABI

### Extracted Job Fields

| Field | Source |
|-------|--------|
| `title` | Card `<h3><a>` text |
| `jobUrl` | Card link href (normalized to absolute) |
| `subjects` | `.subjectTags a.searchLean` texts |
| `location` | `.fa-map-marker-alt` parent `<li>` |
| `postedDate` | `.fa-calendar-alt` parent `<li>` |
| `description` | `.job-description` truncated excerpt |

> **Note:** Budget and student level are not available on listing cards — only on detail pages (not yet implemented).

---

## Scheduler

- Intervals: **30** or **60** minutes (configurable via UI)
- Runs an **immediate first scan** when started
- Prevents **overlapping scans** with a concurrency lock
- Tracks run status, last run time, errors, and next run time

---

## IPC Channels

| Channel | Direction | Purpose |
|---------|-----------|---------|
| `scan:start` | Renderer → Main | Start a job scan |
| `scan:stop` | Renderer → Main | Cancel an in-progress scan |
| `jobs:get-all` | Renderer → Main | Fetch all stored jobs |
| `jobs:get-recent` | Renderer → Main | Fetch recent jobs |
| `jobs:open-url` | Renderer → Main | Open a job URL in browser |
| `scheduler:start/stop/status` | Renderer → Main | Control the cron scheduler |
| `log:event` | Main → Renderer | Stream log entries to UI |
| `db:*` | Renderer → Main | Database info/operations |

---

## UI States

| State | Badge | Description |
|-------|-------|-------------|
| **Idle** | `Idle` | Awaiting user input |
| **Scanning** | `Scanning...` | Browser navigating + extracting |
| **Complete** | `Complete` | Scan finished with results |
| **Failed** | `Failed` | Browser error or network issue |
| **Stopped** | `Stopped` | User cancelled the scan |

---

## Testing

```bash
# Database tests (no Electron required)
node src/scripts/seed-test.js

# Browser automation test
HEADLESS=true npm run browser:test

# Scraper extraction test
HEADLESS=true SUBJECT="Physics" LOCATION="Delhi" npm run scraper:test

# Camoufox launch test
node src/scripts/camoufox-test.js
```

---

## Security

- `contextIsolation: true` — Renderer is isolated from Node.js
- `nodeIntegration: false` — No `require()` in renderer
- `sandbox: true` — Renderer runs in a sandboxed process
- `contextBridge` — Only a curated `window.scraperAPI` is exposed
- **CSP** meta tag — Restricts script/source origins
- All user input and scraped data is **HTML-escaped** before rendering (prevents XSS)

---

## Environment Variables

| Variable | Default | Description |
|----------|---------|-------------|
| `BROWSER_MODE` | `camoufox` | `camoufox` or `firefox` |
| `HEADLESS` | `false` | Run browser without UI |
| `CAMOUFOX_EXECUTABLE_PATH` | `null` | Path to Camoufox binary |
| `TEACHERON_URL` | `https://www.teacheron.com` | Base URL for tests |
| `NAVIGATION_TIMEOUT_MS` | `30000` | Max page load wait |
| `MAX_PAGES` | `3` | Max pages to scrape |
| `PAGE_DELAY_MS` | `2000` | Delay between page navigations |

---

## Known Limitations

> These are intentional design decisions — not bugs.

1. **Cloudflare challenges** — The app detects and stops instead of attempting bypass. No CAPTCHA solving or stealth techniques are implemented.
2. **Location filtering is URL-only** — TeacherOn routes by subject slug; location is extracted client-side, not via URL.
3. **No authentication** — All listings are public; the app does not log in.
4. **CSS selector dependent** — Verified against live DOM as of April 2026. HTML changes on TeacherOn may require selector updates in `src/main/config.js`.
5. **Single concurrency** — Only one scan at a time (manual or scheduled) is prevented by a lock.
6. **Local-only database** — No cloud sync or remote database.
7. **Scheduler intervals** — Only 30 and 60 minute options available.

---

## Package Scripts

| Script | Description |
|--------|-------------|
| `npm start` | Launch the Electron app |
| `npm run dev` | Launch with DevTools open |
| `npm run rebuild` | Rebuild native modules for Electron |
| `npm run browser:test` | Run browser automation test |
| `npm run scraper:test` | Run scraper extraction test |

---

## License

**ISC**