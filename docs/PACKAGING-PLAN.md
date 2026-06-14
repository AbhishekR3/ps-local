# Packaging plan — downloadable builds + per-OS CI badges

> **Status:** not yet implemented. This is a phased implementation guide.
> Implement **one phase at a time**, validate using the checklist at the end of each phase, then move
> on. Each phase is independently shippable and leaves the repo in a working state.

## Goal

Let users **download and run** the primary app (`showdown-ui/`, Electron 42 + React + electron-vite)
on **Linux, Windows, and macOS**. Build Linux first, then Windows + macOS. Each platform gets its own
README CI badge ("Linux build passing", etc.). The repo owner has only macOS hardware, so Windows and
Linux are built/verified in CI.

## The core problem (read before Phase 1)

`showdown-ui/electron/main/index.ts` computes `REPO_ROOT = join(__dirname, '..', '..', '..')` and at
runtime: (a) dynamically `import()`s `helper/extension/lib/parser.js` + `exporter.js`, (b) reads
`helper/extension/data/moves.json`, (c) reads `config.json`, (d) writes logs to `REPO_ROOT/logs/`.

In a **packaged** app `__dirname` no longer points at the repo, so all four break. The fix:
- **parser.js + exporter.js** → bundle into the main process (static import; their closure is pure —
  `parser→toid`, `exporter→parser→toid`, no `fs`/`__dirname`/`fetch`).
- **moves.json** → ship via electron-builder `extraResources`, read from `process.resourcesPath` when
  packaged. (Already optional: `loadMovesData()` degrades to `{}`.)
- **logs + config** → write to `~/Documents/ps-local/` when packaged; repo root in dev.

**Invariant:** never edit `vendor/`. The `helper/` libs are shared by the extension, the renderer, and
main — do **not** edit the libs; only change *how main consumes* them.

## Confirmed decisions

| Decision | Choice |
|---|---|
| Packaging tool | electron-builder |
| Packaged log/config location | `~/Documents/ps-local/` (dev unchanged: repo root) |
| App icon | `charizard_logo.jpeg` (repo root, 512×512 JPEG) → convert to `showdown-ui/build/icon.png` |
| CI badge meaning | all OSes: build + artifact-exists; **Linux also**: headless `xvfb` launch smoke |
| Distribution | Phase 1: Actions artifacts. GitHub Releases = later follow-up |
| Formats | AppImage (Linux), NSIS (Windows), dmg (macOS, **unsigned**) |

## Gotchas discovered (don't re-learn these)

- `showdown-ui/dist/` and `showdown-ui/build/` are **NOT** gitignored — the root `.gitignore` `dist/`
  rule (line 7) matches only the repo-root `dist/`, not nested. Phase 1 must add `showdown-ui/dist/`.
- `showdown-ui/build/icon.png` is a build **input** → it must be **committed** (not ignored).
- The build needs **no submodules** — packaging consumes only `helper/` + `showdown-ui/` (both in the
  main repo). CI checkout can use `submodules: false` (faster than the existing `recursive`).
- Build jobs need **no `helper` npm install** — parser/exporter are bundled (zero deps) and moves.json
  is plain data.
- electron-builder needs a **PNG** icon (with alpha); a JPEG is rejected — hence the conversion step.
- `showdown-ui/package-lock.json` exists → use `npm ci` in CI and cache on it.
- macOS dmg is unsigned → Gatekeeper blocks it; users right-click → Open (document this in README).
  Signing/notarization need a paid Apple Developer ID — out of scope.

---

# Phase 1 — Main-process packaging readiness (no installer yet)

**Goal:** make `index.ts` work both in dev (repo root) and when packaged, *before* introducing
electron-builder. This phase changes only main-process path resolution + how it loads the helper libs.
After this phase the app still runs identically via `npm run dev`/`npm start`.

### Changes — `showdown-ui/electron/main/index.ts`

1. Replace the dynamic helper-lib loading with **static top imports**:
   ```ts
   import { BattleTracker } from '../../../helper/extension/lib/parser.js'
   import { generateBattleLog } from '../../../helper/extension/lib/exporter.js'
   ```
   Delete `loadHelperLibs()` and its `await loadHelperLibs()` call in `whenReady`. Remove the now-unused
   `pathToFileURL` import if nothing else uses it. (The module-scope `BattleTracker`/`generateBattleLog`
   `let` declarations are replaced by the imports.)

2. Add an `isPackaged` path branch near the top (after the `app` import / existing `REPO_ROOT` line):
   ```ts
   const isPackaged = app.isPackaged
   const REPO_ROOT = join(__dirname, '..', '..', '..')                 // dev only
   const DATA_DIR  = isPackaged ? process.resourcesPath : REPO_ROOT    // base for moves.json
   const USER_ROOT = isPackaged ? join(app.getPath('documents'), 'ps-local') : REPO_ROOT
   const LOGS_DIR  = join(USER_ROOT, 'logs', 'battle_info')            // replaces existing LOGS_DIR
   ```

3. Repoint the three readers/writers to the new bases (keep the path *tails* identical):
   - `loadConfig()` → read `join(USER_ROOT, 'config.json')`.
   - `logFile()` → `mkdirSync`/write under `join(USER_ROOT, 'logs', 'debug', ...)`.
   - `loadMovesData()` → read `join(DATA_DIR, 'helper', 'extension', 'data', 'moves.json')`.
     (The `helper/extension/data/` tail must match the `extraResources` `to:` set in Phase 2.)

### Validation (what the user checks)

- [ ] `cd showdown-ui && npm run build` succeeds with no errors.
- [ ] Inspect `showdown-ui/out/main/index.js` — it should **contain** the parser/exporter code inlined
      (search for a distinctive `BattleTracker` method name). Confirms bundling worked, not externalized.
- [ ] `npm start` (from repo root) launches the app exactly as before; the helper panel renders.
- [ ] Play or spectate a battle → a log file still appears in **`logs/battle_info/`** at the repo root
      (dev mode is unchanged — this proves we didn't break the dev path).
- [ ] `npm test` (helper unit tests) still passes — confirms the shared libs weren't disturbed.
- [ ] `git -C vendor/pokemon-showdown status --porcelain` is empty (vendor untouched).

---

# Phase 2 — electron-builder config + icon + scripts (build artifacts locally)

**Goal:** produce a real installer. On the macOS dev machine this means a `.dmg`; the AppImage is
proven in CI (Phase 4). No CI yet.

### Changes

1. **Icon:** convert the JPEG to PNG and commit it:
   ```bash
   sips -s format png charizard_logo.jpeg --out showdown-ui/build/icon.png
   ```
   Commit `showdown-ui/build/icon.png` (build input). Keep `charizard_logo.jpeg` at repo root.

2. **`.gitignore`:** add `showdown-ui/dist/` (build output). Do **not** ignore `showdown-ui/build/`.

3. **`showdown-ui/package.json`:** add devDep `"electron-builder": "^25"` and scripts:
   ```json
   "dist":       "electron-vite build && electron-builder",
   "dist:linux": "electron-vite build && electron-builder --linux"
   ```
   (`dist` with no flag targets the current platform — handy on the Mac.)

4. **`showdown-ui/electron-builder.yml`** (new):
   ```yaml
   appId: com.abhishekr3.ps-local
   productName: PS Local
   directories:
     output: dist
     buildResources: build
   files:
     - out/**/*
     - package.json
   extraResources:
     - from: ../helper/extension/data/moves.json
       to: helper/extension/data/moves.json
   asar: true
   linux:
     target: [AppImage]
     category: Game
     icon: build/icon.png
   ```

### Validation

- [ ] `cd showdown-ui && npm install` pulls electron-builder cleanly.
- [ ] `npm run dist` produces `showdown-ui/dist/*.dmg` (on macOS).
- [ ] Mount the dmg, drag to Applications, **right-click → Open** (unsigned → Gatekeeper). The app
      launches; helper panel renders; you can log in / load a battle.
- [ ] A battle log now lands in **`~/Documents/ps-local/logs/battle_info/`** (NOT the repo) — this is
      the packaged-path fix from Phase 1 working end to end.
- [ ] `~/Documents/ps-local/logs/debug/showdown-ui-*.log` exists and shows
      "movesData loaded: N moves" (proves `extraResources` shipped `moves.json` and `DATA_DIR`
      resolved). If it says "movesData not loaded", the `extraResources` `to:` and `loadMovesData()`
      tail are out of sync — fix before proceeding.
- [ ] `git status` shows `showdown-ui/dist/` is ignored; `showdown-ui/build/icon.png` is tracked.

---

# Phase 3 — PS_SMOKE headless self-exit (enables the Linux launch smoke)

**Goal:** add a CI-only mode where the app boots, exercises the packaged paths, and exits 0 — so the
Linux CI job can prove the packaged app actually launches (not just builds).

### Changes — `showdown-ui/electron/main/index.ts`

- In `whenReady`, **after** `createWindow()` succeeds and after the moves/libs are in place, add:
  ```ts
  if (process.env['PS_SMOKE']) { log.info('PS_SMOKE: boot ok, exiting'); app.exit(0) }
  ```
  Placement matters: it must run *after* window creation + `loadMovesData()` so the smoke actually
  exercises `DATA_DIR`/lib bundling. (This mirrors the `PS_SYNTHETIC` idea CLAUDE.md notes as missing.)

### Validation

- [ ] Dev: `PS_SMOKE=1 npm start` → app boots briefly and exits with code 0 (check `echo $?`).
- [ ] Without `PS_SMOKE`, `npm start` behaves normally (no early exit).
- [ ] The debug log shows "PS_SMOKE: boot ok, exiting" only when the flag is set.

---

# Phase 4 — Linux CI workflow + README badge + Download section

**Goal:** Linux build is proven in CI on every push/PR, with a green badge, and users can download the
AppImage from the Actions run.

### Changes

1. **`.github/workflows/build-linux.yml`** (new):
   - `name: build-linux`
   - `on: { push: { branches: [main] }, pull_request: {} }` — optional `paths:` filter:
     `showdown-ui/**`, `helper/extension/lib/**`, `helper/extension/data/moves.json`, the workflow file.
   - `runs-on: ubuntu-latest`. Steps:
     1. `actions/checkout@v4` with `submodules: false`.
     2. `actions/setup-node@v4`: node `22`, `cache: npm`,
        `cache-dependency-path: showdown-ui/package-lock.json`.
     3. `cd showdown-ui && npm ci`.
     4. `npm run dist:linux`.
     5. **Artifact assert:** fail if no non-empty `showdown-ui/dist/*.AppImage`
        (e.g. a `bash` step: `ls -la showdown-ui/dist/*.AppImage`).
     6. **xvfb launch smoke:**
        `xvfb-run -a env PS_SMOKE=1 timeout 60s ./showdown-ui/dist/linux-unpacked/ps-local`
        — expect exit 0. (The unpacked binary name follows `productName`; verify it after the first run
        — may be `ps-local` or `PS Local`.)
     7. `actions/upload-artifact@v4`: `showdown-ui/dist/*.AppImage`.

2. **`README.md`:**
   - Add to the badge block (lines 3-7):
     ```
     [![build-linux](https://github.com/AbhishekR3/ps-local/actions/workflows/build-linux.yml/badge.svg)](https://github.com/AbhishekR3/ps-local/actions/workflows/build-linux.yml)
     ```
   - Add a **## Download** section: list OS options (Linux only for now), tell users to grab the
     AppImage from the latest Actions run (Releases coming later), note installed builds save logs to
     `~/Documents/ps-local/logs`.

### Validation

- [ ] Push the branch; `build-linux` workflow runs and goes **green**.
- [ ] The run's Summary has an uploaded AppImage artifact; download it.
- [ ] (If a Linux box is available) the AppImage launches and the helper panel renders. Otherwise the
      green xvfb smoke is the signal.
- [ ] The README badge renders and links to the workflow.
- [ ] A trivial change outside `showdown-ui/`/`helper/` (if `paths:` filter used) does **not** trigger
      the workflow.

---

# Phase 5 — Windows + macOS builds + CI + badges

**Goal:** add the remaining two platforms. Reuses everything from Phases 1-4.

### Changes

1. **`showdown-ui/electron-builder.yml`:** add
   ```yaml
   win:
     target: [nsis]
     icon: build/icon.png
   mac:
     target: [dmg]
     category: public.app-category.games
     icon: build/icon.png
   ```

2. **`showdown-ui/package.json`:** add `"dist:win"` and `"dist:mac"` scripts (mirror `dist:linux`).
   **Root `package.json`:** add passthroughs `dist:ui`, `dist:ui:linux`, `dist:ui:win`, `dist:ui:mac`
   (each `cd showdown-ui && npm run <script>`).

3. **`.github/workflows/build-windows.yml`** + **`build-macos.yml`** (new): same shape as
   `build-linux.yml` but `runs-on: windows-latest` / `macos-latest` and `npm run dist:win` / `dist:mac`.
   Verification = build + artifact-exists assert (`*.exe` / `*.dmg`). **No launch smoke** on these
   (Windows/macOS headless GUI in CI is flaky; Linux carries that signal). Upload artifacts.

4. **`README.md`:** add Windows + macOS badges; expand Download to all three OSes; add the **macOS
   Gatekeeper note** (right-click → Open, or
   `xattr -dr com.apple.quarantine "/Applications/PS Local.app"`).

### Validation

- [ ] `build-windows` and `build-macos` workflows run and go **green**; each uploads its installer.
- [ ] Download the macOS dmg from CI (or build locally with `npm run dist:mac`); install + right-click
      → Open works; logs land in `~/Documents/ps-local/logs`.
- [ ] Download the Windows `.exe` from CI; if a Windows box is available, the NSIS installer runs and
      the app launches (else the green build is the signal).
- [ ] All three badges render in the README.

---

# Phase 6 — Docs + (later) GitHub Releases

**Goal:** record the feature in the project docs; optionally automate releases.

### Changes

1. **`showdown-ui/CLAUDE.md`:** update "## Commands" (`dist*`); add a "## Packaging / Distribution"
   section (electron-builder, `electron-builder.yml`, the `isPackaged` `DATA_DIR`/`USER_ROOT`/`LOGS_DIR`
   branch, `extraResources` for `moves.json`, parser/exporter now **bundled** not dynamically imported,
   `PS_SMOKE`). Update the "No `PS_SYNTHETIC=1` headless mode" known-gap note.
2. **Root `CLAUDE.md`:** add the three build workflows to the CI list and the `dist:ui*` scripts to the
   commands section.
3. **Follow-up (optional, separate change):** `release.yml` triggered on `v*` tags → run the three
   builds and attach all installers to a GitHub Release (electron-builder `--publish` or
   `softprops/action-gh-release`). Then point the README Download section at Releases instead of Actions
   artifacts. (macOS signing + notarization is a separate, larger effort needing a paid Apple
   Developer ID.)

### Validation

- [ ] Docs accurately describe the new scripts/workflows/paths.
- [ ] (If release.yml added) tagging `vX.Y.Z` produces a GitHub Release with all three installers
      attached; README Download links resolve.

---

## Quick reference — files touched

| File | Phase | Action |
|---|---|---|
| `showdown-ui/electron/main/index.ts` | 1, 3 | static imports + `isPackaged` paths; `PS_SMOKE` |
| `charizard_logo.jpeg` → `showdown-ui/build/icon.png` | 2 | convert + commit PNG |
| `.gitignore` | 2 | add `showdown-ui/dist/` |
| `showdown-ui/package.json` | 2, 5 | electron-builder devDep + `dist*` scripts |
| `showdown-ui/electron-builder.yml` (new) | 2, 5 | targets, extraResources, icon |
| `.github/workflows/build-linux.yml` (new) | 4 | Linux build + xvfb smoke + artifact |
| `.github/workflows/build-windows.yml`, `build-macos.yml` (new) | 5 | Win/mac build + artifact |
| `README.md` | 4, 5 | badges + Download section |
| root `package.json` | 5 | `dist:ui*` passthroughs |
| `showdown-ui/CLAUDE.md`, root `CLAUDE.md` | 6 | document packaging |
