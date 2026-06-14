# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this is

A standalone Electron + React + TypeScript app (`electron-vite`) that is the **intended replacement for `../app/`**. It provides a native, docked battle helper alongside the live PS client in one window, and as of the C5 port it also writes the same rich battle logs that `../app/` produced. It imports shared pure libs from `../helper/extension/lib/` and JSON from `../helper/extension/data/`.

`../app/` remains in the repo as a fallback but is no longer the primary app.

## Commands

```bash
npm run dev         # electron-vite dev (hot-reload for renderer; restarts main/preload on change)
npm run build       # production build → out/
npm run preview     # preview the production build
npm run dist        # package an installer for the current OS (dmg on macOS) → dist/
npm run dist:linux  # package the Linux AppImage → dist/
npm run dist:win    # Windows NSIS installer → dist/
npm run dist:mac    # macOS dmg → dist/
```

Run from this directory (`showdown-ui/`).

Tests run at the repo root (the helper suite covers the shared parser/exporter libs used here):
```bash
npm test                         # full helper suite (run from repo root)
npm run test:smoke               # quick fixture battle → parser → exporter; fast CI gate
cd helper && node --test test/parser.test.js   # single test file
```

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
- `../helper/extension/lib/render.js` — shared HTML builders (see Render contract)
- `../helper/extension/data/**/*.json` — format data (loaded lazily via `import.meta.glob`)

### Render contract (single shared renderer)
The HTML builders live **once** in `../helper/extension/lib/render.js` — a pure, dependency-free ESM lib
(same invariant as `parser.js`/`lookup.js`) imported by **both** this app and the extension's
`panel.js`. `src/lib/render.ts` is a **thin adapter**: it re-exports `waitingHtml` and wraps
`renderBattle` to pass `opts.assetBase = import.meta.env.BASE_URL` (Vite resolves `/` in dev, `./` in the
packaged build — an absolute `/icons/…` breaks under the packaged `file://` origin). `src/styles/global.css`
and the extension's `panel.css` are **separate copies of the same rules** — keep them in sync.

The features that used to be showdown-ui-only (stat range bars, opponent-HP% + status, ability
descriptions, suppressed "1 sets left" badge, no `Lxx` level label) now live in the shared `render.js`,
so **both surfaces render identically — panel.js is no longer frozen.** Add new helper-UI features to
`render.js` (and mirror the styles into both CSS files); do not fork the builders back into either
consumer. `helper/test/render.test.js` smoke-tests the shared lib for both. Pure data-layer changes still
belong in `../helper/extension/lib` (e.g. `lookup.js` largest-remainder percentages, cosmetic-forme
`baseSpecies` fallback).

### Build entry points
`electron.vite.config.ts` must declare all three entries explicitly (electron-vite 2.x doesn't auto-detect outside `src/`):
- Main: `electron/main/index.ts`
- Preload: `electron/preload/index.ts` + `electron/preload/ps.ts`
- Renderer: `index.html` with relative `./src/main.tsx` script src

### Battle log writing (C5 — ported from `../app/main.js`)
`electron/main/index.ts` now drives the full C5 log path, identical in contract to `../app/main.js`:
- Per-room `rooms` map (one `BattleTracker` + raw frame buffer each). Keyed separately from the display `buffers` map.
- `handleFrame()` called on every `ps-frame` IPC message; detects `|win|`, `|tie|`, `|deinit|` to flush.
- `writeLog()` writes `<roomid>_{prefix}<p1>_vs_<p2>_{result}_{ts}.txt` to `../logs/battle_info/`.
- SPEC_ prefix for spectator games (`state.mySide === null`).
- `config.saveLogs = false` suppresses disk writes (tracker still runs).
- `flushAllRooms()` wired into `before-quit`, `window-all-closed`, `render-process-gone`, `uncaughtException`.
- Stale-room sweep every 5 min; evict after 30 min idle (saved as INPROGRESS).
- Hard frame cap: 100,000 frames/room; flushes + evicts on overflow.

**Tradeoff vs `../app/main.js`**: `../app/` had `PS_SYNTHETIC=1` (headless fixture feed for CI). showdown-ui has no equivalent — add it if CI coverage of the log path is required.

### Config (`config.json`)
Loaded at startup before the logger initializes from `USER_ROOT` (repo root in dev, `~/Documents/ps-local/` when packaged — see Packaging). Keys: `timezone` (IANA, default `UTC`), `logLevel` (`DEBUG`/`INFO`/`WARN`/`ERROR`, default `INFO`), `saveLogs` (bool, default `true`). Env vars `PS_LOG_LEVEL` and `PS_TIMEZONE` override the file. Missing `config.json` is normal (defaults apply silently); malformed JSON logs a warning.

### Logging
`electron/main/index.ts` has an inline logger (no separate file) that mirrors `../app/logger.js` format: `ISO [LEVEL] [ns] msg`. Threshold from `PS_LOG_LEVEL`. Writes to `../logs/debug/showdown-ui-<ts>.log` (separate file from `app-<ts>.log`). Two namespaces: `ui-main` (startup/frames/rooms) and `ui-wlog` (log-writer events).

### Packaging / distribution (`electron-builder.yml`)
`npm run dist` (`electron-vite build && electron-builder`) produces a downloadable installer — `productName: Pokemon Showdown Battle UI`, dmg on macOS / AppImage on Linux (`dist:linux`). Output → `dist/` (gitignored via the root `dist/` rule). The icon is `build/icon.png` (committed; generated from `../charizard_logo.jpeg`).

**Packaged vs. dev paths.** A packaged app's `__dirname` is inside the asar, so `index.ts` branches on `app.isPackaged`:
- `DATA_DIR` = `process.resourcesPath` (packaged) / repo root (dev) — base for `moves.json`, which is shipped via `extraResources` to `helper/extension/data/moves.json` (the `to:` tail must stay in sync with `loadMovesData()`).
- `USER_ROOT` = `~/Documents/ps-local/` (packaged) / repo root (dev) — base for writable state: `config.json` and `logs/`.

In dev both collapse to the repo root, so the dev path is byte-for-byte unchanged. The parser/exporter libs are **statically imported** (so Rollup bundles them into `out/main/index.js`) rather than dynamically `import()`ed — required to survive packaging.

macOS builds are **unsigned** (no Apple Developer ID): first launch needs right-click → Open, or `xattr -dr com.apple.quarantine "/Applications/Pokemon Showdown Battle UI.app"`. CI workflows build a Linux AppImage (`build-linux.yml`, includes xvfb `PS_SMOKE` launch smoke), Windows NSIS installer (`build-windows.yml`), and macOS dmg (`build-macos.yml`) on every push/PR. See [../docs/PACKAGING-PROGRESS.md](../docs/PACKAGING-PROGRESS.md).

### Known gaps (by design, not bugs)
- Only the most-recently-active battle is tracked by the renderer — `BattleTracker.feed()` auto-resets on a new roomid; no foreground-room routing. The log writer in main maintains a full `rooms` map so multiple concurrent rooms are logged correctly.
- No local-mode server or testclient auto-login — official mode only; login persists via `partition:'persist:showdown-ui'`.
- `PS_SMOKE=1` exits after boot (proves the packaged app launches — used by the Linux CI smoke). No `PS_SYNTHETIC=1` full fixture-feed through the log path (only `app/` has that).
