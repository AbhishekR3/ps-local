# app/ — Electron shell

The Electron main process that ties the stack together. Implements contracts C1–C3, C5–C7.

## Modes

The app's behavior is governed by `PS_SERVER` (default `official`), surfaced to the preload via
`--ps-mode` in `webPreferences.additionalArguments`:

| Mode | `PS_SERVER` | Window loads | `contextIsolation` | Local server/static |
|---|---|---|---|---|
| official (default) | _(unset)_ | `https://play.pokemonshowdown.com` | `false` | no |
| local | `local` | `http://localhost:8080/testclient-old.html?~~localhost:8000` | `true` | yes |

C1 (spawn server) and C2 (serve static client) only run in **local** mode.

## The WebSocket tap (C5)

The proven tap lives in `helper/extension/injected.js` and patches `window.WebSocket` to decode
SockJS frames. It must run in the page's **MAIN world** before SockJS captures `window.WebSocket`
at module-load time.

**Official mode** (`contextIsolation:false`): the preload shares the page world, so it executes
the tap source directly via `new Function(tapSrc)()` — no DOM `<script>`, so the live site's CSP
can't block it.

**Local mode** (`contextIsolation:true`): the preload's `window` is a separate context, so it
injects the tap as an inline `<script>` into the MAIN world at document_start. It also injects the
testclient sid global so the bundled client auto-logs-in (see [../CLAUDE.md](../CLAUDE.md) Login section).

In both modes, the tap `postMessage`s each `>battle-…` frame; the preload relays those to main over
the `ps-frame` IPC channel. Main keeps one `BattleTracker` per room and writes two files to `logs/`
on `|win|`/`|tie|`/`|deinit|(turn≥1)`. This path is independent of the extension (C3).

`RESULT` ∈ `WIN|LOSS|TIE|INPROGRESS`. All logs also append to `logs/debug/app-<timestamp>.log`.

## The helper panel (C3)

`session.defaultSession.loadExtension(helper/extension)` loads the MV3 extension before the window
opens, so content scripts apply on first page load. The panel:

- **Auto-opens** on page load — `content.js` calls `setVisible(true)` after injecting the iframe
- **Toggle** — Cmd+Shift+H (View → Toggle Helper Panel). `buildMenu()` posts
  `window.postMessage({type:'ps-toggle-panel'})` via `executeJavaScript`; `content.js` calls
  `setVisible(!panelVisible)`
- `PS_NO_EXTENSION=1` skips `loadExtension` entirely (C5 decoupling proof)

The panel is cosmetic — the logging path (C5) is fully independent.

## Env flags

| Flag | Effect |
|---|---|
| `PS_LOG_LEVEL=DEBUG` | per-frame / per-request logging (default `INFO`) |
| `PS_SYNTHETIC=1` | drive `helper/test/fixtures/sample-battle.txt` through the real `ps-frame` path with no server/window/extension, write the log, quit — the C5 decoupling proof |
| `PS_NO_EXTENSION=1` | skip `loadExtension` (prove logging works with the panel off) |
| `PS_SERVER=local` | switch to local sandbox mode |
| `PS_TESTCLIENT_KEY_PATH=<path>` | override testclient sid path (local mode only) |

## Known rough edges

- **Server orphan workers (local mode).** On quit we `SIGTERM` the PS parent (then `SIGKILL` as a
  `process.exit` backstop). PS spawns its own workers; in rare cases a worker may outlive the parent.
  If you see a stale process on `:8000`, kill it manually.
- **SockJS transport.** The tap only sees frames if SockJS negotiates the `websocket` transport.
  Confirm in DevTools → Network that a `…/websocket` connection carries `a[...]` frames. If it falls
  back to xhr-polling, no frames arrive — the most common cause of empty `logs/`.
- **SSL errors in stdout (official mode).** The live PS site loads third-party ad-sync trackers that
  fail with `ERR_CERT_DATE_INVALID` / `ERR_NAME_NOT_RESOLVED`. These are benign noise from the site's
  ad network and don't affect logging or the panel.
