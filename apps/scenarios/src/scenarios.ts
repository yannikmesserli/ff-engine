import type { Action, Square } from "@bb/engine";

/** A prepared position to test a rule in the browser: two teams and the actions that lead there from a new game. */
export interface Scenario {
  id: string;
  title: string;
  /** What to do once the scenario is loaded. */
  instructions: string[];
  /** Team files in @bb/data's format; their few players are on purpose, so they take no journeymen. */
  home: unknown;
  away: unknown;
  seed: number;
  /** The game uses the pre-game shop. */
  shop?: boolean;
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
      "Enter 1 or 2 for the Pro D6 to fail it: a team re-roll, or the Team Mascot the team bought, is then offered to roll Pro again.",
      "Pick the Team Mascot: on 4+ Pro is rolled again without spending a team re-roll; on a failure, the team re-roll is still offered.",
    ],
    home: {
      name: "Altdorf Pros",
      roster: "Human",
      rerolls: 2,
      journeymen: false,
      inducements: { teamMascot: 1 },
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
      journeymen: false,
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
      journeymen: false,
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
      journeymen: false,
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
      journeymen: false,
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
      journeymen: false,
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
      journeymen: false,
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
      journeymen: false,
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
    id: "bomb-diving-catch",
    title: "Diving Catch on a bomb",
    instructions: [
      "Home's first turn. Lugdush (#6, at (17,7)) has Diving Catch here (given in the team file in src/scenarios.ts).",
      "Declare Throw Bomb with Ludwig (#1), click \"Throw…\" and aim at the empty square above Lugdush, (17,6).",
      "The orcs may try to intercept first (skip it). When the bomb comes down there (or next to him after a bounce), the orc coach may pick Lugdush to catch it from his own square: +1 for an accurate bomb. Caught, he must throw it again at once; dropped, it explodes on him. Pick nobody to let it bounce as usual.",
    ],
    home: {
      name: "Altdorf Sappers",
      roster: "Human",
      rerolls: 2,
      journeymen: false,
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
      journeymen: false,
      players: [
        { number: 1, name: "Snaga", position: "Orc Lineman" },
        { number: 2, name: "Grishnak", position: "Orc Lineman" },
        { number: 3, name: "Lugbur", position: "Orc Lineman" },
        { number: 4, name: "Ugluk", position: "Orc Lineman" },
        { number: 5, name: "Gorbag", position: "Orc Lineman" },
        { number: 6, name: "Lugdush", position: "Orc Lineman", skills: ["Diving Catch"] },
      ],
    },
    seed: 4,
    actions: toFirstTurn({
      home: { 1: { x: 11, y: 8 }, 2: { x: 12, y: 4 }, 3: { x: 12, y: 7 }, 4: { x: 12, y: 10 } },
      away: { 1: { x: 13, y: 4 }, 2: { x: 13, y: 7 }, 3: { x: 13, y: 10 }, 4: { x: 16, y: 5 }, 5: { x: 16, y: 9 }, 6: { x: 17, y: 7 } },
      ball: { x: 5, y: 7 },
    }),
  },
  {
    id: "hail-mary-bomb",
    title: "Hail Mary Pass with a bomb",
    instructions: [
      "Home's first turn. Ludwig (#1) has Bombardier and Hail Mary Pass here (given in the team file in src/scenarios.ts).",
      "Declare Throw Bomb with him, then click \"Hail Mary Pass\" and any square of the pitch, e.g. among the orcs at the back.",
      "The roll counts as a Long Bomb; anything but a fumble scatters three times from the target, and nobody may intercept. Off the pitch the bomb is lost; otherwise it lands as a scattered bomb (catch, bounce or explosion). A fumble explodes on Ludwig.",
    ],
    home: {
      name: "Altdorf Sappers",
      roster: "Human",
      rerolls: 2,
      journeymen: false,
      players: [
        { number: 1, name: "Ludwig", position: "Human Thrower", skills: ["Bombardier", "Hail Mary Pass"] },
        { number: 2, name: "Hans", position: "Human Lineman" },
        { number: 3, name: "Otto", position: "Human Lineman" },
        { number: 4, name: "Fritz", position: "Human Lineman" },
      ],
    },
    away: {
      name: "Blast Radius",
      roster: "Orc",
      rerolls: 2,
      journeymen: false,
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
      away: { 1: { x: 13, y: 4 }, 2: { x: 13, y: 7 }, 3: { x: 13, y: 10 }, 4: { x: 20, y: 6 }, 5: { x: 21, y: 7 }, 6: { x: 20, y: 8 } },
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
      journeymen: false,
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
      journeymen: false,
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
      journeymen: false,
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
      journeymen: false,
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
      journeymen: false,
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
      journeymen: false,
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
      journeymen: false,
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
      journeymen: false,
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
      journeymen: false,
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
      journeymen: false,
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
    id: "reliable",
    title: "Reliable: a fumbled team-mate lands safely",
    instructions: [
      "Home's first turn. Grumbol (#1, Troll) has Reliable here (a star player's special rule, given to him in the team file in src/scenarios.ts).",
      "Click \"Physical dice\", declare Throw Team-mate with Grumbol (Really Stupid: enter 2+; Always Hungry: 2+), click Snikkit (#2), then a square to throw him to.",
      "Enter a 1 for the throw (a fumble) and decline the re-roll: Snikkit scatters once from his square, then lands on his feet without a landing roll (the log says Reliable).",
    ],
    home: {
      name: "Flying Gits",
      roster: "Orc",
      rerolls: 2,
      journeymen: false,
      players: [
        { number: 1, name: "Grumbol", position: "Troll", skills: ["Reliable"] },
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
      journeymen: false,
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
    id: "savage-thrower",
    title: "Animal Savagery: lash out at the team-mate to be thrown",
    instructions: [
      "Home's second turn. Snikkit (#2, Goblin) went down in a Both Down block last turn and lies prone next to Grumbol (#1, Troll), who has Animal Savagery here (given in the team file in src/scenarios.ts).",
      "Click \"Physical dice\", declare Throw Team-mate with Grumbol and enter a 1 for Animal Savagery (4+), then decline the re-roll: he lashes out at Snikkit, prone as he is, since he is the team-mate he could throw (armour roll; the action ends).",
      "Declare a Move with Grumbol instead and fail the roll: with no standing team-mate next to him, the action is just lost.",
    ],
    home: {
      name: "Flying Gits",
      roster: "Orc",
      rerolls: 2,
      journeymen: false,
      players: [
        { number: 1, name: "Grumbol", position: "Troll", skills: ["Animal Savagery"] },
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
      journeymen: false,
      players: [
        { number: 1, name: "Hans", position: "Human Lineman" },
        { number: 2, name: "Otto", position: "Human Lineman" },
        { number: 3, name: "Fritz", position: "Human Lineman" },
        { number: 4, name: "Kurt", position: "Human Lineman" },
      ],
    },
    seed: 9,
    actions: [
      ...toFirstTurn({
        home: { 1: { x: 11, y: 7 }, 2: { x: 12, y: 7 }, 3: { x: 12, y: 5 }, 4: { x: 12, y: 9 }, 5: { x: 8, y: 7 } },
        away: { 1: { x: 13, y: 5 }, 2: { x: 13, y: 7 }, 3: { x: 13, y: 9 }, 4: { x: 16, y: 7 } },
        ball: { x: 8, y: 7 },
      }),
      // Snikkit blocks Otto: Both Down (the humans pick), both armour rolls hold, a turnover; then the humans end their turn.
      { type: "START_ACTION", playerId: "home-2", action: "block" },
      { type: "BLOCK", targetId: "away-2" },
      roll(2, 2),
      { type: "DECLINE_REROLL" },
      { type: "CHOOSE_BLOCK_DIE", index: 0 },
      roll(1, 1),
      roll(1, 1),
      { type: "END_TURN" },
    ],
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
      journeymen: false,
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
      journeymen: false,
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
      journeymen: false,
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
      journeymen: false,
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
  {
    id: "bloodlust",
    title: "Bloodlust: a thirsty vampire bites a Thrall",
    instructions: [
      "Home's first turn. Declare a Block with Count Vlad (#1, Vampire Blitzer, Bloodlust(3)): Bloodlust is rolled first, 2+ for a Block or Blitz (3+ otherwise).",
      "Fail it (Physical dice: 1) and decline the re-roll: Vlad is thirsty. The coach may switch the declared Block to a Move action instead.",
      "Before the action ends (and before passing, handing off or scoring), Vlad bites a Thrall next to him: pick Igor (#2) or Renfield (#3). The Thrall is placed prone and rolls for injury without armour; biting nobody (Skip) is a turnover.",
    ],
    home: {
      name: "Sylvania Nights",
      roster: "Vampire",
      rerolls: 2,
      journeymen: false,
      players: [
        { number: 1, name: "Count Vlad", position: "Vampire Blitzer" },
        { number: 2, name: "Igor", position: "Thrall Lineman" },
        { number: 3, name: "Renfield", position: "Thrall Lineman" },
        { number: 4, name: "Ludmila", position: "Thrall Lineman" },
      ],
    },
    away: {
      name: "Altdorf Hunters",
      roster: "Human",
      rerolls: 2,
      journeymen: false,
      players: [
        { number: 1, name: "Hans", position: "Human Lineman" },
        { number: 2, name: "Otto", position: "Human Lineman" },
        { number: 3, name: "Fritz", position: "Human Lineman" },
      ],
    },
    seed: 12,
    actions: toFirstTurn({
      home: { 1: { x: 12, y: 7 }, 2: { x: 12, y: 6 }, 3: { x: 11, y: 8 }, 4: { x: 12, y: 10 } },
      away: { 1: { x: 13, y: 7 }, 2: { x: 13, y: 4 }, 3: { x: 13, y: 10 } },
      ball: { x: 5, y: 7 },
    }),
  },
  {
    id: "hypnotic-gaze",
    title: "Hypnotic Gaze and Foul Appearance",
    instructions: [
      "Home's first turn. Click Hans (#1, Hypnotic Gaze) and declare Hypnotic Gaze: he may move first, then click \"Gaze at …\" for an adjacent standing opponent.",
      "Gazing at Festus (#1, Bloater, Foul Appearance) takes a Foul Appearance roll first (2+; a 1 ends Hans's action). Then the gaze: on 3+ Festus is distracted until his next action (no tackle zone, no assists). The action ends either way, without a turnover.",
      "Then block Festus with Otto (#2): Foul Appearance is rolled again before the block (a failure wastes the block and ends Otto's action, without a turnover).",
    ],
    home: {
      name: "Altdorf Mesmerists",
      roster: "Human",
      rerolls: 2,
      journeymen: false,
      players: [
        { number: 1, name: "Hans", position: "Human Lineman", skills: ["Hypnotic Gaze"] },
        { number: 2, name: "Otto", position: "Human Lineman" },
        { number: 3, name: "Fritz", position: "Human Lineman" },
      ],
    },
    away: {
      name: "Rotten Bellies",
      roster: "Nurgle",
      rerolls: 2,
      journeymen: false,
      players: [
        { number: 1, name: "Festus", position: "Bloater" },
        { number: 2, name: "Gutrot", position: "Rotter Lineman" },
        { number: 3, name: "Pustule", position: "Rotter Lineman" },
      ],
    },
    seed: 13,
    actions: toFirstTurn({
      home: { 1: { x: 12, y: 8 }, 2: { x: 12, y: 6 }, 3: { x: 12, y: 10 } },
      away: { 1: { x: 13, y: 7 }, 2: { x: 13, y: 5 }, 3: { x: 13, y: 10 } },
      ball: { x: 5, y: 7 },
    }),
  },
  {
    id: "wrestle-steady-footing",
    title: "Wrestle and Steady Footing",
    instructions: [
      "Home's first turn: two one-die blocks, with the die entered by hand (Physical dice).",
      "Bertrand (#1, Squire, Wrestle) blocks Wilhelm (#1, Bodyguard, Wrestle and Stand Firm). Enter 2, a Both Down: the home coach is asked about Wrestle first, then (if declined) the away coach. Wrestle places both prone, without armour rolls or a turnover, and ends Bertrand's action; declined by both, the two of them are knocked down (no Block) and it is a turnover.",
      "Galahad (#2, Grail Knight, Steady Footing) blocks Dieter (#2). Enter 1, a Skull: before going down, Galahad may roll for Steady Footing; on a 6 he stays on his feet and there is no turnover.",
    ],
    home: {
      name: "Bastonne Lances",
      roster: "Bretonnian",
      rerolls: 2,
      journeymen: false,
      players: [
        { number: 1, name: "Bertrand", position: "Bretonnian Squire" },
        { number: 2, name: "Galahad", position: "Grail Knight" },
        { number: 3, name: "Roland", position: "Bretonnian Squire" },
      ],
    },
    away: {
      name: "Altdorf Guard",
      roster: "Imperial Nobility",
      rerolls: 2,
      journeymen: false,
      players: [
        { number: 1, name: "Wilhelm", position: "Bodyguard" },
        { number: 2, name: "Dieter", position: "Imperial Retainer" },
        { number: 3, name: "Konrad", position: "Imperial Retainer" },
      ],
    },
    seed: 14,
    actions: toFirstTurn({
      home: { 1: { x: 12, y: 7 }, 2: { x: 12, y: 4 }, 3: { x: 12, y: 10 } },
      away: { 1: { x: 13, y: 7 }, 2: { x: 13, y: 4 }, 3: { x: 13, y: 10 } },
      ball: { x: 5, y: 7 },
    }),
  },
  {
    id: "safe-pair-of-hands",
    title: "Safe Pair of Hands: place the ball instead of a bounce",
    instructions: [
      "Home's first turn: Orion (#1, Wood Elf Thrower, Safe Pair of Hands) holds the ball on the line of scrimmage.",
      "Declare a Block with Orion on the orc in front of him and enter 1 (Physical dice), a Skull: Orion is knocked down (a turnover). After his armour roll, the home coach may use Safe Pair of Hands, then click a free square next to him: the ball stays there, without a bounce.",
      "Undo, and declare a Move instead: step back away from the orc and fail the dodge (enter 1, decline the re-roll). A player who falls over cannot use Safe Pair of Hands: the ball bounces.",
    ],
    home: {
      name: "Athel Loren Hands",
      roster: "Wood Elf",
      rerolls: 2,
      journeymen: false,
      players: [
        { number: 1, name: "Orion", position: "Wood Elf Thrower" },
        { number: 2, name: "Ariel", position: "Wood Elf Lineman" },
        { number: 3, name: "Drycha", position: "Wood Elf Lineman" },
      ],
    },
    away: {
      name: "Gouged Eye",
      roster: "Orc",
      rerolls: 2,
      journeymen: false,
      players: [
        { number: 1, name: "Grishnak", position: "Orc Lineman" },
        { number: 2, name: "Ugluk", position: "Orc Lineman" },
        { number: 3, name: "Snaga", position: "Orc Lineman" },
      ],
    },
    seed: 15,
    actions: toFirstTurn({
      home: { 1: { x: 12, y: 7 }, 2: { x: 12, y: 4 }, 3: { x: 12, y: 10 } },
      away: { 1: { x: 13, y: 7 }, 2: { x: 13, y: 4 }, 3: { x: 13, y: 10 } },
      ball: { x: 12, y: 7 },
    }),
  },
  {
    id: "diving-catch",
    title: "Diving Catch: catch a ball coming down next to the player",
    instructions: [
      "Home's first turn: Ludwig (#1) holds the ball and has declared a Pass. In the bottom wide zone, Kurt (#4, Diving Catch) and the orc Gorbag (#4, Diving Catch) stand on either side of the empty square (13, 11).",
      "Click \"Throw…\" and pick that empty square (a short pass). Once the pass comes down there, home picks first: Kurt dives for it from his own square (+1 for an accurate pass). Skip, and the away coach may send Gorbag instead. Nobody: the ball lands and bounces.",
      "A failed diving catch bounces from the diver's square. Undo and throw straight to Kurt: Diving Catch gives +1 to catch an accurate pass.",
    ],
    home: {
      name: "Altdorf Divers",
      roster: "Human",
      rerolls: 2,
      journeymen: false,
      players: [
        { number: 1, name: "Ludwig", position: "Human Thrower" },
        { number: 2, name: "Hans", position: "Human Lineman" },
        { number: 3, name: "Otto", position: "Human Lineman" },
        { number: 4, name: "Kurt", position: "Human Catcher", skills: ["Diving Catch"] },
        { number: 5, name: "Fritz", position: "Human Lineman" },
      ],
    },
    away: {
      name: "Gouged Eye",
      roster: "Orc",
      rerolls: 2,
      journeymen: false,
      players: [
        { number: 1, name: "Grishnak", position: "Orc Lineman" },
        { number: 2, name: "Ugluk", position: "Orc Lineman" },
        { number: 3, name: "Snaga", position: "Orc Lineman" },
        { number: 4, name: "Gorbag", position: "Orc Lineman", skills: ["Diving Catch"] },
      ],
    },
    seed: 16,
    actions: [
      ...toFirstTurn({
        home: { 1: { x: 8, y: 8 }, 2: { x: 12, y: 5 }, 3: { x: 12, y: 7 }, 4: { x: 12, y: 11 }, 5: { x: 12, y: 9 } },
        away: { 1: { x: 13, y: 5 }, 2: { x: 13, y: 7 }, 3: { x: 13, y: 9 }, 4: { x: 14, y: 11 } },
        ball: { x: 8, y: 8 },
      }),
      { type: "START_ACTION", playerId: "home-1", action: "pass" },
    ],
  },
  {
    id: "fumblerooski",
    title: "Fumblerooski: drop the ball in the square left",
    instructions: [
      "Home's first turn: Ithilmar (#1, Elf Lineman, Fumblerooski) holds the ball on the line of scrimmage.",
      "Declare a Move with him and click \"Drop the ball on the next step (Fumblerooski)\", then step back (a dodge away from the orc). The ball stays, without bouncing, in the square he left, even if the dodge fails; leaving it is no turnover.",
      "End his action: it is still home's turn. Then Move Caledor (#4) onto the ball to pick it up again (a pick-up roll, -1 for the orc's tackle zone).",
      "Undo and end Ithilmar's action without stepping: he keeps the ball.",
    ],
    home: {
      name: "Elven Tricksters",
      roster: "Elven Union",
      rerolls: 2,
      journeymen: false,
      players: [
        { number: 1, name: "Ithilmar", position: "Elf Lineman" },
        { number: 2, name: "Aenarion", position: "Elf Lineman" },
        { number: 3, name: "Belannaer", position: "Elf Lineman" },
        { number: 4, name: "Caledor", position: "Elf Lineman" },
      ],
    },
    away: {
      name: "Gouged Eye",
      roster: "Orc",
      rerolls: 2,
      journeymen: false,
      players: [
        { number: 1, name: "Grishnak", position: "Orc Lineman" },
        { number: 2, name: "Ugluk", position: "Orc Lineman" },
        { number: 3, name: "Snaga", position: "Orc Lineman" },
      ],
    },
    seed: 17,
    actions: toFirstTurn({
      home: { 1: { x: 12, y: 8 }, 2: { x: 12, y: 5 }, 3: { x: 12, y: 10 }, 4: { x: 10, y: 8 } },
      away: { 1: { x: 13, y: 8 }, 2: { x: 13, y: 5 }, 3: { x: 13, y: 10 } },
      ball: { x: 12, y: 8 },
    }),
  },
  {
    id: "breathe-fire",
    title: "Breathe Fire: a fiery attack instead of a block",
    instructions: [
      "Home's first turn: Zharrak (#1, Flamesmith) stands on the line of scrimmage, next to the orc lineman Grishnak (#1) and the Troll (#4, ST 5).",
      "Declare a Block with Zharrak and click \"Breathe fire on Grishnak\": a D6 needing 2+. A natural 6 knocks him down (armour and injury without modifiers), 4+ places him prone, 2 or 3 does nothing; anything but a 6 can be re-rolled with a team re-roll.",
      "Undo and breathe fire on the Troll instead: -1 to the roll against ST 5 or more, so a 2 knocks Zharrak down, a turnover (enter it with \"Physical dice\").",
      "Undo and declare a Blitz on Snaga (#3) with Drazhoath (#2, Flamesmith): move next to him, then breathe fire; it costs a square and ends the action.",
    ],
    home: {
      name: "Zharr-Naggrund Furnace",
      roster: "Chaos Dwarf",
      rerolls: 2,
      journeymen: false,
      players: [
        { number: 1, name: "Zharrak", position: "Flamesmith" },
        { number: 2, name: "Drazhoath", position: "Flamesmith" },
        { number: 3, name: "Gorbad", position: "Hobgoblin Lineman" },
        { number: 4, name: "Snikkit", position: "Hobgoblin Lineman" },
        { number: 5, name: "Rykarth", position: "Hobgoblin Lineman" },
      ],
    },
    away: {
      name: "Gouged Eye",
      roster: "Orc",
      rerolls: 2,
      journeymen: false,
      players: [
        { number: 1, name: "Grishnak", position: "Orc Lineman" },
        { number: 2, name: "Ugluk", position: "Orc Lineman" },
        { number: 3, name: "Snaga", position: "Orc Lineman" },
        { number: 4, name: "Troll", position: "Troll" },
      ],
    },
    seed: 23,
    actions: toFirstTurn({
      home: { 1: { x: 12, y: 7 }, 2: { x: 10, y: 11 }, 3: { x: 12, y: 4 }, 4: { x: 12, y: 10 }, 5: { x: 5, y: 7 } },
      away: { 1: { x: 13, y: 7 }, 2: { x: 13, y: 4 }, 3: { x: 14, y: 11 }, 4: { x: 13, y: 8 } },
      ball: { x: 5, y: 7 },
    }),
  },
  {
    id: "dump-off",
    title: "Dump-off: a Quick pass before being hit",
    instructions: [
      "Away's first turn: Naggaroth runner Kaelith (#1, Dump-off) holds the ball on the line of scrimmage, next to Grishnak (#1).",
      "Declare a Block with Grishnak on Kaelith: before the block dice, the home coach is asked whether to use Dump-off.",
      "Use it, click \"Throw…\" and pick a Quick square, e.g. Malus (#2): only Quick passes are offered, there is no team re-roll and no On the Ball move. Whatever happens to the ball, nobody's turn ends, and Grishnak's block goes on.",
      "Undo and decline: the block goes on with Kaelith still holding the ball.",
      "Undo and declare a Blitz on Kaelith with Ugluk (#2) instead: Dump-off is offered right away, before Ugluk moves, and not again at the block.",
    ],
    home: {
      name: "Naggaroth Nightblades",
      roster: "Dark Elf",
      rerolls: 2,
      journeymen: false,
      players: [
        { number: 1, name: "Kaelith", position: "Dark Elf Runner" },
        { number: 2, name: "Malus", position: "Dark Elf Lineman" },
        { number: 3, name: "Lokhir", position: "Dark Elf Lineman" },
        { number: 4, name: "Rakarth", position: "Dark Elf Lineman" },
      ],
    },
    away: {
      name: "Gouged Eye",
      roster: "Orc",
      rerolls: 2,
      journeymen: false,
      players: [
        { number: 1, name: "Grishnak", position: "Orc Lineman" },
        { number: 2, name: "Ugluk", position: "Orc Lineman" },
        { number: 3, name: "Snaga", position: "Orc Lineman" },
      ],
    },
    seed: 29,
    actions: [
      ...toFirstTurn({
        home: { 1: { x: 12, y: 7 }, 2: { x: 10, y: 6 }, 3: { x: 12, y: 4 }, 4: { x: 12, y: 10 } },
        away: { 1: { x: 13, y: 7 }, 2: { x: 13, y: 4 }, 3: { x: 13, y: 10 } },
        ball: { x: 12, y: 7 },
      }),
      { type: "END_TURN" },
    ],
  },
  {
    id: "punt",
    title: "Punt: kick the ball downfield",
    instructions: [
      "Home's first turn: Kaelith (#1, Dark Elf Runner, Punt) holds the ball near the top sideline.",
      "Declare a Punt with Kaelith, click \"Punt…\" and the square east of her: a D6 on the throw-in template facing east (1-2 north-east, 3-4 east, 5-6 south-east), then D6 squares. A team re-roll may be used on each roll.",
      "Enter 3 and 4 with \"Physical dice\": the ball comes down on Malus (#2), who may catch it. An empty square makes it bounce; neither is a turnover. Off the pitch, it is thrown in and the turn ends.",
      "Undo and move Kaelith two squares north onto the sideline first: \"Punt into the crowd\" is offered (a throw-in from her square, and a turnover).",
    ],
    home: {
      name: "Naggaroth Nightblades",
      roster: "Dark Elf",
      rerolls: 2,
      journeymen: false,
      players: [
        { number: 1, name: "Kaelith", position: "Dark Elf Runner" },
        { number: 2, name: "Malus", position: "Dark Elf Lineman" },
        { number: 3, name: "Lokhir", position: "Dark Elf Lineman" },
        { number: 4, name: "Rakarth", position: "Dark Elf Lineman" },
        { number: 5, name: "Tullaris", position: "Dark Elf Lineman" },
      ],
    },
    away: {
      name: "Gouged Eye",
      roster: "Orc",
      rerolls: 2,
      journeymen: false,
      players: [
        { number: 1, name: "Grishnak", position: "Orc Lineman" },
        { number: 2, name: "Ugluk", position: "Orc Lineman" },
        { number: 3, name: "Snaga", position: "Orc Lineman" },
      ],
    },
    seed: 31,
    actions: toFirstTurn({
      home: { 1: { x: 5, y: 2 }, 2: { x: 9, y: 2 }, 3: { x: 12, y: 6 }, 4: { x: 12, y: 7 }, 5: { x: 12, y: 8 } },
      away: { 1: { x: 13, y: 6 }, 2: { x: 13, y: 7 }, 3: { x: 13, y: 8 } },
      ball: { x: 5, y: 2 },
    }),
  },
  {
    id: "kick",
    title: "Kick: a shorter kick-off deviation, and re-rolled punts",
    instructions: [
      "Away kicks off: Gorbad (#4, Kick) is the kicking player, so the away coach is asked whether to use Kick before the deviation roll. Use it: the ball deviates a D3 instead of a D6.",
      "Enter 5 and 2 with \"Physical dice\" (south, two squares): the ball comes down on Kaelith. Roll any kick-off event, then 6 for the catch.",
      "Home's turn: declare a Punt with Kaelith (#1, Punt, Kick) and click the square east of her. After the direction roll, and again after the distance roll, \"Re-roll (Kick)\" replaces the team re-roll: none is spent.",
      "Undo back to the kick-off and decline Kick: the deviation is a D6 again.",
    ],
    home: {
      name: "Naggaroth Nightblades",
      roster: "Dark Elf",
      rerolls: 2,
      journeymen: false,
      players: [
        { number: 1, name: "Kaelith", position: "Dark Elf Runner", skills: ["Kick"] },
        { number: 2, name: "Malus", position: "Dark Elf Lineman" },
        { number: 3, name: "Lokhir", position: "Dark Elf Lineman" },
        { number: 4, name: "Rakarth", position: "Dark Elf Lineman" },
        { number: 5, name: "Tullaris", position: "Dark Elf Lineman" },
      ],
    },
    away: {
      name: "Gouged Eye",
      roster: "Orc",
      rerolls: 2,
      journeymen: false,
      players: [
        { number: 1, name: "Grishnak", position: "Orc Lineman" },
        { number: 2, name: "Ugluk", position: "Orc Lineman" },
        { number: 3, name: "Snaga", position: "Orc Lineman" },
        { number: 4, name: "Gorbad", position: "Orc Lineman", skills: ["Kick"] },
      ],
    },
    seed: 41,
    actions: toKickoff(
      {
        home: { 1: { x: 5, y: 3 }, 2: { x: 9, y: 3 }, 3: { x: 12, y: 6 }, 4: { x: 12, y: 7 }, 5: { x: 12, y: 8 } },
        away: { 1: { x: 13, y: 6 }, 2: { x: 13, y: 7 }, 3: { x: 13, y: 8 }, 4: { x: 16, y: 7 } },
      },
      { x: 5, y: 1 },
    ),
  },
  {
    id: "leader",
    title: "Leader: an extra team re-roll while the Leader is on the pitch",
    instructions: [
      "Home's first turn: Lothar (#1, Thrower, Leader) was on the pitch at the kick-off, so the home banner shows \"Re-rolls 2 +1 Leader\".",
      "Move Hans (#2, on the line of scrimmage) one square west, away from the orc: enter 1 for the dodge. The re-roll offer counts 3 left.",
      "Use it: the Leader re-roll goes first (the log shows Leader), so the banner drops \"+1 Leader\" and the 2 team re-rolls are untouched.",
      "The Leader re-roll stays while Lothar is on the pitch, even prone or stunned; knocked out or injured, it is not available until he comes back. A new one comes each half.",
    ],
    home: {
      name: "Altdorf Pros",
      roster: "Human",
      rerolls: 2,
      journeymen: false,
      players: [
        { number: 1, name: "Lothar", position: "Human Thrower", skills: ["Leader"] },
        { number: 2, name: "Hans", position: "Human Lineman" },
        { number: 3, name: "Otto", position: "Human Lineman" },
        { number: 4, name: "Gunther", position: "Human Lineman" },
      ],
    },
    away: {
      name: "Gouged Eye",
      roster: "Orc",
      rerolls: 2,
      journeymen: false,
      players: [
        { number: 1, name: "Grishnak", position: "Orc Lineman" },
        { number: 2, name: "Ugluk", position: "Orc Lineman" },
        { number: 3, name: "Snaga", position: "Orc Lineman" },
      ],
    },
    seed: 43,
    actions: toFirstTurn({
      home: { 1: { x: 7, y: 7 }, 2: { x: 12, y: 7 }, 3: { x: 12, y: 5 }, 4: { x: 12, y: 9 } },
      away: { 1: { x: 13, y: 5 }, 2: { x: 13, y: 7 }, 3: { x: 13, y: 9 } },
      ball: { x: 7, y: 7 },
    }),
  },
  {
    id: "dirty-tricks",
    title: "Lone Fouler, Quick Foul and Pile Driver",
    instructions: [
      "Home's first turn: Otto (#3) has just knocked Snaga (#3) down, prone at the bottom of the line.",
      "Foul Snaga with Klaus (#2, Lone Fouler, Quick Foul): move him next to Snaga first. Nobody assists, so when the armour holds (e.g. 2 and 3), Klaus may re-roll it with Lone Fouler. Avoid doubles, or the referee spots him.",
      "After the foul, Klaus keeps moving with the squares he has left (Quick Foul), but cannot foul again.",
      "Then block Grishnak (#1) with Dieter (#1, Pile Driver) and knock him down, following up: Pile Driver offers a free foul on him, then Dieter is placed prone. It is not the team's Foul action, and not a turnover unless Dieter holds the ball.",
    ],
    home: {
      name: "Altdorf Pros",
      roster: "Human",
      rerolls: 2,
      journeymen: false,
      players: [
        { number: 1, name: "Dieter", position: "Human Lineman", skills: ["Pile Driver"] },
        { number: 2, name: "Klaus", position: "Human Lineman", skills: ["Lone Fouler", "Quick Foul"] },
        { number: 3, name: "Otto", position: "Human Lineman" },
        { number: 4, name: "Gunther", position: "Human Lineman" },
      ],
    },
    away: {
      name: "Gouged Eye",
      roster: "Orc",
      rerolls: 2,
      journeymen: false,
      players: [
        { number: 1, name: "Grishnak", position: "Orc Lineman" },
        { number: 2, name: "Ugluk", position: "Orc Lineman" },
        { number: 3, name: "Snaga", position: "Orc Lineman" },
      ],
    },
    seed: 47,
    actions: [
      ...toFirstTurn({
        home: { 1: { x: 12, y: 7 }, 2: { x: 10, y: 12 }, 3: { x: 12, y: 10 }, 4: { x: 12, y: 4 } },
        away: { 1: { x: 13, y: 7 }, 2: { x: 13, y: 4 }, 3: { x: 13, y: 10 } },
        ball: { x: 6, y: 7 },
      }),
      ...knockBack("home-3", "away-3", { x: 14, y: 10 }),
    ],
  },
  {
    id: "monstrous-mouth",
    title: "Monstrous Mouth: chomp an opponent in place",
    instructions: [
      "Home's first turn. Declare a Block with Wolfgang (#1, Blitzer, Monstrous Mouth) and click \"Chomp Ugluk\" instead of blocking: a D6, 3+ (a team re-roll is offered on a failure).",
      "Ugluk is now chomped. Block him with Hans (#2): a Push does not move him (the log shows Monstrous Mouth), and a knock-down happens where he stands.",
      "End the turn: in the orcs' turn, Ugluk cannot move while Wolfgang stays next to him with a tackle zone, but he may still block. If Wolfgang is knocked down (or moves away), the chomp is over for good.",
      "In the orcs' turn, Gorbag (#4, Strip Ball) may blitz Wolfgang, who holds the ball: a Push does not strip it, as Strip Ball does not work against Monstrous Mouth.",
    ],
    home: {
      name: "Altdorf Pros",
      roster: "Human",
      rerolls: 2,
      journeymen: false,
      players: [
        { number: 1, name: "Wolfgang", position: "Human Blitzer", skills: ["Monstrous Mouth"] },
        { number: 2, name: "Hans", position: "Human Lineman" },
        { number: 3, name: "Otto", position: "Human Lineman" },
      ],
    },
    away: {
      name: "Gouged Eye",
      roster: "Orc",
      rerolls: 2,
      journeymen: false,
      players: [
        { number: 1, name: "Grishnak", position: "Orc Lineman" },
        { number: 2, name: "Ugluk", position: "Orc Lineman" },
        { number: 3, name: "Snaga", position: "Orc Lineman" },
        { number: 4, name: "Gorbag", position: "Orc Lineman", skills: ["Strip Ball"] },
      ],
    },
    seed: 53,
    actions: toFirstTurn({
      home: { 1: { x: 12, y: 7 }, 2: { x: 12, y: 6 }, 3: { x: 12, y: 10 } },
      away: { 1: { x: 13, y: 4 }, 2: { x: 13, y: 7 }, 3: { x: 13, y: 10 }, 4: { x: 14, y: 8 } },
      ball: { x: 12, y: 7 },
    }),
  },
  {
    id: "saboteur",
    title: "Saboteur: a Looney's weapon goes off when knocked down",
    instructions: [
      "Home's first turn. Block Snikkit (#1, Looney, Saboteur) with Hans (#1): two dice, you choose. Enter 6 and 6 and push him back.",
      "Before the armour roll, the away coach may use Saboteur: a D6, 4+. Snikkit is then Knocked Out without an armour roll, and Hans is knocked down too (an armour roll without modifiers). It is no turnover: Hans did not hold the ball.",
      "Undo and roll 1 to 3 for Saboteur, or decline it: Snikkit rolls armour as usual.",
      "On Both Down (2 and 2), Hans falls anyway, but if the weapon goes off his fall is no turnover either.",
    ],
    home: {
      name: "Altdorf Pros",
      roster: "Human",
      rerolls: 2,
      journeymen: false,
      players: [
        { number: 1, name: "Hans", position: "Human Lineman" },
        { number: 2, name: "Otto", position: "Human Lineman" },
        { number: 3, name: "Gunther", position: "Human Lineman" },
      ],
    },
    away: {
      name: "Grotty Gits",
      roster: "Goblin",
      rerolls: 2,
      journeymen: false,
      players: [
        { number: 1, name: "Snikkit", position: "Looney", skills: ["Saboteur"] },
        { number: 2, name: "Nobbla", position: "Goblin Lineman" },
        { number: 3, name: "Grotsnik", position: "Goblin Lineman" },
      ],
    },
    seed: 59,
    actions: toFirstTurn({
      home: { 1: { x: 12, y: 7 }, 2: { x: 12, y: 4 }, 3: { x: 12, y: 10 } },
      away: { 1: { x: 13, y: 7 }, 2: { x: 13, y: 4 }, 3: { x: 13, y: 10 } },
      ball: { x: 6, y: 7 },
    }),
  },
  {
    id: "multiple-block",
    title: "Multiple Block: two blocks at once",
    instructions: [
      "Home's first turn. Declare a Block with Grumbag (#1, Big Un Blocker, Multiple Block, ST 4) and click \"Multiple Block: Snotty and Nobbla\": the two goblins on either side of the one in front of him.",
      "Each block is at ST 4 - 2 = 2 against ST 2, the goblins do not assist each other, and Snaga marks Gitsnik: one die each. The first block is rolled and its die chosen (a team re-roll is possible), then the second; only then are both resolved, in that order.",
      "There is no follow-up, and nobody is pushed into a square where a target stood: undo and block Snotty and Gitsnik (#3, Sidestep, in front of Grumbag). Once Snotty is pushed away, Gitsnik cannot sidestep into the square Snotty left.",
      "Try a Skull on the first block: Grumbag goes down, but the second block still resolves.",
    ],
    home: {
      name: "Gouged Eye",
      roster: "Orc",
      rerolls: 2,
      journeymen: false,
      players: [
        { number: 1, name: "Grumbag", position: "Big Un Blocker", skills: ["Multiple Block"] },
        { number: 2, name: "Ugluk", position: "Orc Lineman" },
        { number: 3, name: "Snaga", position: "Orc Lineman" },
      ],
    },
    away: {
      name: "Grotty Gits",
      roster: "Goblin",
      rerolls: 2,
      journeymen: false,
      players: [
        { number: 1, name: "Snotty", position: "Goblin Lineman" },
        { number: 2, name: "Nobbla", position: "Goblin Lineman" },
        { number: 3, name: "Gitsnik", position: "Goblin Lineman", skills: ["Sidestep"] },
      ],
    },
    seed: 61,
    actions: toFirstTurn({
      home: { 1: { x: 12, y: 7 }, 2: { x: 12, y: 4 }, 3: { x: 12, y: 8 } },
      away: { 1: { x: 13, y: 6 }, 2: { x: 13, y: 8 }, 3: { x: 13, y: 7 } },
      ball: { x: 6, y: 7 },
    }),
  },
  {
    id: "hail-mary-pass",
    title: "Hail Mary Pass: throw the ball anywhere",
    instructions: [
      "Home's first turn: Ithilmar (#1, Elf Thrower, Hail Mary Pass) holds the ball deep in his half. Declare a Pass with him.",
      "Click \"Hail Mary Pass…\", then any square, e.g. next to Aenarion (#2) in the opposing half: a roll counted as a Long Bomb (5+ avoids a fumble). Even a 6 scatters the ball three times from the target, and the orc under the path cannot intercept.",
      "Enter 4 or less with \"Physical dice\": a fumble, which a team re-roll may save.",
      "Undo and click \"Throw…\" instead: the usual range overlay is still there.",
    ],
    home: {
      name: "Elven Tricksters",
      roster: "Elven Union",
      rerolls: 2,
      journeymen: false,
      players: [
        { number: 1, name: "Ithilmar", position: "Elf Thrower" },
        { number: 2, name: "Aenarion", position: "Elf Catcher" },
        { number: 3, name: "Belannaer", position: "Elf Lineman" },
        { number: 4, name: "Caledor", position: "Elf Lineman" },
        { number: 5, name: "Eltharion", position: "Elf Lineman" },
      ],
    },
    away: {
      name: "Gouged Eye",
      roster: "Orc",
      rerolls: 2,
      journeymen: false,
      players: [
        { number: 1, name: "Grishnak", position: "Orc Lineman" },
        { number: 2, name: "Ugluk", position: "Orc Lineman" },
        { number: 3, name: "Snaga", position: "Orc Lineman" },
        { number: 4, name: "Gorbag", position: "Orc Lineman" },
      ],
    },
    seed: 37,
    actions: toFirstTurn({
      home: { 1: { x: 3, y: 7 }, 2: { x: 11, y: 2 }, 3: { x: 12, y: 6 }, 4: { x: 12, y: 7 }, 5: { x: 12, y: 8 } },
      away: { 1: { x: 13, y: 6 }, 2: { x: 13, y: 7 }, 3: { x: 13, y: 8 }, 4: { x: 16, y: 7 } },
      ball: { x: 3, y: 7 },
    }),
  },
  {
    id: "trickster",
    title: "Trickster: slip next to the attacker before the hit",
    instructions: [
      "Away's first turn: the Gnome Illusionist Fizzwick (#1, Trickster) holds the ball on the line of scrimmage, next to Grishnak (#1).",
      "Declare a Block with Grishnak on Fizzwick: before the dice, the home coach may click a free square next to Grishnak to move Fizzwick there, ball included, or click \"Stay\".",
      "Move him behind Grishnak, e.g. (14,7): the block dice are worked out again from the new square, and a push now sends him further into the orcs' half, away from his team-mates.",
      "Undo and let Ugluk (#2) Blitz him instead: Trickster is offered once Ugluk is next to him, before the dice.",
    ],
    home: {
      name: "Glimmerwood Tricksters",
      roster: "Gnome",
      rerolls: 2,
      journeymen: false,
      players: [
        { number: 1, name: "Fizzwick", position: "Gnome Illusionist" },
        { number: 2, name: "Tumblewort", position: "Gnome Lineman" },
        { number: 3, name: "Pipkin", position: "Gnome Lineman" },
        { number: 4, name: "Bramble", position: "Gnome Lineman" },
      ],
    },
    away: {
      name: "Gouged Eye",
      roster: "Orc",
      rerolls: 2,
      journeymen: false,
      players: [
        { number: 1, name: "Grishnak", position: "Orc Lineman" },
        { number: 2, name: "Ugluk", position: "Orc Lineman" },
        { number: 3, name: "Snaga", position: "Orc Lineman" },
      ],
    },
    seed: 41,
    actions: [
      ...toFirstTurn({
        home: { 1: { x: 12, y: 7 }, 2: { x: 12, y: 6 }, 3: { x: 12, y: 8 }, 4: { x: 8, y: 7 } },
        away: { 1: { x: 13, y: 7 }, 2: { x: 13, y: 4 }, 3: { x: 13, y: 10 } },
        ball: { x: 12, y: 7 },
      }),
      { type: "END_TURN" },
    ],
  },
  {
    id: "tentacles",
    title: "Tentacles: hold a player dodging away",
    instructions: [
      "Home's first turn: Wilhelm (#1, Human Lineman) holds the ball on the line of scrimmage, next to the Rotspawn Gloop (#1, ST 5, Tentacles).",
      "Declare a Move with Wilhelm and step back west: before the dodge, the away coach may pick Gloop to try to hold him: a D6 + 5 - 3 needing 6, so 4+.",
      "On a success Wilhelm stays where he is and his action ends, but it is no turnover: move another player. On a failure, Wilhelm rolls his dodge as usual.",
      "Undo and move Klaus (#4, Human Blitzer) away from the Rotter Bilge (#3) instead: no Tentacles there, just the dodge.",
    ],
    home: {
      name: "Altdorf Pros",
      roster: "Human",
      rerolls: 2,
      journeymen: false,
      players: [
        { number: 1, name: "Wilhelm", position: "Human Lineman" },
        { number: 2, name: "Hans", position: "Human Lineman" },
        { number: 3, name: "Otto", position: "Human Lineman" },
        { number: 4, name: "Klaus", position: "Human Blitzer" },
      ],
    },
    away: {
      name: "Rotting Hope",
      roster: "Nurgle",
      rerolls: 2,
      journeymen: false,
      players: [
        { number: 1, name: "Gloop", position: "Rotspawn" },
        { number: 2, name: "Mucus", position: "Rotter Lineman" },
        { number: 3, name: "Bilge", position: "Rotter Lineman" },
      ],
    },
    seed: 43,
    actions: toFirstTurn({
      home: { 1: { x: 12, y: 7 }, 2: { x: 12, y: 4 }, 3: { x: 12, y: 10 }, 4: { x: 12, y: 11 } },
      away: { 1: { x: 13, y: 7 }, 2: { x: 13, y: 4 }, 3: { x: 13, y: 10 } },
      ball: { x: 12, y: 7 },
    }),
  },
  {
    id: "give-and-go",
    title: "Give and Go: keep moving after a quick pass or hand-off",
    instructions: [
      "Home's first turn: Lord Edmund (#1, Imperial Thrower, Give and Go) holds the ball, with Sir Roland (#2) two squares away.",
      "Declare a Pass with Edmund, click \"Throw…\" and throw a Quick pass to Roland. Once he has caught it, Edmund may keep moving with his six squares, but cannot throw again.",
      "Undo and declare a Hand-off instead: after the hand-off, Edmund moves on the same way.",
      "Undo and throw a Short pass to Sir Gareth (#3): the action ends after the throw, as usual.",
    ],
    home: {
      name: "Bögenhafen Barons",
      roster: "Imperial Nobility",
      rerolls: 2,
      journeymen: false,
      players: [
        { number: 1, name: "Lord Edmund", position: "Imperial Thrower" },
        { number: 2, name: "Sir Roland", position: "Noble Blitzer" },
        { number: 3, name: "Sir Gareth", position: "Noble Blitzer" },
        { number: 4, name: "Piet", position: "Imperial Retainer" },
        { number: 5, name: "Jan", position: "Imperial Retainer" },
        { number: 6, name: "Klaas", position: "Imperial Retainer" },
      ],
    },
    away: {
      name: "Gouged Eye",
      roster: "Orc",
      rerolls: 2,
      journeymen: false,
      players: [
        { number: 1, name: "Grishnak", position: "Orc Lineman" },
        { number: 2, name: "Ugluk", position: "Orc Lineman" },
        { number: 3, name: "Snaga", position: "Orc Lineman" },
      ],
    },
    seed: 47,
    actions: toFirstTurn({
      home: { 1: { x: 5, y: 7 }, 2: { x: 7, y: 7 }, 3: { x: 9, y: 11 }, 4: { x: 12, y: 6 }, 5: { x: 12, y: 7 }, 6: { x: 12, y: 8 } },
      away: { 1: { x: 13, y: 6 }, 2: { x: 13, y: 7 }, 3: { x: 13, y: 8 } },
      ball: { x: 5, y: 7 },
    }),
  },
  {
    id: "kick-team-mate",
    title: "Kick Team-mate: kick a team-mate downfield",
    instructions: [
      "Home's first turn: the Ogre Runt Punter Grunk (#1, Kick Team-mate) stands next to the Gnoblar Snit (#2, Right Stuff), who holds the ball.",
      "Declare a Kick Team-mate with Grunk (roll his Bone Head first), click Snit, then a Quick or Short square to kick him to: the kick is rolled like a Throw Team-mate (PA 4+), then Snit scatters and rolls to land.",
      "Enter a 1 for the kick with \"Physical dice\" and decline the re-roll: a fumbled kick does not scatter. Snit rolls for injury (a Stunned result counts as KO'd) and the ball bounces, a turnover.",
      "Undo: the Ogre Blocker Brug (#3) can still Throw Team-mate the Gnoblar Nix (#4) in the same turn, as it is another action.",
    ],
    home: {
      name: "Gnoblar Kickers",
      roster: "Ogre",
      rerolls: 2,
      journeymen: false,
      players: [
        { number: 1, name: "Grunk", position: "Ogre Runt Punter" },
        { number: 2, name: "Snit", position: "Gnoblar Lineman" },
        { number: 3, name: "Brug", position: "Ogre Blocker" },
        { number: 4, name: "Nix", position: "Gnoblar Lineman" },
        { number: 5, name: "Gob", position: "Gnoblar Lineman" },
        { number: 6, name: "Pip", position: "Gnoblar Lineman" },
        { number: 7, name: "Rok", position: "Gnoblar Lineman" },
      ],
    },
    away: {
      name: "Gouged Eye",
      roster: "Orc",
      rerolls: 2,
      journeymen: false,
      players: [
        { number: 1, name: "Grishnak", position: "Orc Lineman" },
        { number: 2, name: "Ugluk", position: "Orc Lineman" },
        { number: 3, name: "Snaga", position: "Orc Lineman" },
      ],
    },
    seed: 53,
    actions: toFirstTurn({
      home: { 1: { x: 8, y: 7 }, 2: { x: 7, y: 7 }, 3: { x: 8, y: 10 }, 4: { x: 7, y: 10 }, 5: { x: 12, y: 6 }, 6: { x: 12, y: 8 }, 7: { x: 12, y: 7 } },
      away: { 1: { x: 13, y: 6 }, 2: { x: 13, y: 7 }, 3: { x: 13, y: 8 } },
      ball: { x: 7, y: 7 },
    }),
  },
  {
    id: "swoop",
    title: "Swoop: travel in a line instead of scattering",
    instructions: [
      "Home's first turn: the Trained Troll Grub (#1) stands next to the Doom Diver Zippy (#2, Right Stuff, Swoop). Declare a Throw Team-mate with Grub (Really Stupid, then Always Hungry first).",
      "Click Zippy, then a Quick or Short square. After a throw that is not fumbled, the board asks for Swoop: click a square next to the target to face the throw-in template that way, or \"Scatter as usual\".",
      "Swooping: a D6 gives the direction (1-2 and 5-6 veer off to the sides), a D6 the number of squares travelled in a straight line from the target; each may take a team re-roll. Off the pitch, the crowd gets Zippy.",
      "A Doom Diver who swooped may re-roll a failed landing (enter a 1 to see it).",
    ],
    home: {
      name: "Grotty Gits",
      roster: "Goblin",
      rerolls: 2,
      journeymen: false,
      players: [
        { number: 1, name: "Grub", position: "Trained Troll" },
        { number: 2, name: "Zippy", position: "Doom Diver" },
        { number: 3, name: "Snotling", position: "Goblin Lineman" },
        { number: 4, name: "Nobbla", position: "Goblin Lineman" },
        { number: 5, name: "Grotsnik", position: "Goblin Lineman" },
      ],
    },
    away: {
      name: "Gouged Eye",
      roster: "Orc",
      rerolls: 2,
      journeymen: false,
      players: [
        { number: 1, name: "Grishnak", position: "Orc Lineman" },
        { number: 2, name: "Ugluk", position: "Orc Lineman" },
        { number: 3, name: "Snaga", position: "Orc Lineman" },
      ],
    },
    seed: 59,
    actions: toFirstTurn({
      home: { 1: { x: 8, y: 7 }, 2: { x: 8, y: 8 }, 3: { x: 12, y: 6 }, 4: { x: 12, y: 7 }, 5: { x: 12, y: 8 } },
      away: { 1: { x: 13, y: 6 }, 2: { x: 13, y: 7 }, 3: { x: 13, y: 8 } },
      ball: { x: 5, y: 7 },
    }),
  },
  {
    id: "chainsaw",
    title: "Chainsaw: a chainsaw attack instead of a block or in a foul",
    instructions: [
      "Home's first turn: the Looney Whirla (#1, Chainsaw) stands on the line of scrimmage next to Grishnak (#1); the Trained Troll Grub (#2) has already knocked Snaga (#3) down.",
      "Declare a Block with Whirla and click \"Chainsaw Grishnak\": a D6, 2+, then Grishnak rolls armour with +3 and is placed prone (and injured) if it breaks. No turnover either way.",
      "Enter a 1 with \"Physical dice\" and decline the re-roll: the chainsaw kicks back, Whirla is knocked down with +3 to his own armour roll, and the turn is over.",
      "Undo and declare a Foul with Whirla instead: step next to Snaga (a dodge) and foul her. He may use his chainsaw, rolling for kick-back first, for +3 to the armour roll.",
    ],
    home: {
      name: "Grotty Gits",
      roster: "Goblin",
      rerolls: 2,
      journeymen: false,
      players: [
        { number: 1, name: "Whirla", position: "Looney" },
        { number: 2, name: "Grub", position: "Trained Troll" },
        { number: 3, name: "Snotling", position: "Goblin Lineman" },
        { number: 4, name: "Nobbla", position: "Goblin Lineman" },
      ],
    },
    away: {
      name: "Gouged Eye",
      roster: "Orc",
      rerolls: 2,
      journeymen: false,
      players: [
        { number: 1, name: "Grishnak", position: "Orc Lineman" },
        { number: 2, name: "Ugluk", position: "Orc Lineman" },
        { number: 3, name: "Snaga", position: "Orc Lineman" },
      ],
    },
    seed: 61,
    actions: [
      ...toFirstTurn({
        home: { 1: { x: 12, y: 7 }, 2: { x: 12, y: 8 }, 3: { x: 12, y: 5 }, 4: { x: 5, y: 7 } },
        away: { 1: { x: 13, y: 7 }, 2: { x: 13, y: 5 }, 3: { x: 13, y: 8 } },
        ball: { x: 5, y: 7 },
      }),
      // Grub (Really Stupid, helped by Whirla: 2+) blocks Snaga with two dice and pushes her down to (14,9).
      { type: "START_ACTION", playerId: "home-2", action: "block" },
      roll(6),
      { type: "BLOCK", targetId: "away-3" },
      roll(6, 6),
      { type: "CHOOSE_BLOCK_DIE", index: 0 },
      { type: "PUSH", square: { x: 14, y: 9 } },
      { type: "FOLLOW_UP", follow: false },
      roll(1, 1),
    ],
  },
  {
    id: "ball-and-chain",
    title: "Ball & Chain: a random move that blocks whoever is in the way",
    instructions: [
      "Home's first turn: the Fanatic Spinna (#1, Ball & Chain, ST 7) stands behind the line of scrimmage. He can only take a Move action.",
      "Each step, click one of the four squares next to him: a D6 on the throw-in template facing that way picks where he goes (1-2 and 5-6 veer to the sides). No dodges, whatever the tackle zones.",
      "Heading east, he will hit the Goblin on the line or the orcs: a block from where he stands, with a forced follow-up. A team-mate is blocked too (no assists, your choice of die), and knocking them down is a turnover.",
      "A player who is already down is not blocked: running into them pushes them back and they roll armour, without block dice. Spinna has MA 3: from the fourth square on, each step needs a Rush, and if he goes down his armour breaks without a roll.",
    ],
    home: {
      name: "Grotty Gits",
      roster: "Goblin",
      rerolls: 2,
      journeymen: false,
      players: [
        { number: 1, name: "Spinna", position: "Fanatic" },
        { number: 2, name: "Snotling", position: "Goblin Lineman" },
        { number: 3, name: "Nobbla", position: "Goblin Lineman" },
        { number: 4, name: "Grotsnik", position: "Goblin Lineman" },
        { number: 5, name: "Wazzock", position: "Goblin Lineman" },
      ],
    },
    away: {
      name: "Gouged Eye",
      roster: "Orc",
      rerolls: 2,
      journeymen: false,
      players: [
        { number: 1, name: "Grishnak", position: "Orc Lineman" },
        { number: 2, name: "Ugluk", position: "Orc Lineman" },
        { number: 3, name: "Snaga", position: "Orc Lineman" },
      ],
    },
    seed: 67,
    actions: [
      ...toFirstTurn({
        home: { 1: { x: 10, y: 7 }, 2: { x: 12, y: 7 }, 3: { x: 12, y: 5 }, 4: { x: 12, y: 9 }, 5: { x: 4, y: 7 } },
        away: { 1: { x: 13, y: 6 }, 2: { x: 13, y: 7 }, 3: { x: 13, y: 9 } },
        ball: { x: 4, y: 7 },
      }),
    ],
  },
  {
    id: "inducements",
    title: "Inducements: Team Mascot and Weather Mage",
    instructions: [
      "Home's first turn. The home team bought a Team Mascot, a Weather Mage and two Bribes (the team file's inducements in src/scenarios.ts).",
      "Before anyone acts, click \"Weather Mage\": a 2D6 on the weather table, then apply a modifier of -2 to +2 (or none); each button shows the total and the weather it gives.",
      "Move Wilhelm (#1) away from the orc and fail the dodge with \"Physical dice\": the re-roll offers \"Team Mascot (4+)\", which spends no team re-roll; on a failure a team re-roll is used instead.",
    ],
    home: {
      name: "Altdorf Pros",
      roster: "Human",
      rerolls: 2,
      journeymen: false,
      inducements: { teamMascot: 1, weatherMage: 1, bribes: 2 },
      players: [
        { number: 1, name: "Wilhelm", position: "Human Lineman" },
        { number: 2, name: "Hans", position: "Human Lineman" },
        { number: 3, name: "Otto", position: "Human Lineman" },
        { number: 4, name: "Klaus", position: "Human Blitzer" },
      ],
    },
    away: {
      name: "Gouged Eye",
      roster: "Orc",
      rerolls: 2,
      journeymen: false,
      players: [
        { number: 1, name: "Grishnak", position: "Orc Lineman" },
        { number: 2, name: "Ugluk", position: "Orc Lineman" },
        { number: 3, name: "Snaga", position: "Orc Lineman" },
      ],
    },
    seed: 71,
    actions: toFirstTurn({
      home: { 1: { x: 12, y: 7 }, 2: { x: 12, y: 4 }, 3: { x: 12, y: 10 }, 4: { x: 9, y: 7 } },
      away: { 1: { x: 13, y: 7 }, 2: { x: 13, y: 4 }, 3: { x: 13, y: 10 } },
      ball: { x: 9, y: 7 },
    }),
  },
  {
    id: "getting-even",
    title: "Getting Even: Hatred after a bad injury",
    instructions: [
      "Home's first turn. Mortis (#4) is a Wight Blitzer: keywords human, skeleton, undead (and blitzer, a role that does not count).",
      "Click \"Physical dice\", then declare a Block by Mortis on Ugluk (#4, at (13,5)): enter a 6 (Pow), push him back, then armour 6+6, injury 6+6, and a casualty roll of 9 to 14 on the D16 (Seriously Hurt, Serious Injury or Lasting Injury; any D6).",
      "Ugluk gets even: the orcs' coach picks human, skeleton or undead, then a D6: on 4+ Ugluk gains Hatred against it (no team re-roll: it is not the orcs' turn). The log says so; teamAfterGame writes it into the team file's `hatred`.",
      "A casualty roll of 1-8 (Badly Hurt) or 15-16 (Dead) gives no Getting Even roll.",
    ],
    home: {
      name: "Grave Guard",
      roster: "Shambling Undead",
      rerolls: 2,
      journeymen: false,
      players: [
        { number: 1, name: "Rattle", position: "Skeleton Lineman" },
        { number: 2, name: "Clatter", position: "Skeleton Lineman" },
        { number: 3, name: "Bones", position: "Skeleton Lineman" },
        { number: 4, name: "Mortis", position: "Wight Blitzer" },
        { number: 5, name: "Shuffle", position: "Zombie Lineman" },
      ],
    },
    away: {
      name: "Gouged Eye",
      roster: "Orc",
      rerolls: 2,
      journeymen: false,
      players: [
        { number: 1, name: "Grishnak", position: "Orc Lineman" },
        { number: 2, name: "Snaga", position: "Orc Lineman" },
        { number: 3, name: "Gorbag", position: "Orc Lineman" },
        { number: 4, name: "Ugluk", position: "Orc Lineman" },
      ],
    },
    seed: 83,
    actions: toFirstTurn({
      home: { 1: { x: 12, y: 6 }, 2: { x: 12, y: 7 }, 3: { x: 12, y: 8 }, 4: { x: 12, y: 5 }, 5: { x: 8, y: 7 } },
      away: { 1: { x: 13, y: 6 }, 2: { x: 13, y: 7 }, 3: { x: 13, y: 8 }, 4: { x: 13, y: 5 } },
      ball: { x: 8, y: 7 },
    }),
  },
  {
    id: "masters-of-undeath",
    title: "Masters of Undeath: raise a killed opponent",
    instructions: [
      "Home's first turn. The Grave Guard have the Masters of Undeath special rule (in the team file in src/scenarios.ts).",
      "Click \"Physical dice\", then declare a Block by Mortis (#4) on Wilhelm (#4, at (13,5)): enter a 6 (Pow), push him back, then armour 6+6, injury 6+6, and a casualty roll of 15 or 16 on the D16 (Dead; any D6).",
      "Wilhelm rises again: pick Skeleton Lineman or Zombie Lineman. He joins the home reserves under his own name, and stays in the team file after the game. Only once per game, and not for an opponent of ST 5 or more, or a Stunty one.",
    ],
    home: {
      name: "Grave Guard",
      roster: "Shambling Undead",
      rerolls: 2,
      journeymen: false,
      specialRules: ["Masters of Undeath"],
      players: [
        { number: 1, name: "Rattle", position: "Skeleton Lineman" },
        { number: 2, name: "Clatter", position: "Skeleton Lineman" },
        { number: 3, name: "Bones", position: "Skeleton Lineman" },
        { number: 4, name: "Mortis", position: "Wight Blitzer" },
        { number: 5, name: "Shuffle", position: "Zombie Lineman" },
      ],
    },
    away: {
      name: "Altdorf Pros",
      roster: "Human",
      rerolls: 2,
      journeymen: false,
      players: [
        { number: 1, name: "Hans", position: "Human Lineman" },
        { number: 2, name: "Otto", position: "Human Lineman" },
        { number: 3, name: "Klaus", position: "Human Lineman" },
        { number: 4, name: "Wilhelm", position: "Human Lineman" },
      ],
    },
    seed: 89,
    actions: toFirstTurn({
      home: { 1: { x: 12, y: 6 }, 2: { x: 12, y: 7 }, 3: { x: 12, y: 8 }, 4: { x: 12, y: 5 }, 5: { x: 8, y: 7 } },
      away: { 1: { x: 13, y: 6 }, 2: { x: 13, y: 7 }, 3: { x: 13, y: 8 }, 4: { x: 13, y: 5 } },
      ball: { x: 8, y: 7 },
    }),
  },
  {
    id: "wandering-apothecaries",
    title: "Wandering Apothecaries",
    instructions: [
      "Home's first turn. The Altdorf Pros have no apothecary of their own but bought two Wandering Apothecaries (the team file's inducements in src/scenarios.ts): two apothecary uses for the game.",
      "Click \"Physical dice\", then declare a Block by Ugluk (#4) on Wilhelm (#4, at (13,5)): enter a 6 (Pow), push him back, then armour 6+6 and an injury of 8 or 9 (KO'd) or 10+ (a casualty).",
      "The humans are offered the apothecary: a KO'd player becomes Stunned, a casualty is re-rolled. Do it again with another human: the second Wandering Apothecary is still there; a third injury gets none.",
    ],
    home: {
      name: "Gouged Eye",
      roster: "Orc",
      rerolls: 2,
      journeymen: false,
      players: [
        { number: 1, name: "Grishnak", position: "Orc Lineman" },
        { number: 2, name: "Snaga", position: "Orc Lineman" },
        { number: 3, name: "Gorbag", position: "Orc Lineman" },
        { number: 4, name: "Ugluk", position: "Orc Blitzer" },
        { number: 5, name: "Lugdush", position: "Orc Lineman" },
      ],
    },
    away: {
      name: "Altdorf Pros",
      roster: "Human",
      rerolls: 2,
      journeymen: false,
      inducements: { wanderingApothecaries: 2 },
      players: [
        { number: 1, name: "Hans", position: "Human Lineman" },
        { number: 2, name: "Otto", position: "Human Lineman" },
        { number: 3, name: "Klaus", position: "Human Lineman" },
        { number: 4, name: "Wilhelm", position: "Human Lineman" },
      ],
    },
    seed: 97,
    actions: toFirstTurn({
      home: { 1: { x: 12, y: 6 }, 2: { x: 12, y: 7 }, 3: { x: 12, y: 8 }, 4: { x: 12, y: 5 }, 5: { x: 8, y: 7 } },
      away: { 1: { x: 13, y: 6 }, 2: { x: 13, y: 7 }, 3: { x: 13, y: 8 }, 4: { x: 13, y: 5 } },
      ball: { x: 8, y: 7 },
    }),
  },
  {
    id: "pitch-invasion-fanatic",
    title: "Pitch Invasion and a Ball & Chain player",
    instructions: [
      "The kick-off: the ball has deviated, the kick-off event is next. The Goblins have only three players, their Fanatic Spinna (#1, Ball & Chain) among them.",
      "Click \"Physical dice\" and enter 6 and 6 for the kick-off event: Pitch Invasion. Then 1 for the Goblins, 6 for the Humans and 3 for the D3: all three goblins are hit.",
      "The two Goblin Linemen are stunned; Spinna is placed prone instead, and his armour breaks without a roll: enter his injury roll (a Stunned result is a KO for him).",
    ],
    home: {
      name: "Spinning Stunties",
      roster: "Goblin",
      rerolls: 2,
      journeymen: false,
      players: [
        { number: 1, name: "Spinna", position: "Fanatic" },
        { number: 2, name: "Snik", position: "Goblin Lineman" },
        { number: 3, name: "Grot", position: "Goblin Lineman" },
      ],
    },
    away: {
      name: "Altdorf Pros",
      roster: "Human",
      rerolls: 2,
      journeymen: false,
      players: [
        { number: 1, name: "Hans", position: "Human Lineman" },
        { number: 2, name: "Otto", position: "Human Lineman" },
        { number: 3, name: "Klaus", position: "Human Lineman" },
      ],
    },
    seed: 101,
    actions: [
      ...toKickoff(
        {
          home: { 1: { x: 12, y: 7 }, 2: { x: 12, y: 6 }, 3: { x: 12, y: 8 } },
          away: { 1: { x: 13, y: 7 }, 2: { x: 13, y: 6 }, 3: { x: 13, y: 8 } },
        },
        { x: 5, y: 7 },
      ),
      roll(5, 1), // deviation: one square south
    ],
  },
  {
    id: "wizard",
    title: "Wizard: Fireball and Zap!",
    instructions: [
      "Home's first turn has just ended: Gouged Eye bought a wizard (the team file's inducements in src/scenarios.ts), and may cast one spell per game between two turns of a drive.",
      "Click \"Zap!\", then Klaus (#4), who holds the ball: on a 6, or on 3+ (his ST), he becomes a frog (MA 5, ST 1, AG 2+, AV 5+, Dodge, No Ball...) until the end of the drive and drops the ball.",
      "Or click \"Fireball\", then a highlighted square, e.g. the middle of the lines of scrimmage (12,7): each player in the 3x3 area, orcs included, is knocked down on 4+, with +1 to the armour roll (or to the injury roll if the armour breaks anyway).",
      "\"Keep the wizard for later\" asks again after the next turn. Once cast, the wizard is gone for the game.",
    ],
    home: {
      name: "Altdorf Pros",
      roster: "Human",
      rerolls: 2,
      journeymen: false,
      players: [
        { number: 1, name: "Wilhelm", position: "Human Lineman" },
        { number: 2, name: "Hans", position: "Human Lineman" },
        { number: 3, name: "Otto", position: "Human Lineman" },
        { number: 4, name: "Klaus", position: "Human Blitzer" },
      ],
    },
    away: {
      name: "Gouged Eye",
      roster: "Orc",
      rerolls: 2,
      journeymen: false,
      inducements: { wizard: 1 },
      players: [
        { number: 1, name: "Grishnak", position: "Orc Lineman" },
        { number: 2, name: "Ugluk", position: "Orc Lineman" },
        { number: 3, name: "Snaga", position: "Orc Lineman" },
      ],
    },
    seed: 73,
    actions: [
      ...toFirstTurn({
        home: { 1: { x: 12, y: 7 }, 2: { x: 12, y: 6 }, 3: { x: 12, y: 8 }, 4: { x: 9, y: 7 } },
        away: { 1: { x: 13, y: 7 }, 2: { x: 13, y: 6 }, 3: { x: 13, y: 8 } },
        ball: { x: 9, y: 7 },
      }),
      { type: "END_TURN" },
    ],
  },
  {
    id: "josef-bugman",
    title: "Josef Bugman: Dwarfen Wisdom",
    instructions: [
      "Both teams have set up; the Grudgebearers hired Josef Bugman (the team file's inducements in src/scenarios.ts). The kicking orcs have no Bugman, so the dwarfs are asked about Dwarfen Wisdom, once per game.",
      "Click \"Dwarfen Wisdom\": a D3, then click 1 to that many dwarfs on the pitch and confirm. They go back to the dugout: drag them onto free squares of your half (only they may move), keep 3 on the line of scrimmage, and confirm the setup.",
      "\"Keep it for later\" asks again at the next kick-off. Bugman's XXXXXX also gives +1 to the dwarfs' KO recovery rolls (4+ becomes 3+).",
    ],
    home: {
      name: "Grudgebearers",
      roster: "Dwarf",
      rerolls: 2,
      journeymen: false,
      inducements: { josefBugman: 1 },
      players: [
        { number: 1, name: "Grimbold", position: "Dwarf Blocker Lineman" },
        { number: 2, name: "Thorin", position: "Dwarf Blocker Lineman" },
        { number: 3, name: "Durin", position: "Dwarf Blocker Lineman" },
        { number: 4, name: "Gimbli", position: "Dwarf Runner" },
        { number: 5, name: "Bruni", position: "Dwarf Blitzer" },
      ],
    },
    away: {
      name: "Gouged Eye",
      roster: "Orc",
      rerolls: 2,
      journeymen: false,
      players: [
        { number: 1, name: "Grishnak", position: "Orc Lineman" },
        { number: 2, name: "Ugluk", position: "Orc Lineman" },
        { number: 3, name: "Snaga", position: "Orc Lineman" },
      ],
    },
    seed: 79,
    // Up to the kick-off, without placing the ball: Dwarfen Wisdom comes first.
    actions: toKickoff(
      {
        home: { 1: { x: 12, y: 6 }, 2: { x: 12, y: 7 }, 3: { x: 12, y: 8 }, 4: { x: 8, y: 7 }, 5: { x: 10, y: 4 } },
        away: { 1: { x: 13, y: 6 }, 2: { x: 13, y: 7 }, 3: { x: 13, y: 8 } },
      },
      { x: 6, y: 7 },
    ).slice(0, -1),
  },
  {
    id: "pre-game-shop",
    title: "Pre-game shop: petty cash, treasury and free prayers",
    instructions: [
      "Fan factor and weather are rolled. Gouged Eye has the higher Current Team Value (425k: three Orc Linemen, a Big Un Blocker and three re-rolls, against 335k), so they shop first, with only their 60k treasury: buy a Team Mascot (25k), or nothing.",
      "The Altdorf Pros then get petty cash: the 90k difference plus what Gouged Eye spent. They may add up to 50k from their 100k treasury; unspent petty cash is lost.",
      "After the shop, the team with the lower value, counting what each team bought, gets a free Prayer to Nuffle per 50k of difference, drawn after any it bought. Buy little to see one.",
      "The log lists what each team bought, and how much of it came from the treasury.",
    ],
    home: {
      name: "Altdorf Pros",
      roster: "Human",
      rerolls: 2,
      treasury: 100_000,
      journeymen: false,
      players: [
        { number: 1, name: "Wilhelm", position: "Human Lineman" },
        { number: 2, name: "Hans", position: "Human Lineman" },
        { number: 3, name: "Otto", position: "Human Lineman" },
        { number: 4, name: "Klaus", position: "Human Blitzer" },
      ],
    },
    away: {
      name: "Gouged Eye",
      roster: "Orc",
      rerolls: 3,
      treasury: 60_000,
      journeymen: false,
      players: [
        { number: 1, name: "Grishnak", position: "Orc Lineman" },
        { number: 2, name: "Ugluk", position: "Orc Lineman" },
        { number: 3, name: "Snaga", position: "Orc Lineman" },
        { number: 4, name: "Gorbag", position: "Big Un Blocker" },
      ],
    },
    seed: 83,
    shop: true,
    actions: [roll(1, 1), roll(3, 4)],
  },
  {
    id: "star-players",
    title: "Star players: Grak and Crumbleberry, Akhorne, a mercenary",
    instructions: [
      "Home's first turn. The Altdorf Pros hired Grak and Crumbleberry (a pair, 250k) and a Human Lineman mercenary with Block; Gouged Eye hired Akhorne the Squirrel (the team files' starPlayers and mercenaries).",
      "Click Grak (#5) and choose Move: after his Bone Head roll, he may pick up Crumbleberry (#6), next to him (I'll Carry You, once per half). She leaves the pitch and Grak gains Dodge and Break Tackle.",
      "Move Grak, then end his action: click a highlighted square next to him to put Crumbleberry down, as she was.",
      "Hover a star player for their skills and special rules; the mercenary (#7) has Loner (4+). Akhorne's Blind Rage re-rolls a failed Dauntless roll when he blocks someone stronger.",
    ],
    home: {
      name: "Altdorf Pros",
      roster: "Human",
      rerolls: 2,
      journeymen: false,
      starPlayers: ["Grak", "Crumbleberry"],
      mercenaries: [{ position: "Human Lineman", skill: "Block" }],
      players: [
        { number: 1, name: "Wilhelm", position: "Human Lineman" },
        { number: 2, name: "Hans", position: "Human Lineman" },
        { number: 3, name: "Otto", position: "Human Lineman" },
        { number: 4, name: "Klaus", position: "Human Blitzer" },
      ],
    },
    away: {
      name: "Gouged Eye",
      roster: "Orc",
      rerolls: 2,
      journeymen: false,
      starPlayers: ["Akhorne the Squirrel"],
      players: [
        { number: 1, name: "Grishnak", position: "Orc Lineman" },
        { number: 2, name: "Ugluk", position: "Orc Lineman" },
        { number: 3, name: "Snaga", position: "Orc Lineman" },
      ],
    },
    seed: 89,
    actions: toFirstTurn({
      home: { 1: { x: 12, y: 7 }, 2: { x: 12, y: 4 }, 3: { x: 12, y: 10 }, 4: { x: 4, y: 7 }, 5: { x: 8, y: 7 }, 6: { x: 8, y: 8 }, 7: { x: 9, y: 11 } },
      away: { 1: { x: 13, y: 7 }, 2: { x: 13, y: 4 }, 3: { x: 13, y: 10 }, 4: { x: 16, y: 7 } },
      ball: { x: 4, y: 7 },
    }),
  },
  {
    id: "prayers",
    title: "Prayers to Nuffle: the pre-game draw",
    instructions: [
      "Pre-game: the home team bought three Prayers to Nuffle. Fan factor and weather are rolled; now each prayer is a D16 on the BB2025 table (a result the team already has is rolled again).",
      "Roll with \"Physical dice\" to pick them: 4 Iron Man and 5 Knuckle Dusters let you choose the player, 6 Bad Habits rolls a D3 for the opponents who gain Loner (2+), 16 Intensive Training lets you choose a primary skill.",
      "The others (Friends with the Ref, Under Scrutiny, Moles under the Pitch, Throw a Rock, Treacherous Trapdoor...) change rules during the game; the log shows each prayer granted.",
    ],
    home: {
      name: "Altdorf Pros",
      roster: "Human",
      rerolls: 2,
      journeymen: false,
      inducements: { prayers: 3 },
      players: [
        { number: 1, name: "Wilhelm", position: "Human Lineman" },
        { number: 2, name: "Hans", position: "Human Lineman" },
        { number: 3, name: "Otto", position: "Human Lineman" },
        { number: 4, name: "Klaus", position: "Human Blitzer" },
      ],
    },
    away: {
      name: "Gouged Eye",
      roster: "Orc",
      rerolls: 2,
      journeymen: false,
      players: [
        { number: 1, name: "Grishnak", position: "Orc Lineman" },
        { number: 2, name: "Ugluk", position: "Orc Lineman" },
        { number: 3, name: "Snaga", position: "Orc Lineman" },
      ],
    },
    seed: 73,
    actions: [roll(1, 1), roll(3, 4)],
  },
  {
    id: "trapdoor-throw",
    title: "Treacherous Trapdoor: a thrown team-mate comes down on it",
    instructions: [
      "Home's first turn. The Flying Gits prayed for Treacherous Trapdoor (drawn before the coin toss): trapdoors at (6,1) and (19,13). Grumbol (#1, Troll) has Bullseye here (given in the team file in src/scenarios.ts).",
      "Click \"Physical dice\", declare Throw Team-mate with Grumbol (Really Stupid 2+, Always Hungry 2+), click Snikkit (#2), then the trapdoor square (6,1). Enter a 6 (superb) and use Bullseye: Snikkit comes down on the trapdoor.",
      "The trapdoor roll comes before his landing: on a 1 (no re-roll) he falls through, an injury roll as for the crowd and a turnover; on 2+ he rolls to land as usual.",
    ],
    home: {
      name: "Flying Gits",
      roster: "Orc",
      rerolls: 2,
      journeymen: false,
      inducements: { prayers: 1 },
      players: [
        { number: 1, name: "Grumbol", position: "Troll", skills: ["Bullseye"] },
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
      journeymen: false,
      players: [
        { number: 1, name: "Hans", position: "Human Lineman" },
        { number: 2, name: "Otto", position: "Human Lineman" },
        { number: 3, name: "Fritz", position: "Human Lineman" },
      ],
    },
    seed: 103,
    actions: ((actions: Action[]) => [...actions.slice(0, 2), roll(1) /* the prayer: Treacherous Trapdoor */, ...actions.slice(2)])(
      toFirstTurn({
        home: { 1: { x: 8, y: 2 }, 2: { x: 8, y: 3 }, 3: { x: 12, y: 6 }, 4: { x: 12, y: 7 }, 5: { x: 12, y: 8 } },
        away: { 1: { x: 13, y: 6 }, 2: { x: 13, y: 7 }, 3: { x: 13, y: 8 } },
        ball: { x: 5, y: 7 },
      }),
    ),
  },
  {
    id: "end-of-game",
    title: "End of the game: Star Player Points, a concession, MVPs, winnings and fans",
    instructions: [
      "Home's first turn: Klaus (#2) has just blocked Grishnak (#1) into the reserves as a casualty: 2 Star Player Points.",
      "Click \"Concede\" and confirm: conceding during a turn is not legal, so Gouged Eye win 2-0. Click two of their players to name the scorers of the awarded touchdowns.",
      "The MVPs (both for Gouged Eye) and the winnings are worked out, then roll Dedicated Fans: a D3 for the Altdorf Pros, who lose that many (keeping 1), a D6 for Gouged Eye.",
      "Wilhelm (#1, 3 advancements) rolls to stay: he leaves on 1-3. The summary lists each team's Star Player Points; \"Download team\" saves the updated team file.",
    ],
    home: {
      name: "Altdorf Pros",
      roster: "Human",
      rerolls: 2,
      dedicatedFans: 3,
      journeymen: false,
      players: [
        { number: 1, name: "Wilhelm", position: "Human Lineman", skills: ["Dodge", "Fend"], improvements: { av: 1 } },
        { number: 2, name: "Klaus", position: "Human Blitzer" },
        { number: 3, name: "Otto", position: "Human Lineman" },
        { number: 4, name: "Hans", position: "Human Lineman" },
      ],
    },
    away: {
      name: "Gouged Eye",
      roster: "Orc",
      rerolls: 2,
      dedicatedFans: 2,
      journeymen: false,
      players: [
        { number: 1, name: "Grishnak", position: "Orc Lineman" },
        { number: 2, name: "Ugluk", position: "Orc Lineman" },
        { number: 3, name: "Snaga", position: "Orc Lineman" },
      ],
    },
    seed: 79,
    actions: [
      ...toFirstTurn({
        home: { 1: { x: 12, y: 5 }, 2: { x: 12, y: 7 }, 3: { x: 12, y: 9 }, 4: { x: 5, y: 7 } },
        away: { 1: { x: 13, y: 7 }, 2: { x: 13, y: 5 }, 3: { x: 13, y: 9 } },
        ball: { x: 5, y: 7 },
      }),
      // Klaus knocks Grishnak down; the armour breaks (11), the injury roll (10) and the casualty roll make him Badly Hurt.
      { type: "START_ACTION", playerId: "home-2", action: "block" },
      { type: "BLOCK", targetId: "away-1" },
      roll(6),
      { type: "CHOOSE_BLOCK_DIE", index: 0 },
      { type: "PUSH", square: { x: 14, y: 7 } },
      { type: "FOLLOW_UP", follow: false },
      roll(6, 5),
      roll(6, 4),
      roll(1, 1),
    ],
  },
];
