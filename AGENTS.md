# Agent guide: ff-engine

A browser-only BB2025 fantasy football engine plus a React game component (pnpm workspace). Start with `README.md`, then the
README of the package you touch:

- `packages/engine` (`@ff-engine/engine`): pure rules engine. Read `packages/engine/README.md` before changing rules.
- `packages/data` (`@ff-engine/data`): rosters, example teams, formations, zod schemas.
- `packages/board-ui` (`@ff-engine/board-ui`): the `<FantasyFootballGame>` React component.
- `apps/playground`: Vite app hosting the component (online games and hot-seat).
- `apps/relay`: WebSocket relay for online games (Node, `ws`), no storage.
- `apps/scenarios`: Vite app starting games from prepared positions (`src/scenarios.ts`), to try a rule in the browser.

## Commands (run from `frontend/`)

```
pnpm test        # vitest: engine unit tests + 40 full random games between test teams of every roster (data.test.ts)
pnpm typecheck   # tsc in every package
pnpm lint        # biome (lint only, no formatting)
pnpm build       # playground production build
pnpm dev         # playground on http://localhost:5173 (?seed=42 replays the same dice) + relay on :8787
pnpm scenarios   # prepared positions on http://localhost:5174 (?scenario=<id>)
```

Run `pnpm lint && pnpm typecheck && pnpm test` before reporting any change as done. CI runs all three on every pull
request, and they must pass before merging.

## Rules

- Target ruleset: **BB2025 only**. Older editions (BB2016, BB2020) differ in many details, so don't port rules from
  them.
- Describe rules in game terms in comments and docs (what is rolled, modifiers, who chooses). Don't cite other Blood
  Bowl implementations or their class names.
- Rosters come from FUMBBL's BB2025 ruleset (`pnpm fetch-rosters`, network).
- Never commit an image. Graphics are not part of this project: FUMBBL's player sprites and team logos are only
  downloaded for testing (`pnpm fetch-artwork`, into the git-ignored `apps/playground/public/fumbbl/`).

## Engine conventions

- Rules are a procedure stack: each procedure is plain serializable data on `state.stack`; its handler in
  `packages/engine/src/procedures/` exposes `step(ctx, proc, action)` (returns `"continue"`, `"wait"` or `"done"`)
  and `actions(state, proc)` (the action templates offered while it waits).
- Every die is a `ROLL` action. Tests pass explicit values (`roll(4, 3)`); never call `Math.random`.
- `step` is pure (Immer). Keep `GameState` JSON-serializable: no classes, Maps or functions.
- Coordinates: home on the left (scores at x = 25), d8 directions clockwise from north (1 = N).
- When a rule lands, update the "Implemented so far" / "Not yet" lists in `README.md`.

## Tests

- `packages/engine/src/engine.test.ts` builds positions with helpers (`toFirstTurn()`, `apply(state, ...actions)`,
  `roll(...)`, `find(state, "TEMPLATE")`, `types(state)`) and mutates a `structuredClone` of the state to place
  players. Add a `describe` block per rule with fixed dice.
- `packages/data/src/data.test.ts` plays full games with random legal actions, between test teams built from every
  roster (`rosterTeam`: one of each position, then linemen), so each roster's skills come up. When you add an action
  template, teach `randomAction` how to answer it, or those games stall.

## Code style

- Terse one-line JSDoc on every export and non-obvious helper. No `@param` boilerplate. Match the comment density
  around you.
- Keep the exports of each package's `src/index.ts` stable; other packages import them.

## Skills

- `.claude/skills/add-rule`: workflow for implementing a BB2025 rule, action or player skill in the engine.
- `.claude/skills/run-playground`: launch the playground and check a change in the browser.
