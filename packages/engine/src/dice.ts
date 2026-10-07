import type { DiceKind, Square } from "./types";

/** mulberry32: tiny, fast, seedable PRNG. The state is a single uint32 stored in the game state. */
export function nextRandom(seed: number): [value: number, next: number] {
  const next = (seed + 0x6d2b79f5) >>> 0;
  let t = next;
  t = Math.imul(t ^ (t >>> 15), t | 1);
  t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
  return [((t ^ (t >>> 14)) >>> 0) / 4294967296, next];
}

/** Number of faces per die kind; a coin is 1 = heads, 2 = tails. */
export const DIE_FACES: Record<DiceKind, number> = { coin: 2, d3: 3, d6: 6, d8: 8, d16: 16, block: 6 };

/** Block die faces, indexed by roll value 1..6. */
export const BLOCK_FACES = ["attacker_down", "both_down", "push", "push", "defender_stumbles", "defender_down"] as const;

const N = { x: 0, y: -1 };
const NE = { x: 1, y: -1 };
const E = { x: 1, y: 0 };
const SE = { x: 1, y: 1 };
const S = { x: 0, y: 1 };
const SW = { x: -1, y: 1 };
const W = { x: -1, y: 0 };
const NW = { x: -1, y: -1 };

/** d8 direction, clockwise from north. */
export const SCATTER: Record<number, Square> = { 1: N, 2: NE, 3: E, 4: SE, 5: S, 6: SW, 7: W, 8: NW };

/** Whether a D6 roll succeeds: a natural 1 always fails, a natural 6 always succeeds. */
export const passes = (roll: number, modifier: number, target: number) =>
  roll === 6 || (roll !== 1 && roll + modifier >= target);

/** BB2025 corners (an end zone square on the first or last row): the throw-in direction is a d3 instead of a d6. */
export const isCorner = (s: Square) => (s.x < 1 || s.x > 24) && (s.y < 1 || s.y > 13);

/**
 * BB2025 throw-in direction from the last square the ball was on: a d3 in the corners,
 * otherwise a d6 on the template facing into the pitch (1-2, 3-4, 5-6).
 */
export function throwInDirection(from: Square, roll: number): Square {
  if (isCorner(from)) {
    const corner = from.x < 1 ? (from.y < 1 ? [E, SE, S] : [N, NE, E]) : from.y < 1 ? [S, SW, W] : [W, NW, N];
    return corner[roll - 1]!;
  }
  if (from.x < 1) return templateDirection(E, roll);
  if (from.x > 24) return templateDirection(W, roll);
  if (from.y > 13) return templateDirection(N, roll);
  return templateDirection(S, roll);
}

/** The throw-in template facing an orthogonal direction: a D6 of 1-2 veers left of it, 3-4 goes straight, 5-6 right. */
export function templateDirection(facing: Square, roll: number): Square {
  const dirs = facing.x > 0 ? [NE, E, SE] : facing.x < 0 ? [SW, W, NW] : facing.y < 0 ? [NW, N, NE] : [SE, S, SW];
  return dirs[Math.floor((roll - 1) / 2)]!;
}
