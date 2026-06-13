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
electron.ipcMain.on("ps-frame", (_event, payload) => {
  if (typeof payload?.data !== "string") return;
  mainWindow?.webContents.send("ps-frame", payload);
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
