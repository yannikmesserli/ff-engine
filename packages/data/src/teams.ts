import { SKILL_CATEGORIES, type InducementId, type InducementPrices, type PositionStats, type TeamSetup } from "@bb/engine";
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
  primary: position.normal,
});

/**
 * BB2025 inducements: the most a team may buy, the special rule it needs, a special rule (or roster keyword) that
 * raises the limit or lowers the cost, and the cost in gold pieces.
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

/** What the team may buy (INDUCEMENT_RULES with its special rules and roster applied): cost and limit of each inducement. */
function inducementPrices(team: TeamFile, roster: Roster): InducementPrices {
  const has = (name: string) => (team.specialRules as string[]).includes(name) || roster.keywords.includes(name);
  const prices: InducementPrices = {};
  for (const [id, rule] of Object.entries(INDUCEMENT_RULES) as Array<[InducementId, (typeof INDUCEMENT_RULES)[InducementId]]>) {
    if (rule.requires && !has(rule.requires)) continue;
    const discount = rule.discount && has(rule.discount.rule) ? rule.discount : undefined;
    let max = discount?.max ?? rule.max;
    if (id === "partTimeCoaches") max = Math.min(max, MAX_COACHES - team.assistantCoaches);
    if (id === "tempCheerleaders") max = Math.min(max, MAX_CHEERLEADERS - team.cheerleaders);
    prices[id] = { cost: discount?.cost ?? rule.cost, max: Math.max(0, max) };
  }
  return prices;
}

/** Check the inducements a team file lists against what the team may buy. */
function checkInducements(team: TeamFile, prices: InducementPrices) {
  for (const [id, bought] of Object.entries(team.inducements) as Array<[InducementId, number]>) {
    if (bought === 0) continue;
    const rule = INDUCEMENT_RULES[id];
    if (!prices[id]) throw new TeamError(`Only teams with ${rule.requires} may buy ${id}.`);
    if (bought > prices[id].max) throw new TeamError(`At most ${prices[id].max} ${id} for this team (${bought} bought).`);
  }
}

/** BB2025 value of the sideline staff: each assistant coach and cheerleader, and the apothecary. */
const STAFF_VALUE = 10_000;
const APOTHECARY_VALUE = 50_000;
/** Value added by each characteristic improvement. */
const IMPROVEMENT_VALUE: Record<Characteristic, number> = { ma: 30_000, st: 60_000, ag: 30_000, pa: 20_000, av: 10_000 };
/** Value added by a gained skill: from a primary category (or none), or from a secondary one. */
const PRIMARY_SKILL_VALUE = 20_000;
const SECONDARY_SKILL_VALUE = 30_000;

/** A player's value: the position's cost plus their advancements (lasting injuries do not lower it). */
function playerValue(player: TeamPlayer, position: Roster["positions"][number]) {
  const secondary = (skill: string) => position.double.some((c) => SKILL_CATEGORIES[c]?.includes(skill));
  const skills = player.skills.reduce((sum, s) => sum + (secondary(s) ? SECONDARY_SKILL_VALUE : PRIMARY_SKILL_VALUE), 0);
  const improvements = (Object.entries(player.improvements) as Array<[Characteristic, number]>).reduce((sum, [stat, n]) => sum + n * IMPROVEMENT_VALUE[stat], 0);
  return position.cost + skills + improvements;
}

/**
 * Current Team Value: the players available for the game (not those who miss it) at their value, the journeymen hired
 * for it, the team re-rolls at the roster's price, the assistant coaches, cheerleaders and apothecary. Dedicated Fans and
 * the treasury do not count.
 */
function currentTeamValue(team: TeamFile, roster: Roster) {
  const players = team.players
    .filter((p) => !p.missNextGame)
    .reduce((sum, p) => sum + playerValue(p, roster.positions.find((pos) => pos.title === p.position)!), 0);
  const hired = journeymen(roster, team).length * (journeymanPosition(roster, team)?.cost ?? 0);
  const staff = (team.assistantCoaches + team.cheerleaders) * STAFF_VALUE + (team.apothecary ? APOTHECARY_VALUE : 0);
  return players + hired + team.rerolls * roster.rerollCost + staff;
}

/** The Current Team Value of a valid team file (see `resolveTeam`, which checks it first). */
export const teamValue = (input: unknown, availableRosters: Roster[] = rosters) => resolveTeam(input, availableRosters).teamValue!;

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
  const prices = inducementPrices(team, roster);
  checkInducements(team, prices);
  if (team.captain !== undefined && !team.players.some((p) => p.number === team.captain)) {
    throw new TeamError(`The Team Captain (#${team.captain}) is not in the team.`);
  }
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
    ...(journeymanPosition(roster, team) ? { journeymanPosition: positionStats(journeymanPosition(roster, team)!) } : {}),
    inducements: { ...team.inducements },
    inducementPrices: prices,
    teamValue: currentTeamValue(team, roster),
    treasury: team.treasury,
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
          skills: [...position.skills, ...p.skills, ...(p.number === team.captain ? captainSkills([...position.skills, ...p.skills]) : [])],
          keywords: position.keywords,
          primary: position.normal,
          nigglingInjuries: p.injuries.filter((i) => i === "niggling").length,
          advancements: p.skills.length + Object.values(p.improvements).reduce((sum, n) => sum + (n ?? 0), 0),
        };
      }), ...journeymen(roster, team)],
  };
}

/** Team Captain: the trait, and Pro unless the player has it already; neither counts as an advancement. */
const captainSkills = (skills: string[]) => [...(skills.includes("Pro") ? [] : ["Pro"]), "Team Captain"];

/** The position journeymen and Riotous Rookies come from: the one the team file names, or the roster's first. */
const journeymanPosition = (roster: Roster, team: TeamFile) => {
  const candidates = journeymenPositions(roster);
  return typeof team.journeymen === "string" ? candidates.find((p) => p.title === team.journeymen) : candidates[0];
};

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
