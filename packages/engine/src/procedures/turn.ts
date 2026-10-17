import type { Ctx, Handler, StepResult } from "../context";
import type { Action, CheckKind, GameState, PlayerActionType, PlayerState, Procedure, Side, Square, Weather } from "../types";
import { templateDirection } from "../dice";
import { weatherFor } from "./kickoff";
import { trapdoor } from "./prayers";
import { adjacent, ballCarrier, hasTackleZone, inBounds, inHalf, isOnPitch, isPinned, other, playerAt, sameSquare, tackleZoneAt, tackleZones, teamPlayers } from "../pitch";
import { blockDice, dumpOff, revolted, rollFoulAppearance } from "./block";
import { dropBall } from "./ball";
import { canHailMary, hailMaryNeeded, handOffTargets, puntTargets, throwTargets } from "./pass";
import { foulTargets } from "./foul";
import { hasSkill, skillValue } from "../skills";
import { CARRY_SKILL, carryPartner, pickUp, putDown } from "./carry";
import { checkTouchdown, getPlayer, useOncePerGame, inducementsLeft, inScoringPosition, pickupModifier, rushModifier, spendInducement, squareOf } from "./helpers";
import { isStalling } from "./stalling";
import { TURNS_PER_HALF } from "./game";
import { teamMateTargets, throwableTeamMates } from "./ttm";
import { activationSkills, loseGainedSkills, loseTurnSkills } from "./starts";

type P<T extends Procedure["type"]> = Extract<Procedure, { type: T }>;

/** Secure the Ball picks up the ball on this roll instead of the player's AG. */
export const SECURE_TARGET = 2;
/** Squares a player may Rush beyond their MA (Sprint: one more). */
export const RUSH_SQUARES = 2;
/** MA plus the Rushes the player may make: Sprint adds a third Rush. */
export const maxMoves = (player: PlayerState) => player.ma + RUSH_SQUARES + (hasSkill(player, "Sprint") ? 1 : 0);
export const RUSH_TARGET = 2;
/** Movement spent standing up (all of it for players with less MA). */
export const STAND_UP_COST = 3;
/** Players with MA below the stand-up cost need this roll to stand up. */
export const STAND_UP_TARGET = 4;
/** Jump Up: +1 to the AG roll to stand up and block. */
const JUMP_UP_MODIFIER = 1;
/** Bone Head fails on a 1. */
export const BONE_HEAD_TARGET = 2;
/** Really Stupid fails on 1-3, or only on a 1 with a team-mate (without Really Stupid) standing next to the player. */
export const REALLY_STUPID_TARGET = 4;
export const REALLY_STUPID_HELPED_TARGET = 2;
/** Take Root fails on a 1. */
export const TAKE_ROOT_TARGET = 2;
/** Animal Savagery and Unchannelled Fury fail on 1-3, or only on a 1 for a Block or Blitz action (+2 to the roll). */
export const FURY_TARGET = 4;
export const FURY_BLOCK_TARGET = 2;

/** Team actions that can only be declared once per turn. */
const ONCE_PER_TURN: PlayerActionType[] = ["blitz", "pass", "handoff", "foul", "secure", "ttm", "ktm", "bomb", "punt"];

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

/**
 * A jump goes two squares, over a prone or stunned player (either team), into an empty square. Leap, Pogo: over any
 * square, empty or not.
 */
function jumpSquares(state: GameState, player: PlayerState & { at: Square }): Square[] {
  if (hasSkill(player, "Ball & Chain")) return [];
  const leaps = hasSkill(player, "Pogo") || hasSkill(player, "Leap");
  const squares: Square[] = [];
  for (let dy = -2; dy <= 2; dy++) {
    for (let dx = -2; dx <= 2; dx++) {
      if (Math.max(Math.abs(dx), Math.abs(dy)) !== 2) continue;
      const to = { x: player.at.x + dx, y: player.at.y + dy };
      if (!inBounds(to) || playerAt(state, to)) continue;
      const over = jumpedSquares(player.at, to).map((s) => playerAt(state, s));
      if (leaps || over.some((p) => p !== undefined && p.status !== "standing")) squares.push(to);
    }
  }
  return squares;
}

/** Prehensile Tail: opponents with the skill marking the square a player leaves, -1 each to Dodge and Jump rolls. */
const prehensileTails = (state: GameState, player: PlayerState, from: Square) =>
  adjacent(from).filter((s) => {
    const marker = tackleZoneAt(state, s);
    return marker !== undefined && marker.side !== player.side && hasSkill(marker, "Prehensile Tail");
  }).length;

/**
 * Jump roll modifier: -1 per tackle zone on the square left or the one landed in, whichever has more; Prehensile Tail.
 * Pogo ignores both; Leap reduces the total by 1, but not below -1. Very Long Legs: +1.
 */
function jumpModifier(state: GameState, player: PlayerState, from: Square, to: Square): number {
  const legs = hasSkill(player, "Very Long Legs") ? 1 : 0;
  if (hasSkill(player, "Pogo")) return legs;
  const penalty = Math.max(tackleZones(state, player.side, from), tackleZones(state, player.side, to)) + prehensileTails(state, player, from);
  return -(hasSkill(player, "Leap") && penalty > 1 ? penalty - 1 : penalty) + legs;
}

/**
 * Dodge roll modifier from `from` to `to`: -1 per opponent's tackle zone on the square moved to (none for Stunty; Titchy
 * opponents do not count), -1 per Prehensile Tail marking the square left, +1 for a Titchy player, +1 with Two Heads.
 */
export function dodgeModifier(state: GameState, player: PlayerState, from: Square, to: Square): number {
  const zones = hasSkill(player, "Stunty")
    ? 0
    : adjacent(to).filter((s) => {
        const marker = tackleZoneAt(state, s);
        return marker !== undefined && marker.side !== player.side && !hasSkill(marker, "Titchy");
      }).length;
  return -zones - prehensileTails(state, player, from) + (hasSkill(player, "Titchy") ? 1 : 0) + (hasSkill(player, "Two Heads") ? 1 : 0);
}

/** Squares a player in a Move action may step (or jump) to, with the rolls each move requires. */
export function legalMoves(state: GameState, player: PlayerState): Array<Square & { rolls: CheckKind[]; jump?: boolean }> {
  if (!isOnPitch(player) || player.status !== "standing" || isPinned(state, player)) return [];
  const left = maxMoves(player) - player.movesUsed;
  if (left <= 0) return [];
  // Ball & Chain: one of the four squares next to the player (occupied or not) gives the side the template faces.
  if (hasSkill(player, "Ball & Chain")) return chainSides(player).map((s) => ({ ...s, rolls: player.movesUsed >= player.ma ? ["rush" as const] : [] }));
  const { ball } = state;
  const pickup = (s: Square): CheckKind[] => (ball.square && !ball.carried && sameSquare(ball.square, s) ? ["pickup"] : []);
  const rushes = (squares: number): CheckKind[] =>
    Array.from({ length: Math.max(0, Math.min(squares, player.movesUsed + squares - player.ma)) }, () => "rush" as const);
  const dodge: CheckKind[] = tackleZones(state, player.side, player.at) > 0 && !player.incorporeal ? ["dodge"] : [];
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
  // Shadowing is counted per turn of the moving team.
  for (const p of teamPlayers(state, other(side))) p.usedSkills = p.usedSkills.filter((s) => s !== "Shadowing");
  ctx.emit(proc.charge ? { type: "ChargeEnded", side } : { type: "TurnEnded", side, turnover: state.turnover });
  // Pick-me-up, unless a touchdown ends the drive or the half is over.
  const halfOver = state.teams.home.turn >= TURNS_PER_HALF && state.teams.away.turn >= TURNS_PER_HALF;
  const pickUps = pickMeUpCandidates(state, other(side));
  if (!proc.charge && state.touchdown === null && !halfOver && pickUps.length > 0) {
    ctx.push({ type: "PickMeUp", side: other(side), playerIds: pickUps, selected: [], stage: "select" });
  }
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
      // Skills gained until the end of the turn (Wisdom of the White Dwarf) are lost.
      for (const p of Object.values(state.players)) loseTurnSkills(p);
      for (const p of teamPlayers(state, proc.side)) {
        p.activated = false;
        p.movesUsed = 0;
        p.usedSkills = [];
        // Stunned players turn face up but cannot act this turn.
        if (p.status === "stunned") {
          p.status = "prone";
          p.activated = true;
        }
        loseGainedSkills(p);
        // Baleful Hex: the player misses this turn.
        if (p.hexed) {
          p.activated = true;
          delete p.hexed;
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
    const a = ctx.expect(action, "START_ACTION", "END_TURN", "WEATHER_MAGE");
    if (a.type === "WEATHER_MAGE") {
      if (!weatherMageAvailable(state, proc)) ctx.reject("The Weather Mage can only be used at the start of the team's turn.");
      spendInducement(ctx, proc.side, "weatherMage");
      ctx.push({ type: "WeatherMage", side: proc.side, stage: "roll" });
      return "continue";
    }
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
    // Sneakiest of the Lot: the player's Foul does not use up the team's Foul action.
    if (ONCE_PER_TURN.includes(a.action) && !(a.action === "foul" && hasSkill(player, "Sneakiest of the Lot"))) proc.used.push(a.action);
    proc.acted = true;
    state.activePlayerId = player.id;
    ctx.emit({ type: "ActionDeclared", playerId: player.id, action: a.action, ...(a.targetId ? { targetId: a.targetId } : {}) });
    // Dump-off: the Blitz target may pass as soon as they are named, before the blitzer does anything.
    const dumpOff: Procedure[] = a.action === "blitz" ? [{ type: "DumpOff", attackerId: player.id, defenderId: a.targetId!, declared: true }] : [];
    ctx.push(...dumpOff, {
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
      ...(weatherMageAvailable(state, proc) ? [{ type: "WEATHER_MAGE" as const, side: proc.side }] : []),
      { type: "END_TURN", side: proc.side },
    ];
  },
};

/** Weather Mage: once per game, at the start of one of the team's own turns (not a Charge). */
const weatherMageAvailable = (state: GameState, proc: P<"Turn">) =>
  !proc.charge && !proc.acted && inducementsLeft(state.teams[proc.side], "weatherMage") > 0;

/** Weather Mage: the modifiers the coach may apply to the roll (none included). */
export const WEATHER_MAGE_MODIFIERS = [-2, -1, 0, 1, 2];

/** Weather Mage: each modifier, the modified total and the weather it gives on the weather table. */
const weatherMageOptions = (roll: number) =>
  WEATHER_MAGE_MODIFIERS.map((modifier) => ({ modifier, total: roll + modifier, weather: weatherFor(roll + modifier) }));

/**
 * Weather Mage: the team rolls 2D6 on the weather table, and its coach may apply a modifier of +1 or +2, or -1 or -2
 * (or none). The new weather stays until it changes again.
 */
export const WeatherMage: Handler<P<"WeatherMage">> = {
  step(ctx, proc, action) {
    if (action === null) return "wait";
    if (proc.stage === "roll") {
      const [a, b] = ctx.roll(action, [{ kind: "d6", count: 2 }], "Weather Mage");
      proc.roll = a! + b!;
      proc.stage = "choose";
      return "wait";
    }
    const { modifier } = ctx.expect(action, "CHOOSE_WEATHER");
    const option = weatherMageOptions(proc.roll!).find((o) => o.modifier === modifier) ?? ctx.reject("The modifier must be from -2 to +2.");
    setWeather(ctx, option.weather);
    return "done";
  },
  actions(state, proc) {
    if (proc.stage === "roll") return [{ type: "ROLL", side: proc.side, dice: [{ kind: "d6", count: 2 }], reason: `Weather Mage (${state.teams[proc.side].name})` }];
    return [{ type: "CHOOSE_WEATHER", side: proc.side, roll: proc.roll!, options: weatherMageOptions(proc.roll!) }];
  },
};

/** Change the weather. */
function setWeather(ctx: Ctx, weather: Weather) {
  ctx.state.weather = weather;
  ctx.emit({ type: "WeatherChanged", weather });
}

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

/** My Ball (and No Ball, Ball & Chain): the player cannot declare a Pass or Hand-off action. */
const keepsBall = (player: PlayerState) => ["My Ball", "No Ball", "Ball & Chain"].some((s) => hasSkill(player, s));

/**
 * Actions the player may declare: Block needs a standing player next to a standing opponent;
 * Blitz, Pass, Hand-off, Foul, Secure the Ball and Punt are once per turn; Hypnotic Gaze is not. A Charge (kick-off event) only allows Move and Blitz.
 */
export function declarableActions(state: GameState, proc: P<"Turn">, player: PlayerState): PlayerActionType[] {
  if (!canAct(player)) return [];
  const actions: PlayerActionType[] = ["move"];
  // Ball & Chain: a Move action only.
  if (hasSkill(player, "Ball & Chain")) return actions;
  const free = (a: PlayerActionType) => !proc.used.includes(a);
  // Jump Up: a prone player may declare a Block, standing up with an AG roll.
  const canBlock = player.status === "standing" || hasSkill(player, "Jump Up");
  if (!proc.charge && canBlock && (adjacentTargets(state, player).length > 0 || downedTargets(state, player).length > 0 || vineTargets(state, player).length > 0)) actions.push("block");
  if (free("blitz") && blitzTargets(state, player.side).length > 0) actions.push("blitz");
  if (proc.charge) return actions;
  if (free("pass") && ballAvailable(state, player) && !keepsBall(player)) actions.push("pass");
  if (free("handoff") && ballAvailable(state, player) && !keepsBall(player)) actions.push("handoff");
  // Punt: a special action of a standing player with the skill.
  if (free("punt") && hasSkill(player, "Punt") && player.status === "standing" && ballAvailable(state, player) && !keepsBall(player)) actions.push("punt");
  if (free("secure") && canSecure(state, player)) actions.push("secure");
  // Throw (or Kick) Team-mate: a standing thrower, with a team-mate with Right Stuff on the pitch to throw.
  const throwable = teamPlayers(state, player.side).some((p) => p.id !== player.id && isOnPitch(p) && hasSkill(p, "Right Stuff"));
  if (free("ttm") && player.status === "standing" && hasSkill(player, "Throw Team-mate") && throwable) actions.push("ttm");
  if (free("ktm") && player.status === "standing" && hasSkill(player, "Kick Team-mate") && throwable) actions.push("ktm");
  // A Foul can be declared as long as an opponent is prone or stunned somewhere on the pitch.
  const foulable = teamPlayers(state, other(player.side)).some((o) => isOnPitch(o) && o.status !== "standing");
  if ((free("foul") || hasSkill(player, "Sneakiest of the Lot")) && foulable) actions.push("foul");
  // Bombardier: a Throw Bomb special action, once per turn.
  if (free("bomb") && hasSkill(player, "Bombardier")) actions.push("bomb");
  // Hypnotic Gaze: a special action any number of players may declare each turn.
  if (hasSkill(player, "Hypnotic Gaze") && blitzTargets(state, player.side).length > 0) actions.push("gaze");
  return actions;
}

/** Timmm-ber!: +1 to the stand-up roll per adjacent team-mate with a tackle zone who is not marked by an opponent. */
function standUpAssists(state: GameState, player: PlayerState & { at: Square }): number {
  return adjacent(player.at).filter((s) => {
    const helper = tackleZoneAt(state, s);
    return helper !== undefined && helper.side === player.side && tackleZones(state, player.side, s) === 0;
  }).length;
}

/** The Animal Savagery, Bone Head, Really Stupid, Unchannelled Fury or Bloodlust roll a player makes when activated, if any. */
function confusionCheck(state: GameState, player: PlayerState & { at: Square }, action: PlayerActionType): P<"Check"> | null {
  const check = (kind: "savagery" | "bonehead" | "reallystupid" | "fury" | "bloodlust", target: number): P<"Check"> =>
    ({ type: "Check", kind, playerId: player.id, target, modifier: 0, stage: "roll", rerolled: false });
  const blocking = action === "block" || action === "blitz";
  if (hasSkill(player, "Animal Savagery")) return check("savagery", blocking ? FURY_BLOCK_TARGET : FURY_TARGET);
  if (hasSkill(player, "Bone Head")) return check("bonehead", BONE_HEAD_TARGET);
  if (hasSkill(player, "Unchannelled Fury")) return check("fury", blocking ? FURY_BLOCK_TARGET : FURY_TARGET);
  // Bloodlust(X): X+, 1 easier (but at least 2+) for a Block or Blitz.
  const bloodlust = skillValue(player, "Bloodlust", 2);
  if (bloodlust !== null) return check("bloodlust", Math.max(2, bloodlust - (blocking ? 1 : 0)));
  if (!hasSkill(player, "Really Stupid")) return null;
  const helped = adjacent(player.at).some((s) => {
    const p = playerAt(state, s);
    return p !== undefined && p.side === player.side && p.status === "standing" && !hasSkill(p, "Really Stupid");
  });
  return check("reallystupid", helped ? REALLY_STUPID_HELPED_TARGET : REALLY_STUPID_TARGET);
}

/**
 * One player activation: Bone Head / Really Stupid roll, stand up if prone, then step, block, throw, hand off or
 * foul according to the declared action, until the player ends it or nothing is left to do.
 * A failed Bone Head, Really Stupid or Unchannelled Fury roll ends the action (the declared action still counts as used
 * this turn, no turnover): the player stays where they are, prone if they were; Bone Head and Really Stupid also
 * distract them until their next activation.
 * Animal Savagery (same roll as Unchannelled Fury): on a failure the player lashes out at an adjacent standing team-mate
 * (the coach picks), who is knocked down, and the action ends; a turnover only if that team-mate held the ball. With
 * nobody to lash out at, the action is lost and the player is distracted.
 * Standing up with MA below 3 takes a 4+ roll (Timmm-ber!: +1 per unmarked team-mate next to the player; a 1 always fails).
 * Take Root (standing players only, 2+): a failure roots the player, who keeps their action but cannot move.
 * Jump Up: stand up for free (no movement spent, no roll); a prone player declaring a Block stands up on an AG roll
 * with +1 instead (a failure ends the action, without a turnover).
 * Quick Foul: after a foul without a turnover, the fouler may go on moving with the squares left (no second foul).
 */
export const MoveAction: Handler<P<"MoveAction">> = {
  step(ctx, proc, action) {
    const { state } = ctx;
    const player = getPlayer(ctx, proc.playerId);
    if (proc.stage === "start") {
      player.activated = true;
      player.movesUsed = 0;
      player.distracted = false;
      player.gouged = false;
      // Take Root ends when the player is knocked down or placed prone.
      if (player.status !== "standing") player.rooted = false;
      if (isStalling(state, player)) {
        proc.stalling = true;
        ctx.emit({ type: "StallingDetected", playerId: player.id });
      }
      proc.stage = "confusion";
      state.lastCheck = null;
      const check = confusionCheck(state, { ...player, at: squareOf(ctx, player) }, proc.action);
      if (check) ctx.push(check);
      return "continue";
    }
    if (proc.stage === "confusion") {
      if (failed(ctx) && state.lastCheck!.kind === "bloodlust") {
        proc.thirsty = true;
        ctx.emit({ type: "PlayerThirsty", playerId: player.id });
      } else if (failed(ctx) && state.lastCheck!.kind === "savagery" && proc.primal === undefined && primalTargets(state, player).length > 0 && hasSkill(player, "Primal Savagery") && !player.usedThisGame?.includes("Primal Savagery")) {
        proc.stage = "primal";
        return "continue";
      } else if (failed(ctx) && state.lastCheck!.kind === "fury" && proc.action === "block" && proc.fury === undefined && state.lastCheck!.roll === 1 && hasSkill(player, "Fury of the Blood God") && !player.usedThisGame?.includes("Fury of the Blood God")) {
        proc.stage = "fury";
        return "continue";
      } else if (failed(ctx) && state.lastCheck!.kind === "savagery" && lashOutTargets(state, player, proc.action).length > 0) {
        proc.stage = "savagery";
        return "continue";
      } else if (failed(ctx)) {
        const { kind } = state.lastCheck!;
        if (kind === "fury") ctx.emit({ type: "ActionLost", playerId: player.id, skill: "Unchannelled Fury" });
        else {
          player.distracted = true;
          const skill = kind === "bonehead" ? "Bone Head" : kind === "savagery" ? "Animal Savagery" : "Really Stupid";
          ctx.emit({ type: "PlayerDistracted", playerId: player.id, skill });
        }
        return loseAction(ctx, proc, player);
      }
      proc.stage = "thirst";
      return "continue";
    }
    if (proc.stage === "fury") {
      if (action === null) return "wait";
      // Fury of the Blood God: once per game, two Block actions instead of the usual effect.
      proc.fury = ctx.expect(action, "USE_SKILL").use;
      if (!proc.fury) {
        proc.stage = "confusion";
        return "continue";
      }
      useOncePerGame(ctx, player, "Fury of the Blood God");
      proc.extraBlocks = 1;
      proc.stage = "thirst";
      return "continue";
    }
    if (proc.stage === "primal") {
      if (action === null) return "wait";
      // Primal Savagery: once per game, the player lashes out at an opponent instead.
      if (ctx.expect(action, "USE_SKILL").use) {
        useOncePerGame(ctx, player, "Primal Savagery");
        proc.primal = true;
        proc.stage = "savagery";
      } else {
        proc.primal = false;
        proc.stage = "confusion";
      }
      return "continue";
    }
    if (proc.stage === "savagery") {
      const victims = proc.primal ? primalTargets(state, player) : lashOutTargets(state, player, proc.action);
      let victim = victims[0]!;
      if (victims.length > 1) {
        if (action === null) return "wait";
        const { playerIds } = ctx.expect(action, "SELECT_PLAYERS");
        if (playerIds.length !== 1) ctx.reject("Choose one team-mate.");
        victim = victims.find((v) => v.id === playerIds[0]) ?? ctx.reject("Invalid team-mate.");
      }
      ctx.emit({ type: "LashedOut", playerId: player.id, victimId: victim.id });
      const bonus = skillValue(player, "Mighty Blow", 1);
      // The knock-down comes first, then any stalling rock.
      const result = loseAction(ctx, proc, player);
      ctx.push({
        type: "KnockDown",
        playerId: victim.id,
        turnover: victim.side === player.side && holdsBall(state, victim),
        stage: "fall",
        blockerId: player.id,
        ...(bonus ? { mightyBlow: { playerId: player.id, bonus, armourOnly: true } } : {}),
      });
      return result;
    }
    if (proc.stage === "thirst") {
      if (proc.thirsty && (proc.action === "block" || proc.action === "secure")) {
        if (action === null) return "wait";
        if (ctx.expect(action, "MOVE_INSTEAD").move) proc.action = "move";
      }
      proc.stage = "root";
      state.lastCheck = null;
      if (player.status === "standing" && !player.rooted && hasSkill(player, "Take Root")) {
        ctx.push({ type: "Check", kind: "takeroot", playerId: player.id, target: TAKE_ROOT_TARGET, modifier: 0, stage: "roll", rerolled: false });
      }
      return "continue";
    }
    if (proc.stage === "root") {
      if (failed(ctx)) {
        player.rooted = true;
        ctx.emit({ type: "PlayerRooted", playerId: player.id });
      }
      proc.stage = "standup";
      state.lastCheck = null;
      if (player.status === "prone" && hasSkill(player, "Jump Up")) {
        if (proc.action === "block") {
          ctx.push({ type: "Check", kind: "jumpup", playerId: player.id, target: player.ag, modifier: JUMP_UP_MODIFIER, stage: "roll", rerolled: false });
        }
      } else if (player.status === "prone" && player.ma < STAND_UP_COST) {
        const modifier = hasSkill(player, "Timmm-ber!") ? standUpAssists(state, { ...player, at: squareOf(ctx, player) }) : 0;
        ctx.push({ type: "Check", kind: "standup", playerId: player.id, target: STAND_UP_TARGET, modifier, stage: "roll", rerolled: false });
      }
      return "continue";
    }
    if (proc.stage === "standup") {
      if (player.status === "prone") {
        // A failed stand-up (or Jump Up) roll ends the action, but is not a turnover.
        if (failed(ctx)) {
          state.activePlayerId = null;
          return "done";
        }
        const jumpUp = hasSkill(player, "Jump Up");
        player.status = "standing";
        player.movesUsed = jumpUp ? 0 : Math.min(STAND_UP_COST, player.ma);
        if (jumpUp) ctx.emit({ type: "SkillUsed", playerId: player.id, skill: "Jump Up" });
        ctx.emit({ type: "PlayerStoodUp", playerId: player.id });
      }
      proc.stage = carryPartner(state, player) ? "carry" : "special";
      return "continue";
    }
    if (proc.stage === "carry") {
      if (action === null) return "wait";
      const { use } = ctx.expect(action, "USE_SKILL");
      if (use) proc.carry = pickUp(ctx, player, carryPartner(state, player)!);
      proc.stage = "special";
      return "continue";
    }
    if (proc.stage === "special") {
      if (proc.ended) return endActivation(ctx, proc, player);
      if (proc.specialAsked || activationSkills(state, player, proc.action).length === 0) {
        proc.stage = "main";
        return "continue";
      }
      if (action === null) return "wait";
      const { skill } = ctx.expect(action, "ACTIVATION_SKILL");
      proc.specialAsked = true;
      if (skill === null) return "continue";
      if (!activationSkills(state, player, proc.action).includes(skill)) ctx.reject(`${skill} cannot be used now.`);
      ctx.push({ type: "StartSkill", playerId: player.id, skill, stage: "target" });
      return "continue";
    }
    const finished =
      proc.finished ||
      proc.fed ||
      // Bloodlust: a thirsty ball carrier in the end zone stops to feed before scoring.
      (proc.thirsty && inScoringPosition(state, player)) ||
      state.turnover ||
      state.touchdown !== null ||
      !isOnPitch(player) ||
      (activationMoves(state, proc).length === 0 &&
        blockTargets(state, proc).length === 0 &&
        extraSpecialTargets(state, proc, "Projectile Vomit").length === 0 &&
        extraSpecialTargets(state, proc, "Chainsaw").length === 0 &&
        throwOptions(state, proc).length === 0 &&
        handOffOptions(state, proc).length === 0 &&
        foulOptions(state, proc).length === 0 &&
        gazeOptions(state, proc).length === 0 &&
        ttmOptions(state, proc).length === 0 &&
        puntOptions(state, proc) === null);
    if (finished) return endActivation(ctx, proc, player);
    if (action === null) return "wait";
    const a = ctx.expect(action, "MOVE", "BLOCK", "MULTIPLE_BLOCK", "VOMIT", "STAB", "BREATHE_FIRE", "CHAINSAW", "CHOMP", "THROW", "HAIL_MARY_PASS", "HAND_OFF", "FOUL", "GAZE", "THROW_TEAM_MATE", "PUNT", "USE_SKILL", "END_PLAYER_ACTION");
    if (a.type === "USE_SKILL") {
      if (!canFumblerooski(state, proc)) ctx.reject("Fumblerooski cannot be used now.");
      if (a.use) proc.fumblerooski = true;
      return "wait";
    }
    if (a.type === "END_PLAYER_ACTION") return endActivation(ctx, proc, player);
    if (a.type === "THROW" && proc.action === "bomb") {
      const square = throwOptions(state, proc).find((s) => sameSquare(s, a.square)) ?? ctx.reject("Cannot throw there.");
      // All You Can Eat: a second bomb after the first, then the roll to be sent off.
      const second = proc.bombs === 1;
      if (proc.bombs === 2) proc.bombs = 1;
      else proc.finished = true;
      ctx.push(
        { type: "Pass", throwerId: player.id, target: { x: square.x, y: square.y }, range: square.range, bomb: true, stage: "animosity", rerolled: false },
        ...(second ? [{ type: "AllYouCanEat" as const, playerId: player.id }] : []),
      );
      return "continue";
    }
    if (a.type === "THROW") {
      const square = throwOptions(state, proc).find((s) => sameSquare(s, a.square)) ?? ctx.reject("Cannot throw there.");
      proc.finished = true;
      ctx.push(...feedFirst(proc), { type: "Pass", throwerId: player.id, target: { x: square.x, y: square.y }, range: square.range, stage: "animosity", rerolled: false });
      return "continue";
    }
    if (a.type === "HAIL_MARY_PASS") {
      const thrower = hailMaryThrower(state, proc) ?? ctx.reject("Cannot make a Hail Mary Pass now.");
      if (!inBounds(a.square) || sameSquare(a.square, thrower.at)) ctx.reject("Throw to another square of the pitch.");
      proc.finished = true;
      const bomb = proc.action === "bomb";
      ctx.push(...(bomb ? [] : feedFirst(proc)), { type: "Pass", throwerId: player.id, target: { x: a.square.x, y: a.square.y }, range: "bomb", hailMary: true, ...(bomb ? { bomb } : {}), stage: "animosity", rerolled: false });
      return "continue";
    }
    if (a.type === "THROW_TEAM_MATE") {
      if (!ttmOptions(state, proc).some((p) => p.id === a.targetId)) ctx.reject("Cannot throw this player.");
      const square = teamMateTargets(state, player).find((s) => sameSquare(s, a.square)) ?? ctx.reject("Cannot throw there.");
      // The thrower's action ends with the throw.
      proc.finished = true;
      const kicked = proc.action === "ktm";
      ctx.push({ type: "ThrowTeamMate", throwerId: player.id, thrownId: a.targetId, target: { x: square.x, y: square.y }, range: square.range, stage: "hunger", rerolled: false, ...(kicked ? { kicked } : {}) });
      return "continue";
    }
    if (a.type === "PUNT") {
      const options = puntOptions(state, proc) ?? ctx.reject("Cannot punt now.");
      const at = squareOf(ctx, player);
      proc.finished = true;
      if (a.square === null) {
        if (!options.crowd) ctx.reject("Can only punt into the crowd from a sideline or an end zone.");
        // Into the crowd: a throw-in from the punter's square, and a turnover.
        ctx.emit({ type: "Punted", playerId: player.id, to: { ...at }, out: true });
        state.ball = { square: null, carried: false };
        state.turnover = true;
        ctx.push({ type: "ThrowIn", from: { ...at } });
        return "continue";
      }
      const square = options.squares.find((s) => sameSquare(s, a.square!)) ?? ctx.reject("Punt towards a square next to the player, not diagonally.");
      const facing = { x: square.x - at.x, y: square.y - at.y };
      ctx.push({ type: "Punt", playerId: player.id, facing, stage: "direction", rolling: "direction", rerolled: false });
      return "continue";
    }
    if (a.type === "FOUL") {
      const target = foulOptions(state, proc).find((t) => t.playerId === a.targetId) ?? ctx.reject("Cannot foul this player.");
      // Quick Foul: the player may move on after the foul (unless it ends in a turnover).
      if (hasSkill(player, "Quick Foul")) proc.fouled = true;
      else proc.finished = true;
      ctx.emit({ type: "Fouled", foulerId: player.id, victimId: target.playerId, assists: target.assists });
      ctx.push({ type: "Foul", foulerId: player.id, victimId: target.playerId, assists: target.assists, stage: "chainsaw" });
      return "continue";
    }
    if (a.type === "GAZE") {
      if (!gazeOptions(state, proc).some((t) => t.id === a.targetId)) ctx.reject("Cannot gaze at this player.");
      // The activation ends once the gaze has been attempted.
      proc.finished = true;
      ctx.push({ type: "Gaze", playerId: player.id, victimId: a.targetId, stage: "appearance" });
      return "continue";
    }
    if (a.type === "HAND_OFF") {
      if (!handOffOptions(state, proc).some((p) => p.id === a.targetId)) ctx.reject("Cannot hand off to this player.");
      proc.finished = true;
      ctx.push(...feedFirst(proc), { type: "HandOff", throwerId: player.id, catcherId: a.targetId, stage: "animosity" });
      return "continue";
    }
    if (a.type === "VOMIT" || a.type === "STAB" || a.type === "BREATHE_FIRE" || a.type === "CHAINSAW" || a.type === "CHOMP") {
      const skill = SPECIAL_ATTACKS[a.type];
      if (!specialTargets(state, proc, skill).some((t) => t.id === a.targetId)) ctx.reject(`Cannot use ${skill} on this player.`);
      // Putrid Regurgitation: the vomit of a player without the skill, or after their block.
      if (skill === "Chainsaw" && state.players[a.targetId]!.status !== "standing") useOncePerGame(ctx, player, "Kick 'em While They're Down!");
      // Maximum Carnage: the second Chainsaw attack uses it up; after a first one, the player may make it.
      const carnage = skill === "Chainsaw" && hasSkill(player, "Maximum Carnage") && !player.usedThisGame?.includes("Maximum Carnage");
      if (carnage && proc.carnage !== undefined) {
        useOncePerGame(ctx, player, "Maximum Carnage");
        delete proc.carnage;
      } else if (carnage && !proc.blocked) proc.carnage = a.targetId;
      if (skill === "Projectile Vomit" && (!hasSkill(player, skill) || proc.blocked)) {
        player.usedThisHalf = [...(player.usedThisHalf ?? []), "Putrid Regurgitation"];
        ctx.emit({ type: "SkillUsed", playerId: player.id, skill: "Putrid Regurgitation" });
      }
      proc.blocked = true;
      // The attack ends the action, even during a Blitz (but Hit and Run may follow a Stab); a blitzer may move on after
      // a chomp (which then ends if they leave).
      if (skill !== "Monstrous Mouth" && proc.carnage === undefined) proc.finished = true;
      const blitz = proc.action === "blitz";
      ctx.push({ type: "Vomit", skill, attackerId: player.id, defenderId: a.targetId, blitz, stage: "appearance" }, ...hitAndRun(player, skill === "Stab"));
      return "continue";
    }
    if (a.type === "MULTIPLE_BLOCK") {
      const options = multipleBlockTargets(state, proc).map((t) => t.id);
      if (a.targetIds.length !== 2 || a.targetIds[0] === a.targetIds[1] || !a.targetIds.every((id) => options.includes(id))) ctx.reject("Choose two adjacent opponents.");
      proc.blocked = true;
      const extraAssist = state.teams[player.side].extraAssist;
      state.teams[player.side].extraAssist = false;
      ctx.emit({ type: "SkillUsed", playerId: player.id, skill: "Multiple Block" });
      ctx.push(
        {
          type: "MultipleBlock",
          attackerId: player.id,
          targetIds: [...a.targetIds],
          pending: [...a.targetIds],
          chosen: [],
          squares: a.targetIds.map((id) => ({ ...squareOf(ctx, getPlayer(ctx, id)) })),
          ...(extraAssist ? { extraAssist } : {}),
        },
        ...pileDriver(player, [...a.targetIds], proc.action),
        ...hitAndRun(player, true),
      );
      return "continue";
    }
    if (a.type === "BLOCK") {
      const target = blockTargets(state, proc).find((t) => t.id === a.targetId) ?? ctx.reject("Illegal block target.");
      // Fury of the Blood God: the second Block action.
      if (proc.blocked) proc.extraBlocks = (proc.extraBlocks ?? 1) - 1;
      proc.blocked = true;
      // Vicious Vines: a block two squares away, once per half.
      const vines = !adjacentTargets(state, player).some((t) => t.id === target.id);
      if (vines) {
        player.usedThisHalf = [...(player.usedThisHalf ?? []), "Vicious Vines"];
        ctx.emit({ type: "SkillUsed", playerId: player.id, skill: "Vicious Vines" });
      }
      const dice = blockDice(state, player, target, { blitz: proc.action === "blitz" });
      // Cheering Fans: the extra assist is used up by the team's first block.
      const extraAssist = state.teams[player.side].extraAssist;
      state.teams[player.side].extraAssist = false;
      ctx.emit({ type: "BlockDeclared", attackerId: player.id, defenderId: target.id, dice });
      ctx.push({
        type: "Block",
        attackerId: player.id,
        defenderId: target.id,
        blitz: proc.action === "blitz",
        stage: "appearance",
        dice,
        ...(vines ? { vines } : {}),
        ...(extraAssist ? { extraAssist } : {}),
        rerolled: false,
        chain: [],
      }, ...pileDriver(player, [target.id], proc.action), ...hitAndRun(player, true));
      return "continue";
    }
    if (!activationMoves(state, proc).some((s) => sameSquare(s, a.square))) ctx.reject("Illegal move.");
    const jump = Math.max(Math.abs(a.square.x - player.at.x), Math.abs(a.square.y - player.at.y)) === 2;
    ctx.push({ type: "MoveStep", playerId: player.id, to: { ...a.square }, stage: "rush", ...(jump ? { jump } : {}) });
    return "continue";
  },
  actions(state, proc) {
    const player = state.players[proc.playerId]!;
    if (proc.stage === "thirst") return [{ type: "MOVE_INSTEAD", side: player.side, playerId: player.id }];
    if (proc.stage === "carry") return [{ type: "USE_SKILL", side: player.side, playerId: player.id, skill: CARRY_SKILL }];
    if (proc.stage === "special") return [{ type: "ACTIVATION_SKILL", side: player.side, playerId: player.id, skills: activationSkills(state, player, proc.action) }];
    if (proc.stage === "fury") return [{ type: "USE_SKILL", side: player.side, playerId: player.id, skill: "Fury of the Blood God" }];
    if (proc.stage === "primal") return [{ type: "USE_SKILL", side: player.side, playerId: player.id, skill: "Primal Savagery" }];
    if (proc.stage === "savagery") {
      const playerIds = (proc.primal ? primalTargets(state, player) : lashOutTargets(state, player, proc.action)).map((p) => p.id);
      return [{ type: "SELECT_PLAYERS", side: player.side, playerIds, max: 1, min: 1, reason: `Animal Savagery: choose a team-mate for ${player.name} to lash out at` }];
    }
    const targets = blockTargets(state, proc).map((t) => ({ playerId: t.id, dice: blockDice(state, player, t, { blitz: proc.action === "blitz" }) }));
    const vomits = specialTargets(state, proc, "Projectile Vomit").map((t) => t.id);
    const stabs = specialTargets(state, proc, "Stab").map((t) => t.id);
    const fires = specialTargets(state, proc, "Breathe Fire").map((t) => t.id);
    const chainsaws = specialTargets(state, proc, "Chainsaw").map((t) => t.id);
    const chomps = specialTargets(state, proc, "Monstrous Mouth").map((t) => t.id);
    const multiple = multipleBlockTargets(state, proc).map((t) => t.id);
    const throws = throwOptions(state, proc);
    const handOffs = handOffOptions(state, proc).map((p) => p.id);
    const fouls = foulOptions(state, proc);
    const throwable = ttmOptions(state, proc).map((p) => p.id);
    const gazes = gazeOptions(state, proc).map((p) => p.id);
    const punt = puntOptions(state, proc);
    const hailMary = hailMaryThrower(state, proc);
    return [
      ...(proc.action === "block" || proc.action === "bomb" ? [] : [{ type: "MOVE" as const, side: player.side, playerId: player.id, squares: legalMoves(state, player) }]),
      ...(targets.length > 0 ? [{ type: "BLOCK" as const, side: player.side, playerId: player.id, targets }] : []),
      ...(multiple.length > 0 ? [{ type: "MULTIPLE_BLOCK" as const, side: player.side, playerId: player.id, targetIds: multiple }] : []),
      ...(vomits.length > 0 ? [{ type: "VOMIT" as const, side: player.side, playerId: player.id, targetIds: vomits }] : []),
      ...(stabs.length > 0 ? [{ type: "STAB" as const, side: player.side, playerId: player.id, targetIds: stabs }] : []),
      ...(fires.length > 0 ? [{ type: "BREATHE_FIRE" as const, side: player.side, playerId: player.id, targetIds: fires }] : []),
      ...(chainsaws.length > 0 ? [{ type: "CHAINSAW" as const, side: player.side, playerId: player.id, targetIds: chainsaws }] : []),
      ...(chomps.length > 0 ? [{ type: "CHOMP" as const, side: player.side, playerId: player.id, targetIds: chomps }] : []),
      ...(throws.length > 0 ? [{ type: "THROW" as const, side: player.side, playerId: player.id, squares: throws }] : []),
      ...(hailMary ? [{ type: "HAIL_MARY_PASS" as const, side: player.side, playerId: player.id, needed: hailMaryNeeded(state, hailMary) }] : []),
      ...(handOffs.length > 0 ? [{ type: "HAND_OFF" as const, side: player.side, playerId: player.id, playerIds: handOffs }] : []),
      ...(fouls.length > 0 ? [{ type: "FOUL" as const, side: player.side, playerId: player.id, targets: fouls }] : []),
      ...(gazes.length > 0 ? [{ type: "GAZE" as const, side: player.side, playerId: player.id, targetIds: gazes }] : []),
      ...(punt ? [{ type: "PUNT" as const, side: player.side, playerId: player.id, ...punt }] : []),
      ...(canFumblerooski(state, proc) ? [{ type: "USE_SKILL" as const, side: player.side, playerId: player.id, skill: "Fumblerooski" }] : []),
      ...(throwable.length > 0
        ? [{ type: "THROW_TEAM_MATE" as const, side: player.side, playerId: player.id, playerIds: throwable, squares: teamMateTargets(state, player) }]
        : []),
      { type: "END_PLAYER_ACTION", side: player.side },
    ];
  },
};

const holdsBall = (state: GameState, player: PlayerState) => ballCarrier(state)?.id === player.id;

/** Pile Driver: offered once a Block action's blocks (any Frenzy or Multiple Block one included) are over, before Hit and Run. */
const pileDriver = (player: PlayerState, defenderIds: string[], action: PlayerActionType): Procedure[] =>
  action === "block" && hasSkill(player, "Pile Driver") ? [{ type: "PileDriver", attackerId: player.id, defenderIds, stage: "ask" }] : [];

/** Hit and Run runs once the block (and any Frenzy block) or Stab is over. */
const hitAndRun = (player: PlayerState, allowed: boolean): Procedure[] =>
  allowed && hasSkill(player, "Hit and Run") ? [{ type: "HitAndRun", playerId: player.id, stage: "ask" }] : [];

/** Hit and Run: free squares next to the player that are not next to any opponent, standing or not. */
export function hitAndRunSquares(state: GameState, player: PlayerState): Square[] {
  if (!isOnPitch(player) || player.status !== "standing" || isPinned(state, player)) return [];
  return adjacent(player.at).filter(
    (s) => !playerAt(state, s) && !adjacent(s).some((n) => playerAt(state, n)?.side === other(player.side)),
  );
}

/**
 * Hit and Run: after a block (once any Frenzy block is over) or a Stab, a standing player with the skill may move one
 * square to a free square that is not next to an opponent: no Dodge or Rush, no movement spent, a pick-up if the ball
 * is there. Not after a turnover.
 */
export const HitAndRun: Handler<P<"HitAndRun">> = {
  step(ctx, proc, action) {
    const { state } = ctx;
    const player = getPlayer(ctx, proc.playerId);
    const squares = hitAndRunSquares(state, player);
    if (state.turnover || state.touchdown !== null || squares.length === 0) return "done";
    if (action === null) return "wait";
    if (proc.stage === "ask") {
      if (!ctx.expect(action, "USE_SKILL").use) return "done";
      proc.stage = "move";
      return "wait";
    }
    const { square } = ctx.expect(action, "MOVE");
    if (!squares.some((s) => sameSquare(s, square))) ctx.reject("Illegal Hit and Run square.");
    ctx.emit({ type: "SkillUsed", playerId: player.id, skill: "Hit and Run" });
    ctx.push({ type: "MoveStep", playerId: player.id, to: { x: square.x, y: square.y }, stage: "rush", hitAndRun: true });
    return "done";
  },
  actions(state, proc) {
    const player = state.players[proc.playerId]!;
    if (proc.stage === "ask") return [{ type: "USE_SKILL", side: player.side, playerId: player.id, skill: "Hit and Run" }];
    return [{ type: "MOVE", side: player.side, playerId: player.id, squares: hitAndRunSquares(state, player).map((s) => ({ ...s, rolls: [] })) }];
  },
};

/**
 * Animal Savagery: standing team-mates next to the player, one of whom gets lashed out at; for a Throw or Kick
 * Team-mate, also the team-mates the player could throw (or kick), even prone or stunned.
 */
/** Primal Savagery: the standing opponents next to the player, one of whom may be lashed out at instead. */
const primalTargets = (state: GameState, player: PlayerState) =>
  !isOnPitch(player) ? [] : adjacent(player.at).flatMap((s) => {
    const p = playerAt(state, s);
    return p && p.side !== player.side && p.status === "standing" ? [p] : [];
  });

export function lashOutTargets(state: GameState, player: PlayerState, action?: PlayerActionType): PlayerState[] {
  if (!isOnPitch(player)) return [];
  // Throw or Kick Team-mate: a team-mate who could be thrown is a target even when down.
  const throwable = action === "ttm" || action === "ktm" ? throwableTeamMates(state, player, action === "ktm").map((p) => p.id) : [];
  return adjacent(player.at).flatMap((s) => {
    const p = playerAt(state, s);
    return p && p.side === player.side && (p.status === "standing" || throwable.includes(p.id)) ? [p] : [];
  });
}

/** The action is lost after a failed roll on activation (still used this turn, no turnover); a staller gets a rock. */
function loseAction(ctx: Ctx, proc: P<"MoveAction">, player: PlayerState) {
  const { state } = ctx;
  if (proc.stalling && player.status === "standing" && holdsBall(state, player)) ctx.push({ type: "Stalling", playerId: player.id });
  state.activePlayerId = null;
  return "done" as const;
}

/** Bloodlust: a thirsty player feeds before passing or handing off the ball. */
function feedFirst(proc: P<"MoveAction">): Procedure[] {
  if (!proc.thirsty || proc.fed) return [];
  proc.fed = true;
  return [{ type: "Feed", playerId: proc.playerId, stage: "select" }];
}

/**
 * End the activation: a thirsty player feeds first (and may then score). Secure the Ball is a turnover when the
 * player does not end up holding the ball.
 */
function endActivation(ctx: Ctx, proc: P<"MoveAction">, player: PlayerState) {
  const { state } = ctx;
  const feed = feedFirst(proc);
  if (feed.length > 0) {
    ctx.push(...feed);
    return "continue" as const;
  }
  if (proc.fed) checkTouchdown(ctx, player);
  if (proc.action === "secure" && !state.turnover && state.touchdown === null && !holdsBall(state, player)) {
    state.turnover = true;
  }
  // A stalling player who still holds the ball, standing, without scoring, gets a rock from the crowd.
  if (proc.stalling && state.touchdown === null && player.status === "standing" && holdsBall(state, player)) {
    ctx.push({ type: "Stalling", playerId: player.id });
  }
  // I'll Carry You: the partner is put down before anything else.
  if (proc.carry) ctx.push(putDown(ctx, player, proc.carry));
  loseGainedSkills(player);
  state.activePlayerId = null;
  return "done" as const;
}

/**
 * Fumblerooski: a standing ball carrier with the skill (not My Ball) whose action lets them move may drop the ball in the
 * square they leave on their next step: it does not bounce, and it is not a turnover.
 */
function canFumblerooski(state: GameState, proc: P<"MoveAction">): boolean {
  const player = state.players[proc.playerId]!;
  if (proc.fumblerooski || !hasSkill(player, "Fumblerooski") || hasSkill(player, "My Ball") || !holdsBall(state, player)) return false;
  return activationMoves(state, proc).length > 0;
}

/** Team-mates the active player may throw now (a Throw Team-mate action, standing, not thrown yet). */
const ttmOptions = (state: GameState, proc: P<"MoveAction">) => {
  const player = state.players[proc.playerId]!;
  if (proc.action !== "ttm" && proc.action !== "ktm") return [];
  return !proc.finished && player.status === "standing" ? throwableTeamMates(state, player, proc.action === "ktm") : [];
};

/** Hypnotic Gaze: any standing opponent next to the (standing) player, once the action allows it. */
const gazeOptions = (state: GameState, proc: P<"MoveAction">) => {
  const player = state.players[proc.playerId]!;
  return proc.action === "gaze" && !proc.finished && player.status === "standing" ? adjacentTargets(state, player) : [];
};

const foulOptions = (state: GameState, proc: P<"MoveAction">) =>
  proc.action === "foul" && !proc.finished && !proc.fouled ? foulTargets(state, state.players[proc.playerId]!) : [];

/** The active player, if this activation still lets them throw or hand off the ball they are holding. */
function releasingBall(state: GameState, proc: P<"MoveAction">, action: "pass" | "handoff") {
  const player = state.players[proc.playerId]!;
  return proc.action === action && !proc.finished && !proc.released && player.status === "standing" && holdsBall(state, player) ? player : null;
}

/** Squares the player may throw the ball (Pass) or a bomb (Throw Bomb, standing, without moving first) to. */
const throwOptions = (state: GameState, proc: P<"MoveAction">) => {
  const bomber = state.players[proc.playerId]!;
  if (proc.action === "bomb") return !proc.finished && bomber.status === "standing" ? throwTargets(state, bomber, true) : [];
  const player = releasingBall(state, proc, "pass");
  return player ? throwTargets(state, player) : [];
};

/** Hail Mary Pass: the player may make one instead of a normal pass (or, with Bombardier, a normal bomb throw) now. */
function hailMaryThrower(state: GameState, proc: P<"MoveAction">) {
  const bomber = state.players[proc.playerId]!;
  const player = proc.action === "bomb" ? (!proc.finished && bomber.status === "standing" ? bomber : null) : releasingBall(state, proc, "pass");
  return player && isOnPitch(player) && canHailMary(state, player) ? player : null;
}

/** Punt: where the standing ball carrier may punt now, during a Punt action. */
const puntOptions = (state: GameState, proc: P<"MoveAction">) => {
  const player = state.players[proc.playerId]!;
  if (proc.action !== "punt" || proc.finished || player.status !== "standing" || !holdsBall(state, player) || !isOnPitch(player)) return null;
  return puntTargets(player);
};

const handOffOptions = (state: GameState, proc: P<"MoveAction">) => {
  const player = releasingBall(state, proc, "handoff");
  return player ? handOffTargets(state, player) : [];
};

/** Block and Throw Bomb actions do not move; Move and Blitz actions do. */
const activationMoves = (state: GameState, proc: P<"MoveAction">) =>
  proc.action === "block" || proc.action === "bomb" || proc.finished ? [] : legalMoves(state, state.players[proc.playerId]!);

/** Who the active player may block now: anyone adjacent for a Block, the declared target once for a Blitz. */
function activationTargets(state: GameState, proc: P<"MoveAction">) {
  const player = state.players[proc.playerId]!;
  if (proc.blocked || player.status !== "standing") return [];
  if (proc.action === "block") return adjacentTargets(state, player);
  if (proc.action !== "blitz" || player.movesUsed >= maxMoves(player)) return [];
  return adjacentTargets(state, player).filter((t) => t.id === proc.targetId);
}

/** The players the player may block now: those next to them, and in a Block action, with Vicious Vines, those 2 squares away. */
function blockTargets(state: GameState, proc: P<"MoveAction">) {
  const player = state.players[proc.playerId]!;
  // Fury of the Blood God: after the first block, a second one, once it is fully resolved.
  if (proc.blocked && (proc.extraBlocks ?? 0) > 0) return player.status === "standing" ? adjacentTargets(state, player) : [];
  const targets = activationTargets(state, proc);
  return proc.action === "block" && !proc.blocked ? [...targets, ...vineTargets(state, state.players[proc.playerId]!)] : targets;
}

/** Vicious Vines (once per half): the standing opponents exactly 2 squares away from the standing player. */
function vineTargets(state: GameState, player: PlayerState) {
  if (!hasSkill(player, "Vicious Vines") || player.usedThisHalf?.includes("Vicious Vines") || !isOnPitch(player) || player.status !== "standing") return [];
  return Object.values(state.players).filter(
    (p): p is PlayerState & { at: Square } =>
      p.side !== player.side && isOnPitch(p) && p.status === "standing" && Math.max(Math.abs(p.at.x - player.at.x), Math.abs(p.at.y - player.at.y)) === 2,
  );
}

/** Multiple Block: in a Block action (not a Blitz), the opponents the player may block two of, if there are two. */
function multipleBlockTargets(state: GameState, proc: P<"MoveAction">) {
  const player = state.players[proc.playerId]!;
  if (proc.action !== "block" || !hasSkill(player, "Multiple Block")) return [];
  const targets = activationTargets(state, proc);
  return targets.length >= 2 ? targets : [];
}

/** The skill behind each attack made instead of a block. */
const SPECIAL_ATTACKS = { VOMIT: "Projectile Vomit", STAB: "Stab", BREATHE_FIRE: "Breathe Fire", CHAINSAW: "Chainsaw", CHOMP: "Monstrous Mouth" } as const;

/**
 * Projectile Vomit, Stab, Breathe Fire, Chainsaw and a chomp (Monstrous Mouth) can replace any block the player could
 * make now; a chomp only on a player they have not chomped yet.
 */
const specialTargets = (state: GameState, proc: P<"MoveAction">, skill: P<"Vomit">["skill"]) => {
  const player = state.players[proc.playerId]!;
  const extra = extraSpecialTargets(state, proc, skill);
  if (!hasSkill(player, skill)) return extra;
  const targets = activationTargets(state, proc);
  const usual = skill === "Monstrous Mouth" ? targets.filter((t) => !t.chompedBy.includes(player.id)) : targets;
  return [...usual, ...extra.filter((t) => !usual.some((u) => u.id === t.id))];
};

/**
 * Special attacks a star player's rule gives: Putrid Regurgitation (once per half, a Projectile Vomit, even after the
 * player blocked in a Block or Blitz action), Kick 'em While They're Down! (once per game, in a Block action, a Chainsaw
 * attack on an adjacent prone or stunned opponent; not a foul), Maximum Carnage (once per game, right after a Chainsaw
 * attack, a second one on another adjacent standing opponent).
 */
function extraSpecialTargets(state: GameState, proc: P<"MoveAction">, skill: P<"Vomit">["skill"]): PlayerState[] {
  const player = state.players[proc.playerId]!;
  if (skill === "Projectile Vomit" && putrid(player) && isOnPitch(player) && player.status === "standing" && (proc.action === "block" || proc.action === "blitz")) {
    return proc.blocked ? adjacentTargets(state, player) : activationTargets(state, proc);
  }
  if (skill === "Chainsaw" && proc.carnage !== undefined && isOnPitch(player) && player.status === "standing") {
    return adjacentTargets(state, player).filter((p) => p.id !== proc.carnage);
  }
  if (skill === "Chainsaw" && proc.action === "block" && !proc.blocked) return downedTargets(state, player);
  return [];
}

/** Kick 'em While They're Down!: the prone or stunned opponents next to the player. */
function downedTargets(state: GameState, player: PlayerState): PlayerState[] {
  if (!hasSkill(player, "Chainsaw") || !hasSkill(player, "Kick 'em While They're Down!") || player.usedThisGame?.includes("Kick 'em While They're Down!")) return [];
  if (!isOnPitch(player) || player.status !== "standing") return [];
  return adjacent(player.at).flatMap((s) => {
    const p = playerAt(state, s);
    return p && p.side !== player.side && p.status !== "standing" ? [p] : [];
  });
}

/** Putrid Regurgitation is still unused this half. */
const putrid = (player: PlayerState) => hasSkill(player, "Putrid Regurgitation") && !player.usedThisHalf?.includes("Putrid Regurgitation");

/**
 * Diving Tackle: the tackler is placed prone in the square the player left, without an armour roll; a ball they held
 * bounces (no turnover, it is not their turn); then a trapdoor there. Returns the procedures to push.
 */
function diveIn(ctx: Ctx, tackler: PlayerState, square: Square): Procedure[] {
  const carrying = ctx.state.ball.carried && ballCarrier(ctx.state)?.id === tackler.id;
  const from = squareOf(ctx, tackler);
  tackler.at = { ...square };
  tackler.status = "prone";
  ctx.emit({ type: "PlayerMoved", playerId: tackler.id, from: { ...from }, to: { ...square } });
  ctx.emit({ type: "PlayerPlacedProne", playerId: tackler.id });
  const fall = trapdoor(ctx.state, tackler, square);
  if (!carrying) return fall;
  ctx.state.ball = { square: { ...square }, carried: false };
  return [dropBall(tackler, square), ...fall];
}

/**
 * Arm Bar: an opponent with the skill and a tackle zone next to the square a player left (or the diving tackler who
 * took it) when they fall after a failed dodge or jump; +1 to their armour or injury roll. Not against Iron Hard Skin.
 */
function armBarrer(state: GameState, player: PlayerState, from: Square): PlayerState | undefined {
  if (hasSkill(player, "Iron Hard Skin")) return undefined;
  const tackler = state.lastCheck?.divingTacklerId ? state.players[state.lastCheck.divingTacklerId] : undefined;
  const markers = adjacent(from).flatMap((s) => {
    const p = tackleZoneAt(state, s);
    return p && p.side !== player.side ? [p] : [];
  });
  return [...markers, ...(tackler ? [tackler] : [])].find((p) => hasSkill(p, "Arm Bar"));
}

/** Step a player (and the ball they carry) to an adjacent square, spending one square of movement. */
function movePlayer(ctx: Ctx, player: PlayerState, to: Square, squares = 1) {
  const from = squareOf(ctx, player);
  const { ball } = ctx.state;
  const moving = activation(ctx.state);
  if (ball.carried && ball.square && sameSquare(ball.square, from) && moving?.fumblerooski && moving.playerId === player.id) {
    // Fumblerooski: the ball stays in the square left, without bouncing.
    ball.carried = false;
    moving.fumblerooski = false;
    ctx.emit({ type: "SkillUsed", playerId: player.id, skill: "Fumblerooski" });
  } else if (ball.carried && ball.square && sameSquare(ball.square, from)) ball.square = { ...to };
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
  step(ctx, proc, action) {
    const { state } = ctx;
    const player = getPlayer(ctx, proc.playerId);
    if (proc.stage === "rush" && hasSkill(player, "Ball & Chain")) proc.stage = "chain";
    if (proc.stage === "chain" || proc.stage === "chainReroll" || proc.stage === "chainGo" || proc.stage === "chainBlock" || proc.stage === "chainArrive") {
      return chainStep(ctx, proc, action, player);
    }
    const squares = proc.jump ? 2 : 1;
    const check = (kind: CheckKind, target: number, modifier: number, leaving?: { from: Square; to: Square }) =>
      ctx.push({ type: "Check", kind, playerId: player.id, target, modifier, stage: "roll", rerolled: false, ...(leaving ? { leaving } : {}) });
    /**
     * Step onto the target square. A diving tackler is then placed prone in the square left; otherwise leaving tackle
     * zones (without jumping) gives Shadowing players a chance to follow.
     */
    const step = (): Procedure[] => {
      const from = { ...squareOf(ctx, player) };
      movePlayer(ctx, player, proc.to, proc.hitAndRun ? 0 : squares);
      // Treacherous Trapdoor: rolled as soon as the player is in the square.
      const fall = trapdoor(state, player, proc.to);
      const tacklerId = state.lastCheck?.divingTacklerId;
      if (tacklerId) return [...fall, ...diveIn(ctx, getPlayer(ctx, tacklerId), from)];
      return [...fall, ...(proc.jump || proc.hitAndRun || proc.onTheBall === "kickoff" ? [] : [{ type: "Shadow" as const, playerId: player.id, from, stage: "select" as const }])];
    };
    /** Falling after a failed dodge or jump (`armBar`) or a failed Rush, in the target square or the starting one. */
    const fall = (inStartSquare = false, armBar = false) => {
      const bar = armBar && !inStartSquare ? armBarrer(state, player, squareOf(ctx, player)) : undefined;
      ctx.push(...(inStartSquare ? [] : step()), {
        type: "KnockDown",
        playerId: player.id,
        turnover: !proc.onTheBall,
        stage: "fall",
        fallsOver: true,
        // Arm Bar: a casualty earns the Arm Bar player Star Player Points.
        ...(bar ? { mightyBlow: { playerId: bar.id, bonus: 1, skill: "Arm Bar" }, sppTo: [bar.id] } : {}),
      });
      proc.stage = "fell";
      proc.fellInPlace = inStartSquare;
      return "continue" as const;
    };
    /** On the target square: pick up a loose ball there, or score. */
    const arrive = () => {
      const { ball } = state;
      if (ball.square && !ball.carried && sameSquare(ball.square, proc.to)) {
        state.lastCheck = null;
        proc.stage = "pickup";
        // Secure the Ball picks up on a 2+ instead of the player's AG.
        const target = securing(state, player) ? SECURE_TARGET : player.ag;
        check("pickup", target, pickupModifier(state, player, proc.to));
        return "continue" as const;
      }
      checkTouchdown(ctx, player);
      return "done" as const;
    };

    switch (proc.stage) {
      case "rush":
        state.lastCheck = null;
        proc.stage = proc.jump ? "rush2" : "dodge";
        if (player.movesUsed >= player.ma && !proc.onTheBall && !proc.hitAndRun) check("rush", RUSH_TARGET, rushModifier(state, player));
        return "continue";
      case "rush2":
        if (failed(ctx)) return fall(true);
        state.lastCheck = null;
        proc.stage = "dodge";
        if (player.movesUsed + 1 >= player.ma && !proc.onTheBall) check("rush", RUSH_TARGET, rushModifier(state, player));
        return "continue";
      case "dodge":
        if (failed(ctx)) return fall(proc.jump);
        if (proc.held) return holdInPlace(ctx, proc, player);
        // Tentacles: the opponents may first try to hold a player dodging or jumping away.
        if (!proc.tentacles && !proc.hitAndRun && tentaclers(state, player, squareOf(ctx, player)).length > 0) {
          proc.tentacles = true;
          state.lastCheck = null;
          ctx.push({ type: "Tentacles", playerId: player.id, from: { ...squareOf(ctx, player) }, stage: "select" });
          return "continue";
        }
        // Bounding Leap: once per game, before the jump roll, the player may ignore its negative modifiers.
        if (proc.jump && proc.bounding === undefined && hasSkill(player, "Bounding Leap") && !player.usedThisGame?.includes("Bounding Leap")) {
          proc.stage = "bounding";
          return "continue";
        }
        state.lastCheck = null;
        proc.stage = "move";
        const leaving = { from: { ...squareOf(ctx, player) }, to: { ...proc.to } };
        if (proc.jump && proc.bounding) {
          // ...and re-roll it if it fails.
          ctx.push({ type: "Check", kind: "jump", playerId: player.id, target: player.ag, modifier: Math.max(0, jumpModifier(state, player, leaving.from, proc.to)), stage: "roll", rerolled: false, leaving, skillReroll: "Bounding Leap" });
        } else if (proc.jump) {
          check("jump", player.ag, jumpModifier(state, player, leaving.from, proc.to), leaving);
        } else if (!proc.hitAndRun && !player.incorporeal && tackleZones(state, player.side, leaving.from) > 0) {
          check("dodge", player.ag, dodgeModifier(state, player, leaving.from, proc.to), leaving);
        }
        return "continue";
      case "bounding":
        if (action === null) return "wait";
        proc.bounding = ctx.expect(action, "USE_SKILL").use;
        if (proc.bounding) useOncePerGame(ctx, player, "Bounding Leap");
        proc.stage = "dodge";
        return "continue";
      case "move":
        if (failed(ctx)) return fall(proc.jump && state.lastCheck?.roll === 1, true);
        ctx.push(...step());
        proc.stage = "arrive";
        return "continue";
      case "arrive":
        // A shadowing ball carrier may have scored for the other team; a trapdoor may have swallowed the player.
        return state.touchdown === null && isOnPitch(player) ? arrive() : "done";
      case "fell":
        // Steady Footing kept the player up: the move goes on from where they are.
        if (player.status !== "standing" || proc.fellInPlace) return "done";
        return arrive();
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
  actions(state, proc) {
    const player = state.players[proc.playerId]!;
    if (proc.stage === "chainReroll") return [{ type: "USE_SKILL", side: player.side, playerId: player.id, skill: "Whirling Dervish" }];
    if (proc.stage === "bounding") return [{ type: "USE_SKILL", side: player.side, playerId: player.id, skill: "Bounding Leap" }];
    if (proc.stage !== "chain") return [];
    return [{ type: "ROLL", side: player.side, dice: [{ kind: "d6", count: 1 }], reason: `Ball & Chain direction (${player.name})` }];
  },
};

/** Ball & Chain: the four squares next to the player (not diagonally) on the pitch. */
const chainSides = (player: PlayerState & { at: Square }) =>
  [{ x: 0, y: -1 }, { x: 1, y: 0 }, { x: 0, y: 1 }, { x: -1, y: 0 }].map((d) => ({ x: player.at.x + d.x, y: player.at.y + d.y })).filter(inBounds);

/**
 * Ball & Chain: each step, the coach picks a side; a D6 on the throw-in template facing it gives the square the player
 * goes to, ignoring tackle zones (no dodge, Tentacles, Diving Tackle or Shadowing). Into a player of either team: a
 * block from where the player stands (a Rush first if needed; a failed one is a fall, a turnover). Into an empty
 * square: the player moves, then rolls any Rush (falling there on a failure, a turnover); a loose ball there bounces,
 * without a turnover (the player never picks it up). Off the pitch: the crowd, a turnover.
 */
function chainStep(ctx: Ctx, proc: P<"MoveStep">, action: Action | null, player: PlayerState): StepResult {
  const { state } = ctx;
  const from = squareOf(ctx, player);
  if (proc.stage === "chain") {
    if (action === null) return "wait";
    // The side the coach picked, kept for a re-roll of the direction.
    proc.chainSide ??= { ...proc.to };
    const [roll] = ctx.roll(action, [{ kind: "d6", count: 1 }], "Ball & Chain direction");
    const dir = templateDirection({ x: Math.sign(proc.chainSide.x - from.x), y: Math.sign(proc.chainSide.y - from.y) }, roll!);
    proc.to = { x: from.x + dir.x, y: from.y + dir.y };
    // Whirling Dervish: once per activation, the direction may be rolled again.
    if (hasSkill(player, "Whirling Dervish") && !player.usedSkills.includes("Whirling Dervish")) {
      proc.stage = "chainReroll";
      return "wait";
    }
    proc.stage = "chainGo";
  }
  if (proc.stage === "chainReroll") {
    if (action === null) return "wait";
    if (ctx.expect(action, "USE_SKILL").use) {
      player.usedSkills.push("Whirling Dervish");
      ctx.emit({ type: "SkillUsed", playerId: player.id, skill: "Whirling Dervish" });
      proc.stage = "chain";
      return "wait";
    }
    proc.stage = "chainGo";
  }
  if (proc.stage === "chainGo") {
    const to = { ...proc.to };
    const rush = player.movesUsed >= player.ma;
    if (!inBounds(to)) {
      // Into the crowd: an injury roll, a turnover.
      player.movesUsed += 1;
      player.at = "reserves";
      ctx.emit({ type: "PlayerPushed", playerId: player.id, from: { ...from }, to: null });
      ctx.push({ type: "Crowd", playerId: player.id, from: { ...from }, hadBall: false });
      state.turnover = true;
      return "done";
    }
    state.lastCheck = null;
    const occupant = playerAt(state, to);
    if (occupant) {
      proc.stage = "chainBlock";
      if (rush) ctx.push({ type: "Check", kind: "rush", playerId: player.id, target: RUSH_TARGET, modifier: rushModifier(state, player), stage: "roll", rerolled: false });
      return "continue";
    }
    movePlayer(ctx, player, to, 1);
    ctx.push(...trapdoor(state, player, to));
    proc.stage = "chainArrive";
    if (rush) ctx.push({ type: "Check", kind: "rush", playerId: player.id, target: RUSH_TARGET, modifier: rushModifier(state, player), stage: "roll", rerolled: false });
    return "continue";
  }
  if (failed(ctx)) {
    ctx.push({ type: "KnockDown", playerId: player.id, turnover: true, stage: "fall", fallsOver: true });
    return "done";
  }
  if (proc.stage === "chainBlock") {
    player.movesUsed += 1;
    const defender = playerAt(state, proc.to)!;
    const dice = blockDice(state, player, defender);
    ctx.emit({ type: "BlockDeclared", attackerId: player.id, defenderId: defender.id, dice });
    ctx.push({ type: "Block", attackerId: player.id, defenderId: defender.id, blitz: false, stage: "appearance", dice, rerolled: false, chain: [], ballAndChain: true });
    return "done";
  }
  const { ball } = state;
  if (isOnPitch(player) && ball.square && !ball.carried && sameSquare(ball.square, proc.to)) ctx.push({ type: "Bounce", from: { ...proc.to }, kickoff: false, receiving: null });
  return "done";
}

/** Tentacles: D6 + the Tentacles player's ST - the mover's ST must reach 6. */
export const TENTACLES_TARGET = 6;

/** Opponents with Tentacles and a tackle zone next to the square the player leaves. */
export function tentaclers(state: GameState, player: PlayerState, from: Square): PlayerState[] {
  return adjacent(from).flatMap((s) => {
    const p = tackleZoneAt(state, s);
    return p && p.side !== player.side && hasSkill(p, "Tentacles") ? [p] : [];
  });
}

/** Held by Tentacles: the player stays in the starting square and their action (or On the Ball move) ends, no turnover. */
function holdInPlace(ctx: Ctx, proc: P<"MoveStep">, player: PlayerState): StepResult {
  const activation = ctx.state.stack.findLast((p): p is P<"MoveAction"> => p.type === "MoveAction" && p.playerId === player.id);
  if (activation) activation.finished = true;
  if (proc.onTheBall) player.movesUsed = ON_THE_BALL_SQUARES;
  return "done";
}

/**
 * Tentacles: when a player dodges or jumps away from opponents with the skill (after any Rush), their coach may pick one
 * of them, who rolls a D6 + their ST - the mover's ST (a 1 always fails, a 6 always succeeds) and needs 6, without a
 * team re-roll (it is not their turn). On a success the mover is held in the starting square and their action ends.
 */
export const Tentacles: Handler<P<"Tentacles">> = {
  step(ctx, proc, action) {
    const { state } = ctx;
    const player = getPlayer(ctx, proc.playerId);
    if (proc.stage === "result") {
      const held = state.lastCheck?.kind === "tentacles" && state.lastCheck.success;
      state.lastCheck = null;
      if (held) {
        ctx.emit({ type: "SkillUsed", playerId: proc.tentaclerId!, skill: "Tentacles" });
        const move = state.stack.findLast((p): p is P<"MoveStep"> => p.type === "MoveStep" && p.playerId === player.id);
        if (move) move.held = true;
      }
      return "done";
    }
    const candidates = tentaclers(state, player, proc.from);
    if (candidates.length === 0) return "done";
    if (action === null) return "wait";
    const { playerIds } = ctx.expect(action, "SELECT_PLAYERS");
    const id = playerIds[0];
    if (playerIds.length > 1 || (id !== undefined && !candidates.some((c) => c.id === id))) ctx.reject("Invalid Tentacles player.");
    if (id === undefined) return "done";
    const holder = getPlayer(ctx, id);
    proc.tentaclerId = id;
    ctx.push({ type: "Check", kind: "tentacles", playerId: id, target: TENTACLES_TARGET, modifier: holder.st - player.st, stage: "roll", rerolled: false });
    proc.stage = "result";
    return "continue";
  },
  actions(state, proc) {
    const player = state.players[proc.playerId]!;
    const playerIds = tentaclers(state, player, proc.from).map((p) => p.id);
    return [{ type: "SELECT_PLAYERS", side: other(player.side), playerIds, max: 1, reason: `Tentacles: choose a player to try to hold ${player.name}` }];
  },
};

/** Shadowing succeeds on 4+. */
export const SHADOWING_TARGET = 4;

/**
 * Opponents who may shadow a player who left `from`: standing next to it with a tackle zone and Shadowing, not rooted,
 * and not yet used it as many times this turn as their MA.
 */
export function shadowers(state: GameState, mover: PlayerState, from: Square): PlayerState[] {
  if (playerAt(state, from)) return [];
  return adjacent(from).flatMap((s) => {
    const p = tackleZoneAt(state, s);
    if (!p || p.side === mover.side || !hasSkill(p, "Shadowing") || isPinned(state, p)) return [];
    return p.usedSkills.filter((u) => u === "Shadowing").length < p.ma ? [p] : [];
  });
}

/**
 * Shadowing: when a player moves out of tackle zones of opponents with the skill, their coach may pick one of them to
 * roll a D6; on 4+ the shadower moves into the square left, without any roll and without using their own movement.
 */
export const Shadow: Handler<P<"Shadow">> = {
  step(ctx, proc, action) {
    const { state } = ctx;
    const mover = getPlayer(ctx, proc.playerId);
    if (proc.stage === "result") {
      if (state.lastCheck?.kind !== "shadowing" || !state.lastCheck.success) return "done";
      const shadower = getPlayer(ctx, proc.shadowerId!);
      ctx.emit({ type: "SkillUsed", playerId: shadower.id, skill: "Shadowing" });
      const from = squareOf(ctx, shadower);
      const { ball } = state;
      if (ball.carried && ball.square && sameSquare(ball.square, from)) ball.square = { ...proc.from };
      shadower.at = { ...proc.from };
      ctx.emit({ type: "PlayerMoved", playerId: shadower.id, from: { ...from }, to: { ...proc.from } });
      checkTouchdown(ctx, shadower);
      ctx.push(...trapdoor(state, shadower, proc.from));
      return "done";
    }
    const candidates = shadowers(state, mover, proc.from);
    if (candidates.length === 0) return "done";
    if (action === null) return "wait";
    const { playerIds } = ctx.expect(action, "SELECT_PLAYERS");
    const id = playerIds[0];
    if (playerIds.length > 1 || (id !== undefined && !candidates.some((c) => c.id === id))) ctx.reject("Invalid shadower.");
    if (id === undefined) return "done";
    const shadower = getPlayer(ctx, id);
    shadower.usedSkills.push("Shadowing");
    proc.shadowerId = id;
    proc.stage = "result";
    state.lastCheck = null;
    ctx.push({ type: "Check", kind: "shadowing", playerId: id, target: SHADOWING_TARGET, modifier: 0, stage: "roll", rerolled: false });
    return "continue";
  },
  actions(state, proc) {
    if (proc.stage !== "select") return [];
    const mover = state.players[proc.playerId]!;
    const playerIds = shadowers(state, mover, proc.from).map((p) => p.id);
    return [{ type: "SELECT_PLAYERS", side: other(mover.side), playerIds, max: 1, reason: `Shadowing: choose a player to follow ${mover.name}` }];
  },
};

/** Hypnotic Gaze works on 3+. */
export const HYPNOTIC_GAZE_TARGET = 3;

/**
 * Hypnotic Gaze (a special action, after an optional move): Foul Appearance and Dump-off first, then a D6 (team re-roll allowed);
 * on 3+ the adjacent opponent is distracted until their next activation (no tackle zone, cannot catch, assist...).
 * The activation ends either way, without a turnover.
 */
export const Gaze: Handler<P<"Gaze">> = {
  step(ctx, proc) {
    const { state } = ctx;
    const player = getPlayer(ctx, proc.playerId);
    const victim = getPlayer(ctx, proc.victimId);
    if (proc.stage === "appearance") {
      rollFoulAppearance(ctx, player, victim);
      proc.stage = "appearanceResult";
      return "continue";
    }
    if (proc.stage === "appearanceResult") {
      if (revolted(ctx, player)) return "done";
      ctx.push(...dumpOff({ attackerId: player.id, defenderId: victim.id }));
      proc.stage = "gaze";
      return "continue";
    }
    if (proc.stage === "gaze") {
      // A Dump-off may score a touchdown.
      if (state.touchdown !== null) return "done";
      ctx.push({ type: "Check", kind: "gaze", playerId: player.id, target: HYPNOTIC_GAZE_TARGET, modifier: 0, stage: "roll", rerolled: false });
      proc.stage = "result";
      return "continue";
    }
    if (state.lastCheck?.kind === "gaze" && state.lastCheck.success) {
      victim.distracted = true;
      ctx.emit({ type: "PlayerHypnotised", playerId: player.id, victimId: victim.id });
    }
    return "done";
  },
  actions: () => [],
};

/** On the Ball: squares moved, whatever the player's MA, and never a Rush. */
export const ON_THE_BALL_SQUARES = 3;

/** Squares an On the Ball move may step or jump to; at the kick-off, only in the team's own half. */
export function onTheBallMoves(state: GameState, player: PlayerState, kickoff: boolean): Array<Square & { rolls: CheckKind[]; jump?: boolean }> {
  if (!isOnPitch(player) || player.status !== "standing" || isPinned(state, player)) return [];
  const left = ON_THE_BALL_SQUARES - player.movesUsed;
  const allowed = (s: Square) => !kickoff || inHalf(player.side, s);
  const dodge: CheckKind[] = tackleZones(state, player.side, player.at) > 0 ? ["dodge"] : [];
  const steps = left < 1 ? [] : adjacent(player.at).filter((s) => !playerAt(state, s) && allowed(s)).map((s) => ({ ...s, rolls: dodge }));
  const jumps = left < 2 ? [] : jumpSquares(state, player).filter(allowed).map((s) => ({ ...s, jump: true, rolls: ["jump" as const] }));
  return [...steps, ...jumps];
}

/**
 * Players who may still make an On the Ball move: on the pitch with a tackle zone and not rooted; at the kick-off only
 * one, not marked by an opponent.
 */
function onTheBallPlayers(state: GameState, proc: P<"OnTheBall">): PlayerState[] {
  if (proc.kickoff && proc.moved.length > 0) return [];
  return teamPlayers(state, proc.side).filter(
    (p) =>
      isOnPitch(p) && hasTackleZone(p) && !isPinned(state, p) && hasSkill(p, "On the Ball") && !proc.moved.includes(p.id) &&
      (!proc.kickoff || tackleZones(state, p.side, p.at) === 0),
  );
}

/**
 * On the Ball: when an opponent declares a pass (after Animosity, before the throw), each player with the skill may
 * move up to three squares, one player at a time, following the normal movement rules but without Rushing; a fall ends
 * these moves (not a turnover). After the kick-off deviation (unless it is a touchback), one unmarked receiving player
 * with the skill may move the same way, in their own half. Team re-rolls are allowed at the kick-off only.
 */
export const OnTheBall: Handler<P<"OnTheBall">> = {
  step(ctx, proc, action) {
    const { state } = ctx;
    if (proc.stage === "move") {
      const player = getPlayer(ctx, proc.playerId!);
      const fell = player.status !== "standing" || !isOnPitch(player);
      const squares = onTheBallMoves(state, player, proc.kickoff);
      if (!fell && squares.length > 0) {
        if (action === null) return "wait";
        const a = ctx.expect(action, "MOVE", "DONE");
        if (a.type === "MOVE") {
          const to = squares.find((s) => sameSquare(s, a.square)) ?? ctx.reject("Illegal move.");
          ctx.push({ type: "MoveStep", playerId: player.id, to: { x: to.x, y: to.y }, stage: "rush", onTheBall: proc.kickoff ? "kickoff" : "pass", ...(to.jump ? { jump: true } : {}) });
          return "continue";
        }
      }
      player.movesUsed = 0;
      proc.moved.push(player.id);
      delete proc.playerId;
      if (fell) return "done";
      proc.stage = "select";
      return "continue";
    }
    const candidates = onTheBallPlayers(state, proc);
    if (candidates.length === 0) return "done";
    if (action === null) return "wait";
    const { playerIds } = ctx.expect(action, "SELECT_PLAYERS");
    const id = playerIds[0];
    if (playerIds.length > 1 || (id !== undefined && !candidates.some((c) => c.id === id))) ctx.reject("Invalid player.");
    if (id === undefined) return "done";
    getPlayer(ctx, id).movesUsed = 0;
    ctx.emit({ type: "SkillUsed", playerId: id, skill: "On the Ball" });
    proc.playerId = id;
    proc.stage = "move";
    return "continue";
  },
  actions(state, proc) {
    if (proc.stage === "move") {
      const player = state.players[proc.playerId!]!;
      return [
        { type: "MOVE", side: proc.side, playerId: player.id, squares: onTheBallMoves(state, player, proc.kickoff) },
        { type: "DONE", side: proc.side },
      ];
    }
    const when = proc.kickoff ? "the kick-off" : "the pass";
    const playerIds = onTheBallPlayers(state, proc).map((p) => p.id);
    return [{ type: "SELECT_PLAYERS", side: proc.side, playerIds, max: 1, reason: `On the Ball: choose a player to move up to 3 squares before ${when}` }];
  },
};

/** Pick-me-up stands a prone player up on 5+. */
export const PICK_ME_UP_TARGET = 5;

/** Pick-me-up: prone (not stunned) players of `side` within 3 squares of a standing team-mate with the skill. */
function pickMeUpCandidates(state: GameState, side: Side): string[] {
  const helpers = teamPlayers(state, side).filter((p) => isOnPitch(p) && hasTackleZone(p) && hasSkill(p, "Pick-me-up"));
  return teamPlayers(state, side)
    .filter((p): p is PlayerState & { at: Square } => isOnPitch(p) && p.status === "prone")
    .filter((p) => helpers.some((h) => isOnPitch(h) && Math.max(Math.abs(h.at.x - p.at.x), Math.abs(h.at.y - p.at.y)) <= 3))
    .map((p) => p.id);
}

/**
 * Pick-me-up: at the end of the opposing team's turn (not after a touchdown or the last turn of the half), the coach
 * chooses any of their prone players within 3 squares of a standing team-mate with the skill; each rolls a D6 and stands
 * up on 5+. The coach may choose again among the others until they choose nobody.
 */
export const PickMeUp: Handler<P<"PickMeUp">> = {
  step(ctx, proc, action) {
    if (proc.stage === "select" && proc.playerIds.length === 0) return "done";
    if (action === null) return "wait";
    if (proc.stage === "select") {
      const { playerIds } = ctx.expect(action, "SELECT_PLAYERS");
      if (playerIds.some((id) => !proc.playerIds.includes(id)) || new Set(playerIds).size !== playerIds.length) ctx.reject("Invalid player.");
      if (playerIds.length === 0) return "done";
      proc.selected = [...playerIds];
      proc.playerIds = proc.playerIds.filter((id) => !playerIds.includes(id));
      proc.stage = "roll";
      return "wait";
    }
    const rolls = ctx.roll(action, [{ kind: "d6", count: proc.selected.length }], `Pick-me-up ${PICK_ME_UP_TARGET}+`);
    proc.selected.forEach((id, i) => {
      const player = getPlayer(ctx, id);
      const success = rolls[i]! >= PICK_ME_UP_TARGET;
      ctx.emit({ type: "CheckResult", kind: "pickmeup", playerId: id, success, roll: rolls[i]!, target: PICK_ME_UP_TARGET });
      if (success && player.status === "prone") {
        player.status = "standing";
        ctx.emit({ type: "PlayerStoodUp", playerId: id });
      }
    });
    proc.selected = [];
    proc.stage = "select";
    return proc.playerIds.length === 0 ? "done" : "wait";
  },
  actions(_state, proc) {
    if (proc.stage === "roll") {
      return [{ type: "ROLL", side: proc.side, dice: [{ kind: "d6", count: proc.selected.length }], reason: `Pick-me-up ${PICK_ME_UP_TARGET}+` }];
    }
    return [{ type: "SELECT_PLAYERS", side: proc.side, playerIds: proc.playerIds, max: proc.playerIds.length, reason: "Pick-me-up: choose prone players to try to stand up (5+)" }];
  },
};
