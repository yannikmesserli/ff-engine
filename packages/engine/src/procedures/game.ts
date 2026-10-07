import type { Ctx, Handler } from "../context";
import type { GameState, HalfNumber, PlayerState, Procedure, Side } from "../types";
import { other } from "../pitch";
import { endDrive, resetForKickoff } from "./helpers";
import { secretWeapons } from "./foul";

type P<T extends Procedure["type"]> = Extract<Procedure, { type: T }>;

export const TURNS_PER_HALF = 8;

/** Reset turn counters and team re-rolls (not for overtime: teams keep what is left), then run the half's drives. */
function startHalf(ctx: Ctx, half: HalfNumber, kicking: Side) {
  const { state } = ctx;
  state.half = half;
  for (const team of Object.values(state.teams)) {
    team.turn = 0;
    if (half < 3) {
      team.rerolls = team.rerollsPerHalf;
      team.mascotUsed = false;
    }
  }
  ctx.emit({ type: "HalfStarted", half });
  ctx.push({ type: "Half", half, stage: "driveEnd", kicking, nextSide: other(kicking) });
}

/**
 * Root procedure: pre-game, both halves, then the final result. Overtime (a game option): a draw after the second half
 * gives a third half of 8 turns per team, kicked off by the team that kicked off the first half, without new team
 * re-rolls; a touchdown does not end it early, and a draw after it stands.
 */
export const Game: Handler<P<"Game">> = {
  step(ctx, proc) {
    const { state } = ctx;
    switch (proc.stage) {
      case "pregame":
        ctx.emit({ type: "GameStarted" });
        proc.stage = "half1";
        ctx.push({ type: "Pregame", stage: "fans" }, { type: "CoinToss", stage: "call" });
        return "continue";
      case "half1":
        proc.stage = "half2";
        startHalf(ctx, 1, state.kickingFirstHalf!);
        return "continue";
      case "half2":
        proc.stage = "overtime";
        startHalf(ctx, 2, other(state.kickingFirstHalf!));
        return "continue";
      case "overtime":
        proc.stage = "end";
        if (state.overtime && state.teams.home.score === state.teams.away.score) startHalf(ctx, 3, state.kickingFirstHalf!);
        return "continue";
      case "end": {
        const { home, away } = state.teams;
        state.finished = true;
        ctx.emit({ type: "GameEnded", winner: home.score === away.score ? null : home.score > away.score ? "home" : "away" });
        return "done";
      }
    }
  },
  actions: () => [],
};

/** Home calls heads or tails (coin 1 = heads), the winner chooses to kick or receive. */
export const CoinToss: Handler<P<"CoinToss">> = {
  step(ctx, proc, action) {
    if (action === null) return "wait";
    switch (proc.stage) {
      case "call":
        proc.call = ctx.expect(action, "CALL_COIN").call;
        proc.stage = "flip";
        return "continue";
      case "flip": {
        const [v] = ctx.roll(action, [{ kind: "coin", count: 1 }], "Coin toss");
        const result = v === 1 ? "heads" : "tails";
        proc.winner = result === proc.call ? "home" : "away";
        ctx.emit({ type: "CoinFlipped", call: proc.call!, result, winner: proc.winner });
        proc.stage = "choose";
        return "continue";
      }
      case "choose": {
        const { kick } = ctx.expect(action, "CHOOSE_KICK");
        const kicking = kick ? proc.winner! : other(proc.winner!);
        ctx.state.kickingFirstHalf = kicking;
        ctx.emit({ type: "KickChosen", kicking });
        return "done";
      }
    }
  },
  actions(_state, proc) {
    switch (proc.stage) {
      case "call":
        return [{ type: "CALL_COIN", side: "home" }];
      case "flip":
        return [{ type: "ROLL", side: "home", dice: [{ kind: "coin", count: 1 }], reason: "Coin toss" }];
      case "choose":
        return [{ type: "CHOOSE_KICK", side: proc.winner! }];
    }
  },
};

/**
 * One half as a loop of drives: end the previous drive (effects expire, Secret Weapons sent off, Sweltering Heat), kick
 * off, then alternate team turns until a touchdown (the scoring team kicks next) or both teams played TURNS_PER_HALF
 * turns.
 */
export const Half: Handler<P<"Half">> = {
  step(ctx, proc) {
    const { state } = ctx;
    if (proc.stage === "driveEnd") {
      proc.stage = "kickoff";
      if (state.drive > 0) {
        endDrive(ctx);
        const weapons = secretWeapons(state);
        for (const p of weapons) ctx.emit({ type: "SecretWeaponSpotted", playerId: p.id });
        ctx.push(
          ...(weapons.length > 0 ? [{ type: "SecretWeapon" as const, playerIds: weapons.map((p) => p.id), stage: "argue" as const }] : []),
          ...(state.weather === "sweltering-heat" ? [{ type: "SwelteringHeat" as const }] : []),
        );
      }
      return "continue";
    }
    if (proc.stage === "kickoff") {
      state.drive += 1;
      resetForKickoff(ctx);
      const receiving = other(proc.kicking);
      proc.nextSide = receiving;
      proc.stage = "turns";
      const knockedOut = Object.values(state.players)
        .filter((p) => p.at === "ko")
        .map((p) => p.id);
      ctx.push(
        ...(knockedOut.length > 0 ? [{ type: "KoRecovery" as const, playerIds: knockedOut }] : []),
        { type: "Setup", side: proc.kicking },
        { type: "Setup", side: receiving },
        { type: "Kickoff", kicking: proc.kicking, stage: "place" },
      );
      return "continue";
    }
    if (state.teams[proc.nextSide].turn >= TURNS_PER_HALF) {
      ctx.emit({ type: "HalfEnded", half: proc.half });
      return "done";
    }
    if (state.touchdown) {
      proc.kicking = state.touchdown;
      proc.stage = "driveEnd";
      return "continue";
    }
    ctx.push({ type: "Turn", side: proc.nextSide, stage: "start", used: [] });
    proc.nextSide = other(proc.nextSide);
    return "continue";
  },
  actions: () => [],
};

/** A KO'd player recovers on 4+ (easier with Blitzer's Best Kegs). */
export const KO_RECOVERY_TARGET = 4;

/** Blitzer's Best Kegs: +1 per keg the team bought to its KO recovery rolls (a natural 1 still fails). */
const koRecoveryTarget = (state: GameState, player: PlayerState) =>
  Math.max(2, KO_RECOVERY_TARGET - (state.teams[player.side].inducements.blitzersBestKegs ?? 0));

/** Before each kick-off, every KO'd player rolls a D6: on 4+ (or less with kegs) they return to the reserves. */
export const KoRecovery: Handler<P<"KoRecovery">> = {
  step(ctx, proc, action) {
    const playerId = proc.playerIds[0];
    if (playerId === undefined) return "done";
    if (action === null) return "wait";
    const player = ctx.state.players[playerId]!;
    const target = koRecoveryTarget(ctx.state, player);
    const [roll] = ctx.roll(action, [{ kind: "d6", count: 1 }], `KO recovery ${target}+`);
    // A natural 1 always fails.
    const recovered = roll! > 1 && roll! >= target;
    if (recovered) player.at = "reserves";
    ctx.emit({ type: "KoRecovery", playerId, recovered });
    proc.playerIds.shift();
    return "continue";
  },
  actions(state, proc) {
    const player = state.players[proc.playerIds[0]!]!;
    return [
      {
        type: "ROLL",
        side: player.side,
        dice: [{ kind: "d6", count: 1 }],
        reason: `KO recovery ${koRecoveryTarget(state, player)}+ (${player.name})`,
      },
    ];
  },
};
