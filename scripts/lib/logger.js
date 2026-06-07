'use strict';
// ps-local orchestration logger (C7) — twin of app/logger.js, same line format so build/runtime logs
// are directly comparable. Console + append to logs/debug/<script>-<ts>.log. Level via PS_LOG_LEVEL.
const fs = require('node:fs');
const path = require('node:path');
const util = require('node:util');

const LEVELS = { DEBUG: 10, INFO: 20, WARN: 30, ERROR: 40 };
const threshold = LEVELS[(process.env.PS_LOG_LEVEL || 'INFO').toUpperCase()] ?? LEVELS.INFO;

const repoRoot = path.join(__dirname, '..', '..');
const logDir = path.join(repoRoot, 'logs', 'debug');
// Name the logfile after the entry script (setup.js -> setup) so each run is self-describing.
const scriptName = path.basename(process.argv[1] || 'script', '.js');

let logFile = null;
function file() {
  if (logFile) return logFile;
  fs.mkdirSync(logDir, { recursive: true });
  const ts = new Date().toISOString().replace(/[:.]/g, '-');
  logFile = path.join(logDir, `${scriptName}-${ts}.log`);
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

// Time a labeled step; logs start then duration + outcome. Rethrows so the caller can decide to exit.
function step(log, label, fn) {
  const t0 = Date.now();
  log.info(`> ${label}`);
  try {
    const r = fn();
    log.info(`OK ${label} (${Date.now() - t0} ms)`);
    return r;
  } catch (e) {
    log.error(`FAIL ${label} (${Date.now() - t0} ms): ${e && e.message}`);
    throw e;
  }
}

module.exports = { createLogger, step, logFilePath: file };
