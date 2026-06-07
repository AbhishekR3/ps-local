# app/ — Electron shell

The Electron main process that ties the local stack together:

- **C1** spawns the PS server (`vendor/pokemon-showdown/pokemon-showdown start 8000`) as a child,
  with `ELECTRON_RUN_AS_NODE=1` so Electron's binary runs the server script as plain Node.
- **C2** serves the built client subdir (`vendor/pokemon-showdown-client/play.pokemonshowdown.com/`)
  on `:8080` via a minimal `node:http` server, and opens
  `http://localhost:8080/testclient-new.html?~~localhost:8000`.
- **C3** best-effort `loadExtension(helper/extension)` for the visual panel.
- **C5** the battle-log writer (the project's #1 deliverable) — see below.

## The WebSocket tap (C5)

The proven tap lives in `helper/extension/injected.js` and patches `window.WebSocket` to decode
SockJS frames. It must run in the page's **MAIN world** — with `contextIsolation: true` a preload's
`window` is a different context, so patching it there would do nothing to the page's socket.

So `preload.js` (ISOLATED world, `sandbox: false`) reads `injected.js` and injects it as an inline
`<script>` at document_start; the tap `postMessage`s each decoded frame; the preload relays those to
the main process over the `ps-frame` IPC channel. Main keeps one `BattleTracker` per room, and on
`|win|`/`|tie|`/`|deinit|(turn≥1)` writes two files to `logs/`:

- `<roomid>_<RESULT>_vs_<opponent>_<timestamp>.raw.txt` — verbatim protocol frames
- `<roomid>_<RESULT>_vs_<opponent>_<timestamp>.txt` — `generateBattleLog` rich analysis

`RESULT` ∈ `WIN|LOSS|TIE|INPROGRESS`. This path is independent of the extension (C3) — that is the
contractual test below.

## Env flags

| Flag | Effect |
|---|---|
| `PS_LOG_LEVEL=DEBUG` | verbose per-frame / per-request logging (default `INFO`) |
| `PS_SYNTHETIC=1` | drive `helper/test/fixtures/sample-battle.txt` through the real `ps-frame` path with **no** server/window/extension, write the log, then quit — the C5 decoupling proof |
| `PS_NO_EXTENSION=1` | skip `loadExtension` (run the app with the panel disabled to prove logging still works) |

All logs also append to `logs/debug/app-<timestamp>.log` (format shared with the orchestration
logger — see C7 in the extraction guide).

## Known rough edges / not-yet-implemented

- **MV3 panel fallback (NOT IMPLEMENTED).** The panel rides on an MV3 service worker, whose support
  in Electron is historically partial. If `loadExtension` succeeds but no panel appears, the planned
  fallback is a second `BrowserView` loading `helper/extension/panel.html` directly. Logging never
  depends on this; build it only if first-run verification shows the panel missing.
- **Server orphan workers.** On quit we `SIGTERM` the PS parent (then `SIGKILL` as a `process.exit`
  backstop). PS spawns its own workers; in rare cases a worker may outlive the parent. If you see a
  stale process on `:8000`, kill it manually. Hardening (kill the process group) is deferred.
- **SockJS transport.** The tap only sees frames if SockJS negotiates the `websocket` transport. On
  first run, confirm DevTools → Network shows a `…/websocket` connection carrying `a[...]` frames; if
  it falls back to xhr-polling, no frames arrive (this is the most likely "empty logs" cause).
