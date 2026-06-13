"use strict";
const { ipcRenderer } = require("electron");
const fs = require("node:fs");
const path = require("node:path");
const tapSrc = (() => {
  try {
    return fs.readFileSync(
      path.join(__dirname, "../../..", "helper", "extension", "injected.js"),
      "utf8"
    );
  } catch (e) {
    console.error("[ps-preload] cannot read tap source:", e.message);
    return null;
  }
})();
if (tapSrc) {
  try {
    new Function(tapSrc)();
  } catch (e) {
    console.error("[ps-preload] tap install failed:", e.message);
  }
}
window.addEventListener("message", (event) => {
  if (event.source !== window) return;
  const m = event.data;
  if (!m || m.__psHelper !== true || typeof m.data !== "string") return;
  ipcRenderer.send("ps-frame", { data: m.data });
});
let _relayMove = null;
let _relayUp = null;
ipcRenderer.on("start-drag-relay", () => {
  _relayMove = (e) => ipcRenderer.send("ps-drag-move", { screenX: e.screenX });
  _relayUp = () => {
    document.removeEventListener("mousemove", _relayMove);
    document.removeEventListener("mouseup", _relayUp);
    _relayMove = null;
    _relayUp = null;
    ipcRenderer.send("ps-drag-end");
  };
  document.addEventListener("mousemove", _relayMove);
  document.addEventListener("mouseup", _relayUp);
});
ipcRenderer.on("stop-drag-relay", () => {
  if (_relayMove) document.removeEventListener("mousemove", _relayMove);
  if (_relayUp) document.removeEventListener("mouseup", _relayUp);
  _relayMove = null;
  _relayUp = null;
});
