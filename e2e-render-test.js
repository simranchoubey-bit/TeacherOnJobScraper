// e2e-render-test.js — Tests DOM rendering/restart flow with pre-seeded DB
// Run: npx electron e2e-render-test.js
// Precondition: DB has jobs seeded (run seed manually first)

const path = require('path');
const { app, BrowserWindow } = require('electron');
app.setName('teacheron-scraper');

const { initializeDatabase, closeDatabase, getDatabasePath } = require('./src/main/database');
const { registerAllHandlers } = require('./src/main/ipc-handlers');

app.whenReady().then(async () => {
  console.log('\n[RENDER TEST] === DOM Rendering Verification ===\n');
  console.log('[RENDER TEST] DB: ' + getDatabasePath());

  initializeDatabase();
  registerAllHandlers();

  const win = new BrowserWindow({
    width: 1024, height: 768,
    webPreferences: {
      preload: path.join(__dirname, 'src', 'main', 'preload.js'),
      contextIsolation: true, nodeIntegration: false, sandbox: true,
    },
    show: false,
  });

  await win.loadFile(path.join(__dirname, 'src', 'renderer', 'index.html'));
  await new Promise(r => setTimeout(r, 4000));

  // Verify DB has data
  const dbCheck = await win.webContents.executeJavaScript(`
    (async () => {
      var r = await window.scraperAPI.getJobs({ offset: 1, limit: 100 });
      return JSON.stringify({ total: r.total, count: r.jobs ? r.jobs.length : 0 });
    })();
  `);
  const db = JSON.parse(dbCheck);
  console.log('[RENDER TEST] DB jobs: ' + db.count + ' (total: ' + db.total + ')');

  // Check DOM: does it load jobs on startup?
  const dom = await win.webContents.executeJavaScript(`
    JSON.stringify({
      sectionVisible: !document.getElementById('results-section').classList.contains('hidden'),
      countText: document.getElementById('results-count').textContent,
      cardCount: document.querySelectorAll('#results-table .job-card').length,
      firstTitle: (function() {
        var c = document.querySelector('#results-table .job-card h3');
        return c ? c.textContent : '';
      })(),
      hasViewBtn: !!document.querySelector('#results-table .view-job-btn'),
      viewBtnUrl: (function() {
        var b = document.querySelector('#results-table .view-job-btn');
        return b ? b.getAttribute('data-url') : '';
      })(),
      stopBtnExists: !!document.getElementById('scan-stop-btn'),
      stopBtnText: document.getElementById('scan-stop-btn').textContent.trim(),
      statusDetail: document.getElementById('status-detail').textContent,
      statusBadge: document.getElementById('status-badge').textContent
    })
  `);
  const d = JSON.parse(dom);

  const loadedOnStartup = d.sectionVisible && d.cardCount > 0;
  const viewBtnOK = d.hasViewBtn && d.viewBtnUrl.length > 0;
  const stopBtnOK = d.stopBtnExists && d.stopBtnText.indexOf('Stop') !== -1;

  console.log('');
  console.log('  Section visible:  ' + d.sectionVisible);
  console.log('  Card count:       ' + d.cardCount);
  console.log('  Count text:       ' + d.countText);
  console.log('  First title:      ' + d.firstTitle);
  console.log('  Status badge:     ' + d.statusBadge);
  console.log('  Status detail:    ' + d.statusDetail);
  console.log('  View btn exists:  ' + d.hasViewBtn + ' url=' + (d.viewBtnUrl ? d.viewBtnUrl.substring(0,50) : ''));
  console.log('  Stop btn:         ' + d.stopBtnText);
  console.log('');
  console.log('========================================');
  console.log('  Startup load:  ' + (loadedOnStartup ? 'PASS (' + d.cardCount + ' cards)' : 'FAIL'));
  console.log('  View Job btn:  ' + (viewBtnOK ? 'PASS' : 'FAIL'));
  console.log('  Stop Scan btn: ' + (stopBtnOK ? 'PASS' : 'FAIL'));
  console.log('========================================');
  console.log('');

  closeDatabase();
  app.quit();
});