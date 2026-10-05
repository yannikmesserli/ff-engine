import type { Handler } from "../context";
import type { GameState, PlayerState, Procedure, Square } from "../types";
import { adjacent, ballCarrier, isOnPitch, playerAt, sameSquare, scoringEndZoneX, tackleZones } from "../pitch";
import { hasSkill } from "../skills";
import { getPlayer } from "./helpers";

type P<T extends Procedure["type"]> = Extract<Procedure, { type: T }>;

/** Players who must roll before acting are never considered stalling. */
const NO_STALLING_SKILLS = ["Animal Savagery", "Bloodlust", "Bone Head", "Really Stupid", "Take Root", "Unchannelled Fury"];

/** From turn 7 on, the rock always misses. */
export const LAST_STALLING_TURN = 6;

/**
 * Within the player's MA, a path to the opposing end zone that does not leave or pass through a tackle zone (it may end
 * in one), around other players and without jumping.
 */
function hasOpenPathToEndZone(state: GameState, player: PlayerState & { at: Square }) {
  const endX = scoringEndZoneX(player.side);
  const seen = new Set([`${player.at.x},${player.at.y}`]);
  let frontier: Square[] = [player.at];
  for (let distance = 1; distance <= player.ma && frontier.length > 0; distance++) {
    const next: Square[] = [];
    for (const square of frontier) {
      if (!sameSquare(square, player.at) && tackleZones(state, player.side, square) > 0) continue;
      for (const s of adjacent(square)) {
        const key = `${s.x},${s.y}`;
        if (seen.has(key) || playerAt(state, s)) continue;
        if (s.x === endX) return true;
        seen.add(key);
        next.push(s);
      }
    }
    frontier = next;
  }
  return false;
}

/**
 * BB2025 stalling: an unmarked standing ball carrier who could walk into the end zone this turn (without rushing) is
 * stalling if they do not score.
 */
export function isStalling(state: GameState, player: PlayerState): boolean {
  if (!isOnPitch(player) || player.status !== "standing" || ballCarrier(state)?.id !== player.id) return false;
  if (NO_STALLING_SKILLS.some((skill) => hasSkill(player, skill))) return false;
  return tackleZones(state, player.side, player.at) === 0 && hasOpenPathToEndZone(state, player);
}

const reason = (state: GameState, player: PlayerState) =>
  `Stalling: the crowd throws a rock at ${player.name} (hits on ${state.teams[player.side].turn}+)`;

/**
 * The crowd throws a rock at a stalling player: on turns 1-6 it hits on a D6 of at least the team's turn number, and
 * the player is Knocked Down (armour, injury, the ball bounces; not a turnover). From turn 7 it always misses.
 */
export const Stalling: Handler<P<"Stalling">> = {
  step(ctx, proc, action) {
    const player = getPlayer(ctx, proc.playerId);
    const turn = ctx.state.teams[player.side].turn;
    if (turn > LAST_STALLING_TURN) {
      ctx.emit({ type: "RockThrown", playerId: player.id, roll: null, hit: false });
      return "done";
    }
    if (action === null) return "wait";
    const [roll] = ctx.roll(action, [{ kind: "d6", count: 1 }], reason(ctx.state, player));
    const hit = roll! >= turn;
    ctx.emit({ type: "RockThrown", playerId: player.id, roll: roll!, hit });
    if (hit) ctx.push({ type: "KnockDown", playerId: player.id, turnover: false, stage: "fall" });
    return "done";
  },
  actions(state, proc) {
    const player = state.players[proc.playerId]!;
    if (state.teams[player.side].turn > LAST_STALLING_TURN) return [];
    return [{ type: "ROLL", side: null, dice: [{ kind: "d6", count: 1 }], reason: reason(state, player) }];
  },
};
