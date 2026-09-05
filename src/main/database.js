// src/main/database.js
// Phase 2: SQLite database layer using better-sqlite3
// All SQL and database logic lives here — never in renderer, preload, or IPC handlers

const path = require('path');
const { app } = require('electron');
const Database = require('better-sqlite3');
const logger = require('./logger');

// ─── Module State ──────────────────────────────────────────────────────────

let db = null;

// ─── Validation (DB layer — independent of IPC validation) ─────────────────

function validateString(value, name) {
  if (typeof value !== 'string' || value.trim().length === 0) return null;
  return value.trim();
}

function validateURL(value) {
  if (typeof value !== 'string' || value.trim().length === 0) return null;
  const trimmed = value.trim();
  try {
    const url = new URL(trimmed);
    if (url.protocol !== 'http:' && url.protocol !== 'https:') return null;
    return trimmed;
  } catch { return null; }
}

// ─── Database Path ─────────────────────────────────────────────────────────

function getDatabasePath() {
  const userDataPath = app.getPath('userData');
  return path.join(userDataPath, 'teacheron.db');
}

// ─── Initialisation ────────────────────────────────────────────────────────

function initializeDatabase() {
  if (db) {
    logger.info('DB', 'Database already initialised');
    return db;
  }

  const dbPath = getDatabasePath();
  logger.info('DB', 'Database opening at: ' + dbPath);
  console.log('[DB PATH] initializeDatabase -> ' + dbPath);

  db = new Database(dbPath);
  db.pragma('journal_mode = WAL');

  db.exec(`
    CREATE TABLE IF NOT EXISTS jobs (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      title TEXT NOT NULL,
      subject TEXT,
      location TEXT,
      student_level TEXT,
      budget TEXT,
      description TEXT,
      posted_date TEXT,
      job_url TEXT NOT NULL UNIQUE,
      scraped_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
    CREATE UNIQUE INDEX IF NOT EXISTS idx_jobs_url ON jobs(job_url);
    CREATE INDEX IF NOT EXISTS idx_jobs_scraped_at ON jobs(scraped_at);

    CREATE TABLE IF NOT EXISTS scan_history (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      started_at TEXT NOT NULL,
      completed_at TEXT,
      subject TEXT,
      location TEXT,
      max_pages INTEGER,
      pages_scraped INTEGER DEFAULT 0,
      jobs_found INTEGER DEFAULT 0,
      new_jobs INTEGER DEFAULT 0,
      existing_jobs INTEGER DEFAULT 0,
      status TEXT NOT NULL DEFAULT 'running',
      stopped_reason TEXT,
      error_message TEXT,
      duration_ms INTEGER
    );
    CREATE INDEX IF NOT EXISTS idx_scan_history_started ON scan_history(started_at);
  `);

  prepareStatements();
  logger.info('DB', 'Database initialized — tables and indexes ready');
  return db;
}

function closeDatabase() {
  if (db) {
    logger.info('DB', 'Closing database');
    db.close();
    db = null;
  }
}
// ─── Prepared Statements ────────────────────────────────────────────────────

let stmtInsert, stmtGetAll, stmtGetRecent, stmtGetByUrl, stmtJobExists, stmtCount;

function prepareStatements() {
  if (!db) throw new Error('Database not initialized');

  stmtInsert = db.prepare(`
    INSERT INTO jobs (title, subject, location, student_level, budget, description, posted_date, job_url, scraped_at)
    VALUES (@title, @subject, @location, @student_level, @budget, @description, @posted_date, @job_url, @scraped_at)
  `);

  stmtGetAll = db.prepare(`
    SELECT * FROM jobs ORDER BY scraped_at DESC LIMIT @limit OFFSET @offset
  `);

  stmtGetRecent = db.prepare(`
    SELECT * FROM jobs WHERE scraped_at >= datetime('now', @cutoff) ORDER BY scraped_at DESC
  `);

  stmtGetByUrl = db.prepare(`SELECT * FROM jobs WHERE job_url = @job_url`);
  stmtJobExists = db.prepare(`SELECT COUNT(*) AS count FROM jobs WHERE job_url = @job_url`);
  stmtCount = db.prepare(`SELECT COUNT(*) AS count FROM jobs`);
}

// ─── Job Operations ────────────────────────────────────────────────────────

function createJob(jobData) {
  if (!db) throw new Error('Database not initialized');
  console.log('[DB PATH] createJob -> ' + getDatabasePath());

  const title = validateString(jobData.title, 'title');
  if (!title) throw new Error('Job title is required and must be a non-empty string');

  const jobUrl = validateURL(jobData.job_url);
  if (!jobUrl) throw new Error('Job URL is required and must be a valid http/https URL');

  // Check for duplicates
  const exists = stmtJobExists.get({ job_url: jobUrl });
  if (exists && exists.count > 0) {
    const existingJob = stmtGetByUrl.get({ job_url: jobUrl });
    logger.info('DB', 'Duplicate job not inserted: ' + jobUrl);
    return { inserted: false, job: existingJob };
  }

  const params = {
    title,
    subject: jobData.subject || null,
    location: jobData.location || null,
    student_level: jobData.student_level || null,
    budget: jobData.budget || null,
    description: jobData.description || null,
    posted_date: jobData.posted_date || null,
    job_url: jobUrl,
    scraped_at: jobData.scraped_at || new Date().toISOString(),
  };

  const result = stmtInsert.run(params);
  const insertedJob = stmtGetByUrl.get({ job_url: jobUrl });
  logger.info('DB', 'Job inserted', { id: result.lastInsertRowid, title: title });
  console.log('[DB PATH] createJob INSERTED id=' + result.lastInsertRowid + ' path=' + getDatabasePath());
  return { inserted: true, job: insertedJob };
}

// Map DB snake_case columns to camelCase for renderer compatibility
function mapToCamelCase(row) {
  return {
    id: row.id,
    title: row.title,
    subject: row.subject,
    location: row.location,
    studentLevel: row.student_level,
    budget: row.budget,
    description: row.description,
    postedDate: row.posted_date,
    jobUrl: row.job_url,
    scrapedAt: row.scraped_at,
  };
}

function getAllJobs(offset = 1, limit = 50) {
  if (!db) throw new Error('Database not initialized');
  console.log('[DB PATH] getAllJobs -> ' + getDatabasePath());
  const total = stmtCount.get().count;
  const rawJobs = stmtGetAll.all({ offset: (offset - 1) * limit, limit });
  const jobs = rawJobs.map(mapToCamelCase);
  return { jobs, total };
}

function getRecentJobs(hours = 24) {
  if (!db) throw new Error('Database not initialized');
  console.log('[DB PATH] getRecentJobs -> ' + getDatabasePath());
  const cutoff = `-${hours} hours`;
  const rawJobs = stmtGetRecent.all({ cutoff });
  const jobs = rawJobs.map(mapToCamelCase);
  return { jobs, total: jobs.length, cutoffHours: hours };
}

function getJobByUrl(jobUrl) {
  if (!db) throw new Error('Database not initialized');
  return stmtGetByUrl.get({ job_url: jobUrl }) || null;
}

function jobExists(jobUrl) {
  if (!db) throw new Error('Database not initialized');
  return stmtJobExists.get({ job_url: jobUrl }).count > 0;
}

function getJobCount() {
  if (!db) throw new Error('Database not initialized');
  return stmtCount.get().count;
}

function clearJobs() {
  if (!db) throw new Error('Database not initialized');
  console.log('[DB PATH] clearJobs -> ' + getDatabasePath());
  const result = db.prepare('DELETE FROM jobs').run();
  logger.info('DB', 'All jobs cleared — ' + result.changes + ' rows deleted');
  return result.changes;
}

// ─── Scan History ──────────────────────────────────────────────────────

let stmtInsertScan, stmtUpdateScan, stmtGetScanHistory, stmtClearScanHistory;

function prepareScanStatements() {
  if (!db) throw new Error('Database not initialized');
  stmtInsertScan = db.prepare(`
    INSERT INTO scan_history (started_at, completed_at, subject, location, max_pages, pages_scraped, jobs_found, new_jobs, existing_jobs, status, stopped_reason, error_message, duration_ms)
    VALUES (@started_at, @completed_at, @subject, @location, @max_pages, @pages_scraped, @jobs_found, @new_jobs, @existing_jobs, @status, @stopped_reason, @error_message, @duration_ms)
  `);
  stmtUpdateScan = db.prepare(`
    UPDATE scan_history SET completed_at = @completed_at, pages_scraped = @pages_scraped, jobs_found = @jobs_found, new_jobs = @new_jobs, existing_jobs = @existing_jobs, status = @status, stopped_reason = @stopped_reason, error_message = @error_message, duration_ms = @duration_ms WHERE id = @id
  `);
  stmtGetScanHistory = db.prepare(`
    SELECT * FROM scan_history ORDER BY started_at DESC LIMIT @limit
  `);
  stmtClearScanHistory = db.prepare('DELETE FROM scan_history');
}

function createScanRecord(data) {
  if (!db) throw new Error('Database not initialized');
  if (!stmtInsertScan) prepareScanStatements();
  const params = {
    started_at: data.startedAt || new Date().toISOString(),
    completed_at: data.completedAt || null,
    subject: data.subject || null,
    location: data.location || null,
    max_pages: data.maxPages || null,
    pages_scraped: data.pagesScraped || 0,
    jobs_found: data.jobsFound || 0,
    new_jobs: data.newJobs || 0,
    existing_jobs: data.existingJobs || 0,
    status: data.status || 'running',
    stopped_reason: data.stoppedReason || null,
    error_message: data.errorMessage || null,
    duration_ms: data.durationMs || null,
  };
  const result = stmtInsertScan.run(params);
  return result.lastInsertRowid;
}

function updateScanRecord(id, data) {
  if (!db) throw new Error('Database not initialized');
  if (!stmtUpdateScan) prepareScanStatements();
  stmtUpdateScan.run({
    id,
    completed_at: data.completedAt || null,
    pages_scraped: data.pagesScraped || 0,
    jobs_found: data.jobsFound || 0,
    new_jobs: data.newJobs || 0,
    existing_jobs: data.existingJobs || 0,
    status: data.status || 'unknown',
    stopped_reason: data.stoppedReason || null,
    error_message: data.errorMessage || null,
    duration_ms: data.durationMs || null,
  });
}

function getScanHistory(limit = 20) {
  if (!db) throw new Error('Database not initialized');
  if (!stmtGetScanHistory) prepareScanStatements();
  // map snake_case to camelCase
  const rows = stmtGetScanHistory.all({ limit });
  return rows.map(r => ({
    id: r.id,
    startedAt: r.started_at,
    completedAt: r.completed_at,
    subject: r.subject,
    location: r.location,
    maxPages: r.max_pages,
    pagesScraped: r.pages_scraped,
    jobsFound: r.jobs_found,
    newJobs: r.new_jobs,
    existingJobs: r.existing_jobs,
    status: r.status,
    stoppedReason: r.stopped_reason,
    errorMessage: r.error_message,
    durationMs: r.duration_ms,
  }));
}

function clearScanHistory() {
  if (!db) throw new Error('Database not initialized');
  if (!stmtClearScanHistory) prepareScanStatements();
  const result = stmtClearScanHistory.run();
  return result.changes;
}

// New today count: jobs scraped within the last 24 hours
let stmtNewToday;
function getNewTodayCount() {
  if (!db) throw new Error('Database not initialized');
  if (!stmtNewToday) {
    stmtNewToday = db.prepare("SELECT COUNT(*) AS count FROM jobs WHERE scraped_at >= datetime('now', '-1 day')");
  }
  return stmtNewToday.get().count;
}

function clearAllData() {
  if (!db) throw new Error('Database not initialized');
  const jobs = db.prepare('DELETE FROM jobs').run();
  const scans = db.prepare('DELETE FROM scan_history').run();
  return { jobs: jobs.changes, scans: scans.changes };
}

function getDatabaseInfo() {
  if (!db) throw new Error('Database not initialized');
  const path = getDatabasePath();
  const totalJobs = getJobCount();
  return { path, totalJobs };
}
// ─── Exports ───────────────────────────────────────────────────────────────

module.exports = {
  initializeDatabase,
  closeDatabase,
  createJob,
  getAllJobs,
  getRecentJobs,
  getJobByUrl,
  jobExists,
  getJobCount,
  clearJobs,
  getDatabasePath,
  // Scan history
  createScanRecord,
  updateScanRecord,
  getScanHistory,
  clearScanHistory,
  // Dashboard
  getNewTodayCount,
  clearAllData,
  getDatabaseInfo,
};