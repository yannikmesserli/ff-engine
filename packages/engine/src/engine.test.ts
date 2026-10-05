import { describe, expect, it } from "vitest";
import { interceptionTarget } from "./procedures/pass";
import {
  CASUALTY_DICE,
  IllegalActionError,
  casualtyFor,
  createGame,
  getAvailableActions,
  injuryOutcome,
  isStalling,
  step,
  throwInDirection,
  type Action,
  type ActionTemplate,
  type GameState,
  type PlayerActionType,
  type PlayerState,
  type Side,
  type Square,
  type TeamSetup,
} from "./index";

/** BB2025 Human-like linemen: MA6 ST3 AG3+ PA4+ AV8+. */
const team = (name: string, options: { rerolls?: number; ma?: number; st?: number; skills?: string[] } = {}): TeamSetup => ({
  name,
  roster: "Human",
  rerolls: options.rerolls ?? 1,
  apothecary: false,
  dedicatedFans: 2,
  cheerleaders: 0,
  assistantCoaches: 0,
  players: Array.from({ length: 11 }, (_, i) => ({
    nr: i + 1,
    name: `${name} ${i + 1}`,
    position: "Human Lineman",
    ma: options.ma ?? 6,
    st: options.st ?? 3,
    ag: 3,
    pa: 4,
    av: 8,
    skills: options.skills ?? [],
  })),
});

const apply = (state: GameState, ...actions: Action[]) => actions.reduce((s, a) => step(s, a).state, state);
const roll = (...values: number[]): Action => ({ type: "ROLL", values });
const declare = (playerId: string, action: PlayerActionType, targetId?: string): Action => ({
  type: "START_ACTION",
  playerId,
  action,
  ...(targetId ? { targetId } : {}),
});
const startMove = (playerId: string) => declare(playerId, "move");
const move = (...squares: Square[]) => squares.map((square): Action => ({ type: "MOVE", square }));
const top = (s: GameState) => s.stack.at(-1)!;
const types = (s: GameState) => getAvailableActions(s).map((a) => a.type);
const find = <T extends ActionTemplate["type"]>(s: GameState, type: T) =>
  getAvailableActions(s).find((t): t is Extract<ActionTemplate, { type: T }> => t.type === type);
/** The actions a player may declare right now. */
const actionsOf = (s: GameState, playerId: string) => find(s, "START_ACTION")?.choices.find((c) => c.playerId === playerId)?.actions;

/** Edit a copy of a state to build a scenario (immer freezes states). */
const edit = (s: GameState, change: (copy: GameState) => void) => {
  const copy = structuredClone(s);
  change(copy);
  return copy;
};
/** Move players around for a scenario. */
const place = (s: GameState, squares: Record<string, Square>) =>
  edit(s, (copy) => {
    for (const [id, at] of Object.entries(squares)) copy.players[id]!.at = at;
  });

/** Home defends the left half (LoS x=12), away the right (LoS x=13). */
function setupActions(side: Side): Action[] {
  const los = side === "home" ? 12 : 13;
  const dir = side === "home" ? -1 : 1;
  const squares: Square[] = [
    { x: los, y: 6 },
    { x: los, y: 7 },
    { x: los, y: 8 },
    ...Array.from({ length: 8 }, (_, i) => ({ x: los + dir * (2 + (i % 2) * 2), y: 4 + i })),
  ];
  return [
    ...squares.map((square, i): Action => ({ type: "PLACE_PLAYER", playerId: `${side}-${i + 1}`, square })),
    { type: "END_SETUP" },
  ];
}

/** Fan factor D3s, then nice weather (3+4). */
const pregame = (s: GameState) => apply(s, roll(1, 1), roll(3, 4));

/** Get the Ref (1+1): a kick-off event without effect on the pitch. */
const QUIET_EVENT = roll(1, 1);

/** Home calls tails, the coin shows heads: away wins and kicks. */
const toSetup = (home = team("Home"), away = team("Away"), seed = 1) =>
  apply(pregame(createGame(home, away, { seed })), { type: "CALL_COIN", call: "tails" }, roll(1), { type: "CHOOSE_KICK", kick: true });

/** Both teams set up and the ball is placed at `square`, ready for the deviation roll. */
const toKick = (square: Square, home = team("Home"), away = team("Away")) =>
  apply(toSetup(home, away), ...setupActions("away"), ...setupActions("home"), { type: "PLACE_BALL", square });

/** Away kicks to (5,1), the ball deviates west to (4,1), bounces south to (4,2) and stays there. */
function toFirstTurn(home = team("Home"), away = team("Away")) {
  return apply(toKick({ x: 5, y: 1 }, home, away), roll(7, 1), QUIET_EVENT, roll(5));
}

/** home-11 starts at (8,11) with MA 6: down to the sideline and along it, using all six squares. */
const HOME_11_FULL_MOVE = move({ x: 7, y: 12 }, { x: 6, y: 13 }, { x: 5, y: 14 }, { x: 4, y: 14 }, { x: 3, y: 14 }, { x: 2, y: 14 });
/** One more square for home-11: a Rush. */
const HOME_11_RUSH = move({ x: 1, y: 14 });

/** End turns until a new kick-off (or anything else) needs a decision. */
function endTurnsUntilSetup(s: GameState) {
  while (types(s).includes("END_TURN")) s = apply(s, { type: "END_TURN" });
  return s;
}

describe("engine", () => {
  describe("game flow", () => {
    it("rolls fan factor and weather, then asks the home coach to call the coin toss", () => {
      let s = createGame(team("Home"), team("Away"), { seed: 42 });
      expect(find(s, "ROLL")?.dice).toEqual([{ kind: "d3", count: 2 }]);
      s = apply(s, roll(1, 3), roll(6, 6));
      expect([s.teams.home.fanFactor, s.teams.away.fanFactor, s.weather]).toEqual([3, 5, "blizzard"]);
      expect(getAvailableActions(s)).toEqual([{ type: "CALL_COIN", side: "home" }]);
    });

    it("is pure: step does not mutate the input state", () => {
      const s = createGame(team("Home"), team("Away"), { seed: 42 });
      const snapshot = JSON.stringify(s);
      step(s, roll(1, 1));
      expect(JSON.stringify(s)).toBe(snapshot);
    });

    it("is deterministic for a given seed", () => {
      const play = () => apply(createGame(team("Home"), team("Away"), { seed: 7 }), { type: "ROLL" }, { type: "ROLL" }).log;
      expect(play()).toEqual(play());
    });

    it("lets the coin toss winner choose to kick or receive", () => {
      let s = apply(pregame(createGame(team("Home"), team("Away"), { seed: 1 })), { type: "CALL_COIN", call: "heads" }, roll(1));
      expect(getAvailableActions(s)).toEqual([{ type: "CHOOSE_KICK", side: "home" }]);
      s = apply(s, { type: "CHOOSE_KICK", kick: false });
      expect(s.kickingFirstHalf).toBe("away");
      expect(top(s)).toEqual({ type: "Setup", side: "away" });
    });

    it("rejects actions that are not available", () => {
      expect(() => step(createGame(team("Home"), team("Away")), { type: "END_TURN" })).toThrow(IllegalActionError);
    });

    it("rejects invalid manual dice", () => {
      const s = createGame(team("Home"), team("Away"));
      expect(() => step(s, roll(4, 1))).toThrow(IllegalActionError);
      expect(() => step(s, roll(1))).toThrow(/Expected 2 dice/);
    });
  });

  describe("setup", () => {
    it("requires 11 players with 3 on the line of scrimmage", () => {
      const s = toSetup();
      expect(() => step(s, { type: "END_SETUP" })).toThrow(/11 players must be set up/);
      expect(() => apply(s, ...setupActions("away"))).not.toThrow();
    });

    it("does not count line of scrimmage squares in the wide zones", () => {
      let s = toSetup();
      const actions = setupActions("away").slice(0, -1);
      // Move the third line player to the top wide zone of the line of scrimmage.
      actions[2] = { type: "PLACE_PLAYER", playerId: "away-3", square: { x: 13, y: 3 } };
      s = apply(s, ...actions);
      expect(find(s, "END_SETUP")?.errors).toEqual([expect.stringMatching(/line of scrimmage \(2 placed\)/)]);
    });

    it("limits wide zones to 2 players", () => {
      const s = apply(toSetup(), ...[0, 1, 2].map((y, i): Action => ({ type: "PLACE_PLAYER", playerId: `away-${i + 1}`, square: { x: 20, y } })));
      expect(find(s, "END_SETUP")?.errors).toEqual(expect.arrayContaining([expect.stringMatching(/top wide zone/)]));
    });

    it("refuses players in the opponent half", () => {
      expect(() => step(toSetup(), { type: "PLACE_PLAYER", playerId: "away-1", square: { x: 12, y: 7 } })).toThrow(/own half/);
    });

    it("swaps players dropped on a team-mate", () => {
      const s = apply(
        toSetup(),
        { type: "PLACE_PLAYER", playerId: "away-1", square: { x: 13, y: 7 } },
        { type: "PLACE_PLAYER", playerId: "away-2", square: { x: 13, y: 7 } },
      );
      expect(s.players["away-2"]!.at).toEqual({ x: 13, y: 7 });
      expect(s.players["away-1"]!.at).toBe("reserves");
    });
  });

  describe("kick-off", () => {
    it("deviates and bounces the ball, then starts the receiving team's turn", () => {
      const s = toFirstTurn();
      expect(s.ball).toEqual({ square: { x: 4, y: 2 }, carried: false });
      expect(s.activeSide).toBe("home");
      expect(s.teams.home.turn).toBe(1);
      expect(types(s)).toEqual(["START_ACTION", "END_TURN"]);
    });

    it("gives a touchback when the ball leaves the receiving half", () => {
      let s = apply(toKick({ x: 11, y: 7 }), roll(3, 3), QUIET_EVENT);
      expect(getAvailableActions(s)).toEqual([{ type: "GIVE_BALL", side: "home", playerIds: expect.arrayContaining(["home-1"]) }]);
      s = apply(s, { type: "GIVE_BALL", playerId: "home-5" });
      expect(s.ball.carried).toBe(true);
      expect(s.ball.square).toEqual(s.players["home-5"]!.at);
    });

    it("catches a kick on the player's AG without the scatter modifier", () => {
      // home-4 stands at (10,4): kick to (10,5), deviate north 1.
      const s = apply(toKick({ x: 10, y: 5 }), roll(1, 1), QUIET_EVENT);
      expect(find(s, "ROLL")?.reason).toMatch(/^Catch 3\+/);
    });
  });

  describe("movement", () => {
    it("moves a player without rolls when not marked", () => {
      let s = toFirstTurn();
      s = apply(s, startMove("home-4"), ...move({ x: 11, y: 4 }));
      expect(s.players["home-4"]!.at).toEqual({ x: 11, y: 4 });
      expect(top(s).type).toBe("MoveAction");
    });

    it("dodges on AG with no +1 bonus: AG3+ fails on a 2, succeeds on a 3", () => {
      const start = apply(toFirstTurn(), startMove("home-1"));
      expect(find(start, "MOVE")?.squares).toEqual(expect.arrayContaining([{ x: 11, y: 5, rolls: ["dodge"] }]));
      expect(apply(start, ...move({ x: 11, y: 5 }), roll(3)).players["home-1"]!.status).toBe("standing");
      expect(types(apply(start, ...move({ x: 11, y: 5 }), roll(2)))).toEqual(["USE_REROLL", "DECLINE_REROLL"]);
    });

    it("adds +1 to the dodge target per tackle zone on the destination", () => {
      // home-1 at (12,6) dodges to (12,5), still next to away-1 at (13,6).
      const s = apply(toFirstTurn(), startMove("home-1"), ...move({ x: 12, y: 5 }));
      expect(find(s, "ROLL")?.reason).toMatch(/^Dodge 4\+/);
      expect(types(apply(s, roll(3)))).toEqual(["USE_REROLL", "DECLINE_REROLL"]);
      expect(apply(s, roll(4)).players["home-1"]!.status).toBe("standing");
    });

    /** home-1 has Dodge; dodging from (12,6) to (11,5) leaves away-1's tackle zone on a 3+. */
    const dodger = (s = toFirstTurn()) => edit(s, (c) => void (c.players["home-1"]!.skills = ["Dodge"]));

    it("Dodge re-rolls a failed Dodge roll automatically, before any team re-roll", () => {
      let s = apply(dodger(), startMove("home-1"), ...move({ x: 11, y: 5 }), roll(2));
      expect(s.log).toContainEqual({ type: "SkillUsed", playerId: "home-1", skill: "Dodge" });
      expect(find(s, "ROLL")?.reason).toMatch(/^Dodge 3\+/);
      s = apply(s, roll(3));
      expect(s.players["home-1"]).toMatchObject({ at: { x: 11, y: 5 }, status: "standing", usedSkills: ["Dodge"] });
      expect(s.teams.home.rerolls).toBe(1);
    });

    it("a failed Dodge re-roll cannot be re-rolled again with a team re-roll", () => {
      const s = apply(dodger(), startMove("home-1"), ...move({ x: 11, y: 5 }), roll(2), roll(2));
      expect(types(s)).not.toContain("USE_REROLL");
      expect(s.players["home-1"]!.status).toBe("prone");
    });

    it("Dodge works once per turn: the next failed dodge offers the team re-roll", () => {
      // away-2 at (10,5) marks (11,5), so leaving it is a second dodge, to (11,6).
      const start = dodger(place(toFirstTurn(), { "away-2": { x: 10, y: 5 } }));
      let s = apply(start, startMove("home-1"), ...move({ x: 11, y: 5 }), roll(1), roll(6), ...move({ x: 11, y: 6 }), roll(1));
      expect(types(s)).toEqual(["USE_REROLL", "DECLINE_REROLL"]);
      // The fall is a turnover; the skill comes back at home's next turn.
      s = apply(s, { type: "DECLINE_REROLL" }, roll(1, 1));
      expect([s.activeSide, s.players["home-1"]!.usedSkills]).toEqual(["away", ["Dodge"]]);
      s = apply(s, { type: "END_TURN" });
      expect([s.activeSide, s.players["home-1"]!.usedSkills]).toEqual(["home", []]);
    });

    it("Tackle on an opponent marking the starting square cancels the Dodge re-roll", () => {
      const s = apply(dodger(toFirstTurn(team("Home"), team("Away", { skills: ["Tackle"] }))), startMove("home-1"), ...move({ x: 11, y: 5 }), roll(2));
      expect(s.log.some((e) => e.type === "SkillUsed")).toBe(false);
      expect(types(s)).toEqual(["USE_REROLL", "DECLINE_REROLL"]);
    });

    it("Stunty ignores the tackle zones on the destination when dodging", () => {
      const stunty = edit(toFirstTurn(), (c) => void (c.players["home-1"]!.skills = ["Stunty"]));
      const s = apply(stunty, startMove("home-1"), ...move({ x: 12, y: 5 }));
      expect(find(s, "ROLL")?.reason).toMatch(/^Dodge 3\+/);
    });

    it("turns over on a failed dodge after a declined or failed re-roll", () => {
      let s = apply(toFirstTurn(), startMove("home-1"), ...move({ x: 11, y: 5 }), roll(2), { type: "USE_REROLL" }, roll(1));
      expect(s.teams.home.rerolls).toBe(0);
      // The player falls in the target square; armour 2+3 holds against AV8+.
      expect(s.players["home-1"]).toMatchObject({ at: { x: 11, y: 5 }, status: "prone" });
      s = apply(s, roll(2, 3));
      expect(s.activeSide).toBe("away");
      expect(s.log.some((e) => e.type === "TurnEnded" && e.side === "home" && e.turnover)).toBe(true);
    });

    it("allows several team re-rolls in the same turn", () => {
      let s = toFirstTurn(team("Home", { rerolls: 2 }));
      s = apply(s, startMove("home-1"), ...move({ x: 11, y: 5 }), roll(1), { type: "USE_REROLL" }, roll(3));
      s = apply(s, { type: "END_PLAYER_ACTION" }, startMove("home-2"), ...move({ x: 11, y: 8 }), roll(1));
      expect(types(s)).toEqual(["USE_REROLL", "DECLINE_REROLL"]);
    });

    it("picks up the ball on AG with no +1 bonus", () => {
      let s = toFirstTurn();
      const path: Square[] = [];
      let at = s.players["home-5"]!.at as Square;
      while (at.x !== 4 || at.y !== 2) {
        at = { x: at.x + Math.sign(4 - at.x), y: at.y + Math.sign(2 - at.y) };
        path.push(at);
      }
      s = apply(s, startMove("home-5"), ...move(...path));
      expect(find(s, "ROLL")?.reason).toMatch(/^Pick-up 3\+/);
      s = apply(s, roll(3));
      expect(s.ball).toEqual({ square: { x: 4, y: 2 }, carried: true });
    });

    it("rushes on 2+ and knocks the player down in the target square on a 1", () => {
      let s = apply(toFirstTurn(), startMove("home-11"), ...HOME_11_FULL_MOVE);
      expect(find(s, "MOVE")?.squares).toEqual(expect.arrayContaining([{ x: 1, y: 14, rolls: ["rush"] }]));
      // Rush 1 fails, decline the re-roll, armour 4+4 breaks AV8+ (equal is enough), injury 4+5 is a KO.
      s = apply(s, ...HOME_11_RUSH, roll(1), { type: "DECLINE_REROLL" }, roll(4, 4));
      expect(s.log.findLast((e) => e.type === "DiceRolled")).toMatchObject({ reason: "Armour 8+" });
      expect(s.log.some((e) => e.type === "ArmourBroken")).toBe(true);
      s = apply(s, roll(4, 5));
      expect(s.players["home-11"]!.at).toBe("ko");
      expect(s.activeSide).toBe("away");
    });

    it("lets KO'd players roll 4+ to come back before the next kick-off", () => {
      let s = apply(toFirstTurn(), startMove("home-11"), ...HOME_11_FULL_MOVE, ...HOME_11_RUSH);
      s = apply(s, roll(1), { type: "DECLINE_REROLL" }, roll(6, 6), roll(4, 5));
      s = endTurnsUntilSetup(s);
      expect(s.log.some((e) => e.type === "HalfEnded")).toBe(true);
      expect(find(s, "ROLL")?.reason).toMatch(/KO recovery 4\+ \(Home 11\)/);
      s = apply(s, roll(4));
      expect(s.players["home-11"]!.at).toBe("reserves");
      expect(top(s)).toEqual({ type: "Setup", side: "home" });
    });
  });

  describe("injuries", () => {
    const player = (skills: string[] = [], change: Partial<PlayerState> = {}): PlayerState => ({
      ...toFirstTurn().players["home-1"]!,
      skills,
      ...change,
    });

    it("reads the injury table, with Stunty and Thick Skull", () => {
      expect([7, 8, 9, 10].map((t) => injuryOutcome(player(), t))).toEqual(["stunned", "ko", "ko", "casualty"]);
      expect([7, 8].map((t) => injuryOutcome(player(["Thick Skull"]), t))).toEqual(["stunned", "stunned"]);
      expect([6, 7, 8, 9, 10].map((t) => injuryOutcome(player(["Stunty"]), t))).toEqual(["stunned", "ko", "ko", "badly-hurt", "casualty"]);
      expect([7, 8].map((t) => injuryOutcome(player(["Stunty", "Thick Skull"]), t))).toEqual(["stunned", "ko"]);
    });

    it("reads the casualty table, with Niggling Injuries and lasting injuries", () => {
      expect([8, 9, 11, 13, 15].map((d16) => casualtyFor(player(), d16, 3).result)).toEqual([
        "badly-hurt",
        "seriously-hurt",
        "serious-injury",
        "lasting-injury",
        "dead",
      ]);
      expect([1, 2, 3, 4, 5, 6].map((d6) => casualtyFor(player(), 13, d6).lasting)).toEqual(["av", "av", "ma", "pa", "ag", "st"]);
      expect(casualtyFor(player([], { nigglingInjuries: 2 }), 13, 1)).toEqual({ result: "dead" });
      // A characteristic at its limit cannot be lowered: Seriously Hurt instead.
      expect(casualtyFor(player([], { pa: null }), 14, 4)).toEqual({ result: "seriously-hurt" });
      expect(casualtyFor(player([], { av: 3 }), 14, 1)).toEqual({ result: "seriously-hurt" });
    });

    /** home-11 fails a rush and breaks its armour: the next roll is the injury roll. */
    const toInjury = (change: (s: GameState) => void = () => {}) =>
      apply(edit(toFirstTurn(), change), startMove("home-11"), ...HOME_11_FULL_MOVE, ...HOME_11_RUSH, roll(1), { type: "DECLINE_REROLL" }, roll(4, 4));
    const withApothecary = (s: GameState) => void (s.teams.home.apothecaries = 1);

    it("rolls a D16 and a D6 on a casualty and sends the player to the casualty box", () => {
      let s = apply(toInjury(), roll(5, 5));
      expect(find(s, "ROLL")).toMatchObject({ reason: "Casualty (Home 11)", dice: CASUALTY_DICE });
      s = apply(s, roll(13, 3));
      expect(s.players["home-11"]).toMatchObject({ at: "cas", casualty: { result: "lasting-injury", lasting: "ma" } });
      expect(s.log).toContainEqual({ type: "CasualtyRolled", playerId: "home-11", roll: 13, casualty: { result: "lasting-injury", lasting: "ma" } });
    });

    it("a Stunty player is Badly Hurt on a 9 without a casualty roll", () => {
      const s = apply(toInjury((c) => void (c.players["home-11"]!.skills = ["Stunty"])), roll(4, 5));
      expect(s.players["home-11"]).toMatchObject({ at: "cas", casualty: { result: "badly-hurt" } });
    });

    it("the apothecary turns a KO into Stunned on the pitch, once per game", () => {
      let s = apply(toInjury(withApothecary), roll(4, 5));
      expect(find(s, "USE_APOTHECARY")).toMatchObject({ side: "home", playerId: "home-11", outcome: "ko", casualty: null });
      s = apply(s, { type: "USE_APOTHECARY", use: true });
      expect(s.players["home-11"]).toMatchObject({ at: { x: 1, y: 14 }, status: "stunned" });
      expect(s.teams.home.apothecaries).toBe(0);
    });

    it("declining the apothecary keeps it for later", () => {
      const s = apply(toInjury(withApothecary), roll(4, 5), { type: "USE_APOTHECARY", use: false });
      expect(s.players["home-11"]!.at).toBe("ko");
      expect(s.teams.home.apothecaries).toBe(1);
    });

    it("the apothecary heals a Badly Hurt player back to the reserves", () => {
      const s = apply(toInjury(withApothecary), roll(5, 5), roll(4, 1), { type: "USE_APOTHECARY", use: true });
      expect(s.players["home-11"]).toMatchObject({ at: "reserves", casualty: null });
    });

    it("the apothecary re-rolls a worse casualty: Badly Hurt heals, otherwise the coach picks a result", () => {
      let s = apply(toInjury(withApothecary), roll(5, 5), roll(16, 1), { type: "USE_APOTHECARY", use: true });
      expect(find(s, "ROLL")?.reason).toBe("Casualty re-roll (Home 11)");
      const healed = apply(s, roll(2, 6));
      expect(healed.players["home-11"]!.at).toBe("reserves");
      s = apply(s, roll(13, 6));
      expect(find(s, "APOTHECARY_CHOICE")).toMatchObject({ first: { result: "dead" }, second: { result: "lasting-injury", lasting: "st" } });
      s = apply(s, { type: "APOTHECARY_CHOICE", keep: "second" });
      expect(s.players["home-11"]).toMatchObject({ at: "cas", casualty: { result: "lasting-injury", lasting: "st" } });
    });

    const regenerating = (s: GameState) => void (s.players["home-11"]!.skills = ["Regeneration"]);

    it("Regeneration on 4+ heals a casualty before the apothecary", () => {
      let s = apply(toInjury((c) => (regenerating(c), withApothecary(c))), roll(5, 5), roll(16, 1));
      expect(find(s, "ROLL")?.reason).toBe("Regeneration 4+ (Home 11)");
      s = apply(s, roll(4));
      expect(s.players["home-11"]).toMatchObject({ at: "reserves", casualty: null });
      expect(s.log).toContainEqual({ type: "Regenerated", playerId: "home-11" });
      expect(s.teams.home.apothecaries).toBe(1);
    });

    it("a failed Regeneration can use a team re-roll in the player's turn, then the apothecary is offered", () => {
      let s = apply(toInjury((c) => (regenerating(c), withApothecary(c))), roll(5, 5), roll(16, 1), roll(3));
      expect(types(s)).toEqual(["USE_REROLL", "DECLINE_REROLL"]);
      s = apply(s, { type: "USE_REROLL" }, roll(2));
      expect(find(s, "USE_APOTHECARY")).toMatchObject({ casualty: { result: "dead" } });
    });

    it("Regeneration also covers a Stunty player's Badly Hurt, and does nothing for a KO", () => {
      const stunty = apply(toInjury((c) => void (c.players["home-11"]!.skills = ["Stunty", "Regeneration"])), roll(4, 5), roll(6));
      expect(stunty.players["home-11"]!.at).toBe("reserves");
      const ko = apply(toInjury(regenerating), roll(4, 5));
      expect(ko.players["home-11"]!.at).toBe("ko");
    });

    it("a player KO'd in the crowd goes to the reserves with the apothecary", () => {
      let s = place(toFirstTurn(), { "home-4": { x: 12, y: 1 }, "away-4": { x: 12, y: 0 } });
      s = edit(s, (c) => void (c.teams.away.apothecaries = 1));
      s = apply(s, declare("home-4", "block"), { type: "BLOCK", targetId: "away-4" }, roll(3), { type: "CHOOSE_BLOCK_DIE", index: 0 }, roll(4, 5));
      expect(find(s, "USE_APOTHECARY")?.side).toBe("away");
      s = apply(s, { type: "USE_APOTHECARY", use: true });
      expect(s.players["away-4"]!.at).toBe("reserves");
    });
  });

  describe("jumping over prone players", () => {
    /** home-4 at (5,5) next to a prone away-1 at (6,5); no tackle zones around. */
    const toJump = (change: (s: GameState) => void = () => {}) =>
      edit(toFirstTurn(), (c) => {
        c.players["home-4"]!.at = { x: 5, y: 5 };
        c.players["away-1"]!.at = { x: 6, y: 5 };
        c.players["away-1"]!.status = "prone";
        change(c);
      });

    it("offers two-square jumps over prone or stunned players, with a Jump roll instead of a Dodge", () => {
      const s = apply(toJump(), startMove("home-4"));
      const squares = find(s, "MOVE")!.squares;
      expect(squares).toContainEqual({ x: 7, y: 5, jump: true, rolls: ["jump"] });
      // Knight-like jumps count when either square on the way holds the prone player.
      expect(squares).toContainEqual({ x: 7, y: 4, jump: true, rolls: ["jump"] });
      expect(squares.some((sq) => sq.x === 7 && sq.y === 7)).toBe(false);
      const standing = apply(toJump((c) => void (c.players["away-1"]!.status = "standing")), startMove("home-4"));
      expect(find(standing, "MOVE")!.squares.some((sq) => sq.x === 7)).toBe(false);
    });

    it("jumps on AG and uses two squares of movement", () => {
      let s = apply(toJump(), startMove("home-4"), ...move({ x: 7, y: 5 }));
      expect(find(s, "ROLL")?.reason).toMatch(/^Jump 3\+/);
      s = apply(s, roll(3));
      expect(s.players["home-4"]).toMatchObject({ at: { x: 7, y: 5 }, status: "standing", movesUsed: 2 });
    });

    it("adds the tackle zones of the busier square, the one left or the one landed in", () => {
      const marked = toJump((c) => {
        c.players["away-2"]!.at = { x: 8, y: 6 };
        c.players["away-3"]!.at = { x: 8, y: 4 };
        c.players["away-4"]!.at = { x: 4, y: 4 };
      });
      const s = apply(marked, startMove("home-4"), ...move({ x: 7, y: 5 }));
      expect(find(s, "ROLL")?.reason).toMatch(/^Jump 5\+/);
    });

    it("a failed jump falls in the target square, a natural 1 in the starting square", () => {
      const failed = apply(toJump(), startMove("home-4"), ...move({ x: 7, y: 5 }), roll(2), { type: "DECLINE_REROLL" });
      expect(failed.players["home-4"]).toMatchObject({ at: { x: 7, y: 5 }, status: "prone" });
      expect(failed.activeSide).toBe("home");
      const one = apply(toJump(), startMove("home-4"), ...move({ x: 7, y: 5 }), roll(1), { type: "DECLINE_REROLL" });
      expect(one.players["home-4"]).toMatchObject({ at: { x: 5, y: 5 }, status: "prone" });
    });

    it("needs a Rush for each jumped square past MA; a failed Rush falls in the starting square", () => {
      // Starting the action resets the squares moved, so set them afterwards.
      const tired = edit(apply(toJump(), startMove("home-4")), (c) => void (c.players["home-4"]!.movesUsed = 5));
      expect(find(tired, "MOVE")!.squares).toContainEqual({ x: 7, y: 5, jump: true, rolls: ["rush", "jump"] });
      const exhausted = edit(tired, (c) => void (c.players["home-4"]!.movesUsed = 6));
      expect(find(exhausted, "MOVE")!.squares).toContainEqual({ x: 7, y: 5, jump: true, rolls: ["rush", "rush", "jump"] });
      const s = apply(exhausted, ...move({ x: 7, y: 5 }), roll(2), roll(1), { type: "DECLINE_REROLL" });
      expect(s.players["home-4"]).toMatchObject({ at: { x: 5, y: 5 }, status: "prone" });
    });
  });

  describe("stalling", () => {
    /** home-5 holds the ball at (20,1): unmarked, five squares from the end zone. */
    const toStalling = (change: (s: GameState) => void = () => {}) =>
      edit(toFirstTurn(), (c) => {
        c.players["home-5"]!.at = { x: 20, y: 1 };
        c.ball = { square: { x: 20, y: 1 }, carried: true };
        change(c);
      });

    it("an unmarked ball carrier who could walk into the end zone is stalling", () => {
      const s = toStalling();
      expect(isStalling(s, s.players["home-5"]!)).toBe(true);
      const marked = toStalling((c) => void (c.players["away-1"]!.at = { x: 21, y: 1 }));
      expect(isStalling(marked, marked.players["home-5"]!)).toBe(false);
      const far = toStalling((c) => void (c.players["home-5"]!.ma = 4));
      expect(isStalling(far, far.players["home-5"]!)).toBe(false);
      // A wall of tackle zones blocks the path even if the end zone is in range.
      const walled = toStalling((c) => {
        for (const [id, y] of [["away-1", 0], ["away-2", 2], ["away-3", 4]] as const) c.players[id]!.at = { x: 22, y };
      });
      expect(isStalling(walled, walled.players["home-5"]!)).toBe(false);
    });

    it("a stalling player who ends the action with the ball is hit on a D6 of at least the turn number", () => {
      let s = apply(toStalling(), startMove("home-5"));
      expect(s.log).toContainEqual({ type: "StallingDetected", playerId: "home-5" });
      s = apply(s, ...move({ x: 20, y: 2 }), { type: "END_PLAYER_ACTION" });
      expect(find(s, "ROLL")?.reason).toBe("Stalling: the crowd throws a rock at Home 5 (hits on 1+)");
      s = apply(s, roll(1));
      expect(s.log).toContainEqual({ type: "RockThrown", playerId: "home-5", roll: 1, hit: true });
      expect(s.players["home-5"]!.status).toBe("prone");
      expect(find(s, "ROLL")?.reason).toMatch(/^Armour/);
    });

    it("the rock misses on a lower roll, and always from turn 7", () => {
      let s = apply(toStalling((c) => void (c.teams.home.turn = 4)), startMove("home-5"), { type: "END_PLAYER_ACTION" }, roll(3));
      expect(s.log).toContainEqual({ type: "RockThrown", playerId: "home-5", roll: 3, hit: false });
      expect(s.players["home-5"]!.status).toBe("standing");
      s = apply(toStalling((c) => void (c.teams.home.turn = 7)), startMove("home-5"), { type: "END_PLAYER_ACTION" });
      expect(s.log).toContainEqual({ type: "RockThrown", playerId: "home-5", roll: null, hit: false });
      expect(find(s, "START_ACTION")).toBeDefined();
    });

    it("no rock after scoring or getting rid of the ball", () => {
      const s = apply(toStalling(), startMove("home-5"), ...move({ x: 21, y: 1 }, { x: 22, y: 1 }, { x: 23, y: 1 }, { x: 24, y: 1 }, { x: 25, y: 1 }));
      expect(s.log.some((e) => e.type === "Touchdown")).toBe(true);
      expect(s.log.some((e) => e.type === "RockThrown")).toBe(false);
    });

    it("ending the turn without activating a stalling ball carrier also gets a rock", () => {
      let s = apply(toStalling((c) => void (c.teams.home.turn = 4)), { type: "END_TURN" });
      expect(s.log).toContainEqual({ type: "StallingDetected", playerId: "home-5" });
      expect(s.activeSide).toBe("home");
      s = apply(s, roll(2));
      expect(s.activeSide).toBe("away");
    });
  });

  describe("Loner", () => {
    const loner = (id: string) => (s: GameState) => edit(s, (c) => void (c.players[id]!.skills = ["Loner(4)"]));

    it("rolls before a team re-roll can be used; a failure loses the re-roll and keeps the result", () => {
      let s = apply(loner("home-1")(toFirstTurn()), startMove("home-1"), ...move({ x: 11, y: 5 }), roll(2), { type: "USE_REROLL" });
      expect(s.teams.home.rerolls).toBe(0);
      expect(find(s, "ROLL")?.reason).toBe("Loner 4+ (Home 1)");
      const lost = apply(s, roll(3));
      expect(lost.log).toContainEqual({ type: "CheckResult", kind: "loner", playerId: "home-1", success: false, roll: 3, target: 4 });
      expect(lost.players["home-1"]!.status).toBe("prone");
      expect(find(apply(s, roll(4)), "ROLL")?.reason).toMatch(/^Dodge/);
    });

    it("applies to block dice and passes too", () => {
      const blocking = apply(loner("home-2")(toFirstTurn()), declare("home-2", "block"), { type: "BLOCK", targetId: "away-2" });
      const block = apply(blocking, roll(1), { type: "USE_REROLL" }, roll(1));
      expect(block.log).toContainEqual({ type: "BlockResult", attackerId: "home-2", defenderId: "away-2", face: 1 });
      const toBall = move({ x: 7, y: 4 }, { x: 6, y: 3 }, { x: 5, y: 2 }, { x: 4, y: 2 });
      const holding = apply(loner("home-5")(toFirstTurn()), declare("home-5", "pass"), ...toBall, roll(3));
      const pass = apply(holding, { type: "THROW", square: { x: 10, y: 3 } }, roll(3), { type: "USE_REROLL" });
      expect(find(pass, "ROLL")?.reason).toBe("Loner 4+ (Home 5)");
      expect(find(apply(pass, roll(1)), "ROLL")?.reason).not.toMatch(/^Pass/);
    });
  });

  describe("standing up and stunned players", () => {
    /** Knock home-1 down with a failed dodge, then get back to home's next turn. */
    function proneHomeOne(home = team("Home"), injury = false) {
      let s = apply(toFirstTurn(home), startMove("home-1"), ...move({ x: 11, y: 5 }), roll(1), { type: "DECLINE_REROLL" });
      s = injury ? apply(s, roll(4, 4), roll(3, 3)) : apply(s, roll(2, 3));
      return apply(s, { type: "END_TURN" });
    }

    it("costs 3 squares of movement to stand up", () => {
      const s = apply(proneHomeOne(), startMove("home-1"));
      expect(s.players["home-1"]).toMatchObject({ status: "standing", movesUsed: 3 });
    });

    it("needs a 4+ for players with MA below 3, and failing just ends the action", () => {
      let s = apply(proneHomeOne(team("Home", { ma: 2 })), startMove("home-1"));
      expect(find(s, "ROLL")?.reason).toMatch(/^Stand up 4\+/);
      s = apply(s, roll(3), { type: "DECLINE_REROLL" });
      expect(s.players["home-1"]).toMatchObject({ status: "prone", activated: true });
      expect(s.activeSide).toBe("home");
      expect(types(s)).toEqual(["START_ACTION", "END_TURN"]);
    });

    it("turns stunned players face up at the start of their turn, but they cannot act in it", () => {
      const s = proneHomeOne(team("Home"), true);
      expect(s.players["home-1"]).toMatchObject({ status: "prone", activated: true });
      expect(find(s, "START_ACTION")?.choices.map((c) => c.playerId)).not.toContain("home-1");
    });
  });

  describe("block and blitz", () => {
    // After toFirstTurn: home-1..3 on (12,6..8) face away-1..3 on (13,6..8); home-4 is on (10,4), away-4 on (15,4).
    const blockAway2 = (s: GameState) => apply(s, declare("home-2", "block"), { type: "BLOCK", targetId: "away-2" });

    it("offers Move, Block and Blitz to players that can declare them", () => {
      const s = toFirstTurn();
      // The ball is loose at (4,2), so Pass, Hand-off and Secure the Ball can be declared too.
      expect(actionsOf(s, "home-2")).toEqual(["move", "block", "blitz", "pass", "handoff", "secure"]);
      expect(actionsOf(s, "home-4")).toEqual(["move", "blitz", "pass", "handoff", "secure"]);
      expect(() => step(s, declare("home-4", "block"))).toThrow(/cannot declare a block/);
    });

    it("rolls one die between equal strengths; assists only count when the helper is not marked", () => {
      let s = apply(toFirstTurn(), declare("home-2", "block"));
      expect(find(s, "BLOCK")?.targets).toEqual([
        { playerId: "away-1", dice: 1 },
        { playerId: "away-2", dice: 1 },
        { playerId: "away-3", dice: 1 },
      ]);
      // home-6 next to away-2 at (13,7) and marked by nobody else: one assist, so 4 against 3 gives 2 dice.
      s = apply(place(toFirstTurn(), { "home-6": { x: 14, y: 6 }, "away-1": { x: 20, y: 2 }, "away-6": { x: 20, y: 3 } }), declare("home-2", "block"));
      expect(find(s, "BLOCK")?.targets.find((t) => t.playerId === "away-2")?.dice).toBe(2);
    });

    it("Guard assists a block even when the helper is marked by other opponents", () => {
      // home-6 at (14,6) is next to away-2, but also marked by away-1 (13,6) and away-6 (15,6).
      const s = place(toFirstTurn(), { "home-6": { x: 14, y: 6 } });
      const dice = (state: GameState) => find(apply(state, declare("home-2", "block")), "BLOCK")?.targets.find((t) => t.playerId === "away-2")?.dice;
      expect(dice(s)).toBe(1);
      expect(dice(edit(s, (c) => (c.players["home-6"]!.skills = ["Guard"])))).toBe(2);
    });

    it("lets the stronger defender choose from 2 dice", () => {
      const s = apply(toFirstTurn(team("Home"), team("Away", { st: 4 })), declare("home-2", "block"));
      expect(find(s, "BLOCK")?.targets.find((t) => t.playerId === "away-2")?.dice).toBe(-2);
    });

    it("Pow: pushes the defender, lets the attacker follow up, then knocks the defender down", () => {
      let s = apply(blockAway2(toFirstTurn()), roll(6));
      expect(find(s, "CHOOSE_BLOCK_DIE")).toEqual({ type: "CHOOSE_BLOCK_DIE", side: "home", results: [6] });
      expect(types(s)).toContain("USE_REROLL");
      s = apply(s, { type: "CHOOSE_BLOCK_DIE", index: 0 });
      expect(find(s, "PUSH")?.squares).toEqual([
        { x: 14, y: 6 },
        { x: 14, y: 7 },
        { x: 14, y: 8 },
      ]);
      s = apply(s, { type: "PUSH", square: { x: 14, y: 7 } }, { type: "FOLLOW_UP", follow: true });
      expect(s.players["home-2"]!.at).toEqual({ x: 13, y: 7 });
      s = apply(s, roll(4, 4), roll(2, 3));
      expect(s.players["away-2"]).toMatchObject({ at: { x: 14, y: 7 }, status: "stunned" });
      expect(s.activeSide).toBe("home");
    });

    it("Attacker Down when the defender chooses: the attacker falls and it is a turnover", () => {
      let s = apply(blockAway2(toFirstTurn(team("Home"), team("Away", { st: 4 }))), roll(1, 6));
      // The attacker decides on the re-roll first, then the defending coach picks the die.
      expect(types(s)).toEqual(["USE_REROLL", "DECLINE_REROLL"]);
      s = apply(s, { type: "DECLINE_REROLL" });
      expect(find(s, "CHOOSE_BLOCK_DIE")?.side).toBe("away");
      s = apply(s, { type: "CHOOSE_BLOCK_DIE", index: 0 }, roll(1, 1));
      expect(s.players["home-2"]!.status).toBe("prone");
      expect(s.activeSide).toBe("away");
    });

    it("Both Down knocks down players without the Block skill", () => {
      const s = apply(blockAway2(toFirstTurn(team("Home", { skills: ["Block"] }))), roll(2), { type: "CHOOSE_BLOCK_DIE", index: 0 }, roll(1, 1));
      expect([s.players["home-2"]!.status, s.players["away-2"]!.status]).toEqual(["standing", "prone"]);
      expect(s.activeSide).toBe("home");
    });

    it("Stumble is only a push for a defender with Dodge", () => {
      const s = apply(blockAway2(toFirstTurn(team("Home"), team("Away", { skills: ["Dodge"] }))), roll(5), { type: "CHOOSE_BLOCK_DIE", index: 0 });
      expect(find(s, "PUSH")).toBeDefined();
      const after = apply(s, { type: "PUSH", square: { x: 14, y: 7 } }, { type: "FOLLOW_UP", follow: false });
      expect(after.players["away-2"]).toMatchObject({ at: { x: 14, y: 7 }, status: "standing" });
    });

    it("Tackle cancels the defender's Dodge on a Stumble", () => {
      let s = apply(blockAway2(toFirstTurn(team("Home", { skills: ["Tackle"] }), team("Away", { skills: ["Dodge"] }))), roll(5));
      s = apply(s, { type: "CHOOSE_BLOCK_DIE", index: 0 }, { type: "PUSH", square: { x: 14, y: 7 } }, { type: "FOLLOW_UP", follow: false });
      expect(s.players["away-2"]).toMatchObject({ at: { x: 14, y: 7 }, status: "prone" });
      expect(find(s, "ROLL")?.reason).toMatch(/^Armour 8\+/);
    });

    it("lets the attacker re-roll all block dice once with a team re-roll", () => {
      let s = apply(blockAway2(toFirstTurn()), roll(1), { type: "USE_REROLL" });
      expect(s.teams.home.rerolls).toBe(0);
      // A single die with no re-roll left leaves nothing to choose.
      s = apply(s, roll(6));
      expect(s.log).toContainEqual({ type: "BlockResult", attackerId: "home-2", defenderId: "away-2", face: 6 });
      expect(types(s)).toEqual(["PUSH"]);
    });

    it("chain-pushes when every pushback square is occupied", () => {
      let s = place(toFirstTurn(), { "away-6": { x: 14, y: 6 }, "away-7": { x: 14, y: 7 }, "away-8": { x: 14, y: 8 } });
      s = apply(blockAway2(s), roll(3), { type: "CHOOSE_BLOCK_DIE", index: 0 });
      expect(find(s, "PUSH")).toMatchObject({ playerId: "away-2", squares: [{ x: 14, y: 6 }, { x: 14, y: 7 }, { x: 14, y: 8 }] });
      s = apply(s, { type: "PUSH", square: { x: 14, y: 7 } });
      expect(find(s, "PUSH")?.playerId).toBe("away-7");
      s = apply(s, { type: "PUSH", square: { x: 15, y: 7 } }, { type: "FOLLOW_UP", follow: false });
      expect([s.players["away-2"]!.at, s.players["away-7"]!.at]).toEqual([
        { x: 14, y: 7 },
        { x: 15, y: 7 },
      ]);
    });

    it("pushes players off the pitch into the crowd: injury without armour, stunned goes to the reserves", () => {
      let s = place(toFirstTurn(), { "home-4": { x: 12, y: 1 }, "away-4": { x: 12, y: 0 } });
      s = apply(s, declare("home-4", "block"), { type: "BLOCK", targetId: "away-4" }, roll(3), { type: "CHOOSE_BLOCK_DIE", index: 0 });
      expect(find(s, "ROLL")?.reason).toMatch(/pushed into the crowd/);
      s = apply(s, roll(3, 3), { type: "FOLLOW_UP", follow: true });
      expect(s.players["away-4"]!.at).toBe("reserves");
      expect(s.players["home-4"]!.at).toEqual({ x: 12, y: 0 });
    });

    it("Blitz: names the target, moves, blocks once for one square of movement, and can keep moving", () => {
      let s = toFirstTurn();
      expect(() => step(s, declare("home-4", "blitz"))).toThrow(/must name/);
      s = apply(s, declare("home-4", "blitz", "away-4"), ...move({ x: 11, y: 4 }, { x: 12, y: 4 }, { x: 13, y: 4 }, { x: 14, y: 4 }));
      expect(find(s, "BLOCK")?.targets).toEqual([{ playerId: "away-4", dice: 1 }]);
      s = apply(s, { type: "BLOCK", targetId: "away-4" }, roll(4), { type: "CHOOSE_BLOCK_DIE", index: 0 }, { type: "PUSH", square: { x: 16, y: 4 } }, { type: "FOLLOW_UP", follow: false });
      expect(s.players["home-4"]!.movesUsed).toBe(5);
      expect(find(s, "BLOCK")).toBeUndefined();
      expect(find(s, "MOVE")?.squares.length).toBeGreaterThan(0);
      // Only one Blitz per turn.
      s = apply(s, { type: "END_PLAYER_ACTION" });
      expect(actionsOf(s, "home-5")).toEqual(["move", "pass", "handoff", "secure"]);
    });

    it("Blitz: blocking with no movement left needs a Rush", () => {
      let s = place(toFirstTurn(), { "away-4": { x: 10, y: 1 } });
      s = apply(s, declare("home-4", "blitz", "away-4"), ...move({ x: 9, y: 5 }, { x: 8, y: 4 }, { x: 7, y: 3 }, { x: 8, y: 3 }, { x: 9, y: 3 }, { x: 9, y: 2 }));
      expect(s.players["home-4"]!.movesUsed).toBe(6);
      s = apply(s, { type: "BLOCK", targetId: "away-4" });
      expect(find(s, "ROLL")?.reason).toMatch(/^Rush 2\+/);
    });
  });

  describe("pass, hand-off and secure the ball", () => {
    /** home-5 at (8,5) walks to the ball at (4,2). */
    const TO_BALL = move({ x: 7, y: 4 }, { x: 6, y: 3 }, { x: 5, y: 2 }, { x: 4, y: 2 });
    /** home-5 declares `action`, walks to the ball and picks it up (3+). */
    const pickUp = (s: GameState, action: PlayerActionType = "pass") => apply(s, declare("home-5", action), ...TO_BALL, roll(3));

    it("uses the BB2025 range table and adds the range, tackle zones and weather to PA", () => {
      const s = pickUp(toFirstTurn());
      const targets = find(s, "THROW")!.squares;
      const at = (x: number, y: number) => targets.find((t) => t.x === x && t.y === y);
      expect(at(7, 2)).toMatchObject({ range: "quick", needed: 4 });
      expect(at(10, 2)).toMatchObject({ range: "short", needed: 5 });
      expect(at(14, 2)).toMatchObject({ range: "long", needed: 6 });
      expect(at(17, 2)).toMatchObject({ range: "bomb" });
      expect(at(18, 2)).toBeUndefined();
    });

    it("accurate pass to a team-mate: catch on AG with no modifier, no turnover", () => {
      // home-4 at (10,4) is in Short range of (4,2).
      let s = apply(pickUp(toFirstTurn()), { type: "THROW", square: { x: 10, y: 4 } });
      expect(find(s, "ROLL")?.reason).toBe("Pass 5+ (short)");
      s = apply(s, roll(5));
      expect(s.log).toContainEqual({ type: "PassResult", playerId: "home-5", result: "accurate" });
      expect(find(s, "ROLL")?.reason).toMatch(/^Catch 3\+/);
      s = apply(s, roll(3));
      expect(s.ball).toEqual({ square: { x: 10, y: 4 }, carried: true });
      expect([s.activeSide, s.activePlayerId]).toEqual(["home", null]);
    });

    it("inaccurate pass scatters three times and is harder to catch", () => {
      let s = apply(pickUp(toFirstTurn()), { type: "THROW", square: { x: 10, y: 3 } }, roll(3), { type: "DECLINE_REROLL" });
      expect(s.log).toContainEqual({ type: "PassResult", playerId: "home-5", result: "inaccurate" });
      // Scatter S (5), N (1), S (5): from (10,3) to (10,4), where home-4 stands.
      s = apply(s, roll(5, 1, 5));
      expect(find(s, "ROLL")?.reason).toMatch(/^Catch 4\+/);
    });

    it("fumble: the ball bounces from the thrower and it is a turnover", () => {
      const s = apply(pickUp(toFirstTurn()), { type: "THROW", square: { x: 10, y: 4 } }, roll(1), { type: "DECLINE_REROLL" }, roll(1));
      expect(s.log).toContainEqual({ type: "PassResult", playerId: "home-5", result: "fumble" });
      expect(s.activeSide).toBe("away");
    });

    it("lets the defending coach intercept with an opponent under the ruler (AG +3 for an accurate pass)", () => {
      let s = place(toFirstTurn(), { "away-4": { x: 9, y: 3 } });
      s = apply(pickUp(s), { type: "THROW", square: { x: 12, y: 4 } }, roll(6));
      expect(find(s, "SELECT_PLAYERS")).toMatchObject({ side: "away", playerIds: ["away-4"], max: 1 });
      s = apply(s, { type: "SELECT_PLAYERS", playerIds: ["away-4"] });
      expect(find(s, "ROLL")?.reason).toBe("Interception 6+ (Away 4)");
      s = apply(s, roll(6));
      expect(s.ball).toEqual({ square: { x: 9, y: 3 }, carried: true });
      expect(s.activeSide).toBe("away");
    });

    it("makes interceptions 1 harder in Pouring Rain", () => {
      // Unmarked at (9,2): AG3 +2 for an inaccurate pass.
      const s = place(toFirstTurn(), { "away-4": { x: 9, y: 2 } });
      const interceptor = s.players["away-4"]! as GameState["players"][string] & { at: Square };
      expect(interceptionTarget(s, interceptor, "inaccurate")).toBe(5);
      expect(interceptionTarget(edit(s, (c) => (c.weather = "pouring-rain")), interceptor, "inaccurate")).toBe(6);
    });

    it("hand-off to an adjacent team-mate who catches on AG", () => {
      let s = place(toFirstTurn(), { "home-4": { x: 5, y: 3 } });
      s = apply(pickUp(s, "handoff"), { type: "HAND_OFF", targetId: "home-4" });
      expect(find(s, "ROLL")?.reason).toMatch(/^Catch 3\+ \(Home 4\)/);
      s = apply(s, roll(3));
      expect(s.ball).toEqual({ square: { x: 5, y: 3 }, carried: true });
      expect(s.activeSide).toBe("home");
    });

    it("a failed hand-off catch is a turnover unless a team-mate catches the bounce", () => {
      let s = place(toFirstTurn(), { "home-4": { x: 5, y: 3 } });
      s = apply(pickUp(s, "handoff"), { type: "HAND_OFF", targetId: "home-4" }, roll(1), { type: "DECLINE_REROLL" });
      // Bounce north-west to (4,2), where home-5 stands: they catch it, so no turnover.
      s = apply(s, roll(8), roll(4));
      expect(s.ball).toEqual({ square: { x: 4, y: 2 }, carried: true });
      expect(s.activeSide).toBe("home");
    });

    it("carrying the ball into the opponent's end zone scores, and the scoring team kicks off next", () => {
      let s = edit(place(toFirstTurn(), { "home-6": { x: 24, y: 3 } }), (c) => (c.ball = { square: { x: 24, y: 3 }, carried: true }));
      s = apply(s, startMove("home-6"), ...move({ x: 25, y: 3 }));
      expect(s.teams.home.score).toBe(1);
      expect(s.log).toContainEqual({ type: "Touchdown", side: "home", playerId: "home-6" });
      expect(top(s)).toEqual({ type: "Setup", side: "home" });
    });

    it("a pass caught in the opponent's end zone also scores", () => {
      let s = edit(place(toFirstTurn(), { "home-6": { x: 25, y: 3 }, "home-5": { x: 22, y: 3 } }), (c) => (c.ball = { square: { x: 22, y: 3 }, carried: true }));
      s = apply(s, declare("home-5", "pass"), { type: "THROW", square: { x: 25, y: 3 } }, roll(6), roll(6));
      expect(s.teams.home.score).toBe(1);
    });

    it("Secure the Ball picks up on 2+ and ends the action", () => {
      let s = apply(toFirstTurn(), declare("home-5", "secure"), ...TO_BALL);
      expect(find(s, "ROLL")?.reason).toMatch(/^Pick-up 2\+/);
      s = apply(s, roll(2));
      expect(s.log.some((e) => e.type === "BallSecured")).toBe(true);
      expect([s.activePlayerId, s.activeSide]).toEqual([null, "home"]);
    });

    it("Secure the Ball is a turnover when the player ends the action without the ball", () => {
      const s = apply(toFirstTurn(), declare("home-5", "secure"), ...move({ x: 7, y: 4 }), { type: "END_PLAYER_ACTION" });
      expect(s.activeSide).toBe("away");
    });

    it("Secure the Ball needs no standing opponent within two squares of the ball", () => {
      const s = place(toFirstTurn(), { "away-4": { x: 6, y: 2 } });
      expect(actionsOf(s, "home-5")).not.toContain("secure");
    });

    it("Secure the Ball is not for Ball & Chain (roster spelling) or Unsteady players", () => {
      for (const skill of ["Ball & Chain", "Unsteady"]) {
        const s = edit(toFirstTurn(), (copy) => void (copy.players["home-5"]!.skills = [skill]));
        expect(actionsOf(s, "home-5")).not.toContain("secure");
      }
    });
  });

  describe("foul", () => {
    /** away-1 lies prone at (20,2); home-4 stands next to it at (19,2), ready to foul. */
    const fouling = (extra: Record<string, Square> = {}, skills: string[] = []) =>
      edit(place(toFirstTurn(), { "away-1": { x: 20, y: 2 }, "home-4": { x: 19, y: 2 }, ...extra }), (c) => {
        c.players["away-1"]!.status = "prone";
        c.players["home-4"]!.skills = skills;
      });
    /** As `fouling`, with a skill for home-4. */
    const withSkill = (skill: string, extra: Record<string, Square> = {}) => fouling(extra, [skill]);
    const foul = (s: GameState) => apply(s, declare("home-4", "foul"), { type: "FOUL", targetId: "away-1" });

    it("can only be declared while an opponent is prone or stunned", () => {
      expect(actionsOf(toFirstTurn(), "home-4")).not.toContain("foul");
      expect(actionsOf(fouling(), "home-4")).toContain("foul");
    });

    it("adds +1 per unmarked team-mate next to the victim and -1 per defender marking only the fouler", () => {
      let s = apply(fouling({ "home-6": { x: 21, y: 2 } }), declare("home-4", "foul"));
      expect(find(s, "FOUL")?.targets).toEqual([{ playerId: "away-1", assists: 1 }]);
      s = apply(fouling({ "home-6": { x: 21, y: 2 }, "away-6": { x: 18, y: 1 } }), declare("home-4", "foul"));
      expect(find(s, "FOUL")?.targets).toEqual([{ playerId: "away-1", assists: 0 }]);
    });

    it("breaks armour on armour roll + assists >= AV; without doubles the referee sees nothing", () => {
      let s = foul(fouling({ "home-6": { x: 21, y: 2 } }));
      expect(find(s, "ROLL")?.reason).toBe("Armour 8+ (foul on Away 1, +1 assists)");
      s = apply(s, roll(4, 3), roll(2, 4));
      expect(s.players["away-1"]!.status).toBe("stunned");
      expect(s.log).toContainEqual({ type: "RefereeCall", foulerId: "home-4", spotted: false });
      expect([s.activeSide, s.activePlayerId]).toEqual(["home", null]);
    });

    it("a double on the armour roll is spotted: arguing the call on a 6 keeps the fouler, but it is a turnover", () => {
      let s = apply(foul(fouling()), roll(2, 2));
      expect(types(s)).toEqual(["ARGUE_THE_CALL"]);
      s = apply(s, { type: "ARGUE_THE_CALL", argue: true }, roll(6));
      expect(s.players["home-4"]!.at).toEqual({ x: 19, y: 2 });
      expect(s.activeSide).toBe("away");
    });

    it("a double on the injury roll is spotted too; without argue or bribe the fouler is sent off", () => {
      let s = apply(foul(fouling()), roll(5, 4), roll(3, 3), { type: "ARGUE_THE_CALL", argue: false });
      expect(find(s, "BRIBE")).toMatchObject({ side: "home", bribes: 1 });
      s = apply(s, { type: "BRIBE", use: false });
      expect(s.players["home-4"]!.at).toBe("banned");
      expect(s.activeSide).toBe("away");
      expect(find(s, "START_ACTION")).toBeDefined();
    });

    it("a successful bribe (2+) keeps the fouler and avoids the turnover", () => {
      const s = apply(foul(fouling()), roll(1, 1), { type: "ARGUE_THE_CALL", argue: false }, { type: "BRIBE", use: true }, roll(2));
      expect(s.teams.home.bribes).toBe(0);
      expect(s.players["home-4"]!.at).toEqual({ x: 19, y: 2 });
      expect(s.activeSide).toBe("home");
    });

    it("arguing on a 1 bans the coach from arguing again", () => {
      const s = apply(foul(fouling()), roll(1, 1), { type: "ARGUE_THE_CALL", argue: true }, roll(1), { type: "BRIBE", use: false });
      expect(s.teams.home.coachBanned).toBe(true);
      expect(s.players["home-4"]!.at).toBe("banned");
    });

    it("a sent-off ball carrier drops the ball", () => {
      const start = edit(fouling(), (c) => (c.ball = { square: { x: 19, y: 2 }, carried: true }));
      const s = apply(foul(start), roll(3, 3), { type: "ARGUE_THE_CALL", argue: false }, { type: "BRIBE", use: false });
      expect(find(s, "ROLL")?.reason).toBe("Bounce");
    });

    it("Dirty Player adds +1 to the armour roll, and then not to the injury roll", () => {
      let s = foul(withSkill("Dirty Player"));
      expect(find(s, "ROLL")?.reason).toBe("Armour 8+ (foul on Away 1, Dirty Player)");
      s = apply(s, roll(3, 4));
      expect(find(s, "ROLL")?.reason).toBe("Injury");
      s = apply(s, roll(4, 3));
      expect(s.players["away-1"]!.status).toBe("stunned");
    });

    it("Dirty Player adds +1 to the injury roll when the assists alone break the armour", () => {
      let s = apply(foul(withSkill("Dirty Player", { "home-6": { x: 21, y: 2 } })), roll(4, 3));
      expect(find(s, "ROLL")?.reason).toBe("Injury (+1 Dirty Player)");
      s = apply(s, roll(4, 3));
      expect(s.players["away-1"]!.at).toBe("ko");
    });

    it("Sneaky Git is not spotted on an armour double if the armour holds, but is on an injury double", () => {
      let s = apply(foul(withSkill("Sneaky Git")), roll(2, 2));
      expect(s.log).toContainEqual({ type: "RefereeCall", foulerId: "home-4", spotted: false });
      expect(s.activeSide).toBe("home");
      s = apply(foul(withSkill("Sneaky Git")), roll(4, 4), roll(2, 1));
      expect(types(s)).toEqual(["ARGUE_THE_CALL"]);
    });
  });

  describe("kick-off events", () => {
    /** Away kicks to (5,1), the ball will come down at (4,1) after the event given by the two dice. */
    const kickWith = (a: number, b: number, home = team("Home")) => apply(toKick({ x: 5, y: 1 }, home), roll(7, 1), roll(a, b));
    const eventOf = (s: GameState) => s.log.find((e) => e.type === "KickoffResult");

    it("Get the Ref gives each team a bribe", () => {
      const s = kickWith(1, 1);
      expect(eventOf(s)).toMatchObject({ result: "get-the-ref" });
      expect([s.teams.home.bribes, s.teams.away.bribes]).toEqual([1, 1]);
    });

    it("Time-out moves both turn counters forward early in the half", () => {
      const s = apply(kickWith(1, 2), roll(5));
      expect(s.log).toContainEqual({ type: "TurnCountersChanged", delta: 1 });
      expect(s.teams.home.turn).toBe(2);
    });

    it("Solid Defence lets the kicking team set up D3+3 open players again", () => {
      let s = apply(kickWith(2, 2), roll(1));
      expect(find(s, "SELECT_PLAYERS")).toMatchObject({ side: "away", max: 4 });
      // Line of scrimmage players are marked by the home line.
      expect(find(s, "SELECT_PLAYERS")?.playerIds).not.toContain("away-1");
      expect(() => step(s, { type: "SELECT_PLAYERS", playerIds: ["away-1"] })).toThrow(/Invalid selection/);
      s = apply(s, { type: "SELECT_PLAYERS", playerIds: ["away-4"] }, { type: "PLACE_PLAYER", playerId: "away-4", square: { x: 20, y: 7 } });
      expect(() => step(s, { type: "PLACE_PLAYER", playerId: "away-5", square: { x: 21, y: 7 } })).toThrow(/selected players/);
      s = apply(s, { type: "END_SETUP" }, roll(5));
      expect(s.players["away-4"]!.at).toEqual({ x: 20, y: 7 });
      expect(s.activeSide).toBe("home");
    });

    it("High Kick moves an open receiving player under the ball, who then tries to catch it", () => {
      let s = kickWith(2, 3);
      expect(find(s, "SELECT_PLAYERS")).toMatchObject({ side: "home", max: 1 });
      s = apply(s, { type: "SELECT_PLAYERS", playerIds: ["home-5"] });
      expect(s.players["home-5"]!.at).toEqual({ x: 4, y: 1 });
      expect(find(s, "ROLL")?.reason).toMatch(/^Catch 3\+/);
    });

    it("Cheering Fans gives the higher roll (plus cheerleaders) an extra block assist", () => {
      const s = apply(kickWith(3, 3), roll(4, 2));
      expect([s.teams.home.extraAssist, s.teams.away.extraAssist]).toEqual([true, false]);
    });

    it("Brilliant Coaching gives both teams a drive re-roll on a tie, used before the normal ones", () => {
      let s = apply(kickWith(3, 4), roll(2, 2), roll(5));
      expect([s.teams.home.driveRerolls, s.teams.away.driveRerolls]).toEqual([1, 1]);
      s = apply(s, startMove("home-1"), ...move({ x: 11, y: 5 }), roll(1), { type: "USE_REROLL" });
      expect([s.teams.home.driveRerolls, s.teams.home.rerolls]).toEqual([0, 1]);
    });

    it("Weather Change to a blizzard makes rushing 3+", () => {
      let s = apply(kickWith(4, 4), roll(6, 6), roll(5));
      expect(s.weather).toBe("blizzard");
      s = apply(s, startMove("home-11"), ...HOME_11_FULL_MOVE, ...HOME_11_RUSH);
      expect(find(s, "ROLL")?.reason).toMatch(/^Rush 3\+/);
    });

    it("Weather Change to nice weather blows the ball three more squares", () => {
      const s = apply(kickWith(4, 4), roll(3, 4), roll(3, 3, 3));
      expect(s.log.findLast((e) => e.type === "BallScattered")).toEqual({ type: "BallScattered", to: { x: 7, y: 1 } });
      expect(find(s, "ROLL")?.reason).toBe("Bounce");
    });

    it("Quick Snap moves D3+3 open receiving players one square each", () => {
      let s = apply(kickWith(4, 5), roll(1));
      expect(find(s, "SNAP")).toMatchObject({ side: "home", remaining: 4 });
      expect(() => step(s, { type: "SNAP", playerId: "home-4", square: { x: 8, y: 4 } })).toThrow(/Illegal/);
      s = apply(s, { type: "SNAP", playerId: "home-4", square: { x: 10, y: 3 } });
      expect(find(s, "SNAP")?.remaining).toBe(3);
      s = apply(s, { type: "DONE" }, roll(5));
      expect(s.players["home-4"]!.at).toEqual({ x: 10, y: 3 });
    });

    it("Charge lets D3+3 open kicking players act before the ball lands", () => {
      let s = apply(kickWith(5, 5), roll(2), { type: "SELECT_PLAYERS", playerIds: ["away-4"] });
      expect(find(s, "START_ACTION")?.choices).toEqual([{ playerId: "away-4", actions: ["move", "blitz"] }]);
      s = apply(s, startMove("away-4"), ...move({ x: 14, y: 4 }), { type: "END_PLAYER_ACTION" }, { type: "END_TURN" });
      expect(s.log.some((e) => e.type === "ChargeEnded")).toBe(true);
      s = apply(s, roll(5));
      expect([s.activeSide, s.teams.home.turn, s.teams.away.turn]).toEqual(["home", 1, 0]);
    });

    it("Dodgy Snack gives a random player of the lowest roller -1 MA and -1 AV until the end of the drive", () => {
      const s = apply(kickWith(5, 6), roll(3, 5), roll(2));
      const snack = s.log.find((e) => e.type === "DodgySnack");
      expect(snack).toMatchObject({ sentOff: false, playerId: expect.stringMatching(/^home-/) });
      const player = s.players[(snack as { playerId: string }).playerId]!;
      expect([player.ma, player.av, player.snack]).toEqual([5, 7, { ma: 6, av: 8 }]);
    });

    it("Pitch Invasion stuns D3 random standing players of the team with the lower total", () => {
      const s = apply(kickWith(6, 6), roll(1, 6, 2));
      const stunned = Object.values(s.players).filter((p) => p.status === "stunned");
      expect(stunned).toHaveLength(2);
      expect(stunned.every((p) => p.side === "home")).toBe(true);
    });
  });

  describe("weather", () => {
    it("Sweltering Heat exhausts the same D3 number of players in each team at the end of a drive", () => {
      let s = apply(createGame(team("Home"), team("Away"), { seed: 1 }), roll(1, 1), roll(1, 1));
      expect(s.weather).toBe("sweltering-heat");
      s = apply(s, { type: "CALL_COIN", call: "tails" }, roll(1), { type: "CHOOSE_KICK", kick: true });
      s = apply(s, ...setupActions("away"), ...setupActions("home"), { type: "PLACE_BALL", square: { x: 5, y: 1 } }, roll(7, 1), QUIET_EVENT, roll(5));
      s = endTurnsUntilSetup(s);
      expect(find(s, "ROLL")).toMatchObject({ reason: "Sweltering Heat (players per team)", dice: [{ kind: "d3", count: 1 }] });
      s = apply(s, roll(2));
      expect(Object.values(s.players).filter((p) => p.exhausted).map((p) => p.side).sort()).toEqual(["away", "away", "home", "home"]);
      expect(find(s, "END_SETUP")?.errors).toEqual([expect.stringMatching(/^9 players must be set up/)]);
      const exhausted = Object.values(s.players).find((p) => p.exhausted && p.side === "home")!;
      expect(() => step(s, { type: "PLACE_PLAYER", playerId: exhausted.id, square: { x: 12, y: 7 } })).toThrow(/cannot play this drive/);
    });
  });

  describe("throw-in", () => {
    it("uses the BB2025 template from sidelines and end zones", () => {
      expect(throwInDirection({ x: 10, y: 0 }, 3)).toEqual({ x: 0, y: 1 });
      expect(throwInDirection({ x: 10, y: 14 }, 1)).toEqual({ x: -1, y: -1 });
      expect(throwInDirection({ x: 0, y: 7 }, 6)).toEqual({ x: 1, y: 1 });
      expect(throwInDirection({ x: 25, y: 7 }, 1)).toEqual({ x: -1, y: 1 });
    });

    it("uses a d3 between three directions in corners", () => {
      expect([1, 2, 3].map((r) => throwInDirection({ x: 0, y: 0 }, r))).toEqual([
        { x: 1, y: 0 },
        { x: 1, y: 1 },
        { x: 0, y: 1 },
      ]);
      expect([1, 2, 3].map((r) => throwInDirection({ x: 25, y: 14 }, r))).toEqual([
        { x: -1, y: 0 },
        { x: -1, y: -1 },
        { x: 0, y: -1 },
      ]);
    });
  });
});
