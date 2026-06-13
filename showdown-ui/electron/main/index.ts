import { app, BrowserWindow, WebContentsView, ipcMain, shell } from 'electron'
import { join } from 'path'
import { existsSync } from 'fs'

// Repo root relative to the built main process (out/main → out → showdown-ui → repo root). The main
// app (../app/main.js) writes battle logs here; showdown-ui only opens the folder for the user.
const REPO_ROOT = join(__dirname, '..', '..', '..')
const LOGS_DIR  = join(REPO_ROOT, 'logs', 'battle_info')
const REPO_URL  = 'https://github.com/AbhishekR3/ps-local'

// ── IPC: header actions (open repo / open logs folder) ────────────────────
ipcMain.on('open-external', (_event, url: string) => {
  // Only http(s) — never let the renderer hand shell.openExternal an arbitrary scheme.
  const target = typeof url === 'string' && /^https?:\/\//.test(url) ? url : REPO_URL
  shell.openExternal(target)
})

ipcMain.on('open-logs', () => {
  // Falls back to the repo root if no battle has been logged yet (showdown-ui doesn't write logs;
  // the folder only appears once the main app has run).
  shell.openPath(existsSync(LOGS_DIR) ? LOGS_DIR : REPO_ROOT)
})

// ── IPC: relay tapped PS frames to the helper renderer ───────────────────
// The PS view's ps.js preload taps the WebSocket and sends each frame here; we
// forward it to the helper window, which owns the BattleTracker + rendering
// (mirroring how the Chrome extension's panel.js consumes frames in its iframe).
ipcMain.on('ps-frame', (_event, payload: { data: string }) => {
  if (typeof payload?.data !== 'string') return
  mainWindow?.webContents.send('ps-frame', payload)
})

// ── windows ───────────────────────────────────────────────────────────────
let mainWindow: BrowserWindow | null = null
let psView:     WebContentsView | null = null
let isDragging  = false

// The renderer measures the left "game" region and reports its rect here; we
// position the embedded PS client to fill exactly that area, left of the helper.
// No gate on isDragging — we want the psView to follow live during a drag.
ipcMain.on('set-game-bounds', (_event, rect: { x: number; y: number; width: number; height: number }) => {
  if (!psView) return
  psView.setBounds({
    x:      Math.round(rect.x),
    y:      Math.round(rect.y),
    width:  Math.round(rect.width),
    height: Math.round(rect.height),
  })
})

// Drag relay: instead of hiding the PS view (which blanks the screen), we ask
// the psView preload to forward its mousemove/mouseup to main, which relays
// position updates to the renderer so the resize continues while the view stays
// visible. The renderer's own document listeners cover the helper-panel area.
ipcMain.on('begin-resize', () => {
  isDragging = true
  psView?.webContents.send('start-drag-relay')
})

ipcMain.on('end-resize', () => {
  isDragging = false
  psView?.webContents.send('stop-drag-relay')
})

ipcMain.on('ps-drag-move', (_event, { screenX }: { screenX: number }) => {
  if (!isDragging || !mainWindow) return
  const { x } = mainWindow.getContentBounds()
  mainWindow.webContents.send('resize-drag', { x: screenX - x })
})

ipcMain.on('ps-drag-end', () => {
  if (!isDragging) return
  isDragging = false
  mainWindow?.webContents.send('resize-drag-end')
})

function createWindow(): void {
  mainWindow = new BrowserWindow({
    width: 1800,
    height: 900,
    backgroundColor: '#1a1a2e',
    title: 'PS Local — Helper',
    webPreferences: {
      preload:          join(__dirname, '../preload/index.js'),
      contextIsolation: true,
      nodeIntegration:  false,
      sandbox:          false,
    },
  })

  if (process.env['ELECTRON_RENDERER_URL']) {
    mainWindow.loadURL(process.env['ELECTRON_RENDERER_URL'])
  } else {
    mainWindow.loadFile(join(__dirname, '../renderer/index.html'))
  }

  // Embed the live PS client as a child view overlaying the left region.
  // Same webPreferences proven in M5 — contextIsolation:false so the ps.js
  // preload can install the WebSocket tap in the page's main world.
  psView = new WebContentsView({
    webPreferences: {
      preload:          join(__dirname, '../preload/ps.js'),
      contextIsolation: false,
      nodeIntegration:  false,
      sandbox:          false,
      partition:        'persist:showdown-ui',
    },
  })
  mainWindow.contentView.addChildView(psView)
  psView.setBounds({ x: 0, y: 0, width: 0, height: 0 }) // until renderer reports
  psView.webContents.loadURL('https://play.pokemonshowdown.com')

  mainWindow.on('closed', () => {
    mainWindow = null
    psView = null
  })
}

// ── lifecycle ─────────────────────────────────────────────────────────────
app.whenReady().then(() => {
  createWindow()
  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow()
  })
})

// Single-window app: closing the window quits, including on macOS.
app.on('window-all-closed', () => {
  app.quit()
})
