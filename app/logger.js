// ps-local runtime logger (C7). Mirrors scripts/lib/logger.js's format so app and
// orchestration logs are directly comparable. Console + append to logs/debug/app-<ts>.log.
// Level threshold from PS_LOG_LEVEL (DEBUG|INFO|WARN|ERROR; default INFO).
const fs = require('node:fs');
const path = require('node:path');
const util = require('node:util');

const LEVELS = { DEBUG: 10, INFO: 20, WARN: 30, ERROR: 40 };
const threshold = LEVELS[(process.env.PS_LOG_LEVEL || 'INFO').toUpperCase()] ?? LEVELS.INFO;

const repoRoot = path.join(__dirname, '..');
const logDir = path.join(repoRoot, 'logs', 'debug');

let logFile = null;
function file() {
  if (logFile) return logFile;
  fs.mkdirSync(logDir, { recursive: true });
  const ts = new Date().toISOString().replace(/[:.]/g, '-');
  logFile = path.join(logDir, `app-${ts}.log`);
  return logFile;
}

function render(arg) {
  if (arg instanceof Error) return arg.stack || arg.message;
  if (typeof arg === 'string') return arg;
  return util.inspect(arg, { depth: 4, breakLength: 120 });
}

function emit(level, ns, args) {
  if (LEVELS[level] < threshold) return;
  const line = `${new Date().toISOString()} [${level.padEnd(5)}] [${ns}] ${args.map(render).join(' ')}`;
  (level === 'WARN' || level === 'ERROR' ? console.error : console.log)(line);
  // Best-effort file sink — never let a logging failure take down the app.
  try { fs.appendFileSync(file(), line + '\n'); } catch {}
}

function createLogger(ns) {
  return {
    debug: (...a) => emit('DEBUG', ns, a),
    info: (...a) => emit('INFO', ns, a),
    warn: (...a) => emit('WARN', ns, a),
    error: (...a) => emit('ERROR', ns, a),
  };
}

module.exports = { createLogger, logFilePath: file };
