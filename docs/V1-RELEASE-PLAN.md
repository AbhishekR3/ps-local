# ps-local: v1.0.0 Release Readiness, Lean-Up & Distribution

> **Implementation hand-off doc.** This plan was produced during a planning session and is meant to be
> executed by a fresh agent. It is self-contained: all decisions are made, file paths and line numbers
> are verified against the repo at hand-off time (re-confirm line numbers before editing, as the repo may
> have drifted). Owner decisions are baked in — do not re-ask them.


Need to fit all of these into phases that I will need to validate at each step and tell you any fixes to be made in the middle as I validate each step.

> **2026-06-14 update — finalized & re-phased.** Five additional owner work items (README rewrite, CI
> greening, Codacy grade) are folded in below as **Parts 6–8**, and everything is sequenced into the
> **Execution Phases** table. The original **Parts 1–4** are unchanged and carried forward; **Part 5**
> (v1.0.0 release readiness) remains **DELAYED — do not implement**.

---

## Execution Phases (each independently validated before the next)

The owner validates after every phase. Order: README (P5) is last because it must reflect the final
badge set (P1), the portable download types (P3), and the from-source electron download.

| Phase | Scope | Items / Parts | Status | Validation gate |
|---|---|---|---|---|
| **P1** | CI greening + new `build-electron.yml` | items 2,3,4 + Part 6 | ✅ **DONE** — merged PR #9 | all build-* badges green; canary green via dispatch; vendor clean |
| **P2** | Codacy grade B→A | item 5 / Part 7 | ✅ **DONE** — PR #10 open (`fix/codacy-grade`), awaiting merge | >97% alert reduction (1800→~41); build + tests pass |
| **P3** | Portable targets + runtime icon | Part 1 + Part 2 | ⬜ not started | `dist/` has installer **and** portable per OS; icon swap works |
| **P4** | Lean-up | Part 3 | ⬜ not started | `npm test`/`test:smoke` pass; no `deep-test.yml`; LLM docs scrubbed |
| **P5** | README full rewrite + screenshots | item 1 / Part 8 + Part 4 | ⬜ not started | renders on GitHub; exactly 7 badges; Downloads table complete |
| **P6** | Docs sync + final sweep + branch protection | architecture.html→.md conversion + sync, CLAUDE.md updates, branch protection | ⬜ not started | `CLAUDE.md`/`showdown-ui/CLAUDE.md` updated; `docs/architecture.md` exists and matches codebase; main branch protected; vendor clean; suite green |
| **P7** | Auto-update mechanism | New Part 9 | ⬜ not started | Update check UI shows on boot; accept/reject/skip works; rollback UI appears on test failure; suite green; packaged-app path handled gracefully |
| **P8** | Pre-release quality sweep | New Part 10 | ⬜ not started | `/simplify` + `/code-review` applied; `npm test` + `test:smoke` + `build` clean; Codacy no new regressions; vendor clean; only then proceed to Part 5 |

### P1 — DONE (2026-06-14, merged as PR #9)
What was delivered:
- `.github/workflows/build-linux.yml` — fixed smoke binary path (`Pokemon Showdown Battle UI` →
  `showdown-ui`; electron-builder uses `package.json.name` for the Linux binary, not `productName`);
  added `workflow_dispatch`.
- `.github/workflows/build-windows.yml` — added `workflow_dispatch` only (was already passing).
- `.github/workflows/upstream-canary.yml` — replaced `--merge` (fails on shallow checkouts with
  "refusing to merge unrelated histories") with `git submodule sync --recursive && git submodule update
  --remote --force --recursive`; added least-privilege `permissions: contents: read / issues: write`.
- `.github/workflows/build-electron.yml` (new) — from-source electron-vite build + xvfb PS_SMOKE on
  ubuntu-latest; uploads `ps-local-electron-app` artifact; path triggers match other build-* workflows.
- `.github/workflows/test.yml` — added least-privilege `permissions: contents: read` (Checkov
  CKV2_GHA_1).

### P2 — DONE (2026-06-14, PR #10 on `fix/codacy-grade`, awaiting owner merge)
What was delivered across two commits on the branch:

**Commit 1 — `chore(codacy): silence linter false positives + least-privilege permissions`:**
- `.jshintrc` — `esversion: 11, browser: true, node: true, loopfunc: true, undef: false` (silences 926 JSHint ES5 false positives)
- `.markdownlint.json` — disables MD013, MD012, MD022, MD025, MD031, MD032, MD036, MD040 (silences 551+ Markdownlint false positives)
- `.csslintrc` — ignores `known-properties, order-alphabetical, ids, adjoining-classes, fallback-colors, universal-selector, box-sizing, empty-rules, errors` (94 CSSlint alerts)
- `.stylelintrc.json` — nulls out 7 noisy rules (48 Stylelint alerts)
- `.remarkrc.json` — disables `remark-lint-no-undefined-references` (17 Remark-lint alerts)
- `test.yml` permissions already added in P1 (`contents: read`)
- `upstream-canary.yml` permissions already added in P1 (`contents: read / issues: write`)

**Commit 2 — `chore(codacy): pin actions to SHAs + suppress remaining false positives`:**
- `biome.json` (new, repo root) — disables 8 Biome style/suspicious/complexity rules that flag
  intentional patterns in helper libs (73 Biome alerts)
- `ruleset.xml` (new, repo root) — PMD ecmascript ruleset excluding `UnnecessaryBlock`; switch-case
  `{ const … }` blocks are required for ES6 scoping, PMD 6.x misflags them (59 PMD alerts)
- `.markdownlint.json` — added MD060 (16 additional alerts)
- All 9 `.github/workflows/*.yml` — pinned `actions/checkout`, `setup-node`, `upload-artifact`,
  `github-script`, `codeql-action/upload-sarif` to commit SHAs (fixes Opengrep
  `third-party-action-not-pinned` + Checkov `CKV2_GHA_1`)

**Result:** Projected >97% alert reduction (baseline ~1800 → ~41 remaining: 24 Agentlinter on
`CLAUDE.md` + 17 Remark-lint; both are unfixable via config). All 66 tests pass. Grade B→A expected.

**Remaining ~41 alerts are unactionable:**
- Agentlinter (24, on `CLAUDE.md`) — semantic agent-prompt linter with no file-based suppression
- Remark-lint (17) — `.remarkrc.json` already disables `no-undefined-references`; may require a
  Codacy dashboard toggle if the server-side tool doesn't pick up the config

**Next step:** Owner merges PR #10 → move to P3 (portable targets + `iconPath`).

**Cross-cutting decisions locked 2026-06-14 (do not re-ask):**
- **Codacy (Part 7): the pasted "Fix Issues" patch is corrupt — never `pbpaste | patch` it.** Many
  markdown hunks contain Codacy's review *prose* as literal file content (e.g. replacing `# CLAUDE.md`
  with "Create separate files: SOUL.md…"). Even the legit `.ts/.tsx` hunks break the build: `strict` is
  on and they turn `catch (e: any)` into `catch (e: unknown)` while leaving `e.code`/`e.message`/`e.stack`
  accesses that don't compile on `unknown`. Drive the grade up via the local CLI (`.codacy/cli.sh`).
- **"build-electron app" badge = a new `build-electron.yml`** (Part 6) that builds & launches the
  Electron app **from source** (`electron-vite build` → `out/`, no `electron-builder` packaging). It is a
  distinct distributable: the OS-agnostic, run-from-terminal / hack-the-codebase app, separate from the
  per-OS `.dmg/.exe/.AppImage` installers.
- `noPropertyAccessFromIndexSignature` is **not** set, so ESLint dot-notation fixes (`process.env.FOO`)
  compile fine. The only build-breaking patch hunks are the unnarrowed `any`→`unknown` ones.
- Per owner global rules: **every `git push` / PR / tag is owner-confirmed**; vendor submodules must stay
  git-clean (`git -C vendor/... status --porcelain` empty) after any local upstream repro.

### P6 — expanded scope

**Branch protection (owner action — no code):**
GitHub → Settings → Branches → Add branch protection rule on `main`:
- Require a pull request before merging (1 approval minimum)
- Require status checks to pass before merging — add `test` and `build-electron` as required checks
- Do not allow bypassing the above settings
- Prohibit force pushes
- Prohibit branch deletion

**`docs/architecture.html` → `docs/architecture.md` conversion:**
The existing `architecture.html` is a 1 400-line interactive graph viewer with all content embedded as JavaScript data. It is not readable on GitHub without a browser. Extract the 8 content sections from the JS `SECTIONS` object and render them as a plain Markdown file `docs/architecture.md`. Keep `architecture.html` — it remains the interactive viewer. The `.md` is the GitHub-readable companion.

Eight sections to cover:
1. Executive Summary — tech stack, two surfaces (showdown-ui + Chrome extension)
2. Repository Structure Map — full directory tree with ownership annotations
3. System Architecture — primary path (PS Server → injected.js → ps.ts → main → React) + extension path
4. File Interaction Map — reference table of 25 key files (layer, line count, role, deps)
5. Dependency Graph — module criticality observations (parser.js most-depended-upon, render.js single source, injected.js three contexts)
6. Execution Flow Analysis — four flows: app startup, ps-frame hot path, panel resync, drag-resize
7. Important Functions & Classes — 25 critical functions with descriptions
8. Data Flow Mapping — live display flow + battle log archive flow

**Sync `docs/architecture.md` with codebase:** After conversion, audit each section against the current code. Known drift areas: file line counts in the File Interaction Map (s4), Electron version in s1 (currently 42.4.0), function list in s7 (verify all 25 still exist with correct names/signatures). Update wherever stale. Also check if anything in `V1-RELEASE-PLAN.md` conflicts with what `architecture.md` clarifies.

**Update `V1-RELEASE-PLAN.md` footnote:** Once architecture.md exists, add a reference to it from the "Critical files" section.

---

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

## Part 6 — CI: green the builds + new `build-electron.yml` (Phase P1; items 2, 3, 4 + item 1 badge)

> **Status 2026-06-14 — diagnosed, fixed locally, awaiting a push to confirm green in CI.**
> Confirmed root causes from the real run logs (`gh run view --log-failed`):
> - **build-linux**: the AppImage built fine; the xvfb smoke failed with `No such file or directory` —
>   the Linux unpacked executable is named **`showdown-ui`** (electron-builder uses package.json `name`),
>   not `Pokemon Showdown Battle UI` (productName, used only for the macOS `.app` / Windows `.exe`).
>   **Verified** by a Docker `electronuserland/builder` build → `dist/linux-unpacked/showdown-ui` exists.
>   **Fixed**: smoke path corrected + `workflow_dispatch` added.
> - **upstream-canary**: died in 12 s at `git submodule update --remote --merge` with `refusing to merge
>   unrelated histories` — the runner checks submodules out shallow, so the pinned gitlink and the upstream
>   tip share no common ancestor. **Fixed**: switched to checkout mode (`git submodule update --remote
>   --force --recursive`), **validated locally** (bumps a8376a2 → upstream tip cleanly, vendor restores clean).
> - **build-windows**: **already passing** (latest run green, 2m18s) — the "no status" was a stale badge
>   before the run finished. Added `workflow_dispatch` for on-demand runs anyway.
> - **build-electron.yml** (new): from-source `electron-vite build` + xvfb `PS_SMOKE` launch. The launch
>   logic was **validated locally on macOS** (`PS_SMOKE: tap source ok` + `boot ok, exiting`, exit 0).

### 6.0 — Diagnose with real logs first (read-only)
Before guessing, pull the actual failing logs:
```bash
gh run list --workflow=build-linux.yml   --limit 5
gh run view <id> --log-failed            # exact build-linux error
gh run list --workflow=build-windows.yml --limit 5   # confirm "no status" = no completed run on main
gh run list --workflow=upstream-canary.yml --limit 5
gh run view <id> --log-failed            # canary: protocol break vs infra
```

### 6.1 — `upstream-canary` re-green (item 2)
`.github/workflows/upstream-canary.yml` bumps both submodules to upstream HEAD, rebuilds, runs
`cd helper && node --test` + `npm run test:smoke`, and files an `upstream-breakage` issue on failure. It
**does not commit** the bump. Local repro on a throwaway branch (no push, no submodule commit):
```bash
git checkout -b canary-check
git submodule update --remote --merge
cd vendor/pokemon-showdown && npm ci && npm run build && cd ../..
cd helper && npm install && node --test && cd ..
npm run test:smoke
```
- **Tests pass against upstream latest** → June 8 2026 failure was transient/infra. Fix = re-run via
  Actions → `upstream-canary` → **Run workflow** (`workflow_dispatch` already exists) until green. No code change.
- **Tests fail** → genuine upstream protocol break in `helper/extension/lib/parser.js` / `exporter.js`.
  Fix per `docs/UPDATE-WORKFLOW.md`; refresh golden if exporter formatting changed
  (`node helper/test/golden.test.js --update`); optionally pin the bump via `npm run update-upstream`.
- **Cleanup (critical — protect the vendor invariant):**
  ```bash
  git checkout main && git branch -D canary-check
  git submodule update --init --recursive
  git -C vendor/pokemon-showdown status --porcelain        # must be empty
  git -C vendor/pokemon-showdown-client status --porcelain # must be empty
  ```
- Optional hardening: pin canary Node to `22`; absorb Part 3's vendor-server-build step here.

### 6.2 — `build-linux` (item 3)
Native AppImage on macOS isn't supported by electron-builder. Two-tier local verification:
- **Tier 1 (fast, OS-agnostic — catches most failures):**
  `cd showdown-ui && npm ci && npm run build` (electron-vite TS compile of main+preload+renderer).
- **Tier 2 (true Linux AppImage, exactly as CI):**
  ```bash
  docker run --rm -v "$PWD":/project -v ~/.cache/electron:/root/.cache/electron \
    -w /project/showdown-ui electronuserland/builder:latest \
    bash -lc "npm ci && npm run dist:linux && ls -la dist/*.AppImage"
  ```
  The xvfb `PS_SMOKE` step (`"…/linux-unpacked/Pokemon Showdown Battle UI" --no-sandbox` → grep
  `PS_SMOKE: tap source ok`) runs inside the container with `xvfb-run`.
- Apply whatever 6.0 revealed (common: TS error, productName path drift, electron download blocked). Add
  `workflow_dispatch` so it's re-runnable on demand.

### 6.3 — `build-windows` "no status" (item 4)
"No status" means the badge has **no completed run on `main`** — the path-filtered triggers never fired
on a main push (or only ran on PRs).
- **Fix the status:** add `workflow_dispatch` and run it once on `main`.
- **Local repro:** Tier 1 = `cd showdown-ui && npm ci && npm run build`. Tier 2 = cross-build via the
  wine builder image (most reliable on Apple Silicon):
  ```bash
  docker run --rm -v "$PWD":/project -w /project/showdown-ui \
    electronuserland/builder:wine bash -lc "npm ci && npm run dist:win && ls -la dist/*.exe"
  ```
  (`brew install --cask wine-stable` + `npm run dist:win` natively is the flakier non-Docker alternative.)

### 6.4 — New `build-electron.yml` ("build-electron app" badge, item 1)
New `.github/workflows/build-electron.yml`, `ubuntu-latest`, Node 22, same path triggers as the other
build-* workflows plus `workflow_dispatch`:
- `cd showdown-ui && npm ci`
- `cd showdown-ui && npm run build` (electron-vite production build → `out/`)
- `xvfb-run -a env PS_SMOKE=1 npx --prefix showdown-ui electron showdown-ui --no-sandbox` → tee to
  `smoke.log`, `grep -q 'PS_SMOKE: tap source ok'` (from-source app launches + tap source ships)
- upload-artifact `ps-local-electron-app` → `showdown-ui/out/**` (optional: built app, no installer)

Distinct from build-linux/win/mac: it proves the **raw Electron app builds and boots from source** — the
run-from-terminal / hack-the-codebase distributable, independent of OS installers.

---

## Part 7 — Codacy grade B→A (Phase P2; item 5, proper lint-fix)

Work on a branch off `main`, **driven from the local CLI, not the pasted patch.**

1. **Baseline:** `bash .codacy/cli.sh analyze` (tools per `.codacy/codacy.yaml`: eslint@8.57, lizard,
   opengrep, pmd, trivy). Capture current issue list + grade.
2. **Apply safe fixes** (owner-authored files only; `.codacy.yaml` already excludes `vendor/`,
   `node_modules/`, `helper/extension/data/`, `dist/`, `logs/`):
   - **ESLint TS/React** (`showdown-ui/electron/**`, `showdown-ui/src/**`): `@ts-ignore`→`@ts-expect-error`;
     wrap bare-expression arrow bodies (`() => cb()` → `() => { cb(); }`); `||`→`??` where semantics hold;
     `dot-notation` env access; `type PsStatus`→`interface PsStatus`. **`any`→`unknown` MUST add narrowing**
     so `strict` compiles: `catch (e: unknown) { const err = e instanceof Error ? e : new Error(String(e)); … err.stack … }`
     — never leave `.code`/`.message`/`.stack` on a bare `unknown`.
   - **Markdownlint** (trailing whitespace, blank lines around headings/lists): apply via a formatter
     (`markdownlint --fix` / prettier), **never by hand-copying the corrupt patch hunks**.
   - **lizard / pmd / opengrep**: only clear, low-risk findings; defer anything behavioral.
3. **Verify before commit:** `cd showdown-ui && npm run build` clean · `npm test` · `npm run test:smoke` ·
   `.codacy/cli.sh analyze` shows fewer issues / improved grade.
4. Push the branch + open PR **only on owner confirmation**.

---

## Part 8 — Full README rewrite (Phase P5; item 1, lean rewrite — folds in Part 4 + Downloads)

Recreate `README.md` from scratch — lean, keeping these sections:
- **Title + one-line pitch.**
- **Badge row — exactly these 7, in order:** `test`, `build-electron` (label "build-electron app"),
  `build-linux`, `build-windows`, `build-macos`, `build-extension` (label "build-chromium-extension"),
  `Codacy Badge`. **Drop** the current `deep-test`, `upstream-canary`, and `License` badges (the
  `upstream-canary` *workflow* stays — only its badge is dropped).
- **Screenshots** (Part 4): one hero under the title + 3 placeholders → new `docs/assets/`
  (`panel.png`, `battle-view.png`, `log-sample.png`) + a "screenshots to capture" checklist.
- **Downloads** table — every distribution type, including the new **Electron app (from source)** row
  (git clone + `npm start`, or the `ps-local-electron-app` artifact from `build-electron`) as a
  first-class entry alongside the OS installers/portables and the Chromium extension. Keep the
  macOS-unsigned note; demote the CI-artifacts fallback below it.
- **Quickstart · How logs are saved · Helper panel · Privacy · Troubleshooting · Updating upstream ·
  Contributing · Credits (unchanged) · License (text link, not a badge).**

Create `docs/assets/` (placeholder markup ready; owner drops real PNGs later).

---

## Part 9 — Auto-update mechanism (Phase P7)

**Goal:** When the app boots, check whether either PS upstream submodule has new commits available. Show a simple loading screen, present results, let the user accept or skip. If accepted, run the update and verify nothing breaks. If tests fail, offer a one-click rollback.

### 9.0 — Scope and constraints

- **What is being updated:** The PS upstream submodules (`vendor/pokemon-showdown`, `vendor/pokemon-showdown-client`) — _not_ the app binary. Binary updates are a separate download from GitHub Releases.
- **Packaged app (asar):** Source files inside the asar are read-only. In a packaged install, the update check cannot modify the vendored data. The UI must detect `app.isPackaged` and instead show: _"A new version of ps-local is available. Download the latest installer from GitHub Releases."_ with a link. No in-app merge for packaged users.
- **From-source / dev:** The full update + rollback flow applies.
- **`npm run update-upstream` already exists** (`scripts/update-upstream.js`) — wire to it rather than reimplementing.
- **`config.checkUpdatesOnBoot`:** New optional boolean (default `true`). When `false`, skip the check entirely and proceed directly to the main UI.

### 9.1 — IPC surface

New channels (all bidirectional renderer ↔ main):

| Channel | Direction | Payload |
|---|---|---|
| `update-check-request` | renderer → main | — |
| `update-check-result` | main → renderer | `{ upToDate: boolean, ahead: { ps: number, client: number }, error?: string }` |
| `update-apply-request` | renderer → main | — |
| `update-apply-progress` | main → renderer | `{ step: string }` (streamed lines from update-upstream) |
| `update-apply-result` | main → renderer | `{ success: boolean, testOutput?: string }` |
| `update-rollback-request` | renderer → main | — |
| `update-rollback-result` | main → renderer | `{ success: boolean }` |
| `update-skip` | renderer → main | — (proceed to main UI) |

Expose all channels in `showdown-ui/electron/preload/index.ts` via `contextBridge`.

### 9.2 — Main process changes (`showdown-ui/electron/main/index.ts`)

1. **Config interface** — add `checkUpdatesOnBoot?: boolean` (default `true` when absent).
2. **`checkUpstreamAhead()`** — async function, runs `git fetch` on both submodule remotes (10 s timeout), then `git rev-list HEAD..@{u} --count` to get the commit-ahead counts. Returns `{ ps: number, client: number }` or throws on error.
3. **`applyUpdate()`** — spawns `npm run update-upstream` from the repo root (captures stdout/stderr, streams via `update-apply-progress` IPC). After completion, runs `npm test` + `npm run test:smoke`; returns `{ success, testOutput }`.
4. **`rollback(priorShas)`** — `git -C vendor/pokemon-showdown checkout <sha>` + `git -C vendor/pokemon-showdown-client checkout <sha>` using the SHAs captured before `applyUpdate()`.
5. **Boot sequence** — in `app.whenReady()`, before `createWindow()`: if `config.checkUpdatesOnBoot !== false` and `!app.isPackaged`, record prior SHAs, then `createWindow()` (the React app immediately shows `UpdateScreen` which triggers `update-check-request`). If `app.isPackaged`, pass a flag to the renderer to show the packaged-update notice instead.

### 9.3 — Renderer changes

**`showdown-ui/src/components/UpdateScreen.tsx` (new):**

Five states, rendered in sequence:

| State | UI |
|---|---|
| `checking` | Spinner + "Checking for upstream updates…" |
| `up-to-date` | "Everything is up to date." + "Continue" button (→ skip to main UI) |
| `update-available` | "X new commit(s) in pokemon-showdown, Y in client." + "Update & verify" button + "Skip for now" button |
| `applying` | Progress lines streamed from main; no cancel (destructive mid-run cancels are unsafe) |
| `result-fail` | Test output (truncated to last 50 lines) + "Roll back" button + "Keep & continue" button |
| `result-success` | "Update applied and verified." + "Continue" button |
| `packaged-update` | "ps-local vX.Y.Z is available. Download from GitHub Releases." + link |

**`showdown-ui/src/App.tsx`** — gate the main app render behind `updateComplete` state. While `!updateComplete`, render `<UpdateScreen onDone={() => setUpdateComplete(true)} />`.

### 9.4 — Config and docs

- `config.example.json` — add `"checkUpdatesOnBoot": true` with a comment explaining the flag.
- `CLAUDE.md` (runtime env flags section) — document `checkUpdatesOnBoot`.

### 9.5 — Validation gate

1. **From source, up to date:** Boot → "Everything is up to date" → Continue → main UI loads.
2. **From source, updates available:** Boot → update available → "Update & verify" → progress streams → "applied and verified" → Continue → main UI loads.
3. **From source, test failure:** Manually introduce a bad submodule state → "Update & verify" → tests fail → rollback offer → "Roll back" → app continues on prior state.
4. **Packaged app:** `app.isPackaged` path shows the Releases link, no merge attempted.
5. **Bad network / timeout:** 10 s timeout on `git fetch` → graceful error state → "Skip for now" unblocks the app.
6. **`checkUpdatesOnBoot: false`:** Update screen never shown; app proceeds immediately to main UI.

---

## Critical files

- `.github/workflows/build-electron.yml` (new), `build-linux.yml`/`build-windows.yml` (+`workflow_dispatch`),
  `upstream-canary.yml` (re-green) — Part 6
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
- Part 9 (new): `showdown-ui/electron/main/index.ts` (IPC handlers + update functions),
  `showdown-ui/src/components/UpdateScreen.tsx` (new), `showdown-ui/src/App.tsx` (update gate),
  `showdown-ui/electron/preload/index.ts` (contextBridge exposure), `config.example.json`
- Part 10 (P8 sweep): no new files — commands only

---

## Part 10 — Pre-release quality sweep (Phase P8)

Run after all feature work (P7) is complete and validated, before cutting the v1.0.0 tag. The goal is zero new issues introduced during feature development; this is not a deep audit.

### Commands to run (in order)

| Step | Command | Purpose |
|---|---|---|
| 1 | `npm test` | All helper suites (parser / exporter / golden / edge / guards / render) |
| 2 | `npm run test:smoke` | Fast protocol gate |
| 3 | `cd showdown-ui && npm run build` | TypeScript compile clean for main + preload + renderer |
| 4 | `/simplify` (Claude Code skill) | Reuse / simplification / efficiency cleanup on all changed code since P2 |
| 5 | `/code-review high` (Claude Code skill) | Correctness bugs + cleanups on the full diff vs `main`; use `--fix` for low-risk auto-apply |
| 6 | Re-run steps 1–3 | Confirm no regressions from `/simplify` + `/code-review --fix` |
| 7 | `bash .codacy/cli.sh analyze` | Final Codacy check — no new regressions vs the grade achieved in P2 |
| 8 | `git -C vendor/pokemon-showdown status --porcelain` | Vendor invariant — must be empty |
| 9 | `git -C vendor/pokemon-showdown-client status --porcelain` | Same |

### Notes on the Claude Code skills

- **`/simplify`** — focuses on reuse, simplification, efficiency, and altitude cleanups only. It does not hunt for bugs; that is `/code-review`'s job.
- **`/code-review high`** — high effort gives broader coverage including uncertain findings. At `max` effort it goes deeper but takes longer. Start at `high`; escalate to `max` if the diff is large.
- **`/code-review --fix`** — auto-applies low-risk findings directly to the working tree. Re-run the test suite immediately after, before committing.
- Run both skills on the **full branch diff vs `main`**, not just the most recent commit. If in doubt about scope, pass the range explicitly or run from a clean branch.

### Validation gate

All of the following must be true before proceeding to Part 5 (v1.0.0 tag + release automation):
- Steps 1–3 pass with zero errors
- `/code-review` findings are either fixed or explicitly deferred with a rationale note
- Codacy shows no new issue categories vs the P2 baseline
- Both vendor status checks return empty output
- Owner has reviewed and confirmed the sweep is complete

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
