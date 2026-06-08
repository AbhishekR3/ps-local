// Flat ESLint config. Its main job is to give each part of the codebase the right runtime
// environment so the linter (and Codacy, when set to use the repo's config) stops reporting
// hundreds of false `no-undef` errors: the app/scripts layers are CommonJS/Node, the extension
// scripts are browser + WebExtension, the preload bridges both, and the shared libs are pure ESM.
//
// Self-contained (no plugin deps) so it works under `npx eslint .` with no install.

// Available in both Node 22 and the browser.
const universalGlobals = {
  console: 'readonly', URL: 'readonly', fetch: 'readonly',
  setTimeout: 'readonly', clearTimeout: 'readonly', setInterval: 'readonly', clearInterval: 'readonly',
  TextEncoder: 'readonly', TextDecoder: 'readonly', structuredClone: 'readonly',
};

const nodeOnly = {
  require: 'readonly', module: 'writable', exports: 'writable', process: 'readonly',
  __dirname: 'readonly', __filename: 'readonly', Buffer: 'readonly', global: 'readonly',
};

const browserOnly = {
  window: 'readonly', document: 'readonly', location: 'readonly', navigator: 'readonly',
  WebSocket: 'readonly', postMessage: 'readonly', MessageEvent: 'readonly', CustomEvent: 'readonly',
  Event: 'readonly', KeyboardEvent: 'readonly', MutationObserver: 'readonly', Node: 'readonly',
  Blob: 'readonly', requestAnimationFrame: 'readonly', cancelAnimationFrame: 'readonly',
  prompt: 'readonly', alert: 'readonly', confirm: 'readonly',
  URLSearchParams: 'readonly',
  chrome: 'readonly', // WebExtension API
};

const nodeGlobals = { ...universalGlobals, ...nodeOnly };
const browserGlobals = { ...universalGlobals, ...browserOnly };
const preloadGlobals = { ...universalGlobals, ...nodeOnly, ...browserOnly }; // Electron preload bridges both

// A curated slice of eslint:recommended — the rules that catch real bugs here — kept inline so the
// config needs no @eslint/js dependency.
const baseRules = {
  'no-undef': 'error',
  'no-unused-vars': ['error', { args: 'none' }],
  'no-duplicate-case': 'error',
  'no-fallthrough': 'error',
  'no-dupe-keys': 'error',
  'no-redeclare': 'error',
  'no-unreachable': 'error',
  'no-cond-assign': 'error',
  'no-constant-condition': ['error', { checkLoops: false }],
  // Best-effort `try { ... } catch {}` is a deliberate pattern (logging/process-kill sinks must
  // never crash the app); empty catch is intentional.
  'no-empty': ['error', { allowEmptyCatch: true }],
  // Block-scoped function declarations (closures inside preload's inject helper) are valid ES2015+
  // and intentionally capture local state — they cannot move to module root.
  'no-inner-declarations': 'off',
};

module.exports = [
  {
    ignores: [
      'vendor/**', '**/node_modules/**', 'dist/**', 'logs/**',
      'helper/extension/data/**', // generated Monte-Carlo data bundle
    ],
  },
  {
    // Electron main process, orchestration scripts, and this config: CommonJS on Node.
    files: ['app/**/*.js', 'scripts/**/*.js', '*.config.js'],
    languageOptions: { ecmaVersion: 2022, sourceType: 'commonjs', globals: nodeGlobals },
    rules: baseRules,
  },
  {
    // The preload runs in the renderer: Node require + DOM. Overrides the app block above for it.
    files: ['app/preload.js'],
    languageOptions: { ecmaVersion: 2022, sourceType: 'commonjs', globals: preloadGlobals },
    rules: baseRules,
  },
  {
    // Extension content/background/panel/injected scripts run in the browser / service worker.
    // sourceType:module covers the ESM ones (background, panel); the plain scripts parse fine too.
    files: ['helper/extension/*.js'],
    languageOptions: { ecmaVersion: 2022, sourceType: 'module', globals: browserGlobals },
    rules: baseRules,
  },
  {
    // Shared pure libs imported by BOTH the extension and Electron main. Kept dependency-free; only
    // universal globals (console/fetch/URL) are available.
    files: ['helper/extension/lib/**/*.js'],
    languageOptions: { ecmaVersion: 2022, sourceType: 'module', globals: universalGlobals },
    rules: baseRules,
  },
];
