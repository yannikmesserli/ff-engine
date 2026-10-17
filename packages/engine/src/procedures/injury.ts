import type { Ctx, Handler } from "../context";
import type { Action, Casualty, Characteristic, DiceSpec, InjuryOutcome, PlayerState, PositionStats, Procedure, Side, TeamState } from "../types";
import { hasSkill, skillName } from "../skills";
import { other, teamPlayers } from "../pitch";
import { createPlayer, earnSpp, getPlayer, inducementsLeft, spendInducement } from "./helpers";

type P<T extends Procedure["type"]> = Extract<Procedure, { type: T }>;

/** D16 for the casualty table and D6 for the lasting injury, rolled together. */
export const CASUALTY_DICE: DiceSpec[] = [
  { kind: "d16", count: 1 },
  { kind: "d6", count: 1 },
];

/**
 * BB2025 injury table on the 2D6 total: 2-7 Stunned, 8-9 KO'd, 10+ casualty. Stunty: 7 is KO'd and 9 Badly Hurt.
 * Thick Skull: KO'd on 8 becomes Stunned (on 7 for a Stunty player).
 */
export function injuryOutcome(player: PlayerState, total: number): InjuryOutcome {
  const thickSkull = hasSkill(player, "Thick Skull");
  if (hasSkill(player, "Stunty")) {
    if (total === 7) return thickSkull ? "stunned" : "ko";
    if (total === 9) return "badly-hurt";
  } else if (total === 8 && thickSkull) {
    return "stunned";
  }
  return total <= 7 ? "stunned" : total <= 9 ? "ko" : "casualty";
}

/** Lasting injury table (D6): 1-2 Head Injury, 3 Smashed Knee, 4 Broken Arm, 5 Dislocated Hip, 6 Dislocated Shoulder. */
const LASTING_INJURIES: Characteristic[] = ["av", "av", "ma", "pa", "ag", "st"];

/** A Lasting Injury cannot take a characteristic past these limits (MA/ST 1, AG/PA 6+, AV 3+); no PA cannot drop. */
function canLower(player: PlayerState, stat: Characteristic) {
  // Dodgy Snack lowers MA and AV for the drive only: look at the values it will restore.
  const ma = player.snack?.ma ?? player.ma;
  const av = player.snack?.av ?? player.av;
  switch (stat) {
    case "ma":
      return ma > 1;
    case "st":
      return player.st > 1;
    case "ag":
      return player.ag < 6;
    case "pa":
      return player.pa !== null && player.pa < 6;
    case "av":
      return av > 3;
  }
}

/** Added to the D16 casualty roll: +1 per Niggling Injury, +1 with Decay. */
const casualtyModifier = (player: PlayerState) => player.nigglingInjuries + (hasSkill(player, "Decay") ? 1 : 0);

/**
 * BB2025 casualty table on D16 + Niggling Injuries (+1 with Decay): 1-8 Badly Hurt, 9-10 Seriously Hurt, 11-12
 * Serious Injury, 13-14 Lasting Injury (the D6 picks the characteristic; Seriously Hurt if it cannot be lowered), 15+
 * Dead.
 */
export function casualtyFor(player: PlayerState, d16: number, d6: number): Casualty {
  const roll = d16 + casualtyModifier(player);
  if (roll >= 15) return { result: "dead" };
  if (roll >= 13) {
    const lasting = LASTING_INJURIES[d6 - 1]!;
    return canLower(player, lasting) ? { result: "lasting-injury", lasting } : { result: "seriously-hurt" };
  }
  if (roll >= 11) return { result: "serious-injury" };
  if (roll >= 9) return { result: "seriously-hurt" };
  return { result: "badly-hurt" };
}

/** The inducement that may re-roll a failed Regeneration roll: the Mortuary Assistant first, then the Plague Doctor. */
const regenerationReroll = (team: TeamState): "mortuaryAssistant" | "plagueDoctor" | null =>
  inducementsLeft(team, "mortuaryAssistant") > 0 ? "mortuaryAssistant" : inducementsLeft(team, "plagueDoctor") > 0 ? "plagueDoctor" : null;

/** Names of the inducements offered as a USE_SKILL decision. */
const INDUCEMENT_SKILLS = { mortuaryAssistant: "Mortuary Assistant", plagueDoctor: "Plague Doctor" } as const;

/** Regeneration (4+, team re-roll in the player's own turn) comes before the apothecary. */
export const REGENERATION_TARGET = 4;

const afterCasualty = (player: PlayerState) => (hasSkill(player, "Regeneration") ? "regeneration" : "apothecary");

/** How an injury happened, for `injure`. */
export interface InjuryCause {
  /** Pushed into the crowd. */
  crowd?: boolean;
  /** The opponent whose block caused it (Plague Ridden). */
  attackerId?: string;
  /** The opponent who caused it (Getting Even); by default the blocker, or the opponent who earns Star Player Points. */
  byId?: string;
  /** Bitten by a Bloodlust player: a casualty is only Badly Hurt. */
  bitten?: boolean;
  /** A Stunned result counts as KO'd (a fumbled Kick Team-mate). */
  stunnedIsKo?: boolean;
  /** Opponents who earn Star Player Points if this is a casualty (whatever the apothecary or Regeneration does after). */
  sppTo?: string[];
}

/** Resolve an injury roll total on `player`: emits the table result and pushes the casualty / apothecary follow-up. */
export function injure(ctx: Ctx, player: PlayerState, total: number, { crowd = false, attackerId, byId, bitten = false, stunnedIsKo = false, sppTo = [] }: InjuryCause = {}) {
  const by = byId ?? attackerId ?? sppTo.find((id) => ctx.state.players[id]?.side !== player.side);
  const rolled = injuryOutcome(player, total);
  // Ball & Chain: a Stunned result is always a KO.
  const stunnedKo = stunnedIsKo || hasSkill(player, "Ball & Chain");
  const outcome = bitten && rolled === "casualty" ? "badly-hurt" : stunnedKo && rolled === "stunned" ? "ko" : rolled;
  ctx.emit({ type: "PlayerInjured", playerId: player.id, result: outcome === "stunned" ? "stunned" : outcome === "ko" ? "ko" : "cas" });
  if (outcome === "casualty" || outcome === "badly-hurt") {
    for (const id of new Set(sppTo)) if (ctx.state.players[id]?.side !== player.side) earnSpp(ctx.state, id, "casualties");
  }
  ctx.push({
    type: "Injury",
    playerId: player.id,
    outcome,
    crowd,
    ...(attackerId ? { attackerId } : {}),
    ...(by ? { byId: by } : {}),
    stage: outcome === "casualty" ? "casualty" : outcome === "badly-hurt" ? afterCasualty(player) : "apothecary",
    ...(outcome === "badly-hurt" ? { casualty: { result: "badly-hurt" as const } } : {}),
  });
}

/** Knocked Out without an injury roll (Saboteur): the apothecary may still treat the player. Returns the procedure to push. */
export function knockOut(ctx: Ctx, player: PlayerState): Procedure {
  ctx.emit({ type: "PlayerInjured", playerId: player.id, result: "ko" });
  return { type: "Injury", playerId: player.id, outcome: "ko", crowd: false, stage: "apothecary" };
}

/** Roll the casualty dice and read the table. */
function rollCasualty(ctx: Ctx, player: PlayerState, action: Action, reason: string) {
  const [d16, d6] = ctx.roll(action, CASUALTY_DICE, reason);
  const casualty = casualtyFor(player, d16!, d6!);
  ctx.emit({ type: "CasualtyRolled", playerId: player.id, roll: d16! + casualtyModifier(player), casualty });
  return casualty;
}

/**
 * After the injury roll: a casualty rolls on the casualty table, then Regeneration (4+: back to the reserves; a
 * Mortuary Assistant or Plague Doctor may re-roll a failure, once per game), then the team's apothecary (once per
 * game; the Plague Doctor can stand in, sharing its single use) may treat
 * a KO'd or injured player. KO'd: Stunned on the pitch (to the reserves if pushed into the crowd). Badly Hurt: back to
 * the reserves. Worse: the casualty is re-rolled; Badly Hurt on the re-roll heals the player, otherwise the coach keeps
 * either result.
 */
export const Injury: Handler<P<"Injury">> = {
  step(ctx, proc, action) {
    const { state } = ctx;
    const player = getPlayer(ctx, proc.playerId);
    const team = state.teams[player.side];
    switch (proc.stage) {
      case "casualty": {
        if (action === null) return "wait";
        proc.casualty = rollCasualty(ctx, player, action, `Casualty (${player.name})`);
        proc.stage = afterCasualty(player);
        return "continue";
      }
      case "regeneration":
        proc.stage = "regenerated";
        ctx.push({ type: "Check", kind: "regeneration", playerId: player.id, target: REGENERATION_TARGET, modifier: 0, stage: "roll", rerolled: false });
        return "continue";
      case "regenerated": {
        const regenerated = state.lastCheck?.success === true;
        state.lastCheck = null;
        if (regenerated) {
          proc.healed = true;
          ctx.emit({ type: "Regenerated", playerId: player.id });
        }
        proc.stage = regenerated ? "place" : !proc.regenerationRerolled && regenerationReroll(team) ? "regenerationReroll" : "apothecary";
        return "continue";
      }
      case "regenerationReroll": {
        if (action === null) return "wait";
        proc.regenerationRerolled = true;
        if (!ctx.expect(action, "USE_SKILL").use) {
          proc.stage = "apothecary";
          return "continue";
        }
        spendInducement(ctx, player.side, regenerationReroll(team)!);
        proc.stage = "regenerated";
        ctx.push({ type: "Check", kind: "regeneration", playerId: player.id, target: REGENERATION_TARGET, modifier: 0, stage: "roll", rerolled: true });
        return "continue";
      }
      case "apothecary": {
        // Ball & Chain: no apothecary for a KO; a frog (Zap!) gets none at all.
        const plagueDoctor = inducementsLeft(team, "plagueDoctor") > 0;
        if (proc.outcome === "stunned" || (team.apothecaries === 0 && !plagueDoctor) || (proc.outcome === "ko" && hasSkill(player, "Ball & Chain")) || player.frog) {
          proc.stage = "place";
          return "continue";
        }
        if (action === null) return "wait";
        if (!ctx.expect(action, "USE_APOTHECARY").use) {
          proc.stage = "place";
          return "continue";
        }
        // The team's own apothecary first, then the Plague Doctor.
        if (team.apothecaries > 0) team.apothecaries -= 1;
        else spendInducement(ctx, player.side, "plagueDoctor");
        proc.treated = true;
        ctx.emit({ type: "ApothecaryUsed", playerId: player.id });
        if (proc.outcome === "ko") {
          if (proc.crowd) proc.healed = true;
          else proc.outcome = "stunned";
          proc.stage = "place";
        } else if (proc.casualty!.result === "badly-hurt") {
          proc.healed = true;
          proc.stage = "place";
        } else {
          proc.stage = "apothecaryRoll";
        }
        return "continue";
      }
      case "apothecaryRoll": {
        if (action === null) return "wait";
        proc.reroll = rollCasualty(ctx, player, action, `Casualty re-roll (${player.name})`);
        if (proc.reroll.result === "badly-hurt") proc.healed = true;
        proc.stage = proc.healed ? "place" : "apothecaryChoice";
        return "continue";
      }
      case "apothecaryChoice": {
        if (action === null) return "wait";
        if (ctx.expect(action, "APOTHECARY_CHOICE").keep === "second") proc.casualty = proc.reroll!;
        proc.stage = "place";
        return "continue";
      }
      case "place":
        place(ctx, player, proc);
        return "done";
    }
  },
  actions(state, proc) {
    const player = state.players[proc.playerId]!;
    const side = player.side;
    switch (proc.stage) {
      case "casualty":
        return [{ type: "ROLL", side: null, dice: CASUALTY_DICE, reason: `Casualty (${player.name})` }];
      case "regenerationReroll":
        return [{ type: "USE_SKILL", side, playerId: player.id, skill: INDUCEMENT_SKILLS[regenerationReroll(state.teams[side])!] }];
      case "apothecary":
        return [{ type: "USE_APOTHECARY", side, playerId: player.id, outcome: proc.outcome, casualty: proc.casualty ?? null }];
      case "apothecaryRoll":
        return [{ type: "ROLL", side, dice: CASUALTY_DICE, reason: `Casualty re-roll (${player.name})` }];
      case "apothecaryChoice":
        return [{ type: "APOTHECARY_CHOICE", side, playerId: player.id, first: proc.casualty!, second: proc.reroll! }];
      case "regeneration":
      case "regenerated":
      case "place":
        return [];
    }
  },
};

/** Put the player where the injury leaves them: stunned on the pitch, or in the reserves, KO or casualty box. */
function place(ctx: Ctx, player: PlayerState, proc: P<"Injury">) {
  if (proc.healed) {
    player.at = "reserves";
    player.status = "standing";
  } else if (proc.outcome === "stunned") {
    if (proc.crowd) player.at = "reserves";
    player.status = proc.crowd ? "standing" : "stunned";
  } else if (proc.outcome === "ko") {
    player.at = "ko";
    player.status = "standing";
  } else {
    player.at = "cas";
    player.status = "standing";
    player.casualty = proc.casualty!;
    if (proc.casualty!.result === "dead") raiseDead(ctx, player, proc.attackerId ? getPlayer(ctx, proc.attackerId) : undefined);
    if (proc.byId) gettingEven(ctx, player, getPlayer(ctx, proc.byId));
  }
  if (proc.treated) {
    const result = proc.healed ? "reserves" : proc.outcome === "stunned" ? "stunned" : "casualty";
    ctx.emit({ type: "ApothecaryResult", playerId: player.id, result, casualty: result === "casualty" ? proc.casualty! : null });
  }
}

/** Getting Even: the casualties that give the player a chance to gain Hatred. */
const GETTING_EVEN_CASUALTIES = ["seriously-hurt", "serious-injury", "lasting-injury"];

/** Keywords of a position's role, not of a race: no Hatred against them. */
const ROLE_KEYWORDS = ["big guy", "blitzer", "blocker", "bugman", "catcher", "lineman", "runner", "special", "thrower"];

/** Getting Even succeeds on 4+. */
export const GETTING_EVEN_TARGET = 4;

/** The keywords the player hates already (Hatred(X), several separated by ";"). */
export const hatedKeywords = (player: PlayerState) =>
  player.skills.filter((s) => skillName(s) === "Hatred").flatMap((s) => (/\((.*)\)$/.exec(s)?.[1] ?? "").toLowerCase().split(";").map((k) => k.trim()));

/**
 * Getting Even: a player left Seriously Hurt, with a Serious Injury or with a Lasting Injury (after the apothecary) by
 * an opponent's block, foul or special action may gain Hatred against one of that opponent's keywords, not a role
 * (Lineman, Blitzer, Big Guy...) nor one they hate already. Star players and mercenaries do not.
 */
function gettingEven(ctx: Ctx, player: PlayerState, by: PlayerState) {
  if (by.side === player.side || player.hired || !GETTING_EVEN_CASUALTIES.includes(player.casualty!.result)) return;
  const hated = hatedKeywords(player);
  const options = by.keywords.filter((k) => !ROLE_KEYWORDS.includes(k) && !hated.includes(k));
  if (options.length === 0) return;
  ctx.push({ type: "GettingEven", playerId: player.id, options, ...(options.length === 1 ? { stage: "roll", keyword: options[0]! } : { stage: "choose" }) });
}

/** Getting Even: the player's coach picks the keyword if there are several, then a D6 (re-rollable): on 4+ Hatred is gained. */
export const GettingEven: Handler<P<"GettingEven">> = {
  step(ctx, proc, action) {
    const { state } = ctx;
    const player = getPlayer(ctx, proc.playerId);
    if (proc.stage === "choose") {
      if (action === null) return "wait";
      const { keyword } = ctx.expect(action, "CHOOSE_KEYWORD");
      if (!proc.options.includes(keyword)) ctx.reject("Choose one of the attacker's keywords.");
      proc.keyword = keyword;
      proc.stage = "roll";
    }
    if (proc.stage === "roll") {
      state.lastCheck = null;
      ctx.push({ type: "Check", kind: "gettingEven", playerId: player.id, target: GETTING_EVEN_TARGET, modifier: 0, stage: "roll", rerolled: false });
      proc.stage = "result";
      return "continue";
    }
    if (state.lastCheck?.success) {
      player.skills.push(`Hatred(${proc.keyword})`);
      player.gainedHatred = [...(player.gainedHatred ?? []), proc.keyword!];
      ctx.emit({ type: "HatredGained", playerId: player.id, keyword: proc.keyword! });
    }
    return "done";
  },
  actions(state, proc) {
    const player = state.players[proc.playerId]!;
    return [{ type: "CHOOSE_KEYWORD", side: player.side, playerId: player.id, keywords: proc.options }];
  },
};

/** A killed player with one of these skills cannot be raised by Plague Ridden. */
const UNRAISABLE_SKILLS = ["Stunty", "Regeneration", "Decay"];

/** Masters of Undeath raise killed opponents of ST 4 or less. */
export const UNDEATH_MAX_ST = 4;

/**
 * A killed player may join the other team, once per game in all, in its reserves as a new player of one of its lineman
 * positions (its coach picks when there are several), named as the dead player:
 * - Plague Ridden: killed by the block of a player with the skill; not a Big Guy, nor a player with Stunty,
 *   Regeneration or Decay.
 * - Masters of Undeath (a team special rule): killed in any way; ST 4 or less, and not a Stunty player.
 */
function raiseDead(ctx: Ctx, dead: PlayerState, attacker: PlayerState | undefined) {
  const { state } = ctx;
  const side = other(dead.side);
  const team = state.teams[side];
  if (team.raisedDead > 0 || team.raisePositions.length === 0) return;
  const infected =
    attacker?.side === side && hasSkill(attacker, "Plague Ridden") && !dead.keywords.includes("big guy") && !UNRAISABLE_SKILLS.some((s) => hasSkill(dead, s));
  const undead = team.specialRules.includes("Masters of Undeath") && dead.st <= UNDEATH_MAX_ST && !hasSkill(dead, "Stunty");
  if (!infected && !undead) return;
  if (team.raisePositions.length > 1) ctx.push({ type: "RaiseDead", side, deadId: dead.id, undead: !infected });
  else raise(ctx, side, dead, team.raisePositions[0]!, !infected);
}

/** The dead player joins `side` in the reserves as a new `position` player, with the dead player's name. */
function raise(ctx: Ctx, side: Side, dead: PlayerState, position: PositionStats, undead: boolean) {
  const { state } = ctx;
  const nr = 1 + Math.max(...teamPlayers(state, side).map((p) => p.nr));
  const raised = { ...createPlayer(side, { ...position, nr, name: dead.name }), raised: true };
  state.players[raised.id] = raised;
  state.teams[side].raisedDead += 1;
  ctx.emit({ type: "PlayerRaised", playerId: raised.id, fromId: dead.id, ...(undead ? { undead } : {}) });
}

/** A killed player is raised: the raising team's coach picks the lineman position. */
export const RaiseDead: Handler<P<"RaiseDead">> = {
  step(ctx, proc, action) {
    if (action === null) return "wait";
    const { position } = ctx.expect(action, "CHOOSE_POSITION");
    const stats = ctx.state.teams[proc.side].raisePositions.find((p) => p.position === position) ?? ctx.reject("Choose one of the team's lineman positions.");
    raise(ctx, proc.side, getPlayer(ctx, proc.deadId), stats, proc.undead);
    return "done";
  },
  actions(state, proc) {
    return [{ type: "CHOOSE_POSITION", side: proc.side, deadId: proc.deadId, positions: state.teams[proc.side].raisePositions.map((p) => p.position) }];
  },
};
