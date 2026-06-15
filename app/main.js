// ps-local Electron main process.
//
// Responsibilities (contracts C1, C2, C3, C5, C6):
//   C1  spawn the PS server child on :8000
//   C2  serve the built client subdir on :8080 and open the window at testclient-new.html
//   C3  best-effort loadExtension(helper/extension) for the visual panel (off the logging path)
//   C5  receive tapped frames over IPC, drive BattleTracker + generateBattleLog, write logs/
//   C6  one process started by `npm start`
//
// Env flags:
//   PS_LOG_LEVEL=DEBUG   verbose (per-frame) logging
//   PS_SYNTHETIC=1        drive helper/test/fixtures/sample-battle.txt through the real ps-frame
//                         path with NO server/window/extension, then quit (the C5 decoupling proof)
//   PS_NO_EXTENSION=1     skip loadExtension (prove logging works with the panel disabled)
const { app, BrowserWindow, session, ipcMain, Menu, shell } = require('electron');
const path = require('node:path');
const fs = require('node:fs');
const http = require('node:http');
const { spawn } = require('node:child_process');
const { pathToFileURL } = require('node:url');

const repoRoot = path.join(__dirname, '..');

// User preferences live in config.json at the repo root (config.example.json is the committed
// template; config.json is gitignored). Read it BEFORE requiring the logger: logger.js resolves its
// level threshold from PS_LOG_LEVEL at import time, so config.logLevel must be promoted to the env
// here first. An explicit env var still wins, so `PS_LOG_LEVEL=DEBUG npm start` overrides the file.
let configWarning = null; // surfaced via the logger once it exists (loadConfig runs before it does)
function loadConfig(root) {
  const defaults = { timezone: 'UTC', logLevel: 'INFO', saveLogs: true };
  try {
    return { ...defaults, ...JSON.parse(fs.readFileSync(path.join(root, 'config.json'), 'utf8')) };
  } catch (e) {
    // Missing config.json is expected (first run / CI); only a malformed one is worth flagging.
    if (e.code !== 'ENOENT') configWarning = `config.json invalid (${e.message}) — using defaults`;
    return defaults;
  }
}
const config = loadConfig(repoRoot);
if (config.logLevel && !process.env.PS_LOG_LEVEL) process.env.PS_LOG_LEVEL = config.logLevel;

const { createLogger } = require('./logger');
const CLIENT_ROOT = path.join(repoRoot, 'vendor', 'pokemon-showdown-client', 'play.pokemonshowdown.com');
const SERVER_BIN = path.join(repoRoot, 'vendor', 'pokemon-showdown', 'pokemon-showdown');
const LOGS_DIR = path.join(repoRoot, 'logs', 'battle_info');
const SERVER_PORT = 8000;
const CLIENT_PORT = 8080;

// Connection mode. Default: 'official' — wrap the live play.pokemonshowdown.com client so you play
// the real ladder, and the tap auto-logs every battle. 'local' (PS_SERVER=local) is the original
// sandbox: spawn our own server on :8000 and point the bundled testclient at it.
const MODE = process.env.PS_SERVER === 'local' ? 'local' : 'official';
const OFFICIAL_URL = 'https://play.pokemonshowdown.com';
// IANA timezone for the "Generated:" timestamp in rich logs (see config.json). Default UTC.
const TIMEZONE = process.env.PS_TIMEZONE || config.timezone;

const log = createLogger('main');
const slog = createLogger('server');
const httpd = createLogger('static');
const wlog = createLogger('writelog');

if (configWarning) log.warn(configWarning);
// Loud parity with showdown-ui (index.ts): saveLogs=false silently discards every battle log, so
// warn once at startup instead of only a per-write DEBUG line.
if (!config.saveLogs) log.warn('saveLogs=false — battle logging is DISABLED; no .txt files will be written');

let serverProc = null;
let staticServer = null;
let mainWindow = null;

// ESM helper libs (pure, no extension APIs), loaded once at ready.
let BattleTracker = null;
let generateBattleLog = null;
let movesData = {};

// Per-room accumulators: roomid -> { tracker: BattleTracker, rawFrames: string[] }.
// One tracker per room: feed() auto-resets when it sees a different >battle- roomid, so a shared
// tracker would thrash across concurrent rooms.
const rooms = new Map();

// Safety valves so a battle that disconnects without an end frame can't leak forever (B3).
const STALE_ROOM_MS = 30 * 60 * 1000;     // evict rooms idle longer than this (flushed as INPROGRESS)
const MAX_FRAMES_PER_ROOM = 100000;       // hard cap on buffered frames per room
const SWEEP_INTERVAL_MS = 5 * 60 * 1000;  // how often the stale-room sweep runs

// ---------------------------------------------------------------------------- helper libs / data

async function loadHelperLibs() {
  // eslint-disable-next-line no-unsanitized/method -- Electron main process; no DOM
  const parser = await import(pathToFileURL(path.join(repoRoot, 'helper', 'extension', 'lib', 'parser.js')).href);
  // eslint-disable-next-line no-unsanitized/method -- Electron main process; no DOM
  const exporter = await import(pathToFileURL(path.join(repoRoot, 'helper', 'extension', 'lib', 'exporter.js')).href);
  BattleTracker = parser.BattleTracker;
  generateBattleLog = exporter.generateBattleLog;
  log.info('helper libs loaded (parser + exporter)');
}

function loadMovesData() {
  const p = path.join(repoRoot, 'helper', 'extension', 'data', 'moves.json');
  try {
    movesData = JSON.parse(fs.readFileSync(p, 'utf8'));
    log.info(`movesData loaded: ${Object.keys(movesData).length} moves`);
  } catch (e) {
    movesData = {};
    log.warn(`movesData not loaded (${e && e.message}); rich logs will use bare move ids`);
  }
}

// ---------------------------------------------------------------------------- log writer (C5)

function roomidOf(frame) {
  if (!frame || frame[0] !== '>') return null;
  const nl = frame.indexOf('\n');
  const firstLine = (nl === -1 ? frame.slice(1) : frame.slice(1, nl)).trim();
  const m = firstLine.match(/^battle-[a-z0-9]+-\d+/);
  return m ? m[0] : null;
}

function sanitize(name) {
  return (name || 'unknown').replace(/[^A-Za-z0-9_-]/g, '_');
}

function writeLog(roomid, state, rawFrames) {
  // saveLogs:false (config.json) disables disk writes entirely — useful for spectating/testing
  // without leaving files behind. The tracker still runs; we just skip the .txt output.
  if (!config.saveLogs) {
    wlog.debug(`saveLogs=false — skipping log write for ${roomid} (turn=${state.turn})`);
    return;
  }
  try {
    fs.mkdirSync(LOGS_DIR, { recursive: true });

    // Unified objective filename: Player 1 vs Player 2, with winner name (not you/opponent POV).
    const p1 = sanitize(state.players?.p1?.name || 'p1');
    const p2 = sanitize(state.players?.p2?.name || 'p2');
    let resultToken;
    if (!state.ended) resultToken = 'INPROGRESS';
    else if (!state.winner) resultToken = 'TIE';
    else resultToken = `WIN_${sanitize(state.winner)}`;
    const prefix = state.mySide ? '' : 'SPEC_'; // SPEC_ marks games watched as a spectator
    const base = `${roomid}_${prefix}${p1}_vs_${p2}_${resultToken}_${Date.now()}`;

    const richPath = path.join(LOGS_DIR, `${base}.txt`);

    const rich = generateBattleLog(state, rawFrames, movesData, TIMEZONE); // synchronous
    fs.writeFileSync(richPath, rich);

    wlog.info(`wrote ${richPath} (${rich.length} B)`);
  } catch (e) {
    wlog.error(`writeLog failed for ${roomid}: ${e && e.stack}`);
  }
}

// Write out every still-open room (as INPROGRESS) on an unexpected shutdown/crash so a battle in
// flight isn't lost. writeLog already emits INPROGRESS when state.ended is false.
function flushAllRooms(reason) {
  if (rooms.size === 0) return;
  wlog.warn(`flushing ${rooms.size} open room(s) on ${reason}`);
  for (const [roomid, entry] of rooms) {
    try {
      writeLog(roomid, entry.tracker.state, entry.rawFrames);
    } catch (e) {
      wlog.error(`flushAllRooms failed for ${roomid}: ${e && e.stack}`);
    }
  }
  rooms.clear();
}

// Periodic safety sweep: a battle that drops without an end frame would otherwise leak in `rooms`.
function sweepStaleRooms() {
  const now = Date.now();
  for (const [roomid, entry] of rooms) {
    if (now - entry.lastSeen > STALE_ROOM_MS) {
      wlog.warn(`evicting stale room ${roomid} (idle ${Math.round((now - entry.lastSeen) / 1000)}s, turn=${entry.tracker.state.turn})`);
      try {
        writeLog(roomid, entry.tracker.state, entry.rawFrames);
      } catch (e) {
        wlog.error(`stale flush failed for ${roomid}: ${e && e.stack}`);
      }
      rooms.delete(roomid);
    }
  }
}

function handleFrame(frameData) {
  const roomid = roomidOf(frameData);
  if (!roomid) return; // lobby / non-battle frame — nothing to accumulate

  let entry = rooms.get(roomid);
  if (!entry) {
    entry = { tracker: new BattleTracker(), rawFrames: [], lastSeen: Date.now() };
    rooms.set(roomid, entry);
    log.info(`room opened: ${roomid}`);
  }
  entry.lastSeen = Date.now();

  entry.tracker.feed(frameData);
  entry.rawFrames.push(frameData);

  // Hard cap: flush + evict a room that grows without ever ending, to bound memory.
  if (entry.rawFrames.length > MAX_FRAMES_PER_ROOM) {
    wlog.warn(`room ${roomid} exceeded ${MAX_FRAMES_PER_ROOM} frames — flushing + evicting`);
    writeLog(roomid, entry.tracker.state, entry.rawFrames);
    rooms.delete(roomid);
    return;
  }

  const st = entry.tracker.state;
  log.debug(`frame ${roomid} turn=${st.turn} ended=${st.ended} bytes=${frameData.length}`);

  const hasWin = /\|win\|/.test(frameData);
  // Line-anchored: the real tie frame is `|tie` (no trailing pipe), one line of its own. A bare
  // /\|tie\|/ never matched; /\|tie/ would false-positive on chat (`|c|user|tie game`). Mirrors
  // battleEndReason() in helper/extension/lib/logmeta.js (showdown-ui's extracted copy).
  const hasTie = /^\|tie\b/m.test(frameData);
  const hasDeinit = /\|deinit/.test(frameData);
  let reason = null;
  if (hasWin) reason = 'win';
  else if (hasTie) reason = 'tie';
  else if (hasDeinit && st.turn >= 1) reason = 'deinit';

  if (reason) {
    log.info(`flushing ${roomid} (reason=${reason}, turn=${st.turn})`);
    writeLog(roomid, st, entry.rawFrames);
    rooms.delete(roomid);
  }
}

// ---------------------------------------------------------------------------- server child (C1)

function lineSplit(stream, onLine) {
  let buf = '';
  stream.setEncoding('utf8');
  stream.on('data', (chunk) => {
    buf += chunk;
    let idx;
    while ((idx = buf.indexOf('\n')) >= 0) {
      onLine(buf.slice(0, idx));
      buf = buf.slice(idx + 1);
    }
  });
  stream.on('end', () => { if (buf) onLine(buf); });
}

function startServer() {
  return new Promise((resolve) => {
    log.info(`spawning server: ${SERVER_BIN} start ${SERVER_PORT}`);
    // process.execPath is the Electron binary; ELECTRON_RUN_AS_NODE makes it behave as plain Node
    // so the PS server entry script runs as intended (no window, correct argv).
    serverProc = spawn(process.execPath, [SERVER_BIN, 'start', String(SERVER_PORT)], {
      cwd: repoRoot,
      env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    log.info(`server pid=${serverProc.pid}`);

    let resolved = false;
    const ready = (why) => { if (!resolved) { resolved = true; log.info(`server ready (${why})`); resolve(); } };

    const onLine = (sink, line) => {
      if (!line.trim()) return;
      sink(line);
      if (/listening on|now listening|Worker .* (started|now)/i.test(line)) ready('listening line');
    };
    lineSplit(serverProc.stdout, (l) => onLine((m) => slog.info(m), l));
    lineSplit(serverProc.stderr, (l) => onLine((m) => slog.warn(m), l));

    serverProc.on('exit', (code, sig) => {
      if (code) slog.error(`server exited code=${code} signal=${sig}`);
      else slog.info(`server exited code=${code} signal=${sig}`);
    });
    serverProc.on('error', (e) => { slog.error(`server spawn error: ${e && e.message}`); ready('spawn error'); });

    // Don't block startup forever if the readiness line never matches a future PS log format.
    setTimeout(() => { if (!resolved) { log.warn('server readiness timeout (8s) — proceeding'); ready('timeout'); } }, 8000);
  });
}

function stopServer() {
  if (serverProc && !serverProc.killed) {
    log.info('stopping server (SIGTERM)');
    try { serverProc.kill('SIGTERM'); } catch { /* empty */ }
  }
}

// ---------------------------------------------------------------------------- static client (C2)

const MIME = {
  '.html': 'text/html', '.js': 'text/javascript', '.mjs': 'text/javascript', '.css': 'text/css',
  '.json': 'application/json', '.map': 'application/json', '.png': 'image/png', '.gif': 'image/gif',
  '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.svg': 'image/svg+xml', '.ico': 'image/x-icon',
  '.wav': 'audio/wav', '.mp3': 'audio/mpeg', '.ttf': 'font/ttf', '.otf': 'font/otf',
  '.woff': 'font/woff', '.woff2': 'font/woff2', '.txt': 'text/plain',
};

function startStatic() {
  return new Promise((resolve, reject) => {
    if (!fs.existsSync(CLIENT_ROOT)) {
      httpd.error(`client root missing: ${CLIENT_ROOT} — run "npm run setup" to build the client`);
      return reject(new Error('client root missing'));
    }
    staticServer = http.createServer((req, res) => {
      let urlPath;
      try {
        urlPath = decodeURIComponent((req.url || '/').split('?')[0]);
      } catch {
        res.writeHead(400); res.end('bad request'); return;
      }
      const rel = urlPath === '/' ? '/index.html' : urlPath;
      const filePath = path.resolve(CLIENT_ROOT, '.' + rel);
      // Path-traversal guard: resolved path must stay under the client root.
      if (filePath !== CLIENT_ROOT && !filePath.startsWith(CLIENT_ROOT + path.sep)) {
        httpd.warn(`403 traversal blocked: ${urlPath}`);
        res.writeHead(403); res.end('forbidden'); return;
      }
      fs.stat(filePath, (err, st) => {
        if (err || !st.isFile()) {
          // Benign here: ../config/testclient-key.js and any missing data/*.js 404 cleanly.
          httpd.debug(`404 ${req.method} ${urlPath}`);
          res.writeHead(404); res.end('not found'); return;
        }
        httpd.debug(`200 ${req.method} ${urlPath}`);
        res.writeHead(200, { 'Content-Type': MIME[path.extname(filePath).toLowerCase()] || 'application/octet-stream' });
        fs.createReadStream(filePath).pipe(res);
      });
    });
    staticServer.on('error', reject);
    staticServer.listen(CLIENT_PORT, () => {
      httpd.info(`serving ${CLIENT_ROOT} at http://localhost:${CLIENT_PORT}`);
      resolve();
    });
  });
}

// ---------------------------------------------------------------------------- window + extension

async function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1400,
    height: 900,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      // Official mode loads the live site, whose CSP blocks an injected inline <script>. With
      // contextIsolation:false the preload shares the page world and patches window.WebSocket
      // directly at document_start — CSP-immune and ahead of SockJS's load-time WebSocket capture.
      // Local mode keeps isolation on and uses the DOM-injected tap (no CSP on the testclient).
      contextIsolation: MODE === 'local',
      sandbox: false, // preload needs fs to read the tap source + reliable document_start inject
      nodeIntegration: false,
      // Tell the preload which path to take (renderer env propagation isn't reliable).
      additionalArguments: [`--ps-mode=${MODE}`],
      // Do NOT set webSecurity:false — the client legitimately cross-origins to the public site
      // for any data files the local build didn't emit.
    },
  });
  // Hardening (B4): never open in-app popups. Route external links (replays, profiles, etc.) to the
  // system browser instead of a fresh BrowserWindow. webSecurity stays on — see webPreferences above.
  mainWindow.webContents.setWindowOpenHandler(({ url: target }) => {
    if (/^https?:\/\//.test(target)) {
      shell.openExternal(target).catch((e) => log.warn(`openExternal failed: ${e && e.message}`));
    }
    return { action: 'deny' };
  });

  const url = MODE === 'local'
    ? `http://localhost:${CLIENT_PORT}/testclient-old.html?~~localhost:${SERVER_PORT}`
    : OFFICIAL_URL;
  log.info(`loading window (${MODE}): ${url}`);
  mainWindow.on('closed', () => { mainWindow = null; });

  // Official mode only: collapse any ad slot that slips past the request blocker. did-finish-load
  // fires on every navigation, so the rule is re-applied as the SPA swaps views.
  if (MODE !== 'local') {
    mainWindow.webContents.on('did-finish-load', () => {
      mainWindow.webContents.insertCSS(AD_COLLAPSE_CSS).catch((e) =>
        log.warn(`ad-collapse insertCSS failed: ${e && e.message}`));
    });
  }

  try {
    await mainWindow.loadURL(url);
  } catch (e) {
    // A transient navigation failure (network blip, or the live site aborting the initial load) must
    // NOT kill the app — keep the window open and retry once so a flaky first load self-heals.
    log.warn(`initial loadURL failed (${e && e.message}); retrying once`);
    mainWindow.loadURL(url).catch((e2) => log.error(`reload after failed load also failed: ${e2 && e2.message}`));
  }
}

async function loadPanelExtension() {
  if (process.env.PS_NO_EXTENSION === '1') {
    log.warn('PS_NO_EXTENSION=1 — skipping loadExtension (C5 decoupling check)');
    return;
  }
  try {
    const ext = await session.defaultSession.loadExtension(
      path.join(repoRoot, 'helper', 'extension'),
      { allowFileAccess: true },
    );
    log.info(`loaded panel extension: ${ext.name} v${ext.version}`);
  } catch (e) {
    // Best-effort: the panel is cosmetic (C3). Logging (C5) is independent.
    log.warn(`loadExtension failed; panel unavailable (logging unaffected): ${e && e.message}`);
  }
}

// ---------------------------------------------------------------------------- ad / analytics block
//
// Official mode wraps the LIVE play.pokemonshowdown.com client, which loads Google ad/analytics and
// the Playwire video-ad stack. PS is MIT, so blocking ads is permitted; we cancel the requests at
// the session layer so the ad partners' servers are never even contacted (privacy + no PII leak).
// The bundled local client has no ad code, so this is gated to official mode (a no-op there anyway).
//
// IMPORTANT: this list MUST NOT match play.pokemonshowdown.com, *.pokemonshowdown.com (asset/data
// CDN fallbacks), sim*.psim.us (battle websockets), or action.php (login). Keep this list in sync
// with showdown-ui/electron/main/index.ts (AD_ANALYTICS_PATTERNS).
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
  '*://*.adnxs.com/*',              // Xandr / AppNexus
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
  '*://*.onetag.com/*',              // OneTag SSP (also onetag-sys.com)
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
];

// Cosmetic cleanup: collapse any ad slot container that slips past the request blocker so no empty
// gap remains. insertCSS is a Chromium user stylesheet (CSP-immune, same reasoning as the preload's
// official-mode WebSocket patch) and applies to dynamically-inserted nodes too.
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
`;

function installAdBlock(targetSession) {
  targetSession.webRequest.onBeforeRequest({ urls: AD_ANALYTICS_PATTERNS }, (details, cb) => {
    log.debug(`adblock cancel: ${details.url}`);
    cb({ cancel: true });
  });
  log.info(`ad/analytics block installed (${AD_ANALYTICS_PATTERNS.length} patterns)`);
}

// ---------------------------------------------------------------------------- menu

function buildMenu() {
  const isMac = process.platform === 'darwin';
  const template = [
    ...(isMac ? [{ role: 'appMenu' }] : []),
    { role: 'fileMenu' },
    { role: 'editMenu' },
    {
      label: 'View',
      submenu: [
        { role: 'reload' },
        { role: 'forceReload' },
        { role: 'toggleDevTools' },
        { type: 'separator' },
        { role: 'resetZoom' },
        { role: 'zoomIn' },
        { role: 'zoomOut' },
        { type: 'separator' },
        { role: 'togglefullscreen' },
        { type: 'separator' },
        {
          label: 'Toggle Helper Panel',
          accelerator: 'CmdOrCtrl+Shift+H',
          click: () => {
            mainWindow?.webContents
              .executeJavaScript("window.postMessage({type:'ps-toggle-panel'},'*')")
              .catch(() => {});
          },
        },
      ],
    },
    { role: 'windowMenu' },
  ];
  Menu.setApplicationMenu(Menu.buildFromTemplate(template));
}

// ---------------------------------------------------------------------------- synthetic C5 proof

function runSynthetic() {
  const fixture = path.join(repoRoot, 'helper', 'test', 'fixtures', 'sample-battle.txt');
  log.info(`PS_SYNTHETIC=1 — driving ${fixture} through the real ps-frame path`);
  let text;
  try {
    text = fs.readFileSync(fixture, 'utf8').replace(/\r/g, '');
  } catch (e) {
    log.error(`synthetic fixture missing: ${e && e.message}`);
    return;
  }
  // The fixture is a flat protocol dump for one room; feed it as a single room-scoped frame,
  // exactly as the ps-frame handler receives a decoded SockJS battle frame.
  handleFrame(text);
  log.info('synthetic feed complete');
}

// ---------------------------------------------------------------------------- IPC

ipcMain.on('ps-frame', (_e, payload) => {
  if (!BattleTracker || !payload || typeof payload.data !== 'string') return;
  try {
    handleFrame(payload.data);
  } catch (e) {
    log.error(`handleFrame error: ${e && e.stack}`); // never let a bad frame crash the app
  }
});

const nsLoggers = new Map();
ipcMain.on('ps-log', (_e, m) => {
  const ns = (m && m.ns) || 'preload';
  if (!nsLoggers.has(ns)) nsLoggers.set(ns, createLogger(ns));
  const l = nsLoggers.get(ns);
  (l[(m && m.level || 'info').toLowerCase()] || l.info)(m && m.msg);
});

// ---------------------------------------------------------------------------- lifecycle

// Single-instance lock (B1, seeds 2H). Skip in synthetic mode so CI/deep-test and concurrent
// synthetic runs aren't blocked by an already-running interactive instance. Calling app.quit()
// before 'ready' prevents startup, so the second instance never spawns a server or window.
const gotSingleInstanceLock = process.env.PS_SYNTHETIC === '1' || app.requestSingleInstanceLock();
if (!gotSingleInstanceLock) {
  log.warn('another ps-local instance is already running — quitting this one');
  app.quit();
}
app.on('second-instance', () => {
  if (mainWindow) {
    if (mainWindow.isMinimized()) mainWindow.restore();
    mainWindow.focus();
  }
});

app.whenReady().then(async () => {
  log.info(`ps-local starting — electron=${process.versions.electron} node=${process.versions.node} chromium=${process.versions.chrome}`);
  log.info(`repoRoot=${repoRoot} PS_LOG_LEVEL=${process.env.PS_LOG_LEVEL || 'INFO'}`);

  await loadHelperLibs();
  loadMovesData();

  // Decoupling proof: the entire log path runs with no server, no window, no extension.
  if (process.env.PS_SYNTHETIC === '1') {
    runSynthetic();
    log.info('synthetic mode done — quitting');
    setTimeout(() => app.quit(), 200);
    return;
  }

  // Local sandbox only: spawn our own server + serve the bundled client. Official mode skips both
  // and connects the live client straight to the real ladder.
  if (MODE === 'local') {
    try {
      await startStatic();
    } catch (e) {
      log.error(`static server failed to start: ${e && e.message} — aborting`);
      app.quit();
      return;
    }
    await startServer();
  } else {
    log.info('official mode — connecting to the live PS ladder (no local server/static)');
    // Block ads/analytics on the default session before the window's first loadURL.
    installAdBlock(session.defaultSession);
  }
  await loadPanelExtension(); // before window so content scripts apply on first load
  await createWindow();
  buildMenu();

  // Periodic safety sweep: evict rooms that went idle without an end frame (flushed as INPROGRESS).
  // unref() so the timer never keeps the process alive on its own.
  setInterval(sweepStaleRooms, SWEEP_INTERVAL_MS).unref();
}).catch((e) => {
  log.error(`fatal during startup: ${e && e.stack}`);
  app.quit();
});

// On any shutdown path, persist in-flight battles (B2) and reap the server child.
app.on('before-quit', () => { flushAllRooms('before-quit'); stopServer(); });
app.on('window-all-closed', () => {
  stopServer();
  app.quit();
});

// Crash resilience (B2): save whatever battles are open before the renderer/child tears down.
app.on('render-process-gone', (_e, _wc, details) => {
  log.error(`render-process-gone: reason=${details && details.reason}`);
  flushAllRooms('render-process-gone');
});
app.on('child-process-gone', (_e, details) => {
  log.error(`child-process-gone: type=${details && details.type} reason=${details && details.reason}`);
});

// Last-resort: flush logs on an otherwise-fatal error, then exit (don't swallow indefinitely).
process.on('uncaughtException', (err) => {
  log.error(`uncaughtException: ${err && err.stack}`);
  flushAllRooms('uncaughtException');
  app.exit(1);
});

// Backstop: if we exit without a clean before-quit, make sure the server child dies too.
process.on('exit', () => {
  if (serverProc && !serverProc.killed) {
    try { serverProc.kill('SIGKILL'); } catch { /* empty */ }
  }
});
