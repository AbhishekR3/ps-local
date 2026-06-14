# Packaging — implementation progress

> Companion to [PACKAGING-PLAN.md](PACKAGING-PLAN.md). Tracks what's **done** vs. **remaining** so a
> fresh chat can resume cleanly. The authoritative phase-by-phase spec (with the codebase-verified
> corrections) lives in the approved plan; this file is the running status + the decisions/gotchas that
> were discovered during implementation.

**Goal:** let people download & run the app (`showdown-ui/`) on Linux/Windows/macOS + a downloadable
Chromium extension, each with its own README CI badge. Owner has macOS only → Win/Linux verified in CI.

## Status at a glance

| Phase | What | Status |
|---|---|---|
| 1 | Main-process packaging readiness (static imports + `isPackaged` paths) | ✅ **Done, validated** |
| 2 | electron-builder config + icon + `dist` scripts (local dmg) | ✅ **Done, validated** |
| 3 | `PS_SMOKE` headless self-exit (enables Linux launch smoke) | ⬜ Not started |
| 4 | Linux CI workflow + README badge + Download section | ⬜ Not started |
| 5 | Chromium extension zip workflow + badge | ⬜ Not started |
| 6 | Windows + macOS builds + CI + badges | ⬜ Not started |
| 7 | Docs (CLAUDE.md updates) + optional Releases | ⬜ Not started |

Plus one **UI side-task** done alongside (not part of the packaging plan): opponent stat bars + window
sizing — see "Side changes" below.

## Decisions locked in (carry forward)

- **App name: `Pokemon Showdown Battle UI`** (electron-builder `productName`). dmg/zip/app bundle all use
  it. `appId: com.abhishekr3.ps-local`.
- **Packaged paths**: logs + `config.json` → `~/Documents/ps-local/`; bundled data (`moves.json`) →
  `process.resourcesPath`. Dev unchanged (repo root).
- **macOS: unsigned + one-time unblock** (right-click → Open, or
  `xattr -dr com.apple.quarantine "/Applications/Pokemon Showdown Battle UI.app"`). No Apple Developer ID.
- **Execution cadence: pause at each phase** for the owner's manual validation.
- **Fold the Chromium extension in** as Phase 5 (zip artifact + workflow + badge), with a hard
  credential-leak guard (exclude `data/config.json` + `.env` from the zip).
- **`.gitignore`**: do NOT add `showdown-ui/dist/` — the bare `dist/` rule already ignores it at any
  nesting depth (verified via `git check-ignore`). The plan's "gotcha" claiming otherwise was wrong.

## Phase 1 — done (validated)

`showdown-ui/electron/main/index.ts`:
- Replaced dynamic `import()` of the helper libs with **static top imports** of `BattleTracker`
  (parser.js) + `generateBattleLog` (exporter.js). These now **bundle** into `out/main/index.js`
  (~15.7 KB → ~45 KB; verified `feed(`/`parseDetails`/`generateBattleLog` inlined, zero `pathToFileURL`
  / dynamic helper `import(` left). `externalizeDepsPlugin()` only externalizes bare specifiers, so
  relative imports bundle — this is why the switch is safe.
- Added the `isPackaged` path branch: `DATA_DIR` (= `process.resourcesPath` packaged, else repo root)
  and `USER_ROOT` (= `~/Documents/ps-local/` packaged, else repo root). Repointed `loadConfig()`,
  `logFile()`, `loadMovesData()` accordingly; deleted `loadHelperLibs()`, the module-scope `let`s, the
  `pathToFileURL` import, and the two now-dead `if (!BattleTracker)` / `if (!generateBattleLog)` guards.
- **Verified:** build ok, bundling confirmed, 49/49 helper tests pass, `vendor/pokemon-showdown` clean,
  `npm start` runs, battle log lands in repo-root `logs/battle_info/` (dev path unchanged).

## Phase 2 — done (validated)

- **Icon:** `sips -s format png charizard_logo.jpeg --out showdown-ui/build/icon.png` (512×512 RGB PNG;
  electron-builder generated `icon.icns` fine — the lack of an alpha channel was a non-issue).
  `showdown-ui/build/icon.png` is committed (build input). `charizard_logo.jpeg` kept at repo root.
- **`showdown-ui/electron-builder.yml`** (new): `productName: Pokemon Showdown Battle UI`,
  `appId: com.abhishekr3.ps-local`, `asar: true`, `files: [out/**/*, package.json]`,
  `extraResources: ../helper/extension/data/moves.json → helper/extension/data/moves.json`,
  `linux: { target: [AppImage], category: Game, icon: build/icon.png }`.
- **`showdown-ui/package.json`:** added devDep `electron-builder ^25.1.8`, scripts `dist`
  (`electron-vite build && electron-builder`) + `dist:linux` (`… --linux`), and `description`/`author`
  (silences electron-builder warnings, gives the app metadata).
- **Verified:** `npm run dist` → `dist/Pokemon Showdown Battle UI-0.1.0-arm64.dmg`; `moves.json` shipped
  to `Contents/Resources/helper/extension/data/moves.json` (`extraResources` `to:` ↔ `loadMovesData()`
  tail in sync); owner confirmed install (right-click → Open), helper renders, logs write to
  `~/Documents/ps-local/logs/`, debug log shows `movesData loaded: N moves`.

## Side changes (shipped with this work; NOT part of the packaging plan)

- **Window sizing** (`index.ts` `createWindow()`): replaced `fullscreen: true` with an ordinary window
  sized to `screen.getPrimaryDisplay().workArea` (full width/height, menu bar/dock visible, movable).
  Added `screen` to the electron import. (`screen` is only used post-`whenReady`, which is satisfied.)
- **Opponent stat bars** (`src/lib/render.ts` `statRangeBar` + `src/styles/global.css`): opponent bars
  now read like the player's — solid fill `0→lo` (`<i>`) plus a 40%-opacity range extension `lo→hi`
  (`<u>`), instead of a detached floating sliver. `.stat-bar` is now `display:flex`. `lo === hi` →
  clean solid bar. Player bars (`statBar`) unchanged.

## ⚠️ Carry-forward gotchas for the remaining phases

1. **`productName` has spaces** → the Linux unpacked binary + AppImage are named
   `Pokemon Showdown Battle UI`, **not** `ps-local`. The plan's Phase 4 xvfb smoke command assumed
   `./showdown-ui/dist/linux-unpacked/ps-local`. **Update it** to the spaced name (quote it), e.g.
   `xvfb-run -a env PS_SMOKE=1 timeout 60s "./showdown-ui/dist/linux-unpacked/Pokemon Showdown Battle UI"`.
   Verify the exact path after the first Linux CI run (electron-builder may also slugify it).
2. **macOS Gatekeeper string** in README/docs must use the spaced bundle name:
   `xattr -dr com.apple.quarantine "/Applications/Pokemon Showdown Battle UI.app"`.
3. **`extraResources` ↔ `loadMovesData()` tail** must stay identical
   (`helper/extension/data/moves.json`) — if they drift, the debug log says "movesData not loaded".
4. **Extension zip (Phase 5) must exclude `data/config.json` + `.env`** — `content.js` fetches
   `data/config.json` for auto-login creds. Add the zip-time `-x` excludes **and** an `unzip -l … | grep
   config.json && exit 1` leak-assert.
5. **electron-builder build-time vulns**: `npm install` reported ~12 advisories in electron-builder's
   transitive deps — build tooling only, not shipped in the app. Not a blocker.

## Unrelated cleanup noted (not done — flag only)

- **`showdown-ui/out/` is committed to git** (build output). Should be gitignored before v1.0.0; it
  bloats every diff. Out of scope for the packaging plan; raise as its own change.

## Files added/changed by Phases 1-2 (+ side changes)

| File | Action |
|---|---|
| `showdown-ui/electron/main/index.ts` | static imports, `isPackaged` paths, window sizing |
| `showdown-ui/electron-builder.yml` (new) | targets, extraResources, icon, productName |
| `showdown-ui/package.json` | electron-builder devDep, `dist`/`dist:linux`, description/author |
| `showdown-ui/build/icon.png` (new) | committed app icon (from `charizard_logo.jpeg`) |
| `showdown-ui/src/lib/render.ts` | `statRangeBar` solid-fill + range-extension |
| `showdown-ui/src/styles/global.css` | `.stat-bar` flex + `.stat-bar u` extension style |

## Resume here (next chat)

Start at **Phase 3** in [PACKAGING-PLAN.md](PACKAGING-PLAN.md): add the `PS_SMOKE` env guard in
`whenReady` (after `createWindow()` + `loadMovesData()`):
```ts
if (process.env['PS_SMOKE']) { log.info('PS_SMOKE: boot ok, exiting'); app.exit(0) }
```
Then Phases 4-7. **Apply gotcha #1** (spaced binary name) when writing the Linux CI workflow.
