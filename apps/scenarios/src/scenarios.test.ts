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
  it.each(SCENARIOS.map((s) => s.id))("%s loads: its actions are all legal", (id) => {
    expect(getAvailableActions(load(id)).length).toBeGreaterThan(0);
  });

  it("pro-block: a two-dice block where Pro can re-roll a die", () => {
    let s = load("pro-block");
    s = step(s, { type: "START_ACTION", playerId: "home-1", action: "block" }).state;
    expect(find(s, "BLOCK")?.targets).toEqual([{ playerId: "away-1", dice: 2 }]);
    s = step(s, { type: "BLOCK", targetId: "away-1" }).state;
    s = step(s, { type: "ROLL", values: [1, 1] }).state;
    expect(getAvailableActions(s).some((t) => t.type === "USE_SKILL" && t.skill === "Pro")).toBe(true);
  });

  it("on-the-ball-pass: the thrower aims, then the away coach picks On the Ball players", () => {
    let s = load("on-the-ball-pass");
    expect(s.ball).toEqual({ square: { x: 6, y: 7 }, carried: true });
    s = step(s, { type: "THROW", square: { x: 11, y: 12 } }).state;
    expect(find(s, "SELECT_PLAYERS")).toMatchObject({ side: "away", playerIds: ["away-1", "away-2"] });
    s = step(s, { type: "SELECT_PLAYERS", playerIds: ["away-1"] }).state;
    s = step(s, { type: "MOVE", square: { x: 12, y: 10 } }).state;
    expect(find(s, "ROLL")?.reason).toMatch(/^Dodge/);
  });

  it("on-the-ball-kickoff: after the deviation, only the unmarked On the Ball player may move", () => {
    let s = load("on-the-ball-kickoff");
    expect(find(s, "ROLL")?.reason).toBe("Kick-off deviation");
    s = step(s, { type: "ROLL", values: [1, 3] }).state;
    expect(find(s, "SELECT_PLAYERS")).toMatchObject({ side: "home", playerIds: ["home-4"] });
  });

  it("bombardier: a bomb caught by an orc must be thrown back by the away coach", () => {
    let s = load("bombardier");
    s = step(s, { type: "START_ACTION", playerId: "home-1", action: "bomb" }).state;
    s = step(s, { type: "THROW", square: { x: 16, y: 7 } }).state;
    expect(find(s, "ROLL")?.reason).toBe("Pass 4+ (short)");
    s = step(s, { type: "ROLL", values: [6] }).state;
    expect(find(s, "SELECT_PLAYERS")).toMatchObject({ side: "away", playerIds: ["away-2"] });
    s = step(s, { type: "SELECT_PLAYERS", playerIds: [] }).state;
    expect(find(s, "ROLL")?.reason).toBe("Catch (bomb) 3+ (Gorbag)");
    s = step(s, { type: "ROLL", values: [4] }).state;
    expect(find(s, "THROW")).toMatchObject({ side: "away", playerId: "away-5" });
  });
});
