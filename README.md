# TeacherOn Tutor Job Scraper

A desktop application built with Electron that scrapes public tutor job listings from [TeacherOn.com](https://www.teacheron.com).

## Status

✅ **Phase 10 — Testing & Bug Fixing** (complete)
📋 See [Implementation Plan](docs/teacheron-scraper-implementation-plan.md) for full details.

### Phase Completion Summary

| Phase | Status | Description |
|-------|--------|-------------|
| Phase 0 | ✅ | Project scaffold, Electron app basics, window management |
| Phase 1 | ✅ | IPC infrastructure, preload bridge, security model |
| Phase 2 | ✅ | SQLite database, `better-sqlite3`, schema, deduplication |
| Phase 3 | ✅ | Playwright browser automation, Firefox/Camoufox support |
| Phase 4 | ✅ | Search navigation, listing extraction, URL normalization |
| Phase 5 | ✅ | Multi-page pagination, Cloudflare detection, anti-bot pacing |
| Phase 6 | ✅ | Renderer UI, scan controls, results table, status badges |
| Phase 7 | ✅ | Cron-based scheduler, 30/60-minute intervals, immediate first scan |
| Phase 8 | ✅ | Abort controller, graceful shutdown, overlap prevention |
| Phase 9 | ✅ | Structured logging, error-log panel, keyboard shortcuts, UI polish |
| Phase 10 | ✅ | Testing, bug fixing, console→logger migration, security audit |

### Test Results

| Test Suite | Passed | Failed | Total |
|------------|--------|--------|-------|
| Syntax checks (13 JS files) | 13 | 0 | 13 |
| Module export verification | 29 | 0 | 29 |
| Security conformance | 7 | 0 | 7 |
| Seed database tests | 15 | 0 | 15 |
| **Total** | **64** | **0** | **64** |

## Tech Stack

- **Electron** — Desktop app shell
- **Node.js** — Runtime
- **Playwright** — Browser automation
- **Camoufox** — Anti-detect Firefox fork (optional)
- **SQLite** (`better-sqlite3`) — Local data storage
- **node-cron** — Scheduled scanning
- **No Puppeteer** — Not used in this project

## Prerequisites

- Node.js ≥ 20 LTS
- npm ≥ 10

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

## Phase 2: SQLite Database

### Why SQLite?

SQLite is a lightweight, file-based database that requires no server setup. It's perfect for a desktop application because:

- Zero configuration — the database file is created automatically
- Runs in-process — synchronous API via `better-sqlite3`, no async overhead
- ACID-compliant — safe concurrent writes from a single process
- No dependency on external services

### Where is the database stored?

The database file is stored in Electron's persistent **userData** directory, obtained via `app.getPath('userData')`:

| Platform | Path |
|----------|------|
| macOS | `~/Library/Application Support/teacheron-scraper/teacheron.db` |
| Windows | `%APPDATA%/teacheron-scraper/teacheron.db` |
| Linux | `~/.config/teacheron-scraper/teacheron.db` |

This ensures the database survives app updates and is stored in the OS-preferred location. It is **not** stored inside the source directory.

### Why `better-sqlite3` in the main process only?

`better-sqlite3` is a Node.js native module (C++ add-on). It runs exclusively in Electron's main process where Node.js APIs are available.

The renderer (frontend UI) never has access to `better-sqlite3`, the database connection, or raw Node.js APIs. All database operations flow through:

```
Renderer → Preload (contextBridge) → IPC Handler → database.js → SQLite
```

### How duplicate jobs are prevented

The `job_url` field has a **UNIQUE constraint** in SQLite. When a new job is scraped:

1. `createJob()` checks if the URL already exists via `jobExists()`
2. If it exists, the existing record is returned with `inserted: false`
3. If not, a new row is inserted

Duplicate records are **never** created, and existing data is **never silently overwritten**.

### Native Module Compatibility

`better-sqlite3` ships prebuilt binaries for multiple platforms. A `postinstall` script automatically runs `@electron/rebuild` to ensure the module is compiled against Electron's Node.js version. Manual rebuild is available via:

```bash
npm run rebuild
```

## Native Module Compatibility

`better-sqlite3` is a native C++ add-on. To ensure it works with Electron (which may use a different Node.js ABI than your system Node.js), the project uses `@electron/rebuild` which runs automatically after `npm install`. This rebuilds the native module against Electron's Node.js headers.

## Project Structure

```
TeacherOnJobScraper/
├── package.json
├── README.md
├── .gitignore
├── docs/
│   └── teacheron-scraper-implementation-plan.md
├── src/
│   ├── main/                    # Electron main process
│   │   ├── main.js              # Entry point
│   │   ├── preload.js           # Secure preload script
│   │   ├── ipc-handlers.js      # IPC handlers
│   │   ├── database.js          # SQLite layer
│   │   ├── scraper.js           # Scraping logic (Phase 3+)
│   │   └── scheduler.js         # Cron scheduler (Phase 7+)
│   ├── renderer/                # Renderer process (UI)
│   │   ├── index.html           # Main window
│   │   ├── renderer.js          # Frontend logic
│   │   └── styles.css           # Styling
│   ├── scripts/                 # Utility scripts
│   │   ├── seed-test.js         # Database test script
│   │   ├── browser-test.js      # Browser automation test
│   │   └── scraper-test.js      # Scraper extraction test
│   └── shared/                  # Shared constants
│       └── constants.js
└── data/                        # (gitignored) Runtime data
    └── teacheron.db             # Created at runtime
```

## Phase 3: Browser Automation Foundation (Playwright)

### What is Playwright?

Playwright is a browser automation library that controls real web browsers programmatically. In this project, Playwright runs Firefox (or Camoufox) to navigate TeacherOn.com, scrape job listings, and interact with the page as a real browser would. Playwright is used instead of Puppeteer for:
- Better cross-browser support (Firefox, Chromium, WebKit)
- More robust auto-waiting mechanisms
- Simpler API for waiting on page state vs. arbitrary timeouts

### What is Camoufox?

[Camoufox](https://github.com/daijro/camoufox) is an anti-detect browser — a hardened Firefox fork designed to evade bot-detection systems. It randomizes fingerprints (Canvas, WebGL, audio), mimics real browser attributes, and reduces the chance of being blocked by anti-scraping protections.

The scraper supports two browser modes:
- **Firefox mode** (default) — Uses Playwright's managed Firefox. Good for development and testing.
- **Camoufox mode** — Uses the Camoufox binary. Intended for production scraping when TeacherOn's anti-bot protections are a concern.

### Browser Modes

| Mode | Description | When to use |
|------|-------------|-------------|
| **Headless** | Browser runs without a visible window. Set `HEADLESS=true`. | Production, automated scans, CI/CD |
| **Headful** | Browser window is visible. Default (`HEADLESS=false`). | Development, debugging, verifying selectors |

### Browser Configuration

Browser settings are configured via environment variables (see `src/main/config.js`):

| Variable | Default | Description |
|----------|---------|-------------|
| `BROWSER_MODE` | `firefox` | `camoufox` or `firefox` |
| `HEADLESS` | `false` | `true` for invisible browser |
| `CAMOUFOX_EXECUTABLE_PATH` | *(auto-detect)* | Path to Camoufox binary |
| `TEACHERON_URL` | `https://www.teacheron.com` | Target URL for navigation tests |
| `NAVIGATION_TIMEOUT_MS` | `30000` | Max time to wait for page load |

If Camoufox is not installed, the app automatically falls back to Playwright's managed Firefox.

### Running the Browser Test

```bash
# Headful (visible browser window) — default
npm run browser:test

# Headless (no window)
HEADLESS=true npm run browser:test

# With Camoufox (if installed)
BROWSER_MODE=camoufox CAMOUFOX_EXECUTABLE_PATH=/path/to/camoufox npm run browser:test
```

This launches a browser, navigates to TeacherOn.com, reads the page title/URL, logs the result, and closes cleanly. It validates that the browser automation foundation works before building the full scraper (Phase 4+).

## Phase 4: TeacherOn Listing-Page Scraping

### Discovered Site Structure (Live DOM, April 2026)

The listing/search page at `/tutor-jobs` uses these actual elements:

| Element | Selector | Notes |
|---------|----------|-------|
| Job card | `.highlightDivOnHover` | Each card is a `<div class="row margin-bottom-30 highlightDivOnHover">` |
| Title + URL | `h3 a[href*="/teacher-job/"]` | Title text and detail-page link in one `<a>` tag |
| Subjects | `ul.subjectTags a.searchLean` | Multiple subject tags per card; not always present |
| Location | `.fa-map-marker-alt` → parent `<li>` | FontAwesome icon; extract parent `<li>` innerText |
| Posted date | `.fa-calendar-alt` → parent `<li>` | FontAwesome icon; extract parent `<li>` innerText |
| Description | `.job-description` | Truncated excerpt from the listing card |

### Search Mechanism

TeacherOn uses **URL-based routing** for subject searches:

```
https://www.teacheron.com/{subject-slug}-tutor-jobs
```

Where `{subject-slug}` is the subject name, lowercased, with spaces → underscores (e.g., `mathematics` → `https://www.teacheron.com/mathematics-tutor-jobs`).

Location filtering is **NOT** supported via URL — the scraper extracts location from each card instead.

### Fields Extracted

| Field | Required | Source |
|-------|----------|--------|
| `title` | Yes | Card `<h3><a>` text |
| `jobUrl` | Yes | Card `<h3><a>` href (normalized to absolute) |
| `subjects` | No | Array of `.subjectTags a.searchLean` texts |
| `location` | No | `.fa-map-marker-alt` parent `<li>` innerText |
| `postedDate` | No | `.fa-calendar-alt` parent `<li>` innerText |
| `description` | No | `.job-description` innerText (truncated excerpt) |

**NOT available on listing cards:** budget, student_level. These will be extracted from detail pages in a later phase.

### URL Normalization

- Relative URLs are resolved against `https://www.teacheron.com`
- Only `http://` and `https://` protocols are accepted
- Malformed URLs are rejected (the listing is skipped with a warning)
- Duplicate URLs within a page are removed (first occurrence wins)

### Limitations

- **No detail pages** — Description is the truncated card excerpt, not full text
- **No SQLite persistence** — Scraper returns structured data; database wiring is separate
- **No budget/student level** — These fields are only on detail pages
- **Cloudflare anti-bot** — TeacherOn serves Cloudflare challenges; rapid sequential requests may be blocked. A single request per browser session works reliably.

### Running the Scraper Test

```bash
# Default: Mathematics, Mumbai
HEADLESS=true npm run scraper:test

# Custom subject and location
HEADLESS=true SUBJECT="Physics" LOCATION="Delhi" npm run scraper:test

# All jobs (no filter)
HEADLESS=true SUBJECT="" npm run scraper:test
```

### IPC Integration

The `scan:start` IPC channel now invokes the scraper with pagination:
- Validates `subject`, `location` (optional, non-empty strings) and `maxPages` (optional, positive integer)
- Launches browser if not already running
- Navigates to the appropriate search URL
- Extracts listing cards from multiple pages using `scrapePages()`
- Returns structured listings with pagination metadata (`pagesScraped`, `stoppedReason`) to the renderer (plain serializable JSON only)

No Puppeteer/Playwright objects are exposed through `contextBridge`.

## Phase 5: Pagination

### Discovered Pagination Mechanism (Live DOM, April 2026)

TeacherOn uses a standard numbered page navigation:

| Element | Selector | Notes |
|---------|----------|-------|
| Pagination container | `ul.pagination` | At the bottom of the listing page |
| Page number links | `a[id^="pgLink"]` | Links to pages 1-5 (visible range) |
| Next page link | `ul.pagination li.next-page a[title="Next page"]` | Text: ">" — navigates to `?p=N+1` |
| Previous page link | `ul.pagination li.prev-page a[title="Previous Page"]` | Text: "<" — navigates to `?p=N-1` |
| Active page | `ul.pagination li.active` | Indicates current page number |

### Page URL Behavior

Page 1 uses the base URL (no query parameter). Pages 2+ use the `?p=N` query parameter:

```
Page 1: https://www.teacheron.com/mathematics-tutor-jobs
Page 2: https://www.teacheron.com/mathematics-tutor-jobs?p=2
Page 3: https://www.teacheron.com/mathematics-tutor-jobs?p=3
```

### How It Works

1. **`scrapePages(page, options)`** orchestrates multi-page extraction:
   - Extracts page 1 listings via `scrapeListingPage()`
   - Reads the next-page URL from `ul.pagination`
   - Navigates to each subsequent page with configurable delays
   - Stops on any termination condition

2. **`getNextPageUrl(page)`** extracts the next-page URL from the pagination DOM. Returns `null` if:
   - No `ul.pagination` container exists
   - No `a[title="Next page"]` link exists (last page)
   - The href is empty or invalid

3. **`navigateToNextPage(page, url, delayMs)`** handles page navigation:
   - Optional pacing delay to avoid Cloudflare blocking
   - Waits for listing cards or "no results" div to appear
   - Returns success/failure

4. **`isBlockedByCloudflare(page)`** detects Cloudflare challenges:
   - Checks page title for known patterns (`Attention Required`, `Cloudflare`, etc.)
   - Checks body text for known DOM patterns (`cf-browser-verification`, etc.)
   - Returns `true` if a challenge is detected — does NOT attempt to bypass

### Termination Conditions

Pagination stops safely when any of these conditions occur:

| Condition | `stoppedReason` |
|-----------|----------------|
| `maxPages` limit reached | `max-pages` |
| No next-page link found | `no-next-page` |
| Next page produces no listings | `empty-page` |
| Cloudflare challenge detected | `cloudflare` |
| Navigation error | `navigation-error` |
| Duplicate page URL (loop protection) | `duplicate-page` |
| Page/browser closed | `page-closed` |

### Cross-Page Deduplication

Listings are deduplicated across all pages using the normalized `jobUrl`. A `Set` of seen URLs ensures each listing appears only once. Duplicate URLs are logged when encountered.

### Infinite Loop Prevention

A `Set` of visited page URLs prevents infinite loops. If a next-page URL has already been visited, pagination stops immediately with `duplicate-page`.

### Cloudflare Handling

TeacherOn triggers Cloudflare challenges on rapid sequential requests. The scraper:

- Adds configurable delay between page navigations (`PAGE_DELAY_MS`, default 2000ms)
- Detects challenges via page title and body text signals
- Stops pagination immediately when a challenge is detected
- Preserves all listings already collected before the challenge
- Does NOT implement bypass, CAPTCHA solving, proxy rotation, or stealth techniques

### Configuration

| Variable | Default | Description |
|----------|---------|-------------|
| `MAX_PAGES` | `3` | Maximum pages to scrape |
| `PAGE_DELAY_MS` | `2000` | Delay between page navigations (anti-bot pacing) |

### Running the Pagination Test

```bash
# Default: Mathematics, Mumbai, max 3 pages
HEADLESS=true npm run scraper:test

# Custom pages
MAX_PAGES=2 HEADLESS=true npm run scraper:test

# Custom subject + location + max pages
MAX_PAGES=2 SUBJECT="Physics" LOCATION="Delhi" HEADLESS=true npm run scraper:test
```

### Scraper Result Shape

```js
{
  listings: [...],        // Array of deduplicated listing objects
  pagesScraped: 3,        // Number of pages actually scraped
  stoppedReason: "max-pages" // Why pagination stopped
}
```
## Phase 6: Basic Renderer UI

### UI Components

The renderer UI has three main sections:

1. **Scan Controls** — Subject, Location, and Max Pages inputs with Start/Stop buttons
2. **Status & Progress** — Status badge (Idle/Running/Success/Error), progress bar, scan stats, and error display
3. **Results** — Job cards rendered in a clean stacked layout with View Job buttons

### How It Works

- **`window.scraperAPI.scanStart(options)`** — Invoked with `{ subject, location, maxPages }` from the IPC preload bridge
- **`window.scraperAPI.scanStop()`** — Requests scan cancellation (sets flag; in-flight page operations may still complete)
- **`window.scraperAPI.openJobUrl(url)`** — Opens the original TeacherOn listing in the default browser
- All rendering is pure DOM manipulation — no framework dependencies
- HTML is safely escaped to prevent XSS
- Enter key on Subject/Location inputs triggers scan

### States Handled

| State | Badge | Description |
|-------|-------|-------------|
| **Idle** / Ready | `Idle` | Awaiting user input |
| **Scanning** | `Scanning...` | Browser navigating + extracting |
| **Complete** | `Complete` | Scan finished with results |
| **Failed** | `Failed` | Browser error or network issue |
| **Stopped** | `Stopped` | User cancelled the scan |

### Scan Result Display

After a successful scan, the UI shows:
- **Pages scraped** — e.g., `3 / 3`
- **Stopped reason** — e.g., `max-pages`, `no-next-page`, `cloudflare`
- **Time** — Start and end timestamps
- **Job cards** — Title, subjects (tag badges), location, posted date, description (truncated 200 chars), and View Job button

### Running the UI

```bash
npm start
```

### Security

- No Node.js APIs in renderer — `contextIsolation: true`, `nodeIntegration: false`, `sandbox: true`
- Only `window.scraperAPI` (contextBridge) is available
- All user input and scraped data is HTML-escaped before rendering
- No frameworks or external CDN dependencies — CSP-compliant
## Testing

```bash
# Run standalone database tests (no Electron required)
node src/scripts/seed-test.js

# Run browser automation test
HEADLESS=true npm run browser:test

# Run scraper extraction test
HEADLESS=true npm run scraper:test
```

## Security

- `contextIsolation: true` — Renderer is isolated from Node.js
- `nodeIntegration: false` — No `require()` in renderer
- `sandbox: true` — Renderer runs in a sandbox
- `contextBridge` — Only a safe, curated API is exposed to the renderer
- CSP meta tag — Restricts script and source origins

## Known Limitations

> These are intentional design decisions and known tradeoffs — not bugs.

1. **Cloudflare challenges** — TeacherOn.com may present Cloudflare challenges during rapid scraping. The app detects these and stops instead of attempting bypass. This is by design — we do NOT implement CAPTCHA bypass or stealth techniques.

2. **Location filtering is URL-only** — Search uses TeacherOn's URL-based routing (`/{subject-slug}-tutor-jobs`). Location filtering happens client-side (in-browser extraction), not via URL. Cards without location data will have `null` in that field.

3. **No authentication** — Tutor job listings on TeacherOn are public. The app does not log in or access authenticated endpoints.

4. **Playwright (not Puppeteer)** — This project uses Playwright for multi-browser support (Firefox, Chromium, WebKit). Puppeteer is not used or depended upon.

5. **Page structure dependent** — CSS selectors are verified against the live DOM as of April 2026. If TeacherOn changes their HTML structure, selectors in `src/main/config.js` will need updating.

6. **Single-concurrency** — Only one scan can run at a time (manual or scheduled). Overlapping scans are prevented with a lock.

7. **Database is local only** — The SQLite database is stored in Electron's userData directory. There is no cloud sync or remote database.

8. **Scheduler interval** — Only 30 and 60 minute intervals are supported. Immediate first scan runs on start.

## License

ISC