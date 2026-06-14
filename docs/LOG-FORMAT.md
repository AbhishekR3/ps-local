# Battle log format

Each finished battle writes one file to `logs/`:

| File | Contents |
|---|---|
| `<roomid>_<RESULT>_vs_<opponent>_<timestamp>.txt` | rich, human/LLM-readable analysis |

The verbatim PS protocol frames are embedded in the rich `.txt` itself (the **RAW PROTOCOL** section
below), so the file is self-contained — no separate `.raw.txt` is written.

## Filename fields

- `roomid` — e.g. `battle-gen9randombattle-1`
- `RESULT` — `WIN | LOSS | TIE | INPROGRESS`, from **your** perspective. It's derived from the parsed
  state: ended + winner is you → `WIN`; ended + winner is the other side → `LOSS`; ended + no winner →
  `TIE`; not ended (e.g. the room was closed mid-battle past turn 1) → `INPROGRESS`. "You" is the side
  named in the `|request|` your client received; if none was seen it defaults to `p1`.
- `opponent` — the other side's display name (filesystem-sanitized to `[A-Za-z0-9_-]`); `unknown` if
  not yet revealed.
- `timestamp` — `Date.now()` at write time.

## Rich `.txt` sections

Produced by `generateBattleLog(state, rawFrames, movesData)` in
`helper/extension/lib/exporter.js` (synchronous). Sections, in order:

1. **POKEMON SHOWDOWN BATTLE LOG** — summary: format/tier, result, turn count, players.
2. **YOUR TEAM (full details from request data)** — your six, with stats/moves/ability/item/tera from
   the `|request|`. Empty if no request was captured (e.g. spectating).
3. **OPPONENT TEAM (… — revealed during battle)** — the opponent's Pokémon as they were revealed,
   with revealed moves/abilities/items.
4. **FIELD STATE AT END OF BATTLE** — weather, terrain, pseudo-weather, side conditions, boosts.
5. **TURN-BY-TURN BATTLE LOG** — each turn's moves with damage deltas and effects. Move names are
   annotated (e.g. `Earthquake (Ground · Physical · 100 BP)`) when the move data bundle is loaded;
   otherwise bare move ids are shown.
6. **RAW PROTOCOL (complete reference — all WebSocket frames)** — the decoded SockJS frames,
   embedded for a self-contained file.
7. **LLM ANALYSIS PROMPT** — a ready-to-paste prompt for asking an LLM to analyze the game.

Move annotations come from `helper/extension/data/moves.json`, loaded once by the Electron main
process. If that file is missing the rich log still renders, just with bare move ids.

## Raw protocol section

The decoded SockJS battle frames, joined by newlines, exactly as received from the server — the
ground-truth record if the rich exporter ever has a bug. Embedded as section 6 of the rich `.txt`.
