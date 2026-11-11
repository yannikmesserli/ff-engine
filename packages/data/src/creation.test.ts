import { describe, expect, it } from "vitest";
import { TEAM_CREATION, TeamError, creationCost, creationErrors, draftTeam, rosters, type TeamFileInput } from "./index";

const human = rosters.find((r) => r.name === "Human")!;

/** A new Human team: 11 linemen (550k), 2 re-rolls (100k), an apothecary, 2 cheerleaders and 3 Dedicated Fans. */
const newHumans = (): TeamFileInput => ({
  name: "New Humans",
  roster: "Human",
  rerolls: 2,
  apothecary: true,
  cheerleaders: 2,
  dedicatedFans: 3,
  players: Array.from({ length: 11 }, (_, i) => ({ number: i + 1, name: `P${i + 1}`, position: "Human Lineman" })),
});

describe("team creation", () => {
  it("costs the players, re-rolls, staff and the Dedicated Fans after the first", () => {
    expect(creationCost(newHumans(), human)).toEqual({ players: 550_000, rerolls: 100_000, staff: 70_000, dedicatedFans: 20_000, total: 740_000 });
  });

  it("puts the gold left over in the treasury", () => {
    expect(draftTeam(newHumans()).treasury).toBe(TEAM_CREATION.budget - 740_000);
    expect(draftTeam(newHumans(), 800_000).treasury).toBe(60_000);
  });

  it("accepts a valid new team", () => {
    expect(creationErrors(newHumans())).toEqual([]);
  });

  it("needs 11 players and stays within the budget and staff limits", () => {
    const team = { ...newHumans(), players: newHumans().players.slice(0, 10), assistantCoaches: 7, dedicatedFans: 4 };
    expect(creationErrors(team, 500_000)).toEqual([
      "A new team needs at least 11 players (10 so far).",
      "At most 6 assistant coaches.",
      "A new team has at most 3 Dedicated Fans.",
      "Costs 770k, over the 500k budget.",
    ]);
    expect(() => draftTeam(team)).toThrow(TeamError);
  });

  it("refuses veterans and hired players", () => {
    const team = newHumans();
    team.players[0] = { ...team.players[0]!, skills: ["Block"] };
    expect(creationErrors({ ...team, starPlayers: ["Akhorne the Squirrel"] })).toEqual([
      "P1 has advancements, injuries, Star Player Points or misses the next game: a new team has none.",
      "Star players, mercenaries and inducements are hired before a game, not when drafting the team.",
    ]);
  });

  it("refuses a player who misses the next game", () => {
    const team = newHumans();
    team.players[0] = { ...team.players[0]!, missNextGame: true };
    expect(creationErrors(team)).toEqual(["P1 has advancements, injuries, Star Player Points or misses the next game: a new team has none."]);
    expect(() => draftTeam(team)).toThrow(TeamError);
  });

  it.each([1_000_000.5, -1, Number.NaN, Number.POSITIVE_INFINITY])("refuses a budget of %s", (budget) => {
    expect(creationErrors(newHumans(), budget)).toEqual([`The budget must be a whole, non-negative number of gold pieces (${budget}).`]);
    expect(() => draftTeam(newHumans(), budget)).toThrow(TeamError);
  });

  it("reports the roster's limits as resolveTeam does", () => {
    const team = newHumans();
    team.players.push(...[12, 13, 14].map((number) => ({ number, name: `T${number}`, position: "Human Thrower" })));
    expect(creationErrors({ ...team, rerolls: 0 })).toEqual(["At most 2 Human Thrower allowed (3 in team)."]);
  });
});
