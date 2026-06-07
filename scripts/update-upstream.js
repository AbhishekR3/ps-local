#!/usr/bin/env node
'use strict';
// Bump both submodules to upstream latest, rebuild, re-apply overlays, and gate on the helper tests.
// If the helper tests fail after a bump, the upstream change broke parser.js/exporter.js — the SHAs
// of the offending bump are printed so you can read the upstream diff.
const { spawnSync } = require('node:child_process');
const path = require('node:path');
const { createLogger, step } = require('./lib/logger');

const repoRoot = path.join(__dirname, '..');
const SRV = path.join(repoRoot, 'vendor', 'pokemon-showdown');
const CLI = path.join(repoRoot, 'vendor', 'pokemon-showdown-client');
const HELP = path.join(repoRoot, 'helper');
const log = createLogger('update');

function run(cmd, args, cwd = repoRoot) {
  const res = spawnSync(cmd, args, { cwd, stdio: 'inherit' });
  if (res.error) throw res.error;
  return res.status;
}
function capture(cmd, args, cwd = repoRoot) {
  const res = spawnSync(cmd, args, { cwd, encoding: 'utf8' });
  return (res.stdout || '').trim();
}
function assertOk(code) { if (code !== 0) throw new Error(`exit ${code}`); }
function sha(sub) { return capture('git', ['-C', sub, 'rev-parse', '--short', 'HEAD']); }

// 1. Refuse on a dirty tree — a bump rewrites submodule pointers; don't mix with local edits.
if (capture('git', ['status', '--porcelain'])) {
  log.error('Working tree is dirty — commit or stash your changes before updating upstream.');
  process.exit(1);
}

const beforeServer = sha('vendor/pokemon-showdown');
const beforeClient = sha('vendor/pokemon-showdown-client');
log.info(`before: server=${beforeServer} client=${beforeClient}`);

// 2. Pull upstream.
try {
  step(log, 'pull upstream submodules', () => assertOk(run('git', ['submodule', 'update', '--remote', '--merge'])));
} catch (e) {
  log.error(`submodule update failed: ${e.message}`); process.exit(1);
}

const afterServer = sha('vendor/pokemon-showdown');
const afterClient = sha('vendor/pokemon-showdown-client');
log.info(`after:  server=${afterServer} client=${afterClient}`);

// 3. Rebuild + re-apply overlays.
try {
  step(log, 'install server deps', () => assertOk(run('npm', ['ci'], SRV)));
  step(log, 'build server', () => assertOk(run('npm', ['run', 'build'], SRV)));
  step(log, 'install client deps', () => assertOk(run('npm', ['ci'], CLI)));
  step(log, 'build client', () => assertOk(run('node', ['build'], CLI)));
  step(log, 'apply overlays', () => assertOk(run('node', ['scripts/apply-overlay.js'])));
} catch (e) {
  log.error(`rebuild failed after upstream bump (server=${afterServer} client=${afterClient}): ${e.message}`);
  process.exit(1);
}

// 4. Helper tests — the breakage gate.
const testCode = step(log, 'run helper tests', () => run('node', ['--test'], HELP));
if (testCode !== 0) {
  log.error(`UPSTREAM BROKE HELPER TESTS server=${afterServer} client=${afterClient}`);
  log.error(`Read the diff: git -C vendor/pokemon-showdown log --oneline ${beforeServer}..${afterServer}`);
  process.exit(1);
}

log.info(`Done. Submodules updated: server ${beforeServer}->${afterServer}, client ${beforeClient}->${afterClient}`);
log.info("Commit the pointer bump:  git add vendor/ && git commit -m 'chore: bump submodules to latest upstream'");
