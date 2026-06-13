// Preload for the hidden PS BrowserWindow (contextIsolation: false).
// Installs the WebSocket tap in the page world, then relays battle frames to main via IPC.
// Mirrors app/preload.js official-mode logic — do not add node-only APIs that would break
// if this preload is ever moved to a sandboxed context.
const { ipcRenderer } = require('electron')
const fs = require('node:fs')
const path = require('node:path')

const tapSrc = (() => {
  try {
    return fs.readFileSync(
      path.join(__dirname, '../../..', 'helper', 'extension', 'injected.js'),
      'utf8'
    )
  } catch (e: unknown) {
    console.error('[ps-preload] cannot read tap source:', (e as Error).message)
    return null
  }
})()

if (tapSrc) {
  try {
    // contextIsolation:false → preload shares the page window, so we can run the tap
    // inline with new Function() before any page script captures window.WebSocket.
    new Function(tapSrc)()  // eslint-disable-line no-new-func
  } catch (e: unknown) {
    console.error('[ps-preload] tap install failed:', (e as Error).message)
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
