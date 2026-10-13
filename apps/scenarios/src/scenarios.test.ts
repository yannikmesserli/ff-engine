import { describe, expect, it } from "vitest";
import { applyActions, createGame, getAvailableActions, step, type Action, type ActionTemplate, type GameState } from "@bb/engine";
import { resolveTeam } from "@bb/data";
import { SCENARIOS } from "./scenarios";

const load = (id: string) => {
  const s = SCENARIOS.find((x) => x.id === id)!;
  return applyActions(createGame(resolveTeam(s.home), resolveTeam(s.away), { seed: s.seed, shop: s.shop }), s.actions);
};
/** A Block action whose single die knocks the defender down, pushed to `to` with a follow-up; the armour holds. */
const knockDownOnce = (attackerId: string, defenderId: string, to: { x: number; y: number }) => [
  { type: "START_ACTION", playerId: attackerId, action: "block" },
  { type: "BLOCK", targetId: defenderId },
  { type: "ROLL", values: [6] },
  { type: "CHOOSE_BLOCK_DIE", index: 0 },
  { type: "PUSH", square: to },
  { type: "FOLLOW_UP", follow: true },
  { type: "ROLL", values: [1, 2] },
] as const satisfies readonly Action[];
const find = <T extends ActionTemplate["type"]>(s: GameState, type: T) =>
  getAvailableActions(s).find((t): t is Extract<ActionTemplate, { type: T }> => t.type === type);

describe("scenarios", () => {
  it.each(SCENARIOS.map((s) => s.id))("%s loads: its actions are all legal", (id) => {
    expect(getAvailableActions(load(id)).length).toBeGreaterThan(0);
  });

  it("pre-game-shop: the orcs spend their treasury first, then the humans get petty cash; free prayers for what is left", () => {
    let s = load("pre-game-shop");
    expect(find(s, "BUY_INDUCEMENTS")).toMatchObject({ side: "away", pettyCash: 0, treasury: 60_000 });
    s = step(s, { type: "BUY_INDUCEMENTS", inducements: { teamMascot: 1 } }).state;
    expect(find(s, "BUY_INDUCEMENTS")).toMatchObject({ side: "home", pettyCash: 115_000, treasury: 50_000 });
    // Nothing bought: 450k against 335k, two free prayers.
    expect(step(s, { type: "BUY_INDUCEMENTS", inducements: {} }).state.log).toContainEqual({ type: "FreePrayers", side: "home", count: 2 });
    s = step(s, { type: "BUY_INDUCEMENTS", inducements: { bribes: 1 } }).state;
    // 450k against 435k: no free prayer.
    expect(s.teams.home.treasurySpent).toBe(0);
    expect(s.log.some((e) => e.type === "FreePrayers")).toBe(false);
    expect(find(s, "CALL_COIN")).toBeDefined();
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

  it("block-rerolls: a Skull and a Both Down offer the team re-roll, Brawler, Hatred and Pro", () => {
    const s = applyActions(load("block-rerolls"), [
      { type: "START_ACTION", playerId: "home-1", action: "block" },
      { type: "BLOCK", targetId: "away-1" },
      { type: "ROLL", values: [1, 2] },
    ]);
    expect(getAvailableActions(s).map((t) => (t.type === "USE_SKILL" ? t.skill : t.type))).toEqual(["CHOOSE_BLOCK_DIE", "USE_REROLL", "Brawler", "Hatred", "Pro"]);
    expect(find(step(s, { type: "USE_REROLL" }).state, "ROLL")?.reason).toBe("Loner 4+ (Gunther)");
  });

  it("throw-team-mate: Really Stupid first, then the goblin can be thrown", () => {
    let s = step(load("throw-team-mate"), { type: "START_ACTION", playerId: "home-1", action: "ttm" }).state;
    expect(find(s, "ROLL")?.reason).toBe("Really Stupid 2+ (Grumbol)");
    s = step(s, { type: "ROLL", values: [6] }).state;
    expect(find(s, "THROW_TEAM_MATE")?.playerIds).toEqual(["home-2"]);
    s = step(s, { type: "THROW_TEAM_MATE", targetId: "home-2", square: { x: 16, y: 8 } }).state;
    expect(find(s, "ROLL")?.reason).toMatch(/^Always Hungry 2\+/);
  });

  it("pick-me-up: at the end of home's turn, the away coach picks the prone raiders in range", () => {
    let s = load("pick-me-up");
    expect(["away-1", "away-2", "away-3"].map((id) => s.players[id]!.status)).toEqual(["prone", "prone", "prone"]);
    s = step(s, { type: "END_TURN" }).state;
    expect(find(s, "SELECT_PLAYERS")).toMatchObject({ side: "away", playerIds: ["away-1", "away-2"], max: 2 });
  });

  it("animal-savagery: a failed roll makes the home coach pick a team-mate to lash out at", () => {
    let s = step(load("animal-savagery"), { type: "START_ACTION", playerId: "home-1", action: "block" }).state;
    expect(find(s, "ROLL")?.reason).toBe("Animal Savagery 2+ (Skritch)");
    s = applyActions(s, [{ type: "ROLL", values: [1] }, { type: "DECLINE_REROLL" }]);
    expect(find(s, "SELECT_PLAYERS")).toMatchObject({ side: "home", playerIds: ["home-2", "home-3"], min: 1, max: 1 });
  });

  it("bloodlust: a failed roll offers a Move instead, then the bite at the end of the action", () => {
    let s = step(load("bloodlust"), { type: "START_ACTION", playerId: "home-1", action: "block" }).state;
    expect(find(s, "ROLL")?.reason).toBe("Bloodlust 2+ (Count Vlad)");
    s = applyActions(s, [{ type: "ROLL", values: [1] }, { type: "DECLINE_REROLL" }]);
    expect(find(s, "MOVE_INSTEAD")).toBeDefined();
    s = applyActions(s, [{ type: "MOVE_INSTEAD", move: false }, { type: "END_PLAYER_ACTION" }]);
    expect(find(s, "SELECT_PLAYERS")).toMatchObject({ side: "home", playerIds: ["home-2", "home-3"] });
  });

  it("hypnotic-gaze: Foul Appearance first, then the gaze distracts the Bloater", () => {
    let s = applyActions(load("hypnotic-gaze"), [{ type: "START_ACTION", playerId: "home-1", action: "gaze" }, { type: "GAZE", targetId: "away-1" }]);
    expect(find(s, "ROLL")?.reason).toBe("Foul Appearance 2+ (Hans)");
    s = applyActions(s, [{ type: "ROLL", values: [2] }, { type: "ROLL", values: [3] }]);
    expect(s.players["away-1"]!.distracted).toBe(true);
    s = applyActions(s, [{ type: "START_ACTION", playerId: "home-2", action: "block" }, { type: "BLOCK", targetId: "away-1" }]);
    expect(find(s, "ROLL")?.reason).toBe("Foul Appearance 2+ (Otto)");
  });

  it("wrestle-steady-footing: both coaches are asked about Wrestle; Steady Footing before a fall", () => {
    const start = load("wrestle-steady-footing");
    const block = (attacker: string, defender: string, face: number) =>
      applyActions(start, [
        { type: "START_ACTION", playerId: attacker, action: "block" },
        { type: "BLOCK", targetId: defender },
        { type: "ROLL", values: [face] },
        { type: "CHOOSE_BLOCK_DIE", index: 0 },
      ]);
    let s = block("home-1", "away-1", 2);
    expect(find(s, "USE_SKILL")).toMatchObject({ side: "home", skill: "Wrestle" });
    s = step(s, { type: "USE_SKILL", use: false }).state;
    expect(find(s, "USE_SKILL")).toMatchObject({ side: "away", skill: "Wrestle" });
    s = block("home-2", "away-2", 1);
    expect(find(s, "USE_SKILL")).toMatchObject({ side: "home", playerId: "home-2", skill: "Steady Footing" });
  });

  it("safe-pair-of-hands: the knocked-down ball carrier may place the ball", () => {
    let s = load("safe-pair-of-hands");
    expect(s.ball).toEqual({ square: { x: 12, y: 7 }, carried: true });
    s = applyActions(s, [
      { type: "START_ACTION", playerId: "home-1", action: "block" },
      { type: "BLOCK", targetId: "away-1" },
      { type: "ROLL", values: [1] },
      { type: "CHOOSE_BLOCK_DIE", index: 0 },
      { type: "ROLL", values: [1, 1] },
    ]);
    expect(find(s, "USE_SKILL")).toMatchObject({ side: "home", skill: "Safe Pair of Hands" });
    s = step(s, { type: "USE_SKILL", use: true }).state;
    expect(find(s, "PLACE_BALL")?.squares).toContainEqual({ x: 11, y: 7 });
    const fell = applyActions(load("safe-pair-of-hands"), [
      { type: "START_ACTION", playerId: "home-1", action: "move" },
      { type: "MOVE", square: { x: 11, y: 7 } },
      { type: "ROLL", values: [1] },
      { type: "DECLINE_REROLL" },
      { type: "ROLL", values: [1, 1] },
    ]);
    expect(find(fell, "ROLL")?.reason).toBe("Bounce");
  });

  it("diving-catch: home picks its diver first, then the away coach may send theirs", () => {
    let s = applyActions(load("diving-catch"), [{ type: "THROW", square: { x: 13, y: 11 } }, { type: "ROLL", values: [6] }]);
    expect(find(s, "SELECT_PLAYERS")).toMatchObject({ side: "home", playerIds: ["home-4"], reason: "Diving Catch: choose a player to catch the ball" });
    const away = step(s, { type: "SELECT_PLAYERS", playerIds: [] }).state;
    expect(find(away, "SELECT_PLAYERS")).toMatchObject({ side: "away", playerIds: ["away-4"] });
    s = step(s, { type: "SELECT_PLAYERS", playerIds: ["home-4"] }).state;
    expect(find(s, "ROLL")?.reason).toBe("Catch 2+ (Kurt)");
  });

  it("fumblerooski: the ball stays in the square left, and a team-mate may pick it up", () => {
    let s = applyActions(load("fumblerooski"), [
      { type: "START_ACTION", playerId: "home-1", action: "move" },
      { type: "USE_SKILL", use: true, skill: "Fumblerooski" },
      { type: "MOVE", square: { x: 11, y: 7 } },
      { type: "ROLL", values: [6] },
      { type: "END_PLAYER_ACTION" },
    ]);
    expect([s.ball, s.turnover]).toEqual([{ square: { x: 12, y: 8 }, carried: false }, false]);
    s = applyActions(s, [{ type: "START_ACTION", playerId: "home-4", action: "move" }, { type: "MOVE", square: { x: 11, y: 8 } }, { type: "MOVE", square: { x: 12, y: 8 } }]);
    expect(find(s, "ROLL")?.reason).toMatch(/^Pick-up/);
  });

  it("breathe-fire: 4+ places the target prone, a failure against the Troll is a turnover", () => {
    const start = applyActions(load("breathe-fire"), [{ type: "START_ACTION", playerId: "home-1", action: "block" }]);
    expect(find(start, "BREATHE_FIRE")?.targetIds).toEqual(["away-1", "away-4"]);
    let s = applyActions(start, [{ type: "BREATHE_FIRE", targetId: "away-1" }, { type: "ROLL", values: [4] }, { type: "DECLINE_REROLL" }]);
    expect(s.players["away-1"]!.status).toBe("prone");
    s = applyActions(start, [{ type: "BREATHE_FIRE", targetId: "away-4" }, { type: "ROLL", values: [2] }, { type: "DECLINE_REROLL" }]);
    expect(s.players["home-1"]!.status).toBe("prone");
    expect(s.turnover).toBe(true);
  });

  it("dump-off: the home coach may pass before the block, and nobody's turn ends", () => {
    let s = applyActions(load("dump-off"), [
      { type: "START_ACTION", playerId: "away-1", action: "block" },
      { type: "BLOCK", targetId: "home-1" },
      { type: "USE_SKILL", use: true, skill: "Dump-off" },
    ]);
    expect(find(s, "THROW")?.squares.every((t) => t.range === "quick")).toBe(true);
    s = applyActions(s, [{ type: "THROW", square: { x: 10, y: 6 } }, { type: "ROLL", values: [6] }, { type: "ROLL", values: [6] }]);
    expect(s.ball).toEqual({ square: { x: 10, y: 6 }, carried: true });
    expect([s.activeSide, s.turnover, find(s, "ROLL")?.reason]).toEqual(["away", false, "Block (1 die)"]);
  });

  it("dump-off: a Blitz target is asked when the Blitz is declared", () => {
    const s = applyActions(load("dump-off"), [{ type: "START_ACTION", playerId: "away-2", action: "blitz", targetId: "home-1" }]);
    expect(find(s, "USE_SKILL")?.skill).toBe("Dump-off");
  });

  it("kick: Kick shortens the deviation, then re-rolls the punt rolls", () => {
    let s = load("kick");
    expect(find(s, "USE_SKILL")).toMatchObject({ side: "away", playerId: "away-4", skill: "Kick" });
    s = applyActions(s, [{ type: "USE_SKILL", use: true, skill: "Kick" }, { type: "ROLL", values: [5, 2] }, { type: "ROLL", values: [1, 1] }, { type: "ROLL", values: [6] }]);
    expect(s.ball).toEqual({ square: { x: 5, y: 3 }, carried: true });
    s = applyActions(s, [{ type: "START_ACTION", playerId: "home-1", action: "punt" }, { type: "PUNT", square: { x: 6, y: 3 } }, { type: "ROLL", values: [1] }]);
    expect(find(s, "USE_REROLL")).toMatchObject({ skill: "Kick" });
  });

  it("leader: the Leader re-roll is spent first", () => {
    let s = load("leader");
    expect(s.teams.home.leaders).toEqual(["home-1"]);
    s = applyActions(s, [{ type: "START_ACTION", playerId: "home-2", action: "move" }, { type: "MOVE", square: { x: 11, y: 7 } }, { type: "ROLL", values: [1] }]);
    expect(find(s, "USE_REROLL")?.available).toBe(3);
    s = applyActions(s, [{ type: "USE_REROLL" }]);
    expect([s.teams.home.rerolls, s.teams.home.leaderUsed]).toEqual([2, true]);
  });

  it("dirty-tricks: Lone Fouler re-rolls, Quick Foul moves on, Pile Driver fouls after a block", () => {
    let s = load("dirty-tricks");
    expect(s.players["away-3"]!.status).toBe("prone");
    s = applyActions(s, [
      { type: "START_ACTION", playerId: "home-2", action: "foul" },
      { type: "MOVE", square: { x: 11, y: 11 } },
      { type: "MOVE", square: { x: 12, y: 11 } },
      { type: "MOVE", square: { x: 13, y: 11 } },
      { type: "FOUL", targetId: "away-3" },
      { type: "ROLL", values: [2, 3] },
    ]);
    expect(find(s, "USE_SKILL")?.skill).toBe("Lone Fouler");
    s = applyActions(s, [{ type: "USE_SKILL", use: true }, { type: "ROLL", values: [2, 4] }]);
    expect(find(s, "MOVE")?.playerId).toBe("home-2");
    expect(find(s, "FOUL")).toBeUndefined();
    s = applyActions(s, [{ type: "END_PLAYER_ACTION" }, ...knockDownOnce("home-1", "away-1", { x: 14, y: 7 })]);
    expect(find(s, "USE_SKILL")?.skill).toBe("Pile Driver");
  });

  it("monstrous-mouth: Wolfgang chomps Ugluk, who is then not pushed", () => {
    let s = load("monstrous-mouth");
    expect(s.ball).toEqual({ square: { x: 12, y: 7 }, carried: true });
    s = applyActions(s, [{ type: "START_ACTION", playerId: "home-1", action: "block" }, { type: "CHOMP", targetId: "away-2" }, { type: "ROLL", values: [3] }]);
    expect(s.players["away-2"]!.chompedBy).toEqual(["home-1"]);
    s = applyActions(s, [{ type: "START_ACTION", playerId: "home-2", action: "block" }, { type: "BLOCK", targetId: "away-2" }, { type: "ROLL", values: [3, 3] }, { type: "CHOOSE_BLOCK_DIE", index: 0 }]);
    expect(s.players["away-2"]!.at).toEqual({ x: 13, y: 7 });
  });

  it("saboteur: a Looney knocked down may take the blocker with him", () => {
    let s = applyActions(load("saboteur"), [
      { type: "START_ACTION", playerId: "home-1", action: "block" },
      { type: "BLOCK", targetId: "away-1" },
      { type: "ROLL", values: [6, 6] },
      { type: "CHOOSE_BLOCK_DIE", index: 0 },
      { type: "PUSH", square: { x: 14, y: 7 } },
      { type: "FOLLOW_UP", follow: false },
    ]);
    expect(find(s, "USE_SKILL")).toMatchObject({ side: "away", skill: "Saboteur" });
    s = applyActions(s, [{ type: "USE_SKILL", use: true }, { type: "ROLL", values: [4] }]);
    expect(s.players["away-1"]!.at).toBe("ko");
    expect(find(s, "ROLL")?.reason).toBe("Armour 9+ (Hans)");
  });

  it("multiple-block: one die against each goblin, both rolled before either resolves", () => {
    let s = applyActions(load("multiple-block"), [{ type: "START_ACTION", playerId: "home-1", action: "block" }]);
    expect(find(s, "MULTIPLE_BLOCK")?.targetIds).toEqual(["away-1", "away-2", "away-3"]);
    s = applyActions(s, [{ type: "MULTIPLE_BLOCK", targetIds: ["away-1", "away-2"] }, { type: "ROLL", values: [6] }, { type: "CHOOSE_BLOCK_DIE", index: 0 }]);
    expect(find(s, "ROLL")?.dice).toEqual([{ kind: "block", count: 1 }]);
    expect(s.players["away-1"]!.at).toEqual({ x: 13, y: 6 });
  });

  it("punt: 3 and 4 put the ball on Malus; from the sideline the crowd is offered", () => {
    const start = applyActions(load("punt"), [{ type: "START_ACTION", playerId: "home-1", action: "punt" }]);
    let s = applyActions(start, [
      { type: "PUNT", square: { x: 6, y: 2 } },
      { type: "ROLL", values: [3] },
      { type: "DECLINE_REROLL" },
      { type: "ROLL", values: [4] },
      { type: "DECLINE_REROLL" },
      { type: "ROLL", values: [6] },
    ]);
    expect([s.ball, s.turnover]).toEqual([{ square: { x: 9, y: 2 }, carried: true }, false]);
    s = applyActions(start, [{ type: "MOVE", square: { x: 5, y: 1 } }, { type: "MOVE", square: { x: 5, y: 0 } }]);
    expect(find(s, "PUNT")?.crowd).toBe(true);
  });

  it("hail-mary-pass: any square, never accurate, no interception", () => {
    let s = applyActions(load("hail-mary-pass"), [{ type: "START_ACTION", playerId: "home-1", action: "pass" }]);
    expect(find(s, "HAIL_MARY_PASS")?.needed).toBe(5);
    s = applyActions(s, [{ type: "HAIL_MARY_PASS", square: { x: 20, y: 7 } }, { type: "ROLL", values: [6] }]);
    expect(find(s, "ROLL")?.reason).toBe("Inaccurate pass");
  });

  it("trickster: the Illusionist moves next to the attacker with the ball", () => {
    let s = applyActions(load("trickster"), [
      { type: "START_ACTION", playerId: "away-1", action: "block" },
      { type: "BLOCK", targetId: "home-1" },
    ]);
    expect(find(s, "TRICKSTER")?.squares).toContainEqual({ x: 14, y: 7 });
    s = applyActions(s, [{ type: "TRICKSTER", square: { x: 14, y: 7 } }]);
    expect(s.players["home-1"]!.at).toEqual({ x: 14, y: 7 });
    expect(s.ball).toEqual({ square: { x: 14, y: 7 }, carried: true });
  });

  it("tentacles: the Rotspawn may hold the ball carrier stepping away (4+)", () => {
    let s = applyActions(load("tentacles"), [
      { type: "START_ACTION", playerId: "home-1", action: "move" },
      { type: "MOVE", square: { x: 11, y: 7 } },
      { type: "SELECT_PLAYERS", playerIds: ["away-1"] },
    ]);
    expect(find(s, "ROLL")?.reason).toBe("Tentacles 4+ (Gloop)");
    s = applyActions(s, [{ type: "ROLL", values: [4] }]);
    expect([s.players["home-1"]!.at, s.turnover]).toEqual([{ x: 12, y: 7 }, false]);
  });

  it("give-and-go: the thrower moves on after a quick pass", () => {
    const s = applyActions(load("give-and-go"), [
      { type: "START_ACTION", playerId: "home-1", action: "pass" },
      { type: "THROW", square: { x: 7, y: 7 } },
      { type: "ROLL", values: [6] },
      { type: "ROLL", values: [6] },
    ]);
    expect(s.ball).toEqual({ square: { x: 7, y: 7 }, carried: true });
    expect(find(s, "MOVE")?.playerId).toBe("home-1");
  });

  it("kick-team-mate: a fumbled kick hurts the Gnoblar, who drops the ball", () => {
    let s = applyActions(load("kick-team-mate"), [{ type: "START_ACTION", playerId: "home-1", action: "ktm" }, { type: "ROLL", values: [6] }]);
    expect(find(s, "THROW_TEAM_MATE")?.playerIds).toEqual(["home-2"]);
    s = applyActions(s, [{ type: "THROW_TEAM_MATE", targetId: "home-2", square: { x: 5, y: 7 } }, { type: "ROLL", values: [1] }, { type: "DECLINE_REROLL" }]);
    expect(find(s, "ROLL")?.reason).toBe("Injury (Snit, fumbled kick)");
    const choices = find(load("kick-team-mate"), "START_ACTION")!.choices;
    expect(choices.find((c) => c.playerId === "home-1")?.actions).toContain("ktm");
    expect(choices.find((c) => c.playerId === "home-3")?.actions).toContain("ttm");
  });

  it("swoop: after the throw, the Doom Diver may swoop instead of scattering", () => {
    let s = applyActions(load("swoop"), [{ type: "START_ACTION", playerId: "home-1", action: "ttm" }, { type: "ROLL", values: [6] }]);
    s = applyActions(s, [{ type: "THROW_TEAM_MATE", targetId: "home-2", square: { x: 6, y: 5 } }, { type: "ROLL", values: [6] }, { type: "ROLL", values: [6] }]);
    expect(find(s, "SWOOP")?.squares).toHaveLength(4);
  });

  it("chainsaw: an attack instead of a block, or +3 in a foul", () => {
    const start = load("chainsaw");
    expect(start.players["away-3"]).toMatchObject({ at: { x: 14, y: 9 }, status: "prone" });
    const s = applyActions(start, [{ type: "START_ACTION", playerId: "home-1", action: "block" }]);
    expect(find(s, "CHAINSAW")?.targetIds).toEqual(["away-1"]);
  });

  it("ball-and-chain: the Fanatic only moves, and a step into a team-mate blocks them", () => {
    let s = load("ball-and-chain");
    expect(find(s, "START_ACTION")?.choices.find((c) => c.playerId === "home-1")?.actions).toEqual(["move"]);
    s = applyActions(s, [{ type: "START_ACTION", playerId: "home-1", action: "move" }, { type: "MOVE", square: { x: 11, y: 7 } }, { type: "ROLL", values: [3] }]);
    expect(s.players["home-1"]!.at).toEqual({ x: 11, y: 7 });
    s = applyActions(s, [{ type: "MOVE", square: { x: 12, y: 7 } }, { type: "ROLL", values: [3] }]);
    expect(s.log).toContainEqual(expect.objectContaining({ type: "BlockDeclared", attackerId: "home-1", defenderId: "home-2" }));
  });

  it("inducements: the Weather Mage at the start of the turn, the Team Mascot on a failed dodge", () => {
    const s = load("inducements");
    expect(getAvailableActions(s).some((t) => t.type === "WEATHER_MAGE")).toBe(true);
    const dodge = applyActions(s, [{ type: "START_ACTION", playerId: "home-1", action: "move" }, { type: "MOVE", square: { x: 11, y: 7 } }, { type: "ROLL", values: [1] }]);
    expect(find(dodge, "USE_REROLL")?.mascot).toBe(true);
  });

  it("prayers: three D16 draws before the coin toss", () => {
    let s = load("prayers");
    expect(find(s, "ROLL")?.dice).toEqual([{ kind: "d16", count: 1 }]);
    s = applyActions(s, [{ type: "ROLL", values: [2] }, { type: "ROLL", values: [9] }, { type: "ROLL", values: [15] }]);
    expect(s.teams.home.prayers).toEqual(["friends-with-the-ref", "moles-under-the-pitch", "under-scrutiny"]);
    expect(find(s, "CALL_COIN")).toBeDefined();
  });

  it("end-of-game: a casualty's Star Player Points, then an illegal concession down to player loss", () => {
    let s = load("end-of-game");
    expect([s.players["away-1"]!.at, s.players["home-2"]!.spp.casualties]).toEqual(["cas", 1]);
    expect(find(s, "CONCEDE")).toEqual({ type: "CONCEDE", side: "home", legal: false });
    s = applyActions(s, [{ type: "CONCEDE" }, { type: "SELECT_PLAYERS", playerIds: ["away-2"] }, { type: "SELECT_PLAYERS", playerIds: ["away-3"] }, { type: "ROLL", values: [2] }, { type: "ROLL", values: [4] }]);
    expect(find(s, "ROLL")?.reason).toBe("Player loss: Wilhelm leaves on 1-3");
    s = step(s, { type: "ROLL", values: [5] }).state;
    expect([s.finished, s.result?.winner, s.teams.away.score, s.result?.dedicatedFans]).toEqual([true, "away", 2, { home: -2, away: 1 }]);
  });
});
