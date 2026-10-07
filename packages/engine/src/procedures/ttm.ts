import type { Ctx, Handler } from "../context";
import type { GameState, PassRange, PlayerState, Procedure, Square } from "../types";
import { SCATTER } from "../dice";
import { adjacent, allSquares, ballCarrier, hasTackleZone, inBounds, isOnPitch, isRooted, offset, playerAt, sameSquare, tackleZones } from "../pitch";
import { hasSkill } from "../skills";
import { canTeamReroll, canUsePro, checkTouchdown, getPlayer, lonerRollTemplate, lonerTarget, proTemplate, proTemplates, rerollsLeft, rollLoner, squareOf, stepPro, useTeamReroll } from "./helpers";
import { evaluatePass, passModifiers, passRange, shownNeeded } from "./pass";
import { injure } from "./injury";

type P<T extends Procedure["type"]> = Extract<Procedure, { type: T }>;

/** Team-mates with Right Stuff next to the thrower (or kicker), who can be thrown (even prone, but not rooted). */
export function throwableTeamMates(state: GameState, thrower: PlayerState, kick = false): PlayerState[] {
  if (!isOnPitch(thrower) || !hasSkill(thrower, kick ? "Kick Team-mate" : "Throw Team-mate")) return [];
  return adjacent(thrower.at)
    .map((s) => playerAt(state, s))
    .filter((p): p is PlayerState => p !== undefined && p.side === thrower.side && hasSkill(p, "Right Stuff") && !isRooted(p));
}

/** Added to the thrower's PA for a team-mate throw: the pass modifiers, and Strong Arm's +1 to the roll. */
const throwModifiers = (state: GameState, thrower: PlayerState & { at: Square }, range: PassRange) =>
  passModifiers(state, thrower, range, true) - (hasSkill(thrower, "Strong Arm") ? 1 : 0);

/** Squares a team-mate can be thrown to: Quick or Short range only, with the roll needed for a superb throw. */
export function teamMateTargets(state: GameState, thrower: PlayerState) {
  if (!isOnPitch(thrower)) return [];
  return allSquares((s) => !sameSquare(s, thrower.at)).flatMap((s) => {
    const range = passRange(state, thrower.at, s);
    if (range !== "quick" && range !== "short") return [];
    return [{ ...s, range, needed: shownNeeded(thrower, throwModifiers(state, thrower, range)) }];
  });
}

/** The thrown player comes down on `at`, moving the ball they hold with them. */
function setDown(ctx: Ctx, player: PlayerState, at: Square) {
  const from = squareOf(ctx, player);
  const { ball } = ctx.state;
  if (ball.carried && ball.square && sameSquare(ball.square, from)) ball.square = { ...at };
  player.at = { ...at };
  ctx.emit({ type: "PlayerMoved", playerId: player.id, from: { ...from }, to: { ...at } });
}

/** A failed landing: knocked down where they came down, a turnover only if they held the ball. */
const fall = (ctx: Ctx, player: PlayerState) =>
  ctx.push({ type: "KnockDown", playerId: player.id, turnover: ballCarrier(ctx.state)?.id === player.id, stage: "fall", fallsOver: true });

/** Always Hungry: the thrower throws on 2+; otherwise the team-mate escapes (thrown as a fumble) on 2+, or is eaten. */
export const HUNGER_TARGET = 2;
export const ESCAPE_TARGET = 2;

/** Eaten by an Always Hungry thrower: dead, without apothecary or Regeneration; the ball bounces from their square. */
function eat(ctx: Ctx, thrower: PlayerState, thrown: PlayerState) {
  const { state } = ctx;
  const square = squareOf(ctx, thrown);
  const carrying = ballCarrier(state)?.id === thrown.id;
  thrown.at = "cas";
  thrown.status = "standing";
  thrown.casualty = { result: "dead" };
  ctx.emit({ type: "PlayerEaten", playerId: thrown.id, byId: thrower.id });
  if (!carrying) return;
  state.ball = { square: { ...square }, carried: false };
  state.turnover = true;
  ctx.push({ type: "Bounce", from: { ...square }, kickoff: false, receiving: null });
}

/** The d8 scatters of the thrown player: three from the target, or one from their own square after a fumble. */
const scatterDice = (proc: P<"ThrowTeamMate">) => [{ kind: "d8" as const, count: proc.result === "fumble" ? 1 : 3 }];

/**
 * Throw Team-mate: the throw is rolled like a pass (PA, range, tackle zones on the thrower, Very Sunny, Disturbing
 * Presence, +1 for Strong Arm; team re-roll or Pro, no interception). A superb or subpar throw scatters three times from the target square, a fumble once from the
 * thrown player's square. Landing on a player knocks them down (a turnover if they are the thrower's team-mate) and
 * the thrown player scatters on; leaving the pitch means the crowd (always a turnover). The landing roll is on AG,
 * -1 for a subpar throw, -1 for a fumble and -1 per tackle zone; it fails without a roll after landing on someone,
 * or for a player who was down or distracted. A failed landing is a knock-down, a turnover only with the ball.
 * Always Hungry is rolled first (see HUNGER_TARGET); eating the team-mate is a turnover only if they held the ball.
 */
export const ThrowTeamMate: Handler<P<"ThrowTeamMate">> = {
  step(ctx, proc, action) {
    const { state } = ctx;
    const thrower = getPlayer(ctx, proc.throwerId);
    const thrown = getPlayer(ctx, proc.thrownId);
    // Decided before the throw: a player who was not standing, or was distracted, cannot land on their feet.
    if (proc.autoFail === undefined) proc.autoFail = !hasTackleZone(thrown);
    const check = (kind: "hunger" | "escape", player: PlayerState, target: number) => {
      state.lastCheck = null;
      ctx.push({ type: "Check", kind, playerId: player.id, target, modifier: 0, stage: "roll", rerolled: false });
    };
    switch (proc.stage) {
      case "hunger":
        proc.stage = "roll";
        if (hasSkill(thrower, "Always Hungry")) {
          check("hunger", thrower, HUNGER_TARGET);
          proc.stage = "hungerResult";
        }
        return "continue";
      case "hungerResult":
        if (state.lastCheck?.success) proc.stage = "roll";
        else {
          check("escape", thrown, ESCAPE_TARGET);
          proc.stage = "escapeResult";
        }
        return "continue";
      case "escapeResult":
        if (!state.lastCheck?.success) {
          eat(ctx, thrower, thrown);
          return "done";
        }
        // The team-mate wriggles free: it is thrown as a fumble.
        proc.result = "fumble";
        ctx.emit({ type: "TeamMateThrown", playerId: thrower.id, thrownId: thrown.id, result: "fumble", ...(proc.kicked ? { kicked: true } : {}) });
        proc.stage = "scatter";
        return "continue";
      case "roll": {
        const modifiers = throwModifiers(state, { ...thrower, at: squareOf(ctx, thrower) }, proc.range);
        if (thrower.pa === null) proc.result = "fumble";
        else {
          if (action === null) return "wait";
          const [roll] = ctx.roll(action, [{ kind: "d6", count: 1 }], `${proc.kicked ? "Kick" : "Throw"} team-mate ${shownNeeded(thrower, modifiers)}+`);
          proc.result = evaluatePass(thrower, roll!, modifiers);
        }
        ctx.emit({ type: "TeamMateThrown", playerId: thrower.id, thrownId: thrown.id, result: proc.result, ...(proc.kicked ? { kicked: true } : {}) });
        const canReroll = canTeamReroll(state, thrower.side, proc.rerolled) || canUsePro(state, thrower, proc.rerolled);
        proc.stage = proc.result !== "accurate" && canReroll ? "reroll" : "scatter";
        return "continue";
      }
      case "reroll": {
        if (action === null) return "wait";
        const a = ctx.expect(action, "USE_REROLL", "DECLINE_REROLL", "USE_SKILL");
        if (a.type === "USE_SKILL" && a.use) {
          if ((a.skill ?? "Pro") !== "Pro" || !canUsePro(state, thrower, proc.rerolled)) ctx.reject("Pro cannot be used now.");
          proc.rerolled = true;
          proc.stage = "pro";
        } else if (a.type === "USE_REROLL") {
          if (!canTeamReroll(state, thrower.side, proc.rerolled)) ctx.reject("No re-roll available.");
          useTeamReroll(ctx, thrower.side);
          proc.rerolled = true;
          proc.stage = lonerTarget(thrower) === null ? "roll" : "loner";
        } else proc.stage = "scatter";
        return "continue";
      }
      case "loner":
        if (action === null) return "wait";
        proc.stage = rollLoner(ctx, action, thrower) ? "roll" : "scatter";
        return "continue";
      case "pro":
      case "proTeam":
      case "proLoner": {
        if (action === null) return "wait";
        // A failed Pro roll keeps the first throw.
        const pro = stepPro(ctx, proc, action, thrower);
        if (pro !== "wait") proc.stage = pro === "reroll" ? "roll" : "scatter";
        return "continue";
      }
      case "scatter":
      case "bounce": {
        // A fumbled kick does not scatter: the kicked player is hurt.
        if (proc.stage === "scatter" && proc.kicked && proc.result === "fumble") {
          proc.stage = "fumbled";
          return "continue";
        }
        if (action === null) return "wait";
        const dice = proc.stage === "bounce" ? [{ kind: "d8" as const, count: 1 }] : scatterDice(proc);
        const start = proc.stage === "bounce" ? proc.at! : proc.result === "fumble" ? squareOf(ctx, thrown) : proc.target;
        let at = start;
        for (const d of ctx.roll(action, dice, proc.stage === "bounce" ? "Thrown player bounces" : "Thrown player scatters")) {
          const next = offset(at, SCATTER[d]!);
          if (!inBounds(next)) {
            proc.crowdFrom = { ...at };
            break;
          }
          at = next;
        }
        proc.at = { ...at };
        proc.stage = "land";
        return "continue";
      }
      case "fumbled": {
        if (action === null) return "wait";
        const [a, b] = ctx.roll(action, [{ kind: "d6", count: 2 }], "Injury (fumbled kick)");
        const square = squareOf(ctx, thrown);
        const carrying = ballCarrier(state)?.id === thrown.id;
        // The ball bounces once the injury is resolved, a turnover.
        if (carrying) {
          state.ball = { square: { ...square }, carried: false };
          state.turnover = true;
          ctx.push({ type: "Bounce", from: { ...square }, kickoff: false, receiving: null });
        }
        injure(ctx, thrown, a! + b!, { stunnedIsKo: true });
        return "done";
      }
      case "land": {
        if (proc.crowdFrom) {
          const carrying = ballCarrier(state)?.id === thrown.id;
          thrown.at = "reserves";
          if (carrying) state.ball = { square: null, carried: false };
          ctx.emit({ type: "PlayerPushed", playerId: thrown.id, from: { ...proc.crowdFrom }, to: null });
          ctx.push({ type: "Crowd", playerId: thrown.id, from: { ...proc.crowdFrom }, hadBall: carrying });
          state.turnover = true;
          return "done";
        }
        const occupant = playerAt(state, proc.at!);
        if (occupant && occupant.id !== thrown.id) {
          // The player landed on is knocked down; the thrown player scatters on and will not land on their feet.
          proc.autoFail = true;
          ctx.push({ type: "KnockDown", playerId: occupant.id, turnover: occupant.side === thrower.side, stage: "fall" });
          proc.stage = "bounce";
          return "continue";
        }
        setDown(ctx, thrown, proc.at!);
        if (proc.autoFail) {
          fall(ctx, thrown);
          return "done";
        }
        const modifier = -(proc.result === "accurate" ? 0 : 1) - tackleZones(state, thrown.side, proc.at!);
        state.lastCheck = null;
        ctx.push({ type: "Check", kind: "landing", playerId: thrown.id, target: thrown.ag, modifier, stage: "roll", rerolled: false });
        proc.stage = "landed";
        return "continue";
      }
      case "landed": {
        if (!state.lastCheck?.success) {
          fall(ctx, thrown);
          return "done";
        }
        const { ball } = state;
        // Landing on a loose ball does not catch it: it bounces.
        if (ball.square && !ball.carried && sameSquare(ball.square, proc.at!)) {
          ctx.push({ type: "Bounce", from: { ...proc.at! }, kickoff: false, receiving: null });
        }
        checkTouchdown(ctx, thrown);
        return "done";
      }
    }
  },
  actions(state, proc) {
    const thrower = state.players[proc.throwerId]! as PlayerState & { at: Square };
    switch (proc.stage) {
      case "roll": {
        const needed = shownNeeded(thrower, throwModifiers(state, thrower, proc.range));
        return [{ type: "ROLL", side: thrower.side, dice: [{ kind: "d6", count: 1 }], reason: `${proc.kicked ? "Kick" : "Throw"} team-mate ${needed}+ (${proc.range})` }];
      }
      case "reroll":
        return [
          ...(canTeamReroll(state, thrower.side, proc.rerolled) ? [{ type: "USE_REROLL" as const, side: thrower.side, available: rerollsLeft(state, thrower.side) }] : []),
          ...proTemplate(state, thrower, proc.rerolled),
          { type: "DECLINE_REROLL", side: thrower.side },
        ];
      case "loner":
        return [lonerRollTemplate(thrower)];
      case "pro":
      case "proTeam":
      case "proLoner":
        return proTemplates(state, proc.stage, thrower);
      case "scatter":
        if (proc.kicked && proc.result === "fumble") return [];
        return [{ type: "ROLL", side: null, dice: scatterDice(proc), reason: "Thrown player scatters" }];
      case "fumbled":
        return [{ type: "ROLL", side: null, dice: [{ kind: "d6", count: 2 }], reason: `Injury (${state.players[proc.thrownId]!.name}, fumbled kick)` }];
      case "bounce":
        return [{ type: "ROLL", side: null, dice: [{ kind: "d8", count: 1 }], reason: "Thrown player bounces" }];
      default:
        return [];
    }
  },
};
