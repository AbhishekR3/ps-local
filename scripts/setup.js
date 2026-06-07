#!/usr/bin/env node
'use strict';
// One-shot setup: submodules -> server build -> client build -> overlays -> helper/app deps -> tests.
// Idempotent; safe to re-run. Does NOT run build-data.js (slow Monte-Carlo) — that's a manual step.
const { spawnSync } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');
const { createLogger, step } = require('./lib/logger');

const repoRoot = path.join(__dirname, '..');
const SRV = path.join(repoRoot, 'vendor', 'pokemon-showdown');
const CLI = path.join(repoRoot, 'vendor', 'pokemon-showdown-client');
const HELP = path.join(repoRoot, 'helper');
const APP = path.join(repoRoot, 'app');
const log = createLogger('setup');

function run(cmd, args, cwd = repoRoot) {
  const res = spawnSync(cmd, args, { cwd, stdio: 'inherit' });
  if (res.error) throw res.error;
  return res.status;
}
function required(label, cmd, args, cwd) {
  const code = step(log, label, () => run(cmd, args, cwd));
  if (code !== 0) { log.error(`${label} exited ${code} — aborting`); process.exit(code || 1); }
}

// 1. Node version — build-data.js imports .ts via type-stripping (needs >=22.6).
const [maj, min] = process.versions.node.split('.').map(Number);
if (maj < 22 || (maj === 22 && min < 6)) {
  log.error(`Node ${process.versions.node} is too old. build-data.js uses .ts type-stripping which needs Node >=22.6. Upgrade Node and re-run.`);
  process.exit(1);
}
log.info(`Node ${process.versions.node} OK (>=22.6)`);

// 2. Submodules
required('init submodules', 'git', ['submodule', 'update', '--init', '--recursive']);

// 3-4. Server
required('install server deps (npm ci)', 'npm', ['ci'], SRV);
required('build server (npm run build)', 'npm', ['run', 'build'], SRV);
if (!fs.existsSync(path.join(SRV, 'dist', 'sim', 'teams.js'))) {
  log.error('server build incomplete: dist/sim/teams.js missing'); process.exit(1);
}
log.info('server build OK (dist/sim/teams.js present)');

// 5. Client — npm ci first preserves the lockfile so `node build` skips its own install (keeps the
//    submodule clean per the invariant).
required('install client deps (npm ci)', 'npm', ['ci'], CLI);
required('build client (node build)', 'node', ['build'], CLI);
if (!fs.existsSync(path.join(CLI, 'play.pokemonshowdown.com', 'js'))) {
  log.error('client build incomplete: play.pokemonshowdown.com/js missing'); process.exit(1);
}
log.info('client build OK (play.pokemonshowdown.com/js present)');

// 6. Overlays
required('apply config overlays', 'node', ['scripts/apply-overlay.js']);

// 7-8. Helper + app deps
required('install helper deps', 'npm', ['install'], HELP);
required('install app deps', 'npm', ['install'], APP);

// 9. Helper tests — warn but don't fail (don't block a fresh setup on a flaky test).
const testCode = step(log, 'run helper tests', () => run('node', ['--test'], HELP));
if (testCode !== 0) log.warn(`helper tests exited ${testCode} (continuing)`);

log.info('Done. Run: npm start');
log.info('Optional (slow, Monte-Carlo): rebuild the data bundle with  cd helper && node build-data.js');
