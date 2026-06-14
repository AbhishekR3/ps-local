# ps-local

[![test](https://github.com/AbhishekR3/ps-local/actions/workflows/test.yml/badge.svg)](https://github.com/AbhishekR3/ps-local/actions/workflows/test.yml)
[![deep-test](https://github.com/AbhishekR3/ps-local/actions/workflows/deep-test.yml/badge.svg)](https://github.com/AbhishekR3/ps-local/actions/workflows/deep-test.yml)
[![upstream-canary](https://github.com/AbhishekR3/ps-local/actions/workflows/upstream-canary.yml/badge.svg)](https://github.com/AbhishekR3/ps-local/actions/workflows/upstream-canary.yml)
[![Codacy Badge](https://app.codacy.com/project/badge/Grade/fe47edfc301e4964990f676c9a1c8125)](https://app.codacy.com/gh/AbhishekR3/ps-local/dashboard?utm_source=gh&utm_medium=referral&utm_content=&utm_campaign=Badge_grade)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](LICENSE)

An Electron app that **automatically saves a rich battle log for every battle** — a raw protocol dump
plus a human-readable breakdown — with zero per-battle action. Play on the live
`play.pokemonshowdown.com` ladder in a native docked window with an integrated battle helper panel that
shows the opponent's predicted sets, stats, abilities, and Tera types live.

## Architecture

```
showdown-ui/electron/main/index.ts
  ├─ BrowserWindow (React helper panel — right side)
  │     └─ preload/index.ts: exposes psUI API to renderer
  ├─ WebContentsView (psView — left side, live play.pokemonshowdown.com)
  │     └─ preload/ps.ts: installs WebSocket tap → postMessage → ps-frame IPC
  ├─ main: receives ps-frame → BattleTracker + generateBattleLog → logs/battle_info/
  └─ session ad-block: cancels ~55 ad/analytics domains before they leave the machine
```

The log writer (tap → parser → exporter → `logs/`) runs in the Electron main process. The React helper
panel renders opponent breakdowns (predicted sets, stats, abilities, tera) in the renderer. Both use the
same shared pure libs from `helper/extension/lib/`.

## Prerequisites

| Tool | Version |
|---|---|
| Node.js | ≥ 22.6 (`build-data.js` imports `.ts` via type-stripping) |
| npm | ≥ 10 |
| Git | any modern (submodules) |

Electron is installed locally as a dev dependency in `showdown-ui/` (no global install needed).

## Quickstart

```bash
git clone <this repo> ps-local && cd ps-local
npm run setup:ui    # install showdown-ui dependencies
npm start           # launch the app — connects to live play.pokemonshowdown.com
```

Log in with your Pokémon Showdown account and play a battle. When it ends (`|win|`/`|tie|`, or you
close the room past turn 1), two files appear in `logs/battle_info/`.

## Download

Prefer a ready-to-run app over building from source? Package an installer with electron-builder:

```bash
npm run setup:ui                  # one-time: install showdown-ui deps
cd showdown-ui && npm run dist    # → dist/Pokemon Showdown Battle UI-<ver>-<arch>.dmg (current OS)
cd showdown-ui && npm run dist:linux   # → Linux AppImage
```

> **macOS (unsigned).** The build isn't code-signed, so Gatekeeper blocks the first launch. After
> dragging the app to Applications, **right-click → Open** once (or run
> `xattr -dr com.apple.quarantine "/Applications/Pokemon Showdown Battle UI.app"`). It opens normally
> afterward. A signed/notarized build needs a paid Apple Developer ID and is out of scope for now.

Installed builds save logs and read `config.json` from `~/Documents/ps-local/` (not the repo). Pre-built
downloadable installers + per-OS CI badges (Linux/Windows/macOS) and a downloadable Chromium extension
are in progress — see [docs/PACKAGING-PROGRESS.md](docs/PACKAGING-PROGRESS.md).

## How battle logs are saved

For each finished battle, `logs/battle_info/` gets two files:

```
<roomid>_<p1>_vs_<p2>_WIN_<winner>_<timestamp>.txt        # rich, human-readable
<roomid>_<p1>_vs_<p2>_WIN_<winner>_<timestamp>.raw.txt    # verbatim PS protocol frames
```

Result tokens: `WIN_<winner>` · `TIE` · `INPROGRESS` (crash/disconnect). Spectated battles get a
`SPEC_` prefix. The rich `.txt` has sections: battle summary, teams, field state, turn-by-turn log, and
raw protocol. See [docs/LOG-FORMAT.md](docs/LOG-FORMAT.md).

### Debug logging

Every run appends structured logs to `logs/debug/showdown-ui-<ts>.log`. Set `PS_LOG_LEVEL=DEBUG` for
per-frame detail (useful when no logs appear — see Troubleshooting).

```bash
PS_LOG_LEVEL=DEBUG npm start
```

## The helper panel

When a battle is open, the right-side panel shows the opponent's Pokémon with predicted sets, stats,
abilities, and Tera types. It updates live as the battle progresses.

- **Resizable**: drag the divider between the game and the panel
- **Opens automatically** when the app starts

## Tests & CI

The helper suite (parser, exporter, lookup, integration, golden-file, edge cases) is the single test
gate, mirrored locally and in CI:

| Command | What it runs | CI |
|---|---|---|
| `npm test` | Full helper suite (`cd helper && node --test`). | `test.yml` — every push/PR |
| `npm run test:smoke` | One fixture battle → parser → exporter; asserts section anchors. Fast. | `test.yml` — every push/PR |
| `cd helper && node --test test/parser.test.js` | A single test file. | — |

The nightly `deep-test.yml` workflow runs the same helper suite, then additionally builds the bundled PS
server and launches the legacy Electron app (`app/`) in `PS_SYNTHETIC` mode to prove the end-to-end
logging path (the C5 decoupling proof). If you intentionally change exporter formatting, refresh the
golden: `node helper/test/golden.test.js --update`.

**Code quality:** [Codacy](https://app.codacy.com/gh/AbhishekR3/ps-local/dashboard) analyzes every
push; the `codacy` workflow reports findings into Security → Code scanning. `vendor/` and generated
bundles are excluded.

## Updating to latest upstream

ps-local wraps two official Pokémon Showdown repositories as git submodules:

| Submodule | Path | Upstream |
|---|---|---|
| Server | `vendor/pokemon-showdown` | [smogon/pokemon-showdown](https://github.com/smogon/pokemon-showdown) |
| Client | `vendor/pokemon-showdown-client` | [smogon/pokemon-showdown-client](https://github.com/smogon/pokemon-showdown-client) |

**Never source-edit anything inside `vendor/`.** All customizations are applied via config overlays
(`overlay/`) on top of pristine submodule checkouts.

```bash
npm run update-upstream    # bumps both submodules, rebuilds, re-applies overlays, runs helper tests
```

If the helper tests fail, an upstream change broke `parser.js`/`exporter.js`. A scheduled CI canary
(`.github/workflows/upstream-canary.yml`) runs this weekly and files an `upstream-breakage` issue on
failure. See [docs/UPDATE-WORKFLOW.md](docs/UPDATE-WORKFLOW.md).

## Rebuilding the battle-data bundle

After an upstream bump that changes sets/moves/Pokédex, regenerate the static data bundle (slow —
Monte-Carlo over the real team generator):

```bash
cd vendor/pokemon-showdown && npm run build && cd ../..
cd helper && node build-data.js
```

## Privacy model

- Battle traffic and login go to `*.psim.us` / `play.pokemonshowdown.com` as on the normal site. Only
  the **logging** is local — the tap writes your battles to `logs/battle_info/` on disk; nothing extra
  is uploaded.
- Third-party ad and analytics requests (Google, Microsoft/Bing, Venatus/Playwire, ~50 prebid partners)
  are **cancelled at the Electron session layer** before they leave the machine. PS is MIT-licensed, so
  this is permitted.

Electron's bundled Chromium ships without Google account/sync services.

## Troubleshooting

- **No log files after a battle.** Open DevTools (Electron menu → View → Toggle Developer Tools) and
  confirm the tap is live: `[PSH inject] WebSocket created: … | tapped: true`, then
  `[PSH inject] battle frame #N` during play. If you see `tapped: false`, the sim socket URL didn't
  match the tap filter. `PS_LOG_LEVEL=DEBUG npm start` shows per-frame counts in `logs/debug/`.
- **Login issues.** Log in through the normal Pokémon Showdown UI in the left panel. Session persists
  across restarts via the `persist:showdown-ui` Electron session partition.

## Contributing

See [CONTRIBUTING.md](CONTRIBUTING.md) for local setup, the `vendor/` "never source-edit" rule, how to
run the tests, and what CI expects from a pull request.

## Features

### Battle Logging
- **Automatic logging**: every battle is logged with zero per-battle action
- **Rich format**: human-readable sections (summary, teams, field state, turn log) plus raw protocol
- **Spectator support**: logs opponent battles when you're spectating

### Helper Panel
- **Live opponent analysis**: predicted Pokémon sets, stats, abilities, and Tera types
- **Real-time updates**: panel refreshes as the battle progresses
- **Resizable**: drag the divider to allocate screen space

### Quality & Testing
- **Smoke tests**: quick validation on every push
- **Deep tests**: comprehensive suite including golden-file comparison and edge cases
- **Upstream canary**: weekly compatibility check, auto-files issues on breaking changes
- **Code quality**: Codacy analysis on every push with public dashboard

## Advanced Usage

### Environment Variables
```bash
PS_LOG_LEVEL=DEBUG    # Enable detailed per-frame logging
PS_TIMEZONE=...       # IANA timezone for "Generated:" timestamps in logs (default UTC)
```

Config file (`config.json` at repo root, gitignored — see `config.example.json`):
```json
{ "timezone": "America/New_York", "logLevel": "INFO", "saveLogs": true }
```

### Directory Structure
```
showdown-ui/      → Primary Electron app (React helper panel + live PS client)
  electron/
    main/         → Main process: log writer, IPC, ad blocking, window management
    preload/      → index.ts (helper API bridge) + ps.ts (WebSocket tap)
  src/            → React renderer (HelperPanel, render.ts, styles)
helper/           → WebSocket tap + parser + exporter + data bundle + tests
  extension/lib/  → parser.js (BattleTracker), exporter.js, lookup.js — pure shared libs
  extension/data/ → Static battle-data bundle (sets, moves, abilities)
overlay/          → Config overlays applied to vendor submodules
vendor/           → Pristine git submodules (never source-edit)
  ├─ pokemon-showdown/
  └─ pokemon-showdown-client/
app/              → Legacy Electron app (kept for local-mode sandbox and CI synthetic test)
logs/
  ├─ battle_info/ → Battle logs (.txt + .raw.txt)
  └─ debug/       → Debug logs
scripts/          → Build and orchestration utilities
docs/             → Documentation (log format, update workflow, design rationale)
```

## Roadmap

See [BACKLOG.md](BACKLOG.md) for active work and long-term plans.

## Credits

**ps-local** builds on the excellent open-source work of the **Pokémon Showdown team**:

- **[pokemon-showdown](https://github.com/smogon/pokemon-showdown)** — the competitive Pokémon simulator server powering the entire platform.
- **[pokemon-showdown-client](https://github.com/smogon/pokemon-showdown-client)** — the web client that makes Showdown accessible and enjoyable.

Both projects are published under the MIT license. ps-local adds **local logging and analysis** on top
of this foundation — the core battle simulation, protocol, and UI remain the Showdown team's work.

**Special thanks** to the Showdown community for maintaining such a robust, open platform for Pokémon
competitive play.

## License

[MIT](LICENSE) © Abhishek Ramesh. The wrapped Pokémon Showdown server and client are included only as
git submodules under `vendor/` and remain under their own (MIT) licenses.
