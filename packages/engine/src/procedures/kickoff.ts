import type { Ctx, Handler } from "../context";
import type { Action, ActionTemplate, DiceSpec, GameState, KickoffResult, PlayerState, Procedure, Side, Square, TeamState, Weather } from "../types";
import { SCATTER } from "../dice";
import { adjacent, allSquares, inHalf, inWideZone, isOnPitch, offset, onLineOfScrimmage, other, playerAt, sameSquare, tackleZones, teamPlayers } from "../pitch";
import { hasSkill } from "../skills";
import { createPlayer, getPlayer, inducementsLeft, landBall, spendInducement } from "./helpers";
import { setupErrors } from "./setup";
import { freePrayers, openShop } from "./shop";
import { trapdoor } from "./prayers";

type P<T extends Procedure["type"]> = Extract<Procedure, { type: T }>;

const SIDES = ["home", "away"] as const;

const D3: DiceSpec[] = [{ kind: "d3", count: 1 }];
/** One D3 per team, home first. */
const D3_EACH: DiceSpec[] = [{ kind: "d3", count: 2 }];
const TWO_D6: DiceSpec[] = [{ kind: "d6", count: 2 }];
/** Kick-off deviation: d8 direction, D6 squares (a D3 with Kick). */
const kickDice = (kick = false): DiceSpec[] => [
  { kind: "d8", count: 1 },
  { kind: kick ? "d3" : "d6", count: 1 },
];

/**
 * The kicking player: one set up in the centre field (not on the line of scrimmage nor in a wide zone), or on the line
 * of scrimmage when nobody is there; one with Kick if any.
 */
export function kickingPlayer(state: GameState, side: Side): PlayerState | undefined {
  const onPitch = teamPlayers(state, side).filter((p): p is PlayerState & { at: Square } => isOnPitch(p));
  const centre = onPitch.filter((p) => inWideZone(p.at) === null && !onLineOfScrimmage(side, p.at));
  const candidates = centre.length > 0 ? centre : onPitch.filter((p) => onLineOfScrimmage(side, p.at));
  return candidates.find((p) => hasSkill(p, "Kick")) ?? candidates[0];
}

/** BB2025 weather table (2D6). */
export function weatherFor(roll: number): Weather {
  if (roll <= 2) return "sweltering-heat";
  if (roll === 3) return "very-sunny";
  if (roll <= 10) return "nice";
  if (roll === 11) return "pouring-rain";
  return "blizzard";
}

/** BB2025 kick-off event table (2D6). */
export const KICKOFF_TABLE: Record<number, KickoffResult> = {
  2: "get-the-ref",
  3: "time-out",
  4: "solid-defence",
  5: "high-kick",
  6: "cheering-fans",
  7: "brilliant-coaching",
  8: "weather-change",
  9: "quick-snap",
  10: "charge",
  11: "dodgy-snack",
  12: "pitch-invasion",
};

/** Players on the pitch that are not marked by an opponent. */
export const openPlayers = (state: GameState, side: Side) =>
  teamPlayers(state, side).filter(
    (p): p is PlayerState & { at: Square } => isOnPitch(p) && p.status === "standing" && tackleZones(state, side, p.at) === 0,
  );

/** Pick `count` distinct random players with the game RNG. */
function pickRandom(ctx: Ctx, players: PlayerState[], count: number): PlayerState[] {
  const pool = [...players];
  const picked: PlayerState[] = [];
  while (picked.length < count && pool.length > 0) picked.push(pool.splice(ctx.random(pool.length), 1)[0]!);
  return picked;
}

const playersOnPitch = (state: GameState, side: Side) => teamPlayers(state, side).filter(isOnPitch);

/** Roll-off winners: the higher total, both teams on a tie. */
const winners = (t: Record<Side, number>): Side[] => SIDES.filter((s) => t[s] >= t[other(s)]);
/** Roll-off losers: the lower total, both teams on a tie. */
const losers = (t: Record<Side, number>): Side[] => SIDES.filter((s) => t[s] <= t[other(s)]);

/** Roll 2D6 on the weather table and announce the result. */
function rollWeather(ctx: Ctx, action: Action, reason: string) {
  const [a, b] = ctx.roll(action, TWO_D6, reason);
  ctx.state.weather = weatherFor(a! + b!);
  ctx.emit({ type: "WeatherChanged", weather: ctx.state.weather });
}

/** Reject a selection that is too large or includes a player who is not open. */
function checkSelection(ctx: Ctx, side: Side, playerIds: string[], allowed: number) {
  const open = openPlayers(ctx.state, side).map((p) => p.id);
  if (playerIds.length > allowed || playerIds.some((id) => !open.includes(id))) ctx.reject("Invalid selection.");
}

/**
 * Fan factor (dedicated fans + D3 per team), then the weather, then the pre-game shop (a game option, see `Shop`), then
 * Prayers to Nuffle (see `Prayers`; bought, plus the underdog's free ones after the shop), then Riotous Rookies: a team
 * that bought them rolls 2D3 + 1 players of its lineman position into its reserves for the game, with Loner (4+).
 */
export const Pregame: Handler<P<"Pregame">> = {
  step(ctx, proc, action) {
    if (proc.stage === "inducements") {
      proc.rookies = SIDES.filter((side) => (ctx.state.teams[side].inducements.riotousRookies ?? 0) > 0 && ctx.state.teams[side].journeymanPosition);
      proc.stage = "rookies";
      const free = freePrayers(ctx.state);
      if (free) ctx.emit({ type: "FreePrayers", ...free });
      // Prayers to Nuffle come first.
      const prayers = (side: Side) => (ctx.state.teams[side].inducements.prayers ?? 0) + (free?.side === side ? free.count : 0);
      const draws = SIDES.flatMap((side) => Array.from({ length: prayers(side) }, () => side));
      if (draws.length > 0) ctx.push({ type: "Prayers", draws, stage: "draw" });
      return "continue";
    }
    if (proc.stage === "rookies" && proc.rookies!.length === 0) return "done";
    if (action === null) return "wait";
    if (proc.stage === "fans") {
      const rolls = ctx.roll(action, D3_EACH, "Fan factor (home, away)");
      SIDES.forEach((side, i) => {
        const team = ctx.state.teams[side];
        team.fanFactor = team.dedicatedFans + rolls[i]!;
        ctx.emit({ type: "FanFactor", side, fanFactor: team.fanFactor });
      });
      proc.stage = "weather";
      return "continue";
    }
    if (proc.stage === "weather") {
      rollWeather(ctx, action, "Weather");
      proc.stage = "inducements";
      openShop(ctx);
      return "continue";
    }
    const side = proc.rookies!.shift()!;
    const [a, b] = ctx.roll(action, TWO_D3, `Riotous Rookies (${ctx.state.teams[side].name})`);
    joinRookies(ctx, side, a! + b! + 1);
    return proc.rookies!.length > 0 ? "wait" : "done";
  },
  actions(state, proc) {
    if (proc.stage === "rookies") {
      const side = proc.rookies![0]!;
      return [{ type: "ROLL", side, dice: TWO_D3, reason: `Riotous Rookies (${state.teams[side].name}): 2D3 + 1 players join` }];
    }
    return proc.stage === "fans"
      ? [{ type: "ROLL", side: null, dice: D3_EACH, reason: "Fan factor (home, away)" }]
      : [{ type: "ROLL", side: null, dice: TWO_D6, reason: "Weather" }];
  },
};

const TWO_D3: DiceSpec[] = [{ kind: "d3", count: 2 }];

/** Riotous Rookies: `count` players of the lineman position join the reserves for the game, with Loner (4+). */
function joinRookies(ctx: Ctx, side: Side, count: number) {
  const { state } = ctx;
  const position = state.teams[side].journeymanPosition!;
  const loner = position.skills.some((s) => s.startsWith("Loner")) ? [] : ["Loner(4)"];
  const playerIds: string[] = [];
  for (let i = 0; i < count; i++) {
    const nr = 1 + Math.max(...teamPlayers(state, side).map((p) => p.nr));
    const rookie = createPlayer(side, { ...position, skills: [...position.skills, ...loner], nr, name: `Riotous Rookie #${nr}` });
    state.players[rookie.id] = rookie;
    playerIds.push(rookie.id);
  }
  ctx.emit({ type: "RookiesJoined", side, playerIds });
}

const SWELTERING_HEAT = "Sweltering Heat (players per team)";

/**
 * At the end of a drive in Sweltering Heat, one D3 is rolled and that many random players of each team on the pitch are
 * exhausted for the next drive.
 */
export const SwelteringHeat: Handler<P<"SwelteringHeat">> = {
  step(ctx, _proc, action) {
    if (action === null) return "wait";
    const [count] = ctx.roll(action, D3, SWELTERING_HEAT);
    for (const side of SIDES) {
      for (const p of pickRandom(ctx, playersOnPitch(ctx.state, side), count!)) {
        p.exhausted = true;
        ctx.emit({ type: "PlayerExhausted", playerId: p.id });
      }
    }
    return "done";
  },
  actions: () => [{ type: "ROLL", side: null, dice: D3, reason: SWELTERING_HEAT }],
};

/**
 * Kick-off: place the ball, deviate it (D8 + D6), roll the kick-off event, then land the ball.
 * In BB2025 the event is resolved while the ball is in the air.
 * Kick: if the kicking player has the skill, their coach may decide, before the roll, that the ball deviates D3 squares
 * instead of D6.
 * Leader: at the half's first kick-off, the players with the skill on the pitch are noted; they give their team the
 * Leader re-roll (see `leaderReroll`).
 */
export const Kickoff: Handler<P<"Kickoff">> = {
  step(ctx, proc, action) {
    const { state } = ctx;
    const receiving = other(proc.kicking);
    switch (proc.stage) {
      case "place": {
        if (action === null) return "wait";
        const { square } = ctx.expect(action, "PLACE_BALL");
        if (!inHalf(receiving, square)) ctx.reject("The ball must be kicked into the receiving half.");
        proc.target = { ...square };
        for (const p of Object.values(state.players)) p.played = isOnPitch(p);
        if (proc.firstOfHalf) {
          for (const side of SIDES) state.teams[side].leaders = teamPlayers(state, side).filter((p) => isOnPitch(p) && hasSkill(p, "Leader")).map((p) => p.id);
        }
        ctx.emit({ type: "BallPlaced", square });
        proc.stage = kicker(state, proc) ? "kick" : "scatter";
        return "continue";
      }
      case "kick": {
        if (action === null) return "wait";
        if (ctx.expect(action, "USE_SKILL").use) {
          proc.kick = true;
          ctx.emit({ type: "SkillUsed", playerId: kicker(state, proc)!.id, skill: "Kick" });
        }
        proc.stage = "scatter";
        return "continue";
      }
      case "scatter": {
        if (action === null) return "wait";
        const [direction, distance] = ctx.roll(action, kickDice(proc.kick), "Kick-off deviation");
        proc.landing = offset(proc.target!, SCATTER[direction!]!, distance!);
        proc.touchback = !inHalf(receiving, proc.landing);
        ctx.emit({ type: "BallScattered", to: proc.landing });
        // On the Ball: a receiving player may move while the ball is in the air.
        if (!proc.touchback) ctx.push({ type: "OnTheBall", side: receiving, kickoff: true, stage: "select", moved: [] });
        proc.stage = "event";
        return "continue";
      }
      case "event": {
        if (action === null) return "wait";
        const [a, b] = ctx.roll(action, TWO_D6, "Kick-off event");
        const result = KICKOFF_TABLE[a! + b!]!;
        ctx.emit({ type: "KickoffResult", result });
        proc.stage = "land";
        applyKickoffResult(ctx, proc, result);
        return "continue";
      }
      case "weather": {
        if (action === null) return "wait";
        rollWeather(ctx, action, "Weather change");
        // Players exhausted by the heat recover when the heat comes back.
        if (state.weather === "sweltering-heat") {
          for (const p of Object.values(state.players)) p.exhausted = false;
        }
        // A change to nice weather brings a gust of wind: the ball scatters three more squares.
        proc.stage = state.weather === "nice" && !proc.touchback ? "gusts" : "land";
        return "continue";
      }
      case "gusts": {
        if (action === null) return "wait";
        const directions = ctx.roll(action, [{ kind: "d8", count: 3 }], "Gust of wind");
        for (const d of directions) {
          const next = offset(proc.landing!, SCATTER[d]!);
          if (!inHalf(receiving, next)) {
            proc.touchback = true;
            break;
          }
          proc.landing = next;
        }
        ctx.emit({ type: "BallScattered", to: proc.landing! });
        proc.stage = "land";
        return "continue";
      }
      case "land":
        if (proc.touchback) {
          state.ball = { square: null, carried: false };
          ctx.push({ type: "Touchback", side: receiving });
        } else {
          landBall(ctx, proc.landing!, proc.target!, { kickoff: true, receiving, bounceIfEmpty: true, scattered: false, divingCatch: true });
        }
        return "done";
    }
  },
  actions(state, proc) {
    const receiving = other(proc.kicking);
    switch (proc.stage) {
      case "place":
        return [{ type: "PLACE_BALL", side: proc.kicking, squares: allSquares((s) => inHalf(receiving, s)) }];
      case "kick":
        return [{ type: "USE_SKILL", side: proc.kicking, playerId: kicker(state, proc)!.id, skill: "Kick" }];
      case "scatter":
        return [{ type: "ROLL", side: proc.kicking, dice: kickDice(proc.kick), reason: proc.kick ? "Kick-off deviation (Kick: D3)" : "Kick-off deviation" }];
      case "event":
        return [{ type: "ROLL", side: proc.kicking, dice: TWO_D6, reason: "Kick-off event" }];
      case "weather":
        return [{ type: "ROLL", side: null, dice: TWO_D6, reason: "Weather change" }];
      case "gusts":
        return [{ type: "ROLL", side: null, dice: [{ kind: "d8", count: 3 }], reason: "Gust of wind" }];
      case "land":
        return [];
    }
  },
};

/** The kicking player, if they have Kick. */
const kicker = (state: GameState, proc: P<"Kickoff">) => {
  const player = kickingPlayer(state, proc.kicking);
  return player && hasSkill(player, "Kick") ? player : undefined;
};

/** Apply a kick-off event: immediate effects here, the others as procedures that run before the ball lands. */
function applyKickoffResult(ctx: Ctx, proc: P<"Kickoff">, result: KickoffResult) {
  const { state } = ctx;
  const receiving = other(proc.kicking);
  switch (result) {
    case "get-the-ref":
      for (const side of SIDES) {
        state.teams[side].bribes += 1;
        ctx.emit({ type: "BribeGained", side });
      }
      return;
    case "time-out": {
      const delta = state.teams[proc.kicking].turn >= 6 ? -1 : 1;
      for (const side of SIDES) state.teams[side].turn += delta;
      ctx.emit({ type: "TurnCountersChanged", delta });
      return;
    }
    case "solid-defence":
      ctx.push({ type: "SolidDefence", side: proc.kicking, stage: "roll" });
      return;
    case "high-kick":
      if (!proc.touchback && !playerAt(state, proc.landing!) && openPlayers(state, receiving).length > 0) {
        ctx.push({ type: "HighKick", side: receiving, square: { ...proc.landing! } });
      }
      return;
    case "weather-change":
      proc.stage = "weather";
      return;
    case "quick-snap":
      ctx.push({ type: "QuickSnap", side: receiving, stage: "roll", moved: [] });
      return;
    case "charge":
      ctx.push({ type: "Charge", side: proc.kicking, stage: "roll" });
      return;
    case "cheering-fans":
    case "brilliant-coaching":
    case "dodgy-snack":
    case "pitch-invasion":
      ctx.push({ type: "KickoffEvent", result, stage: "roll" });
      return;
  }
}

type RollOffEvent = P<"KickoffEvent">["result"];

/** A D6 per team (home first); Pitch Invasion adds the D3 of stunned players. */
const EVENT_DICE: Record<RollOffEvent, DiceSpec[]> = {
  "cheering-fans": TWO_D6,
  "brilliant-coaching": TWO_D6,
  "dodgy-snack": TWO_D6,
  "pitch-invasion": [...TWO_D6, ...D3],
};

/** Cheering Fans: the teams with a Team Mascot that rolled a natural 1, which they re-roll for free. */
const mascotFans = (state: GameState, rolls: Record<Side, number>) =>
  (["home", "away"] as const).filter((side) => rolls[side] === 1 && (state.teams[side].inducements.teamMascot ?? 0) > 0);

/** Cheerleaders for Cheering Fans: the team's own, plus Temp Agency Cheerleaders. */
const cheerleaders = (team: TeamState) => team.cheerleaders + (team.inducements.tempCheerleaders ?? 0);

/** Assistant coaches for Brilliant Coaching: the team's own, plus Part-time Assistant Coaches. */
const assistantCoaches = (team: TeamState) => team.assistantCoaches + (team.inducements.partTimeCoaches ?? 0);

const EVENT_NAMES: Record<RollOffEvent, string> = {
  "cheering-fans": "Cheering Fans (home, away)",
  "brilliant-coaching": "Brilliant Coaching (home, away)",
  "dodgy-snack": "Dodgy Snack (home, away)",
  "pitch-invasion": "Pitch Invasion (home, away, players)",
};

/**
 * Kick-off events resolved with a D6 roll-off between both teams; ties affect both teams.
 * Dodgy Snack then rolls a D6 per victim: 1 sends them to the reserves, otherwise -1 MA/AV.
 */
export const KickoffEvent: Handler<P<"KickoffEvent">> = {
  step(ctx, proc, action) {
    if (action === null) return "wait";
    const { state } = ctx;
    const { home, away } = state.teams;
    if (proc.stage === "snack") {
      const rolls = ctx.roll(action, [{ kind: "d6", count: proc.snackers!.length }], "Dodgy Snack");
      proc.snackers!.forEach((id, i) => {
        const p = state.players[id]!;
        const sentOff = rolls[i] === 1;
        if (sentOff) {
          p.at = "reserves";
        } else {
          p.snack = { ma: p.ma, av: p.av };
          p.ma = Math.max(1, p.ma - 1);
          p.av = Math.max(3, p.av - 1);
        }
        ctx.emit({ type: "DodgySnack", playerId: id, sentOff });
      });
      return "done";
    }
    if (proc.stage === "mascot") {
      const rerolls = ctx.roll(action, [{ kind: "d6", count: mascotFans(state, proc.rolls!).length }], "Cheering Fans (Team Mascot)");
      mascotFans(state, proc.rolls!).forEach((side, i) => {
        proc.rolls![side] = rerolls[i]!;
      });
    }
    const [h, a, d3] = proc.stage === "mascot" ? [proc.rolls!.home, proc.rolls!.away] : ctx.roll(action, EVENT_DICE[proc.result], EVENT_NAMES[proc.result]);
    const totals = { home: h!, away: a! };
    // Cheering Fans: a team with a Team Mascot re-rolls a natural 1, for free.
    if (proc.result === "cheering-fans" && proc.stage === "roll" && mascotFans(state, totals).length > 0) {
      proc.rolls = { ...totals };
      proc.stage = "mascot";
      return "wait";
    }
    switch (proc.result) {
      case "cheering-fans":
        totals.home += cheerleaders(home);
        totals.away += cheerleaders(away);
        for (const side of winners(totals)) {
          state.teams[side].extraAssist = true;
          ctx.emit({ type: "ExtraAssist", side });
        }
        return "done";
      case "brilliant-coaching":
        totals.home += assistantCoaches(home);
        totals.away += assistantCoaches(away);
        for (const side of winners(totals)) {
          state.teams[side].driveRerolls += 1;
          ctx.emit({ type: "RerollGained", side });
        }
        return "done";
      case "dodgy-snack":
        // The team with the lowest roll (both on a tie) loses a random player on the pitch to a dodgy snack.
        proc.snackers = losers(totals).flatMap((side) => pickRandom(ctx, playersOnPitch(state, side), 1).map((p) => p.id));
        if (proc.snackers.length === 0) return "done";
        proc.stage = "snack";
        return "continue";
      case "pitch-invasion":
        totals.home += home.fanFactor;
        totals.away += away.fanFactor;
        for (const side of losers(totals)) {
          const standing = teamPlayers(state, side).filter((p) => isOnPitch(p) && p.status === "standing");
          for (const p of pickRandom(ctx, standing, d3!)) {
            // Ball & Chain: placed prone instead, and the armour breaks without a roll (an injury roll).
            if (hasSkill(p, "Ball & Chain")) {
              p.status = "prone";
              ctx.emit({ type: "PlayerPlacedProne", playerId: p.id });
              ctx.push({ type: "KnockDown", playerId: p.id, turnover: false, stage: "armour" });
              continue;
            }
            p.status = "stunned";
            ctx.emit({ type: "PlayerInjured", playerId: p.id, result: "stunned" });
          }
        }
        return "done";
    }
  },
  actions(state, proc) {
    if (proc.stage === "snack") {
      return [{ type: "ROLL", side: null, dice: [{ kind: "d6", count: proc.snackers!.length }], reason: "Dodgy Snack: 1 sends the player off" }];
    }
    if (proc.stage === "mascot") {
      const sides = mascotFans(state, proc.rolls!);
      return [{ type: "ROLL", side: null, dice: [{ kind: "d6", count: sides.length }], reason: `Cheering Fans: Team Mascot re-roll (${sides.join(", ")})` }];
    }
    return [{ type: "ROLL", side: null, dice: EVENT_DICE[proc.result], reason: EVENT_NAMES[proc.result] }];
  },
};

/** D3+3 open players of the kicking team may be removed and set up again. */
export const SolidDefence: Handler<P<"SolidDefence">> = {
  step(ctx, proc, action) {
    const { state } = ctx;
    if (proc.stage === "roll") {
      if (openPlayers(state, proc.side).length === 0) return "done";
      if (action === null) return "wait";
      const [d3] = ctx.roll(action, D3, "Solid Defence: D3+3 players");
      proc.allowed = Math.min(d3! + 3, openPlayers(state, proc.side).length);
      proc.stage = "select";
      return "continue";
    }
    if (action === null) return "wait";
    if (proc.stage === "select") {
      const { playerIds } = ctx.expect(action, "SELECT_PLAYERS");
      checkSelection(ctx, proc.side, playerIds, proc.allowed!);
      if (playerIds.length === 0) return "done";
      proc.selected = [...playerIds];
      for (const id of playerIds) state.players[id]!.at = "reserves";
      proc.stage = "setup";
      return "wait";
    }
    return setUpAgain(ctx, proc.side, proc.selected!, action);
  },
  actions(state, proc) {
    if (proc.stage === "roll") return [{ type: "ROLL", side: proc.side, dice: D3, reason: "Solid Defence: D3+3 players" }];
    if (proc.stage === "select") {
      const playerIds = openPlayers(state, proc.side).map((p) => p.id);
      return [{ type: "SELECT_PLAYERS", side: proc.side, playerIds, max: proc.allowed!, reason: `Solid Defence: choose up to ${proc.allowed} players to set up again` }];
    }
    return setUpAgainActions(state, proc.side, proc.selected!);
  },
};

/** Set up again the players taken off the pitch (Solid Defence, Dwarfen Wisdom): only they may be placed, until the setup is legal. */
function setUpAgain(ctx: Ctx, side: Side, selected: string[], action: Action): "wait" | "done" {
  const { state } = ctx;
  const a = ctx.expect(action, "PLACE_PLAYER", "END_SETUP");
  if (a.type === "END_SETUP") {
    const errors = setupErrors(state, side);
    if (errors.length > 0) ctx.reject(errors.join(" "));
    return "done";
  }
  if (!selected.includes(a.playerId)) ctx.reject("Only the selected players may be set up again.");
  const player = getPlayer(ctx, a.playerId);
  if (a.square === null) {
    player.at = "reserves";
    return "wait";
  }
  if (!inHalf(side, a.square) || playerAt(state, a.square)) ctx.reject("Choose an empty square in your own half.");
  player.at = { ...a.square };
  return "wait";
}

/** What `setUpAgain` offers: the selected players, the empty squares of the team's half, and confirming. */
const setUpAgainActions = (state: GameState, side: Side, selected: string[]): ActionTemplate[] => [
  { type: "PLACE_PLAYER", side, playerIds: selected, squares: allSquares((s) => inHalf(side, s) && !playerAt(state, s)) },
  { type: "END_SETUP", side, errors: setupErrors(state, side) },
];

/** Dwarfen Wisdom (Josef Bugman), if the team has not used it: the kicking team is asked first, then the receiving team. */
export const dwarfenWisdom = (state: GameState, kicking: Side): Procedure[] =>
  [kicking, other(kicking)]
    .filter((side) => inducementsLeft(state.teams[side], "josefBugman") > 0)
    .map((side) => ({ type: "DwarfenWisdom", side, stage: "ask" }));

/** The team's players on the pitch, who Dwarfen Wisdom may set up again. */
const onPitch = (state: GameState, side: Side) => teamPlayers(state, side).filter(isOnPitch);

/**
 * Dwarfen Wisdom (Josef Bugman, once per game): after both teams have set up for a kick-off, the coach may roll a D3
 * and set up again that many of the team's players on the pitch (at least one), as long as the setup stays legal.
 */
export const DwarfenWisdom: Handler<P<"DwarfenWisdom">> = {
  step(ctx, proc, action) {
    const { state } = ctx;
    if (proc.stage === "ask") {
      if (onPitch(state, proc.side).length === 0) return "done";
      if (action === null) return "wait";
      if (!ctx.expect(action, "DWARFEN_WISDOM").use) return "done";
      spendInducement(ctx, proc.side, "josefBugman");
      proc.stage = "roll";
      return "wait";
    }
    if (action === null) return "wait";
    if (proc.stage === "roll") {
      const [d3] = ctx.roll(action, D3, "Dwarfen Wisdom: D3 players");
      proc.allowed = Math.min(d3!, onPitch(state, proc.side).length);
      proc.stage = "select";
      return "wait";
    }
    if (proc.stage === "select") {
      const { playerIds } = ctx.expect(action, "SELECT_PLAYERS");
      const eligible = onPitch(state, proc.side).map((p) => p.id);
      if (playerIds.length === 0 || playerIds.length > proc.allowed! || new Set(playerIds).size !== playerIds.length || playerIds.some((id) => !eligible.includes(id))) {
        ctx.reject(`Choose 1 to ${proc.allowed} of your players on the pitch.`);
      }
      proc.selected = [...playerIds];
      for (const id of playerIds) state.players[id]!.at = "reserves";
      proc.stage = "setup";
      return "wait";
    }
    return setUpAgain(ctx, proc.side, proc.selected!, action);
  },
  actions(state, proc) {
    const { side } = proc;
    if (proc.stage === "ask") return [{ type: "DWARFEN_WISDOM", side }];
    if (proc.stage === "roll") return [{ type: "ROLL", side, dice: D3, reason: "Dwarfen Wisdom: D3 players to set up again" }];
    if (proc.stage === "select") {
      const playerIds = onPitch(state, side).map((p) => p.id);
      return [{ type: "SELECT_PLAYERS", side, playerIds, max: proc.allowed!, min: 1, reason: `Dwarfen Wisdom: choose 1 to ${proc.allowed} players to set up again` }];
    }
    return setUpAgainActions(state, side, proc.selected!);
  },
};

/** The receiving team may move one open player to the square where the ball will land. */
export const HighKick: Handler<P<"HighKick">> = {
  step(ctx, proc, action) {
    if (action === null) return "wait";
    const { playerIds } = ctx.expect(action, "SELECT_PLAYERS");
    if (playerIds.length > 1) ctx.reject("Choose a single player.");
    const id = playerIds[0];
    if (id !== undefined) {
      if (!openPlayers(ctx.state, proc.side).some((p) => p.id === id)) ctx.reject("This player is marked.");
      ctx.state.players[id]!.at = { ...proc.square };
    }
    return "done";
  },
  actions(state, proc) {
    const playerIds = openPlayers(state, proc.side).map((p) => p.id);
    return [{ type: "SELECT_PLAYERS", side: proc.side, playerIds, max: 1, reason: "High Kick: move a player under the ball" }];
  },
};

/** The receiving team moves D3+3 open players one square each. */
export const QuickSnap: Handler<P<"QuickSnap">> = {
  step(ctx, proc, action) {
    const { state } = ctx;
    if (proc.stage === "roll") {
      if (action === null) return "wait";
      const [d3] = ctx.roll(action, D3, "Quick Snap: D3+3 players");
      proc.allowed = d3! + 3;
      proc.stage = "move";
      return "continue";
    }
    if (snapMoves(state, proc).length === 0) return "done";
    if (action === null) return "wait";
    const a = ctx.expect(action, "SNAP", "DONE");
    if (a.type === "DONE") return "done";
    const move = snapMoves(state, proc).find((m) => m.playerId === a.playerId);
    if (!move?.squares.some((s) => sameSquare(s, a.square))) ctx.reject("Illegal Quick Snap move.");
    state.players[a.playerId]!.at = { ...a.square };
    proc.moved.push(a.playerId);
    ctx.push(...trapdoor(state, state.players[a.playerId]!, a.square));
    return "continue";
  },
  actions(state, proc) {
    if (proc.stage === "roll") return [{ type: "ROLL", side: proc.side, dice: D3, reason: "Quick Snap: D3+3 players" }];
    return [
      { type: "SNAP", side: proc.side, moves: snapMoves(state, proc), remaining: proc.allowed! - proc.moved.length },
      { type: "DONE", side: proc.side },
    ];
  },
};

/** Open players not moved yet, with the empty squares next to them; none once `allowed` players moved. */
function snapMoves(state: GameState, proc: P<"QuickSnap">) {
  if (proc.moved.length >= (proc.allowed ?? 0)) return [];
  return openPlayers(state, proc.side)
    .filter((p) => !proc.moved.includes(p.id))
    .map((p) => ({ playerId: p.id, squares: adjacent(p.at).filter((s) => !playerAt(state, s)) }))
    .filter((m) => m.squares.length > 0);
}

/** The kicking team picks D3+3 open players, who then take actions as in a team turn (Move or Blitz). */
export const Charge: Handler<P<"Charge">> = {
  step(ctx, proc, action) {
    const { state } = ctx;
    if (proc.stage === "roll") {
      if (openPlayers(state, proc.side).length === 0) return "done";
      if (action === null) return "wait";
      const [d3] = ctx.roll(action, D3, "Charge: D3+3 players");
      proc.allowed = Math.min(d3! + 3, openPlayers(state, proc.side).length);
      proc.stage = "select";
      return "continue";
    }
    if (action === null) return "wait";
    const { playerIds } = ctx.expect(action, "SELECT_PLAYERS");
    checkSelection(ctx, proc.side, playerIds, proc.allowed!);
    if (playerIds.length > 0) ctx.push({ type: "Turn", side: proc.side, stage: "start", charge: [...playerIds], used: [] });
    return "done";
  },
  actions(state, proc) {
    if (proc.stage === "roll") return [{ type: "ROLL", side: proc.side, dice: D3, reason: "Charge: D3+3 players" }];
    const playerIds = openPlayers(state, proc.side).map((p) => p.id);
    return [{ type: "SELECT_PLAYERS", side: proc.side, playerIds, max: proc.allowed!, reason: `Charge: choose up to ${proc.allowed} players` }];
  },
};
