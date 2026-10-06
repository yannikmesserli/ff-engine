# Blood Bowl frontend

A browser-only Blood Bowl engine and game component, following the **BB2025** rules.

```
pnpm install
pnpm dev          # playground at http://localhost:5173, with the relay for online games on :8787
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
| `apps/playground` | Vite app hosting the component: online games through the relay, or hot-seat. |
| `apps/relay` | Node WebSocket relay for online games: forwards each player's actions, stores nothing. |

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
- Mighty Blow (+X): when the blocker knocks an opponent down, +X to the armour roll if that breaks it, otherwise to the
  injury roll (not both).
- Frenzy: must follow up; after a Push or a dodged Stumble, a second block against the same defender if both are still
  standing next to each other (during a Blitz it costs another square, a Rush if needed).
- Stand Firm: the pushed player's coach may refuse the push (also when chain-pushed: then nobody in the chain moves);
  no follow-up, and a knock-down happens in place.
- Sidestep: the pushed player's coach picks any free adjacent square instead of the usual three (when one is free).
- Sure Hands, Catch: automatic re-roll of a failed pick-up or catch (hand-offs too). Pass: the coach may re-roll an
  inaccurate pass or a fumble with the skill instead of a team re-roll.
- Bone Head (2+) and Really Stupid (4+, or 2+ next to a standing team-mate without Really Stupid): rolled when the
  player is activated, team re-roll allowed. A failure ends the action (the declared action still counts as used, no
  turnover) and the player is distracted until their next activation or the end of the drive: no tackle zone, cannot
  catch, intercept, assist, or use Stand Firm / Sidestep.
- Jump Up: stand up for free (no movement, no 4+ roll); a prone player may declare a Block, standing up on an AG roll
  with +1 (a failure ends the action, no turnover).
- Sprint: a third Rush.
- Horns: +1 ST when blocking during a Blitz (Frenzy's second block too).
- Dauntless: blocking a stronger player, D6 + ST must beat the defender's ST (team re-roll allowed) to match its
  strength for the block; Horns and assists come on top.
- Wrestle: on Both Down, the attacker's coach (then the defender's) may place both players prone instead: no armour
  rolls and no turnover unless the moving team's ball carrier goes down; the attacker's action ends.
- Juggernaut (Blitz only): the attacker's coach may turn Both Down into a Push, and the defender's Stand Firm and
  Wrestle do not work.
- Projectile Vomit: instead of a block (a Blitz pays the square), 2+ hits the opponent, a failure the vomiting
  player (team re-roll allowed); armour without modifiers, placed prone and injury if broken; the action ends, no
  turnover unless the moving team's ball carrier drops the ball.
- Animosity(X): before a pass or hand-off to a team-mate with keyword X (plain Animosity: any team-mate), 2+ (team
  re-roll allowed); a failure keeps the ball and ends the action, without a turnover.
- Throw Team-mate / Right Stuff: a once-per-turn action; the thrower may move, then throws an adjacent team-mate with
  Right Stuff to a Quick or Short square (PA roll like a pass, team re-roll, no interception). A superb or subpar
  throw scatters three times from the target, a fumble once from the thrown player. Landing on a player knocks them
  down (a turnover if they are a team-mate) and scatters on; off the pitch means the crowd and a turnover. Landing
  roll on AG (-1 subpar or fumble, -1 per tackle zone), failing after hitting someone or for a prone or distracted
  player; a failed landing is a turnover only with the ball. The thrown player may still act.

- Always Hungry: before throwing a team-mate, 2+ (team re-roll allowed) or the team-mate must escape on 2+ (then
  thrown as a fumble) or be eaten: dead without apothecary or Regeneration, a turnover only with the ball.
- Unchannelled Fury: rolled when the player is activated, 2+ for a Block or Blitz and 4+ otherwise (team re-roll
  allowed); a failure loses the action (still used this turn, no turnover), but the player keeps their tackle zone.
- Disturbing Presence: -1 to passes (and team-mate throws), catches and interceptions for each opponent with the skill
  on the pitch within 3 squares, even prone or stunned.
- Secret Weapon: when a drive ends (touchdown or half time), each player with the skill who was on the pitch for its
  kick-off and is not a casualty is sent off, even from the reserves or the KO box. The coach may argue the call (6:
  the player stays; 1: coach banned), then use bribes (2+).
- Claws: when the blocker knocks an opponent down, a natural armour roll of 8+ breaks armour above 8+; it does not
  stack with Mighty Blow, which then goes to the injury roll.
- Titchy: +1 to the player's Dodge rolls; opponents dodging into their tackle zone do not count it.
- Stab: instead of a block (a Blitz pays the square and ends there), an unmodified armour roll against the opponent
  (no Mighty Blow or Claws); if it breaks, they are placed prone and roll for injury without modifiers. No turnover.
- Prehensile Tail: -1 to the Dodge and Jump rolls of an opponent leaving the player's tackle zone (per tail).
- Strong Arm: +1 to the Throw Team-mate roll.
- Take Root: a standing player rolls 2+ when activated (team re-roll allowed); on a failure they are rooted until
  knocked down or placed prone, or the drive ends: the action goes on, but they cannot move or rush, cannot follow up
  and are never pushed (nobody in the chain moves), and cannot be thrown.
- Plague Ridden: once per game, an opponent killed by the player's block (not a Big Guy, and without Stunty,
  Regeneration or Decay) joins the team's reserves as a new player of its lineman position (Rotter for Nurgle).
- Bloodlust(X): rolled when the player is activated, X+ (1 easier for a Block or Blitz, at least 2+; team re-roll
  allowed). On a failure the action goes on (a Block or Secure the Ball may become a Move), but before it ends, and
  before passing, handing off or scoring, the player bites an adjacent Thrall team-mate: placed prone, injury roll
  without armour, a casualty is only Badly Hurt. Biting nobody is a turnover, and the player loses their tackle zone and
  drops the ball.
- Defensive: in the opposing team's turn (not during a Charge), players marked by this player cannot use Guard.
- Brawler: once per activation, not during a Blitz, the attacker may re-roll a single Both Down die instead of the
  block re-roll (no team re-roll is spent).
- Nerves of Steel: tackle zones do not count for the player's passes (team-mate throws excepted), catches and
  interceptions.
- Steady Footing: whenever the player (standing and not distracted) would be knocked down or fall over, their coach may
  roll a D6 (team re-roll allowed in their own turn): on a 6 they stay on their feet with the ball, without a turnover,
  and the action goes on (a failed Rush before a Blitz block still leads to the block).
- Shadowing: when a player moves (not jumps) out of the tackle zones of opponents with Shadowing, their coach may
  pick one to roll a D6: on 4+ the shadower moves into the vacated square (no roll, no movement spent; as many times per
  turn as their MA).
- Animal Savagery: rolled when the player is activated, like Unchannelled Fury (2+ for a Block or Blitz, 4+ otherwise,
  team re-roll allowed). On a failure the player lashes out at an adjacent standing team-mate (the coach picks), who is
  knocked down (the player's Claws and Mighty Blow count for the armour roll only), and the action ends; a turnover only
  if that team-mate held the ball. With nobody to lash out at, the action is lost and the player is distracted.
- Timmm-ber!: +1 to the stand-up roll (MA below 3) per adjacent team-mate with a tackle zone not marked by an
  opponent; a natural 1 still fails.
- Foul Appearance: a player who wants to block the player (Blitz and Frenzy blocks included) or use Projectile Vomit or
  Stab on them first rolls 2+ (team re-roll allowed); a 1 wastes the block and ends the action, without a turnover.
- Strip Ball: an opponent holding the ball who is pushed back by the player (Push, or a Stumble saved by Dodge) without
  being knocked down drops it in the square they were pushed to, where it bounces; not when they have Sure Hands (and a
  tackle zone), stand firm or are rooted.
- Hypnotic Gaze: a special action any number of players may declare each turn. The player may move first, then gazes at
  an adjacent standing opponent (after that opponent's Foul Appearance): on 3+ (team re-roll allowed) the opponent is
  distracted until their next activation. The activation ends either way, without a turnover.
- On the Ball: when an opponent declares a pass (after Animosity, before the throw), each player with the skill and a
  tackle zone may move up to 3 squares, one at a time, whatever their MA: dodges and jumps as usual (skill re-rolls
  such as Dodge, but no team re-roll, since it is not their turn), no Rush; a fall ends these moves, without a
  turnover. After the kick-off deviation (unless it is a touchback), one unmarked receiving player with the skill may
  move the same way, in their own half, with team re-rolls allowed.
- Safe Pass: a pass fumbled on a natural 1 (after any re-roll) may be saved: the thrower keeps the ball and the action
  ends, without a turnover. Fumbles from modifiers are dropped as usual.
- Hit and Run: after a block (once any Frenzy block is over, during a Blitz too) or a Stab, a standing player with the
  skill may step to a free adjacent square that is not next to any opponent: no Dodge or Rush, no movement spent, a
  pick-up if the ball is there. Not after a turnover.
- Diving Tackle: after a successful dodge or jump out of the tackle zone of opponents with the skill (who are not next
  to the square moved to), that -2 would turn into a failure, the opposing coach may pick one of them: the roll fails
  (a re-roll keeps the -2), and the tackler is placed prone in the square left, without an armour roll.
- Hatred(X): when blocking a player with keyword X (Blitz and Frenzy blocks included), the attacker may re-roll a
  single Skull die instead of the block re-roll, without spending a team re-roll.
- Break Tackle: once per turn, +1 to a Dodge roll with ST 3 or less, +2 with ST 4, +3 with ST 5 or more, used only when
  the roll would fail without it (Diving Tackle included).
- My Ball: the player cannot declare a Pass or Hand-off action (nor can No Ball or Ball & Chain players).
- Bombardier: a once-per-turn Throw Bomb special action, without moving first. The bomb is thrown like a pass (range,
  PA roll, Pass and team re-rolls, Safe Pass, interception; no Animosity or On the Ball). A fumble explodes on the
  thrower; a bomb leaving the pitch is lost; on an empty square it bounces once. A standing player where it comes down
  tries to catch it (no Catch re-roll) and must throw it again at once (an interceptor too); otherwise it explodes:
  the player in the square is hit, each adjacent player on a 4+. Standing players hit are knocked down (a turnover for
  the moving team), prone or stunned ones roll armour, without modifiers.
- Pogo: the player may jump over any adjacent square (empty or occupied, standing players included) into an empty
  square; the Jump roll ignores tackle zones and Prehensile Tail, and Diving Tackle does not work on it.
- Taunt: when the player is pushed back by a block (and not distracted), their coach may force the attacker to follow
  up (not a rooted attacker).

Not yet: most other skills (Kick...), inducements, overtime.

The playground accepts `?seed=42` to replay the same dice.

Conventions: home on the left (scores at x=25), d8 directions clockwise from north (1 = N).

## Data sources

- Rosters: FUMBBL's BB2025 ruleset (`https://fumbbl.com/api/ruleset/get/2014`, `xml:roster?id=...`). Check FUMBBL's
  terms before redistributing.

## Assets

Board graphics are not included. The playground serves `apps/playground/public/` (git-ignored), which must contain
an `img/` folder; see `packages/board-ui/README.md` for the expected layout.
