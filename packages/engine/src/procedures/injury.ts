import type { Ctx, Handler } from "../context";
import type { Action, Casualty, Characteristic, DiceSpec, InjuryOutcome, PlayerState, Procedure } from "../types";
import { hasSkill } from "../skills";
import { teamPlayers } from "../pitch";
import { createPlayer, getPlayer } from "./helpers";

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

/** Regeneration (4+, team re-roll in the player's own turn) comes before the apothecary. */
export const REGENERATION_TARGET = 4;

const afterCasualty = (player: PlayerState) => (hasSkill(player, "Regeneration") ? "regeneration" : "apothecary");

/** How an injury happened, for `injure`. */
export interface InjuryCause {
  /** Pushed into the crowd. */
  crowd?: boolean;
  /** The opponent whose block caused it (Plague Ridden). */
  attackerId?: string;
  /** Bitten by a Bloodlust player: a casualty is only Badly Hurt. */
  bitten?: boolean;
  /** A Stunned result counts as KO'd (a fumbled Kick Team-mate). */
  stunnedIsKo?: boolean;
}

/** Resolve an injury roll total on `player`: emits the table result and pushes the casualty / apothecary follow-up. */
export function injure(ctx: Ctx, player: PlayerState, total: number, { crowd = false, attackerId, bitten = false, stunnedIsKo = false }: InjuryCause = {}) {
  const rolled = injuryOutcome(player, total);
  const outcome = bitten && rolled === "casualty" ? "badly-hurt" : stunnedIsKo && rolled === "stunned" ? "ko" : rolled;
  ctx.emit({ type: "PlayerInjured", playerId: player.id, result: outcome === "stunned" ? "stunned" : outcome === "ko" ? "ko" : "cas" });
  ctx.push({
    type: "Injury",
    playerId: player.id,
    outcome,
    crowd,
    ...(attackerId ? { attackerId } : {}),
    stage: outcome === "casualty" ? "casualty" : outcome === "badly-hurt" ? afterCasualty(player) : "apothecary",
    ...(outcome === "badly-hurt" ? { casualty: { result: "badly-hurt" as const } } : {}),
  });
}

/** Roll the casualty dice and read the table. */
function rollCasualty(ctx: Ctx, player: PlayerState, action: Action, reason: string) {
  const [d16, d6] = ctx.roll(action, CASUALTY_DICE, reason);
  const casualty = casualtyFor(player, d16!, d6!);
  ctx.emit({ type: "CasualtyRolled", playerId: player.id, roll: d16! + casualtyModifier(player), casualty });
  return casualty;
}

/**
 * After the injury roll: a casualty rolls on the casualty table, then Regeneration (4+: back to the reserves), then the
 * team's apothecary (once per game) may treat
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
        proc.stage = regenerated ? "place" : "apothecary";
        return "continue";
      }
      case "apothecary": {
        if (proc.outcome === "stunned" || team.apothecaries === 0) {
          proc.stage = "place";
          return "continue";
        }
        if (action === null) return "wait";
        if (!ctx.expect(action, "USE_APOTHECARY").use) {
          proc.stage = "place";
          return "continue";
        }
        team.apothecaries -= 1;
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
    if (proc.casualty!.result === "dead" && proc.attackerId) raiseInfected(ctx, player, getPlayer(ctx, proc.attackerId));
  }
  if (proc.treated) {
    const result = proc.healed ? "reserves" : proc.outcome === "stunned" ? "stunned" : "casualty";
    ctx.emit({ type: "ApothecaryResult", playerId: player.id, result, casualty: result === "casualty" ? proc.casualty! : null });
  }
}

/** A killed player with one of these skills cannot be raised (Plague Ridden). */
const UNRAISABLE_SKILLS = ["Stunty", "Regeneration", "Decay"];

/**
 * Plague Ridden: once per game, an opponent killed by the block of a player with the skill (not a Big Guy, and
 * without Stunty, Regeneration or Decay) joins the blocker's team in the reserves, as a new player of its lineman
 * position.
 */
function raiseInfected(ctx: Ctx, dead: PlayerState, attacker: PlayerState) {
  const { state } = ctx;
  const team = state.teams[attacker.side];
  if (!hasSkill(attacker, "Plague Ridden") || attacker.side === dead.side || !team.raisePosition || team.raisedDead > 0) return;
  if (dead.keywords.includes("big guy") || UNRAISABLE_SKILLS.some((s) => hasSkill(dead, s))) return;
  const nr = 1 + Math.max(...teamPlayers(state, attacker.side).map((p) => p.nr));
  const raised = createPlayer(attacker.side, { ...team.raisePosition, nr, name: dead.name });
  state.players[raised.id] = raised;
  team.raisedDead += 1;
  ctx.emit({ type: "PlayerRaised", playerId: raised.id, fromId: dead.id });
}
