# ps-local

Run the official Pokémon Showdown server and client locally in an Electron app that **automatically
saves a rich battle log for every battle** — a raw protocol dump plus a human-readable, LLM-ready
analysis — with zero per-battle action. The two upstream repos are wrapped as **pristine git
submodules**; all customization lives outside `vendor/`.

## Architecture

```
Electron main (app/main.js)
  ├─ child process: pokemon-showdown server            (port 8000)
  ├─ static http server: pokemon-showdown-client       (port 8080, the play.pokemonshowdown.com/ subdir)
  ├─ BrowserWindow → http://localhost:8080/testclient-new.html?~~localhost:8000
  │     └─ preload.js: injects the MAIN-world WebSocket tap → postMessage
  │                    → ps-frame IPC → main → BattleTracker + generateBattleLog → logs/
  └─ session.loadExtension(helper/extension)            (best-effort visual panel; off the logging path)
```

The log writer (the WebSocket tap → parser → exporter → `logs/`) is **independent of the extension** —
battle logs are written even with the panel disabled.

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
npm run setup     # builds server + client, applies config overlays, installs deps, runs helper tests
npm start         # launches the Electron app
```

Play a battle. When it ends (`|win|`/`|tie|`, or you close the room past turn 1), two files appear in
`logs/`.

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

## Updating to latest upstream

```bash
npm run update-upstream    # bumps both submodules, rebuilds, re-applies overlays, runs helper tests
```

If the helper tests fail, an upstream change broke `parser.js`/`exporter.js`; the script prints the new
submodule SHAs. A scheduled CI canary (`.github/workflows/upstream-canary.yml`) runs this weekly and
files an `upstream-breakage` issue on failure. See [docs/UPDATE-WORKFLOW.md](docs/UPDATE-WORKFLOW.md).

## Rebuilding the battle-data bundle

The extension panel ships a static data bundle (`helper/extension/data/`). After an upstream bump that
changed sets/moves/Pokédex, regenerate it (slow — Monte-Carlo over the real team generator):

```bash
cd vendor/pokemon-showdown && npm run build && cd ../..   # build-data needs dist/sim/teams.js
cd helper && node build-data.js
```

## Privacy model

The server and client run on your machine and battles are played against your local server. **One
caveat:** our entry point `testclient-new.html` loads `config.js` from the public site
(`https://play.pokemonshowdown.com/config/config.js`), and if the local client build is missing any
data file the client falls back to fetching it from `play.pokemonshowdown.com` (`loadRemoteData`). So
first load currently touches the public site for config/data. Battle traffic itself stays local. To
verify, watch DevTools → Network for any `play.pokemonshowdown.com` requests; making the client fully
offline is tracked in Future Work.

Electron's bundled Chromium ships without Google account/sync services.

## Using against the public site

The `helper/extension` panel also matches `https://play.pokemonshowdown.com/*`, so the same visual panel
works on the real site (the local-only auto-login was intentionally removed). The Electron log writer
only taps the local server.

## Troubleshooting

- **No log files after a battle.** Most likely the SockJS socket negotiated `xhr-polling` instead of
  `websocket`, so the tap saw nothing. Open DevTools → Network → WS and confirm a `…/websocket`
  connection carrying `a[...]` frames. `PS_LOG_LEVEL=DEBUG` shows per-frame counts in `logs/debug/`.
- **No panel.** The panel rides on an MV3 service worker; Electron's support is partial. Logging is
  unaffected. A `BrowserView` fallback is noted in [app/README.md](app/README.md) but not yet built.

## Future Work (Phase 2 — deferred)

- [ ] Distribution: electron-builder packaging, code signing/notarization, auto-update (.dmg/.exe)
- [ ] Multi-OS CI matrix (ubuntu/macos/windows)
- [ ] Headless Electron smoke test in CI (synthetic frame → log file)
- [ ] Fully-offline client: vendor the data files the client currently fetches remotely
- [ ] Deeper protocol-drift detection: diff `sim/SIM-PROTOCOL.md` on upstream bumps
- [ ] In-app log/replay viewer
- [ ] MV3 panel `BrowserView` fallback
