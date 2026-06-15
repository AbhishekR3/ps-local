import { app, BrowserWindow, WebContentsView, ipcMain, shell, session, screen, nativeImage } from 'electron'
import { join } from 'path'
import { mkdirSync, readFileSync, writeFileSync, appendFileSync, readdirSync, unlinkSync, existsSync } from 'fs'
import { homedir } from 'os'
import { BattleTracker } from '../../../helper/extension/lib/parser.js'
import { generateBattleLog } from '../../../helper/extension/lib/exporter.js'
import { roomidOf, battleLogFilename, battleEndReason } from '../../../helper/extension/lib/logmeta.js'

// Path bases differ between dev (run from the repo) and a packaged app (__dirname is inside the asar).
//   DATA_DIR  — base for bundled read-only data (moves.json). Packaged: process.resourcesPath, where
//               electron-builder's extraResources lands the helper data outside the asar.
//   USER_ROOT — base for user-writable state (config.json + logs/). Packaged: ~/Documents/ps-local/
//               so logs survive app updates and aren't trapped inside the read-only bundle.
// In dev both collapse to the repo root, so the dev path is byte-for-byte unchanged.
const REPO_ROOT = join(__dirname, '..', '..', '..')                 // dev only (out/main → repo root)
const DATA_DIR  = app.isPackaged ? process.resourcesPath : REPO_ROOT
const USER_ROOT = app.isPackaged ? join(app.getPath('documents'), 'ps-local') : REPO_ROOT
const LOGS_DIR  = join(USER_ROOT, 'logs', 'battle_info')
const REPO_URL  = 'https://github.com/AbhishekR3/ps-local'

// ── Config ────────────────────────────────────────────────────────────────────
// config.json at the repo root (gitignored; config.example.json is the committed template).
// Env var PS_LOG_LEVEL and PS_TIMEZONE still win over the file.
interface Config { timezone: string; logLevel: string; saveLogs: boolean; iconPath?: string }
let _configWarning: string | null = null
function loadConfig(): Config {
  const defaults: Config = { timezone: 'UTC', logLevel: 'INFO', saveLogs: true }
  try {
    return { ...defaults, ...JSON.parse(readFileSync(join(USER_ROOT, 'config.json'), 'utf8')) }
  } catch (e: any) {
    if (e.code !== 'ENOENT') _configWarning = `config.json invalid (${e.message}) — using defaults`
    return defaults
  }
}
const config = loadConfig()
if (config.logLevel && !process.env['PS_LOG_LEVEL']) process.env['PS_LOG_LEVEL'] = config.logLevel
const TIMEZONE = process.env['PS_TIMEZONE'] || config.timezone

// ── Transport health (surfaced to the renderer) ────────────────────────────────
// Silent failures were the system's #1 weakness: a dead WebSocket tap, an offline PS site, or
// saveLogs=false all left the helper sitting on "Waiting…" forever with no signal. We track the
// three here and push them to the renderer (ps-status) so they become visible.
type PsStatus = { tap: 'unknown' | 'ok' | 'error'; page: 'ok' | 'unreachable'; saveLogs: boolean; logWrite: 'ok' | 'error' }
const psStatus: PsStatus = { tap: 'unknown', page: 'ok', saveLogs: config.saveLogs, logWrite: 'ok' }

// ── Logger ────────────────────────────────────────────────────────────────────
// Mirrors app/logger.js format: "ISO [LEVEL] [ns] msg", PS_LOG_LEVEL threshold, logs/debug/ sink.
const LOG_LEVELS: Record<string, number> = { DEBUG: 10, INFO: 20, WARN: 30, ERROR: 40 }
const LOG_THRESHOLD = LOG_LEVELS[(process.env['PS_LOG_LEVEL'] || 'INFO').toUpperCase()] ?? LOG_LEVELS['INFO']

const MAX_DEBUG_LOGS = 10  // one debug log per launch is created; prune so only the newest N survive

// Debug logs accumulate one file per launch with no upstream bound — prune on startup. Battle logs
// (logs/battle_info/) are an intentional permanent archive and are left untouched.
function pruneDebugLogs(dir: string): void {
  try {
    const logs = readdirSync(dir)
      .filter((f) => f.startsWith('showdown-ui-') && f.endsWith('.log'))
      .sort()  // ISO timestamp embedded in the name → lexical sort is chronological
    // Keep newest MAX_DEBUG_LOGS-1; this launch is about to add one, landing exactly at the cap.
    for (const f of logs.slice(0, Math.max(0, logs.length - (MAX_DEBUG_LOGS - 1)))) {
      try { unlinkSync(join(dir, f)) } catch { /* best-effort */ }
    }
  } catch { /* best-effort — never let log housekeeping crash startup */ }
}

let _logFile: string | null = null
function logFile(): string {
  if (_logFile) return _logFile
  const dir = join(USER_ROOT, 'logs', 'debug')
  mkdirSync(dir, { recursive: true })
  pruneDebugLogs(dir)
  const ts = new Date().toISOString().replace(/[:.]/g, '-')
  _logFile = join(dir, `showdown-ui-${ts}.log`)
  return _logFile
}

function logEmit(level: string, ns: string, msg: string): void {
  if ((LOG_LEVELS[level] ?? 0) < LOG_THRESHOLD) return
  const line = `${new Date().toISOString()} [${level.padEnd(5)}] [${ns}] ${msg}`
  ;(level === 'WARN' || level === 'ERROR' ? console.error : console.log)(line)
  try { appendFileSync(logFile(), line + '\n') } catch { /* best-effort */ }
}

function createLogger(ns: string) {
  return {
    debug: (m: string) => logEmit('DEBUG', ns, m),
    info:  (m: string) => logEmit('INFO',  ns, m),
    warn:  (m: string) => logEmit('WARN',  ns, m),
    error: (m: string) => logEmit('ERROR', ns, m),
  }
}

const log  = createLogger('ui-main')
const wlog = createLogger('ui-wlog')

if (_configWarning) log.warn(_configWarning)

// Resolve config.iconPath → a nativeImage for the window/taskbar (Linux/Windows) and macOS Dock.
// Tilde-expands ~; missing/unreadable files warn and fall back to the bundled icon.
function resolveIcon(p: string | undefined): Electron.NativeImage | undefined {
  if (!p) return undefined
  const expanded = p.startsWith('~') ? join(homedir(), p.slice(1)) : p
  if (!existsSync(expanded)) { log.warn(`iconPath not found: ${expanded} — using default icon`); return undefined }
  const img = nativeImage.createFromPath(expanded)
  if (img.isEmpty()) { log.warn(`iconPath unreadable as image: ${expanded} — using default icon`); return undefined }
  return img
}

// ── Move metadata (read once at ready; optional — rich logs degrade to bare ids without it) ──
let movesData: Record<string, any> = {}

function loadMovesData(): void {
  const p = join(DATA_DIR, 'helper', 'extension', 'data', 'moves.json')
  try {
    movesData = JSON.parse(readFileSync(p, 'utf8'))
    log.info(`movesData loaded: ${Object.keys(movesData).length} moves`)
  } catch (e: any) {
    movesData = {}
    log.warn(`movesData not loaded (${e?.message}); rich logs will use bare move ids`)
  }
}

// ── Battle log writer (C5) ────────────────────────────────────────────────────
// Per-room accumulators: roomid → { tracker, rawFrames, lastSeen }.
// One tracker per room: feed() auto-resets on a new roomid, so a shared tracker would thrash.
interface RoomEntry { tracker: any; rawFrames: string[]; lastSeen: number }
const rooms = new Map<string, RoomEntry>()

const STALE_ROOM_MS      = 30 * 60 * 1000  // evict rooms idle longer than this (saved as INPROGRESS)
const MAX_FRAMES_PER_ROOM = 100_000         // hard cap to bound memory
const SWEEP_INTERVAL_MS  = 5 * 60 * 1000   // stale-room sweep cadence

function writeLog(roomid: string, state: any, rawFrames: string[]): void {
  if (!config.saveLogs) {
    wlog.debug(`saveLogs=false — skipping log write for ${roomid} (turn=${state.turn})`)
    return
  }
  try {
    mkdirSync(LOGS_DIR, { recursive: true })

    const base     = battleLogFilename(roomid, state, Date.now())
    const richPath = join(LOGS_DIR, `${base}.txt`)

    const rich = generateBattleLog(state, rawFrames, movesData, TIMEZONE)
    writeFileSync(richPath, rich)

    wlog.info(`wrote ${richPath} (${rich.length} B)`)
    // Recovered after a prior failure — clear the error so the status line returns to OK.
    if (psStatus.logWrite === 'error') { psStatus.logWrite = 'ok'; pushStatus() }
  } catch (e: any) {
    wlog.error(`writeLog failed for ${roomid}: ${e?.stack}`)
    // A real disk/permission failure loses a battle log silently — surface it on the status line.
    psStatus.logWrite = 'error'
    pushStatus()
  }
}

function flushAllRooms(reason: string): void {
  if (rooms.size === 0) return
  wlog.warn(`flushing ${rooms.size} open room(s) on ${reason}`)
  for (const [roomid, entry] of rooms) {
    try { writeLog(roomid, entry.tracker.state, entry.rawFrames) }
    catch (e: any) { wlog.error(`flushAllRooms failed for ${roomid}: ${e?.stack}`) }
  }
  rooms.clear()
}

function sweepStaleRooms(): void {
  const now = Date.now()
  for (const [roomid, entry] of rooms) {
    if (now - entry.lastSeen > STALE_ROOM_MS) {
      wlog.warn(`evicting stale room ${roomid} (idle ${Math.round((now - entry.lastSeen) / 1000)}s, turn=${entry.tracker.state.turn})`)
      try { writeLog(roomid, entry.tracker.state, entry.rawFrames) }
      catch (e: any) { wlog.error(`stale flush failed for ${roomid}: ${e?.stack}`) }
      rooms.delete(roomid)
    }
  }
}

function handleFrame(frameData: string): void {
  const roomid = roomidOf(frameData)
  if (!roomid) return

  let entry = rooms.get(roomid)
  if (!entry) {
    entry = { tracker: new BattleTracker(), rawFrames: [], lastSeen: Date.now() }
    rooms.set(roomid, entry)
    log.info(`room opened: ${roomid}`)
  }
  entry.lastSeen = Date.now()
  entry.tracker.feed(frameData)
  entry.rawFrames.push(frameData)

  if (entry.rawFrames.length > MAX_FRAMES_PER_ROOM) {
    wlog.warn(`room ${roomid} exceeded ${MAX_FRAMES_PER_ROOM} frames — flushing + evicting`)
    writeLog(roomid, entry.tracker.state, entry.rawFrames)
    rooms.delete(roomid)
    return
  }

  const st = entry.tracker.state
  log.debug(`frame ${roomid} turn=${st.turn} ended=${st.ended} bytes=${frameData.length}`)

  const reason = battleEndReason(frameData, st.turn)

  if (reason) {
    log.info(`flushing ${roomid} (reason=${reason}, turn=${st.turn})`)
    writeLog(roomid, st, entry.rawFrames)
    rooms.delete(roomid)
  }
}

// ── IPC: header actions ───────────────────────────────────────────────────────
ipcMain.on('open-external', (_event, url: string) => {
  const target = typeof url === 'string' && /^https?:\/\//.test(url) ? url : REPO_URL
  shell.openExternal(target)
})

ipcMain.on('open-logs', () => {
  // Always open the real logs dir (~/Documents/ps-local/logs/battle_info when packaged, repo root in
  // dev). Create it on demand so the first click before any battle doesn't fall back into the asar.
  mkdirSync(LOGS_DIR, { recursive: true })
  shell.openPath(LOGS_DIR)
})

// ── Frame buffer (so the renderer can replay a battle it mounted too late for) ──
// The renderer registers its ps-frame listener only after React mounts; the PS view's
// WebSocket can emit the once-only |init|/|request| frames before that. Without a buffer
// those frames are dropped forever → the helper sits on "Waiting…" for the whole battle.
// We buffer per room (mirroring the extension's background.js) and replay on get-buffer.
const MAX_FRAMES = 2000  // per room (display buffer — log writer uses its own rooms map above)
const MAX_ROOMS  = 6     // evict the oldest room beyond this
const buffers = new Map<string, string[]>()  // roomid → raw frame strings, insertion-ordered

function bufferFrame(data: string): void {
  const room = roomidOf(data)
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

// ── IPC: relay tapped PS frames to the helper renderer ───────────────────────
ipcMain.on('ps-frame', (_event, payload: { data: string }) => {
  if (typeof payload?.data !== 'string') return
  bufferFrame(payload.data)
  // Drive the log writer (same contract as app/main.js C5 path).
  try { handleFrame(payload.data) }
  catch (e: any) { log.error(`handleFrame error: ${e?.stack}`) }

  if (!mainWindow || mainWindow.webContents.isLoading()) {
    const room = roomidOf(payload.data)
    if (room) log.debug(`frame for ${room} arrived before renderer ready — buffered (live send skipped)`)
  }
  mainWindow?.webContents.send('ps-frame', payload)
})

// ── IPC: replay buffered frames for the most-recently-active room ─────────────
ipcMain.handle('get-buffer', () => {
  const roomList = [...buffers.keys()]
  const room     = roomList[roomList.length - 1] || null
  const frames   = (room && buffers.get(room)) || []
  log.info(`get-buffer room=${room} → ${frames.length} frames`)
  return { frames, room }
})

// ── windows ───────────────────────────────────────────────────────────────────
let mainWindow: BrowserWindow | null = null
let psView:     WebContentsView | null = null
let isDragging  = false

ipcMain.on('set-game-bounds', (_event, rect: { x: number; y: number; width: number; height: number }) => {
  if (!psView) return
  psView.setBounds({
    x:      Math.round(rect.x),
    y:      Math.round(rect.y),
    width:  Math.round(rect.width),
    height: Math.round(rect.height),
  })
})

ipcMain.on('begin-resize', () => {
  isDragging = true
  psView?.webContents.send('start-drag-relay')
})

ipcMain.on('end-resize', () => {
  isDragging = false
  psView?.webContents.send('stop-drag-relay')
})

ipcMain.on('ps-drag-move', (_event, { screenX }: { screenX: number }) => {
  // Guard isDestroyed too: quitting mid-drag can leave a non-null but torn-down window, and
  // getContentBounds()/send() throw on it.
  if (!isDragging || !mainWindow || mainWindow.isDestroyed()) return
  const { x } = mainWindow.getContentBounds()
  mainWindow.webContents.send('resize-drag', { x: screenX - x })
})

ipcMain.on('ps-drag-end', () => {
  if (!isDragging) return
  isDragging = false
  if (mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.send('resize-drag-end')
})

// ── IPC: transport health → renderer status line ───────────────────────────────
function pushStatus(): void {
  mainWindow?.webContents.send('ps-status', psStatus)
}

// The psView preload reports whether the WebSocket tap installed. A failure means no battle frames
// will ever arrive — surface it instead of letting the helper sit on "Waiting…" indefinitely.
ipcMain.on('ps-tap-ok', () => { psStatus.tap = 'ok'; pushStatus() })
ipcMain.on('ps-tap-error', (_event, info: { reason?: string }) => {
  psStatus.tap = 'error'
  log.error(`ps tap failed to install (${info?.reason || 'unknown'}) — battle help will receive no frames`)
  pushStatus()
})

// Renderer pulls the snapshot on mount: the tap/page events can fire before its listener registers.
ipcMain.handle('get-status', () => psStatus)

// Reload affordance shown when the PS site failed to load (offline / DNS). Optimistically clear the
// page error; did-finish-load / did-fail-load will set the real state.
ipcMain.on('reload-ps', () => {
  psStatus.page = 'ok'
  pushStatus()
  psView?.webContents.reload()
})

// ── ad / analytics block (live psView only) ───────────────────────────────────
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
  // Open at the full size of the screen's work area (menu bar / dock excluded) as an ordinary,
  // movable window — not true fullscreen (no separate Space / hidden chrome on macOS).
  const { workArea } = screen.getPrimaryDisplay()
  const windowIcon = resolveIcon(config.iconPath)
  mainWindow = new BrowserWindow({
    x:      workArea.x,
    y:      workArea.y,
    width:  workArea.width,
    height: workArea.height,
    backgroundColor: '#1a1a2e',
    title: 'Pokemon Showdown Battle UI',
    ...(windowIcon ? { icon: windowIcon } : {}),
    webPreferences: {
      preload:          join(__dirname, '../preload/index.js'),
      contextIsolation: true,
      nodeIntegration:  false,
      sandbox:          false,
    },
  })

  if (windowIcon && process.platform === 'darwin') app.dock?.setIcon(windowIcon)

  if (process.env['ELECTRON_RENDERER_URL']) {
    mainWindow.loadURL(process.env['ELECTRON_RENDERER_URL'])
  } else {
    mainWindow.loadFile(join(__dirname, '../renderer/index.html'))
  }

  psView = new WebContentsView({
    webPreferences: {
      preload:          join(__dirname, '../preload/ps.js'),
      contextIsolation: false,
      nodeIntegration:  false,
      sandbox:          false,
      partition:        'persist:showdown-ui',
    },
  })
  installAdBlock(session.fromPartition('persist:showdown-ui'))
  psView.webContents.on('did-finish-load', () => {
    psStatus.page = 'ok'
    pushStatus()
    psView?.webContents.insertCSS(AD_COLLAPSE_CSS).catch(() => {})
  })
  // Offline / DNS failure on the main-frame load: surface it so the renderer can offer a reload
  // instead of stalling silently. ERR_ABORTED (-3) is the client's own SPA redirects, not a failure.
  psView.webContents.on('did-fail-load', (_e, errorCode, errorDesc, validatedURL, isMainFrame) => {
    if (!isMainFrame || errorCode === -3) return
    log.error(`psView failed to load ${validatedURL}: ${errorDesc} (${errorCode})`)
    psStatus.page = 'unreachable'
    pushStatus()
  })

  mainWindow.contentView.addChildView(psView)
  psView.setBounds({ x: 0, y: 0, width: 0, height: 0 })
  psView.webContents.loadURL('https://play.pokemonshowdown.com')

  mainWindow.on('closed', () => {
    mainWindow = null
    psView = null
  })
}

// ── lifecycle ─────────────────────────────────────────────────────────────────

// Single-instance lock: bring the existing window to front if a second instance is launched.
const gotLock = app.requestSingleInstanceLock()
if (!gotLock) {
  app.quit()
}
app.on('second-instance', () => {
  if (mainWindow) {
    if (mainWindow.isMinimized()) mainWindow.restore()
    mainWindow.focus()
  }
})

app.whenReady().then(async () => {
  log.info(`showdown-ui starting — electron=${process.versions.electron} node=${process.versions.node}`)
  log.info(`REPO_ROOT=${REPO_ROOT} PS_LOG_LEVEL=${process.env['PS_LOG_LEVEL'] || 'INFO'} timezone=${TIMEZONE}`)

  // saveLogs=false silently discards every battle log — make that loud at startup (was DEBUG-only).
  if (!config.saveLogs) log.warn('saveLogs=false — battle logging is DISABLED; no .txt files will be written')

  loadMovesData()

  createWindow()

  // CI launch smoke: boot exercises DATA_DIR + bundled libs + window creation, then exit 0/1.
  // Lets CI prove the packaged app *launches* (not just builds) AND that the WebSocket tap source is
  // shippable — injected.js read failures are why battle-help silently broke in the packaged .dmg.
  // The preload (electron/preload/ps.ts) reads injected.js from process.resourcesPath when packaged;
  // here DATA_DIR already resolves to that (packaged) or the repo root (dev), so it's the same file.
  // app.exit (not quit) is an immediate, deterministic exit — placed before the sweep timer.
  if (process.env['PS_SMOKE']) {
    const tapPath = join(DATA_DIR, 'helper', 'extension', 'injected.js')
    try {
      readFileSync(tapPath, 'utf8')
      log.info(`PS_SMOKE: tap source ok (${tapPath})`)
      log.info('PS_SMOKE: boot ok, exiting')
      app.exit(0)
    } catch (e: any) {
      log.error(`PS_SMOKE: tap source MISSING at ${tapPath} (${e?.message}) — battle-help would not work`)
      app.exit(1)
    }
    return
  }

  // Periodic safety sweep: evict rooms that went idle without an end frame (saved as INPROGRESS).
  // unref() so the timer never keeps the process alive on its own.
  setInterval(sweepStaleRooms, SWEEP_INTERVAL_MS).unref()

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow()
  })
})

// Flush in-flight battles on any shutdown path before the process exits.
app.on('before-quit',       () => flushAllRooms('before-quit'))
app.on('window-all-closed', () => { flushAllRooms('window-all-closed'); app.quit() })

// Crash resilience: save whatever battles are open before the renderer tears down.
app.on('render-process-gone', (_e, _wc, details) => {
  log.error(`render-process-gone: reason=${details?.reason}`)
  flushAllRooms('render-process-gone')
})

// Last-resort: flush on an otherwise-fatal error, then exit.
process.on('uncaughtException', (err) => {
  log.error(`uncaughtException: ${err?.stack}`)
  flushAllRooms('uncaughtException')
  app.exit(1)
})
