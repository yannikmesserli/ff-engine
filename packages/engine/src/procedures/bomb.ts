import type { Handler } from "../context";
import type { GameState, Procedure, Square } from "../types";
import { SCATTER } from "../dice";
import { adjacent, inBounds, isOnPitch, offset, playerAt, sameSquare } from "../pitch";
import { hasSkill } from "../skills";
import { catchModifier } from "./ball";
import { getPlayer, squareOf } from "./helpers";

type P<T extends Procedure["type"]> = Extract<Procedure, { type: T }>;

/** Players next to an explosion are hit on this D6 roll. */
export const BOMB_HIT_TARGET = 4;

/** A bomb explodes on `square`: the player there (if any) first, then the players around it. */
export function explosion(state: GameState, square: Square): P<"Explosion"> {
  const targets = [square, ...adjacent(square)].flatMap((s) => {
    const p = playerAt(state, s);
    return p ? [p.id] : [];
  });
  return { type: "Explosion", square: { ...square }, targets, stage: "explode" };
}

/** A player who caught or intercepted a bomb must throw it again at once. */
export const rethrow = (playerId: string): P<"Pass"> => ({
  type: "Pass",
  throwerId: playerId,
  target: { x: 0, y: 0 },
  range: "quick",
  bomb: true,
  stage: "aim",
  rerolled: false,
});

/**
 * The bomb comes down on a square: a standing player there tries to catch it (AG, -1 after a scatter or bounce, no Catch
 * re-roll) and must throw it again on a success; a failure, or a player who cannot catch, sets it off there. On an empty
 * square it bounces once: off the pitch it is lost, onto a player it may be caught, otherwise it explodes.
 */
export const BombLanding: Handler<P<"BombLanding">> = {
  step(ctx, proc, action) {
    const { state } = ctx;
    if (proc.stage === "catch") {
      if (state.lastCheck?.kind === "bombcatch" && state.lastCheck.success) {
        ctx.emit({ type: "BombCaught", playerId: proc.catcherId! });
        ctx.push(rethrow(proc.catcherId!));
      } else ctx.push(explosion(state, proc.square));
      return "done";
    }
    const player = playerAt(state, proc.square);
    if (player?.status === "standing" && !player.distracted) {
      state.lastCheck = null;
      proc.catcherId = player.id;
      proc.stage = "catch";
      const modifier = catchModifier(state, { ...player, at: squareOf(ctx, player) }, proc.scattered || proc.bounced);
      ctx.push({ type: "Check", kind: "bombcatch", playerId: player.id, target: player.ag, modifier, stage: "roll", rerolled: false });
      return "continue";
    }
    if (player || proc.bounced) {
      ctx.push(explosion(state, proc.square));
      return "done";
    }
    if (action === null) return "wait";
    const [direction] = ctx.roll(action, [{ kind: "d8", count: 1 }], "Bomb bounce");
    const to = offset(proc.square, SCATTER[direction!]!);
    if (!inBounds(to)) {
      ctx.emit({ type: "BombLost" });
      return "done";
    }
    proc.square = to;
    proc.bounced = true;
    return "continue";
  },
  actions(state) {
    return [{ type: "ROLL", side: state.activeSide, dice: [{ kind: "d8", count: 1 }], reason: "Bomb bounce" }];
  },
};

/**
 * A bomb explodes: the player in the square is hit, each player next to it is hit on a D6 of 4+. A standing player hit is
 * knocked down (a turnover for the moving team's players); a prone or stunned one rolls armour. No modifiers apply.
 */
export const Explosion: Handler<P<"Explosion">> = {
  step(ctx, proc, action) {
    const { state } = ctx;
    if (proc.stage === "explode") {
      ctx.emit({ type: "BombExploded", square: { ...proc.square } });
      proc.stage = "next";
      return "continue";
    }
    const player = proc.targets[0] === undefined ? undefined : getPlayer(ctx, proc.targets[0]);
    if (!player) return "done";
    if (proc.stage === "roll") {
      if (action === null) return "wait";
      const [roll] = ctx.roll(action, [{ kind: "d6", count: 1 }], `Explosion ${BOMB_HIT_TARGET}+ (${player.name})`);
      proc.targets.shift();
      proc.stage = "next";
      if (roll! >= BOMB_HIT_TARGET) hit();
      return "continue";
    }
    if (!isOnPitch(player)) {
      proc.targets.shift();
      return "continue";
    }
    if (!sameSquare(player.at, proc.square)) {
      proc.stage = "roll";
      return "continue";
    }
    proc.targets.shift();
    hit();
    return "continue";

    function hit() {
      ctx.emit({ type: "BombHit", playerId: player!.id });
      // Violent Innovator: a casualty an opponent suffers from the bomb earns the bombardier Star Player Points.
      const bombardier = state.activePlayerId ? state.players[state.activePlayerId] : undefined;
      const spp = bombardier && bombardier.side !== player!.side && hasSkill(bombardier, "Violent Innovator") ? { sppTo: [bombardier.id] } : {};
      if (player!.status === "standing") {
        ctx.push({ type: "KnockDown", playerId: player!.id, turnover: player!.side === state.activeSide, stage: "fall", ...spp });
      } else ctx.push({ type: "KnockDown", playerId: player!.id, turnover: false, stage: "armour", ...spp });
    }
  },
  actions(state, proc) {
    if (proc.stage !== "roll") return [];
    const player = state.players[proc.targets[0]!]!;
    return [{ type: "ROLL", side: null, dice: [{ kind: "d6", count: 1 }], reason: `Explosion ${BOMB_HIT_TARGET}+ (${player.name})` }];
  },
};
