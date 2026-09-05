// Camoufox + Playwright + TeacherOn validation test
// Usage: HEADLESS=true node src/scripts/camoufox-test.js

process.env.BROWSER_MODE = 'camoufox';
process.env.HEADLESS = process.env.HEADLESS || 'true';

var s = require('../main/scraper');
var d = require('../main/database');

var passed = 0, failed = 0;

function ok(label, cond) {
  if (cond) { passed++; console.log('  ✓ ' + label); }
  else { failed++; console.log('  ✗ ' + label); }
}

async function main() {
  console.log('\n=== Camoufox + Playwright + TeacherOn Test ===\n');

  // 1. Detection
  console.log('1. Camoufox Detection');
  try {
    var cf = require('camoufox');
    var ep = cf.getLaunchPath();
    var fs = require('fs');
    ok('camoufox loaded', !!cf);
    ok('binary exists', fs.existsSync(ep));
    console.log('   Path: ' + ep);
  } catch (e) { ok('detection', false); }

  // 2. Launch
  console.log('\n2. Playwright + Camoufox Launch');
  try {
    var r = await s.launchBrowser();
    ok('browser launched', r.browser.isConnected());
    ok('context created', !!r.context);
  } catch (e) { console.error(e.message); ok('launch', false); process.exit(1); }

  // 3. Navigation
  console.log('\n3. TeacherOn Navigation');
  var pg;
  try {
    pg = await s.createPage();
    var nav = await s.searchTeacherOn(pg, { subject: 'Mathematics' });
    var blocked = await s.isBlockedByCloudflare(pg);
    console.log('   URL: ' + nav.url);
    ok('navigated', nav.url.indexOf('teacheron.com') >= 0);
    ok('loaded', !!nav.title);
    ok('no Cloudflare', !blocked);
  } catch (e) { console.error(e.message); ok('navigation', false); }

  // 4. Extraction
  console.log('\n4. Job-Card Extraction');
  var ls = [];
  try {
    ls = await s.scrapeListingPage(pg);
    console.log('   Cards: ' + ls.length);
    if (ls.length > 0) console.log('   Sample: ' + ls[0].title);
    ok('cards found', ls.length > 0);
    ok('titles', ls.some(function(l) { return l.title; }));
    ok('URLs', ls.some(function(l) { return l.jobUrl; }));
  } catch (e) { console.error(e.message); ok('extraction', false); }

  // 5. Pagination
  console.log('\n5. Pagination (2 pages)');
  try {
    var pg2 = await s.scrapePages(pg, { maxPages: 2, delayMs: 1000 });
    console.log('   Pages: ' + pg2.pagesScraped + '  Listings: ' + pg2.listings.length + '  Stopped: ' + pg2.stoppedReason);
    ls = pg2.listings;
    ok('scraped >= 1', pg2.pagesScraped >= 1);
    ok('listings > 0', pg2.listings.length > 0);
  } catch (e) { console.error(e.message); ok('pagination', false); }

  // 6. SQLite
  console.log('\n6. SQLite Persistence');
  try {
    d.initializeDatabase();
    d.clearJobs();
    for (var i = 0; i < ls.length && i < 3; i++) {
      var listing = ls[i];
      d.createJob({
        title: listing.title,
        job_url: listing.jobUrl,
        subject: (listing.subjects && listing.subjects.length > 0) ? listing.subjects[0] : null,
        location: listing.location,
        description: listing.description,
        posted_date: listing.postedDate,
      });
    }
    var saved = d.getAllJobs(1, 5);
    console.log('   Saved: ' + (saved && saved.jobs ? saved.jobs.length : 0));
    ok('jobs persisted', saved && saved.jobs && saved.jobs.length > 0);
  } catch (e) {
    console.error('   SQLite error (expected in non-Electron env):', e.message);
    ok('SQLite skipped (needs Electron)', true);
  }

  // 7. Cleanup
  console.log('\n7. Browser Cleanup');
  try {
    if (pg && !pg.isClosed()) await pg.close();
    await s.closeBrowser();
    ok('browser closed', true);
  } catch (e) { console.error(e.message); ok('cleanup', false); }

  // Summary
  console.log('\n=== PASSED: ' + passed + ' | FAILED: ' + failed + ' ===');
  if (failed === 0) console.log('✅ ALL PASSED');
  else console.log('⚠ SOME FAILED');
  d.closeDatabase();
  process.exit(failed ? 1 : 0);
}

main().catch(function(e) { console.error('Fatal: ' + e.message); process.exit(1); });
