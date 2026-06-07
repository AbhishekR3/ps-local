# Contributing to ps-local

Thanks for your interest! This guide covers local setup, the one hard architectural rule, and what CI
expects from a pull request.

## Setup

```bash
git clone https://github.com/AbhishekR3/ps-local && cd ps-local
git submodule update --init --recursive
npm run setup       # builds the PS server + client, applies config overlays, installs deps, runs tests
```

**Requirements:** Node.js **≥ 22.6** (the data tooling imports `.ts` via Node type-stripping; older
Node fails with a misleading syntax error), npm ≥ 10, git.

Run the app:

```bash
npm start            # official mode — wraps live play.pokemonshowdown.com (needs no local build)
npm run start:local  # offline sandbox — spawns the bundled server + client (needs npm run setup first)
```

## The one rule: never source-edit `vendor/`

The two upstream Pokémon Showdown repos live under `vendor/` as **pristine git submodules**. Nothing
in `vendor/` is ever edited directly. Every customization belongs in one of:

- `overlay/` — config overlays applied onto the (gitignored) vendor `config/config.js` via
  `npm run apply-overlay`
- `app/` — the Electron layer (main, preload, loggers)
- `helper/` — the extracted extension + the pure parser/exporter libs + tests

After any change, both submodules must stay clean:

```bash
git -C vendor/pokemon-showdown status --porcelain        # must be empty
git -C vendor/pokemon-showdown-client status --porcelain # must be empty
```

If either is dirty, you've coupled to upstream — back it out and use an overlay or the `app/`/`helper/`
layers instead. See [CLAUDE.md](CLAUDE.md) for the full architecture and the C1–C7 contracts.

## Running tests

```bash
npm run test:smoke                             # fast: one fixture battle through parser -> exporter
npm run test:deep                              # full helper suite (unit + golden + edge cases)
npm test                                       # alias for the full suite (cd helper && node --test)
cd helper && node --test test/parser.test.js   # a single test file
```

CI runs `test:smoke` + the unit suite on every PR (`.github/workflows/test.yml`). A heavier
`deep-test.yml` runs nightly / on-demand: it also builds the bundled PS server and launches the real
Electron app in `PS_SYNTHETIC` mode under Xvfb to assert the end-to-end logging path writes a file.

If you intentionally change exporter output, regenerate the golden file:
`node helper/test/golden.test.js --update`.

The pure libs `helper/extension/lib/parser.js` and `helper/extension/lib/exporter.js` are imported by
**both** the Electron main process and the browser extension. Keep them dependency-free — no Node-only
or chrome/browser APIs — or you break one of the two consumers.

To exercise the end-to-end log-writer path without playing a battle (no server/window/extension), use
the synthetic driver:

```bash
PS_SYNTHETIC=1 npm start   # feeds a fixture battle through the real log path, writes logs/, quits
```

### Environment gotcha

If `require('electron')` returns a path instead of the Electron API (app crashes immediately), your
shell has `ELECTRON_RUN_AS_NODE=1` set, which makes Electron run as plain Node. Strip it:

```bash
cd app && env -u ELECTRON_RUN_AS_NODE ./node_modules/.bin/electron .
```

A normal user terminal doesn't set this, so `npm start` works unmodified there.

## Submitting a pull request

1. Branch off `main`, make your change, keep both submodules clean.
2. Run `npm test` locally.
3. Open a PR. CI (`.github/workflows/test.yml`) runs on every PR and must pass:
   - **gitleaks** secret scan (full history) — never commit `helper/.env` or
     `helper/extension/data/config.json` (both gitignored)
   - helper unit tests (smoke + full suite + golden + edge cases)
   - Codacy code-quality analysis (`.github/workflows/codacy.yml`; scope in `.codacy.yaml`)
4. Keep commits scoped and write a clear description of what changed and why.

## Reporting issues

Use the GitHub issue templates. Include your OS, Node version (`node --version`), the mode
(official/local), and relevant lines from `logs/debug/` (run with `PS_LOG_LEVEL=DEBUG` for detail).
