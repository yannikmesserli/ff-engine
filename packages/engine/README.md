# @bb/engine

Pure TypeScript Blood Bowl rules engine, no UI. It follows the **BB2025** rules. The whole game is a serializable `GameState`,
every random number comes from a seeded RNG stored in that state, and `step` is pure, so saves, replays and undo
are just a matter of keeping states.

```ts
import { createGame, getAvailableActions, step } from "@bb/engine";

let state = createGame(home, away, { seed: 42 }); // TeamSetup x2, already at the first decision
getAvailableActions(state); // [{ type: "ROLL", side: null, dice: [{ kind: "d3", count: 2 }], reason: "Fan factor (home, away)" }]
({ state } = step(state, { type: "ROLL" })); // or { type: "ROLL", values: [2, 3] } for physical dice
```

## The procedure stack

Rules run as a stack of procedures.

- A procedure is plain data (`Procedure` in `src/types.ts`): a `type`, usually a `stage`, and whatever it must
  remember between steps. The stack lives in `state.stack`; the last element is the one running.
- Its behaviour is a `Handler` (`src/context.ts`), registered by type in `src/procedures/index.ts`:
  - `step(ctx, proc, action)` advances it. `action` is the player's input, or `null` when the procedure is
    entered or resumed without input (e.g. after a child procedure finished). It mutates `ctx.state` and `proc`
    (both Immer drafts) and returns:
    - `"wait"`: it needs input. If an action was passed it has been consumed; the runner stops here.
    - `"continue"`: step the top of the stack again, i.e. this procedure (at a new stage) or the children it just
      pushed.
    - `"done"`: remove this procedure. Children it pushed stay on the stack and run next.
  - `actions(state, proc)` lists the `ActionTemplate`s available while it waits on top of the stack. The UI renders
    only from these. Procedures that never wait return `[]`.
- `run` (`src/context.ts`) loops over the top of the stack until a handler waits or the stack is empty. The action
  goes to the first step only. More than 10 000 steps without settling throws (a handler looping on "continue").
- `step` (`src/engine.ts`) rejects an action whose type is not in the current templates, then runs the stack on an
  Immer draft. Handlers validate the details (player, square...) and reject anything else.

A typical handler checks `if (action === null) return "wait";` at a stage that needs input, then handles the
action and moves on: `proc.stage = "next"; return "continue";`.

### The context

Handlers only touch the game through `ctx`:

| | |
|---|---|
| `ctx.state` | The draft `GameState`; mutate it freely. |
| `ctx.push(a, b, ...)` | Push procedures so that `a` runs first, then `b`... They run before the pusher resumes. |
| `ctx.emit(event)` | Report a `GameEvent`: returned by `step` and appended to `state.log`. |
| `ctx.roll(action, dice, reason)` | Consume a `ROLL` action and return the values, flat and in `dice` order. Emits `DiceRolled`. |
| `ctx.random(n)` | Integer in `[0, n)` from the game RNG, for random picks that are not shown as dice (players hit by a Pitch Invasion...). |
| `ctx.expect(action, "A", "B")` | Narrow `action` to one of these types, or reject it. |
| `ctx.reject(message)` | Throw an `IllegalActionError`; the whole step is discarded and the input state is untouched. |

Child procedures report back through the state: `Check` writes `state.lastCheck` (`{ kind, success }`), which
the procedure that pushed it reads when it resumes; `state.turnover` and `state.touchdown` end turns and drives.

### Dice

Every die is an explicit `ROLL` action, so a coach (or a test) can enter physical dice.

- The waiting procedure offers `{ type: "ROLL", side, dice, reason }` (`side` is the team that rolls, or `null`
  when it does not matter), and calls `ctx.roll(action, dice, reason)` with the same `dice` in `step`.
- `{ type: "ROLL" }` rolls with the seeded RNG (mulberry32, `src/dice.ts`); `{ type: "ROLL", values: [4, 2] }`
  uses these values, which must match the number of dice and each die's faces (`DIE_FACES`).
- Die kinds: `coin` (1 heads, 2 tails), `d3`, `d6`, `d8` (direction, see below), `d16` (casualty table) and `block`
  (1..6, faces in `BLOCK_FACES`).
- Re-rolls are a separate decision (`USE_REROLL` / `DECLINE_REROLL`) followed by a new `ROLL`.

## Adding a procedure or rule

1. **State** (`src/types.ts`): add a member to the `Procedure` union with its `type`, its stages and the data it
   keeps between steps. Keep it serializable (no functions, no classes). Add new `Action`s, `ActionTemplate`s and
   `GameEvent`s there too if needed (an action type needs both an `Action` and an `ActionTemplate` member).
2. **Handler** (`src/procedures/<topic>.ts`): export a `Handler<P<"MyProc">>` named like the type, with
   `type P<T extends Procedure["type"]> = Extract<Procedure, { type: T }>;`. Document it in one line, stating the
   rule it implements. Shared helpers live in `procedures/helpers.ts` (`getPlayer`, `squareOf`, `landBall`,
   `checkTouchdown`, `weatherModifier`...) and `src/pitch.ts` (geometry, tackle zones).
3. **Register** it in `src/procedures/index.ts`. `HandlerMap` makes a missing handler a type error.
4. **Push** it from the procedure that triggers it (`ctx.push({ type: "MyProc", ... })`).
5. **Actions**: offer templates in `actions` for every stage that returns `"wait"`, and accept exactly those
   actions in `step` (`ctx.expect`, `ctx.roll`). Rolls use the same `dice` spec in both.
6. **Events**: `ctx.emit` what the UI needs to show or animate.
7. **Exports**: helpers the UI needs (e.g. to highlight legal squares) go in `src/index.ts`.
8. **Tests** (`src/engine.test.ts`, vitest): drive the game with `step` and fixed `ROLL` values, and check the
   state, the events and `getAvailableActions`. A new action template also needs an answer in `randomAction`
   (`packages/data/src/data.test.ts`), or the full random games stall.

## Conventions

- Pitch: 26 x 15 squares including both end zones, `{ x, y }` with x from 0 to 25 and y from 0 (top) to 14. Home is
  on the left: it sets up in x <= 12 (line of scrimmage at x = 12) and scores at x = 25; away sets up in
  x >= 13 and scores at x = 0. Wide zones are the 4 rows at the top and the bottom.
- d8 directions (`SCATTER`) go clockwise from north: 1 N, 2 NE, 3 E, 4 SE, 5 S, 6 SW, 7 W, 8 NW. North is
  y - 1.
- Characteristics are BB2025 target numbers: AG 3 means 3+, PA null when the player cannot pass; armour breaks
  when 2D6 >= AV.
- Check rolls store a `target` and a `modifier` added to the roll (-1 per tackle zone is the same as +1 to the target);
  a natural 1 fails and a natural 6 succeeds (`passes`).
- Player ids are `"<side>-<nr>"`. Players off the pitch are in a dugout box: `"reserves"`, `"ko"`, `"cas"` or
  `"banned"`.
- JSDoc states the rule in game terms ("Foul assists: +1 per team-mate next to the victim..."), so it can be
  checked against the rulebook.

## Public API (`src/index.ts`)

- Game: `createGame(home, away, { seed, overtime })` (`overtime`: a draw after the second half goes to a third half), `getAvailableActions(state)`, `step(state, action)` returning
  `{ state, events }`, `applyActions(state, actions)` (successive steps, e.g. to reach a prepared position),
  `IllegalActionError`.
- End of the game: `state.result` (`GameResult`: concession, penalties, winner, winnings, Dedicated Fans changes,
  MVPs, players leaving) once the `EndGame` procedure has run. `CONCEDE` is added to the templates of a team's own
  setup or turn (`legal`: no penalty); `step` handles it directly, clearing the stack down to the root `Game`.
- Star Player Points: each player's `spp` (`SppRecord`) counts what they did; `starPlayerPoints(state, player)` turns
  it into points (`SPP_VALUES`, Brawlin' Brutes, Perfect Passing). Casualties are credited through `sppTo` on
  `KnockDown`, `Crowd`, `Trapdoor` and `injure`.
- Types: everything in `types.ts` (`GameState`, `Action`, `ActionTemplate`, `GameEvent`, `TeamSetup`, `Procedure`...),
  `GameOptions`, `StepResult`.
- Pitch (`pitch.ts`): constants (`PITCH_WIDTH`, `PITCH_HEIGHT`, line of scrimmage, wide zones) and helpers
  (`other`, `sameSquare`, `offset`, `inBounds`, `inHalf`, `adjacent`, `playerAt`, `teamPlayers`, `tackleZones`,
  `hasTackleZone` (standing and not distracted), `ballCarrier`...).
- Dice: `DIE_FACES`, `BLOCK_FACES`, `SCATTER`, `isCorner`, `throwInDirection`.
- Rules helpers for the UI: `flightMarkers` (a kicked, thrown or exploding ball or bomb: aimed square, landing square),
  `scatterOrigin` (the square the next d8 roll moves from), `ballUnsettled` (the loose ball is about to be caught,
  bounce or be placed),
  `setupErrors`, `KICKOFF_TABLE`, `openPlayers`, `weatherFor`, `declarableActions`,
  `legalMoves`, `adjacentTargets`, `blockDice`, `pushbackSquares`, `foulAssists`, `foulTargets`,
  `RANGE_MODIFIER`, `evaluatePass`, `passRange`, `throwTargets`, `handOffTargets`, `interceptors`, `underRuler`,
  `neededRoll`, `injuryOutcome`, `casualtyFor`, `CASUALTY_DICE`, `hasSkill`, `skillName`, `skillValue`.
- Skills: automatic skill re-rolls (Dodge, Sure Hands, Catch) live in `skillReroll` (`procedures/checks.ts`). The
  rules make them optional ("may re-roll"), but they are used without asking: keeping a failed dodge, pick-up or
  catch almost never helps, and a prompt on each one would slow the game down. An
  optional skill the coach decides on is a `USE_SKILL` template (`{ skill, playerId }`) answered by
  `{ type: "USE_SKILL", use }` (Stand Firm); a skill re-roll offered instead of a team re-roll is a `USE_REROLL`
  template with `skill` set (Pass).
- Injuries: anything that rolls on the injury table calls `injure(ctx, player, total)` (`procedures/injury.ts`),
  which pushes the `Injury` procedure: casualty roll, apothecary, then the player is placed.
