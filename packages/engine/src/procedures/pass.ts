import type { Ctx, Handler } from "../context";
import type { GameState, PassRange, PassResult, PlayerState, Procedure, Square } from "../types";
import { SCATTER, passes } from "../dice";
import { adjacent, allSquares, ballCarrier, hasTackleZone, inBounds, isOnPitch, other, playerAt, sameSquare, tackleZones, teamPlayers } from "../pitch";
import { hasSkill, skillName } from "../skills";
import { explosion, rethrow } from "./bomb";
import { canTeamReroll, canUsePro, proTemplate, proTemplates, stepPro, checkTouchdown, disturbingPresences, getPlayer, landBall, lonerRollTemplate, lonerTarget, rerollsLeft, rollLoner, squareOf, useTeamReroll } from "./helpers";

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

/** Nerves of Steel: tackle zones do not count for the player's passes, catches and interceptions. */
export const markingZones = (state: GameState, player: PlayerState & { at: Square }) =>
  hasSkill(player, "Nerves of Steel") ? 0 : tackleZones(state, player.side, player.at);

/**
 * Everything added to the thrower's PA: range, tackle zones on the thrower (not with Nerves of Steel, unless throwing a
 * team-mate), Very Sunny, Disturbing Presence.
 */
export function passModifiers(state: GameState, thrower: PlayerState & { at: Square }, range: PassRange, teamMate = false) {
  const zones = teamMate ? tackleZones(state, thrower.side, thrower.at) : markingZones(state, thrower);
  return RANGE_MODIFIER[range] + zones + (state.weather === "very-sunny" ? 1 : 0) + disturbingPresences(state, thrower);
}

/** The D6 roll needed for an accurate pass, or null without PA. */
export const neededForPass = (thrower: PlayerState, modifiers: number) =>
  thrower.pa === null ? null : Math.max(2, thrower.pa + modifiers);

/** The needed roll as shown to the coach: a natural 6 is always accurate, and a player without PA needs one too. */
export const shownNeeded = (thrower: PlayerState, modifiers: number) => Math.min(6, neededForPass(thrower, modifiers) ?? 6);

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

/**
 * Opponents under the ruler exerting a tackle zone (standing, not distracted) who may try to intercept. Cloud Burster:
 * nobody may intercept the thrower's passes (or bombs), except a player with Very Long Legs.
 */
export function interceptors(state: GameState, thrower: PlayerState, target: Square) {
  if (!isOnPitch(thrower)) return [];
  const cloudBurster = hasSkill(thrower, "Cloud Burster");
  return teamPlayers(state, other(thrower.side)).filter(
    (p): p is PlayerState & { at: Square } =>
      isOnPitch(p) && hasTackleZone(p) && !hasSkill(p, "No Ball") && underRuler(thrower.at, target, p.at) && (!cloudBurster || hasSkill(p, "Very Long Legs")),
  );
}

/**
 * BB2025 interception target: AG +3 accurate / +2 inaccurate, +1 per tackle
 * zone (not with Nerves of Steel), +1 in Pouring Rain, +1 per Disturbing Presence.
 */
export const interceptionTarget = (state: GameState, interceptor: PlayerState & { at: Square }, result: PassResult) =>
  Math.max(
    2,
    interceptor.ag +
      (result === "accurate" ? 3 : 2) +
      markingZones(state, interceptor) +
      (state.weather === "pouring-rain" ? 1 : 0) +
      disturbingPresences(state, interceptor),
  );

/** Pass: the thrower may re-roll an inaccurate pass or a fumble with the skill instead of a team re-roll. */
const passSkillReroll = (thrower: PlayerState, proc: P<"Pass">) => !proc.rerolled && hasSkill(thrower, "Pass");

/** Animosity is overcome on 2+. */
export const ANIMOSITY_TARGET = 2;

/**
 * Animosity(X): the thrower dislikes team-mates with keyword X ("Animosity" alone: all team-mates). Several keywords
 * may be separated by ";".
 */
export function dislikes(thrower: PlayerState, receiver: PlayerState | undefined): boolean {
  const skill = thrower.skills.find((s) => skillName(s) === "Animosity");
  if (!skill || !receiver || receiver.side !== thrower.side || receiver.id === thrower.id) return false;
  const value = /\((.*)\)$/.exec(skill)?.[1]?.trim().toLowerCase();
  if (!value || value === "all") return true;
  return value.split(";").some((k) => receiver.keywords.includes(k.trim()));
}

/** Push the Animosity roll before a pass or hand-off to a disliked team-mate; false when there is none. */
function rollAnimosity(ctx: Ctx, thrower: PlayerState, receiver: PlayerState | undefined): boolean {
  ctx.state.lastCheck = null;
  if (!dislikes(thrower, receiver)) return false;
  ctx.push({ type: "Check", kind: "animosity", playerId: thrower.id, target: ANIMOSITY_TARGET, modifier: 0, stage: "roll", rerolled: false });
  return true;
}

/** A failed Animosity roll: the ball is not released and the action ends, without a turnover. */
const animosityFailed = (state: GameState) => state.lastCheck?.kind === "animosity" && !state.lastCheck.success;

/** After a pass or hand-off: a turnover unless a team-mate of the thrower holds the ball. */
function endBallAction(ctx: Ctx, thrower: PlayerState) {
  const carrier = ballCarrier(ctx.state);
  if (carrier) checkTouchdown(ctx, carrier);
  if (!carrier || carrier.side !== thrower.side) ctx.state.turnover = true;
}

/**
 * A thrown pass (BB2025), or a bomb (Throw Bomb: thrown like a pass, without Animosity or On the Ball; a fumble
 * explodes on the thrower, an intercepted bomb is thrown again by the interceptor, and it lands with `BombLanding`): Animosity towards the receiver, On the Ball moves of the opponents, PA roll with a team re-roll,
 * fumble (Safe Pass: the thrower may keep the ball on a natural 1, ending the action without a turnover) / inaccurate scatter,
 * one interception attempt under the ruler, then the ball lands and may be caught.
 */
export const Pass: Handler<P<"Pass">> = {
  step(ctx, proc, action) {
    const { state } = ctx;
    const thrower = getPlayer(ctx, proc.throwerId);
    const at = squareOf(ctx, thrower);
    const modifiers = passModifiers(state, { ...thrower, at }, proc.range);
    switch (proc.stage) {
      case "aim": {
        // The player who caught the bomb throws it again straight away.
        if (action === null) return "wait";
        const { square } = ctx.expect(action, "THROW");
        const to = throwTargets(state, thrower).find((s) => sameSquare(s, square)) ?? ctx.reject("Cannot throw there.");
        proc.target = { x: to.x, y: to.y };
        proc.range = to.range;
        proc.stage = "animosity";
        return "continue";
      }
      case "animosity":
        // A failed Bloodlust feeding before the throw ends the action.
        if (state.turnover && !proc.bomb) return "done";
        if (!proc.bomb) rollAnimosity(ctx, thrower, playerAt(state, proc.target));
        else state.lastCheck = null;
        proc.stage = "animosityResult";
        return "continue";
      case "animosityResult":
        if (animosityFailed(state)) return "done";
        ctx.emit({ type: "PassThrown", playerId: thrower.id, target: { ...proc.target }, range: proc.range, ...(proc.bomb ? { bomb: true } : {}) });
        // On the Ball: the opponents may move before the throw (not for a bomb).
        if (!proc.bomb) ctx.push({ type: "OnTheBall", side: other(thrower.side), kickoff: false, stage: "select", moved: [] });
        proc.stage = "roll";
        return "continue";
      case "roll": {
        if (thrower.pa === null) {
          // No Passing Ability: the pass is fumbled automatically.
          proc.result = "fumble";
          proc.stage = "outcome";
          return "continue";
        }
        if (action === null) return "wait";
        const [roll] = ctx.roll(action, [{ kind: "d6", count: 1 }], `Pass ${shownNeeded(thrower, modifiers)}+`);
        proc.roll = roll!;
        proc.result = evaluatePass(thrower, roll!, modifiers);
        ctx.emit({ type: "PassResult", playerId: thrower.id, result: proc.result });
        const canReroll = passSkillReroll(thrower, proc) || canTeamReroll(state, thrower.side, proc.rerolled) || canUsePro(state, thrower, proc.rerolled);
        proc.stage = proc.result !== "accurate" && canReroll ? "reroll" : "outcome";
        return "continue";
      }
      case "reroll": {
        if (action === null) return "wait";
        const a = ctx.expect(action, "USE_REROLL", "DECLINE_REROLL", "USE_SKILL");
        if (a.type === "USE_SKILL" && a.use) {
          if ((a.skill ?? "Pro") !== "Pro" || !canUsePro(state, thrower, proc.rerolled)) ctx.reject("Pro cannot be used now.");
          proc.rerolled = true;
          proc.stage = "pro";
        } else if (a.type === "USE_REROLL" && passSkillReroll(thrower, proc)) {
          // A skill re-roll: no team re-roll is spent, so Loner does not apply.
          ctx.emit({ type: "SkillUsed", playerId: thrower.id, skill: "Pass" });
          proc.rerolled = true;
          proc.stage = "roll";
        } else if (a.type === "USE_REROLL") {
          if (!canTeamReroll(state, thrower.side, proc.rerolled)) ctx.reject("No re-roll available.");
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
      case "pro":
      case "proTeam":
      case "proLoner": {
        if (action === null) return "wait";
        const pro = stepPro(ctx, proc, action, thrower);
        if (pro !== "wait") proc.stage = pro === "reroll" ? "roll" : "outcome";
        return "continue";
      }
      case "outcome":
        if (proc.result === "fumble" && proc.roll === 1 && hasSkill(thrower, "Safe Pass")) {
          proc.stage = "safePass";
          return "continue";
        }
        if (proc.result === "fumble" && proc.bomb) {
          // A fumbled bomb explodes in the thrower's square.
          ctx.push(explosion(state, at));
          proc.stage = "end";
          return "continue";
        }
        if (proc.result === "fumble") {
          // The ball bounces from the thrower's square.
          state.ball = { square: { ...at }, carried: false };
          state.turnover = true;
          ctx.push({ type: "Bounce", from: { ...at }, kickoff: false, receiving: null });
          proc.stage = "end";
          return "continue";
        }
        if (!proc.bomb) state.ball = { square: null, carried: false };
        proc.landing = { ...proc.target };
        proc.stage = proc.result === "inaccurate" ? "scatter" : "intercept";
        return "continue";
      case "safePass":
        if (action === null) return "wait";
        if (ctx.expect(action, "USE_SKILL").use) {
          // The thrower keeps the ball (or the bomb does not go off) and the action ends, without a turnover.
          ctx.emit({ type: "SkillUsed", playerId: thrower.id, skill: "Safe Pass" });
          if (proc.bomb) ctx.emit({ type: "BombLost" });
          proc.stage = "end";
        } else {
          proc.result = "fumble";
          delete proc.roll;
          proc.stage = "outcome";
        }
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
        if (passes(roll!, 0, target) && proc.bomb) {
          // An intercepted bomb must be thrown again by the interceptor.
          ctx.emit({ type: "Intercepted", playerId: interceptor.id });
          ctx.push(rethrow(interceptor.id));
          proc.stage = "end";
        } else if (passes(roll!, 0, target)) {
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
        if (proc.bomb && proc.throwInFrom) ctx.emit({ type: "BombLost" });
        else if (proc.bomb) ctx.push({ type: "BombLanding", square: proc.landing!, scattered: proc.result === "inaccurate", bounced: false, stage: "land" });
        else if (proc.throwInFrom) ctx.push({ type: "ThrowIn", from: proc.throwInFrom });
        else {
          landBall(ctx, proc.landing!, proc.landing!, {
            kickoff: false,
            receiving: null,
            bounceIfEmpty: true,
            scattered: proc.result === "inaccurate",
            divingCatch: true,
            accurate: proc.result === "accurate",
          });
        }
        proc.stage = "end";
        return "continue";
      case "end":
        // A bomb only causes a turnover by knocking down the team's players.
        if (!proc.bomb) endBallAction(ctx, thrower);
        return "done";
    }
  },
  actions(state, proc) {
    const thrower = state.players[proc.throwerId]! as PlayerState & { at: Square };
    switch (proc.stage) {
      case "aim":
        return [{ type: "THROW", side: thrower.side, playerId: thrower.id, squares: throwTargets(state, thrower) }];
      case "roll": {
        const needed = shownNeeded(thrower, passModifiers(state, thrower, proc.range));
        return [{ type: "ROLL", side: thrower.side, dice: [{ kind: "d6", count: 1 }], reason: `Pass ${needed}+ (${proc.range})` }];
      }
      case "reroll":
        return [
          ...(passSkillReroll(thrower, proc) || canTeamReroll(state, thrower.side, proc.rerolled)
            ? [{ type: "USE_REROLL" as const, side: thrower.side, available: rerollsLeft(state, thrower.side), ...(passSkillReroll(thrower, proc) ? { skill: "Pass" } : {}) }]
            : []),
          ...proTemplate(state, thrower, proc.rerolled),
          { type: "DECLINE_REROLL", side: thrower.side },
        ];
      case "loner":
        return [lonerRollTemplate(thrower)];
      case "pro":
      case "proTeam":
      case "proLoner":
        return proTemplates(state, proc.stage, thrower);
      case "safePass":
        return [{ type: "USE_SKILL", side: thrower.side, playerId: thrower.id, skill: "Safe Pass" }];
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

/** Hand-off: Animosity towards the receiver, then the ball goes to the adjacent team-mate, who rolls to catch it (no scatter modifier). */
export const HandOff: Handler<P<"HandOff">> = {
  step(ctx, proc) {
    const thrower = getPlayer(ctx, proc.throwerId);
    if (proc.stage === "animosity") {
      if (ctx.state.turnover) return "done";
      rollAnimosity(ctx, thrower, getPlayer(ctx, proc.catcherId));
      proc.stage = "animosityResult";
      return "continue";
    }
    if (proc.stage === "animosityResult") {
      if (animosityFailed(ctx.state)) return "done";
      proc.stage = "catch";
      return "continue";
    }
    if (proc.stage === "catch") {
      const catcher = getPlayer(ctx, proc.catcherId);
      ctx.state.ball = { square: { ...squareOf(ctx, catcher) }, carried: false };
      ctx.emit({ type: "HandedOff", playerId: thrower.id, targetId: catcher.id });
      // The receiver may have been bitten (Bloodlust) and be down: the ball bounces.
      if (catcher.status === "standing") ctx.push({ type: "Catch", playerId: catcher.id, kickoff: false, scattered: false, stage: "check" });
      else ctx.push({ type: "Bounce", from: { ...squareOf(ctx, catcher) }, kickoff: false, receiving: null });
      proc.stage = "end";
      return "continue";
    }
    endBallAction(ctx, thrower);
    return "done";
  },
  actions: () => [],
};
