import type { Handler } from "../context";
import type { DiceSpec, GameState, PlayerState, Procedure, Side, Square } from "../types";
import { SCATTER, isCorner, throwInDirection } from "../dice";
import { adjacent, inBounds, isOnPitch, offset, playerAt, sameSquare, teamPlayers } from "../pitch";
import { hasSkill } from "../skills";
import { checkTouchdown, disturbingPresences, getPlayer, landBall, squareOf, weatherModifier } from "./helpers";
import { markingZones } from "./pass";

type P<T extends Procedure["type"]> = Extract<Procedure, { type: T }>;

/** Standing players of the receiving team: any of them may be given the ball. */
const touchbackCandidates = (state: GameState, side: Side) =>
  teamPlayers(state, side).filter((p) => isOnPitch(p) && p.status === "standing");

/** The kick-off left the receiving half: the receiving coach gives the ball to one of their standing players. */
export const Touchback: Handler<P<"Touchback">> = {
  step(ctx, proc, action) {
    if (touchbackCandidates(ctx.state, proc.side).length === 0) return "done";
    if (action === null) return "wait";
    const player = getPlayer(ctx, ctx.expect(action, "GIVE_BALL").playerId);
    if (!touchbackCandidates(ctx.state, proc.side).some((p) => p.id === player.id)) {
      ctx.reject(`${player.name} cannot receive the ball.`);
    }
    ctx.state.ball = { square: { ...squareOf(ctx, player) }, carried: true };
    ctx.emit({ type: "Touchback", playerId: player.id });
    return "done";
  },
  actions(state, proc) {
    return [{ type: "GIVE_BALL", side: proc.side, playerIds: touchbackCandidates(state, proc.side).map((p) => p.id) }];
  },
};

/** The ball bounces one square in a d8 direction. */
export const Bounce: Handler<P<"Bounce">> = {
  step(ctx, proc, action) {
    if (action === null) return "wait";
    const [direction] = ctx.roll(action, [{ kind: "d8", count: 1 }], "Bounce");
    const to = offset(proc.from, SCATTER[direction!]!);
    if (inBounds(to)) ctx.emit({ type: "BallBounced", to });
    landBall(ctx, to, proc.from, { kickoff: proc.kickoff, receiving: proc.receiving, bounceIfEmpty: false, scattered: true });
    return "done";
  },
  actions(state) {
    return [{ type: "ROLL", side: state.activeSide, dice: [{ kind: "d8", count: 1 }], reason: "Bounce" }];
  },
};

/** Direction (d3 in the corners, d6 otherwise) then distance (2D6). */
const throwInDice = (from: Square): DiceSpec[] => [
  { kind: isCorner(from) ? "d3" : "d6", count: 1 },
  { kind: "d6", count: 2 },
];

/**
 * The crowd throws the ball back from the last square it was on. In BB2025 that square counts
 * as the first of the 2D6, so the ball ends 2D6-1 squares away.
 */
export const ThrowIn: Handler<P<"ThrowIn">> = {
  step(ctx, proc, action) {
    if (action === null) return "wait";
    const [direction, d1, d2] = ctx.roll(action, throwInDice(proc.from), "Throw-in");
    const dir = throwInDirection(proc.from, direction!);
    const to = offset(proc.from, dir, d1! + d2! - 1);
    if (!inBounds(to)) {
      let last = proc.from;
      while (inBounds(offset(last, dir))) last = offset(last, dir);
      ctx.state.ball = { square: null, carried: false };
      ctx.push({ type: "ThrowIn", from: last });
      return "done";
    }
    ctx.emit({ type: "BallThrownIn", to });
    landBall(ctx, to, to, { kickoff: false, receiving: null, bounceIfEmpty: true, scattered: false });
    return "done";
  },
  actions(_state, proc) {
    return [{ type: "ROLL", side: null, dice: throwInDice(proc.from), reason: "Throw-in" }];
  },
};

/** Catch roll modifier: tackle zones (none with Nerves of Steel), -1 after a bounce or scatter, weather, Disturbing Presence. */
export const catchModifier = (state: GameState, player: PlayerState & { at: Square }, scattered: boolean) =>
  -markingZones(state, player) - (scattered ? 1 : 0) + weatherModifier(state, "catch") - disturbingPresences(state, player);

/**
 * A standing player tries to catch the ball on their square (AG, tackle zones unless they have Nerves of Steel, weather,
 * Disturbing Presence); a failure bounces it.
 * A distracted player cannot catch: the ball bounces straight away.
 */
export const Catch: Handler<P<"Catch">> = {
  step(ctx, proc) {
    const { state } = ctx;
    const player = getPlayer(ctx, proc.playerId);
    const square = squareOf(ctx, player);
    if (proc.stage === "check" && player.distracted) {
      state.lastCheck = null;
      proc.stage = "resolve";
      return "continue";
    }
    if (proc.stage === "check") {
      state.lastCheck = null;
      proc.stage = "resolve";
      ctx.push({
        type: "Check",
        kind: "catch",
        playerId: player.id,
        target: player.ag,
        modifier: catchModifier(state, { ...player, at: square }, proc.scattered),
        stage: "roll",
        rerolled: false,
      });
      return "continue";
    }
    if (state.lastCheck?.success) {
      state.ball = { square: { ...square }, carried: true };
      ctx.emit({ type: "BallCaught", playerId: player.id });
      checkTouchdown(ctx, player);
    } else {
      ctx.push({ type: "Bounce", from: { ...square }, kickoff: proc.kickoff, receiving: proc.kickoff ? player.side : null });
    }
    return "done";
  },
  actions: () => [],
};

/** Safe Pair of Hands: free squares next to where the ball was dropped. */
const safeHandsSquares = (state: GameState, square: Square) => adjacent(square).filter((s) => !playerAt(state, s));

/**
 * What happens to the ball a player drops: it bounces, unless they were knocked down or placed prone (not fell over)
 * and have Safe Pair of Hands.
 */
export function dropBall(player: PlayerState, square: Square, knockedDown = true): Procedure {
  return knockedDown && hasSkill(player, "Safe Pair of Hands")
    ? { type: "SafeHands", playerId: player.id, square: { ...square }, stage: "ask" }
    : { type: "Bounce", from: { ...square }, kickoff: false, receiving: null };
}

/**
 * Safe Pair of Hands: a player knocked down or placed prone with the ball (and not distracted) may place it on a free
 * adjacent square, where it stays, instead of letting it bounce; there is no catch roll.
 */
export const SafeHands: Handler<P<"SafeHands">> = {
  step(ctx, proc, action) {
    const { state } = ctx;
    const player = getPlayer(ctx, proc.playerId);
    const squares = safeHandsSquares(state, proc.square);
    if (squares.length === 0 || player.distracted) {
      ctx.push({ type: "Bounce", from: { ...proc.square }, kickoff: false, receiving: null });
      return "done";
    }
    if (action === null) return "wait";
    if (proc.stage === "ask") {
      if (!ctx.expect(action, "USE_SKILL").use) {
        ctx.push({ type: "Bounce", from: { ...proc.square }, kickoff: false, receiving: null });
        return "done";
      }
      proc.stage = "place";
      return "wait";
    }
    const { square } = ctx.expect(action, "PLACE_BALL");
    if (!squares.some((s) => sameSquare(s, square))) ctx.reject("The ball must be placed on a free adjacent square.");
    state.ball = { square: { ...square }, carried: false };
    ctx.emit({ type: "SkillUsed", playerId: player.id, skill: "Safe Pair of Hands" });
    return "done";
  },
  actions(state, proc) {
    const player = state.players[proc.playerId]!;
    if (proc.stage === "ask") return [{ type: "USE_SKILL", side: player.side, playerId: player.id, skill: "Safe Pair of Hands" }];
    return [{ type: "PLACE_BALL", side: player.side, squares: safeHandsSquares(state, proc.square) }];
  },
};
