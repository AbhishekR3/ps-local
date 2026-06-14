# ps-local: v1.0.0 Release Readiness, Lean-Up & Distribution

> **Implementation hand-off doc.** This plan was produced during a planning session and is meant to be
> executed by a fresh agent. It is self-contained: all decisions are made, file paths and line numbers
> are verified against the repo at hand-off time (re-confirm line numbers before editing, as the repo may
> have drifted). Owner decisions are baked in — do not re-ask them.


Need to fit all of these into phases that I will need to validate at each step and tell you any fixes to be made in the middle as I validate each step.


## Context

`ps-local` is an Electron app (`showdown-ui/` is primary; `app/` is a legacy fallback kept only for
local-mode sandbox + `PS_SYNTHETIC=1` CI) that wraps live `play.pokemonshowdown.com` and auto-saves a
rich battle log per battle. The owner wants to publish it as a polished, public **v1.0.0** on GitHub.

This plan covers five owner requests:
1. Offer a no-install ("portable") download in addition to installers; let users set a custom app logo via config.
2. A clearly labelled, near-top README "Downloads" section covering all distribution types.
3. Remove outdated info / dead code (LLM-analysis references; redundant `deep-test`); keep the app lean.
4. Make the README more visual with screenshots.
5. Prepare the repo for a shareable, high-quality v1.0.0 (metadata, community files, release automation).

**Key facts established during exploration (don't re-derive):**
- LLM-analysis *code* is already fully removed; only **docs** still mention it. Tests assert it stays gone.
- `app/` and `helper/extension/panel.js` are intentionally kept (not dead) — do **not** delete them.
- The build-time installer icon (`showdown-ui/build/icon.png`) is baked at package time and **cannot**
  change at runtime. A runtime `iconPath` config only affects the live window/taskbar (Linux/Windows)
  and the macOS Dock (via `app.dock.setIcon`). Be accurate about this in code comments and docs.
- electron-builder builds **every** target listed in a platform's `target:` array in one run; the
  `--linux/--win/--mac` flags select the *platform*, not targets — so no npm-script changes are needed.
- Owner chose **not** to address the Charizard icon / Pokémon-trademark branding question. Leave icon
  and branding as-is; do not add a trademark disclaimer.

---

## Part 1 — Portable / no-install download targets

**File:** `showdown-ui/electron-builder.yml` (lines 15–25). Add a portable target alongside each installer:

```yaml
linux:
  target: [AppImage, tar.gz]
  category: Game
  icon: build/icon.png
win:
  target: [nsis, portable]
  icon: build/icon.png
mac:
  target: [dmg, zip]
  category: public.app-category.games
  icon: build/icon.png
```

- macOS `zip`, Windows `portable` (single self-extracting `.exe`, no install), Linux `tar.gz` (unpacked app dir).
- **No** changes to `showdown-ui/package.json` dist scripts — `--linux/--win/--mac` already build all listed targets.
- **CI side-effect to handle:** `build-windows.yml` globs/uploads `dist/*.exe`, which will now match
  **two** exes (NSIS `...Setup.exe` + portable `...exe`). That's fine — leave the glob, just confirm the
  existing assert still passes (it checks ≥1 non-empty `.exe`).

---

## Part 2 — Runtime custom logo via config (`iconPath`)

**File:** `showdown-ui/electron/main/index.ts`.

1. **Imports** — add `nativeImage` to the electron import (line 1) and `homedir` from `os` (after line 2):
   ```ts
   import { app, BrowserWindow, WebContentsView, ipcMain, shell, session, screen, nativeImage } from 'electron'
   import { homedir } from 'os'
   ```
2. **Config interface (line 22)** — add optional key (keeps missing-config behavior identical):
   ```ts
   interface Config { timezone: string; logLevel: string; saveLogs: boolean; iconPath?: string }
   ```
3. **Helper** — add after the logger block (module-level `log`/`wlog` already exist at lines 67–68;
   `existsSync`/`join` already imported):
   ```ts
   // Resolve config.iconPath → a nativeImage for the window/taskbar (Linux/Windows) and macOS Dock.
   // Tilde-expands ~; missing/unreadable files warn and fall back to the bundled icon.
   function resolveIcon(p: string | undefined): Electron.NativeImage | undefined {
     if (!p) return undefined
     const expanded = p.startsWith('~') ? join(homedir(), p.slice(1)) : p
     if (!existsSync(expanded)) { log.warn(`iconPath not found: ${expanded} — using default icon`); return undefined }
     const img = nativeImage.createFromPath(expanded)
     if (img.isEmpty()) { log.warn(`iconPath unreadable as image: ${expanded} — using default icon`); return undefined }
     return img
   }
   ```
4. **`createWindow()` (lines 395–409)** — resolve once, inject conditionally so the options object is
   byte-identical to today when unset, then set the macOS Dock icon so the key isn't a silent no-op there:
   ```ts
   const { workArea } = screen.getPrimaryDisplay()
   const windowIcon = resolveIcon(config.iconPath)
   mainWindow = new BrowserWindow({
     x: workArea.x, y: workArea.y, width: workArea.width, height: workArea.height,
     backgroundColor: '#1a1a2e',
     title: 'Pokemon Showdown Battle UI',
     ...(windowIcon ? { icon: windowIcon } : {}),
     webPreferences: { /* unchanged */ },
   })
   if (windowIcon && process.platform === 'darwin') app.dock?.setIcon(windowIcon)
   ```
5. **`config.example.json`** — add the documented optional key:
   ```json
   "saveLogs": true,
   "iconPath": "~/Documents/ps-local/my-icon.png"
   ```
   with an `_iconPath` note explaining it sets the live window/taskbar icon (Linux/Windows) and the
   macOS Dock icon, defaults to the bundled icon when unset/unreadable, and does **not** change the
   installer's baked icon.

---

## Part 3 — Lean-up: dead code & outdated info

**Test/CI consolidation (chosen: single per-change gate):**
- **Delete** `.github/workflows/deep-test.yml`. Its only step not already in `test.yml` is the vendor
  server build — **move that step into `upstream-canary.yml`** (where upstream-compat belongs).
- **Remove** the redundant `test:deep` npm alias from root `package.json` (identical to `npm test`).
- **Remove** the `deep-test` badge line from `README.md` (line 4) and the `deep-test.yml` mention from
  the CI list in `CLAUDE.md` (directory-ownership section). Keep `test.yml`, `upstream-canary.yml`,
  `codacy.yml`, and the four `build-*.yml`.
- Update any README/CONTRIBUTING text that describes a "nightly deep-test" to reflect the single gate.

**LLM-analysis doc cleanup (code already clean — docs only):**
- `docs/LOG-FORMAT.md`: line 7 change "human/LLM-readable" → "human-readable"; delete the entire
  "LLM ANALYSIS PROMPT" section (≈ lines 37–40).
- Grep once more for `LLM`/`llm` across docs + READMEs (exclude `vendor/`, `node_modules/`, `helper/test/`)
  and scrub any other stray references. Do **not** touch the `helper/test/*` assertions that verify the
  prompt is gone — those are guards, keep them.

**Do NOT remove:** `app/`, `helper/extension/panel.js`/`panel.css`, `scripts/*`, any other build
workflow. They are in active use per the exploration.

---

## Part 4 — Visual README (scaffold + placeholders)

- Create `docs/assets/` for screenshots.
- In `README.md`, near the top (just under the intro paragraph, above or beside "Architecture"), embed
  placeholder image markup with relative paths, e.g.:
  ```md
  ![Battle helper panel](docs/assets/panel.png)
  ![In-battle view](docs/assets/battle-view.png)
  ![Saved battle log](docs/assets/log-sample.png)
  ```
- Add a short **"Screenshots to capture"** checklist (HTML comment or a small section the owner removes
  later) naming each: (1) helper panel with predicted sets/stats/abilities, (2) full window mid-battle,
  (3) a sample saved `.txt` log. Owner will drop the real PNGs into `docs/assets/` later; markup is ready.
- Consider one hero/screenshot directly under the title for first-impression impact.

---

## Part 5 — v1.0.0 release readiness (all selected)

** THIS HAS BEEN OFFICIAL DELAYED UNTIL FURTHER NOTICE **
** A FINALIZED CODEBASE WITH NO FURTHER CODE CHANGES IS REQUIRED **
** UAT TESTING + FEATURES IMPLEMENTATION STILL GOING ON **
** DO NOT IMPLEMENTED Part 5 — v1.0.0 release readiness **

Need to run another /init + relevant updates to readme.md
Then need rethink this release info/readiness


**Version bump (hand-bump all four; no sync tooling — minimal fat):** `0.1.0` → `1.0.0` in
`package.json`, `showdown-ui/package.json` (this one drives dmg/AppImage/exe filenames),
`helper/package.json`, `app/package.json`.

**Root `package.json` metadata** — add:
```json
"description": "Electron app that auto-saves a rich battle log for every Pokémon Showdown battle, with a live opponent-prediction helper panel.",
"author": "Abhishek Ramesh",
"license": "MIT",
"repository": { "type": "git", "url": "https://github.com/AbhishekR3/ps-local" },
"homepage": "https://github.com/AbhishekR3/ps-local",
"bugs": { "url": "https://github.com/AbhishekR3/ps-local/issues" }
```
Add `"license": "MIT"` (+ author/repository where sensible) to `showdown-ui/`, `helper/`, `app/` package.json too.

**Release automation** — new `.github/workflows/release.yml`, tag-triggered on `v*`, matrix over
`ubuntu/windows/macos`. Each leg installs `showdown-ui` deps, runs its `dist:<os>`, and uploads its
artifacts to one GitHub Release via `softprops/action-gh-release@v2`; the ubuntu leg also builds the
extension zip (reusing `build-extension.yml`'s exclude list + leak-assert). `permissions: contents: write`;
`GITHUB_TOKEN` is auto-provided. `fail-fast: false`. Include the high-value, low-fat guard: an ubuntu-leg
step asserting the pushed tag (minus `v`) equals `showdown-ui/package.json`'s version (the one mismatch
that would actually break release filenames). This is **additive** to the per-push `build-*.yml` CI — it
does not replace them. Artifact globs per leg:
- ubuntu: `showdown-ui/dist/*.AppImage`, `showdown-ui/dist/*.tar.gz`, `ps-local-extension.zip`
- windows: `showdown-ui/dist/*.exe` (NSIS + portable)
- macos: `showdown-ui/dist/*.dmg`, `showdown-ui/dist/*.zip`

Reference `release.yml` (model after the existing `build-*.yml`):

```yaml
name: release
# Builds all three OS distributables (+ the extension zip) on a v* tag and attaches them to a
# GitHub Release. GITHUB_TOKEN is auto-provided; contents:write lets the action create the release.
on:
  push:
    tags: ['v*']
permissions:
  contents: write
jobs:
  build:
    strategy:
      fail-fast: false
      matrix:
        include:
          - os: ubuntu-latest
            dist: dist:linux
            artifacts: |
              showdown-ui/dist/*.AppImage
              showdown-ui/dist/*.tar.gz
            build_extension: true
          - os: windows-latest
            dist: dist:win
            artifacts: |
              showdown-ui/dist/*.exe
            build_extension: false
          - os: macos-latest
            dist: dist:mac
            artifacts: |
              showdown-ui/dist/*.dmg
              showdown-ui/dist/*.zip
            build_extension: false
    runs-on: ${{ matrix.os }}
    steps:
      - uses: actions/checkout@v4
        with: { submodules: false }
      - uses: actions/setup-node@v4
        with:
          node-version: '22'
          cache: 'npm'
          cache-dependency-path: showdown-ui/package-lock.json
      - name: Assert tag matches showdown-ui version
        if: matrix.os == 'ubuntu-latest'
        run: |
          v=$(node -p "require('./showdown-ui/package.json').version")
          tag="${GITHUB_REF_NAME#v}"
          [ "$v" = "$tag" ] || { echo "tag $tag != showdown-ui version $v"; exit 1; }
      - name: Install showdown-ui deps
        run: cd showdown-ui && npm ci
      - name: Build distributables
        run: cd showdown-ui && npm run ${{ matrix.dist }}
      - name: Zip extension (excluding secrets)
        if: matrix.build_extension
        run: |
          cd helper
          zip -r ../ps-local-extension.zip extension \
            -x 'extension/data/config.json' -x '*.env' -x 'extension/.env' -x '*/.DS_Store'
      - name: Leak-assert (no credentials in the extension zip)
        if: matrix.build_extension
        run: |
          if unzip -l ps-local-extension.zip | grep -qE '(data/config\.json|\.env)$'; then
            echo 'CREDENTIAL LEAK: data/config.json or .env present in extension zip'; exit 1; fi
          echo 'leak-assert passed'
      - name: Attach artifacts to the release
        uses: softprops/action-gh-release@v2
        with:
          files: |
            ${{ matrix.artifacts }}
            ${{ matrix.build_extension && 'ps-local-extension.zip' || '' }}
```

**Community health files** (create at repo root / `.github/`):
- `CHANGELOG.md` — Keep-a-Changelog format, seeded with a `## [1.0.0]` entry.
- `SECURITY.md` — supported versions + how to report (private email / GitHub security advisories).
- `.github/PULL_REQUEST_TEMPLATE.md` — summary / testing / vendor-clean checklist
  (`git -C vendor/... status --porcelain` is empty).
- `CODE_OF_CONDUCT.md` — Contributor Covenant.
- `.nvmrc` — `22.6.0` (matches `engines.node`).
- `.editorconfig` — basic 2-space, LF, trim-trailing-whitespace.
- (LICENSE, CONTRIBUTING.md, `.github/ISSUE_TEMPLATE/{bug_report,feature_request}.md` already exist.)

**README "Downloads" section (Part 2 of owner's list)** — rewrite the existing `## Download` block
(lines 55–91) into a clearly labelled, near-top section that, once `release.yml` has run, points at the
**GitHub Releases page** as the primary source and lists all five download types in a table:

| Type | Platforms | Source |
|---|---|---|
| Electron app (run from source) | Linux / Windows / macOS | `git clone` + `npm start` (verify the run-from-source steps work on all three) |
| Chromium browser extension | Chrome/Chromium (any OS) | Releases → `ps-local-extension.zip` → load unpacked |
| macOS `.dmg` (installer) + `.zip` (portable) | macOS | Releases |
| Windows `.exe` (NSIS installer) + portable `.exe` | Windows | Releases |
| Linux `.AppImage` (installer) + `.tar.gz` (portable) | Linux | Releases |

Keep the macOS-unsigned note. Keep the CI-artifacts fallback table but demote it below Releases.
Double-check and state the cross-OS support claim for run-from-source.

**Docs to refresh after the above:** `CLAUDE.md`, `showdown-ui/CLAUDE.md`, `README.md`,
`docs/PACKAGING-PROGRESS.md` (mark portable targets + release.yml as done), and per the owner's standing
automation rule, reflect any feature/distribution changes back into `CLAUDE.md`.

---

## Critical files

- `showdown-ui/electron-builder.yml` — portable targets (Part 1)
- `showdown-ui/electron/main/index.ts` — `iconPath` config + window icon (Part 2)
- `config.example.json` — document `iconPath`
- `.github/workflows/deep-test.yml` (delete), `upstream-canary.yml` (absorb server build),
  `release.yml` (new), `README.md` badge (Part 3 + 5)
- `docs/LOG-FORMAT.md` — LLM cleanup (Part 3)
- `docs/assets/` (new) + `README.md` — screenshots (Part 4)
- `package.json` (×4) — version bump + metadata (Part 5)
- New: `CHANGELOG.md`, `SECURITY.md`, `CODE_OF_CONDUCT.md`, `.nvmrc`, `.editorconfig`,
  `.github/PULL_REQUEST_TEMPLATE.md`

---

## Verification

1. **Portable + installers build:** `cd showdown-ui && npm run dist:linux` (and on the matching OS,
   `dist:win` / `dist:mac`). Confirm `dist/` contains both the installer and the portable artifact per OS
   (e.g. `*.AppImage` **and** `*.tar.gz`).
2. **Runtime icon:** put a PNG at a path, set `iconPath` in `config.json`, `npm start`; confirm the
   window/taskbar icon changes (Linux/Windows) and the Dock icon changes (macOS). Set a bogus path →
   confirm it warns in `logs/debug/showdown-ui-*.log` and falls back without crashing.
3. **Lean-up:** `npm test` and `npm run test:smoke` pass; `npm run test:deep` no longer exists; no
   `deep-test.yml`; `grep -ri 'LLM ANALYSIS PROMPT' docs README.md` returns nothing.
4. **Release workflow (dry-ish):** validate YAML; on a throwaway `v0.0.0-rc` tag (owner-initiated, with
   confirmation before any push) confirm the matrix builds and a draft/Release gets the artifacts +
   extension zip, and the tag-version guard fires on a mismatched tag.
5. **Metadata/community files:** `npm pkg get version` reads `1.0.0` in all four; the new root files
   exist and render on GitHub.

> Note: anything requiring `git push` or tag creation must be confirmed with the owner first (per their
> global rules). Screenshots are captured by the owner; this plan only scaffolds the markup.
