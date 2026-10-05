import type { Handler } from "../context";
import type { DiceSpec, GameState, Procedure, Side, Square } from "../types";
import { SCATTER, isCorner, throwInDirection } from "../dice";
import { inBounds, isOnPitch, offset, tackleZones, teamPlayers } from "../pitch";
import { checkTouchdown, disturbingPresences, getPlayer, landBall, squareOf, weatherModifier } from "./helpers";

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

/**
 * A standing player tries to catch the ball on their square (AG, tackle zones, weather, Disturbing Presence); a failure
 * bounces it.
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
        modifier: -tackleZones(state, player.side, square) - (proc.scattered ? 1 : 0) + weatherModifier(state, "catch") - disturbingPresences(state, player),
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
