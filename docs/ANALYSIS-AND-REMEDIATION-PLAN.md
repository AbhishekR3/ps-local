# ps-local — Codebase Analysis & Remediation Plan

> **Hand-off doc.** Produced during an analysis session driven by [docs/architecture.html](architecture.html).
> It is **self-contained**: a fresh Claude Code chat (or a new engineer) can execute the **DO-NOW** tasks
> in §7 without any prior context. All findings were verified against the working tree at hand-off time —
> **re-confirm every `file:line` before editing**, the repo may have drifted.
>
> **Status of this doc: analysis + plan only. No code has been changed.** §7 lists what to implement;
> §8–§11 are documented-but-deferred.

---

## 0. How to read this doc

| Section | What it is |
|---|---|
| §1 | System shape + why the generic analysis prompts are reinterpreted |
| §2 | What the working tree **already fixed** (don't redo it) |
| §3 | The 8 analysis lenses (failure-modes, consistency, coupling, data-gravity, event-storming, observability, dead-code) |
| §4 | Endpoint / function-mapping check (the "is everything wired to the right place" ask) |
| §5 | **Issue register** — every issue in architecture.html + audit-found issues, each with a solution + tier |
| §6 | architecture.html corrections (doc ↔ code reconciliation) |
| §7 | **DO-NOW tasks** — High/correctness only, with implementation notes |
| §8 | Deferred fixes |
| §9 | Test-coverage plan |
| §10 | Legacy `app/` decision + transition/decommission plan |
| §11 | Forward-pointer: self-update & data-staleness (BACKLOG §4) |
| §12 | Verification |

**Owner decisions baked in (do not re-ask):** (1) deliverable = analysis + executable tasks;
(2) only **High/correctness (silent-failure / data-loss)** fixes are "do-now", rest deferred; (3) assess
`app/` necessity and provide a decommission path if redundant; (4) include arch.html corrections, an
auto-update forward-pointer, and a test-coverage plan.

---

## 1. System shape (why the generic prompts are reinterpreted)

`ps-local` is **not** a web service. It is:

- **`showdown-ui/`** — primary **Electron + React + TS** desktop app. Wraps live
  `play.pokemonshowdown.com` in a `WebContentsView`, docks a native React **helper panel**, and
  auto-saves a rich battle log per battle.
- **`helper/extension/`** — a **Chrome MV3 extension** (secondary surface) injecting the same panel.
- **`helper/extension/lib/`** — **pure, zero-dependency** shared libs (`parser.js`, `exporter.js`,
  `render.js`, `lookup.js`) imported by both surfaces **and** the Electron main process.
- **`app/`** — **legacy** Electron app (local-mode sandbox + a now-obsolete CI path). See §10.

There are **no databases, queues, HTTP APIs, caches, or multi-tenant servers**. So the generic analysis
questions map as follows:

| Generic prompt | ps-local reality |
|---|---|
| "external dependencies (DB, APIs, queues, caches)" | **PS WebSocket server** (`wss://sim*.psim.us`), **live PS client site** (DOM), **Chrome `storage.session`**, the **frozen data bundle** |
| "data written to multiple places / consistency" | the **3 independent `BattleTracker` instances** (main / renderer / extension) + the **log file** |
| "data gravity / 10x-100x scale" | **battle-log `.txt` files** accruing in `~/Documents/ps-local/logs/` — linear, unbounded, no rotation |
| "SLAs / uptime / on-call / Datadog" | single-user local app — the answer is "none, and none needed"; observability = the 3 file loggers + the in-UI status line |
| "GDPR / retention / compliance" | logs contain usernames + full battle frames on the **user's own disk**; no server-side PII store |

---

## 2. What the working tree already fixed (build on this, don't redo)

The audit found the **uncommitted working tree already resolves several architecture.html "issues"** in
**showdown-ui**:

- **In-UI transport-health status line** ([HelperPanel.tsx:195-207](../showdown-ui/src/components/HelperPanel.tsx#L195-L207)):
  renders tap/page/`saveLogs` health with a colored dot (`ok`/`warn`/`error`/`idle`), a reload button,
  and **distinct messages** ("Waiting for a battle… · logging OFF", data-error, stall) instead of an
  endless "Waiting…". Fed by `ps-status` / `get-status` / `ps-tap-ok` / `ps-tap-error` / `reload-ps` IPC
  ([index.ts](../showdown-ui/electron/main/index.ts), [preload/index.ts](../showdown-ui/electron/preload/index.ts),
  [global.d.ts](../showdown-ui/src/global.d.ts)).
- **Loud `saveLogs=false` warning at startup** (`index.ts:520`) — addresses the arch.html "dangerous
  silent config" footgun **in showdown-ui** (still silent in `app/` — see I10).
- **Guard tests** ([helper/test/guards.test.js](../helper/test/guards.test.js)): enforce **ad-block
  sorted parity** (I1), **CSS-class parity** (I2), and **injected.js origin/port security** (I4) — the
  three previously "discipline-only" invariants now fail CI on drift.
- **Renderer parity test** ([helper/test/render.test.js](../helper/test/render.test.js)).

> Net effect: the arch.html **High/Danger** rows for "SockJS silent tap" and "`saveLogs` silent" are
> **resolved for showdown-ui**. The remaining gaps are the **extension panel** (still blind), the
> **legacy `app/`** surface, and **real disk-write failures** (distinct from `saveLogs=false`).

---

## 3. The 8 analysis lenses

### 3.1 Failure modes & external-dependency outages

| Failure | Behavior | Blast radius | Acceptable? |
|---|---|---|---|
| PS WS server unreachable | No frames; parser idle; status line shows tap state; no crash | this user | ✅ graceful |
| **PS changes SockJS framing/transport** (the one true "upstream API") | `decodeSockJS` silently returns `[]` → tap yields nothing. **showdown-ui surfaces it via tap status; the extension is still blind** (15s console warn only) | this user | ⚠️ silent on extension → **I3** |
| Live PS client DOM redesign | breaks `content.js` `autoLogin`/`autoHideRooms` selectors + possibly divider relay; silent | this user | ⚠️ → **A3** |
| **Disk full / permission error on log write** | `writeLog` catch logs to `logs/debug/` only — **never surfaced to the user** | this user, **data loss** | ❌ silent → **A1** |
| `storage.session` unavailable (non-Chrome) | null-guarded; extension loses cross-restart replay only | extension only | ✅ graceful |
| `moves.json` / `config.json` missing/malformed | falls back to defaults — **verify the `JSON.parse` paths in `loadMovesData`/`loadConfig` are wrapped**; flag any unguarded parse | this user | re-verify |

**Cascade analysis:** the shared libs are pure and dependency-free, so a failure in one consumer (e.g.
the extension) **cannot cascade** to another (Electron main). The only coupling is the shared **state
shape** emitted by `parser.js`. **Early-warning:** the weekly `upstream-canary.yml` re-bumps submodules
and runs the helper tests, catching most protocol breaks before users do.

### 3.2 Consistency model

- **Three representations of one battle:** the **main-process tracker** (authoritative — writes the log),
  the **renderer tracker** (drives the UI), and the **extension tracker**. Each is fed the *same* frames
  but independently, so the renderer can lag or miss early once-only `|init|`/`|request|` frames.
- **Convergence mechanism:** `HelperPanel.resync()` + the **5s stall-detection timer** + `get-buffer`
  frame replay reconcile a late/desynced renderer. The system is **eventually consistent within a
  session**; the **log file is the source of truth**.
- **Partial-write risk:** single-file `writeFileSync` is atomic-enough; the real exposure is `writeLog`
  **throwing** mid-flush (→ A1). There is no multi-file transaction to tear.
- **"Deployment"/reload analog:** in-flight battle state is in memory; a reload/crash drops it **unless**
  `flushAllRooms()` runs — it's wired to 4 exit paths (`before-quit`, `window-all-closed`,
  `render-process-gone`, `uncaughtException`). Confirm the `reload-ps` path also flushes/buffers.

### 3.3 Coupling map

- **`parser.js` state shape = the central contract.** Three consumers read the same fields. **Renaming a
  field breaks all three simultaneously; adding a field is safe.** Highest-ripple change point in the repo.
- **`render.js` is the single UI source; `render.ts` is a thin adapter** (supplies `assetBase` only). Any
  rendering logic added to `render.ts` is **invisible to the extension** — a documented footgun.
- **String/magic-value couplings:** the `__psHelper` token, the `>battle-` prefix filter, the SockJS
  `a[...]` prefix, the localhost `:8000`/`:8080` ports (must match `manifest.json`), the **IPC channel
  names** (audited consistent across main/preload/renderer; `global.d.ts` is the `window.psUI` type
  contract), the **CSS class names** emitted by `render.js` (coupled to two CSS files → I2), and the
  **ad-block pattern list** (duplicated across two files → I1).
- **Ripple of the most central files:** a change to `parser.js` state, `render.js` HTML structure, or an
  IPC channel name is the kind of "local edit, distant breakage." The guard tests now catch the IPC/CSS/
  ad-block cases; the state-shape contract is still discipline-only.

### 3.4 Data gravity

- **The accruing data is battle-log `.txt` files** in `~/Documents/ps-local/logs/battle_info/`. Growth is
  **linear in battles played, unbounded, with no rotation/archival/retention.** Each file embeds the full
  **RAW PROTOCOL** section, so files are non-trivial in size.
  - *First bottleneck at scale:* a power user's `logs/` directory listing and the `open-logs` folder.
  - *Recommendation (deferred):* document a retention note + an optional age/size prune mirroring the
    existing `pruneDebugLogs` (which already prunes `logs/debug/`).
- **Frozen data bundle** (`helper/extension/data/**`): the migration-nightmare candidate — **no version
  stamp, no staleness check**. `lookup.js`/`render.js` implicitly depend on its schema. → §11.
- **Filename scheme** (`<roomid>_[SPEC_]<p1>_vs_<p2>_<RESULT>_<ts>.txt`) is a **de-facto schema** anything
  parsing the logs would couple to; changing it is a silent break for downstream tooling.

### 3.5 Event storming

**Trigger chain (the hot path):**
```
PS WS frame → PatchedWebSocket(injected.js) → postMessage({__psHelper}) →
  [ps.ts | content.js] → ipc 'ps-frame' / chrome.runtime →
  handleFrame → BattleTracker.feed →
    (a) relay 'ps-frame' to renderer → RAF-coalesced render
    (b) on |win|/|tie|/|deinit| → writeLog → generateBattleLog → fs.writeFileSync
```
**Lifecycle events:** `before-quit` / `window-all-closed` / `render-process-gone` / `uncaughtException`
→ `flushAllRooms`; `setInterval` → `sweepStaleRooms`; divider `begin-resize`/`end-resize` → drag relay.

- **Dead events:** none material.
- **Sync-vs-async / missing-event smell:** the log write is a **direct synchronous call** inside
  `handleFrame`. For a single-user desktop app this is correct — **no event bus is present or needed**;
  do not add one.
- **Guaranteed vs fire-and-forget:** the **log write must be guaranteed** (→ A1 surfacing makes failures
  visible); the **frame relay to the renderer is intentionally fire-and-forget** (resync recovers losses).

### 3.6 Observability plan

- **Today:** three cohesive loggers (`app/logger.js`, `scripts/lib/logger.js`, inline in `index.ts`),
  one format `ISO [LEVEL] [ns] msg`, `PS_LOG_LEVEL` threshold, sink `logs/debug/`. showdown-ui adds the
  **in-UI status line** — genuine end-user-facing observability.
- **Blind spots:** real log-write failures at default `INFO` (→ A1); extension tap-silent (→ I3); no
  metrics on frames/sec, rooms tracked, buffer occupancy, or resync count (acceptable for a local app).
- **Sensitive-data check:** logs include **player usernames + full battle frames** — that is the product,
  but state it explicitly in any privacy note. **Confirm the testclient session sid is never logged**
  (`app/preload.js` injects it as a MAIN-world global; re-verify it isn't written to any log). `gitleaks`
  guards committed secrets in CI.
- **Tooling answer:** none external (no Datadog/Sentry/OTel) and **none warranted** for a local desktop
  app — record that as the deliberate answer, not a gap to fill.

### 3.7 Dead code

- **`react-router-dom`**: architecture.html §10 lists it as a dependency, but it is **not installed in
  any `package.json` and imported nowhere** — a phantom. → §6 doc correction.
- **`test:deep` npm script** is byte-identical to `test`; `deep-test.yml` adds only a vendor-server-build
  step that `upstream-canary.yml` already runs (→ A5; matches V1-RELEASE-PLAN Part 3).
- **`app/`** surface is largely redundant (→ §10).
- **No unused npm dependencies** found; **all lib exports have consumers** (the `render.js` "export list"
  in arch.html is overstated — only `renderBattle`/`waitingHtml` are exported; the rest are
  module-internal builders → §6, a doc inaccuracy, not dead code).

---

## 4. Endpoint / function-mapping check (explicit ask)

**Result: PASS.** All **13 showdown-ui IPC channels** are registered in main, sent/invoked from a
preload, and consumed via `window.psUI` consistently — no handler is mapped to the wrong channel, and
`global.d.ts` matches the preload which matches `ipcMain`.

| Channel | Type | Registered (main) | Sent / consumed |
|---|---|---|---|
| `ps-frame` | on + send | ipcMain.on + webContents.send | ps.ts relay → renderer `onFrame` |
| `get-buffer` | invoke | ipcMain.handle | preload `getBuffer` |
| `set-game-bounds` | on | ipcMain.on | preload `setGameBounds` |
| `begin-resize` / `end-resize` | on | ipcMain.on | preload `beginResize`/`endResize` |
| `ps-drag-move` / `ps-drag-end` | on | ipcMain.on | ps.ts (during drag relay) |
| `start-drag-relay` / `stop-drag-relay` | send | webContents.send → ps.ts | ps.ts listeners |
| `resize-drag` / `resize-drag-end` | send | webContents.send → renderer | preload `onResizeDrag` |
| `ps-tap-ok` / `ps-tap-error` | on | ipcMain.on | ps.ts (tap install result) |
| `ps-status` / `get-status` | send / invoke | pushStatus / ipcMain.handle | preload `onStatus`/`getStatus` |
| `open-external` / `open-logs` | on | ipcMain.on | preload `openExternal`/`openLogs` |
| `reload-ps` | on | ipcMain.on | preload `reloadPS` |

**One minor robustness nit (not a mis-mapping):** `index.ts` sends `resize-drag` (~line 318) **without**
the `mainWindow` null/destroyed guard that the `resize-drag-end` send (~line 324) has → **A4**.

**Cross-surface mapping:** `app/main.js` and `index.ts` implement the identical **C5 log contract**; the
divergences (server spawn, static serve, extension load, logger namespaces, `PS_SMOKE` vs `PS_SYNTHETIC`)
are **intentional** — **except** the `saveLogs` warning, which should be re-aligned (→ I10).

---

## 5. Issue register (every issue + a solution)

### 5a. From architecture.html (§13 Risk, §15 Weaknesses, §11 Dangerous config, §16 Gotchas)

| ID | Issue | Sev | Current status | Solution | Tier |
|----|----|----|----|----|----|
| **I1** | Duplicate ad-block list (`index.ts` ↔ `app/main.js`) | Med | `guards.test.js` asserts sorted parity; 3 cosmetic drifts | Single-source: move the list to `helper/extension/data/adblock-patterns.json` and `require`/`import` it in both (JSON loads in **both** CJS and ESM, defeating the "CJS/ESM boundary" excuse). Keep guard until then. **Decommissioning `app/` (§10) deletes this issue.** | Deferred |
| **I2** | Duplicate CSS (`panel.css` ↔ `global.css`, 148 vs 179 lines) | Med | `guards.test.js` asserts class-name parity (not rule bodies) | Single source: author shared rules once + a tiny build step that emits both (or a shared `@import` partial). Interim: extend the guard to diff rule *bodies* for shared classes. | Deferred |
| **I3** | SockJS framing → **silent tap failure** | High | **Resolved in showdown-ui** (tap status + reload). **Extension panel still blind** (15s console warn only) | **DO-NOW (A2):** give `panel.js` a visible "tap inactive / no battle data" state, parity with the showdown-ui status line. | **DO-NOW** |
| **I4** | `content.js` `event.source===window` footgun | High | `guards.test.js` + inline comments mitigate | Keep guard; no code change needed. | ✅ Done |
| **I5** | MV3 worker 500ms persist debounce loses last frames on hard kill | Med | Inherent | Also persist on `visibilitychange` / burst-end; shrink debounce. | Deferred |
| **I6** | `app.isPackaged` path-fork sprawl | Low | Centralized (`DATA_DIR`/`USER_ROOT`), all guarded | Accept + document. | None |
| **I7** | `build-data.js` Node ≥22.6 only checked in `setup.js` | Low | Direct invocation skips the check → cryptic syntax error | Add a ~5-line `process.versions.node` assert at the top of `build-data.js`. | Deferred |
| **I8** | Renderer shows only the most-recent room | Low | Documented gap | Room switcher (ties to BACKLOG multi-game future). | Deferred |
| **I9** | Unsigned macOS builds (Gatekeeper friction) | Low | Documented in README | Accept (needs paid Apple Developer cert); keep the note. | None |
| **I10** | `saveLogs:false` silently discards all logs | Danger | **Resolved in showdown-ui** (startup WARN + "logging OFF" status). **`app/` still DEBUG-only / silent** | **DO-NOW (A3, if keeping `app/`):** port the loud warning to `app/main.js`. | **DO-NOW** |

### 5b. Audit-found (not in architecture.html)

| ID | Issue | Sev | Solution | Tier |
|----|----|----|----|----|
| **A1** | **Real log-write failure** (disk/permission error in `writeLog`) is logged to `logs/debug/` only — **never surfaced**. Distinct from `saveLogs=false`. A battle log is lost with no visible signal. | **High** | Add a `logWrite` health field to `PsStatus`; on the `writeLog` catch, set it + `pushStatus`; render an error tone + message in the status line. Reuses existing `ps-status` plumbing. | **DO-NOW** |
| **A2** | `parseCondition` can propagate `NaN` on malformed condition strings | Low | Guard the split/`Number()`. Trusted protocol → low urgency. | Deferred |
| **A3** | Brittle DOM selectors in `content.js` (`autoLogin`/`autoHideRooms`) break silently on a PS redesign | Med | Wrap in try/catch + one-time console warn on selector miss; keep the text-match fallback. | Deferred |
| **A4** | `resize-drag` send lacks the destroyed-window guard the sibling send has (~`index.ts:318`) | Low | Add the `mainWindow && !mainWindow.isDestroyed()` guard. | **DO-NOW** (cheap) |
| **A5** | `deep-test.yml`/`test:deep` redundant with `test`/`upstream-canary` | Low | Lean-up per V1 Part 3: delete `deep-test.yml`, drop `test:deep`. | Deferred |
| **A6** | Electron version drift: `app` `^42.3.3` vs `showdown-ui` `42.4.0` | Low | Align when touching either (moot if `app/` removed). | Deferred |

---

## 6. architecture.html corrections (doc ↔ code)

Low-risk doc edits to reconcile [architecture.html](architecture.html) with the actual code:

1. **`render-js` node `exports`** overstates the export list — only `renderBattle` and `waitingHtml` are
   exported; `statBar`/`statRangeBar`/`typeTags`/`moveChip`/`breakdownCard`/`myActiveCard`/`renderSideHtml`
   are **module-internal**. Reword to "internal builders."
2. **§10 lists `react-router-dom`** as a dependency — **not installed / not imported**. Remove the row.
3. **§13/§11**: mark the "SockJS silent tap" and "`saveLogs` silent" rows as **resolved in showdown-ui**
   (status line); note the extension / `app/` gap remains.
4. **`runSynthetic`/`PS_SYNTHETIC`** is described as "the CI decoupling proof" — **no CI workflow uses
   it**; `npm run test:smoke` (`helper/test/smoke.mjs`) is. Correct this.
5. **Test count "8 files"** → now **10** (`guards.test.js`, `render.test.js`, `smoke.mjs` added).
6. **Add the missing channels/feature** to the `main-ts` / `ui-preload` / `helper-panel` nodes:
   `ps-status`, `get-status`, `ps-tap-ok`, `ps-tap-error`, `reload-ps`, and the status-line UI.
7. **Electron version**: note the pin drift (`42.4.0` exact vs `^42.3.3`).

---

## 7. DO-NOW tasks (High / correctness only — implement in a future session)

> These are the **only** tasks marked for immediate execution. After each: run `npm test` **and**
> `npm run test:smoke`; confirm `git -C vendor/pokemon-showdown status --porcelain` stays empty.
> **Re-verify line numbers first.**

### A1 — Surface real log-write failures in showdown-ui *(highest value)*
- [`showdown-ui/electron/main/index.ts`](../showdown-ui/electron/main/index.ts): widen the `PsStatus`
  shape + `pushStatus()` with a log-write health field, e.g. `logWrite: 'ok' | 'error'`. In the
  `writeLog` **catch** (~lines 138–158), set `logWrite='error'` and call `pushStatus(...)`.
- [`showdown-ui/electron/preload/index.ts`](../showdown-ui/electron/preload/index.ts) +
  [`showdown-ui/src/global.d.ts`](../showdown-ui/src/global.d.ts): widen the `PsStatus` type — the
  `onStatus`/`getStatus` channel already carries it, so only the type changes.
- [`showdown-ui/src/components/HelperPanel.tsx`](../showdown-ui/src/components/HelperPanel.tsx)
  `deriveStatus(...)` (~lines 27–35): add an **error-tone** branch — e.g. *"Battle log failed to save —
  check disk space / folder permissions."* Reuse the existing `.ps-status--error` CSS.
- Optional: add a `render.test.js`/`guards.test.js` assertion for the new status branch.

**Comment for implementer:** this is the genuine remaining data-loss gap — `saveLogs=false` is already
loud, but an *actual disk failure* with `saveLogs=true` is still invisible. Small wire-up on existing
plumbing; no new IPC channel needed.

### A2 — Extension panel "tap inactive / no data" state (closes I3 on the extension)
- [`helper/extension/panel.js`](../helper/extension/panel.js): when no `>battle-` frame has arrived after
  a threshold (mirror injected.js's 15s) or the tap is reported inactive, render a **visible banner**
  instead of an indefinite blank/"waiting" — parity with the showdown-ui status line wording.
- Add the matching CSS class to **both** [`panel.css`](../helper/extension/panel.css) **and**
  [`showdown-ui/src/styles/global.css`](../showdown-ui/src/styles/global.css) (the I2 invariant — keep
  them in sync, `guards.test.js` will fail otherwise).

### A3 — Port the loud `saveLogs=false` warning to `app/` (I10) — *only if `app/` is kept (see §10)*
- [`app/main.js`](../app/main.js): at startup emit a **WARN** (not DEBUG) when `config.saveLogs === false`,
  matching `index.ts:520`. **If §10 decides to decommission `app/`, skip this and do §10 instead.**

### A4 — Guard the `resize-drag` send (mapping nit)
- [`showdown-ui/electron/main/index.ts`](../showdown-ui/electron/main/index.ts) (~line 318): add the same
  `mainWindow && !mainWindow.isDestroyed()` guard the `resize-drag-end` send (~line 324) already has.

---

## 8. Deferred fixes (documented, not executed)

I1 (ad-block → shared JSON), I2 (CSS single-source + build step), I5 (MV3 persist on visibilitychange),
I7 (`build-data.js` Node-version assert), I8 (multi-room switcher), A2 (`parseCondition` NaN guard),
A3 (selector hardening), A5 (`deep-test` lean-up), A6 (Electron version align). Solutions are in §5.

---

## 9. Test-coverage plan (deferred)

The lib **core is well covered** (parser, exporter, render, lookup, golden, edge-cases, integration,
content + the guards + smoke). **Untested layers:**

- **Electron main** ([index.ts](../showdown-ui/electron/main/index.ts)): `handleFrame` end-detection,
  `writeLog` filename/`SPEC_` logic, `flushAllRooms`, `sweepStaleRooms`, the new A1 status.
  → **Highest leverage:** extract the *pure* helpers (`roomidOf`, the filename builder, the
  end-condition predicate) into a small importable module and unit-test with `node --test` — **no Electron
  runtime required**.
- **IPC contract guard:** a test asserting `ipcMain` channel names == `global.d.ts` `window.psUI` keys
  (cheaply catches future endpoint-mapping drift — the §4 check, automated).
- **`injected.js` `decodeSockJS`:** a pure function — unit-test `a[...]` frames, control frames
  (`o`/`h`/`c`), and malformed input. `guards.test.js` currently checks only the security invariants, not
  decoding.
- **`app/` lifecycle / `PS_SYNTHETIC`:** only if `app/` is kept (§10).

---

## 10. Legacy `app/` decision + transition plan

**Audit finding:** `app/`'s **only non-redundant capability is local-mode** — `npm run start:local`
(`PS_SERVER=local`) spawns a real local PS server on `:8000` + a static client on `:8080`.

- `npm run start:legacy` == official mode == **redundant with showdown-ui**.
- `PS_SYNTHETIC=1` is the stated "C5 CI decoupling proof" but **no CI workflow invokes it** —
  `npm run test:smoke` ([smoke.mjs](../helper/test/smoke.mjs)) drives the same fixture through
  `parser → exporter` and is the real CI proof (used in `test.yml`, `deep-test.yml`, `upstream-canary.yml`).

So the decision reduces to **one question for the owner:**

> **Do you still want the local-mode self-hosted PS sandbox (`npm run start:local`)?**

**If NO → decommission `app/` (recommended for an official-mode-only product):**
1. Delete `app/` (`main.js`, `preload.js`, `logger.js`, `package.json`).
2. Remove root scripts `start:legacy`, `start:local`, and `test:deep` from
   [`package.json`](../package.json).
3. Update [`.github/ISSUE_TEMPLATE/feature_request.md`](../.github/ISSUE_TEMPLATE/feature_request.md#L19)
   (drops the `app/main.js` reference).
4. Update [`CLAUDE.md`](../CLAUDE.md) (directory-ownership, C5 dual-path, `PS_SYNTHETIC`/local-mode/
   env-gotcha sections), [`architecture.html`](architecture.html) (remove `app-main`/`app-preload`/
   `app-logger` nodes + edges), [`README.md`](../README.md).
5. Keep [`helper/test/smoke.mjs`](../helper/test/smoke.mjs) as the standing C5-decoupling proof.
6. **Bonus:** this **erases issue I1** (ad-block duplication) — only one copy remains.
7. Verify: `npm test`, `npm run test:smoke`, `npm start` (showdown-ui) all green;
   `grep -rn "app/" --include=*.json --include=*.yml --include=*.md .` finds no live references.

**If YES → keep `app/`, but correct the stale framing:** do A3 (loud `saveLogs`), document that
`PS_SYNTHETIC` is **not** CI-wired, and keep `guards.test.js` ad-block parity as the divergence guard.

> This is a **decision to surface to the owner** — not an automatic deletion (it touches a whole surface
> + several docs).

---

## 11. Forward-pointer: self-update & data-staleness (BACKLOG §4, deferred)

The **data-bundle-staleness** (no version stamp / no runtime check) and **SockJS-fragility** findings
directly motivate BACKLOG §4 (on-launch check of upstream PS repos **and** the ps-local repo; opt-in
merge with rollback; a "safe to proceed / won't break your software" check; a loading/waiting UI).
Scope as **next**, not now:

- **Make staleness detectable first:** have [`build-data.js`](../helper/build-data.js) write a
  `helper/extension/data/_meta.json` (`{ generatedAt, upstreamCommit, schemaVersion }`); expose it via
  both loaders; surface a "data may be stale" hint when the wrapped upstream submodule commit moves past
  the stamped one. This is the prerequisite that makes the auto-update "safety check" meaningful.
- **Per-surface update channels** (each needs its own mechanism + rollback):
  - **Electron app** → `electron-updater` against tagged GitHub Releases; rollback = retain the previous
    install / downloaded build.
  - **Browser extension** → store update or re-load of `ps-local-extension.zip`.
  - **Run-from-source** → guided `git pull` + `npm ci`; rollback = previous git tag.
- **"Won't break your current software" gate:** run `npm test` + `npm run test:smoke` (and lean on the
  `upstream-canary` result) before applying an update; offer revert if post-merge smoke fails.
- **Dependency:** auto-update needs tagged releases to exist → cross-reference
  [`docs/V1-RELEASE-PLAN.md`](V1-RELEASE-PLAN.md) (release automation) and the "officially delayed" Part 5.

---

## 12. Verification

1. **Doc is self-contained:** a fresh reader can act on §7 without this session's context.
2. **A1:** make `logs/battle_info/` read-only (or mock the write throw), finish a battle → status line
   goes **error-tone** with the failure message (not a silent debug-only line).
3. **A2:** open the extension panel on a non-battle PS page → after the threshold, the "tap inactive / no
   data" banner appears (not an endless blank).
4. **A3 / §10:** if kept, `PS_LOG_LEVEL=INFO npm run start:legacy` with `saveLogs:false` shows the WARN;
   if decommissioned, `grep -rn "app/"` is clean and `npm start` + `npm test` + `npm run test:smoke` pass.
5. **A4:** drag the divider, then quit mid-drag → no destroyed-window send crash.
6. **Regression:** `npm test` (helper unit + guards + render + golden) and `npm run test:smoke` green;
   vendor submodules stay git-clean.
7. **arch.html:** the §6 corrections applied; `grep -n "react-router" docs/architecture.html` returns
   nothing.

---

### Appendix — audit evidence (key `file:line`, verify before relying)

- IPC wiring (all 13 channels correct): `showdown-ui/electron/main/index.ts` (handlers ~223–346),
  `showdown-ui/electron/preload/index.ts`, `showdown-ui/electron/preload/ps.ts`.
- Status line: `HelperPanel.tsx:19, 33, 164–207`; `global.css:53–72`; `global.d.ts:23–25`.
- `saveLogs` loud (showdown-ui) vs silent (`app/`): `index.ts:520` vs `app/main.js` (DEBUG-only).
- Log-write catch (debug-only, → A1): `index.ts` `writeLog` ~138–158.
- Ad-block lists: `index.ts:360–422` vs `app/main.js:409–471` (3 cosmetic drifts; `guards.test.js` guards parity).
- Constants: `MAX_FRAMES_PER_ROOM=100_000`, `STALE_ROOM_MS=30m`, `SWEEP_INTERVAL_MS=5m`, display
  `MAX_FRAMES=2000`/`MAX_ROOMS=6`; extension `background.js` `MAX_FRAMES=2000`/`MAX_ROOMS=6`/500ms debounce.
- Tap filter (psim.us + localhost:8000/8080), postMessage origin (not `'*'`): `injected.js:40–66`.
- `content.js` origin check w/o `event.source` (correct), 700ms room poll: `content.js:273–281, 155–163`.
- `react-router-dom` absent: not in any `package.json`, zero imports.
- `PS_SYNTHETIC` not in any workflow; `test:smoke` in `test.yml:40`, `deep-test.yml:34`, `upstream-canary.yml:41`.
