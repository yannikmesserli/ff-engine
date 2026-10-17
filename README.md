# Blood Bowl frontend

A browser-only Blood Bowl engine and game component, following the **BB2025** rules.

```
pnpm install
pnpm dev          # playground at http://localhost:5173, with the relay for online games on :8787
pnpm scenarios    # prepared positions to try a rule in the browser, on http://localhost:5174
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
| `apps/scenarios` | Vite app starting games from prepared positions (teams plus the actions leading there), to try a rule. |

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

- Pre-game shop (the `shop` game option; without it, the team files list the inducements, checked against the same
  limits): after the weather, the team with the higher Current Team Value may spend its treasury on inducements first.
  The other team then gets petty cash, the difference in value plus what the first team spent, and may add up to 50k
  from its treasury; petty cash it does not spend is lost. With equal values nobody buys anything. Then the team with
  the lower value, counting what each team bought, gets a free Prayer to Nuffle per 50k of difference. The Current
  Team Value counts the players available for the game (position cost, +20k per primary skill and +30k per secondary
  skill gained, +30k MA, +60k ST, +30k AG, +20k PA, +10k AV), the journeymen, the team re-rolls, the assistant coaches,
  cheerleaders and apothecary. What the shop took from the treasury is gone after the game.
- Star players and mercenaries (hired in the shop, or listed in the team file): up to 2 star players from those the
  roster may hire (a pair, Grak and Crumbleberry, comes together and counts as one), and mercenaries from the team's
  positions with room left (position cost + 30k, Loner (4+), an extra primary skill for 50k more; Big Guys within the
  roster's limit), 16 players in all. A star player both teams hire plays for neither (both have paid). Hired players
  are never MVP, and prayers that pick players leave star players out.
- Inducements, within the BB2025 limits and the team's special rules. Bribes: one each to keep a fouler (or a Secret Weapon) on the pitch on 2+ (Bribery and Corruption
  teams may also re-roll a natural 1 on Argue the Call, once per game). Part-time Assistant
  Coaches and Temp Agency Cheerleaders: added to the team's own for Brilliant Coaching and Cheering Fans. Blitzer's
  Best Kegs: +1 each to the team's KO recovery rolls (a natural 1 still fails). Biased Referee: an opposing foul the
  referee missed is spotted on a D6 of 5+, and the team's own arguments get +1 (a natural 1 still bans the coach).
  Team Mascot: once per half, in the team's turn, instead of a team re-roll (even with none left): 4+ re-rolls the
  die (Loner still applies); after a failure the coach may still use a team re-roll; it also re-rolls a natural 1 on
  the Cheering Fans roll, for free. Halfling Master Chef: before the first kick-off of each half, 3D6, each 4+
  steals one of the opponents' team re-rolls for the half. Riotous Rookies (Low Cost Linemen teams): before the coin
  toss, 2D3 + 1 linemen with Loner (4+) join the reserves for the game. Mortuary Assistant (Masters of Undeath) and
  Plague Doctor (Favoured of Nurgle): once per game, re-roll a failed Regeneration roll; the Plague Doctor's single use
  may go to treating a player as an apothecary instead. Weather Mage: once per game, at the start of the team's turn,
  2D6 on the weather table, with a modifier of +1 or +2, or -1 or -2, if the coach wants one. Wizard (150k): once per
  game, between two turns of a drive, one spell. Fireball: each player in a 3x3 area is knocked down on 4+, with +1 to
  the armour roll (or to the injury roll if the armour breaks without it). Zap!: on a 6, or on 2+ equal to or above
  the target's ST, a player on the pitch becomes a frog until the end of the drive (MA 5, ST 1, AG 2+, no PA, AV 5+,
  Dodge, No Ball, Titchy, Stunty, Very Long Legs, Leap), dropping the ball, and gets no apothecary. No turnover either
  way. Josef Bugman (the Infamous Coaching Staff, 100k): +1 to the team's KO recovery rolls (Bugman's XXXXXX), and
  Dwarfen Wisdom: once per game, after both teams set up (the kicking team is asked first), a D3, then that many of
  the team's players on the pitch (at least one) are set up again. Wandering Apothecaries (100k, up to 2, for rosters that may have an
  apothecary): each is one more use of an apothecary for the game, after the team's own.
- Prayers to Nuffle (bought as inducements, up to 3, plus the underdog's free ones after the shop): before the coin toss, a D16 each on the BB2025 table, re-rolled
  when the team already has the result; they last the whole game. Stiletto (a random player gains Stab), Iron Man
  (+1 AV, up to 11+, to a player the coach picks), Knuckle Dusters (Mighty Blow, likewise), Bad Habits (D3 random
  opponents gain Loner (2+)), Greasy Cleats (a random opponent -1 MA), Blessing of Nuffle (a random player gains Pro),
  Friends with the Ref (+1 to the team's arguments), Under Scrutiny (the opponents' fouls that break armour are always
  spotted), Moles under the Pitch (-1 to the opponents' Rush rolls), Throw a Rock (once per game, between two turns of
  a drive: a random standing opponent is knocked down on 4+), Intensive Training (a random player gains a primary
  skill the coach picks), Treacherous Trapdoor (for both teams: a player moving, pushed, following up, shadowing,
  diving in with Diving Tackle, moving in a Quick Snap or coming down from a team-mate throw into (6,1) or (19,13)
  falls through on a 1, an injury roll as for the crowd, the ball bouncing from there, a turnover for the
  moving team).
  The four Star Player Point prayers: Perfect Passing (completions earn 2), Dazzling Catching (any pass a player of the
  team catches earns 1), Fan Interaction (a casualty from a crowd push, or a trapdoor the player was pushed into, earns
  the attacker 2) and Fouling Frenzy (a casualty from a foul earns the fouler 2).
- Team Captain (named in the team file): the player gains Pro and the trait, neither an advancement. While they are
  on the pitch, each team re-roll the team uses (or each successful Team Mascot roll) is saved on a D6 of 6, rolled
  with the Mascot and Loner dice; a saved Leader or Brilliant Coaching re-roll comes back as a normal team re-roll.
  The captain must be set up whenever they can play.
- Pre-game: fan factor (dedicated fans + D3), weather (2D6), coin toss (home calls). Journeymen: a team with fewer
  than 11 players available gets free ones up to 11 from its lineman position, with Loner (4+) (team file option).
- Setup checks: 11 players (or all available), 3 on the line of scrimmage in the centre field, at most 2 per wide zone.
  Built-in formations are available as one-click setups.
- Overtime (the `overtime` game option, off by default, for cup games): a draw after the second half is played on in
  a third half of 8 turns per team, kicked off by the team that kicked off the first half, without new team re-rolls;
  a touchdown does not end it early, and a draw after it goes to a penalty shootout (each round both coaches roll a
  D6, the higher one scores, a tie scores nothing, until 5 penalties are scored). The hot-seat playground has a
  checkbox for it.
- Star Player Points, counted per player during the game: touchdown 3, casualty 2, completion (an accurate pass
  caught by a team-mate in the target square, or a superb team-mate throw that lands) 1, interception 2, MVP 4, and 1
  for a thrown player landing on their feet. Brawlin' Brutes teams: touchdowns 2, casualties 3. A casualty counts when
  the injury roll gives it, whatever the apothecary or Regeneration does after, and only for an opponent's block
  (the attacker's, or the defender's when the attacker falls), an Arm Bar, the prayers above, or Violent Innovator.
- End of the game: MVP (a random player of each team, not killed or raised during the game), winnings ((half the fan
  attendance + touchdowns + 1 for not stalling) x 10,000 gp), Dedicated Fans (the winners gain one on a D6 of at least
  their Dedicated Fans, the losers lose one below theirs, nothing on a draw).
- Concession: during their own setup or turn, a coach may concede. The opponents win at least 2-0 (their coach names
  the scorers of the touchdowns awarded) and the conceding team loses the Star Player Points of the game. It is legal
  only in setup, with fewer than 3 players able to play; otherwise the conceding team also gets no MVP (the winners
  get two), no winnings (the winners get the whole attendance), loses a D3 Dedicated Fans (keeping 1), and each of its
  players with 3 or more advancements leaves the team on a D6 of 1-3.
- After the game, `teamAfterGame` (`@bb/data`) writes the result into the team file: Star Player Points, casualties
  (missing the next game, Niggling and Lasting Injuries, the dead and departed removed), raised players, winnings and
  Dedicated Fans. The end-of-game summary has a "Download team" button for it.
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
  apothecary. Getting Even: a player left Seriously Hurt, with a Serious Injury or a Lasting Injury (after the
  apothecary) by an opponent's block, foul or special action rolls a D6 (a team re-roll in their own turn): on 4+ they
  gain Hatred against one of that opponent's keywords (not a role such as Lineman or Big Guy, nor one they hate
  already; their coach picks among several). It is kept in the team file (`hatred`), not as an advancement. Not for
  star players or mercenaries. Masters of Undeath (a team special rule, in the team file): once per game, an opponent
  killed in any way (ST 4 or less, not Stunty) rises in the team's reserves as a new player of one of its lineman
  positions, named as the dead player (the coach picks between Skeleton and Zombie for Shambling Undead); the player
  stays in the team after the game.
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
- Sure Hands, Catch: automatic re-roll of a failed pick-up or catch (hand-offs too). Like Dodge's, these optional
  re-rolls are used without asking: declining one almost never helps, and skipping the prompt keeps the game moving. Pass: the coach may re-roll an
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
- Dump-off: when targeted by a block (not Frenzy's second one) or by Projectile Vomit, Stab, Breathe Fire or
  Hypnotic Gaze, after any Foul Appearance roll, the ball carrier's coach may first make a Quick pass with them (no
  team re-roll, no On the Ball); neither team's turn ends because of it, then the action goes on. The target of a
  Blitz decides as soon as the Blitz is declared, before the blitzer moves (a blitzer still down has no tackle zone).
- Give and Go: after a Quick pass that is not fumbled, or a hand-off, without a turnover, the thrower may move on with
  the squares left (but not throw again).
- Tentacles: when an opponent dodges or jumps away from players with the skill (after any Rush), their coach may pick
  one, who rolls D6 + their ST - the mover's ST, 6+ (no team re-roll): the mover stays in the starting square and
  their action ends, without a turnover.
- Trickster: before being blocked (or hit by Projectile Vomit, Stab or Breathe Fire), after any Dump-off and
  Dauntless, a player with a tackle zone may move to a free square next to the attacker, with the ball; onto a loose
  ball, a pick-up roll or a bounce, as their coach chooses. The block dice are worked out again.
- Hail Mary Pass: in a Pass action (not in a blizzard), the ball may go to any square of the pitch. The roll counts
  as a Long Bomb; anything but a fumble is inaccurate (three scatters from the target), only a fumble may be
  re-rolled, and nobody may intercept (On the Ball still applies). With Bombardier, a Throw Bomb may be one too: the
  bomb is lost off the pitch, explodes on the thrower on a fumble, and otherwise lands as a scattered bomb.
- Punt: a once-per-turn action of a standing player with the skill, who may move first: the coach picks a square
  next to the punter (not diagonally); a D6 on the throw-in template facing it gives the direction, then the ball
  travels D6 squares (a team re-roll or Pro on each roll). Off the pitch, a throw-in from the last square and a
  turnover; otherwise it comes down there, caught by a standing player (an opponent: a turnover) or bouncing, and the
  action ends. From a sideline or an end zone, it may go into the crowd instead (throw-in, turnover).
- Chainsaw: instead of a block (a Blitz pays the square), a D6 with a team re-roll: on 2+ the opponent rolls armour
  with +3 (no Mighty Blow), placed prone and injured if it breaks, no turnover; on a 1 it kicks back and the chainsaw
  player is knocked down, a turnover. It may also be used in a foul (kick-back roll first, then +3 to the armour
  roll). A knocked-down chainsaw player always gets +3 against them on the armour roll.
- Breathe Fire: instead of a block (a Blitz pays the square), a D6, -1 against ST 5 or more; the coach may re-roll
  anything but a 6 (team re-roll). A natural 6 knocks the opponent down (armour and injury without modifiers), 4+
  places them prone, 2+ does nothing, and a 1 knocks the fire-breather down (armour without modifiers), a turnover.
- Animosity(X): before a pass or hand-off to a team-mate with keyword X (plain Animosity: any team-mate), 2+ (team
  re-roll allowed); a failure keeps the ball and ends the action, without a turnover.
- Throw Team-mate / Right Stuff: a once-per-turn action; the thrower may move, then throws an adjacent team-mate with
  Right Stuff to a Quick or Short square (PA roll like a pass, team re-roll or Pro, no interception). A superb or subpar
  throw scatters three times from the target, a fumble once from the thrown player. Landing on a player knocks them
  down (a turnover if they are a team-mate) and scatters on; off the pitch means the crowd and a turnover. Landing
  roll on AG (-1 subpar or fumble, -1 per tackle zone), failing after hitting someone or for a prone or distracted
  player; a failed landing is a turnover only with the ball. The thrown player may still act.
- Swoop: after a throw (or kick) that is not fumbled, the thrown player's coach may pick a side instead of the three
  scatters: a D6 on the throw-in template facing it gives the direction, a D6 the distance travelled from the target
  in a straight line (a team re-roll on each roll); a player who swooped may re-roll a failed landing.
- Kick Team-mate: a once-per-turn action of its own, played like Throw Team-mate, except that a fumbled kick does
  not scatter: the kicked player rolls for injury (a Stunned result counts as KO'd), and a ball they held bounces (a
  turnover).

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
- Two Heads: +1 to the player's Dodge rolls.
- Extra Arms: +1 to pick up, catch and intercept the ball.
- Big Hand: tackle zones and Pouring Rain do not count when the player picks up the ball.
- Very Long Legs: +1 to Jump rolls (Leap and Pogo jumps too), +2 to interceptions, and Cloud Burster does not stop the
  player intercepting.
- Accurate: +1 to the player's Quick and Short passes (and bombs), not to team-mate throws.
- Cannoneer: +1 to the player's Long passes and Long Bombs (bombs and Hail Mary Passes too), not to team-mate throws.
- Bullseye: after a superb team-mate throw, the thrower may have the player land in the target square, without
  scattering.
- Kick: the kicking player (one set up in the centre field, or on the line of scrimmage when nobody is there) may
  have the kick-off deviate D3 squares instead of D6, decided before the roll. A punter with the skill may re-roll each
  punt roll with it instead of a team re-roll.
- Leader: a team with a Leader on the pitch at the first kick-off of a half gets one more team re-roll for the half,
  spent before the others (after Brilliant Coaching's), and only while one of those Leaders is on the pitch (even
  prone or stunned). An unused one is kept into overtime, without a new one.
- Put the Boot In: the player gives a foul assist even while marked by opponents.
- Lone Fouler: once per turn, when nobody assists the foul (offensive or defensive), the fouler's coach may re-roll
  an armour roll that holds; only the new roll counts, its doubles included.
- Quick Foul: after a foul that is not a turnover (a bribe may keep the fouler on the pitch), the fouler may go on
  moving with the squares left, without fouling again.
- Pile Driver: once a Block action (not a Blitz) is over, if the defender was knocked down and the attacker still
  stands next to them, the attacker's coach may make a free foul on them (not the team's Foul action), then the
  attacker is placed prone (unless sent off): a turnover only if they held the ball.
- Monstrous Mouth: Strip Ball does not work against the player. Chomp: instead of a block (Blitz included, after
  Foul Appearance, Dump-off and Trickster), a D6 with a team re-roll: on 3+ the target is chomped, pinned like a rooted
  player (cannot move, be pushed, follow up or be thrown) for as long as the chomper stays next to them with a tackle
  zone; once the chomper moves away or goes down, the chomp is over. A blitzer may move on after a chomp.
- Saboteur: a player with the skill and a tackle zone knocked down by an opponent's Block or Blitz action (not a
  Ball & Chain move) may roll a D6 before the armour roll (and before Steady Footing): on 4+ they are Knocked Out
  without an armour roll, and the blocker is knocked down too (no armour or injury modifiers), a turnover only if the
  blocker held the ball.
- Lethal Flight: an opponent the thrown player lands on (or bounces onto) gets +1 against them on the armour roll if
  that breaks it, otherwise on the injury roll, and a casualty earns the thrown player Star Player Points.
- Multiple Block: in a Block action (not a Blitz), the player may block two adjacent standing opponents at once, at
  -2 ST each (at least 1); neither target assists against the other block. The blocks are prepared one after the
  other, from Foul Appearance (a failure only drops that block) to the choice of the die, then both are resolved in the
  same order: no follow-up, no Frenzy, and nobody is pushed into a square where a target stood. Pile Driver (on either
  target) and Hit and Run may follow.
- Violent Innovator: a casualty an opponent suffers from the player's special action earns them Star Player Points:
  Stab, Chainsaw, Breathe Fire, a bomb, a kicked team-mate landing on them (Kick Team-mate), a Ball & Chain hit on a
  player already down.
- Stab: instead of a block (a Blitz pays the square and ends there), an unmodified armour roll against the opponent
  (no Mighty Blow or Claws); if it breaks, they are placed prone and roll for injury without modifiers. No turnover.
- Prehensile Tail: -1 to the Dodge and Jump rolls of an opponent leaving the player's tackle zone (per tail).
- Strong Arm: +1 to the Throw Team-mate roll.
- Take Root: a standing player rolls 2+ when activated (team re-roll allowed); on a failure they are rooted until
  knocked down or placed prone, or the drive ends: the action goes on, but they cannot move or rush, cannot follow up
  and are never pushed (nobody in the chain moves), and cannot be thrown.
- Plague Ridden: once per game, an opponent killed by the player's block (not a Big Guy, and without Stunty,
  Regeneration or Decay) joins the team's reserves as a new player of its lineman position (Rotter for Nurgle). It
  counts as the team's one raised player of the game (see Masters of Undeath).
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
  team re-roll allowed). On a failure the player lashes out at an adjacent standing team-mate (the coach picks; for a
  Throw or Kick Team-mate, also a team-mate they could throw, even prone or stunned), who is knocked down (the player's Claws and Mighty Blow count for the armour roll only), and the action ends; a turnover only
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
- Ball & Chain: a Move action only. Each step, the coach picks a side and a D6 on the throw-in template facing it
  gives the square, tackle zones ignored (no dodge, Tentacles, Diving Tackle, Shadowing or jump); MA and two Rushes.
  Into a player of either team, a block from where the player stands (a Rush first if needed): no assists and the
  attacker's choice against a team-mate, a forced follow-up, no Foul Appearance, Trickster or Fend, and a prone or
  stunned player is pushed back and rolls armour without dice; knocking down a standing team-mate is a turnover. Into
  an empty square, the move, then any Rush; a loose ball there bounces (never picked up, no turnover). Off the pitch,
  the crowd and a turnover. When the player is knocked down or placed prone, the armour breaks without a roll, a
  Stunned result is a KO, and a KO gets no apothecary. A Pitch Invasion that would stun the player places them prone
  instead, with that armour break.
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
- Fend: when the player (with a tackle zone) is pushed back by a block, even if knocked down, their coach may stop the
  attacker from following up (Frenzy included); a blitzing Juggernaut ignores it.
- Pro: once per turn, the active player (standing, in their team's turn) may roll a D6 instead of using a team re-roll
  on one of their failed rolls (single-D6 checks, passes, throws of a team-mate) or a punt roll: on 3+ the die is
  re-rolled, otherwise the first result stands, unless the coach spends a team re-roll (Loner applies) or tries the
  Team Mascot to roll Pro once more (a failed Mascot still leaves the team re-roll; the Team Captain may save either).
  On block dice, the coach first picks the one die to re-roll.
- Eye Gouge: an opponent the player pushes back with a block cannot give block assists (offensive or defensive) until
  their next activation (or the end of the drive).
- Pick-me-up: at the end of the opposing team's turn (not after a touchdown or the last turn of the half), the coach
  chooses any of their prone (not stunned) players within 3 squares of a standing team-mate with the skill; each rolls
  a D6 and stands up on 5+. The coach may choose again among the others.
- Sure Feet: once per turn, a failed Rush is re-rolled automatically (before any team re-roll).
- Drunkard: -1 to every Rush roll (moves and the square a Blitz block costs).
- Cloud Burster: nobody may intercept the player's passes or bombs (a player with Very Long Legs still may).
- Decay: +1 to the player's casualty rolls (and, as before, a killed Decay player cannot be raised by Plague Ridden).
- Leap: the player may jump over any adjacent square (empty or occupied) into an empty square, and the Jump roll's
  tackle zone and Prehensile Tail penalty is reduced by 1, but not below -1.
- Iron Hard Skin: the player's armour rolls cannot be modified: no Claws, no Mighty Blow or Dirty Player on the armour
  roll (they may still go to the injury roll), no foul assists.
- Arm Bar: when an opponent falls after a failed dodge or jump out of the player's tackle zone (or after the player
  dived into their square with Diving Tackle), +1 to their armour roll if that breaks it, otherwise to the injury roll.
  Not for a failed Rush, nor against Iron Hard Skin.
- Grab: in a Block action (not a Blitz), the attacker may push the defender to any free square next to them, besides
  the usual three, and the defender's Sidestep does not work.
- Safe Pair of Hands: a ball carrier who is knocked down or placed prone (not one who falls over after a failed dodge,
  jump, Rush or landing), and is not distracted, may place the ball on a free adjacent square instead of letting it
  bounce; turnovers are unchanged.
- Diving Catch: +1 to catch an accurate pass to the player's square. When a kick-off, pass or throw-in (not a bounce)
  comes down next to standing players with the skill, the moving team (the kicking team at the kick-off) may pick one
  of its divers, or its own player in the square, to catch it, then the other team; the catch is rolled from the
  catcher's square, and a failure bounces from there. Bombs too, also after their bounce: a failed catch sets the bomb
  off in the catcher's square, and the +1 is for an accurate bomb.
- Insignificant: a team-building rule, checked by `resolveTeam`: a team may not have more players with the trait than
  players without it. It has no effect during the game.
- Fumblerooski: during an action that lets them move, a standing ball carrier may choose to drop the ball: it stays,
  without bouncing, in the square they leave on their next step, and it is not a turnover. Not with My Ball.
- Star player special rules (FUMBBL lists four star players so far; the others' rules work for any player given them in
  the team file):
  - Blind Rage (Akhorne the Squirrel): a failed Dauntless roll is re-rolled.
  - The Ballista (Morg 'n' Thorg): once per game, re-roll a failed pass or team-mate throw instead of a team re-roll.
  - I'll Carry You (Grak and Crumbleberry): once per half, when Grak's activation starts next to Crumbleberry, after
    his Bone Head roll, he may pick her up; she leaves the pitch, with the ball if she holds it, and Grak has Dodge and
    Break Tackle; at the end of the activation the coach puts her down, as she was, in a free square next to Grak, or
    where he last stood if he left the pitch. With no free square: from a sideline or an end zone she goes into the
    crowd, a turnover; otherwise she is dropped on an adjacent player, who is knocked down, and bounces on until she
    comes down, knocked down.
  - Reliable (Deeproot Strongbranch): a team-mate whose throw he fumbles still scatters, but lands safely without a roll
    (not one who lands on another player or was down).
  - Swift as the Breeze (Jordell Freshbreeze): once per game, a failed Dodge, Jump (Leap) or Rush roll passes on a
    natural 2+, whatever the modifiers; offered before any re-roll.
  - Consummate Professional (Griff Oberwald): once per game, +1 to an Agility Test (Dodge, Jump, pick-up, catch,
    landing) after the roll, when that saves it (a natural 1 still fails); offered before any re-roll.
  - Unstoppable Momentum (H'thark the Unstoppable): in a Blitz (each of its blocks), the attacker may re-roll any one
    block die of their choice, instead of the block's one re-roll.
  - Slayer (Grim Ironjaw): once per game, +1 to the armour or the injury roll of an opposing Big Guy knocked down by
    his block (a Blitz's too), after the roll: offered when it breaks the armour or changes the injury result.
  - Dwarven Scourge (Ivan 'the Animal' Deathshroud): once per game, +1 to the armour or the injury roll of an
    opponent knocked down by his block (+2 against a Dwarf), after the roll, as for Slayer.
  - Dwarfen Grit (Josef Bugman, the star player): once per game, when his armour is broken (a knock-down, a fall or a
    foul), his coach may have the armour roll rolled again; the new roll stands.
  - Ram (Rumbelow Sheepskin): once per game, +1 to the armour or the injury roll of an opponent knocked down by his
    block, after the roll, as for Slayer.
  - Crushing Blow (The Mighty Zug): once per game, +1 to the armour roll of an opponent knocked down by his block,
    after the roll, when it breaks the armour.
  - Krump and Smash (Varag Ghoul-Chewer): once per game, the armour roll of an opponent knocked down by his block may
    be re-rolled when it holds; the new roll stands.
  - Savage Mauling (Wilhelm Chaney): once per game, he may re-roll an injury roll he makes against an opponent (his
    block's knock-down, a foul, a special action), unless it is already a casualty; the new roll stands.
  - Master Assassin (Skitter Stab-Stab): once per game, the armour roll of his Stab may be re-rolled when it holds; the
    new roll stands.
  - Toxin Connoisseur (Rashnak Backstabber): once per game, +1 to the injury roll of his Stab, after the roll, when it
    changes the result.
  - Lord of Chaos (Lord Borak the Despoiler): once per game, when he blocks an opponent, he may re-roll any one block
    die of his choice, as the block's one re-roll.
  - Woodland Fury (Willow Rosebark): once per game, when her block dice would knock her down (all of them when she
    picks, any one when the defender does: a Skull, or a Both Down without Block), she may re-roll any one block die.
  - Working in Tandem (the Swift Twins; `Working in Tandem(block)` for Lucien, `Working in Tandem(pass)` for Valen):
    Lucien may re-roll any one block die against an opponent Valen also marks; Valen's pass to Lucien's square has no
    range modifier.
  - Savage Blow (Anqi Panqi): once per game, when he blocks an opponent, he may re-roll any number of the block dice,
    as the block's one re-roll.
  - Gored by the Bull (Grashnak Blackhoof): once per game, when he blocks during a Blitz and picks the die, he may roll
    one more block die (up to 3); a Frenzy second block of that Blitz gets it too.
  - Black Ink (Kiroth Krakeneye): once per game, at the start of one of his activations, an opponent he marks becomes
    Distracted until their next activation. Rules like this one are offered when the activation starts, after any
    stand-up, next to going on with the action.
  - "Excuse me, are you a Zoat?" (Zolcath the Zoat): once per game, when he is activated, an opponent within 3
    squares (with a tackle zone) becomes Distracted.
  - Baleful Hex (Estelle la Veneaux): once per game, at the start of her activation, a D6 against an opponent within 5
    squares: on 2+ they become Distracted and cannot be activated during their team's next turn.
  - Look Into My Eyes (Boa Kon'ssstriktr): once per game, starting his activation marking the opposing ball carrier, a
    D6: on 2+ he takes the ball and his activation ends; on a 1 nothing happens.
  - Catch of the Day (Rodney Roachbait): once per half, starting his activation standing within 3 squares of the ball
    on the ground, a D6: on 3+ he gets the ball (no roll to pick it up); the activation goes on.
  - Treacherous (Hakflem Skuttlespike): once per game, at the start of his activation, he takes the ball from the
    team-mate next to him who holds it; the team-mate is knocked down, without a turnover even if hurt.
  - Beer Barrel Bash! (Thorsson Stoutmead): once per drive, at the start of his activation, standing, a D6 against a
    standing opponent within 3 squares: on 3+ they are knocked down, on a 2 nothing happens, on a 1 he falls over (a
    turnover). His activation then ends.
  - "Blastin' Solves Everything" (Zzharg Madeye): once per half, at the start of his activation, a D6 against a
    standing opponent within 3 squares: on 3+ they are hit; on a 2 the opposing coach picks a standing player (either
    team, not Zzharg) within 3 squares of them to be hit instead; on a 1 Zzharg is hit. The player hit rolls armour, and
    is placed prone if it breaks (dropping the ball). His activation then ends.
  - Shot to Nothing (Gloriel Summerbloom): once per game, when she is activated, she gains Hail Mary Pass until the end
    of her activation.
  - Frenzied Rush (Glart Smashrip): once per half, declaring a Blitz, he gains Frenzy until the end of his activation
    (Grab, which only works outside a Blitz, cannot be used that turn anyway).
  - Slashing Nails (Roxanna Darknail): once per half, declaring a Blitz, she gains Claws until the end of her activation.
  - Incorporeal (Gretchen Wächter): once per game, when she is activated, she makes no Dodge rolls for leaving
    opponents' tackle zones until the end of her activation (Rushes, jumps and Shadowing still apply).
<!-- star rules -->

Not yet: spending winnings and Star Player Points between games, the golden-goal overtime variant.

The playground accepts `?seed=42` to replay the same dice.

Conventions: home on the left (scores at x=25), d8 directions clockwise from north (1 = N).

## Data sources

- Rosters: FUMBBL's BB2025 ruleset (`https://fumbbl.com/api/ruleset/get/2014`, `xml:roster?id=...`). Check FUMBBL's
  terms before redistributing.

## Assets

Board graphics are not included. The playground serves `apps/playground/public/` (git-ignored), which must contain
an `img/` folder; see `packages/board-ui/README.md` for the expected layout.
