import type { Ctx, Handler } from "../context";
import { SCATTER } from "../dice";
import { PITCH_HEIGHT, PITCH_WIDTH, adjacent, ballCarrier, inBounds, isOnPitch, offset, playerAt, sameSquare } from "../pitch";
import { skillName } from "../skills";
import type { GameState, PlayerState, Procedure, Square } from "../types";
import { checkTouchdown, getPlayer } from "./helpers";

type P<T extends Procedure["type"]> = Extract<Procedure, { type: T }>;

export const CARRY_SKILL = "I'll Carry You";

/** Skills the carrier has while carrying their partner. */
const CARRIER_SKILLS = ["Dodge", "Break Tackle"];

/** The variant of I'll Carry You the player has: "carrier" (Grak) or "carried" (Crumbleberry). */
const carryRole = (player: PlayerState) => {
  const skill = player.skills.find((s) => skillName(s) === CARRY_SKILL);
  return skill ? /\((\w+)\)$/.exec(skill)?.[1]?.toLowerCase() : undefined;
};

/**
 * I'll Carry You: the partner a carrier may pick up at the start of their activation, once per half: an adjacent
 * team-mate with the "carried" variant.
 */
export function carryPartner(state: GameState, player: PlayerState): PlayerState | undefined {
  if (carryRole(player) !== "carrier" || player.usedThisHalf?.includes(CARRY_SKILL) || !isOnPitch(player)) return undefined;
  return adjacent(player.at)
    .map((s) => playerAt(state, s))
    .find((p) => p !== undefined && p.side === player.side && carryRole(p) === "carried");
}

/**
 * Pick the partner up: they leave the pitch (with the ball, if they hold it) until the end of the carrier's activation,
 * and the carrier gains Dodge and Break Tackle meanwhile. Returns what the activation must remember.
 */
export function pickUp(ctx: Ctx, carrier: PlayerState, partner: PlayerState) {
  const { state } = ctx;
  const hadBall = ballCarrier(state)?.id === partner.id;
  const status = partner.status;
  partner.at = "carried";
  if (hadBall) state.ball = { square: null, carried: true };
  const skills = CARRIER_SKILLS.filter((s) => !carrier.skills.includes(s));
  carrier.skills.push(...skills);
  carrier.usedThisHalf = [...(carrier.usedThisHalf ?? []), CARRY_SKILL];
  ctx.emit({ type: "SkillUsed", playerId: carrier.id, skill: CARRY_SKILL });
  ctx.emit({ type: "PartnerPickedUp", playerId: carrier.id, partnerId: partner.id });
  return { playerId: partner.id, status, hadBall, skills };
}

/** Where the player is, or the last square they were seen on (a carrier knocked out or hurt during the activation). */
function lastSquare(state: GameState, player: PlayerState): Square | null {
  if (isOnPitch(player)) return player.at;
  for (let i = state.log.length - 1; i >= 0; i--) {
    const e = state.log[i]!;
    if ((e.type === "PlayerMoved" || e.type === "FollowedUp") && e.playerId === player.id) return e.to;
    if (e.type === "PlayerPushed" && e.playerId === player.id) return e.to ?? e.from;
  }
  return null;
}

/** The end of the carrier's activation: they lose the skills carrying gave them, and the partner is put down. */
export function putDown(ctx: Ctx, carrier: PlayerState, carry: { playerId: string; status: PlayerState["status"]; hadBall: boolean; skills: string[] }): Procedure {
  for (const skill of carry.skills) carrier.skills.splice(carrier.skills.lastIndexOf(skill), 1);
  const from = lastSquare(ctx.state, carrier)!;
  return { type: "Carried", carrierId: carrier.id, playerId: carry.playerId, from: { ...from }, status: carry.status, hadBall: carry.hadBall, stage: "place" };
}

/** Free squares next to the carrier, where the partner may be put down. */
const freeSquares = (state: GameState, from: Square) => adjacent(from).filter((s) => !playerAt(state, s));

/** A square on a sideline or in an end zone. */
const atEdge = (s: Square) => s.x === 0 || s.x === PITCH_WIDTH - 1 || s.y === 0 || s.y === PITCH_HEIGHT - 1;

/** The partner goes into the crowd from `from`: an injury roll as for a crowd push, a throw-in if they held the ball, a turnover. */
function intoCrowd(ctx: Ctx, proc: P<"Carried">, partner: PlayerState, from: Square) {
  partner.at = "reserves";
  ctx.emit({ type: "PlayerPushed", playerId: partner.id, from: { ...from }, to: null });
  ctx.push({ type: "Crowd", playerId: partner.id, from: { ...from }, hadBall: proc.hadBall });
  ctx.state.turnover = true;
  return "done" as const;
}

/** Set the partner down on a free square, as they were; the ball comes with them, and a loose ball there bounces. */
function setDown(ctx: Ctx, proc: P<"Carried">, partner: PlayerState, square: Square) {
  const { state } = ctx;
  const loose = state.ball.square && !state.ball.carried && sameSquare(state.ball.square, square);
  partner.at = { ...square };
  ctx.emit({ type: "PlayerMoved", playerId: partner.id, from: { ...proc.from }, to: { ...square } });
  if (proc.hadBall) state.ball = { square: { ...square }, carried: true };
  else if (loose) ctx.push({ type: "Bounce", from: { ...square }, kickoff: false, receiving: null });
}

/** The opponent or team-mate the partner is dropped on is knocked down; one of the carrier's own is a turnover. */
function hit(ctx: Ctx, proc: P<"Carried">, victim: PlayerState) {
  const carrier = ctx.state.players[proc.carrierId]!;
  ctx.push({ type: "KnockDown", playerId: victim.id, turnover: victim.side === carrier.side, stage: "fall" });
}

/**
 * I'll Carry You, at the end of the carrier's activation: the coach puts the partner down, as they were (standing,
 * prone or stunned), in a free square next to the carrier (where the carrier last stood if they left the pitch). With
 * no free square: from a sideline or an end zone, the partner goes into the crowd (a turnover); otherwise the coach
 * drops them on an adjacent player, who is knocked down, and they bounce on (D8, knocking down anyone else they land on)
 * until they come down, knocked down, in a free square.
 */
export const Carried: Handler<P<"Carried">> = {
  step(ctx, proc, action) {
    const { state } = ctx;
    const partner = getPlayer(ctx, proc.playerId);
    if (proc.stage === "place") {
      const free = freeSquares(state, proc.from);
      partner.status = proc.status;
      if (free.length === 1) {
        setDown(ctx, proc, partner, free[0]!);
        checkTouchdown(ctx, partner);
        return "done";
      }
      if (free.length === 0 && atEdge(proc.from)) return intoCrowd(ctx, proc, partner, proc.from);
      if (action === null) return "wait";
      const { square } = ctx.expect(action, "PLACE_CARRIED");
      if (!placeSquares(state, proc).some((s) => sameSquare(s, square))) ctx.reject("Put the player down next to the carrier.");
      if (free.length > 0) {
        setDown(ctx, proc, partner, square);
        checkTouchdown(ctx, partner);
        return "done";
      }
      hit(ctx, proc, playerAt(state, square)!);
      proc.at = { ...square };
      proc.stage = "bounce";
      return "continue";
    }
    if (action === null) return "wait";
    const [d] = ctx.roll(action, [{ kind: "d8", count: 1 }], "Carried player bounces");
    const next = offset(proc.at!, SCATTER[d!]!);
    if (!inBounds(next)) return intoCrowd(ctx, proc, partner, proc.at!);
    const occupant = playerAt(state, next);
    if (occupant) {
      hit(ctx, proc, occupant);
      proc.at = next;
      return "continue";
    }
    partner.status = "standing";
    setDown(ctx, proc, partner, next);
    ctx.push({ type: "KnockDown", playerId: partner.id, turnover: proc.hadBall, stage: "fall", fallsOver: true });
    return "done";
  },
  actions(state, proc) {
    const carrier = state.players[proc.carrierId]!;
    if (proc.stage === "bounce") return [{ type: "ROLL", side: null, dice: [{ kind: "d8", count: 1 }], reason: "Carried player bounces" }];
    return [{ type: "PLACE_CARRIED", side: carrier.side, playerId: proc.playerId, squares: placeSquares(state, proc) }];
  },
};

/** Where the coach may put the partner down: the free squares next to the carrier, or else the occupied ones. */
const placeSquares = (state: GameState, proc: P<"Carried">) => {
  const free = freeSquares(state, proc.from);
  return free.length > 0 ? free : adjacent(proc.from);
};
