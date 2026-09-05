// TeacherOn Tracker — Renderer with Sidebar Navigation
(function(){'use strict';

// ── Debug ──
console.log("[Renderer] Starting...");
if(!window.scraperAPI){console.error("[Renderer] scraperAPI not available");return;}
var api=window.scraperAPI;
console.log("[Renderer] API methods:",Object.keys(api).join(", "));

// ── Navigation ──
var currentSection="dashboard";
var sidebarItems=document.querySelectorAll(".sidebar__item");
var contentSections={};
["dashboard","jobs","scan","scheduler","scan-history","logs","settings"].forEach(function(s){
  contentSections[s]=document.getElementById("section-"+s);
});

function navigateTo(section){
  if(currentSection===section)return;
  currentSection=section;
  sidebarItems.forEach(function(el){el.classList.toggle("active",el.dataset.section===section);});
  Object.keys(contentSections).forEach(function(k){
    var sec=contentSections[k];
    if(sec)sec.classList.toggle("active",k===section);
  });
  if(section==="dashboard")refreshDashboard();
  else if(section==="jobs")refreshJobs();
  else if(section==="scan-history")refreshScanHistory();
  else if(section==="logs")refreshLogs();
  else if(section==="settings")refreshSettings();
}

sidebarItems.forEach(function(el){
  el.addEventListener("click",function(e){
    e.preventDefault();
    navigateTo(el.dataset.section);
  });
});

// ── Helpers ──
function escapeHtml(s){if(!s)return"";return String(s).replace(/&/g,"&amp;").replace(/</g,"&lt;").replace(/>/g,"&gt;")}
function formatTime(iso){if(!iso)return"—";var d=new Date(iso);return d.toLocaleTimeString([],{hour:"2-digit",minute:"2-digit"})}
function formatDateTime(iso){if(!iso)return"—";return new Date(iso).toLocaleString()}
function truncate(s,n){if(!s)return"";return s.length>n?s.slice(0,n)+"…":s}

var headerDot=document.getElementById("header-connection-dot");
var headerText=document.getElementById("header-status-text");
function setHeaderState(s,t){headerDot.className="connection-dot connection-dot--"+s;headerText.textContent=t;}
async function refreshDashboard(){
try{
var d=await api.getDashboardStats();if(!d.success)return;
document.getElementById("dash-total-jobs").textContent=d.totalJobs||0;
document.getElementById("dash-new-today").textContent=d.newToday||0;
document.getElementById("dash-last-scan").textContent=d.lastScanTime?formatTime(d.lastScanTime):"—";
document.getElementById("dash-next-scan").textContent=d.scheduler&&d.scheduler.nextRun?formatTime(d.scheduler.nextRun):"—";
var sd=document.getElementById("dash-scheduler-dot"),st=document.getElementById("dash-scheduler-text");
if(d.scheduler&&d.scheduler.running){sd.className="scheduler-dot scheduler-dot--running";st.textContent="Running · "+d.scheduler.intervalMinutes+" min · "+d.scheduler.runCount+" runs";}
else{sd.className="scheduler-dot";st.textContent="Not running";}
var scd=document.getElementById("dash-scan-dot"),sct=document.getElementById("dash-scan-text");
if(d.scheduler&&d.scheduler.isScanning){scd.className="scan-dot scan-dot--running";sct.textContent="Scanning…";}
else{scd.className="scan-dot";sct.textContent="Idle";}
var rj=document.getElementById("dash-recent-jobs");
if(d.recentJobs&&d.recentJobs.length>0){rj.innerHTML="";var today=new Date();today.setHours(0,0,0,0);
for(var i=0;i<d.recentJobs.length;i++){var j=d.recentJobs[i];var isNew=j.scrapedAt&&new Date(j.scrapedAt)>=today;
rj.innerHTML+='<div class="dash-recent-item"><span class="dash-recent-item__title">'+escapeHtml(j.title)+(isNew?'<span class="dash-recent-item__new">NEW</span>':'')+'</span><div class="dash-recent-item__meta">'+escapeHtml(j.subject||"")+' · '+escapeHtml(j.location||"")+'</div></div>';}
}else{rj.innerHTML='<div class="empty-state">No jobs yet.</div>';}
var rs=document.getElementById("dash-recent-scans");
if(d.recentScans&&d.recentScans.length>0){rs.innerHTML="";
for(var i=0;i<d.recentScans.length;i++){var s=d.recentScans[i];var cls=s.status==="success"?"success":s.status==="blocked"?"blocked":"failed";
rs.innerHTML+='<div class="dash-recent-item"><span class="dash-recent-item__title">'+formatTime(s.startedAt)+'</span> — '+s.jobsFound+' jobs ('+s.newJobs+' new) <span class="scan-history-item__status--'+cls+'">'+s.status+'</span></div>';}
}else{rs.innerHTML='<div class="empty-state">No scans yet.</div>';}
setHeaderState("online","Ready");
}catch(e){console.error("[Renderer] Dashboard error:",e);}
}

var subIn=document.getElementById("subject-input"),locIn=document.getElementById("location-input"),maxIn=document.getElementById("max-pages-input");
var sBtn=document.getElementById("scan-start-btn"),sIcon=document.getElementById("scan-start-icon"),xBtn=document.getElementById("scan-stop-btn");
var sSect=document.getElementById("status-section"),sBadge=document.getElementById("status-badge"),sDetail=document.getElementById("status-detail");
var pCont=document.getElementById("progress-bar-container"),pBar=document.getElementById("progress-bar");
var sStats=document.getElementById("status-stats"),sErr=document.getElementById("status-error");
var rSect=document.getElementById("results-section"),rCount=document.getElementById("results-count"),rTable=document.getElementById("results-table"),rEmpty=document.getElementById("results-empty");
var stopReason=document.getElementById("stopped-reason");var scanning=false;
function showReason(r){if(!r){stopReason.classList.add("hidden");return;}var t=r==="cloudflare_block"?"Blocked by Cloudflare":r==="user-aborted"?"Stopped by user":r;stopReason.textContent=t;stopReason.className=r==="cloudflare_block"?"stopped-reason stopped-reason--error":"stopped-reason stopped-reason--warn";stopReason.classList.remove("hidden");}
function setUI(on){scanning=on;sBtn.disabled=on;xBtn.disabled=!on;sIcon.textContent=on?"⟳":"▶";if(on)sIcon.classList.add("spinning");else sIcon.classList.remove("spinning");}
function setStatus(st,t,d){sBadge.className="status-badge status-badge--"+st;sBadge.textContent=t;sDetail.textContent=d||"";sSect.classList.remove("hidden");}
function showErr(m){sErr.textContent=m;sErr.classList.remove("hidden");}function hideErr(){sErr.classList.add("hidden");sErr.textContent="";}
function showP(d,t){if(t<=0)return;pCont.classList.remove("hidden");pBar.style.width=Math.min(100,Math.round(d/t*100))+"%";}
function hideP(){pCont.classList.add("hidden");pBar.style.width="0%";}
function setStats(h){sStats.innerHTML=h;}function hideReason(){stopReason.classList.add("hidden");}
function renderJobs(jobs){
if(!jobs||jobs.length===0){rEmpty.classList.remove("hidden");rSect.classList.remove("hidden");rTable.innerHTML="";return;}
rSect.classList.remove("hidden");rEmpty.classList.add("hidden");rCount.textContent=jobs.length+" job"+(jobs.length!==1?"s":"");
var h="";for(var i=0;i<jobs.length;i++){var j=jobs[i];var tg="";if(j.subject)tg+='<span class="job-tag">'+escapeHtml(j.subject)+'</span>';
h+='<div class="job-card"><div class="job-card-header"><div class="job-title">'+escapeHtml(j.title||"Untitled")+'</div></div>';
if(tg)h+='<div class="job-tags">'+tg+'</div>';
h+='<div class="job-meta-row">';if(j.location)h+='<span class="job-meta-item">📍 '+escapeHtml(j.location)+'</span>';if(j.postedDate)h+='<span class="job-meta-item">📅 '+escapeHtml(j.postedDate)+'</span>';h+='</div>';
if(j.description)h+='<div class="job-description">'+escapeHtml(truncate(j.description,200))+'</div>';
h+='<div class="job-card-footer"><button class="btn btn-primary btn-sm view-job-btn" data-url="'+escapeHtml(j.jobUrl)+'">View Job</button></div></div>';
}
rTable.innerHTML=h;var bs=rTable.querySelectorAll(".view-job-btn");for(var k=0;k<bs.length;k++){(function(b){b.addEventListener("click",function(){api.openJobUrl(b.dataset.url);});})(bs[k]);}
}
async function startScan(){if(scanning)return;var sub=subIn.value.trim()||undefined;var loc=locIn.value.trim()||undefined;var mp=parseInt(maxIn.value,10)||3;hideErr();hideP();hideReason();rSect.classList.add("hidden");rTable.innerHTML="";rEmpty.classList.add("hidden");setUI(true);setStatus("running","Scanning","Searching TeacherOn…");setHeaderState("online","Scanning…");
try{var r=await api.scanStart({subject:sub,location:loc,maxPages:mp});setUI(false);if(r.stoppedReason&&r.stoppedReason!=="max-pages")showReason(r.stoppedReason);
if(r.stopped&&r.stoppedReason==="cloudflare_block"){setStatus("blocked","Blocked",r.message||"Blocked");rSect.classList.remove("hidden");rEmpty.classList.remove("hidden");rEmpty.textContent=r.message;setStats('<div class="stat-row"><span class="stat-label">Pages:</span><span>'+ (r.pagesScraped||0)+'</span></div><div class="stat-row"><span class="stat-label">Jobs:</span><span>'+r.totalListings+'</span></div>');setHeaderState("error","Blocked");}
else if(r.success){setStatus("success","Complete",r.message);if(r.listings&&r.listings.length>0)renderJobs(r.listings);else{rSect.classList.remove("hidden");rEmpty.classList.remove("hidden");}setStats('<div class="stat-row"><span class="stat-label">Pages:</span><span>'+ (r.pagesScraped||0)+'</span></div><div class="stat-row"><span class="stat-label">Jobs:</span><span>'+r.totalListings+'</span></div>');setHeaderState("online","Ready");}
else{setStatus("error","Failed",r.message);showErr("Scan failed: "+(r.message||"?"));setHeaderState("error","Error");}
try{var a=await api.getJobs({offset:1,limit:50});if(a&&a.jobs&&a.jobs.length)renderJobs(a.jobs);}catch(e){}
}catch(e){setUI(false);setStatus("error","Error",e.message);showErr("Scan failed: "+e.message);setHeaderState("error","Error");}finally{setUI(false);}
}
async function stopScan(){if(!scanning)return;try{await api.scanStop();setStatus("idle","Stopped","Scan stopped");}catch(e){}setUI(false);}
sBtn.addEventListener("click",startScan);xBtn.addEventListener("click",stopScan);
subIn.addEventListener("keydown",function(e){if(e.key==="Enter")startScan();});locIn.addEventListener("keydown",function(e){if(e.key==="Enter")startScan();});
document.addEventListener("keydown",function(e){var m=(navigator.platform.indexOf("Mac")!==-1)?e.metaKey:e.ctrlKey;if(m&&e.shiftKey&&e.key==="S"){e.preventDefault();navigateTo("scan");startScan();}else if(m&&e.shiftKey&&e.key==="X"){e.preventDefault();stopScan();}});

var jobsSearch=document.getElementById("jobs-search"),jobsSubj=document.getElementById("jobs-filter-subject"),jobsLoc=document.getElementById("jobs-filter-location");
var jobsList=document.getElementById("jobs-list"),jobsCount=document.getElementById("jobs-total-count");
var jobsRefresh=document.getElementById("jobs-refresh-btn"),jobsClear=document.getElementById("jobs-clear-btn");
var allJobsData=[];
async function refreshJobs(){try{var r=await api.getJobs({offset:1,limit:200});if(r&&r.jobs){allJobsData=r.jobs;renderJobsList(allJobsData);jobsCount.textContent=allJobsData.length+" job"+(allJobsData.length!==1?"s":"");}}catch(e){console.error(e);}}
function renderJobsList(jobs){if(!jobs||jobs.length===0){jobsList.innerHTML='<div class="empty-state">No jobs saved yet.</div>';return;}
var h="";for(var i=0;i<jobs.length;i++){var j=jobs[i];var tg="";if(j.subject)tg+='<span class="job-tag">'+escapeHtml(j.subject)+'</span>';
h+='<div class="job-card"><div class="job-card-header"><div class="job-title">'+escapeHtml(j.title||"Untitled")+'</div></div>';
if(tg)h+='<div class="job-tags">'+tg+'</div>';
h+='<div class="job-meta-row">';if(j.location)h+='<span class="job-meta-item">📍 '+escapeHtml(j.location)+'</span>';if(j.postedDate)h+='<span class="job-meta-item">📅 '+escapeHtml(j.postedDate)+'</span>';h+='</div>';
if(j.description)h+='<div class="job-description">'+escapeHtml(truncate(j.description,200))+'</div>';
h+='<div class="job-card-footer"><button class="btn btn-primary btn-sm view-job-btn" data-url="'+escapeHtml(j.jobUrl)+'">View Job</button></div></div>';}
jobsList.innerHTML=h;var bs=jobsList.querySelectorAll(".view-job-btn");for(var k=0;k<bs.length;k++){(function(b){b.addEventListener("click",function(){api.openJobUrl(b.dataset.url);});})(bs[k]);}}
function filterJobs(){var q=(jobsSearch.value||"").toLowerCase(),fs=(jobsSubj.value||"").toLowerCase(),fl=(jobsLoc.value||"").toLowerCase();
var f=allJobsData.filter(function(j){return(!q||(j.title||"").toLowerCase().indexOf(q)!==-1||(j.description||"").toLowerCase().indexOf(q)!==-1)&&(!fs||(j.subject||"").toLowerCase().indexOf(fs)!==-1)&&(!fl||(j.location||"").toLowerCase().indexOf(fl)!==-1);});
renderJobsList(f);jobsCount.textContent=f.length+" of "+allJobsData.length+" job"+(allJobsData.length!==1?"s":"");}
jobsSearch.addEventListener("input",filterJobs);jobsSubj.addEventListener("input",filterJobs);jobsLoc.addEventListener("input",filterJobs);
jobsRefresh.addEventListener("click",refreshJobs);
jobsClear.addEventListener("click",async function(){if(!confirm("Delete ALL saved jobs? This cannot be undone."))return;try{await api.clearAllJobs();allJobsData=[];renderJobsList([]);jobsCount.textContent="0 jobs";}catch(e){console.error(e);}});

var schedInt=document.getElementById("scheduler-interval"),schedStart=document.getElementById("scheduler-start-btn"),schedStartIcon=document.getElementById("scheduler-start-icon"),schedStop=document.getElementById("scheduler-stop-btn");
var schedStatus=document.getElementById("scheduler-status"),schedIdle=document.getElementById("scheduler-idle"),schedErr=document.getElementById("scheduler-error");
var schedStateText=document.getElementById("scheduler-state-text"),schedIntText=document.getElementById("scheduler-interval-text"),schedNextRun=document.getElementById("scheduler-next-run"),schedRunCount=document.getElementById("scheduler-run-count"),schedLastRun=document.getElementById("scheduler-last-run");
var schedActive=false;
function setSchedUI(on){schedActive=on;schedStart.disabled=on;schedStop.disabled=!on;schedInt.disabled=on;if(on)schedStartIcon.classList.add("spinning");else schedStartIcon.classList.remove("spinning");}
async function startScheduler(){if(schedActive)return;var intv=parseInt(schedInt.value,10);var sub=subIn.value.trim()||undefined;var loc=locIn.value.trim()||undefined;var mp=parseInt(maxIn.value,10)||3;
try{var r=await api.schedulerStart({intervalMinutes:intv,subject:sub,location:loc,maxPages:mp});if(!r.success){schedErr.textContent=r.message;schedErr.classList.remove("hidden");return;}
schedErr.classList.add("hidden");setSchedUI(true);schedStatus.classList.remove("hidden");schedIdle.classList.add("hidden");
schedStateText.textContent="Running";schedIntText.textContent=r.intervalMinutes+" min";schedNextRun.textContent=formatTime(r.nextRun);schedRunCount.textContent="0";schedLastRun.textContent="—";}catch(e){schedErr.textContent=e.message;schedErr.classList.remove("hidden");}}
async function stopScheduler(){if(!schedActive)return;try{await api.schedulerStop();setSchedUI(false);schedStatus.classList.add("hidden");schedIdle.classList.remove("hidden");}catch(e){console.error(e);}}
async function refreshSchedStatus(){if(!schedActive)return;try{var s=await api.schedulerStatus();if(!s.running){setSchedUI(false);schedStatus.classList.add("hidden");schedIdle.classList.remove("hidden");schedActive=false;return;}
schedStatus.classList.remove("hidden");schedIdle.classList.add("hidden");schedStateText.textContent=s.isScanning?"Scanning now…":"Running";schedIntText.textContent=s.intervalMinutes+" min";
schedNextRun.textContent=s.nextRun?formatTime(s.nextRun):"—";schedRunCount.textContent=s.runCount||0;if(s.lastRunCompletedAt)schedLastRun.textContent=formatTime(s.lastRunCompletedAt)+(s.lastRunStatus==="success"?" ✓":" ✗");else if(s.lastRunStartedAt)schedLastRun.textContent="Running…";else schedLastRun.textContent="—";}catch(e){}}
schedStart.addEventListener("click",startScheduler);schedStop.addEventListener("click",stopScheduler);setInterval(function(){if(schedActive)refreshSchedStatus();},5000);

var histList=document.getElementById("scan-history-list"),histClear=document.getElementById("scan-history-clear-btn");
async function refreshScanHistory(){try{var r=await api.getScanHistory(30);if(r&&r.history&&r.history.length>0){var h="";for(var i=0;i<r.history.length;i++){var s=r.history[i];var cls=s.status==="success"?"success":s.status==="blocked"?"blocked":s.status==="failed"?"failed":s.status==="partial"?"partial":"stopped";
h+='<div class="scan-history-item"><div class="scan-history-item__header"><span class="scan-history-item__time">'+formatDateTime(s.startedAt)+'</span><span class="scan-history-item__status scan-history-item__status--'+cls+'">'+s.status+'</span></div><div class="scan-history-item__details">';
if(s.subject)h+='<span>Subject: '+escapeHtml(s.subject)+'</span>';if(s.location)h+='<span>Loc: '+escapeHtml(s.location)+'</span>';
h+='<span>Pages: '+s.pagesScraped+'</span><span>Jobs: '+s.jobsFound+'</span><span>New: '+s.newJobs+'</span>';
if(s.durationMs)h+='<span>Dur: '+(s.durationMs/1000).toFixed(1)+'s</span>';if(s.stoppedReason)h+='<span>Reason: '+escapeHtml(s.stoppedReason)+'</span>';h+='</div></div>';}
histList.innerHTML=h;}else{histList.innerHTML='<div class="empty-state">No scan history yet.</div>';}}catch(e){console.error(e);}}
histClear.addEventListener("click",async function(){if(!confirm("Clear all scan history?"))return;try{await api.clearScanHistory();refreshScanHistory();}catch(e){console.error(e);}});

var logList=document.getElementById("logs-list"),logFilter=document.getElementById("logs-filter"),logClear=document.getElementById("logs-clear-btn");var logEntries=[];
async function refreshLogs(){try{var r=await api.getLogs();if(r&&r.logs){logEntries=r.logs;renderLogs();}}catch(e){}}
function renderLogs(){var fv=logFilter.value;var filtered=fv==="all"?logEntries:logEntries.filter(function(e){return e.level===fv;});
if(filtered.length===0){logList.innerHTML='<div class="empty-state">No log entries</div>';return;}
var h="";for(var i=filtered.length-1;i>=0;i--){var e=filtered[i];
h+='<div class="log-entry log-entry--'+e.level+'"><span class="log-entry__time">'+formatTime(e.timestamp)+'</span><span class="log-entry__module">'+escapeHtml(e.module)+'</span>'+escapeHtml(e.message)+'</div>';}
logList.innerHTML=h;}
logFilter.addEventListener("change",renderLogs);
logClear.addEventListener("click",async function(){try{await api.clearLogs();logEntries=[];renderLogs();}catch(e){}});

var setPages=document.getElementById("settings-default-pages"),setIntv=document.getElementById("settings-default-interval");
var setBrowser=document.getElementById("settings-browser-mode"),setHeadless=document.getElementById("settings-headless");
var setDbJobs=document.getElementById("settings-db-jobs"),setDbPath=document.getElementById("settings-db-path");
var setClear=document.getElementById("settings-clear-db-btn"),setAppName=document.getElementById("settings-app-name"),setAppVer=document.getElementById("settings-app-version");
async function refreshSettings(){try{
var r=await api.getSettings();if(r&&r.settings){setPages.value=r.settings.defaultMaxPages||3;setIntv.value=r.settings.defaultInterval||60;setBrowser.textContent=r.settings.browserMode||"—";setHeadless.textContent=r.settings.headless?"Yes":"No";}
var d=await api.getDbInfo();if(d){setDbJobs.textContent=d.totalJobs||0;setDbPath.textContent=d.path||"—";}
setAppName.textContent=api.getAppName?api.getAppName():"TeacherOn Tracker";setAppVer.textContent=api.getVersion?api.getVersion():"1.0.0";}catch(e){console.error(e);}}
setPages.addEventListener("change",function(){api.saveSettings({defaultMaxPages:parseInt(setPages.value,10)});});
setIntv.addEventListener("change",function(){api.saveSettings({defaultInterval:parseInt(setIntv.value,10)});});
setClear.addEventListener("click",async function(){if(!confirm("Clear ALL jobs and scan history? This cannot be undone."))return;try{await api.clearAllData();refreshSettings();refreshDashboard();}catch(e){console.error(e);}});

console.log("[Renderer] UI ready");refreshDashboard();setInterval(refreshDashboard,15000);setTimeout(function(){refreshJobs();},500);
})();
