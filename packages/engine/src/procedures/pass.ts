import type { Ctx, Handler } from "../context";
import type { GameState, PassRange, PassResult, PlayerState, Procedure, Square } from "../types";
import { SCATTER, passes } from "../dice";
import { adjacent, allSquares, ballCarrier, inBounds, isOnPitch, other, playerAt, sameSquare, tackleZones, teamPlayers } from "../pitch";
import { hasSkill } from "../skills";
import { canTeamReroll, checkTouchdown, getPlayer, landBall, lonerRollTemplate, lonerTarget, rerollsLeft, rollLoner, squareOf, useTeamReroll } from "./helpers";

type P<T extends Procedure["type"]> = Extract<Procedure, { type: T }>;

/** BB2025 throwing range table, indexed by [|dy|][|dx|] from the thrower. */
const RANGE_TABLE = [
  "T Q Q Q S S S L L L L B B B",
  "Q Q Q Q S S S L L L L B B B",
  "Q Q Q S S S S L L L L B B B",
  "Q Q S S S S S L L L B B B  ",
  "S S S S S S L L L L B B B  ",
  "S S S S S L L L L B B B    ",
  "S S S S L L L L L B B B    ",
  "L L L L L L L L B B B      ",
  "L L L L L L L B B B B      ",
  "L L L L L B B B B B        ",
  "L L L B B B B B B          ",
  "B B B B B B B              ",
  "B B B B B                  ",
  "B B B                      ",
];
const RANGES: Record<string, PassRange> = { Q: "quick", S: "short", L: "long", B: "bomb" };

/** Added to the PA target number. */
export const RANGE_MODIFIER: Record<PassRange, number> = { quick: 0, short: 1, long: 2, bomb: 3 };

/** Range of a pass between two squares, or null when out of range (or too far for a blizzard). */
export function passRange(state: GameState, from: Square, to: Square): PassRange | null {
  const dx = Math.abs(to.x - from.x);
  const dy = Math.abs(to.y - from.y);
  if (dx > 13 || dy > 13) return null;
  const range = RANGES[RANGE_TABLE[dy]![dx * 2]!] ?? null;
  // Blizzard: only Quick and Short passes.
  if (state.weather === "blizzard" && (range === "long" || range === "bomb")) return null;
  return range;
}

/** Everything added to the thrower's PA: range, tackle zones on the thrower, Very Sunny. */
export function passModifiers(state: GameState, thrower: PlayerState & { at: Square }, range: PassRange) {
  return RANGE_MODIFIER[range] + tackleZones(state, thrower.side, thrower.at) + (state.weather === "very-sunny" ? 1 : 0);
}

/** The D6 roll needed for an accurate pass, or null without PA. */
export const neededForPass = (thrower: PlayerState, modifiers: number) =>
  thrower.pa === null ? null : Math.max(2, thrower.pa + modifiers);

/** The needed roll as shown to the coach: a natural 6 is always accurate, and a player without PA needs one too. */
const shownNeeded = (thrower: PlayerState, modifiers: number) => Math.min(6, neededForPass(thrower, modifiers) ?? 6);

/** BB2025 pass result: there is no "wildly inaccurate" result any more. */
export function evaluatePass(thrower: PlayerState, roll: number, modifiers: number): PassResult {
  if (thrower.pa === null || roll === 1) return "fumble";
  const result = roll - modifiers;
  if (roll === 6 || result >= thrower.pa) return "accurate";
  return result <= 1 ? "fumble" : "inaccurate";
}

/** Every square the player could throw to, with its range and the roll needed. */
export function throwTargets(state: GameState, thrower: PlayerState) {
  if (!isOnPitch(thrower)) return [];
  return allSquares((s) => !sameSquare(s, thrower.at)).flatMap((s) => {
    const range = passRange(state, thrower.at, s);
    return range ? [{ ...s, range, needed: shownNeeded(thrower, passModifiers(state, thrower, range)) }] : [];
  });
}

/** Can intercept: the player stands under the range ruler between thrower and target. */
export function underRuler(thrower: Square, target: Square, player: Square): boolean {
  const rx = target.x - thrower.x;
  const ry = target.y - thrower.y;
  const ix = player.x - thrower.x;
  const iy = player.y - thrower.y;
  const a = (rx - ix) ** 2 + (ry - iy) ** 2;
  const b = ix ** 2 + iy ** 2;
  const c = rx ** 2 + ry ** 2;
  const d = Math.min(
    Math.abs(ry * (ix + 0.5) - rx * (iy + 0.5)),
    Math.abs(ry * (ix + 0.5) - rx * (iy - 0.5)),
    Math.abs(ry * (ix - 0.5) - rx * (iy + 0.5)),
    Math.abs(ry * (ix - 0.5) - rx * (iy - 0.5)),
  );
  return c > a && c > b && 1.74 > (2 * d) / Math.sqrt(c);
}

/** Standing opponents under the ruler who may try to intercept. */
export function interceptors(state: GameState, thrower: PlayerState, target: Square) {
  if (!isOnPitch(thrower)) return [];
  return teamPlayers(state, other(thrower.side)).filter(
    (p): p is PlayerState & { at: Square } => isOnPitch(p) && p.status === "standing" && !hasSkill(p, "No Ball") && underRuler(thrower.at, target, p.at),
  );
}

/**
 * BB2025 interception target: AG +3 accurate / +2 inaccurate, +1 per tackle
 * zone, +1 in Pouring Rain.
 */
export const interceptionTarget = (state: GameState, interceptor: PlayerState & { at: Square }, result: PassResult) =>
  Math.max(
    2,
    interceptor.ag +
      (result === "accurate" ? 3 : 2) +
      tackleZones(state, interceptor.side, interceptor.at) +
      (state.weather === "pouring-rain" ? 1 : 0),
  );

/** After a pass or hand-off: a turnover unless a team-mate of the thrower holds the ball. */
function endBallAction(ctx: Ctx, thrower: PlayerState) {
  const carrier = ballCarrier(ctx.state);
  if (carrier) checkTouchdown(ctx, carrier);
  if (!carrier || carrier.side !== thrower.side) ctx.state.turnover = true;
}

/**
 * A thrown pass (BB2025): PA roll with a team re-roll, fumble / inaccurate scatter, one
 * interception attempt under the ruler, then the ball lands and may be caught.
 */
export const Pass: Handler<P<"Pass">> = {
  step(ctx, proc, action) {
    const { state } = ctx;
    const thrower = getPlayer(ctx, proc.throwerId);
    const at = squareOf(ctx, thrower);
    const modifiers = passModifiers(state, { ...thrower, at }, proc.range);
    switch (proc.stage) {
      case "roll": {
        if (thrower.pa === null) {
          // No Passing Ability: the pass is fumbled automatically.
          proc.result = "fumble";
          proc.stage = "outcome";
          return "continue";
        }
        if (action === null) return "wait";
        const [roll] = ctx.roll(action, [{ kind: "d6", count: 1 }], `Pass ${shownNeeded(thrower, modifiers)}+`);
        proc.result = evaluatePass(thrower, roll!, modifiers);
        ctx.emit({ type: "PassResult", playerId: thrower.id, result: proc.result });
        proc.stage = proc.result !== "accurate" && canTeamReroll(state, thrower.side, proc.rerolled) ? "reroll" : "outcome";
        return "continue";
      }
      case "reroll": {
        if (action === null) return "wait";
        const a = ctx.expect(action, "USE_REROLL", "DECLINE_REROLL");
        if (a.type === "USE_REROLL") {
          useTeamReroll(ctx, thrower.side);
          proc.rerolled = true;
          proc.stage = lonerTarget(thrower) === null ? "roll" : "loner";
        } else proc.stage = "outcome";
        return "continue";
      }
      case "loner":
        if (action === null) return "wait";
        // A failed Loner roll keeps the first pass result.
        proc.stage = rollLoner(ctx, action, thrower) ? "roll" : "outcome";
        return "continue";
      case "outcome":
        if (proc.result === "fumble") {
          // The ball bounces from the thrower's square.
          state.ball = { square: { ...at }, carried: false };
          state.turnover = true;
          ctx.push({ type: "Bounce", from: { ...at }, kickoff: false, receiving: null });
          proc.stage = "end";
          return "continue";
        }
        state.ball = { square: null, carried: false };
        proc.landing = { ...proc.target };
        proc.stage = proc.result === "inaccurate" ? "scatter" : "intercept";
        return "continue";
      case "scatter": {
        if (action === null) return "wait";
        // An inaccurate pass scatters three times from the target square.
        const directions = ctx.roll(action, [{ kind: "d8", count: 3 }], "Inaccurate pass");
        let landing = proc.target;
        for (const d of directions) {
          const next = { x: landing.x + SCATTER[d]!.x, y: landing.y + SCATTER[d]!.y };
          if (!inBounds(next)) {
            proc.throwInFrom = { ...landing };
            break;
          }
          landing = next;
        }
        proc.landing = { ...landing };
        ctx.emit({ type: "BallScattered", to: landing });
        proc.stage = "intercept";
        return "continue";
      }
      case "intercept": {
        const candidates = interceptors(state, thrower, proc.landing!);
        if (candidates.length === 0) {
          proc.stage = "land";
          return "continue";
        }
        if (action === null) return "wait";
        const { playerIds } = ctx.expect(action, "SELECT_PLAYERS");
        const id = playerIds[0];
        if (playerIds.length > 1 || (id !== undefined && !candidates.some((c) => c.id === id))) ctx.reject("Invalid interceptor.");
        if (id === undefined) proc.stage = "land";
        else {
          proc.interceptorId = id;
          proc.stage = "interceptRoll";
        }
        return "continue";
      }
      case "interceptRoll": {
        if (action === null) return "wait";
        const interceptor = getPlayer(ctx, proc.interceptorId!);
        const square = squareOf(ctx, interceptor);
        const target = interceptionTarget(state, { ...interceptor, at: square }, proc.result!);
        const [roll] = ctx.roll(action, [{ kind: "d6", count: 1 }], `Interception ${Math.min(6, target)}+`);
        if (passes(roll!, 0, target)) {
          state.ball = { square: { ...square }, carried: true };
          ctx.emit({ type: "Intercepted", playerId: interceptor.id });
          proc.stage = "end";
        } else {
          ctx.emit({ type: "InterceptionFailed", playerId: interceptor.id });
          proc.stage = "land";
        }
        return "continue";
      }
      case "land":
        if (proc.throwInFrom) ctx.push({ type: "ThrowIn", from: proc.throwInFrom });
        else {
          landBall(ctx, proc.landing!, proc.landing!, {
            kickoff: false,
            receiving: null,
            bounceIfEmpty: true,
            scattered: proc.result === "inaccurate",
          });
        }
        proc.stage = "end";
        return "continue";
      case "end":
        endBallAction(ctx, thrower);
        return "done";
    }
  },
  actions(state, proc) {
    const thrower = state.players[proc.throwerId]! as PlayerState & { at: Square };
    switch (proc.stage) {
      case "roll": {
        const needed = shownNeeded(thrower, passModifiers(state, thrower, proc.range));
        return [{ type: "ROLL", side: thrower.side, dice: [{ kind: "d6", count: 1 }], reason: `Pass ${needed}+ (${proc.range})` }];
      }
      case "reroll":
        return [
          { type: "USE_REROLL", side: thrower.side, available: rerollsLeft(state, thrower.side) },
          { type: "DECLINE_REROLL", side: thrower.side },
        ];
      case "loner":
        return [lonerRollTemplate(thrower)];
      case "scatter":
        return [{ type: "ROLL", side: null, dice: [{ kind: "d8", count: 3 }], reason: "Inaccurate pass" }];
      case "intercept":
        return [
          {
            type: "SELECT_PLAYERS",
            side: other(thrower.side),
            playerIds: interceptors(state, thrower, proc.landing!).map((p) => p.id),
            max: 1,
            reason: "Interception: choose a player to try to intercept",
          },
        ];
      case "interceptRoll": {
        const interceptor = state.players[proc.interceptorId!]! as PlayerState & { at: Square };
        const target = interceptionTarget(state, interceptor, proc.result!);
        return [{ type: "ROLL", side: interceptor.side, dice: [{ kind: "d6", count: 1 }], reason: `Interception ${Math.min(6, target)}+ (${interceptor.name})` }];
      }
      default:
        return [];
    }
  },
};

/** Standing team-mates next to the ball carrier who can receive a hand-off. */
export function handOffTargets(state: GameState, player: PlayerState) {
  if (!isOnPitch(player)) return [];
  return adjacent(player.at)
    .map((s) => playerAt(state, s))
    .filter((p): p is PlayerState => p !== undefined && p.side === player.side && p.status === "standing" && !hasSkill(p, "No Ball"));
}

/** Hand-off: the ball goes to the adjacent team-mate, who rolls to catch it (no scatter modifier). */
export const HandOff: Handler<P<"HandOff">> = {
  step(ctx, proc) {
    const thrower = getPlayer(ctx, proc.throwerId);
    if (proc.stage === "catch") {
      const catcher = getPlayer(ctx, proc.catcherId);
      ctx.state.ball = { square: { ...squareOf(ctx, catcher) }, carried: false };
      ctx.emit({ type: "HandedOff", playerId: thrower.id, targetId: catcher.id });
      ctx.push({ type: "Catch", playerId: catcher.id, kickoff: false, scattered: false, stage: "check" });
      proc.stage = "end";
      return "continue";
    }
    endBallAction(ctx, thrower);
    return "done";
  },
  actions: () => [],
};
