import { z } from "zod";
import { CHARACTERISTICS, SPECIAL_RULES, type Characteristic, type TeamFileInput } from "./schemas";
import { TeamError } from "./teams";

/**
 * FUMBBL team JSON (`https://fumbbl.com/api/team/get/<id>`), read as a team file. Only the fields a team file has are
 * read; FUMBBL's own ones (ids, bio, division, records, redrafting, skill costs, portraits...) are ignored. See
 * "FUMBBL team JSON" in the package README for what maps to what, and why this package keeps its own format.
 */

/** Characteristic increases, which FUMBBL lists among a player's skills ("+ST"). */
const IMPROVEMENT = /^\+(MA|ST|AG|PA|AV)$/i;

/** Hatred gained by Getting Even, which FUMBBL lists among a player's skills, at no cost ("Hatred (orc)"). */
const HATRED = /^Hatred\s*\((.+)\)$/i;

/** FUMBBL's player status of journeymen (players hired for one game, numbered from 17): left out, the engine adds its own. */
const JOURNEYMAN_STATUS = 6;

const name = z.object({ name: z.string().min(1) });
const count = z.number().int().min(0);

/** The parts of a FUMBBL team the conversion reads; anything else is allowed and ignored. */
const FumbblTeamSchema = z.object({
  name: z.string().min(1),
  coach: name.optional(),
  roster: name,
  rerolls: count,
  apothecary: z.enum(["Yes", "No"]).optional(),
  assistantCoaches: count.optional(),
  cheerleaders: count.optional(),
  fanFactor: count.optional(),
  treasury: count.optional(),
  specialRules: z.record(z.string(), z.unknown()).optional(),
  players: z.array(
    z.object({
      number: z.number().int().positive(),
      name: z.string().min(1),
      position: z.string().min(1),
      status: z.number().nullish(),
      skills: z.array(z.string()).default([]),
      /** Comma-separated: "n" a Niggling Injury, "-st" (any characteristic) a lasting -1, "m" misses the next game. */
      injuries: z.string().nullish(),
      /** The player's injuries one by one; "d": dead. */
      injuryStatus: z.array(z.object({ injury: z.string() })).nullish(),
      record: z.object({ spp: count, extra_spp: count.nullish(), spent_spp: count.nullish() }).partial().nullish(),
    }),
  ),
});

/** The input looks like FUMBBL team JSON (its roster is an object with a name) rather than a team file of this package. */
export function isFumbblTeam(input: unknown): boolean {
  const roster = (input as { roster?: unknown } | null)?.roster;
  return typeof roster === "object" && roster !== null && typeof (roster as { name?: unknown }).name === "string";
}

/**
 * A team file from FUMBBL team JSON: the coach and roster by name, staff, Dedicated Fans (FUMBBL's fan factor),
 * treasury, the special rules this package knows, and the players with their gained skills, characteristic increases,
 * Hatred from Getting Even, lasting injuries, unspent SPP and whether they miss the next game. The player with the Team Captain skill is the
 * captain. Journeymen and dead players are left out. Throws TeamError on JSON that is not a FUMBBL team; the result still goes
 * through the usual checks (`resolveTeam`).
 */
export function fromFumbblTeam(input: unknown): TeamFileInput {
  const parsed = FumbblTeamSchema.safeParse(input);
  if (!parsed.success) throw new TeamError(`Invalid FUMBBL team: ${parsed.error.message}`);
  const team = parsed.data;
  const known = new Set<string>(SPECIAL_RULES);
  const players = team.players
    .filter((p) => p.status !== JOURNEYMAN_STATUS && !p.injuryStatus?.some((i) => i.injury === "d"))
    .map((p) => {
      const improvements: Partial<Record<Characteristic, number>> = {};
      const skills: string[] = [];
      const hatred: string[] = [];
      for (const skill of p.skills) {
        const increase = IMPROVEMENT.exec(skill)?.[1]?.toLowerCase() as Characteristic | undefined;
        const hated = HATRED.exec(skill)?.[1]?.trim().toLowerCase();
        if (increase) improvements[increase] = (improvements[increase] ?? 0) + 1;
        // Not an advancement: neither counted in the player's value nor lost after a concession.
        else if (hated) hatred.push(hated);
        // "Mighty Blow (+1)" is written "Mighty Blow(+1)" in the rosters.
        else skills.push(skill.replace(/\s+\(/, "("));
      }
      const codes = (p.injuries ?? "").split(",").map((c) => c.trim().toLowerCase());
      // Any other code (none seen so far) is not read.
      const injuries = codes.flatMap((c): Array<Characteristic | "niggling"> => {
        if (c === "n") return ["niggling"];
        const lost = c.startsWith("-") ? c.slice(1) : "";
        return (CHARACTERISTICS as readonly string[]).includes(lost) ? [lost as Characteristic] : [];
      });
      const spp = Math.max(0, (p.record?.spp ?? 0) + (p.record?.extra_spp ?? 0) - (p.record?.spent_spp ?? 0));
      return {
        number: p.number,
        name: p.name,
        position: p.position,
        captain: skills.includes("Team Captain"),
        player: {
          number: p.number,
          name: p.name,
          position: p.position,
          ...(skills.some((s) => s !== "Team Captain") ? { skills: skills.filter((s) => s !== "Team Captain") } : {}),
          ...(hatred.length > 0 ? { hatred } : {}),
          ...(Object.keys(improvements).length > 0 ? { improvements } : {}),
          ...(injuries.length > 0 ? { injuries } : {}),
          ...(codes.includes("m") ? { missNextGame: true } : {}),
          ...(spp > 0 ? { spp } : {}),
        },
      };
    });
  const captain = players.find((p) => p.captain)?.number;
  const specialRules = Object.keys(team.specialRules ?? {}).filter((r) => known.has(r)) as TeamFileInput["specialRules"];
  return {
    name: team.name,
    ...(team.coach ? { coach: team.coach.name } : {}),
    roster: team.roster.name,
    rerolls: team.rerolls,
    ...(team.apothecary === "Yes" ? { apothecary: true } : {}),
    ...(team.assistantCoaches ? { assistantCoaches: team.assistantCoaches } : {}),
    ...(team.cheerleaders ? { cheerleaders: team.cheerleaders } : {}),
    // Some FUMBBL leagues leave the fan factor at 0 (BB2025 Dedicated Fans are 1 to 7): the default, 1, then.
    ...(team.fanFactor ? { dedicatedFans: team.fanFactor } : {}),
    ...(team.treasury ? { treasury: team.treasury } : {}),
    ...(specialRules && specialRules.length > 0 ? { specialRules } : {}),
    ...(captain !== undefined ? { captain } : {}),
    players: players.map((p) => p.player),
  };
}

/** A team file as given, or converted from FUMBBL team JSON (see `fromFumbblTeam`). */
export const teamFile = (input: unknown): unknown => (isFumbblTeam(input) ? fromFumbblTeam(input) : input);
