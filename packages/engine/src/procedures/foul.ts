import type { Ctx, Handler } from "../context";
import type { GameState, PlayerState, Procedure, Square, TeamState } from "../types";
import { adjacent, ballCarrier, isOnPitch, playerAt, tackleZoneAt } from "../pitch";
import { ARMOUR_DICE, dwarfenGrit } from "./checks";
import { injure, savageMauling } from "./injury";
import { hasSkill } from "../skills";
import { getPlayer, squareOf, useOncePerGame } from "./helpers";
import { dropBall } from "./ball";
import { CHAINSAW_TARGET, chainsawArmour } from "./block";

type P<T extends Procedure["type"]> = Extract<Procedure, { type: T }>;

/** Argue the call succeeds on a 6; a natural 1 bans the coach. */
export const ARGUE_THE_CALL_TARGET = 6;

/**
 * Bribery and Corruption (a team special rule): once per game, a natural 1 on Argue the Call is re-rolled, so the coach
 * is not banned yet. True when the argue is rolled again.
 */
function briberyReroll(ctx: Ctx, team: TeamState): boolean {
  if (!team.specialRules.includes("Bribery and Corruption") || team.briberyRerollUsed) return false;
  team.briberyRerollUsed = true;
  ctx.emit({ type: "SpecialRuleUsed", side: team.side, rule: "Bribery and Corruption" });
  return true;
}

/** Biased Referee: spots an opposing foul the referee missed on 5+. */
export const BIASED_REFEREE_TARGET = 5;

/** Argue the call: 6+, with +1 for the team's Biased Referee and +1 for Friends with the Ref (a prayer). */
const argueTarget = (team: TeamState) =>
  ARGUE_THE_CALL_TARGET - (team.inducements.biasedReferee ?? 0) - (team.prayers.includes("friends-with-the-ref") ? 1 : 0);
/** A bribe works on 2+. */
export const BRIBE_TARGET = 2;

/**
 * Players assisting a foul: team-mates next to the victim who are not marked by any opponent (Put the Boot In: even
 * marked), and victim team-mates next to the fouler who are not marked by anyone but the fouler. Only players exerting
 * a tackle zone assist or mark.
 */
function foulHelpers(state: GameState, fouler: PlayerState & { at: Square }, victim: PlayerState & { at: Square }) {
  const offensive = adjacent(victim.at).filter((s) => {
    const helper = tackleZoneAt(state, s);
    if (!helper || helper.side !== fouler.side || helper.id === fouler.id) return false;
    return hasSkill(helper, "Put the Boot In") || adjacent(s).every((n) => tackleZoneAt(state, n)?.side !== victim.side);
  }).length;
  const defensive = adjacent(fouler.at).filter((s) => {
    const helper = tackleZoneAt(state, s);
    if (!helper || helper.side !== victim.side) return false;
    return adjacent(s).filter((n) => tackleZoneAt(state, n)?.side === fouler.side).length < 2;
  }).length;
  return { offensive, defensive };
}

/**
 * Foul assists: +1 per offensive assist, -1 per defensive one (see `foulHelpers`). None against Iron Hard Skin, whose
 * armour roll cannot be modified.
 */
export function foulAssists(state: GameState, fouler: PlayerState & { at: Square }, victim: PlayerState & { at: Square }): number {
  if (hasSkill(victim, "Iron Hard Skin")) return 0;
  const { offensive, defensive } = foulHelpers(state, fouler, victim);
  return offensive - defensive;
}

/** Lone Fouler: once per turn, a fouler with nobody assisting the foul (either way) may re-roll an armour roll that holds. */
function loneFouler(state: GameState, fouler: PlayerState, victim: PlayerState) {
  if (!hasSkill(fouler, "Lone Fouler") || fouler.usedSkills.includes("Lone Fouler") || !isOnPitch(fouler) || !isOnPitch(victim)) return false;
  const { offensive, defensive } = foulHelpers(state, fouler, victim);
  return offensive === 0 && defensive === 0;
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
 * doubles (Sneaky Git: not on the armour roll if the armour holds). Lone Fouler: the fouler's coach may re-roll an armour
 * roll that holds when nobody assists the foul; only the new roll counts, its doubles included.
 * Chainsaw: the fouler may use it, rolling for kick-back first (2+, team re-roll): on a 1 they are knocked down (+3 to
 * their armour roll), a turnover, and there is no foul; otherwise the armour roll gets +3 (not against Iron Hard Skin).
 * Biased Referee (bought by the victim's team): a foul the referee missed is spotted anyway on a D6 of 5+; the team's
 * own arguments get +1 (a natural 1 still bans the coach). Prayers: Friends with the Ref, +1 to the team's arguments;
 * Under Scrutiny, the opponents' fouls that break armour are always spotted.
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
        proc.stage = broken ? (!proc.grit && dwarfenGrit(victim) ? "grit" : "injury") : loneFouler(state, fouler, victim) ? "loneFouler" : "referee";
        return "continue";
      }
      case "grit": {
        if (action === null) return "wait";
        proc.grit = true;
        if (!ctx.expect(action, "USE_SKILL").use) {
          proc.stage = "injury";
          return "continue";
        }
        // Dwarfen Grit: the armour is rolled again, and the new roll stands.
        useOncePerGame(ctx, victim, "Dwarfen Grit");
        proc.stage = "armour";
        return "wait";
      }
      case "loneFouler": {
        if (action === null) return "wait";
        if (!ctx.expect(action, "USE_SKILL").use) {
          proc.stage = "referee";
          return "continue";
        }
        fouler.usedSkills.push("Lone Fouler");
        ctx.emit({ type: "SkillUsed", playerId: fouler.id, skill: "Lone Fouler" });
        proc.stage = "armour";
        return "wait";
      }
      case "injury": {
        if (action === null) return "wait";
        proc.injury = ctx.roll(action, [...ARMOUR_DICE], "Injury");
        if (savageMauling(fouler, victim, proc.injury[0]! + proc.injury[1]! + injuryModifier(fouler, proc))) {
          proc.stage = "mauling";
          return "wait";
        }
        proc.stage = "injured";
        return "continue";
      }
      case "mauling": {
        if (action === null) return "wait";
        if (ctx.expect(action, "USE_SKILL").use) {
          // Savage Mauling: the injury is rolled again, and the new roll stands (the referee looks at the new dice).
          useOncePerGame(ctx, fouler, "Savage Mauling");
          proc.stage = "injuryAgain";
          return "wait";
        }
        proc.stage = "injured";
        return "continue";
      }
      case "injuryAgain": {
        if (action === null) return "wait";
        proc.injury = ctx.roll(action, [...ARMOUR_DICE], "Injury");
        proc.stage = "injured";
        return "continue";
      }
      case "injured": {
        // Fouling Frenzy (a prayer): a casualty caused by a foul earns the fouler Star Player Points.
        const frenzy = state.teams[fouler.side].prayers.includes("fouling-frenzy");
        injure(ctx, victim, proc.injury![0]! + proc.injury![1]! + injuryModifier(fouler, proc), { byId: fouler.id, ...(frenzy ? { sppTo: [fouler.id] } : {}) });
        proc.stage = "referee";
        return "continue";
      }
      case "referee": {
        // Sneaky Git: a double on the armour roll is not spotted when the armour holds.
        const broken = proc.injury !== undefined;
        // Under Scrutiny (a prayer of the victim's team): a foul that breaks armour is always spotted.
        const scrutiny = broken && state.teams[victim.side].prayers.includes("under-scrutiny");
        const spotted = (isDouble(proc.armour) && (broken || !hasSkill(fouler, "Sneaky Git"))) || isDouble(proc.injury) || scrutiny;
        // A missed foul: the victim's team's Biased Referee may still spot it.
        if (!spotted && (state.teams[victim.side].inducements.biasedReferee ?? 0) > 0) {
          proc.stage = "biasedReferee";
          return "continue";
        }
        ctx.emit({ type: "RefereeCall", foulerId: fouler.id, spotted });
        proc.stage = !spotted ? "end" : team.coachBanned ? "bribe" : "argue";
        return "continue";
      }
      case "biasedReferee": {
        if (action === null) return "wait";
        const [roll] = ctx.roll(action, [{ kind: "d6", count: 1 }], `Biased Referee ${BIASED_REFEREE_TARGET}+`);
        const spotted = roll! >= BIASED_REFEREE_TARGET;
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
        const [roll] = ctx.roll(action, [{ kind: "d6", count: 1 }], `Argue the call ${argueTarget(team)}+`);
        if (roll! > 1 && roll! >= argueTarget(team)) {
          // The fouler stays on the pitch, but the turn is still over.
          ctx.emit({ type: "ArgueTheCall", foulerId: fouler.id, result: "success" });
          state.turnover = true;
          proc.stage = "end";
          return "continue";
        }
        if (roll === 1 && briberyReroll(ctx, team)) return "wait";
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
      case "loneFouler":
        return [{ type: "USE_SKILL", side, playerId: fouler.id, skill: "Lone Fouler" }];
      case "armour": {
        const mod = proc.assists === 0 ? "" : `, ${proc.assists > 0 ? "+" : ""}${proc.assists} assists`;
        const dirty = hasSkill(fouler, "Dirty Player") ? ", Dirty Player" : "";
        const chainsaw = proc.chainsaw && chainsawArmour(victim) > 0 ? ", +3 Chainsaw" : "";
        return [{ type: "ROLL", side, dice: [...ARMOUR_DICE], reason: `Armour ${victim.av}+ (foul on ${victim.name}${mod}${chainsaw}${dirty})` }];
      }
      case "grit":
        return [{ type: "USE_SKILL", side: victim.side, playerId: victim.id, skill: "Dwarfen Grit" }];
      case "injury":
      case "injuryAgain":
        return [{ type: "ROLL", side, dice: [...ARMOUR_DICE], reason: injuryModifier(fouler, proc) ? "Injury (+1 Dirty Player)" : "Injury" }];
      case "mauling":
        return [{ type: "USE_SKILL", side, playerId: fouler.id, skill: "Savage Mauling" }];
      case "biasedReferee":
        return [{ type: "ROLL", side: victim.side, dice: [{ kind: "d6", count: 1 }], reason: `Biased Referee ${BIASED_REFEREE_TARGET}+ (foul by ${fouler.name})` }];
      case "argue":
        return [{ type: "ARGUE_THE_CALL", side, playerId: fouler.id }];
      case "argueRoll":
        return [{ type: "ROLL", side, dice: [{ kind: "d6", count: 1 }], reason: `Argue the call ${argueTarget(state.teams[side])}+` }];
      case "bribe":
        return [{ type: "BRIBE", side, playerId: fouler.id, bribes: state.teams[side].bribes }];
      case "bribeRoll":
        return [{ type: "ROLL", side, dice: [{ kind: "d6", count: 1 }], reason: `Bribe ${BRIBE_TARGET}+` }];
      default:
        return [];
    }
  },
};

/** Pile Driver: the defenders who are down next to the still standing attacker, and can be fouled. */
function pileDriverTargets(state: GameState, proc: P<"PileDriver">) {
  const attacker = state.players[proc.attackerId]!;
  if (state.turnover || state.touchdown !== null || !hasSkill(attacker, "Pile Driver")) return [];
  return foulTargets(state, attacker).filter((t) => proc.defenderIds.includes(t.playerId));
}

/**
 * Pile Driver: once a Block action (not a Blitz) is over, if a defender was knocked down and the attacker is still
 * standing next to them, the attacker's coach may make a free foul on them (it is not the team's Foul action), as any
 * foul (assists, Chainsaw, the referee). The attacker is then placed prone, unless sent off: a turnover only if they
 * hold the ball. After a Multiple Block, the coach picks which defender to foul, if both are down.
 */
export const PileDriver: Handler<P<"PileDriver">> = {
  step(ctx, proc, action) {
    const { state } = ctx;
    const attacker = getPlayer(ctx, proc.attackerId);
    if (proc.stage === "drop") {
      if (!isOnPitch(attacker) || attacker.status !== "standing") return "done";
      const square = squareOf(ctx, attacker);
      const carrying = ballCarrier(state)?.id === attacker.id;
      attacker.status = "prone";
      ctx.emit({ type: "PlayerPlacedProne", playerId: attacker.id });
      if (carrying) {
        state.ball.carried = false;
        state.turnover = true;
        ctx.push(dropBall(attacker, square));
      }
      return "done";
    }
    const targets = pileDriverTargets(state, proc);
    if (action === null) return targets.length > 0 ? "wait" : "done";
    const a = ctx.expect(action, "USE_SKILL", "SELECT_PLAYERS");
    const chosen = a.type === "USE_SKILL" ? (a.use && targets.length === 1 ? targets[0]!.playerId : undefined) : a.playerIds[0];
    if (a.type === "SELECT_PLAYERS" && (a.playerIds.length > 1 || (chosen !== undefined && !targets.some((t) => t.playerId === chosen)))) ctx.reject("Invalid Pile Driver target.");
    const target = targets.find((t) => t.playerId === chosen);
    if (!target) return "done";
    ctx.emit({ type: "SkillUsed", playerId: attacker.id, skill: "Pile Driver" });
    ctx.emit({ type: "Fouled", foulerId: attacker.id, victimId: target.playerId, assists: target.assists });
    ctx.push({ type: "Foul", foulerId: attacker.id, victimId: target.playerId, assists: target.assists, stage: "chainsaw" });
    proc.stage = "drop";
    return "continue";
  },
  actions(state, proc) {
    const attacker = state.players[proc.attackerId]!;
    const targets = pileDriverTargets(state, proc);
    if (targets.length === 1) return [{ type: "USE_SKILL", side: attacker.side, playerId: attacker.id, skill: "Pile Driver" }];
    return [{ type: "SELECT_PLAYERS", side: attacker.side, playerIds: targets.map((t) => t.playerId), max: 1, reason: `Pile Driver: choose a player for ${attacker.name} to foul` }];
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
        const [roll] = ctx.roll(action, [{ kind: "d6", count: 1 }], `Argue the call ${argueTarget(team)}+`);
        if (roll! > 1 && roll! >= argueTarget(team)) {
          ctx.emit({ type: "ArgueTheCall", foulerId: player.id, result: "success" });
          return next();
        }
        if (roll === 1 && briberyReroll(ctx, team)) return "wait";
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
        return [{ type: "ROLL", side, dice: [{ kind: "d6", count: 1 }], reason: `Argue the call ${argueTarget(state.teams[side])}+ (${player.name})` }];
      case "bribe":
        return [{ type: "BRIBE", side, playerId: player.id, bribes: state.teams[side].bribes }];
      case "bribeRoll":
        return [{ type: "ROLL", side, dice: [{ kind: "d6", count: 1 }], reason: `Bribe ${BRIBE_TARGET}+ (${player.name})` }];
    }
  },
};
