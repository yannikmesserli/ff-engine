import type { Ctx, Handler } from "../context";
import type { GameState, PlayerState, Procedure, Square } from "../types";
import { adjacent, ballCarrier, isOnPitch, playerAt, tackleZoneAt } from "../pitch";
import { ARMOUR_DICE } from "./checks";
import { injure } from "./injury";
import { hasSkill } from "../skills";
import { getPlayer, squareOf } from "./helpers";
import { CHAINSAW_TARGET, chainsawArmour } from "./block";

type P<T extends Procedure["type"]> = Extract<Procedure, { type: T }>;

/** Argue the call succeeds on a 6; a natural 1 bans the coach. */
export const ARGUE_THE_CALL_TARGET = 6;
/** A bribe works on 2+. */
export const BRIBE_TARGET = 2;

/**
 * Foul assists: +1 per team-mate next to the victim who is not marked by any
 * opponent, -1 per victim team-mate next to the fouler who is not marked by anyone but the fouler. Only players
 * exerting a tackle zone assist or mark. None against Iron Hard Skin, whose armour roll cannot be modified.
 */
export function foulAssists(state: GameState, fouler: PlayerState & { at: Square }, victim: PlayerState & { at: Square }): number {
  if (hasSkill(victim, "Iron Hard Skin")) return 0;
  const offensive = adjacent(victim.at).filter((s) => {
    const helper = tackleZoneAt(state, s);
    if (!helper || helper.side !== fouler.side || helper.id === fouler.id) return false;
    return adjacent(s).every((n) => tackleZoneAt(state, n)?.side !== victim.side);
  }).length;
  const defensive = adjacent(fouler.at).filter((s) => {
    const helper = tackleZoneAt(state, s);
    if (!helper || helper.side !== victim.side) return false;
    return adjacent(s).filter((n) => tackleZoneAt(state, n)?.side === fouler.side).length < 2;
  }).length;
  return offensive - defensive;
}

/** Prone or stunned opponents next to a standing player, with the foul assists against each. */
export function foulTargets(state: GameState, fouler: PlayerState) {
  if (!isOnPitch(fouler) || fouler.status !== "standing") return [];
  return adjacent(fouler.at)
    .map((s) => playerAt(state, s))
    .filter((p): p is PlayerState & { at: Square } => p !== undefined && p.side !== fouler.side && p.status !== "standing")
    .map((victim) => ({ playerId: victim.id, assists: foulAssists(state, fouler, victim) }));
}

/** Dirty Player's +1 on the injury roll, when it was not needed on the armour roll. */
const injuryModifier = (fouler: PlayerState, proc: P<"Foul">) => (hasSkill(fouler, "Dirty Player") && !proc.dirtyPlayerOnArmour ? 1 : 0);

/** Natural doubles on a 2D6 roll, which the referee spots. */
const isDouble = (dice: number[] | undefined) => dice !== undefined && dice[0] === dice[1];

/**
 * BB2025 Foul: armour roll with foul assists and Dirty Player, injury, then the referee spots
 * doubles (Sneaky Git: not on the armour roll if the armour holds).
 * Chainsaw: the fouler may use it, rolling for kick-back first (2+, team re-roll): on a 1 they are knocked down (+3 to
 * their armour roll), a turnover, and there is no foul; otherwise the armour roll gets +3 (not against Iron Hard Skin).
 * A spotted fouler may argue the call (6: stays, still a turnover; 1: coach banned) and then use bribes
 * (2+: stays, no turnover); otherwise they are sent off and it is a turnover.
 */
export const Foul: Handler<P<"Foul">> = {
  step(ctx, proc, action) {
    const { state } = ctx;
    const fouler = getPlayer(ctx, proc.foulerId);
    const victim = getPlayer(ctx, proc.victimId);
    const team = state.teams[fouler.side];
    switch (proc.stage) {
      case "chainsaw": {
        if (!hasSkill(fouler, "Chainsaw")) {
          proc.stage = "armour";
          return "continue";
        }
        if (action === null) return "wait";
        if (!ctx.expect(action, "USE_SKILL").use) {
          proc.stage = "armour";
          return "continue";
        }
        proc.chainsaw = true;
        ctx.emit({ type: "SkillUsed", playerId: fouler.id, skill: "Chainsaw" });
        state.lastCheck = null;
        ctx.push({ type: "Check", kind: "chainsaw", playerId: fouler.id, target: CHAINSAW_TARGET, modifier: 0, stage: "roll", rerolled: false });
        proc.stage = "kickback";
        return "continue";
      }
      case "kickback":
        if (!state.lastCheck?.success) {
          state.lastCheck = null;
          ctx.push({ type: "KnockDown", playerId: fouler.id, turnover: true, stage: "fall" });
          return "done";
        }
        state.lastCheck = null;
        proc.stage = "armour";
        return "continue";
      case "armour": {
        if (action === null) return "wait";
        proc.armour = ctx.roll(action, [...ARMOUR_DICE], `Armour ${victim.av}+ (foul${proc.chainsaw ? ", chainsaw" : ""})`);
        const unmodified = proc.armour[0]! + proc.armour[1]! + proc.assists + (proc.chainsaw ? chainsawArmour(victim) : 0);
        // Dirty Player goes to the armour roll unless the assists alone break it (or Iron Hard Skin forbids it).
        proc.dirtyPlayerOnArmour = hasSkill(fouler, "Dirty Player") && !hasSkill(victim, "Iron Hard Skin") && unmodified < victim.av;
        const roll = unmodified + (proc.dirtyPlayerOnArmour ? 1 : 0);
        const broken = roll >= victim.av;
        ctx.emit(broken ? { type: "ArmourBroken", playerId: victim.id, roll } : { type: "ArmourHeld", playerId: victim.id, roll });
        proc.stage = broken ? "injury" : "referee";
        return "continue";
      }
      case "injury": {
        if (action === null) return "wait";
        proc.injury = ctx.roll(action, [...ARMOUR_DICE], "Injury");
        injure(ctx, victim, proc.injury[0]! + proc.injury[1]! + injuryModifier(fouler, proc));
        proc.stage = "referee";
        return "continue";
      }
      case "referee": {
        // Sneaky Git: a double on the armour roll is not spotted when the armour holds.
        const broken = proc.injury !== undefined;
        const spotted = (isDouble(proc.armour) && (broken || !hasSkill(fouler, "Sneaky Git"))) || isDouble(proc.injury);
        ctx.emit({ type: "RefereeCall", foulerId: fouler.id, spotted });
        proc.stage = !spotted ? "end" : team.coachBanned ? "bribe" : "argue";
        return "continue";
      }
      case "argue": {
        if (action === null) return "wait";
        const { argue } = ctx.expect(action, "ARGUE_THE_CALL");
        proc.stage = argue ? "argueRoll" : "bribe";
        return "continue";
      }
      case "argueRoll": {
        if (action === null) return "wait";
        const [roll] = ctx.roll(action, [{ kind: "d6", count: 1 }], `Argue the call ${ARGUE_THE_CALL_TARGET}+`);
        if (roll! >= ARGUE_THE_CALL_TARGET) {
          // The fouler stays on the pitch, but the turn is still over.
          ctx.emit({ type: "ArgueTheCall", foulerId: fouler.id, result: "success" });
          state.turnover = true;
          proc.stage = "end";
          return "continue";
        }
        if (roll === 1) team.coachBanned = true;
        ctx.emit({ type: "ArgueTheCall", foulerId: fouler.id, result: roll === 1 ? "coach-banned" : "failed" });
        proc.stage = "bribe";
        return "continue";
      }
      case "bribe": {
        if (team.bribes === 0) {
          proc.stage = "sendOff";
          return "continue";
        }
        if (action === null) return "wait";
        const { use } = ctx.expect(action, "BRIBE");
        proc.stage = use ? "bribeRoll" : "sendOff";
        return "continue";
      }
      case "bribeRoll": {
        if (action === null) return "wait";
        team.bribes -= 1;
        const [roll] = ctx.roll(action, [{ kind: "d6", count: 1 }], `Bribe ${BRIBE_TARGET}+`);
        const success = roll! >= BRIBE_TARGET;
        ctx.emit({ type: "BribeUsed", side: fouler.side, success });
        // A successful bribe: the fouler stays and there is no turnover. A failed one may be followed by another.
        proc.stage = success ? "end" : "bribe";
        return "continue";
      }
      case "sendOff": {
        const square = squareOf(ctx, fouler);
        const carrying = ballCarrier(state)?.id === fouler.id;
        sendOff(ctx, fouler);
        state.turnover = true;
        if (carrying) {
          state.ball = { square: { ...square }, carried: false };
          ctx.push({ type: "Bounce", from: { ...square }, kickoff: false, receiving: null });
        }
        proc.stage = "end";
        return "continue";
      }
      case "end":
        return "done";
    }
  },
  actions(state, proc) {
    const fouler = state.players[proc.foulerId]!;
    const victim = state.players[proc.victimId]!;
    const side = fouler.side;
    switch (proc.stage) {
      case "chainsaw":
        return [{ type: "USE_SKILL", side, playerId: fouler.id, skill: "Chainsaw" }];
      case "armour": {
        const mod = proc.assists === 0 ? "" : `, ${proc.assists > 0 ? "+" : ""}${proc.assists} assists`;
        const dirty = hasSkill(fouler, "Dirty Player") ? ", Dirty Player" : "";
        const chainsaw = proc.chainsaw && chainsawArmour(victim) > 0 ? ", +3 Chainsaw" : "";
        return [{ type: "ROLL", side, dice: [...ARMOUR_DICE], reason: `Armour ${victim.av}+ (foul on ${victim.name}${mod}${chainsaw}${dirty})` }];
      }
      case "injury":
        return [{ type: "ROLL", side, dice: [...ARMOUR_DICE], reason: injuryModifier(fouler, proc) ? "Injury (+1 Dirty Player)" : "Injury" }];
      case "argue":
        return [{ type: "ARGUE_THE_CALL", side, playerId: fouler.id }];
      case "argueRoll":
        return [{ type: "ROLL", side, dice: [{ kind: "d6", count: 1 }], reason: `Argue the call ${ARGUE_THE_CALL_TARGET}+` }];
      case "bribe":
        return [{ type: "BRIBE", side, playerId: fouler.id, bribes: state.teams[side].bribes }];
      case "bribeRoll":
        return [{ type: "ROLL", side, dice: [{ kind: "d6", count: 1 }], reason: `Bribe ${BRIBE_TARGET}+` }];
      default:
        return [];
    }
  },
};


/** Secret Weapon players who played in the drive and are not a casualty or already sent off. */
export const secretWeapons = (state: GameState) =>
  Object.values(state.players).filter((p) => p.played && hasSkill(p, "Secret Weapon") && p.at !== "cas" && p.at !== "banned");

/** Send a player off for the rest of the game. */
function sendOff(ctx: Ctx, player: PlayerState) {
  player.at = "banned";
  player.status = "standing";
  ctx.emit({ type: "PlayerSentOff", playerId: player.id });
}

/**
 * Secret Weapon: at the end of a drive, every player with the skill who played in it is sent off, even from the
 * reserves or the KO box. For each one the coach may argue the call (6: the player stays; 1: coach banned), then use
 * bribes (2+: the player stays).
 */
export const SecretWeapon: Handler<P<"SecretWeapon">> = {
  step(ctx, proc, action) {
    const id = proc.playerIds[0];
    if (id === undefined) return "done";
    const player = getPlayer(ctx, id);
    const team = ctx.state.teams[player.side];
    const next = () => {
      proc.playerIds.shift();
      proc.stage = "argue";
      return "continue" as const;
    };
    switch (proc.stage) {
      case "argue": {
        if (team.coachBanned) {
          proc.stage = "bribe";
          return "continue";
        }
        if (action === null) return "wait";
        proc.stage = ctx.expect(action, "ARGUE_THE_CALL").argue ? "argueRoll" : "bribe";
        return "continue";
      }
      case "argueRoll": {
        if (action === null) return "wait";
        const [roll] = ctx.roll(action, [{ kind: "d6", count: 1 }], `Argue the call ${ARGUE_THE_CALL_TARGET}+`);
        if (roll! >= ARGUE_THE_CALL_TARGET) {
          ctx.emit({ type: "ArgueTheCall", foulerId: player.id, result: "success" });
          return next();
        }
        if (roll === 1) team.coachBanned = true;
        ctx.emit({ type: "ArgueTheCall", foulerId: player.id, result: roll === 1 ? "coach-banned" : "failed" });
        proc.stage = "bribe";
        return "continue";
      }
      case "bribe": {
        if (team.bribes > 0) {
          if (action === null) return "wait";
          if (ctx.expect(action, "BRIBE").use) {
            proc.stage = "bribeRoll";
            return "continue";
          }
        }
        sendOff(ctx, player);
        return next();
      }
      case "bribeRoll": {
        if (action === null) return "wait";
        team.bribes -= 1;
        const [roll] = ctx.roll(action, [{ kind: "d6", count: 1 }], `Bribe ${BRIBE_TARGET}+`);
        const success = roll! >= BRIBE_TARGET;
        ctx.emit({ type: "BribeUsed", side: player.side, success });
        if (success) return next();
        proc.stage = "bribe";
        return "continue";
      }
    }
  },
  actions(state, proc) {
    const player = state.players[proc.playerIds[0]!]!;
    const side = player.side;
    switch (proc.stage) {
      case "argue":
        return [{ type: "ARGUE_THE_CALL", side, playerId: player.id }];
      case "argueRoll":
        return [{ type: "ROLL", side, dice: [{ kind: "d6", count: 1 }], reason: `Argue the call ${ARGUE_THE_CALL_TARGET}+ (${player.name})` }];
      case "bribe":
        return [{ type: "BRIBE", side, playerId: player.id, bribes: state.teams[side].bribes }];
      case "bribeRoll":
        return [{ type: "ROLL", side, dice: [{ kind: "d6", count: 1 }], reason: `Bribe ${BRIBE_TARGET}+ (${player.name})` }];
    }
  },
};
