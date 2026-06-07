// ps-local preload (runs at document_start). Mode is passed in via --ps-mode (see main.js).
//
// Both modes install the same proven tap (helper/extension/injected.js), which patches
// window.WebSocket, decodes SockJS frames, and postMessages each one; the relay at the bottom ships
// those to the main process over IPC. How the tap gets in differs by mode:
//   official (contextIsolation:false): the preload shares the page window, so we run the tap in-world
//     (new Function) before any page script — CSP-immune, and ahead of SockJS's load-time capture.
//   local    (contextIsolation:true):  the preload's window is a SEPARATE context, so we inject the
//     tap as a MAIN-world <script> instead (the two-world design the Chrome extension uses). Local
//     also injects the testclient-key global so the bundled client auto-logs in as a registered acct.
// Requires sandbox:false so this preload can require('node:fs').
const { ipcRenderer } = require('electron');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');

// Set by main via webPreferences.additionalArguments. 'official' wraps the live site (contextIsolation
// off, direct WebSocket patch); 'local' drives the bundled testclient (contextIsolation on, DOM inject).
const MODE = (process.argv.find((a) => a.startsWith('--ps-mode=')) || '--ps-mode=official')
  .slice('--ps-mode='.length);

function plog(level, msg) {
  try { ipcRenderer.send('ps-log', { level, ns: 'preload', msg }); } catch {}
  console.log(`[preload] ${msg}`);
}

const tapSrc = (() => {
  try {
    return fs.readFileSync(path.join(__dirname, '..', 'helper', 'extension', 'injected.js'), 'utf8');
  } catch (e) {
    plog('ERROR', `cannot read tap source: ${e && e.message}`);
    return null;
  }
})();

// Read the testclient sid so the page can log in as a registered account exactly like the standalone
// client does. The old client's storage.js reads window.POKEMON_SHOWDOWN_TESTCLIENT_KEY; when present it
// makes the REAL action.php request (with the sid) instead of showing the copy/paste ProxyPopup. We can't
// reuse the standalone's `../config/testclient-key.js` <script> trick (our static root resolves that path
// inside vendor/, which would 404 and dirty the submodule), so we read the value here in the isolated
// world (where node:fs is available) and inject it as a MAIN-world global below.
// Default path is the standalone client repo's key; override with PS_TESTCLIENT_KEY_PATH.
function readTestclientKey() {
  const keyPath = process.env.PS_TESTCLIENT_KEY_PATH ||
    path.join(os.homedir(), 'Documents', 'pokemon-showdown-client', 'config', 'testclient-key.js');
  try {
    const text = fs.readFileSync(keyPath, 'utf8');
    const m = text.match(/POKEMON_SHOWDOWN_TESTCLIENT_KEY\s*=\s*['"]([^'"]+)['"]/);
    if (!m) { plog('WARN', `testclient key file has no POKEMON_SHOWDOWN_TESTCLIENT_KEY: ${keyPath}`); return null; }
    return m[1];
  } catch (e) {
    // Missing key is fine — the client falls back to the stock ProxyPopup. Never log the sid value.
    plog('INFO', `no testclient key (${e && e.code || 'read failed'}) — login falls back to ProxyPopup`);
    return null;
  }
}

// 1. Install the tap before the page constructs its sim WebSocket.
if (MODE === 'official') {
  // contextIsolation:false means this preload shares the page's window and runs before any page
  // script. Execute the proven tap (injected.js) verbatim in that shared world: it patches
  // window.WebSocket directly — no DOM <script> (so the live site's CSP can't block it) and ahead
  // of SockJS capturing window.WebSocket at module-load. No testclient-key: the live site logs in
  // natively. The tap postMessages frames, which the relay below ships to main.
  try {
    if (tapSrc) {
      new Function(tapSrc)(); // eslint-disable-line no-new-func -- run the unforked tap in-world
      plog('INFO', 'tap patched directly into page world (official)');
    }
  } catch (e) {
    plog('ERROR', `tap patch failed: ${e && e.message}`);
  }
} else if (tapSrc) {
  // local: inject the tap (and the testclient-key global) into the page MAIN world via a <script>.
  // An inline <script>'s textContent executes synchronously on insertion, in the page context.
  // In some Electron versions the preload fires before documentElement exists; defer via
  // readystatechange in that case — PS constructs its WebSocket after parsing, so we're still early.
  try {
    const sid = readTestclientKey();
    // storage.js reads this global during App.initialize (well after document_start), so setting it
    // here is early enough; JSON.stringify safely quotes/escapes the value.
    const keySrc = sid ? `window.POKEMON_SHOWDOWN_TESTCLIENT_KEY = ${JSON.stringify(sid)};` : null;
    function injectOne(src, root) {
      const s = document.createElement('script');
      s.textContent = src;
      root.prepend(s);
      s.remove();
    }
    function doInject() {
      const root = document.head || document.documentElement;
      if (!root) return false;
      // Inline scripts run on insertion, so call order = run order: tap first, then the key global.
      injectOne(tapSrc, root);
      if (keySrc) injectOne(keySrc, root);
      return true;
    }
    const what = keySrc ? 'tap + testclient key' : 'tap';
    if (!doInject()) {
      document.addEventListener('readystatechange', function onReady() {
        if (doInject()) {
          document.removeEventListener('readystatechange', onReady);
          plog('INFO', `${what} injected into MAIN world (deferred)`);
        }
      });
    } else {
      plog('INFO', `${what} injected into MAIN world`);
    }
  } catch (e) {
    plog('ERROR', `tap injection failed: ${e && e.message}`);
  }
}

// 2. Relay tapped frames: MAIN world (postMessage) -> this isolated preload -> main process.
let frameCount = 0;
window.addEventListener('message', (event) => {
  if (event.source !== window) return;
  const m = event.data;
  if (!m || m.__psHelper !== true || typeof m.data !== 'string') return;
  frameCount++;
  // Sample the DEBUG noise: first few frames, then every 50th.
  if (frameCount <= 3 || frameCount % 50 === 0) plog('DEBUG', `relayed frame #${frameCount}`);
  ipcRenderer.send('ps-frame', { data: m.data });
});
