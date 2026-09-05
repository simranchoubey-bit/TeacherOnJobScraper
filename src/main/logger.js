// src/main/logger.js — Phase 9: Structured logging utility
'use strict';

var path = require('path');
var fs = require('fs');
var electron = require('electron');
var app = electron.app;

var logDir = null, logFilePath = null, logStream = null, rendererCb = null;
var LEVELS = { DEBUG: 0, INFO: 1, WARN: 2, ERROR: 3 };
var LEVEL_NAMES = ['DEBUG', 'INFO', 'WARN', 'ERROR'];
var currentLevel = LEVELS.INFO;

function initLogDir() {
  if (logDir) return;
  try { logDir = app.getPath('logs'); }
  catch (e) { logDir = path.join(app.getPath('userData'), 'logs'); }
  if (!fs.existsSync(logDir)) fs.mkdirSync(logDir, { recursive: true });
}

function getLogFilePath() {
  var d = new Date();
  return path.join(logDir, d.getFullYear() + '-' +
    String(d.getMonth() + 1).padStart(2, '0') + '-' +
    String(d.getDate()).padStart(2, '0') + '.log');
}

function ensureLogStream() {
  initLogDir();
  var p = getLogFilePath();
  if (logFilePath !== p) {
    if (logStream) { try { logStream.end(); } catch (e) {} }
    logFilePath = p;
    logStream = fs.createWriteStream(logFilePath, { flags: 'a' });
  }
  if (!logStream) logStream = fs.createWriteStream(logFilePath, { flags: 'a' });
}

function formatEntry(lvl, mod, msg, ctx) {
  var ts = new Date().toISOString().replace('T', ' ').split('.')[0];
  var s = '[' + ts + '] [' + lvl.padEnd(5) + '] [' + mod + '] ' + msg;
  if (ctx && Object.keys(ctx).length > 0) {
    try { s += ' | ' + JSON.stringify(ctx); } catch (e) {}
  }
  return s;
}

function sanitizeContext(ctx) {
  if (!ctx) return {};
  var safe = {};
  var keys = Object.keys(ctx);
  for (var i = 0; i < keys.length; i++) {
    var k = keys[i], v = ctx[k];
    if (k === 'stack' || k === 'cause') continue;
    if (v instanceof Error) { safe[k] = v.message; continue; }
    if (typeof v === 'string') safe[k] = v.length > 500 ? v.slice(0, 500) + '...' : v;
    else if (typeof v === 'number' || typeof v === 'boolean' || v === null) safe[k] = v;
    else if (typeof v === 'object') {
      try { safe[k] = JSON.stringify(v).length > 500 ? '[large object]' : v; }
      catch (e) { safe[k] = '[non-serializable]'; }
    }
  }
  return safe;
}

function log(level, mod, msg, ctx) {
  if (level < currentLevel) return;
  var lvlName = LEVEL_NAMES[level];
  var entry = formatEntry(lvlName, mod, msg, ctx);

  // File
  try { ensureLogStream(); logStream.write(entry + '\n'); } catch (e) {}

  // Console
  if (level === LEVELS.ERROR) console.error('[' + mod + '] ' + msg, ctx || '');
  else if (level === LEVELS.WARN) console.warn('[' + mod + '] ' + msg, ctx || '');
  else console.log('[' + mod + '] ' + msg);

  // Renderer — sanitized, only WARN/ERROR
  if ((level === LEVELS.ERROR || level === LEVELS.WARN) && rendererCb) {
    try { rendererCb({ timestamp: new Date().toISOString(), level: lvlName,
      module: mod, message: msg, context: sanitizeContext(ctx) }); } catch (e) {}
  }
}

function info(mod, msg, ctx)  { log(LEVELS.INFO, mod, msg, ctx); }
function warn(mod, msg, ctx)  { log(LEVELS.WARN, mod, msg, ctx); }
function error(mod, msg, ctx) { log(LEVELS.ERROR, mod, msg, ctx); }
function debug(mod, msg, ctx) { log(LEVELS.DEBUG, mod, msg, ctx); }

function setLevel(lvl) {
  var idx = ['DEBUG', 'INFO', 'WARN', 'ERROR'].indexOf(lvl.toUpperCase());
  if (idx >= 0) currentLevel = idx;
}

function setRendererCallback(cb) { rendererCb = cb; }
function getLogFilePathCurrent() { initLogDir(); return getLogFilePath(); }

function close() {
  if (logStream) { try { logStream.end(); } catch (e) {}; logStream = null; logFilePath = null; }
}

module.exports = {
  info: info, warn: warn, error: error, debug: debug,
  setLevel: setLevel, setRendererCallback: setRendererCallback,
  getLogFilePath: getLogFilePathCurrent, close: close,
};