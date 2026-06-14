// Preload for the hidden PS BrowserWindow (contextIsolation: false).
// Installs the WebSocket tap in the page world, then relays battle frames to main via IPC.
// Mirrors app/preload.js official-mode logic — do not add node-only APIs that would break
// if this preload is ever moved to a sandboxed context.
const { ipcRenderer } = require('electron')
const fs = require('node:fs')
const path = require('node:path')

// injected.js lives outside out/, so it's shipped via electron-builder extraResources to
// process.resourcesPath when packaged. In dev it's read from the repo (out/preload → repo root).
// `app.isPackaged` isn't available in a preload, so probe both paths instead of branching on a flag.
// Keep these candidates in sync with the PS_SMOKE tap-load assertion in electron/main/index.ts.
const tapCandidates = [
  path.join(process.resourcesPath, 'helper', 'extension', 'injected.js'), // packaged
  path.join(__dirname, '../../..', 'helper', 'extension', 'injected.js'),  // dev
]

const tapSrc = (() => {
  for (const p of tapCandidates) {
    try {
      return fs.readFileSync(p, 'utf8')
    } catch { /* try next candidate */ }
  }
  console.error('[ps-preload] cannot read tap source from any of:', tapCandidates.join(', '))
  return null
})()

if (!tapSrc) {
  // No tap source → no WebSocket interception → the helper would never see a frame. Report it so
  // main can show "Tap not active" instead of an endless "Waiting…".
  ipcRenderer.send('ps-tap-error', { reason: 'tap source not found' })
} else {
  try {
    // contextIsolation:false → preload shares the page window, so we can run the tap
    // inline with new Function() before any page script captures window.WebSocket.
    new Function(tapSrc)()  // eslint-disable-line no-new-func
    console.log('[ps-preload] tap install ok')
    ipcRenderer.send('ps-tap-ok')
  } catch (e: unknown) {
    console.error('[ps-preload] tap install failed:', (e as Error).message)
    ipcRenderer.send('ps-tap-error', { reason: (e as Error).message })
  }
}

// Relay battle frames: page postMessage → IPC → main
window.addEventListener('message', (event: MessageEvent) => {
  if (event.source !== window) return
  const m = event.data
  if (!m || m.__psHelper !== true || typeof m.data !== 'string') return
  ipcRenderer.send('ps-frame', { data: m.data })
})

// Drag relay: when the user drags the game/helper divider, the PS view (a
// WebContentsView) would normally eat mouse events over its area, breaking the
// drag. Instead of hiding the view (which blanks the screen), main asks us to
// forward mousemove/mouseup so the resize can continue uninterrupted.
let _relayMove: ((e: MouseEvent) => void) | null = null
let _relayUp:   (() => void) | null = null

ipcRenderer.on('start-drag-relay', () => {
  _relayMove = (e: MouseEvent) => ipcRenderer.send('ps-drag-move', { screenX: e.screenX })
  _relayUp   = () => {
    document.removeEventListener('mousemove', _relayMove!)
    document.removeEventListener('mouseup',   _relayUp!)
    _relayMove = null
    _relayUp   = null
    ipcRenderer.send('ps-drag-end')
  }
  document.addEventListener('mousemove', _relayMove)
  document.addEventListener('mouseup',   _relayUp)
})

ipcRenderer.on('stop-drag-relay', () => {
  if (_relayMove) document.removeEventListener('mousemove', _relayMove)
  if (_relayUp)   document.removeEventListener('mouseup',   _relayUp)
  _relayMove = null
  _relayUp   = null
})
