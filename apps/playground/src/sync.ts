import type { Action, Side } from "@ff-engine/engine";

/**
 * How two browsers keep an online game in step. The game is the replay of a list of batches of actions, the same in
 * both browsers. Each batch is sent with its position in the list (`at`); a browser that comes back, or that sees a
 * batch further down than it got to, sends everything it has (a sync), and the browser behind adopts the longer list.
 */

/** What is settled before the kick-off: the teams of the players who are ready, and home's seed and shop option. */
export interface Lobby {
  ready: Partial<Record<Side, unknown>>;
  seed: number | null;
  shop: boolean;
}

const same = (a: Action[], b: Action[]) => a === b || JSON.stringify(a) === JSON.stringify(b);
/** `a` is the start of `b` (or all of it). */
const isPrefix = (a: Action[][], b: Action[][]) => a.length <= b.length && a.every((batch, i) => same(batch, b[i]!));

/**
 * A batch received at position `at`: appended when it is the next one. A lower position is a batch already applied
 * (it came back after a sync) or one sent at the same time as the batch the relay passed first: both browsers drop
 * it. A higher position means batches were missed (`missing`: ask for a sync).
 */
export function receiveBatch(mine: Action[][], actions: Action[], at: number): { batches: Action[][]; missing: boolean } {
  if (at === mine.length) return { batches: [...mine, actions], missing: false };
  return { batches: mine, missing: at > mine.length };
}

/**
 * The batches to keep after the opponent's sync, and whether to answer with ours (they are behind). Batches already
 * applied keep their objects, so the board only replays the new ones. Lists that disagree (which should not happen)
 * resolve to home's.
 */
export function reconcile(mine: Action[][], theirs: Action[][], from: Side): { batches: Action[][]; reply: boolean } {
  if (isPrefix(mine, theirs)) return { batches: [...mine, ...theirs.slice(mine.length)], reply: false };
  if (isPrefix(theirs, mine)) return { batches: mine, reply: true };
  return from === "home" ? { batches: theirs, reply: false } : { batches: mine, reply: true };
}

/** Our lobby, completed with what the opponent knows and we don't (a team, home's seed and shop option). */
export function mergeLobby(mine: Lobby, theirs: Lobby): Lobby {
  const seeded = mine.seed === null && theirs.seed !== null;
  return {
    ready: { ...theirs.ready, ...mine.ready },
    seed: seeded ? theirs.seed : mine.seed,
    shop: seeded ? theirs.shop : mine.shop,
  };
}
