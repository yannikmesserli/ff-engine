import type { Ctx, Handler } from "../context";
import type { GameState, PlayerState, Procedure, Square } from "../types";
import { adjacent, ballCarrier, hasTackleZone, isOnPitch, playerAt } from "../pitch";
import { hasSkill } from "../skills";
import { checkTouchdown, getPlayer, squareOf, useOncePerGame } from "./helpers";

type P<T extends Procedure["type"]> = Extract<Procedure, { type: T }>;

/** How often each start-of-activation rule may be used. */
const PERIODS: Record<string, "game" | "half" | "drive"> = {
  "Black Ink": "game",
  "Excuse me, are you a Zoat?": "game",
  "Baleful Hex": "game",
  "Look Into My Eyes": "game",
  "Catch of the Day": "half",
};

/** Baleful Hex works on 2+. */
export const BALEFUL_HEX_TARGET = 2;

/** The D6 a start-of-activation rule rolls after its target is picked, if any. */
const ROLLS: Record<string, { target: number; reason: string }> = {
  "Baleful Hex": { target: BALEFUL_HEX_TARGET, reason: "Baleful Hex" },
  "Look Into My Eyes": { target: 2, reason: "Look Into My Eyes" },
  "Catch of the Day": { target: 3, reason: "Catch of the Day" },
};

/** Rules without a player to pick, and when they can be used. */
const UNTARGETED: Record<string, (state: GameState, player: PlayerState) => boolean> = {
  // A standing player within 3 squares of the ball on the ground.
  "Catch of the Day": (state, player) => {
    const { ball } = state;
    return player.status === "standing" && isOnPitch(player) && !ball.carried && ball.square !== null && Math.max(Math.abs(ball.square.x - player.at.x), Math.abs(ball.square.y - player.at.y)) <= 3;
  },
};

/** The rule ends the player's activation: their action goes no further. */
function endActivation(state: GameState, player: PlayerState) {
  const move = state.stack.findLast((p): p is P<"MoveAction"> => p.type === "MoveAction" && p.playerId === player.id);
  if (move) move.ended = true;
}

/** The player may still use the rule this game, half or drive. */
export function ruleLeft(player: PlayerState, skill: string): boolean {
  if (!hasSkill(player, skill)) return false;
  const period = PERIODS[skill] ?? "game";
  const used = period === "game" ? player.usedThisGame : period === "half" ? player.usedThisHalf : player.usedThisDrive;
  return !used?.includes(skill);
}

/** Spend the rule for its period. */
export function useRule(ctx: Ctx, player: PlayerState, skill: string) {
  const period = PERIODS[skill] ?? "game";
  if (period === "game") return useOncePerGame(ctx, player, skill);
  if (period === "half") player.usedThisHalf = [...(player.usedThisHalf ?? []), skill];
  else player.usedThisDrive = [...(player.usedThisDrive ?? []), skill];
  ctx.emit({ type: "SkillUsed", playerId: player.id, skill });
}

/** Opponents standing next to the player, who they mark (when the player has a tackle zone). */
const marked = (state: GameState, player: PlayerState) =>
  !isOnPitch(player) || !hasTackleZone(player)
    ? []
    : adjacent(player.at).flatMap((s) => {
        const p = playerAt(state, s);
        return p && p.side !== player.side && p.status === "standing" ? [p] : [];
      });

/** Players of the other team on the pitch within `n` squares of the player (counting diagonals as one). */
const opponentsWithin = (state: GameState, player: PlayerState, n: number) =>
  !isOnPitch(player)
    ? []
    : Object.values(state.players).filter(
        (p): p is PlayerState & { at: Square } => p.side !== player.side && isOnPitch(p) && Math.max(Math.abs(p.at.x - player.at.x), Math.abs(p.at.y - player.at.y)) <= n,
      );

/** The targets a start-of-activation rule may pick. */
function targets(state: GameState, player: PlayerState, skill: string): PlayerState[] {
  switch (skill) {
    case "Black Ink":
      return marked(state, player).filter((p) => !p.distracted);
    case "Excuse me, are you a Zoat?":
      return opponentsWithin(state, player, 3).filter((p) => hasTackleZone(p));
    case "Baleful Hex":
      return opponentsWithin(state, player, 5);
    case "Look Into My Eyes":
      return marked(state, player).filter((p) => ballCarrier(state)?.id === p.id);
    default:
      return [];
  }
}

/** The special rules the player may use now, at the start of their activation (see `StartSkill`). */
export function activationSkills(state: GameState, player: PlayerState): string[] {
  return Object.keys(PERIODS).filter((skill) => ruleLeft(player, skill) && (UNTARGETED[skill]?.(state, player) ?? targets(state, player, skill).length > 0));
}

/**
 * Special rules used at the start of an activation:
 * - Black Ink (once per game): an opponent the player marks becomes Distracted until their next activation.
 * - "Excuse me, are you a Zoat?" (once per game): an opponent within 3 squares (with a tackle zone) becomes Distracted.
 * - Baleful Hex (once per game): a D6 against an opponent within 5 squares: on 2+ they become Distracted and cannot be
 *   activated during their team's next turn.
 * - Look Into My Eyes (once per game): a D6 against the opponent with the ball the player marks: on 2+ the player takes
 *   the ball, and their activation ends.
 * - Catch of the Day (once per half): a standing player within 3 squares of the ball on the ground rolls a D6: on 3+ they
 *   pick it up, without a roll; the activation goes on.
 */
export const StartSkill: Handler<P<"StartSkill">> = {
  step(ctx, proc, action) {
    const { state } = ctx;
    const player = getPlayer(ctx, proc.playerId);
    const choices = targets(state, player, proc.skill);
    if (proc.stage === "target" && UNTARGETED[proc.skill]) {
      useRule(ctx, player, proc.skill);
      proc.stage = ROLLS[proc.skill] ? "roll" : "effect";
      if (proc.stage === "roll") return "wait";
    }
    if (proc.stage === "target") {
      if (choices.length === 0) return "done";
      if (action === null) return "wait";
      const { playerIds } = ctx.expect(action, "SELECT_PLAYERS");
      if (playerIds.length === 0) return "done";
      const target = choices.find((p) => p.id === playerIds[0]) ?? ctx.reject("Invalid target.");
      if (playerIds.length > 1) ctx.reject("Choose one player.");
      useRule(ctx, player, proc.skill);
      proc.targetId = target.id;
      proc.stage = ROLLS[proc.skill] ? "roll" : "effect";
      if (proc.stage === "roll") return "wait";
    }
    const target = proc.targetId === undefined ? player : getPlayer(ctx, proc.targetId);
    if (proc.stage === "roll") {
      if (action === null) return "wait";
      const { target: needed, reason } = ROLLS[proc.skill]!;
      const [roll] = ctx.roll(action, [{ kind: "d6", count: 1 }], `${reason} ${needed}+`);
      ctx.emit({ type: "CheckResult", kind: "rule", playerId: player.id, success: roll! >= needed, roll: roll!, target: needed });
      if (roll! < needed) return "done";
      proc.stage = "effect";
    }
    switch (proc.skill) {
      case "Black Ink":
      case "Excuse me, are you a Zoat?":
        target.distracted = true;
        ctx.emit({ type: "DistractedBy", playerId: target.id, byId: player.id, skill: proc.skill });
        return "done";
      case "Baleful Hex":
        target.distracted = true;
        target.hexed = true;
        ctx.emit({ type: "DistractedBy", playerId: target.id, byId: player.id, skill: proc.skill });
        return "done";
      case "Catch of the Day":
        state.ball = { square: { ...squareOf(ctx, player) }, carried: true };
        ctx.emit({ type: "BallCaught", playerId: player.id });
        checkTouchdown(ctx, player);
        return "done";
      case "Look Into My Eyes":
        state.ball = { square: { ...squareOf(ctx, player) }, carried: true };
        ctx.emit({ type: "BallStolen", playerId: player.id, fromId: target.id, skill: proc.skill });
        checkTouchdown(ctx, player);
        endActivation(state, player);
        return "done";
    }
    return "done";
  },
  actions(state, proc) {
    const player = state.players[proc.playerId]!;
    if (proc.stage === "roll") {
      const { target, reason } = ROLLS[proc.skill]!;
      return [{ type: "ROLL", side: player.side, dice: [{ kind: "d6", count: 1 }], reason: `${reason} ${target}+ (${state.players[proc.targetId ?? proc.playerId]!.name})` }];
    }
    const playerIds = targets(state, player, proc.skill).map((p) => p.id);
    return [{ type: "SELECT_PLAYERS", side: player.side, playerIds, max: 1, reason: `${proc.skill}: choose a player` }];
  },
};
