// src/main/scheduler.js
// Phase 7: Cron-based scheduler for periodic scanning
//
// Uses node-cron for 30/60-minute intervals.
// Runs the first scan immediately when started.
// Prevents overlapping scans.
// Exposes start(), stop(), getStatus().

const cron = require('node-cron');
const logger = require('./logger');

// ─── Valid Interval Minutes ─────────────────────────────────────────────────
const VALID_INTERVALS = new Set([30, 60]);

// ─── Scheduler State ────────────────────────────────────────────────────────
let cronJob = null;       // node-cron scheduled task
let isScanning = false;   // overlap guard
let state = {
  running: false,
  intervalMinutes: 0,
  startedAt: null,
  nextRun: null,
  lastRunStartedAt: null,
  lastRunCompletedAt: null,
  lastRunStatus: null,    // 'success' | 'failed'
  lastRunError: null,
  runCount: 0,
};

// ─── Helpers ────────────────────────────────────────────────────────────────

/**
 * Compute the next time the cron job will fire.
 * For intervals of 30 or 60 minutes starting at the top of the hour.
 */
function computeNextRun(intervalMinutes) {
  const now = new Date();
  const next = new Date(now);

  if (intervalMinutes === 60) {
    // Next top of the hour
    next.setMinutes(0, 0, 0);
    next.setHours(next.getHours() + 1);
  } else {
    // intervalMinutes === 30: next 0 or 30 of the hour
    const currentMinute = now.getMinutes();
    if (currentMinute < 30) {
      next.setMinutes(30, 0, 0);
    } else {
      next.setMinutes(0, 0, 0);
      next.setHours(next.getHours() + 1);
    }
  }

  return next.toISOString();
}

/**
 * Start the scheduler.
 * @param {number} intervalMinutes - Must be one of VALID_INTERVALS (30 | 60)
 * @param {() => Promise<void>} scanCallback - The scan function to invoke
 * @returns {{ success: boolean, message: string, intervalMinutes: number, nextRun: string }}
 */
function start(intervalMinutes, scanCallback) {
  if (state.running) {
    return { success: false, message: 'Scheduler is already running.' };
  }

  // Validate interval
  const interval = Number(intervalMinutes) || 60;
  if (!VALID_INTERVALS.has(interval)) {
    return { success: false, message: `Invalid interval: must be 30 or 60 minutes, got ${intervalMinutes}` };
  }

  if (typeof scanCallback !== 'function') {
    return { success: false, message: 'Internal error: scanCallback must be a function' };
  }

  // Build cron expression: every 30 or 60 minutes
  // Format: minute hour dayOfMonth month dayOfWeek
  // "*/30 * * * *" or "0 */1 * * *" (every hour at minute 0)
  let cronExpression;
  if (interval === 30) {
    // At minute 0 and 30 of every hour
    cronExpression = '0,30 * * * *';
  } else {
    // At minute 0 of every hour
    cronExpression = '0 * * * *';
  }

  logger.info('Scheduler', 'Starting with interval ' + interval + ' min, cron: \"' + cronExpression + '\"');

  // ── Scan wrapper: prevents overlap ──────────────────────────────────────
  const scheduledTask = async () => {
    if (isScanning) {
      logger.info('Scheduler', 'Skipping tick — previous scan still running');
      return;
    }
    isScanning = true;

    state.lastRunStartedAt = new Date().toISOString();
    state.runCount += 1;

    logger.info('Scheduler', 'Running scan #' + state.runCount + ' at ' + state.lastRunStartedAt);

    try {
      await scanCallback();
      state.lastRunCompletedAt = new Date().toISOString();
      state.lastRunStatus = 'success';
      state.lastRunError = null;
      logger.info('Scheduler', 'Scan #' + state.runCount + ' completed at ' + state.lastRunCompletedAt);
    } catch (err) {
      state.lastRunCompletedAt = new Date().toISOString();
      state.lastRunStatus = 'failed';
      state.lastRunError = err.message;
      logger.error('Scheduler', 'Scan #' + state.runCount + ' failed: ' + err.message);
    } finally {
      isScanning = false;
      state.nextRun = state.running ? computeNextRun(state.intervalMinutes) : null;
    }
  };

  // Create and start the cron job
  cronJob = cron.schedule(cronExpression, scheduledTask, { scheduled: false });
  cronJob.start();

  // Update state AFTER cron job is created (so nextDate() works)
  state.running = true;
  state.intervalMinutes = interval;
  state.startedAt = new Date().toISOString();
  state.nextRun = computeNextRun(interval);
  state.lastRunStartedAt = null;
  state.lastRunCompletedAt = null;
  state.lastRunStatus = null;
  state.lastRunError = null;
  state.runCount = 0;

  // Run the first scan IMMEDIATELY (next event loop tick)
  // Use setImmediate so the IPC response is sent first, then the scan runs
  setImmediate(() => {
    logger.info('Scheduler', 'Running immediate first scan...');
    scheduledTask();
  });

  return {
    success: true,
    message: 'Scheduler started. First scan running immediately.',
    intervalMinutes: interval,
    nextRun: state.nextRun,
    startedAt: state.startedAt,
  };
}

/**
 * Stop the scheduler.
 * @returns {{ success: boolean, message: string }}
 */
function stop() {
  if (!state.running) {
    return { success: false, message: 'Scheduler is not running.' };
  }

  logger.info('Scheduler', 'Stopping scheduler...');
  if (cronJob) {
    cronJob.stop();
    cronJob = null;
  }

  state.running = false;
  state.intervalMinutes = 0;
  state.nextRun = null;

  const result = {
    success: true,
    message: 'Scheduler stopped.',
    stoppedAt: new Date().toISOString(),
    totalRuns: state.runCount,
  };

  logger.info('Scheduler', 'Stopped — total runs: ' + state.runCount);

  return result;
}

/**
 * Get current scheduler status.
 * @returns {{ running: boolean, intervalMinutes: number, startedAt: string|null, nextRun: string|null, ... }}
 */
function getStatus() {
  return {
    running: state.running,
    intervalMinutes: state.intervalMinutes,
    startedAt: state.startedAt,
    nextRun: state.nextRun,
    lastRunStartedAt: state.lastRunStartedAt,
    lastRunCompletedAt: state.lastRunCompletedAt,
    lastRunStatus: state.lastRunStatus,
    lastRunError: state.lastRunError,
    runCount: state.runCount,
    isScanning, // so UI knows if a scan is currently in-flight
    timestamp: new Date().toISOString(),
  };
}

/**
 * Used by main.js on before-quit to clean up.
 */
function cleanup() {
  if (state.running) {
    logger.info('Scheduler', 'Cleanup — stopping active scheduler');
    stop();
  }
}

module.exports = { start, stop, getStatus, cleanup };