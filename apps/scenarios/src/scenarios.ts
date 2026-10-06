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

/** Where each player (by number) is set up, and where the kick-off ball comes to rest. */
export interface Kickoff {
  home: Record<number, Square>;
  away: Record<number, Square>;
  /** A free square of the home half, at least two rows from the top sideline. */
  ball: Square;
}

/**
 * Actions from a new game to home's first turn: nice weather, away wins the coin toss and kicks, both teams are set up
 * as given, and the ball deviates one square south onto the square above `ball` (Get the Ref, nothing happens) and
 * bounces south onto `ball`.
 */
export function toFirstTurn({ home, away, ball }: Kickoff): Action[] {
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
    { type: "PLACE_BALL", square: { x: ball.x, y: ball.y - 2 } },
    roll(5, 1), // deviation: one square south
    roll(1, 1), // kick-off event: Get the Ref
    roll(5), // bounce: south
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
];
