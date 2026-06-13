import { app, BrowserWindow, WebContentsView, ipcMain, shell, session } from 'electron'
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

// ── Frame buffer (so the renderer can replay a battle it mounted too late for) ──
// The renderer registers its ps-frame listener only after React mounts; the PS view's
// WebSocket can emit the once-only |init|/|request| frames before that. Without a buffer
// those frames are dropped forever → the helper sits on "Waiting…" for the whole battle.
// We buffer per room (mirroring the extension's background.js) and replay on get-buffer.
const MAX_FRAMES = 2000 // per room
const MAX_ROOMS  = 6    // evict the oldest room beyond this
const buffers = new Map<string, string[]>() // roomid → raw frame strings, insertion-ordered

function roomOf(frame: string): string | null {
  const first = frame.split('\n', 1)[0]
  if (first.startsWith('>')) {
    const m = first.slice(1).trim().match(/^battle-[a-z0-9]+-\d+/)
    if (m) return m[0]
  }
  return null
}

function bufferFrame(data: string): void {
  const room = roomOf(data)
  if (!room) return
  let buf = buffers.get(room)
  if (!buf) {
    buf = []
    buffers.set(room, buf)
    while (buffers.size > MAX_ROOMS) buffers.delete(buffers.keys().next().value!)
  }
  buf.push(data)
  if (buf.length > MAX_FRAMES) buf.shift()
}

// ── IPC: relay tapped PS frames to the helper renderer ───────────────────
// The PS view's ps.js preload taps the WebSocket and sends each frame here; we
// forward it to the helper window, which owns the BattleTracker + rendering
// (mirroring how the Chrome extension's panel.js consumes frames in its iframe).
ipcMain.on('ps-frame', (_event, payload: { data: string }) => {
  if (typeof payload?.data !== 'string') return
  bufferFrame(payload.data)
  // If the helper window isn't ready to receive yet, the live send is a no-op — but the buffer
  // above still captured the frame, so the renderer's get-buffer replay on mount recovers it.
  if (!mainWindow || mainWindow.webContents.isLoading()) {
    const room = roomOf(payload.data)
    if (room) console.log('[PSH ui-main] frame for ' + room + ' arrived before renderer ready — buffered (live send skipped)')
  }
  mainWindow?.webContents.send('ps-frame', payload)
})

// ── IPC: replay buffered frames for the most-recently-active room ─────────
// Called by the renderer on mount so a battle already in progress (or whose init frames
// preceded mount) is reconstructed from the buffer. BattleTracker.feed()'s auto-reset keeps
// state correct since we return a single room's frames.
ipcMain.handle('get-buffer', () => {
  const rooms = [...buffers.keys()]
  const room = rooms[rooms.length - 1] || null
  const frames = (room && buffers.get(room)) || []
  console.log('[PSH ui-main] get-buffer room=' + room + ' → ' + frames.length + ' frames (rooms=[' + rooms.join(', ') + '])')
  return { frames, room }
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

// ── ad / analytics block (live psView only) ───────────────────────────────
// psView wraps the LIVE play.pokemonshowdown.com client (partition 'persist:showdown-ui'), which
// loads Google ad/analytics + the Playwire video-ad stack. PS is MIT, so blocking is permitted; we
// cancel at the session layer so the ad partners are never contacted (no PII leak). Keep this list
// in sync with ../../app/main.js (AD_ANALYTICS_PATTERNS).
//
// MUST NOT match play.pokemonshowdown.com, *.pokemonshowdown.com (asset/data CDN fallbacks),
// sim*.psim.us (battle websockets), or action.php (login).
const AD_ANALYTICS_PATTERNS = [
  // ── Venatus / PS ad orchestrator ─────────────────────────────────────────
  // hb.vntsm.com is THE entry point: one <script> in the live PS page that
  // bootstraps every prebid partner below. Blocking it alone kills the whole
  // ad stack; the rest are belt-and-suspenders for anything loaded separately.
  '*://*.vntsm.com/*',               // Venatus Media orchestrator (hb.vntsm.com, cdn1.vntsm.com, …)
  '*://*.venatus.com/*',             // Venatus first-party domain
  '*://*.venatusmedia.com/*',
  // ── Google ad / analytics stack ──────────────────────────────────────────
  '*://*.doubleclick.net/*',
  '*://*.googlesyndication.com/*',
  '*://*.googletagservices.com/*',
  '*://*.googletagmanager.com/*',
  '*://*.googleadservices.com/*',
  '*://*.google-analytics.com/*',
  '*://*.googleanalytics.com/*',
  '*://*.analytics.google.com/*',
  '*://adservice.google.com/*',
  // ── Microsoft / Bing ads ─────────────────────────────────────────────────
  '*://*.bat.bing.com/*',            // Microsoft UET / Bing Ads conversion pixel
  '*://bat.bing.com/*',
  '*://*.clarity.ms/*',              // Microsoft Clarity analytics/heatmap
  '*://ads.microsoft.com/*',
  // ── Prebid bidders loaded by Venatus ─────────────────────────────────────
  '*://*.amazon-adsystem.com/*',     // Amazon A9 / TAM
  '*://*.adsrvr.org/*',              // The Trade Desk
  '*://*.adnxs.com/*',               // Xandr / AppNexus
  '*://*.criteo.com/*',
  '*://*.rubiconproject.com/*',      // Magnite / Rubicon
  '*://*.sharethrough.com/*',
  '*://*.pubmatic.com/*',
  '*://*.openx.net/*',
  '*://*.openx.com/*',
  '*://*.sovrn.com/*',
  '*://*.lijit.com/*',               // Sovrn legacy domain
  '*://*.triplelift.com/*',
  '*://*.richaudience.com/*',
  '*://*.id5-sync.com/*',            // ID5 universal ID
  '*://*.liadm.com/*',               // LiveRamp / IdentityLink
  '*://*.aniview.com/*',             // Aniview video ads
  '*://*.4dvertible.com/*',          // 4D programmatic
  '*://*.bids.ws/*',                 // Venatus bidder endpoint (a.bids.ws)
  '*://*.smartadserver.com/*',       // Smart AdServer
  '*://*.rapidedge.io/*',            // RapidEdge audience
  '*://*.brandmetrics.com/*',        // Brandmetrics brand-lift
  '*://*.kargo.com/*',
  '*://*.yieldmo.com/*',
  '*://*.seedtag.com/*',
  '*://*.onetag.com/*',              // OneTag SSP
  '*://*.onetag-sys.com/*',
  // ── Other ad/analytics nets seen in practice ─────────────────────────────
  '*://*.moatads.com/*',
  '*://*.scorecardresearch.com/*',
  '*://*.tapad.com/*',
  '*://*.cpx.to/*',
  '*://*.a-mo.net/*',               // Adform DSP
  // ── Legacy Playwire domains (pre-Venatus) ────────────────────────────────
  '*://*.intunl.com/*',
  '*://video-player.playwire.com/*',
  '*://*.playwire.com/*',
  '*://*.intergient.com/*',
  '*://*.pwshowdown.com/*',
]

const AD_COLLAPSE_CSS = `
  .pwAd, [class*="playwire"], [id^="pw-"], [id^="google_ads_"],
  ins.adsbygoogle, iframe[src*="doubleclick"], iframe[src*="googlesyndication"],
  #leaderboard-ad, .ad-container, .ad-slot, [data-ad] {
    display: none !important;
    height: 0 !important;
    min-height: 0 !important;
    margin: 0 !important;
    padding: 0 !important;
  }
`

function installAdBlock(targetSession: Electron.Session): void {
  targetSession.webRequest.onBeforeRequest({ urls: AD_ANALYTICS_PATTERNS }, (_details, cb) => {
    cb({ cancel: true })
  })
}

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
  // Block ads/analytics on the SAME session the psView uses (the partition, not defaultSession),
  // before its first loadURL. Cosmetic CSS collapses any slot that slips through, re-applied per nav.
  installAdBlock(session.fromPartition('persist:showdown-ui'))
  psView.webContents.on('did-finish-load', () => {
    psView?.webContents.insertCSS(AD_COLLAPSE_CSS).catch(() => {})
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
