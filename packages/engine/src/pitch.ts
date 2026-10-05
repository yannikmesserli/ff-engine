import type { GameState, PlayerState, Side, Square } from "./types";

/**
 * Pitch is 26x15 squares, including both end zones:
 * home defends the left end zone (x=0) and scores at x=25, away the opposite.
 */
export const PITCH_WIDTH = 26;
export const PITCH_HEIGHT = 15;
/** Column of each side's line of scrimmage (the last column of its half). */
export const HOME_LOS_X = 12;
export const AWAY_LOS_X = 13;
/** Rows of each wide zone (y < 4 at the top, y >= 11 at the bottom). */
export const WIDE_ZONE_ROWS = 4;

/** The opposing side. */
export const other = (side: Side): Side => (side === "home" ? "away" : "home");

export const sameSquare = (a: Square, b: Square) => a.x === b.x && a.y === b.y;

/** The square `n` steps from `s` in direction `d` (a unit vector such as a SCATTER entry). */
export const offset = (s: Square, d: Square, n = 1): Square => ({ x: s.x + d.x * n, y: s.y + d.y * n });

export const inBounds = (s: Square) => s.x >= 0 && s.x < PITCH_WIDTH && s.y >= 0 && s.y < PITCH_HEIGHT;

/** The square is on the pitch, in the half `side` sets up in. */
export const inHalf = (side: Side, s: Square) =>
  inBounds(s) && (side === "home" ? s.x <= HOME_LOS_X : s.x >= AWAY_LOS_X);

/** Which wide zone the square is in, if any. */
export const inWideZone = (s: Square): "top" | "bottom" | null =>
  s.y < WIDE_ZONE_ROWS ? "top" : s.y >= PITCH_HEIGHT - WIDE_ZONE_ROWS ? "bottom" : null;

/** Line of scrimmage squares only count in the centre field, not in the wide zones. */
export const onLineOfScrimmage = (side: Side, s: Square) =>
  s.x === (side === "home" ? HOME_LOS_X : AWAY_LOS_X) && inWideZone(s) === null;

/** The end zone a side scores in. */
export const scoringEndZoneX = (side: Side) => (side === "home" ? PITCH_WIDTH - 1 : 0);

/** Every square of the pitch matching `filter`, row by row. */
export function allSquares(filter: (s: Square) => boolean = () => true): Square[] {
  const squares: Square[] = [];
  for (let y = 0; y < PITCH_HEIGHT; y++) {
    for (let x = 0; x < PITCH_WIDTH; x++) {
      if (filter({ x, y })) squares.push({ x, y });
    }
  }
  return squares;
}

/** The (up to 8) neighbouring squares that are on the pitch. */
export function adjacent(s: Square): Square[] {
  const result: Square[] = [];
  for (let dy = -1; dy <= 1; dy++) {
    for (let dx = -1; dx <= 1; dx++) {
      if (dx === 0 && dy === 0) continue;
      const n = { x: s.x + dx, y: s.y + dy };
      if (inBounds(n)) result.push(n);
    }
  }
  return result;
}

/** The player stands or lies on a square (not in a dugout box). */
export const isOnPitch = (p: PlayerState): p is PlayerState & { at: Square } => typeof p.at !== "string";

export function playerAt(state: GameState, s: Square): PlayerState | undefined {
  return Object.values(state.players).find((p) => isOnPitch(p) && sameSquare(p.at, s));
}

/** All players of a side, wherever they are. */
export const teamPlayers = (state: GameState, side: Side) =>
  Object.values(state.players).filter((p) => p.side === side);

/** Number of opposing standing players exerting a tackle zone on the square. */
export function tackleZones(state: GameState, side: Side, s: Square): number {
  return adjacent(s).filter((n) => {
    const p = playerAt(state, n);
    return p !== undefined && p.side !== side && p.status === "standing";
  }).length;
}

/** The player holding the ball, if any. */
export function ballCarrier(state: GameState): PlayerState | undefined {
  const { square, carried } = state.ball;
  return square && carried ? playerAt(state, square) : undefined;
}
