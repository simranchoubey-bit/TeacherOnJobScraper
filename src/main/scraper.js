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
 *   Resolves the Camoufox executable path and launches it through
 *   Playwright's Firefox launcher (firefox.launch with executablePath).
 *   This avoids the Camoufox() async function's incompatible
 *   Browser.setDefaultViewport CDP payload in the current Playwright version.
 *   If the Camoufox binary cannot be found, falls back to Playwright's
 *   managed Firefox.
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

  if (BROWSER_MODE === 'camoufox') {
    // Resolve Camoufox executable path (env var → npm getLaunchPath → default paths)
    const execPath = resolveCamoufoxPath();

    if (execPath) {
      console.log('[Scraper] Camoufox executable: ' + execPath);
      browser = await playwright.firefox.launch({
        headless: HEADLESS,
        executablePath: execPath
      });
      console.log('[Scraper] ✓ Camoufox launched via Playwright Firefox executable');
    } else {
      // Camoufox binary not found — fall back to Playwright's managed Firefox
      console.warn('[Scraper] ⚠ Camoufox binary not found — falling back to Playwright-managed Firefox.');
      browser = await playwright.firefox.launch({
        headless: HEADLESS
      });
      console.log('[Scraper] ✓ Launched Playwright-managed Firefox (Camoufox not found)');
    }
  } else {
    // Explicit Firefox mode
    browser = await playwright.firefox.launch({ headless: HEADLESS });
    console.log('[Scraper] ✓ Using Playwright-managed Firefox');
  }

  console.log('[Scraper] ✓ Browser launched successfully');

  // Create the browser context.
  // The `userAgent` option is only set when a real UA string exists.
  // When USER_AGENT is null (default), the browser uses its native UA —
  // the internally consistent Gecko UA for Firefox/Camoufox.

  // Build context options conditionally:
  // - Camoufox mode: viewport must be null (disable) to avoid the
  //   incompatible Browser.setDefaultViewport CDP payload.
  // - Firefox mode: use the standard viewport dimensions.
  // - userAgent is only included when USER_AGENT is a real string.
  const contextOptions = {};

  if (BROWSER_MODE === 'camoufox') {
    // Camoufox mode: disable viewport entirely.
    contextOptions.viewport = null;
  } else {
    // Normal Firefox mode: use standard viewport.
    contextOptions.viewport = {
      width: VIEWPORT.width,
      height: VIEWPORT.height
    };
  }

  if (USER_AGENT) {
    contextOptions.userAgent = USER_AGENT;
  }

  browserContext = await browser.newContext(contextOptions);

  if (BROWSER_MODE === 'camoufox') {
    console.log('[Scraper] ✓ Created Camoufox browser context (viewport disabled)');
  } else {
    console.log('[Scraper] ✓ Created browser context');
  }

  if (USER_AGENT) {
    console.log('[Scraper] ✓ Custom USER_AGENT env is set');
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

// ─── Phase 4.5: Scrolling ──────────────────────────────────────────────────

/**
 * Scroll the TeacherOn results container (or the document) gradually,
 * in small increments with brief waits, to trigger any lazy-loaded cards.
 *
 * Behavior:
 *   - Detects the listing container (#tutorOrJobSearchItemList) if it exists
 *     and is scrollable. Otherwise scrolls the document/window.
 *   - Scrolls gradually (≈0.8 viewport per step) rather than jumping to bottom.
 *   - Waits briefly (≈120ms) between scroll steps for lazy-load triggers.
 *   - Detects when the bottom has been reached and stops.
 *   - Respects the abort signal.
 *   - Hard cap on iterations to prevent infinite loops.
 *
 * @param {import('playwright').Page} page
 * @returns {Promise<{containerScrollable: boolean, steps: number, reachedBottom: boolean}>}
 */
async function scrollResultsPage(page) {
  if (!page || page.isClosed()) return { containerScrollable: false, steps: 0, reachedBottom: false };

  console.log('[Scraper] scrolling results...');

  // Determine scroll context: prefer the listing container.
  const scrollPlan = await page.evaluate(() => {
    const container = document.querySelector('#tutorOrJobSearchItemList');
    const doc = document.documentElement;
    const maxScrollSteps = 40;

    // Determine which element to scroll.
    let target = null;
    let isContainerScrollable = false;

    if (container) {
      const cs = window.getComputedStyle(container);
      // A container is scrollable when its content overflows its client area.
      if (container.scrollHeight > container.clientHeight + 10) {
        target = container;
        isContainerScrollable = true;
      }
    }
    if (!target) {
      // Fall back to the document/window.
      const docScrollable = (doc.scrollHeight - doc.clientHeight) > 10;
      if (docScrollable) {
        target = doc;
      }
    }
    if (!target) {
      return { hasTarget: false, isContainerScrollable: false, totalSteps: 0, maxSteps: maxScrollSteps };
    }

    const totalSteps = isContainerScrollable
      ? Math.max(1, Math.ceil((container.scrollHeight - container.clientHeight) / (container.clientHeight * 0.8)))
      : Math.max(1, Math.ceil((doc.scrollHeight - doc.clientHeight) / (doc.clientHeight * 0.8)));

    return {
      hasTarget: true,
      isContainerScrollable,
      totalSteps: Math.min(totalSteps, maxScrollSteps),
      maxSteps: maxScrollSteps,
    };
  });

  if (!scrollPlan || !scrollPlan.hasTarget) {
    console.log('[Scraper] No scrollable results container / document found — nothing to scroll.');
    return { containerScrollable: false, steps: 0, reachedBottom: true };
  }

  console.log(
    `[Scraper] ${scrollPlan.isContainerScrollable ? 'Scrolling results container' : 'Scrolling document'} — ${scrollPlan.totalSteps} step(s)`
  );

  let steps = 0;
  let reachedBottom = false;

  for (let i = 0; i < scrollPlan.totalSteps; i++) {
    // Respect abort signal — stop scrolling if user cancelled.
    if (isAborted()) {
      console.log('[Scraper] Abort signal — stopping scroll routine.');
      break;
    }

    const info = await page.evaluate(({ useContainer }) => {
      const container = document.querySelector('#tutorOrJobSearchItemList');
      const isContainerScrollable = useContainer && container && (container.scrollHeight > container.clientHeight + 10);
      let scrollAmount = 0;

      if (isContainerScrollable) {
        scrollAmount = Math.min(
          container.clientHeight * 0.8,
          container.scrollHeight - container.scrollTop - container.clientHeight
        );
        container.scrollTop += scrollAmount;
        return {
          atBottom: container.scrollTop + container.clientHeight >= container.scrollHeight - 10,
          scrollTop: container.scrollTop,
          scrollHeight: container.scrollHeight,
        };
      }
      // Document scroll.
      scrollAmount = Math.min(
        window.innerHeight * 0.8,
        document.documentElement.scrollHeight - window.scrollY - window.innerHeight
      );
      window.scrollBy(0, scrollAmount);
      return {
        atBottom: window.scrollY + window.innerHeight >= document.documentElement.scrollHeight - 10,
        scrollTop: window.scrollY,
        scrollHeight: document.documentElement.scrollHeight,
      };
    }, { useContainer: scrollPlan.isContainerScrollable });

    steps++;

    if (info.atBottom) {
      reachedBottom = true;
      console.log(`[Scraper] reached bottom at step ${steps}`);
      break;
    }

    // Brief wait between scroll steps — allows lazy-load to fire.
    await page.waitForTimeout(120);
  }

  if (!reachedBottom) {
    console.log(`[Scraper] scroll routine finished after ${steps} step(s) without explicit bottom`);
  }

  return {
    containerScrollable: !!scrollPlan.isContainerScrollable,
    steps,
    reachedBottom,
  };
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
 * @param {object} [options]
 * @param {boolean} [options.scroll=true] — if true, runs the scroll routine
 *   before extracting. Keep this independent of the extraction itself:
 *   all cards already present in the DOM are always extracted.
 * @param {string} [options.pageLabel=''] — e.g. 'Page 1' for logging
 * @returns {Promise<Array<object>>}
 */
async function scrapeListingPage(page, options = {}) {
  const { scroll = true, pageLabel = '' } = options;

  if (!page || page.isClosed()) {
    throw new Error('Cannot scrape: page is closed or invalid.');
  }

  const sel = LISTING_SELECTORS;
  const prefix = pageLabel ? `[Scraper] ${pageLabel}: ` : '[Scraper] ';

  // Count cards before any scrolling — we want to know how many are
  // already in the DOM vs. how many appear after scrolling.
  const beforeScrollCount = await page.locator(sel.card).count();
  console.log(`${prefix}found ${beforeScrollCount} cards before scrolling`);

  // Check for "no results" first
  const noResultsCount = await page.locator('#noRecordFoundOnSearchDiv').count();
  if (noResultsCount > 0) {
    const visible = await page.locator('#noRecordFoundOnSearchDiv').evaluate(
      (el) => window.getComputedStyle(el).display !== 'none'
    );
    if (visible) {
      console.log(`${prefix}No results found on this page.`);
      return [];
    }
  }

  // Scroll the results container / document to trigger any lazy-loaded cards.
  // This is separate from extraction — even if scrolling finds nothing new,
  // the cards already present are still extracted below.
  let scrollResult = null;
  if (scroll) {
    console.log(`${prefix}scrolling results`);
    scrollResult = await scrollResultsPage(page);
    if (scrollResult && scrollResult.steps === 0) {
      console.log(`${prefix}no scrolling needed (content fits viewport)`);
    }
  }

  // Double-check page is still alive after scrolling
  if (page.isClosed()) {
    throw new Error('Page closed during scroll routine.');
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

  console.log(`${prefix}extracted ${processed.length} jobs from ${rawListings.length} card(s)`);
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
 *
 * Tries, in order:
 *   1. The configured PAGINATION_SELECTORS.nextPageLink (a[title="Next page"]).
 *   2. Any pagination link whose visible text is ">" or contains "next".
 *   3. Any pagination link whose aria-label / title contains "next".
 *   4. If a numeric pagination link exists next to the active page, take its href.
 *
 * Returns null if no next page exists, link is disabled, or invalid.
 * For numeric fallback (option 4), the URL is composed from the active page
 * number's +1 href if it exists, otherwise constructed with ?p=N+1.
 */
async function getNextPageUrl(page) {
  try {
    const sel = PAGINATION_SELECTORS;
    const currentUrl = page.url();
    const base = TEACHERON_SEARCH_BASE_URL;

    // Helper to validate and resolve a candidate href.
    function resolveHref(rawHref) {
      if (!rawHref || rawHref.trim() === '') return null;
      try {
        const resolved = new URL(rawHref, base);
        if (resolved.protocol !== 'http:' && resolved.protocol !== 'https:') {
          console.warn('[Scraper] Invalid next-page URL protocol:', resolved.protocol, rawHref);
          return null;
        }
        // Don't return the same URL we're currently on (would loop).
        if (resolved.href === currentUrl) {
          console.log('[Scraper] Next-page URL is identical to current URL — ignoring.');
          return null;
        }
        return resolved.href;
      } catch {
        return null;
      }
    }

    // 1. Primary: configured `a[title="Next page"]` selector.
    const nextLinkCount = await page.locator(sel.nextPageLink).count();
    if (nextLinkCount > 0) {
      const href = await page.locator(sel.nextPageLink).getAttribute('href');
      const resolved = resolveHref(href);
      if (resolved) {
        console.log('[Scraper] Next-page URL (primary link):', resolved);
        return resolved;
      }
      // Link exists but href is missing/empty — maybe it's a JS-triggered button.
      console.log('[Scraper] Next-page link exists but has no usable href.');
    }

    // 2. Fallback: any pagination link whose text is ">" or contains "next"/"Next".
    const paginationText = await page.evaluate(() => {
      const container = document.querySelector('ul.pagination');
      if (!container) return null;
      const links = container.querySelectorAll('a');
      for (const a of links) {
        const text = (a.innerText || a.textContent || '').trim();
        const title = (a.getAttribute('title') || '').toLowerCase();
        const aria = (a.getAttribute('aria-label') || '').toLowerCase();
        if (text === '>' || text === '»' || text === '›' ||
            text.toLowerCase().includes('next') ||
            title.includes('next') || aria.includes('next')) {
          return {
            href: a.getAttribute('href'),
            text,
            title: a.getAttribute('title'),
          };
        }
      }
      return null;
    });
    if (paginationText && paginationText.href) {
      const resolved = resolveHref(paginationText.href);
      if (resolved) {
        console.log('[Scraper] Next-page URL (fallback: pagination text → href):', resolved);
        return resolved;
      }
    }

    // 3. Fallback: find the page-number link right after the active page.
    const nextByPageNum = await page.evaluate(() => {
      const container = document.querySelector('ul.pagination');
      if (!container) return null;
      const active = container.querySelector('li.active');
      if (!active) return null;
      const link = active.nextElementSibling ? active.nextElementSibling.querySelector('a') : null;
      if (link) {
        return {
          href: link.getAttribute('href'),
          text: (link.innerText || link.textContent || '').trim(),
        };
      }
      return null;
    });
    if (nextByPageNum && nextByPageNum.href) {
      const resolved = resolveHref(nextByPageNum.href);
      if (resolved) {
        console.log('[Scraper] Next-page URL (next sibling page link):', resolved);
        return resolved;
      }
    }

    // 4. Fallback: construct ?p=N+1 from the current page number.
    const pageNum = await getCurrentPageNumber(page);
    if (pageNum) {
      const constructed = currentUrl.includes('?')
        ? currentUrl.replace(/[?&]p=\d+/, `?p=${pageNum + 1}`)
        : currentUrl + `?p=${pageNum + 1}`;
      const resolved = resolveHref(constructed);
      if (resolved && resolved !== currentUrl) {
        console.log(`[Scraper] Next-page URL (constructed ?p=${pageNum + 1}):`, resolved);
        return resolved;
      }
    }

    console.log('[Scraper] No next-page control found — last page reached.');
    return null;
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
 *
 * Verifies the page URL or page number actually changed after navigation,
 * so we don't get stuck scraping the same page repeatedly.
 *
 * @param {import('playwright').Page} page
 * @param {string} url — the next page URL
 * @param {number} [delayMs] — anti-bot pacing delay
 * @param {number} [pageNum] — expected page number (for verification)
 * @returns {Promise<{success: boolean, urlChanged: boolean, pageNumChanged: boolean}>}
 */
async function navigateToNextPage(page, url, delayMs = PAGE_DELAY_MS, pageNum = null) {
  try {
    const beforeUrl = page.url();
    const beforePageNum = pageNum || await getCurrentPageNumber(page);

    console.log(`[Scraper] Navigating to page ${(beforePageNum || 1) + 1}: ${url}`);
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

    // Verify the page changed.
    const afterUrl = page.url();
    const afterPageNum = await getCurrentPageNumber(page);
    const urlChanged = afterUrl !== beforeUrl;
    const pageNumChanged = (afterPageNum !== null && afterPageNum !== beforePageNum) ||
      (afterPageNum !== null && beforePageNum === null);

    if (urlChanged) {
      console.log(`[Scraper] Page navigated to: ${afterUrl}`);
    } else {
      console.warn('[Scraper] ⚠ URL did not change after navigation — may be stuck on same page.');
    }

    // Cloudflare detection is handled by the caller (scrapePages)
    return { success: true, urlChanged, pageNumChanged };
  } catch (error) {
    logger.error('Scraper', 'Navigation error on next page: ' + error.message);
    return { success: false, urlChanged: false, pageNumChanged: false };
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
    console.log(`[Scraper] Page 1 loaded`);

    // ---- Page 1: scroll → extract → dedupe ----
    let page1Listings = [];
    try {
      page1Listings = await scrapeListingPage(page, {
        scroll: true,
        pageLabel: 'Page 1',
      });
    } catch (scrapeError) {
      logger.error('Scraper', 'Page 1 scrape error: ' + scrapeError.message);
      stoppedReason = 'scrape-error';
      return { listings: [], pagesScraped: 0, stoppedReason };
    }
    pagesScraped = 1;

    for (const listing of page1Listings) {
      if (!seenUrls.has(listing.jobUrl)) {
        seenUrls.add(listing.jobUrl);
        allListings.push(listing);
      }
    }
    console.log(`[Scraper] Page 1: extracted ${page1Listings.length} jobs`);
    console.log(`[Scraper] Page 1: total unique so far: ${allListings.length}`);

    if (maxPages <= 1 || isAborted()) {
      stoppedReason = isAborted() ? 'user-aborted' : 'max-pages';
      if (maxPages <= 1) console.log(`[Scraper] Reached MAX_PAGES=${maxPages}`);
      return { listings: allListings, pagesScraped, stoppedReason };
    }

    let nextUrl = await getNextPageUrl(page);
    if (nextUrl) {
      console.log(`[Scraper] Page 1: next page detected: ${nextUrl}`);
    } else {
      console.log('[Scraper] Page 1: no next page detected');
    }

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

      const nextPageNum = pagesScraped + 1;

      // Phase 8: Catch per-page errors so we preserve previous results
      let navResult = null;
      try {
        navResult = await navigateToNextPage(page, nextUrl, delayMs);
      } catch (navError) {
        console.error('[Scraper] Navigation error on page', nextPageNum, ':', navError.message);
        // Check if page/browser is still alive
        if (page.isClosed()) {
          console.warn('[Scraper] Page was closed during navigation — stopping');
          stoppedReason = 'page-closed';
          break;
        }
        stoppedReason = 'navigation-error';
        break;
      }

      if (!navResult || !navResult.success) {
        stoppedReason = 'navigation-error';
        break;
      }

      visitedPageUrls.add(nextUrl);

      // Verify the page actually changed — if neither URL nor page number
      // changed, we're stuck on the same page. Stop to avoid a loop.
      const changed = navResult.urlChanged || navResult.pageNumChanged;
      if (!changed) {
        console.warn('[Scraper] ⚠ Page did not change after navigation — stopping to prevent loop.');
        stoppedReason = 'no-page-change';
        break;
      }

      console.log(`[Scraper] Navigating to page ${nextPageNum}`);
      console.log(`[Scraper] Page ${nextPageNum} loaded`);

      try {
        if (await isBlockedByCloudflare(page)) {
          console.log(`[Scraper] Cloudflare challenge detected on page ${nextPageNum}`);
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

      // Phase 8: Check page health before scraping
      if (page.isClosed()) {
        console.warn('[Scraper] Page closed mid-pagination — stopping');
        stoppedReason = 'page-closed';
        break;
      }

      const pageNum = await getCurrentPageNumber(page);
      console.log(`\n[Scraper] ═══ Page ${pageNum || nextPageNum} ═══`);

      // Phase 8: Catch per-page scrape errors — preserve existing results
      let pageListings = [];
      try {
        pageListings = await scrapeListingPage(page, {
          scroll: true,
          pageLabel: `Page ${nextPageNum}`,
        });
      } catch (scrapeError) {
        logger.error('Scraper', 'Scrape error on page ' + nextPageNum + ': ' + scrapeError.message);
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
      console.log(`[Scraper] Page ${pagesScraped}: extracted ${pageListings.length} jobs (${addedCount} new, ${dupes} dupes)`);
      logger.info('Scraper', 'Page ' + pagesScraped + ': ' + pageListings.length + ' card(s) → ' +
        addedCount + ' new, ' + dupes + ' dupes → total unique: ' + allListings.length);

      try {
        nextUrl = await getNextPageUrl(page);
        if (nextUrl) {
          console.log(`[Scraper] Page ${pagesScraped}: next page detected: ${nextUrl}`);
        } else {
          console.log(`[Scraper] Page ${pagesScraped}: no next page detected`);
        }
      } catch (nextError) {
        logger.warn('Scraper', 'Error getting next page URL: ' + nextError.message);
        nextUrl = null;
      }
    }

    if (isAborted()) {
      stoppedReason = 'user-aborted';
    } else if (pagesScraped >= maxPages) {
      stoppedReason = 'max-pages';
      console.log(`[Scraper] Reached MAX_PAGES=${maxPages}`);
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
  scrollResultsPage,
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