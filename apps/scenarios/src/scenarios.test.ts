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

  it("diving-tackle: on a 4, Diving Tackle is offered and Break Tackle still saves the dodge", () => {
    let s = load("diving-tackle");
    s = step(s, { type: "START_ACTION", playerId: "home-1", action: "move" }).state;
    s = step(s, { type: "MOVE", square: { x: 11, y: 7 } }).state;
    expect(find(s, "ROLL")?.reason).toBe("Dodge 3+ (Gorbag)");
    const five = step(s, { type: "ROLL", values: [5] }).state;
    expect(find(five, "SELECT_PLAYERS")).toBeUndefined();
    // On a 3, Diving Tackle makes the dodge fail: Dodge re-rolls it, keeping the -2.
    const three = step(step(s, { type: "ROLL", values: [3] }).state, { type: "SELECT_PLAYERS", playerIds: ["away-3"] }).state;
    expect(find(three, "ROLL")?.reason).toBe("Dodge 5+ (Gorbag)");
    s = step(s, { type: "ROLL", values: [4] }).state;
    expect(find(s, "SELECT_PLAYERS")).toMatchObject({ side: "away", playerIds: ["away-1", "away-3"] });
    s = step(s, { type: "SELECT_PLAYERS", playerIds: ["away-1"] }).state;
    expect(s.players["home-1"]).toMatchObject({ at: { x: 11, y: 7 }, status: "standing", usedSkills: ["Break Tackle"] });
    expect(s.players["away-1"]).toMatchObject({ at: { x: 12, y: 7 }, status: "prone" });
  });

  it("block-followups: Fend, the blitzing Juggernaut, then Sidestep, Taunt and Hit and Run", () => {
    const start = load("block-followups");
    const block = (s: GameState, attacker: string, defender: string, face: number, blitz = false) =>
      applyActions(s, [
        blitz ? { type: "START_ACTION", playerId: attacker, action: "blitz", targetId: defender } : { type: "START_ACTION", playerId: attacker, action: "block" },
        { type: "BLOCK", targetId: defender },
        { type: "ROLL", values: [face] },
        { type: "CHOOSE_BLOCK_DIE", index: 0 },
      ]);
    let s = block(start, "home-1", "away-1", 3);
    s = step(s, { type: "PUSH", square: { x: 14, y: 4 } }).state;
    expect(find(s, "USE_SKILL")).toMatchObject({ side: "away", skill: "Fend" });
    s = block(start, "home-2", "away-2", 3, true);
    s = step(s, { type: "PUSH", square: { x: 14, y: 7 } }).state;
    expect(find(s, "FOLLOW_UP")).toBeDefined();
    s = block(start, "home-3", "away-3", 3);
    expect(find(s, "PUSH")).toMatchObject({ side: "away" });
    s = step(s, { type: "PUSH", square: { x: 13, y: 11 } }).state;
    expect(find(s, "USE_SKILL")).toMatchObject({ side: "away", skill: "Taunt" });
    s = step(s, { type: "USE_SKILL", use: false }).state;
    s = step(s, { type: "FOLLOW_UP", follow: false }).state;
    expect(find(s, "USE_SKILL")).toMatchObject({ side: "home", skill: "Hit and Run" });
  });

  it("shadowing: after the dodge, the away coach picks a shadower who follows on 4+", () => {
    let s = load("shadowing");
    expect(s.players["away-2"]!.ma).toBe(1);
    s = applyActions(s, [{ type: "START_ACTION", playerId: "home-1", action: "move" }, { type: "MOVE", square: { x: 11, y: 7 } }, { type: "ROLL", values: [6] }]);
    expect(find(s, "SELECT_PLAYERS")).toMatchObject({ side: "away", playerIds: ["away-1", "away-2"] });
    s = applyActions(s, [{ type: "SELECT_PLAYERS", playerIds: ["away-2"] }, { type: "ROLL", values: [4] }]);
    expect(s.players["away-2"]!.at).toEqual({ x: 12, y: 7 });
    s = applyActions(s, [{ type: "MOVE", square: { x: 10, y: 7 } }, { type: "ROLL", values: [6] }]);
    expect(find(s, "SELECT_PLAYERS")).toBeUndefined();
  });
});
