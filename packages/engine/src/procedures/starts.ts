import type { Ctx, Handler } from "../context";
import type { GameState, PlayerState, Procedure, Square } from "../types";
import { adjacent, hasTackleZone, isOnPitch, playerAt } from "../pitch";
import { hasSkill } from "../skills";
import { getPlayer, useOncePerGame } from "./helpers";

type P<T extends Procedure["type"]> = Extract<Procedure, { type: T }>;

/** How often each start-of-activation rule may be used. */
const PERIODS: Record<string, "game" | "half" | "drive"> = {
  "Black Ink": "game",
  "Excuse me, are you a Zoat?": "game",
};

/** The player may still use the rule this game, half or drive. */
export function ruleLeft(player: PlayerState, skill: string): boolean {
  if (!hasSkill(player, skill)) return false;
  const period = PERIODS[skill] ?? "game";
  const used = period === "game" ? player.usedThisGame : period === "half" ? player.usedThisHalf : player.usedThisDrive;
  return !used?.includes(skill);
}

/** Spend the rule for its period. */
export function useRule(ctx: Ctx, player: PlayerState, skill: string) {
  const period = PERIODS[skill] ?? "game";
  if (period === "game") return useOncePerGame(ctx, player, skill);
  if (period === "half") player.usedThisHalf = [...(player.usedThisHalf ?? []), skill];
  else player.usedThisDrive = [...(player.usedThisDrive ?? []), skill];
  ctx.emit({ type: "SkillUsed", playerId: player.id, skill });
}

/** Opponents standing next to the player, who they mark (when the player has a tackle zone). */
const marked = (state: GameState, player: PlayerState) =>
  !isOnPitch(player) || !hasTackleZone(player)
    ? []
    : adjacent(player.at).flatMap((s) => {
        const p = playerAt(state, s);
        return p && p.side !== player.side && p.status === "standing" ? [p] : [];
      });

/** Players of the other team on the pitch within `n` squares of the player (counting diagonals as one). */
const opponentsWithin = (state: GameState, player: PlayerState, n: number) =>
  !isOnPitch(player)
    ? []
    : Object.values(state.players).filter(
        (p): p is PlayerState & { at: Square } => p.side !== player.side && isOnPitch(p) && Math.max(Math.abs(p.at.x - player.at.x), Math.abs(p.at.y - player.at.y)) <= n,
      );

/** The targets a start-of-activation rule may pick. */
function targets(state: GameState, player: PlayerState, skill: string): PlayerState[] {
  switch (skill) {
    case "Black Ink":
      return marked(state, player).filter((p) => !p.distracted);
    case "Excuse me, are you a Zoat?":
      return opponentsWithin(state, player, 3).filter((p) => hasTackleZone(p));
    default:
      return [];
  }
}

/** The special rules the player may use now, at the start of their activation (see `StartSkill`). */
export function activationSkills(state: GameState, player: PlayerState): string[] {
  return Object.keys(PERIODS).filter((skill) => ruleLeft(player, skill) && targets(state, player, skill).length > 0);
}

/**
 * Special rules used at the start of an activation:
 * - Black Ink (once per game): an opponent the player marks becomes Distracted until their next activation.
 * - "Excuse me, are you a Zoat?" (once per game): an opponent within 3 squares (with a tackle zone) becomes Distracted.
 */
export const StartSkill: Handler<P<"StartSkill">> = {
  step(ctx, proc, action) {
    const { state } = ctx;
    const player = getPlayer(ctx, proc.playerId);
    const choices = targets(state, player, proc.skill);
    if (proc.stage === "target") {
      if (choices.length === 0) return "done";
      if (action === null) return "wait";
      const { playerIds } = ctx.expect(action, "SELECT_PLAYERS");
      if (playerIds.length === 0) return "done";
      const target = choices.find((p) => p.id === playerIds[0]) ?? ctx.reject("Invalid target.");
      if (playerIds.length > 1) ctx.reject("Choose one player.");
      useRule(ctx, player, proc.skill);
      proc.targetId = target.id;
      proc.stage = "effect";
    }
    const target = getPlayer(ctx, proc.targetId!);
    switch (proc.skill) {
      case "Black Ink":
      case "Excuse me, are you a Zoat?":
        target.distracted = true;
        ctx.emit({ type: "DistractedBy", playerId: target.id, byId: player.id, skill: proc.skill });
        return "done";
    }
    return "done";
  },
  actions(state, proc) {
    const player = state.players[proc.playerId]!;
    const playerIds = targets(state, player, proc.skill).map((p) => p.id);
    return [{ type: "SELECT_PLAYERS", side: player.side, playerIds, max: 1, reason: `${proc.skill}: choose a player` }];
  },
};
