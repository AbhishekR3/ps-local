"use strict";
const electron = require("electron");
const path = require("path");
const fs = require("fs");
const url = require("url");
const REPO_ROOT = path.join(__dirname, "..", "..", "..");
const LOGS_DIR = path.join(REPO_ROOT, "logs", "battle_info");
const REPO_URL = "https://github.com/AbhishekR3/ps-local";
let _configWarning = null;
function loadConfig() {
  const defaults = { timezone: "UTC", logLevel: "INFO", saveLogs: true };
  try {
    return { ...defaults, ...JSON.parse(fs.readFileSync(path.join(REPO_ROOT, "config.json"), "utf8")) };
  } catch (e) {
    if (e.code !== "ENOENT") _configWarning = `config.json invalid (${e.message}) — using defaults`;
    return defaults;
  }
}
const config = loadConfig();
if (config.logLevel && !process.env["PS_LOG_LEVEL"]) process.env["PS_LOG_LEVEL"] = config.logLevel;
const TIMEZONE = process.env["PS_TIMEZONE"] || config.timezone;
const LOG_LEVELS = { DEBUG: 10, INFO: 20, WARN: 30, ERROR: 40 };
const LOG_THRESHOLD = LOG_LEVELS[(process.env["PS_LOG_LEVEL"] || "INFO").toUpperCase()] ?? LOG_LEVELS["INFO"];
let _logFile = null;
function logFile() {
  if (_logFile) return _logFile;
  fs.mkdirSync(path.join(REPO_ROOT, "logs", "debug"), { recursive: true });
  const ts = (/* @__PURE__ */ new Date()).toISOString().replace(/[:.]/g, "-");
  _logFile = path.join(REPO_ROOT, "logs", "debug", `showdown-ui-${ts}.log`);
  return _logFile;
}
function logEmit(level, ns, msg) {
  if ((LOG_LEVELS[level] ?? 0) < LOG_THRESHOLD) return;
  const line = `${(/* @__PURE__ */ new Date()).toISOString()} [${level.padEnd(5)}] [${ns}] ${msg}`;
  (level === "WARN" || level === "ERROR" ? console.error : console.log)(line);
  try {
    fs.appendFileSync(logFile(), line + "\n");
  } catch {
  }
}
function createLogger(ns) {
  return {
    debug: (m) => logEmit("DEBUG", ns, m),
    info: (m) => logEmit("INFO", ns, m),
    warn: (m) => logEmit("WARN", ns, m),
    error: (m) => logEmit("ERROR", ns, m)
  };
}
const log = createLogger("ui-main");
const wlog = createLogger("ui-wlog");
if (_configWarning) log.warn(_configWarning);
let BattleTracker = null;
let generateBattleLog = null;
let movesData = {};
async function loadHelperLibs() {
  const parser = await import(url.pathToFileURL(path.join(REPO_ROOT, "helper", "extension", "lib", "parser.js")).href);
  const exporter = await import(url.pathToFileURL(path.join(REPO_ROOT, "helper", "extension", "lib", "exporter.js")).href);
  BattleTracker = parser.BattleTracker;
  generateBattleLog = exporter.generateBattleLog;
  log.info("helper libs loaded (parser + exporter)");
}
function loadMovesData() {
  const p = path.join(REPO_ROOT, "helper", "extension", "data", "moves.json");
  try {
    movesData = JSON.parse(fs.readFileSync(p, "utf8"));
    log.info(`movesData loaded: ${Object.keys(movesData).length} moves`);
  } catch (e) {
    movesData = {};
    log.warn(`movesData not loaded (${e?.message}); rich logs will use bare move ids`);
  }
}
const rooms = /* @__PURE__ */ new Map();
const STALE_ROOM_MS = 30 * 60 * 1e3;
const MAX_FRAMES_PER_ROOM = 1e5;
const SWEEP_INTERVAL_MS = 5 * 60 * 1e3;
function roomidOf(frame) {
  if (!frame || frame[0] !== ">") return null;
  const nl = frame.indexOf("\n");
  const firstLine = (nl === -1 ? frame.slice(1) : frame.slice(1, nl)).trim();
  const m = firstLine.match(/^battle-[a-z0-9]+-\d+/);
  return m ? m[0] : null;
}
function sanitize(name) {
  return (name || "unknown").replace(/[^A-Za-z0-9_-]/g, "_");
}
function writeLog(roomid, state, rawFrames) {
  if (!config.saveLogs) {
    wlog.debug(`saveLogs=false — skipping log write for ${roomid} (turn=${state.turn})`);
    return;
  }
  if (!generateBattleLog) {
    wlog.warn(`generateBattleLog not loaded yet — skipping write for ${roomid}`);
    return;
  }
  try {
    fs.mkdirSync(LOGS_DIR, { recursive: true });
    const p1 = sanitize(state.players?.p1?.name);
    const p2 = sanitize(state.players?.p2?.name);
    let resultToken;
    if (!state.ended) resultToken = "INPROGRESS";
    else if (!state.winner) resultToken = "TIE";
    else resultToken = `WIN_${sanitize(state.winner)}`;
    const prefix = state.mySide ? "" : "SPEC_";
    const base = `${roomid}_${prefix}${p1}_vs_${p2}_${resultToken}_${Date.now()}`;
    const rawPath = path.join(LOGS_DIR, `${base}.raw.txt`);
    const richPath = path.join(LOGS_DIR, `${base}.txt`);
    const raw = rawFrames.join("\n");
    fs.writeFileSync(rawPath, raw);
    const rich = generateBattleLog(state, rawFrames, movesData, TIMEZONE);
    fs.writeFileSync(richPath, rich);
    wlog.info(`wrote ${richPath} (${rich.length} B) + ${base}.raw.txt (${raw.length} B)`);
  } catch (e) {
    wlog.error(`writeLog failed for ${roomid}: ${e?.stack}`);
  }
}
function flushAllRooms(reason) {
  if (rooms.size === 0) return;
  wlog.warn(`flushing ${rooms.size} open room(s) on ${reason}`);
  for (const [roomid, entry] of rooms) {
    try {
      writeLog(roomid, entry.tracker.state, entry.rawFrames);
    } catch (e) {
      wlog.error(`flushAllRooms failed for ${roomid}: ${e?.stack}`);
    }
  }
  rooms.clear();
}
function sweepStaleRooms() {
  const now = Date.now();
  for (const [roomid, entry] of rooms) {
    if (now - entry.lastSeen > STALE_ROOM_MS) {
      wlog.warn(`evicting stale room ${roomid} (idle ${Math.round((now - entry.lastSeen) / 1e3)}s, turn=${entry.tracker.state.turn})`);
      try {
        writeLog(roomid, entry.tracker.state, entry.rawFrames);
      } catch (e) {
        wlog.error(`stale flush failed for ${roomid}: ${e?.stack}`);
      }
      rooms.delete(roomid);
    }
  }
}
function handleFrame(frameData) {
  if (!BattleTracker) return;
  const roomid = roomidOf(frameData);
  if (!roomid) return;
  let entry = rooms.get(roomid);
  if (!entry) {
    entry = { tracker: new BattleTracker(), rawFrames: [], lastSeen: Date.now() };
    rooms.set(roomid, entry);
    log.info(`room opened: ${roomid}`);
  }
  entry.lastSeen = Date.now();
  entry.tracker.feed(frameData);
  entry.rawFrames.push(frameData);
  if (entry.rawFrames.length > MAX_FRAMES_PER_ROOM) {
    wlog.warn(`room ${roomid} exceeded ${MAX_FRAMES_PER_ROOM} frames — flushing + evicting`);
    writeLog(roomid, entry.tracker.state, entry.rawFrames);
    rooms.delete(roomid);
    return;
  }
  const st = entry.tracker.state;
  log.debug(`frame ${roomid} turn=${st.turn} ended=${st.ended} bytes=${frameData.length}`);
  const hasWin = /\|win\|/.test(frameData);
  const hasTie = /\|tie\|/.test(frameData);
  const hasDeinit = /\|deinit/.test(frameData);
  let reason = null;
  if (hasWin) reason = "win";
  else if (hasTie) reason = "tie";
  else if (hasDeinit && st.turn >= 1) reason = "deinit";
  if (reason) {
    log.info(`flushing ${roomid} (reason=${reason}, turn=${st.turn})`);
    writeLog(roomid, st, entry.rawFrames);
    rooms.delete(roomid);
  }
}
electron.ipcMain.on("open-external", (_event, url2) => {
  const target = typeof url2 === "string" && /^https?:\/\//.test(url2) ? url2 : REPO_URL;
  electron.shell.openExternal(target);
});
electron.ipcMain.on("open-logs", () => {
  electron.shell.openPath(fs.existsSync(LOGS_DIR) ? LOGS_DIR : REPO_ROOT);
});
const MAX_FRAMES = 2e3;
const MAX_ROOMS = 6;
const buffers = /* @__PURE__ */ new Map();
function roomOf(frame) {
  const first = frame.split("\n", 1)[0];
  if (first.startsWith(">")) {
    const m = first.slice(1).trim().match(/^battle-[a-z0-9]+-\d+/);
    if (m) return m[0];
  }
  return null;
}
function bufferFrame(data) {
  const room = roomOf(data);
  if (!room) return;
  let buf = buffers.get(room);
  if (!buf) {
    buf = [];
    buffers.set(room, buf);
    while (buffers.size > MAX_ROOMS) buffers.delete(buffers.keys().next().value);
  }
  buf.push(data);
  if (buf.length > MAX_FRAMES) buf.shift();
}
electron.ipcMain.on("ps-frame", (_event, payload) => {
  if (typeof payload?.data !== "string") return;
  bufferFrame(payload.data);
  try {
    handleFrame(payload.data);
  } catch (e) {
    log.error(`handleFrame error: ${e?.stack}`);
  }
  if (!mainWindow || mainWindow.webContents.isLoading()) {
    const room = roomOf(payload.data);
    if (room) log.debug(`frame for ${room} arrived before renderer ready — buffered (live send skipped)`);
  }
  mainWindow?.webContents.send("ps-frame", payload);
});
electron.ipcMain.handle("get-buffer", () => {
  const roomList = [...buffers.keys()];
  const room = roomList[roomList.length - 1] || null;
  const frames = room && buffers.get(room) || [];
  log.info(`get-buffer room=${room} → ${frames.length} frames`);
  return { frames, room };
});
let mainWindow = null;
let psView = null;
let isDragging = false;
electron.ipcMain.on("set-game-bounds", (_event, rect) => {
  if (!psView) return;
  psView.setBounds({
    x: Math.round(rect.x),
    y: Math.round(rect.y),
    width: Math.round(rect.width),
    height: Math.round(rect.height)
  });
});
electron.ipcMain.on("begin-resize", () => {
  isDragging = true;
  psView?.webContents.send("start-drag-relay");
});
electron.ipcMain.on("end-resize", () => {
  isDragging = false;
  psView?.webContents.send("stop-drag-relay");
});
electron.ipcMain.on("ps-drag-move", (_event, { screenX }) => {
  if (!isDragging || !mainWindow) return;
  const { x } = mainWindow.getContentBounds();
  mainWindow.webContents.send("resize-drag", { x: screenX - x });
});
electron.ipcMain.on("ps-drag-end", () => {
  if (!isDragging) return;
  isDragging = false;
  mainWindow?.webContents.send("resize-drag-end");
});
const AD_ANALYTICS_PATTERNS = [
  // ── Venatus / PS ad orchestrator ─────────────────────────────────────────
  // hb.vntsm.com is THE entry point: one <script> in the live PS page that
  // bootstraps every prebid partner below. Blocking it alone kills the whole
  // ad stack; the rest are belt-and-suspenders for anything loaded separately.
  "*://*.vntsm.com/*",
  // Venatus Media orchestrator (hb.vntsm.com, cdn1.vntsm.com, …)
  "*://*.venatus.com/*",
  // Venatus first-party domain
  "*://*.venatusmedia.com/*",
  // ── Google ad / analytics stack ──────────────────────────────────────────
  "*://*.doubleclick.net/*",
  "*://*.googlesyndication.com/*",
  "*://*.googletagservices.com/*",
  "*://*.googletagmanager.com/*",
  "*://*.googleadservices.com/*",
  "*://*.google-analytics.com/*",
  "*://*.googleanalytics.com/*",
  "*://*.analytics.google.com/*",
  "*://adservice.google.com/*",
  // ── Microsoft / Bing ads ─────────────────────────────────────────────────
  "*://*.bat.bing.com/*",
  // Microsoft UET / Bing Ads conversion pixel
  "*://bat.bing.com/*",
  "*://*.clarity.ms/*",
  // Microsoft Clarity analytics/heatmap
  "*://ads.microsoft.com/*",
  // ── Prebid bidders loaded by Venatus ─────────────────────────────────────
  "*://*.amazon-adsystem.com/*",
  // Amazon A9 / TAM
  "*://*.adsrvr.org/*",
  // The Trade Desk
  "*://*.adnxs.com/*",
  // Xandr / AppNexus
  "*://*.criteo.com/*",
  "*://*.rubiconproject.com/*",
  // Magnite / Rubicon
  "*://*.sharethrough.com/*",
  "*://*.pubmatic.com/*",
  "*://*.openx.net/*",
  "*://*.openx.com/*",
  "*://*.sovrn.com/*",
  "*://*.lijit.com/*",
  // Sovrn legacy domain
  "*://*.triplelift.com/*",
  "*://*.richaudience.com/*",
  "*://*.id5-sync.com/*",
  // ID5 universal ID
  "*://*.liadm.com/*",
  // LiveRamp / IdentityLink
  "*://*.aniview.com/*",
  // Aniview video ads
  "*://*.4dvertible.com/*",
  // 4D programmatic
  "*://*.bids.ws/*",
  // Venatus bidder endpoint (a.bids.ws)
  "*://*.smartadserver.com/*",
  // Smart AdServer
  "*://*.rapidedge.io/*",
  // RapidEdge audience
  "*://*.brandmetrics.com/*",
  // Brandmetrics brand-lift
  "*://*.kargo.com/*",
  "*://*.yieldmo.com/*",
  "*://*.seedtag.com/*",
  "*://*.onetag.com/*",
  // OneTag SSP
  "*://*.onetag-sys.com/*",
  // ── Other ad/analytics nets seen in practice ─────────────────────────────
  "*://*.moatads.com/*",
  "*://*.scorecardresearch.com/*",
  "*://*.tapad.com/*",
  "*://*.cpx.to/*",
  "*://*.a-mo.net/*",
  // Adform DSP
  // ── Legacy Playwire domains (pre-Venatus) ────────────────────────────────
  "*://*.intunl.com/*",
  "*://video-player.playwire.com/*",
  "*://*.playwire.com/*",
  "*://*.intergient.com/*",
  "*://*.pwshowdown.com/*"
];
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
  targetSession.webRequest.onBeforeRequest({ urls: AD_ANALYTICS_PATTERNS }, (_details, cb) => {
    cb({ cancel: true });
  });
}
function createWindow() {
  mainWindow = new electron.BrowserWindow({
    width: 1800,
    height: 900,
    backgroundColor: "#1a1a2e",
    title: "PS Local — Helper",
    webPreferences: {
      preload: path.join(__dirname, "../preload/index.js"),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false
    }
  });
  if (process.env["ELECTRON_RENDERER_URL"]) {
    mainWindow.loadURL(process.env["ELECTRON_RENDERER_URL"]);
  } else {
    mainWindow.loadFile(path.join(__dirname, "../renderer/index.html"));
  }
  psView = new electron.WebContentsView({
    webPreferences: {
      preload: path.join(__dirname, "../preload/ps.js"),
      contextIsolation: false,
      nodeIntegration: false,
      sandbox: false,
      partition: "persist:showdown-ui"
    }
  });
  installAdBlock(electron.session.fromPartition("persist:showdown-ui"));
  psView.webContents.on("did-finish-load", () => {
    psView?.webContents.insertCSS(AD_COLLAPSE_CSS).catch(() => {
    });
  });
  mainWindow.contentView.addChildView(psView);
  psView.setBounds({ x: 0, y: 0, width: 0, height: 0 });
  psView.webContents.loadURL("https://play.pokemonshowdown.com");
  mainWindow.on("closed", () => {
    mainWindow = null;
    psView = null;
  });
}
const gotLock = electron.app.requestSingleInstanceLock();
if (!gotLock) {
  electron.app.quit();
}
electron.app.on("second-instance", () => {
  if (mainWindow) {
    if (mainWindow.isMinimized()) mainWindow.restore();
    mainWindow.focus();
  }
});
electron.app.whenReady().then(async () => {
  log.info(`showdown-ui starting — electron=${process.versions.electron} node=${process.versions.node}`);
  log.info(`REPO_ROOT=${REPO_ROOT} PS_LOG_LEVEL=${process.env["PS_LOG_LEVEL"] || "INFO"} timezone=${TIMEZONE}`);
  await loadHelperLibs();
  loadMovesData();
  createWindow();
  setInterval(sweepStaleRooms, SWEEP_INTERVAL_MS).unref();
  electron.app.on("activate", () => {
    if (electron.BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});
electron.app.on("before-quit", () => flushAllRooms("before-quit"));
electron.app.on("window-all-closed", () => {
  flushAllRooms("window-all-closed");
  electron.app.quit();
});
electron.app.on("render-process-gone", (_e, _wc, details) => {
  log.error(`render-process-gone: reason=${details?.reason}`);
  flushAllRooms("render-process-gone");
});
process.on("uncaughtException", (err) => {
  log.error(`uncaughtException: ${err?.stack}`);
  flushAllRooms("uncaughtException");
  electron.app.exit(1);
});
