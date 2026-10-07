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
      journeymen: false,
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
];
