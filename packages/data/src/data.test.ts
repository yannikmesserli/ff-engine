import { IMPLEMENTED_SKILLS, createGame, getAvailableActions, skillName, step, type Action, type ActionTemplate, type GameState } from "@bb/engine";
import { afterAll, describe, expect, it } from "vitest";
import { SKILL_DESCRIPTIONS, TeamError, exampleTeams, formationActions, formations, resolveTeam, rosters, skillDescription } from "./index";

describe("data", () => {
  it("has the BB2025 rosters from FUMBBL", () => {
    expect(rosters).toHaveLength(30);
    const human = rosters.find((r) => r.name === "Human")!;
    expect(human).toMatchObject({ tier: 3, rerollCost: 50000, apothecary: true });
    expect(human.positions.find((p) => p.title === "Human Lineman")).toMatchObject({ quantity: 16, ma: 6, st: 3, ag: 3, pa: 4, av: 9 });
    expect(human.positions.find((p) => p.title === "Ogre")).toMatchObject({ skills: expect.arrayContaining(["Loner(3)"]), normal: ["S"] });
  });

  it("marks positions that cannot pass with a null PA", () => {
    expect(rosters.flatMap((r) => r.positions).some((p) => p.pa === null)).toBe(true);
  });

  it.each(Object.keys(exampleTeams))("resolves the %s example team", (key) => {
    const team = resolveTeam(exampleTeams[key]);
    expect(team.players.length).toBeGreaterThanOrEqual(11);
  });

  it("applies gained skills, improvements and lasting injuries; AG improvements lower the target", () => {
    const file = structuredClone(exampleTeams["human"]!);
    Object.assign(file.players[0]!, { skills: ["Sprint"], improvements: { ma: 1, ag: 1 }, injuries: ["av", "pa", "niggling"] });
    const team = resolveTeam(file);
    expect(team.players[0]).toMatchObject({ ma: 8, ag: 2, pa: 5, av: 8, skills: ["Block", "Tackle", "Sprint"], nigglingInjuries: 1 });
  });

  it("fills in defaults and leaves out players who miss the next game", () => {
    const team = resolveTeam({
      name: "Minimal",
      roster: "Human",
      rerolls: 2,
      players: [
        { number: 1, name: "A", position: "Human Lineman" },
        { number: 2, name: "B", position: "Human Lineman", missNextGame: true },
      ],
    });
    expect(team).toMatchObject({ apothecary: false, assistantCoaches: 0, cheerleaders: 0, dedicatedFans: 1 });
    expect(team.players.map((p) => p.nr)).toEqual([1]);
  });

  it("reports invalid teams", () => {
    expect(() => resolveTeam({ name: "x" })).toThrow(TeamError);
    expect(() => resolveTeam({ ...exampleTeams["human"], roster: "Gnoll" })).toThrow(/Unknown roster/);
    // Unknown fields are rejected rather than silently ignored.
    expect(() => resolveTeam({ ...exampleTeams["human"], race: "Human" })).toThrow(/Invalid team file/);
    const tooManyOgres = structuredClone(exampleTeams["human"]!);
    tooManyOgres.players.slice(0, 2).forEach((p) => (p.position = "Ogre"));
    expect(() => resolveTeam(tooManyOgres)).toThrow(/At most 1 Ogre/);
    // Chaos Chosen already field a Minotaur and may hire one Big Guy.
    const twoBigGuys = structuredClone(exampleTeams["chaos"]!);
    twoBigGuys.players[0]!.position = "Ogre";
    expect(() => resolveTeam(twoBigGuys)).toThrow(/at most 1 Big Guys/);
  });

  it.each(Object.keys(formations))("formation %s gives a legal setup for both sides", (name) => {
    // Fan factor, weather and coin toss; the toss winner kicks.
    const pregame: Action[] = [
      { type: "ROLL", values: [1, 1] },
      { type: "ROLL", values: [3, 4] },
      { type: "CALL_COIN", call: "heads" },
      { type: "ROLL", values: [1] },
      { type: "CHOOSE_KICK", kick: true },
    ];
    let s = pregame.reduce(
      (st, a) => step(st, a).state,
      createGame(resolveTeam(exampleTeams["orc"]), resolveTeam(exampleTeams["human"]), { seed: 3 }),
    );
    for (const side of ["home", "away"] as const) {
      s = formationActions(s, side, formations[name]!).reduce((st, a) => step(st, a).state, s);
      expect(getAvailableActions(s).find((a) => a.type === "END_SETUP")).toMatchObject({ errors: [] });
      s = step(s, { type: "END_SETUP" }).state;
    }
  });
});

/** Pick random legal actions from the templates; setups use a random formation. */
function randomActions(state: GameState, templates: ActionTemplate[], random: () => number): Action[] {
  const pick = <T>(xs: T[]): T => xs[Math.floor(random() * xs.length)]!;
  const setup = templates.find((t) => t.type === "END_SETUP");
  if (setup?.type === "END_SETUP" && state.stack.at(-1)?.type === "SolidDefence") {
    const placement = templates.find((t) => t.type === "PLACE_PLAYER");
    const unplaced = placement?.type === "PLACE_PLAYER" ? placement.playerIds.filter((id) => state.players[id]!.at === "reserves") : [];
    if (setup.errors.length === 0) return [{ type: "END_SETUP" }];
    if (unplaced.length === 0 && placement?.type === "PLACE_PLAYER") {
      // Illegal setup: take a selected player off the pitch and try again.
      return [{ type: "PLACE_PLAYER", playerId: pick(placement.playerIds), square: null }];
    }
    return [randomAction(templates.filter((t) => t.type === "PLACE_PLAYER"), pick, random)];
  }
  if (setup?.type === "END_SETUP") {
    return [...formationActions(state, setup.side, pick(Object.values(formations))), { type: "END_SETUP" }];
  }
  return [randomAction(templates, pick, random)];
}

/** One random answer to a random template; ending a turn or player action is rarer so games progress. */
function randomAction(templates: ActionTemplate[], pick: <T>(xs: T[]) => T, random: () => number): Action {
  const t = pick(templates.filter((t) => (t.type !== "END_TURN" && t.type !== "END_PLAYER_ACTION") || random() < 0.1));
  switch (t.type) {
    case "CALL_COIN":
      return { type: "CALL_COIN", call: pick(["heads", "tails"] as const) };
    case "CHOOSE_KICK":
      return { type: "CHOOSE_KICK", kick: random() < 0.5 };
    case "PLACE_BALL":
      return { type: "PLACE_BALL", square: pick(t.squares) };
    case "GIVE_BALL":
      return { type: "GIVE_BALL", playerId: pick(t.playerIds) };
    case "START_ACTION": {
      if (t.choices.length === 0) return { type: "END_TURN" };
      const choice = pick(t.choices);
      const action = pick(choice.actions);
      return action === "blitz"
        ? { type: "START_ACTION", playerId: choice.playerId, action, targetId: pick(t.blitzTargets) }
        : { type: "START_ACTION", playerId: choice.playerId, action };
    }
    case "BLOCK":
      return { type: "BLOCK", targetId: pick(t.targets).playerId };
    case "THROW_TEAM_MATE":
      return t.squares.length > 0 && random() < 0.8
        ? { type: "THROW_TEAM_MATE", targetId: pick(t.playerIds), square: pick(t.squares) }
        : { type: "END_PLAYER_ACTION" };
    case "VOMIT":
      return { type: "VOMIT", targetId: pick(t.targetIds) };
    case "STAB":
      return { type: "STAB", targetId: pick(t.targetIds) };
    case "CHOOSE_BLOCK_DIE":
      return { type: "CHOOSE_BLOCK_DIE", index: Math.floor(random() * t.results.length) };
    case "PUSH":
      return { type: "PUSH", square: pick(t.squares) };
    case "THROW":
      return { type: "THROW", square: pick(t.squares) };
    case "HAND_OFF":
      return { type: "HAND_OFF", targetId: pick(t.playerIds) };
    case "FOUL":
      return { type: "FOUL", targetId: pick(t.targets).playerId };
    case "ARGUE_THE_CALL":
      return { type: "ARGUE_THE_CALL", argue: random() < 0.5 };
    case "BRIBE":
      return { type: "BRIBE", use: random() < 0.5 };
    case "USE_APOTHECARY":
      return { type: "USE_APOTHECARY", use: random() < 0.7 };
    case "APOTHECARY_CHOICE":
      return { type: "APOTHECARY_CHOICE", keep: pick(["first", "second"] as const) };
    case "FOLLOW_UP":
      return { type: "FOLLOW_UP", follow: random() < 0.5 };
    case "USE_SKILL":
      return { type: "USE_SKILL", use: random() < 0.7 };
    case "MOVE":
      return t.squares.length > 0 && random() < 0.9 ? { type: "MOVE", square: pick(t.squares) } : { type: "END_PLAYER_ACTION" };
    case "SELECT_PLAYERS": {
      const shuffled = [...t.playerIds].sort(() => random() - 0.5);
      return { type: "SELECT_PLAYERS", playerIds: shuffled.slice(0, Math.floor(random() * (t.max + 1))) };
    }
    case "SNAP": {
      const m = t.moves.length > 0 && random() < 0.7 ? pick(t.moves) : undefined;
      return m ? { type: "SNAP", playerId: m.playerId, square: pick(m.squares) } : { type: "DONE" };
    }
    case "PLACE_PLAYER":
      // Solid Defence: put the selected players back on any free square of the half.
      return { type: "PLACE_PLAYER", playerId: pick(t.playerIds), square: pick(t.squares) };
    default:
      return { type: t.type } as Action;
  }
}

describe("skill descriptions", () => {
  /** Skills only gained through advancement, not on any starting roster. */
  const ADVANCEMENT_ONLY = ["Kick", "Multiple Block", "Bullseye", "Accurate", "Cannoneer", "Leader", "Big Hand", "Extra Arms",
    "Monstrous Mouth", "Two Heads", "Very Long Legs", "Lethal Flight", "Lone Fouler", "Pile Driver", "Put the Boot In",
    "Quick Foul", "Saboteur", "Violent Innovator"];

  it("describes every skill of the rosters, the engine and advancement", () => {
    const fromRosters = rosters.flatMap((r) => r.positions.flatMap((p) => p.skills.map(skillName)));
    const missing = [...new Set([...fromRosters, ...IMPLEMENTED_SKILLS, ...ADVANCEMENT_ONLY])].filter((s) => !SKILL_DESCRIPTIONS[s]);
    expect(missing).toEqual([]);
  });

  it("fills in the skill's value", () => {
    expect(skillDescription("Loner(4)")).toMatch(/needs a 4\+ on a D6/);
    expect(skillDescription("Mighty Blow(+2)")).toMatch(/^\+2 to the armour/);
    expect(skillDescription("Mighty Blow")).toMatch(/^\+1 to the armour/);
    expect(skillDescription("Animosity(goblin)")).toMatch(/to a team-mate with keyword goblin/);
    expect(skillDescription("Animosity")).toMatch(/to any team-mate/);
    expect(skillDescription("Unknown skill")).toBeNull();
  });
});

describe("random games", () => {
  const seenKickoffResults = new Set<string>();
  const seenBlockResults = new Set<number>();
  const ballEvents = new Set<string>();
  let crowdPushes = 0;
  // Coverage summary: which rare outcomes the random games reached.
  afterAll(() => {
    console.log("kick-off results seen:", [...seenKickoffResults].sort().join(", "));
    console.log("block faces seen:", [...seenBlockResults].sort().join(", "), "| pushes into crowd:", crowdPushes);
    console.log("ball events seen:", [...ballEvents].sort().join(", "));
  });
  /** A game takes under a second; the margin keeps a busy or sleeping machine from failing the run. */
  const GAME_TIMEOUT_MS = 30_000;
  it.each(Array.from({ length: 40 }, (_, i) => i + 1))("plays a full game with random legal actions (seed %i)", (seed) => {
    let rng = seed;
    // Linear congruential generator: reproducible per seed, independent of the engine's RNG.
    const random = () => ((rng = (rng * 1103515245 + 12345) % 2 ** 31) / 2 ** 31);
    const start = createGame(resolveTeam(exampleTeams["orc"]), resolveTeam(exampleTeams["wood-elf"]), { seed });
    let s = start;
    const taken: Action[] = [];
    let steps = 0;
    while (!s.finished) {
      if (++steps > 50_000) throw new Error("game did not finish");
      const actions = randomActions(s, getAvailableActions(s), random);
      taken.push(...actions);
      s = actions.reduce((st, a) => step(st, a).state, s);
    }
    // Online play relies on this: the same seed and actions give the same game (dice rolled by the seeded RNG).
    if (seed <= 3) expect(taken.reduce((st, a) => step(st, a).state, start)).toEqual(s);
    // Time-out kick-offs can shift the turn counters, so the number of turns varies.
    expect(s.log.filter((e) => e.type === "HalfEnded")).toHaveLength(2);
    expect(s.log.filter((e) => e.type === "TurnStarted").length).toBeGreaterThan(24);
    expect(s.log.at(-1)).toMatchObject({ type: "GameEnded" });
    for (const e of s.log) {
      if (e.type === "KickoffResult") seenKickoffResults.add(e.result);
      if (e.type === "BlockResult") seenBlockResults.add(e.face);
      if (e.type === "PlayerPushed" && e.to === null) crowdPushes++;
      if (e.type === "PassResult") ballEvents.add(`pass ${e.result}`);
      if (e.type === "Intercepted" || e.type === "HandedOff" || e.type === "BallSecured" || e.type === "Touchdown") ballEvents.add(e.type);
      if (e.type === "PlayerSentOff" || e.type === "BribeUsed" || e.type === "ArgueTheCall" || e.type === "Fouled") ballEvents.add(e.type);
      if (e.type === "CasualtyRolled") ballEvents.add(`casualty ${e.casualty.result}`);
      if (e.type === "ApothecaryResult") ballEvents.add(`apothecary ${e.result}`);
      if (e.type === "CheckResult" && (e.kind === "jump" || e.kind === "loner")) ballEvents.add(e.kind);
      if (e.type === "RockThrown") ballEvents.add(`rock ${e.hit ? "hit" : "missed"}`);
      if (e.type === "SkillUsed") ballEvents.add(`skill ${e.skill}`);
      if (e.type === "TeamMateThrown") ballEvents.add(`team-mate throw ${e.result}`);
      if (e.type === "PlayerDistracted") ballEvents.add(`distracted (${e.skill})`);
    }
  }, GAME_TIMEOUT_MS);
});
