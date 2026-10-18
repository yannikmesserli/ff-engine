---
name: run-playground
description: Launch the Blood Bowl playground (Vite + React) from frontend/ and check a change in the browser. Use when asked to run, start, screenshot or manually test the frontend game.
---

# Run the playground

From `frontend/`:

```
pnpm install            # once
pnpm dev                # Vite on http://localhost:5173 (run it in the background)
```

- `http://localhost:5173/?seed=42` replays the same dice; use a fixed seed to reproduce a situation.
- The pitch, dice and ball come from `apps/playground/public/img/` (git-ignored, not shipped; layout in
  `packages/board-ui/README.md`). Player sprites and team logos come from `pnpm fetch-artwork` (FUMBBL's, downloaded
  into `apps/playground/public/fumbbl/` for testing only, never committed); without them the board shows numbered
  discs.
- `pnpm build` makes a production build. It catches errors that `pnpm typecheck` misses in the app entry.

To reach a game situation faster than clicking through, reproduce it in an engine test
(`packages/engine/src/engine.test.ts`) with fixed dice. To check it in the browser, add a scenario to
`apps/scenarios/src/scenarios.ts` (teams plus the actions leading there) and run `pnpm scenarios`
(http://localhost:5174/?scenario=<id>).

Stop the dev server when done.
