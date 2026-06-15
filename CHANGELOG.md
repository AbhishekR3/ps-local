# Changelog

All notable changes to this project will be documented in this file.

Format: [Keep a Changelog](https://keepachangelog.com/en/1.1.0/) — versioning: [SemVer](https://semver.org/).

## [Unreleased]

## [1.0.0] - 2026-06-15

### Added

- `showdown-ui/` primary Electron app (React + TypeScript + electron-vite) replacing legacy `app/`
- Battle log auto-save (C5): per-room `BattleTracker`, `.txt` output to `logs/battle_info/`, `SPEC_` prefix for spectator games, `INPROGRESS` flush on crash/disconnect
- Docked helper panel: opponent predicted sets, stat ranges, abilities, Tera types shown live during battle
- Ad/analytics blocking at the Electron session layer (`webRequest.onBeforeRequest`) — covers Venatus, Google, Microsoft/Bing, and all prebid partners
- Packaged installers: macOS `.dmg`, Linux `AppImage` + `tar.gz`, Windows NSIS + portable (via `electron-builder`)
- Chromium MV3 extension build — panel uses shared `render.js` renderer with `showdown-ui`
- On-boot upstream update check with apply + rollback UI (`checkUpdatesOnBoot` config flag); packaged installs link to GitHub Releases instead
- Stat range bars, ability pill descriptions, opponent HP% + status display, suppressed "1 sets left" badge, no `Lxx` level label
- `config.json` runtime configuration: `timezone`, `logLevel`, `saveLogs`, `iconPath`, `checkUpdatesOnBoot`
- Single-instance lock (second launch raises existing window)
- Crash-resilient `flushAllRooms()` wired into `before-quit`, `window-all-closed`, `render-process-gone`, `uncaughtException`
- Stale-room sweep (5 min interval, 30 min idle eviction) and 100 K frame hard cap per room
- Guard tests (CI-enforced via `helper/test/guards.test.js`): ad-block list identity across `app/main.js` ↔ `showdown-ui` main; `render.js` class CSS parity across `panel.css` ↔ `global.css`
- Multi-OS/Node CI matrix (`ubuntu` / `macOS` / `Windows` × Node 22 / 24): smoke test, full helper suite, lint, typecheck, renderer unit tests, dependency audit, secret scan
- `release.yml` workflow: on a `v*` tag, builds all per-OS installers + the extension zip and publishes them as a GitHub Release (macOS `.dmg`/`.zip`, Linux `AppImage`/`tar.gz`, Windows NSIS `.exe`/portable, `ps-local-extension.zip`)

### Changed

- `showdown-ui/` is now the primary app; `app/` is legacy (local-mode sandbox + `PS_SYNTHETIC=1` CI decoupling proof only)
- Shared renderer: `helper/extension/lib/render.js` is the single source of truth for all HTML builders — both the extension panel and `showdown-ui` render identically; `panel.js` is no longer frozen

### Fixed

- Codacy static-analysis pass: resolved type-safety and code-pattern issues across `showdown-ui` and `app/` (removed an unsafe non-null assertion on a `Map` key, replaced `catch (e: any)` with `unknown`, dropped unnecessary optional chains and always-truthy conditionals, added a null guard for the React root element, and `void`-marked intentionally fire-and-forget promises). File-access and object-injection findings on Electron-internal paths are annotated as reviewed false positives.
- Battle-help silently broke in the packaged macOS `.dmg` when `injected.js` (the WebSocket tap source) wasn't shipped — now asserted by the `PS_SMOKE` launch smoke in every per-OS build and release job.

---

[Unreleased]: https://github.com/AbhishekR3/ps-local/compare/v1.0.0...HEAD
[1.0.0]: https://github.com/AbhishekR3/ps-local/releases/tag/v1.0.0
