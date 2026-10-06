import { describe, expect, it } from "vitest";
import { applyActions, createGame, getAvailableActions, step, type ActionTemplate, type GameState } from "@bb/engine";
import { resolveTeam } from "@bb/data";
import { SCENARIOS } from "./scenarios";

const load = (id: string) => {
  const s = SCENARIOS.find((x) => x.id === id)!;
  return applyActions(createGame(resolveTeam(s.home), resolveTeam(s.away), { seed: s.seed }), s.actions);
};
const find = <T extends ActionTemplate["type"]>(s: GameState, type: T) =>
  getAvailableActions(s).find((t): t is Extract<ActionTemplate, { type: T }> => t.type === type);

describe("scenarios", () => {
  it.each(SCENARIOS.map((s) => s.id))("%s reaches home's first turn", (id) => {
    const s = load(id);
    expect([s.activeSide, s.teams.home.turn]).toEqual(["home", 1]);
    expect(find(s, "START_ACTION")).toBeDefined();
  });

  it("pro-block: a two-dice block where Pro can re-roll a die", () => {
    let s = load("pro-block");
    s = step(s, { type: "START_ACTION", playerId: "home-1", action: "block" }).state;
    expect(find(s, "BLOCK")?.targets).toEqual([{ playerId: "away-1", dice: 2 }]);
    s = step(s, { type: "BLOCK", targetId: "away-1" }).state;
    s = step(s, { type: "ROLL", values: [1, 1] }).state;
    expect(getAvailableActions(s).some((t) => t.type === "USE_SKILL" && t.skill === "Pro")).toBe(true);
  });
});
