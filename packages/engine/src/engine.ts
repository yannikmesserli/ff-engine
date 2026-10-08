import { produce } from "immer";
import { IllegalActionError, createContext, run, type Handler } from "./context";
import { handlers } from "./procedures";
import { createPlayer } from "./procedures/helpers";
import type { Action, ActionTemplate, GameEvent, GameState, PlayerState, Side, TeamSetup } from "./types";

export interface GameOptions {
  /** Seed for the game RNG; random when omitted. Same seed and actions give the same game. */
  seed?: number;
  /** A draw after the second half goes to overtime: a third half (cup games). Off by default: a draw stands. */
  overtime?: boolean;
}

/** Result of `step`: the next state and the events emitted while getting there. */
export interface StepResult {
  state: GameState;
  events: GameEvent[];
}

/** Teams in their reserves, before anything is rolled; player ids are "<side>-<nr>". */
function initialState(home: TeamSetup, away: TeamSetup, seed: number, overtime: boolean): GameState {
  const players: Record<string, PlayerState> = {};
  const teams = { home, away };
  for (const side of ["home", "away"] as const) {
    for (const p of teams[side].players) {
      const player = createPlayer(side, p);
      players[player.id] = player;
    }
  }
  const team = (side: Side) => ({
    side,
    name: teams[side].name,
    roster: teams[side].roster,
    score: 0,
    turn: 0,
    rerolls: teams[side].rerolls,
    rerollsPerHalf: teams[side].rerolls,
    driveRerolls: 0,
    leaders: [],
    leaderUsed: false,
    dedicatedFans: teams[side].dedicatedFans,
    fanFactor: teams[side].dedicatedFans,
    cheerleaders: teams[side].cheerleaders,
    assistantCoaches: teams[side].assistantCoaches,
    bribes: teams[side].inducements?.bribes ?? 0,
    specialRules: [...(teams[side].specialRules ?? [])],
    journeymanPosition: teams[side].journeymanPosition ?? null,
    inducements: { ...(teams[side].inducements ?? {}) },
    inducementsUsed: {},
    prayers: [],
    mascotUsed: false,
    mascotRolling: false,
    coachBanned: false,
    extraAssist: false,
    apothecaries: teams[side].apothecary ? 1 : 0,
    raisePosition: teams[side].raisePosition ?? null,
    raisedDead: 0,
  });
  return {
    version: 1,
    rng: seed >>> 0,
    half: 1,
    kickingFirstHalf: null,
    overtime,
    teams: { home: team("home"), away: team("away") },
    players,
    ball: { square: null, carried: false },
    activeSide: null,
    activePlayerId: null,
    weather: "nice",
    drive: 0,
    turnover: false,
    touchdown: null,
    lastCheck: null,
    stack: [{ type: "Game", stage: "pregame" }],
    log: [],
    finished: false,
  };
}

/** Create a game and advance it to the first decision (the fan factor roll). */
export function createGame(home: TeamSetup, away: TeamSetup, options: GameOptions = {}): GameState {
  const seed = options.seed ?? Math.floor(Math.random() * 2 ** 32);
  return produce(initialState(home, away, seed, options.overtime ?? false), (draft) => {
    run(createContext(draft, []), handlers, null);
  });
}

/**
 * Apply actions in order, as successive `step`s would: replays a saved game, or reaches a prepared position (a test
 * scenario). Throws IllegalActionError at the first action that is not legal.
 */
export function applyActions(state: GameState, actions: readonly Action[]): GameState {
  return actions.reduce((s, a) => step(s, a).state, state);
}

/** Everything the current decision maker may do. Empty when the game is over. */
export function getAvailableActions(state: GameState): ActionTemplate[] {
  const top = state.stack.at(-1);
  if (!top) return [];
  return (handlers[top.type] as Handler).actions(state, top);
}

/**
 * Apply an action and advance the game to the next decision.
 * Pure: returns a new state and leaves the input untouched. Throws IllegalActionError on invalid input.
 */
export function step(state: GameState, action: Action): StepResult {
  if (!getAvailableActions(state).some((t) => t.type === action.type)) {
    throw new IllegalActionError(`${action.type} is not available now.`);
  }
  const events: GameEvent[] = [];
  const next = produce(state, (draft) => {
    run(createContext(draft, events), handlers, action);
  });
  return { state: next, events };
}
