// src/main/config.js
// Phase 3: Browser automation configuration
//
// This module provides browser-related configuration used by scraper.js.
// It reads from environment variables with sensible defaults.
//
// Environment variables:
//   BROWSER_MODE             — 'camoufox' | 'firefox' (default: 'camoufox')
//   HEADLESS                 — 'true' | 'false' (default: 'false' for dev)
//   CAMOUFOX_EXECUTABLE_PATH — path to Camoufox binary (required if BROWSER_MODE=camoufox)
//   TEACHERON_URL            — URL to navigate to for tests (default: teacheron.com)
//   NAVIGATION_TIMEOUT_MS    — max time to wait for page load (default: 30000)
//
// Note: Camoufox is an anti-detect Firefox fork. If it is not installed,
// the app falls back to Playwright's managed Firefox automatically.

const os = require('os');

// ─── Browser Configuration ──────────────────────────────────────────────────

const BROWSER_MODE = process.env.BROWSER_MODE || 'camoufox';
// 'camoufox' — use Camoufox anti-detect browser (requires binary)
// 'firefox'   — use Playwright's managed Firefox

const HEADLESS = process.env.HEADLESS === 'true' || false;
// true  — browser runs without visible UI (headless mode)
// false — browser window is visible (headful mode, useful for development/debugging)

const CAMOUFOX_EXECUTABLE_PATH = process.env.CAMOUFOX_EXECUTABLE_PATH || null;
// Absolute path to the Camoufox executable.
// Example (macOS): /Applications/Camoufox.app/Contents/MacOS/camoufox
// Leave null to use Playwright's managed Firefox.

const TEACHERON_URL =
  process.env.TEACHERON_URL || 'https://www.teacheron.com';

const NAVIGATION_TIMEOUT_MS = parseInt(
  process.env.NAVIGATION_TIMEOUT_MS || '30000',
  10
);

// ─── Viewport & User Agent ──────────────────────────────────────────────────

const VIEWPORT = { width: 1280, height: 720 };

// IMPORTANT: Do NOT set a hardcoded Chrome UA when running Firefox/Camoufox.
// Matching "Chrome/120" while the browser engine is Gecko creates a
// fingerprint inconsistency that Cloudflare can detect immediately.
// Instead, pass null here to let the browser use its own matching UA.
// If you must override it, use a Firefox-compatible UA:
const USER_AGENT = process.env.USER_AGENT || null;
// Firefox-compatible UA (set only if USER_AGENT env is not provided):
// 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10.15; rv:138.0) Gecko/20100101 Firefox/138.0'

// ─── Default Camoufox Search Paths ──────────────────────────────────────────
//
// These are helpful hints for common installation locations.
// The actual path must come from the CAMOUFOX_EXECUTABLE_PATH env var.

function getDefaultCamoufoxPaths() {
  const paths = [];
  if (os.platform() === 'darwin') {
    paths.push('/Applications/Camoufox.app/Contents/MacOS/camoufox');
    // Homebrew
    paths.push('/usr/local/bin/camoufox');
    paths.push('/opt/homebrew/bin/camoufox');
  } else if (os.platform() === 'linux') {
    paths.push('/usr/local/bin/camoufox');
    paths.push('/usr/bin/camoufox');
  } else if (os.platform() === 'win32') {
    paths.push('C:\\Program Files\\Camoufox\\camoufox.exe');
  }
  return paths;
}

// ─── Phase 4: Listing Page Scraping Configuration ──────────────────────────
//
// Selectors based on LIVE TeacherOn DOM inspection (April 2026).
// The listing page URL is either /tutor-jobs (all jobs) or
// /{subject-slug}-tutor-jobs (subject-filtered).

const TEACHERON_LISTING_URL =
  process.env.TEACHERON_LISTING_URL || 'https://www.teacheron.com/tutor-jobs';

const TEACHERON_SEARCH_BASE_URL = 'https://www.teacheron.com';

// These selectors were verified against the live DOM on 2026-04-09.
// If TeacherOn changes their markup, update these here.

const LISTING_SELECTORS = {
  // Each job card is a div.highlightDivOnHover inside #tutorOrJobSearchItemList
  card: '.highlightDivOnHover',
  // Title is an <a> inside <h3> — the ONLY link in the card that does NOT have class "searchLean"
  title: 'h3 a[href*="/teacher-job/"]',
  // Subject tags are <a class="searchLean"> inside ul.subjectTags
  subjects: 'ul.subjectTags a.searchLean',
  // Location is found via FontAwesome map-marker icon's parent <li>
  locationIcon: '.fa-map-marker-alt',
  // Posted date is found via FontAwesome calendar icon's parent <li>
  postedDateIcon: '.fa-calendar-alt',
  // Description is a <p class="job-description">
  description: '.job-description',
  // Job detail-page URL (the title link href)
  jobLink: 'a[href*="/teacher-job/"]',
};

// ─── Phase 5: Pagination Configuration ────────────────────────────────────
//
// Verified against live TeacherOn DOM on 2026-04-09:
//   - Pagination container: ul.pagination
//   - Page links: li > a with ids pgLink1, pgLink2, etc.
//   - Next page: li.next-page > a[title="Next page"] (text: ">")
//   - Previous page: li.prev-page > a[title="Previous Page"] (text: "<")
//   - Active page: li.active
//   - URL format: page 1 = base URL, pages 2+ use ?p=N parameter
//   - Cards per page: 20

// Detect-only default. When Cloudflare is hit mid-pagination, we wait
// this long and retry once before giving up.
const CLOUDFLARE_RETRY_MS = parseInt(process.env.CLOUDFLARE_RETRY_MS || '8000', 10);

const PAGINATION_SELECTORS = {
  // The ul.pagination container
  container: 'ul.pagination',
  // The "Next page" link — has title="Next page", text ">", inside li.next-page
  nextPageLink: 'ul.pagination li.next-page a[title="Next page"]',
  // The active page li element
  activePage: 'ul.pagination li.active',
  // Individual page number links (not prev/next)
  pageNumber: 'ul.pagination a[id^="pgLink"]',
};

// Default maximum pages to scrape (1–3 is safe for anti-bot pacing)
const MAX_PAGES = parseInt(process.env.MAX_PAGES || '3', 10);

// Delay in milliseconds between page navigations to avoid Cloudflare triggers.
// TeacherOn triggers Cloudflare challenges on rapid sequential requests.
// This delay helps pace the crawler within safe limits.
const PAGE_DELAY_MS = parseInt(process.env.PAGE_DELAY_MS || '5000', 10);

// ─── Cloudflare Detection ─────────────────────────────────────────────────

// Known page titles that indicate a Cloudflare challenge
const CLOUDFLARE_TITLE_PATTERNS = [
  'Attention Required',
  'Cloudflare',
  'Just a moment',
  'Checking your browser',
  'DDoS protection',
];

// Known DOM text patterns that may appear during a Cloudflare challenge
const CLOUDFLARE_BODY_PATTERNS = [
  'cf-browser-verification',
  'cf-challenge-running',
  'cf_captcha',
  '_cf_chl_opt',
  'Why have I been blocked?',
];

// ─── Exports ───────────────────────────────────────────────────────────────

module.exports = {
  BROWSER_MODE,
  HEADLESS,
  CAMOUFOX_EXECUTABLE_PATH,
  TEACHERON_URL,
  TEACHERON_LISTING_URL,
  TEACHERON_SEARCH_BASE_URL,
  LISTING_SELECTORS,
  PAGINATION_SELECTORS,
  MAX_PAGES,
  PAGE_DELAY_MS,
  CLOUDFLARE_TITLE_PATTERNS,
  CLOUDFLARE_BODY_PATTERNS,
  CLOUDFLARE_RETRY_MS,
  NAVIGATION_TIMEOUT_MS,
  VIEWPORT,
  USER_AGENT,
  getDefaultCamoufoxPaths,
};
