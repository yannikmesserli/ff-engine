import { IMPLEMENTED_SKILLS, createGame, getAvailableActions, skillName, starPlayerPoints, step, type Action, type ActionTemplate, type GameState } from "@bb/engine";
import { afterAll, describe, expect, it } from "vitest";
import { SKILL_DESCRIPTIONS, TeamError, exampleTeams, formationActions, formations, resolveTeam, rosters, skillDescription, teamAfterGame } from "./index";

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
      journeymen: false,
      players: [
        { number: 1, name: "A", position: "Human Lineman" },
        { number: 2, name: "B", position: "Human Lineman", missNextGame: true },
      ],
    });
    expect(team).toMatchObject({ apothecary: false, assistantCoaches: 0, cheerleaders: 0, dedicatedFans: 1 });
    expect(team.players.map((p) => p.nr)).toEqual([1]);
  });

  it("fills a team up to 11 with journeymen from the lineman position, with Loner (4+)", () => {
    const short = (journeymen?: boolean | string, roster = "Human", position = "Human Blitzer") => ({
      name: "Short",
      roster,
      rerolls: 2,
      ...(journeymen === undefined ? {} : { journeymen }),
      players: [
        { number: 1, name: "A", position },
        { number: 2, name: "B", position, missNextGame: true },
      ],
    });
    const team = resolveTeam(short());
    expect(team.players.map((p) => p.nr)).toEqual([1, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12]);
    expect(team.players[1]).toMatchObject({ name: "Journeyman #3", position: "Human Lineman", skills: ["Loner(4)"] });
    expect(resolveTeam(short(false)).players).toHaveLength(1);
    // Shambling Undead may take Skeletons or Zombies.
    expect(resolveTeam(short("Zombie Lineman", "Shambling Undead", "Ghoul Runner")).players[1]!.position).toBe("Zombie Lineman");
    expect(() => resolveTeam(short("Ghoul Runner", "Shambling Undead", "Ghoul Runner"))).toThrow(/Journeymen cannot be Ghoul Runner/);
  });

  it("checks the inducements bought against the BB2025 limits and special rules; bribes reach the game", () => {
    const human = (inducements: Record<string, number>, specialRules: string[] = []) => ({ ...exampleTeams["human"]!, inducements, specialRules });
    const team = resolveTeam(human({ bribes: 2, teamMascot: 1 }));
    expect(team.inducements).toEqual({ bribes: 2, teamMascot: 1 });
    expect(createGame(team, resolveTeam(exampleTeams["orc"]), { seed: 1 }).teams.home.bribes).toBe(2);
    expect(() => resolveTeam(human({ bribes: 4 }))).toThrow(/At most 3 bribes/);
    expect(resolveTeam(human({ bribes: 6 }, ["Bribery and Corruption"])).inducements!.bribes).toBe(6);
    expect(() => resolveTeam(human({ plagueDoctor: 1 }))).toThrow(/Only teams with Favoured of Nurgle/);
    expect(() => resolveTeam(human({ wizard: 1 }))).toThrow(/Invalid team file/);
    expect(() => resolveTeam(human({ tempCheerleaders: 4 }))).not.toThrow();
    expect(() => resolveTeam({ ...human({ partTimeCoaches: 3 }), assistantCoaches: 8 })).toThrow(/At most 1 partTimeCoaches/);
  });

  it("gives teams with Plague Ridden their lineman position for raised players", () => {
    const nurgle = resolveTeam({ name: "N", roster: "Nurgle", rerolls: 0, players: [{ number: 1, name: "A", position: "Rotter Lineman" }] });
    expect(nurgle.raisePosition).toMatchObject({ position: "Rotter Lineman", skills: ["Decay", "Plague Ridden"] });
    expect(resolveTeam(exampleTeams["human"]).raisePosition).toBeUndefined();
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

  it("rejects more Insignificant players than other players", () => {
    const team = (snotlings: number, others: number) => ({
      name: "Snots",
      roster: "Snotling",
      rerolls: 1,
      players: [
        ...Array.from({ length: snotlings }, (_, i) => ({ number: i + 1, name: `Snot ${i + 1}`, position: "Snotling Lineman" })),
        ...Array.from({ length: others }, (_, i) => ({ number: 20 + i, name: `Runna ${i + 1}`, position: "Stilty Runna" })),
      ],
    });
    expect(() => resolveTeam(team(2, 2))).not.toThrow();
    expect(() => resolveTeam(team(3, 2))).toThrow(/At most as many Insignificant players as other players \(3 of 5\)/);
  });

  it("counts each player's advancements: gained skills and characteristic improvements", () => {
    const human = exampleTeams["human"]!;
    const team = { ...human, players: [{ ...human.players[0]!, skills: ["Block", "Dodge"], improvements: { ma: 1 } }, ...human.players.slice(1)] };
    expect(resolveTeam(team).players.map((p) => p.advancements)).toEqual([3, ...human.players.slice(1).map(() => 0)]);
  });

  it("writes the result of a game into the team file", () => {
    const human = { ...exampleTeams["human"]!, players: exampleTeams["human"]!.players.map((p, i) => (i === 4 ? { ...p, missNextGame: true } : p)) };
    const game = structuredClone(createGame(resolveTeam(human), resolveTeam(exampleTeams["orc"])));
    const [first, second, third, fourth] = human.players.map((p) => game.players[`home-${p.number}`]!);
    first!.spp.touchdowns = 2;
    second!.casualty = { result: "lasting-injury", lasting: "ag" };
    third!.casualty = { result: "dead" };
    fourth!.casualty = { result: "serious-injury" };
    game.finished = true;
    game.result = { conceded: null, concededLegally: false, penalties: null, winner: "home", winnings: { home: 60_000, away: 50_000 }, dedicatedFans: { home: 1, away: 0 }, mvps: [], leaving: [] };
    const after = teamAfterGame({ ...human, treasury: 10_000, inducements: { bribes: 1 } }, game, "home");
    expect([after.treasury, after.dedicatedFans, after.inducements]).toEqual([70_000, human.dedicatedFans + 1, {}]);
    expect(after.players).toHaveLength(human.players.length - 1);
    expect(after.players[0]).toMatchObject({ spp: 6, missNextGame: false });
    expect(after.players[1]).toMatchObject({ injuries: ["ag"], missNextGame: true });
    expect(after.players[2]).toMatchObject({ number: human.players[3]!.number, injuries: ["niggling"], missNextGame: true });
    // Sat this game out: back for the next.
    expect(after.players[3]).toMatchObject({ number: human.players[4]!.number, missNextGame: false });
    expect(() => teamAfterGame(human, createGame(resolveTeam(human), resolveTeam(exampleTeams["orc"])), "home")).toThrow(/not over/);
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
  const hailMary = templates.find((t) => t.type === "HAIL_MARY_PASS");
  if (hailMary && random() < 0.3) {
    // Any square of the pitch but the thrower's.
    const at = state.players[hailMary.playerId]!.at as { x: number; y: number };
    const squares = Array.from({ length: 26 * 15 }, (_, i) => ({ x: i % 26, y: Math.floor(i / 26) })).filter((s) => s.x !== at.x || s.y !== at.y);
    return [{ type: "HAIL_MARY_PASS", square: pick(squares) }];
  }
  return [randomAction(templates.filter((t) => t.type !== "HAIL_MARY_PASS"), pick, random)];
}

/** One random answer to a random template; ending a turn or player action is rarer so games progress. */
function randomAction(templates: ActionTemplate[], pick: <T>(xs: T[]) => T, random: () => number): Action {
  // Nobody concedes: the games are played to the end.
  const t = pick(templates.filter((t) => t.type !== "CONCEDE" && ((t.type !== "END_TURN" && t.type !== "END_PLAYER_ACTION") || random() < 0.1)));
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
    case "CHOMP":
      return { type: "CHOMP", targetId: pick(t.targetIds) };
    case "MULTIPLE_BLOCK": {
      const first = pick(t.targetIds);
      return { type: "MULTIPLE_BLOCK", targetIds: [first, pick(t.targetIds.filter((id) => id !== first))] };
    }
    case "STAB":
      return { type: "STAB", targetId: pick(t.targetIds) };
    case "CHOOSE_SKILL":
      return { type: "CHOOSE_SKILL", skill: pick(t.skills) };
    case "THROW_A_ROCK":
      return { type: "THROW_A_ROCK", use: random() < 0.3 };
    case "WEATHER_MAGE":
      return { type: "WEATHER_MAGE" };
    case "CHOOSE_WEATHER":
      return { type: "CHOOSE_WEATHER", modifier: pick(t.options).modifier };
    case "SWOOP":
      return { type: "SWOOP", square: random() < 0.3 ? null : pick(t.squares) };
    case "TRICKSTER":
      return random() < 0.3 ? { type: "TRICKSTER", square: null } : { type: "TRICKSTER", square: pick(t.squares), pickUp: random() < 0.5 };
    case "PUNT":
      return random() < 0.8 || !t.crowd ? { type: "PUNT", square: pick(t.squares) } : { type: "PUNT", square: null };
    case "CHAINSAW":
      return { type: "CHAINSAW", targetId: pick(t.targetIds) };
    case "BREATHE_FIRE":
      return { type: "BREATHE_FIRE", targetId: pick(t.targetIds) };
    case "GAZE":
      return { type: "GAZE", targetId: pick(t.targetIds) };
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
    case "USE_REROLL":
      return t.mascot && (t.available === 0 || random() < 0.5) ? { type: "USE_REROLL", mascot: true } : { type: "USE_REROLL" };
    case "USE_SKILL":
      return { type: "USE_SKILL", use: random() < 0.7, skill: t.skill };
    case "REROLL_BLOCK_DIE":
      return { type: "REROLL_BLOCK_DIE", index: Math.floor(random() * t.results.length) };
    case "MOVE_INSTEAD":
      return { type: "MOVE_INSTEAD", move: random() < 0.5 };
    case "MOVE":
      if (t.squares.length > 0 && random() < 0.9) return { type: "MOVE", square: pick(t.squares) };
      // On the Ball moves end with DONE.
      return templates.some((u) => u.type === "DONE") ? { type: "DONE" } : { type: "END_PLAYER_ACTION" };
    case "SELECT_PLAYERS": {
      const shuffled = [...t.playerIds].sort(() => random() - 0.5);
      const min = t.min ?? 0;
      return { type: "SELECT_PLAYERS", playerIds: shuffled.slice(0, min + Math.floor(random() * (t.max - min + 1))) };
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

/**
 * A legal 11-player team for a roster: one of each position but the lineman (Big Guys up to the roster's limit, as
 * many Insignificant players as the others allow), then linemen (the most common position) up to 11.
 */
function rosterTeam(roster: (typeof rosters)[number]): unknown {
  const byQuantity = [...roster.positions].sort((a, b) => b.quantity - a.quantity);
  const lineman = roster.positions.find((p) => p.keywords.includes("lineman")) ?? byQuantity[0]!;
  const picked: string[] = [];
  let bigGuys = 0;
  for (const position of roster.positions) {
    if (position === lineman || picked.length >= 11) continue;
    if (position.type === "Big Guy" && bigGuys >= roster.maxBigGuys) continue;
    if (position.skills.includes("Insignificant")) continue;
    if (position.type === "Big Guy") bigGuys++;
    picked.push(position.title);
  }
  for (const position of [lineman, ...byQuantity.filter((p) => p !== lineman && p.type !== "Big Guy")]) {
    while (picked.length < 11 && picked.filter((t) => t === position.title).length < position.quantity) {
      // Insignificant players may not outnumber the others.
      if (position.skills.includes("Insignificant") && 2 * (picked.filter((t) => t === position.title).length + 1) > 11) break;
      picked.push(position.title);
    }
  }
  return {
    name: `${roster.name} test team`,
    roster: roster.name,
    rerolls: Math.min(3, roster.maxRerolls),
    apothecary: roster.apothecary,
    players: picked.map((position, i) => ({ number: i + 1, name: `${roster.name} ${i + 1}`, position })),
  };
}

describe("random games", () => {
  it.each(rosters.map((r) => r.name))("builds a legal test team for %s", (name) => {
    expect(resolveTeam(rosterTeam(rosters.find((r) => r.name === name)!)).players).toHaveLength(11);
  });
  const seenKickoffResults = new Set<string>();
  const seenBlockResults = new Set<number>();
  const ballEvents = new Set<string>();
  let crowdPushes = 0;
  let seenOvertime = 0;
  // Coverage summary: which rare outcomes the random games reached.
  afterAll(() => {
    console.log("kick-off results seen:", [...seenKickoffResults].sort().join(", "));
    console.log("block faces seen:", [...seenBlockResults].sort().join(", "), "| pushes into crowd:", crowdPushes, "| overtimes:", seenOvertime);
    console.log("ball events seen:", [...ballEvents].sort().join(", "));
  });
  /** A game takes under a second; the margin keeps a busy or sleeping machine from failing the run. */
  const GAME_TIMEOUT_MS = 30_000;
  /** Inducements any team may buy, for the random games. */
  const RANDOM_GAME_INDUCEMENTS = { bribes: 1, teamMascot: 1, partTimeCoaches: 1, tempCheerleaders: 1, blitzersBestKegs: 1, biasedReferee: 1, halflingMasterChef: 1, riotousRookies: 1, weatherMage: 1, prayers: 3 };
  /** Seed i: every roster plays at home once in 30 seeds (7 and 30 share no factor), against a different one away. */
  const matchup = (seed: number) => [rosters[(7 * seed) % rosters.length]!, rosters[(11 * seed + 3) % rosters.length]!] as const;
  it.each(Array.from({ length: 40 }, (_, i) => [i + 1, ...matchup(i + 1).map((r) => r.name)] as const))("plays a full game with random legal actions (seed %i: %s v %s)", (seed) => {
    let rng = seed;
    // Linear congruential generator: reproducible per seed, independent of the engine's RNG.
    const random = () => ((rng = (rng * 1103515245 + 12345) % 2 ** 31) / 2 ** 31);
    const [home, away] = matchup(seed);
    // One game in four is a cup game: a draw goes to overtime.
    // Every other game, the home team bought a few inducements.
    const homeTeam = { ...(rosterTeam(home) as object), ...(seed % 2 === 1 ? { inducements: RANDOM_GAME_INDUCEMENTS, specialRules: ["Low Cost Linemen"] } : {}) };
    const start = createGame(resolveTeam(homeTeam), resolveTeam(rosterTeam(away)), { seed, overtime: seed % 4 === 0 });
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
    const overtime = s.log.some((e) => e.type === "HalfStarted" && e.half === 3);
    expect(s.log.filter((e) => e.type === "HalfEnded")).toHaveLength(overtime ? 3 : 2);
    if (overtime) seenOvertime++;
    expect(s.log.filter((e) => e.type === "TurnStarted").length).toBeGreaterThan(24);
    expect(s.log.at(-1)).toMatchObject({ type: "GameEnded" });
    // The Star Player Points earned go to the team file.
    const after = teamAfterGame(homeTeam, s, "home");
    const kept = (p: GameState["players"][string]) => p.side === "home" && !/^(Journeyman|Riotous Rookie) #/.test(p.name) && p.casualty?.result !== "dead";
    const earned = Object.values(s.players).filter(kept);
    expect(after.players.reduce((sum, p) => sum + p.spp, 0)).toBe(earned.reduce((sum, p) => sum + starPlayerPoints(s, p), 0));
    expect(s.result!.mvps).toHaveLength(2);
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
