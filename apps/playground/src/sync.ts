import type { Action, Side } from "@ff-engine/engine";

/**
 * How two browsers keep an online game in step. The game is the replay of a list of batches of actions, the same in
 * both browsers. Each batch is sent with its position in the list (`at`). A browser that (re)connects, or that sees a
 * batch further down than it got to, sends everything it knows (a snapshot, in chunks), and both settle on the same
 * snapshot. A browser takes no decision after (re)connecting until it has the opponent's snapshot, so it never plays
 * from a position the opponent has already left.
 */

/** What is settled before the kick-off: the teams of the players who are ready, and home's seed and shop option. */
export interface Lobby {
  ready: Partial<Record<Side, unknown>>;
  seed: number | null;
  shop: boolean;
}

/** Everything a browser knows of a game: its lobby and every batch played. */
export interface Snapshot extends Lobby {
  batches: Action[][];
}

const same = (a: unknown, b: unknown) => a === b || JSON.stringify(a) === JSON.stringify(b);
/** `a` is the start of `b` (or all of it). */
const isPrefix = (a: Action[][], b: Action[][]) => a.length <= b.length && a.every((batch, i) => same(batch, b[i]));

/** Both teams are ready and home picked the seed: the game exists, and its batches only make sense with this lobby. */
export const started = (g: Lobby) => g.ready.home !== undefined && g.ready.away !== undefined && g.seed !== null;

/** The settings a started game was created with. */
const settings = (g: Lobby) => [g.ready.home, g.ready.away, g.seed, g.shop];

/**
 * A batch received at position `at`: appended when it is the next one. A lower position is a batch already applied
 * (it came back after a sync) or one sent at the same time as the batch the relay passed first: both browsers drop
 * it. A higher position means batches were missed (`missing`: send a snapshot, the opponent answers with theirs).
 */
export function receiveBatch(mine: Action[][], actions: Action[], at: number): { batches: Action[][]; missing: boolean } {
  if (at === mine.length) return { batches: [...mine, actions], missing: false };
  return { batches: mine, missing: at > mine.length };
}

/**
 * The batches to keep after the opponent's snapshot of the same game, and whether to answer with ours (they are
 * behind). Batches already applied keep their objects, so the board only replays the new ones. Lists that disagree
 * (which the pause after reconnecting prevents) resolve to the longer one, then to home's.
 */
export function reconcile(mine: Action[][], theirs: Action[][], from: Side): { batches: Action[][]; reply: boolean } {
  if (isPrefix(mine, theirs)) return { batches: [...mine, ...theirs.slice(mine.length)], reply: false };
  if (isPrefix(theirs, mine)) return { batches: mine, reply: true };
  return theirs.length > mine.length || (theirs.length === mine.length && from === "home") ? { batches: theirs, reply: false } : { batches: mine, reply: true };
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

/**
 * The snapshot to keep after the opponent's, and whether to answer with ours. The lobby and the batches go together:
 * a started game is never mixed with another lobby. A started game wins over a lobby (a player who lost their tab
 * and picked again); two started games with different settings resolve whole to the one with more batches, then to
 * home's; two lobbies merge.
 */
export function reconcileSnapshot(mine: Snapshot, theirs: Snapshot, from: Side): { snapshot: Snapshot; reply: boolean } {
  const ours = started(mine);
  const their = started(theirs);
  if (ours && their && same(settings(mine), settings(theirs))) {
    const { batches, reply } = reconcile(mine.batches, theirs.batches, from);
    return { snapshot: { ...mine, batches }, reply };
  }
  if (ours && their) {
    const theirsWins = theirs.batches.length > mine.batches.length || (theirs.batches.length === mine.batches.length && from === "home");
    return theirsWins ? { snapshot: theirs, reply: false } : { snapshot: mine, reply: true };
  }
  if (their) return { snapshot: theirs, reply: false };
  if (ours) return { snapshot: mine, reply: true };
  return { snapshot: { ...mergeLobby(mine, theirs), batches: [] }, reply: false };
}

/**
 * Characters of a snapshot per relay message. The relay accepts messages up to 256 KiB: a chunk of this many
 * characters stays under it even when every character takes 3 bytes in UTF-8, with room for the envelope.
 */
export const SYNC_CHUNK_CHARS = 60_000;

/** A snapshot's JSON cut into chunks of at most `size` characters (at least one chunk). */
export function chunk(text: string, size = SYNC_CHUNK_CHARS): string[] {
  const parts: string[] = [];
  for (let i = 0; i < text.length; i += size) parts.push(text.slice(i, i + size));
  return parts.length > 0 ? parts : [""];
}

/** Reassembles the chunks of the latest snapshot an opponent sent; a new snapshot id drops an unfinished one. */
export function snapshotAssembler() {
  let current: { id: string; parts: Array<string | undefined>; received: number } | null = null;
  /** Adds a chunk; returns the whole text once every chunk of that snapshot has arrived. */
  return (id: string, index: number, count: number, data: string): string | null => {
    if (!current || current.id !== id) current = { id, parts: new Array(count), received: 0 };
    if (index < 0 || index >= current.parts.length || current.parts[index] !== undefined) return null;
    current.parts[index] = data;
    current.received += 1;
    if (current.received < current.parts.length) return null;
    const text = current.parts.join("");
    current = null;
    return text;
  };
}
