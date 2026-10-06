import type { Ctx, Handler } from "../context";
import type { GameState, PlayerState, Procedure } from "../types";
import { adjacent, ballCarrier, hasTackleZone, isOnPitch, playerAt } from "../pitch";
import { ARMOUR_DICE } from "./checks";
import { injure } from "./injury";
import { dropBall } from "./ball";
import { getPlayer, squareOf } from "./helpers";

type P<T extends Procedure["type"]> = Extract<Procedure, { type: T }>;

/** Thrall team-mates next to the player, standing, prone or stunned: the ones a thirsty player may bite. */
export function thralls(state: GameState, player: PlayerState): PlayerState[] {
  if (!isOnPitch(player)) return [];
  return adjacent(player.at)
    .map((s) => playerAt(state, s))
    .filter((p): p is PlayerState => p !== undefined && p.side === player.side && p.keywords.includes("thrall"));
}

/** No Thrall bitten: a turnover, the player loses their tackle zone and drops the ball. */
function starve(ctx: Ctx, player: PlayerState) {
  const { state } = ctx;
  state.turnover = true;
  ctx.emit({ type: "FeedingFailed", playerId: player.id });
  if (!isOnPitch(player)) return "done" as const;
  player.distracted = true;
  if (ballCarrier(state)?.id === player.id) {
    state.ball.carried = false;
    ctx.push({ type: "Bounce", from: { ...squareOf(ctx, player) }, kickoff: false, receiving: null });
  }
  return "done" as const;
}

/**
 * Bloodlust feeding: the thirsty player, still standing with a tackle zone and before any turnover, bites one adjacent
 * Thrall team-mate (the coach picks). The Thrall is placed prone and rolls for injury without armour, a casualty being
 * only Badly Hurt; a turnover only if they held the ball. Biting nobody is a turnover, and the player loses their
 * tackle zone until their next activation and drops the ball.
 */
export const Feed: Handler<P<"Feed">> = {
  step(ctx, proc, action) {
    const { state } = ctx;
    const player = getPlayer(ctx, proc.playerId);
    if (proc.stage === "select") {
      const victims = thralls(state, player);
      if (state.turnover || !hasTackleZone(player) || victims.length === 0) return starve(ctx, player);
      if (action === null) return "wait";
      const { playerIds } = ctx.expect(action, "SELECT_PLAYERS");
      const id = playerIds[0];
      if (playerIds.length > 1 || (id !== undefined && !victims.some((v) => v.id === id))) ctx.reject("Invalid Thrall.");
      if (id === undefined) return starve(ctx, player);
      const victim = getPlayer(ctx, id);
      ctx.emit({ type: "PlayerBitten", playerId: player.id, victimId: victim.id });
      if (ballCarrier(state)?.id === victim.id) {
        state.ball.carried = false;
        state.turnover = true;
        proc.dropped = true;
      }
      if (victim.status === "standing") {
        victim.status = "prone";
        ctx.emit({ type: "PlayerPlacedProne", playerId: victim.id });
      }
      proc.victimId = victim.id;
      proc.stage = "injury";
      return "continue";
    }
    if (action === null) return "wait";
    const victim = getPlayer(ctx, proc.victimId!);
    const square = squareOf(ctx, victim);
    const [a, b] = ctx.roll(action, [...ARMOUR_DICE], "Injury (bitten)");
    if (proc.dropped) ctx.push(dropBall(victim, square));
    injure(ctx, victim, a! + b!, { bitten: true });
    const activation = state.stack.findLast((p): p is P<"MoveAction"> => p.type === "MoveAction" && p.playerId === player.id);
    if (activation) activation.thirsty = false;
    return "done";
  },
  actions(state, proc) {
    const player = state.players[proc.playerId]!;
    if (proc.stage === "injury") {
      return [{ type: "ROLL", side: null, dice: [...ARMOUR_DICE], reason: `Injury (${state.players[proc.victimId!]!.name}, bitten)` }];
    }
    return [
      {
        type: "SELECT_PLAYERS",
        side: player.side,
        playerIds: thralls(state, player).map((p) => p.id),
        max: 1,
        reason: `Bloodlust: choose a Thrall for ${player.name} to bite (none is a turnover)`,
      },
    ];
  },
};
