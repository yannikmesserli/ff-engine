import type { Ctx, Handler } from "../context";
import type { GameState, PlayerState, Prayer, Procedure, Side, Square } from "../types";
import { PRAYERS } from "../types";
import { ballCarrier, isOnPitch, other, sameSquare, teamPlayers } from "../pitch";
import { SKILL_CATEGORIES, hasSkill } from "../skills";
import { getPlayer, squareOf } from "./helpers";
import { injure } from "./injury";

type P<T extends Procedure["type"]> = Extract<Procedure, { type: T }>;

/** Iron Man: +1 AV, up to 11+. */
export const IRON_MAN_MAX_AV = 11;

/** Bad Habits: the opponents gain Loner (2+). */
export const BAD_HABITS_LONER = "Loner(2)";

/** Display names of the prayers, for roll reasons. */
export const PRAYER_NAMES: Record<Prayer, string> = {
  "treacherous-trapdoor": "Treacherous Trapdoor",
  "friends-with-the-ref": "Friends with the Ref",
  stiletto: "Stiletto",
  "iron-man": "Iron Man",
  "knuckle-dusters": "Knuckle Dusters",
  "bad-habits": "Bad Habits",
  "greasy-cleats": "Greasy Cleats",
  "blessing-of-nuffle": "Blessing of Nuffle",
  "moles-under-the-pitch": "Moles under the Pitch",
  "perfect-passing": "Perfect Passing",
  "dazzling-catching": "Dazzling Catching",
  "fan-interaction": "Fan Interaction",
  "fouling-frenzy": "Fouling Frenzy",
  "throw-a-rock": "Throw a Rock",
  "under-scrutiny": "Under Scrutiny",
  "intensive-training": "Intensive Training",
};

/** The team's players a prayer may change: in the reserves (not KO'd or injured) and `fits`. */
const candidates = (state: GameState, side: Side, fits: (p: PlayerState) => boolean) =>
  teamPlayers(state, side).filter((p) => p.at === "reserves" && fits(p));

/** Players a coach-chosen prayer may go to: Iron Man (AV below 11+), Knuckle Dusters (without Mighty Blow). */
export function prayerChoices(state: GameState, side: Side, prayer: Prayer): PlayerState[] {
  if (prayer === "iron-man") return candidates(state, side, (p) => p.av < IRON_MAN_MAX_AV);
  return candidates(state, side, (p) => !hasSkill(p, "Mighty Blow"));
}

/** Intensive Training: the primary skills the player does not have yet, by name. */
export const trainingSkills = (player: PlayerState) =>
  player.primary.flatMap((c) => SKILL_CATEGORIES[c] ?? []).filter((s) => !hasSkill(player, s)).sort();

/** Pick `count` players at random, without repeats. */
function pickRandom(ctx: Ctx, players: PlayerState[], count: number): PlayerState[] {
  const pool = [...players];
  const picked: PlayerState[] = [];
  while (picked.length < count && pool.length > 0) picked.push(pool.splice(ctx.random(pool.length), 1)[0]!);
  return picked;
}

/** A prayer's effect on players, once they are known. */
function grant(ctx: Ctx, side: Side, prayer: Prayer, players: PlayerState[]) {
  for (const p of players) {
    if (prayer === "stiletto") p.skills.push("Stab");
    if (prayer === "iron-man") p.av = Math.min(IRON_MAN_MAX_AV, p.av + 1);
    if (prayer === "knuckle-dusters") p.skills.push("Mighty Blow");
    if (prayer === "bad-habits") p.skills.push(BAD_HABITS_LONER);
    if (prayer === "greasy-cleats") p.ma = Math.max(1, p.ma - 1);
    if (prayer === "blessing-of-nuffle") p.skills.push("Pro");
  }
  ctx.emit({ type: "PrayerGranted", side, prayer, playerIds: players.map((p) => p.id) });
}

/**
 * Prayers to Nuffle (bought as inducements), before the coin toss: each one is a D16 on the table, re-rolled when the
 * team already has that result. All last the whole game. Those that change players pick them among the team's players
 * in the reserves: Stiletto (a random player gains Stab), Iron Man (one the coach picks gets +1 AV, up to 11+), Knuckle
 * Dusters (one the coach picks gains Mighty Blow), Bad Habits (D3 random opponents without Loner gain Loner (2+)),
 * Greasy Cleats (a random opponent gets -1 MA), Blessing of Nuffle (a random player gains Pro), Intensive Training (a
 * random player gains a primary skill the coach picks). The others are recorded on the team for the rules they change.
 */
export const Prayers: Handler<P<"Prayers">> = {
  step(ctx, proc, action) {
    const { state } = ctx;
    const side = proc.draws[0];
    if (side === undefined) return "done";
    const team = state.teams[side];
    if (proc.stage === "choose") {
      const choices = prayerChoices(state, side, proc.prayer!);
      if (choices.length === 0) return next(ctx, proc, side, []);
      if (action === null) return "wait";
      const { playerIds } = ctx.expect(action, "SELECT_PLAYERS");
      const chosen = playerIds.length === 1 ? choices.find((p) => p.id === playerIds[0]) : undefined;
      if (!chosen) ctx.reject("Choose one of the players offered.");
      return next(ctx, proc, side, [chosen!]);
    }
    if (action === null) return "wait";
    if (proc.stage === "skill") {
      const player = getPlayer(ctx, proc.playerId!);
      const { skill } = ctx.expect(action, "CHOOSE_SKILL");
      if (!trainingSkills(player).includes(skill)) ctx.reject("Choose one of the skills offered.");
      player.skills.push(skill);
      return next(ctx, proc, side, [player]);
    }
    if (proc.stage === "badHabits") {
      const [count] = ctx.roll(action, [{ kind: "d3", count: 1 }], "Bad Habits");
      const victims = pickRandom(ctx, candidates(state, other(side), (p) => !hasSkill(p, "Loner")), count!);
      return next(ctx, proc, side, victims);
    }
    const [roll] = ctx.roll(action, [{ kind: "d16", count: 1 }], `Prayer to Nuffle (${team.name})`);
    const prayer = PRAYERS[roll! - 1]!;
    // A team never gets the same prayer twice: roll again.
    if (team.prayers.includes(prayer)) {
      proc.repeated = prayer;
      ctx.emit({ type: "PrayerRepeated", side, prayer });
      return "wait";
    }
    delete proc.repeated;
    team.prayers.push(prayer);
    proc.prayer = prayer;
    switch (prayer) {
      case "iron-man":
      case "knuckle-dusters":
        proc.stage = "choose";
        return "continue";
      case "bad-habits":
        proc.stage = "badHabits";
        return "wait";
      case "stiletto":
        return next(ctx, proc, side, pickRandom(ctx, candidates(state, side, (p) => !hasSkill(p, "Stab")), 1));
      case "greasy-cleats":
        return next(ctx, proc, side, pickRandom(ctx, candidates(state, other(side), () => true), 1));
      case "blessing-of-nuffle":
        return next(ctx, proc, side, pickRandom(ctx, candidates(state, side, (p) => !hasSkill(p, "Pro")), 1));
      case "intensive-training": {
        const [trainee] = pickRandom(ctx, candidates(state, side, (p) => trainingSkills(p).length > 0), 1);
        if (!trainee) return next(ctx, proc, side, []);
        proc.playerId = trainee.id;
        proc.stage = "skill";
        return "wait";
      }
      default:
        return next(ctx, proc, side, []);
    }
  },
  actions(state, proc) {
    const side = proc.draws[0]!;
    if (proc.stage === "choose") {
      const playerIds = prayerChoices(state, side, proc.prayer!).map((p) => p.id);
      return [{ type: "SELECT_PLAYERS", side, playerIds, min: 1, max: 1, reason: `${PRAYER_NAMES[proc.prayer!]}: choose the player` }];
    }
    if (proc.stage === "skill") return [{ type: "CHOOSE_SKILL", side, playerId: proc.playerId!, skills: trainingSkills(state.players[proc.playerId!]!) }];
    if (proc.stage === "badHabits") return [{ type: "ROLL", side, dice: [{ kind: "d3", count: 1 }], reason: "Bad Habits: D3 opponents gain Loner (2+)" }];
    const again = proc.repeated ? `: ${PRAYER_NAMES[proc.repeated]} again, the team already has it, roll again` : "";
    return [{ type: "ROLL", side, dice: [{ kind: "d16", count: 1 }], reason: `Prayer to Nuffle (${state.teams[side].name})${again}` }];
  },
};

/** The prayer is granted to these players; on to the next draw. */
function next(ctx: Ctx, proc: P<"Prayers">, side: Side, players: PlayerState[]) {
  grant(ctx, side, proc.prayer!, players.map((p) => getPlayer(ctx, p.id)));
  proc.draws.shift();
  delete proc.prayer;
  delete proc.playerId;
  proc.stage = "draw";
  return "continue" as const;
}

/** Treacherous Trapdoor (a prayer of either team): the two trapdoor squares. */
export const TRAPDOORS = [
  { x: 6, y: 1 },
  { x: 19, y: 13 },
];

/** A player entering a trapdoor falls through on a 1. */
export const TRAPDOOR_TARGET = 2;

/**
 * The Trapdoor roll due for a player who just entered `square`, if it is a trapdoor and a team prayed for them.
 * `sppTo`: who earns Star Player Points if the fall is a casualty (a pushed player, with Fan Interaction).
 */
export function trapdoor(state: GameState, player: PlayerState, square: Square, sppTo: string[] = []): Procedure[] {
  if (!Object.values(state.teams).some((t) => t.prayers.includes("treacherous-trapdoor"))) return [];
  if (!TRAPDOORS.some((t) => sameSquare(t, square))) return [];
  return [{ type: "Trapdoor", playerId: player.id, stage: "roll", ...(sppTo.length > 0 ? { sppTo } : {}) }];
}

/**
 * Treacherous Trapdoor (a prayer; it affects both teams): a player who moves, is pushed or follows up into a trapdoor
 * rolls a D6 (team re-roll in their turn) and falls through on a 1: off the pitch, an injury roll without armour (as for
 * the crowd), the ball they held bounces from the trapdoor, and it is a turnover if they are of the moving team.
 */
export const Trapdoor: Handler<P<"Trapdoor">> = {
  step(ctx, proc, action) {
    const { state } = ctx;
    const player = getPlayer(ctx, proc.playerId);
    if (proc.stage === "roll") {
      if (!isOnPitch(player)) return "done";
      state.lastCheck = null;
      ctx.push({ type: "Check", kind: "trapdoor", playerId: player.id, target: TRAPDOOR_TARGET, modifier: 0, stage: "roll", rerolled: false });
      proc.stage = "result";
      return "continue";
    }
    if (proc.stage === "result") {
      const safe = state.lastCheck?.kind !== "trapdoor" || state.lastCheck.success;
      state.lastCheck = null;
      if (safe) return "done";
      proc.stage = "injury";
      return "wait";
    }
    if (action === null) return "wait";
    const square = squareOf(ctx, player);
    const carrying = ballCarrier(state)?.id === player.id;
    const [a, b] = ctx.roll(action, [{ kind: "d6", count: 2 }], "Injury (trapdoor)");
    player.at = "reserves";
    ctx.emit({ type: "FellThroughTrapdoor", playerId: player.id });
    if (player.side === state.activeSide) state.turnover = true;
    // The ball bounces once the injury is resolved.
    if (carrying) {
      state.ball = { square: { ...square }, carried: false };
      ctx.push({ type: "Bounce", from: { ...square }, kickoff: false, receiving: null });
    }
    injure(ctx, player, a! + b!, { crowd: true, ...(proc.sppTo ? { sppTo: proc.sppTo } : {}) });
    return "done";
  },
  actions(state, proc) {
    if (proc.stage !== "injury") return [];
    return [{ type: "ROLL", side: null, dice: [{ kind: "d6", count: 2 }], reason: `Injury (${state.players[proc.playerId]!.name}, trapdoor)` }];
  },
};
