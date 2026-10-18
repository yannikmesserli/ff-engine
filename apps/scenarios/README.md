# scenarios

Vite app to try a rule in the browser from a prepared position, without playing up to it: pick a scenario, follow its
instructions, and play on with the full `<BloodBowlGame>` (physical dice entry, undo back to the scenario's start).

**For testing only**: the scenario teams give players skills freely, and dice are entered by hand.

```
pnpm scenarios    # from frontend/: http://localhost:5174 (?scenario=<id> opens one directly)
```

Images come from the playground's `apps/playground/public/img/` (git-ignored, see `packages/board-ui/README.md`).

## Adding a scenario

A scenario (`src/scenarios.ts`) is two team files (often a few players each), a seed, and the engine actions that lead
from a new game to the position. `<BloodBowlGame actions={...}>` replays them with the engine's `applyActions`, so a
scenario only goes through legal steps, and the state stays consistent.

- `toFirstTurn({ home, away, ball })` builds the actions to reach home's first turn: nice weather, away kicks, both
  teams set up on the given squares (players by number), and a quiet kick-off ending with the ball on `ball` (caught
  by the home player standing there, if any). Add more actions after it to go further (`{ type: "ROLL", values: [...] }`
  for fixed dice).
- `toKickoff({ home, away }, target)` stops earlier: the ball has just been kicked to `target`, and the deviation roll
  is next.
- `src/scenarios.test.ts` checks every scenario still reaches home's first turn; add a check that the scenario offers
  what it is meant to show.
