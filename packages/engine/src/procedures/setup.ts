import type { Handler } from "../context";
import type { GameState, Procedure, Side } from "../types";
import { allSquares, inHalf, inWideZone, isOnPitch, onLineOfScrimmage, playerAt, teamPlayers } from "../pitch";
import { getPlayer } from "./helpers";

type P<T extends Procedure["type"]> = Extract<Procedure, { type: T }>;

export const MAX_PLAYERS_ON_PITCH = 11;
export const MIN_ON_LINE_OF_SCRIMMAGE = 3;
export const MAX_PER_WIDE_ZONE = 2;

/** Players who may be set up this drive: not KO'd, injured, sent off or exhausted. */
const availablePlayers = (state: GameState, side: Side) =>
  teamPlayers(state, side).filter((p) => p.at !== "ko" && p.at !== "cas" && p.at !== "banned" && !p.exhausted);

/** Why the current setup of `side` is illegal; empty when it can be confirmed. */
export function setupErrors(state: GameState, side: Side): string[] {
  const players = availablePlayers(state, side);
  const onPitch = players.filter(isOnPitch);
  const required = Math.min(MAX_PLAYERS_ON_PITCH, players.length);
  const errors: string[] = [];
  if (onPitch.length > MAX_PLAYERS_ON_PITCH) {
    errors.push(`Too many players on the pitch (${onPitch.length}/${MAX_PLAYERS_ON_PITCH}).`);
  } else if (onPitch.length < required) {
    errors.push(`${required} players must be set up (${onPitch.length} placed).`);
  }
  const onLos = onPitch.filter((p) => onLineOfScrimmage(side, p.at)).length;
  const requiredOnLos = Math.min(MIN_ON_LINE_OF_SCRIMMAGE, onPitch.length);
  if (onLos < requiredOnLos) {
    errors.push(`At least ${requiredOnLos} players must be on the line of scrimmage (${onLos} placed).`);
  }
  for (const zone of ["top", "bottom"] as const) {
    const n = onPitch.filter((p) => inWideZone(p.at) === zone).length;
    if (n > MAX_PER_WIDE_ZONE) errors.push(`At most ${MAX_PER_WIDE_ZONE} players in the ${zone} wide zone (${n} placed).`);
  }
  return errors;
}

/** A team places its players (moving them around or back to the reserves) until it confirms a legal setup. */
export const Setup: Handler<P<"Setup">> = {
  step(ctx, proc, action) {
    if (action === null) return "wait";
    const { state } = ctx;
    const a = ctx.expect(action, "PLACE_PLAYER", "END_SETUP");
    if (a.type === "END_SETUP") {
      const errors = setupErrors(state, proc.side);
      if (errors.length > 0) ctx.reject(errors.join(" "));
      ctx.emit({ type: "SetupDone", side: proc.side });
      return "done";
    }
    const player = getPlayer(ctx, a.playerId);
    if (player.side !== proc.side) ctx.reject(`${player.name} is not in the ${proc.side} team.`);
    if (!availablePlayers(state, proc.side).some((p) => p.id === player.id)) ctx.reject(`${player.name} cannot play this drive.`);
    if (a.square === null) {
      player.at = "reserves";
      return "wait";
    }
    if (!inHalf(proc.side, a.square)) ctx.reject("Players must be set up in their own half.");
    // Dropping onto a team-mate swaps both players.
    const occupant = playerAt(state, a.square);
    if (occupant && occupant.id !== player.id) occupant.at = player.at;
    player.at = { ...a.square };
    return "wait";
  },
  actions(state, proc) {
    return [
      {
        type: "PLACE_PLAYER",
        side: proc.side,
        playerIds: availablePlayers(state, proc.side).map((p) => p.id),
        squares: allSquares((s) => inHalf(proc.side, s)),
      },
      { type: "END_SETUP", side: proc.side, errors: setupErrors(state, proc.side) },
    ];
  },
};
