# ps-local: Extraction & Implementation Guide

This document is self-contained. It covers everything from creating the new repo to running parallel Claude Code agents to ongoing upstream maintenance. When this chat ends, work from here.

---

## What You're Building

A new public repo (`ps-local`, at `~/Documents/ps-local`) that wraps two official Pokémon Showdown repos as **pristine git submodules** inside an **Electron app** that:

- Runs the official PS server and client locally (all data stays on your machine)
- **Automatically saves a rich battle log** (raw protocol + human-readable analysis) for every battle, with zero per-battle action
- Loads the existing `battle-helper` Chrome extension for its live visual panel
- Detects when upstream changes break your additions via a scheduled CI canary

**The key invariant:** nothing in `vendor/` is ever source-edited. Every layer of customization lives in `overlay/` (config), `app/` (Electron), or `helper/` (extension). Updating upstream is `git submodule update --remote` + rebuild.

> **Public repo note:** This repo will be public and usable by others. Phase 2 (packaging, signing, multi-OS CI) is explicitly deferred — work linked in the Future Work section at the bottom. For now: dev-run only (`npm start`).

---

## Prerequisites

| Tool | Version | Why |
|---|---|---|
| Node.js | ≥ 22.6 | `build-data.js` imports `.ts` files directly via Node's type-stripping; fails silently on older versions |
| npm | ≥ 10 | Workspaces support |
| Git | any modern | Submodule support |
| Electron | ≥ 33 (current stable) | MV3 service-worker support for the extension panel |
| Claude Code CLI | latest | Running parallel worktree agents |
| gh (GitHub CLI) | any | Creating the GitHub repo in one command |

---

## Repository Layout

```
ps-local/
  vendor/
    pokemon-showdown/          # submodule → smogon/pokemon-showdown (server, pristine)
    pokemon-showdown-client/   # submodule → client repo (pristine)
  helper/                      # extracted battle-helper (extension + build-data + tests)
    extension/                 #   loaded unpacked into Electron (panel UI only)
    build-data.js              #   regenerates extension/data/ bundle from server submodule
    test/
  app/                         # Electron: main, preload (log tap), window mgmt
  overlay/
    server-config.js           # → vendor/pokemon-showdown/config/config.js   (gitignored target)
    client-config.js           # → vendor/pokemon-showdown-client/config/config.js (gitignored target)
  scripts/                     # setup, apply-overlay, update-upstream
  logs/                        # default local log output (gitignored)
  .github/workflows/
    test.yml                   # PR/push: helper tests + lint + protocol smoke
    upstream-canary.yml        # scheduled: bump submodules, run smoke, file issue on failure
  docs/
  package.json                 # root orchestrator + workspaces
  .gitignore
  README.md
```

---

## Cross-Workstream Contracts (the seams — do not break these)

Agents code against these. They are what let workstreams run in parallel without colliding.

- **C1 — Server:** `node vendor/pokemon-showdown/pokemon-showdown start 8000` → SockJS at `http://localhost:8000/showdown`
- **C2 — Client:** built client static files served at `http://localhost:8080/`; opened at the new-client entry with `?~~localhost:8000` targeting the local server
- **C3 — Extension (panel only):** lives at `helper/extension/` as a loadable unpacked MV3 extension matching both `localhost:8080/*` and `play.pokemonshowdown.com/*`. Powers the visual panel. **Not on the logging path.**
- **C4 — Overlays:** `scripts/apply-overlay` copies `overlay/server-config.js` → `vendor/pokemon-showdown/config/config.js` and `overlay/client-config.js` → `vendor/pokemon-showdown-client/config/config.js`. Both targets are gitignored *inside their submodules*. **No source file in `vendor/` is ever edited.**
- **C5 — Log capture (decoupled from extension):** Electron **preload** wraps `window.WebSocket` in the renderer and forwards each PS protocol frame via IPC to **main**. Main drives `BattleTracker` (from `helper/extension/lib/parser.js`) + `generateBattleLog` (from `helper/extension/lib/exporter.js`) — both are pure ESM with no extension-API dependencies. Per-room raw `.txt` + rich `.txt` written to `logs/` on `|win|`/`|tie|` or `|deinit|` (turn ≥ 1). Works with the extension completely disabled — this is the contractual test.
- **C6 — One-command entry:** `npm start` → Electron spawns server child (C1), serves client (C2), opens BrowserWindow, registers preload log tap (C5), best-effort `loadExtension('helper/extension')` (C3).

---

## Phase 0 — Seed ✅ COMPLETE (verified 2026-06-06)

**This phase has two goals: create the repo skeleton and validate the two hardest unknowns (server build, client build) before fanning out. If either build is broken here, stop and fix it before proceeding.**

> **STATUS: COMPLETE.** All sub-steps (0a–0g) verified against the actual repo. Three commits present: `9bc13dc` scaffold, `93f5b71` submodules, `5422360` validate builds. Verified facts below correct several assumptions in this guide — **Phase 1 agents must use these, not the inline guesses in the WS prompts.**
>
> **Seed findings (ground truth — overrides conflicting details later in this doc):**
> - **Default branch is `main`, not `master`.** Everywhere this guide says `master` (Phase 0 push, WS5 `test.yml` `branches: [master]`, push commands), use `main`. Remote: `https://github.com/AbhishekR3/ps-local.git`.
> - **Client submodule URL = `smogon/pokemon-showdown-client`** (canonical, not the nicknisi fork). Server = `smogon/pokemon-showdown`.
> - **Server build ✅** — `vendor/pokemon-showdown/dist/sim/teams.js` exists; `node_modules` installed. Build cmd: `npm ci && npm run build`.
> - **Client build ✅** — built via `node build` (the script auto-`npm install`s and auto-creates `config/config.js` from the example if missing). Compiled JS lives in `vendor/pokemon-showdown-client/play.pokemonshowdown.com/js/`.
> - **⚠️ Client static root is the SUBDIRECTORY** `vendor/pokemon-showdown-client/play.pokemonshowdown.com/`, **not** `vendor/pokemon-showdown-client/`. The repo is the full multi-site monorepo (play./replay./teams./pokemonshowdown.com subdirs). WS2's static server and WS4's references must point at the `play.pokemonshowdown.com/` subdir.
> - **Entry point ✅** `testclient-new.html` (in that subdir) accepts `?~~localhost:8000` — confirmed by the parser at line 89–90 of the file (`/\?~~(([^:\/]*)(:[0-9]*)?)/`). So the BrowserWindow URL is `http://localhost:8080/testclient-new.html?~~localhost:8000`.
> - **Overlay targets are gitignored ✅** — `git check-ignore config/config.js` returns the path in BOTH submodules. The overlay pattern (WS3) works cleanly. Both `config/config.js` files already exist (auto-generated during the seed builds).
> - **⚠️ Helper API names differ from the WS prompts:**
>   - `parser.js` → `class BattleTracker` with method **`feed(frame)`** (NOT `consume(line)`). `feed` splits a multi-line frame itself and auto-resets state on a new `>battle-…` roomid, so the WS2 per-room Map is correct — feed each tracker only its own room's frames.
>   - `exporter.js` → **`generateBattleLog(state, rawFrames, movesData)` is synchronous** (no `await` needed; `await` is harmless but the plan implies async).
>   - State shape: `state.mySide` (set only when a `|request|` frame is seen — defaults to `'p1'` otherwise), `state.players[side].name`, `state.winner`, `state.ended`, `state.turn`, `state.tier/formatId/gen/gameType`.
>   - **Result strings are `'YOU WON' / 'YOU LOST' / 'TIE' / 'IN PROGRESS'`** — not `WIN/LOSS`. WS2's filename logic must map these.
> - **⚠️ WS5 smoke assertion is wrong:** the summary section header pushed to the log is `'POKEMON SHOWDOWN BATTLE LOG'`, **not** `'BATTLE SUMMARY'` (that string is only a code comment). Assert `log.includes('POKEMON SHOWDOWN BATTLE LOG')`. The `'TURN-BY-TURN'` assertion is fine (actual text: `'TURN-BY-TURN BATTLE LOG'`). Also fix `tracker.consume` → `tracker.feed` in both workflow YAML blocks.
> - **⚠️ Working-tree note:** `vendor/pokemon-showdown-client` currently shows `M package-lock.json` (touched by `npm install` during the build). This is an install artifact, not a source edit, but it makes the submodule dirty — decide whether to revert it to keep the invariant clean (see Phase 1 open questions).

### 0a. Create the repo

```bash
cd ~/Documents
mkdir ps-local && cd ps-local
git init
gh repo create ps-local --public --source=. --remote=origin --description "Local Pokémon Showdown app with auto battle log export"
```

### 0b. Write .gitignore immediately (before any other commit)

```
logs/
**/config/config.js
helper/.env
helper/extension/data/config.json
node_modules/
dist/
.DS_Store
```

**Why immediately:** the secret-prevention rules must be in `.gitignore` before the first `git add` so they can never accidentally be staged.

### 0c. Scaffold directories and root package.json

```bash
mkdir -p vendor helper app overlay scripts logs docs .github/workflows
touch README.md
```

```json
// package.json (minimal — workstreams will fill in scripts)
{
  "name": "ps-local",
  "version": "0.1.0",
  "private": false,
  "engines": { "node": ">=22.6.0" },
  "scripts": {
    "setup": "echo TODO",
    "start": "echo TODO",
    "update-upstream": "echo TODO"
  }
}
```

```bash
git add .gitignore package.json README.md
git commit -m "chore: repo scaffold with gitignore"
```

### 0d. Add submodules

```bash
git submodule add https://github.com/smogon/pokemon-showdown vendor/pokemon-showdown
git submodule add https://github.com/nicknisi/pokemon-showdown-client vendor/pokemon-showdown-client
# If the client repo URL differs, find the correct one first:
# gh repo view smogon/pokemon-showdown-client
git commit -m "chore: add vendor submodules"
git push origin main
```

> **Note on the client repo:** confirm the URL is correct. The canonical client is at `https://github.com/smogon/pokemon-showdown-client`. If it's a different account, update accordingly.

### 0e. Validate server build

```bash
cd vendor/pokemon-showdown
npm ci
npm run build
# Verify:
ls dist/sim/teams.js          # must exist — build-data.js depends on it
cd ../..
```

### 0f. Validate client build (the unknown — work through it here)

```bash
cd vendor/pokemon-showdown-client
# Read the client's README to find its build command. It's usually:
node build
# or:
./build
# Then serve it and confirm it loads:
npx serve . -p 8080 &
open "http://localhost:8080/testclient-new.html?~~localhost:8000"
# With the server running (from 0e), the client should connect.
# Kill the serve process when done.
cd ../..
```

**Things to watch for here:**
- The client may need `config/config.js` before it builds. Check its `.gitignore` — if `config/config.js` is listed, the overlay pattern works cleanly. If not, you'll need to gitignore it inside the submodule before WS3 runs.
- The `testclient-new.html` may have moved or been renamed. Find the right entry in the client's `index.html` or equivalent.
- The `?~~localhost:8000` targeting param is the client's mechanism for pointing at a local server. Confirm it works.

**If the client build fails, do not proceed to parallel workstreams until it's resolved.** The client-build is WS2's dependency and the most unpredictable piece.

### 0g. Commit seed state

```bash
git add vendor/
git commit -m "chore: validate server and client builds"
git push origin main
```

---

## Phase 1 — Parallel Workstreams

After Phase 0 is committed and pushed, open Claude Code in `~/Documents/ps-local` and launch all six workstreams as parallel worktree agents. Each agent gets an isolated git worktree so they cannot collide on files.

### How to launch worktree agents in Claude Code

In Claude Code, use the **Agent tool with `isolation: "worktree"`**:

```
// In a Claude Code session at ~/Documents/ps-local, send a single message with
// multiple Agent tool calls to launch all workstreams in parallel.
// Each agent works in its own worktree branch and its changes are merged back.
```

Each workstream section below includes:
1. The recommended model + effort level
2. The full agent prompt (copy-paste into the Agent tool's `prompt` field)

---

### WS1 — Extract & Decouple the Helper

**Owns:** `helper/**`  
**Model:** `sonnet` (Sonnet 4.6) | **Effort:** High  
**Why Sonnet High:** well-scoped work (copy files, fix 3 specific coupling points, delete credentials), but the secret hygiene step requires careful attention to detail — getting it wrong ships credentials.

**Agent prompt:**

```
You are implementing WS1 of the ps-local project: extract the battle-helper extension from an existing repo and set it up in this new repo at helper/.

BACKGROUND:
- The current pokemon-showdown repo lives at ~/Documents/pokemon-showdown (a separate directory)
- It has an uncommitted battle-helper/ directory at ~/Documents/pokemon-showdown/battle-helper/
- This is the SOURCE to copy from. Use the working-tree version (uncommitted changes included) — it has the latest parser.js, exporter.js, and panel files
- The destination is helper/ in this repo (~/Documents/ps-local/helper/)

WHAT TO DO:

1. Copy source: cp -r ~/Documents/pokemon-showdown/battle-helper/. helper/
   Do this first before any other step.

2. SECRET HYGIENE — do not skip:
   - Delete helper/.env (contains PS credentials, must not be committed)
   - Delete helper/extension/data/config.json (contains plaintext credentials, must not be committed)
   - Verify .gitignore at repo root already covers both (it should: "helper/.env" and "helper/extension/data/config.json")
   - Open build-data.js and remove the buildConfig() function entirely (it's at the bottom, ~20 lines). Also remove its call site at the bottom of the file. This function reads .env and writes config.json — we do not want it in this new repo.
   - After removing: run "git status" and confirm neither .env nor config.json appears as staged/unstaged files.
   - Run "git ls-files helper/extension/data/config.json" — must return nothing.

3. FIX MANIFEST — helper/extension/manifest.json:
   - content_scripts.matches: add "http://localhost:8080/*" (keep existing https://play.pokemonshowdown.com/*)
   - host_permissions: add "http://localhost:8080/*"
   - web_accessible_resources[0].matches: add "http://localhost:8080/*"
   The extension needs to inject into the local client, not just the public site.

4. FIX build-data.js REPO PATH:
   - Line 20: const REPO = join(HERE, '..'); → const REPO = join(HERE, '..', 'vendor', 'pokemon-showdown');
   The script now points at the vendor submodule instead of the parent directory.

5. UPDATE helper/package.json:
   - Add "engines": { "node": ">=22.6.0" } (build-data.js imports .ts files via Node type-stripping)
   - Keep scripts as-is: "build-data": "node build-data.js", "test": "node --test"

6. VERIFY TESTS PASS:
   cd helper && node --test
   All tests should pass. If any fail due to path assumptions, fix the paths in the test files.

7. COMMIT the generated extension/data/ bundle (minus config.json):
   git add helper/
   git status  -- confirm config.json is NOT listed
   git commit -m "feat(WS1): extract helper, fix manifest for localhost, decouple build-data paths"

WHAT NOT TO TOUCH: vendor/, app/, .github/, overlay/, scripts/
KEY CHECK: after your commit, run "git ls-files helper/ | grep config.json" — must return nothing.
```

---

### WS2 — Electron Shell + Log Writer

**Owns:** `app/**`  
**Model:** `opus` (Opus 4.8) | **Effort:** High  
**Why Opus High:** highest complexity in the project — new Electron architecture, the WebSocket tap + IPC bridge (C5), and a potential fallback path if MV3 service-worker support is incomplete. The core logging path (C5) is the project's #1 deliverable; correctness matters more than speed.

**Agent prompt:**

```
You are implementing WS2 of the ps-local project: the Electron shell, including the auto-save battle log writer.

BACKGROUND:
- This is an Electron app that loads a local Pokémon Showdown client + server
- The existing battle-helper extension lives at helper/extension/ (being set up by a parallel agent in WS1)
- Key architecture contracts this workstream must implement:
  C1: server spawned as child process via "node vendor/pokemon-showdown/pokemon-showdown start 8000"
  C2: built client served from the SUBDIRECTORY vendor/pokemon-showdown-client/play.pokemonshowdown.com/ at http://localhost:8080/; BrowserWindow opens at http://localhost:8080/testclient-new.html?~~localhost:8000
  C3: session.loadExtension('helper/extension') — best-effort, panel UI only
  C5 (CORE): preload wraps window.WebSocket in renderer → IPC → main → parser.js + exporter.js → writes logs to logs/
  C6: npm start launches everything in sequence

IMPLEMENTATION:

Create app/package.json:
{
  "name": "ps-local-app",
  "private": true,
  "main": "main.js",
  "dependencies": {
    "electron": "^33.0.0"
  }
}

Create app/main.js — Electron main process:
- On app ready:
  1. Spawn "node vendor/pokemon-showdown/pokemon-showdown start 8000" as a child process
     Capture stdout/stderr; pipe to console. Manage lifecycle (kill on app quit).
  2. Start a minimal static file server (use Node's http module, not a framework) serving
     vendor/pokemon-showdown-client/play.pokemonshowdown.com/ (the built client SUBDIRECTORY — the
     submodule is the full PS monorepo; the servable client is this subdir) at http://localhost:8080/
  3. Create BrowserWindow with these options:
     - width: 1400, height: 900
     - webPreferences: { preload: path.join(__dirname, 'preload.js'), contextIsolation: true }
  4. After a short delay for server startup, loadURL('http://localhost:8080/testclient-new.html?~~localhost:8000')
     (testclient-new.html is confirmed to parse the ?~~host:port param to target the local server)
  5. session.defaultSession.loadExtension(path.join(__dirname, '../helper/extension'))
     — wrap in try/catch, log if it fails, but do NOT crash. This is best-effort.
  6. Listen for IPC channel 'ps-frame' from renderer (via preload). On each frame:
     - Route to the per-room log accumulator (see below).

Create app/preload.js — WebSocket tap:
- REFERENCE IMPLEMENTATION: port the existing, proven tap at
  helper/extension/injected.js (originally ~/Documents/pokemon-showdown/battle-helper/extension/injected.js).
  Do NOT write a naive `event.data` forwarder — that breaks in three ways the reference already solves:
  1. SOCKJS FRAMING: the socket payload is SockJS-framed, NOT raw PS protocol. Only 'a[...]' frames carry
     data (a JSON array of protocol-message strings); 'o'/'h'/'c' are open/heartbeat/close. You MUST decode:
       function decodeSockJS(raw){ if(raw[0]!=='a') return []; try{ const a=JSON.parse(raw.slice(1)); return Array.isArray(a)?a:[]; }catch{ return []; } }
     Forward each decoded element, not event.data.
  2. URL FILTER: injected.js taps only `url.includes('psim.us') && url.endsWith('/websocket')`. The LOCAL
     server is localhost:8000, so that filter never matches locally. Use a filter that matches BOTH the
     local socket and the public site, e.g.:
       const isSim = typeof url==='string' && url.endsWith('/websocket') && (url.includes('localhost:8000') || url.includes('psim.us'));
  3. REQUEST CAPTURE (this is what fixes state.mySide): the |request| frame arrives inside a
     ">battle-…"-scoped frame. As long as you forward frames whose first line starts with ">battle-",
     request frames flow through and parser._onRequest sets state.mySide + state.myTeam. A raw/unfiltered
     forwarder that doesn't preserve frame boundaries loses this.
- For each decoded frame that startsWith('>battle-'): ipcRenderer.send('ps-frame', { url, data: frame })
  (forwarding the whole multi-line frame string — main hands it straight to tracker.feed()).
- Use contextBridge to expose nothing — ipcRenderer.send is fine since it's only sending, not exposing.
- The tap must install before SockJS evaluates, so preload runs at document_start (Electron default).
  Replicate injected.js's NativeWebSocket-subclass approach (PatchedWebSocket with prototype + static
  constants copied) so the patch is in place before the PS bundle constructs its socket.

Per-room log accumulator in main.js:
- Import (ESM dynamic import or require, whichever Electron's main supports) from:
    ../helper/extension/lib/parser.js  → BattleTracker class
    ../helper/extension/lib/exporter.js → generateBattleLog function
- Maintain a Map: roomid → { tracker: BattleTracker, rawFrames: string[] }
- On each incoming 'ps-frame' IPC message:
  - Parse the PS protocol: frames start with ">roomid\n" or are unscoped (lobby). Extract roomid.
  - VERIFIED API: the method is tracker.feed(frame) — NOT consume(). feed() splits a multi-line frame
    itself and auto-resets state when it sees a new ">battle-…" roomid, so the per-room Map is correct:
    feed each tracker only the frames for its own room.
  - IMPORTANT: forward the whole frame string to feed() (it does its own line splitting). Also make sure
    |request| frames flow through — state.mySide is set ONLY from a |request| frame; without them mySide
    defaults to 'p1' and the rich "YOUR TEAM" section is empty.
  - Push the raw frame to rawFrames
  - On |win|, |tie|, or |deinit| (with tracker.state.turn >= 1):
    call writeLog(roomid, tracker.state, rawFrames)
    then delete the entry from the Map
- writeLog(roomid, state, rawFrames):
  - Ensure logs/ directory exists (mkdirSync recursive)
  - VERIFIED state shape: state.mySide ('p1'|'p2', defaults 'p1'), state.players[side].name, state.winner,
    state.ended, state.turn. Result: derive from state — map exporter's strings to a short tag for the
    filename: ended && winner===myName → WIN; ended && winner && winner!==myName → LOSS; ended && !winner
    → TIE; !ended → INPROGRESS. (myName = state.players[state.mySide]?.name; opponent = the other side's name.)
  - Filename: `${roomid}_${result}_vs_${opponent}_${Date.now()}.txt`
  - Write raw .txt: rawFrames.join('\n')
  - Write rich .txt: generateBattleLog(state, rawFrames, movesData) — VERIFIED SYNCHRONOUS, no await needed
    (movesData: pass null or {} if you haven't wired up data loading yet — exporter handles null gracefully)
  - mySide-NULL POLICY (decided): if no |request| was captured (e.g. spectating), state.mySide stays 'p1'
    and state.myTeam is empty. ALWAYS write the rich log anyway — the exporter degrades gracefully and the
    "YOUR TEAM" section is simply empty/unavailable. Do NOT skip the rich log. (With the corrected preload
    above, request frames are captured for any battle YOU play, so mySide resolves in the normal case.)

MV3 FALLBACK (document in app/README.md but implement only if loadExtension fails):
- If the extension panel never appears (background.js service worker not running), the fallback is:
  Create a second BrowserWindow (or BrowserView) that loads helper/extension/panel.html directly
  as an extension-origin URL. The panel libs are pure and can open their own WebSocket to localhost:8000.
  Do NOT block the logging path on this — logging must work regardless.

CRITICAL TEST — before committing, verify:
  1. Temporarily disable the loadExtension call
  2. npm start → play a battle (or pipe synthetic frames through IPC)
  3. Confirm a file appears in logs/ with the correct content
  4. This proves C5 (logging) is decoupled from C3 (extension)
  Re-enable loadExtension after.

WHAT NOT TO TOUCH: vendor/, helper/ internals, overlay/, scripts/, .github/
```

---

### WS3 — Config Overlays

**Owns:** `overlay/**`, `scripts/apply-overlay.js`  
**Model:** `sonnet` | **Effort:** Medium  
**Why Sonnet Medium:** mostly writing two config files and a copy script. The one trap (verifying gitignore inside submodules) requires reading submodule state, but no complex logic.

**Agent prompt:**

```
You are implementing WS3 of the ps-local project: configuration overlays that point the server and client at localhost without editing any submodule source files.

BACKGROUND:
- vendor/pokemon-showdown/ and vendor/pokemon-showdown-client/ are pristine git submodules
- Both repos have gitignored "config/config.js" — their generated config file
- We write our config to those gitignored paths. The submodules stay clean.
- This is the ONLY mechanism for configuring vendor repos. Never edit vendor/ source files.

VERIFY GITIGNORE FIRST:
  ALREADY VERIFIED during seed: both submodules' `git check-ignore config/config.js` return the path,
  and both config/config.js files already exist (auto-generated by the seed builds). The overlay pattern
  is confirmed clean. Re-run the checks below to be safe before overwriting.
  cd vendor/pokemon-showdown && git check-ignore config/config.js
  cd vendor/pokemon-showdown-client && git check-ignore config/config.js
  Both must print "config/config.js". If either doesn't, the submodule's .gitignore does not cover it —
  you cannot add a gitignore entry to a submodule without editing it. In that case: check if the file is
  listed in the submodule's .gitignore under a different pattern (e.g., "config/"). Document the result
  in overlay/README.md regardless.

CREATE overlay/server-config.js:
  This file will be copied to vendor/pokemon-showdown/config/config.js
  Model it after vendor/pokemon-showdown/config/config-example.js (read that file first).
  Set:
  - exports.port = 8000
  - exports.bindaddress = '0.0.0.0'
  - exports.noguestsecurity = true    (guests can battle without registering — local use)
  - exports.nologin = true            (disable login server integration for local use)
  - exports.autosavereplays = false   (we capture logs in Electron; no need for server-side replay saving)
  - exports.repl = false
  Comment each line: // ps-local overlay — do not edit this file directly, edit overlay/server-config.js
  Read the config-example to find the exact export names (they may differ slightly from above).

CREATE overlay/client-config.js:
  This file will be copied to vendor/pokemon-showdown-client/config/config.js
  Read vendor/pokemon-showdown-client/config/config-example.js first for the exact structure.
  Set:
  - Config.defaultserver = { id: 'localhost', host: 'localhost', port: 8000, ... }
    (or whatever the client's config structure requires for defaultserver)
  Also note: the BrowserWindow will load the URL with ?~~localhost:8000 as a belt-and-suspenders
  targeting mechanism, so the client config is secondary.

CREATE scripts/apply-overlay.js:
  #!/usr/bin/env node
  - Copy overlay/server-config.js → vendor/pokemon-showdown/config/config.js
  - Copy overlay/client-config.js → vendor/pokemon-showdown-client/config/config.js
  - Print "[apply-overlay] server config written" and "[apply-overlay] client config written"
  - No dependencies beyond Node built-ins (fs, path)

ADD to root package.json scripts: "apply-overlay": "node scripts/apply-overlay.js"

VERIFY:
  node scripts/apply-overlay.js
  cat vendor/pokemon-showdown/config/config.js    — should show your config
  cd vendor/pokemon-showdown && git status        — must show CLEAN (config.js is gitignored)
  cd vendor/pokemon-showdown-client && git status — must show CLEAN

COMMIT:
  git add overlay/ scripts/apply-overlay.js package.json
  git commit -m "feat(WS3): server and client config overlays + apply-overlay script"

WHAT NOT TO TOUCH: vendor/ source files, app/, helper/, .github/
```

---

### WS4 — Setup / Build / Update Scripts

**Owns:** `scripts/**` (except apply-overlay, already owned by WS3), root `package.json` script wiring  
**Model:** `sonnet` | **Effort:** High  
**Why Sonnet High:** orchestration scripts need to handle real-world edge cases (missing builds, partial installs, wrong Node version) and the `update-upstream` script is the ongoing maintenance path — bugs here cause silent breakage.

**Agent prompt:**

```
You are implementing WS4 of the ps-local project: setup, build, and update-upstream scripts.

BACKGROUND:
- This is the orchestration layer. Scripts invoke vendor builds and helper tools but never edit vendor source.
- Contracts this workstream must wire up:
  C1/C2: vendor builds produce the server and client outputs consumed by Electron
  C4: apply-overlay (already implemented by WS3) must run after every build
  C6: npm start must be the one-command entry

PREREQUISITES (assume these exist or will exist from parallel workstreams):
- scripts/apply-overlay.js (WS3)
- helper/build-data.js (WS1, optional step)
- app/ (WS2, main.js + package.json)

CREATE scripts/setup.js:
Steps in order:
1. Assert Node >= 22.6.0. If not: print error explaining that build-data.js uses .ts type-stripping
   which requires Node 22.6+, then process.exit(1).
2. console.log('[setup] Initializing submodules...')
   spawnSync('git', ['submodule', 'update', '--init', '--recursive'], { stdio: 'inherit' })
3. console.log('[setup] Installing server deps...')
   spawnSync('npm', ['ci'], { cwd: 'vendor/pokemon-showdown', stdio: 'inherit' })
4. console.log('[setup] Building server...')
   spawnSync('npm', ['run', 'build'], { cwd: 'vendor/pokemon-showdown', stdio: 'inherit' })
   Verify dist/sim/teams.js exists after — if not, print error and exit.
5. console.log('[setup] Building client...')
   VERIFIED: client build cmd is `node build` from cwd vendor/pokemon-showdown-client (package.json
   "build": "node build"). The build outputs compiled JS into the play.pokemonshowdown.com/js/ subdir
   and auto-creates config/config.js from the example if absent.
   PRISTINE-VENDOR NOTE: `node build` runs `npm install` itself if @babel/core isn't resolvable, which
   dirties the submodule's package-lock.json. To honor the "vendor never dirty" invariant, install client
   deps with a lock-preserving `npm ci` FIRST, then run `node build` (it will skip its own install):
     spawnSync('npm', ['ci'], { cwd: 'vendor/pokemon-showdown-client', stdio: 'inherit' })
     spawnSync('node', ['build'], { cwd: 'vendor/pokemon-showdown-client', stdio: 'inherit' })
   After building, assert vendor/pokemon-showdown-client/play.pokemonshowdown.com/js/ exists.
6. console.log('[setup] Applying config overlays...')
   spawnSync('node', ['scripts/apply-overlay.js'], { stdio: 'inherit' })
7. console.log('[setup] Installing helper deps...')
   spawnSync('npm', ['install'], { cwd: 'helper', stdio: 'inherit' })
8. console.log('[setup] Installing app deps...')
   spawnSync('npm', ['install'], { cwd: 'app', stdio: 'inherit' })
9. console.log('[setup] Running helper tests...')
   spawnSync('node', ['--test'], { cwd: 'helper', stdio: 'inherit' })
   If tests fail: print warning but do not exit (tests may fail if WS1 isn't complete yet)
10. Print "[setup] Done. Run: npm start"

Note: do NOT run build-data.js automatically in setup — it takes a while (Monte Carlo simulation).
      Document it as an optional manual step: "cd helper && node build-data.js"

CREATE scripts/update-upstream.js:
Steps:
1. Assert git status is clean: spawnSync('git', ['status', '--porcelain']). If output is non-empty,
   print "Working tree is dirty — commit or stash changes before updating upstream" and exit.
2. console.log('[update] Pulling upstream submodule changes...')
   spawnSync('git', ['submodule', 'update', '--remote', '--merge'], { stdio: 'inherit' })
3. Rebuild server (same as setup steps 3-4)
4. Rebuild client (same as setup step 5)
5. Re-apply overlays (same as setup step 6)
6. Run helper tests (cd helper && node --test) — on failure: print "UPSTREAM BROKE HELPER TESTS"
   with the submodule SHA that was just pulled, then exit 1.
7. Print "[update] Done. Submodules updated to latest upstream."
8. Print a reminder: "Commit the submodule pointer updates: git add vendor/ && git commit -m 'chore: bump submodules to latest upstream'"

UPDATE root package.json scripts:
{
  "setup": "node scripts/setup.js",
  "start": "cd app && npx electron .",
  "update-upstream": "node scripts/update-upstream.js",
  "apply-overlay": "node scripts/apply-overlay.js",
  "test": "cd helper && node --test"
}

COMMIT:
  git add scripts/ package.json
  git commit -m "feat(WS4): setup, update-upstream, and start scripts"

WHAT NOT TO TOUCH: vendor/ source, app/ internals, helper/ internals, .github/, overlay/
```

---

### WS5 — CI/CD

**Owns:** `.github/workflows/**`  
**Model:** `sonnet` | **Effort:** High  
**Why Sonnet High:** GitHub Actions YAML is low-complexity syntactically but bugs are subtle (caching misses, submodule checkout flags, Node version mismatches) and the upstream-canary workflow needs to correctly file issues — a wrong pattern silently fails to alert you.

**Agent prompt:**

```
You are implementing WS5 of the ps-local project: GitHub Actions CI including an upstream canary.

BACKGROUND:
- The repo is at github.com/[your-handle]/ps-local (public)
- Two goals:
  1. test.yml: runs on PR/push, validates helper tests + protocol smoke
  2. upstream-canary.yml: runs on a schedule, bumps submodules to latest, runs smoke, files an issue on failure
- NO headless Electron testing in Phase 1 — too flaky. The smoke test proves the protocol parsing
  pipeline (parser.js + exporter.js), which is the real upstream-breakage surface.

CREATE A FIXTURE for the protocol smoke:
  Look for any existing test fixture in helper/test/ that contains raw PS protocol frames.
  If one exists, use it. If not, create helper/test/fixtures/sample-battle.txt with at minimum:
  - |player|p1|PlayerOne|...|
  - |player|p2|PlayerTwo|...|
  - |turn|1
  - |switch|p1a: Garchomp|Garchomp, L50|356/356
  - |switch|p2a: Gengar|Gengar, L50|262/262
  - |move|p1a: Garchomp|Earthquake|p2a: Gengar
  - |-damage|p2a: Gengar|131/262
  - |turn|2
  - |win|PlayerOne
  This is enough for the smoke: parser consumes it, exporter produces a log, we assert sections exist.
  HYGIENE: use a GENERIC player name (e.g. "PlayerOne"/"PlayerTwo") in this committed fixture, NOT the real
  account name — this is a public repo. Update the |win| target to match. (Not a secret, just avoid
  publishing the real handle.)

CREATE .github/workflows/test.yml:
```yaml
name: test
on:
  push:
    branches: [main]   # VERIFIED: default branch is main, not master
  pull_request:

jobs:
  test:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
        with:
          submodules: recursive
          fetch-depth: 0   # gitleaks needs full history to scan commits

      # Secret scan FIRST — fail fast before doing any other work if a credential leaked.
      # Scans the whole repo history + the PR diff. Free for public repos (no license env needed).
      - name: Secret scan (gitleaks)
        uses: gitleaks/gitleaks-action@v2
        env:
          GITHUB_TOKEN: ${{ secrets.GITHUB_TOKEN }}

      - uses: actions/setup-node@v4
        with:
          node-version: '22'
          cache: 'npm'

      - name: Install helper deps
        run: cd helper && npm install

      - name: Run helper unit tests
        run: cd helper && node --test

      - name: Build server (required for protocol smoke)
        run: cd vendor/pokemon-showdown && npm ci && npm run build

      - name: Protocol smoke test
        run: |
          node --input-type=module <<'EOF'
          import { BattleTracker } from './helper/extension/lib/parser.js';
          import { generateBattleLog } from './helper/extension/lib/exporter.js';
          import { readFileSync } from 'node:fs';

          const frames = readFileSync('./helper/test/fixtures/sample-battle.txt', 'utf8').split('\n');
          const tracker = new BattleTracker();
          for (const line of frames) tracker.feed(line);   // VERIFIED: method is feed(), not consume()
          const log = generateBattleLog(tracker.state, frames, {});
          console.assert(log.includes('POKEMON SHOWDOWN BATTLE LOG'), 'missing summary header'); // VERIFIED actual header
          console.assert(log.includes('TURN-BY-TURN'), 'missing TURN-BY-TURN section');
          console.log('Protocol smoke: PASS');
          EOF
```
  (API verified against parser.js/exporter.js: feed() + synchronous generateBattleLog; the literal
   summary header is 'POKEMON SHOWDOWN BATTLE LOG' — 'BATTLE SUMMARY' is only a code comment.)

CREATE .github/workflows/upstream-canary.yml:
```yaml
name: upstream-canary
on:
  schedule:
    - cron: '0 6 * * 1'  # every Monday at 6am UTC
  workflow_dispatch:       # allow manual trigger

jobs:
  canary:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
        with:
          submodules: recursive
          token: ${{ secrets.GITHUB_TOKEN }}

      - uses: actions/setup-node@v4
        with:
          node-version: '22'

      - name: Bump submodules to upstream latest
        id: bump
        run: |
          git submodule update --remote --merge
          git config user.email "github-actions[bot]@users.noreply.github.com"
          git config user.name "github-actions[bot]"
          SERVER_SHA=$(git -C vendor/pokemon-showdown rev-parse --short HEAD)
          CLIENT_SHA=$(git -C vendor/pokemon-showdown-client rev-parse --short HEAD)
          echo "server_sha=$SERVER_SHA" >> $GITHUB_OUTPUT
          echo "client_sha=$CLIENT_SHA" >> $GITHUB_OUTPUT

      - name: Install and build
        run: |
          cd vendor/pokemon-showdown && npm ci && npm run build
          cd ../../helper && npm install

      - name: Run helper tests
        id: tests
        run: cd helper && node --test
        continue-on-error: true

      - name: Protocol smoke
        id: smoke
        run: |
          node --input-type=module <<'EOF'
          import { BattleTracker } from './helper/extension/lib/parser.js';
          import { generateBattleLog } from './helper/extension/lib/exporter.js';
          import { readFileSync } from 'node:fs';
          const frames = readFileSync('./helper/test/fixtures/sample-battle.txt', 'utf8').split('\n');
          const tracker = new BattleTracker();
          for (const line of frames) tracker.feed(line);   // VERIFIED: feed(), not consume()
          const log = generateBattleLog(tracker.state, frames, {});
          if (!log.includes('POKEMON SHOWDOWN BATTLE LOG')) process.exit(1); // VERIFIED actual header
          if (!log.includes('TURN-BY-TURN')) process.exit(1);
          EOF
        continue-on-error: true

      - name: File issue on failure
        if: steps.tests.outcome == 'failure' || steps.smoke.outcome == 'failure'
        uses: actions/github-script@v7
        with:
          script: |
            const serverSha = '${{ steps.bump.outputs.server_sha }}';
            const clientSha = '${{ steps.bump.outputs.client_sha }}';
            const testsOk = '${{ steps.tests.outcome }}' === 'success';
            const smokeOk = '${{ steps.smoke.outcome }}' === 'success';
            const broken = [];
            if (!testsOk) broken.push('helper unit tests');
            if (!smokeOk) broken.push('protocol smoke');
            await github.rest.issues.create({
              owner: context.repo.owner,
              repo: context.repo.repo,
              title: `[upstream-canary] Breakage detected: ${broken.join(', ')}`,
              body: `## Upstream canary failed\n\n**Broken:** ${broken.join(', ')}\n\n**Submodule SHAs at failure:**\n- pokemon-showdown: \`${serverSha}\`\n- pokemon-showdown-client: \`${clientSha}\`\n\nRun \`npm run update-upstream\` locally to investigate.`,
              labels: ['upstream-breakage']
            });
```

CREATE the label on GitHub (do this after the workflow is pushed):
  gh label create upstream-breakage --color FF0000 --description "Upstream submodule change broke the helper"

COMMIT:
  git add .github/ helper/test/fixtures/
  git commit -m "feat(WS5): CI test + upstream canary workflows"

WHAT NOT TO TOUCH: vendor/, app/, helper/ libs, overlay/, scripts/
```

---

### WS6 — Docs

**Owns:** `README.md`, `docs/**`  
**Model:** `sonnet` | **Effort:** Medium  
**Why Sonnet Medium:** writing, no novel logic. Should run last (or last-to-merge) since it documents what WS1–WS5 actually built.

**Agent prompt:**

```
You are implementing WS6 of the ps-local project: documentation.

NOTE: Run this workstream AFTER WS1–WS5 have merged, or write it based on the plan contracts
and update it during the integration phase. The docs should reflect what actually got built.

WRITE README.md:

# ps-local

Local Pokémon Showdown app with automatic battle log export.

Sections:
1. What this is (2 sentences: local PS + auto-save battle logs for LLM analysis)
2. Architecture diagram (ASCII or mermaid — use the one from this prompt)
3. Prerequisites (Node >= 22.6, Git, npm)
4. Quickstart: git clone + git submodule update --init + npm run setup + npm start
5. How battle logs are saved (where logs/ is, filename format, raw vs rich)
6. Updating to latest upstream: npm run update-upstream
7. Rebuilding the battle data bundle: cd helper && node build-data.js
   (when: after npm run update-upstream if sets/moves data changed)
8. Privacy model: all data local; Electron Chromium has no Google services/telemetry
9. Using against the public site: the extension also injects into play.pokemonshowdown.com
10. Future work (see below)

Architecture diagram (put in README):
  Electron main
    ├─ child: pokemon-showdown server (port 8000)
    ├─ static: pokemon-showdown-client (port 8080)
    ├─ BrowserWindow → localhost:8080
    │     └─ preload.js: WebSocket tap → IPC → main (log writer)
    └─ session.loadExtension(helper/extension) → panel overlay

WRITE docs/UPDATE-WORKFLOW.md:
  Exact steps for: npm run update-upstream, what to do if helper tests fail,
  when to manually re-run build-data.js

WRITE docs/LOG-FORMAT.md:
  Explain raw .txt (verbatim PS protocol frames) vs rich .txt (human-readable sections:
  BATTLE SUMMARY, YOUR TEAM, OPPONENT TEAM, FIELD STATE, TURN-BY-TURN LOG, RAW PROTOCOL, ANALYSIS PROMPT)
  Explain filename format: roomid_RESULT_vs_opponent_timestamp.txt

FUTURE WORK section (add to README):
- [ ] Distribution: Electron packaging, code signing/notarization, auto-update (macOS .dmg, Windows .exe)
- [ ] Multi-OS CI: matrix build on ubuntu/macos/windows
- [ ] Headless Electron smoke test in CI
- [ ] Deeper protocol drift detection: diff sim/SIM-PROTOCOL.md on upstream bumps
- [ ] Log/replay viewer UI inside the app
- [ ] Optional deeper upstream integration detection

COMMIT:
  git add README.md docs/
  git commit -m "docs(WS6): README, update workflow, log format docs"

WHAT NOT TO TOUCH: vendor/, app/, helper/, overlay/, scripts/, .github/
```

---

## Phase 2 — Integration (sequential, after all workstreams merge)

Merge all six worktree branches into main. Resolve any conflicts (there should be none if workstreams respected path ownership). Then:

```bash
cd ~/Documents/ps-local
npm run setup
```

Expected output: submodules init → server builds → client builds → overlays applied → helper tests pass.

Then:
```bash
npm start
```

Expected: Electron opens; server up on 8000; client window loads pointed at localhost; panel appears.

**The contractual proof test (run this before declaring done):**

1. In the Electron app, **disable the extension** (open DevTools → Extensions, disable it)
2. Play one battle to completion against the local server
3. Confirm `logs/<roomid>_WIN/LOSS_vs_opponent_<timestamp>.txt` exists with both raw and rich content
4. Re-enable the extension — panel should appear
5. Open a second battle and confirm no stale data from the first battle appears in the panel

---

## Verification Checklist

- [ ] `git ls-files helper/ | grep config.json` returns nothing
- [ ] `git ls-files helper/ | grep .env` returns nothing
- [ ] `cd vendor/pokemon-showdown && git status` → **clean**
- [ ] `cd vendor/pokemon-showdown-client && git status` → **clean**
- [ ] `npm run setup` succeeds end-to-end
- [ ] `npm start` opens the app and the client loads
- [ ] Battle log is written automatically with extension disabled (C5 decoupling proof)
- [ ] Battle log is written automatically with extension enabled
- [ ] `npm run update-upstream` on a clean tree → submodules bump, rebuilds succeed, `git status` in both vendor dirs shows clean
- [ ] CI `test.yml` green on a PR
- [ ] `upstream-canary.yml` manually triggered → runs without error (or correctly files an issue if a breakage is simulated)

---

## Ongoing Maintenance

### After any upstream update

```bash
npm run update-upstream
# If helper tests fail, the upstream change broke something in parser.js or exporter.js.
# Read the upstream diff: git -C vendor/pokemon-showdown log --oneline ORIG_HEAD..HEAD
# Check sim/SIM-PROTOCOL.md for protocol changes.
```

### After upstream data changes (new Pokémon, moves, sets)

```bash
# Server must be rebuilt first (build-data imports dist/sim/teams.js)
cd vendor/pokemon-showdown && npm run build && cd ../..
cd helper && node build-data.js
# Then commit the regenerated extension/data/ bundle (minus config.json)
git add helper/extension/data/
git commit -m "chore: regenerate helper data bundle from upstream"
```

---

## Things to Keep in Mind Throughout

1. **The invariant:** `vendor/` is never source-edited. If `git status` inside a submodule shows dirty after your work, you have coupled to upstream — back it out.

2. **Node 22.6+ is hard:** `build-data.js` imports `.ts` files via Node's native type-stripping. On Node < 22.6 it fails with a syntax error on the `.ts` import, not a helpful version error. The setup script enforces this, but development machines must also meet it.

3. **The SockJS/WebSocket tap:** PS client uses SockJS, which selects a transport at runtime. On localhost it should resolve to native WebSocket (the preload tap's target), but confirm this when first testing. If frames aren't arriving in `main.js`, the tap isn't firing — SockJS may have fallen back to xhr-polling. Force WebSocket transport by setting a `?transport=websocket` param or adjusting the SockJS client constructor if needed.

4. **MV3 service worker in Electron:** `background.js` runs as a service worker. Electron's support for MV3 service workers has historically been partial. If the panel doesn't appear after `loadExtension`, check the Electron version's release notes for "service worker" or "extension" notes. The fallback (BrowserView loading panel.html directly) is fully documented in WS2.

5. **Secret hygiene (VERIFIED 2026-06-06):** PS credentials were checked against both repos' full git history — neither repo contains them in any commit. The credential lives only in the uncommitted `helper/.env` (working tree), which is gitignored. This repo's history is clean. Never commit `.env`. A CI secret scan (gitleaks) is wired into WS5's `test.yml` to block any future credential from reaching the public repo.

6. **Parallel agents and file ownership:** Worktree agents are isolated at the git level, so they can't accidentally edit each other's files. But the contracts (C1–C6) are the seams — if WS2 changes the IPC channel name, WS5's smoke test will break. Prefer to integrate workstreams incrementally (WS1 first since WS2/WS5 depend on helper libs being present).

7. **Public repo hygiene:** since this is public, review every commit before pushing. `git diff --cached` before `git commit`; `git log --oneline` before `git push`. The `.gitignore` covers the known secrets, but audit for any path additions that weren't planned. **Audit tool-generated files too** — e.g. Codacy's `.codacy/` and `.github/instructions/codacy.instructions.md` are now gitignored and the latter was untracked via `git rm --cached` (kept on disk). Watch for any other local-tooling files (editor configs, analyzer caches) sneaking into commits.

---

## Future Work (Phase 2 — explicitly deferred from Phase 1)

- **Distribution:** Electron packaging (electron-builder), code signing and notarization (macOS), auto-update. Phase 1 is dev-run only.
- **Multi-OS CI:** matrix build on ubuntu/macos/windows-latest once the app is packaged.
- **Headless Electron smoke in CI:** launch + window-loads + synthetic-frame-writes-log. Deferred because xvfb setup adds flake.
- **Deeper protocol drift detection:** pin `sim/SIM-PROTOCOL.md`, diff it on upstream bumps, and alert when the protocol shapes `parser.js` consumes have changed.
- **Log/replay viewer UI** inside the app window.
- **Optional auto-login** for the public site (gitignored `.env` + generated `config.json`) — only if needed.
