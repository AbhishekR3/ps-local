# PS Random-Battle Helper

A Chrome side-panel extension that runs alongside your live Pokémon Showdown **random
battles** and, for every Pokémon on the field (and every one the opponent reveals), shows a
full breakdown: types, base stats, possible abilities, predicted movesets (by role, with
physical/special/status icons and base power), tera types, and **likely held items**. As the
opponent reveals moves the panel **narrows the predicted set** (highlighting moves already
seen) and sharpens the item prediction. For your own active Pokémon it shows the **real set**
from the battle's `|request|` — final stats, item, ability, tera, and moves.

The predictions come from the *same data Showdown uses to generate random teams*
(`data/random-battles/**`), so for random formats they are exact, not guesswork. Item
predictions are sampled from the real team generator at build time (see below).

## Browser compatibility

Works in any browser that supports **Manifest V3 Web Extensions** — Chrome, DuckDuckGo,
Edge, Firefox, Safari 16+. No Chrome-specific APIs (`sidePanel` etc.) are used.

The panel renders as a fixed overlay injected into the PS page, so it never depends on a
browser-specific side-panel API.

## How it works

```
injected.js (MAIN world) ──window.postMessage──▶ content.js (ISOLATED)
                                                    ├─▶ background.js  (per-room buffer, persisted)
                                                    └─▶ panel iframe   (live frames, foreground room only)
                                                           └─▶ parser.js ─▶ lookup.js ─▶ UI
```

- **`injected.js`** (MAIN world, `document_start`) wraps `window.WebSocket` to observe the
  protocol stream the client receives (version-independent — depends only on the documented
  wire protocol) and re-broadcasts each frame via `window.postMessage`. It must be a
  manifest-declared MAIN-world script (not a DOM-injected `<script>`) to bypass the page CSP,
  and must be in place *before the PS bundle loads*: SockJS captures `window.WebSocket` once
  at module-load time, so `document_start` guarantees the wrapper wins.
- **`content.js`** (ISOLATED world) injects the panel iframe overlay + resize grip, buffers
  **every** battle room's frames in the background, and forwards live frames to the panel
  **only for the foreground room** so a second open battle can't corrupt the panel's state.
  Foreground detection reads `location.pathname + location.hash` via a 700 ms poll (not
  `hashchange` — the PS client routes by pathname, not just hash). Wraps
  `chrome.runtime.sendMessage` in `safeSend()` which catches the synchronous throw when
  the extension context is invalidated after a reload, tears down the stale script, and
  suppresses further errors. Notifies the panel on `panel-shown` / `room-changed`.
- **`background.js`** keeps a per-room frame buffer (≤2000 frames × ≤6 rooms) and mirrors it
  to `chrome.storage.session` (debounced), so an MV3 worker restart rehydrates instead of
  losing the battle. The panel reconstructs state even when opened mid-battle.
- **`lib/parser.js`** turns protocol frames into a `BattleState` (active field with live
  HP/status, revealed opponents with ability/item/**used moves**/fainted, your own team from
  `|request|`, and `ended`/`closed` flags). Items are captured from three frame types:
  explicit `|-item|`, inline `[from] item: X` tags on heal/damage frames (Leftovers, Life Orb,
  Rocky Helmet …), and `|-enditem|` (berry consumed, Knock Off).
- **`lib/lookup.js`** — `getBreakdown(species, data, revealedMoves)` maps `species + format` →
  breakdown, narrowing sets by revealed moves and returning top-3 weighted `predictedItems`.
- **`lib/data.js`** lazy-loads the bundle: `loadCore()`, `loadSets(key)`, `loadItems(key)`.
- **`lib/api.js`** is a one-line `browser ?? chrome` shim so the same code runs on all
  browsers without modification.

## Build the data bundle

The extension ships static JSON generated from the parent repo. Regenerate it whenever the
upstream PS data changes:

```bash
# 1. Compile the simulator — the item step imports the real team generator from dist/sim.
npm run build            # in the repo root

# 2. Regenerate the bundle.
cd battle-helper && node build-data.js
```

`build-data.js`:

- imports `data/pokedex.ts` and `data/moves.ts` directly (Node ≥ 22 strips the data-only TS
  types) → trimmed `pokedex.json` / `moves.json`;
- copies the `random-battles` set files into `extension/data/sets/`;
- **predicted items** — runs the real generator (`Teams.getGenerator(format).randomSet(...)`,
  200×/species) and tallies the chosen item keyed `species → role → item` into
  `items/<key>.json`. Random-battle items aren't stored statically anywhere (they're chosen at
  generation time from the rolled set), so we sample the generator to learn the distribution;
  keying by role lets the prediction sharpen as revealed moves narrow the set. This step needs
  the compiled `dist/sim`, hence the `npm run build` prerequisite. (gen1 has no items and is
  skipped. Sampling uses empty team-details, so rare weather/team-context item branches aren't
  reflected.)

## Load the extension

**DuckDuckGo (Mac)**

1. Open DuckDuckGo → Settings → **Extensions** → enable **Developer Mode**.
2. Click **Load Unpacked** → select `battle-helper/extension`.
3. Go to <https://play.pokemonshowdown.com> and click the extension icon in the toolbar to
   toggle the panel.

**Chrome / Edge**

1. Open `chrome://extensions` (or `edge://extensions`), enable **Developer mode**.
2. **Load unpacked** → select `battle-helper/extension`.
3. Same as above.

The panel appears as a right-side overlay on the PS page. Use the toolbar button or the
✕ button in the panel to toggle it. **Drag the panel's left edge to resize it** — the width
is saved (`chrome.storage.local`) and restored on every page.

## Test

```bash
cd battle-helper
node --test
```

20 offline test cases cover the protocol parser, the lookup engine, and the full frame →
tracker → breakdown pipeline (no browser required). `test/content.test.js` loads
`content.js` in a Node vm sandbox with a mocked extension environment and guards against
the orphaned-context bug (verifies the script tears down quietly rather than throwing when
`chrome.runtime` is invalidated).

### Manual verification

After any extension reload, **hard-reload the PS tab** (Cmd-Shift-R) — the WebSocket tap
is installed at page load and cannot be re-injected into an already-open tab.

In a `gen9randombattle`, check:

- Own active card shows HP ≤ 100%, category icons on moves, correct item/ability/tera.
- Opponent item predictions sharpen as moves are revealed; sets narrow and used moves highlight.
- Fainted opponent Pokémon drop to the bottom of the bench list.
- Closing a battle shows "Waiting for next game…"; reopening mid-battle reconstructs state correctly.
- Drag-resize the panel's left edge — width persists across tab reloads.
- With two battles open simultaneously, switching between them shows no stale carry-over.

## Notes & scope

- **Random battles only.** `resolveSetsKey()` returns `null` for non-random formats (OU,
  VGC, …) — those have no in-repo set files. The panel still shows dex info (types/stats)
  but no predicted moves for them.
- Predicted movepools list the **full set of moves a Pokémon may run** per role (often more
  than 4), which is the same information strong players reason from — not the exact 4.
- Source logic is plain ES modules (`.js`) rather than TypeScript so the extension loads
  with **zero build step**; JSDoc typedefs document the shapes. Only the data bundle is
  generated.
- Generations 1–9 singles + Gen 9 doubles are bundled. Add more by extending the copy loop
  in `build-data.js` and the key logic in `resolveSetsKey()`.
- **Game-over states.** `|win|`/`|tie|` keeps the final board with a "Battle over" banner;
  `|deinit|` (room closed) clears the panel to "Waiting for next game…".

