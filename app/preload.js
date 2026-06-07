// ps-local preload (runs in the renderer's ISOLATED world at document_start).
//
// Why this is not a naive `window.WebSocket = Patched`: with contextIsolation:true the preload's
// `window` is a SEPARATE context from the page's, so patching it here would never touch the socket
// the PS bundle actually constructs. Instead we inject the proven MAIN-world tap
// (helper/extension/injected.js) as a <script> before page scripts run, let it postMessage frames
// across the world boundary, and relay those to the main process over IPC. This is the same
// two-world design the Chrome extension uses (MAIN-world injected.js + ISOLATED-world content.js),
// reproduced for Electron. Requires sandbox:false so this preload can require('node:fs').
const { ipcRenderer } = require('electron');
const fs = require('node:fs');
const path = require('node:path');

function plog(level, msg) {
  try { ipcRenderer.send('ps-log', { level, ns: 'preload', msg }); } catch {}
  console.log(`[preload] ${msg}`);
}

// 1. Inject the tap into the page MAIN world before SockJS is constructed.
//    An inline <script>'s textContent executes synchronously on insertion, in the page context.
try {
  const tapSrc = fs.readFileSync(
    path.join(__dirname, '..', 'helper', 'extension', 'injected.js'),
    'utf8',
  );
  const s = document.createElement('script');
  s.textContent = tapSrc;
  (document.head || document.documentElement).prepend(s);
  s.remove();
  plog('INFO', 'tap injected into MAIN world');
} catch (e) {
  plog('ERROR', `tap injection failed: ${e && e.message}`);
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
