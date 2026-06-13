# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this is

An Electron app that **auto-saves a rich battle log for every battle**. It runs in one of two modes
(`PS_SERVER`, default `official`):
- **official** (default `npm start`): wraps the live `https://play.pokemonshowdown.com` client so you
  play the real ladder against real people, logging into your own account; the WebSocket tap logs
  every battle. No local server/static server is started.
- **local** (`npm run start:local`): the original offline sandbox — spawns the bundled PS server on
  `:8000`, serves the bundled client on `:8080`, and points the testclient at it. Only you are on it.

The two upstream repos are wrapped as **pristine git submodules** under `vendor/` (used by local mode
and by the data/build tooling). See [README.md](README.md) for the user-facing overview and
[docs/](docs/) for log format and the upstream-update workflow.

## The invariant (read this first)

**Nothing in `vendor/` is ever source-edited.** Every customization lives in `overlay/` (config),
`app/` (Electron), or `helper/` (the extracted extension + parser/exporter). If `git -C
vendor/pokemon-showdown status --porcelain` (or the client) is non-empty after your work, you've
coupled to upstream — back it out. Both submodules' `config/config.js` are gitignored; that's the only
file we write inside them, via `apply-overlay`.

## Commands

```bash
npm run setup            # full bootstrap: submodules → build server+client → overlays → deps → tests
npm start                # launch the app, OFFICIAL mode — wraps live play.pokemonshowdown.com
npm run start:local      # launch the app, LOCAL sandbox (= PS_SERVER=local; spawns server + static)
npm test                 # helper unit tests (= cd helper && node --test)
cd helper && node --test test/parser.test.js   # run a single test file
npm run apply-overlay    # write overlay/*.js onto the gitignored vendor config/config.js targets
npm run update-upstream  # bump both submodules, rebuild, re-apply overlays, gate on helper tests

npm run setup:ui         # install showdown-ui deps (the separate native-UI Electron app)
npm run start:ui         # launch showdown-ui (electron-vite dev) — DOES NOT touch app/
npm run build:ui         # production build of showdown-ui
```

Rebuild the panel's static data bundle (slow Monte-Carlo; only after an upstream data change):
```bash
cd vendor/pokemon-showdown && npm run build && cd ../..   # build-data needs dist/sim/teams.js first
cd helper && node build-data.js
```

**Runtime env flags** (see [app/README.md](app/README.md)):
- `PS_LOG_LEVEL=DEBUG` — per-frame / per-request logging
- `PS_SYNTHETIC=1` — drive `helper/test/fixtures/sample-battle.txt` through the real log path with **no
  server/window/extension**, write the log, quit. This is the C5 decoupling proof — use it to verify
  the log writer without playing a battle.
- `PS_NO_EXTENSION=1` — skip `loadExtension` (prove logging works with the panel off)

### Environment gotchas
- **Node ≥ 22.6 is required** — `helper/build-data.js` imports `.ts` files via Node type-stripping;
  older Node fails with an unhelpful syntax error.
- **This shell forces `ELECTRON_RUN_AS_NODE=1`**, which makes Electron run as plain Node so the app
  crashes (`require('electron')` returns a path, `app`/`ipcMain` are undefined). To run the app here,
  strip it: `env -u ELECTRON_RUN_AS_NODE ./node_modules/.bin/electron .` (run from `app/`). A normal
  user terminal doesn't set this — `npm start` works there unmodified, so do **not** add a workaround
  to the start script. `electron --version` under this flag prints the *bundled Node* version, not the
  Electron version.
- **Port 8000 must be free (local mode only).** In local mode the app spawns its own server on :8000;
  if a standalone `node pokemon-showdown start` already holds it, ps-local's server can't bind and the
  window silently attaches to that *other* server (with different config). Stop any standalone server
  first. (Official mode starts no server, so this doesn't apply.) Separately,
  the per-launch multi-worker `EADDRINUSE` warning in the logs — extra socket workers failing to bind
  while Worker 1 succeeds — is **harmless** and unrelated.

## Architecture

### The logging path (C5 — the #1 deliverable)
This is the core flow and spans `app/preload.js` → `app/main.js` → `helper/extension/lib/*`:

1. `app/preload.js` installs the tap (`helper/extension/injected.js`) before the page's sim socket is
   constructed. **How depends on mode** (`--ps-mode`, set by main from `PS_SERVER`):
   - **official** (`contextIsolation:false`): the preload shares the page world, so it runs the tap
     in-world via `new Function(tapSrc)()` and patches `window.WebSocket` directly. No DOM `<script>`
     (the live site's CSP would block one) and ahead of SockJS's load-time `window.WebSocket` capture.
     No testclient-key — the live site logs in natively.
   - **local** (`contextIsolation:true`): the preload's `window` is a *separate* context, so it injects
     the tap as a `<script>` into the page **MAIN world** at document_start instead, and also injects
     the testclient **sid** global for registered-account login (see the Login section below).
2. `injected.js` (the proven tap, shared with the Chrome extension) subclasses `window.WebSocket`,
   decodes SockJS `a[...]` frames, and `postMessage`s each `>battle-…` frame.
3. The preload relays those over the `ps-frame` IPC channel to main.
4. `app/main.js` keeps **one `BattleTracker` per room** (`Map<roomid, {tracker, rawFrames, lastSeen}>`) — `feed()`
   auto-resets on a new `>battle-…` roomid, so a shared tracker would thrash. On `|win|`/`|tie|`/
   `|deinit|(turn≥1)` it calls `generateBattleLog` and writes to `logs/battle_info/`.
   - **Own battle**: `<roomid>_WIN|LOSS|TIE_vs_<opp>_<ts>.{txt,raw.txt}`
   - **Spectator** (`state.mySide === null`): `<roomid>_SPEC_<p1>_vs_<p2>_WIN_<winner>|TIE_<ts>.{txt,raw.txt}`
   - Crash/disconnect: `flushAllRooms()` is wired into `before-quit`, `render-process-gone`, and
     `uncaughtException` so in-progress battles are saved as `INPROGRESS` files on unexpected exit.
   - Stale rooms (disconnected without an end frame) are swept every 5 min and evicted after 30 min idle.

This path is **independent of the extension** (`loadExtension` is best-effort, panel-only). That
decoupling is the contractual test — `PS_SYNTHETIC=1`/`PS_NO_EXTENSION=1` prove it.

### Shared pure libs
`helper/extension/lib/parser.js` (`class BattleTracker`, method **`feed(frame)`** — not `consume`) and
`helper/extension/lib/exporter.js` (`generateBattleLog(state, rawFrames, movesData, timezone='UTC')` — **synchronous**,
result strings `YOU WON`/`YOU LOST`/`TIE`/`IN PROGRESS`) are pure ESM with no chrome/browser APIs. They
are imported by **both** the extension panel and the Electron main process (via dynamic `import()`).
Keep them dependency-free — coupling them to extension or Node-only APIs breaks the other consumer.

### The helper panel (C3)
`helper/extension/` is a Chrome MV3 extension loaded at startup via `session.defaultSession.loadExtension`.
It shows opponent Pokémon breakdowns (predicted sets, stats, abilities, tera) in a right-side overlay.

- **Auto-opens** when the page loads (`content.js` calls `setVisible(true)` after `injectPanel()`).
- **Toggle**: **Cmd+Shift+H** (View → Toggle Helper Panel). `app/main.js`'s `buildMenu()` sets up the
  app menu; the accelerator fires `executeJavaScript("window.postMessage({type:'ps-toggle-panel'},'*')")`,
  which `content.js` relays to `setVisible(!panelVisible)`.
- **No panel download**: the panel no longer triggers a browser file-download. main.js is the sole
  writer; logs go to `logs/battle_info/` automatically.
- **Spectator mode**: when watching someone else's battle, `|request|` never arrives so `state.mySide`
  stays `null`. `panel.js` detects this (`isSpectating(s)`) and renders both players' cards side by
  side labeled with their names. The background service worker buffer (`get-buffer` message) still
  accumulates all frames; main.js writes them under the `SPEC_` filename scheme above.

### Config overlays (C4)
`scripts/apply-overlay.js` copies `overlay/server-config.js` and `overlay/client-config.js` onto the
gitignored vendor `config/config.js` files. The **server** merges its config over `config-example.js`
defaults (`server/config-loader.ts`: `{ ...defaults, ...require(config.js) }`), so the overlay is
minimal — only keys that differ. `nologin`/`autosavereplays` are **not** real keys; `noguestsecurity =
true` was what enabled the old local-guest path (now optional — see Login). The **client** overlay is
secondary: our entry `testclient-old.html` loads `config.js` from the public site and is targeted at the
local server purely by its `?~~localhost:8000` URL param.

### Client static root (local mode only)
The client submodule is the full PS monorepo; the servable client is the **subdir**
`vendor/pokemon-showdown-client/play.pokemonshowdown.com/`. `app/main.js`'s static server and the
window URL point there. We load **`testclient-old.html`** — the rewrite `testclient-new.html` is
experimental and doesn't connect even on the standalone client, so do **not** switch to it. The client's
own `../config/testclient-key.js` `<script>` 404s under our static root (benign — the preload injects
that global instead, see Login), and missing `data/*.js` fall back to fetching from
`play.pokemonshowdown.com` (so first load isn't fully offline — noted in the README privacy section).

### Login — registered-account auth via the testclient sid (local mode only)
In **official** mode you just log in through the live client's normal UI; none of the below applies.
In **local** mode the app logs in as a **registered PS account** against ps-local's *own* spawned
server, the same way the upstream testclient does:
- `app/preload.js` reads a **testclient sid** from `~/Documents/pokemon-showdown-client/config/testclient-key.js`
  (override path with `PS_TESTCLIENT_KEY_PATH`) and injects it as the MAIN-world global
  `window.POKEMON_SHOWDOWN_TESTCLIENT_KEY` — right after the tap, before page scripts. We inject the
  value (rather than placing the file) because under our static root the client's relative
  `../config/testclient-key.js` resolves *inside* `vendor/`, which 404s and would dirty the submodule.
- With that global set, the old client's `storage.js` makes the **real** cross-origin `$.post` to
  `https://play.pokemonshowdown.com/~~localhost:8000/action.php` (sid attached) instead of showing the
  copy/paste ProxyPopup; on connect `upkeep → assertion → /trn` auto-logs-in. action.php is
  CORS-permissive, so this works in Electron with `webSecurity` on.
- The server verifies the assertion against `loginserverpublickey` (inherited from `config-example.js`;
  `legalhosts` unset, so the signed-hostname check is skipped).
- **sid expiry:** if login loops or the ProxyPopup appears, the sid is stale — refresh it from
  `https://play.pokemonshowdown.com/testclient-key.php` (logged in as the account) and restart.
- Timing is safe: the global is set at document_start; `storage.js` reads it during `App.initialize()`.
  Do **not** reintroduce a MAIN-world guest-login bypass in the preload (a removed `inject-localfix.js`
  did this by forcing `/trn name,0,` — it blocks real-account login).

### Logging system (C7)
Two cohesive loggers share one line format (`ISO [LEVEL] [ns] msg`), `PS_LOG_LEVEL` threshold, and a
`logs/debug/` sink: `app/logger.js` (runtime → `app-<ts>.log`) and `scripts/lib/logger.js`
(orchestration → `<script>-<ts>.log`, plus a `step()` timer). Battle logs land in `logs/battle_info/`. The preload routes its logs to main via
a `ps-log` IPC channel so renderer/preload lines land in the same app logfile. When extending either
layer, match the other's format.

### showdown-ui/ — the native-UI alternative client (separate app)
`showdown-ui/` is a **standalone Electron + React + TypeScript app** (electron-vite, launched via `npm
run start:ui`) that replaces the floating extension panel with a **native, docked** battle helper. It is
**completely independent of `app/`** — `npm start` is never affected, so it's a safe sandbox / rollback
target. It imports the same pure libs from `helper/extension/lib/` (`parser.js`, `lookup.js`) and the
same `helper/extension/data/**` JSON, so predictions stay identical to the extension.

- **Single cohesive window** (`electron/main/index.ts`): the live `play.pokemonshowdown.com` client is a
  **`WebContentsView`** overlaying the left region; the React **Battle Helper** panel is docked on the
  right. The renderer measures the left region and reports its rect over the `set-game-bounds` IPC; main
  calls `view.setBounds()`. A draggable divider resizes the helper — during the drag the renderer fires
  `begin-resize`/`end-resize` so main hides the overlay (it would otherwise eat mouse events).
- **The PS view uses the proven M5 tap config**: `contextIsolation:false` + `electron/preload/ps.ts`,
  which runs `helper/extension/injected.js` in-world (same as `app/preload.js` official mode). `ps.ts`
  `ipcRenderer.send('ps-frame')` → **main is now a dumb relay** that forwards every frame to the helper
  renderer over the same `ps-frame` channel.
- **Rendering lives in the renderer, mirroring the extension's `panel.js`**: `HelperPanel.tsx` owns a
  `BattleTracker`, feeds relayed frames, coalesces renders per `requestAnimationFrame`, and renders via
  `src/lib/render.ts` — a **verbatim port of `panel.js`'s HTML builders** (`breakdownCard`, `statBar`,
  `moveChip`, `renderSideHtml`, …) injected with `dangerouslySetInnerHTML`. `src/styles/global.css`
  ports `panel.css`, and `public/icons/categories/*.png` are copied from the extension. **showdown-ui
  is now the canonical helper UI; `panel.js`/`panel.css` (the extension panel) are frozen-legacy and
  may visually lag.** `render.ts` originated as a verbatim port but is intentionally allowed to diverge
  for showdown-ui-only features (no level label, opponent-HP%, ability descriptions, the suppressed
  "1 sets left" badge). Data-layer fixes still flow to both surfaces via the shared `helper/extension/lib`
  (e.g. `lookup.js` percentage rounding + cosmetic-forme fallback). Format data is loaded lazily via Vite
  `import.meta.glob` in `src/lib/data.ts` (mirrors `helper/extension/lib/data.js`).
- **electron-vite gotcha**: 2.x auto-entry detection only scans `src/`, so `electron.vite.config.ts`
  must declare main/preload/renderer entries explicitly. The renderer needs `server.fs.allow` widened to
  the repo root (it imports from `../../../helper/`), and `index.html` must use a **relative** `./src/…`
  script src. `tsconfig.web.json` sets `allowJs` to import the helper's `.js` libs.
- Known gaps (carried, not bugs): the tap relays **all** rooms and `feed()` auto-resets on a new roomid,
  so only the most-recently-active battle is tracked (no foreground-room routing like the extension's
  `content.js`); no battle-log writing; login is manual (official-mode, like `npm start`) but persists
  in showdown-ui's own session partition.

### Directory ownership
`helper/` = extracted extension + `build-data.js` + tests · `app/` = Electron (main, preload, loggers)
· `overlay/` + `scripts/apply-overlay.js` = config overlays · `scripts/` = orchestration + root
`package.json` scripts · `showdown-ui/` = standalone native-UI client (see above), independent of `app/`
· `.github/workflows/` = CI · `docs/` = docs. The full design rationale and contracts (C1–C7 + C-tap)
are in `PS-LOCAL-EXTRACTION-GUIDE.md`.

## When changing things

- **Touching `vendor/`**: don't — use an overlay or the `app/`/`helper/` layers. Verify both submodules
  stay git-clean afterward.
- **The WebSocket tap** (`helper/extension/injected.js`): its `isSim` URL filter must keep matching
  **both** `psim.us` (official mode — the default) **and** `localhost` (local mode) — the C-tap
  contract — or the Electron log writer silently sees nothing on that path. The same file powers the
  extension, the official-mode tap, and the local-mode tap — don't fork it.
- **postMessage origins**: `injected.js` posts to `window.location.origin` (not `'*'`). `content.js`
  posts to the panel iframe using `PANEL_ORIGIN` (derived from `api.runtime.getURL`). `content.js`'s
  `frameHandler` validates `event.origin === location.origin` — do **not** add an `event.source ===
  window` check there (MAIN→ISOLATED world delivery gives a different proxy; it silently drops frames).
  `panel.js` reads the page origin from `?pageOrigin=` in its iframe URL and validates inbound messages.
- **`helper/` secrets**: never commit `helper/.env` or `helper/extension/data/config.json` (both
  gitignored; gitleaks runs in CI). `build-data.js` no longer writes credentials.
- **Upstream bumps**: use `npm run update-upstream`; if helper tests fail, an upstream protocol change
  broke `parser.js`/`exporter.js` — see [docs/UPDATE-WORKFLOW.md](docs/UPDATE-WORKFLOW.md). The weekly
  `upstream-canary` workflow files an `upstream-breakage` issue on failure.
