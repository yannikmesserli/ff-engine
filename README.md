# Blood Bowl frontend

A browser-only Blood Bowl engine and game component, following the **BB2025** rules.

```
pnpm install
pnpm dev          # playground at http://localhost:5173
pnpm test         # engine + data tests (incl. full random games)
pnpm typecheck
pnpm fetch-rosters    # download the BB2025 rosters from FUMBBL (ruleset 2014) into packages/data/src/generated
```

## Packages

| Package | What |
|---|---|
| `packages/engine` (`@bb/engine`) | Pure TypeScript rules engine, no UI. Serializable `GameState`, seeded RNG. |
| `packages/data` (`@bb/data`) | BB2025 rosters (from FUMBBL), example teams and formations, zod schemas, `resolveTeam()`. |
| `packages/board-ui` (`@bb/board-ui`) | React `<BloodBowlGame home={teamJson} away={teamJson} />` component. |
| `apps/playground` | Vite app hosting the component. |

Each package has its own README (engine model and how to add a rule, data formats and scripts, UI file map).
`AGENTS.md` holds the conventions for coding agents, and `.claude/skills/` has the workflows for adding a rule and running
the playground.

## Engine model

```ts
const state = createGame(resolveTeam(homeJson), resolveTeam(awayJson), { seed: 42 });
getAvailableActions(state); // [{ type: "ROLL", dice: [{ kind: "d3", count: 2 }], reason: "Fan factor (home, away)", ... }]
const { state: next, events } = step(state, { type: "ROLL" });
```

- Rules run as a **procedure stack** . Each procedure (`Turn`, `MoveStep`,
  `Check`, `KnockDown`, `Bounce`...) is plain data on `state.stack`; its behaviour lives in a handler in
  `engine/src/procedures/`. A handler either finishes, pushes sub-procedures, or waits for an action.
- Every die is an explicit `ROLL` action. `{ type: "ROLL" }` uses the seeded RNG; `{ type: "ROLL", values: [4] }` lets a
  coach enter physical dice (and makes tests deterministic).
- `step` is pure (Immer), so undo, replays and saves are just keeping old states.

## Implemented so far (BB2025)

- Pre-game: fan factor (dedicated fans + D3), weather (2D6), coin toss (home calls).
- Setup checks: 11 players (or all available), 3 on the line of scrimmage in the centre field, at most 2 per wide zone.
  Built-in formations are available as one-click setups.
- Kick-off: D8 + D6 deviation, all 11 kick-off events (Solid Defence, High Kick, Quick Snap, Charge, Weather
  Change with wind gusts, Dodgy Snack, Pitch Invasion...), resolved before the ball lands; touchback.
- Ball: bounce, throw-in (BB2025 template, D3 in corners, 2D6 counting the starting square), catch (+1 harder
  for scattered balls).
- Actions: players declare Move, Block, Blitz, Pass, Hand-off, Foul or Secure the Ball from an action menu (all but Move
  and Block once per turn; a Blitz names its target up front).
- Pass: BB2025 range table (Quick/Short/Long/Long Bomb, Blizzard: Quick and Short only), PA + range + tackle
  zones + Very Sunny, accurate / inaccurate (3 scatters) / fumble, team re-roll, interception by one opponent under
  the ruler (AG +3 / +2), catch (+1 after a scatter), turnover unless a team-mate ends up with the ball.
- Hand-off to an adjacent standing team-mate (catch on AG). Secure the Ball: loose ball with no standing opponent
  within 2 squares, not for Big Guys, pick-up on 2+, turnover if the player does not end up with the ball.
- Block: dice from strength and assists (helpers must not be marked by others, Guard ignores that), attacker or
  defender picks, team re-roll of all dice, Block/Dodge/Tackle on Both Down and Stumble, pushback (free squares
  first, chain pushes, crowd pushes with injury), follow-up, knock-downs and loose balls. Blitz blocks cost a
  square (Rush if needed) and the blitzer may keep moving afterwards.
- Turns: Move actions with stand-up (4+ roll for MA < 3), Dodge and pick-up on AG, Rush (2+, 3+ in a blizzard),
  any number of team re-rolls per turn, armour (roll >= AV) and injury, stunned recovery, turnovers,
  touchdowns (also in the opponent's turn), halves.
- Foul (once per turn): move, then foul an adjacent prone or stunned opponent. Armour roll with foul assists
  (+1 per team-mate next to the victim not marked by an opponent, -1 per defender next to the fouler not marked by
  anyone else), injury, and the referee spots natural doubles on either roll. A spotted fouler may argue the call (6:
  stays, still a turnover; 1: coach banned from arguing again), then use bribes (2+: stays, no turnover); otherwise they
  are sent off (dropping the ball) and it is a turnover. Dirty Player (+1 armour, or injury if not needed) and Sneaky
  Git (no ban on an armour double while the armour holds).
- Drives: KO recovery (4+), Sweltering Heat exhaustion, drive-long effects reset.

- Injuries: BB2025 injury table (Stunty: 7 KO'd, 9 Badly Hurt; Thick Skull: KO'd on 8, or 7 for Stunty, becomes
  Stunned), casualty table (D16 + Niggling Injuries: Badly Hurt, Seriously Hurt, Serious Injury, Lasting Injury on a
  D6, Dead; a characteristic at its limit becomes Seriously Hurt instead), apothecary once per game (KO'd to Stunned,
  or to the reserves from the crowd; Badly Hurt healed; worse casualties re-rolled, Badly Hurt heals, otherwise the
  coach keeps either result). Regeneration (4+, team re-roll in the player's own turn) heals any casualty before the
  apothecary.
- Jumping over a prone or stunned player (either team) into the square beyond, two squares away: costs 2 squares (a
  Rush for each past MA), an AG Jump roll with -1 per tackle zone on the busier of the two squares instead of a Dodge;
  a failed Rush or a natural 1 falls in the starting square, any other failure in the target square.
- Stalling: an unmarked ball carrier who could walk (without rushing) into the end zone along a path free of tackle
  zones, and does not score or get rid of the ball (or is not activated before the coach ends the turn), gets a rock
  from the crowd: hit on a D6 of at least the turn number (turns 1-6), Knocked Down without a turnover.
- Loner(X): after spending a team re-roll, a D6 below X loses the re-roll and keeps the first result (rolls, block
  dice, passes).
- Skills: Block, Dodge (Stumble, and an automatic re-roll of a failed Dodge roll once per turn, cancelled by an
  opponent with Tackle marking the starting square), Tackle, Guard, No Ball, Dirty Player, Sneaky Git, Thick Skull, Stunty (injury table, and
  tackle zones on the destination ignored when dodging), Regeneration, Loner.

Not yet: most skills (Kick, Mighty Blow, Wrestle, Frenzy, Juggernaut, Stand Firm, Side Step...), inducements,
overtime.

The playground accepts `?seed=42` to replay the same dice.

Conventions: home on the left (scores at x=25), d8 directions clockwise from north (1 = N).

## Data sources

- Rosters: FUMBBL's BB2025 ruleset (`https://fumbbl.com/api/ruleset/get/2014`, `xml:roster?id=...`). Check FUMBBL's
  terms before redistributing.

## Assets

Board graphics are not included. The playground serves `apps/playground/public/` (git-ignored), which must contain
an `img/` folder; see `packages/board-ui/README.md` for the expected layout.
