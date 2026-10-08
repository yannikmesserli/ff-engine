import type { Ctx, Handler } from "../context";
import type { GameState, PassRange, PassResult, PlayerState, Procedure, Square } from "../types";
import { SCATTER, passes, templateDirection } from "../dice";
import { adjacent, allSquares, ballCarrier, hasTackleZone, inBounds, isOnPitch, other, playerAt, sameSquare, tackleZones, teamPlayers } from "../pitch";
import { hasSkill, skillName } from "../skills";
import { explosion, rethrow } from "./bomb";
import { canTeamReroll, canUsePro, checkTouchdown, disturbingPresences, getPlayer, landBall, lonerRollTemplate, lonerTarget, mascotFailed, proTemplate, proTemplates, rerollGate, rerollsLeft, rollLoner, squareOf, stepPro, teamRerollTemplate, useTeamReroll } from "./helpers";

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

/** Accurate: +1 to the player's Quick and Short passes (not team-mate throws). */
const rangeSkill = (thrower: PlayerState, range: PassRange) =>
  (range === "quick" || range === "short") && hasSkill(thrower, "Accurate") ? 1 : 0;

/**
 * Everything added to the thrower's PA: range, tackle zones on the thrower (not with Nerves of Steel, unless throwing a
 * team-mate), Very Sunny, Disturbing Presence, Accurate.
 */
export function passModifiers(state: GameState, thrower: PlayerState & { at: Square }, range: PassRange, teamMate = false) {
  const zones = teamMate ? tackleZones(state, thrower.side, thrower.at) : markingZones(state, thrower);
  const skill = teamMate ? 0 : rangeSkill(thrower, range);
  return RANGE_MODIFIER[range] + zones + (state.weather === "very-sunny" ? 1 : 0) + disturbingPresences(state, thrower) - skill;
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

/** Hail Mary Pass: the roll needed not to fumble, rolled as a Long Bomb (a fumble on a modified 1 or less). */
export const hailMaryNeeded = (state: GameState, thrower: PlayerState & { at: Square }) =>
  thrower.pa === null ? 6 : Math.min(6, Math.max(2, 2 + passModifiers(state, thrower, "bomb")));

/** Hail Mary Pass: the thrower holds the ball in a Pass action, and it is not a blizzard. */
export const canHailMary = (state: GameState, thrower: PlayerState) => hasSkill(thrower, "Hail Mary Pass") && state.weather !== "blizzard";

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
 * zone (not with Nerves of Steel), +1 in Pouring Rain, +1 per Disturbing Presence, -1 with Extra Arms, -2 with Very Long Legs.
 */
export const interceptionTarget = (state: GameState, interceptor: PlayerState & { at: Square }, result: PassResult) =>
  Math.max(
    2,
    interceptor.ag +
      (result === "accurate" ? 3 : 2) +
      markingZones(state, interceptor) +
      (state.weather === "pouring-rain" ? 1 : 0) +
      disturbingPresences(state, interceptor) -
      (hasSkill(interceptor, "Extra Arms") ? 1 : 0) -
      (hasSkill(interceptor, "Very Long Legs") ? 2 : 0),
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

/** After a pass or hand-off: a turnover unless a team-mate of the thrower holds the ball (never after a Dump-off). */
function endBallAction(ctx: Ctx, thrower: PlayerState, dumpOff = false) {
  const carrier = ballCarrier(ctx.state);
  if (carrier) checkTouchdown(ctx, carrier);
  if (!dumpOff && (!carrier || carrier.side !== thrower.side)) ctx.state.turnover = true;
}

/**
 * Give and Go: after a Quick pass that was not fumbled, or a hand-off, without a turnover, the thrower's action goes on
 * as a move with the squares left.
 */
function giveAndGo(ctx: Ctx, thrower: PlayerState) {
  const { state } = ctx;
  if (state.turnover || state.touchdown !== null || !hasSkill(thrower, "Give and Go")) return;
  const activation = state.stack.findLast((p): p is P<"MoveAction"> => p.type === "MoveAction" && p.playerId === thrower.id);
  if (!activation) return;
  activation.finished = false;
  activation.released = true;
  ctx.emit({ type: "SkillUsed", playerId: thrower.id, skill: "Give and Go" });
}

/** Where the thrower may aim: Quick passes only for a Dump-off. */
const aimTargets = (state: GameState, thrower: PlayerState, proc: P<"Pass">) =>
  throwTargets(state, thrower).filter((s) => !proc.dumpOff || s.range === "quick");

/**
 * Hail Mary Pass: the target may be any square of the pitch, the roll counts as a Long Bomb, a result better than a
 * fumble is always inaccurate (three scatters from the target), only a fumble may be re-rolled, and nobody may intercept.
 * A thrown pass (BB2025), or a bomb (Throw Bomb: thrown like a pass, without Animosity or On the Ball; a fumble
 * explodes on the thrower, an intercepted bomb is thrown again by the interceptor, and it lands with `BombLanding`): Animosity towards the receiver, On the Ball moves of the opponents, PA roll with a team re-roll,
 * fumble (Safe Pass: the thrower may keep the ball on a natural 1, ending the action without a turnover) / inaccurate scatter,
 * one interception attempt under the ruler, then the ball lands and may be caught.
 */
export const Pass: Handler<P<"Pass">> = {
  step(ctx, proc, action) {
    const { state } = ctx;
    const thrower = getPlayer(ctx, proc.throwerId);
    // Looked up only while the thrower is on the pitch: a fumbled bomb may have taken them off it by the end.
    const throwerSquare = () => squareOf(ctx, thrower);
    switch (proc.stage) {
      case "aim": {
        // The player who caught the bomb throws it again straight away.
        if (action === null) return "wait";
        const { square } = ctx.expect(action, "THROW");
        const to = aimTargets(state, thrower, proc).find((s) => sameSquare(s, square)) ?? ctx.reject("Cannot throw there.");
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
        ctx.emit({ type: "PassThrown", playerId: thrower.id, target: { ...proc.target }, range: proc.range, ...(proc.bomb ? { bomb: true } : {}), ...(proc.hailMary ? { hailMary: true } : {}) });
        // On the Ball: the opponents may move before the throw (not for a bomb or a Dump-off).
        if (!proc.bomb && !proc.dumpOff) ctx.push({ type: "OnTheBall", side: other(thrower.side), kickoff: false, stage: "select", moved: [] });
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
        const at = throwerSquare();
        const modifiers = passModifiers(state, { ...thrower, at }, proc.range);
        const [roll] = ctx.roll(action, [{ kind: "d6", count: 1 }], proc.hailMary ? `Hail Mary Pass ${hailMaryNeeded(state, { ...thrower, at })}+` : `Pass ${shownNeeded(thrower, modifiers)}+`);
        proc.roll = roll!;
        proc.result = evaluatePass(thrower, roll!, modifiers);
        // A Hail Mary Pass is never accurate, and only a fumble is worth a re-roll.
        if (proc.hailMary && proc.result === "accurate") proc.result = "inaccurate";
        ctx.emit({ type: "PassResult", playerId: thrower.id, result: proc.result });
        const canReroll = passSkillReroll(thrower, proc) || canTeamReroll(state, thrower.side, proc.rerolled) || canUsePro(state, thrower, proc.rerolled);
        const wantsReroll = proc.hailMary ? proc.result === "fumble" : proc.result !== "accurate";
        proc.stage = wantsReroll && canReroll ? "reroll" : "outcome";
        return "continue";
      }
      case "reroll": {
        if (action === null) return "wait";
        const a = ctx.expect(action, "USE_REROLL", "DECLINE_REROLL", "USE_SKILL");
        if (a.type === "USE_SKILL" && a.use) {
          if ((a.skill ?? "Pro") !== "Pro" || proc.mascotFailed || !canUsePro(state, thrower, proc.rerolled)) ctx.reject("Pro cannot be used now.");
          proc.rerolled = true;
          proc.stage = "pro";
        } else if (a.type === "USE_REROLL" && passSkillReroll(thrower, proc)) {
          // A skill re-roll: no team re-roll is spent, so Loner does not apply.
          ctx.emit({ type: "SkillUsed", playerId: thrower.id, skill: "Pass" });
          proc.rerolled = true;
          proc.stage = "roll";
        } else if (a.type === "USE_REROLL") {
          if (!canTeamReroll(state, thrower.side, proc.rerolled)) ctx.reject("No re-roll available.");
          useTeamReroll(ctx, thrower.side, a.mascot);
          proc.rerolled = true;
          proc.stage = rerollGate(state, thrower) ? "loner" : "roll";
        } else proc.stage = "outcome";
        return "continue";
      }
      case "loner":
        if (action === null) return "wait";
        // A failed Loner roll keeps the first pass result; a failed Team Mascot asks again.
        const gate = rollLoner(ctx, action, thrower);
        if (gate === "offer") mascotFailed(proc);
        proc.stage = gate === "reroll" ? "roll" : gate === "offer" ? "reroll" : "outcome";
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
          ctx.push(explosion(state, throwerSquare()));
          proc.stage = "end";
          return "continue";
        }
        if (proc.result === "fumble") {
          // The ball bounces from the thrower's square.
          const at = throwerSquare();
          state.ball = { square: { ...at }, carried: false };
          if (!proc.dumpOff) state.turnover = true;
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
        // Nobody may intercept a Hail Mary Pass.
        const candidates = proc.hailMary ? [] : interceptors(state, thrower, proc.landing!);
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
        if (!proc.bomb) endBallAction(ctx, thrower, proc.dumpOff);
        if (!proc.bomb && !proc.dumpOff && !proc.hailMary && proc.range === "quick" && proc.result !== "fumble") giveAndGo(ctx, thrower);
        return "done";
    }
  },
  actions(state, proc) {
    const thrower = state.players[proc.throwerId]! as PlayerState & { at: Square };
    switch (proc.stage) {
      case "aim":
        return [{ type: "THROW", side: thrower.side, playerId: thrower.id, squares: aimTargets(state, thrower, proc) }];
      case "roll": {
        const needed = shownNeeded(thrower, passModifiers(state, thrower, proc.range));
        return [{ type: "ROLL", side: thrower.side, dice: [{ kind: "d6", count: 1 }], reason: proc.hailMary ? `Hail Mary Pass ${hailMaryNeeded(state, thrower)}+` : `Pass ${needed}+ (${proc.range})` }];
      }
      case "reroll":
        return [
          ...(passSkillReroll(thrower, proc)
            ? [{ type: "USE_REROLL" as const, side: thrower.side, available: rerollsLeft(state, thrower.side), skill: "Pass" }]
            : canTeamReroll(state, thrower.side, proc.rerolled)
              ? [teamRerollTemplate(state, thrower.side)]
              : []),
          ...(proc.mascotFailed ? [] : proTemplate(state, thrower, proc.rerolled)),
          { type: "DECLINE_REROLL", side: thrower.side },
        ];
      case "loner":
        return [lonerRollTemplate(state, thrower)];
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

/** Dump-off: the defender holds the ball and is not distracted; the attacker is still on their feet (but a blitzer may be down when declaring). */
function canDumpOff(state: GameState, proc: P<"DumpOff">) {
  const attacker = state.players[proc.attackerId]!;
  const defender = state.players[proc.defenderId]!;
  if (state.turnover || state.touchdown !== null || (!proc.declared && attacker.status !== "standing")) return false;
  return hasSkill(defender, "Dump-off") && ballCarrier(state)?.id === defender.id && hasTackleZone(defender);
}

/**
 * Dump-off: when the ball carrier is targeted by a block (not Frenzy's second one) or a special action that targets
 * them (Projectile Vomit, Stab, Breathe Fire, Hypnotic Gaze), after any Foul Appearance roll, their coach may first make
 * a Quick pass with them. A Blitz target decides as soon as the Blitz is declared, before the blitzer moves (or rolls
 * for Bone Head and the like), and not again when the block comes. The normal passing rules apply (no team re-roll: it is not their turn), except that there is
 * no On the Ball move and neither team's turn ends because of the pass. Then the attacker's action goes on.
 */
export const DumpOff: Handler<P<"DumpOff">> = {
  step(ctx, proc, action) {
    if (action === null) return canDumpOff(ctx.state, proc) ? "wait" : "done";
    if (!ctx.expect(action, "USE_SKILL").use) return "done";
    const thrower = getPlayer(ctx, proc.defenderId);
    ctx.emit({ type: "SkillUsed", playerId: thrower.id, skill: "Dump-off" });
    ctx.push({ type: "Pass", throwerId: thrower.id, target: { ...squareOf(ctx, thrower) }, range: "quick", dumpOff: true, stage: "aim", rerolled: false });
    return "done";
  },
  actions(state, proc) {
    const defender = state.players[proc.defenderId]!;
    return [{ type: "USE_SKILL", side: defender.side, playerId: defender.id, skill: "Dump-off" }];
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
    giveAndGo(ctx, thrower);
    return "done";
  },
  actions: () => [],
};

/** Punt: the orthogonal squares next to the punter, to choose the direction; the crowd from a sideline or an end zone. */
export function puntTargets(player: PlayerState & { at: Square }) {
  const squares = [{ x: 0, y: -1 }, { x: 1, y: 0 }, { x: 0, y: 1 }, { x: -1, y: 0 }]
    .map((d) => ({ x: player.at.x + d.x, y: player.at.y + d.y }))
    .filter(inBounds);
  const { x, y } = player.at;
  return { squares, crowd: x < 1 || x > 24 || y < 1 || y > 13 };
}

/** After a punt roll: the re-roll decision (team re-roll or Pro), or the next step. */
function afterPuntRoll(state: GameState, proc: P<"Punt">, punter: PlayerState) {
  if (canTeamReroll(state, punter.side, proc.rerolled) || canUsePro(state, punter, proc.rerolled)) proc.stage = "reroll";
  else nextPuntStep(proc);
}

/** The distance after the direction (unless the ball already leaves the pitch), then the landing. */
function nextPuntStep(proc: P<"Punt">) {
  if (proc.rolling === "direction" && proc.distance === undefined) {
    proc.rolling = "distance";
    proc.rerolled = false;
    proc.stage = "distance";
  } else proc.stage = "land";
}

/**
 * Punt (a once-per-turn action of a player with the skill, who may move first): the coach picks a square next to the
 * punter (not diagonally); a D6 on the throw-in template facing it gives the direction, then the ball travels D6
 * squares from the punter. A team re-roll (or Pro) may be used on each of the two rolls. If the ball would leave the pitch, it
 * is thrown in from the last square it reached, a turnover. Otherwise it comes down on the square: a standing player
 * there may catch it (a turnover if it is an opponent), else it bounces; either way the action ends, and the ball
 * loose or caught after a bounce is no turnover. From a sideline or an end zone, the punter may instead kick it into
 * the crowd: a throw-in from their square, and a turnover.
 */
export const Punt: Handler<P<"Punt">> = {
  step(ctx, proc, action) {
    const { state } = ctx;
    const punter = getPlayer(ctx, proc.playerId);
    const at = squareOf(ctx, punter);
    switch (proc.stage) {
      case "direction": {
        if (action === null) return "wait";
        const [roll] = ctx.roll(action, [{ kind: "d6", count: 1 }], "Punt direction");
        proc.direction = templateDirection(proc.facing, roll!);
        // The first square is off the pitch: no need for a distance.
        if (!inBounds({ x: at.x + proc.direction.x, y: at.y + proc.direction.y })) proc.distance = 0;
        else delete proc.distance;
        afterPuntRoll(state, proc, punter);
        return "continue";
      }
      case "distance": {
        if (action === null) return "wait";
        const [roll] = ctx.roll(action, [{ kind: "d6", count: 1 }], "Punt distance");
        proc.distance = roll!;
        afterPuntRoll(state, proc, punter);
        return "continue";
      }
      case "reroll": {
        if (action === null) return "wait";
        const a = ctx.expect(action, "USE_REROLL", "DECLINE_REROLL", "USE_SKILL");
        if (a.type === "DECLINE_REROLL" || (a.type === "USE_SKILL" && !a.use)) nextPuntStep(proc);
        else if (a.type === "USE_SKILL") {
          if ((a.skill ?? "Pro") !== "Pro" || proc.mascotFailed || !canUsePro(state, punter, proc.rerolled)) ctx.reject("Pro cannot be used now.");
          proc.rerolled = true;
          proc.stage = "pro";
        } else {
          if (!canTeamReroll(state, punter.side, proc.rerolled)) ctx.reject("No re-roll available.");
          useTeamReroll(ctx, punter.side, a.mascot);
          proc.rerolled = true;
          proc.stage = rerollGate(state, punter) ? "loner" : proc.rolling;
        }
        return "continue";
      }
      case "loner":
        if (action === null) return "wait";
        // A failed Loner roll keeps the first result.
        const gate = rollLoner(ctx, action, punter);
        if (gate === "offer") mascotFailed(proc);
        if (gate === "reroll") proc.stage = proc.rolling;
        else if (gate === "offer") proc.stage = "reroll";
        else nextPuntStep(proc);
        return "continue";
      case "pro":
      case "proTeam":
      case "proLoner": {
        if (action === null) return "wait";
        const pro = stepPro(ctx, proc, action, punter);
        if (pro === "reroll") proc.stage = proc.rolling;
        else if (pro === "stands") nextPuntStep(proc);
        return "continue";
      }
      case "land": {
        const d = proc.direction!;
        let n = proc.distance!;
        const out = n === 0 || !inBounds({ x: at.x + d.x * n, y: at.y + d.y * n });
        while (n > 0 && !inBounds({ x: at.x + d.x * n, y: at.y + d.y * n })) n -= 1;
        const square = { x: at.x + d.x * n, y: at.y + d.y * n };
        ctx.emit({ type: "Punted", playerId: punter.id, to: { ...square }, out });
        if (out) {
          state.ball = { square: null, carried: false };
          state.turnover = true;
          ctx.push({ type: "ThrowIn", from: square });
        } else {
          const catcher = playerAt(state, square);
          if (catcher?.status === "standing") proc.catcherId = catcher.id;
          landBall(ctx, square, square, { kickoff: false, receiving: null, bounceIfEmpty: true, scattered: false });
        }
        proc.stage = "end";
        return "continue";
      }
      case "end": {
        const carrier = ballCarrier(state);
        // Only a catch where the ball came down counts: not one after a bounce.
        if (carrier && carrier.id === proc.catcherId && carrier.side !== punter.side) state.turnover = true;
        if (carrier) checkTouchdown(ctx, carrier);
        return "done";
      }
    }
  },
  actions(state, proc) {
    const punter = state.players[proc.playerId]!;
    switch (proc.stage) {
      case "direction":
      case "distance":
        return [{ type: "ROLL", side: punter.side, dice: [{ kind: "d6", count: 1 }], reason: `Punt ${proc.stage} (${punter.name})` }];
      case "reroll":
        return [
          ...(canTeamReroll(state, punter.side, proc.rerolled) ? [teamRerollTemplate(state, punter.side)] : []),
          ...(proc.mascotFailed ? [] : proTemplate(state, punter, proc.rerolled)),
          { type: "DECLINE_REROLL", side: punter.side },
        ];
      case "loner":
        return [lonerRollTemplate(state, punter)];
      case "pro":
      case "proTeam":
      case "proLoner":
        return proTemplates(state, proc.stage, punter);
      default:
        return [];
    }
  },
};
