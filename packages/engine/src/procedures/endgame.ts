import type { Ctx, Handler } from "../context";
import type { ActionTemplate, GameResult, GameState, PlayerState, Procedure, Side, SppRecord } from "../types";
import { other, teamPlayers } from "../pitch";
import { getPlayer } from "./helpers";
import { availablePlayers } from "./setup";

type P<T extends Procedure["type"]> = Extract<Procedure, { type: T }>;

/**
 * BB2025 Star Player Points: touchdown 3, casualty 2, completion 1, interception 2, MVP 4; a landing after a team-mate
 * throw 1, a pass caught with Dazzling Catching 1. Brawlin' Brutes: touchdowns are worth 2 and casualties 3.
 */
export const SPP_VALUES = { touchdown: 3, casualty: 2, completion: 1, interception: 2, landing: 1, catch: 1, mvp: 4 } as const;

/** Nothing earned yet. */
export const noSpp = (): SppRecord => ({ touchdowns: 0, casualties: 0, completions: 0, interceptions: 0, landings: 0, catches: 0, mvp: 0 });

/** The Star Player Points a player earned this game. Perfect Passing (a prayer): each completion earns 1 more. */
export function starPlayerPoints(state: GameState, player: PlayerState): number {
  const team = state.teams[player.side];
  const brutes = team.specialRules.includes("Brawlin' Brutes");
  const completion = SPP_VALUES.completion + (team.prayers.includes("perfect-passing") ? 1 : 0);
  const { spp } = player;
  return (
    spp.touchdowns * (brutes ? 2 : SPP_VALUES.touchdown) +
    spp.casualties * (brutes ? 3 : SPP_VALUES.casualty) +
    spp.completions * completion +
    spp.interceptions * SPP_VALUES.interception +
    spp.landings * SPP_VALUES.landing +
    spp.catches * SPP_VALUES.catch +
    spp.mvp * SPP_VALUES.mvp
  );
}

/** A concession is legal when the team cannot set up 3 players at the start of a drive. */
export const LEGAL_CONCESSION_PLAYERS = 3;

/** The CONCEDE template for the team in its own setup or turn (not a Charge). */
export function concessionTemplate(state: GameState, top: Procedure): ActionTemplate[] {
  if (top.type === "Setup") return [{ type: "CONCEDE", side: top.side, legal: availablePlayers(state, top.side).length < LEGAL_CONCESSION_PLAYERS }];
  if (top.type === "Turn" && top.stage === "main" && !top.charge) return [{ type: "CONCEDE", side: top.side, legal: false }];
  return [];
}

const emptyResult = (): GameResult => ({
  conceded: null,
  concededLegally: false,
  penalties: null,
  winner: null,
  winnings: { home: 0, away: 0 },
  dedicatedFans: { home: 0, away: 0 },
  mvps: [],
  leaving: [],
});

/** The team concedes: whatever was going on stops and the game goes straight to its end. */
export function concede(ctx: Ctx, template: Extract<ActionTemplate, { type: "CONCEDE" }>) {
  const { state } = ctx;
  ctx.emit({ type: "Conceded", side: template.side, legal: template.legal });
  state.result = { ...emptyResult(), conceded: template.side, concededLegally: template.legal };
  state.stack.splice(1);
  const root = state.stack[0];
  if (root?.type === "Game") root.stage = "postgame";
  state.activeSide = null;
  state.activePlayerId = null;
}

/**
 * Players who can be named MVP or awarded a touchdown: not killed this game, not raised during it, and not star players
 * or mercenaries.
 */
const awardable = (state: GameState, side: Side) => teamPlayers(state, side).filter((p) => p.casualty?.result !== "dead" && !p.raised && !p.hired);

/** The penalty shootout ends once this many penalties are scored in all. */
export const SHOOTOUT_PENALTIES = 5;

/** Winnings: 10,000 gp per point (half the fan attendance, touchdowns, 1 for not stalling). */
export const WINNINGS_PER_POINT = 10_000;

/** Player loss after an illegal concession: players with this many advancements roll a D6 and leave on 1-3. */
export const PLAYER_LOSS_ADVANCEMENTS = 3;
export const PLAYER_LOSS_MAX_ROLL = 3;

/** Conceded without the right to (see `concessionTemplate`). */
const illegalConcession = (result: GameResult, side: Side) => result.conceded === side && !result.concededLegally;

/**
 * The end of the game, in order:
 * - Concession: the winners have at least 2 touchdowns (they name who scored the ones they are awarded), the conceding
 *   team none, and it loses the Star Player Points of the game.
 * - Penalty shootout after a drawn overtime: each round both coaches roll a D6, the higher one scores (a tie scores
 *   nothing), until 5 penalties are scored.
 * - MVP: one random player of each team (not killed or raised this game, nor hired for it). After an illegal concession the conceding
 *   team gets none and the winners two.
 * - Winnings: (half the fan attendance + touchdowns + 1 for not stalling) x 10,000 gp. After an illegal concession the
 *   conceding team wins nothing and the winners get the whole attendance.
 * - Dedicated Fans: the winners roll a D6 and gain one on a roll of at least their Dedicated Fans; the losers lose one
 *   on a roll below theirs; nothing on a draw. A team that conceded illegally rolls a D3 and loses that many (keeping
 *   at least 1).
 * - Player loss: after an illegal concession, each player of the conceding team with 3 or more advancements (and not
 *   killed) rolls a D6 and leaves the team on 1-3.
 */
export const EndGame: Handler<P<"EndGame">> = {
  step(ctx, proc, action) {
    const { state } = ctx;
    const result = (state.result ??= emptyResult());
    const { home, away } = state.teams;
    switch (proc.stage) {
      case "init": {
        state.activeSide = null;
        state.activePlayerId = null;
        const conceded = result.conceded;
        proc.stage = "shootout";
        if (conceded) {
          const winner = state.teams[other(conceded)];
          proc.touchdowns = Math.max(0, 2 - winner.score);
          winner.score = Math.max(winner.score, 2);
          state.teams[conceded].score = 0;
          for (const p of teamPlayers(state, conceded)) p.spp = noSpp();
          proc.stage = "touchdowns";
        }
        return "continue";
      }
      case "touchdowns": {
        const side = other(result.conceded!);
        if ((proc.touchdowns ?? 0) <= 0 || awardable(state, side).length === 0) {
          proc.stage = "shootout";
          return "continue";
        }
        if (action === null) return "wait";
        const { playerIds } = ctx.expect(action, "SELECT_PLAYERS");
        const player =
          (playerIds.length === 1 ? awardable(state, side).find((p) => p.id === playerIds[0]) : undefined) ?? ctx.reject("Choose one player of the winning team.");
        player.spp.touchdowns += 1;
        ctx.emit({ type: "TouchdownAwarded", playerId: player.id });
        proc.touchdowns! -= 1;
        return "continue";
      }
      case "shootout": {
        const tied = home.score === away.score;
        if (state.half === 3 && tied && !result.conceded) {
          const penalties = (result.penalties ??= { home: 0, away: 0 });
          if (penalties.home + penalties.away < SHOOTOUT_PENALTIES) {
            if (action === null) return "wait";
            const [h, a] = ctx.roll(action, [{ kind: "d6", count: 2 }], "Penalty shootout (home, away)");
            const winner = h! > a! ? "home" : a! > h! ? "away" : null;
            if (winner) penalties[winner] += 1;
            ctx.emit({ type: "PenaltyKick", rolls: { home: h!, away: a! }, winner });
            return "continue";
          }
        }
        const penalties = result.penalties;
        result.winner = result.conceded
          ? other(result.conceded)
          : home.score !== away.score
            ? home.score > away.score ? "home" : "away"
            : penalties && penalties.home !== penalties.away
              ? penalties.home > penalties.away ? "home" : "away"
              : null;
        proc.stage = "mvp";
        return "continue";
      }
      case "mvp":
        for (const side of ["home", "away"] as const) {
          const count = illegalConcession(result, side) ? 0 : illegalConcession(result, other(side)) ? 2 : 1;
          const candidates = awardable(state, side);
          for (let i = 0; i < count && candidates.length > 0; i++) {
            const mvp = candidates[ctx.random(candidates.length)]!;
            mvp.spp.mvp += 1;
            result.mvps.push(mvp.id);
            ctx.emit({ type: "MvpAwarded", playerId: mvp.id });
          }
        }
        proc.stage = "winnings";
        return "continue";
      case "winnings": {
        const attendance = home.fanFactor + away.fanFactor;
        for (const side of ["home", "away"] as const) {
          const team = state.teams[side];
          const fans = illegalConcession(result, side) ? 0 : illegalConcession(result, other(side)) ? attendance : attendance / 2;
          const points = illegalConcession(result, side) ? 0 : fans + team.score + (team.stalled ? 0 : 1);
          result.winnings[side] = Math.floor(points * WINNINGS_PER_POINT);
          ctx.emit({ type: "Winnings", side, amount: result.winnings[side] });
        }
        proc.fans = result.winner ? ["home", "away"] : [];
        proc.stage = "fans";
        return "continue";
      }
      case "fans": {
        const side = proc.fans?.[0];
        if (side === undefined) {
          const conceded = result.conceded;
          proc.loss =
            conceded && illegalConcession(result, conceded)
              ? awardable(state, conceded)
                  .filter((p) => p.advancements >= PLAYER_LOSS_ADVANCEMENTS)
                  .map((p) => p.id)
              : [];
          proc.stage = "loss";
          return "continue";
        }
        if (action === null) return "wait";
        const fans = state.teams[side].dedicatedFans;
        const illegal = illegalConcession(result, side);
        const [roll] = ctx.roll(action, [{ kind: illegal ? "d3" : "d6", count: 1 }], fansReason(state, side));
        const change = illegal ? -Math.max(0, Math.min(roll!, fans - 1)) : result.winner === side ? (roll! >= fans ? 1 : 0) : roll! >= fans ? 0 : -1;
        result.dedicatedFans[side] = change;
        ctx.emit({ type: "DedicatedFans", side, roll: roll!, change });
        proc.fans!.shift();
        return "continue";
      }
      case "loss": {
        const playerId = proc.loss?.[0];
        if (playerId === undefined) return "done";
        if (action === null) return "wait";
        const player = getPlayer(ctx, playerId);
        const [roll] = ctx.roll(action, [{ kind: "d6", count: 1 }], `Player loss: ${player.name} leaves on 1-${PLAYER_LOSS_MAX_ROLL}`);
        const leaves = roll! <= PLAYER_LOSS_MAX_ROLL;
        if (leaves) result.leaving.push(playerId);
        ctx.emit({ type: "PlayerLoss", playerId, roll: roll!, leaves });
        proc.loss!.shift();
        return "continue";
      }
    }
  },
  actions(state, proc) {
    const result = state.result!;
    switch (proc.stage) {
      case "touchdowns": {
        const side = other(result.conceded!);
        const reason = `Name the scorer of an awarded touchdown (${proc.touchdowns} left)`;
        return [{ type: "SELECT_PLAYERS", side, playerIds: awardable(state, side).map((p) => p.id), max: 1, min: 1, reason }];
      }
      case "shootout":
        return [{ type: "ROLL", side: null, dice: [{ kind: "d6", count: 2 }], reason: "Penalty shootout (home, away)" }];
      case "fans": {
        const side = proc.fans![0]!;
        return [{ type: "ROLL", side, dice: [{ kind: illegalConcession(result, side) ? "d3" : "d6", count: 1 }], reason: fansReason(state, side) }];
      }
      case "loss": {
        const player = state.players[proc.loss![0]!]!;
        return [{ type: "ROLL", side: player.side, dice: [{ kind: "d6", count: 1 }], reason: `Player loss: ${player.name} leaves on 1-${PLAYER_LOSS_MAX_ROLL}` }];
      }
      default:
        return [];
    }
  },
};

/** What the Dedicated Fans roll needs, for the team. */
function fansReason(state: GameState, side: Side): string {
  const team = state.teams[side];
  const result = state.result!;
  if (illegalConcession(result, side)) return `Dedicated Fans (${team.name} conceded): lose a D3`;
  return result.winner === side
    ? `Dedicated Fans (${team.name} won): +1 on ${team.dedicatedFans}+`
    : `Dedicated Fans (${team.name} lost): -1 below ${team.dedicatedFans}`;
}
