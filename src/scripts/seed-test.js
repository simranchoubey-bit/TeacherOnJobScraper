// src/scripts/seed-test.js
// Phase 2: Temporary test script for verifying database operations
// NOT part of normal app startup — run manually via Node.js
//
// Usage: node src/scripts/seed-test.js
//
// Tests: create, read, duplicate handling, queries, validation

const Database = require('better-sqlite3');

// Use a temporary in-memory database (not the production one)
const db = new Database(':memory:');

// ─── Schema ─────────────────────────────────────────────────────────────────

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
`);

// ─── Prepared Statements ────────────────────────────────────────────────────

const stmtInsert = db.prepare(`
  INSERT INTO jobs (title, subject, location, student_level, budget, description, posted_date, job_url, scraped_at)
  VALUES (@title, @subject, @location, @student_level, @budget, @description, @posted_date, @job_url, @scraped_at)
`);

const stmtGetAll = db.prepare(`SELECT * FROM jobs ORDER BY scraped_at DESC LIMIT @limit OFFSET @offset`);
const stmtGetRecent = db.prepare(`SELECT * FROM jobs WHERE scraped_at >= datetime('now', @cutoff) ORDER BY scraped_at DESC`);
const stmtGetByUrl = db.prepare(`SELECT * FROM jobs WHERE job_url = @job_url`);
const stmtJobExists = db.prepare(`SELECT COUNT(*) AS count FROM jobs WHERE job_url = @job_url`);
const stmtCount = db.prepare(`SELECT COUNT(*) AS count FROM jobs`);

// ─── Validation ─────────────────────────────────────────────────────────────

function validateString(value) {
  if (typeof value !== 'string' || value.trim().length === 0) return null;
  return value.trim();
}

function validateURL(value) {
  if (typeof value !== 'string' || value.trim().length === 0) return null;
  const trimmed = value.trim();
  try { const u = new URL(trimmed); if (u.protocol !== 'http:' && u.protocol !== 'https:') return null; return trimmed; }
  catch { return null; }
}

// ─── CRUD Functions ─────────────────────────────────────────────────────────

function createJob(jobData) {
  const title = validateString(jobData.title);
  if (!title) throw new Error('title required');
  const jobUrl = validateURL(jobData.job_url);
  if (!jobUrl) throw new Error('job_url required');

  const exists = stmtJobExists.get({ job_url: jobUrl });
  if (exists && exists.count > 0) {
    const existing = stmtGetByUrl.get({ job_url: jobUrl });
    return { inserted: false, job: existing };
  }

  stmtInsert.run({
    title,
    subject: jobData.subject || null,
    location: jobData.location || null,
    student_level: jobData.student_level || null,
    budget: jobData.budget || null,
    description: jobData.description || null,
    posted_date: jobData.posted_date || null,
    job_url: jobUrl,
    scraped_at: jobData.scraped_at || new Date().toISOString(),
  });
  return { inserted: true, job: stmtGetByUrl.get({ job_url: jobUrl }) };
}

function getAllJobs(offset = 1, limit = 50) {
  const total = stmtCount.get().count;
  const jobs = stmtGetAll.all({ offset: (offset - 1) * limit, limit });
  return { jobs, total };
}

function getRecentJobs(hours = 24) {
  const jobs = stmtGetRecent.all({ cutoff: `-${hours} hours` });
  return { jobs, total: jobs.length, cutoffHours: hours };
}

function getJobByUrl(url) { return stmtGetByUrl.get({ job_url: url }) || null; }
function jobExists(url) { return stmtJobExists.get({ job_url: url }).count > 0; }

// ─── Test Runner ────────────────────────────────────────────────────────────
let passed = 0;
let failed = 0;

function test(name, fn) {
  try {
    fn();
    passed++;
    console.log('  ✅ ' + name);
  } catch (e) {
    failed++;
    console.log('  ❌ ' + name + ' — ' + e.message);
  }
}

function assert(cond, msg) { if (!cond) throw new Error(msg || 'assertion failed'); }

console.log('Phase 2: SQLite Database Layer — Seed Test');
console.log('============================================\n');

// T1: Insert valid job
test('T1: create valid job', () => {
  const result = createJob({
    title: 'Math Tutor Needed',
    subject: 'Mathematics',
    location: 'Remote',
    student_level: 'Grade 10',
    budget: '$15/hr',
    description: 'Looking for an experienced math tutor',
    posted_date: '2 hours ago',
    job_url: 'https://www.teacheron.com/tutor-job/example-1',
  });
  assert(result.inserted === true);
  assert(result.job.title === 'Math Tutor Needed');
  assert(result.job.id === 1);
});

// T2: Insert second job
test('T2: create second job', () => {
  const result = createJob({
    title: 'English Tutor',
    subject: 'English',
    job_url: 'https://www.teacheron.com/tutor-job/example-2',
  });
  assert(result.inserted === true);
  assert(result.job.id === 2);
});

// T3: Duplicate URL handled safely
test('T3: duplicate job_url rejected', () => {
  const result = createJob({
    title: 'Different Title',
    job_url: 'https://www.teacheron.com/tutor-job/example-1',
  });
  assert(result.inserted === false, 'should not insert duplicate');
  assert(result.job.title === 'Math Tutor Needed', 'should return existing job');
});

// T4: getAllJobs
test('T4: getAllJobs returns 2 jobs', () => {
  const result = getAllJobs(1, 10);
  assert(result.total === 2);
  assert(result.jobs.length === 2);
});

// T5: getRecentJobs within 24 hours
test('T5: getRecentJobs for 24h returns 2', () => {
  const result = getRecentJobs(24);
  assert(result.total === 2);
});

// T6: getJobByUrl
test('T6: getJobByUrl finds existing', () => {
  const job = getJobByUrl('https://www.teacheron.com/tutor-job/example-2');
  assert(job !== null);
  assert(job.title === 'English Tutor');
});

// T7: getJobByUrl returns null for missing
test('T7: getJobByUrl missing returns null', () => {
  const job = getJobByUrl('https://www.teacheron.com/nonexistent');
  assert(job === null);
});

// T8: jobExists
test('T8: jobExists returns true/false', () => {
  assert(jobExists('https://www.teacheron.com/tutor-job/example-1') === true);
  assert(jobExists('https://example.com/not-there') === false);
});

// Validation tests
console.log('\n  -- Validation --');

// V1: empty title
test('V1: empty title rejected', () => {
  try { createJob({ title: '', job_url: 'https://example.com/j1' }); throw new Error('should have thrown'); }
  catch (e) { assert(e.message.includes('title'), e.message); }
});

// V2: missing title
test('V2: missing title rejected', () => {
  try { createJob({ job_url: 'https://example.com/j2' }); throw new Error('should have thrown'); }
  catch (e) { assert(e.message.includes('title'), e.message); }
});

// V3: empty URL
test('V3: empty URL rejected', () => {
  try { createJob({ title: 'Test', job_url: '' }); throw new Error('should have thrown'); }
  catch (e) { assert(e.message.includes('job_url'), e.message); }
});

// V4: missing URL
test('V4: missing URL rejected', () => {
  try { createJob({ title: 'Test' }); throw new Error('should have thrown'); }
  catch (e) { assert(e.message.includes('job_url'), e.message); }
});

// V5: ftp:// URL
test('V5: ftp:// URL rejected', () => {
  try { createJob({ title: 'Test', job_url: 'ftp://files.example.com' }); throw new Error('should have thrown'); }
  catch (e) { assert(e.message.includes('job_url'), e.message); }
});

// V6: javascript: URL
test('V6: javascript: URL rejected', () => {
  try { createJob({ title: 'Test', job_url: 'javascript:alert(1)' }); throw new Error('should have thrown'); }
  catch (e) { assert(e.message.includes('job_url'), e.message); }
});

// V7: optional fields can be null
test('V7: optional fields null ok', () => {
  const result = createJob({
    title: 'Minimal Job',
    job_url: 'https://example.com/minimal',
  });
  assert(result.inserted === true);
  assert(result.job.subject === null);
  assert(result.job.location === null);
});

// ─── Cleanup ────────────────────────────────────────────────────────────────

db.close();

console.log('\nResults: ' + passed + ' passed, ' + failed + ' failed, ' + (passed + failed) + ' total');

if (failed > 0) {
  console.log('❌ SOME TESTS FAILED');
  process.exit(1);
} else {
  console.log('✅ ALL TESTS PASSED');
  process.exit(0);
}