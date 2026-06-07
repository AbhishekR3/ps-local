#!/usr/bin/env node
'use strict';
// Copies the ps-local config overlays onto the (gitignored) config/config.js targets inside each
// vendor submodule. This is the ONLY supported way to configure the vendored repos — no source file
// in vendor/ is ever edited. Node built-ins only.
const fs = require('node:fs');
const path = require('node:path');

const repoRoot = path.join(__dirname, '..');

const copies = [
  ['overlay/server-config.js', 'vendor/pokemon-showdown/config/config.js', 'server'],
  ['overlay/client-config.js', 'vendor/pokemon-showdown-client/config/config.js', 'client'],
];

for (const [src, dest, label] of copies) {
  const s = path.join(repoRoot, src);
  const d = path.join(repoRoot, dest);
  if (!fs.existsSync(s)) {
    console.error(`[apply-overlay] missing overlay source: ${src}`);
    process.exit(1);
  }
  fs.mkdirSync(path.dirname(d), { recursive: true });
  fs.copyFileSync(s, d);
  console.log(`[apply-overlay] ${label} config written -> ${dest}`);
}
