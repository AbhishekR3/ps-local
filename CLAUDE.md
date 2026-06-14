# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this is

**`showdown-ui/` is the primary app** (`npm start`). It wraps the live `https://play.pokemonshowdown.com`
client in a native Electron window with a docked React helper panel, and auto-saves a rich battle log
for every battle. `app/` is the legacy app, kept for the local-mode sandbox and the `PS_SYNTHETIC=1`
CI decoupling test.

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
npm run setup:ui         # install showdown-ui deps (first-time setup)
npm start                # launch showdown-ui — wraps live play.pokemonshowdown.com
npm run build:ui         # production build of showdown-ui

# Packaging (downloadable installers) — run from showdown-ui/:
cd showdown-ui && npm run dist        # build a packaged installer for the current OS (dmg on macOS)
cd showdown-ui && npm run dist:linux  # build the Linux AppImage

npm test                 # helper unit tests (= cd helper && node --test)
cd helper && node --test test/parser.test.js   # run a single test file
npm run apply-overlay    # write overlay/*.js onto the gitignored vendor config/config.js targets
npm run update-upstream  # bump both submodules, rebuild, re-apply overlays, gate on helper tests

# Legacy app/ commands (local sandbox + CI synthetic test only)
npm run start:legacy     # launch app/ in official mode
npm run start:local      # launch app/ in local sandbox mode (PS_SERVER=local; spawns server+static)
```

Rebuild the panel's static data bundle (slow Monte-Carlo; only after an upstream data change):
```bash
cd vendor/pokemon-showdown && npm run build && cd ../..   # build-data needs dist/sim/teams.js first
cd helper && node build-data.js
```

**Runtime env flags:**
- `PS_LOG_LEVEL=DEBUG` — per-frame / per-request logging (works in both `showdown-ui` and `app/`)
- `PS_TIMEZONE=<iana>` — timezone for the "Generated:" timestamp in rich logs (e.g. `America/New_York`)
- `PS_SYNTHETIC=1` — (`app/` only) drive `helper/test/fixtures/sample-battle.txt` through the real log
  path with no server/window/extension, write the log, quit. The C5 decoupling proof for CI.
- `PS_NO_EXTENSION=1` — (`app/` only) skip `loadExtension`

### Environment gotchas
- **Node ≥ 22.6 is required** — `helper/build-data.js` imports `.ts` files via Node type-stripping;
  older Node fails with an unhelpful syntax error.
- **`ELECTRON_RUN_AS_NODE=1` (legacy `app/` only):** this shell forces `ELECTRON_RUN_AS_NODE=1`, which
  makes Electron run as plain Node so `app/` crashes. To run `app/` here, strip it:
  `env -u ELECTRON_RUN_AS_NODE ./node_modules/.bin/electron .` (from `app/`). `showdown-ui` (`npm
  start`) launches via `electron-vite` which handles this correctly.
- **Port 8000 must be free (local mode only).** In local mode `app/` spawns its own server on :8000;
  if another `node pokemon-showdown start` holds it, the server can't bind. The per-launch
  multi-worker `EADDRINUSE` warning in the logs is **harmless** (Worker 1 succeeds; extras fail).

## Architecture

### The logging path (C5 — the #1 deliverable)
The primary path is in `showdown-ui/electron/main/index.ts` + `showdown-ui/electron/preload/ps.ts`.
The legacy `app/preload.js` → `app/main.js` path is identical in contract and kept for `PS_SYNTHETIC=1`
CI testing and local-mode sandbox use only.

**showdown-ui path:**
1. `showdown-ui/electron/preload/ps.ts` runs `helper/extension/injected.js` in the psView's MAIN world
   (`contextIsolation:false`) via `new Function()` — CSP-immune, ahead of SockJS's WebSocket capture.
2. `injected.js` subclasses `window.WebSocket`, decodes SockJS `a[...]` frames, `postMessage`s each
   `>battle-…` frame.
3. The preload relays over `ps-frame` IPC to main.
4. `showdown-ui/electron/main/index.ts` keeps **one `BattleTracker` per room** (`Map<roomid, {tracker,
   rawFrames, lastSeen}>`). On `|win|`/`|tie|`/`|deinit|(turn≥1)` it calls `generateBattleLog` and
   writes to `logs/battle_info/`.
   - **Own battle**: `<roomid>_<p1>_vs_<p2>_WIN_<winner>|TIE_<ts>.{txt,raw.txt}`
   - **Spectator** (`state.mySide === null`): `<roomid>_SPEC_<p1>_vs_<p2>_WIN_<winner>|TIE_<ts>.{txt,raw.txt}`
   - Crash/disconnect: `flushAllRooms()` wired into `before-quit`, `render-process-gone`,
     `uncaughtException` — in-progress battles saved as `INPROGRESS` files.
   - Stale rooms swept every 5 min, evicted after 30 min idle.

### Shared pure libs
`helper/extension/lib/parser.js` (`class BattleTracker`, method **`feed(frame)`** — not `consume`) and
`helper/extension/lib/exporter.js` (`generateBattleLog(state, rawFrames, movesData, timezone='UTC')` — **synchronous**,
result strings `YOU WON`/`YOU LOST`/`TIE`/`IN PROGRESS`) are pure ESM with no chrome/browser APIs. They
are imported by **both** the extension panel and the Electron main process (via dynamic `import()`).
Keep them dependency-free — coupling them to extension or Node-only APIs breaks the other consumer.

### The helper panel
In `showdown-ui/`, the helper panel is a **native React component** (`showdown-ui/src/components/HelperPanel.tsx`)
docked on the right side of the window. It owns a `BattleTracker`, feeds frames relayed from main,
coalesces renders per `requestAnimationFrame`, and renders via `src/lib/render.ts`.

- **Resizable**: drag the divider between the PS view and the panel. The psView is never hidden during
  the drag — the preload relays mouse events through IPC instead.
- **Spectator mode**: `state.mySide === null` when watching; both players' cards render side by side.
  The main process writes spectator logs with the `SPEC_` filename prefix.
- **Legacy extension panel** (`helper/extension/`): a Chrome MV3 extension used only in `app/`.
  `panel.js`/`panel.css` are frozen-legacy; `render.ts` is the canonical helper UI going forward.

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

### Login
In `showdown-ui/` (primary app), log in through the normal Pokémon Showdown UI in the left panel.
Session cookies persist across restarts via the `persist:showdown-ui` Electron session partition.

**Legacy `app/` local-mode login** (kept for `npm run start:local`): `app/preload.js` reads a
testclient sid from `~/Documents/pokemon-showdown-client/config/testclient-key.js` (override with
`PS_TESTCLIENT_KEY_PATH`) and injects it as `window.POKEMON_SHOWDOWN_TESTCLIENT_KEY` so the old client
auto-logs in via action.php. If login loops, the sid is stale — refresh from
`https://play.pokemonshowdown.com/testclient-key.php`.

### Ad / analytics blocking
`app/main.js` installs a session-layer ad blocker in **official mode only**, before the window loads. It uses `session.defaultSession.webRequest.onBeforeRequest` to cancel requests to `AD_ANALYTICS_PATTERNS` — a ~56-entry list covering Venatus (PS's ad orchestrator, `hb.vntsm.com`), Google ad/analytics stack, Microsoft/Bing UET + Clarity, and all prebid bidder partners. A companion `insertCSS` on `did-finish-load` collapses any ad slot that slips through.

`showdown-ui/electron/main/index.ts` mirrors the **identical** blocklist on `session.fromPartition('persist:showdown-ui')` (the `psView`'s partition, not `defaultSession`). Both copies must stay textually in sync — the cross-reference comment in each file names the other. Do **not** factor them into a shared module: `app/` is CommonJS-from-source; `showdown-ui` main is electron-vite-bundled TS, so a cross-build import is fragile.

The blocklist is allow-by-default: only matching hosts are cancelled. It must never match `play.pokemonshowdown.com`/`*.pokemonshowdown.com` (client + CDN fallbacks), `sim*.psim.us` (battle websockets), or `action.php` (login).

To discover new ad domains: `curl -s https://hb.vntsm.com/v4/live/vms/sites/pokemonshowdown.com/index.js` — this is the single orchestrator script PS injects; it lists every prebid partner inline.

### Logging system (C7)
Three cohesive loggers share one line format (`ISO [LEVEL] [ns] msg`), `PS_LOG_LEVEL` threshold, and a
`logs/debug/` sink: `app/logger.js` (runtime → `app-<ts>.log`), `scripts/lib/logger.js`
(orchestration → `<script>-<ts>.log`, plus a `step()` timer`), and an inline logger in
`showdown-ui/electron/main/index.ts` (→ `showdown-ui-<ts>.log`). Battle logs land in `logs/battle_info/`.
For `app/`, the preload routes its logs to main via a `ps-log` IPC channel. When extending any layer,
match the others' format.

### showdown-ui/ — the primary app (replacing `app/`)
`showdown-ui/` is a **standalone Electron + React + TypeScript app** (electron-vite, launched via `npm
run start:ui`) that is **the intended replacement for `app/`**. It provides a native, docked battle
helper alongside the live PS client in one window. It imports the same pure libs from
`helper/extension/lib/` (`parser.js`, `lookup.js`) and the same `helper/extension/data/**` JSON.

`app/` remains in the repo as a fallback but is no longer the primary app. `showdown-ui` is now at
feature parity for all official-mode functionality:

- **Battle log writing (C5)**: `showdown-ui/electron/main/index.ts` runs the full C5 log path —
  per-room `BattleTracker`, `generateBattleLog`, `.txt`/`.raw.txt` output to `logs/battle_info/`,
  SPEC_ prefix for spectator games, `config.saveLogs` guard, `flushAllRooms()` on all exit paths,
  stale-room sweep (5 min), 100K frame hard cap.
- **Config file**: reads `config.json` at repo root (`timezone`, `logLevel`, `saveLogs`). `PS_LOG_LEVEL`
  and `PS_TIMEZONE` env vars override the file. Inline logger writes to `logs/debug/showdown-ui-<ts>.log`.
- **Single-instance lock**: second launch raises the existing window.
- **Crash resilience**: `before-quit`, `window-all-closed`, `render-process-gone`, `uncaughtException`
  all call `flushAllRooms()`.
- **Single cohesive window** (`electron/main/index.ts`): the live `play.pokemonshowdown.com` client is a
  **`WebContentsView`** overlaying the left region; the React **Battle Helper** panel is docked on the
  right. The renderer measures the left region and reports its rect over the `set-game-bounds` IPC; main
  calls `view.setBounds()`. A draggable divider resizes the helper — during the drag the renderer fires
  `begin-resize`/`end-resize` so main relays mouse events from the psView preload instead of hiding it.
- **The PS view uses the proven M5 tap config**: `contextIsolation:false` + `electron/preload/ps.ts`,
  which runs `helper/extension/injected.js` in-world (same as `app/preload.js` official mode). `ps.ts`
  `ipcRenderer.send('ps-frame')` → main drives the log writer **and** forwards to the helper renderer.
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
- **Packaging (`showdown-ui/electron-builder.yml`, `npm run dist`)**: produces downloadable installers
  (`productName: Pokemon Showdown Battle UI`, dmg on macOS / AppImage on Linux). In a **packaged** app
  `__dirname` is inside the asar, so `index.ts` branches on `app.isPackaged`: read-only data
  (`moves.json`) comes from `process.resourcesPath` (shipped via `extraResources`), and writable state
  (logs + `config.json`) goes to `~/Documents/ps-local/`. In dev both collapse to the repo root, so the
  dev path is unchanged. The parser/exporter libs are **statically imported** (hence bundled into
  `out/main/index.js`) rather than dynamically `import()`ed — required so they survive packaging.
  macOS builds are **unsigned** (first launch: right-click → Open, or `xattr -dr com.apple.quarantine`).
  Full phase status: [docs/PACKAGING-PROGRESS.md](docs/PACKAGING-PROGRESS.md).
- **Intentional gaps vs `app/`** (by design, not bugs):
  - No local-mode server / static server / testclient auto-login — official mode only.
  - No `PS_SYNTHETIC=1` headless fixture-feed for CI (only `app/` has this).
  - Only the most-recently-active battle is tracked in the renderer — the main process `rooms` map
    correctly handles concurrent rooms for logging, but the helper panel only shows one at a time.
  - No `PS_NO_EXTENSION=1` flag (no extension to skip — the panel is native).

### Directory ownership
`showdown-ui/` = **primary app** (main, preloads, React renderer, battle log writer) · `helper/` =
WebSocket tap + pure libs (parser, exporter, lookup) + data bundle + tests · `app/` = legacy Electron
app (local-mode sandbox + `PS_SYNTHETIC=1` CI path) · `overlay/` + `scripts/apply-overlay.js` =
config overlays · `scripts/` = orchestration + root `package.json` scripts · `.github/workflows/` = CI
· `docs/` = docs. Full design rationale and contracts (C1–C7 + C-tap) are in
`PS-LOCAL-EXTRACTION-GUIDE.md`.

## When changing things

- **Touching `vendor/`**: don't — use an overlay or the `showdown-ui/`/`helper/` layers. Verify both
  submodules stay git-clean afterward.
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
