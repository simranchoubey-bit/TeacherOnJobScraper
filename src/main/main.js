// src/main/main.js — Electron main process
// Phase 0+1+2+7+8: Secure defaults + IPC handlers + SQLite database + scheduler

const { app, BrowserWindow } = require('electron');
const path = require('path');
const logger = require('./logger');
const { initializeDatabase, closeDatabase } = require('./database');
const { registerAllHandlers } = require('./ipc-handlers');
const scheduler = require('./scheduler');
const { closeBrowser, abortScan, clearAbortController } = require('./scraper');

// Keep a global reference of the window object to prevent garbage collection
let mainWindow = null;
let shuttingDown = false;  // Phase 8: Prevents duplicate shutdown actions

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1024,
    height: 768,
    minWidth: 800,
    minHeight: 600,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,   // Isolate renderer from Node.js
      nodeIntegration: false,   // No require() in renderer
      sandbox: true,            // Sandbox the renderer process
    },
    title: 'TeacherOn Tutor Job Scraper',
  });

  // Load the renderer HTML
  mainWindow.loadFile(path.join(__dirname, '..', 'renderer', 'index.html'));

  // Set up logger callback to send errors to renderer after page loads
  mainWindow.webContents.on('did-finish-load', function () {
    logger.setRendererCallback(function (data) {
      try {
        if (mainWindow && !mainWindow.isDestroyed()) {
          mainWindow.webContents.send('log:event', data);
        }
      } catch (e) {}
    });
  });

  // Open DevTools if --dev flag is passed
  if (process.argv.includes('--dev')) {
    mainWindow.webContents.openDevTools();
  }

  // Dereference the window when closed
  mainWindow.on('closed', () => {
    mainWindow = null;
  });
}

// Create window when Electron is ready
app.whenReady().then(() => {
  logger.info('Main', 'TeacherOn Scraper starting...');

  // 1. Initialize database first
  initializeDatabase();
  logger.info('Main', 'Database initialized');

  // 2. Register IPC handlers (may depend on database)
  registerAllHandlers();
  logger.info('Main', 'IPC handlers registered');

  // 3. Create the window
  createWindow();

  // macOS: re-create window when dock icon clicked and no windows open
  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) {
      createWindow();
    }
  });
});

// Quit when all windows are closed (except on macOS)
app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') {
    app.quit();
  }
});

// Cleanup on quit — Phase 8: Graceful shutdown sequence
// 1. Stop cron scheduler and wait for in-flight scan
// 2. Abort any in-flight manual scan
// 3. Close Playwright browser and page
// 4. Close SQLite database
app.on('before-quit', async (event) => {
  // Prevent duplicate shutdown from multiple before-quit events
  if (shuttingDown) {
    logger.info('Main', 'Shutdown already in progress — ignoring duplicate event');
    return;
  }
  shuttingDown = true;

  logger.info('Main', 'Shutting down...');

  // Prevent the app from quitting immediately — we need to clean up first
  event.preventDefault();

  try {
    // 1. Stop the cron scheduler (doesn't wait for in-flight scan)
    scheduler.cleanup();
    console.log('[Main] Scheduler cleaned up');

    // 2. Abort any in-flight scan (manual or scheduler-triggered)
    logger.info('Main', 'Stopping scheduler and aborting scans...');
    abortScan();
    clearAbortController();
    logger.info('Main', 'Scan aborted and abort controller cleared');

    // 3. Close the Playwright browser (safe — wrapped in try/catch internally)
    await closeBrowser();
    logger.info('Main', 'Browser closed');

    // 4. Close the SQLite database
    closeDatabase();
    logger.info('Main', 'Database closed');

    // 5. Close the logger
    logger.close();
  } catch (error) {
    console.error('[Main] Error during shutdown:', error.message);
  } finally {
    console.log('[Main] Shutdown complete');
    // Now actually quit the app
    app.exit(0);
  }
});

// Phase 8: Global error handlers — prevent unhandled rejections/exceptions
// from crashing the app silently.

process.on('uncaughtException', (error) => {
  logger.error('Main', 'UNCAUGHT EXCEPTION: ' + error.message);
  console.error('[Main] Stack:', error.stack);
  // Don't exit — let the app keep running. Log and move on.
  // The crash reporter / error log should be checked in dev.
});

process.on('unhandledRejection', (reason, promise) => {
  var reasonMsg = reason instanceof Error ? reason.message : String(reason);
  logger.error('Main', 'UNHANDLED REJECTION: ' + reasonMsg);
  // Don't exit — just log. The promise rejection is caught here
  // so it doesn't cause an unhandledRejection crash in Node.js.
});

process.on('SIGTERM', async () => {
  logger.info('Main', 'Received SIGTERM — shutting down');
  if (!shuttingDown) {
    shuttingDown = true;
    scheduler.cleanup();
    abortScan();
    clearAbortController();
    await closeBrowser();
    closeDatabase();
  }
  process.exit(0);
});

// Log started
logger.info('Main', 'Application ready');