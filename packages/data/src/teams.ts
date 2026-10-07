import type { InducementId, PositionStats, TeamSetup } from "@bb/engine";
import rosterData from "./generated/rosters.json";
import teamData from "./teams.json";
import { RosterSchema, TeamFileSchema, type Characteristic, type Roster, type TeamFile, type TeamPlayer } from "./schemas";

/** BB2025 rosters, fetched from FUMBBL (see scripts/fetch-rosters.ts). */
export const rosters: Roster[] = RosterSchema.array().parse(rosterData.rosters);

/** Bundled example teams, keyed by name, e.g. "human". */
export const exampleTeams: Record<string, TeamFile> = Object.fromEntries(
  Object.entries(teamData).map(([key, value]) => [key, TeamFileSchema.parse(value)]),
);

/** Thrown by resolveTeam() when a team file is malformed or breaks its roster's limits. */
export class TeamError extends Error {
  override name = "TeamError";
}

const clamp = (v: number, [min, max]: readonly [number, number]) => Math.min(max, Math.max(min, v));

/** BB2025 characteristic limits (min, max). */
const STAT_LIMITS = {
  ma: [1, 9],
  st: [1, 8],
  ag: [1, 6],
  pa: [1, 6],
  av: [3, 11],
} as const;

/** Characteristic after improvements and injuries. AG and PA are target numbers, so improving them lowers the value. */
function characteristic(player: TeamPlayer, stat: Characteristic, base: number) {
  const improved = player.improvements[stat] ?? 0;
  const injured = player.injuries.filter((i) => i === stat).length;
  const delta = stat === "ag" || stat === "pa" ? injured - improved : improved - injured;
  return clamp(base + delta, STAT_LIMITS[stat]);
}

/** A position's starting characteristics, skills and keywords. */
const positionStats = (position: Roster["positions"][number]): PositionStats => ({
  position: position.title,
  ma: position.ma,
  st: position.st,
  ag: position.ag,
  pa: position.pa,
  av: position.av,
  skills: [...position.skills],
  keywords: position.keywords,
});

/**
 * BB2025 inducements: the most a team may buy, the special rule it needs, a special rule (or roster keyword) that
 * raises the limit or lowers the cost, and the cost in gold pieces (for reference: the team file lists what was bought).
 */
export const INDUCEMENT_RULES: Record<InducementId, { max: number; cost: number; requires?: string; discount?: { rule: string; cost: number; max?: number } }> = {
  bribes: { max: 3, cost: 100_000, discount: { rule: "Bribery and Corruption", cost: 50_000, max: 6 } },
  teamMascot: { max: 1, cost: 25_000 },
  partTimeCoaches: { max: 3, cost: 20_000 },
  tempCheerleaders: { max: 4, cost: 20_000 },
  blitzersBestKegs: { max: 2, cost: 50_000 },
  halflingMasterChef: { max: 1, cost: 300_000, discount: { rule: "master chef", cost: 100_000 } },
  riotousRookies: { max: 1, cost: 100_000, requires: "Low Cost Linemen" },
  plagueDoctor: { max: 1, cost: 100_000, requires: "Favoured of Nurgle" },
  mortuaryAssistant: { max: 1, cost: 100_000, requires: "Masters of Undeath" },
  weatherMage: { max: 1, cost: 30_000 },
  biasedReferee: { max: 1, cost: 120_000, discount: { rule: "Bribery and Corruption", cost: 80_000 } },
  prayers: { max: 3, cost: 50_000 },
};

/** At most 9 assistant coaches (own and part-time) and 16 cheerleaders (own and temporary). */
const MAX_COACHES = 9;
const MAX_CHEERLEADERS = 16;

/** Check the inducements a team bought against INDUCEMENT_RULES. */
function checkInducements(team: TeamFile, roster: Roster) {
  for (const [id, bought] of Object.entries(team.inducements) as Array<[InducementId, number]>) {
    if (bought === 0) continue;
    const rule = INDUCEMENT_RULES[id];
    const has = (name: string) => (team.specialRules as string[]).includes(name) || roster.keywords.includes(name);
    if (rule.requires && !has(rule.requires)) throw new TeamError(`Only teams with ${rule.requires} may buy ${id}.`);
    let max = rule.discount && has(rule.discount.rule) ? (rule.discount.max ?? rule.max) : rule.max;
    if (id === "partTimeCoaches") max = Math.min(max, MAX_COACHES - team.assistantCoaches);
    if (id === "tempCheerleaders") max = Math.min(max, MAX_CHEERLEADERS - team.cheerleaders);
    if (bought > max) throw new TeamError(`At most ${max} ${id} for this team (${bought} bought).`);
  }
}

/** A team takes journeymen when it has fewer players than this available for the game. */
export const JOURNEYMEN_UP_TO = 11;

/** Positions journeymen may be hired from: the roster's 0-12 or 0-16 positions that are not Irregular (its linemen). */
export const journeymenPositions = (roster: Roster) => roster.positions.filter((p) => (p.quantity === 12 || p.quantity === 16) && p.type !== "Irregular");

/**
 * Validate a team file against its BB2025 roster (re-rolls, apothecary, position quantities, Big Guys, Insignificant
 * players) and build the
 * engine's team: position characteristics with improvements and injuries applied, position skills plus gained ones.
 * Players who miss the next game are left out. Journeymen: a team with fewer than 11 players left gets free ones up to
 * 11 (unless `journeymen` is false), from its lineman position (`journeymen` names it when there are several), with
 * Loner (4+).
 */
export function resolveTeam(input: unknown, availableRosters: Roster[] = rosters): TeamSetup {
  const parsed = TeamFileSchema.safeParse(input);
  if (!parsed.success) throw new TeamError(`Invalid team file: ${parsed.error.message}`);
  const team = parsed.data;
  const roster = availableRosters.find((r) => r.name === team.roster);
  if (!roster) throw new TeamError(`Unknown roster "${team.roster}".`);
  if (team.rerolls > roster.maxRerolls) throw new TeamError(`${roster.name} can have at most ${roster.maxRerolls} re-rolls.`);
  if (team.apothecary && !roster.apothecary) throw new TeamError(`${roster.name} cannot hire an apothecary.`);
  checkInducements(team, roster);
  const positionOf = (player: TeamPlayer) => {
    const position = roster.positions.find((pos) => pos.title === player.position);
    if (!position) throw new TeamError(`Unknown position "${player.position}" for ${roster.name}.`);
    return position;
  };
  for (const position of roster.positions) {
    const count = team.players.filter((p) => p.position === position.title).length;
    if (count > position.quantity) {
      throw new TeamError(`At most ${position.quantity} ${position.title} allowed (${count} in team).`);
    }
  }
  const bigGuys = team.players.filter((p) => positionOf(p).type === "Big Guy").length;
  if (bigGuys > roster.maxBigGuys) throw new TeamError(`${roster.name} can have at most ${roster.maxBigGuys} Big Guys.`);
  // Insignificant: no more players with the trait than players without it.
  const insignificant = team.players.filter((p) => [...positionOf(p).skills, ...p.skills].includes("Insignificant")).length;
  if (insignificant > team.players.length - insignificant) {
    throw new TeamError(`At most as many Insignificant players as other players (${insignificant} of ${team.players.length}).`);
  }
  // Plague Ridden: a killed opponent may join the team as a lineman.
  const plagueRidden = team.players.some((p) => [...positionOf(p).skills, ...p.skills].includes("Plague Ridden"));
  const lineman = roster.positions.find((pos) => pos.keywords.includes("lineman"));
  return {
    name: team.name,
    roster: team.roster,
    rerolls: team.rerolls,
    apothecary: team.apothecary,
    dedicatedFans: team.dedicatedFans,
    cheerleaders: team.cheerleaders,
    assistantCoaches: team.assistantCoaches,
    specialRules: [...team.specialRules],
    inducements: { ...team.inducements },
    ...(plagueRidden && lineman ? { raisePosition: positionStats(lineman) } : {}),
    players: [...team.players
      .filter((p) => !p.missNextGame)
      .map((p) => {
        const position = positionOf(p);
        return {
          nr: p.number,
          name: p.name,
          position: p.position,
          ma: characteristic(p, "ma", position.ma),
          st: characteristic(p, "st", position.st),
          ag: characteristic(p, "ag", position.ag),
          pa: position.pa === null ? null : characteristic(p, "pa", position.pa),
          av: characteristic(p, "av", position.av),
          skills: [...position.skills, ...p.skills],
          keywords: position.keywords,
          nigglingInjuries: p.injuries.filter((i) => i === "niggling").length,
        };
      }), ...journeymen(roster, team)],
  };
}

/** The journeymen a team takes for the game: the smallest free numbers, Loner (4+) added to the position's skills. */
function journeymen(roster: Roster, team: TeamFile) {
  const missing = JOURNEYMEN_UP_TO - team.players.filter((p) => !p.missNextGame).length;
  if (missing <= 0 || team.journeymen === false) return [];
  const candidates = journeymenPositions(roster);
  const position = team.journeymen === true ? candidates[0] : candidates.find((p) => p.title === team.journeymen);
  if (!position) {
    throw new TeamError(team.journeymen === true ? `${roster.name} has no position to hire journeymen from.` : `Journeymen cannot be ${team.journeymen} for ${roster.name}.`);
  }
  const used = new Set(team.players.map((p) => p.number));
  const numbers: number[] = [];
  for (let nr = 1; numbers.length < missing; nr++) if (!used.has(nr)) numbers.push(nr);
  const stats = positionStats(position);
  const loner = stats.skills.some((s) => s.startsWith("Loner")) ? [] : ["Loner(4)"];
  return numbers.map((nr) => ({ ...stats, skills: [...stats.skills, ...loner], nr, name: `Journeyman #${nr}`, nigglingInjuries: 0 }));
}
