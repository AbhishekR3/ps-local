# ps-local

[![test](https://github.com/AbhishekR3/ps-local/actions/workflows/test.yml/badge.svg)](https://github.com/AbhishekR3/ps-local/actions/workflows/test.yml)
[![deep-test](https://github.com/AbhishekR3/ps-local/actions/workflows/deep-test.yml/badge.svg)](https://github.com/AbhishekR3/ps-local/actions/workflows/deep-test.yml)
[![upstream-canary](https://github.com/AbhishekR3/ps-local/actions/workflows/upstream-canary.yml/badge.svg)](https://github.com/AbhishekR3/ps-local/actions/workflows/upstream-canary.yml)
[![Codacy Badge](https://app.codacy.com/project/badge/Grade/PROJECT_ID)](https://app.codacy.com/gh/AbhishekR3/ps-local/dashboard)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](LICENSE)

<!-- Codacy: after connecting the repo on codacy.com, replace PROJECT_ID above with the hash from
     Codacy → repo Settings → Badge (otherwise the badge image renders broken). -->

An Electron app that **automatically saves a rich battle log for every battle** — a raw protocol dump
plus a human-readable, LLM-ready analysis — with zero per-battle action. It runs in one of two modes:

- **official** (default): wraps the live `play.pokemonshowdown.com` client, so you play the **real
  ladder against real people** logged into your own account, and every battle is logged locally.
- **local** (`PS_SERVER=local`): an offline sandbox — spawns the bundled PS server + client and plays
  against your own machine. The two upstream repos are wrapped as **pristine git submodules**.

## Architecture

```
Electron main (app/main.js)
  ├─ [local mode only] child process: pokemon-showdown server   (port 8000)
  ├─ [local mode only] static http server: client subdir        (port 8080)
  ├─ BrowserWindow
  │     ├─ official: → https://play.pokemonshowdown.com         (contextIsolation:false)
  │     └─ local:    → http://localhost:8080/testclient-old.html?~~localhost:8000
  │     └─ preload.js: installs the WebSocket tap → postMessage
  │                    → ps-frame IPC → main → BattleTracker + generateBattleLog → logs/
  └─ session.loadExtension(helper/extension)                    (best-effort visual panel; off the logging path)
```

The log writer (the WebSocket tap → parser → exporter → `logs/`) is **independent of the extension** —
battle logs are written even with the panel disabled. The tap matches both `psim.us` (official) and
`localhost` (local).

## Prerequisites

| Tool | Version |
|---|---|
| Node.js | ≥ 22.6 (`build-data.js` imports `.ts` via type-stripping) |
| npm | ≥ 10 |
| Git | any modern (submodules) |

Electron is installed locally by `npm run setup` (no global install needed).

## Quickstart

```bash
git clone <this repo> ps-local && cd ps-local
git submodule update --init --recursive
npm run setup       # builds server + client, applies config overlays, installs deps, runs helper tests
npm start           # launches the Electron app — OFFICIAL mode (live play.pokemonshowdown.com)
npm run start:local # offline sandbox instead (= PS_SERVER=local)
```

> **Note:** `npm run setup` (which builds the PS server/client submodules) is only required for
> `start:local`. Official mode connects directly to the live site and needs no local build.

Log in with your Pokémon Showdown account and play a battle. When it ends (`|win|`/`|tie|`, or you
close the room past turn 1), two files appear in `logs/`.

## How battle logs are saved

For each finished battle, `logs/` gets two files:

```
<roomid>_<RESULT>_vs_<opponent>_<timestamp>.txt        # rich, human/LLM-readable
<roomid>_<RESULT>_vs_<opponent>_<timestamp>.raw.txt    # verbatim PS protocol frames
```

`RESULT` is `WIN | LOSS | TIE | INPROGRESS` (from your perspective — derived from the `|request|` your
client received). The rich `.txt` has sections: battle summary, your team, opponent team (as revealed),
field state, turn-by-turn log, raw protocol, and an LLM analysis prompt. See
[docs/LOG-FORMAT.md](docs/LOG-FORMAT.md).

### Debug logging

Every run also appends structured logs to `logs/debug/` (app run → `app-<ts>.log`, setup/update →
`<script>-<ts>.log`). Set `PS_LOG_LEVEL=DEBUG` for per-frame / per-request detail (useful when no logs
appear — see Troubleshooting). `logs/` is gitignored.

```bash
PS_LOG_LEVEL=DEBUG npm start
```

## The helper panel

When a battle is open, a side panel shows the opponent's Pokémon with predicted sets, stats,
abilities, and tera types. It opens automatically at app start.

- **Toggle**: **Cmd+Shift+H** (or View → Toggle Helper Panel)
- The panel auto-downloads a rich `.txt` log at battle end (same content as the `logs/` file)

## Tests & CI

Two tiers, mirrored locally and in GitHub Actions:

| Tier | Command | What it runs | CI |
|---|---|---|---|
| **Smoke** | `npm run test:smoke` | One fixture battle → parser → exporter; asserts the rich log's section anchors. Fast, exits non-zero on failure. | `test.yml` — every push/PR |
| **Deep** | `npm run test:deep` | Full helper suite: parser, exporter, lookup, integration, **golden-file** comparison, and tie/forfeit/in-progress **edge cases**. | `test.yml` (unit) + `deep-test.yml` |

`deep-test.yml` runs nightly and on-demand (`workflow_dispatch`); on top of the suite it **builds the
bundled PS server** and launches the **real Electron app in `PS_SYNTHETIC` mode under Xvfb** to prove
the end-to-end logging path writes a file (the C5 decoupling proof).

If you intentionally change exporter formatting, refresh the golden:
`node helper/test/golden.test.js --update`.

**Code quality:** [Codacy](https://app.codacy.com/gh/AbhishekR3/ps-local/dashboard) analyzes every
push (grade badge above); the `codacy` workflow also reports findings into the repo's **Security →
Code scanning** tab. Analysis scope is set in [.codacy.yaml](.codacy.yaml) — `vendor/` (upstream
submodules) and generated bundles are excluded.

## Updating to latest upstream

ps-local wraps two official Pokémon Showdown repositories as git submodules:

| Submodule | Path | Upstream |
|---|---|---|
| Server | `vendor/pokemon-showdown` | [smogon/pokemon-showdown](https://github.com/smogon/pokemon-showdown) |
| Client | `vendor/pokemon-showdown-client` | [smogon/pokemon-showdown-client](https://github.com/smogon/pokemon-showdown-client) |

**Never source-edit anything inside `vendor/`.** All customizations are applied via config overlays
(`overlay/`) on top of the pristine submodule checkouts.

To bump both submodules to latest, rebuild, and verify:

```bash
npm run update-upstream    # bumps both submodules, rebuilds, re-applies overlays, runs helper tests
```

If the helper tests fail, an upstream change broke `parser.js`/`exporter.js`; the script prints the
new submodule SHAs so you can pin to the last-known-good commit. A scheduled CI canary
(`.github/workflows/upstream-canary.yml`) runs this weekly and files an `upstream-breakage` issue on
failure. See [docs/UPDATE-WORKFLOW.md](docs/UPDATE-WORKFLOW.md).

## Rebuilding the battle-data bundle

The extension panel ships a static data bundle (`helper/extension/data/`). After an upstream bump that
changed sets/moves/Pokédex, regenerate it (slow — Monte-Carlo over the real team generator):

```bash
cd vendor/pokemon-showdown && npm run build && cd ../..   # build-data needs dist/sim/teams.js
cd helper && node build-data.js
```

## Privacy model

- **official mode** connects to the real Pokémon Showdown servers (you're playing real people), so
  battle traffic and login go to `*.psim.us` / `play.pokemonshowdown.com` as on the normal site. Only
  the **logging** is local — the tap writes your battles to `logs/` on disk; nothing extra is uploaded.
  The site's normal third-party ad trackers load as they would in any browser; they cannot read IPC or
  the `logs/` directory.
- **local mode** plays against your own machine. **One caveat:** the bundled `testclient-old.html`
  loads `config.js` from the public site, and any data file the local build didn't emit falls back to
  fetching from `play.pokemonshowdown.com` (`loadRemoteData`), so first load touches the public site
  for config/data. Battle traffic itself stays local. Fully-offline client is tracked in Future Work.

Electron's bundled Chromium ships without Google account/sync services.

## Troubleshooting

- **No log files after a battle.** Open DevTools console (View → Toggle Developer Tools) and confirm
  the tap is live: `[PSH inject] WebSocket created: … | tapped: true`, then `[PSH inject] battle frame #N`
  during play. If you see `tapped: false`, the sim socket URL didn't match the tap filter; if you see
  the WS in Network → WS carrying non-`a[...]` (non-SockJS) frames, the tap's `decodeSockJS` needs to
  pass them through. Most often, SockJS negotiated `xhr-polling` instead of `websocket` so there was
  no socket to tap. `PS_LOG_LEVEL=DEBUG` shows per-frame counts in `logs/debug/`.
- **Panel not visible.** Press Cmd+Shift+H or use View → Toggle Helper Panel. The panel rides on an
  MV3 service worker; if `loadExtension` fails you'll see a warning in `logs/debug/` — logging is
  unaffected.
- **Login issues (local mode only).** If login loops or the ProxyPopup appears, the testclient sid is
  stale. Refresh it from `https://play.pokemonshowdown.com/testclient-key.php` (while logged in as
  your account), save to `~/Documents/pokemon-showdown-client/config/testclient-key.js`, and restart.

## Future Work (Phase 2 — deferred)

- [ ] Distribution: electron-builder packaging, code signing/notarization, auto-update (.dmg/.exe)
- [ ] Multi-OS CI matrix (ubuntu/macos/windows)
- [x] Headless Electron smoke test in CI (synthetic frame → log file) — `deep-test.yml`
- [ ] Fully-offline client: vendor the data files the client currently fetches remotely
- [ ] Deeper protocol-drift detection: diff `sim/SIM-PROTOCOL.md` on upstream bumps
- [ ] In-app log/replay viewer

## Contributing

See [CONTRIBUTING.md](CONTRIBUTING.md) for local setup, the `vendor/` "never source-edit" rule, how to
run the tests, and what CI expects from a pull request.

## License

[MIT](LICENSE) © Abhishek Ramesh. The wrapped Pokémon Showdown server and client are included only as
git submodules under `vendor/` and remain under their own (MIT) licenses.
