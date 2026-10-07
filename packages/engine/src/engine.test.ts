import { describe, expect, it } from "vitest";
import { interceptionTarget, interceptors } from "./procedures/pass";
import {
  CASUALTY_DICE,
  ballUnsettled,
  blockDice,
  flightMarkers,
  scatterOrigin,
  IllegalActionError,
  casualtyFor,
  createGame,
  getAvailableActions,
  injuryOutcome,
  isStalling,
  step,
  tackleZones,
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

  describe("skills", () => {
    /** Give players skills (replacing theirs) in a copy of the state. */
    const withSkills = (s: GameState, skills: Record<string, string[]>) =>
      edit(s, (c) => {
        for (const [id, list] of Object.entries(skills)) c.players[id]!.skills = list;
      });
    const blockAway2 = (s: GameState) => apply(s, declare("home-2", "block"), { type: "BLOCK", targetId: "away-2" });
    /** A single die with a team re-roll left still has to be picked. */
    const pick = { type: "CHOOSE_BLOCK_DIE", index: 0 } as const;
    const TO_BALL = move({ x: 7, y: 4 }, { x: 6, y: 3 }, { x: 5, y: 2 }, { x: 4, y: 2 });

    describe("Mighty Blow", () => {
      const pow = (s: GameState) => apply(blockAway2(withSkills(s, { "home-2": ["Mighty Blow"] })), roll(6), pick, { type: "PUSH", square: { x: 14, y: 7 } }, { type: "FOLLOW_UP", follow: false });

      it("adds +1 to the armour roll when that breaks the armour, and then not to the injury roll", () => {
        let s = pow(toFirstTurn());
        expect(find(s, "ROLL")?.reason).toBe("Armour 8+ (Away 2) (+1 Mighty Blow)");
        s = apply(s, roll(4, 3));
        expect(s.log).toContainEqual({ type: "ArmourBroken", playerId: "away-2", roll: 8 });
        expect(s.log).toContainEqual({ type: "SkillUsed", playerId: "home-2", skill: "Mighty Blow" });
        expect(find(s, "ROLL")?.reason).toBe("Injury");
        s = apply(s, roll(4, 4));
        expect(s.players["away-2"]!.at).toBe("ko");
      });

      it("adds +1 to the injury roll when the armour breaks without it", () => {
        let s = apply(pow(toFirstTurn()), roll(5, 4));
        expect(find(s, "ROLL")?.reason).toBe("Injury (+1 Mighty Blow)");
        // 3+4 is Stunned, +1 makes it KO'd.
        s = apply(s, roll(3, 4));
        expect(s.players["away-2"]!.at).toBe("ko");
      });

      it("uses the skill's value, and does not help when the attacker falls", () => {
        const s = apply(blockAway2(withSkills(toFirstTurn(), { "home-2": ["Mighty Blow(+2)"] })), roll(6), pick, { type: "PUSH", square: { x: 14, y: 7 } }, { type: "FOLLOW_UP", follow: false });
        expect(find(s, "ROLL")?.reason).toMatch(/\(\+2 Mighty Blow\)$/);
        const down = apply(blockAway2(withSkills(toFirstTurn(), { "away-2": ["Mighty Blow"] })), roll(1), pick);
        expect(find(down, "ROLL")?.reason).toBe("Armour 8+ (Home 2)");
      });
    });

    describe("Claws", () => {
      /** home-2 knocks away-2 (AV 10+) down. */
      const claw = (skills: string[], av = 10) => {
        const s = edit(withSkills(toFirstTurn(), { "home-2": skills }), (c) => void (c.players["away-2"]!.av = av));
        return apply(blockAway2(s), roll(6), pick, { type: "PUSH", square: { x: 14, y: 7 } }, { type: "FOLLOW_UP", follow: false });
      };

      it("an armour roll of 8+ breaks the armour, whatever the AV", () => {
        let s = claw(["Claws"]);
        expect(find(s, "ROLL")?.reason).toBe("Armour 10+ (Away 2) (Claws: 8+)");
        s = apply(s, roll(4, 4));
        expect(s.log).toContainEqual({ type: "SkillUsed", playerId: "home-2", skill: "Claws" });
        expect(find(s, "ROLL")?.reason).toBe("Injury");
      });

      it("does not stack with Mighty Blow, which then goes to the injury roll", () => {
        expect(apply(claw(["Claws", "Mighty Blow"]), roll(4, 3)).log).toContainEqual({ type: "ArmourHeld", playerId: "away-2", roll: 7 });
        expect(find(apply(claw(["Claws", "Mighty Blow"]), roll(4, 4)), "ROLL")?.reason).toBe("Injury (+1 Mighty Blow)");
      });

      it("does nothing against AV 8+ or less", () => {
        expect(find(claw(["Claws"], 8), "ROLL")?.reason).toBe("Armour 8+ (Away 2)");
      });
    });

    it("Titchy: +1 to the player's Dodge rolls, and opponents dodging next to them ignore their tackle zone", () => {
      // home-1 dodges from (12,6) to (12,5), into away-1's tackle zone: 4+ without Titchy.
      const dodge = (skills: Record<string, string[]>) => find(apply(withSkills(toFirstTurn(), skills), startMove("home-1"), ...move({ x: 12, y: 5 })), "ROLL")?.reason;
      expect(dodge({})).toMatch(/^Dodge 4\+/);
      expect(dodge({ "home-1": ["Titchy"] })).toMatch(/^Dodge 3\+/);
      expect(dodge({ "away-1": ["Titchy"] })).toMatch(/^Dodge 3\+/);
    });

    it("Prehensile Tail: -1 to Dodge and Jump rolls of opponents leaving its tackle zone", () => {
      const tail = withSkills(toFirstTurn(), { "away-1": ["Prehensile Tail"] });
      // home-1 leaves (12,6), marked by away-1, for (12,5), also in its tackle zone: 5+ instead of 4+.
      expect(find(apply(tail, startMove("home-1"), ...move({ x: 12, y: 5 })), "ROLL")?.reason).toMatch(/^Dodge 5\+/);
      // Leaving away-1's tackle zone towards (11,5): 4+ instead of 3+.
      expect(find(apply(tail, startMove("home-1"), ...move({ x: 11, y: 5 })), "ROLL")?.reason).toMatch(/^Dodge 4\+/);
      // Jumping over prone away-2 from (12,7) to (14,7): four tackle zones on the landing square, then the tail.
      const prone = (s: GameState) => edit(s, (c) => void (c.players["away-2"]!.status = "prone"));
      const jump = (s: GameState) => top(apply(prone(s), startMove("home-2"), ...move({ x: 14, y: 7 })));
      expect(jump(toFirstTurn())).toMatchObject({ kind: "jump", modifier: -4 });
      expect(jump(tail)).toMatchObject({ kind: "jump", modifier: -5 });
    });

    describe("Plague Ridden", () => {
      const ROTTER = { position: "Rotter Lineman", ma: 5, st: 3, ag: 4, pa: 6, av: 9, skills: ["Decay", "Plague Ridden"], keywords: ["human", "lineman"] };
      /** home-2 (Plague Ridden) knocks away-2 down and kills them: armour 12, injury 12, casualty 16. */
      const kill = (s: GameState) =>
        apply(blockAway2(s), roll(6), pick, { type: "PUSH", square: { x: 14, y: 7 } }, { type: "FOLLOW_UP", follow: false }, roll(6, 6), roll(6, 6), roll(16, 1));
      const nurgle = (change: (c: GameState) => void = () => {}) =>
        edit(withSkills(toFirstTurn({ ...team("Home"), raisePosition: ROTTER }), { "home-2": ["Plague Ridden"] }), change);

      it("an opponent killed by the player's block joins the team's reserves as a lineman, once per game", () => {
        const s = kill(nurgle());
        expect(s.players["away-2"]!.casualty).toEqual({ result: "dead" });
        expect(s.log).toContainEqual({ type: "PlayerRaised", playerId: "home-12", fromId: "away-2" });
        expect(s.players["home-12"]).toMatchObject({ name: "Away 2", position: "Rotter Lineman", side: "home", at: "reserves", ma: 5, av: 9 });
        expect(s.teams.home.raisedDead).toBe(1);
        const again = kill(edit(nurgle(), (c) => void (c.teams.home.raisedDead = 1)));
        expect(again.log.some((e) => e.type === "PlayerRaised")).toBe(false);
      });

      it("not for Big Guys or players with Stunty, Regeneration or Decay", () => {
        expect(kill(nurgle((c) => void (c.players["away-2"]!.keywords = ["big guy"]))).players["home-12"]).toBeUndefined();
        expect(kill(nurgle((c) => void (c.players["away-2"]!.skills = ["Stunty"]))).players["home-12"]).toBeUndefined();
      });
    });

    describe("Frenzy", () => {
      const frenzy = (s = toFirstTurn()) => withSkills(s, { "home-2": ["Frenzy"] });

      it("must follow up, then blocks the same defender again after a push", () => {
        let s = apply(blockAway2(frenzy()), roll(3), pick, { type: "PUSH", square: { x: 14, y: 7 } });
        expect(types(s)).not.toContain("FOLLOW_UP");
        expect(s.players["home-2"]!.at).toEqual({ x: 13, y: 7 });
        expect(s.log).toContainEqual({ type: "SkillUsed", playerId: "home-2", skill: "Frenzy" });
        expect(find(s, "ROLL")?.reason).toMatch(/^Block/);
        // The second push (to the only free square, (15,7)) is the last block: no third one.
        s = apply(s, roll(4), pick);
        expect(s.log.filter((e) => e.type === "BlockDeclared")).toHaveLength(2);
        expect(s.players["home-2"]!.at).toEqual({ x: 14, y: 7 });
        expect(top(s).type).toBe("Turn");
      });

      it("makes no second block when the defender went down", () => {
        const s = apply(blockAway2(frenzy()), roll(6), pick, { type: "PUSH", square: { x: 14, y: 7 } }, roll(2, 2));
        expect(s.log.filter((e) => e.type === "BlockDeclared")).toHaveLength(1);
      });

      it("pays another square for the second block of a Blitz", () => {
        let s = frenzy(withSkills(toFirstTurn(), { "home-4": ["Frenzy"] }));
        s = apply(s, declare("home-4", "blitz", "away-4"), ...move({ x: 11, y: 4 }, { x: 12, y: 4 }, { x: 13, y: 4 }, { x: 14, y: 4 }));
        s = apply(s, { type: "BLOCK", targetId: "away-4" }, roll(3), pick, { type: "PUSH", square: { x: 16, y: 4 } });
        // 4 squares, the first block, the follow-up is free, the second block: 6.
        expect(s.players["home-4"]!.movesUsed).toBe(6);
        expect(find(s, "ROLL")?.reason).toMatch(/^Block/);
      });
    });

    describe("Stand Firm", () => {
      const firm = (s = toFirstTurn()) => withSkills(s, { "away-2": ["Stand Firm"] });

      it("lets the defending coach refuse the push: nobody moves and there is no follow-up", () => {
        let s = apply(blockAway2(firm()), roll(3), pick);
        expect(find(s, "USE_SKILL")).toEqual({ type: "USE_SKILL", side: "away", playerId: "away-2", skill: "Stand Firm" });
        s = apply(s, { type: "USE_SKILL", use: true });
        expect(s.players["away-2"]).toMatchObject({ at: { x: 13, y: 7 }, status: "standing" });
        expect(types(s)).not.toContain("FOLLOW_UP");
        expect(top(s).type).toBe("Turn");
      });

      it("knocks the player down where they stand, or is pushed as usual when not used", () => {
        const down = apply(blockAway2(firm()), roll(6), pick, { type: "USE_SKILL", use: true });
        expect(down.players["away-2"]).toMatchObject({ at: { x: 13, y: 7 }, status: "prone" });
        expect(find(apply(blockAway2(firm()), roll(3), pick, { type: "USE_SKILL", use: false }), "PUSH")).toBeDefined();
      });

      it("stops a chain push: neither player moves", () => {
        let s = place(toFirstTurn(), { "away-6": { x: 14, y: 6 }, "away-7": { x: 14, y: 7 }, "away-8": { x: 14, y: 8 } });
        s = apply(blockAway2(withSkills(s, { "away-7": ["Stand Firm"] })), roll(3), pick, { type: "PUSH", square: { x: 14, y: 7 } });
        expect(find(s, "USE_SKILL")?.playerId).toBe("away-7");
        s = apply(s, { type: "USE_SKILL", use: true });
        expect([s.players["away-2"]!.at, s.players["away-7"]!.at]).toEqual([
          { x: 13, y: 7 },
          { x: 14, y: 7 },
        ]);
      });
    });

    it("Sidestep: the pushed player's coach picks any free adjacent square", () => {
      // With away-3 gone, home-3 assists: 2 dice.
      const s = apply(blockAway2(withSkills(place(toFirstTurn(), { "away-3": { x: 20, y: 10 } }), { "away-2": ["Sidestep"] })), roll(3, 3), pick);
      expect(find(s, "PUSH")).toEqual({
        type: "PUSH",
        side: "away",
        playerId: "away-2",
        squares: [
          { x: 14, y: 6 },
          { x: 14, y: 7 },
          { x: 13, y: 8 },
          { x: 14, y: 8 },
        ],
      });
      const after = apply(s, { type: "PUSH", square: { x: 13, y: 8 } });
      expect(after.players["away-2"]!.at).toEqual({ x: 13, y: 8 });
      expect(after.log).toContainEqual({ type: "SkillUsed", playerId: "away-2", skill: "Sidestep" });
    });

    it("Sure Hands re-rolls a failed pick-up, without a team re-roll", () => {
      const s = apply(withSkills(toFirstTurn(), { "home-5": ["Sure Hands"] }), startMove("home-5"), ...TO_BALL, roll(2));
      expect(s.log).toContainEqual({ type: "SkillUsed", playerId: "home-5", skill: "Sure Hands" });
      const after = apply(s, roll(3));
      expect(after.ball).toEqual({ square: { x: 4, y: 2 }, carried: true });
      expect(after.teams.home.rerolls).toBe(1);
    });

    it("Catch re-rolls a failed catch", () => {
      let s = withSkills(place(toFirstTurn(), { "home-4": { x: 5, y: 3 } }), { "home-4": ["Catch"] });
      s = apply(s, declare("home-5", "handoff"), ...TO_BALL, roll(3), { type: "HAND_OFF", targetId: "home-4" }, roll(1));
      expect(s.log).toContainEqual({ type: "SkillUsed", playerId: "home-4", skill: "Catch" });
      s = apply(s, roll(3));
      expect(s.ball).toEqual({ square: { x: 5, y: 3 }, carried: true });
    });

    it("Pass offers a skill re-roll of an inaccurate pass instead of a team re-roll", () => {
      let s = apply(withSkills(toFirstTurn(), { "home-5": ["Pass", "Loner(4)"] }), declare("home-5", "pass"), ...TO_BALL, roll(3));
      s = apply(s, { type: "THROW", square: { x: 10, y: 4 } }, roll(3));
      expect(find(s, "USE_REROLL")).toMatchObject({ skill: "Pass" });
      // No Loner roll: the team re-roll is not used.
      s = apply(s, { type: "USE_REROLL" });
      expect(s.teams.home.rerolls).toBe(1);
      expect(find(s, "ROLL")?.reason).toMatch(/^Pass 5\+/);
      s = apply(s, roll(5));
      expect(s.log).toContainEqual({ type: "PassResult", playerId: "home-5", result: "accurate" });
    });

    describe("Disturbing Presence", () => {
      /** away-11 with Disturbing Presence at (6,4), prone: within 3 squares of the ball at (4,2). */
      const disturbing = (s = toFirstTurn()) =>
        edit(withSkills(place(s, { "away-11": { x: 6, y: 4 } }), { "away-11": ["Disturbing Presence"] }), (c) => void (c.players["away-11"]!.status = "prone"));

      it("-1 to passes of opponents within 3 squares, even when prone", () => {
        const s = apply(disturbing(), declare("home-5", "pass"), ...TO_BALL, roll(3));
        expect(find(s, "THROW")?.squares).toContainEqual({ x: 10, y: 4, range: "short", needed: 6 });
        expect(find(apply(s, { type: "THROW", square: { x: 10, y: 4 } }), "ROLL")?.reason).toBe("Pass 6+ (short)");
      });

      it("-1 to catches", () => {
        const s = apply(place(disturbing(), { "home-4": { x: 5, y: 3 } }), declare("home-5", "handoff"), ...TO_BALL, roll(3), { type: "HAND_OFF", targetId: "home-4" });
        expect(find(s, "ROLL")?.reason).toBe("Catch 4+ (Home 4)");
      });

      it("-1 to interceptions, and only counts opponents", () => {
        const s = withSkills(toFirstTurn(), { "home-2": ["Disturbing Presence"], "away-3": ["Disturbing Presence"] });
        const interceptor = { ...s.players["away-2"]!, at: { x: 13, y: 7 } };
        expect(interceptionTarget(s, interceptor, "accurate")).toBe(10);
        expect(interceptionTarget(toFirstTurn(), interceptor, "accurate")).toBe(9);
      });
    });

    describe("Secret Weapon", () => {
      /** home-1 and home-2 have Secret Weapon, home-3 too but stays in the reserves; home-6 then scores. No bribes. */
      const score = (change: (c: GameState) => void = () => {}) => {
        let s = withSkills(toFirstTurn(), { "home-1": ["Secret Weapon"], "home-2": ["Secret Weapon"], "home-3": ["Secret Weapon"] });
        s = edit(place(s, { "home-6": { x: 24, y: 3 } }), (c) => {
          c.ball = { square: { x: 24, y: 3 }, carried: true };
          Object.assign(c.players["home-3"]!, { at: "reserves", played: false });
          c.teams.home.bribes = 0;
          change(c);
        });
        return apply(s, startMove("home-6"), ...move({ x: 25, y: 3 }));
      };

      it("sends off the players who played in the drive when it ends; the coach may argue the call", () => {
        let s = score();
        expect(s.log.filter((e) => e.type === "SecretWeaponSpotted").map((e) => e.type === "SecretWeaponSpotted" && e.playerId)).toEqual(["home-1", "home-2"]);
        expect(find(s, "ARGUE_THE_CALL")).toEqual({ type: "ARGUE_THE_CALL", side: "home", playerId: "home-1" });
        s = apply(s, { type: "ARGUE_THE_CALL", argue: false });
        expect(s.players["home-1"]!.at).toBe("banned");
        s = apply(s, { type: "ARGUE_THE_CALL", argue: true });
        expect(find(s, "ROLL")?.reason).toBe("Argue the call 6+ (Home 2)");
        s = apply(s, roll(6));
        expect(s.players["home-2"]!.at).toBe("reserves");
        expect(s.players["home-3"]!.at).toBe("reserves");
        expect(top(s)).toEqual({ type: "Setup", side: "home" });
      });

      it("a banned coach cannot argue, but bribes still work", () => {
        let s = score((c) => (c.teams.home.bribes = 2));
        s = apply(s, { type: "ARGUE_THE_CALL", argue: true }, roll(1));
        expect(s.teams.home.coachBanned).toBe(true);
        s = apply(s, { type: "BRIBE", use: true }, roll(2));
        expect(s.players["home-1"]!.at).not.toBe("banned");
        expect(find(s, "BRIBE")).toEqual({ type: "BRIBE", side: "home", playerId: "home-2", bribes: 1 });
        s = apply(s, { type: "BRIBE", use: false });
        expect(s.players["home-2"]!.at).toBe("banned");
      });

      it("a casualty is not sent off, a knocked-out player is", () => {
        const s = score((c) => {
          Object.assign(c.players["home-1"]!, { at: "cas", casualty: { result: "badly-hurt" } });
          c.players["home-2"]!.at = "ko";
        });
        expect(find(s, "ARGUE_THE_CALL")?.playerId).toBe("home-2");
      });
    });

    describe("Bone Head and Really Stupid", () => {
      it("Bone Head: a 1 loses the declared action and distracts the player, without a turnover", () => {
        let s = apply(withSkills(toFirstTurn(), { "home-1": ["Bone Head"] }), declare("home-1", "blitz", "away-1"));
        expect(find(s, "ROLL")?.reason).toBe("Bone Head 2+ (Home 1)");
        expect(tackleZones(s, "away", { x: 13, y: 6 })).toBe(2);
        s = apply(s, roll(1));
        expect(types(s)).toEqual(["USE_REROLL", "DECLINE_REROLL"]);
        s = apply(s, { type: "DECLINE_REROLL" });
        expect(s.log).toContainEqual({ type: "PlayerDistracted", playerId: "home-1", skill: "Bone Head" });
        expect(s.players["home-1"]).toMatchObject({ at: { x: 12, y: 6 }, activated: true, distracted: true });
        expect([s.activeSide, s.activePlayerId]).toEqual(["home", null]);
        // No tackle zone while distracted, and the Blitz is used up for the turn.
        expect(tackleZones(s, "away", { x: 13, y: 6 })).toBe(1);
        expect(actionsOf(s, "home-4")).not.toContain("blitz");
        // The next activation clears it before rolling again.
        s = apply(s, { type: "END_TURN" }, { type: "END_TURN" }, startMove("home-1"));
        expect(s.players["home-1"]!.distracted).toBe(false);
        expect(find(s, "ROLL")?.reason).toBe("Bone Head 2+ (Home 1)");
      });

      it("a distracted player cannot assist a block, even with Guard", () => {
        // home-6 at (14,6) is next to away-2; with Guard its assist gives a second die.
        const s = withSkills(place(toFirstTurn(), { "home-6": { x: 14, y: 6 } }), { "home-6": ["Guard"] });
        const dice = (state: GameState) => find(apply(state, declare("home-2", "block")), "BLOCK")?.targets.find((t) => t.playerId === "away-2")?.dice;
        expect(dice(s)).toBe(2);
        expect(dice(edit(s, (c) => void (c.players["home-6"]!.distracted = true)))).toBe(1);
      });

      it("Really Stupid: 4+ alone, 2+ next to a standing team-mate without Really Stupid", () => {
        const s = withSkills(toFirstTurn(), { "home-4": ["Really Stupid"], "home-1": ["Really Stupid"] });
        expect(find(apply(s, startMove("home-4")), "ROLL")?.reason).toBe("Really Stupid 4+ (Home 4)");
        expect(find(apply(s, startMove("home-1")), "ROLL")?.reason).toBe("Really Stupid 2+ (Home 1)");
        const both = withSkills(s, { "home-2": ["Really Stupid"] });
        expect(find(apply(both, startMove("home-1")), "ROLL")?.reason).toBe("Really Stupid 4+ (Home 1)");
        expect(apply(s, startMove("home-4"), roll(4)).players["home-4"]!.distracted).toBe(false);
      });
    });

    describe("Unchannelled Fury", () => {
      const fury = (s = toFirstTurn()) => withSkills(s, { "home-2": ["Unchannelled Fury"] });

      it("rolls after the declaration: 2+ for a Block or Blitz, 4+ otherwise", () => {
        expect(find(apply(fury(), declare("home-2", "block")), "ROLL")?.reason).toBe("Unchannelled Fury 2+ (Home 2)");
        expect(find(apply(fury(), declare("home-2", "blitz", "away-2")), "ROLL")?.reason).toBe("Unchannelled Fury 2+ (Home 2)");
        expect(find(apply(fury(), startMove("home-2")), "ROLL")?.reason).toBe("Unchannelled Fury 4+ (Home 2)");
        expect(find(apply(fury(), startMove("home-2"), roll(4)), "MOVE")).toBeDefined();
      });

      it("a failure loses the action without a turnover; the player keeps their tackle zone", () => {
        let s = apply(fury(), declare("home-2", "blitz", "away-2"), roll(1));
        expect(types(s)).toEqual(["USE_REROLL", "DECLINE_REROLL"]);
        s = apply(s, { type: "DECLINE_REROLL" });
        expect(s.log).toContainEqual({ type: "ActionLost", playerId: "home-2", skill: "Unchannelled Fury" });
        expect(s.players["home-2"]).toMatchObject({ at: { x: 12, y: 7 }, activated: true, distracted: false });
        expect([s.activeSide, s.activePlayerId]).toEqual(["home", null]);
        expect(tackleZones(s, "away", { x: 13, y: 7 })).toBe(3);
        expect(actionsOf(s, "home-4")).not.toContain("blitz");
      });

      it("a prone player who fails stays prone", () => {
        const prone = edit(fury(), (c) => void (c.players["home-2"]!.status = "prone"));
        const s = apply(prone, startMove("home-2"), roll(3), { type: "DECLINE_REROLL" });
        expect(s.players["home-2"]).toMatchObject({ status: "prone", activated: true });
      });
    });

    describe("Bloodlust", () => {
      /** home-2 has Bloodlust(X); home-1, next to them, is a Thrall. */
      const vampire = (skill = "Bloodlust(2)", s = toFirstTurn()) =>
        edit(withSkills(s, { "home-2": [skill] }), (c) => void (c.players["home-1"]!.keywords = ["thrall"]));
      const thirsty = (s: GameState, action: PlayerActionType = "move") => apply(s, declare("home-2", action, action === "blitz" ? "away-2" : undefined), roll(1), { type: "DECLINE_REROLL" });

      it("rolls X+ after the declaration, 1 easier for a Block or Blitz (at least 2+)", () => {
        expect(find(apply(vampire("Bloodlust(3)"), startMove("home-2")), "ROLL")?.reason).toBe("Bloodlust 3+ (Home 2)");
        expect(find(apply(vampire("Bloodlust(3)"), declare("home-2", "block")), "ROLL")?.reason).toBe("Bloodlust 2+ (Home 2)");
        expect(find(apply(vampire("Bloodlust(2)"), declare("home-2", "block")), "ROLL")?.reason).toBe("Bloodlust 2+ (Home 2)");
      });

      it("a failure keeps the action, then the player bites an adjacent Thrall at the end: injury, no turnover", () => {
        let s = thirsty(vampire());
        expect(s.log).toContainEqual({ type: "PlayerThirsty", playerId: "home-2" });
        s = apply(s, { type: "END_PLAYER_ACTION" });
        expect(find(s, "SELECT_PLAYERS")).toMatchObject({ side: "home", playerIds: ["home-1"], max: 1 });
        s = apply(s, { type: "SELECT_PLAYERS", playerIds: ["home-1"] });
        expect(find(s, "ROLL")?.reason).toBe("Injury (Home 1, bitten)");
        s = apply(s, roll(2, 3));
        expect(s.players["home-1"]!.status).toBe("stunned");
        expect([s.activeSide, s.activePlayerId, top(s).type]).toEqual(["home", null, "Turn"]);
      });

      it("a bitten Thrall's casualty is only Badly Hurt", () => {
        const s = apply(thirsty(vampire()), { type: "END_PLAYER_ACTION" }, { type: "SELECT_PLAYERS", playerIds: ["home-1"] }, roll(6, 6));
        expect(s.players["home-1"]).toMatchObject({ at: "cas", casualty: { result: "badly-hurt" } });
      });

      it("biting nobody is a turnover, and the player loses their tackle zone", () => {
        const s = apply(thirsty(vampire()), { type: "END_PLAYER_ACTION" }, { type: "SELECT_PLAYERS", playerIds: [] });
        expect(s.log).toContainEqual({ type: "FeedingFailed", playerId: "home-2" });
        expect(s.players["home-2"]!.distracted).toBe(true);
        expect(s.activeSide).toBe("away");
        const noThrall = apply(thirsty(withSkills(toFirstTurn(), { "home-2": ["Bloodlust(2)"] })), { type: "END_PLAYER_ACTION" });
        expect(noThrall.activeSide).toBe("away");
      });

      it("a declared Block may become a Move action", () => {
        let s = thirsty(vampire(), "block");
        expect(types(s)).toEqual(["MOVE_INSTEAD"]);
        expect(find(apply(s, { type: "MOVE_INSTEAD", move: false }), "BLOCK")).toBeDefined();
        s = apply(s, { type: "MOVE_INSTEAD", move: true });
        expect(find(s, "BLOCK")).toBeUndefined();
        expect(find(s, "MOVE")).toBeDefined();
      });

      it("feeds before passing", () => {
        let s = edit(vampire(), (c) => (c.ball = { square: { x: 12, y: 7 }, carried: true }));
        s = apply(thirsty(s, "pass"), { type: "THROW", square: { x: 10, y: 4 } });
        expect(find(s, "SELECT_PLAYERS")?.playerIds).toEqual(["home-1"]);
        s = apply(s, { type: "SELECT_PLAYERS", playerIds: ["home-1"] }, roll(2, 3));
        expect(find(s, "ROLL")?.reason).toMatch(/^Pass/);
      });

      it("scores only after feeding", () => {
        let s = vampire("Bloodlust(2)", place(toFirstTurn(), { "home-2": { x: 24, y: 3 }, "home-1": { x: 25, y: 4 } }));
        s = edit(s, (c) => (c.ball = { square: { x: 24, y: 3 }, carried: true }));
        s = apply(thirsty(s), ...move({ x: 25, y: 3 }));
        expect(s.teams.home.score).toBe(0);
        s = apply(s, { type: "SELECT_PLAYERS", playerIds: ["home-1"] }, roll(2, 3));
        expect(s.teams.home.score).toBe(1);
      });
    });

    it("Defensive: in the opponent's turn, players it marks cannot use Guard", () => {
      // home-6 at (14,6), next to away-2 and marked by away-1 and away-6: only Guard lets it assist.
      const s = withSkills(place(toFirstTurn(), { "home-6": { x: 14, y: 6 } }), { "home-6": ["Guard"] });
      const dice = (state: GameState) => find(apply(state, declare("home-2", "block")), "BLOCK")?.targets.find((t) => t.playerId === "away-2")?.dice;
      expect(dice(s)).toBe(2);
      expect(dice(withSkills(s, { "away-1": ["Defensive"] }))).toBe(1);
      // The defender's own Defensive counts too, but a team-mate of the guard does not.
      expect(dice(withSkills(s, { "away-2": ["Defensive"] }))).toBe(1);
      expect(dice(withSkills(s, { "home-2": ["Defensive"] }))).toBe(2);
    });

    describe("Brawler", () => {
      const brawler = (s = toFirstTurn()) => withSkills(s, { "home-2": ["Brawler"] });

      it("re-rolls a single Both Down die instead of the team re-roll, once per activation", () => {
        let s = apply(blockAway2(brawler()), roll(2));
        expect(find(s, "USE_SKILL")).toEqual({ type: "USE_SKILL", side: "home", playerId: "home-2", skill: "Brawler" });
        s = apply(s, { type: "USE_SKILL", use: true });
        expect(find(s, "ROLL")?.reason).toBe("Brawler (re-roll a Both Down)");
        s = apply(s, roll(3));
        expect(s.log).toContainEqual({ type: "BlockResult", attackerId: "home-2", defenderId: "away-2", face: 3 });
        expect(s.teams.home.rerolls).toBe(1);
        expect(s.players["home-2"]!.usedSkills).toContain("Brawler");
      });

      it("only on a Both Down, and not during a Blitz", () => {
        expect(find(apply(blockAway2(brawler()), roll(3)), "USE_SKILL")).toBeUndefined();
        const blitz = apply(brawler(), declare("home-2", "blitz", "away-2"), { type: "BLOCK", targetId: "away-2" }, roll(2));
        expect(find(blitz, "USE_SKILL")).toBeUndefined();
      });

      it("is offered before the defender chooses from several dice", () => {
        const strong = brawler(toFirstTurn(team("Home"), team("Away", { st: 4 })));
        const s = apply(blockAway2(strong), roll(2, 6));
        expect(types(s)).toEqual(["USE_REROLL", "USE_SKILL", "DECLINE_REROLL"]);
        expect(apply(s, { type: "USE_SKILL", use: true }, roll(1)).stack.at(-1)).toMatchObject({ results: [1, 6] });
      });
    });

    describe("Hatred", () => {
      const hater = (keywords: string[]) =>
        edit(withSkills(toFirstTurn(), { "home-2": ["Hatred(troll)"] }), (c) => void (c.players["away-2"]!.keywords = keywords));

      it("re-rolls a single Skull against a hated player, also during a Blitz", () => {
        let s = apply(blockAway2(hater(["troll", "big guy"])), roll(1));
        expect(find(s, "USE_SKILL")).toEqual({ type: "USE_SKILL", side: "home", playerId: "home-2", skill: "Hatred" });
        s = apply(s, { type: "USE_SKILL", use: true });
        expect(find(s, "ROLL")?.reason).toBe("Hatred (re-roll a Skull)");
        s = apply(s, roll(6));
        expect(s.log).toContainEqual({ type: "BlockResult", attackerId: "home-2", defenderId: "away-2", face: 6 });
        expect(s.teams.home.rerolls).toBe(1);
        const blitz = apply(hater(["troll"]), declare("home-2", "blitz", "away-2"), { type: "BLOCK", targetId: "away-2" }, roll(1));
        expect(find(blitz, "USE_SKILL")?.skill).toBe("Hatred");
      });

      it("is offered next to Brawler when both a Skull and a Both Down are rolled", () => {
        const strong = edit(toFirstTurn(team("Home", { st: 4 }), team("Away")), (c) => {
          c.players["home-2"]!.skills = ["Hatred(troll)", "Brawler"];
          c.players["away-2"]!.keywords = ["troll"];
        });
        const s = apply(blockAway2(strong), roll(1, 2));
        expect(getAvailableActions(s).flatMap((t) => (t.type === "USE_SKILL" ? [t.skill] : []))).toEqual(["Brawler", "Hatred"]);
        const hated = apply(s, { type: "USE_SKILL", use: true, skill: "Hatred" }, roll(6));
        expect(find(hated, "CHOOSE_BLOCK_DIE")?.results).toEqual([6, 2]);
      });

      it("not against other players, nor on other faces", () => {
        expect(find(apply(blockAway2(hater(["lineman"])), roll(1)), "USE_SKILL")).toBeUndefined();
        expect(find(apply(blockAway2(hater(["troll"])), roll(2)), "USE_SKILL")).toBeUndefined();
      });
    });

    it("Nerves of Steel: tackle zones do not count for the player's passes, catches and interceptions", () => {
      // home-2 at (12,7) is marked by three opponents.
      const carrier = (skills: string[]) =>
        edit(withSkills(toFirstTurn(), { "home-2": skills }), (c) => (c.ball = { square: { x: 12, y: 7 }, carried: true }));
      const needed = (s: GameState) => find(apply(s, declare("home-2", "pass")), "THROW")?.squares.find((q) => q.x === 10 && q.y === 4)?.needed;
      expect(needed(carrier([]))).toBe(6);
      expect(needed(carrier(["Nerves of Steel"]))).toBe(5);
      // home-1 hands off to home-2.
      const handOff = (skills: string[]) =>
        find(apply(edit(withSkills(toFirstTurn(), { "home-2": skills }), (c) => (c.ball = { square: { x: 12, y: 6 }, carried: true })), declare("home-1", "handoff"), { type: "HAND_OFF", targetId: "home-2" }), "ROLL")?.reason;
      expect(handOff([])).toBe("Catch 6+ (Home 2)");
      expect(handOff(["Nerves of Steel"])).toBe("Catch 3+ (Home 2)");
      const interceptor = { ...toFirstTurn().players["away-2"]!, at: { x: 13, y: 7 }, skills: ["Nerves of Steel"] };
      expect(interceptionTarget(toFirstTurn(), interceptor, "accurate")).toBe(6);
    });

    describe("Steady Footing", () => {
      const steady = (s = toFirstTurn()) => withSkills(s, { "home-2": ["Steady Footing"] });

      it("a 6 avoids being knocked down: no turnover, the action goes on", () => {
        let s = apply(blockAway2(steady()), roll(1), pick);
        expect(find(s, "USE_SKILL")).toEqual({ type: "USE_SKILL", side: "home", playerId: "home-2", skill: "Steady Footing" });
        s = apply(s, { type: "USE_SKILL", use: true });
        expect(find(s, "ROLL")?.reason).toBe("Steady Footing 6+ (Home 2)");
        s = apply(s, roll(6));
        expect(s.players["home-2"]!.status).toBe("standing");
        expect([s.activeSide, top(s).type]).toEqual(["home", "Turn"]);
      });

      it("otherwise (or when declined) the player falls as usual", () => {
        const failed = apply(blockAway2(steady()), roll(1), pick, { type: "USE_SKILL", use: true }, roll(5), { type: "DECLINE_REROLL" });
        expect(find(failed, "ROLL")?.reason).toMatch(/^Armour/);
        const declined = apply(blockAway2(steady()), roll(1), pick, { type: "USE_SKILL", use: false });
        expect(declined.players["home-2"]!.status).toBe("prone");
      });

      it("after a failed dodge, the player stands in the square they moved to and may go on", () => {
        let s = withSkills(toFirstTurn(), { "home-1": ["Steady Footing"] });
        s = apply(s, startMove("home-1"), ...move({ x: 11, y: 5 }), roll(1), { type: "DECLINE_REROLL" }, { type: "USE_SKILL", use: true }, roll(6));
        expect(s.players["home-1"]).toMatchObject({ at: { x: 11, y: 5 }, status: "standing" });
        expect(find(s, "MOVE")).toBeDefined();
      });

      it("works for the defender, who stays up in the square they were pushed to", () => {
        const s = apply(blockAway2(withSkills(toFirstTurn(), { "away-2": ["Steady Footing"] })), roll(6), pick, { type: "PUSH", square: { x: 14, y: 7 } }, { type: "FOLLOW_UP", follow: false });
        expect(find(s, "USE_SKILL")).toMatchObject({ side: "away", playerId: "away-2" });
        expect(apply(s, { type: "USE_SKILL", use: true }, roll(6)).players["away-2"]).toMatchObject({ at: { x: 14, y: 7 }, status: "standing" });
      });
    });

    it("Timmm-ber!: +1 to stand up per adjacent team-mate not marked by an opponent", () => {
      // home-2 lies at (11,8), next to home-3 (12,8, marked by away-2 and away-3) and home-8 (10,8).
      const s = edit(withSkills(toFirstTurn(), { "home-2": ["Timmm-ber!"] }), (c) => {
        Object.assign(c.players["home-2"]!, { ma: 2, status: "prone", at: { x: 11, y: 8 } });
      });
      expect(find(apply(s, startMove("home-2")), "ROLL")?.reason).toBe("Stand up 3+ (Home 2)");
      const standUp = apply(place(s, { "away-2": { x: 20, y: 7 }, "away-3": { x: 20, y: 8 } }), startMove("home-2"));
      expect(find(standUp, "ROLL")?.reason).toBe("Stand up 2+ (Home 2)");
      expect(apply(standUp, roll(1), { type: "DECLINE_REROLL" }).players["home-2"]!.status).toBe("prone");
      expect(apply(standUp, roll(2)).players["home-2"]!.status).toBe("standing");
    });

    describe("On the Ball", () => {
      const select = (...playerIds: string[]): Action => ({ type: "SELECT_PLAYERS", playerIds });

      it("after the kick-off deviation, one unmarked receiving player moves up to 3 squares in their own half", () => {
        const kicked = withSkills(toKick({ x: 5, y: 1 }), { "home-1": ["On the Ball"], "home-4": ["On the Ball"], "home-6": ["On the Ball"] });
        let s = apply(kicked, roll(7, 1));
        // home-1 (12,6) is marked by the line of scrimmage.
        expect(find(s, "SELECT_PLAYERS")).toMatchObject({ side: "home", playerIds: ["home-4", "home-6"], max: 1 });
        s = apply(s, select("home-4"), ...move({ x: 11, y: 4 }, { x: 12, y: 4 }));
        expect(find(s, "MOVE")?.squares.some((q) => q.x === 13)).toBe(false);
        s = apply(s, ...move({ x: 12, y: 3 }));
        expect(s.players["home-4"]!.at).toEqual({ x: 12, y: 3 });
        // Only one player, then the kick-off event.
        expect(find(s, "ROLL")?.reason).toBe("Kick-off event");
      });

      it("at the kick-off, the receiving team may use a team re-roll", () => {
        let s = apply(withSkills(toKick({ x: 5, y: 1 }), { "home-4": ["On the Ball"] }), roll(7, 1), select("home-4"));
        // (12,5) is next to away-1 (13,6): leaving it takes a dodge.
        s = apply(s, ...move({ x: 11, y: 5 }, { x: 12, y: 5 }, { x: 12, y: 4 }), roll(1));
        expect(types(s)).toEqual(["USE_REROLL", "DECLINE_REROLL"]);
        s = apply(s, { type: "USE_REROLL" }, roll(6));
        expect([s.players["home-4"]!.at, s.teams.home.rerolls]).toEqual([{ x: 12, y: 4 }, 0]);
      });

      it("when the opponent passes, each player with the skill may move 3 squares, dodging but never rushing", () => {
        const passing = edit(withSkills(toFirstTurn(), { "away-1": ["On the Ball"] }), (c) => {
          c.ball = { square: { x: 10, y: 4 }, carried: true };
          c.players["away-1"]!.ma = 2;
        });
        let s = apply(passing, declare("home-4", "pass"), { type: "THROW", square: { x: 6, y: 4 } });
        expect(find(s, "SELECT_PLAYERS")).toMatchObject({ side: "away", playerIds: ["away-1"] });
        s = apply(s, select("away-1"), ...move({ x: 12, y: 5 }));
        expect(find(s, "ROLL")?.reason).toBe("Dodge 4+ (Away 1)");
        s = apply(s, roll(6), ...move({ x: 11, y: 5 }), roll(6), ...move({ x: 11, y: 4 }), roll(6));
        expect(s.players["away-1"]!.at).toEqual({ x: 11, y: 4 });
        // Now marking the thrower: the pass is harder.
        expect(find(s, "ROLL")?.reason).toBe("Pass 6+ (short)");
      });

      it("skill re-rolls work (Dodge), team re-rolls do not", () => {
        const passing = edit(withSkills(toFirstTurn(), { "away-1": ["On the Ball", "Dodge"] }), (c) => (c.ball = { square: { x: 10, y: 4 }, carried: true }));
        let s = apply(passing, declare("home-4", "pass"), { type: "THROW", square: { x: 6, y: 4 } }, select("away-1"), ...move({ x: 12, y: 5 }), roll(1));
        expect(s.log).toContainEqual({ type: "SkillUsed", playerId: "away-1", skill: "Dodge" });
        s = apply(s, roll(1));
        expect(types(s)).not.toContain("USE_REROLL");
        expect(s.players["away-1"]!.status).toBe("prone");
      });

      it("a fall ends the moves, without a turnover", () => {
        const passing = edit(withSkills(toFirstTurn(), { "away-1": ["On the Ball"] }), (c) => (c.ball = { square: { x: 10, y: 4 }, carried: true }));
        let s = apply(passing, declare("home-4", "pass"), { type: "THROW", square: { x: 6, y: 4 } }, select("away-1"), ...move({ x: 12, y: 5 }), roll(1));
        s = apply(s, roll(1, 1));
        expect([s.players["away-1"]!.status, s.turnover]).toEqual(["prone", false]);
        expect(find(s, "ROLL")?.reason).toBe("Pass 5+ (short)");
      });
    });

    describe("Safe Pass", () => {
      // home-4 at (10,4) holds the ball and throws it to (6,4).
      const thrower = (skills: string[]) =>
        edit(withSkills(toFirstTurn(), { "home-4": skills }), (c) => (c.ball = { square: { x: 10, y: 4 }, carried: true }));
      const fumble = (s: GameState, natural: number) => apply(s, declare("home-4", "pass"), { type: "THROW", square: { x: 6, y: 4 } }, roll(natural), { type: "DECLINE_REROLL" });

      it("on a natural 1, the thrower may keep the ball: the action ends, without a turnover", () => {
        let s = fumble(thrower(["Safe Pass"]), 1);
        expect(find(s, "USE_SKILL")).toEqual({ type: "USE_SKILL", side: "home", playerId: "home-4", skill: "Safe Pass" });
        s = apply(s, { type: "USE_SKILL", use: true });
        expect(s.ball).toEqual({ square: { x: 10, y: 4 }, carried: true });
        expect([s.turnover, s.activePlayerId, top(s).type]).toEqual([false, null, "Turn"]);
      });

      it("declined, or on a modified fumble, the ball is dropped as usual", () => {
        const declined = apply(fumble(thrower(["Safe Pass"]), 1), { type: "USE_SKILL", use: false });
        expect([declined.turnover, declined.ball.carried]).toEqual([true, false]);
        // Three tackle zones on the thrower: a 2 is a fumble too, but not a natural 1.
        const marked = place(thrower(["Safe Pass"]), { "away-1": { x: 11, y: 4 }, "away-2": { x: 11, y: 5 }, "away-3": { x: 11, y: 3 } });
        expect(types(fumble(marked, 2))).not.toContain("USE_SKILL");
      });
    });

    describe("Diving Tackle", () => {
      const select = (...playerIds: string[]): Action => ({ type: "SELECT_PLAYERS", playerIds });
      // home-1 dodges from (12,6), next to away-1, to (11,5): a 3+ dodge.
      const dodge = (value: number) => apply(withSkills(toFirstTurn(), { "away-1": ["Diving Tackle"] }), startMove("home-1"), ...move({ x: 11, y: 5 }), roll(value));

      it("turns a dodge that -2 would fail into a failure; the tackler is placed prone in the square left", () => {
        let s = dodge(4);
        expect(find(s, "SELECT_PLAYERS")).toMatchObject({ side: "away", playerIds: ["away-1"], max: 1 });
        s = apply(s, select("away-1"));
        expect(s.log).toContainEqual({ type: "SkillUsed", playerId: "away-1", skill: "Diving Tackle" });
        s = apply(s, { type: "DECLINE_REROLL" });
        expect(s.players["home-1"]).toMatchObject({ at: { x: 11, y: 5 }, status: "prone" });
        expect(s.players["away-1"]).toMatchObject({ at: { x: 12, y: 6 }, status: "prone" });
        expect(s.turnover).toBe(true);
      });

      it("the re-roll keeps the -2; it is not offered when it would not help", () => {
        const s = apply(dodge(4), select("away-1"), { type: "USE_REROLL" });
        expect(find(s, "ROLL")?.reason).toBe("Dodge 5+ (Home 1)");
        const rerolled = apply(s, roll(5));
        expect(rerolled.players["home-1"]).toMatchObject({ at: { x: 11, y: 5 }, status: "standing" });
        expect(rerolled.players["away-1"]).toMatchObject({ at: { x: 12, y: 6 }, status: "prone" });
        expect(types(dodge(5))).not.toContain("SELECT_PLAYERS");
        expect(apply(dodge(4), select()).players["home-1"]).toMatchObject({ at: { x: 11, y: 5 }, status: "standing" });
      });
    });

    it("My Ball: the player cannot declare a Pass or Hand-off action", () => {
      const s = edit(toFirstTurn(), (c) => (c.ball = { square: { x: 10, y: 4 }, carried: true }));
      expect(actionsOf(s, "home-4")).toEqual(expect.arrayContaining(["pass", "handoff"]));
      expect(actionsOf(withSkills(s, { "home-4": ["My Ball"] }), "home-4")).not.toContain("pass");
      expect(actionsOf(withSkills(s, { "home-4": ["My Ball"] }), "home-4")).not.toContain("handoff");
    });

    it("Leap: jumps over any square; the tackle zone penalty is reduced by 1, not below -1", () => {
      // home-2 at (12,7) is marked by three opponents: a jump to (10,7) over home's empty (11,7).
      const s = withSkills(toFirstTurn(), { "home-2": ["Leap"] });
      const jump = find(apply(s, startMove("home-2")), "MOVE")!.squares.find((q) => q.x === 10 && q.y === 7);
      expect(jump?.rolls).toEqual(["jump"]);
      expect(find(apply(s, startMove("home-2"), ...move({ x: 10, y: 7 })), "ROLL")?.reason).toBe("Jump 5+ (Home 2)");
      // One tackle zone stays -1.
      const one = place(s, { "away-1": { x: 20, y: 1 }, "away-3": { x: 20, y: 3 } });
      expect(find(apply(one, startMove("home-2"), ...move({ x: 10, y: 7 })), "ROLL")?.reason).toBe("Jump 4+ (Home 2)");
    });

    it("Pogo: jumps over any square, ignoring tackle zones, Prehensile Tail and Diving Tackle", () => {
      // home-2 at (12,7) is marked by three opponents; (10,7) is empty, two squares away over (11,7).
      const s = withSkills(toFirstTurn(), { "home-2": ["Pogo"], "away-2": ["Prehensile Tail", "Diving Tackle"] });
      const jumps = find(apply(s, startMove("home-2")), "MOVE")!.squares.filter((q) => q.rolls.includes("jump"));
      expect(jumps.some((q) => q.x === 10 && q.y === 7)).toBe(true);
      expect(find(apply(withSkills(s, { "home-2": [] }), startMove("home-2")), "MOVE")!.squares.some((q) => q.rolls.includes("jump"))).toBe(false);
      let jumped = apply(s, startMove("home-2"), ...move({ x: 10, y: 7 }));
      expect(find(jumped, "ROLL")?.reason).toBe("Jump 3+ (Home 2)");
      jumped = apply(jumped, roll(3));
      expect(types(jumped)).not.toContain("SELECT_PLAYERS");
      expect(jumped.players["home-2"]).toMatchObject({ at: { x: 10, y: 7 }, status: "standing" });
    });

    it("Eye Gouge: an opponent pushed back cannot assist blocks until their next activation", () => {
      let s = apply(blockAway2(withSkills(toFirstTurn(), { "home-2": ["Eye Gouge"] })), roll(3), pick, { type: "PUSH", square: { x: 14, y: 7 } }, { type: "FOLLOW_UP", follow: false });
      expect(s.players["away-2"]!.gouged).toBe(true);
      // Away from everyone else: away-2 next to home-1 would give away-1 a defensive assist.
      const corner = place(s, { "home-1": { x: 3, y: 3 }, "away-1": { x: 4, y: 3 }, "away-2": { x: 3, y: 4 } });
      const dice = (c: GameState) => blockDice(c, c.players["home-1"]!, c.players["away-1"]!);
      expect(dice(corner)).toBe(1);
      expect(dice(edit(corner, (c) => void (c.players["away-2"]!.gouged = false)))).toBe(-2);
      s = apply(s, { type: "END_TURN" }, declare("away-2", "move"));
      expect(s.players["away-2"]!.gouged).toBe(false);
    });

    it("Pick-me-up: at the end of the opponent's turn, prone players near a team-mate with the skill stand up on 5+", () => {
      const s = edit(withSkills(toFirstTurn(), { "away-5": ["Pick-me-up"] }), (c) => {
        c.players["away-1"]!.status = "prone";
        c.players["away-3"]!.status = "prone";
        c.players["away-4"]!.status = "stunned";
      });
      // away-5 at (15,7) is within 3 squares of away-1 (13,6) and away-3 (13,8); stunned players do not count.
      const near = place(s, { "away-5": { x: 15, y: 7 } });
      let ended = apply(near, { type: "END_TURN" });
      expect(find(ended, "SELECT_PLAYERS")).toMatchObject({ side: "away", playerIds: ["away-1", "away-3"], max: 2 });
      ended = apply(ended, { type: "SELECT_PLAYERS", playerIds: ["away-1", "away-3"] });
      expect(find(ended, "ROLL")?.dice).toEqual([{ kind: "d6", count: 2 }]);
      ended = apply(ended, roll(5, 4));
      expect([ended.players["away-1"]!.status, ended.players["away-3"]!.status]).toEqual(["standing", "prone"]);
      expect(ended.log.at(-1)).toMatchObject({ type: "TurnStarted", side: "away" });
    });

    it("Fumblerooski: a moving ball carrier may leave the ball in the square they leave, without a bounce or a turnover", () => {
      const s0 = edit(withSkills(toFirstTurn(), { "home-4": ["Fumblerooski"] }), (c) => (c.ball = { square: { x: 10, y: 4 }, carried: true }));
      let s = apply(s0, startMove("home-4"));
      expect(find(s, "USE_SKILL")).toEqual({ type: "USE_SKILL", side: "home", playerId: "home-4", skill: "Fumblerooski" });
      s = apply(s, { type: "USE_SKILL", use: true, skill: "Fumblerooski" }, ...move({ x: 9, y: 4 }));
      expect(s.ball).toEqual({ square: { x: 10, y: 4 }, carried: false });
      expect(s.log).toContainEqual({ type: "SkillUsed", playerId: "home-4", skill: "Fumblerooski" });
      s = apply(s, { type: "END_PLAYER_ACTION" });
      expect([s.turnover, top(s).type]).toEqual([false, "Turn"]);
      // Not with My Ball.
      expect(find(apply(withSkills(s0, { "home-4": ["Fumblerooski", "My Ball"] }), startMove("home-4")), "USE_SKILL")).toBeUndefined();
    });

    describe("Diving Catch", () => {
      // home-4 at (10,4) holds the ball; home-6 at (10,6) has Diving Catch.
      const diver = edit(withSkills(toFirstTurn(), { "home-6": ["Diving Catch"] }), (c) => (c.ball = { square: { x: 10, y: 4 }, carried: true }));
      const pass = (square: Square) => apply(diver, declare("home-4", "pass"), { type: "THROW", square }, roll(6));

      it("+1 to catch an accurate pass to the player's square", () => {
        expect(find(pass({ x: 10, y: 6 }), "ROLL")?.reason).toBe("Catch 2+ (Home 6)");
      });

      it("may catch a pass coming down next to the player, from their own square", () => {
        let s = pass({ x: 9, y: 6 });
        expect(find(s, "SELECT_PLAYERS")).toMatchObject({ side: "home", playerIds: ["home-6"], max: 1 });
        s = apply(s, { type: "SELECT_PLAYERS", playerIds: ["home-6"] });
        expect(find(s, "ROLL")?.reason).toBe("Catch 2+ (Home 6)");
        s = apply(s, roll(2));
        expect(s.ball).toEqual({ square: { x: 10, y: 6 }, carried: true });
        expect(s.turnover).toBe(false);
        // Declined: the ball lands in the empty square and bounces.
        expect(find(apply(pass({ x: 9, y: 6 }), { type: "SELECT_PLAYERS", playerIds: [] }), "ROLL")?.reason).toBe("Bounce");
      });
    });

    describe("Safe Pair of Hands", () => {
      it("a ball carrier knocked down may place the ball on a free adjacent square instead of a bounce", () => {
        const s0 = edit(withSkills(toFirstTurn(), { "away-2": ["Safe Pair of Hands"] }), (c) => (c.ball = { square: { x: 13, y: 7 }, carried: true }));
        let s = apply(blockAway2(s0), roll(6), pick, { type: "PUSH", square: { x: 14, y: 7 } }, { type: "FOLLOW_UP", follow: false }, roll(1, 1));
        expect(find(s, "USE_SKILL")).toEqual({ type: "USE_SKILL", side: "away", playerId: "away-2", skill: "Safe Pair of Hands" });
        s = apply(s, { type: "USE_SKILL", use: true });
        expect(find(s, "PLACE_BALL")?.squares).toContainEqual({ x: 15, y: 7 });
        s = apply(s, { type: "PLACE_BALL", square: { x: 15, y: 7 } });
        expect(s.ball).toEqual({ square: { x: 15, y: 7 }, carried: false });
      });

      it("not when the player falls over (a failed dodge): the ball bounces", () => {
        const s0 = edit(withSkills(toFirstTurn(), { "home-1": ["Safe Pair of Hands"] }), (c) => (c.ball = { square: { x: 12, y: 6 }, carried: true }));
        const s = apply(s0, startMove("home-1"), ...move({ x: 11, y: 5 }), roll(1), { type: "DECLINE_REROLL" }, roll(1, 1));
        expect(find(s, "ROLL")?.reason).toBe("Bounce");
      });
    });

    it("Grab: in a Block action, the attacker may push the defender to any free adjacent square; Sidestep does not work", () => {
      const grab = withSkills(toFirstTurn(), { "home-2": ["Grab"], "away-2": ["Sidestep"] });
      let s = apply(blockAway2(grab), roll(3), pick);
      const push = find(s, "PUSH")!;
      expect(push.side).toBe("home");
      // Every square around away-2 at (13,7) but the usual three is taken: nothing more to choose from.
      expect(push.squares.map(({ x, y }) => [x, y])).toEqual([[14, 6], [14, 7], [14, 8]]);
      // With away-1 gone, (13,6) is free too (home-1 now assists: two dice).
      s = apply(place(grab, { "away-1": { x: 20, y: 1 } }), declare("home-2", "block"), { type: "BLOCK", targetId: "away-2" }, roll(3, 3), pick);
      expect(find(s, "PUSH")!.squares.some((q) => q.x === 13 && q.y === 6)).toBe(true);
      s = apply(s, { type: "PUSH", square: { x: 13, y: 6 } });
      expect(s.log).toContainEqual({ type: "SkillUsed", playerId: "home-2", skill: "Grab" });
      // Not during a Blitz: Sidestep works again.
      const blitz = apply(grab, declare("home-2", "blitz", "away-2"), { type: "BLOCK", targetId: "away-2" }, roll(3), pick);
      expect(find(blitz, "PUSH")!.side).toBe("away");
    });

    it("Arm Bar: +1 to the armour (or injury) roll of a player falling after a dodge out of the tackle zone", () => {
      // home-1 dodges from (12,6), next to away-1, to (11,5) and fails.
      const s = apply(withSkills(toFirstTurn(), { "away-1": ["Arm Bar"] }), startMove("home-1"), ...move({ x: 11, y: 5 }), roll(1), { type: "DECLINE_REROLL" });
      expect(find(s, "ROLL")?.reason).toBe("Armour 8+ (Home 1) (+1 Arm Bar)");
      expect(apply(s, roll(3, 4)).log).toContainEqual({ type: "SkillUsed", playerId: "away-1", skill: "Arm Bar" });
      // Not for a failed Rush.
      const rush = apply(withSkills(toFirstTurn(), { "away-1": ["Arm Bar"] }), startMove("home-11"), ...HOME_11_FULL_MOVE, ...HOME_11_RUSH, roll(1), { type: "DECLINE_REROLL" });
      expect(find(rush, "ROLL")?.reason).toBe("Armour 8+ (Home 11)");
    });

    it("Iron Hard Skin: no Claws, no Mighty Blow or Dirty Player on the armour roll, no foul assists", () => {
      const skin = (skills: string[]) =>
        edit(withSkills(toFirstTurn(), { "home-2": ["Claws", "Mighty Blow(+1)"], "away-2": skills }), (c) => void (c.players["away-2"]!.av = 9));
      const armour = (s: GameState) => apply(blockAway2(s), roll(6), pick, { type: "PUSH", square: { x: 14, y: 7 } }, { type: "FOLLOW_UP", follow: false }, roll(4, 4));
      expect(armour(skin([])).log).toContainEqual({ type: "SkillUsed", playerId: "home-2", skill: "Claws" });
      const held = armour(skin(["Iron Hard Skin"]));
      expect(held.log).toContainEqual({ type: "ArmourHeld", playerId: "away-2", roll: 8 });
      expect(held.log.filter((e) => e.type === "SkillUsed").map((e) => (e as { skill: string }).skill)).toEqual([]);
      // home-3 (12,8) and home-1 (12,6), unmarked once away-1 and away-3 are moved away, assist a foul on away-2.
      const prone = (skills: string[]) =>
        edit(place(toFirstTurn(), { "away-1": { x: 20, y: 1 }, "away-3": { x: 20, y: 3 } }), (c) => {
          c.players["away-2"]!.skills = skills;
          c.players["away-2"]!.status = "prone";
        });
      const assists = (s: GameState) => find(apply(s, declare("home-2", "foul")), "FOUL")?.targets.find((t) => t.playerId === "away-2")?.assists;
      expect(assists(prone([]))).toBe(2);
      expect(assists(prone(["Iron Hard Skin"]))).toBe(0);
    });

    it("Decay: +1 to the casualty roll", () => {
      const player = toFirstTurn().players["home-1"]!;
      expect(casualtyFor(player, 8, 1)).toEqual({ result: "badly-hurt" });
      expect(casualtyFor({ ...player, skills: ["Decay"] }, 8, 1)).toEqual({ result: "seriously-hurt" });
    });

    it("Cloud Burster: the thrower's passes cannot be intercepted", () => {
      const s = edit(toFirstTurn(), (c) => (c.ball = { square: { x: 12, y: 6 }, carried: true }));
      const under = (skills: string[]) => interceptors(withSkills(s, { "home-1": skills }), withSkills(s, { "home-1": skills }).players["home-1"]!, { x: 16, y: 6 });
      expect(under([]).map((p) => p.id)).toContain("away-1");
      expect(under(["Cloud Burster"])).toEqual([]);
    });

    it("Drunkard: -1 to Rush rolls", () => {
      const s = apply(withSkills(toFirstTurn(), { "home-11": ["Drunkard"] }), startMove("home-11"), ...HOME_11_FULL_MOVE, ...HOME_11_RUSH);
      expect(find(s, "ROLL")?.reason).toBe("Rush 3+ (Home 11)");
    });

    it("Sure Feet: once per turn, a failed Rush is re-rolled automatically", () => {
      let s = withSkills(toFirstTurn(), { "home-11": ["Sure Feet"] });
      s = apply(s, startMove("home-11"), ...HOME_11_FULL_MOVE, ...HOME_11_RUSH, roll(1));
      expect(s.log).toContainEqual({ type: "SkillUsed", playerId: "home-11", skill: "Sure Feet" });
      s = apply(s, roll(2), ...move({ x: 0, y: 14 }), roll(1));
      expect(types(s)).toEqual(["USE_REROLL", "DECLINE_REROLL"]);
    });

    describe("Pro", () => {
      // home-1 dodges from (12,6) to (11,5).
      const dodge = (value: number) => apply(withSkills(toFirstTurn(), { "home-1": ["Pro"] }), startMove("home-1"), ...move({ x: 11, y: 5 }), roll(value));

      it("once per turn, a D6 of 3+ re-rolls one of the player's own dice instead of a team re-roll", () => {
        let s = dodge(1);
        expect(types(s)).toEqual(["USE_REROLL", "USE_SKILL", "DECLINE_REROLL"]);
        s = apply(s, { type: "USE_SKILL", use: true });
        expect(find(s, "ROLL")?.reason).toBe("Pro 3+ (Home 1)");
        s = apply(s, roll(3), roll(6));
        expect(s.players["home-1"]).toMatchObject({ at: { x: 11, y: 5 }, status: "standing" });
        expect(s.teams.home.rerolls).toBe(1);
        // Back next to away-1 and out again: Pro is used up for this turn.
        s = apply(s, ...move({ x: 12, y: 5 }), ...move({ x: 11, y: 4 }), roll(1));
        expect(types(s)).toEqual(["USE_REROLL", "DECLINE_REROLL"]);
      });

      it("on block dice, the coach picks the die to re-roll, then rolls Pro", () => {
        const strong = withSkills(toFirstTurn(team("Home", { st: 4 })), { "home-2": ["Pro", "Brawler"] });
        let s = apply(blockAway2(strong), roll(1, 2));
        expect(types(s)).toEqual(["CHOOSE_BLOCK_DIE", "USE_REROLL", "USE_SKILL", "USE_SKILL"]);
        expect(getAvailableActions(s).filter((t) => t.type === "USE_SKILL").map((t) => (t as { skill: string }).skill)).toEqual(["Brawler", "Pro"]);
        s = apply(s, { type: "USE_SKILL", use: true, skill: "Pro" });
        expect(find(s, "REROLL_BLOCK_DIE")).toEqual({ type: "REROLL_BLOCK_DIE", side: "home", results: [1, 2], skill: "Pro" });
        s = apply(s, { type: "REROLL_BLOCK_DIE", index: 0 });
        expect(find(s, "ROLL")?.reason).toBe("Pro 3+ (Home 2)");
        s = apply(s, roll(3));
        expect(find(s, "ROLL")?.reason).toBe("Pro (re-roll a block die)");
        s = apply(s, roll(6));
        expect(find(s, "CHOOSE_BLOCK_DIE")?.results).toEqual([6, 2]);
        // That was the block's one re-roll, and no team re-roll was spent.
        expect(types(s)).toEqual(["CHOOSE_BLOCK_DIE"]);
        expect(s.teams.home.rerolls).toBe(1);
        // A failed Pro roll keeps the dice, unless a team re-roll (here with Loner) gets another Pro roll.
        const failed = apply(blockAway2(strong), roll(1, 2), { type: "USE_SKILL", use: true, skill: "Pro" }, { type: "REROLL_BLOCK_DIE", index: 1 }, roll(2));
        expect(find(apply(failed, { type: "DECLINE_REROLL" }), "CHOOSE_BLOCK_DIE")?.results).toEqual([1, 2]);
        const loner = edit(failed, (c) => c.players["home-2"]!.skills.push("Loner(4)"));
        const lonely = apply(loner, { type: "USE_REROLL" });
        expect(find(lonely, "ROLL")?.reason).toBe("Loner 4+ (Home 2)");
        expect(find(apply(lonely, roll(3)), "CHOOSE_BLOCK_DIE")?.results).toEqual([1, 2]);
        expect(find(apply(lonely, roll(4), roll(3), roll(5)), "CHOOSE_BLOCK_DIE")?.results).toEqual([1, 5]);
      });

      it("a failed Pro roll keeps the first result, unless a team re-roll is spent to roll Pro again; passes too", () => {
        const failed = apply(dodge(1), { type: "USE_SKILL", use: true }, roll(2));
        expect(types(failed)).toEqual(["USE_REROLL", "DECLINE_REROLL"]);
        expect(apply(failed, { type: "DECLINE_REROLL" }).players["home-1"]!.status).toBe("prone");
        let retried = apply(failed, { type: "USE_REROLL" });
        expect([find(retried, "ROLL")?.reason, retried.teams.home.rerolls]).toEqual(["Pro 3+ (Home 1)", 0]);
        retried = apply(retried, roll(3), roll(6));
        expect(retried.players["home-1"]).toMatchObject({ at: { x: 11, y: 5 }, status: "standing" });
        // Only once: a second failed Pro roll stands.
        const twice = apply(failed, { type: "USE_REROLL" }, roll(1));
        expect(twice.players["home-1"]!.status).toBe("prone");
        const passer = edit(withSkills(toFirstTurn(), { "home-4": ["Pro"] }), (c) => (c.ball = { square: { x: 10, y: 4 }, carried: true }));
        const s = apply(passer, declare("home-4", "pass"), { type: "THROW", square: { x: 6, y: 4 } }, roll(2));
        expect(find(s, "USE_SKILL")?.skill).toBe("Pro");
      });
    });

    describe("Fend", () => {
      const fender = (attacker: string[] = []) => withSkills(toFirstTurn(), { "away-2": ["Fend"], "home-2": attacker });

      it("the pushed player's coach may stop the follow-up, even when knocked down", () => {
        const pushed = apply(blockAway2(fender()), roll(6), pick, { type: "PUSH", square: { x: 14, y: 7 } });
        expect(find(pushed, "USE_SKILL")).toEqual({ type: "USE_SKILL", side: "away", playerId: "away-2", skill: "Fend" });
        const s = apply(pushed, { type: "USE_SKILL", use: true });
        expect(types(s)).not.toContain("FOLLOW_UP");
        expect(s.players["home-2"]!.at).toEqual({ x: 12, y: 7 });
        expect(types(apply(pushed, { type: "USE_SKILL", use: false }))).toEqual(["FOLLOW_UP"]);
      });

      it("Frenzy does not follow up, and a blitzing Juggernaut ignores Fend", () => {
        const frenzy = apply(blockAway2(fender(["Frenzy"])), roll(3), pick, { type: "PUSH", square: { x: 14, y: 7 } }, { type: "USE_SKILL", use: true });
        expect(frenzy.players["home-2"]!.at).toEqual({ x: 12, y: 7 });
        expect(types(frenzy)).not.toContain("ROLL");
        const blitz = apply(fender(["Juggernaut"]), declare("home-2", "blitz", "away-2"), { type: "BLOCK", targetId: "away-2" }, roll(3), pick, { type: "PUSH", square: { x: 14, y: 7 } });
        expect(types(blitz)).toEqual(["FOLLOW_UP"]);
      });
    });

    it("Taunt: the pushed player's coach may force the attacker to follow up", () => {
      const s = apply(blockAway2(withSkills(toFirstTurn(), { "away-2": ["Taunt"] })), roll(3), pick, { type: "PUSH", square: { x: 14, y: 7 } });
      expect(find(s, "USE_SKILL")).toEqual({ type: "USE_SKILL", side: "away", playerId: "away-2", skill: "Taunt" });
      expect(apply(s, { type: "USE_SKILL", use: true }).players["home-2"]!.at).toEqual({ x: 13, y: 7 });
      expect(types(apply(s, { type: "USE_SKILL", use: false }))).toEqual(["FOLLOW_UP"]);
    });

    describe("Bombardier", () => {
      const bomber = (s = toFirstTurn()) => withSkills(s, { "home-4": ["Bombardier"] });
      const throwBomb = (s: GameState, square: Square) => apply(s, declare("home-4", "bomb"), { type: "THROW", square });

      it("Throw Bomb: once per turn, no move before the throw, thrown like a pass", () => {
        let s = apply(bomber(), declare("home-4", "bomb"));
        expect(types(s)).toEqual(["THROW", "END_PLAYER_ACTION"]);
        s = apply(s, { type: "THROW", square: { x: 6, y: 4 } });
        expect(s.log).toContainEqual({ type: "PassThrown", playerId: "home-4", target: { x: 6, y: 4 }, range: "short", bomb: true });
        expect(find(s, "ROLL")?.reason).toBe("Pass 5+ (short)");
        // Accurate on an empty square: it bounces once (east, to (7,4)) and explodes; home-5 at (8,5) is hit on a 4+.
        s = apply(s, roll(5), roll(3));
        expect(s.log).toContainEqual({ type: "BombExploded", square: { x: 7, y: 4 } });
        expect(find(s, "ROLL")?.reason).toBe("Explosion 4+ (Home 5)");
        s = apply(s, roll(4));
        expect(s.players["home-5"]!.status).toBe("prone");
        expect(s.turnover).toBe(true);
        expect(s.ball).toEqual({ square: { x: 4, y: 2 }, carried: false });
      });

      it("a fumble explodes on the thrower", () => {
        const s = apply(throwBomb(bomber(), { x: 6, y: 4 }), roll(1), { type: "DECLINE_REROLL" });
        expect(s.log).toContainEqual({ type: "BombHit", playerId: "home-4" });
        expect([s.players["home-4"]!.status, s.turnover]).toEqual(["prone", true]);
      });

      it("a player who catches the bomb must throw it again; a failed catch sets it off", () => {
        // home-6 stands at (10,6).
        let s = apply(throwBomb(bomber(), { x: 10, y: 6 }), roll(6));
        expect(find(s, "ROLL")?.reason).toBe("Catch (bomb) 3+ (Home 6)");
        const caught = apply(s, roll(3));
        expect(caught.log).toContainEqual({ type: "BombCaught", playerId: "home-6" });
        expect(find(caught, "THROW")).toMatchObject({ side: "home", playerId: "home-6" });
        s = apply(s, roll(2), { type: "DECLINE_REROLL" });
        expect(s.log).toContainEqual({ type: "BombHit", playerId: "home-6" });
      });
    });

    describe("Break Tackle", () => {
      // home-1 dodges from (12,6) to (11,5): a 3+ dodge.
      const breaker = (skills: string[] = []) => withSkills(toFirstTurn(), { "home-1": ["Break Tackle"], "away-1": skills });

      it("once per turn, adds +1 (ST 3) to a Dodge roll that would fail without it", () => {
        let s = apply(breaker(), startMove("home-1"), ...move({ x: 11, y: 5 }), roll(2));
        expect(s.log).toContainEqual({ type: "SkillUsed", playerId: "home-1", skill: "Break Tackle" });
        expect(s.players["home-1"]).toMatchObject({ at: { x: 11, y: 5 }, status: "standing" });
        // Back next to away-1 and out again: no Break Tackle left.
        s = apply(s, ...move({ x: 12, y: 5 }), ...move({ x: 11, y: 4 }), roll(2));
        expect(types(s)).toContain("USE_REROLL");
      });

      it("is not used when the roll succeeds anyway, and saves a dodge from Diving Tackle", () => {
        const s = apply(breaker(), startMove("home-1"), ...move({ x: 11, y: 5 }), roll(3));
        expect(s.players["home-1"]!.usedSkills).not.toContain("Break Tackle");
        const tackled = apply(breaker(["Diving Tackle"]), startMove("home-1"), ...move({ x: 11, y: 5 }), roll(4), { type: "SELECT_PLAYERS", playerIds: ["away-1"] });
        expect(tackled.players["home-1"]).toMatchObject({ at: { x: 11, y: 5 }, status: "standing", usedSkills: ["Break Tackle"] });
        expect(tackled.players["away-1"]!.status).toBe("prone");
      });
    });

    describe("Hit and Run", () => {
      const runner = (s = toFirstTurn()) => withSkills(s, { "home-2": ["Hit and Run"] });

      it("after the block, the player may step to a free square away from opponents, without a roll", () => {
        let s = apply(blockAway2(runner()), roll(6), pick, { type: "PUSH", square: { x: 14, y: 7 } }, { type: "FOLLOW_UP", follow: false });
        expect(find(s, "ROLL")?.reason).toMatch(/^Armour/);
        s = apply(s, roll(1, 1));
        expect(find(s, "USE_SKILL")).toEqual({ type: "USE_SKILL", side: "home", playerId: "home-2", skill: "Hit and Run" });
        s = apply(s, { type: "USE_SKILL", use: true });
        // (13,7), left by away-2, is next to opponents; the other squares around (12,7) are taken.
        expect(find(s, "MOVE")?.squares.map(({ x, y }) => [x, y])).toEqual([[11, 6], [11, 7], [11, 8]]);
        s = apply(s, ...move({ x: 11, y: 7 }));
        expect(s.players["home-2"]!.at).toEqual({ x: 11, y: 7 });
        expect([s.activePlayerId, s.turnover, top(s).type]).toEqual([null, false, "Turn"]);
      });

      it("not after a turnover, and it can be declined", () => {
        const down = apply(blockAway2(runner()), roll(1), pick, roll(1, 1));
        expect(types(down)).not.toContain("USE_SKILL");
        const declined = apply(blockAway2(runner()), roll(6), pick, { type: "PUSH", square: { x: 14, y: 7 } }, { type: "FOLLOW_UP", follow: false }, roll(1, 1), { type: "USE_SKILL", use: false });
        expect(declined.players["home-2"]!.at).toEqual({ x: 12, y: 7 });
      });
    });

    describe("Hypnotic Gaze", () => {
      const gazer = (s = toFirstTurn()) => withSkills(s, { "home-2": ["Hypnotic Gaze"] });
      const gaze = (s: GameState) => apply(s, declare("home-2", "gaze"), { type: "GAZE", targetId: "away-2" });

      it("is a special action any number of players may declare, after an optional move", () => {
        let s = withSkills(gazer(), { "home-1": ["Hypnotic Gaze"] });
        expect(actionsOf(s, "home-2")).toContain("gaze");
        s = apply(s, declare("home-1", "gaze"), { type: "END_PLAYER_ACTION" });
        expect(actionsOf(s, "home-2")).toContain("gaze");
        expect(find(apply(s, declare("home-2", "gaze")), "GAZE")).toEqual({ type: "GAZE", side: "home", playerId: "home-2", targetIds: ["away-1", "away-2", "away-3"] });
      });

      it("on 3+ the opponent is distracted, and the activation ends either way", () => {
        let s = gaze(gazer());
        expect(find(s, "ROLL")?.reason).toBe("Hypnotic Gaze 3+ (Home 2)");
        s = apply(s, roll(3));
        expect(s.players["away-2"]!.distracted).toBe(true);
        expect(s.log).toContainEqual({ type: "PlayerHypnotised", playerId: "home-2", victimId: "away-2" });
        expect([s.activePlayerId, s.turnover]).toEqual([null, false]);
        // No tackle zone: home-1 at (12,6) is now only marked by away-1.
        expect(tackleZones(s, "home", { x: 12, y: 6 })).toBe(1);
        s = apply(gaze(gazer()), roll(2), { type: "DECLINE_REROLL" });
        expect([s.players["away-2"]!.distracted, s.activePlayerId, s.turnover]).toEqual([false, null, false]);
      });

      it("Foul Appearance comes first", () => {
        const s = gaze(withSkills(gazer(), { "away-2": ["Foul Appearance"] }));
        expect(find(s, "ROLL")?.reason).toBe("Foul Appearance 2+ (Home 2)");
        expect(apply(s, roll(1), { type: "DECLINE_REROLL" }).activePlayerId).toBeNull();
      });
    });

    describe("Strip Ball", () => {
      // away-2 at (13,7) holds the ball; home-2 blocks them from (12,7) and rolls a Push.
      const carrier = (skills: string[] = []) =>
        edit(withSkills(toFirstTurn(), { "home-2": ["Strip Ball"], "away-2": skills }), (c) => (c.ball = { square: { x: 13, y: 7 }, carried: true }));
      const push = (s: GameState) => apply(blockAway2(s), roll(3), pick, { type: "PUSH", square: { x: 14, y: 7 } }, { type: "FOLLOW_UP", follow: false });

      it("a pushed ball carrier drops the ball in the square they are pushed to", () => {
        const s = push(carrier());
        expect(s.log).toContainEqual({ type: "SkillUsed", playerId: "home-2", skill: "Strip Ball" });
        expect(find(s, "ROLL")?.reason).toMatch(/^Bounce/);
        expect(apply(s, roll(3)).ball).toEqual({ square: { x: 15, y: 7 }, carried: false });
      });

      it("does not work against Sure Hands, nor when the carrier stands firm", () => {
        expect(push(carrier(["Sure Hands"])).ball).toEqual({ square: { x: 14, y: 7 }, carried: true });
        const firm = apply(blockAway2(carrier(["Stand Firm"])), roll(3), pick, { type: "USE_SKILL", use: true });
        expect(firm.ball).toEqual({ square: { x: 13, y: 7 }, carried: true });
      });
    });

    describe("Foul Appearance", () => {
      const ugly = (s = toFirstTurn()) => withSkills(s, { "away-2": ["Foul Appearance"] });

      it("the blocker must roll 2+ first; a 1 wastes the block and ends the action, without a turnover", () => {
        let s = blockAway2(ugly());
        expect(find(s, "ROLL")?.reason).toBe("Foul Appearance 2+ (Home 2)");
        expect(find(apply(s, roll(2)), "ROLL")?.reason).toMatch(/^Block/);
        s = apply(s, roll(1), { type: "DECLINE_REROLL" });
        expect([s.activePlayerId, s.turnover, top(s).type]).toEqual([null, false, "Turn"]);
        expect(s.players["home-2"]!.activated).toBe(true);
      });

      it("comes before the Rush of a Blitz, and before Stab", () => {
        const blitz = apply(ugly(), declare("home-2", "blitz", "away-2"), { type: "BLOCK", targetId: "away-2" });
        expect(find(blitz, "ROLL")?.reason).toBe("Foul Appearance 2+ (Home 2)");
        const stab = apply(withSkills(ugly(), { "home-2": ["Stab"] }), declare("home-2", "block"), { type: "STAB", targetId: "away-2" });
        expect(find(stab, "ROLL")?.reason).toBe("Foul Appearance 2+ (Home 2)");
        expect(apply(stab, roll(1), { type: "DECLINE_REROLL" }).players["away-2"]!.status).toBe("standing");
      });
    });

    describe("Animal Savagery", () => {
      const savage = (s = toFirstTurn()) => withSkills(s, { "home-2": ["Animal Savagery", "Mighty Blow(+1)"] });

      it("rolls 2+ for a Block or Blitz, 4+ otherwise", () => {
        expect(find(apply(savage(), declare("home-2", "block")), "ROLL")?.reason).toBe("Animal Savagery 2+ (Home 2)");
        expect(find(apply(savage(), startMove("home-2")), "ROLL")?.reason).toBe("Animal Savagery 4+ (Home 2)");
        const s = apply(savage(), startMove("home-2"), roll(4));
        expect(find(s, "MOVE")).toBeDefined();
      });

      it("a failure knocks down a chosen adjacent team-mate (Mighty Blow on the armour only) and ends the action", () => {
        let s = apply(savage(), startMove("home-2"), roll(3), { type: "DECLINE_REROLL" });
        // home-1 (12,6) and home-3 (12,8) stand next to home-2 (12,7).
        expect(find(s, "SELECT_PLAYERS")).toMatchObject({ side: "home", playerIds: ["home-1", "home-3"], max: 1, min: 1 });
        expect(() => apply(s, { type: "SELECT_PLAYERS", playerIds: [] })).toThrow(IllegalActionError);
        s = apply(s, { type: "SELECT_PLAYERS", playerIds: ["home-3"] });
        expect(s.log).toContainEqual({ type: "LashedOut", playerId: "home-2", victimId: "home-3" });
        expect(find(s, "ROLL")?.reason).toBe("Armour 8+ (Home 3) (+1 Mighty Blow)");
        s = apply(s, roll(4, 4));
        expect(find(s, "ROLL")?.reason).toBe("Injury");
        s = apply(s, roll(3, 4));
        expect(s.players["home-3"]!.status).toBe("stunned");
        expect([s.activeSide, s.activePlayerId, s.turnover, s.players["home-2"]!.distracted]).toEqual(["home", null, false, false]);
      });

      it("a turnover if the team-mate held the ball; with nobody next to them, the action is lost", () => {
        const carrier = edit(savage(), (c) => {
          c.players["home-3"]!.at = { x: 20, y: 8 };
          c.ball = { square: { x: 12, y: 6 }, carried: true };
        });
        let s = apply(carrier, startMove("home-2"), roll(1), { type: "DECLINE_REROLL" });
        expect(s.players["home-1"]!.status).toBe("prone");
        expect(s.turnover).toBe(true);
        const alone = place(savage(), { "home-1": { x: 20, y: 6 }, "home-3": { x: 20, y: 8 } });
        s = apply(alone, startMove("home-2"), roll(1), { type: "DECLINE_REROLL" });
        expect(s.log).toContainEqual({ type: "PlayerDistracted", playerId: "home-2", skill: "Animal Savagery" });
        expect([s.activePlayerId, s.turnover]).toEqual([null, false]);
      });
    });

    describe("Shadowing", () => {
      const select = (...playerIds: string[]): Action => ({ type: "SELECT_PLAYERS", playerIds });
      // home-1 dodges from (12,6), next to away-1 and away-2, to (11,5).
      const dodgeAway = (s: GameState) => apply(s, startMove("home-1"), ...move({ x: 11, y: 5 }), roll(6));

      it("on 4+ the chosen shadower moves into the square the player left", () => {
        let s = dodgeAway(withSkills(toFirstTurn(), { "away-1": ["Shadowing"], "away-2": ["Shadowing"] }));
        expect(find(s, "SELECT_PLAYERS")).toMatchObject({ side: "away", playerIds: ["away-1", "away-2"], max: 1 });
        s = apply(s, select("away-1"));
        expect(find(s, "ROLL")?.reason).toBe("Shadowing 4+ (Away 1)");
        s = apply(s, roll(4));
        expect(s.players["away-1"]!.at).toEqual({ x: 12, y: 6 });
        expect(s.players["home-1"]!.at).toEqual({ x: 11, y: 5 });
        expect(find(s, "MOVE")).toBeDefined();
      });

      it("a failure or no choice leaves the shadower in place", () => {
        const s = dodgeAway(withSkills(toFirstTurn(), { "away-1": ["Shadowing"] }));
        expect(apply(s, select("away-1"), roll(3)).players["away-1"]!.at).toEqual({ x: 13, y: 6 });
        expect(apply(s, select()).players["away-1"]!.at).toEqual({ x: 13, y: 6 });
      });

      it("works as many times per turn as the shadower's MA", () => {
        let s = edit(withSkills(toFirstTurn(), { "away-1": ["Shadowing"] }), (c) => void (c.players["away-1"]!.ma = 1));
        s = apply(dodgeAway(s), select("away-1"), roll(4));
        s = apply(s, ...move({ x: 10, y: 5 }), roll(6));
        expect(types(s)).not.toContain("SELECT_PLAYERS");
        expect(s.players["home-1"]!.at).toEqual({ x: 10, y: 5 });
      });
    });

    describe("Take Root", () => {
      const rooted = (s = toFirstTurn()) => withSkills(s, { "home-2": ["Take Root"] });

      it("a 1 roots the player: no moves, but they may still block, without following up", () => {
        let s = apply(rooted(), declare("home-2", "blitz", "away-2"));
        expect(find(s, "ROLL")?.reason).toBe("Take Root 2+ (Home 2)");
        s = apply(s, roll(1), { type: "DECLINE_REROLL" });
        expect(s.log).toContainEqual({ type: "PlayerRooted", playerId: "home-2" });
        expect(find(s, "MOVE")?.squares).toEqual([]);
        s = apply(s, { type: "BLOCK", targetId: "away-2" }, roll(3), pick, { type: "PUSH", square: { x: 14, y: 7 } });
        expect(types(s)).not.toContain("FOLLOW_UP");
        expect(s.players["home-2"]!.at).toEqual({ x: 12, y: 7 });
        // Still rooted in the next turn, without a new roll: a Move action ends straight away.
        s = apply(s, { type: "END_TURN" }, { type: "END_TURN" }, startMove("home-2"));
        expect([s.players["home-2"]!.activated, s.activePlayerId, top(s).type]).toEqual([true, null, "Turn"]);
      });

      it("a rooted player cannot be pushed", () => {
        const s = apply(blockAway2(edit(toFirstTurn(), (c) => void (c.players["away-2"]!.rooted = true))), roll(3), pick);
        expect(s.log).toContainEqual({ type: "SkillUsed", playerId: "away-2", skill: "Take Root" });
        expect(s.players["away-2"]!.at).toEqual({ x: 13, y: 7 });
        expect(top(s).type).toBe("Turn");
      });

      it("ends once the player has been knocked down; a prone player does not roll", () => {
        const down = edit(rooted(), (c) => Object.assign(c.players["home-2"]!, { rooted: true, status: "prone" }));
        const s = apply(down, startMove("home-2"));
        expect(s.players["home-2"]).toMatchObject({ status: "standing", rooted: false });
        expect(find(s, "MOVE")?.squares.length).toBeGreaterThan(0);
      });
    });

    describe("Jump Up", () => {
      const prone = (s: GameState, skills: string[] = ["Jump Up"]) =>
        edit(withSkills(s, { "home-1": skills }), (c) => void (c.players["home-1"]!.status = "prone"));

      it("stands up for free, without a roll even with MA below 3", () => {
        const s = apply(prone(toFirstTurn(team("Home", { ma: 2 }))), startMove("home-1"));
        expect(s.players["home-1"]).toMatchObject({ status: "standing", movesUsed: 0 });
        expect(s.log).toContainEqual({ type: "SkillUsed", playerId: "home-1", skill: "Jump Up" });
      });

      it("lets a prone player declare a Block: AG roll with +1, a failure stays prone without a turnover", () => {
        expect(actionsOf(prone(toFirstTurn(), []), "home-1")).not.toContain("block");
        let s = apply(prone(toFirstTurn()), declare("home-1", "block"));
        expect(find(s, "ROLL")?.reason).toBe("Jump Up 2+ (Home 1)");
        const failed = apply(s, roll(1), { type: "DECLINE_REROLL" });
        expect(failed.players["home-1"]).toMatchObject({ status: "prone", activated: true });
        expect([failed.activeSide, failed.activePlayerId]).toEqual(["home", null]);
        s = apply(s, roll(2));
        expect(s.players["home-1"]!.status).toBe("standing");
        expect(find(s, "BLOCK")?.targets.map((t) => t.playerId)).toEqual(["away-1", "away-2"]);
      });
    });

    it("Sprint allows a third Rush", () => {
      const rushes = (skills: string[]) =>
        apply(withSkills(toFirstTurn(), { "home-11": skills }), startMove("home-11"), ...HOME_11_FULL_MOVE, ...move({ x: 1, y: 14 }), roll(2), ...move({ x: 0, y: 14 }), roll(2));
      expect(find(rushes([]), "MOVE")).toBeUndefined();
      expect(find(rushes(["Sprint"]), "MOVE")?.squares).toContainEqual({ x: 0, y: 13, rolls: ["rush"] });
    });

    it("Horns: +1 ST when blocking during a Blitz, not in a Block action", () => {
      const s = withSkills(toFirstTurn(), { "home-2": ["Horns"] });
      // ST 4 against 3: two dice.
      expect(find(apply(s, declare("home-2", "blitz", "away-2")), "BLOCK")?.targets).toEqual([{ playerId: "away-2", dice: 2 }]);
      expect(find(apply(s, declare("home-2", "block")), "BLOCK")?.targets.find((t) => t.playerId === "away-2")?.dice).toBe(1);
    });

    describe("Dauntless", () => {
      const strongAway = (skills: string[]) => withSkills(toFirstTurn(team("Home"), team("Away", { st: 4 })), { "home-2": skills });

      it("rolls D6 + ST against a stronger defender: beating its ST makes the block one die", () => {
        let s = blockAway2(strongAway(["Dauntless"]));
        expect(find(s, "ROLL")?.reason).toBe("Dauntless 2+ (Home 2)");
        s = apply(s, roll(2));
        expect(s.log).toContainEqual({ type: "SkillUsed", playerId: "home-2", skill: "Dauntless" });
        expect(find(s, "ROLL")?.reason).toBe("Block (1 die)");
      });

      it("a failed roll can use a team re-roll, then the defender picks from 2 dice", () => {
        const s = apply(blockAway2(strongAway(["Dauntless"])), roll(1));
        expect(types(s)).toEqual(["USE_REROLL", "DECLINE_REROLL"]);
        expect(find(apply(s, { type: "DECLINE_REROLL" }), "ROLL")?.reason).toBe("Block (2 dice, defender chooses)");
      });

      it("Horns adds to the matched strength during a Blitz", () => {
        const s = apply(strongAway(["Dauntless", "Horns"]), declare("home-2", "blitz", "away-2"), { type: "BLOCK", targetId: "away-2" }, roll(2));
        expect(find(s, "ROLL")?.reason).toBe("Block (2 dice)");
      });

      it("no roll against a weaker or equal defender", () => {
        expect(find(blockAway2(withSkills(toFirstTurn(), { "home-2": ["Dauntless"] })), "ROLL")?.reason).toBe("Block (1 die)");
      });
    });

    describe("Wrestle", () => {
      const bothDown = (s: GameState) => apply(blockAway2(s), roll(2), pick);

      it("on Both Down, the attacker may place both players prone: no armour roll, no turnover, the action ends", () => {
        let s = bothDown(withSkills(toFirstTurn(), { "home-2": ["Wrestle"] }));
        expect(find(s, "USE_SKILL")).toEqual({ type: "USE_SKILL", side: "home", playerId: "home-2", skill: "Wrestle" });
        s = apply(s, { type: "USE_SKILL", use: true });
        expect([s.players["home-2"]!.status, s.players["away-2"]!.status]).toEqual(["prone", "prone"]);
        expect(s.log.some((e) => e.type === "ArmourBroken" || e.type === "ArmourHeld")).toBe(false);
        expect([s.activeSide, s.activePlayerId, top(s).type]).toEqual(["home", null, "Turn"]);
      });

      it("the defender's coach is asked when the attacker does not use it", () => {
        let s = bothDown(withSkills(toFirstTurn(), { "home-2": ["Wrestle"], "away-2": ["Wrestle"] }));
        s = apply(s, { type: "USE_SKILL", use: false });
        expect(find(s, "USE_SKILL")).toMatchObject({ side: "away", playerId: "away-2" });
        s = apply(s, { type: "USE_SKILL", use: true });
        expect(s.players["away-2"]!.status).toBe("prone");
        expect(s.activeSide).toBe("home");
        // Declined by everyone: a normal Both Down, the attacker falls.
        const declined = apply(bothDown(withSkills(toFirstTurn(), { "away-2": ["Wrestle"] })), { type: "USE_SKILL", use: false });
        expect(find(declined, "ROLL")?.reason).toMatch(/^Armour/);
      });

      it("a ball carrier of the moving team placed prone drops the ball: turnover", () => {
        let s = edit(withSkills(toFirstTurn(), { "home-2": ["Wrestle"] }), (c) => (c.ball = { square: { x: 12, y: 7 }, carried: true }));
        s = apply(bothDown(s), { type: "USE_SKILL", use: true });
        expect(find(s, "ROLL")?.reason).toBe("Bounce");
        s = apply(s, roll(7));
        expect(s.activeSide).toBe("away");
      });
    });

    describe("Juggernaut", () => {
      /** home-4 blitzes away-4 at (15,4) after moving next to it, and rolls Both Down. */
      const blitzBothDown = (s: GameState) =>
        apply(s, declare("home-4", "blitz", "away-4"), ...move({ x: 11, y: 4 }, { x: 12, y: 4 }, { x: 13, y: 4 }, { x: 14, y: 4 }), { type: "BLOCK", targetId: "away-4" }, roll(2), pick);

      it("may turn Both Down into a Push during a Blitz, and cancels the defender's Stand Firm", () => {
        let s = blitzBothDown(withSkills(toFirstTurn(), { "home-4": ["Juggernaut"], "away-4": ["Stand Firm"] }));
        expect(find(s, "USE_SKILL")).toEqual({ type: "USE_SKILL", side: "home", playerId: "home-4", skill: "Juggernaut" });
        s = apply(s, { type: "USE_SKILL", use: true });
        expect(types(s)).toEqual(["PUSH"]);
        s = apply(s, { type: "PUSH", square: { x: 16, y: 4 } }, { type: "FOLLOW_UP", follow: false });
        expect(s.players["away-4"]).toMatchObject({ at: { x: 16, y: 4 }, status: "standing" });
        expect(s.players["home-4"]!.status).toBe("standing");
      });

      it("cancels the defender's Wrestle when Both Down stands", () => {
        const s = apply(blitzBothDown(withSkills(toFirstTurn(), { "home-4": ["Juggernaut"], "away-4": ["Wrestle"] })), { type: "USE_SKILL", use: false });
        expect(types(s)).not.toContain("USE_SKILL");
        expect(find(s, "ROLL")?.reason).toMatch(/^Armour/);
      });

      it("does nothing in a Block action", () => {
        const s = apply(blockAway2(withSkills(toFirstTurn(), { "home-2": ["Juggernaut"] })), roll(2), pick);
        expect(types(s)).not.toContain("USE_SKILL");
      });
    });

    describe("Projectile Vomit", () => {
      const vomiter = (skills = ["Projectile Vomit"]) => withSkills(toFirstTurn(), { "home-2": skills });
      const vomit = (s: GameState) => apply(s, declare("home-2", "block"), { type: "VOMIT", targetId: "away-2" });

      it("replaces a block: 2+ hits the target, armour without modifiers, placed prone if broken", () => {
        let s = apply(vomiter(), declare("home-2", "block"));
        expect(find(s, "VOMIT")?.targetIds).toEqual(["away-1", "away-2", "away-3"]);
        s = apply(s, { type: "VOMIT", targetId: "away-2" });
        expect(find(s, "ROLL")?.reason).toBe("Projectile Vomit 2+ (Home 2)");
        s = apply(s, roll(2));
        expect(find(s, "ROLL")?.reason).toBe("Armour 8+ (Away 2, vomit)");
        s = apply(s, roll(4, 4), roll(2, 3));
        expect(s.players["away-2"]).toMatchObject({ at: { x: 13, y: 7 }, status: "stunned" });
        expect([s.activeSide, top(s).type]).toEqual(["home", "Turn"]);
      });

      it("Mighty Blow does not help, and a held armour leaves the target standing", () => {
        const s = apply(vomit(vomiter(["Projectile Vomit", "Mighty Blow"])), roll(2), roll(4, 3));
        expect(s.log).toContainEqual({ type: "ArmourHeld", playerId: "away-2", roll: 7 });
        expect(s.players["away-2"]!.status).toBe("standing");
      });

      it("a failed roll hits the vomiting player, without a turnover", () => {
        let s = apply(vomit(vomiter()), roll(1));
        expect(types(s)).toEqual(["USE_REROLL", "DECLINE_REROLL"]);
        s = apply(s, { type: "DECLINE_REROLL" });
        expect(find(s, "ROLL")?.reason).toBe("Armour 8+ (Home 2, vomit)");
        s = apply(s, roll(5, 4), roll(2, 2));
        expect(s.players["home-2"]!.status).toBe("stunned");
        expect(s.activeSide).toBe("home");
      });

      it("during a Blitz it costs a square and ends the action", () => {
        let s = withSkills(toFirstTurn(), { "home-4": ["Projectile Vomit"] });
        s = apply(s, declare("home-4", "blitz", "away-4"), ...move({ x: 11, y: 4 }, { x: 12, y: 4 }, { x: 13, y: 4 }, { x: 14, y: 4 }), { type: "VOMIT", targetId: "away-4" });
        expect(s.players["home-4"]!.movesUsed).toBe(5);
        s = apply(s, roll(2), roll(2, 2));
        expect([s.activePlayerId, top(s).type]).toEqual([null, "Turn"]);
      });
    });

    describe("Breathe Fire", () => {
      const breather = (st = 3) =>
        edit(withSkills(toFirstTurn(), { "home-2": ["Breathe Fire"] }), (c) => {
          c.players["away-2"]!.st = st;
        });
      const fire = (s: GameState) => apply(s, declare("home-2", "block"), { type: "BREATHE_FIRE", targetId: "away-2" });

      it("replaces a block: a 6 knocks the target down, armour and injury without modifiers", () => {
        let s = apply(breather(), declare("home-2", "block"));
        expect(find(s, "BREATHE_FIRE")?.targetIds).toEqual(["away-1", "away-2", "away-3"]);
        s = apply(s, { type: "BREATHE_FIRE", targetId: "away-2" });
        expect(find(s, "ROLL")?.reason).toBe("Breathe Fire 2+ (Home 2)");
        s = apply(s, roll(6));
        expect(s.players["away-2"]!.status).toBe("prone");
        expect(find(s, "ROLL")?.reason).toBe("Armour 8+ (Away 2)");
        s = apply(s, roll(4, 4), roll(2, 3));
        expect(s.players["away-2"]).toMatchObject({ at: { x: 13, y: 7 }, status: "stunned" });
        expect([s.activeSide, top(s).type]).toEqual(["home", "Turn"]);
      });

      it("4+ places the target prone without an armour roll, after the coach may re-roll", () => {
        let s = apply(fire(breather()), roll(4));
        expect(types(s)).toEqual(["USE_REROLL", "DECLINE_REROLL"]);
        s = apply(s, { type: "DECLINE_REROLL" });
        expect(s.players["away-2"]!.status).toBe("prone");
        expect([s.activeSide, top(s).type]).toEqual(["home", "Turn"]);
      });

      it("a re-roll replaces a weak result", () => {
        const s = apply(fire(breather()), roll(2), { type: "USE_REROLL" }, roll(5));
        expect(s.players["away-2"]!.status).toBe("prone");
        expect(s.teams.home.rerolls).toBe(0);
      });

      it("2 or 3 does nothing, -1 against ST 5 or more", () => {
        let s = apply(fire(breather(5)), roll(4), { type: "DECLINE_REROLL" });
        expect(s.players["away-2"]!.status).toBe("standing");
        expect([s.activeSide, top(s).type]).toEqual(["home", "Turn"]);
        s = apply(fire(breather(5)), roll(5), { type: "DECLINE_REROLL" });
        expect(s.players["away-2"]!.status).toBe("prone");
      });

      it("a failure knocks the fire-breather down: armour roll and a turnover", () => {
        let s = apply(fire(breather(5)), roll(2), { type: "DECLINE_REROLL" });
        expect(s.players["home-2"]!.status).toBe("prone");
        expect(find(s, "ROLL")?.reason).toBe("Armour 8+ (Home 2)");
        s = apply(s, roll(2, 2));
        expect(s.activeSide).toBe("away");
      });
    });

    describe("Stab", () => {
      const stabber = (skills = ["Stab"]) => withSkills(toFirstTurn(), { "home-2": skills });

      it("replaces a block: unmodified armour roll, placed prone and injured if it breaks; no turnover", () => {
        let s = apply(stabber(), declare("home-2", "block"));
        expect(find(s, "STAB")?.targetIds).toEqual(["away-1", "away-2", "away-3"]);
        s = apply(s, { type: "STAB", targetId: "away-2" });
        expect(s.log).toContainEqual({ type: "SkillUsed", playerId: "home-2", skill: "Stab" });
        expect(find(s, "ROLL")?.reason).toBe("Armour 8+ (Away 2, stab)");
        s = apply(s, roll(4, 4), roll(2, 3));
        expect(s.players["away-2"]).toMatchObject({ at: { x: 13, y: 7 }, status: "stunned" });
        expect([s.activeSide, top(s).type]).toEqual(["home", "Turn"]);
      });

      it("Mighty Blow and Claws do not help; a held armour leaves the target standing", () => {
        const s = apply(stabber(["Stab", "Mighty Blow", "Claws"]), declare("home-2", "block"), { type: "STAB", targetId: "away-2" }, roll(4, 3));
        expect(s.log).toContainEqual({ type: "ArmourHeld", playerId: "away-2", roll: 7 });
        expect(s.players["away-2"]!.status).toBe("standing");
      });

      it("during a Blitz it costs a square and ends the action", () => {
        let s = withSkills(toFirstTurn(), { "home-4": ["Stab"] });
        s = apply(s, declare("home-4", "blitz", "away-4"), ...move({ x: 11, y: 4 }, { x: 12, y: 4 }, { x: 13, y: 4 }, { x: 14, y: 4 }), { type: "STAB", targetId: "away-4" });
        expect(s.players["home-4"]!.movesUsed).toBe(5);
        s = apply(s, roll(2, 2));
        expect([s.activePlayerId, top(s).type]).toEqual([null, "Turn"]);
      });
    });

    describe("Animosity", () => {
      const thrower = (skill: string) => apply(withSkills(toFirstTurn(), { "home-5": [skill] }), declare("home-5", "pass"), ...TO_BALL, roll(3));
      const toHome4 = { type: "THROW", square: { x: 10, y: 4 } } as const;

      it("rolls 2+ before passing to a team-mate; a failure keeps the ball, ends the action and uses the Pass", () => {
        let s = apply(thrower("Animosity"), toHome4);
        expect(find(s, "ROLL")?.reason).toBe("Animosity 2+ (Home 5)");
        s = apply(s, roll(1), { type: "DECLINE_REROLL" });
        expect(s.ball).toEqual({ square: { x: 4, y: 2 }, carried: true });
        expect([s.activeSide, s.activePlayerId]).toEqual(["home", null]);
        expect(s.log.some((e) => e.type === "PassThrown")).toBe(false);
        expect(actionsOf(s, "home-4")).not.toContain("pass");
        expect(find(apply(thrower("Animosity"), toHome4, roll(2)), "ROLL")?.reason).toBe("Pass 5+ (short)");
      });

      it("only towards a team-mate on the target square with the disliked keyword", () => {
        expect(find(apply(thrower("Animosity"), { type: "THROW", square: { x: 10, y: 2 } }), "ROLL")?.reason).toMatch(/^Pass/);
        const goblinHater = thrower("Animosity(goblin)");
        expect(find(apply(goblinHater, toHome4), "ROLL")?.reason).toMatch(/^Pass/);
        const goblin = edit(goblinHater, (c) => void (c.players["home-4"]!.keywords = ["goblin", "lineman"]));
        expect(find(apply(goblin, toHome4), "ROLL")?.reason).toBe("Animosity 2+ (Home 5)");
      });

      it("applies to hand-offs too", () => {
        let s = place(withSkills(toFirstTurn(), { "home-5": ["Animosity"] }), { "home-4": { x: 5, y: 3 } });
        s = apply(s, declare("home-5", "handoff"), ...TO_BALL, roll(3), { type: "HAND_OFF", targetId: "home-4" });
        expect(find(s, "ROLL")?.reason).toBe("Animosity 2+ (Home 5)");
      });
    });

    describe("Throw Team-mate and Right Stuff", () => {
      /** home-4 at (10,4) can throw home-5, who has Right Stuff, from (10,5). */
      const ttmTeam = (s = toFirstTurn()) => withSkills(place(s, { "home-5": { x: 10, y: 5 } }), { "home-4": ["Throw Team-mate"], "home-5": ["Right Stuff"] });
      const throwTo = (square: Square) => ({ type: "THROW_TEAM_MATE", targetId: "home-5", square }) as const;
      const declared = (s = ttmTeam()) => apply(s, declare("home-4", "ttm"));

      it("is a once-per-turn action for a thrower with a Right Stuff team-mate, to Quick or Short range", () => {
        expect(actionsOf(ttmTeam(), "home-4")).toContain("ttm");
        expect(actionsOf(toFirstTurn(), "home-4")).not.toContain("ttm");
        const t = find(declared(), "THROW_TEAM_MATE")!;
        expect(t.playerIds).toEqual(["home-5"]);
        expect(t.squares).toContainEqual({ x: 7, y: 4, range: "quick", needed: 4 });
        expect(t.squares.some((s) => s.range === "long" || s.range === "bomb")).toBe(false);
      });

      it("superb throw: three scatters from the target, then a landing roll on AG; the thrown player may still act", () => {
        let s = apply(declared(), throwTo({ x: 7, y: 4 }));
        expect(find(s, "ROLL")?.reason).toBe("Throw team-mate 4+ (quick)");
        s = apply(s, roll(4));
        expect(find(s, "ROLL")).toMatchObject({ dice: [{ kind: "d8", count: 3 }] });
        // North, south, east: from (7,4) to (8,4).
        s = apply(s, roll(1, 5, 3));
        expect(find(s, "ROLL")?.reason).toMatch(/^Landing 3\+ \(Home 5\)/);
        s = apply(s, roll(3));
        expect(s.players["home-5"]).toMatchObject({ at: { x: 8, y: 4 }, status: "standing", activated: false });
        expect([s.activeSide, s.activePlayerId]).toEqual(["home", null]);
        expect(actionsOf(s, "home-5")).toContain("move");
        expect(actionsOf(s, "home-6")).not.toContain("ttm");
      });

      it("a subpar throw or a fumble makes the landing 1 harder; a fumble scatters once from the thrown player", () => {
        const subpar = apply(declared(), throwTo({ x: 7, y: 4 }), roll(2), { type: "DECLINE_REROLL" }, roll(1, 5, 3));
        expect(find(subpar, "ROLL")?.reason).toMatch(/^Landing 4\+/);
        let fumble = apply(declared(), throwTo({ x: 7, y: 4 }), roll(1), { type: "DECLINE_REROLL" });
        expect(find(fumble, "ROLL")).toMatchObject({ dice: [{ kind: "d8", count: 1 }] });
        fumble = apply(fumble, roll(3));
        expect(fumble.players["home-5"]!.at).toEqual({ x: 11, y: 5 });
        expect(find(fumble, "ROLL")?.reason).toMatch(/^Landing 4\+/);
      });

      it("landing on a team-mate knocks them down (turnover), scatters on and fails the landing", () => {
        // East, north, south from (9,6) ends on home-6 at (10,6).
        let s = apply(declared(), throwTo({ x: 9, y: 6 }), roll(5), roll(3, 1, 5));
        expect(s.players["home-6"]!.status).toBe("prone");
        s = apply(s, roll(2, 2));
        expect(find(s, "ROLL")?.reason).toBe("Thrown player bounces");
        s = apply(s, roll(3));
        expect(s.players["home-5"]).toMatchObject({ at: { x: 11, y: 6 }, status: "prone" });
        expect(find(s, "ROLL")?.reason).toMatch(/^Armour/);
        s = apply(s, roll(2, 2));
        expect(s.activeSide).toBe("away");
      });

      it("leaving the pitch means the crowd and a turnover", () => {
        const s = apply(ttmTeam(place(toFirstTurn(), { "home-4": { x: 10, y: 1 } })), declare("home-4", "ttm"));
        const after = apply(edit(s, (c) => void (c.players["home-5"]!.at = { x: 10, y: 0 })), throwTo({ x: 8, y: 0 }), roll(4), roll(1, 1, 1));
        expect(find(after, "ROLL")?.reason).toMatch(/pushed into the crowd/);
        expect(apply(after, roll(2, 2)).activeSide).toBe("away");
      });

      it("a failed landing is a knock-down, a turnover only with the ball", () => {
        const landing = (s: GameState) => apply(s, declare("home-4", "ttm"), throwTo({ x: 7, y: 4 }), roll(4), roll(1, 5, 3), roll(1), { type: "DECLINE_REROLL" });
        expect(apply(landing(ttmTeam()), roll(2, 2)).activeSide).toBe("home");
        const carrying = edit(ttmTeam(), (c) => (c.ball = { square: { x: 10, y: 5 }, carried: true }));
        const s = apply(landing(carrying), roll(2, 2));
        expect(find(s, "ROLL")?.reason).toBe("Bounce");
        expect(apply(s, roll(3)).activeSide).toBe("away");
      });

      it("Strong Arm: +1 to the throw", () => {
        const s = apply(withSkills(ttmTeam(), { "home-4": ["Throw Team-mate", "Strong Arm"] }), declare("home-4", "ttm"));
        expect(find(s, "THROW_TEAM_MATE")?.squares).toContainEqual({ x: 7, y: 4, range: "quick", needed: 3 });
        expect(find(apply(s, throwTo({ x: 7, y: 4 })), "ROLL")?.reason).toBe("Throw team-mate 3+ (quick)");
        expect(apply(s, throwTo({ x: 7, y: 4 }), roll(3)).log).toContainEqual({ type: "TeamMateThrown", playerId: "home-4", thrownId: "home-5", result: "accurate" });
      });

      it("a prone team-mate can be thrown, but does not land on their feet", () => {
        const prone = edit(ttmTeam(), (c) => void (c.players["home-5"]!.status = "prone"));
        const s = apply(prone, declare("home-4", "ttm"), throwTo({ x: 7, y: 4 }), roll(4), roll(1, 5, 3));
        expect(find(s, "ROLL")?.reason).toMatch(/^Armour/);
      });
    });

    describe("Always Hungry", () => {
      const hungry = (s = toFirstTurn()) =>
        withSkills(place(s, { "home-5": { x: 10, y: 5 } }), { "home-4": ["Throw Team-mate", "Always Hungry"], "home-5": ["Right Stuff"] });
      const hunger = (s = hungry()) => apply(s, declare("home-4", "ttm"), { type: "THROW_TEAM_MATE", targetId: "home-5", square: { x: 7, y: 4 } });

      it("rolls before the throw: 2+ throws as usual", () => {
        const s = hunger();
        expect(find(s, "ROLL")?.reason).toBe("Always Hungry 2+ (Home 4)");
        expect(find(apply(s, roll(2)), "ROLL")?.reason).toBe("Throw team-mate 4+ (quick)");
      });

      it("on a 1 the team-mate escapes on 2+ and is thrown as a fumble", () => {
        let s = apply(hunger(), roll(1), { type: "DECLINE_REROLL" });
        expect(find(s, "ROLL")?.reason).toBe("Escape 2+ (Home 5)");
        s = apply(s, roll(2));
        expect(find(s, "ROLL")).toMatchObject({ dice: [{ kind: "d8", count: 1 }] });
        s = apply(s, roll(3));
        expect(find(s, "ROLL")?.reason).toMatch(/^Landing 4\+/);
      });

      it("otherwise the team-mate is eaten: dead, a turnover only with the ball", () => {
        const s = apply(hunger(), roll(1), { type: "DECLINE_REROLL" }, roll(1), { type: "DECLINE_REROLL" });
        expect(s.log).toContainEqual({ type: "PlayerEaten", playerId: "home-5", byId: "home-4" });
        expect(s.players["home-5"]).toMatchObject({ at: "cas", casualty: { result: "dead" } });
        expect(s.activeSide).toBe("home");
        const carrying = edit(hungry(), (c) => (c.ball = { square: { x: 10, y: 5 }, carried: true }));
        const eaten = apply(hunger(carrying), roll(1), { type: "DECLINE_REROLL" }, roll(1), { type: "DECLINE_REROLL" });
        expect(find(eaten, "ROLL")?.reason).toBe("Bounce");
        expect(apply(eaten, roll(7)).activeSide).toBe("away");
      });
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

  describe("flight markers", () => {
    it("show the kick-off target, then where the ball comes down until it lands", () => {
      let s = toKick({ x: 5, y: 1 });
      expect(flightMarkers(s)).toEqual([{ kind: "ball", square: { x: 5, y: 1 }, state: "aimed" }]);
      s = apply(s, roll(7, 1));
      expect(flightMarkers(s)).toEqual([{ kind: "ball", square: { x: 4, y: 1 }, state: "landing" }]);
      expect(flightMarkers(apply(s, QUIET_EVENT, roll(5)))).toEqual([]);
    });

    it("ballUnsettled: a loose ball about to bounce or be caught", () => {
      const s = apply(toKick({ x: 5, y: 1 }), roll(7, 1), QUIET_EVENT);
      expect([s.ball.square, ballUnsettled(s)]).toEqual([{ x: 4, y: 1 }, true]);
      expect(ballUnsettled(apply(s, roll(5)))).toBe(false);
    });

    it("scatterOrigin: the square the next d8 moves from (kick-off deviation, then the bounce)", () => {
      let s = toKick({ x: 5, y: 1 });
      expect(scatterOrigin(s)).toEqual({ x: 5, y: 1 });
      s = apply(s, roll(7, 1), QUIET_EVENT);
      expect(scatterOrigin(s)).toEqual({ x: 4, y: 1 });
      expect(scatterOrigin(apply(s, roll(5)))).toBeNull();
    });

    it("show a pass target before the throw, and a bomb held, landing or exploding", () => {
      const passing = edit(toFirstTurn(), (c) => (c.ball = { square: { x: 10, y: 4 }, carried: true }));
      const aimed = apply(passing, declare("home-4", "pass"), { type: "THROW", square: { x: 6, y: 4 } });
      expect(flightMarkers(aimed)).toEqual([{ kind: "ball", square: { x: 6, y: 4 }, state: "aimed" }]);
      const bomber = edit(toFirstTurn(), (c) => void (c.players["home-4"]!.skills = ["Bombardier"]));
      const caught = apply(bomber, declare("home-4", "bomb"), { type: "THROW", square: { x: 10, y: 6 } }, roll(6));
      expect(flightMarkers(caught)).toEqual([{ kind: "bomb", square: { x: 10, y: 6 }, state: "landing" }]);
      expect(flightMarkers(apply(caught, roll(3)))).toEqual([{ kind: "bomb", square: { x: 10, y: 6 }, state: "held" }]);
      expect(flightMarkers(apply(caught, roll(1), { type: "DECLINE_REROLL" }))).toContainEqual({ kind: "bomb", square: { x: 10, y: 6 }, state: "exploding" });
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
