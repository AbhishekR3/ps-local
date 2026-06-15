## Summary

<!-- What does this PR do? Link the relevant issue if any (e.g. "Closes #123"). -->

## Type

- [ ] Bug fix
- [ ] Feature
- [ ] Refactor / cleanup
- [ ] Docs / config only

## Checklist

- [ ] `npm test` passes (helper suite + guards)
- [ ] `npm run test:smoke` passes
- [ ] `npm run lint` passes
- [ ] `npm run typecheck:ui` passes (if `showdown-ui/` touched)
- [ ] `vendor/` submodules are still git-clean after changes (`git -C vendor/pokemon-showdown status --porcelain` is empty)
- [ ] If the ad-block list changed in one file, it was updated in **both** (`app/main.js` ↔ `showdown-ui/electron/main/index.ts`)
- [ ] If `render.js` CSS classes changed, styles updated in **both** `panel.css` and `global.css`

## Testing

<!-- How did you test this change? (manual steps, which scenarios covered, new tests added) -->
