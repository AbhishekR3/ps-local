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
| 3 | `PS_SMOKE` headless self-exit (enables Linux launch smoke) | ✅ **Done, validated locally** |
| 4 | Linux CI workflow + README badge + Download section | ✅ **Done — green run pending push** |
| 5 | Chromium extension zip workflow + badge | ✅ **Done, validated locally** |
| 6 | Windows + macOS builds + CI + badges | ✅ **Done — green runs pending push** |
| 7 | Docs (CLAUDE.md updates) | ✅ **Done** |

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
   `Pokemon Showdown Battle UI`, **not** `ps-local`. `build-linux.yml`'s xvfb smoke already uses the
   quoted spaced name (`xvfb-run -a env PS_SMOKE=1 "showdown-ui/dist/linux-unpacked/Pokemon Showdown
   Battle UI" --no-sandbox`). **Still verify the exact path after the first Linux CI run** —
   electron-builder may slugify the `linux-unpacked` dir; if so, fix the path in the workflow.
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

## Phases 3-6 — done (Phase 3 + 5 validated locally; 4 + 6 build/smoke pending the owner's push)

- **Phase 3 (`PS_SMOKE`):** added `if (process.env['PS_SMOKE']) { log.info('PS_SMOKE: boot ok, exiting');
  app.exit(0) }` in `index.ts` `whenReady`, after `createWindow()` and before the sweep `setInterval`.
  Locally verified: `PS_SMOKE=1` boots and exits 0 (log line present, bundled into `out/main/index.js`);
  plain boot keeps running (no early exit).
- **Phase 4 (Linux CI):** `.github/workflows/build-linux.yml` — `submodules: false`, node 22, `npm ci`,
  `npm run dist:linux`, AppImage-exists assert, **xvfb + `PS_SMOKE` launch smoke** (quoted spaced binary
  per gotcha #1, `--no-sandbox` for CI runners), upload `ps-local-linux-AppImage`. README `build-linux`
  badge + Download table row. **Green run is push-only** (no Docker locally).
- **Phase 5 (extension zip):** `.github/workflows/build-extension.yml` — zips `helper/extension/` with
  secret excludes (`data/config.json`, `*.env`) + a hard leak-assert (`grep -qE '(data/config\.json|
  \.env)$'`). **Fully validated locally**: clean zip passes, planted dummy `data/config.json` is excluded,
  and an un-excluded zip is correctly caught by the assert. README `build-extension` badge + Download blurb.
- **Phase 6 (Win+mac CI):** `electron-builder.yml` gained `win:[nsis]` + `mac:[dmg]`
  (`public.app-category.games`); `dist:win`/`dist:mac` scripts + root `dist:ui*` passthroughs;
  `.github/workflows/build-windows.yml` (pwsh `.exe` assert) + `build-macos.yml` (`.dmg` assert) — **no
  launch smoke** (Linux carries it). README `build-windows`/`build-macos` badges + 3-OS Download table.
  Local mac `npm run dist:mac` regression build passed (dmg + `moves.json` shipped to the Resources tail).

Both vendor submodules stayed git-clean throughout.

## Resume here (next chat)

All 7 phases are complete. The one remaining owner action:

- **Push the branch** so `build-linux`, `build-extension`, `build-windows`, `build-macos` run. Confirm
  each goes green + uploads its artifact. **After the first Linux run**, verify the
  `linux-unpacked/Pokemon Showdown Battle UI` path the xvfb smoke assumes (electron-builder may slugify
  it — fix the workflow path in `build-linux.yml` if so).

Optional follow-up (not part of this plan):
- `release.yml` triggered on `v*` tags → run the three builds and attach all installers to a GitHub
  Release (`softprops/action-gh-release`). Then point the README Download section at Releases instead of
  Actions artifacts. (macOS signing + notarization is a separate, larger effort.)
