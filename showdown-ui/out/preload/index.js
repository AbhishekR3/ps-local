"use strict";
const electron = require("electron");
electron.contextBridge.exposeInMainWorld("psUI", {
  version: "0.1.0",
  onFrame: (cb) => {
    electron.ipcRenderer.on("ps-frame", (_event, payload) => cb(payload));
  },
  offFrame: () => {
    electron.ipcRenderer.removeAllListeners("ps-frame");
  },
  // Replay buffered frames for the most-recently-active room — called on mount so a battle
  // whose init frames preceded the renderer is reconstructed instead of lost.
  getBuffer: () => electron.ipcRenderer.invoke("get-buffer"),
  setGameBounds: (rect) => {
    electron.ipcRenderer.send("set-game-bounds", rect);
  },
  beginResize: () => electron.ipcRenderer.send("begin-resize"),
  endResize: () => electron.ipcRenderer.send("end-resize"),
  // Called when the mouse is over the PS view during a drag; main relays the
  // cursor x from the psView preload so the renderer can update helperWidth
  // without hiding the view. Returns an unsubscribe function.
  onResizeDrag: (cb) => {
    const handler = (_e, { x }) => cb(x);
    electron.ipcRenderer.on("resize-drag", handler);
    return () => electron.ipcRenderer.removeListener("resize-drag", handler);
  },
  // Fired by main when mouseup was caught in the PS view (not the renderer).
  onResizeDragEnd: (cb) => {
    const handler = () => cb();
    electron.ipcRenderer.on("resize-drag-end", handler);
    return () => electron.ipcRenderer.removeListener("resize-drag-end", handler);
  },
  // Header actions: open the project repo in the system browser, or the battle-log folder in Finder.
  openExternal: (url) => electron.ipcRenderer.send("open-external", url),
  openLogs: () => electron.ipcRenderer.send("open-logs")
});
