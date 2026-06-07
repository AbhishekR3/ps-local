# overlay/ — config overlays for the vendored submodules

The submodules under `vendor/` are **pristine** — no source file there is ever edited. The only way
we configure them is by writing to their **gitignored** `config/config.js` files. `apply-overlay`
copies the files here onto those targets.

| Overlay | Copied to | Loaded by |
|---|---|---|
| `server-config.js` | `vendor/pokemon-showdown/config/config.js` | the PS server |
| `client-config.js` | `vendor/pokemon-showdown-client/config/config.js` | the web client (non-testclient entry) |

Apply with:

```bash
npm run apply-overlay     # = node scripts/apply-overlay.js
```

## Why the targets stay clean (the invariant)

Both submodules gitignore `config/config.js` (verified — `git -C <submodule> check-ignore
config/config.js` prints the path in both). So writing our config there never dirties the submodule.
After `apply-overlay`, `git -C vendor/pokemon-showdown status --porcelain` (and the client) must be
**empty**. If either shows dirty, the overlay leaked into a tracked path — back it out.

## Server overlay is minimal on purpose

`server/config-loader.ts` loads config as `{ ...config-example.js, ...config.js }` — it spreads the
example defaults first, then overrides with our file. So `server-config.js` only needs the keys that
differ from upstream (`port`, `bindaddress`, `noguestsecurity`, `repl`); everything else
(login-server keys, routes, etc.) falls back to the example. Note `nologin` / `autosavereplays` are
**not** real config keys (not in `config-example.js`) — `noguestsecurity = true` is the key that
enables local guest play.

## Client overlay is secondary

Our entry point is `testclient-new.html`, which:
- loads `config.js` from the **public site** (`https://play.pokemonshowdown.com/config/config.js`),
  not the local file, and
- is targeted at the local server purely by the `?~~localhost:8000` URL param it parses itself.

So the local `client-config.js` does **not** govern the testclient path — the URL param does. The
overlay is kept for completeness and for the regular (non-testclient) client entry. (The public
`config.js` fetch is also why the app currently needs network access on first load; see the privacy
note in the top-level README.)
