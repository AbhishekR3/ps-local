# Upstream update workflow

The two repos under `vendor/` are pinned submodules. Updating them is a single command, gated by the
helper tests so a breaking upstream change is caught immediately.

## Routine update

```bash
# Must be on a clean tree (update-upstream refuses otherwise).
npm run update-upstream
```

This:

1. Verifies the working tree is clean.
2. `git submodule update --remote --merge` — bumps both submodules to upstream latest. Logs the
   before/after short SHAs (server + client).
3. Rebuilds the server (`npm ci && npm run build`) and client (`npm ci && node build`).
4. Re-applies the config overlays (`scripts/apply-overlay.js`).
5. Runs the helper tests. On failure it prints:
   `UPSTREAM BROKE HELPER TESTS server=<sha> client=<sha>` and exits non-zero.

All steps are timed and written to `logs/debug/update-<timestamp>.log`.

If it succeeds, commit the pointer bump:

```bash
git add vendor/
git commit -m "chore: bump submodules to latest upstream"
```

## If the helper tests fail

An upstream change altered the protocol shapes `parser.js`/`exporter.js` depend on. Investigate:

```bash
# What changed in the server between the old and new SHAs (printed by update-upstream):
git -C vendor/pokemon-showdown log --oneline <oldSha>..<newSha>
# Protocol changes specifically:
less vendor/pokemon-showdown/sim/SIM-PROTOCOL.md
```

Fix `helper/extension/lib/parser.js` / `exporter.js` to match, re-run `npm test`, then commit both the
submodule bump and the helper fix.

## CI canary

`.github/workflows/upstream-canary.yml` runs the same bump-build-test on a weekly schedule (and on
manual `workflow_dispatch`). If the helper tests or protocol smoke fail against upstream latest, it
files an issue labeled `upstream-breakage` with the offending SHAs — so you find out before you next
pull. (The canary does **not** commit the bump; it only alerts.)

One-time label setup after the workflow is first pushed:

```bash
gh label create upstream-breakage --color FF0000 --description "Upstream submodule change broke the helper"
```

## When to rebuild the data bundle

`npm run update-upstream` does **not** regenerate `helper/extension/data/` (it's slow — Monte-Carlo over
the team generator). Rebuild it manually only when upstream changed sets/moves/Pokédex and you want the
panel's predictions current:

```bash
cd vendor/pokemon-showdown && npm run build && cd ../..
cd helper && node build-data.js
git add helper/extension/data/
git commit -m "chore: regenerate helper data bundle from upstream"
```
