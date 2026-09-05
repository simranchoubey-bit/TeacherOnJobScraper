// src/main/ipc-handlers.js
// Phase 1+2+7+8: IPC handler registration — wired to SQLite + real scheduler
// All handlers use ipcMain.handle() for request/response pattern

const { ipcMain, app, shell } = require('electron');
const { IPC_CHANNELS } = require('../shared/constants');
const logger = require('./logger');
const {
  createJob,
  getAllJobs,
  getRecentJobs,
  clearJobs,
  createScanRecord,
  updateScanRecord,
  getScanHistory,
  clearScanHistory,
  getNewTodayCount,
  clearAllData,
  getDatabaseInfo,
} = require('./database');
const {
  launchBrowser,
  closeBrowser,
  createPage,
  searchTeacherOn,
  scrapeListingPage,
  scrapePages,
  isBrowserRunning,
  // Phase 8: Abort controller
  createAbortController,
  abortScan,
  clearAbortController,
} = require('./scraper');
const scheduler = require('./scheduler');

// ─── Input Validators ──────────────────────────────────────────────────────

function validateString(value, name) {
  if (typeof value !== 'string' || value.trim().length === 0) {
    logger.warn('IPC', 'Invalid ' + name + ': expected non-empty string, got ' + typeof value);
    return null;
  }
  return value.trim();
}

function validatePositiveInt(value, name) {
  var num = Number(value);
  if (!Number.isInteger(num) || num <= 0) {
    logger.warn('IPC', 'Invalid ' + name + ': expected positive integer, got ' + value);
    return null;
  }
  return num;
}

function validateURL(value) {
  if (typeof value !== 'string' || value.trim().length === 0) return null;
  var trimmed = value.trim();
  try {
    var url = new URL(trimmed);
    if (url.protocol !== 'http:' && url.protocol !== 'https:') {
      logger.warn('IPC', 'Invalid URL protocol: ' + url.protocol);
      return null;
    }
    return trimmed;
  } catch {
    logger.warn('IPC', 'Invalid URL format: ' + trimmed);
    return null;
  }
}

// ─── Scan State ────────────────────────────────────────────────────────────

let scanRunning = false;   // Prevents overlapping manual/scheduler scans

// ─── Reusable Scan Logic (used by both manual scan & scheduler) ───────────

/**
 * runScan — the core scan implementation.
 *
 * Phase 8 improvements:
 *  - Checks scanRunning to prevent overlaps
 *  - Uses AbortController to let Stop Scan interrupt pagination
 *  - try/finally ensures scanRunning is always reset
 *  - Page close is always attempted even if errors occur
 *  - Partial results are preserved when a page fails
 */
async function runScan({ subject, location, maxPages }) {
  logger.info('Scan', 'Starting scan', { subject: subject || 'all', location: location || 'all', maxPages: maxPages || 3 });

  var results = {
    success: true,
    message: 'Scan completed',
    filters: {
      subject: subject || 'all',
      location: location || 'all',
      maxPages: maxPages || 3,
    },
    startedAt: new Date().toISOString(),
    listings: [],
    totalListings: 0,
  };

  let page = null;

  try {
    // Ensure browser is running
    if (!isBrowserRunning()) {
      await launchBrowser();
    }

    page = await createPage();

    // Execute search
    await searchTeacherOn(page, { subject, location });

    // Multi-page pagination (Phase 8: now respects abort signal)
    const paginationResult = await scrapePages(page, { maxPages: maxPages || 3, delayMs: 2000 });
    results.listings = paginationResult.listings;
    results.totalListings = paginationResult.listings.length;
    results.pagesScraped = paginationResult.pagesScraped;
    results.stoppedReason = paginationResult.stoppedReason;

    // If Cloudflare blocked the scan, mark it as stopped and set a clear message.
    // Existing jobs in SQLite are preserved (no writes happened for 0 listings).
    if (paginationResult.stoppedReason === 'cloudflare_block') {
      results.stopped = true;
      results.message = 'TeacherOn blocked this scan with a Cloudflare security challenge. Previously saved jobs were preserved.';
    }

    logger.info('Scan', 'Pages completed', { listings: paginationResult.listings.length,
      pagesScraped: paginationResult.pagesScraped, stoppedReason: paginationResult.stoppedReason });

    // Phase 10: Persist every unique job into SQLite.
    // Duplicates are silently skipped by createJob()'s UNIQUE constraint.
    console.log('[SCAN] Persisting ' + paginationResult.listings.length + ' listings to SQLite...');
    var inserted = 0;
    var skipped = 0;
    for (var i = 0; i < paginationResult.listings.length; i++) {
      var listing = paginationResult.listings[i];
      try {
        var dbResult = createJob({
          title: listing.title,
          job_url: listing.jobUrl,
          subject: (listing.subjects && listing.subjects.length > 0) ? listing.subjects[0] : null,
          location: listing.location,
          description: listing.description,
          posted_date: listing.postedDate,
        });
        if (dbResult.inserted) inserted++;
        else skipped++;
      } catch (dbError) {
        console.log('[SCAN] createJob ERROR: ' + dbError.message);
        logger.warn('Scan', 'Failed to persist job: ' + dbError.message);
      }
    }
    console.log('[SCAN] Persist complete: inserted=' + inserted + ' skipped=' + skipped + ' total=' + paginationResult.listings.length);
    logger.info('Scan', 'Jobs persisted', { inserted, skipped, total: paginationResult.listings.length });

    // Record scan history
    try {
      const scanId = createScanRecord({
        startedAt: results.startedAt,
        subject: subject || null,
        location: location || null,
        maxPages: maxPages || 3,
        status: 'running'
      });
      const durationMs = Date.now() - new Date(results.startedAt).getTime();
      let status = 'success';
      if (paginationResult.stoppedReason === 'cloudflare_block') status = 'blocked';
      else if (paginationResult.stoppedReason === 'user-aborted') status = 'stopped';
      else if (!results.success) status = 'failed';
      else if (paginationResult.listings.length === 0) status = 'success';

      updateScanRecord(scanId, {
        completedAt: new Date().toISOString(),
        pagesScraped: paginationResult.pagesScraped || 0,
        jobsFound: paginationResult.listings.length,
        newJobs: inserted,
        existingJobs: skipped,
        status: status,
        stoppedReason: paginationResult.stoppedReason || null,
        errorMessage: results.error || null,
        durationMs: durationMs,
      });
      results.scanRecordId = scanId;
    } catch (histErr) {
      logger.warn('Scan', 'Failed to record scan history: ' + histErr.message);
    }

  } catch (error) {
    logger.error('Scan', 'Scan failed: ' + error.message, { error: error.message });
    results.success = false;
    results.message = error.message;
    results.error = error.message;
  } finally {
    // Phase 8: Always close the page regardless of errors
    if (page) {
      try {
        if (!page.isClosed()) {
          await page.close();
          logger.info('IPC', 'Scan page closed');
        }
      } catch (closeErr) {
        logger.warn('IPC', 'Error closing scan page: ' + closeErr.message);
      }
    }
  }

  return results;
}

// ─── Handler Implementations ───────────────────────────────────────────────

function setupScanHandlers() {
  ipcMain.handle(IPC_CHANNELS.SCAN_START, async (_event, options = {}) => {
    logger.info('IPC', 'Scan start requested', options);

    // Phase 8: Prevent overlapping scans
    if (scanRunning) {
      logger.warn('IPC', 'Scan overlap prevented');
      throw new Error('A scan is already in progress. Please wait for it to complete or stop it first.');
    }

    const subject = validateString(options.subject, 'subject');
    const location = validateString(options.location, 'location');
    const maxPages = validatePositiveInt(options.maxPages, 'maxPages');

    // Bug Fix: Location is optional — only validate if explicitly provided
    if (options.subject !== undefined && subject === null) {
      throw new Error('Invalid subject: must be a non-empty string');
    }
    // location is explicitly optional — undefined/null/blank all become null (no error)
    if (options.maxPages !== undefined && maxPages === null) {
      throw new Error('Invalid maxPages: must be a positive integer');
    }

    // Phase 8: Create abort controller for this scan
    createAbortController();

    scanRunning = true;
    logger.info('IPC', 'Scan started', { subject: subject || 'all', location: location || 'all' });

    try {
      const results = await runScan({ subject, location, maxPages });
      results.completedAt = new Date().toISOString();
      return results;
    } catch (error) {
      logger.error('IPC', 'Scan error: ' + error.message);
      return {
        success: false,
        message: `Scan failed: ${error.message}`,
        startedAt: new Date().toISOString(),
        completedAt: new Date().toISOString(),
        listings: [],
        totalListings: 0,
      };
    } finally {
      // Phase 8: Always reset state, even if runScan throws
      scanRunning = false;
      clearAbortController();
    }
  });

  ipcMain.handle(IPC_CHANNELS.SCAN_STOP, async () => {
    logger.info('IPC', 'Scan stop requested');

    if (!scanRunning) {
      logger.info('IPC', 'No scan running to stop');
      return { success: false, message: 'No scan is currently running.', scanRunning: false };
    }

    // Phase 8: Signal the abort controller so in-flight pagination stops
    // The scan will stop after completing the current page.
    // Partial results collected so far will be preserved.
    abortScan();

    logger.info('IPC', 'Abort signal sent to active scan');

    return {
      success: true,
      message: 'Stopping scan. Results collected so far will be preserved.',
      stoppedAt: new Date().toISOString(),
      scanRunning: true, // still running — will finish naturally
    };
  });
}
function setupJobsHandlers() {
  ipcMain.handle(IPC_CHANNELS.JOBS_GET_ALL, async (_event, options = {}) => {
    logger.info('IPC', 'jobs:get-all requested');

    var offset = 1;
    var limit = 10;

    if (options.offset !== undefined) {
      offset = validatePositiveInt(options.offset, 'offset');
      if (offset === null) throw new Error('Invalid offset: must be a positive integer');
    }
    if (options.limit !== undefined) {
      limit = validatePositiveInt(options.limit, 'limit');
      if (limit === null) throw new Error('Invalid limit: must be a positive integer');
    }

    // Delegate to database layer
    var dbResult = getAllJobs(offset, limit);
    return {
      success: true,
      jobs: dbResult.jobs,
      total: dbResult.total,
      returned: dbResult.jobs.length,
      timestamp: new Date().toISOString(),
    };
  });

  ipcMain.handle(IPC_CHANNELS.JOBS_GET_RECENT, async (_event, options = {}) => {
    logger.info('IPC', 'jobs:get-recent requested', options);

    let hours = 24;
    if (options.hours !== undefined) {
      hours = validatePositiveInt(options.hours, 'hours');
      if (hours === null) throw new Error('Invalid hours: must be a positive integer');
    }

    // Delegate to database layer
    const dbResult = getRecentJobs(hours);
    return {
      success: true,
      jobs: dbResult.jobs,
      total: dbResult.total,
      cutoffHours: dbResult.cutoffHours,
      timestamp: new Date().toISOString(),
    };
  });

  ipcMain.handle(IPC_CHANNELS.JOBS_OPEN_URL, async (_event, url) => {
    logger.info('IPC', 'jobs:open-url requested: ' + url);
    var validatedURL = validateURL(url);
    if (!validatedURL) {
      throw new Error('Invalid URL: must be a valid http/https URL');
    }
    // Open in the default OS browser
    try {
      await shell.openExternal(validatedURL);
      logger.info('IPC', 'Opened URL in external browser: ' + validatedURL);
      return { success: true, message: 'URL opened in browser', url: validatedURL };
    } catch (err) {
      logger.error('IPC', 'Failed to open URL: ' + err.message);
      throw new Error('Failed to open URL: ' + err.message);
    }
  });

  // Phase 9: Clear all jobs
  ipcMain.handle(IPC_CHANNELS.JOBS_CLEAR_ALL, async () => {
    logger.info('IPC', 'Clear all jobs requested');
    try {
      var deleted = clearJobs();
      logger.info('IPC', 'All jobs cleared', { count: deleted });
      return { success: true, message: 'All jobs cleared', deleted: deleted,
        timestamp: new Date().toISOString() };
    } catch (err) {
      logger.error('IPC', 'Failed to clear jobs: ' + err.message);
      throw err;
    }
  });
}
// ─── Scheduler Config (persisted across ticks) ─────────────────────────────
let schedulerScanConfig = {
  subject: null,
  location: null,
  maxPages: 3,
};

function setupSchedulerHandlers() {
  ipcMain.handle(IPC_CHANNELS.SCHEDULER_START, async (_event, options = {}) => {
    logger.info('IPC', 'Scheduler start requested', options);

    const intervalMinutes = validatePositiveInt(options.intervalMinutes, 'intervalMinutes');

    if (options.intervalMinutes !== undefined && intervalMinutes === null) {
      throw new Error('Invalid intervalMinutes: must be a positive integer (30 or 60)');
    }

    // Read optional scan config (same as manual scan params)
    const subject = validateString(options.subject, 'subject');
    const location = validateString(options.location, 'location');
    const maxPages = validatePositiveInt(options.maxPages, 'maxPages');

    if (options.subject !== undefined && subject === null) {
      throw new Error('Invalid subject: must be a non-empty string');
    }
    // Location is optional for scheduler too
    if (options.maxPages !== undefined && maxPages === null) {
      throw new Error('Invalid maxPages: must be a positive integer');
    }

    // Store config so scheduled ticks know what to scan
    schedulerScanConfig = {
      subject: subject || null,
      location: location || null,
      maxPages: maxPages || 3,
    };

    // Pass a callback that runs the shared scan logic
    // Phase 8: The scheduler callback checks scanRunning to prevent overlap with manual scans
    const result = scheduler.start(intervalMinutes || 60, async () => {
      // If a manual scan is already running, skip this tick
      if (scanRunning) {
        logger.info('IPC', 'Scheduler tick skipped — manual scan in progress');
        return;
      }

      const config = schedulerScanConfig;

      // Prevent scheduler from running if a manual scan starts between checks
      scanRunning = true;
      createAbortController();

      try {
        await runScan(config);
      } finally {
        scanRunning = false;
        clearAbortController();
      }
    });

    return { success: result.success, message: result.message,
      intervalMinutes: result.intervalMinutes,
      nextRun: result.nextRun, startedAt: result.startedAt };
  });

  ipcMain.handle(IPC_CHANNELS.SCHEDULER_STOP, async () => {
    logger.info('IPC', 'Scheduler stop requested');
    const result = scheduler.stop();
    return { success: result.success, message: result.message,
      stoppedAt: result.stoppedAt, totalRuns: result.totalRuns };
  });

  ipcMain.handle(IPC_CHANNELS.SCHEDULER_STATUS, async () => {
    logger.info('IPC', 'Scheduler status requested');
    const status = scheduler.getStatus();
    return { success: true, ...status };
  });
}

function setupAppHandlers() {
  ipcMain.handle(IPC_CHANNELS.APP_QUIT, async () => {
    logger.info('IPC', 'App quit requested');
    setTimeout(() => app.quit(), 100);
    return { success: true, message: 'Quitting application...' };
  });
}

// ─── Dashboard, Scan History, Logs, Settings ────────────────────────────

function setupDashboardHandlers() {
  ipcMain.handle(IPC_CHANNELS.DASHBOARD_STATS, async () => {
    try {
      const totalJobs = require('./database').getJobCount();
      const newToday = getNewTodayCount();
      const recentJobs = getRecentJobs(24);
      const scanHistory = getScanHistory(5);
      const schedulerStatus = scheduler.getStatus();

      return {
        success: true,
        totalJobs,
        newToday,
        recentJobs: recentJobs.jobs.slice(0, 5),
        recentScans: scanHistory,
        scheduler: {
          running: schedulerStatus.running,
          intervalMinutes: schedulerStatus.intervalMinutes,
          nextRun: schedulerStatus.nextRun,
          lastRun: schedulerStatus.lastRunCompletedAt,
          runCount: schedulerStatus.runCount,
          isScanning: schedulerStatus.isScanning,
        },
        lastScanTime: scanHistory.length > 0 ? scanHistory[0].completedAt : null,
      };
    } catch (err) {
      logger.error('IPC', 'Dashboard stats error: ' + err.message);
      return { success: false, message: err.message };
    }
  });
}

function setupScanHistoryHandlers() {
  ipcMain.handle(IPC_CHANNELS.SCAN_HISTORY_GET, async (_event, limit) => {
    try {
      const history = getScanHistory(limit || 20);
      return { success: true, history };
    } catch (err) {
      return { success: false, message: err.message };
    }
  });

  ipcMain.handle(IPC_CHANNELS.SCAN_HISTORY_CLEAR, async () => {
    try {
      const deleted = clearScanHistory();
      return { success: true, deleted };
    } catch (err) {
      return { success: false, message: err.message };
    }
  });
}

// In-memory log buffer (renderer queries this)
const logBuffer = [];
const MAX_LOG_BUFFER = 200;
function addToLogBuffer(entry) {
  logBuffer.push(entry);
  if (logBuffer.length > MAX_LOG_BUFFER) logBuffer.shift();
}

// Hook into logger to capture logs for the renderer
const originalWarn = logger.warn;
const originalError = logger.error;
const originalInfo = logger.info;
logger.info = function (mod, msg, ctx) {
  addToLogBuffer({ timestamp: new Date().toISOString(), level: 'INFO', module: mod, message: msg });
  return originalInfo.apply(logger, arguments);
};
logger.warn = function (mod, msg, ctx) {
  addToLogBuffer({ timestamp: new Date().toISOString(), level: 'WARN', module: mod, message: msg });
  return originalWarn.apply(logger, arguments);
};
logger.error = function (mod, msg, ctx) {
  addToLogBuffer({ timestamp: new Date().toISOString(), level: 'ERROR', module: mod, message: msg });
  return originalError.apply(logger, arguments);
};

function setupLogHandlers() {
  ipcMain.handle(IPC_CHANNELS.LOGS_GET, async () => {
    return { success: true, logs: logBuffer.slice() };
  });
  ipcMain.handle(IPC_CHANNELS.LOGS_CLEAR, async () => {
    logBuffer.length = 0;
    return { success: true };
  });
}

// Runtime settings store (simple in-memory, not persisted to DB)
const runtimeSettings = {
  defaultMaxPages: 3,
  defaultInterval: 60,
};

function setupSettingsHandlers() {
  ipcMain.handle(IPC_CHANNELS.SETTINGS_GET, async () => {
    const config = require('./config');
    return {
      success: true,
      settings: {
        defaultMaxPages: runtimeSettings.defaultMaxPages,
        defaultInterval: runtimeSettings.defaultInterval,
        browserMode: config.BROWSER_MODE,
        headless: config.HEADLESS,
      },
    };
  });

  ipcMain.handle(IPC_CHANNELS.SETTINGS_SAVE, async (_event, settings) => {
    if (settings.defaultMaxPages !== undefined) {
      const val = parseInt(settings.defaultMaxPages, 10);
      if (val >= 1 && val <= 10) runtimeSettings.defaultMaxPages = val;
    }
    if (settings.defaultInterval !== undefined) {
      const val = parseInt(settings.defaultInterval, 10);
      if (val === 30 || val === 60) runtimeSettings.defaultInterval = val;
    }
    return { success: true };
  });

  ipcMain.handle(IPC_CHANNELS.DB_CLEAR_ALL, async () => {
    try {
      const result = clearAllData();
      return { success: true, ...result };
    } catch (err) {
      return { success: false, message: err.message };
    }
  });

  ipcMain.handle(IPC_CHANNELS.DB_INFO, async () => {
    try {
      return { success: true, ...getDatabaseInfo() };
    } catch (err) {
      return { success: false, message: err.message };
    }
  });
}

// ─── Register All Handlers ─────────────────────────────────────────────────

function registerAllHandlers() {
  logger.info('IPC', 'Registering IPC handlers...');
  setupScanHandlers();
  setupJobsHandlers();
  setupSchedulerHandlers();
  setupAppHandlers();
  setupDashboardHandlers();
  setupScanHistoryHandlers();
  setupLogHandlers();
  setupSettingsHandlers();
  logger.info('IPC', 'All IPC handlers registered');
}

module.exports = { registerAllHandlers };