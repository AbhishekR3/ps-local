// Guard tests for the architecture's known "silent divergence" footguns. Each duplication or
// cross-file contract that the codebase keeps in sync by hand is asserted here, so drift fails CI
// loudly instead of leaking ads / unstyled UI / a dead tap at runtime. See docs/architecture.html
// §13 (Risk Assessment) and §16 (Gotchas).

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, '..', '..');
// Normalize CRLF→LF: these guards parse source with \n-based anchors (e.g. indexOf('\n\n')), so a
// Windows checkout with autocrlf would otherwise break them. Keeps the suite line-ending-stable on CI.
const read = (p) => readFileSync(join(ROOT, p), 'utf8').replace(/\r\n/g, '\n');

// ── A1: the ad-block list is hand-duplicated across the two Electron mains (CJS app/ vs ESM
// showdown-ui — CLAUDE.md forbids a shared module). Assert the two pattern lists are identical. ──
test('AD_ANALYTICS_PATTERNS is identical in app/main.js and showdown-ui main', () => {
  const extract = (src) => {
    const open = src.indexOf('[', src.indexOf('AD_ANALYTICS_PATTERNS'));
    const close = src.indexOf(']', open);
    assert.ok(open !== -1 && close !== -1, 'could not locate AD_ANALYTICS_PATTERNS array');
    return [...src.slice(open, close).matchAll(/'(\*:\/\/[^']+)'/g)].map((m) => m[1]);
  };
  const legacy = extract(read('app/main.js'));
  const primary = extract(read('showdown-ui/electron/main/index.ts'));
  assert.ok(legacy.length > 20, 'expected a substantial ad-block list');
  assert.deepEqual([...primary].sort(), [...legacy].sort(),
    'ad-block lists diverged — update BOTH app/main.js and showdown-ui/electron/main/index.ts');
});

// ── A2: panel.css (extension) and global.css (showdown-ui) are separate copies of the same rules.
// Any class the SHARED render.js emits must be styled in BOTH (or neither) — a class styled in one
// surface but not the other is the silent-divergence bug this guards. ──
test('render.js classes are styled consistently across panel.css and global.css', () => {
  const renderSrc = read('helper/extension/lib/render.js');
  const emitted = new Set();
  for (const m of renderSrc.matchAll(/class\s*=\s*(["'])(.*?)\1/g)) {
    for (const tok of m[2].split(/\s+/)) {
      if (/^[a-z][a-z0-9-]*$/i.test(tok)) emitted.add(tok);  // static tokens only; ${...} fragments skipped
    }
  }
  assert.ok(emitted.size > 5, 'expected render.js to emit several classes');

  const cssClasses = (src) => {
    const noComments = src.replace(/\/\*[\s\S]*?\*\//g, '');
    return new Set([...noComments.matchAll(/\.([a-z][a-z0-9_-]*)/gi)].map((m) => m[1]));
  };
  const inPanel = cssClasses(read('helper/extension/panel.css'));
  const inGlobal = cssClasses(read('showdown-ui/src/styles/global.css'));

  const divergent = [];
  for (const cls of emitted) {
    const p = inPanel.has(cls);
    const g = inGlobal.has(cls);
    if (p !== g) divergent.push(`${cls} (panel.css=${p}, global.css=${g})`);
  }
  assert.deepEqual(divergent, [],
    'render.js classes styled in only one CSS copy — keep panel.css and global.css in sync');
});

// ── A1: a real disk/permission failure in writeLog used to be logged to logs/debug/ only — a battle
// log lost with no visible signal. The fix surfaces it via the existing ps-status plumbing as a
// logWrite health field. Guard that the wiring stays in place (deriveStatus is TSX, not node-testable). ──
test('writeLog failure surfaces via PsStatus.logWrite', () => {
  const main = read('showdown-ui/electron/main/index.ts');
  assert.match(main, /psStatus\.logWrite\s*=\s*'error'/,
    'index.ts no longer sets logWrite="error" on a write failure — A1 surfacing regressed');
  assert.match(main, /logWrite:\s*'ok'/, 'index.ts PsStatus must initialize logWrite');
  const dts = read('showdown-ui/src/global.d.ts');
  assert.match(dts, /logWrite\s*:/, 'global.d.ts PsStatus must declare logWrite');
  const panel = read('showdown-ui/src/components/HelperPanel.tsx');
  assert.match(panel, /transport\.logWrite\s*===\s*'error'/,
    'HelperPanel deriveStatus must render an error branch for logWrite');
});

// ── §4/§9: every IPC channel the showdown-ui main registers (ipcMain.on/handle) or pushes
// (webContents.send) must have a matching ipcRenderer.on/send/invoke in a preload, and vice versa.
// A channel wired on only one side is a dead endpoint (the endpoint-mapping check, automated). ──
test('showdown-ui IPC channels match between main and preloads', () => {
  const channels = (src, re) => new Set([...src.matchAll(re)].map((m) => m[1]));
  const main = channels(
    read('showdown-ui/electron/main/index.ts'),
    /(?:ipcMain\.(?:on|handle)|webContents\.send)\(\s*['"]([^'"]+)['"]/g);
  const preload = channels(
    read('showdown-ui/electron/preload/index.ts') + '\n' + read('showdown-ui/electron/preload/ps.ts'),
    /ipcRenderer\.(?:on|send|invoke)\(\s*['"]([^'"]+)['"]/g);
  assert.ok(main.size > 10, 'expected a substantial set of IPC channels');
  assert.deepEqual([...main].sort(), [...preload].sort(),
    'IPC channels diverged between main and preload — a channel is wired on only one side');
});

// ── A12: injected.js taps localhost ports that manifest.json must grant, or the extension never
// injects on that port and the tap silently sees nothing. Assert the port sets match. ──
test('injected.js localhost ports match manifest.json grants', () => {
  const ports = (src) => new Set([...src.matchAll(/localhost:(\d+)/g)].map((m) => m[1]));
  const injected = ports(read('helper/extension/injected.js'));
  const manifest = ports(read('helper/extension/manifest.json'));
  assert.ok(injected.size >= 2, 'expected injected.js to tap at least two localhost ports');
  assert.deepEqual([...injected].sort(), [...manifest].sort(),
    'injected.js taps a localhost port manifest.json does not grant (or vice versa)');
});

// ── A12: injected.js must postMessage to the page origin, never '*' (a cross-origin data-leak
// regression — any framing page could intercept battle frames). ──
test('injected.js posts to the page origin, not the "*" wildcard', () => {
  const src = read('helper/extension/injected.js');
  assert.match(src, /postMessage\([^)]*window\.location\.origin\s*\)/,
    'expected injected.js to post to window.location.origin');
  assert.doesNotMatch(src, /postMessage\([^)]*,\s*['"]\*['"]\s*\)/,
    'injected.js posts to "*" — security regression, target window.location.origin instead');
});

// ─────────────────────────────────────────────────────────────────────────────
// P7 on-boot upstream update flow (feat: apply + rollback UI). Same silent-divergence philosophy:
// the apply path, its IPC surface, the config key, and the UI state machine are wired by hand across
// index.ts / upstream-canary.yml / the preloads / config.example.json / UpdateScreen.tsx. Guard the
// seams so a one-sided edit fails CI instead of shipping a dead update button or a skipped test gate.
// ─────────────────────────────────────────────────────────────────────────────

// ── The in-app apply (index.ts applyUpdate) and the canary CI both bump submodules. index.ts pins the
// exact flags with a comment promising they match upstream-canary.yml ("avoids 'refusing to merge
// unrelated histories' on shallow clones"). Assert the flag set is identical so a future change to one
// side can't silently diverge the apply behavior from the CI that validates it. ──
test('submodule-update flags match between index.ts applyUpdate and upstream-canary.yml', () => {
  // index.ts spawns it as an argv array: ['git','submodule','update','--remote','--force','--recursive'].
  const mainFlags = (src) => {
    const m = src.match(/\[\s*'git'\s*,\s*'submodule'\s*,\s*'update'\s*,([^\]]*)\]/);
    assert.ok(m, "could not locate the git-submodule-update argv array in index.ts");
    return new Set([...m[1].matchAll(/'(--[a-z-]+)'/g)].map((x) => x[1]));
  };
  // upstream-canary.yml runs it as a shell line: git submodule update --remote --force --recursive.
  const ymlFlags = (src) => {
    const m = src.match(/git submodule update((?:\s+--[a-z-]+)+)/);
    assert.ok(m, "could not locate the git submodule update line in upstream-canary.yml");
    return new Set([...m[1].matchAll(/(--[a-z-]+)/g)].map((x) => x[1]));
  };
  const main = mainFlags(read('showdown-ui/electron/main/index.ts'));
  const yml = ymlFlags(read('.github/workflows/upstream-canary.yml'));
  assert.ok(main.size >= 3, 'expected at least --remote --force --recursive');
  assert.deepEqual([...main].sort(), [...yml].sort(),
    'submodule-update flags diverged between index.ts and upstream-canary.yml — update BOTH');
});

// ── applyUpdate MUST run the helper test suite as a gate AFTER pulling new commits and BEFORE
// returning success — that gate is the whole safety story (failure surfaces the rollback UI). Guard
// that the apply path can never be edited to skip it. ──
test('applyUpdate gates on node --test before reporting success', () => {
  const src = read('showdown-ui/electron/main/index.ts');
  const fn = src.slice(src.indexOf('async function applyUpdate'), src.indexOf('async function doRollback'));
  assert.ok(fn.length > 0, 'could not isolate applyUpdate()');
  assert.match(fn, /\[\s*'node'\s*,\s*'--test'\s*\]/,
    'applyUpdate no longer runs node --test — the upstream-apply test gate was removed');
  // The success return must come from the same block that ran the tests (after the submodule update).
  const testIdx = fn.indexOf("'--test'");
  const successIdx = fn.indexOf('success: true');
  assert.ok(testIdx !== -1 && successIdx > testIdx,
    'success:true is no longer downstream of the node --test gate in applyUpdate');
});

// ── The five P7 update IPC channels are part of the endpoint-map guard above (it sweeps all channels),
// but symmetric deletion (remove a channel from BOTH main and preload) would still pass that test. Pin
// the names explicitly so the auto-update surface can't be silently dropped from both sides at once. ──
test('P7 update IPC channels are present in main and preload', () => {
  const required = ['get-app-config', 'update-check', 'update-apply', 'update-rollback', 'update-apply-progress'];
  const main = read('showdown-ui/electron/main/index.ts');
  const preload = read('showdown-ui/electron/preload/index.ts');
  for (const ch of required) {
    assert.ok(main.includes(`'${ch}'`), `index.ts no longer wires the '${ch}' IPC channel`);
    assert.ok(preload.includes(`'${ch}'`), `preload/index.ts no longer wires the '${ch}' IPC channel`);
  }
});

// ── checkUpdatesOnBoot is the config key that gates the whole UpdateScreen. It must stay in lockstep
// across the example config (so users can discover it), the main process (which reads it), and the
// docs. A key documented in one place but read under a different name silently disables the feature. ──
test('checkUpdatesOnBoot config key is consistent across config, main, and docs', () => {
  assert.match(read('config.example.json'), /"checkUpdatesOnBoot"\s*:/,
    'config.example.json no longer advertises checkUpdatesOnBoot');
  assert.match(read('showdown-ui/electron/main/index.ts'), /config\.checkUpdatesOnBoot\b/,
    'index.ts no longer reads config.checkUpdatesOnBoot');
  assert.ok(read('CLAUDE.md').includes('checkUpdatesOnBoot'),
    'root CLAUDE.md no longer documents checkUpdatesOnBoot');
  assert.ok(read('showdown-ui/CLAUDE.md').includes('checkUpdatesOnBoot'),
    'showdown-ui/CLAUDE.md no longer documents checkUpdatesOnBoot');
});

// ── UpdateScreen.tsx is a phase state machine: every `kind` in the Phase union must have a render
// branch, or a new phase added to the union renders nothing (blank screen on boot). Assert each kind
// from the union appears in the component body as either an `if (phase.kind === '…')` guard or the
// fall-through default's `// <kind>` marker comment (result-fail is the trailing default). ──
test('UpdateScreen Phase union is exhaustively rendered', () => {
  const src = read('showdown-ui/src/components/UpdateScreen.tsx');
  const unionStart = src.indexOf('type Phase');
  const unionEnd = src.indexOf('\n\n', unionStart);
  const unionBlock = src.slice(unionStart, unionEnd);
  const kinds = [...unionBlock.matchAll(/kind:\s*'([a-z-]+)'/g)].map((m) => m[1]);
  assert.ok(kinds.length >= 6, `expected several Phase kinds, found ${kinds.length}`);

  const body = src.slice(unionEnd);
  const missing = kinds.filter((k) =>
    !body.includes(`phase.kind === '${k}'`) &&   // explicit guard branch
    !new RegExp(`//\\s*${k}\\b`).test(body));     // or the trailing fall-through marker comment
  assert.deepEqual(missing, [],
    `UpdateScreen Phase kind(s) with no render branch (blank-screen risk): ${missing.join(', ')}`);
});
