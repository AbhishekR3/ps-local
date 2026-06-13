# ps-local improvement plan (12 items)

## Context

This plan covers 12 incremental improvements across two surfaces:

- **showdown-ui/** — the standalone React+Electron battle helper (items 1, 2, 6, 7, 8, 10, 11, 12, and the "log viewer" part of 3)
- **app/ + helper/** — the main Electron app that writes battle logs (items 3 config, 4, 5, 9)

Items 3 and 9 are consolidated (both ask about replacing `.env`). Items are ordered from lowest to highest effort and dependency, so each phase builds on the previous.

---

## Decisions (resolved before implementation)

These four cross-cutting calls were settled up front; the per-item sections below assume them.

1. **Parity contract → showdown-ui is canonical; `panel.js` is frozen-legacy.** Items 1, 8, 10, 11
   change `render.ts` (the native helper) only and deliberately diverge from the extension's
   `panel.js`. We retire the "byte-faithful" contract rather than mirror every UI change into both
   surfaces. Rationale: showdown-ui is the surface actually run (`npm run start:ui`) and the one the
   extension panel was built to replace; keeping two UIs in lockstep doubles the edit/review surface
   and is the main source of drift. The **shared pure libs still serve both** — items 6 and 7 live in
   `lookup.js`/`build-data.js`, so the extension keeps the data-layer fixes for free; only UI-only
   items (1, 8, 10, 11) diverge. Action: update the render-parity sections of both `showdown-ui/CLAUDE.md`
   and root `CLAUDE.md` to say `render.ts`/`global.css` are the canonical helper UI and `panel.js`/
   `panel.css` are frozen and may lag.

2. **Percentages → true probabilities (may sum to <100%).** Item 6 is fixed by largest-remainder over
   the **full** distribution *before* slicing to top-N, so the full set sums to exactly 100 and the
   displayed top-N is a faithful subset (≤100, never >100). We do **not** renormalize the displayed
   slice to force 100. This kills the "sums to 101%" rounding artifact while staying honest about the
   hidden tail.

3. **Maushold-Four → proper data-layer fix.** Emit `baseSpecies` in `build-data.js`'s pokedex output,
   then fall back to the base-form sets key in `lookup.js`. Covers Maushold-Three and every other
   cosmetic forme, not just `-Four`. (Quick suffix-strip hack rejected.)

4. **Helper reopen affordance → top header bar.** The collapse/expand toggle lives in `App.tsx`'s
   `<header>`, which sits **above** the psView region and is never occluded. A floating `position:fixed`
   button was rejected: the psView is a native `WebContentsView` composited *above* the renderer DOM, so
   a fixed button would be hidden once the game region expands to full width.

---

## Implementation order and rationale

### Phase 0 — Infrastructure (do first; unblocks later items)

**Items 3 + 9 — Replace `.env` with `config.json`**

Both items ask for the same thing. `.env` implies secrets; these are preferences.

**Current state (verified):** there is no `dotenv` anywhere in the app, so the existing root `.env`
(`PS_TIMEZONE`, `PS_LOG_LEVEL`) is **vestigial** — `app/main.js` reads `process.env.PS_TIMEZONE`
([main.js:36](../app/main.js#L36)) and `app/logger.js` reads `process.env.PS_LOG_LEVEL`
([logger.js:9](../app/logger.js#L9)), but nothing loads `.env` into `process.env`, so today those
values only take effect if the user exports them manually. Moving to `config.json` actually *fixes*
this latent bug.

Changes:
- Delete `.env` at repo root. Create `config.json` at repo root:
  ```json
  {
    "timezone": "America/Los_Angeles",
    "logLevel": "INFO",
    "saveLogs": true
  }
  ```
- Update `app/main.js` startup: `fs.readFileSync(path.join(__dirname, '../config.json'))`, merge into config object. Process.env vars (e.g. `PS_LOG_LEVEL=DEBUG node ...`) still override for scripting.
- **Ordering trap — `logLevel` must reach the logger before it's imported.** `app/logger.js`
  resolves its threshold from `process.env.PS_LOG_LEVEL` *at module-import time* (a top-level const).
  So `main.js` must read `config.json` and, when no env var is already set, do
  `process.env.PS_LOG_LEVEL ||= config.logLevel` **before** the `require('./logger')`. Otherwise the
  config's `logLevel` is silently ignored. (Same for `PS_TIMEZONE`, though `main.js` reads that lazily
  so it's less fragile — prefer reading `config.timezone` directly in `main.js` and dropping the
  `PS_TIMEZONE` env read, keeping env override only for `logLevel`.)
- Wire `saveLogs: false` into the `writeLog()` gate: if `!config.saveLogs`, skip both `.txt` and `.raw.txt` writes, emit a DEBUG log line instead.
- Add `config.json` to `.gitignore` so user edits don't accidentally commit. Provide `config.example.json` (committed) as the reference template.
- **Item 4 (credential doc):** Add a comment block at the top of `config.example.json` explaining: credentials are stored in Electron's `persist:showdown-ui` session partition automatically; there is nothing to configure here. The testclient key (local mode only) stays at `~/Documents/pokemon-showdown-client/config/testclient-key.js`.

Critical files: `app/main.js`, `app/logger.js` (reads `PS_LOG_LEVEL`), root `.gitignore`.

---

**Item 5 — Remove LLM ANALYSIS PROMPT from saved logs**

The `generateBattleLog` function in `helper/extension/lib/exporter.js` appends a structured LLM coaching prompt (~50 lines) after the raw protocol dump. Remove that entire section.

Changes:
- In `exporter.js`, delete the trailing "ANALYSIS PROMPT" block — [exporter.js:463-514](../helper/extension/lib/exporter.js#L463-L514) (`lines.push(hr('='))` through the final `hr('=')`). Keep everything above it (header, teams, field state, turn log, raw protocol).
- **Two tests encode this section and will fail — update both, this is not optional:**
  - [smoke.mjs:29](../helper/test/smoke.mjs#L29) asserts `assert.match(log, /LLM ANALYSIS PROMPT/, ...)`. Delete or invert that assertion (e.g. `assert.doesNotMatch`).
  - [golden.test.js](../helper/test/golden.test.js) diffs against `helper/test/golden/sample-battle.expected.txt`, which contains the whole prompt block. Regenerate it: `node helper/test/golden.test.js --update`, then **review the diff** — the only removed lines should be the prompt block, the last retained section should be "RAW PROTOCOL".
- Then run `npm test` (which includes the golden + edge-case + exporter tests) to confirm green.

---

### Phase 1 — Quick render wins (showdown-ui/src/lib/render.ts)

All three changes are in the same file (`render.ts`). Do them together.

**Item 1 — Drop "1 sets left" badge**

Current (render.ts:152):
```ts
b.revealedCount && b.possibleCount && b.possibleCount < b.sets.length
  ? `<span class="match">${b.possibleCount} sets left</span>`
  : ''
```

Change: add `b.possibleCount > 1` to the condition. When `possibleCount === 1`, the single matching set is already shown in full below the card head — no badge needed.

```ts
b.revealedCount && b.possibleCount && b.possibleCount > 1 && b.possibleCount < b.sets.length
  ? `<span class="match">${b.possibleCount} sets left</span>`
  : ''
```

**Item 11 — Remove level display**

- Remove `${b.level ? \`<span class="lvl">L${b.level}</span>\` : ''}` from `breakdownCard`'s card-head (render.ts:159).
- Remove `<span class="lvl">L${p.level}</span>` from `myActiveCard`'s card-head (render.ts:203).
- Per **Decision 1**, this divergence from `panel.js` is expected and allowed (`render.ts` is now the
  canonical helper UI; `panel.js` is frozen). Level display adds noise without value at competitive
  level caps (all mons are L50 in formats like VGC). `panel.js` (the extension) is untouched — extension
  users keep the level label. The one-time CLAUDE.md contract update in Decision 1 covers this; no
  per-item note needed beyond it.

**Item 6 — Tera / ability / item percentages must not break 100% from rounding**

The root cause is independent `Math.round()` on each entry, which can make a set sum to 99 or 101. Per
**Decision 2** we want *true probabilities* (a top-N slice may legitimately sum to <100 when a tail is
hidden) — but the full distribution must sum to exactly 100, and a displayed slice must never exceed
100. Fix with the largest-remainder method **over the full list, before slicing**.

Affected functions in `helper/extension/lib/lookup.js` — **all three**, not just tera/ability:
- [`predictItems`](../helper/extension/lib/lookup.js#L116) (`.slice(0, 3)`)
- [`predictTeras`](../helper/extension/lib/lookup.js#L134) (`.slice(0, 5)`)
- [`predictAbilities`](../helper/extension/lib/lookup.js#L150) (`.slice(0, 3)`)

Each currently does `.sort(...).slice(...).map(([k,count]) => ({..., pct: Math.round(count/grand*100)}))`.
Replace with a shared helper applied **before** the slice:
1. Over the full sorted `Object.entries(totals)`, compute `exact = count/grand*100`, `floor = Math.floor(exact)`, `rem = exact - floor`.
2. Distribute `100 - sum(floors)` extra points to the entries with the largest `rem` (ties broken by original count desc).
3. `pct = floor + bonus`. Then `.slice(0, N)`.

Because the full list sums to exactly 100, any top-N prefix sums to ≤100 and never >100. Empirically the
slice rarely cuts anything (only 2/504 mons exceed 5 tera types; abilities are ≤3), so in practice the
shown chips usually still total 100 — they just never total 101 anymore. No `render.ts` change needed —
it already renders `p.pct` verbatim. This fix flows to **both** surfaces (shared lib), consistent with
Decision 1.

---

### Phase 2 — New data / bug fixes

**Item 7 — Maushold-Four not loading**

**Diagnosis confirmed.** The protocol sends `Maushold-Four` → `toID` → `mausholdfour`. `pokedex.json`
has both `maushold` and `mausholdfour`, but the **sets file only has `maushold`** (the random-battle
data is keyed under the base form). So `getBreakdown('Maushold-Four')` finds no `entry` and renders
"No predicted-set data for this format." The base-form relationship is **not** recoverable from the
shipped data: `pokedex.json` does **not** carry a `baseSpecies` field today
([build-data.js:42-48](../helper/build-data.js#L42-L48) omits it). `parser.js` is fine — don't touch it.

Per **Decision 3**, fix at the data layer so it generalizes (Maushold-Three, Tatsugiri, Alcremie, every
cosmetic forme), not a `-Four`-only string hack:

1. **`build-data.js`** — add `baseSpecies: s.baseSpecies` to the emitted pokedex object at
   [build-data.js:42-48](../helper/build-data.js#L42-L48). Upstream `data/pokedex.ts` populates
   `baseSpecies` on forme entries (e.g. `mausholdfour.baseSpecies === 'Maushold'`); base entries leave
   it undefined, which is fine.
2. Regenerate `pokedex.json`. `build-data.js` runs the pokedex emission first (it only needs
   `data/pokedex.ts`, imported via type-stripping) but the file continues into the slow Monte-Carlo
   pass; rerun the whole `node helper/build-data.js` once (slow, one-time) and **verify**
   `node -e "const d=require('./helper/extension/data/pokedex.json'); console.log(d.mausholdfour.baseSpecies)"`
   prints `Maushold`.
3. **`lookup.js`** — in [`getBreakdown`](../helper/extension/lib/lookup.js#L172), after resolving
   `entry`, add a base-form fallback: if `entry` is null and `dex?.baseSpecies` is set, retry the sets
   lookup under `toID(dex.baseSpecies)`. Use that base id consistently for the downstream item/ability/
   tera/movesFreq lookups too (they're all keyed by the same id), so predictions resolve under the base
   form. Keep `name`/`types`/`baseStats` from the **forme's** dex entry so the card still shows
   "Maushold-Four" with the right typing.

Shared-lib fix → benefits both surfaces (Decision 1).

---

**Item 8 — Ability descriptions (largest item)**

Three-step implementation.

**Step A — Build the data file**

Source: `vendor/pokemon-showdown/data/text/abilities.ts`. This file lives in the already-vendored PS repo, so no scraping or network dependency. It's always in sync after `npm run update-upstream`.

The file exports ability text keyed by Showdown ability ID (e.g., `magicguard`) with a `shortDesc` field and an implicit display name derivable from the key (or from `vendor/pokemon-showdown/data/abilities.ts` which has the canonical `name` field).

Create `scripts/build-ability-descriptions.js`. It uses Node's type-stripping (`--experimental-strip-types`, already required for `build-data.js` and Node ≥ 22.6) to import both files directly:

```javascript
// Node >= 22.6: type-stripping allows importing .ts files
import { AbilityText } from '../vendor/pokemon-showdown/data/text/abilities.ts'
import { Abilities } from '../vendor/pokemon-showdown/data/abilities.ts'
```

For each entry in `AbilityText`, write:
```json
{
  "magicguard":  { "displayName": "Magic Guard",  "description": "The Pokémon only takes damage from attacks." },
  "levitate":    { "displayName": "Levitate",      "description": "Gives immunity to Ground-type moves." }
}
```

`displayName` comes from `Abilities[id].name` (canonical form with spaces and capitals). `description` comes from `AbilityText[id].shortDesc`. If `shortDesc` is absent, fall back to `AbilityText[id].desc` truncated at ~80 characters.

Output path: `helper/extension/data/abilities-desc.json`. Commit the generated file.

Add to `package.json`: `"build:ability-desc": "node --experimental-strip-types scripts/build-ability-descriptions.js"`.

Re-run this after every `npm run update-upstream` that changes upstream ability data (rare, but a one-liner).

**Step B — Load in showdown-ui**

In [`showdown-ui/src/lib/data.ts`](../showdown-ui/src/lib/data.ts)'s `loadCore()`, load
`abilities-desc.json` through the **existing `loadJson()` glob** rather than a static `import` — the
file lands under `helper/extension/data/` which is already covered by the
`import.meta.glob('../../../helper/extension/data/**/*.json')` at [data.ts:8](../showdown-ui/src/lib/data.ts#L8),
so a static import would be an inconsistent second loading path:
```ts
export interface Core { pokedex: any; moves: any; abilitiesDesc: Record<string, {displayName: string; description: string}> }

export async function loadCore(): Promise<Core> {
  if (_core) return _core
  const [pokedex, moves, abilitiesDesc] = await Promise.all([
    loadJson('/pokedex.json'),
    loadJson('/moves.json'),
    loadJson('/abilities-desc.json'),
  ])
  _core = { pokedex, moves, abilitiesDesc: abilitiesDesc || {} }
  return _core
}
```
It's a global table (not per-format), so `Core`/`loadCore()` is the right home. Per **Decision 1** this
is a `render.ts`-only (showdown-ui-canonical) feature; `panel.js` is not given the same treatment.

**Step C — Render in the panel**

In `render.ts`:
- `breakdownCard`: when a revealed ability is shown (the `known` section, line ~100), look up `core.abilitiesDesc[toID(ability)]` and append the description as a small muted line below.
- `breakdownCard`: when predicted abilities are listed as pills, show the `displayName` (with spaces) rather than the raw Showdown id.
- `myActiveCard`: same treatment for the actual ability.

Display format inside the `.known` section:
```html
<b>Ability:</b> Magic Guard
<span class="ability-desc muted">The Pokémon only takes damage from attacks.</span>
```

Add `.ability-desc` to `global.css` (mirroring the style in `panel.css` if/when that gets the same treatment): `font-size: 11px; color: var(--muted); display: block; margin-top: 2px;`.

---

### Phase 3 — New UI features (showdown-ui)

**Item 10 — Show opponent's HP**

`state.active` already tracks opponent HP (from `|switch|`, `|-damage|`, `|-heal|` frames). It just isn't passed through to `breakdownCard`.

Changes in `render.ts`:
1. Change the "Opponent active" rendering loop in `renderBattle` (lines 295-297) to pass the active pokemon's HP data:
   ```ts
   active.map((p: any) => breakdownCard(p.species, s.revealed[opp]?.[idOf(p.species)], core, fmt, { hp: p.hp, maxhp: p.maxhp, status: p.status }))
   ```
2. Add optional `activeHp?: {hp: number; maxhp: number; status?: string}` parameter to `breakdownCard`.
3. In `breakdownCard`'s card-head, after the name span, add:
   ```ts
   ${activeHp ? `<span class="hp">${Math.round(activeHp.hp / (activeHp.maxhp || 100) * 100)}%${activeHp.status ? ' ' + esc(activeHp.status) : ''}</span>` : ''}
   ```

No change to `parser.js` — it already populates `state.active[pos].hp` and `.maxhp` from frames.

**Also:** update the `renderSideHtml` path (used in spectator mode, lines 233-234) the same way so spectated battles also show HP.

---

**Item 2 — GitHub link in the native header**

The PS home screen links live inside the embedded WebContentsView (live play.pokemonshowdown.com). We don't modify that page.

Add a GitHub icon/link to the right side of `App.tsx`'s `<header>` (currently shows "Battle Helper UI" label):

```tsx
// In the header's right side:
<button
  onClick={() => window.psUI.openExternal('https://github.com/<your-repo>')}
  style={{ background: 'none', border: 'none', cursor: 'pointer', color: 'var(--muted)', fontSize: 11 }}
  title="About this app"
>
  GitHub ↗
</button>
```

Wire the IPC:
- `showdown-ui/electron/preload/index.ts`: expose `openExternal(url: string)` via `contextBridge.exposeInMainWorld`.
- `showdown-ui/electron/main/index.ts`: handle `ipcMain.on('open-external', (_, url) => shell.openExternal(url))`.

**Item 3 (log viewer) — Open logs folder button**

In the same header, add an "Open Logs" button that opens the `logs/battle_info/` folder in Finder/Explorer.

- **Caveat — showdown-ui does not write logs.** Per its own CLAUDE.md ("No battle log writing — that's
  `../app/main.js`'s job"), the folder is only populated when the user *also* runs `npm start` (the main
  app). So this button may open an empty/nonexistent folder for a pure `start:ui` user. Acceptable as a
  convenience, but `shell.openPath` on a missing dir is a no-op that returns an error string — handle
  it: if the path doesn't exist, fall back to opening the repo root (or show a toast).
- **Don't hardcode `~/Documents/ps-local`.** That's this machine's layout, not a guarantee. Derive the
  repo root from the app's location — in dev, `electron/main/` resolves up to `showdown-ui/`, whose
  parent is the repo root (`join(__dirname, '../../..')` from the built main, then `logs/battle_info`).
  Verify against `app.isPackaged` if a packaged build is ever in scope. Prefer reading the path from the
  shared `config.json` (Phase 0) if one is wired for showdown-ui.
- `electron/main/index.ts`: `ipcMain.on('open-logs', ...)` resolving the path as above.
- `electron/preload/index.ts`: expose `openLogs()` via contextBridge.
- `App.tsx` header: add an "Open Logs ↗" button next to the GitHub link.

---

**Item 12 — Close/reopen the battle helper panel**

Layout: the right panel can be hidden; the PS game view expands to fill. Per **Decision 4**, the
reopen affordance lives in the **top header bar** (`App.tsx`), which sits above the psView region and is
never occluded by the native `WebContentsView`. (A `position:fixed` right-edge button was rejected — the
psView composites *above* the renderer DOM, so it would be hidden once the game region expands.)

Because the toggle is in the header (owned by `App.tsx`) but the layout it controls is in `Battle.tsx`,
**lift `helperOpen` state to `App.tsx`** and pass it down.

Changes in [`App.tsx`](../showdown-ui/src/App.tsx):
1. `const [helperOpen, setHelperOpen] = useState(true)`.
2. In the header's right side, a toggle button (sits alongside the GitHub / Open Logs buttons from
   items 2/3):
   ```tsx
   <button onClick={() => setHelperOpen(o => !o)} title={helperOpen ? 'Hide helper' : 'Show helper'} style={iconBtn}>
     {helperOpen ? '⟩ Hide Helper' : '⟨ Show Helper'}
   </button>
   ```
3. Pass down: `<Battle helperOpen={helperOpen} />`.

Changes in [`Battle.tsx`](../showdown-ui/src/routes/Battle.tsx):
1. Accept `{ helperOpen }: { helperOpen: boolean }` as a prop.
2. The helper column's `width` is `helperOpen ? helperWidth : 0` with `overflow: 'hidden'`; the divider's
   `display` is `helperOpen ? 'block' : 'none'` (and `pointerEvents` off when hidden).
3. **Re-report psView bounds after the layout settles.** `report()` (which calls
   `window.psUI.setGameBounds`) must fire *after* React applies the width change, or the psView won't
   grow/shrink to match. Add an effect keyed on `helperOpen`:
   ```ts
   useEffect(() => { requestAnimationFrame(report) }, [helperOpen, report])
   ```
   `requestAnimationFrame` guarantees the DOM has the new width before we measure `gameRef`, without
   guessing a timeout. (The existing `ResizeObserver` on `gameRef` may also catch this, but the explicit
   rAF makes the intent clear and avoids depending on observer timing.)

`helperWidth` retains the user's last drag-adjusted value across toggles (it's separate state — do NOT
reset to the `380` default on reopen).

---

## Verification plan

| Item | How to verify |
|------|---------------|
| 3+9 config | Edit `config.json`, set `saveLogs: false`, play a synthetic battle (`PS_SYNTHETIC=1 npm start`). Confirm no file written to `logs/battle_info/`. |
| 5 LLM prompt | Check an existing log file after the change — the last section should be "RAW PROTOCOL", not "LLM ANALYSIS PROMPT". |
| 1 sets left | Run `npm run start:ui`, play a random battle. Narrow a card to 1 possible set — badge disappears. With 2+ possible sets — badge still shows. |
| 11 levels | Confirm no "L50" label appears in any card in the battle helper. |
| 6 percentages | Find a Gen9 Doubles battle with Spectrier. Confirm tera/ability/item percentages never exceed 100 in total and never show the old 101% artifact (a hidden tail may legitimately leave them <100 — Decision 2). Sanity-check the full unsliced distribution sums to 100 in a `node -e` repro. |
| 7 Maushold-Four | Play or spectate a Gen9 Doubles game that includes Maushold-Four. Confirm its card shows predicted data (sets, items, tera) instead of "No predicted-set data for this format." |
| 8 abilities | Open any battle — confirmed cards should show ability display name (with spaces) and a one-line description beneath. |
| 10 opponent HP | In a live battle, damage an opponent's Pokemon. Confirm the HP% in their card updates in real time. |
| 2 GitHub link | Click "GitHub ↗" in the header — browser opens to the repo. |
| 3 log viewer | Click "Open Logs ↗" — Finder opens `logs/battle_info/`. |
| 12 panel toggle | Click the header "Hide Helper" — PS view expands to full width and the divider disappears. Click "Show Helper" — panel restores at its last dragged width (not 380). Confirm the button is never hidden behind the PS view. |

---

## Files that will change

| File | Items |
|------|-------|
| `config.json` (new) + `config.example.json` (new) | 3, 4, 9 |
| `app/main.js` | 3 (config read + saveLogs gate) |
| `helper/extension/lib/exporter.js` | 5 (delete prompt block) |
| `helper/test/smoke.mjs` + `helper/test/golden/sample-battle.expected.txt` | 5 (update assertion + regen golden) |
| `showdown-ui/src/lib/render.ts` | 1, 8, 10, 11 (NOT 6 — that's lookup.js) |
| `helper/extension/lib/lookup.js` | 6 (largest-remainder, all 3 predictors), 7 (base-form fallback) |
| `helper/build-data.js` | 7 (emit `baseSpecies` into pokedex.json) |
| `scripts/build-ability-descriptions.js` (new) | 8 |
| `helper/extension/data/abilities-desc.json` (generated) | 8 |
| `showdown-ui/src/lib/data.ts` | 8 (load abilitiesDesc into Core via loadJson) |
| `showdown-ui/src/routes/Battle.tsx` | 12 (accept `helperOpen` prop, collapse + rAF re-report) |
| `showdown-ui/src/App.tsx` | 2, 3 (header buttons), 12 (own `helperOpen` state + toggle) |
| `showdown-ui/electron/preload/index.ts` | 2, 3 |
| `showdown-ui/electron/main/index.ts` | 2, 3 |
| `showdown-ui/CLAUDE.md` + root `CLAUDE.md` | Decision 1 (retire byte-faithful contract; panel.js frozen) |
| `package.json` | 8 (add build:ability-desc script) |
| `.gitignore` | 3 (add config.json, keep config.example.json tracked) |
| `app/logger.js` / `app/main.js` | 3+9 (config read + logLevel ordering, see Phase 0) |

---

## Tradeoffs to be aware of

**Item 8 (ability descriptions):**
- ~300 ability entries → the generated JSON is ~60–80 KB, trivially small.
- If `vendor/pokemon-showdown/data/text/abilities.ts` exports a namespace that Node's type-stripping can't resolve cleanly (some PS files use complex TS constructs), fall back to reading the file as text and extracting `shortDesc` values with regex — the structure is uniform enough for this.
- Re-run `npm run build:ability-desc` after any `npm run update-upstream` that touches abilities (rare; usually only new generations).

**Item 11 (level) parity:**
- `render.ts` is contractually byte-faithful to `panel.js`. This change accepts a deliberate divergence for showdown-ui. Keep the note in `showdown-ui/CLAUDE.md` so future contributors understand this is intentional, not an oversight.

**Item 12 (panel toggle):**
- `helperWidth` retains the user's last drag-adjusted value across toggles. Do NOT reset to the default `380` on reopen.
- The reopen control lives in the **top header** (Decision 4), not as a `position:fixed` floating button.
  A `fixed` renderer element would be **hidden behind** the psView: a `WebContentsView` is a native layer
  composited *above* the BrowserWindow's DOM, so once the game region expands to full width any fixed
  element in that region is occluded. The header sits above the psView's reported bounds and stays clickable.
