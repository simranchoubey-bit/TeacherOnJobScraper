// src/main/scraper.js
// Browser automation + TeacherOn listing-page scraping for Electron main process.
// Playwright/Camoufox objects are NEVER exposed to the renderer.

let playwright;
try { playwright = require('playwright'); }
catch { console.error('[Scraper] Playwright not installed — run: npm install playwright'); playwright = null; }

let camoufox;
try { camoufox = require('camoufox'); }
catch { console.log('[Scraper] Camoufox npm package not installed — will use Firefox fallback'); camoufox = null; }

const logger = require('./logger');

const {
  BROWSER_MODE, HEADLESS, CAMOUFOX_EXECUTABLE_PATH,
  TEACHERON_URL, TEACHERON_LISTING_URL, TEACHERON_SEARCH_BASE_URL,
  LISTING_SELECTORS, PAGINATION_SELECTORS,
  MAX_PAGES, PAGE_DELAY_MS,
  CLOUDFLARE_TITLE_PATTERNS, CLOUDFLARE_BODY_PATTERNS,
  CLOUDFLARE_RETRY_MS, NAVIGATION_TIMEOUT_MS,
  VIEWPORT, USER_AGENT, getDefaultCamoufoxPaths,
} = require('./config');

let browser = null;
let browserContext = null;
let abortController = null; // signals in-flight scans to stop at page boundaries

// ─── Camoufox Executable Detection ─────────────────────────────────────────

/** Resolve Camoufox binary: env var → npm getLaunchPath → defaults → null (Firefox fallback). */
function resolveCamoufoxPath() {
  const fs = require('fs');
  const exists = p => fs.existsSync(p);

  if (CAMOUFOX_EXECUTABLE_PATH) {
    if (exists(CAMOUFOX_EXECUTABLE_PATH)) {
      console.log('[Scraper] ✓ Camoufox binary from CAMOUFOX_EXECUTABLE_PATH:', CAMOUFOX_EXECUTABLE_PATH);
      return CAMOUFOX_EXECUTABLE_PATH;
    }
    console.warn('[Scraper] CAMOUFOX_EXECUTABLE_PATH is set but file not found:', CAMOUFOX_EXECUTABLE_PATH);
  }

  if (camoufox) {
    try {
      const lp = camoufox.getLaunchPath();
      if (lp && exists(lp)) { console.log('[Scraper] ✓ Camoufox binary from npm package:', lp); return lp; }
    } catch (e) { console.warn('[Scraper] camoufox.getLaunchPath() failed:', e.message); }
  }

  for (const p of getDefaultCamoufoxPaths()) {
    if (exists(p)) { console.log('[Scraper] ✓ Camoufox found at default path:', p); return p; }
  }

  console.log('[Scraper] ✗ Camoufox binary not found');
  return null;
}

// ─── Browser Launch ────────────────────────────────────────────────────────

/** Launch a browser (Camoufox via Playwright Firefox, or managed Firefox fallback). */
async function launchBrowser() {
  if (!playwright) throw new Error('Playwright is not installed. Run: npm install playwright');

  if (browser) {
    logger.info('Scraper', 'Browser already running — returning existing instance');
    return getCurrentBrowser();
  }

  logger.info('Scraper', 'Launching browser...');
  logger.info('Scraper', '  Mode: ' + BROWSER_MODE);
  logger.info('Scraper', '  Headless: ' + HEADLESS);

  if (BROWSER_MODE === 'camoufox') {
    const execPath = resolveCamoufoxPath();
    if (execPath) {
      console.log('[Scraper] Camoufox executable: ' + execPath);
      browser = await playwright.firefox.launch({ headless: HEADLESS, executablePath: execPath });
      console.log('[Scraper] ✓ Camoufox launched via Playwright Firefox executable');
    } else {
      console.warn('[Scraper] ⚠ Camoufox binary not found — falling back to Playwright-managed Firefox.');
      browser = await playwright.firefox.launch({ headless: HEADLESS });
      console.log('[Scraper] ✓ Launched Playwright-managed Firefox (Camoufox not found)');
    }
  } else {
    browser = await playwright.firefox.launch({ headless: HEADLESS });
    console.log('[Scraper] ✓ Using Playwright-managed Firefox');
  }
  console.log('[Scraper] ✓ Browser launched successfully');

  const contextOptions = BROWSER_MODE === 'camoufox'
    ? { viewport: null }
    : { viewport: { width: VIEWPORT.width, height: VIEWPORT.height } };
  if (USER_AGENT) contextOptions.userAgent = USER_AGENT;

  browserContext = await browser.newContext(contextOptions);
  console.log(BROWSER_MODE === 'camoufox'
    ? '[Scraper] ✓ Created Camoufox browser context (viewport disabled)'
    : '[Scraper] ✓ Created browser context');
  console.log(USER_AGENT
    ? '[Scraper] ✓ Custom USER_AGENT env is set'
    : '[Scraper] ✓ Using browser-native userAgent (no override — best for anti-detect)');

  return getCurrentBrowser();
}

function getCurrentBrowser() {
  return browser ? { browser, context: browserContext } : null;
}

async function createPage() {
  if (!browser || !browserContext) throw new Error('Browser is not running. Call launchBrowser() first.');
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
  if (!browser || !browserContext) throw new Error('Browser is not running. Call launchBrowser() first.');

  const page = await createPage();
  const startTime = Date.now();

  try {
    console.log('[Scraper] Navigating to TeacherOn:', TEACHERON_URL);
    await page.goto(TEACHERON_URL, { waitUntil: 'load', timeout: NAVIGATION_TIMEOUT_MS });

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
    if (page && !page.isClosed()) { await page.close(); console.log('[Scraper] Test page closed'); }
  }
}

// ─── Abort Controller ──────────────────────────────────────────────────────

/** Create a fresh AbortController for a new scan (called by ipc-handlers). */
function createAbortController() {
  abortController = new AbortController();
  return abortController;
}

/** Signal the current scan to abort. Idempotent. */
function abortScan() {
  if (abortController) {
    abortController.abort();
    logger.info('Scraper', 'Abort signal sent to active scan');
  }
}

/** Get the current abort signal, or null if no scan is running. */
function getAbortSignal() {
  return abortController ? abortController.signal : null;
}

/** Whether the scan has been aborted. */
function isAborted() {
  return !!(abortController && abortController.signal.aborted);
}

/** Clear the abort controller after a scan completes or is stopped. */
function clearAbortController() {
  abortController = null;
}

// ─── Cleanup ───────────────────────────────────────────────────────────────

/** Close the browser context and browser safely, resetting state regardless of errors. */
async function closeBrowser() {
  logger.info('Scraper', 'Closing browser...');

  if (browserContext) {
    try { await browserContext.close(); logger.info('Scraper', 'Browser context closed'); }
    catch (e) { logger.warn('Scraper', 'Error closing context: ' + e.message); }
    browserContext = null;
  }
  if (browser) {
    try { await browser.close(); logger.info('Scraper', 'Browser closed'); }
    catch (e) { logger.warn('Scraper', 'Error closing browser: ' + e.message); }
    browser = null;
  }
  clearAbortController();
}

function isBrowserRunning() {
  return !!(browser && browser.isConnected());
}
// ─── Search Navigation ─────────────────────────────────────────────────────

/** Build a TeacherOn search URL from subject and/or location. */
function buildSearchUrl(subject, location) {
  if (subject) {
    const slug = subject.trim().toLowerCase().replace(/\s+/g, '_');
    return `${TEACHERON_SEARCH_BASE_URL}/${slug}-tutor-jobs`;
  }
  return TEACHERON_LISTING_URL;
}

/** Navigate to a TeacherOn listing/search page, wait for job cards. */
async function searchTeacherOn(page, options = {}) {
  const { subject, location } = options;
  if (!page || page.isClosed()) throw new Error('Cannot search: page is closed or invalid.');

  const url = buildSearchUrl(subject, location);
  console.log('[Scraper] Navigating to:', url);
  if (subject) console.log('[Scraper]   Subject:', subject);
  if (location) console.log('[Scraper]   Location (for extraction):', location);

  await page.goto(url, { waitUntil: 'load', timeout: NAVIGATION_TIMEOUT_MS });

  try {
    await page.waitForSelector(
      `${LISTING_SELECTORS.card}, #noRecordFoundOnSearchDiv`,
      { timeout: NAVIGATION_TIMEOUT_MS }
    );
  } catch { console.warn('[Scraper] No job cards or "no results" div found on page.'); }

  console.log('[Scraper] Search page loaded — URL:', page.url());
  return { url: page.url(), title: await page.title() };
}

// ─── Scrolling ─────────────────────────────────────────────────────────────

/**
 * Scroll the results container (#tutorOrJobSearchItemList) or document gradually
 * (≈0.8 viewport/step, 120ms between steps) to trigger lazy-loaded cards.
 * Detects bottom, respects abort, hard-caps at 40 steps.
 */
async function scrollResultsPage(page) {
  if (!page || page.isClosed()) return { containerScrollable: false, steps: 0, reachedBottom: false };
  console.log('[Scraper] scrolling results...');

  const plan = await page.evaluate(() => {
    const container = document.querySelector('#tutorOrJobSearchItemList');
    const doc = document.documentElement;
    const MAX = 40;
    const isContainer = container && container.scrollHeight > container.clientHeight + 10;
    const isDoc = doc.scrollHeight - doc.clientHeight > 10;
    const target = isContainer ? 'container' : (isDoc ? 'document' : null);
    if (!target) return { target: null };
    const totalSteps = target === 'container'
      ? Math.max(1, Math.ceil((container.scrollHeight - container.clientHeight) / (container.clientHeight * 0.8)))
      : Math.max(1, Math.ceil((doc.scrollHeight - doc.clientHeight) / (doc.clientHeight * 0.8)));
    return { target, totalSteps: Math.min(totalSteps, MAX) };
  });

  if (!plan || !plan.target) {
    console.log('[Scraper] No scrollable results container / document found — nothing to scroll.');
    return { containerScrollable: false, steps: 0, reachedBottom: true };
  }

  const containerScrollable = plan.target === 'container';
  console.log(`[Scraper] ${containerScrollable ? 'Scrolling results container' : 'Scrolling document'} — ${plan.totalSteps} step(s)`);

  let steps = 0;
  let reachedBottom = false;

  for (let i = 0; i < plan.totalSteps; i++) {
    if (isAborted()) { console.log('[Scraper] Abort signal — stopping scroll routine.'); break; }

    const info = await page.evaluate(({ useContainer }) => {
      const container = document.querySelector('#tutorOrJobSearchItemList');
      const isContainer = useContainer && container && (container.scrollHeight > container.clientHeight + 10);
      if (isContainer) {
        container.scrollTop += Math.min(container.clientHeight * 0.8,
          container.scrollHeight - container.scrollTop - container.clientHeight);
        return { atBottom: container.scrollTop + container.clientHeight >= container.scrollHeight - 10 };
      }
      window.scrollBy(0, Math.min(window.innerHeight * 0.8,
        document.documentElement.scrollHeight - window.scrollY - window.innerHeight));
      return { atBottom: window.scrollY + window.innerHeight >= document.documentElement.scrollHeight - 10 };
    }, { useContainer: containerScrollable });

    steps++;
    if (info.atBottom) { reachedBottom = true; console.log(`[Scraper] reached bottom at step ${steps}`); break; }
    await page.waitForTimeout(120);
  }

  if (!reachedBottom) console.log(`[Scraper] scroll routine finished after ${steps} step(s) without explicit bottom`);
  return { containerScrollable, steps, reachedBottom };
}
// ─── Listing Extraction ────────────────────────────────────────────────────

/**
 * Extract all job listings from the current listing page.
 * Fields not present on a card are set to null — never throws.
 * Duplicate URLs within the page are removed (first occurrence wins).
 * Relative URLs are resolved; invalid protocols are rejected.
 */
async function scrapeListingPage(page, options = {}) {
  const { scroll = true, pageLabel = '' } = options;

  if (!page || page.isClosed()) throw new Error('Cannot scrape: page is closed or invalid.');

  const sel = LISTING_SELECTORS;
  const prefix = pageLabel ? `[Scraper] ${pageLabel}: ` : '[Scraper] ';

  // Count cards before scrolling, check for "no results" first.
  const beforeScrollCount = await page.locator(sel.card).count();
  console.log(`${prefix}found ${beforeScrollCount} cards before scrolling`);

  const noResultsCount = await page.locator('#noRecordFoundOnSearchDiv').count();
  if (noResultsCount > 0) {
    const visible = await page.locator('#noRecordFoundOnSearchDiv').evaluate(
      (el) => window.getComputedStyle(el).display !== 'none'
    );
    if (visible) { console.log(`${prefix}No results found on this page.`); return []; }
  }

  // Scroll to trigger lazy-loaded cards (extraction still happens for existing cards).
  if (scroll) {
    console.log(`${prefix}scrolling results`);
    const scrollResult = await scrollResultsPage(page);
    if (scrollResult && scrollResult.steps === 0) console.log(`${prefix}no scrolling needed (content fits viewport)`);
  }

  if (page.isClosed()) throw new Error('Page closed during scroll routine.');

  // Extract card data from the DOM in one browser evaluation.
  const rawListings = await page.$$eval(sel.card, (cards, selectors) => {
    return cards.map((cardEl) => {
      const titleEl = cardEl.querySelector(selectors.title);
      const titleText = titleEl ? titleEl.innerText.trim() : null;
      const rawUrl = titleEl ? titleEl.getAttribute('href') : null;

      const subjectList = Array.from(cardEl.querySelectorAll(selectors.subjects))
        .map((a) => a.innerText.trim());

      let locText = null;
      const locIcon = cardEl.querySelector(selectors.locationIcon);
      if (locIcon) { const li = locIcon.closest('li'); if (li) locText = li.innerText.trim(); }

      let dateText = null;
      const dateIcon = cardEl.querySelector(selectors.postedDateIcon);
      if (dateIcon) { const li = dateIcon.closest('li'); if (li) dateText = li.innerText.trim(); }

      const descEl = cardEl.querySelector(selectors.description);
      const descText = descEl ? descEl.innerText.trim() : null;

      return { title: titleText, jobUrl: rawUrl, subjects: subjectList, location: locText, description: descText, postedDate: dateText };
    });
  }, sel);

  // Normalize, validate, and deduplicate.
  const seenUrls = new Set();
  const processed = [];

  for (const raw of rawListings) {
    let normalizedUrl = null;
    if (raw.jobUrl) {
      try {
        const resolved = new URL(raw.jobUrl, TEACHERON_SEARCH_BASE_URL);
        if (resolved.protocol === 'http:' || resolved.protocol === 'https:') normalizedUrl = resolved.href;
        else console.warn('[Scraper] Invalid protocol:', resolved.protocol, raw.jobUrl);
      } catch { console.warn('[Scraper] Malformed URL:', raw.jobUrl); }
    }
    if (!normalizedUrl) { if (raw.title) console.warn('[Scraper] Missing valid URL for:', raw.title); continue; }
    if (seenUrls.has(normalizedUrl)) { console.log('[Scraper] Skipping duplicate:', normalizedUrl); continue; }
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
// ─── Pagination & Cloudflare ───────────────────────────────────────────────

/** Wait for a Cloudflare challenge to auto-solve, reload once, then re-check. Returns true if still blocked. */
async function waitForCloudflareResolution(page) {
  if (!page || page.isClosed()) return false;

  console.log(`[Scraper] Cloudflare challenge detected — waiting ${CLOUDFLARE_RETRY_MS}ms for auto-solve...`);
  await page.waitForTimeout(CLOUDFLARE_RETRY_MS);

  try {
    if (!page.isClosed()) {
      await page.reload({ waitUntil: 'domcontentloaded', timeout: NAVIGATION_TIMEOUT_MS }).catch(() => {});
      console.log('[Scraper] Page reloaded after Cloudflare wait');
    }
  } catch { /* ignore reload errors */ }

  await page.waitForTimeout(3000);
  return await isBlockedByCloudflare(page);
}

/** Detect if the current page shows a Cloudflare challenge (title/body signals, no bypass). */
async function isBlockedByCloudflare(page) {
  try {
    if (page.isClosed()) return false;
    const title = await page.title();
    for (const pat of CLOUDFLARE_TITLE_PATTERNS) {
      if (title && title.toLowerCase().includes(pat.toLowerCase())) {
        console.warn(`[Scraper] ⚠️ Cloudflare challenge detected — title: "${title}"`);
        return true;
      }
    }
    const bodyText = await page.evaluate(() => document.body.innerText || '');
    for (const pat of CLOUDFLARE_BODY_PATTERNS) {
      if (bodyText.includes(pat)) {
        console.warn(`[Scraper] ⚠️ Cloudflare challenge detected — body: "${pat}"`);
        return true;
      }
    }
    return false;
  } catch { return false; }
}

/** Get the current active page number from the pagination UI. */
async function getCurrentPageNumber(page) {
  try {
    const count = await page.locator(PAGINATION_SELECTORS.activePage).count();
    if (count === 0) return null;
    const text = await page.locator(PAGINATION_SELECTORS.activePage).innerText();
    const num = parseInt(text.trim(), 10);
    return Number.isNaN(num) ? null : num;
  } catch { return null; }
}

/**
 * Extract the next-page URL from pagination controls.
 * Strategies: primary link → text-based next → sibling page → constructed ?p=N+1.
 */
async function getNextPageUrl(page) {
  try {
    const sel = PAGINATION_SELECTORS;
    const currentUrl = page.url();
    const base = TEACHERON_SEARCH_BASE_URL;

    const resolveHref = (rawHref) => {
      if (!rawHref || rawHref.trim() === '') return null;
      try {
        const resolved = new URL(rawHref, base);
        if (resolved.protocol !== 'http:' && resolved.protocol !== 'https:') {
          console.warn('[Scraper] Invalid next-page URL protocol:', resolved.protocol, rawHref);
          return null;
        }
        if (resolved.href === currentUrl) {
          console.log('[Scraper] Next-page URL is identical to current URL — ignoring.');
          return null;
        }
        return resolved.href;
      } catch { return null; }
    };

    // 1. Primary: configured `a[title="Next page"]` selector.
    if (await page.locator(sel.nextPageLink).count() > 0) {
      const resolved = resolveHref(await page.locator(sel.nextPageLink).getAttribute('href'));
      if (resolved) { console.log('[Scraper] Next-page URL (primary link):', resolved); return resolved; }
      console.log('[Scraper] Next-page link exists but has no usable href.');
    }

    // 2. Fallback: any pagination link whose text is ">" or contains "next".
    const paginationText = await page.evaluate(() => {
      const container = document.querySelector('ul.pagination');
      if (!container) return null;
      for (const a of container.querySelectorAll('a')) {
        const text = (a.innerText || a.textContent || '').trim();
        const title = (a.getAttribute('title') || '').toLowerCase();
        const aria = (a.getAttribute('aria-label') || '').toLowerCase();
        if (text === '>' || text === '»' || text === '›' ||
            text.toLowerCase().includes('next') || title.includes('next') || aria.includes('next')) {
          return { href: a.getAttribute('href'), text, title: a.getAttribute('title') };
        }
      }
      return null;
    });
    if (paginationText && paginationText.href) {
      const resolved = resolveHref(paginationText.href);
      if (resolved) { console.log('[Scraper] Next-page URL (fallback: pagination text → href):', resolved); return resolved; }
    }

    // 3. Fallback: find the page-number link right after the active page.
    const nextByPageNum = await page.evaluate(() => {
      const container = document.querySelector('ul.pagination');
      if (!container) return null;
      const active = container.querySelector('li.active');
      if (!active) return null;
      const link = active.nextElementSibling ? active.nextElementSibling.querySelector('a') : null;
      if (link) return { href: link.getAttribute('href'), text: (link.innerText || link.textContent || '').trim() };
      return null;
    });
    if (nextByPageNum && nextByPageNum.href) {
      const resolved = resolveHref(nextByPageNum.href);
      if (resolved) { console.log('[Scraper] Next-page URL (next sibling page link):', resolved); return resolved; }
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
/** Navigate to the next listing page, including anti-bot pacing and page-change verification. */
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
    ).catch(() => { console.warn('[Scraper] Listing cards did not appear after navigation.'); });

    // Verify page actually changed.
    const afterUrl = page.url();
    const afterPageNum = await getCurrentPageNumber(page);
    const urlChanged = afterUrl !== beforeUrl;
    const pageNumChanged = (afterPageNum !== null && (afterPageNum !== beforePageNum || beforePageNum === null));

    if (urlChanged) console.log(`[Scraper] Page navigated to: ${afterUrl}`);
    else console.warn('[Scraper] ⚠ URL did not change after navigation — may be stuck on same page.');

    return { success: true, urlChanged, pageNumChanged };
  } catch (error) {
    logger.error('Scraper', 'Navigation error on next page: ' + error.message);
    return { success: false, urlChanged: false, pageNumChanged: false };
  }
}

/** Deduplicate listings into a set + array, returning the count of new listings added. */
function addUniqueListings(listings, allListings, seenUrls) {
  let added = 0;
  for (const l of listings) {
    if (!seenUrls.has(l.jobUrl)) {
      seenUrls.add(l.jobUrl);
      allListings.push(l);
      added++;
    }
  }
  return added;
}
/** Scrape multiple listing pages using TeacherOn pagination, dedupes across pages. */
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
    visitedPageUrls.add(page.url());

    if (isAborted()) return { listings: allListings, pagesScraped: 0, stoppedReason: 'user-aborted' };
    if (await isBlockedByCloudflare(page)) return { listings: [], pagesScraped: 0, stoppedReason: 'cloudflare_block' };

    const currentPageNum = await getCurrentPageNumber(page);
    console.log(`\n[Scraper] ═══ Page ${currentPageNum || 1} ═══`);
    console.log('[Scraper] Page 1 loaded');

    // ---- Page 1: scroll → extract → dedupe ----
    let page1Listings = [];
    try {
      page1Listings = await scrapeListingPage(page, { scroll: true, pageLabel: 'Page 1' });
    } catch (scrapeError) {
      logger.error('Scraper', 'Page 1 scrape error: ' + scrapeError.message);
      return { listings: [], pagesScraped: 0, stoppedReason: 'scrape-error' };
    }
    pagesScraped = 1;
    addUniqueListings(page1Listings, allListings, seenUrls);
    console.log(`[Scraper] Page 1: extracted ${page1Listings.length} jobs`);
    console.log(`[Scraper] Page 1: total unique so far: ${allListings.length}`);

    if (maxPages <= 1 || isAborted()) {
      stoppedReason = isAborted() ? 'user-aborted' : 'max-pages';
      if (maxPages <= 1) console.log(`[Scraper] Reached MAX_PAGES=${maxPages}`);
      return { listings: allListings, pagesScraped, stoppedReason };
    }

    let nextUrl = await getNextPageUrl(page);
    if (nextUrl) console.log(`[Scraper] Page 1: next page detected: ${nextUrl}`);
    else console.log('[Scraper] Page 1: no next page detected');

    while (nextUrl && pagesScraped < maxPages) {
      if (isAborted()) { console.log('[Scraper] Abort signal detected — stopping pagination'); stoppedReason = 'user-aborted'; break; }

      if (visitedPageUrls.has(nextUrl)) {
        console.warn(`[Scraper] Already visited ${nextUrl} — stopping to prevent loop.`);
        stoppedReason = 'duplicate-page'; break;
      }

      const nextPageNum = pagesScraped + 1;

      let navResult = null;
      try {
        navResult = await navigateToNextPage(page, nextUrl, delayMs);
      } catch (navError) {
        console.error('[Scraper] Navigation error on page', nextPageNum, ':', navError.message);
        if (page.isClosed()) { console.warn('[Scraper] Page was closed during navigation — stopping'); stoppedReason = 'page-closed'; }
        else stoppedReason = 'navigation-error';
        break;
      }

      if (!navResult || !navResult.success) { stoppedReason = 'navigation-error'; break; }

      visitedPageUrls.add(nextUrl);

      // Verify the page actually changed — if neither URL nor page number changed, stop to prevent a loop.
      if (!(navResult.urlChanged || navResult.pageNumChanged)) {
        console.warn('[Scraper] ⚠ Page did not change after navigation — stopping to prevent loop.');
        stoppedReason = 'no-page-change'; break;
      }

      console.log(`[Scraper] Navigating to page ${nextPageNum}`);
      console.log(`[Scraper] Page ${nextPageNum} loaded`);

      // Cloudflare check with one retry via waitForCloudflareResolution.
      try {
        if (await isBlockedByCloudflare(page)) {
          console.log(`[Scraper] Cloudflare challenge detected on page ${nextPageNum}`);
          const retryBlocked = await waitForCloudflareResolution(page);
          if (retryBlocked) { stoppedReason = 'cloudflare_block'; break; }
          console.log('[Scraper] Cloudflare challenge resolved after wait — continuing');
        }
      } catch (cfError) { logger.warn('Scraper', 'Cloudflare check failed: ' + cfError.message); }

      if (page.isClosed()) { console.warn('[Scraper] Page closed mid-pagination — stopping'); stoppedReason = 'page-closed'; break; }

      const pageNum = await getCurrentPageNumber(page);
      console.log(`\n[Scraper] ═══ Page ${pageNum || nextPageNum} ═══`);

      // Scrape current page, preserving previous results on error.
      let pageListings = [];
      try {
        pageListings = await scrapeListingPage(page, { scroll: true, pageLabel: `Page ${nextPageNum}` });
      } catch (scrapeError) {
        logger.error('Scraper', 'Scrape error on page ' + nextPageNum + ': ' + scrapeError.message);
        stoppedReason = 'scrape-error'; break;
      }
      pagesScraped++;

      if (pageListings.length === 0) {
        logger.info('Scraper', 'Page ' + pagesScraped + ' has no listings — stopping.');
        stoppedReason = 'empty-page'; break;
      }

      const addedCount = addUniqueListings(pageListings, allListings, seenUrls);
      const dupes = pageListings.length - addedCount;
      console.log(`[Scraper] Page ${pagesScraped}: extracted ${pageListings.length} jobs (${addedCount} new, ${dupes} dupes)`);
      logger.info('Scraper', 'Page ' + pagesScraped + ': ' + pageListings.length + ' card(s) → ' +
        addedCount + ' new, ' + dupes + ' dupes → total unique: ' + allListings.length);

      // Look for next page.
      try {
        nextUrl = await getNextPageUrl(page);
        if (nextUrl) console.log(`[Scraper] Page ${pagesScraped}: next page detected: ${nextUrl}`);
        else console.log(`[Scraper] Page ${pagesScraped}: no next page detected`);
      } catch (nextError) {
        logger.warn('Scraper', 'Error getting next page URL: ' + nextError.message);
        nextUrl = null;
      }
    }

    if (isAborted()) stoppedReason = 'user-aborted';
    else if (pagesScraped >= maxPages) { stoppedReason = 'max-pages'; console.log(`[Scraper] Reached MAX_PAGES=${maxPages}`); }
    else if (!nextUrl) stoppedReason = 'no-next-page';
  } catch (error) {
    logger.error('Scraper', 'Pagination error: ' + error.message);
    stoppedReason = 'navigation-error';
  }

  logger.info('Scraper', 'Pagination complete: ' + pagesScraped + ' pages, ' +
    allListings.length + ' unique listings, stopped: ' + stoppedReason);

  return { listings: allListings, pagesScraped, stoppedReason };
}

// ─── Exports ───────────────────────────────────────────────────────────────

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
  createAbortController,
  abortScan,
  getAbortSignal,
  isAborted,
  clearAbortController,
};