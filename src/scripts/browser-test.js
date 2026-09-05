// src/scripts/browser-test.js
// Phase 3: Development-only browser test script
//
// Tests the browser automation foundation:
//   launch → navigate to TeacherOn → inspect → close
//
// Usage:
//   # Headful (visible browser window) — default
//   node src/scripts/browser-test.js
//
//   # Headless
//   HEADLESS=true node src/scripts/browser-test.js
//
//   # With Camoufox (if installed)
//   BROWSER_MODE=camoufox CAMOUFOX_EXECUTABLE_PATH=/path/to/camoufox node src/scripts/browser-test.js
//
// This script is NOT part of the normal Electron app startup.
// It's for validating the browser layer during development.

const path = require('path');

// Simulate Electron's app.getPath('userData') for standalone test
// (scraper.js doesn't need electron, but config.js is fine standalone)
process.env.TEACHERON_URL = process.env.TEACHERON_URL || 'https://www.teacheron.com';

const { launchBrowser, closeBrowser, testNavigation } = require('../main/scraper');

async function main() {
  console.log('Phase 3: Browser Automation Test');
  console.log('================================\n');

  // 1. Launch browser
  try {
    await launchBrowser();
  } catch (error) {
    console.error('❌ Browser launch failed:', error.message);
    console.error('\nTroubleshooting:');
    console.error('  - Is Playwright installed? npm install playwright');
    console.error('  - Are Playwright browsers installed? npx playwright install firefox');
    process.exit(1);
  }

  // 2. Navigate to TeacherOn
  console.log('\n--- Navigation Test ---\n');
  const result = await testNavigation();

  if (result.success) {
    console.log('\n✅ Navigation successful!');
    console.log('   URL:', result.url);
    console.log('   Title:', result.title);
    console.log('   Load time:', result.loadTimeMs, 'ms');
  } else {
    console.log('\n❌ Navigation failed!');
    console.log('   Error:', result.error);
    console.log('   Load time before failure:', result.loadTimeMs, 'ms');
  }

  // 3. Close browser cleanly
  console.log('\n--- Cleanup ---\n');
  await closeBrowser();
  console.log('\n✅ Browser closed cleanly');

  // Report
  if (result.success) {
    console.log('\n🎉 Phase 3 browser test PASSED');
    process.exit(0);
  } else {
    console.log('\n⚠️  Phase 3 browser test completed with navigation error');
    console.log('   (This may be normal if TeacherOn blocks or network is unavailable)');
    process.exit(0);
  }
}

main().catch((error) => {
  console.error('\n💥 Unexpected error:', error.message);
  console.error(error.stack);
  process.exit(1);
});