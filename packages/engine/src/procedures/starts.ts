import type { Ctx, Handler } from "../context";
import type { GameState, PlayerActionType, PlayerState, Procedure, Square } from "../types";
import { adjacent, ballCarrier, hasTackleZone, isOnPitch, other, playerAt, tackleZones } from "../pitch";
import { trapdoor } from "./prayers";
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
  Treacherous: "game",
  "Beer Barrel Bash!": "drive",
  "Blastin' Solves Everything": "half",
  "Shot to Nothing": "game",
  "Frenzied Rush": "half",
  "Slashing Nails": "half",
  Incorporeal: "game",
  "Wisdom of the White Dwarf": "game",
  "Raiding Party": "drive",
  "The Flashing Blade": "game",
};

/** Raiding Party: how far the team-mate may be. */
export const RAIDING_PARTY_RANGE = 5;

/** Wisdom of the White Dwarf: the skills a team-mate may gain until the end of the turn. */
export const WISDOM_SKILLS = ["Break Tackle", "Dauntless", "Mighty Blow", "Sure Feet"];

/** The start of a turn: the skills gained until the end of the previous one are lost. */
export function loseTurnSkills(player: PlayerState) {
  for (const skill of player.turnSkills ?? []) player.skills.splice(player.skills.lastIndexOf(skill), 1);
  delete player.turnSkills;
}

/** Rules that give the player a skill until the end of their activation. */
const GAINS: Record<string, string> = {
  "Shot to Nothing": "Hail Mary Pass",
  "Frenzied Rush": "Frenzy",
  "Slashing Nails": "Claws",
};

/** The end of the activation (or the start of the next team turn): the skills a rule gave are lost. */
export function loseGainedSkills(player: PlayerState) {
  for (const skill of player.gained ?? []) player.skills.splice(player.skills.lastIndexOf(skill), 1);
  delete player.gained;
  delete player.incorporeal;
}

/** Baleful Hex works on 2+. */
export const BALEFUL_HEX_TARGET = 2;

/** The D6 a start-of-activation rule rolls after its target is picked, if any. */
const ROLLS: Record<string, { target: number; reason: string; always?: boolean }> = {
  "Baleful Hex": { target: BALEFUL_HEX_TARGET, reason: "Baleful Hex" },
  "Look Into My Eyes": { target: 2, reason: "Look Into My Eyes" },
  "Catch of the Day": { target: 3, reason: "Catch of the Day" },
  "Beer Barrel Bash!": { target: 3, reason: "Beer Barrel Bash!", always: true },
  "Blastin' Solves Everything": { target: 3, reason: "Blastin' Solves Everything", always: true },
};

/** Rules without a player to pick, and when they can be used (`action`: the action the player declared). */
const UNTARGETED: Record<string, (state: GameState, player: PlayerState, action: PlayerActionType) => boolean> = {
  "Shot to Nothing": (_state, player) => !hasSkill(player, "Hail Mary Pass"),
  "Frenzied Rush": (_state, player, action) => action === "blitz" && !hasSkill(player, "Frenzy"),
  "Slashing Nails": (_state, player, action) => action === "blitz" && !hasSkill(player, "Claws"),
  Incorporeal: () => true,
  "Raiding Party": (state, player) => raiders(state, player).length > 0,
  // A standing player within 3 squares of the ball on the ground.
  "Catch of the Day": (state, player) => {
    const { ball } = state;
    return player.status === "standing" && isOnPitch(player) && !ball.carried && ball.square !== null && Math.max(Math.abs(ball.square.x - player.at.x), Math.abs(ball.square.y - player.at.y)) <= 3;
  },
};

/** Raiding Party: the open team-mates within 5 squares, and the free squares next to them that are next to an opponent. */
function raiders(state: GameState, player: PlayerState) {
  if (!isOnPitch(player)) return [];
  return Object.values(state.players).flatMap((p) => {
    if (p.id === player.id || p.side !== player.side || !isOnPitch(p) || p.status !== "standing" || !hasTackleZone(p)) return [];
    if (Math.max(Math.abs(p.at.x - player.at.x), Math.abs(p.at.y - player.at.y)) > RAIDING_PARTY_RANGE || tackleZones(state, p.side, p.at) > 0) return [];
    const squares = adjacent(p.at).filter((s) => !playerAt(state, s) && adjacent(s).some((n) => playerAt(state, n)?.side === other(p.side)));
    return squares.length > 0 ? [{ playerId: p.id, squares }] : [];
  });
}

/** "Blastin' Solves Everything" on a 2: the standing players within 3 squares of the target, but the player. */
const redirectTargets = (state: GameState, player: PlayerState, target: PlayerState) =>
  !isOnPitch(target)
    ? []
    : Object.values(state.players).filter(
        (p) => p.id !== player.id && isOnPitch(p) && p.status === "standing" && Math.max(Math.abs(p.at.x - target.at.x), Math.abs(p.at.y - target.at.y)) <= 3,
      );

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
    case "The Flashing Blade":
      return player.status === "standing" ? marked(state, player) : [];
    case "Excuse me, are you a Zoat?":
      return opponentsWithin(state, player, 3).filter((p) => hasTackleZone(p));
    case "Baleful Hex":
      return opponentsWithin(state, player, 5);
    case "Look Into My Eyes":
      return marked(state, player).filter((p) => ballCarrier(state)?.id === p.id);
    case "Beer Barrel Bash!":
      return player.status === "standing" ? opponentsWithin(state, player, 3).filter((p) => p.status === "standing") : [];
    case "Blastin' Solves Everything":
      return opponentsWithin(state, player, 3).filter((p) => p.status === "standing");
    case "Wisdom of the White Dwarf":
      return !isOnPitch(player)
        ? []
        : Object.values(state.players).filter(
            (p) => p.id !== player.id && p.side === player.side && isOnPitch(p) && Math.max(Math.abs(p.at.x - player.at.x), Math.abs(p.at.y - player.at.y)) <= 2 && WISDOM_SKILLS.some((s) => !hasSkill(p, s)),
          );
    case "Treacherous":
      return isOnPitch(player) ? adjacent(player.at).flatMap((s) => (ballCarrier(state)?.id === playerAt(state, s)?.id && playerAt(state, s)?.side === player.side ? [playerAt(state, s)!] : [])) : [];
    default:
      return [];
  }
}

/** The special rules the player may use now, at the start of their activation (see `StartSkill`). */
export function activationSkills(state: GameState, player: PlayerState, action: PlayerActionType): string[] {
  return Object.keys(PERIODS).filter((skill) => ruleLeft(player, skill) && (UNTARGETED[skill]?.(state, player, action) ?? targets(state, player, skill).length > 0));
}

/**
 * Special rules used at the start of an activation:
 * - Black Ink (once per game): an opponent the player marks becomes Distracted until their next activation.
 * - "Excuse me, are you a Zoat?" (once per game): an opponent within 3 squares (with a tackle zone) becomes Distracted.
 * - Baleful Hex (once per game): a D6 against an opponent within 5 squares: on 2+ they become Distracted and cannot be
 *   activated during their team's next turn.
 * - Look Into My Eyes (once per game): a D6 against the opponent with the ball the player marks: on 2+ the player takes
 *   the ball, and their activation ends.
 * - Treacherous (once per game): the player takes the ball from the team-mate next to them who holds it; the team-mate is
 *   knocked down, without a turnover (even if they are hurt).
 * - Beer Barrel Bash! (once per drive): a standing player rolls a D6 against a standing opponent within 3 squares: on
 *   3+ the opponent is knocked down, on a 2 nothing happens, on a 1 the player falls over (a turnover). The activation
 *   ends.
 * - "Blastin' Solves Everything" (once per half): a D6 against a standing opponent within 3 squares: on 3+ they are hit,
 *   on a 2 the opposing coach picks a standing player (of either team, not the player) within 3 squares of them to be
 *   hit instead, on a 1 the player is hit. The player hit rolls armour (and is placed prone if it breaks). The
 *   activation ends.
 * - Shot to Nothing (once per game): the player gains Hail Mary Pass until the end of the activation.
 * - Frenzied Rush (once per half): declaring a Blitz, the player gains Frenzy until the end of the activation; they may
 *   not use Grab that turn.
 * - Slashing Nails (once per half): declaring a Blitz, the player gains Claws until the end of the activation.
 * - Wisdom of the White Dwarf (once per game): a team-mate within 2 squares gains Break Tackle, Dauntless, Mighty Blow or
 *   Sure Feet (one they lack, the coach picks) until the end of the turn.
 * - Raiding Party (once per drive): an open team-mate within 5 squares (standing, not marked) moves one square, to a
 *   free square next to an opponent, without any roll.
 * - The Flashing Blade (once per game): the player stabs an opponent they mark, then may go on with a Move action.
 * - Incorporeal (once per game): until the end of the activation, the player makes no Dodge rolls for leaving opponents'
 *   tackle zones.
 * - Catch of the Day (once per half): a standing player within 3 squares of the ball on the ground rolls a D6: on 3+ they
 *   pick it up, without a roll; the activation goes on.
 */
export const StartSkill: Handler<P<"StartSkill">> = {
  step(ctx, proc, action) {
    const { state } = ctx;
    const player = getPlayer(ctx, proc.playerId);
    const choices = targets(state, player, proc.skill);
    if (proc.skill === "Raiding Party") {
      if (action === null) return "wait";
      const a = ctx.expect(action, "SNAP", "DONE");
      if (a.type === "DONE") return "done";
      const move = raiders(state, player).find((m) => m.playerId === a.playerId);
      if (!move?.squares.some((s) => s.x === a.square.x && s.y === a.square.y)) ctx.reject("Move an open team-mate next to an opponent.");
      useRule(ctx, player, proc.skill);
      const raider = getPlayer(ctx, a.playerId);
      const from = squareOf(ctx, raider);
      const { ball } = state;
      if (ball.carried && ball.square && ball.square.x === from.x && ball.square.y === from.y) ball.square = { ...a.square };
      raider.at = { ...a.square };
      ctx.emit({ type: "PlayerMoved", playerId: raider.id, from: { ...from }, to: { ...a.square } });
      ctx.push(...trapdoor(state, raider, a.square));
      // A loose ball where the team-mate stops bounces (there is no pick-up).
      if (!ball.carried && ball.square && ball.square.x === a.square.x && ball.square.y === a.square.y) {
        ctx.push({ type: "Bounce", from: { ...a.square }, kickoff: false, receiving: null });
      }
      checkTouchdown(ctx, raider);
      return "done";
    }
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
      proc.stage = ROLLS[proc.skill] ? "roll" : proc.skill === "Wisdom of the White Dwarf" ? "choose" : "effect";
      if (proc.stage !== "effect") return "wait";
    }
    const target = proc.targetId === undefined ? player : getPlayer(ctx, proc.targetId);
    if (proc.stage === "choose") {
      if (action === null) return "wait";
      const { skill } = ctx.expect(action, "CHOOSE_SKILL");
      if (!WISDOM_SKILLS.includes(skill) || hasSkill(target, skill)) ctx.reject("Choose a skill the player does not have.");
      target.skills.push(skill);
      target.turnSkills = [...(target.turnSkills ?? []), skill];
      ctx.emit({ type: "SkillGained", playerId: target.id, skill });
      return "done";
    }
    if (proc.stage === "redirect") {
      const victims = redirectTargets(state, player, target);
      if (victims.length === 0) return "done";
      if (action === null) return "wait";
      const { playerIds } = ctx.expect(action, "SELECT_PLAYERS");
      const victim = victims.find((p) => p.id === playerIds[0]) ?? ctx.reject("Choose a player to hit.");
      ctx.push({ type: "KnockDown", playerId: victim.id, turnover: false, stage: "armour", armourOnly: true });
      return "done";
    }
    if (proc.stage === "roll") {
      if (action === null) return "wait";
      const { target: needed, reason, always } = ROLLS[proc.skill]!;
      const [roll] = ctx.roll(action, [{ kind: "d6", count: 1 }], `${reason} ${needed}+`);
      ctx.emit({ type: "CheckResult", kind: "rule", playerId: player.id, success: roll! >= needed, roll: roll!, target: needed });
      proc.roll = roll!;
      // `always`: the effect depends on the roll, a failure included.
      if (roll! < needed && !always) return "done";
      proc.stage = "effect";
    }
    const gain = GAINS[proc.skill];
    if (gain) {
      player.skills.push(gain);
      player.gained = [...(player.gained ?? []), gain];
      return "done";
    }
    switch (proc.skill) {
      case "Incorporeal":
        player.incorporeal = true;
        return "done";
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
      case "Blastin' Solves Everything":
        endActivation(state, player);
        if (proc.roll === 2) {
          proc.stage = "redirect";
          return "continue";
        }
        ctx.push({ type: "KnockDown", playerId: proc.roll === 1 ? player.id : target.id, turnover: false, stage: "armour", armourOnly: true });
        return "done";
      case "Beer Barrel Bash!":
        endActivation(state, player);
        if (proc.roll! >= 3) ctx.push({ type: "KnockDown", playerId: target.id, turnover: false, stage: "fall" });
        else if (proc.roll === 1) ctx.push({ type: "KnockDown", playerId: player.id, turnover: true, stage: "fall", fallsOver: true });
        return "done";
      case "Treacherous":
        state.ball = { square: { ...squareOf(ctx, player) }, carried: true };
        ctx.emit({ type: "BallStolen", playerId: player.id, fromId: target.id, skill: proc.skill });
        ctx.push({ type: "KnockDown", playerId: target.id, turnover: false, stage: "fall" });
        checkTouchdown(ctx, player);
        return "done";
      case "Catch of the Day":
        state.ball = { square: { ...squareOf(ctx, player) }, carried: true };
        ctx.emit({ type: "BallCaught", playerId: player.id });
        checkTouchdown(ctx, player);
        return "done";
      case "The Flashing Blade": {
        const move = state.stack.findLast((p): p is P<"MoveAction"> => p.type === "MoveAction" && p.playerId === player.id);
        if (move) {
          move.action = "move";
          move.blocked = true;
        }
        ctx.push({ type: "Vomit", skill: "Stab", attackerId: player.id, defenderId: target.id, blitz: false, stage: "appearance" });
        return "done";
      }
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
    if (proc.skill === "Raiding Party") {
      return [
        { type: "SNAP", side: player.side, moves: raiders(state, player), remaining: 1 },
        { type: "DONE", side: player.side },
      ];
    }
    if (proc.stage === "choose") {
      const target = state.players[proc.targetId!]!;
      return [{ type: "CHOOSE_SKILL", side: player.side, playerId: target.id, skills: WISDOM_SKILLS.filter((s) => !hasSkill(target, s)) }];
    }
    if (proc.stage === "redirect") {
      const playerIds = redirectTargets(state, player, state.players[proc.targetId!]!).map((p) => p.id);
      return [{ type: "SELECT_PLAYERS", side: other(player.side), playerIds, max: 1, min: 1, reason: `${proc.skill}: choose the player hit instead` }];
    }
    if (proc.stage === "roll") {
      const { target, reason } = ROLLS[proc.skill]!;
      return [{ type: "ROLL", side: player.side, dice: [{ kind: "d6", count: 1 }], reason: `${reason} ${target}+ (${state.players[proc.targetId ?? proc.playerId]!.name})` }];
    }
    const playerIds = targets(state, player, proc.skill).map((p) => p.id);
    return [{ type: "SELECT_PLAYERS", side: player.side, playerIds, max: 1, reason: `${proc.skill}: choose a player` }];
  },
};
