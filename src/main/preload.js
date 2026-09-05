// src/main/preload.js — Secure preload script
// Phase 1: Expose controlled IPC API via contextBridge
// NOTE: IPC channel names are inlined here for sandbox compatibility.
// They MUST match src/shared/constants.js exactly.

(function () {
  'use strict';

  console.log('[Preload] =============================================');
  console.log('[Preload] Script starting...');

  try {
    // __filename is NOT available in sandboxed preloads on Electron 20+
    console.log('[Preload] __filename:', typeof __filename !== 'undefined' ? __filename : '(sandboxed — not available)');
    // 1. Load Electron
    var electron;
    try {
      electron = require('electron');
      console.log('[Preload] Electron loaded OK');
    } catch (e) {
      console.error('[Preload] FATAL: Cannot require electron:', e.message);
      return;
    }

    var contextBridge = electron.contextBridge;
    var ipcRenderer = electron.ipcRenderer;
    console.log('[Preload] contextBridge:', typeof contextBridge);
    console.log('[Preload] ipcRenderer:', typeof ipcRenderer);

    if (!contextBridge || !ipcRenderer) {
      console.error('[Preload] FATAL: contextBridge or ipcRenderer missing');
      return;
    }

    // 2. IPC channel names (inlined for maximum compatibility)
    // Must match src/shared/constants.js — keep in sync!
    var IPC = {
      SCAN_START: 'scan:start',
      SCAN_STOP: 'scan:stop',
      SCAN_PROGRESS: 'scan:progress',
      SCAN_ERROR: 'scan:error',
      JOBS_GET_ALL: 'jobs:get-all',
      JOBS_GET_RECENT: 'jobs:get-recent',
      JOBS_OPEN_URL: 'jobs:open-url',
      JOBS_CLEAR_ALL: 'jobs:clear-all',
      LOG_EVENT: 'log:event',
      SCHEDULER_START: 'scheduler:start',
      SCHEDULER_STOP: 'scheduler:stop',
      SCHEDULER_STATUS: 'scheduler:status',
      APP_QUIT: 'app:quit',
      DASHBOARD_STATS: 'dashboard:stats',
      SCAN_HISTORY_GET: 'scan-history:get',
      SCAN_HISTORY_CLEAR: 'scan-history:clear',
      LOGS_GET: 'logs:get',
      LOGS_CLEAR: 'logs:clear',
      SETTINGS_GET: 'settings:get',
      SETTINGS_SAVE: 'settings:save',
      DB_CLEAR_ALL: 'db:clear-all',
      DB_INFO: 'db:info'
    };
    console.log('[Preload] IPC channels defined:', Object.keys(IPC).join(', '));

    // 3. Expose safe API to renderer
    var api = {
      // App info
      getVersion: function () { return '1.0.0'; },
      getAppName: function () { return 'TeacherOn Tutor Job Scraper'; },
      ping: function () { return 'pong'; },

      // Scan
      scanStart: function (options) {
        console.log('[Preload] scanStart called with:', options);
        return ipcRenderer.invoke(IPC.SCAN_START, options || {});
      },
      scanStop: function () {
        console.log('[Preload] scanStop called');
        return ipcRenderer.invoke(IPC.SCAN_STOP);
      },

      // Jobs
      getJobs: function (options) { return ipcRenderer.invoke(IPC.JOBS_GET_ALL, options || {}); },
      getRecentJobs: function (options) { return ipcRenderer.invoke(IPC.JOBS_GET_RECENT, options || {}); },
      openJobUrl: function (url) { return ipcRenderer.invoke(IPC.JOBS_OPEN_URL, url); },
      clearAllJobs: function () { return ipcRenderer.invoke(IPC.JOBS_CLEAR_ALL); },

      // Scheduler
      schedulerStart: function (options) { return ipcRenderer.invoke(IPC.SCHEDULER_START, options || {}); },
      schedulerStop: function () { return ipcRenderer.invoke(IPC.SCHEDULER_STOP); },
      schedulerStatus: function () { return ipcRenderer.invoke(IPC.SCHEDULER_STATUS); },

      // Log events (main → renderer)
      onLogEvent: function (callback) {
        var handler = function (_event, data) { callback(data); };
        ipcRenderer.on(IPC.LOG_EVENT, handler);
        return function () { ipcRenderer.removeListener(IPC.LOG_EVENT, handler); };
      },

      // App
      quitApp: function () { return ipcRenderer.invoke(IPC.APP_QUIT); },

      // Dashboard
      getDashboardStats: function () { return ipcRenderer.invoke(IPC.DASHBOARD_STATS); },

      // Scan History
      getScanHistory: function (limit) { return ipcRenderer.invoke(IPC.SCAN_HISTORY_GET, limit || 20); },
      clearScanHistory: function () { return ipcRenderer.invoke(IPC.SCAN_HISTORY_CLEAR); },

      // Logs
      getLogs: function () { return ipcRenderer.invoke(IPC.LOGS_GET); },
      clearLogs: function () { return ipcRenderer.invoke(IPC.LOGS_CLEAR); },

      // Settings
      getSettings: function () { return ipcRenderer.invoke(IPC.SETTINGS_GET); },
      saveSettings: function (settings) { return ipcRenderer.invoke(IPC.SETTINGS_SAVE, settings); },

      // Database management
      clearAllData: function () { return ipcRenderer.invoke(IPC.DB_CLEAR_ALL); },
      getDbInfo: function () { return ipcRenderer.invoke(IPC.DB_INFO); },
    };
    console.log('[Preload] API methods:', Object.keys(api).join(', '));

    // 4. Expose to renderer
    contextBridge.exposeInMainWorld('scraperAPI', api);
    console.log('[Preload] ✓ contextBridge.exposeInMainWorld SUCCEEDED');
    console.log('[Preload] =============================================');

  } catch (err) {
    console.error('[Preload] =============================================');
    console.error('[Preload] ✗ FATAL ERROR!');
    console.error('[Preload] Error:', err.name || 'Unknown');
    console.error('[Preload] Message:', err.message || 'No message');
    console.error('[Preload] Stack:', err.stack || 'No stack');
    console.error('[Preload] =============================================');
  }

})();