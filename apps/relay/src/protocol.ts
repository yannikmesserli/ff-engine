/** Messages between the relay and the players' browsers (JSON over a WebSocket on `/relay?game=<id>`). */

export type Side = "home" | "away";

/** A game id in a URL: 4 to 32 lowercase letters and digits. */
export const GAME_ID = /^[a-z0-9]{4,32}$/;

/** From a player: `data` is forwarded as is to both players of the game, the sender included. */
export interface ClientMessage {
  type: "relay";
  data: unknown;
}

export type ServerMessage =
  /** On connection: the side this player plays (first in the game: home) and whether the opponent is there. */
  | { type: "welcome"; side: Side; opponent: boolean }
  /** The opponent connected or left. */
  | { type: "opponent"; present: boolean }
  /** A player's message, in the order the relay received it (the same order for both players). */
  | { type: "relay"; from: Side; data: unknown };
