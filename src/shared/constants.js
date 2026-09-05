// src/shared/constants.js
// Phase 1+: Shared IPC channel names and constants
// Currently a placeholder — will be populated in Phase 1

// IPC Channel names (to be used in Phase 1+)
const IPC_CHANNELS = {
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
  // New channels
  DASHBOARD_STATS: 'dashboard:stats',
  SCAN_HISTORY_GET: 'scan-history:get',
  SCAN_HISTORY_CLEAR: 'scan-history:clear',
  LOGS_GET: 'logs:get',
  LOGS_CLEAR: 'logs:clear',
  SETTINGS_GET: 'settings:get',
  SETTINGS_SAVE: 'settings:save',
  DB_CLEAR_ALL: 'db:clear-all',
  DB_INFO: 'db:info',
};

// Job field names for consistency
const JOB_FIELDS = [
  'title',
  'subject',
  'location',
  'student_level',
  'budget',
  'description',
  'posted_date',
  'job_url',
  'scraped_at',
];

// Export for CommonJS (main process)
if (typeof module !== 'undefined' && module.exports) {
  module.exports = { IPC_CHANNELS, JOB_FIELDS };
}