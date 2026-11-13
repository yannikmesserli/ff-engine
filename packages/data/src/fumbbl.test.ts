import { createGame } from "@ff-engine/engine";
import { describe, expect, it } from "vitest";
import { TeamError, exampleTeams, fromFumbblTeam, teamValue, isFumbblTeam, resolveTeam, teamAfterGame } from "./index";

/** A player in FUMBBL's team JSON, with the fields it always has. */
const player = (number: number, position: string, extra: Record<string, unknown> = {}) => ({
  id: 1000 + number,
  number,
  status: 0,
  name: `Player ${number}`,
  portrait: 0,
  gender: "male",
  hasBio: false,
  position,
  positionId: 1,
  record: { seasons: 1, games: 3, completions: 0, catches: 0, landings: 0, touchdowns: 0, deflections: 0, interceptions: 0, casualties: 0, mvps: 0, spp: 0, extra_spp: 0, spent_spp: 0 },
  skillStatus: { status: "none", maxLimit: 20, tier: 0, numRewards: 0 },
  injuries: "",
  injuryStatus: null,
  skills: [],
  skillCosts: [],
  refundable: false,
  properties: null,
  data: null,
  ...extra,
});

/** A made-up team in the shape of FUMBBL's `/api/team/get/<id>` JSON. */
const fumbblTeam = () => ({
  id: 1,
  coach: { id: 2, name: "Some Coach" },
  roster: { id: 8584, name: "Orc" },
  name: "Da Test Boyz",
  bio: { image: 0, htmlBio: "" },
  divisionId: 2,
  division: "Competitive",
  league: 2,
  rerolls: 3,
  ruleset: 3906,
  status: "Active",
  teamValue: 1_100_000,
  currentTeamValue: 1_100_000,
  treasury: 40_000,
  fanFactor: 4,
  assistantCoaches: 1,
  cheerleaders: 0,
  apothecary: "Yes",
  record: { games: 3, wins: 2, ties: 0, losses: 1, form: "WLW" },
  specialRules: { "Badlands Brawl": [null, null, { selectedLeague: true }, null, true, 1, null], "Brawlin' Brutes": [null, null, null, null, false, 13, null], "Team Captain": [null, null, null, null, false, 16, null] },
  redrafting: { base: 1_000_000 },
  players: [
    player(1, "Troll", { skills: ["Block", "Guard"], record: { spp: 30, extra_spp: 2, spent_spp: 18 } }),
    player(2, "Big Un Blocker", { skills: ["Block", "+ST", "Team Captain"], skillCosts: [30000, 60000, 0] }),
    player(3, "Orc Blitzer", { skills: ["Hatred (human)"], injuries: "-st,-av,n,m", injuryStatus: [{ injury: "-st", lasting: true, lastMatch: true }] }),
    player(4, "Orc Lineman", { injuryStatus: [{ injury: "d", lasting: false, lastMatch: false }] }),
    ...[5, 6, 7, 8, 9, 10, 11].map((n) => player(n, "Orc Lineman")),
    player(17, "Orc Lineman", { status: 6 }),
  ],
  firedPlayers: [],
});

describe("FUMBBL team JSON", () => {
  it("is told apart from a team file", () => {
    expect(isFumbblTeam(fumbblTeam())).toBe(true);
    expect(isFumbblTeam({ name: "x", roster: "Orc", rerolls: 0, players: [] })).toBe(false);
    expect(isFumbblTeam(null)).toBe(false);
  });

  it("becomes a team file: staff, fans, special rules, captain, skills, increases, injuries, SPP", () => {
    const file = fromFumbblTeam(fumbblTeam());
    expect(file).toMatchObject({
      name: "Da Test Boyz",
      coach: "Some Coach",
      roster: "Orc",
      rerolls: 3,
      apothecary: true,
      assistantCoaches: 1,
      dedicatedFans: 4,
      treasury: 40_000,
      specialRules: ["Badlands Brawl", "Brawlin' Brutes"],
      captain: 2,
    });
    expect(file).not.toHaveProperty("cheerleaders");
    const [troll, bigUn, blitzer] = file.players;
    expect(troll).toEqual({ number: 1, name: "Player 1", position: "Troll", skills: ["Block", "Guard"], spp: 14 });
    expect(bigUn).toEqual({ number: 2, name: "Player 2", position: "Big Un Blocker", skills: ["Block"], improvements: { st: 1 } });
    expect(blitzer).toEqual({ number: 3, name: "Player 3", position: "Orc Blitzer", hatred: ["human"], injuries: ["st", "av", "niggling"], missNextGame: true });
  });

  it("a fan factor of 0 (left unset by some leagues) gives the default Dedicated Fans", () => {
    expect(fromFumbblTeam({ ...fumbblTeam(), fanFactor: 0 })).not.toHaveProperty("dedicatedFans");
    expect(resolveTeam({ ...fumbblTeam(), fanFactor: 0 }).dedicatedFans).toBe(1);
  });

  it("Hatred is from Getting Even: no advancement, no value added", () => {
    const hating = { ...fumbblTeam(), players: fumbblTeam().players.map((p) => (p.number === 5 ? { ...p, skills: ["Hatred (human)"], skillCosts: [0] } : p)) };
    const lineman = resolveTeam(hating).players.find((p) => p.nr === 5)!;
    expect(lineman).toMatchObject({ advancements: 0, skills: ["Hatred(human)"] });
    expect(teamValue(hating)).toBe(teamValue(fumbblTeam()));
  });

  it("leaves out journeymen and dead players", () => {
    const numbers = fromFumbblTeam(fumbblTeam()).players.map((p) => p.number);
    expect(numbers).toEqual([1, 2, 3, 5, 6, 7, 8, 9, 10, 11]);
  });

  it("is accepted by resolveTeam and teamAfterGame", () => {
    const team = resolveTeam(fumbblTeam());
    expect(team.name).toBe("Da Test Boyz");
    // The blitzer misses the game and the dead lineman is gone: 9 players, and 2 journeymen in the smallest free numbers.
    expect(team.players.map((p) => p.nr)).toEqual([1, 2, 5, 6, 7, 8, 9, 10, 11, 4, 12]);
    // A Big Un Blocker has ST 4: +ST makes 5. The captain gains Pro and the Team Captain trait.
    expect(team.players.find((p) => p.nr === 2)).toMatchObject({ st: 5, skills: expect.arrayContaining(["Block", "Pro", "Team Captain"]) });
    // After a game, the team comes back as a team file of this package.
    const game = structuredClone(createGame(team, resolveTeam(exampleTeams["human"]), { seed: 1 }));
    game.finished = true;
    game.result = { conceded: null, concededLegally: false, penalties: null, winner: null, winnings: { home: 0, away: 0 }, dedicatedFans: { home: 0, away: 0 }, mvps: [], leaving: [] };
    expect(teamAfterGame(fumbblTeam(), game, "home")).toMatchObject({ roster: "Orc", coach: "Some Coach", captain: 2, dedicatedFans: 4 });
  });

  it("still goes through the roster's checks, and rejects what is not a FUMBBL team", () => {
    const tooMany = { ...fumbblTeam(), rerolls: 9 };
    expect(() => resolveTeam(tooMany)).toThrow(/at most/);
    expect(() => resolveTeam({ ...fumbblTeam(), players: "none" })).toThrow(TeamError);
    expect(() => resolveTeam({ ...fumbblTeam(), roster: { id: 1, name: "Not A Roster" } })).toThrow(/Unknown roster/);
  });
});
