import type { Ctx, Handler } from "../context";
import type { GameState, PlayerState, Procedure } from "../types";
import { passes } from "../dice";
import { adjacent, hasTackleZone, isOnPitch, playerAt, sameSquare } from "../pitch";
import { hasSkill } from "../skills";
import { canTeamReroll, getPlayer, lonerRollTemplate, lonerTarget, rerollsLeft, rollLoner, squareOf, useTeamReroll } from "./helpers";
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
  dauntless: "Dauntless",
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

/**
 * A single D6 roll against a target (AG for agility rolls), with an optional team re-roll.
 * `modifier` is added to the roll: -1 per tackle zone is the same as +1 to the target.
 * Writes its outcome to `state.lastCheck`.
 */
export const Check: Handler<P<"Check">> = {
  step(ctx, proc, action) {
    if (action === null) return "wait";
    const { state } = ctx;
    const player = getPlayer(ctx, proc.playerId);
    if (proc.stage === "reroll") {
      const a = ctx.expect(action, "USE_REROLL", "DECLINE_REROLL");
      if (a.type === "DECLINE_REROLL") {
        state.lastCheck = { kind: proc.kind, success: false, roll: proc.roll! };
        return "done";
      }
      useTeamReroll(ctx, player.side);
      proc.rerolled = true;
      proc.stage = lonerTarget(player) === null ? "roll" : "loner";
      return "wait";
    }
    if (proc.stage === "loner") {
      if (!rollLoner(ctx, action, player)) {
        state.lastCheck = { kind: proc.kind, success: false, roll: proc.roll! };
        return "done";
      }
      proc.stage = "roll";
      return "wait";
    }
    const reason = `${CHECK_NAMES[proc.kind]} ${neededRoll(proc.target, proc.modifier)}+`;
    const [roll] = ctx.roll(action, [{ kind: "d6", count: 1 }], reason);
    const success = passes(roll!, proc.modifier, proc.target);
    proc.roll = roll!;
    ctx.emit({ type: "CheckResult", kind: proc.kind, playerId: player.id, success, roll: roll!, target: proc.target - proc.modifier });
    // A skill re-roll is used automatically, before any team re-roll; a roll is only ever re-rolled once.
    const skill = success || proc.rerolled ? null : skillReroll(state, proc, player);
    if (skill) {
      if (ONCE_PER_TURN_REROLLS.includes(skill)) player.usedSkills.push(skill);
      ctx.emit({ type: "SkillUsed", playerId: player.id, skill });
      proc.rerolled = true;
      return "wait";
    }
    if (!success && canTeamReroll(state, player.side, proc.rerolled)) {
      proc.stage = "reroll";
      return "wait";
    }
    state.lastCheck = { kind: proc.kind, success, roll: roll! };
    return "done";
  },
  actions(state, proc) {
    const player = state.players[proc.playerId]!;
    if (proc.stage === "reroll") {
      return [
        { type: "USE_REROLL", side: player.side, available: rerollsLeft(state, player.side) },
        { type: "DECLINE_REROLL", side: player.side },
      ];
    }
    if (proc.stage === "loner") return [lonerRollTemplate(player)];
    const reason = `${CHECK_NAMES[proc.kind]} ${neededRoll(proc.target, proc.modifier)}+ (${player.name})`;
    return [{ type: "ROLL", side: player.side, dice: [{ kind: "d6", count: 1 }], reason }];
  },
};

/** 2D6, for both armour and injury rolls. */
export const ARMOUR_DICE = [{ kind: "d6", count: 2 }] as const;

/** Mighty Blow's bonus to the injury roll: only when it did not go to the armour roll. */
const injuryBonus = (proc: P<"KnockDown">) => (proc.mightyBlowOnArmour ? 0 : (proc.mightyBlow?.bonus ?? 0));

/** Name of the Mighty Blow bonus in roll reasons. */
const mightyBlowNote = (bonus: number) => (bonus > 0 ? ` (+${bonus} Mighty Blow)` : "");

/**
 * Player goes prone (a turnover if `turnover`), then armour, injury and finally a bounce if they held the ball.
 * Mighty Blow (+X, from the blocker) goes to the armour roll when it breaks the armour, otherwise to the injury roll.
 */
export const KnockDown: Handler<P<"KnockDown">> = {
  step(ctx, proc, action) {
    const { state } = ctx;
    const player = getPlayer(ctx, proc.playerId);
    switch (proc.stage) {
      case "fall": {
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
      case "armour": {
        if (action === null) return "wait";
        const [a, b] = ctx.roll(action, [...ARMOUR_DICE], `Armour ${player.av}+${mightyBlowNote(proc.mightyBlow?.bonus ?? 0)}`);
        let roll = a! + b!;
        const bonus = proc.mightyBlow?.bonus ?? 0;
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
        injure(ctx, player, a! + b! + bonus);
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
    const reason =
      proc.stage === "injury" ? `Injury${mightyBlowNote(injuryBonus(proc))}` : `Armour ${player.av}+ (${player.name})${mightyBlowNote(proc.mightyBlow?.bonus ?? 0)}`;
    return [{ type: "ROLL", side: null, dice: [...ARMOUR_DICE], reason }];
  },
};

