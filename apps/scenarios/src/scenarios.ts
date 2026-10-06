import type { Action, Square } from "@bb/engine";

/** A prepared position to test a rule in the browser: two teams and the actions that lead there from a new game. */
export interface Scenario {
  id: string;
  title: string;
  /** What to do once the scenario is loaded. */
  instructions: string[];
  /** Team files in @bb/data's format. */
  home: unknown;
  away: unknown;
  seed: number;
  actions: Action[];
}

const roll = (...values: number[]): Action => ({ type: "ROLL", values });

/** Where each player (by number) is set up. */
export interface Setup {
  home: Record<number, Square>;
  away: Record<number, Square>;
}

/** A setup, and where the kick-off ball comes to rest. */
export interface Kickoff extends Setup {
  /**
   * A square of the home half, at least two rows from the top sideline: if a home player stands there, the ball lands
   * on them and they catch it; otherwise it comes down just above it and bounces onto it.
   */
  ball: Square;
}

/**
 * Actions from a new game to the kick-off: nice weather, away wins the coin toss and kicks, both teams are set up as
 * given, and the ball is kicked to `target`. The kick-off deviation roll comes next.
 */
export function toKickoff({ home, away }: Setup, target: Square): Action[] {
  const setup = (side: "home" | "away", squares: Record<number, Square>): Action[] => [
    ...Object.entries(squares).map(([nr, square]): Action => ({ type: "PLACE_PLAYER", playerId: `${side}-${nr}`, square })),
    { type: "END_SETUP" },
  ];
  return [
    roll(1, 1), // fan factor
    roll(3, 4), // weather: nice
    { type: "CALL_COIN", call: "tails" },
    roll(1), // heads: away wins the toss
    { type: "CHOOSE_KICK", kick: true },
    ...setup("away", away),
    ...setup("home", home),
    { type: "PLACE_BALL", square: target },
  ];
}

/**
 * Actions from a new game to home's first turn: `toKickoff`, then the ball deviates one square south (Get the Ref,
 * nothing happens) and comes to rest on `ball`, caught by the home player there with a 6.
 */
export function toFirstTurn({ home, away, ball }: Kickoff): Action[] {
  const caught = Object.values(home).some((s) => s.x === ball.x && s.y === ball.y);
  return [
    ...toKickoff({ home, away }, { x: ball.x, y: ball.y - (caught ? 1 : 2) }),
    roll(5, 1), // deviation: one square south
    roll(1, 1), // kick-off event: Get the Ref
    roll(caught ? 6 : 5), // the catch, or a bounce south
  ];
}

/**
 * A one-die block that knocks the defender down: a Defender Down (with a team re-roll left, the die is picked), the
 * push to `to`, no follow-up, and an armour roll of 2 that holds.
 */
export function knockBack(attackerId: string, defenderId: string, to: Square): Action[] {
  return [
    { type: "START_ACTION", playerId: attackerId, action: "block" },
    { type: "BLOCK", targetId: defenderId },
    roll(6),
    { type: "CHOOSE_BLOCK_DIE", index: 0 },
    { type: "PUSH", square: to },
    { type: "FOLLOW_UP", follow: false },
    roll(1, 1),
  ];
}

/** Every scenario, in menu order. */
export const SCENARIOS: Scenario[] = [
  {
    id: "pro-block",
    title: "Pro: re-roll one block die",
    instructions: [
      "Home's first turn. Click Gunther (#1, Pro) and declare a Block on the orc in front of him: 2 dice, you choose (the lineman above him assists).",
      "Click \"Physical dice\" and enter 1 and 1: two Skulls.",
      "Click \"Re-roll with Pro (3+)\", pick the die to re-roll, then roll the Pro D6 (3+) and the new block die.",
      "Enter 1 or 2 for the Pro D6 to fail it: a team re-roll is then offered to roll Pro again.",
    ],
    home: {
      name: "Altdorf Pros",
      roster: "Human",
      rerolls: 2,
      players: [
        { number: 1, name: "Gunther", position: "Human Lineman", skills: ["Pro"] },
        { number: 2, name: "Hans", position: "Human Lineman" },
        { number: 3, name: "Otto", position: "Human Lineman" },
      ],
    },
    away: {
      name: "Gouged Eye",
      roster: "Orc",
      rerolls: 2,
      players: [
        { number: 1, name: "Grishnak", position: "Orc Lineman" },
        { number: 2, name: "Ugluk", position: "Orc Lineman" },
        { number: 3, name: "Snaga", position: "Orc Lineman" },
      ],
    },
    seed: 1,
    actions: toFirstTurn({
      home: { 1: { x: 12, y: 7 }, 2: { x: 12, y: 6 }, 3: { x: 12, y: 10 } },
      away: { 1: { x: 13, y: 7 }, 2: { x: 13, y: 4 }, 3: { x: 13, y: 10 } },
      ball: { x: 5, y: 7 },
    }),
  },
  {
    id: "on-the-ball-pass",
    title: "On the Ball: move when the opponent passes",
    instructions: [
      "Home's first turn: Ludwig (#1) holds the ball and has declared a Pass. Click \"Throw…\", then Kurt (#5) in the bottom wide zone (a long pass).",
      "Before the throw, the away coach may move each On the Ball player (#1 on the line, #2 behind it) up to 3 squares, one at a time: pick one, click squares, then Done.",
      "Grishnak (#1) is marked: leaving takes a dodge, without a team re-roll (it is not their turn). A failed dodge ends these moves, without a turnover. Nobody rushes.",
      "Moving under the pass path lets them try to intercept.",
    ],
    home: {
      name: "Altdorf Passers",
      roster: "Human",
      rerolls: 2,
      players: [
        { number: 1, name: "Ludwig", position: "Human Thrower" },
        { number: 2, name: "Hans", position: "Human Lineman" },
        { number: 3, name: "Otto", position: "Human Lineman" },
        { number: 4, name: "Fritz", position: "Human Lineman" },
        { number: 5, name: "Kurt", position: "Human Catcher" },
      ],
    },
    away: {
      name: "Ball Watchers",
      roster: "Orc",
      rerolls: 2,
      players: [
        { number: 1, name: "Grishnak", position: "Orc Lineman", skills: ["On the Ball"] },
        { number: 2, name: "Ugluk", position: "Orc Lineman", skills: ["On the Ball"] },
        { number: 3, name: "Snaga", position: "Orc Lineman" },
        { number: 4, name: "Lugdush", position: "Orc Lineman" },
      ],
    },
    seed: 2,
    actions: [
      ...toFirstTurn({
        home: { 1: { x: 6, y: 7 }, 2: { x: 12, y: 5 }, 3: { x: 12, y: 7 }, 4: { x: 12, y: 9 }, 5: { x: 11, y: 12 } },
        away: { 1: { x: 13, y: 9 }, 2: { x: 16, y: 8 }, 3: { x: 13, y: 5 }, 4: { x: 13, y: 7 } },
        ball: { x: 6, y: 7 },
      }),
      { type: "START_ACTION", playerId: "home-1", action: "pass" },
    ],
  },
  {
    id: "on-the-ball-kickoff",
    title: "On the Ball: move during the kick-off",
    instructions: [
      "Away has kicked the ball towards (5, 7). Roll the kick-off deviation (Physical dice: 1 and 3 sends it 3 squares north).",
      "Before the kick-off event, one unmarked home player with On the Ball may move up to 3 squares in the home half: Kurt (#4) can, Hans (#1) on the line of scrimmage is marked and cannot.",
      "Move Kurt next to where the ball comes down, or under it, then click Done. Here the team re-roll is offered for a failed dodge.",
    ],
    home: {
      name: "Altdorf Returners",
      roster: "Human",
      rerolls: 2,
      players: [
        { number: 1, name: "Hans", position: "Human Lineman", skills: ["On the Ball"] },
        { number: 2, name: "Otto", position: "Human Lineman" },
        { number: 3, name: "Fritz", position: "Human Lineman" },
        { number: 4, name: "Kurt", position: "Human Catcher", skills: ["On the Ball"] },
      ],
    },
    away: {
      name: "Kick Masters",
      roster: "Orc",
      rerolls: 2,
      players: [
        { number: 1, name: "Grishnak", position: "Orc Lineman" },
        { number: 2, name: "Ugluk", position: "Orc Lineman" },
        { number: 3, name: "Snaga", position: "Orc Lineman" },
      ],
    },
    seed: 3,
    actions: toKickoff(
      {
        home: { 1: { x: 12, y: 7 }, 2: { x: 12, y: 5 }, 3: { x: 12, y: 9 }, 4: { x: 7, y: 6 } },
        away: { 1: { x: 13, y: 7 }, 2: { x: 13, y: 5 }, 3: { x: 13, y: 9 } },
      },
      { x: 5, y: 7 },
    ),
  },
  {
    id: "bombardier",
    title: "Bombardier: throw a bomb",
    instructions: [
      "Home's first turn. Click Ludwig (#1) and declare Throw Bomb: he cannot move first.",
      "Click \"Throw…\" and pick a target: Gorbag (#5, a short throw) to see a catch, or the empty square above Lugdush (#6) to see the bomb bounce once before it explodes.",
      "Grishnak (#2) on the line may be under the path: the away coach may try to intercept, and an interceptor must throw the bomb straight back.",
      "A player who catches the bomb must throw it again at once (the away coach aims); a failed catch sets it off on them.",
      "The explosion hits the player in the square, and each player around it on a 4+: standing players are knocked down, prone ones roll armour. Knocking down a home player is a turnover; a fumble (a 1) explodes on Ludwig. Undo to try another target.",
    ],
    home: {
      name: "Altdorf Sappers",
      roster: "Human",
      rerolls: 2,
      players: [
        { number: 1, name: "Ludwig", position: "Human Thrower", skills: ["Bombardier"] },
        { number: 2, name: "Hans", position: "Human Lineman" },
        { number: 3, name: "Otto", position: "Human Lineman" },
        { number: 4, name: "Fritz", position: "Human Lineman" },
      ],
    },
    away: {
      name: "Blast Radius",
      roster: "Orc",
      rerolls: 2,
      players: [
        { number: 1, name: "Snaga", position: "Orc Lineman" },
        { number: 2, name: "Grishnak", position: "Orc Lineman" },
        { number: 3, name: "Lugbur", position: "Orc Lineman" },
        { number: 4, name: "Ugluk", position: "Orc Lineman" },
        { number: 5, name: "Gorbag", position: "Orc Lineman" },
        { number: 6, name: "Lugdush", position: "Orc Lineman" },
      ],
    },
    seed: 4,
    actions: toFirstTurn({
      home: { 1: { x: 11, y: 8 }, 2: { x: 12, y: 4 }, 3: { x: 12, y: 7 }, 4: { x: 12, y: 10 } },
      away: { 1: { x: 13, y: 4 }, 2: { x: 13, y: 7 }, 3: { x: 13, y: 10 }, 4: { x: 16, y: 6 }, 5: { x: 16, y: 7 }, 6: { x: 17, y: 7 } },
      ball: { x: 5, y: 7 },
    }),
  },
  {
    id: "diving-tackle",
    title: "Diving Tackle and Break Tackle on a dodge",
    instructions: [
      "Home's first turn. Click Gorbag (#1: Block, Break Tackle, Dodge) and declare a Move to the square behind him: a 3+ dodge away from three humans. Hans (#1) and Fritz (#3) have Diving Tackle.",
      "Enter the dodge by hand to see each case (Undo to try the next): 5 or 6, Diving Tackle cannot make it fail and is not offered.",
      "4: the away coach is offered Diving Tackle (-2); Break Tackle (+1) still saves the dodge, and the tackler lands prone in the square Gorbag left.",
      "3 or 2: with Diving Tackle the dodge fails, and Dodge re-rolls it automatically, keeping the -2. Without it, a 2 is saved by Break Tackle.",
      "Break Tackle works once per turn: after using it, step back next to a human and dodge away again to see it gone.",
    ],
    home: {
      name: "Slippery Gits",
      roster: "Orc",
      rerolls: 2,
      players: [
        { number: 1, name: "Gorbag", position: "Orc Blitzer", skills: ["Dodge"] },
        { number: 2, name: "Snaga", position: "Orc Lineman" },
        { number: 3, name: "Lugbur", position: "Orc Lineman" },
      ],
    },
    away: {
      name: "Altdorf Tacklers",
      roster: "Human",
      rerolls: 2,
      players: [
        { number: 1, name: "Hans", position: "Human Lineman", skills: ["Diving Tackle"] },
        { number: 2, name: "Otto", position: "Human Lineman" },
        { number: 3, name: "Fritz", position: "Human Lineman", skills: ["Diving Tackle"] },
      ],
    },
    seed: 5,
    actions: toFirstTurn({
      home: { 1: { x: 12, y: 7 }, 2: { x: 12, y: 4 }, 3: { x: 12, y: 10 } },
      away: { 1: { x: 13, y: 6 }, 2: { x: 13, y: 7 }, 3: { x: 13, y: 8 } },
      ball: { x: 5, y: 7 },
    }),
  },
  {
    id: "block-followups",
    title: "Follow-ups: Frenzy, Fend, Juggernaut, Stand Firm, Sidestep, Taunt, Hit and Run",
    instructions: [
      "Three one-die blocks across the line of scrimmage: enter the block die by hand (Physical dice) and pick the result: 3 or 4 is a Push, 6 a Defender Down.",
      "Top: Hans (#1, Frenzy) blocks Grishnak (#1, Fend). On a push the away coach may use Fend: Hans then cannot follow up (Frenzy included) and gets no second block. Without Fend, Frenzy must follow up and blocks again.",
      "Middle: Otto (#2, Juggernaut) declares a Blitz on Ugluk (#2, Stand Firm and Fend): Juggernaut cancels both, so Ugluk is pushed and Otto may follow up. Declared as a plain Block instead, Ugluk may stand firm or fend.",
      "Bottom: Fritz (#3, Block, Hit and Run) blocks Snaga (#3, Sidestep, Taunt): the away coach picks any free square for the push (Sidestep), then may force Fritz to follow up (Taunt). Afterwards Fritz may step to a free square away from opponents (Hit and Run).",
    ],
    home: {
      name: "Altdorf Shovers",
      roster: "Human",
      rerolls: 3,
      players: [
        { number: 1, name: "Hans", position: "Human Lineman", skills: ["Frenzy"] },
        { number: 2, name: "Otto", position: "Human Lineman", skills: ["Juggernaut"] },
        { number: 3, name: "Fritz", position: "Human Lineman", skills: ["Block", "Hit and Run"] },
      ],
    },
    away: {
      name: "Stubborn Gits",
      roster: "Orc",
      rerolls: 2,
      players: [
        { number: 1, name: "Grishnak", position: "Orc Lineman", skills: ["Fend"] },
        { number: 2, name: "Ugluk", position: "Orc Lineman", skills: ["Stand Firm", "Fend"] },
        { number: 3, name: "Snaga", position: "Orc Lineman", skills: ["Sidestep", "Taunt"] },
      ],
    },
    seed: 6,
    actions: toFirstTurn({
      home: { 1: { x: 12, y: 4 }, 2: { x: 12, y: 7 }, 3: { x: 12, y: 10 } },
      away: { 1: { x: 13, y: 4 }, 2: { x: 13, y: 7 }, 3: { x: 13, y: 10 } },
      ball: { x: 5, y: 7 },
    }),
  },
  {
    id: "shadowing",
    title: "Shadowing: follow a player leaving the tackle zone",
    instructions: [
      "Home's first turn. Declare a Move with Kurt (#1, Catcher) and step back to the square behind him: a dodge out of the tackle zones of all three elves.",
      "The away coach then picks one shadower (Malekith #1 or Morathi #2, both Assassins with Shadowing) or skips: on a D6 of 4+ the shadower steps into the square Kurt left, without any roll.",
      "Keep running away: each time Kurt leaves a shadower's tackle zone, the away coach may shadow again. Morathi has MA 1 (old injuries), so she can only shadow once this turn; Malekith up to 7 times.",
      "A jump over a prone player does not trigger Shadowing.",
    ],
    home: {
      name: "Altdorf Runners",
      roster: "Human",
      rerolls: 2,
      players: [
        { number: 1, name: "Kurt", position: "Human Catcher" },
        { number: 2, name: "Hans", position: "Human Lineman" },
        { number: 3, name: "Otto", position: "Human Lineman" },
      ],
    },
    away: {
      name: "Naggaroth Shadows",
      roster: "Dark Elf",
      rerolls: 2,
      players: [
        { number: 1, name: "Malekith", position: "Dark Elf Assassin" },
        { number: 2, name: "Morathi", position: "Dark Elf Assassin", injuries: ["ma", "ma", "ma", "ma", "ma", "ma"] },
        { number: 3, name: "Kaldor", position: "Dark Elf Lineman" },
      ],
    },
    seed: 7,
    actions: toFirstTurn({
      home: { 1: { x: 12, y: 7 }, 2: { x: 12, y: 4 }, 3: { x: 12, y: 10 } },
      away: { 1: { x: 13, y: 6 }, 2: { x: 13, y: 8 }, 3: { x: 13, y: 7 } },
      ball: { x: 5, y: 7 },
    }),
  },
  {
    id: "block-rerolls",
    title: "Block re-rolls: team re-roll, Brawler, Hatred, Pro and Loner",
    instructions: [
      "Home's first turn. Declare a Block with Gunther (#1: Pro, Brawler, Hatred(orc), Loner(4)) on the orc in front of him: 2 dice, you choose.",
      "Enter 1 and 2 (Physical dice): a Skull and a Both Down. Four re-rolls are offered: the team re-roll (Gunther must then roll 4+ for Loner), Brawler (the Both Down), Hatred (the Skull, he hates orcs) and Pro (the die you pick, on a 3+).",
      "Only one of them can be used on a block. Undo to try each; a failed Pro roll offers the team re-roll (with Loner) to roll Pro again.",
    ],
    home: {
      name: "Altdorf Grudges",
      roster: "Human",
      rerolls: 3,
      players: [
        { number: 1, name: "Gunther", position: "Human Lineman", skills: ["Pro", "Brawler", "Hatred(orc)", "Loner(4)"] },
        { number: 2, name: "Hans", position: "Human Lineman" },
        { number: 3, name: "Otto", position: "Human Lineman" },
      ],
    },
    away: {
      name: "Gouged Eye",
      roster: "Orc",
      rerolls: 2,
      players: [
        { number: 1, name: "Grishnak", position: "Orc Lineman" },
        { number: 2, name: "Ugluk", position: "Orc Lineman" },
        { number: 3, name: "Snaga", position: "Orc Lineman" },
      ],
    },
    seed: 8,
    actions: toFirstTurn({
      home: { 1: { x: 12, y: 7 }, 2: { x: 12, y: 6 }, 3: { x: 12, y: 10 } },
      away: { 1: { x: 13, y: 7 }, 2: { x: 13, y: 4 }, 3: { x: 13, y: 10 } },
      ball: { x: 5, y: 7 },
    }),
  },
  {
    id: "throw-team-mate",
    title: "Throw Team-mate, Right Stuff and Always Hungry",
    instructions: [
      "Home's first turn. Declare Throw Team-mate with Grumbol (#1, Troll): first his Really Stupid roll (2+, a team-mate stands next to him).",
      "Click Snikkit (#2, Goblin with Right Stuff), then a highlighted square (Quick or Short range) to throw him to.",
      "Always Hungry: Grumbol rolls 2+ first; on a 1 Snikkit must escape on 2+ (then he is thrown as a fumble) or is eaten.",
      "Then the throw roll (a superb throw lands in the square, a subpar one scatters three times, a fumble once from Snikkit), and Snikkit's landing roll (AG, -1 per tackle zone). Throw him onto an opponent to see the hit.",
    ],
    home: {
      name: "Flying Gits",
      roster: "Orc",
      rerolls: 2,
      players: [
        { number: 1, name: "Grumbol", position: "Troll" },
        { number: 2, name: "Snikkit", position: "Goblin Lineman" },
        { number: 3, name: "Grishnak", position: "Orc Lineman" },
        { number: 4, name: "Ugluk", position: "Orc Lineman" },
        { number: 5, name: "Snaga", position: "Orc Lineman" },
      ],
    },
    away: {
      name: "Altdorf Targets",
      roster: "Human",
      rerolls: 2,
      players: [
        { number: 1, name: "Hans", position: "Human Lineman" },
        { number: 2, name: "Otto", position: "Human Lineman" },
        { number: 3, name: "Fritz", position: "Human Lineman" },
        { number: 4, name: "Kurt", position: "Human Lineman" },
      ],
    },
    seed: 9,
    actions: toFirstTurn({
      home: { 1: { x: 11, y: 7 }, 2: { x: 10, y: 7 }, 3: { x: 12, y: 5 }, 4: { x: 12, y: 7 }, 5: { x: 12, y: 9 } },
      away: { 1: { x: 13, y: 5 }, 2: { x: 13, y: 7 }, 3: { x: 13, y: 9 }, 4: { x: 16, y: 7 } },
      ball: { x: 5, y: 7 },
    }),
  },
  {
    id: "pick-me-up",
    title: "Pick-me-up: stand up after the opponent's turn",
    instructions: [
      "Home has already knocked down three Norse raiders this turn (they are prone). Click End turn.",
      "At the end of home's turn, the away coach may pick prone raiders within 3 squares of Bjorn (#4, Beer Boar, Pick-me-up): Ragnar (#1) and Sven (#2), not Leif (#3), who is too far.",
      "Each one picked rolls a D6 (several dice at once) and stands up on 5+; the coach may then pick again among the others, or skip.",
    ],
    home: {
      name: "Altdorf Bashers",
      roster: "Human",
      rerolls: 2,
      players: [
        { number: 1, name: "Hans", position: "Human Lineman" },
        { number: 2, name: "Otto", position: "Human Lineman" },
        { number: 3, name: "Fritz", position: "Human Lineman" },
      ],
    },
    away: {
      name: "Hangover Hall",
      roster: "Norse",
      rerolls: 2,
      players: [
        { number: 1, name: "Ragnar", position: "Norse Raider" },
        { number: 2, name: "Sven", position: "Norse Raider" },
        { number: 3, name: "Leif", position: "Norse Raider" },
        { number: 4, name: "Bjorn", position: "Beer Boar" },
      ],
    },
    seed: 10,
    actions: [
      ...toFirstTurn({
        home: { 1: { x: 12, y: 7 }, 2: { x: 12, y: 5 }, 3: { x: 12, y: 9 } },
        away: { 1: { x: 13, y: 7 }, 2: { x: 13, y: 5 }, 3: { x: 13, y: 9 }, 4: { x: 16, y: 6 } },
        ball: { x: 5, y: 7 },
      }),
      // Three blocks: Defender Down, pushed straight back, no follow-up, armour holds.
      ...knockBack("home-1", "away-1", { x: 14, y: 7 }),
      ...knockBack("home-2", "away-2", { x: 14, y: 4 }),
      ...knockBack("home-3", "away-3", { x: 14, y: 10 }),
    ],
  },
  {
    id: "animal-savagery",
    title: "Animal Savagery: lash out at a team-mate",
    instructions: [
      "Home's first turn. Declare an action with Skritch (#1, Rat Ogre): Animal Savagery is rolled first, 2+ for a Block or Blitz, 4+ otherwise (Loner(4) applies to the team re-roll).",
      "Fail it (Physical dice: 1) and decline the re-roll: the home coach must pick one of the two standing team-mates next to Skritch (no Skip). That rat is knocked down (Mighty Blow counts for the armour only) and Skritch's action ends, without a turnover.",
      "Undo, and first move Snikch (#2) and Queek (#3) away from Skritch: now a failed roll finds nobody to lash out at, so the action is lost and Skritch is distracted (no tackle zone).",
    ],
    home: {
      name: "Clan Rattus",
      roster: "Skaven",
      rerolls: 2,
      players: [
        { number: 1, name: "Skritch", position: "Rat Ogre" },
        { number: 2, name: "Snikch", position: "Skaven Clanrat" },
        { number: 3, name: "Queek", position: "Skaven Clanrat" },
        { number: 4, name: "Ikit", position: "Skaven Clanrat" },
      ],
    },
    away: {
      name: "Altdorf Ratcatchers",
      roster: "Human",
      rerolls: 2,
      players: [
        { number: 1, name: "Hans", position: "Human Lineman" },
        { number: 2, name: "Otto", position: "Human Lineman" },
        { number: 3, name: "Fritz", position: "Human Lineman" },
      ],
    },
    seed: 11,
    actions: toFirstTurn({
      home: { 1: { x: 12, y: 7 }, 2: { x: 12, y: 6 }, 3: { x: 11, y: 7 }, 4: { x: 12, y: 10 } },
      away: { 1: { x: 13, y: 7 }, 2: { x: 13, y: 4 }, 3: { x: 13, y: 10 } },
      ball: { x: 5, y: 7 },
    }),
  },
];
