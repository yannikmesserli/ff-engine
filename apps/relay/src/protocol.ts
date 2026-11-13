/**
 * Messages between the relay and the browsers (JSON over a WebSocket on `/relay?game=<id>`). `&side=<home|away>` takes
 * that side back after a reload, `&side=watcher` comes back as a watcher; home's `&watchers=1` lets the game be
 * watched (away's is ignored).
 */

export type Side = "home" | "away";

export const SIDES: readonly Side[] = ["home", "away"];

/** A game id in a URL: 4 to 32 lowercase letters and digits. */
export const GAME_ID = /^[a-z0-9]{4,32}$/;

export type ClientMessage =
  /** From a player: `data` is forwarded as is to both players of the game (the sender included) and its watchers. */
  | { type: "relay"; data: unknown }
  /** From a watcher: ask the players for everything they know (forwarded to them, at most once a second per watcher). */
  | { type: "sync-request" };

export type ServerMessage =
  /**
   * To a player, on connection: the side they play (the one asked for, else the first free: home), whether the opponent
   * is there, and how many watch (null: the game may not be watched).
   */
  | { type: "welcome"; side: Side; opponent: boolean; watchers: number | null }
  /** To a player: the opponent connected or left. */
  | { type: "opponent"; present: boolean }
  /** To the players: the game may now be watched, or a watcher came or left. */
  | { type: "watchers"; count: number }
  /** To the players: a watcher asks for everything they know (answer with a snapshot, sent like any message). */
  | { type: "sync-request" }
  /** To a watcher, on connection: the players there. A watcher only receives; it sends nothing but sync requests. */
  | { type: "watching"; players: Side[] }
  /** To the watchers: a player connected or left. */
  | { type: "player"; side: Side; present: boolean }
  /** A player's message, in the order the relay received it (the same order for everyone in the game). */
  | { type: "relay"; from: Side; data: unknown };
