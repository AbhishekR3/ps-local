# ps-local — Architecture Reference

> This is the GitHub-readable companion to [architecture.html](architecture.html), which is an
> interactive graph viewer. The two files cover the same content; `architecture.html` adds a
> force-directed dependency graph and per-file drill-downs.

---

## 1. Executive Summary

**ps-local** is a Pokemon Showdown Battle Helper — a real-time competitive battle analysis tool that
runs alongside the live Pokemon Showdown client. It shows you opponent set predictions, stat ranges,
move frequencies, and ability/item probabilities during a battle, and automatically archives every
battle as a rich log file.

The system has **two production surfaces** that share an identical pure-function core:

- **`showdown-ui/`** — A native Electron + React + TypeScript app (`npm start`). The primary surface.
  Wraps `play.pokemonshowdown.com` in a native window with a docked battle helper panel on the right.
  This is what most users run.
- **`helper/extension/`** — A Chrome MV3 browser extension. Injects a helper panel into the PS web
  client as a side panel overlay.

**Architecture style:** Layered event-driven. A WebSocket tap feeds raw frames up through a stateful
parser into a pure rendering layer. The Electron main process handles persistence; the renderer handles
display. Both surfaces use identical shared libraries.

**Core loop:** PS WebSocket → injected.js tap → SockJS decode → postMessage → IPC relay →
BattleTracker.feed() → renderBattle() → HTML update

### Key Technologies

| Layer | Technology | Version |
|---|---|---|
| Desktop app | Electron | 42.x |
| Build | electron-vite | 2.x |
| UI | React + TypeScript | 18.x / 5.x |
| Extension | Chrome MV3 | — |
| Packaging | electron-builder | 25.x |
| Tests | Node built-in test runner | ≥22.6 |
| Linting | ESLint flat config | 9.x |

---

## 2. Repository Structure Map

```
ps-local/
├── showdown-ui/          PRIMARY APP — Electron+React native client
│   ├── electron/
│   │   ├── main/
│   │   │   └── index.ts          ★ Main process: rooms, IPC, log writer, ad-block
│   │   └── preload/
│   │       ├── index.ts          Context bridge → window.psUI API
│   │       └── ps.ts             WS tap relay + drag relay for psView
│   ├── src/
│   │   ├── App.tsx               Root: helperOpen toggle, resync button
│   │   ├── routes/
│   │   │   └── Battle.tsx        Layout: gameRef div + divider + HelperPanel
│   │   ├── components/
│   │   │   └── HelperPanel.tsx   ★ React component: BattleTracker + render loop
│   │   ├── lib/
│   │   │   ├── render.ts         Thin adapter over shared render.js
│   │   │   └── data.ts           Vite import.meta.glob data loader
│   │   └── styles/
│   │       └── global.css        CSS (copy of panel.css — keep in sync)
│   ├── electron.vite.config.ts   Build config (entries, externals, fs.allow)
│   ├── electron-builder.yml      Packaging (productName, icon, extraResources)
│   ├── tsconfig.web.json         Web/renderer TS config (allowJs for .js libs)
│   └── package.json              deps: react 18; devdeps: electron 42.4.0

├── helper/               SHARED PURE LIBS + CHROME EXTENSION
│   ├── extension/
│   │   ├── injected.js           ★ WebSocket tap (runs in page MAIN world)
│   │   ├── content.js            Bridge: MAIN→ISOLATED, injects panel iframe
│   │   ├── background.js         Service worker: buffer all rooms, toggle panel
│   │   ├── panel.js              Extension panel UI (BattleTracker + render loop)
│   │   ├── manifest.json         MV3: storage, host_permissions, content scripts
│   │   ├── panel.css             Panel styles (copy of global.css — keep in sync)
│   │   ├── lib/
│   │   │   ├── parser.js         ★ BattleTracker class (state machine, 430 lines)
│   │   │   ├── exporter.js       ★ generateBattleLog() (archive writer, 465 lines)
│   │   │   ├── render.js         ★ Shared HTML renderer (all UI, 370 lines)
│   │   │   ├── lookup.js         Prediction engine (set narrowing + Monte Carlo)
│   │   │   ├── data.js           Data loader for extension (chrome.runtime.getURL)
│   │   │   └── toid.js           toId() name normalizer (10 lines)
│   │   └── data/             FROZEN BUILD ARTIFACT — do not hand-edit
│   │       ├── pokedex.json      All Pokemon base stats + typing
│   │       ├── moves.json        Move type/category/BP table
│   │       ├── abilities-desc.json  Ability descriptions for UI tooltips
│   │       ├── gen9/             Per-generation random-battle data
│   │       │   ├── sets.json     Set movepool definitions
│   │       │   ├── items.json    Item frequency by role
│   │       │   ├── abilities.json
│   │       │   ├── teras.json
│   │       │   ├── movesFreq.json
│   │       │   └── stats.json    Pre-nature stat ranges by level
│   │       └── gen9doubles/      Same for doubles format
│   ├── test/
│   │   ├── parser.test.js        BattleTracker unit tests
│   │   ├── render.test.js        HTML renderer smoke tests
│   │   ├── exporter.test.js      Log generation tests
│   │   ├── golden.test.js        Byte-for-byte log regression
│   │   ├── edge-cases.test.js    Tie/forfeit/INPROGRESS edge cases
│   │   ├── integration.test.js   End-to-end pipeline tests
│   │   ├── content.test.js       Content script browser-sim tests
│   │   ├── lookup.test.js        Prediction engine tests
│   │   └── fixtures/             sample-battle.txt, forfeit-battle.txt, tie-battle.txt
│   └── build-data.js             Slow Monte-Carlo data rebuild (Node ≥22.6, TS)

├── app/                  LEGACY APP (local-mode sandbox + PS_SYNTHETIC=1 CI)
│   ├── main.js                   Electron main (C5 log contract, server spawn)
│   ├── preload.js                WS tap + testclient key injection
│   └── logger.js                 Runtime logger (C7 format)

├── scripts/              ORCHESTRATION SCRIPTS
│   ├── setup.js                  One-shot setup (submodules, build, overlays, deps)
│   ├── update-upstream.js        Bump submodules + rebuild + test gate
│   ├── apply-overlay.js          Copy overlay/ → vendor/ gitignored config targets
│   ├── build-ability-descriptions.js  Regenerate abilities-desc.json
│   └── lib/
│       └── logger.js             Orchestration logger (same format + step() timer)

├── overlay/              VENDOR CONFIG PATCHES (applied via apply-overlay.js)
│   ├── server-config.js          PS server: port 8000, noguestsecurity
│   └── client-config.js          PS client: default server localhost:8000

├── vendor/               GIT SUBMODULES — NEVER EDIT
│   ├── pokemon-showdown/          PS battle server
│   └── pokemon-showdown-client/   PS web client

├── .github/workflows/    8 CI PIPELINES
│   ├── test.yml                  Secret scan + unit tests (every push/PR)
│   ├── build-electron.yml        From-source electron-vite build + xvfb PS_SMOKE
│   ├── build-linux.yml           AppImage + headless launch smoke
│   ├── build-macos.yml           dmg + launch smoke
│   ├── build-windows.yml         NSIS installer + launch smoke
│   ├── build-extension.yml       Extension zip + credential leak guard
│   ├── upstream-canary.yml       Weekly upstream bump + test gate
│   └── codacy.yml                Static analysis SARIF

├── docs/                         DOCUMENTATION
├── config.json                   Runtime config (timezone, logLevel, saveLogs)
├── CLAUDE.md                     Developer guide
└── package.json                  Root orchestration scripts (no runtime deps)
```

---

## 3. System Architecture

### Primary Path (showdown-ui)

```
┌─ PS SERVER (wss://sim*.psim.us) ──────────────────────────────────────────┐
│  Battle WebSocket (SockJS-wrapped)                                         │
└────────────────────────────────────┬──────────────────────────────────────┘
                                     │ WS frames (a[...] SockJS)
                          ┌──────────▼──────────┐
                          │   injected.js        │  MAIN world (page context)
                          │  PatchedWebSocket    │  decodeSockJS() → postMessage
                          └──────────┬──────────┘
                                     │ window.postMessage {__psHelper, data}
                          ┌──────────▼──────────┐
                          │    ps.ts (preload)   │  psView preload
                          │  message listener    │  ipcRenderer.send("ps-frame")
                          └──────────┬──────────┘
                                     │ Electron IPC
                          ┌──────────▼──────────┐
                          │  index.ts (main)     │  Main process
                          │  ┌───────────────┐  │
                          │  │ rooms Map      │  │  BattleTracker per room
                          │  │ BattleTracker  │  │
                          │  │ handleFrame()  │──┼──→ writeLog() on |win|/|tie|/|deinit|
                          │  │ bufferFrame()  │  │       └→ generateBattleLog()
                          │  └───────────────┘  │       └→ fs.writeFileSync (logs/)
                          │  installAdBlock()    │
                          └──────┬──────┬───────┘
                                 │      │ webContents.send("ps-frame")
             contextBridge       │      │
          ┌──────────────────────┘      ▼
          │               ┌────────────────────────┐
          │               │  preload/index.ts       │  mainWindow preload
          │               │  window.psUI API        │  contextBridge bridge
          │               └──────────┬─────────────┘
          │                          │ window.psUI.onFrame()
          │               ┌──────────▼─────────────┐
          │               │  HelperPanel.tsx        │  React renderer
          │               │  BattleTracker (ref)    │
          │               │  onFrame → doRender()   │
          │               │  ensureFormat()         │
          │               └──────────┬─────────────┘
          │                          │
          │      ┌───────────────────┼────────────────────┐
          │      ▼                   ▼                     ▼
          │  render.ts           data.ts             parser.js
          │  (adapter)           (Vite loader)       (BattleTracker)
          │      │                   │
          │      ▼                   ▼
          │  render.js           data/*.json
          │  (HTML builder)
          │      │
          │      ▼
          │  lookup.js → toid.js
          │
          ▼
     psView (WebContentsView)
     play.pokemonshowdown.com
```

### Extension Path (Chrome)

```
PS Client page (play.pokemonshowdown.com)
  ├── injected.js (MAIN world) ──postMessage──→ content.js (ISOLATED world)
  │                                               │
  │                               ┌───────────────┼───────────────────┐
  │                               ▼               ▼                   ▼
  │                        background.js    panel.js (iframe)    foregroundRoom()
  │                        (service worker)  │                   (700ms URL poll)
  │                        buffers all       ├── BattleTracker
  │                        rooms in          ├── render.js
  │                        storage.session   ├── lookup.js
  │                                          └── data.js
```

---

## 4. File Interaction Map

Click any node in the interactive graph ([architecture.html](architecture.html)) for full per-file
detail. Quick reference below (line counts reflect the current codebase):

| File | Layer | Lines | Role | Key Dependency |
|---|---|---|---|---|
| `showdown-ui/electron/main/index.ts` | Entry | 559 | Main process: rooms, IPC, log writer, ad-block | parser.js, exporter.js |
| `app/main.js` | Entry | 666 | Legacy main: same C5 contract + server spawn + synthetic CI | parser.js, exporter.js, logger.js |
| `showdown-ui/electron/preload/ps.ts` | Preload | 78 | WS tap relay (new Function) + drag relay | injected.js |
| `showdown-ui/electron/preload/index.ts` | Preload | 54 | contextBridge → window.psUI for renderer | ipcRenderer |
| `app/preload.js` | Preload | 123 | Legacy WS tap + testclient key injection | injected.js |
| `showdown-ui/src/App.tsx` | React | 61 | Root: helperOpen + resyncSignal state | Battle.tsx |
| `showdown-ui/src/routes/Battle.tsx` | React | 137 | Layout: gameRef bounds + divider drag | HelperPanel.tsx |
| `showdown-ui/src/components/HelperPanel.tsx` | React | 215 | ★ Battle helper: BattleTracker + render loop + stall detection | render.ts, data.ts, parser.js |
| `showdown-ui/src/lib/render.ts` | Adapter | 19 | Thin wrapper: adds Vite assetBase to render.js call | render.js |
| `showdown-ui/src/lib/data.ts` | Adapter | 56 | Vite import.meta.glob data loader (mirrors data.js) | data/*.json |
| `helper/extension/lib/parser.js` | Shared Lib | 430 | ★ BattleTracker state machine (40+ protocol commands) | (none) |
| `helper/extension/lib/exporter.js` | Shared Lib | 465 | ★ generateBattleLog() — 7-section archive writer | parser state |
| `helper/extension/lib/render.js` | Shared Lib | 370 | ★ Shared HTML renderer (single source for both surfaces) | lookup.js |
| `helper/extension/lib/lookup.js` | Shared Lib | 278 | Prediction engine: set narrowing + Monte Carlo distributions | toid.js |
| `helper/extension/lib/data.js` | Shared Lib | 129 | Extension data loader (chrome.runtime.getURL) | data/*.json |
| `helper/extension/lib/toid.js` | Shared Lib | 10 | toId() name normalizer | (none) |
| `helper/extension/injected.js` | Extension | 83 | ★ WebSocket subclass tap (MAIN world, runs in both surfaces) | window.WebSocket |
| `helper/extension/panel.js` | Extension | 143 | Extension panel UI (mirror of HelperPanel.tsx) | parser.js, render.js, data.js |
| `helper/extension/content.js` | Extension | 349 | Bridge: MAIN→ISOLATED, panel injection, room routing | background.js, panel.js |
| `helper/extension/background.js` | Extension | 109 | MV3 service worker: buffer + storage.session persist | chrome.storage.session |
| `app/logger.js` | Script | 46 | Runtime logger (C7 format: ISO [LEVEL] [ns] msg) | fs |
| `scripts/lib/logger.js` | Script | 61 | Orchestration logger (same format + step() timer) | fs |
| `scripts/apply-overlay.js` | Script | 26 | Copy overlay/ → vendor/ gitignored config targets | fs |

---

## 5. Dependency Graph

The interactive graph in [architecture.html](architecture.html) shows directed dependencies. Key
structural observations:

- **`parser.js`** is the most-depended-upon module (3 consumers: `index.ts`, `HelperPanel.tsx`,
  `panel.js`) and has zero dependencies of its own.
- **`render.js`** is the second most critical: it is the single shared source of all UI HTML.
  Forking it would immediately create a rendering divergence.
- **`injected.js`** is uniquely cross-context: it runs in three different execution environments
  (Chrome extension MAIN world, Electron psView via `ps.ts`, Electron window via `app/preload.js`).
- **The adapter layer** (`render.ts`, `data.ts`) is intentionally thin — it exists only to bridge the
  Vite/Electron build environment to the pure shared libs.
- **No circular dependencies** exist in the shared lib graph: `parser` ← `exporter`,
  `render` → `lookup` → `toid`. The dependency direction is always toward more-primitive modules.

> `render.js` and `lookup.js` must remain dependency-free of `chrome.*` and Node-only APIs. They are
> imported by both browser and Node contexts simultaneously — coupling to either breaks the other.

---

## 6. Execution Flow Analysis

### A. Application Startup (showdown-ui)

```
app.whenReady()
  └→ loadMovesData()                    // reads moves.json from REPO_ROOT or resourcesPath
      └→ loadConfig()                   // reads config.json: timezone, logLevel, saveLogs
          └→ createWindow()
              ├→ new BrowserWindow()    // mainWindow: React renderer
              │   └ preload: preload/index.ts (contextBridge → window.psUI)
              ├→ new WebContentsView()  // psView: PS client overlay
              │   └ preload: preload/ps.ts (WS tap + drag relay)
              │   └ loadURL('https://play.pokemonshowdown.com')
              ├→ installAdBlock(psView.webContents.session)
              ├→ Register all ipcMain handlers (ps-frame, get-buffer, set-game-bounds, …)
              └→ mainWindow.loadURL(MAIN_URL)  // loads React app

  app.on('ready') also starts:
  └→ setInterval(sweepStaleRooms, 5min).unref()
```

### B. ps-frame Pipeline (the hot path)

```
PS Server ──SockJS──→ psView WebSocket
  │
  injected.js (PatchedWebSocket.onmessage)
    ├ decodeSockJS(raw)          // parse a[...] frame → string[]
    └ for each msg starting with >battle-:
        window.postMessage({__psHelper:true, data:msg}, origin)
  │
  ps.ts preload (message listener)
    └ ipcRenderer.send('ps-frame', {data})
  │
  index.ts main (ipcMain.on 'ps-frame')
    ├ bufferFrame(data)          // push to buffers[roomid], cap at MAX_FRAMES, cap rooms at MAX_ROOMS
    ├ handleFrame(data)
    │   ├ roomidOf(data)         // extract >battle-xxx-yyy from first line
    │   ├ rooms.get(room) or create {tracker:new BattleTracker(), rawFrames:[], lastSeen:now}
    │   ├ tracker.feed(data)     // state mutation (BattleTracker._handleLine × N)
    │   ├ rawFrames.push(data), lastSeen = now
    │   └ if state.ended or (state.closed and turn≥1):
    │       writeLog(roomid, state, rawFrames)
    │         ├ generateBattleLog(state, rawFrames, movesData, timezone)  // → rich string
    │         ├ sanitize(p1), sanitize(p2)
    │         └ writeFileSync(path.join(LOGS_DIR, filename+'.txt'), rich)
    └ mainWindow.webContents.send('ps-frame', {data})
  │
  preload/index.ts (ipcRenderer.on 'ps-frame')
    └ window.psUI callbacks: cb({data})
  │
  HelperPanel.tsx (onFrame)
    ├ tracker.feed(data)
    ├ room change detection → resync()
    ├ stall timer rearm
    └ if !rafRef: requestAnimationFrame(doRender); rafRef=true
  │
  doRender()
    ├ await ensureFormat()       // lazy-load format tables if needed
    ├ renderBattle(state,core,fmt) → {format, html}
    └ setHtml(html), setFormat(format)
```

### C. Panel Resync Flow

```
resync() [triggered by: resyncSignal prop change, room change, stall detection]
  ├ tracker.reset()
  ├ framesSeenRef = 0, autoResyncedRef = false
  ├ const {frames, room} = await window.psUI.getBuffer()
  │     └→ ipcMain.handle('get-buffer')
  │           └→ return {frames: buffers[mostRecentRoom], room}
  └ for each frame: onFrame({data: frame})
        └→ tracker.feed(frame) → normal render pipeline
```

### D. Drag-Resize Flow

```
User drags divider in renderer (Battle.tsx onMouseDown)
  ├ window.psUI.beginResize()
  │     └→ ipcMain.on('begin-resize')
  │           ├ psView mouse events → relay mode
  │           └ psView.webContents.send('start-drag-relay')
  │                 └→ ps.ts: attach mousemove/mouseup listeners
  │
  User moves mouse over psView (PS client area)
  ├ ps.ts mousemove: ipcRenderer.send('ps-drag-move', {screenX})
  │     └→ ipcMain.on('ps-drag-move')
  │           └→ mainWindow.webContents.send('resize-drag', {x: screenX})
  │                 └→ preload/index.ts: onResizeDrag cb(x)
  │                       └→ Battle.tsx: update divider position CSS
  │
  User releases mouse
  ├ ps.ts mouseup: ipcRenderer.send('ps-drag-end')
  │     └→ ipcMain.on('ps-drag-end')
  │           └→ mainWindow.webContents.send('resize-drag-end')
  └ window.psUI.endResize() → cleanup
```

---

## 7. Important Functions & Classes

1. **`BattleTracker.feed(frame)`** — `helper/extension/lib/parser.js`  
   The core state machine entry point. Consumes every raw PS protocol frame. Auto-resets on room
   change. Dispatches 40+ command types. Called from three consumers simultaneously.

2. **`handleFrame(frameData)`** — `showdown-ui/electron/main/index.ts`  
   The hottest path in the app. Buffers display frames, feeds BattleTracker, detects
   `|win|`/`|tie|`/`|deinit|` end conditions, triggers `writeLog`. Every battle frame flows here.

3. **`renderBattle(state,core,fmt,opts)`** — `helper/extension/lib/render.js`  
   Top-level HTML generator. Three code paths: spectator (both sides), player (your vs opponent),
   waiting. Single source of truth for all battle UI in both surfaces.

4. **`generateBattleLog(state,rawFrames,movesData,timezone)`** — `helper/extension/lib/exporter.js`  
   Synchronous archive writer. Produces 7-section battle record. Called on every completed battle.
   The output is what users actually keep and share.

5. **`getBreakdown(species,data,revealedMoves)`** — `helper/extension/lib/lookup.js`  
   Core prediction engine. Narrows possible sets, computes Monte Carlo distributions for
   items/abilities/teras. Called once per opponent Pokemon per render pass.

6. **`PatchedWebSocket(url,protocols)`** — `helper/extension/injected.js`  
   Wraps `window.WebSocket` to intercept SockJS frames before PS captures them. The tap that makes
   everything else possible. Runs in MAIN world in three different contexts.

7. **`flushAllRooms(reason)`** — `showdown-ui/electron/main/index.ts`  
   Crash-resilience function. Wired to 4 exit events (`before-quit`, `window-all-closed`,
   `render-process-gone`, `uncaughtException`). Ensures no battle is ever lost on unexpected exit.

8. **`BattleTracker._handleLine(line)`** — `helper/extension/lib/parser.js`  
   Giant dispatch switch on PS protocol command. Implements the full PS battle protocol client-side.

9. **`BattleTracker._onRequest(json)`** — `helper/extension/lib/parser.js`  
   Parses the `|request|` message (the only frame that contains full team data). Populates `myTeam[]`
   with stats, moves, ability, item, tera. The only source of ground-truth player data.

10. **`HelperPanel.onFrame(payload)`** — `showdown-ui/src/components/HelperPanel.tsx`  
    Frame receiver in the renderer. Feeds tracker, arms stall detection, schedules RAF coalescing
    render. The renderer-side hot path.

11. **`breakdownCard(species,reveal,core,fmt,meta,activeHp)`** — `helper/extension/lib/render.js`  
    The main opponent Pokemon card builder. Renders stat range bars, predicted sets with move
    frequencies, item/ability/tera predictions. Most visually complex output.

12. **`sweepStaleRooms()`** — `showdown-ui/electron/main/index.ts`  
    Memory management. Evicts rooms idle for >30 min to prevent unbounded growth. Runs every 5 min.
    Writes INPROGRESS log for evicted rooms.

13. **`installAdBlock(session)`** — `showdown-ui/electron/main/index.ts` + `app/main.js`  
    Registers `onBeforeRequest` handler cancelling 80+ ad/analytics domains at the session layer.
    Must never cancel `*.pokemonshowdown.com`, `sim*.psim.us`, or `action.php`.

14. **`decodeSockJS(raw)`** — `helper/extension/injected.js`  
    Parses SockJS `a[...]` frames into PS protocol messages. Returns `[]` for control frames. The
    framing assumption here is the single most fragile contract with upstream.

15. **`createWindow()`** — `showdown-ui/electron/main/index.ts`  
    Bootstraps the full dual-pane window: `BrowserWindow` (React) + `WebContentsView` (PS client).
    Sets up all IPC handlers. Called once per app lifecycle.

16. **`writeLog(roomid,state,rawFrames)`** — `showdown-ui/electron/main/index.ts`  
    Produces the filename (encodes result, player names, timestamp) and writes the generated log.
    The `SPEC_` prefix is applied here when `state.mySide === null`.

17. **`HelperPanel.resync()`** — `showdown-ui/src/components/HelperPanel.tsx`  
    Full tracker rebuild from buffer. The recovery mechanism for missed frames, mid-battle mounts,
    and manual user-triggered re-syncs.

18. **`BattleTracker._reveal(side,species,extra)`** — `helper/extension/lib/parser.js`  
    Accumulates opponent knowledge. Merges ability/item/move sets across multiple reveals of the
    same species. Core of the knowledge-tracking system.

19. **`largestRemainderPct(entries,grand)`** — `helper/extension/lib/lookup.js`  
    Hamilton method for integer percentage distribution summing to exactly 100. Prevents "101%"
    display bugs in prediction panels.

20. **`runSynthetic()`** — `app/main.js`  
    Headless mode: feeds a fixture battle file through the real C5 log path with no window or
    server. `PS_SYNTHETIC=1` triggers this path. No CI workflow invokes it directly; the real CI
    decoupling gate is `npm run test:smoke` (`helper/test/smoke.mjs`).

21. **`content.js frameHandler(event)`** — `helper/extension/content.js`  
    Cross-world bridge. Receives frames from `injected.js` (MAIN world), routes to `background.js`
    (all rooms) and panel iframe (current room only). The `event.source` check MUST NOT be added.

22. **`background.js handleFrame(data)`** — `helper/extension/background.js`  
    Extension-side frame buffer. Maintains per-room circular buffer (2000 frames max, 6 rooms max
    LRU). Persists to `storage.session` with 500ms debounce.

23. **`parseDetails(str)`** — `helper/extension/lib/parser.js`  
    Parses PS "details" strings into structured Pokemon identity data. Called on every
    switch/drag/replace event to identify the Pokemon entering battle.

24. **`statRangeBar(label,lo,hi,max)`** — `helper/extension/lib/render.js`  
    Renders the stat uncertainty visualization: solid bar to lo, translucent extension to hi.

25. **`Battle.tsx ResizeObserver callback`** — `showdown-ui/src/routes/Battle.tsx`  
    Reports game container pixel bounds to main via `setGameBounds` IPC on every resize. The glue
    that keeps the psView overlay aligned with its React placeholder div.

---

## 8. Data Flow Mapping

### A. Live Battle Display

```
ENTRY:  PS WebSocket SockJS frames (raw binary via TCP/TLS)
        │
        injected.js: decodeSockJS → array of PS protocol strings
        │
        content.js / ps.ts: validation + routing (filter >battle- prefix)
        │
PARSE:  BattleTracker.feed(frame)
        │  state.active    — currently active Pokemon (slot → identity + HP + boosts)
        │  state.revealed  — observed opponent info (species → moves/ability/item sets)
        │  state.myTeam    — player's own team (from |request|)
        │  state.turn      — current turn number
        │  state.ended     — has |win|/|tie| been seen
        │
PREDICT:getBreakdown(species, formatData, revealedMoves)
        │  Narrows sets → relevantSets
        │  Computes item/ability/tera distributions via Monte Carlo
        │  Returns breakdown.predictedItems, .predictedAbilities, .predictedTeras
        │
RENDER: renderBattle(state, core, fmt) → HTML string
        │  breakdownCard()  — opponent cards (predictions + stat ranges)
        │  myActiveCard()   — player's active (actual stats from |request|)
        │  statRangeBar()   — lo/hi uncertainty visualization
        │  moveChip()       — move buttons (type, BP, frequency %)
        │
OUTPUT: dangerouslySetInnerHTML / $content.innerHTML = html
```

### B. Battle Log Archive

```
ENTRY:  Battle ends (|win| / |tie| / |deinit| / stale-eviction)
        │
        state = BattleTracker.state   (accumulated over entire battle)
        rawFrames = string[]          (all frames as received, verbatim)
        movesData = moves.json        (type/category/BP lookup)
        │
GENERATE: generateBattleLog(state, rawFrames, movesData, timezone)
        │  Section 1: SUMMARY (result, format, date, players)
        │  Section 2: YOUR TEAM (from myTeam[], full stats + moves)
        │  Section 3: OPPONENT TEAM (from revealed{}, observed data only)
        │  Section 4: FIELD STATE AT END (weather, terrain, side conditions)
        │  Section 5: TURN-BY-TURN (rendered via renderTurn() per turn)
        │  Section 6: RAW PROTOCOL (rawFrames joined, verbatim)
        │
PERSIST: fs.writeFileSync(logs/battle_info/<filename>.txt)
         filename: <roomid>_[SPEC_]<p1>_vs_<p2>_<WIN|TIE|INPROGRESS>_<ts>.txt
```

### C. Static Data Loading

```
Build time:  helper/build-data.js  (slow Monte-Carlo, run manually after upstream update)
               └→ queries vendor/pokemon-showdown format data
               └→ writes helper/extension/data/**/*.json
               └→ these JSONs are FROZEN ARTIFACTS in the repo

Runtime (Electron):  data.ts loadFormat(key)
               └→ import.meta.glob matches helper/extension/data/gen9/*.json
               └→ Vite bundles these at build time into the renderer chunk
               └→ packaged app reads from asar (inline bundle)

Runtime (Extension):  data.js loadSets(key)
               └→ fetch(chrome.runtime.getURL('data/gen9/sets.json'))
               └→ Chrome serves from extension's local file system
```

---

## 9. Storage & Persistence

### Battle Log Files (Primary Output)

**`logs/battle_info/*.txt`**

- **Location:** Dev: `<repo>/logs/battle_info/` | Packaged: `~/Documents/ps-local/logs/battle_info/`
- **Naming convention:**
  ```
  Own games:    <roomid>_<p1>_vs_<p2>_WIN_<ts>.txt
                <roomid>_<p1>_vs_<p2>_LOSS_<ts>.txt
                <roomid>_<p1>_vs_<p2>_TIE_<ts>.txt
  Spectator:    <roomid>_SPEC_<p1>_vs_<p2>_WIN_<ts>.txt
  In-progress:  <roomid>_<p1>_vs_<p2>_INPROGRESS_<ts>.txt
  ```
- **Contents:** 7 sections (SUMMARY, YOUR TEAM, OPPONENT TEAM, FIELD STATE, TURN-BY-TURN, RAW PROTOCOL)
- **Written by:** `showdown-ui/electron/main/index.ts writeLog()` (primary) and `app/main.js writeLog()` (legacy)

### Debug Logs

**`logs/debug/*.log`**

- **Location:** Dev: `<repo>/logs/debug/` | Packaged: `~/Documents/ps-local/logs/debug/`
- **Files:** `app-<ts>.log` (app/ runtime), `showdown-ui-<ts>.log` (showdown-ui runtime),
  `<script>-<ts>.log` (orchestration scripts)
- **Format (C7):** `2024-01-15T10:23:45.123Z [INFO] [ui-main] Battle ended: gen9randombattle-123`
- **Level threshold:** `PS_LOG_LEVEL` env var (DEBUG/INFO/WARN/ERROR)

### Extension Frame Buffer (Ephemeral)

**`chrome.storage.session` (background.js)**

- **Scope:** Chrome browser session — lost on browser close, persists across service worker restarts
- **Contents:** `Map<roomid, string[]>` — up to 2000 frames per room, up to 6 rooms
- **Purpose:** Replay frames when panel is opened mid-battle or after service worker restart
- **Risk:** 500ms persist debounce — last 500ms of frames can be lost on hard worker kill

### Electron Frame Buffer (In-Memory)

**`buffers` Map (`showdown-ui/electron/main/index.ts`)**

- **Scope:** Process lifetime — lost on app exit (after `flushAllRooms` writes logs)
- **Contents:** `Map<roomid, string[]>` — max MAX_FRAMES (2000) per room, max MAX_ROOMS (6)
- **Purpose:** Replay frames to renderer on mount or resync via `get-buffer` IPC

### Config File

**`config.json`**

- **Location:** Dev: `<repo>/config.json` | Packaged: `~/Documents/ps-local/config.json`
- **Schema:**
  ```json
  { "timezone": "UTC", "logLevel": "INFO", "saveLogs": true, "iconPath": "~/path/to/icon.png" }
  ```
- **Overrides:** `PS_TIMEZONE` and `PS_LOG_LEVEL` env vars override the file values
- `iconPath` is optional — sets the live window/taskbar icon (Linux/Windows) and macOS Dock icon

### Static Data Bundle

**`helper/extension/data/**/*.json`**

- **Status:** Frozen build artifact — committed to repo, not generated at runtime
- **Regenerate:**
  ```bash
  cd vendor/pokemon-showdown && npm run build && cd ../..
  cd helper && node build-data.js
  ```
- **Requires:** Node ≥22.6 (TypeScript type-stripping), upstream PS build data in `dist/`
- **Staleness:** No automatic staleness detection — must manually rebuild after upstream PS data changes

---

## 10. External Dependencies

| Dependency | Type | Where Used | Notes |
|---|---|---|---|
| **Electron 42** | Framework | `showdown-ui/` + `app/` | Provides BrowserWindow, WebContentsView, IPC, session, app APIs |
| **electron-vite 2.x** | Build tool | `showdown-ui/` | Vite-based bundler for Electron main+preload+renderer. Requires explicit entry declarations. |
| **electron-builder 25.x** | Packager | `showdown-ui/` | Produces dmg/AppImage+tar.gz/NSIS+portable. productName has spaces → affects artifact path. Unsigned on macOS. |
| **React 18 + ReactDOM** | UI library | `showdown-ui/src/` | Used only in the Electron renderer process. Not in extension. |
| **TypeScript 5.x** | Language | `showdown-ui/` (main, preload, renderer) | `tsconfig.web.json` enables `allowJs` to import .js helper libs. |
| **Pokemon Showdown Server** | Upstream service | `vendor/pokemon-showdown` | Git submodule (pristine). Never edit. Weekly canary CI detects protocol breaks. |
| **Pokemon Showdown Client** | Upstream service | `vendor/pokemon-showdown-client` + `play.pokemonshowdown.com` | Git submodule for local mode. Live site loaded in showdown-ui official mode. |
| **Chrome Extension MV3 APIs** | Browser API | `helper/extension/` | `storage.session`, `action`, `host_permissions`, `runtime`. MV3 only — no MV2 fallback. |
| **Node built-in test runner** | Test framework | `helper/test/` | `node --test` (requires Node ≥18). No external test framework. |
| **ESLint 9 (flat config)** | Linter | repo root | Per-module globals to avoid false `no-undef`. Ignores `vendor/`, `dist/`, `logs/`. |
| **gitleaks** | CI tool | `.github/workflows/test.yml` | Scans for secrets before running tests. Fail-fast position in pipeline. |
| **Codacy CLI** | CI tool | `.github/workflows/codacy.yml` | SARIF static analysis. Advisory only (`max-allowed-issues=unlimited`). |

---

## 11. Configuration & Environment

### Environment Variables

| Variable | Values | Default | Where Used | Effect |
|---|---|---|---|---|
| `PS_LOG_LEVEL` | DEBUG, INFO, WARN, ERROR | INFO | All loggers | Sets logging threshold. DEBUG enables per-frame and per-request logging. |
| `PS_TIMEZONE` | IANA timezone string | UTC | showdown-ui main, `app/main.js` | Timezone for "Generated:" timestamp in battle log files. |
| `PS_SERVER` | `local`, (default: official) | official | `app/main.js` only | `local`: spawns PS server on :8000, serves static client on :8080. |
| `PS_TESTCLIENT_KEY_PATH` | file path | `~/Documents/pokemon-showdown-client/config/testclient-key.js` | `app/preload.js` | Override path for local-mode session key file. |
| `PS_NO_EXTENSION` | 1 | (unset) | `app/main.js` only | Skip `loadPanelExtension()`. Useful when debugging without the helper panel. |
| `PS_SYNTHETIC` | 1 | (unset) | `app/main.js` only | Headless fixture-feed mode: runs `sample-battle.txt` through log path, then exits. |
| `PS_SMOKE` | 1 | (unset) | `showdown-ui` only | Boot, log "PS_SMOKE: boot ok", exit 0. Used by Linux CI launch smoke. |
| `ELECTRON_RUN_AS_NODE` | 1 | (set by this shell) | `app/` only | Forces Electron to behave as plain Node — breaks `app/`. Strip it: `env -u ELECTRON_RUN_AS_NODE electron .` |

### config.json

```json
// Location: repo root (dev) or ~/Documents/ps-local/ (packaged)
{
  "timezone": "UTC",        // IANA timezone for log timestamps (overridden by PS_TIMEZONE)
  "logLevel": "INFO",       // DEBUG|INFO|WARN|ERROR (overridden by PS_LOG_LEVEL)
  "saveLogs": true,         // false disables writing battle log files entirely
  "iconPath": "~/path/to/icon.png"  // optional: live window/taskbar + macOS Dock icon
}
```

### electron-builder.yml Key Settings

| Key | Value | Impact |
|---|---|---|
| `productName` | "Pokemon Showdown Battle UI" | Has spaces — artifact paths include spaces. Careful with CI shell quoting. |
| `appId` | `com.abhishekr3.ps-local` | macOS bundle identifier |
| `asar` | `true` | Code bundled in asar archive. `__dirname` inside asar is read-only. |
| `extraResources` | `moves.json → helper/extension/data/moves.json` | Ships `moves.json` outside asar into `resourcesPath`. |
| Targets | Linux: `[AppImage, tar.gz]` / Windows: `[nsis, portable]` / macOS: `[dmg, zip]` | Each OS builds both an installer and a portable/no-install artifact. |

> **Dangerous configuration (RESOLVED):** If `saveLogs: false` is set in `config.json`, ALL battle
> logs are discarded. This is surfaced: showdown-ui logs a loud startup WARN and shows "logging OFF"
> on the status line; `app/main.js` logs the same startup WARN.

> **Node version requirement:** Node ≥22.6 is required for `build-data.js` (TypeScript
> type-stripping). Older Node fails with a syntax error — not an obvious version error.

---

## 12. Developer Knowledge Guide

### Where should new features go?

| Feature Type | Where to Add | Notes |
|---|---|---|
| New battle UI element (stat, badge, card) | `helper/extension/lib/render.js` | Both surfaces get it automatically. Update `panel.css` AND `global.css` with matching styles. |
| New protocol command handling | `helper/extension/lib/parser.js _handleLine()` | Add a new case. Update state shape if needed. Add tests in `helper/test/parser.test.js`. |
| New log section or format | `helper/extension/lib/exporter.js` | `generateBattleLog()` is the single writer. Update golden test (`helper/test/golden.test.js --update`). |
| New Electron window UI (toolbar button, dialog) | `showdown-ui/src/App.tsx` or `Battle.tsx` | Wire new IPC channels in `preload/index.ts` and `main/index.ts`. |
| New main-process feature | `showdown-ui/electron/main/index.ts` | Add `ipcMain.handle` or `ipcMain.on`. Expose via `contextBridge` in `preload/index.ts` if renderer needs it. |
| New prediction data | `helper/build-data.js` + `data.js` + `data.ts` | Add a new JSON file, loader function in both `data.js` and `data.ts`, and consume in `lookup.js` or `render.js`. |

### How are tests organized?

Tests live in `helper/test/` and run with `npm test` (= `cd helper && node --test`). Requires Node
≥18. No external test framework — uses Node's built-in `assert` module.

- **`parser.test.js`** — feed raw protocol frames through `BattleTracker`, assert state mutations
- **`render.test.js`** — call `renderBattle` with mock state, assert HTML output contains expected elements
- **`golden.test.js`** — run full pipeline on `sample-battle.txt`, compare output byte-for-byte. Update: `node golden.test.js --update`
- **`lookup.test.js`** — test set narrowing and Monte Carlo predictions with known inputs
- **`edge-cases.test.js`** — tie battles, forfeits, INPROGRESS scenarios

### How to add a new IPC channel?

1. Add `ipcMain.handle('my-channel', async (e, args) => { ... })` in `index.ts createWindow()`
2. Add `window.psUI.myMethod = (args) => ipcRenderer.invoke('my-channel', args)` in `preload/index.ts`
3. Call `window.psUI.myMethod(args)` in any React component

### How to update upstream PS data?

```bash
npm run update-upstream          # bumps submodules, rebuilds, re-applies overlays
cd vendor/pokemon-showdown && npm run build && cd ../..
cd helper && node build-data.js  # regenerates data/*.json (slow, Monte-Carlo)
```

If helper tests fail after an upstream bump, a PS protocol change broke `parser.js` or `exporter.js`.
See [docs/UPDATE-WORKFLOW.md](UPDATE-WORKFLOW.md).

### How does packaging work?

`npm run dist:ui` → `electron-vite build` (produces `out/`) → `electron-builder` (produces `dist/`).
On macOS: unsigned dmg (right-click → Open, or `xattr -dr com.apple.quarantine`). The key path fork:
`app.isPackaged` switches reads from repo root to `process.resourcesPath` (for `moves.json`) and
`~/Documents/ps-local/` (for logs + config).

---

## 13. Risk Assessment

| Risk | Severity | Description | Mitigation |
|---|---|---|---|
| Duplicate ad-block list | Medium | `AD_ANALYTICS_PATTERNS` is copy-pasted between `index.ts` and `app/main.js`. They can silently diverge. | Comment in each file references the other. `guards.test.js` asserts both copies are identical. |
| Stale render.js CSS sync | Medium | `panel.css` and `global.css` are separate copies. Adding a CSS class to `render.js` HTML without updating both files silently breaks one surface's styling. | `guards.test.js` asserts every class emitted by `render.js` is styled in both CSS files (or neither). |
| SockJS framing assumption | High → mitigated | `injected.js` assumes PS uses SockJS `a[...]` framing (unversioned). If PS changes transport, the tap produces nothing. | Both surfaces surface tap failures visually. Weekly `upstream-canary` CI detects protocol breaks. |
| `content.js` postMessage source check | High | Adding `event.source===window` to `frameHandler` silently drops ALL frames. | Documented in `CLAUDE.md` and inline comments. `guards.test.js` asserts no such check exists. |
| MV3 service worker lifetime | Medium | Chrome may kill `background.js` at any time. 500ms debounce means up to 500ms of frames can be lost. | Debounce window is intentionally short. `storage.session` rehydration on restart recovers most history. |
| `app.isPackaged` path fork complexity | Low | Every path root changes between dev and packaged. Missing the branch silently reads/writes the wrong location. | The `isPackaged` pattern is centralized in early initialization. |
| No shared CSS source | Medium | `panel.css` and `global.css` are parallel copies. Divergence accumulates over time. | `guards.test.js` enforcement. Any new CSS class added to `render.js` HTML must be added to both CSS files. |
| `build-data.js` Node version | Low | Requires Node ≥22.6 for TypeScript type-stripping. Older Node fails with an unhelpful syntax error. | `CLAUDE.md` documents this. `setup.js` performs a version check before running. |
| Only most-recent room in renderer | Low | `HelperPanel` only shows the most-recently-active room. Main process correctly logs all concurrent rooms. | Documented as intentional design gap. |
| Unsigned macOS builds | Low | macOS users must right-click → Open or run `xattr -dr` to bypass Gatekeeper. | Documented in `README.md`. Apple Developer ID signing would require a paid membership. |

---

## 14. Suggested Reading Order

For a new engineer who wants to understand this codebase as quickly as possible:

1. **`CLAUDE.md`** (repo root) — Read the entire file. It is the authoritative developer guide. The
   "invariant" and "undocumented assumptions" sections are especially critical.
2. **`helper/extension/injected.js`** (83 lines) — This is where it all begins. Understand how the
   WebSocket tap works before anything else. Small file, huge impact.
3. **`helper/extension/lib/parser.js`** — Read `emptyState()` to understand the full state shape,
   then read `feed()` and `_handleLine()`. This is the state machine everything depends on.
4. **`showdown-ui/electron/main/index.ts`** — Read `handleFrame()`, `writeLog()`, and
   `createWindow()`. This is the primary app entry point and the C5 log path in one place.
5. **`showdown-ui/electron/preload/ps.ts`** (78 lines) — Read the frame relay and drag relay. Short
   file that bridges two execution contexts.
6. **`showdown-ui/electron/preload/index.ts`** (54 lines) — Read the full contextBridge API. This
   is the renderer-main security boundary.
7. **`showdown-ui/src/components/HelperPanel.tsx`** — Read `onFrame()`, `doRender()`, and
   `resync()`. This is the renderer-side hot path and the most complex React component.
8. **`helper/extension/lib/render.js`** — Read `renderBattle()` entry point, then `breakdownCard()`
   and `statRangeBar()`. This is the full UI renderer.
9. **`helper/extension/lib/lookup.js`** — Read `getBreakdown()` and `largestRemainderPct()`. This
   is the prediction engine.
10. **`helper/extension/lib/exporter.js`** — Read `generateBattleLog()` and `renderTurn()`. This
    produces the archived battle files.
11. **`helper/test/parser.test.js`** — Run the test suite and read the tests. They demonstrate the
    exact behavior of the state machine with concrete examples.
12. **`helper/extension/content.js`** — Read `frameHandler()` and `injectPanel()`. Now you
    understand the extension surface.

---

## 15. Final Architecture Summary

### Most Critical Files (Must Understand Before Any PR)

1. `helper/extension/lib/parser.js` — the state machine
2. `showdown-ui/electron/main/index.ts` — the main process
3. `helper/extension/injected.js` — the WebSocket tap
4. `helper/extension/lib/render.js` — the shared renderer
5. `showdown-ui/src/components/HelperPanel.tsx` — the React UI

### Critical Execution Paths

- **Hot path:** `injected.js` → `ps.ts` → `index.ts handleFrame()` → `BattleTracker.feed()` →
  `mainWindow.send` → `HelperPanel.onFrame()` → `doRender()` → `renderBattle()` → DOM update
- **Log-write path:** `handleFrame()` detects end condition → `writeLog()` →
  `generateBattleLog()` → `fs.writeFileSync()`
- **Resync path:** `resync()` → `tracker.reset()` → `getBuffer()` IPC → replay frames →
  `onFrame()` loop
- **Crash-resilience path:** `before-quit`/`uncaughtException` → `flushAllRooms()` →
  `writeLog(INPROGRESS)` × N rooms

### Architectural Strengths

- **Pure shared core:** `parser.js`, `exporter.js`, `render.js`, `lookup.js` have zero dependencies
  on `chrome` or Node APIs. Both surfaces share identical business logic with no forking.
- **Zero-config data loading:** Vite `import.meta.glob` bundles all JSONs at build time. No runtime
  file discovery needed.
- **Crash resilience:** Four exit paths all call `flushAllRooms()`. No battle log is lost unless the
  OS kills the process mid-write.
- **Coalesced rendering:** rAF coalescing prevents DOM thrashing during frame bursts.
- **Layered IPC security:** `contextBridge` enforces that only explicitly exposed `window.psUI`
  methods reach the renderer.
- **CI-enforced sync invariants:** `guards.test.js` asserts that `AD_ANALYTICS_PATTERNS`,
  `render.js` CSS classes, and `injected.js` localhost ports stay in sync across all consumers.

### Architectural Weaknesses

- **Duplicate CSS:** `panel.css` and `global.css` must be kept in sync manually. No build step
  generates both from a shared source.
- **Duplicate ad-block list:** `index.ts` and `app/main.js` both maintain `AD_ANALYTICS_PATTERNS`.
  `guards.test.js` detects divergence but doesn't prevent it.
- **Single-room renderer:** `HelperPanel` only shows the most-recently-active room. Main process
  correctly logs all concurrent rooms.
- **Frozen data bundle:** No automatic staleness detection for `data/*.json` after upstream PS
  changes. Must manually rebuild.
- **Unsigned macOS:** Distribution friction — users must bypass Gatekeeper manually.

---

## 16. Gotchas & Non-Obvious Behaviors

**1. Do NOT add `event.source===window` in `content.js frameHandler()`**  
MAIN→ISOLATED cross-world `postMessage` delivery uses a different window proxy object. The check
silently drops every frame. The failure mode is a completely blank helper panel with no error message.
This is the #1 trap for new developers touching the extension.

**2. Do NOT post to `'*'` in `injected.js`**  
`injected.js` posts `{__psHelper, data}` to `window.location.origin`, not `'*'`. Changing this to
`'*'` is a security regression — it allows any cross-origin iframe to intercept battle frame data.

**3. `ELECTRON_RUN_AS_NODE=1` is set in this shell**  
This environment variable forces Electron to run as plain Node — breaking `app/`. To run `app/`:
`env -u ELECTRON_RUN_AS_NODE ./node_modules/.bin/electron .`. `showdown-ui`'s `npm start`
(electron-vite) handles this correctly and is unaffected.

**4. `render.ts` adapter — do not add rendering logic here**  
`render.ts` only sets `opts.assetBase`. Any rendering feature added here is invisible to the Chrome
extension panel. Always add to `render.js`.

**5. `panel.css` and `global.css` must be manually kept in sync**  
They are separate copies. Adding a CSS class to `render.js` HTML without updating both files causes
the extension panel to have un-styled elements while the Electron panel looks correct (or vice versa).
`guards.test.js` will catch the drift at test time.

**6. `parser.js`, `exporter.js`, `render.js`, `lookup.js` — zero dependencies always**  
Adding any `chrome.*` or Node-only import (`fs`, `path`, `require`) to these files breaks the other
consumer. They must remain importable in both browser extension context AND Node/Electron main process.
ESM only, no CommonJS.

**7. The 15-second no-sim-socket diagnostic is normal during non-battle browsing**  
`injected.js` warns in the console after 15s if no sim socket is seen. This fires on every
non-battle PS page (lobby, user profile, etc.). It is informational only, not an error.

**8. The stall-detection timer fires exactly once per mount**  
The `autoResyncedRef` flag prevents infinite resync loops. If the stall timer fires and `resync()` is
called but frames still don't contain `|init|`/`|request|`, the component stays stuck. This can happen
in very unusual mid-battle disconnect scenarios.

**9. `BattleTracker` is never re-constructed in `HelperPanel` — only `reset()`**  
`trackerRef.current` is created once and persists for the component lifetime. This is intentional:
React re-renders must not create new tracker instances. Constructing a new `BattleTracker` is wrong;
call `tracker.reset()` instead.

**10. `app.isPackaged` changes ALL path roots**  
In dev: `moves.json` from `<repo>/helper/extension/data/`, logs/config to `<repo>/logs|config.json`.
In packaged: `moves.json` from `process.resourcesPath`, logs/config to `~/Documents/ps-local/`. Any
new file access must handle both cases.

**11. `content.js` polls URL every 700ms for room changes**  
PS routes battles via History API — the URL may change without a page navigation. The 700ms poll is
how `content.js` detects room switches. This means there's up to a 700ms delay before the panel
switches to a new battle room.

**12. `manifest.json` localhost ports must match `injected.js`**  
`injected.js` taps `:8000` AND `:8080`. `manifest.json` `host_permissions`, `matches`, and
`web_accessible_resources` must grant both ports. `guards.test.js` asserts this invariant.

**13. `background.js storage.session` is Chrome-only**  
The code null-guards `storage.session` access for non-Chrome browsers. Without it, the frame buffer
does not survive service worker restarts — all replay history is lost on every worker restart.

**14. `testclient-old.html`, not `testclient-new.html`**  
In local mode, `app/` loads `testclient-old.html`. `testclient-new.html` exists in the client
submodule but does not connect even standalone — do not switch to it.

**15. The "Port 8000 EADDRINUSE" warning in local mode is harmless**  
When `app/` spawns the PS server, multiple worker processes race to bind `:8000`. Worker 1 wins;
extras fail with EADDRINUSE. This appears in the logs and looks alarming but is expected behavior
from PS's multi-worker server architecture.

**16. `build-data.js` requires Node ≥22.6 for TypeScript type-stripping**  
Older Node fails with a syntax error on `.ts` imports. The error message does not clearly indicate a
Node version issue. `setup.js` performs a version check, but if you run `build-data.js` directly
without `setup.js`, the version check is skipped.

**17. Only battle rooms are forwarded by `injected.js`**  
`injected.js` only posts frames starting with `>battle-` to the page. Non-battle rooms (lobby, chat,
team builder) are silently dropped. The parser also validates the roomid format on the first line.
