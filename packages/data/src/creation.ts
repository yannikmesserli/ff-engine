import { MAX_PLAYERS, TeamFileSchema, type Roster, type TeamFileInput } from "./schemas";
import { TeamError, resolveTeam, rosters } from "./teams";

/**
 * BB2025 team creation: the gold a new team is drafted with, how many players it starts with, and the sideline staff it
 * may buy (most of each, price of each). A team starts with 1 Dedicated Fan and may buy up to 2 more.
 */
export const TEAM_CREATION = {
  budget: 1_000_000,
  minPlayers: 11,
  maxPlayers: MAX_PLAYERS,
  apothecary: { max: 1, cost: 50_000 },
  assistantCoaches: { max: 6, cost: 10_000 },
  cheerleaders: { max: 6, cost: 10_000 },
  dedicatedFans: { start: 1, max: 3, cost: 10_000 },
} as const;

/** What drafting a team costs, in gold pieces: its players, re-rolls, sideline staff and extra Dedicated Fans. */
export interface CreationCost {
  players: number;
  rerolls: number;
  /** Apothecary, assistant coaches and cheerleaders. */
  staff: number;
  /** Dedicated Fans bought on top of the first, free one. */
  dedicatedFans: number;
  total: number;
}

/** The cost of drafting a team file from scratch (positions at their roster price, staff at creation prices). */
export function creationCost(team: TeamFileInput, roster: Roster): CreationCost {
  const players = team.players.reduce((sum, p) => sum + (roster.positions.find((pos) => pos.title === p.position)?.cost ?? 0), 0);
  const rerolls = team.rerolls * roster.rerollCost;
  const staff =
    (team.apothecary ? TEAM_CREATION.apothecary.cost : 0) +
    (team.assistantCoaches ?? 0) * TEAM_CREATION.assistantCoaches.cost +
    (team.cheerleaders ?? 0) * TEAM_CREATION.cheerleaders.cost;
  const dedicatedFans = Math.max(0, (team.dedicatedFans ?? 1) - TEAM_CREATION.dedicatedFans.start) * TEAM_CREATION.dedicatedFans.cost;
  return { players, rerolls, staff, dedicatedFans, total: players + rerolls + staff + dedicatedFans };
}

/**
 * Why a team file is not a valid new team, or an empty list: the team-creation rules (players, staff limits, the budget
 * in whole gold pieces, no advancements, injuries, missed games or hired players yet) and then everything `resolveTeam` checks.
 */
export function creationErrors(team: TeamFileInput, budget: number = TEAM_CREATION.budget, availableRosters: Roster[] = rosters): string[] {
  if (!Number.isSafeInteger(budget) || budget < 0) return [`The budget must be a whole, non-negative number of gold pieces (${budget}).`];
  const roster = availableRosters.find((r) => r.name === team.roster);
  if (!roster) return [`Unknown roster "${team.roster}".`];
  const errors: string[] = [];
  const { minPlayers, maxPlayers, assistantCoaches, cheerleaders, dedicatedFans } = TEAM_CREATION;
  if (team.players.length < minPlayers) errors.push(`A new team needs at least ${minPlayers} players (${team.players.length} so far).`);
  if (team.players.length > maxPlayers) errors.push(`At most ${maxPlayers} players.`);
  if ((team.assistantCoaches ?? 0) > assistantCoaches.max) errors.push(`At most ${assistantCoaches.max} assistant coaches.`);
  if ((team.cheerleaders ?? 0) > cheerleaders.max) errors.push(`At most ${cheerleaders.max} cheerleaders.`);
  if ((team.dedicatedFans ?? 1) > dedicatedFans.max) errors.push(`A new team has at most ${dedicatedFans.max} Dedicated Fans.`);
  const veteran = team.players.find(
    (p) => p.skills?.length || p.hatred?.length || p.injuries?.length || Object.values(p.improvements ?? {}).some((n) => n) || p.spp || p.missNextGame,
  );
  if (veteran) errors.push(`${veteran.name} has advancements, injuries, Star Player Points or misses the next game: a new team has none.`);
  if (team.starPlayers?.length || team.mercenaries?.length || Object.values(team.inducements ?? {}).some((n) => n)) {
    errors.push("Star players, mercenaries and inducements are hired before a game, not when drafting the team.");
  }
  const cost = creationCost(team, roster).total;
  if (cost > budget) errors.push(`Costs ${cost / 1000}k, over the ${budget / 1000}k budget.`);
  try {
    resolveTeam(team, availableRosters);
  } catch (e) {
    if (!(e instanceof TeamError)) throw e;
    errors.push(e.message);
  }
  return errors;
}

/**
 * A new team drafted with `budget`: the team file with the gold left over as its treasury. Throws `TeamError` when the
 * team breaks the team-creation rules (see `creationErrors`).
 */
export function draftTeam(team: TeamFileInput, budget: number = TEAM_CREATION.budget, availableRosters: Roster[] = rosters): TeamFileInput {
  const errors = creationErrors(team, budget, availableRosters);
  if (errors.length > 0) throw new TeamError(errors.join(" "));
  const roster = availableRosters.find((r) => r.name === team.roster)!;
  const file = { ...team, treasury: budget - creationCost(team, roster).total };
  TeamFileSchema.parse(file);
  return file;
}
