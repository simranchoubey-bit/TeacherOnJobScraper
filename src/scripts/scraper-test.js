// src/scripts/scraper-test.js
// Phase 5: Scraper test with pagination
//
// Usage:
//   MAX_PAGES=3 HEADLESS=true node src/scripts/scraper-test.js
//
//   MAX_PAGES=2 SUBJECT="Mathematics" LOCATION="Mumbai" HEADLESS=true node src/scripts/scraper-test.js
//
// Tests:
//   A. Subject + Location search - 2 pages
//   B. Max page limit - 3 pages
//   C. No-results subject - ZxYwNosuchthing999
//   D. Pagination end detection (search that runs out of pages)

const {
  launchBrowser,
  closeBrowser,
  createPage,
  searchTeacherOn,
  scrapePages,
} = require('../main/scraper');

const subject = process.env.SUBJECT || 'Mathematics';
const location = process.env.LOCATION || 'Mumbai';
const maxPages = parseInt(process.env.MAX_PAGES || '3', 10);

function printSummary(result) {
  console.log('\n' + '='.repeat(60));
  console.log('  RESULT: Pages scraped:', result.pagesScraped, 'Stopped:', result.stoppedReason);
  console.log('  Unique listings:', result.listings.length);
  console.log('='.repeat(60));

  result.listings.slice(0, 5).forEach(function(job, i) {
    console.log('\n' + (i + 1) + '. Title:', job.title || '(no title)');
    if (job.subjects && job.subjects.length > 0)
      console.log('   Subjects:', job.subjects.join(', '));
    if (job.location) console.log('   Location:', job.location);
    if (job.postedDate) console.log('   Posted:', job.postedDate);
    if (job.description)
      console.log('   Desc:', job.description.substring(0, 80) + '...');
    console.log('   URL:', job.jobUrl);
  });

  if (result.listings.length > 5) {
    console.log('\n   ... and', result.listings.length - 5, 'more listings');
  }

  var listings = result.listings;
  var withTitle = listings.filter(function(j) { return j.title; }).length;
  var withLocation = listings.filter(function(j) { return j.location; }).length;
  var withPosted = listings.filter(function(j) { return j.postedDate; }).length;
  var withDesc = listings.filter(function(j) { return j.description; }).length;
  var withSubjects = listings.filter(function(j) { return j.subjects && j.subjects.length > 0; }).length;

  console.log('\n--- Stats ---');
  console.log('  With title:   ', withTitle + '/' + listings.length);
  console.log('  With subjects:', withSubjects + '/' + listings.length);
  console.log('  With location:', withLocation + '/' + listings.length);
  console.log('  With posted:  ', withPosted + '/' + listings.length);
  console.log('  With desc:    ', withDesc + '/' + listings.length);
}

async function runTest(label, testSubject, testLocation, pages) {
  console.log('\n' + '-'.repeat(60));
  console.log('TEST:', label);
  console.log('  Subject:', testSubject || '(none)', 'Location:', testLocation || '(none)', 'Max pages:', pages);

  var page = await createPage();

  try {
    var searchResult = await searchTeacherOn(page, {
      subject: testSubject,
      location: testLocation,
    });
    console.log('  Page title:', searchResult.title);

    var result = await scrapePages(page, { maxPages: pages });
    printSummary(result);

    return result;
  } catch (error) {
    console.error('  ERROR:', error.message);
    return { listings: [], pagesScraped: 0, stoppedReason: 'error' };
  } finally {
    if (page && !page.isClosed()) {
      await page.close();
    }
  }
}

(async function() {
  console.log('[Scraper Test] Phase 5 - TeacherOn Pagination\n');
  console.log('  Default subject:', subject);
  console.log('  Default location:', location);
  console.log('  Default maxPages:', maxPages + '\n');

  try {
    await launchBrowser();

    // Test A: Subject + Location - scrape 2 pages
    await runTest('A. Two pages - Subject + Location', subject, location, 2);

    // Test B: Maximum page limit - 3 pages
    await runTest('B. Three pages (max limit) - Subject only', subject, null, 3);

    // Test C: No-results subject
    await runTest('C. No-results subject', 'ZxYwNoSuchSubject999', null, 3);

    // Test D: Pagination end - all jobs, 5 pages (should hit end before 5)
    await runTest('D. Pagination end detection - All jobs', null, null, 5);

    console.log('\n[Scraper Test] All pagination tests completed.');
  } catch (error) {
    console.error('[Scraper Test] Fatal error:', error.message);
  } finally {
    await closeBrowser();
  }
})();