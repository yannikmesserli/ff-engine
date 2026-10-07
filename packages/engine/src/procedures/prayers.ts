import type { Ctx, Handler } from "../context";
import type { GameState, PlayerState, Prayer, Procedure, Side } from "../types";
import { PRAYERS } from "../types";
import { other, teamPlayers } from "../pitch";
import { hasSkill } from "../skills";
import { getPlayer } from "./helpers";

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
 * Greasy Cleats (a random opponent gets -1 MA), Blessing of Nuffle (a random player gains Pro). The others are
 * recorded on the team for the rules they change.
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
    if (proc.stage === "badHabits") {
      const [count] = ctx.roll(action, [{ kind: "d3", count: 1 }], "Bad Habits");
      const victims = pickRandom(ctx, candidates(state, other(side), (p) => !hasSkill(p, "Loner")), count!);
      return next(ctx, proc, side, victims);
    }
    const [roll] = ctx.roll(action, [{ kind: "d16", count: 1 }], `Prayer to Nuffle (${team.name})`);
    const prayer = PRAYERS[roll! - 1]!;
    // A team never gets the same prayer twice: roll again.
    if (team.prayers.includes(prayer)) return "wait";
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
    if (proc.stage === "badHabits") return [{ type: "ROLL", side, dice: [{ kind: "d3", count: 1 }], reason: "Bad Habits: D3 opponents gain Loner (2+)" }];
    return [{ type: "ROLL", side, dice: [{ kind: "d16", count: 1 }], reason: `Prayer to Nuffle (${state.teams[side].name})` }];
  },
};

/** The prayer is granted to these players; on to the next draw. */
function next(ctx: Ctx, proc: P<"Prayers">, side: Side, players: PlayerState[]) {
  grant(ctx, side, proc.prayer!, players.map((p) => getPlayer(ctx, p.id)));
  proc.draws.shift();
  delete proc.prayer;
  proc.stage = "draw";
  return "continue" as const;
}
