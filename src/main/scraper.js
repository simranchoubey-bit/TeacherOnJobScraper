// src/main/scraper.js
// Phase 3+4: Browser automation + TeacherOn listing-page scraping
//
// This module provides:
//  - Browser lifecycle management (launch, close, page creation)
//  - Camoufox integration via Playwright for anti-detection
//  - TeacherOn search navigation (URL-based search)
//  - Listing-card extraction from the current page DOM
//  - Multi-page pagination with Cloudflare detection
//
// It runs exclusively in the Electron main process.
// Playwright/Camoufox objects are NEVER exposed to the renderer.
// SQLite and IPC logic are kept in their own modules.

let playwright;
try {
  playwright = require('playwright');
} catch (e) {
  console.error('[Scraper] Playwright not installed — run: npm install playwright');
  playwright = null;
}

let camoufox;
try {
  camoufox = require('camoufox');
} catch (e) {
  console.log('[Scraper] Camoufox npm package not installed — will use Firefox fallback');
  camoufox = null;
}

const logger = require('./logger');

const {
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
} = require('./config');

// ─── Module State ──────────────────────────────────────────────────────────

let browser = null;
let browserContext = null;

// Phase 8: Abort controller for gracefully stopping in-flight scans.
// When signaled, scraping loops should stop after the current page
// and return whatever results they've already collected.
let abortController = null;

// ─── Camoufox Executable Detection ─────────────────────────────────────────

/**
 * Resolve the Camoufox binary path.
 *
 * Priority:
 *   1. CAMOUFOX_EXECUTABLE_PATH env var (explicit override)
 *   2. camoufox npm package's getLaunchPath() (auto-downloaded binary)
 *   3. Default platform-specific paths
 *   4. null → falls back to Playwright Firefox
 */
function resolveCamoufoxPath() {
  // 1. Explicit env var takes highest precedence
  if (CAMOUFOX_EXECUTABLE_PATH) {
    const fs = require('fs');
    if (fs.existsSync(CAMOUFOX_EXECUTABLE_PATH)) {
      console.log('[Scraper] ✓ Camoufox binary from CAMOUFOX_EXECUTABLE_PATH:', CAMOUFOX_EXECUTABLE_PATH);
      return CAMOUFOX_EXECUTABLE_PATH;
    }
    console.warn('[Scraper] CAMOUFOX_EXECUTABLE_PATH is set but file not found:', CAMOUFOX_EXECUTABLE_PATH);
  }

  // 2. Try the camoufox npm package's managed binary
  if (camoufox) {
    try {
      const launchPath = camoufox.getLaunchPath();
      if (launchPath) {
        const fs = require('fs');
        if (fs.existsSync(launchPath)) {
          console.log('[Scraper] ✓ Camoufox binary from npm package:', launchPath);
          return launchPath;
        }
      }
    } catch (e) {
      console.warn('[Scraper] camoufox.getLaunchPath() failed:', e.message);
    }
  }

  // 3. Check default install locations
  const defaultPaths = getDefaultCamoufoxPaths();
  const fs = require('fs');
  for (const p of defaultPaths) {
    if (fs.existsSync(p)) {
      console.log('[Scraper] ✓ Camoufox found at default path:', p);
      return p;
    }
  }

  // 4. Not found
  console.log('[Scraper] ✗ Camoufox binary not found');
  return null;
}
// ─── Browser Launch ────────────────────────────────────────────────────────

/**
 * Launch a browser instance.
 *
 * Camoufox mode (default):
 *   Uses the Camoufox() async function which returns a Playwright Browser
 *   pre-configured for anti-fingerprinting. This is the recommended API.
 *
 * Firefox mode (fallback):
 *   Uses Playwright's managed Firefox via firefox.launch().
 */
async function launchBrowser() {
  if (!playwright) {
    throw new Error('Playwright is not installed. Run: npm install playwright');
  }

  if (browser) {
    logger.info('Scraper', 'Browser already running — returning existing instance');
    return getCurrentBrowser();
  }

  logger.info('Scraper', 'Launching browser...');
  logger.info('Scraper', '  Mode: ' + BROWSER_MODE);
  logger.info('Scraper', '  Headless: ' + HEADLESS);

  if (BROWSER_MODE === 'camoufox' && camoufox) {
    // Use Camoufox native API — returns a Playwright Browser
    // with proper anti-fingerprinting pre-configured
    var cfOpts = {
      headless: HEADLESS,
      os: ['macos', 'linux', 'windows'],
      window: [VIEWPORT.width, VIEWPORT.height],
    };

    try {
      browser = await camoufox.Camoufox(cfOpts);
      console.log('[Scraper] ✓ Camoufox launched via Camoufox() API');
    } catch (cfError) {
      console.warn('[Scraper] Camoufox() API failed:', cfError.message);
      console.warn('[Scraper] Falling back to executablePath approach...');

      // Fallback: use firefox.launch with Camoufox executable
      var execPath = resolveCamoufoxPath();
      if (execPath) {
        browser = await playwright.firefox.launch({ headless: HEADLESS, executablePath: execPath });
        console.log('[Scraper] ✓ Camoufox launched via firefox.launch + executablePath');
      } else {
        browser = await playwright.firefox.launch({ headless: HEADLESS });
        console.log('[Scraper] ✓ Launched Playwright-managed Firefox (Camoufox not found)');
      }
    }
  } else if (BROWSER_MODE === 'camoufox' && !camoufox) {
    // Camoufox requested but npm package not installed
    console.warn('[Scraper] ⚠ Camoufox npm package not installed.');
    console.warn('[Scraper] ⚠ Run: npm install camoufox');
    console.warn('[Scraper] ⚠ Falling back to Playwright-managed Firefox.');

    var execPath = resolveCamoufoxPath();
    if (execPath) {
      browser = await playwright.firefox.launch({ headless: HEADLESS, executablePath: execPath });
      console.log('[Scraper] ✓ Using Camoufox binary via executablePath:', execPath);
    } else {
      browser = await playwright.firefox.launch({ headless: HEADLESS });
      console.log('[Scraper] ✓ Using Playwright-managed Firefox (fallback)');
    }
  } else {
    // Explicit Firefox mode
    browser = await playwright.firefox.launch({ headless: HEADLESS });
    console.log('[Scraper] ✓ Using Playwright-managed Firefox');
  }

  console.log('[Scraper] ✓ Browser launched successfully');

  // IMPORTANT FIX: Do NOT pass `userAgent` when USER_AGENT is null.
  // Playwright interprets `null` as the literal string "null", which is
  // a dead giveaway to Cloudflare fingerprinting.
  //
  // Build the context options conditionally: only set userAgent when a
  // real UA string is provided. When omitted, the browser uses its native
  // UA which is internally consistent with its engine (Gecko for Firefox).
  const contextOptions = {};

  // For Camoufox, do NOT set viewport — its fingerprint patching is at
  // the C++ level and Playwright 1.62's setDefaultViewport CDP call is
  // incompatible.
  if (BROWSER_MODE === 'camoufox') {
    browserContext = await browser.newContext(contextOptions);
    console.log('[Scraper] ✓ Created Camoufox browser context');
  } else {
    contextOptions.viewport = { width: VIEWPORT.width, height: VIEWPORT.height };
    browserContext = await browser.newContext(contextOptions);
    console.log('[Scraper] ✓ Created browser context');
  }

  if (USER_AGENT) {
    // Apply UA AFTER context creation so we only set it when valid
    // (Playwright doesn't allow modifying UA on an existing context, so
    // we log it here; the context uses the native UA which is fine)
    console.log('[Scraper] ✓ Custom USER_AGENT env is set (note: using native UA for consistency)');
  } else {
    console.log('[Scraper] ✓ Using browser-native userAgent (no override — best for anti-detect)');
  }

  return getCurrentBrowser();
}

function getCurrentBrowser() {
  if (!browser) return null;
  return { browser, context: browserContext };
}

async function createPage() {
  if (!browser || !browserContext) {
    throw new Error('Browser is not running. Call launchBrowser() first.');
  }

  if (!browser.isConnected()) {
    console.warn('[Scraper] Browser disconnected — re-launching...');
    await closeBrowser();
    await launchBrowser();
  }

  const page = await browserContext.newPage();
  console.log('[Scraper] New page created');
  return page;
}

// ─── Navigation Test ───────────────────────────────────────────────────────

async function testNavigation() {
  if (!browser || !browserContext) {
    throw new Error('Browser is not running. Call launchBrowser() first.');
  }

  const page = await createPage();
  const startTime = Date.now();

  try {
    console.log('[Scraper] Navigating to TeacherOn:', TEACHERON_URL);

    // Use Playwright's 'load' event — waits for DOMContentLoaded +
    // all sub-resources. Preferable to setTimeout() because it's
    // tied to actual page state, not an arbitrary time guess.
    await page.goto(TEACHERON_URL, {
      waitUntil: 'load',
      timeout: NAVIGATION_TIMEOUT_MS,
    });

    const loadTimeMs = Date.now() - startTime;
    const url = page.url();
    const title = await page.title();

    console.log('[Scraper] Navigation complete');
    console.log('[Scraper]   URL:', url);
    console.log('[Scraper]   Title:', title);
    console.log('[Scraper]   Load time:', loadTimeMs, 'ms');

    return { success: true, url, title, loadTimeMs };
  } catch (error) {
    const loadTimeMs = Date.now() - startTime;
    console.error('[Scraper] Navigation failed:', error.message);
    return { success: false, url: TEACHERON_URL, title: null, loadTimeMs, error: error.message };
  } finally {
    if (page && !page.isClosed()) {
      await page.close();
      console.log('[Scraper] Test page closed');
    }
  }
}

// ─── Abort Controller (Phase 8) ────────────────────────────────────────────

/**
 * Create a fresh AbortController for a new scan.
 * Called by ipc-handlers before starting a scan.
 * @returns {AbortController}
 */
function createAbortController() {
  abortController = new AbortController();
  return abortController;
}

/**
 * Signal the current scan to abort.
 * Idempotent — safe to call multiple times or after scanning has finished.
 */
function abortScan() {
  if (abortController) {
    abortController.abort();
    logger.info('Scraper', 'Abort signal sent to active scan');
  }
}

/**
 * Get the current abort signal, or null if no scan is running.
 * @returns {AbortSignal|null}
 */
function getAbortSignal() {
  return abortController ? abortController.signal : null;
}

/**
 * Check whether the scan has been aborted.
 * @returns {boolean}
 */
function isAborted() {
  return !!(abortController && abortController.signal.aborted);
}

/**
 * Clear the abort controller after a scan completes or is stopped.
 */
function clearAbortController() {
  abortController = null;
}

// ─── Cleanup ───────────────────────────────────────────────────────────────

/**
 * Close the browser context and the browser safely.
 * Each step is wrapped in its own try/catch so one failure doesn't
 * prevent the other from running. After this, browser and context
 * are set to null regardless of errors.
 */
async function closeBrowser() {
  logger.info('Scraper', 'Closing browser...');

  if (browserContext) {
    try {
      await browserContext.close();
      logger.info('Scraper', 'Browser context closed');
    } catch (e) {
      logger.warn('Scraper', 'Error closing context: ' + e.message);
    }
    browserContext = null;
  }

  if (browser) {
    try {
      await browser.close();
      logger.info('Scraper', 'Browser closed');
    } catch (e) {
      logger.warn('Scraper', 'Error closing browser: ' + e.message);
    }
    browser = null;
  }

  // Also clear any lingering abort controller
  clearAbortController();
}

function isBrowserRunning() {
  return !!(browser && browser.isConnected());
}

// ─── Phase 4: Search Navigation ─────────────────────────────────────────────

/**
 * Build a TeacherOn search URL from subject and/or location.
 *
 * TeacherOn's current public search uses URL-based routing:
 *   https://www.teacheron.com/{subject-slug}-tutor-jobs
 *
 * Location filtering is NOT supported via URL at listing level;
 * cards will be filtered client-side when a location is provided.
 *
 * @param {string} [subject] — e.g. "Mathematics", "Physics"
 * @param {string} [location] — city/country name (for future use)
 * @returns {string} The search URL
 */
function buildSearchUrl(subject, location) {
  if (subject) {
    const slug = subject.trim().toLowerCase().replace(/\s+/g, '_');
    return `${TEACHERON_SEARCH_BASE_URL}/${slug}-tutor-jobs`;
  }
  return TEACHERON_LISTING_URL;
}

/**
 * Navigate to a TeacherOn listing/search page, wait for job cards.
 *
 * @param {import('playwright').Page} page — active Playwright page
 * @param {object} options
 * @param {string} [options.subject]
 * @param {string} [options.location]
 */
async function searchTeacherOn(page, options = {}) {
  const { subject, location } = options;

  if (!page || page.isClosed()) {
    throw new Error('Cannot search: page is closed or invalid.');
  }

  const url = buildSearchUrl(subject, location);

  console.log('[Scraper] Navigating to:', url);
  if (subject) console.log('[Scraper]   Subject:', subject);
  if (location) console.log('[Scraper]   Location (for extraction):', location);

  await page.goto(url, {
    waitUntil: 'load',
    timeout: NAVIGATION_TIMEOUT_MS,
  });

  try {
    await page.waitForSelector(
      `${LISTING_SELECTORS.card}, #noRecordFoundOnSearchDiv`,
      { timeout: NAVIGATION_TIMEOUT_MS }
    );
  } catch {
    console.warn('[Scraper] No job cards or "no results" div found on page.');
  }

  console.log('[Scraper] Search page loaded — URL:', page.url());
  return { url: page.url(), title: await page.title() };
}

// ─── Phase 4: Listing Extraction ───────────────────────────────────────────

/**
 * Extract all job listings from the current listing page.
 *
 * Scans .highlightDivOnHover cards and extracts:
 *   title, jobUrl, subjects, location, description, postedDate
 *
 * Fields not present on a card are set to null — never throws.
 * Duplicate URLs within the page are removed (first occurrence wins).
 * Relative URLs are resolved; invalid protocols are rejected (set to null).
 *
 * @param {import('playwright').Page} page — page on a TeacherOn listing URL
 * @returns {Promise<Array<object>>}
 */
async function scrapeListingPage(page) {
  if (!page || page.isClosed()) {
    throw new Error('Cannot scrape: page is closed or invalid.');
  }

  const sel = LISTING_SELECTORS;

  console.log('[Scraper] Extracting listings from page...');

  // Check for "no results" first
  const noResultsCount = await page.locator('#noRecordFoundOnSearchDiv').count();
  if (noResultsCount > 0) {
    const visible = await page.locator('#noRecordFoundOnSearchDiv').evaluate(
      (el) => window.getComputedStyle(el).display !== 'none'
    );
    if (visible) {
      console.log('[Scraper] No results found on this page.');
      return [];
    }
  }

  // Extract using $$eval for deterministic DOM access
  const rawListings = await page.$$eval(sel.card, (cards, selectors) => {
    return cards.map((cardEl) => {
      const titleEl = cardEl.querySelector(selectors.title);
      const titleText = titleEl ? titleEl.innerText.trim() : null;
      let rawUrl = titleEl ? titleEl.getAttribute('href') : null;

      const subjectEls = cardEl.querySelectorAll(selectors.subjects);
      const subjectList = Array.from(subjectEls).map((a) => a.innerText.trim());

      let locText = null;
      const locIcon = cardEl.querySelector(selectors.locationIcon);
      if (locIcon) {
        const li = locIcon.closest('li');
        if (li) locText = li.innerText.trim();
      }

      let dateText = null;
      const dateIcon = cardEl.querySelector(selectors.postedDateIcon);
      if (dateIcon) {
        const li = dateIcon.closest('li');
        if (li) dateText = li.innerText.trim();
      }

      const descEl = cardEl.querySelector(selectors.description);
      const descText = descEl ? descEl.innerText.trim() : null;

      return { title: titleText, jobUrl: rawUrl, subjects: subjectList, location: locText, description: descText, postedDate: dateText };
    });
  }, sel);

  // Post-process: normalize URLs, deduplicate, validate
  const seenUrls = new Set();
  const processed = [];

  for (const raw of rawListings) {
    let normalizedUrl = null;
    if (raw.jobUrl) {
      try {
        const resolved = new URL(raw.jobUrl, TEACHERON_SEARCH_BASE_URL);
        if (resolved.protocol === 'http:' || resolved.protocol === 'https:') {
          normalizedUrl = resolved.href;
        } else {
          console.warn('[Scraper] Invalid protocol:', resolved.protocol, raw.jobUrl);
        }
      } catch {
        console.warn('[Scraper] Malformed URL:', raw.jobUrl);
      }
    }

    if (!normalizedUrl) {
      if (raw.title) console.warn('[Scraper] Missing valid URL for:', raw.title);
      continue;
    }

    if (seenUrls.has(normalizedUrl)) {
      console.log('[Scraper] Skipping duplicate:', normalizedUrl);
      continue;
    }
    seenUrls.add(normalizedUrl);

    processed.push({
      title: raw.title || null,
      jobUrl: normalizedUrl,
      subjects: raw.subjects || [],
      location: raw.location || null,
      description: raw.description || null,
      postedDate: raw.postedDate || null,
    });
  }

  console.log(`[Scraper] ${rawListings.length} card(s) → ${processed.length} unique listing(s)`);
  return processed;
}

// ─── Exports ───────────────────────────────────────────────────────────────
// ─── Phase 5: Pagination ───────────────────────────────────────────────────
//
// TeacherOn pagination mechanism (verified live DOM 2026-04-09):
//   ul.pagination contains numbered page links + prev/next <a> elements.
//   Page URLs use query parameter ?p=N (page 1 = no parameter).
//   Next page link: a[title="Next page"] inside li.next-page.
//   On the last page, li.next-page is absent or the "Next" link is gone.

/**
 * Wait for a Cloudflare challenge to auto-solve (if it's a JS challenge)
 * or return after the retry window if it's a hard block.
 *
 * TeacherOn uses "Attention Required! | Cloudflare" which is typically
 * a hard block — but sometimes it's a JavaScript challenge that auto-solves
 * after a few seconds with a valid browser fingerprint.
 *
 * This function waits, reloads the page, then checks again. Returns true
 * only if the challenge persists.
 *
 * @param {import('playwright').Page} page
 * @returns {Promise<boolean>} true if still blocked after retry
 */
async function waitForCloudflareResolution(page) {
  if (!page || page.isClosed()) return false;

  console.log(`[Scraper] Cloudflare challenge detected — waiting ${CLOUDFLARE_RETRY_MS}ms for auto-solve...`);
  await page.waitForTimeout(CLOUDFLARE_RETRY_MS);

  // Try reloading — sometimes the challenge clears on the second load
  try {
    if (!page.isClosed()) {
      await page.reload({ waitUntil: 'domcontentloaded', timeout: NAVIGATION_TIMEOUT_MS })
        .catch(() => {});
      console.log('[Scraper] Page reloaded after Cloudflare wait');
    }
  } catch {
    // Ignore reload errors — page might be closed
  }

  // Give the page time to render
  await page.waitForTimeout(3000);

  // Check again
  return await isBlockedByCloudflare(page);
}

/**
 * Detect if the current page shows a Cloudflare challenge.
 * Uses page title and body text signals — does NOT attempt to bypass.
 */
async function isBlockedByCloudflare(page) {
  try {
    if (page.isClosed()) return false;
    const title = await page.title();
    for (const pattern of CLOUDFLARE_TITLE_PATTERNS) {
      if (title && title.toLowerCase().includes(pattern.toLowerCase())) {
        console.warn(`[Scraper] ⚠️ Cloudflare challenge detected — title: "${title}"`);
        return true;
      }
    }
    const bodyText = await page.evaluate(() => document.body.innerText || '');
    for (const pattern of CLOUDFLARE_BODY_PATTERNS) {
      if (bodyText.includes(pattern)) {
        console.warn(`[Scraper] ⚠️ Cloudflare challenge detected — body: "${pattern}"`);
        return true;
      }
    }
    return false;
  } catch {
    return false;
  }
}

/**
 * Extract the next-page URL from the pagination controls.
 * Returns null if no next page exists, link is disabled, or invalid.
 */
async function getNextPageUrl(page) {
  try {
    const sel = PAGINATION_SELECTORS;
    const containerCount = await page.locator(sel.container).count();
    if (containerCount === 0) {
      console.log('[Scraper] No pagination container found — no next page.');
      return null;
    }
    const nextLinkCount = await page.locator(sel.nextPageLink).count();
    if (nextLinkCount === 0) {
      console.log('[Scraper] No "Next page" link found — last page reached.');
      return null;
    }
    const href = await page.locator(sel.nextPageLink).getAttribute('href');
    if (!href || href.trim() === '') {
      console.log('[Scraper] Next-page link exists but has no href.');
      return null;
    }
    const resolved = new URL(href, TEACHERON_SEARCH_BASE_URL);
    if (resolved.protocol !== 'http:' && resolved.protocol !== 'https:') {
      console.warn('[Scraper] Invalid next-page URL protocol:', resolved.protocol);
      return null;
    }
    console.log('[Scraper] Next-page URL:', resolved.href);
    return resolved.href;
  } catch (error) {
    console.warn('[Scraper] Error extracting next-page URL:', error.message);
    return null;
  }
}

/**
 * Get the current active page number from the pagination UI.
 */
async function getCurrentPageNumber(page) {
  try {
    const count = await page.locator(PAGINATION_SELECTORS.activePage).count();
    if (count === 0) return null;
    const text = await page.locator(PAGINATION_SELECTORS.activePage).innerText();
    const num = parseInt(text.trim(), 10);
    return Number.isNaN(num) ? null : num;
  } catch {
    return null;
  }
}
/**
 * Navigate to the next listing page and wait for cards to appear.
 * Includes configurable delay for anti-bot pacing.
 */
async function navigateToNextPage(page, url, delayMs = PAGE_DELAY_MS) {
  try {
    console.log(`[Scraper] Navigating to next page: ${url}`);
    if (delayMs > 0) {
      console.log(`[Scraper] Pacing delay ${delayMs}ms before navigation...`);
      await page.waitForTimeout(delayMs);
    }
    await page.goto(url, { waitUntil: 'domcontentloaded', timeout: NAVIGATION_TIMEOUT_MS });
    await page.waitForSelector(
      `${LISTING_SELECTORS.card}, #noRecordFoundOnSearchDiv`,
      { timeout: 15000 }
    ).catch(() => {
      console.warn('[Scraper] Listing cards did not appear after navigation.');
    });
    // Cloudflare detection is handled by the caller (scrapePages)
    return true;
  } catch (error) {
    logger.error('Scraper', 'Navigation error on next page: ' + error.message);
    return false;
  }
}

/**
 * Scrape multiple listing pages using TeacherOn pagination controls.
 * Reuses scrapeListingPage() for each page. Deduplicates across pages.
 * Uses a Set of visited URLs to prevent infinite loops.
 *
 * @param {import('playwright').Page} page — already navigated to page 1
 * @param {{maxPages?: number, delayMs?: number}} [options]
 * @returns {Promise<{listings: Array, pagesScraped: number, stoppedReason: string}>}
 */
async function scrapePages(page, options = {}) {
  const maxPages = options.maxPages || MAX_PAGES;
  const delayMs = options.delayMs ?? PAGE_DELAY_MS;

  if (!page || page.isClosed()) {
    return { listings: [], pagesScraped: 0, stoppedReason: 'page-closed' };
  }

  const allListings = [];
  const seenUrls = new Set();
  const visitedPageUrls = new Set();
  let pagesScraped = 0;
  let stoppedReason = 'max-pages';

  try {
    const currentUrl = page.url();
    visitedPageUrls.add(currentUrl);

    // Phase 8: Check abort signal before starting
    if (isAborted()) {
      return { listings: allListings, pagesScraped: 0, stoppedReason: 'user-aborted' };
    }

    if (await isBlockedByCloudflare(page)) {
      return { listings: [], pagesScraped: 0, stoppedReason: 'cloudflare_block' };
    }

    const currentPageNum = await getCurrentPageNumber(page);
    console.log(`\n[Scraper] ═══ Page ${currentPageNum || 1} ═══`);

    const page1Listings = await scrapeListingPage(page);
    pagesScraped = 1;

    for (const listing of page1Listings) {
      if (!seenUrls.has(listing.jobUrl)) {
        seenUrls.add(listing.jobUrl);
        allListings.push(listing);
      }
    }
    console.log(
      `[Scraper] Page ${pagesScraped}: ${page1Listings.length} card(s) → total unique: ${allListings.length}`
    );

    if (maxPages <= 1 || isAborted()) {
      stoppedReason = isAborted() ? 'user-aborted' : 'max-pages';
      return { listings: allListings, pagesScraped, stoppedReason };
    }

    let nextUrl = await getNextPageUrl(page);

    while (nextUrl && pagesScraped < maxPages) {
      // Phase 8: Check abort signal before each page navigation
      if (isAborted()) {
        console.log('[Scraper] Abort signal detected — stopping pagination');
        stoppedReason = 'user-aborted';
        break;
      }

      if (visitedPageUrls.has(nextUrl)) {
        console.warn(`[Scraper] Already visited ${nextUrl} — stopping to prevent loop.`);
        stoppedReason = 'duplicate-page';
        break;
      }

      // Phase 8: Catch per-page errors so we preserve previous results
      let navSuccess = false;
      try {
        navSuccess = await navigateToNextPage(page, nextUrl, delayMs);
      } catch (navError) {
        console.error('[Scraper] Navigation error on page', pagesScraped + 1, ':', navError.message);
        // Check if page/browser is still alive
        if (page.isClosed()) {
          console.warn('[Scraper] Page was closed during navigation — stopping');
          stoppedReason = 'page-closed';
          break;
        }
        stoppedReason = 'navigation-error';
        break;
      }

      if (!navSuccess) {
        stoppedReason = 'navigation-error';
        break;
      }

      visitedPageUrls.add(nextUrl);

      // Phase 8: Check page health before scraping
      if (page.isClosed()) {
        console.warn('[Scraper] Page closed mid-pagination — stopping');
        stoppedReason = 'page-closed';
        break;
      }

      try {
        if (await isBlockedByCloudflare(page)) {
          console.log('[Scraper] Cloudflare challenge detected on page ' + (pagesScraped + 1));
          // Wait and retry once before giving up — Cloudflare JS challenges
          // sometimes auto-solve after a few seconds with a valid fingerprint
          const retryBlocked = await waitForCloudflareResolution(page);
          if (retryBlocked) {
            stoppedReason = 'cloudflare_block';
            break;
          }
          console.log('[Scraper] Cloudflare challenge resolved after wait — continuing');
        }
      } catch (cfError) {
        logger.warn('Scraper', 'Cloudflare check failed: ' + cfError.message);
        // Not critical — continue scraping
      }

      const pageNum = await getCurrentPageNumber(page);
      console.log(`\n[Scraper] ═══ Page ${pageNum || pagesScraped + 1} ═══`);

      // Phase 8: Catch per-page scrape errors — preserve existing results
      let pageListings = [];
      try {
        pageListings = await scrapeListingPage(page);
      } catch (scrapeError) {
        logger.error('Scraper', 'Scrape error on page ' + (pagesScraped + 1) + ': ' + scrapeError.message);
        stoppedReason = 'scrape-error';
        break;
      }
      pagesScraped++;

      if (pageListings.length === 0) {
        logger.info('Scraper', 'Page ' + pagesScraped + ' has no listings — stopping.');
        stoppedReason = 'empty-page';
        break;
      }

      let addedCount = 0;
      for (const listing of pageListings) {
        if (!seenUrls.has(listing.jobUrl)) {
          seenUrls.add(listing.jobUrl);
          allListings.push(listing);
          addedCount++;
        }
      }

      const dupes = pageListings.length - addedCount;
      logger.info('Scraper', 'Page ' + pagesScraped + ': ' + pageListings.length + ' card(s) → ' +
        addedCount + ' new, ' + dupes + ' dupes → total unique: ' + allListings.length);

      try {
        nextUrl = await getNextPageUrl(page);
      } catch (nextError) {
        logger.warn('Scraper', 'Error getting next page URL: ' + nextError.message);
        nextUrl = null;
      }
    }

    if (isAborted()) {
      stoppedReason = 'user-aborted';
    } else if (pagesScraped >= maxPages) {
      stoppedReason = 'max-pages';
    } else if (!nextUrl) {
      stoppedReason = 'no-next-page';
    }
  } catch (error) {
    logger.error('Scraper', 'Pagination error: ' + error.message);
    stoppedReason = 'navigation-error';
  }

  logger.info('Scraper', 'Pagination complete: ' + pagesScraped + ' pages, ' +
    allListings.length + ' unique listings, stopped: ' + stoppedReason);

  return { listings: allListings, pagesScraped, stoppedReason };
}

module.exports = {
  launchBrowser,
  closeBrowser,
  createPage,
  testNavigation,
  searchTeacherOn,
  scrapeListingPage,
  scrapePages,
  isBlockedByCloudflare,
  waitForCloudflareResolution,
  getNextPageUrl,
  getCurrentBrowser,
  isBrowserRunning,
  // Phase 8: Scan lifecycle
  createAbortController,
  abortScan,
  getAbortSignal,
  isAborted,
  clearAbortController,
};