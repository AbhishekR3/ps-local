"use strict";
const electron = require("electron");
const path = require("path");
const fs = require("fs");
const REPO_ROOT = path.join(__dirname, "..", "..", "..");
const LOGS_DIR = path.join(REPO_ROOT, "logs", "battle_info");
const REPO_URL = "https://github.com/AbhishekR3/ps-local";
electron.ipcMain.on("open-external", (_event, url) => {
  const target = typeof url === "string" && /^https?:\/\//.test(url) ? url : REPO_URL;
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
  if (!mainWindow || mainWindow.webContents.isLoading()) {
    const room = roomOf(payload.data);
    if (room) console.log("[PSH ui-main] frame for " + room + " arrived before renderer ready — buffered (live send skipped)");
  }
  mainWindow?.webContents.send("ps-frame", payload);
});
electron.ipcMain.handle("get-buffer", () => {
  const rooms = [...buffers.keys()];
  const room = rooms[rooms.length - 1] || null;
  const frames = room && buffers.get(room) || [];
  console.log("[PSH ui-main] get-buffer room=" + room + " → " + frames.length + " frames (rooms=[" + rooms.join(", ") + "])");
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
electron.app.whenReady().then(() => {
  createWindow();
  electron.app.on("activate", () => {
    if (electron.BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});
electron.app.on("window-all-closed", () => {
  electron.app.quit();
});
