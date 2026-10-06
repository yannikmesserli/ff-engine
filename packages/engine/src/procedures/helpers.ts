import type { Ctx } from "../context";
import type { Action, ActionTemplate, GameState, PlayerState, Side, Square, TeamSetup, Weather } from "../types";
import { hasSkill, skillName } from "../skills";
import { inBounds, inHalf, isOnPitch, other, playerAt, sameSquare, scoringEndZoneX, teamPlayers } from "../pitch";

/** The player with this id, or reject the action. */
export function getPlayer(ctx: Ctx, id: string): PlayerState {
  return ctx.state.players[id] ?? ctx.reject(`Unknown player ${id}.`);
}

/** A player of `side` in the reserves, before the kick-off; the id is "<side>-<nr>". */
export function createPlayer(side: Side, p: TeamSetup["players"][number]): PlayerState {
  const { nr, name, position, ma, st, ag, pa, av } = p;
  return {
    nr,
    name,
    position,
    ma,
    st,
    ag,
    pa,
    av,
    skills: [...p.skills],
    keywords: [...(p.keywords ?? [])],
    id: `${side}-${nr}`,
    side,
    at: "reserves",
    status: "standing",
    activated: false,
    movesUsed: 0,
    exhausted: false,
    snack: null,
    nigglingInjuries: p.nigglingInjuries ?? 0,
    casualty: null,
    usedSkills: [],
    distracted: false,
    played: false,
    rooted: false,
  };
}

/** The square of a player on the pitch, or reject the action. */
export function squareOf(ctx: Ctx, player: PlayerState): Square {
  return isOnPitch(player) ? player.at : ctx.reject(`${player.name} is not on the pitch.`);
}

/** How a ball arrives on a square, for `landBall`. */
export interface Landing {
  kickoff: boolean;
  /** Set during the kick-off: leaving the receiving half means a touchback. */
  receiving: Side | null;
  /** A kicked or thrown ball bounces when landing on an empty square; a bouncing ball comes to rest. */
  bounceIfEmpty: boolean;
  /** The ball bounced or scattered: +1 to the catch roll (not for throw-ins). */
  scattered: boolean;
}

/**
 * The ball arrives on a square after a kick, bounce or throw-in: touchback, throw-in from `from` when it left the
 * pitch, a catch by a standing player, or a bounce.
 */
export function landBall(ctx: Ctx, square: Square, from: Square, { kickoff, receiving, bounceIfEmpty, scattered }: Landing) {
  const { state } = ctx;
  if (kickoff && receiving && !inHalf(receiving, square)) {
    state.ball = { square: null, carried: false };
    ctx.push({ type: "Touchback", side: receiving });
    return;
  }
  if (!inBounds(square)) {
    state.ball = { square: null, carried: false };
    ctx.push({ type: "ThrowIn", from });
    return;
  }
  state.ball = { square, carried: false };
  const player = playerAt(state, square);
  if (player?.status === "standing") {
    ctx.push({ type: "Catch", playerId: player.id, kickoff, scattered, stage: "check" });
  } else if (player || bounceIfEmpty) {
    ctx.push({ type: "Bounce", from: square, kickoff, receiving });
  }
}

/** The player stands in the opponents' end zone holding the ball. */
export function inScoringPosition(state: GameState, player: PlayerState): boolean {
  if (!isOnPitch(player) || player.status !== "standing") return false;
  if (!state.ball.carried || !state.ball.square || !sameSquare(state.ball.square, player.at)) return false;
  return player.at.x === scoringEndZoneX(player.side);
}

/**
 * Score a touchdown if the player stands in the opponents' end zone with the ball (in either team's turn). Bloodlust:
 * a thirsty player scores only once they have fed.
 */
export function checkTouchdown(ctx: Ctx, player: PlayerState) {
  const { state } = ctx;
  if (state.activeSide === null || state.touchdown !== null || !inScoringPosition(state, player)) return;
  if (state.stack.some((p) => p.type === "MoveAction" && p.playerId === player.id && p.thirsty)) return;
  state.teams[player.side].score += 1;
  // A touchdown scored in the opponent's turn uses up one of the scoring team's turns.
  if (player.side !== state.activeSide) state.teams[player.side].turn += 1;
  state.touchdown = player.side;
  ctx.emit({ type: "Touchdown", side: player.side, playerId: player.id });
}

/** End of a drive: drive-long effects expire (exhaustion from the previous drive, Dodgy Snack, kick-off bonuses). */
export function endDrive(ctx: Ctx) {
  const { state } = ctx;
  for (const p of Object.values(state.players)) {
    p.exhausted = false;
    if (p.snack) {
      p.ma = p.snack.ma;
      p.av = p.snack.av;
      p.snack = null;
    }
  }
  for (const team of Object.values(state.teams)) {
    team.driveRerolls = 0;
    team.extraAssist = false;
  }
}

/** Disturbing Presence: opponents with the skill on the pitch within 3 squares of the player, even prone or stunned. */
export function disturbingPresences(state: GameState, player: PlayerState): number {
  if (!isOnPitch(player)) return 0;
  const { at } = player;
  return teamPlayers(state, other(player.side)).filter(
    (p) => isOnPitch(p) && hasSkill(p, "Disturbing Presence") && Math.max(Math.abs(p.at.x - at.x), Math.abs(p.at.y - at.y)) <= 3,
  ).length;
}

/** BB2025 weather modifier added to a check roll. */
export function weatherModifier(state: { weather: Weather }, kind: "rush" | "pickup" | "catch"): number {
  if (kind === "rush") return state.weather === "blizzard" ? -1 : 0;
  return state.weather === "pouring-rain" ? -1 : 0;
}

/** Clear the pitch before a kick-off: everyone fit goes back to the reserves. */
export function resetForKickoff(ctx: Ctx) {
  const { state } = ctx;
  for (const p of Object.values(state.players)) {
    if (isOnPitch(p) || p.at === "reserves") {
      p.at = "reserves";
      p.status = "standing";
    }
    p.activated = false;
    p.movesUsed = 0;
    p.distracted = false;
    p.rooted = false;
  }
  state.ball = { square: null, carried: false };
  state.activeSide = null;
  state.activePlayerId = null;
  state.turnover = false;
  state.touchdown = null;
}

/** Team re-rolls left for the drive (Brilliant Coaching) and the half. */
export const rerollsLeft = (state: GameState, side: Side) => state.teams[side].rerolls + state.teams[side].driveRerolls;

/**
 * BB2025: any number of team re-rolls per turn, only in the team's own turn (or while a receiving player makes an On the
 * Ball move at the kick-off), each roll at most once.
 */
export const canTeamReroll = (state: GameState, side: Side, rerolled: boolean) =>
  !rerolled && (state.activeSide === side || movingAtKickoff(state, side)) && rerollsLeft(state, side) > 0;

/** A player of `side` is making an On the Ball move at the kick-off. */
const movingAtKickoff = (state: GameState, side: Side) =>
  state.stack.some((p) => p.type === "OnTheBall" && p.kickoff && p.side === side);

/** Pro: a D6 of 3+ lets the player re-roll the die. */
export const PRO_TARGET = 3;

/** Pro: once per turn, the active player, standing, in their team's turn, may try to re-roll one of their own dice. */
export const canUsePro = (state: GameState, player: PlayerState, rerolled: boolean) =>
  !rerolled && hasSkill(player, "Pro") && !player.usedSkills.includes("Pro") && state.activePlayerId === player.id &&
  state.activeSide === player.side && player.status === "standing";

/** The USE_SKILL template offering Pro, if it can be used. */
export const proTemplate = (state: GameState, player: PlayerState, rerolled: boolean): ActionTemplate[] =>
  canUsePro(state, player, rerolled) ? [{ type: "USE_SKILL", side: player.side, playerId: player.id, skill: "Pro" }] : [];

/** Use Pro: roll the D6 that decides whether the re-roll happens. */
export function rollPro(ctx: Ctx, action: Action, player: PlayerState): boolean {
  player.usedSkills.push("Pro");
  ctx.emit({ type: "SkillUsed", playerId: player.id, skill: "Pro" });
  const [roll] = ctx.roll(action, [{ kind: "d6", count: 1 }], `Pro ${PRO_TARGET}+`);
  const success = roll! >= PRO_TARGET;
  ctx.emit({ type: "CheckResult", kind: "pro", playerId: player.id, success, roll: roll!, target: PRO_TARGET });
  return success;
}

/** The ROLL template of a Pro roll. */
export const proRollTemplate = (player: PlayerState): ActionTemplate => ({
  type: "ROLL",
  side: player.side,
  dice: [{ kind: "d6", count: 1 }],
  reason: `Pro ${PRO_TARGET}+ (${player.name})`,
});

/** Spend a team re-roll, drive re-rolls first. */
export function useTeamReroll(ctx: Ctx, side: Side) {
  const team = ctx.state.teams[side];
  if (team.driveRerolls > 0) team.driveRerolls -= 1;
  else team.rerolls -= 1;
  ctx.emit({ type: "RerollUsed", side });
}

/** Loner(X): the D6 roll a player needs to use a team re-roll, or null without Loner. */
export function lonerTarget(player: PlayerState): number | null {
  const loner = player.skills.find((s) => skillName(s) === "Loner");
  if (!loner) return null;
  return Number(/\((\d)\+?\)/.exec(loner)?.[1] ?? 4);
}

const lonerReason = (player: PlayerState) => `Loner ${lonerTarget(player)}+ (${player.name})`;

/** The ROLL template of a Loner roll. */
export const lonerRollTemplate = (player: PlayerState): ActionTemplate => ({
  type: "ROLL",
  side: player.side,
  dice: [{ kind: "d6", count: 1 }],
  reason: lonerReason(player),
});

/** Roll for Loner after spending a team re-roll: on a failure the re-roll is lost and the first result stands. */
export function rollLoner(ctx: Ctx, action: Action, player: PlayerState): boolean {
  const target = lonerTarget(player)!;
  const [roll] = ctx.roll(action, [{ kind: "d6", count: 1 }], lonerReason(player));
  const success = roll! >= target;
  ctx.emit({ type: "CheckResult", kind: "loner", playerId: player.id, success, roll: roll!, target });
  return success;
}
