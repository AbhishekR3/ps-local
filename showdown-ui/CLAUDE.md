# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this is

A standalone Electron + React + TypeScript app (`electron-vite`) that is the **intended replacement for `../app/`**. It provides a native, docked battle helper alongside the live PS client in one window, and as of the C5 port it also writes the same rich battle logs that `../app/` produced. It imports shared pure libs from `../helper/extension/lib/` and JSON from `../helper/extension/data/`.

`../app/` remains in the repo as a fallback but is no longer the primary app.

## Commands

```bash
npm run dev      # electron-vite dev (hot-reload for renderer; restarts main/preload on change)
npm run build    # production build → out/
npm run preview  # preview the production build
```

Run from this directory (`showdown-ui/`). No test suite yet.

## Architecture

### Window layout
Two Electron surfaces share one native window:
- **`mainWindow` (BrowserWindow)** — hosts the React helper panel (right side). Uses `contextIsolation:true`, preload `electron/preload/index.ts`.
- **`psView` (WebContentsView)** — overlays the left region with the live `play.pokemonshowdown.com` client. Uses `contextIsolation:false` (required for the WebSocket tap) and `partition:'persist:showdown-ui'` (login persistence). Preload `electron/preload/ps.ts`.

`psView` has no fixed bounds at creation; the renderer measures its `gameRef` container and sends `set-game-bounds` so main can call `psView.setBounds()`.

### IPC channels

| Channel | Direction | Purpose |
|---|---|---|
| `ps-frame` | psView preload → main → helper renderer | Battle frame relay + log writer input |
| `get-buffer` | renderer → main (invoke) | Replay buffered frames on mount |
| `set-game-bounds` | renderer → main | Positions psView over the game container |
| `begin-resize` / `end-resize` | renderer → main | Toggles drag-relay mode |
| `ps-drag-move` | psView preload → main | Cursor X while divider is dragged over psView |
| `ps-drag-end` | psView preload → main | Drag ended while cursor was over psView |
| `resize-drag` / `resize-drag-end` | main → renderer | Forwards drag position to renderer |
| `open-external` | renderer → main | Opens http(s) URL in system browser |
| `open-logs` | renderer → main | Opens `logs/battle_info/` in Finder |

The psView is **never hidden** during divider drags (hiding blanks the screen). Instead the preload relays `mousemove`/`mouseup` through IPC so the resize animation stays smooth.

### Data flow
```
psView WebSocket → injected.js tap → postMessage → ps.ts preload
  → ipcRenderer.send('ps-frame') → main → ipcMain relay
  → mainWindow.webContents.send('ps-frame') → index.ts preload
  → window.psUI.onFrame() → HelperPanel.tsx → BattleTracker.feed()
  → renderBattle() → dangerouslySetInnerHTML
```

`HelperPanel.tsx` coalesces rapid frame bursts with `requestAnimationFrame` — one DOM update per 16 ms max.

### Cross-repo imports
The renderer imports directly from the parent repo (allowed via `server.fs.allow: ['..']` in `electron.vite.config.ts` and `allowJs: true` in `tsconfig.web.json`):
- `../helper/extension/lib/parser.js` — `BattleTracker` class
- `../helper/extension/lib/lookup.js` — set/stat lookup
- `../helper/extension/data/**/*.json` — format data (loaded lazily via `import.meta.glob`)

### Render contract (showdown-ui is canonical; panel.js is frozen)
`src/lib/render.ts` originated as a TypeScript port of `../helper/extension/panel.js`'s HTML builders, and `src/styles/global.css` ports `panel.css`. **As of the 12-item improvement pass, showdown-ui is the canonical helper UI and the extension's `panel.js`/`panel.css` are frozen-legacy.** `render.ts` is therefore allowed to diverge from `panel.js`, and several features are intentionally showdown-ui-only:
- no level (`Lxx`) label on cards (item 11),
- opponent-HP% (+ status) shown on the active opponent card (item 10),
- a one-line ability description under revealed abilities + tooltips on predicted-ability pills (item 8),
- the "1 sets left" badge suppressed when only one set remains (item 1).

Do **not** "fix" these back toward `panel.js`. Pure data-layer changes still belong in the shared `../helper/extension/lib` so both surfaces benefit (e.g. `lookup.js` largest-remainder percentages and the cosmetic-forme `baseSpecies` fallback). When adding a *new* helper-UI feature, build it here; mirroring into `panel.js` is optional and not required.

### Build entry points
`electron.vite.config.ts` must declare all three entries explicitly (electron-vite 2.x doesn't auto-detect outside `src/`):
- Main: `electron/main/index.ts`
- Preload: `electron/preload/index.ts` + `electron/preload/ps.ts`
- Renderer: `index.html` with relative `./src/main.tsx` script src

### Battle log writing (C5 — ported from `../app/main.js`)
`electron/main/index.ts` now drives the full C5 log path, identical in contract to `../app/main.js`:
- Per-room `rooms` map (one `BattleTracker` + raw frame buffer each). Keyed separately from the display `buffers` map.
- `handleFrame()` called on every `ps-frame` IPC message; detects `|win|`, `|tie|`, `|deinit|` to flush.
- `writeLog()` writes `<roomid>_{prefix}<p1>_vs_<p2>_{result}_{ts}.{txt,raw.txt}` to `../logs/battle_info/`.
- SPEC_ prefix for spectator games (`state.mySide === null`).
- `config.saveLogs = false` suppresses disk writes (tracker still runs).
- `flushAllRooms()` wired into `before-quit`, `window-all-closed`, `render-process-gone`, `uncaughtException`.
- Stale-room sweep every 5 min; evict after 30 min idle (saved as INPROGRESS).
- Hard frame cap: 100,000 frames/room; flushes + evicts on overflow.

**Tradeoff vs `../app/main.js`**: `../app/` had `PS_SYNTHETIC=1` (headless fixture feed for CI). showdown-ui has no equivalent — add it if CI coverage of the log path is required.

### Config (`config.json` at repo root)
Loaded at startup before the logger initializes. Keys: `timezone` (IANA, default `UTC`), `logLevel` (`DEBUG`/`INFO`/`WARN`/`ERROR`, default `INFO`), `saveLogs` (bool, default `true`). Env vars `PS_LOG_LEVEL` and `PS_TIMEZONE` override the file. Missing `config.json` is normal (defaults apply silently); malformed JSON logs a warning.

### Logging
`electron/main/index.ts` has an inline logger (no separate file) that mirrors `../app/logger.js` format: `ISO [LEVEL] [ns] msg`. Threshold from `PS_LOG_LEVEL`. Writes to `../logs/debug/showdown-ui-<ts>.log` (separate file from `app-<ts>.log`). Two namespaces: `ui-main` (startup/frames/rooms) and `ui-wlog` (log-writer events).

### Known gaps (by design, not bugs)
- Only the most-recently-active battle is tracked by the renderer — `BattleTracker.feed()` auto-resets on a new roomid; no foreground-room routing. The log writer in main maintains a full `rooms` map so multiple concurrent rooms are logged correctly.
- No local-mode server or testclient auto-login — official mode only; login persists via `partition:'persist:showdown-ui'`.
- No `PS_SYNTHETIC=1` headless mode for CI (see above).
