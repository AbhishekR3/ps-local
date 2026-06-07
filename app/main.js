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
const { app, BrowserWindow, session, ipcMain } = require('electron');
const path = require('node:path');
const fs = require('node:fs');
const http = require('node:http');
const { spawn } = require('node:child_process');
const { pathToFileURL } = require('node:url');
const { createLogger } = require('./logger');

const repoRoot = path.join(__dirname, '..');
const CLIENT_ROOT = path.join(repoRoot, 'vendor', 'pokemon-showdown-client', 'play.pokemonshowdown.com');
const SERVER_BIN = path.join(repoRoot, 'vendor', 'pokemon-showdown', 'pokemon-showdown');
const LOGS_DIR = path.join(repoRoot, 'logs');
const SERVER_PORT = 8000;
const CLIENT_PORT = 8080;

const log = createLogger('main');
const slog = createLogger('server');
const httpd = createLogger('static');
const wlog = createLogger('writelog');

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

// ---------------------------------------------------------------------------- helper libs / data

async function loadHelperLibs() {
  const parser = await import(pathToFileURL(path.join(repoRoot, 'helper', 'extension', 'lib', 'parser.js')).href);
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
  try {
    fs.mkdirSync(LOGS_DIR, { recursive: true });
    const mySide = state.mySide || 'p1';
    const myName = state.players?.[mySide]?.name || null;
    const oppSide = mySide === 'p1' ? 'p2' : 'p1';
    const opponent = state.players?.[oppSide]?.name || 'unknown';

    let result;
    if (!state.ended) result = 'INPROGRESS';
    else if (!state.winner) result = 'TIE';
    else if (state.winner === myName) result = 'WIN';
    else result = 'LOSS';

    const base = `${roomid}_${result}_vs_${sanitize(opponent)}_${Date.now()}`;
    const rawPath = path.join(LOGS_DIR, `${base}.raw.txt`);
    const richPath = path.join(LOGS_DIR, `${base}.txt`);

    const raw = rawFrames.join('\n');
    fs.writeFileSync(rawPath, raw);
    const rich = generateBattleLog(state, rawFrames, movesData); // synchronous
    fs.writeFileSync(richPath, rich);

    wlog.info(`wrote ${richPath} (${rich.length} B) + ${path.basename(rawPath)} (${raw.length} B)`);
  } catch (e) {
    wlog.error(`writeLog failed for ${roomid}: ${e && e.stack}`);
  }
}

function handleFrame(frameData) {
  const roomid = roomidOf(frameData);
  if (!roomid) return; // lobby / non-battle frame — nothing to accumulate

  let entry = rooms.get(roomid);
  if (!entry) {
    entry = { tracker: new BattleTracker(), rawFrames: [] };
    rooms.set(roomid, entry);
    log.info(`room opened: ${roomid}`);
  }

  entry.tracker.feed(frameData);
  entry.rawFrames.push(frameData);
  const st = entry.tracker.state;
  log.debug(`frame ${roomid} turn=${st.turn} ended=${st.ended} bytes=${frameData.length}`);

  const hasWin = /\|win\|/.test(frameData);
  const hasTie = /\|tie\|/.test(frameData);
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
    try { serverProc.kill('SIGTERM'); } catch {}
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
      contextIsolation: true,
      sandbox: false, // preload needs fs to read the tap source + reliable document_start inject
      nodeIntegration: false,
      // Do NOT set webSecurity:false — the client legitimately cross-origins to the public site
      // for any data files the local build didn't emit.
    },
  });
  const url = `http://localhost:${CLIENT_PORT}/testclient-new.html?~~localhost:${SERVER_PORT}`;
  log.info(`loading window: ${url}`);
  await mainWindow.loadURL(url);
  mainWindow.on('closed', () => { mainWindow = null; });
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

  try {
    await startStatic();
  } catch (e) {
    log.error(`static server failed to start: ${e && e.message} — aborting`);
    app.quit();
    return;
  }
  await startServer();
  await loadPanelExtension(); // before window so content scripts apply on first load
  await createWindow();
}).catch((e) => {
  log.error(`fatal during startup: ${e && e.stack}`);
  app.quit();
});

app.on('before-quit', stopServer);
app.on('window-all-closed', () => {
  stopServer();
  app.quit();
});
// Backstop: if we exit without a clean before-quit, make sure the server child dies too.
process.on('exit', () => {
  if (serverProc && !serverProc.killed) {
    try { serverProc.kill('SIGKILL'); } catch {}
  }
});
