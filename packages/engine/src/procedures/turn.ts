import type { Ctx, Handler } from "../context";
import type { CheckKind, GameState, PlayerActionType, PlayerState, Procedure, Side, Square } from "../types";
import { adjacent, ballCarrier, inBounds, isOnPitch, other, playerAt, sameSquare, tackleZones, teamPlayers } from "../pitch";
import { blockDice } from "./block";
import { handOffTargets, throwTargets } from "./pass";
import { foulTargets } from "./foul";
import { hasSkill } from "../skills";
import { checkTouchdown, getPlayer, squareOf, weatherModifier } from "./helpers";
import { isStalling } from "./stalling";

type P<T extends Procedure["type"]> = Extract<Procedure, { type: T }>;

/** Secure the Ball picks up the ball on this roll instead of the player's AG. */
export const SECURE_TARGET = 2;
/** Squares a player may Rush beyond their MA. */
export const RUSH_SQUARES = 2;
export const RUSH_TARGET = 2;
/** Movement spent standing up (all of it for players with less MA). */
export const STAND_UP_COST = 3;
/** Players with MA below the stand-up cost need this roll to stand up. */
export const STAND_UP_TARGET = 4;

/** Team actions that can only be declared once per turn. */
const ONCE_PER_TURN: PlayerActionType[] = ["blitz", "pass", "handoff", "foul", "secure"];

/** The innermost player activation on the stack. */
const activation = (state: GameState) => state.stack.findLast((p): p is P<"MoveAction"> => p.type === "MoveAction");

/** The player is in a Secure the Ball action. */
const securing = (state: GameState, player: PlayerState) => {
  const a = activation(state);
  return a?.action === "secure" && a.playerId === player.id;
};

/**
 * Squares a jump can pass over on the way from `from` to `to` (two squares away): the middle square, or both
 * candidates when the jump is a knight-like move.
 */
function jumpedSquares(from: Square, to: Square): Square[] {
  const steps = (d: number) => (Math.abs(d) === 2 ? [d / 2] : Math.abs(d) === 1 ? [d, 0] : [0]);
  return steps(to.x - from.x).flatMap((dx) => steps(to.y - from.y).map((dy) => ({ x: from.x + dx, y: from.y + dy })));
}

/** A jump goes two squares, over a prone or stunned player (either team), into an empty square. */
function jumpSquares(state: GameState, player: PlayerState & { at: Square }): Square[] {
  if (hasSkill(player, "Ball & Chain")) return [];
  const squares: Square[] = [];
  for (let dy = -2; dy <= 2; dy++) {
    for (let dx = -2; dx <= 2; dx++) {
      if (Math.max(Math.abs(dx), Math.abs(dy)) !== 2) continue;
      const to = { x: player.at.x + dx, y: player.at.y + dy };
      if (!inBounds(to) || playerAt(state, to)) continue;
      const over = jumpedSquares(player.at, to).map((s) => playerAt(state, s));
      if (over.some((p) => p !== undefined && p.status !== "standing")) squares.push(to);
    }
  }
  return squares;
}

/** Jump roll modifier: -1 per tackle zone on the square left or the one landed in, whichever has more. */
const jumpModifier = (state: GameState, player: PlayerState, from: Square, to: Square) =>
  -Math.max(tackleZones(state, player.side, from), tackleZones(state, player.side, to));

/** Squares a player in a Move action may step (or jump) to, with the rolls each move requires. */
export function legalMoves(state: GameState, player: PlayerState): Array<Square & { rolls: CheckKind[]; jump?: boolean }> {
  if (!isOnPitch(player) || player.status !== "standing") return [];
  const left = player.ma + RUSH_SQUARES - player.movesUsed;
  if (left <= 0) return [];
  const { ball } = state;
  const pickup = (s: Square): CheckKind[] => (ball.square && !ball.carried && sameSquare(ball.square, s) ? ["pickup"] : []);
  const rushes = (squares: number): CheckKind[] =>
    Array.from({ length: Math.max(0, Math.min(squares, player.movesUsed + squares - player.ma)) }, () => "rush" as const);
  const dodge: CheckKind[] = tackleZones(state, player.side, player.at) > 0 ? ["dodge"] : [];
  const steps = adjacent(player.at)
    .filter((s) => !playerAt(state, s))
    .map((s) => ({ ...s, rolls: [...rushes(1), ...dodge, ...pickup(s)] }));
  if (left < 2) return steps;
  const jumps = jumpSquares(state, player).map((s) => ({ ...s, jump: true, rolls: [...rushes(2), "jump" as const, ...pickup(s)] }));
  return [...steps, ...jumps];
}

/** The last Check (stand-up, rush, dodge, pick-up) failed, after any re-roll. */
const failed = (ctx: Ctx) => ctx.state.lastCheck !== null && !ctx.state.lastCheck.success;

/** On the pitch, not yet activated, and standing or prone (stunned players cannot act). */
const canAct = (p: PlayerState) => isOnPitch(p) && !p.activated && (p.status === "standing" || p.status === "prone");

/** End of a team turn or Charge: emit the event and clear the active side, player and turnover. */
function endTurn(ctx: Ctx, proc: P<"Turn">) {
  const { state } = ctx;
  const { side } = proc;
  // Cheering Fans only lasts until the end of the team's next turn.
  if (!proc.charge) state.teams[side].extraAssist = false;
  ctx.emit(proc.charge ? { type: "ChargeEnded", side } : { type: "TurnEnded", side, turnover: state.turnover });
  state.activeSide = null;
  state.activePlayerId = null;
  state.turnover = false;
}

/** A team turn (or a Charge): players declare actions one at a time until END_TURN, a turnover or a touchdown. */
export const Turn: Handler<P<"Turn">> = {
  step(ctx, proc, action) {
    const { state } = ctx;
    if (proc.stage === "start" && proc.charge) {
      // Charge: only the chosen players act; it is not a team turn (no turn counter, no stunned recovery).
      for (const p of teamPlayers(state, proc.side)) {
        p.activated = !proc.charge.includes(p.id);
        p.movesUsed = 0;
      }
      state.activeSide = proc.side;
      ctx.emit({ type: "ChargeStarted", side: proc.side, playerIds: proc.charge });
      proc.stage = "main";
      return "continue";
    }
    if (proc.stage === "start") {
      const team = state.teams[proc.side];
      team.turn += 1;
      for (const p of teamPlayers(state, proc.side)) {
        p.activated = false;
        p.movesUsed = 0;
        p.usedSkills = [];
        // Stunned players turn face up but cannot act this turn.
        if (p.status === "stunned") {
          p.status = "prone";
          p.activated = true;
        }
      }
      state.activeSide = proc.side;
      ctx.emit({ type: "TurnStarted", side: proc.side, turn: team.turn });
      proc.stage = "main";
      return "continue";
    }
    if (state.turnover || state.touchdown || proc.ending) {
      endTurn(ctx, proc);
      return "done";
    }
    if (action === null) return "wait";
    const a = ctx.expect(action, "START_ACTION", "END_TURN");
    if (a.type === "END_TURN") {
      // Ending the turn without activating a stalling ball carrier also gets them a rock.
      const staller = proc.charge ? undefined : teamPlayers(state, proc.side).find((p) => !p.activated && isStalling(state, p));
      if (!staller) {
        endTurn(ctx, proc);
        return "done";
      }
      ctx.emit({ type: "StallingDetected", playerId: staller.id });
      ctx.push({ type: "Stalling", playerId: staller.id });
      proc.ending = true;
      return "continue";
    }
    const player = getPlayer(ctx, a.playerId);
    if (player.side !== proc.side) ctx.reject(`${player.name} is not in the acting team.`);
    const allowed = declarableActions(state, proc, player);
    if (!allowed.includes(a.action)) ctx.reject(`${player.name} cannot declare a ${a.action} action.`);
    if (a.action === "blitz" && !blitzTargets(state, proc.side).some((p) => p.id === a.targetId)) {
      ctx.reject("A Blitz must name a standing opponent as its target.");
    }
    if (ONCE_PER_TURN.includes(a.action)) proc.used.push(a.action);
    state.activePlayerId = player.id;
    ctx.emit({ type: "ActionDeclared", playerId: player.id, action: a.action, ...(a.targetId ? { targetId: a.targetId } : {}) });
    ctx.push({
      type: "MoveAction",
      playerId: player.id,
      stage: "start",
      action: a.action,
      ...(a.action === "blitz" ? { targetId: a.targetId! } : {}),
    });
    return "continue";
  },
  actions(state, proc) {
    if (proc.stage !== "main") return [];
    const choices = teamPlayers(state, proc.side)
      .map((p) => ({ playerId: p.id, actions: declarableActions(state, proc, p) }))
      .filter((c) => c.actions.length > 0);
    return [
      { type: "START_ACTION", side: proc.side, choices, blitzTargets: blitzTargets(state, proc.side).map((p) => p.id) },
      { type: "END_TURN", side: proc.side },
    ];
  },
};

/** Opponents of `side` standing on the pitch. */
const standingOpponents = (state: GameState, side: Side) =>
  teamPlayers(state, other(side)).filter((p): p is PlayerState & { at: Square } => isOnPitch(p) && p.status === "standing");

/** A Blitz may name any standing opponent as its target. */
export const blitzTargets = standingOpponents;

/** Opponents a standing player could block right now. */
export const adjacentTargets = (state: GameState, player: PlayerState) =>
  isOnPitch(player) ? standingOpponents(state, player.side).filter((o) => adjacent(player.at).some((s) => sameSquare(s, o.at))) : [];

/** The ball is on the pitch and either loose or held by this player. */
function ballAvailable(state: GameState, player: PlayerState) {
  const { square, carried } = state.ball;
  if (!square) return false;
  return !carried || (isOnPitch(player) && sameSquare(square, player.at));
}

/** Secure the Ball: a loose ball with no standing opponent within two squares; not for Big Guys. */
function canSecure(state: GameState, player: PlayerState) {
  const { square, carried } = state.ball;
  if (!square || carried) return false;
  if (player.keywords.includes("big guy") || hasSkill(player, "Unsteady") || hasSkill(player, "Ball & Chain")) return false;
  return !standingOpponents(state, player.side).some((o) => Math.max(Math.abs(o.at.x - square.x), Math.abs(o.at.y - square.y)) <= 2);
}

/**
 * Actions the player may declare: Block needs a standing player next to a standing opponent;
 * Blitz, Pass, Hand-off, Foul and Secure the Ball are once per turn. A Charge (kick-off event) only allows Move and Blitz.
 */
export function declarableActions(state: GameState, proc: P<"Turn">, player: PlayerState): PlayerActionType[] {
  if (!canAct(player)) return [];
  const actions: PlayerActionType[] = ["move"];
  const free = (a: PlayerActionType) => !proc.used.includes(a);
  if (!proc.charge && player.status === "standing" && adjacentTargets(state, player).length > 0) actions.push("block");
  if (free("blitz") && blitzTargets(state, player.side).length > 0) actions.push("blitz");
  if (proc.charge) return actions;
  if (free("pass") && ballAvailable(state, player)) actions.push("pass");
  if (free("handoff") && ballAvailable(state, player)) actions.push("handoff");
  if (free("secure") && canSecure(state, player)) actions.push("secure");
  // A Foul can be declared as long as an opponent is prone or stunned somewhere on the pitch.
  const foulable = teamPlayers(state, other(player.side)).some((o) => isOnPitch(o) && o.status !== "standing");
  if (free("foul") && foulable) actions.push("foul");
  return actions;
}

/**
 * One player activation: stand up if prone, then step, block, throw, hand off or
 * foul according to the declared action, until the player ends it or nothing is left to do.
 */
export const MoveAction: Handler<P<"MoveAction">> = {
  step(ctx, proc, action) {
    const { state } = ctx;
    const player = getPlayer(ctx, proc.playerId);
    if (proc.stage === "start") {
      player.activated = true;
      player.movesUsed = 0;
      if (isStalling(state, player)) {
        proc.stalling = true;
        ctx.emit({ type: "StallingDetected", playerId: player.id });
      }
      proc.stage = "standup";
      state.lastCheck = null;
      if (player.status === "prone" && player.ma < STAND_UP_COST) {
        ctx.push({ type: "Check", kind: "standup", playerId: player.id, target: STAND_UP_TARGET, modifier: 0, stage: "roll", rerolled: false });
      }
      return "continue";
    }
    if (proc.stage === "standup") {
      if (player.status === "prone") {
        // A failed stand-up roll ends the action, but is not a turnover.
        if (failed(ctx)) {
          state.activePlayerId = null;
          return "done";
        }
        player.status = "standing";
        player.movesUsed = Math.min(STAND_UP_COST, player.ma);
        ctx.emit({ type: "PlayerStoodUp", playerId: player.id });
      }
      proc.stage = "main";
      return "continue";
    }
    const finished =
      proc.finished ||
      state.turnover ||
      state.touchdown !== null ||
      !isOnPitch(player) ||
      (activationMoves(state, proc).length === 0 &&
        activationTargets(state, proc).length === 0 &&
        throwOptions(state, proc).length === 0 &&
        handOffOptions(state, proc).length === 0 &&
        foulOptions(state, proc).length === 0);
    if (finished) return endActivation(ctx, proc, player);
    if (action === null) return "wait";
    const a = ctx.expect(action, "MOVE", "BLOCK", "THROW", "HAND_OFF", "FOUL", "END_PLAYER_ACTION");
    if (a.type === "END_PLAYER_ACTION") return endActivation(ctx, proc, player);
    if (a.type === "THROW") {
      const square = throwOptions(state, proc).find((s) => sameSquare(s, a.square)) ?? ctx.reject("Cannot throw there.");
      proc.finished = true;
      ctx.emit({ type: "PassThrown", playerId: player.id, target: { x: square.x, y: square.y }, range: square.range });
      ctx.push({ type: "Pass", throwerId: player.id, target: { x: square.x, y: square.y }, range: square.range, stage: "roll", rerolled: false });
      return "continue";
    }
    if (a.type === "FOUL") {
      const target = foulOptions(state, proc).find((t) => t.playerId === a.targetId) ?? ctx.reject("Cannot foul this player.");
      proc.finished = true;
      ctx.emit({ type: "Fouled", foulerId: player.id, victimId: target.playerId, assists: target.assists });
      ctx.push({ type: "Foul", foulerId: player.id, victimId: target.playerId, assists: target.assists, stage: "armour" });
      return "continue";
    }
    if (a.type === "HAND_OFF") {
      if (!handOffOptions(state, proc).some((p) => p.id === a.targetId)) ctx.reject("Cannot hand off to this player.");
      proc.finished = true;
      ctx.push({ type: "HandOff", throwerId: player.id, catcherId: a.targetId, stage: "catch" });
      return "continue";
    }
    if (a.type === "BLOCK") {
      const target = activationTargets(state, proc).find((t) => t.id === a.targetId) ?? ctx.reject("Illegal block target.");
      proc.blocked = true;
      const dice = blockDice(state, player, target);
      // Cheering Fans: the extra assist is used up by the team's first block.
      state.teams[player.side].extraAssist = false;
      ctx.emit({ type: "BlockDeclared", attackerId: player.id, defenderId: target.id, dice });
      ctx.push({
        type: "Block",
        attackerId: player.id,
        defenderId: target.id,
        blitz: proc.action === "blitz",
        stage: proc.action === "blitz" ? "rush" : "roll",
        dice,
        rerolled: false,
        chain: [],
      });
      return "continue";
    }
    if (!activationMoves(state, proc).some((s) => sameSquare(s, a.square))) ctx.reject("Illegal move.");
    const jump = Math.max(Math.abs(a.square.x - player.at.x), Math.abs(a.square.y - player.at.y)) === 2;
    ctx.push({ type: "MoveStep", playerId: player.id, to: { ...a.square }, stage: "rush", ...(jump ? { jump } : {}) });
    return "continue";
  },
  actions(state, proc) {
    const player = state.players[proc.playerId]!;
    const targets = activationTargets(state, proc).map((t) => ({ playerId: t.id, dice: blockDice(state, player, t) }));
    const throws = throwOptions(state, proc);
    const handOffs = handOffOptions(state, proc).map((p) => p.id);
    const fouls = foulOptions(state, proc);
    return [
      ...(proc.action === "block" ? [] : [{ type: "MOVE" as const, side: player.side, playerId: player.id, squares: legalMoves(state, player) }]),
      ...(targets.length > 0 ? [{ type: "BLOCK" as const, side: player.side, playerId: player.id, targets }] : []),
      ...(throws.length > 0 ? [{ type: "THROW" as const, side: player.side, playerId: player.id, squares: throws }] : []),
      ...(handOffs.length > 0 ? [{ type: "HAND_OFF" as const, side: player.side, playerId: player.id, playerIds: handOffs }] : []),
      ...(fouls.length > 0 ? [{ type: "FOUL" as const, side: player.side, playerId: player.id, targets: fouls }] : []),
      { type: "END_PLAYER_ACTION", side: player.side },
    ];
  },
};

const holdsBall = (state: GameState, player: PlayerState) => ballCarrier(state)?.id === player.id;

/** End the activation; Secure the Ball is a turnover when the player does not end up holding the ball. */
function endActivation(ctx: Ctx, proc: P<"MoveAction">, player: PlayerState) {
  const { state } = ctx;
  if (proc.action === "secure" && !state.turnover && state.touchdown === null && !holdsBall(state, player)) {
    state.turnover = true;
  }
  // A stalling player who still holds the ball, standing, without scoring, gets a rock from the crowd.
  if (proc.stalling && state.touchdown === null && player.status === "standing" && holdsBall(state, player)) {
    ctx.push({ type: "Stalling", playerId: player.id });
  }
  state.activePlayerId = null;
  return "done" as const;
}

const foulOptions = (state: GameState, proc: P<"MoveAction">) =>
  proc.action === "foul" && !proc.finished ? foulTargets(state, state.players[proc.playerId]!) : [];

/** The active player, if this activation still lets them throw or hand off the ball they are holding. */
function releasingBall(state: GameState, proc: P<"MoveAction">, action: "pass" | "handoff") {
  const player = state.players[proc.playerId]!;
  return proc.action === action && !proc.finished && player.status === "standing" && holdsBall(state, player) ? player : null;
}

const throwOptions = (state: GameState, proc: P<"MoveAction">) => {
  const player = releasingBall(state, proc, "pass");
  return player ? throwTargets(state, player) : [];
};

const handOffOptions = (state: GameState, proc: P<"MoveAction">) => {
  const player = releasingBall(state, proc, "handoff");
  return player ? handOffTargets(state, player) : [];
};

/** A Block action does not move; Move and Blitz actions do. */
const activationMoves = (state: GameState, proc: P<"MoveAction">) =>
  proc.action === "block" || proc.finished ? [] : legalMoves(state, state.players[proc.playerId]!);

/** Who the active player may block now: anyone adjacent for a Block, the declared target once for a Blitz. */
function activationTargets(state: GameState, proc: P<"MoveAction">) {
  const player = state.players[proc.playerId]!;
  if (proc.blocked || player.status !== "standing") return [];
  if (proc.action === "block") return adjacentTargets(state, player);
  if (proc.action !== "blitz" || player.movesUsed >= player.ma + RUSH_SQUARES) return [];
  return adjacentTargets(state, player).filter((t) => t.id === proc.targetId);
}

/** Step a player (and the ball they carry) to an adjacent square, spending one square of movement. */
function movePlayer(ctx: Ctx, player: PlayerState, to: Square, squares = 1) {
  const from = squareOf(ctx, player);
  const { ball } = ctx.state;
  if (ball.carried && ball.square && sameSquare(ball.square, from)) ball.square = { ...to };
  player.at = { ...to };
  player.movesUsed += squares;
  ctx.emit({ type: "PlayerMoved", playerId: player.id, from: { ...from }, to: { ...to } });
}

/**
 * One move: Rush, then Dodge, then the step itself and an optional pick-up. A jump uses two squares (a Rush for each
 * one past MA) and a Jump roll instead of the Dodge; a failed Rush or a natural 1 on the Jump falls in the starting
 * square, any other failed Jump in the target square.
 */
export const MoveStep: Handler<P<"MoveStep">> = {
  step(ctx, proc) {
    const { state } = ctx;
    const player = getPlayer(ctx, proc.playerId);
    const squares = proc.jump ? 2 : 1;
    const check = (kind: CheckKind, target: number, modifier: number) =>
      ctx.push({ type: "Check", kind, playerId: player.id, target, modifier, stage: "roll", rerolled: false });
    const fall = (inStartSquare = false) => {
      if (!inStartSquare) movePlayer(ctx, player, proc.to, squares);
      ctx.push({ type: "KnockDown", playerId: player.id, turnover: true, stage: "fall" });
      return "done" as const;
    };

    switch (proc.stage) {
      case "rush":
        state.lastCheck = null;
        proc.stage = proc.jump ? "rush2" : "dodge";
        if (player.movesUsed >= player.ma) check("rush", RUSH_TARGET, weatherModifier(state, "rush"));
        return "continue";
      case "rush2":
        if (failed(ctx)) return fall(true);
        state.lastCheck = null;
        proc.stage = "dodge";
        if (player.movesUsed + 1 >= player.ma) check("rush", RUSH_TARGET, weatherModifier(state, "rush"));
        return "continue";
      case "dodge":
        if (failed(ctx)) return fall(proc.jump);
        state.lastCheck = null;
        proc.stage = "move";
        if (proc.jump) {
          check("jump", player.ag, jumpModifier(state, player, squareOf(ctx, player), proc.to));
        } else if (tackleZones(state, player.side, squareOf(ctx, player)) > 0) {
          // Stunty: tackle zones on the square moved to do not count.
          check("dodge", player.ag, hasSkill(player, "Stunty") ? 0 : -tackleZones(state, player.side, proc.to));
        }
        return "continue";
      case "move": {
        if (failed(ctx)) return fall(proc.jump && state.lastCheck?.roll === 1);
        movePlayer(ctx, player, proc.to, squares);
        const { ball } = state;
        if (ball.square && !ball.carried && sameSquare(ball.square, proc.to)) {
          state.lastCheck = null;
          proc.stage = "pickup";
          // Secure the Ball picks up on a 2+ instead of the player's AG.
          const target = securing(state, player) ? SECURE_TARGET : player.ag;
          check("pickup", target, -tackleZones(state, player.side, proc.to) + weatherModifier(state, "pickup"));
          return "continue";
        }
        checkTouchdown(ctx, player);
        return "done";
      }
      case "pickup":
        if (failed(ctx)) {
          state.turnover = true;
          ctx.push({ type: "Bounce", from: { ...proc.to }, kickoff: false, receiving: null });
          return "done";
        }
        state.ball.carried = true;
        ctx.emit({ type: "BallPickedUp", playerId: player.id });
        if (securing(state, player)) {
          ctx.emit({ type: "BallSecured", playerId: player.id });
          activation(state)!.finished = true;
        }
        checkTouchdown(ctx, player);
        return "done";
    }
  },
  actions: () => [],
};
