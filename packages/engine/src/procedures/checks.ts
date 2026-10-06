import type { Ctx, Handler, StepResult } from "../context";
import type { GameState, PlayerState, Procedure } from "../types";
import { passes } from "../dice";
import { adjacent, hasTackleZone, isOnPitch, other, playerAt, sameSquare, tackleZoneAt } from "../pitch";
import { hasSkill } from "../skills";
import { canTeamReroll, canUsePro, getPlayer, lonerRollTemplate, lonerTarget, proRollTemplate, proTemplate, rerollsLeft, rollLoner, rollPro, squareOf, useTeamReroll } from "./helpers";
import { injure } from "./injury";

type P<T extends Procedure["type"]> = Extract<Procedure, { type: T }>;

const CHECK_NAMES = {
  dodge: "Dodge",
  rush: "Rush",
  jump: "Jump",
  pickup: "Pick-up",
  catch: "Catch",
  standup: "Stand up",
  regeneration: "Regeneration",
  loner: "Loner",
  jumpup: "Jump Up",
  bonehead: "Bone Head",
  reallystupid: "Really Stupid",
  fury: "Unchannelled Fury",
  takeroot: "Take Root",
  bloodlust: "Bloodlust",
  steadyfooting: "Steady Footing",
  dauntless: "Dauntless",
  vomit: "Projectile Vomit",
  animosity: "Animosity",
  landing: "Landing",
  hunger: "Always Hungry",
  escape: "Escape",
  shadowing: "Shadowing",
  savagery: "Animal Savagery",
  appearance: "Foul Appearance",
  gaze: "Hypnotic Gaze",
  bombcatch: "Catch (bomb)",
  pro: "Pro",
} as const;

/** The natural d6 result needed, for display ("4+"). */
export const neededRoll = (target: number, modifier: number) => Math.min(6, Math.max(2, target - modifier));

/**
 * The skill that re-rolls a failed check of this kind, if the player can use it now: Sure Hands for a pick-up, Catch
 * for a catch, Dodge once per turn and not when dodging away from an opponent with Tackle.
 */
function skillReroll(state: GameState, proc: P<"Check">, player: PlayerState): string | null {
  if (proc.kind === "pickup") return hasSkill(player, "Sure Hands") ? "Sure Hands" : null;
  if (proc.kind === "catch") return hasSkill(player, "Catch") ? "Catch" : null;
  if (proc.kind !== "dodge" || !hasSkill(player, "Dodge") || player.usedSkills.includes("Dodge")) return null;
  const tacklers = isOnPitch(player) ? adjacent(player.at).map((s) => playerAt(state, s)) : [];
  const cancelled = tacklers.some((p) => p !== undefined && p.side !== player.side && hasTackleZone(p) && hasSkill(p, "Tackle"));
  return cancelled ? null : "Dodge";
}

/** Skills whose re-roll can only be used once per team turn. */
const ONCE_PER_TURN_REROLLS = ["Dodge"];

/** Diving Tackle: -2 to the dodge or jump of a player leaving the tackler's tackle zone. */
export const DIVING_TACKLE_MODIFIER = 2;

/**
 * Opponents who may use Diving Tackle on this dodge or jump: next to the square left with a tackle zone, not next to the
 * square moved to, and not the active player (a thrower whose pass is being blocked); not on the jumps of a Pogo player.
 */
export function divingTacklers(state: GameState, proc: P<"Check">, player: PlayerState): PlayerState[] {
  // Pogo: Diving Tackle does not work on the player's jumps.
  if (!proc.leaving || proc.divingTacklerId !== undefined || (proc.kind === "jump" && hasSkill(player, "Pogo"))) return [];
  const { from, to } = proc.leaving;
  return adjacent(from).flatMap((s) => {
    const p = tackleZoneAt(state, s);
    if (!p || p.side === player.side || p.id === state.activePlayerId || !hasSkill(p, "Diving Tackle")) return [];
    return adjacent(to).some((n) => sameSquare(n, s)) ? [] : [p];
  });
}

/** The check is over: report it to the procedure that pushed it. */
function finish(state: GameState, proc: P<"Check">, success: boolean): StepResult {
  state.lastCheck = { kind: proc.kind, success, roll: proc.roll!, ...(proc.divingTacklerId ? { divingTacklerId: proc.divingTacklerId } : {}) };
  return "done";
}

/** Break Tackle: +1 to a Dodge roll with ST 3 or less, +2 with ST 4, +3 with ST 5 or more. */
export const breakTackleBonus = (player: PlayerState) => (player.st <= 3 ? 1 : player.st === 4 ? 2 : 3);

/** The Break Tackle bonus the player can still add to this roll: a dodge, once per turn. */
const breakTackle = (proc: P<"Check">, player: PlayerState) =>
  proc.kind === "dodge" && hasSkill(player, "Break Tackle") && !player.usedSkills.includes("Break Tackle") ? breakTackleBonus(player) : 0;

/** Whether the roll succeeds; Break Tackle is only used when it turns a failure into a success. */
function resolve(proc: P<"Check">, player: PlayerState): { success: boolean; breakTackle: number } {
  if (passes(proc.roll!, proc.modifier, proc.target)) return { success: true, breakTackle: 0 };
  const bonus = breakTackle(proc, player);
  return bonus > 0 && passes(proc.roll!, proc.modifier + bonus, proc.target) ? { success: true, breakTackle: bonus } : { success: false, breakTackle: 0 };
}

/** Report the roll, with Break Tackle's bonus when it was needed. */
function report(ctx: Ctx, proc: P<"Check">, player: PlayerState) {
  const { success, breakTackle } = resolve(proc, player);
  ctx.emit({ type: "CheckResult", kind: proc.kind, playerId: player.id, success, roll: proc.roll!, target: proc.target - proc.modifier - breakTackle });
  if (breakTackle > 0) {
    player.usedSkills.push("Break Tackle");
    ctx.emit({ type: "SkillUsed", playerId: player.id, skill: "Break Tackle" });
  }
  return success;
}

/** After a roll: a skill re-roll, the team re-roll decision, or the result. */
function settle(ctx: Ctx, proc: P<"Check">, player: PlayerState, success: boolean): StepResult {
  const { state } = ctx;
  // A skill re-roll is used automatically, before any team re-roll; a roll is only ever re-rolled once.
  const skill = success || proc.rerolled ? null : skillReroll(state, proc, player);
  if (skill) {
    if (ONCE_PER_TURN_REROLLS.includes(skill)) player.usedSkills.push(skill);
    ctx.emit({ type: "SkillUsed", playerId: player.id, skill });
    proc.rerolled = true;
    proc.stage = "roll";
    return "wait";
  }
  if (!success && (canTeamReroll(state, player.side, proc.rerolled) || canUsePro(state, player, proc.rerolled))) {
    proc.stage = "reroll";
    return "wait";
  }
  return finish(state, proc, success);
}

/**
 * A single D6 roll against a target (AG for agility rolls), with an optional team re-roll.
 * `modifier` is added to the roll: -1 per tackle zone is the same as +1 to the target.
 * Diving Tackle: after a successful dodge or jump that -2 would turn into a failure, the opposing coach may pick one
 * eligible tackler; the roll then fails (unless Break Tackle saves it), and a re-roll keeps the -2.
 * Break Tackle: once per turn, its bonus is added to a Dodge roll that would fail without it.
 * Pro: instead of a team re-roll, once per turn the active player may roll a D6: on 3+ the die is re-rolled.
 * Writes its outcome to `state.lastCheck`.
 */
export const Check: Handler<P<"Check">> = {
  step(ctx, proc, action) {
    if (action === null) return "wait";
    const { state } = ctx;
    const player = getPlayer(ctx, proc.playerId);
    if (proc.stage === "reroll") {
      const a = ctx.expect(action, "USE_REROLL", "DECLINE_REROLL", "USE_SKILL");
      if (a.type === "DECLINE_REROLL" || (a.type === "USE_SKILL" && !a.use)) return finish(state, proc, false);
      if (a.type === "USE_SKILL") {
        if (!canUsePro(state, player, proc.rerolled)) ctx.reject("Pro cannot be used now.");
        proc.rerolled = true;
        proc.stage = "pro";
        return "wait";
      }
      if (!canTeamReroll(state, player.side, proc.rerolled)) ctx.reject("No re-roll available.");
      useTeamReroll(ctx, player.side);
      proc.rerolled = true;
      proc.stage = lonerTarget(player) === null ? "roll" : "loner";
      return "wait";
    }
    if (proc.stage === "loner" || proc.stage === "pro") {
      // A failed Loner or Pro roll keeps the first result.
      if (!(proc.stage === "loner" ? rollLoner(ctx, action, player) : rollPro(ctx, action, player))) return finish(state, proc, false);
      proc.stage = "roll";
      return "wait";
    }
    if (proc.stage === "divingTackle") {
      const { playerIds } = ctx.expect(action, "SELECT_PLAYERS");
      const id = playerIds[0];
      const candidates = divingTacklers(state, proc, player);
      if (playerIds.length > 1 || (id !== undefined && !candidates.some((c) => c.id === id))) ctx.reject("Invalid diving tackler.");
      if (id !== undefined) {
        proc.divingTacklerId = id;
        proc.modifier -= DIVING_TACKLE_MODIFIER;
        ctx.emit({ type: "SkillUsed", playerId: id, skill: "Diving Tackle" });
      }
      return settle(ctx, proc, player, report(ctx, proc, player));
    }
    const reason = `${CHECK_NAMES[proc.kind]} ${neededRoll(proc.target, proc.modifier)}+`;
    const [roll] = ctx.roll(action, [{ kind: "d6", count: 1 }], reason);
    proc.roll = roll!;
    // Diving Tackle is decided before the result (and any Break Tackle) is settled.
    if (resolve(proc, player).success && divingTacklers(state, proc, player).length > 0 && !passes(roll!, proc.modifier - DIVING_TACKLE_MODIFIER, proc.target)) {
      proc.stage = "divingTackle";
      return "wait";
    }
    return settle(ctx, proc, player, report(ctx, proc, player));
  },
  actions(state, proc) {
    const player = state.players[proc.playerId]!;
    if (proc.stage === "reroll") {
      return [
        ...(canTeamReroll(state, player.side, proc.rerolled) ? [{ type: "USE_REROLL" as const, side: player.side, available: rerollsLeft(state, player.side) }] : []),
        ...proTemplate(state, player, proc.rerolled),
        { type: "DECLINE_REROLL", side: player.side },
      ];
    }
    if (proc.stage === "loner") return [lonerRollTemplate(player)];
    if (proc.stage === "pro") return [proRollTemplate(player)];
    if (proc.stage === "divingTackle") {
      const playerIds = divingTacklers(state, proc, player).map((p) => p.id);
      return [{ type: "SELECT_PLAYERS", side: other(player.side), playerIds, max: 1, reason: `Diving Tackle: choose a player to make ${player.name}'s ${CHECK_NAMES[proc.kind].toLowerCase()} fail` }];
    }
    const reason = `${CHECK_NAMES[proc.kind]} ${neededRoll(proc.target, proc.modifier)}+ (${player.name})`;
    return [{ type: "ROLL", side: player.side, dice: [{ kind: "d6", count: 1 }], reason }];
  },
};

/** 2D6, for both armour and injury rolls. */
export const ARMOUR_DICE = [{ kind: "d6", count: 2 }] as const;

/** Mighty Blow's bonus to the injury roll: only when it did not go to the armour roll. */
const injuryBonus = (proc: P<"KnockDown">) => (proc.mightyBlowOnArmour || proc.mightyBlow?.armourOnly ? 0 : (proc.mightyBlow?.bonus ?? 0));

/** Name of the Mighty Blow bonus in roll reasons. */
const mightyBlowNote = (bonus: number) => (bonus > 0 ? ` (+${bonus} Mighty Blow)` : "");

/** Claws: an armour roll of 8+ breaks the armour of a player with a higher AV. */
export const CLAWS_ARMOUR = 8;

/** Claws applies to the knock-down: the blocker has it and the player's AV is above 8+. */
const clawsApply = (state: GameState, proc: P<"KnockDown">, player: PlayerState) =>
  proc.blockerId !== undefined && hasSkill(state.players[proc.blockerId]!, "Claws") && player.av > CLAWS_ARMOUR;

/** Name of Claws in armour roll reasons. */
const clawsNote = (state: GameState, proc: P<"KnockDown">, player: PlayerState) =>
  clawsApply(state, proc, player) ? ` (Claws: ${CLAWS_ARMOUR}+)` : "";

/** Steady Footing avoids a knock-down on a 6. */
export const STEADY_FOOTING_TARGET = 6;

/**
 * Steady Footing first: a standing, undistracted player with the skill may roll a D6 (team re-roll allowed in their own
 * turn); on a 6 they stay on their feet, holding the ball, and there is no turnover.
 * Then the player goes prone (a turnover if `turnover`), armour, injury and finally a bounce if they held the ball.
 * Claws (from the blocker): a natural 8+ on the armour roll breaks it, whatever the AV. Otherwise Mighty Blow (+X, from
 * the blocker) goes to the armour roll when it breaks the armour, and to the injury roll if not (they do not stack).
 */
export const KnockDown: Handler<P<"KnockDown">> = {
  step(ctx, proc, action) {
    const { state } = ctx;
    const player = getPlayer(ctx, proc.playerId);
    switch (proc.stage) {
      case "fall": {
        if (!proc.steadied && hasSkill(player, "Steady Footing") && player.status === "standing" && !player.distracted) {
          proc.stage = "steady";
          return "continue";
        }
        const square = squareOf(ctx, player);
        const { ball } = state;
        proc.square = { ...square };
        proc.hadBall = ball.carried && ball.square !== null && sameSquare(ball.square, square);
        if (proc.hadBall) ball.carried = false;
        player.status = "prone";
        if (proc.turnover) state.turnover = true;
        ctx.emit({ type: "PlayerKnockedDown", playerId: player.id });
        proc.stage = "armour";
        return "continue";
      }
      case "steady": {
        if (action === null) return "wait";
        proc.steadied = true;
        if (!ctx.expect(action, "USE_SKILL").use) {
          proc.stage = "fall";
          return "continue";
        }
        state.lastCheck = null;
        ctx.push({ type: "Check", kind: "steadyfooting", playerId: player.id, target: STEADY_FOOTING_TARGET, modifier: 0, stage: "roll", rerolled: false });
        proc.stage = "steadyResult";
        return "continue";
      }
      case "steadyResult":
        if (state.lastCheck?.success) {
          ctx.emit({ type: "SkillUsed", playerId: player.id, skill: "Steady Footing" });
          return "done";
        }
        proc.stage = "fall";
        return "continue";
      case "armour": {
        if (action === null) return "wait";
        const [a, b] = ctx.roll(action, [...ARMOUR_DICE], `Armour ${player.av}+${mightyBlowNote(proc.mightyBlow?.bonus ?? 0)}${clawsNote(state, proc, player)}`);
        let roll = a! + b!;
        const bonus = proc.mightyBlow?.bonus ?? 0;
        if (clawsApply(state, proc, player) && roll >= CLAWS_ARMOUR && roll < player.av) {
          ctx.emit({ type: "SkillUsed", playerId: proc.blockerId!, skill: "Claws" });
          ctx.emit({ type: "ArmourBroken", playerId: player.id, roll });
          proc.stage = "injury";
          return "continue";
        }
        if (bonus > 0 && roll < player.av && roll + bonus >= player.av) {
          proc.mightyBlowOnArmour = true;
          roll += bonus;
          ctx.emit({ type: "SkillUsed", playerId: proc.mightyBlow!.playerId, skill: "Mighty Blow" });
        }
        // BB2025: armour is broken when the roll equals or beats AV.
        if (roll >= player.av) {
          ctx.emit({ type: "ArmourBroken", playerId: player.id, roll });
          proc.stage = "injury";
        } else {
          ctx.emit({ type: "ArmourHeld", playerId: player.id, roll });
          proc.stage = "bounce";
        }
        return "continue";
      }
      case "injury": {
        if (action === null) return "wait";
        const bonus = injuryBonus(proc);
        const [a, b] = ctx.roll(action, [...ARMOUR_DICE], `Injury${mightyBlowNote(bonus)}`);
        if (bonus > 0) ctx.emit({ type: "SkillUsed", playerId: proc.mightyBlow!.playerId, skill: "Mighty Blow" });
        // The casualty roll and the apothecary run before the ball bounces.
        injure(ctx, player, a! + b! + bonus, { attackerId: proc.blockerId });
        proc.stage = "bounce";
        return "continue";
      }
      case "bounce":
        if (proc.hadBall) ctx.push({ type: "Bounce", from: proc.square!, kickoff: false, receiving: null });
        return "done";
    }
  },
  actions(state, proc) {
    const player = state.players[proc.playerId]!;
    if (proc.stage === "steady") return [{ type: "USE_SKILL", side: player.side, playerId: player.id, skill: "Steady Footing" }];
    const reason =
      proc.stage === "injury"
        ? `Injury${mightyBlowNote(injuryBonus(proc))}`
        : `Armour ${player.av}+ (${player.name})${mightyBlowNote(proc.mightyBlow?.bonus ?? 0)}${clawsNote(state, proc, player)}`;
    return [{ type: "ROLL", side: null, dice: [...ARMOUR_DICE], reason }];
  },
};

