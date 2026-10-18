import { SKILL_CATEGORIES, type HireOffer, type InducementId, type InducementPrices, type PositionStats, type TeamSetup } from "@bb/engine";
import rosterData from "./generated/rosters.json";
import teamData from "./teams.json";
import { MAX_PLAYERS, RosterSchema, StarPlayerSchema, TeamFileSchema, type Characteristic, type Roster, type StarPlayer, type TeamFile, type TeamPlayer } from "./schemas";

/** BB2025 rosters, fetched from FUMBBL (see scripts/fetch-rosters.ts). */
export const rosters: Roster[] = RosterSchema.array().parse(rosterData.rosters);

/** BB2025 star players, fetched from FUMBBL; each roster lists those it may hire (`Roster.stars`). */
export const starPlayers: StarPlayer[] = StarPlayerSchema.array().parse(rosterData.starPlayers);

/** FUMBBL's image server, which the artwork paths of rosters and star players are relative to (images not included). */
export const artworkBase: string = rosterData.artworkBase;

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
  wizard: { max: 1, cost: 150_000 },
  josefBugman: { max: 1, cost: 100_000 },
  wanderingApothecaries: { max: 2, cost: 100_000 },
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
    // Wandering Apothecaries: only for a roster that may have an apothecary.
    if (id === "wanderingApothecaries" && !roster.apothecary) continue;
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
    if (!prices[id]) throw new TeamError(rule.requires ? `Only teams with ${rule.requires} may buy ${id}.` : `This team cannot buy ${id}.`);
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

/** A team may hire up to this many star players for a game (a pair hired together counts as one). */
const MAX_STARS = 2;
/** A mercenary costs the position's price plus this; an extra skill costs this much more. */
const MERCENARY_EXTRA_COST = 30_000;
const MERCENARY_SKILL_COST = 50_000;

/** A star player's characteristics and skills, as the engine's PositionStats (the position is their name). */
const starStats = (star: StarPlayer): PositionStats => ({
  position: star.name,
  ma: star.ma,
  st: star.st,
  ag: star.ag,
  pa: star.pa,
  av: star.av,
  skills: [...star.skills],
  keywords: star.keywords,
  primary: [],
});

/**
 * Star players and mercenaries the team may hire for a game: the star players its roster lists; mercenaries from any
 * of its positions with room left (counting the players available and the journeymen), Big Guys only within the
 * roster's limit, each with an optional extra skill from the position's primary categories.
 */
function hireOffer(team: TeamFile, roster: Roster, journeymen: string[]): HireOffer {
  const available = [...team.players.filter((p) => !p.missNextGame), ...journeymen.map((position) => ({ position }))];
  const bigGuys = available.filter((p) => roster.positions.find((pos) => pos.title === p.position)?.type === "Big Guy").length;
  return {
    stars: roster.stars.flatMap((name) => {
      const star = starPlayers.find((s) => s.name === name);
      return star ? [{ ...starStats(star), cost: star.cost, ...(star.partner ? { partner: star.partner } : {}) }] : [];
    }),
    maxStars: MAX_STARS,
    mercenaries: roster.positions.map((position) => ({
      stats: positionStats(position),
      cost: position.cost + MERCENARY_EXTRA_COST,
      max: Math.max(0, position.quantity - available.filter((p) => p.position === position.title).length),
      bigGuy: position.type === "Big Guy",
      skills: position.normal.flatMap((c) => SKILL_CATEGORIES[c] ?? []).filter((s) => !position.skills.includes(s)).sort(),
    })),
    maxBigGuys: Math.max(0, roster.maxBigGuys - bigGuys),
    mercenarySkillCost: MERCENARY_SKILL_COST,
  };
}

/** The star players and mercenaries a team file lists, checked against its offer, as players for the game. */
function hiredPlayers(team: TeamFile, offer: HireOffer, firstNr: number): TeamSetup["players"] {
  let nr = firstNr;
  const stars = team.starPlayers.map((name) => {
    const star = offer.stars.find((s) => s.position === name);
    if (!star) throw new TeamError(`${team.roster} cannot hire the star player ${name}.`);
    if (star.partner && !team.starPlayers.includes(star.partner)) throw new TeamError(`${name} and ${star.partner} are hired together.`);
    const { cost: _, partner: __, ...stats } = star;
    return { ...stats, nr: nr++, name, hired: "star" as const };
  });
  if (new Set(team.starPlayers).size !== team.starPlayers.length) throw new TeamError("A star player can only be hired once.");
  const counted = team.starPlayers.filter((name) => {
    const partner = offer.stars.find((s) => s.position === name)!.partner;
    return !partner || name < partner;
  });
  if (counted.length > offer.maxStars) throw new TeamError(`At most ${offer.maxStars} star players.`);
  let bigGuys = 0;
  const mercenaries = team.mercenaries.map((choice) => {
    const merc = offer.mercenaries.find((m) => m.stats.position === choice.position);
    if (!merc) throw new TeamError(`Unknown position "${choice.position}" for ${team.roster} mercenaries.`);
    if (team.mercenaries.filter((m) => m.position === choice.position).length > merc.max) throw new TeamError(`At most ${merc.max} ${choice.position} mercenaries.`);
    if (choice.skill !== undefined && !merc.skills.includes(choice.skill)) throw new TeamError(`A ${choice.position} mercenary cannot gain ${choice.skill}.`);
    if (merc.bigGuy && ++bigGuys > offer.maxBigGuys) throw new TeamError(`At most ${offer.maxBigGuys} more Big Guys.`);
    const loner = merc.stats.skills.some((s) => s.startsWith("Loner")) ? [] : ["Loner(4)"];
    const skills = [...merc.stats.skills, ...loner, ...(choice.skill !== undefined ? [choice.skill] : [])];
    return { ...merc.stats, skills, nr: nr++, name: `${choice.position} (mercenary)`, hired: "mercenary" as const };
  });
  return [...stars, ...mercenaries];
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
  // Plague Ridden and Masters of Undeath: a killed opponent may join the team as a lineman.
  const plagueRidden = team.players.some((p) => [...positionOf(p).skills, ...p.skills].includes("Plague Ridden"));
  const raises = plagueRidden || (team.specialRules as string[]).includes("Masters of Undeath");
  const linemen = roster.positions.filter((pos) => pos.keywords.includes("lineman"));
  const hired = journeymen(roster, team);
  const offer = hireOffer(team, roster, hired.map((p) => p.position));
  const players = [
    ...team.players
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
          skills: [
            ...position.skills,
            ...p.skills,
            ...p.hatred.map((keyword) => `Hatred(${keyword})`),
            ...(p.number === team.captain ? captainSkills([...position.skills, ...p.skills]) : []),
          ],
          keywords: position.keywords,
          primary: position.normal,
          nigglingInjuries: p.injuries.filter((i) => i === "niggling").length,
          advancements: p.skills.length + Object.values(p.improvements).reduce((sum, n) => sum + (n ?? 0), 0),
        };
      }),
    ...hired,
  ];
  const stars = hiredPlayers(team, offer, 1 + Math.max(0, ...team.players.map((p) => p.number), ...players.map((p) => p.nr)));
  if (players.length + stars.length > MAX_PLAYERS) throw new TeamError(`At most ${MAX_PLAYERS} players, star players and mercenaries included.`);
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
    hires: offer,
    ...(raises && linemen.length > 0 ? { raisePositions: linemen.map(positionStats) } : {}),
    players: [...players, ...stars],
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
