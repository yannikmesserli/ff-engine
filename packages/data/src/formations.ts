import { PITCH_WIDTH, isOnPitch, onLineOfScrimmage, teamPlayers } from "@bb/engine";
import type { Action, GameState, PlayerState, Side, Square } from "@bb/engine";
import formationData from "./formations.json";

/**
 * Formations use a text format: 15 rows by 13 columns describing the left (home) half,
 * the last column being the line of scrimmage. Letters say which kind of player should stand there.
 */
export type Formation = string[];

/** Built-in formations, keyed by name, e.g. "def_spread". */
export const formations: Record<string, Formation> = formationData;

const has = (p: PlayerState, skill: string) => p.skills.includes(skill);

/** Formation letters in placement order. */
const ORDER = ["S", "s", "p", "b", "c", "m", "a", "v", "d", "0", "x"] as const;
type Slot = (typeof ORDER)[number];

/** How well a player fits each letter (highest wins, first player on ties). */
const SCORE: Record<Slot, (p: PlayerState) => number> = {
  S: (p) => p.st + (has(p, "Block") ? 0.5 : 0) - (has(p, "Sure Hands") ? 0.5 : 0),
  m: (p) => p.ma,
  a: (p) => p.ag,
  v: (p) => p.av,
  s: (p) => (has(p, "Sure Hands") ? 1 : 0),
  p: (p) => (has(p, "Pass") ? 1 : 0),
  c: (p) => (has(p, "Catch") ? 1 : 0),
  b: (p) => (has(p, "Block") ? 1 : 0),
  d: (p) => (has(p, "Dodge") ? 1 : 0),
  "0": (p) => -p.skills.length,
  x: (p) => (has(p, "Block") ? 1 : has(p, "Pass") || has(p, "Catch") ? 0 : 0.5),
};

/** Formation coordinates describe the home half; mirror them for the away side. */
function toPitch(side: Side, x: number, y: number): Square {
  return { x: side === "home" ? x : PITCH_WIDTH - 1 - x, y };
}

/** PLACE_PLAYER actions that clear the side's half and set up the formation with its available players. */
export function formationActions(state: GameState, side: Side, formation: Formation): Action[] {
  const actions: Action[] = [];
  const pool = teamPlayers(state, side).filter((p) => (p.at === "reserves" && !p.exhausted) || isOnPitch(p));
  for (const p of pool) if (isOnPitch(p)) actions.push({ type: "PLACE_PLAYER", playerId: p.id, square: null });

  const cells = formation.flatMap((row, y) => [...row].map((t, x) => ({ t, square: toPitch(side, x, y) })));
  // Fill the line of scrimmage first, then the rest, each in letter order. "-" and unknown letters stay empty.
  const ordered = [true, false].flatMap((los) =>
    ORDER.flatMap((slot) =>
      cells.filter((c) => c.t === slot && onLineOfScrimmage(side, c.square) === los).map(({ square }) => ({ slot, square })),
    ),
  );
  for (const { slot, square } of ordered) {
    if (pool.length === 0) break;
    const score = SCORE[slot];
    const best = pool.reduce((a, b) => (score(b) > score(a) ? b : a));
    pool.splice(pool.indexOf(best), 1);
    actions.push({ type: "PLACE_PLAYER", playerId: best.id, square });
  }
  // The Team Captain must be set up: if left out, they take the last square filled (the least important one).
  const captain = pool.find((p) => has(p, "Team Captain"));
  const last = actions.at(-1);
  if (captain && last?.type === "PLACE_PLAYER" && last.square) actions[actions.length - 1] = { ...last, playerId: captain.id };
  return actions;
}
