import type { Handler } from "../context";
import type { GameState, PlayerState, Procedure, Side, Square } from "../types";
import { SCATTER } from "../dice";
import { adjacent, inBounds, isOnPitch, offset, other, playerAt, sameSquare } from "../pitch";
import { hasSkill } from "../skills";
import { catchModifier } from "./ball";
import { divingCatchers, getPlayer, squareOf } from "./helpers";

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

/** Diving Catch for a bomb: the team's divers next to the square, and its standing player in it. */
function bombDivers(state: GameState, square: Square, side: Side): PlayerState[] {
  const direct = playerAt(state, square);
  return [
    ...(direct && direct.side === side && direct.status === "standing" && !direct.distracted ? [direct] : []),
    ...divingCatchers(state, square).filter((p) => p.side === side),
  ];
}

/**
 * The bomb comes down on a square: a standing player there tries to catch it (AG, -1 after a scatter or bounce, no Catch
 * re-roll) and must throw it again on a success; a failure, or a player who cannot catch, sets it off there. On an empty
 * square it bounces once: off the pitch it is lost, onto a player it may be caught, otherwise it explodes.
 * Diving Catch: next to players with the skill, the moving team, then the other, may pick one of them (or their player
 * in the square) to catch it from their own square, where it goes off if the catch fails; +1 to catch an accurate bomb.
 */
export const BombLanding: Handler<P<"BombLanding">> = {
  step(ctx, proc, action) {
    const { state } = ctx;
    if (proc.stage === "land") {
      if (proc.dive === undefined) {
        const first: Side = state.activeSide ?? "home";
        proc.dive = divingCatchers(state, proc.square).length > 0 ? [first, other(first)] : [];
      }
      const side = proc.dive[0];
      if (side !== undefined) {
        const choices = bombDivers(state, proc.square, side);
        if (choices.length === 0) {
          proc.dive.shift();
          return "continue";
        }
        if (action === null) return "wait";
        const { playerIds } = ctx.expect(action, "SELECT_PLAYERS");
        const id = playerIds[0];
        if (playerIds.length > 1 || (id !== undefined && !choices.some((c) => c.id === id))) ctx.reject("Invalid catcher.");
        if (id === undefined) {
          proc.dive.shift();
          return "continue";
        }
        proc.dive = [];
        const diver = getPlayer(ctx, id);
        const from = squareOf(ctx, diver);
        if (!sameSquare(from, proc.square)) {
          ctx.emit({ type: "SkillUsed", playerId: id, skill: "Diving Catch" });
          proc.square = { ...from };
        }
        return "continue";
      }
    }
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
      const accurate = !proc.scattered && !proc.bounced;
      const modifier = catchModifier(state, { ...player, at: squareOf(ctx, player) }, !accurate) + (accurate && hasSkill(player, "Diving Catch") ? 1 : 0);
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
    delete proc.dive;
    return "continue";
  },
  actions(state, proc) {
    const side = proc.dive?.[0];
    if (side !== undefined) {
      const playerIds = bombDivers(state, proc.square, side).map((p) => p.id);
      return [{ type: "SELECT_PLAYERS", side, playerIds, max: 1, reason: "Diving Catch: choose a player to catch the bomb" }];
    }
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
