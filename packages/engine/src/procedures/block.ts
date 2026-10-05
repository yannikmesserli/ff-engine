import type { Ctx, Handler } from "../context";
import type { GameState, PlayerState, Procedure, Side, Square } from "../types";
import { adjacent, ballCarrier, hasTackleZone, inBounds, isOnPitch, isRooted, playerAt, sameSquare, tackleZoneAt } from "../pitch";
import { BLOCK_FACES } from "../dice";
import { injure } from "./injury";
import { hasSkill, skillValue } from "../skills";
import { canTeamReroll, checkTouchdown, getPlayer, lonerRollTemplate, lonerTarget, rerollsLeft, rollLoner, squareOf, useTeamReroll, weatherModifier } from "./helpers";
import { RUSH_TARGET, maxMoves } from "./turn";

type P<T extends Procedure["type"]> = Extract<Procedure, { type: T }>;

/** The eight directions clockwise from north, so that neighbours in the array are neighbouring directions. */
const COMPASS: Square[] = [
  { x: 0, y: -1 },
  { x: 1, y: -1 },
  { x: 1, y: 0 },
  { x: 1, y: 1 },
  { x: 0, y: 1 },
  { x: -1, y: 1 },
  { x: -1, y: 0 },
  { x: -1, y: -1 },
];

/**
 * Defensive: in the opposing team's turn (not during a Charge), a player with Guard marked by an opponent with
 * Defensive cannot use Guard.
 */
function guardCancelled(state: GameState, helper: PlayerState & { at: Square }): boolean {
  if (state.activeSide !== helper.side || state.stack.some((p) => p.type === "Turn" && p.charge)) return false;
  return adjacent(helper.at).some((n) => {
    const marker = tackleZoneAt(state, n);
    return marker !== undefined && marker.side !== helper.side && hasSkill(marker, "Defensive");
  });
}

/**
 * Assists for `side` against the opponent standing on `target`: team-mates next to it exerting a tackle zone (except
 * `excludeId`) that are not marked by any other opponent, or that have Guard (unless Defensive cancels it).
 */
function assists(state: GameState, side: Side, target: Square, opponentId: string, excludeId: string): number {
  return adjacent(target).filter((s) => {
    const helper = tackleZoneAt(state, s);
    if (!helper || helper.side !== side || helper.id === excludeId) return false;
    if (hasSkill(helper, "Guard") && !guardCancelled(state, { ...helper, at: s })) return true;
    return adjacent(s).every((n) => {
      const marker = tackleZoneAt(state, n);
      return !marker || marker.side === side || marker.id === opponentId;
    });
  }).length;
}

/** How a block is made, for its strength: during a Blitz (Horns), after a successful Dauntless roll. */
export interface BlockContext {
  blitz?: boolean;
  dauntless?: boolean;
}

/** The attacker's strength before assists: Dauntless raises it to the defender's ST, then Horns +1 during a Blitz. */
function attackerStrength(attacker: PlayerState, defender: PlayerState, { blitz = false, dauntless = false }: BlockContext) {
  const base = dauntless ? Math.max(attacker.st, defender.st) : attacker.st;
  return base + (blitz && hasSkill(attacker, "Horns") ? 1 : 0);
}

/**
 * Dauntless: against a stronger defender (but less than 6 ST stronger), D6 + ST must beat the defender's ST.
 * Horns and assists do not count. Returns the D6 needed, or null when there is nothing to roll.
 */
export function dauntlessTarget(attacker: PlayerState, defender: PlayerState): number | null {
  if (!hasSkill(attacker, "Dauntless") || attacker.st >= defender.st || attacker.st + 6 <= defender.st) return null;
  return defender.st - attacker.st + 1;
}

/** Number of block dice: positive when the attacker chooses, negative when the defender does. */
export function blockDice(state: GameState, attacker: PlayerState, defender: PlayerState, context: BlockContext = {}): number {
  if (!isOnPitch(attacker) || !isOnPitch(defender)) return 0;
  const extra = state.teams[attacker.side].extraAssist ? 1 : 0;
  const a = attackerStrength(attacker, defender, context) + assists(state, attacker.side, defender.at, defender.id, attacker.id) + extra;
  const d = defender.st + assists(state, defender.side, attacker.at, attacker.id, defender.id);
  if (a > 2 * d) return 3;
  if (a > d) return 2;
  if (2 * a < d) return -3;
  if (a < d) return -2;
  return 1;
}

/**
 * Squares a player on `from` can be pushed to in direction `dir`:
 * the free ones among the three away from the pusher, else all three for a chain push; empty means into the crowd.
 */
export function pushbackSquares(state: GameState, from: Square, dir: Square): Square[] {
  const i = COMPASS.findIndex((d) => sameSquare(d, dir));
  const squares = [-1, 0, 1].map((k) => COMPASS[(i + k + 8) % 8]!).map((d) => ({ x: from.x + d.x, y: from.y + d.y }));
  const onPitch = squares.filter(inBounds);
  const free = onPitch.filter((s) => !playerAt(state, s));
  if (free.length > 0) return free;
  // All three squares occupied: push into one of them (chain push). Otherwise the crowd gets them.
  return onPitch.length === 3 ? onPitch : [];
}

/**
 * Where the player being pushed can go, and which side chooses. Sidestep: the pushed player's coach picks any free
 * adjacent square (if there is one) instead of the usual three; a player without a tackle zone cannot use it.
 */
export function pushChoice(state: GameState, proc: P<"Block">): { side: Side; squares: Square[]; sidestep: boolean } {
  const pushing = proc.pushing!;
  const player = state.players[pushing.playerId]!;
  if (hasSkill(player, "Sidestep") && hasTackleZone(player)) {
    const free = adjacent(pushing.from).filter((s) => !playerAt(state, s));
    if (free.length > 0) return { side: player.side, squares: free, sidestep: true };
  }
  return { side: state.players[proc.attackerId]!.side, squares: pushbackSquares(state, pushing.from, pushing.dir), sidestep: false };
}

/** Juggernaut works during a Blitz only. */
const juggernaut = (proc: P<"Block">, attacker: PlayerState) => proc.blitz && hasSkill(attacker, "Juggernaut");

/**
 * Stand Firm: the player being pushed (defender or chain-pushed) may refuse, if they exert a tackle zone. A blitzing
 * Juggernaut cancels it for opponents. A rooted player (Take Root) is never pushed.
 */
const pushStage = (state: GameState, proc: P<"Block">) => {
  const player = state.players[proc.pushing!.playerId]!;
  const attacker = state.players[proc.attackerId]!;
  if (isRooted(player)) return "rooted";
  if (juggernaut(proc, attacker) && player.side !== attacker.side) return "push";
  return hasSkill(player, "Stand Firm") && hasTackleZone(player) ? "standFirm" : "push";
};

/** The attacker's Mighty Blow, Claws and Plague Ridden, for a knock-down of an opponent caused by the block. */
function knockDownDefender(attacker: PlayerState, defender: PlayerState): P<"KnockDown"> {
  const opponent = attacker.side !== defender.side;
  const bonus = opponent ? skillValue(attacker, "Mighty Blow", 1) : null;
  return {
    type: "KnockDown",
    playerId: defender.id,
    turnover: false,
    stage: "fall",
    ...(bonus ? { mightyBlow: { playerId: attacker.id, bonus } } : {}),
    ...(opponent ? { blockerId: attacker.id } : {}),
  };
}

/**
 * Frenzy: after a Push or a dodged Stumble, a second block against the same defender if both still stand next to each
 * other; during a Blitz it costs another square of movement (a Rush if needed) and needs movement left.
 */
function frenzyBlock(state: GameState, proc: P<"Block">, attacker: PlayerState, defender: PlayerState): P<"Block"> | null {
  if (proc.second || !hasSkill(attacker, "Frenzy") || state.turnover || state.touchdown !== null) return null;
  const face = BLOCK_FACES[proc.face! - 1];
  if (face !== "push" && face !== "defender_stumbles") return null;
  if (!isOnPitch(attacker) || !hasTackleZone(attacker) || !isOnPitch(defender) || defender.status !== "standing") return null;
  if (!adjacent(attacker.at).some((s) => sameSquare(s, defender.at))) return null;
  if (proc.blitz && attacker.movesUsed >= maxMoves(attacker)) return null;
  const dice = blockDice(state, attacker, defender, { blitz: proc.blitz });
  return { type: "Block", attackerId: attacker.id, defenderId: defender.id, blitz: proc.blitz, second: true, stage: proc.blitz ? "rush" : "dauntless", dice, rerolled: false, chain: [] };
}

/**
 * Wrestle on Both Down: the attacker's coach is asked first, then the defender's (if the defender exerts a tackle
 * zone, and the attacker is not a blitzing Juggernaut). `after` is the player who already declined.
 */
function nextWrestler(proc: P<"Block">, attacker: PlayerState, defender: PlayerState, after?: string): string | undefined {
  if (after === undefined && hasSkill(attacker, "Wrestle")) return attacker.id;
  if (after !== defender.id && hasSkill(defender, "Wrestle") && hasTackleZone(defender) && !juggernaut(proc, attacker)) return defender.id;
  return undefined;
}

/** Both Down: Juggernaut (may turn it into a Push), then Wrestle, then the knock-downs. */
function resolveBothDown(ctx: Ctx, proc: P<"Block">, attacker: PlayerState, defender: PlayerState) {
  const wrestler = nextWrestler(proc, attacker, defender);
  if (wrestler) {
    proc.wrestlerId = wrestler;
    proc.stage = "wrestle";
    return;
  }
  bothDown(ctx, attacker, defender);
  proc.stage = "end";
}

/** The face of a Push on the block dice. */
const PUSH_FACE = BLOCK_FACES.indexOf("push") + 1;

/** Both Down without Wrestle: whoever lacks Block is knocked down (a defender needs a tackle zone for Block). */
function bothDown(ctx: Ctx, attacker: PlayerState, defender: PlayerState) {
  const defenderBlocks = hasSkill(defender, "Block") && hasTackleZone(defender);
  ctx.push(
    ...(defenderBlocks ? [] : [knockDownDefender(attacker, defender)]),
    ...(hasSkill(attacker, "Block") ? [] : [{ type: "KnockDown" as const, playerId: attacker.id, turnover: true, stage: "fall" as const }]),
  );
}

/**
 * Wrestle: both players are placed prone, without armour rolls and without a turnover, unless a ball carrier of the
 * moving team goes down; the ball bounces. The attacker's action ends.
 */
function wrestle(ctx: Ctx, attacker: PlayerState, defender: PlayerState) {
  const { state } = ctx;
  for (const player of [defender, attacker]) {
    const square = squareOf(ctx, player);
    const carrying = ballCarrier(state)?.id === player.id;
    player.status = "prone";
    ctx.emit({ type: "PlayerPlacedProne", playerId: player.id });
    if (!carrying) continue;
    state.ball.carried = false;
    if (player.side === state.activeSide) state.turnover = true;
    ctx.push({ type: "Bounce", from: { ...square }, kickoff: false, receiving: null });
  }
  const activation = state.stack.findLast((p): p is P<"MoveAction"> => p.type === "MoveAction" && p.playerId === attacker.id);
  if (activation) activation.finished = true;
}

/** Only the attacker's team may re-roll the block dice, once. */
const canReroll = (state: GameState, proc: P<"Block">, attacker: PlayerState) => canTeamReroll(state, attacker.side, proc.rerolled);

/** The face of a Both Down on the block dice. */
const BOTH_DOWN_FACE = BLOCK_FACES.indexOf("both_down") + 1;

/**
 * Brawler: once per activation, not during a Blitz, the attacker may re-roll a single Both Down die instead of the
 * block re-roll.
 */
const canBrawl = (proc: P<"Block">, attacker: PlayerState) =>
  !proc.rerolled && !proc.blitz && hasSkill(attacker, "Brawler") && !attacker.usedSkills.includes("Brawler") && proc.results!.includes(BOTH_DOWN_FACE);

/** Any re-roll the attacker could use on the block dice now. */
const anyReroll = (state: GameState, proc: P<"Block">, attacker: PlayerState) => canReroll(state, proc, attacker) || canBrawl(proc, attacker);

/** The USE_SKILL template offering Brawler, if it can be used. */
const brawlerTemplate = (proc: P<"Block">, attacker: PlayerState) =>
  canBrawl(proc, attacker) ? [{ type: "USE_SKILL" as const, side: attacker.side, playerId: attacker.id, skill: "Brawler" }] : [];

/** Use Brawler: the re-roll of one Both Down die comes next. */
function brawl(ctx: Ctx, proc: P<"Block">, attacker: PlayerState) {
  if (!canBrawl(proc, attacker)) ctx.reject("Brawler cannot be used now.");
  attacker.usedSkills.push("Brawler");
  ctx.emit({ type: "SkillUsed", playerId: attacker.id, skill: "Brawler" });
  proc.rerolled = true;
  proc.stage = "brawler";
}

/** Spend the team re-roll; a Loner attacker must roll for it first. */
function useReroll(ctx: Ctx, proc: P<"Block">, attacker: PlayerState) {
  useTeamReroll(ctx, attacker.side);
  proc.rerolled = true;
  proc.stage = lonerTarget(attacker) === null ? "roll" : "loner";
}

/** Move every pushed player, last of the chain first, carrying the ball along; off the pitch means the crowd. */
function applyPushes(ctx: Ctx, proc: P<"Block">) {
  const { state } = ctx;
  const { ball } = state;
  for (const { playerId, to } of [...proc.chain].reverse()) {
    const p = state.players[playerId]!;
    const from = squareOf(ctx, p);
    const carrying = ball.carried && ball.square !== null && sameSquare(ball.square, from);
    ctx.emit({ type: "PlayerPushed", playerId, from: { ...from }, to: to && { ...to } });
    if (to === null) {
      p.at = "reserves";
      if (carrying) state.ball = { square: null, carried: false };
      ctx.push({ type: "Crowd", playerId, from: { ...from }, hadBall: carrying });
      continue;
    }
    p.at = { ...to };
    if (carrying) ball.square = { ...to };
  }
}

/**
 * One BB2025 block or blitz block: (Rush when blitzing) -> Dauntless -> block dice -> re-roll ->
 * choice of die -> pushback -> follow-up -> knock-downs -> loose ball -> touchdown check.
 */
export const Block: Handler<P<"Block">> = {
  step(ctx, proc, action) {
    const { state } = ctx;
    const attacker = getPlayer(ctx, proc.attackerId);
    const defender = getPlayer(ctx, proc.defenderId);
    switch (proc.stage) {
      case "rush": {
        // Blocking during a Blitz costs one square of movement, which may be a Rush.
        const needsRush = attacker.movesUsed >= attacker.ma;
        attacker.movesUsed += 1;
        state.lastCheck = null;
        proc.stage = "rushResult";
        if (needsRush) {
          ctx.push({ type: "Check", kind: "rush", playerId: attacker.id, target: RUSH_TARGET, modifier: weatherModifier(state, "rush"), stage: "roll", rerolled: false });
        }
        return "continue";
      }
      case "rushResult":
        if (state.lastCheck?.success === false) {
          ctx.push({ type: "KnockDown", playerId: attacker.id, turnover: true, stage: "fall" });
          return "done";
        }
        proc.stage = "dauntless";
        return "continue";
      case "dauntless": {
        const target = dauntlessTarget(attacker, defender);
        state.lastCheck = null;
        proc.stage = "dauntlessResult";
        if (target !== null) ctx.push({ type: "Check", kind: "dauntless", playerId: attacker.id, target, modifier: 0, stage: "roll", rerolled: false });
        return "continue";
      }
      case "dauntlessResult":
        if (state.lastCheck?.kind === "dauntless" && state.lastCheck.success) {
          proc.dauntless = true;
          proc.dice = blockDice(state, attacker, defender, { blitz: proc.blitz, dauntless: true });
          ctx.emit({ type: "SkillUsed", playerId: attacker.id, skill: "Dauntless" });
        }
        proc.stage = "roll";
        return "continue";
      case "roll": {
        if (action === null) return "wait";
        proc.results = ctx.roll(action, [{ kind: "block", count: Math.abs(proc.dice) }], "Block");
        // The attacker may re-roll from the choice of die; when the defender chooses, the re-roll is decided first.
        proc.stage = proc.dice < 0 && anyReroll(state, proc, attacker) ? "reroll" : "choose";
        return "continue";
      }
      case "reroll": {
        if (action === null) return "wait";
        const a = ctx.expect(action, "USE_REROLL", "DECLINE_REROLL", "USE_SKILL");
        if (a.type === "USE_SKILL" && a.use) brawl(ctx, proc, attacker);
        else if (a.type === "USE_REROLL") {
          if (!canReroll(state, proc, attacker)) ctx.reject("No re-roll available.");
          useReroll(ctx, proc, attacker);
        } else proc.stage = "choose";
        return "continue";
      }
      case "brawler": {
        if (action === null) return "wait";
        const [die] = ctx.roll(action, [{ kind: "block", count: 1 }], "Brawler");
        proc.results![proc.results!.indexOf(BOTH_DOWN_FACE)] = die!;
        proc.stage = "choose";
        return "continue";
      }
      case "loner":
        if (action === null) return "wait";
        // A failed Loner roll keeps the dice already rolled.
        proc.stage = rollLoner(ctx, action, attacker) ? "roll" : "choose";
        return "continue";
      case "choose": {
        // A single die without a possible re-roll leaves nothing to decide.
        if (proc.results!.length === 1 && !(proc.dice > 0 && anyReroll(state, proc, attacker))) proc.face = proc.results![0]!;
        else {
          if (action === null) return "wait";
          const a = ctx.expect(action, "CHOOSE_BLOCK_DIE", "USE_REROLL", "USE_SKILL");
          if (a.type === "USE_SKILL") {
            if (proc.dice < 0) ctx.reject("The defender chooses the die.");
            if (a.use) brawl(ctx, proc, attacker);
            return "continue";
          }
          if (a.type === "USE_REROLL") {
            if (proc.dice < 0 || !canReroll(state, proc, attacker)) ctx.reject("No re-roll available.");
            useReroll(ctx, proc, attacker);
            return "continue";
          }
          proc.face = proc.results![a.index] ?? ctx.reject("Invalid die.");
        }
        ctx.emit({ type: "BlockResult", attackerId: attacker.id, defenderId: defender.id, face: proc.face });
        proc.stage = "resolve";
        return "continue";
      }
      case "resolve": {
        const result = BLOCK_FACES[proc.face! - 1]!;
        if (result === "attacker_down") {
          ctx.push({ type: "KnockDown", playerId: attacker.id, turnover: true, stage: "fall" });
          proc.stage = "end";
          return "continue";
        }
        if (result === "both_down") {
          if (juggernaut(proc, attacker)) proc.stage = "juggernaut";
          else resolveBothDown(ctx, proc, attacker, defender);
          return "continue";
        }
        const dodges = result === "defender_stumbles" && hasSkill(defender, "Dodge") && !hasSkill(attacker, "Tackle");
        proc.knockDefender = result === "defender_down" || (result === "defender_stumbles" && !dodges);
        const from = squareOf(ctx, defender);
        const at = squareOf(ctx, attacker);
        proc.vacated = { ...from };
        proc.pushing = { playerId: defender.id, from: { ...from }, dir: { x: Math.sign(from.x - at.x), y: Math.sign(from.y - at.y) } };
        proc.stage = pushStage(state, proc);
        return "continue";
      }
      case "juggernaut": {
        if (action === null) return "wait";
        if (ctx.expect(action, "USE_SKILL").use) {
          ctx.emit({ type: "SkillUsed", playerId: attacker.id, skill: "Juggernaut" });
          proc.face = PUSH_FACE;
          proc.stage = "resolve";
        } else resolveBothDown(ctx, proc, attacker, defender);
        return "continue";
      }
      case "wrestle": {
        if (action === null) return "wait";
        const wrestler = proc.wrestlerId!;
        if (ctx.expect(action, "USE_SKILL").use) {
          ctx.emit({ type: "SkillUsed", playerId: wrestler, skill: "Wrestle" });
          wrestle(ctx, attacker, defender);
          proc.stage = "end";
          return "continue";
        }
        const next = nextWrestler(proc, attacker, defender, wrestler);
        if (next) {
          proc.wrestlerId = next;
          return "wait";
        }
        bothDown(ctx, attacker, defender);
        proc.stage = "end";
        return "continue";
      }
      case "standFirm":
      case "rooted": {
        if (proc.stage === "standFirm") {
          if (action === null) return "wait";
          if (!ctx.expect(action, "USE_SKILL").use) {
            proc.stage = "push";
            return "continue";
          }
        }
        // Nobody in the chain moves, and there is no square to follow up into; a knock-down happens where they stand.
        ctx.emit({ type: "SkillUsed", playerId: proc.pushing!.playerId, skill: proc.stage === "standFirm" ? "Stand Firm" : "Take Root" });
        proc.chain = [];
        delete proc.vacated;
        proc.stage = "followup";
        return "continue";
      }
      case "push": {
        const pushing = proc.pushing!;
        const { squares, sidestep } = pushChoice(state, proc);
        let to: Square | null;
        if (squares.length === 0) to = null;
        else if (squares.length === 1) to = squares[0]!;
        else {
          if (action === null) return "wait";
          const { square } = ctx.expect(action, "PUSH");
          if (!squares.some((s) => sameSquare(s, square))) ctx.reject("Illegal push square.");
          to = square;
        }
        if (sidestep) ctx.emit({ type: "SkillUsed", playerId: pushing.playerId, skill: "Sidestep" });
        proc.chain.push({ playerId: pushing.playerId, to: to && { ...to } });
        const occupant = to && playerAt(state, to);
        if (to && occupant) {
          proc.pushing = { playerId: occupant.id, from: { ...to }, dir: { x: to.x - pushing.from.x, y: to.y - pushing.from.y } };
          proc.stage = pushStage(state, proc);
          return "continue";
        }
        if (to && !state.ball.carried && state.ball.square && sameSquare(state.ball.square, to)) proc.bounceFrom = { ...to };
        applyPushes(ctx, proc);
        proc.stage = "followup";
        return "continue";
      }
      case "followup": {
        // A rooted attacker cannot follow up.
        const canFollow = proc.vacated !== undefined && isOnPitch(attacker) && attacker.status === "standing" && !isRooted(attacker) && !playerAt(state, proc.vacated);
        // Frenzy: the attacker must follow up.
        const frenzy = canFollow && hasSkill(attacker, "Frenzy");
        if (canFollow && !frenzy && action === null) return "wait";
        if (canFollow) {
          const follow = frenzy || ctx.expect(action, "FOLLOW_UP").follow;
          if (follow) {
            const from = squareOf(ctx, attacker);
            const { ball } = state;
            if (ball.carried && ball.square && sameSquare(ball.square, from)) ball.square = { ...proc.vacated! };
            attacker.at = { ...proc.vacated! };
            ctx.emit({ type: "FollowedUp", playerId: attacker.id, to: { ...proc.vacated! } });
          }
        }
        const knock = proc.knockDefender && isOnPitch(defender);
        // A loose ball under a pushed player bounces once the knock-downs are resolved.
        ctx.push(
          ...(knock ? [knockDownDefender(attacker, defender)] : []),
          ...(proc.bounceFrom ? [{ type: "Bounce" as const, from: proc.bounceFrom, kickoff: false, receiving: null }] : []),
        );
        proc.stage = "end";
        return "continue";
      }
      case "end": {
        const carrier = ballCarrier(state);
        if (carrier) checkTouchdown(ctx, carrier);
        const second = frenzyBlock(state, proc, attacker, defender);
        if (second) {
          ctx.emit({ type: "SkillUsed", playerId: attacker.id, skill: "Frenzy" });
          ctx.emit({ type: "BlockDeclared", attackerId: attacker.id, defenderId: defender.id, dice: second.dice });
          ctx.push(second);
        }
        return "done";
      }
    }
  },
  actions(state, proc) {
    const attacker = state.players[proc.attackerId]!;
    const defender = state.players[proc.defenderId]!;
    switch (proc.stage) {
      case "roll":
        return [{ type: "ROLL", side: attacker.side, dice: [{ kind: "block", count: Math.abs(proc.dice) }], reason: `Block (${Math.abs(proc.dice)} ${proc.dice < 0 ? "dice, defender chooses" : Math.abs(proc.dice) > 1 ? "dice" : "die"})` }];
      case "reroll":
        return [
          ...(canReroll(state, proc, attacker) ? [{ type: "USE_REROLL" as const, side: attacker.side, available: rerollsLeft(state, attacker.side) }] : []),
          ...brawlerTemplate(proc, attacker),
          { type: "DECLINE_REROLL", side: attacker.side },
        ];
      case "loner":
        return [lonerRollTemplate(attacker)];
      case "brawler":
        return [{ type: "ROLL", side: attacker.side, dice: [{ kind: "block", count: 1 }], reason: "Brawler (re-roll a Both Down)" }];
      case "choose": {
        const chooser = proc.dice > 0 ? attacker.side : defender.side;
        const reroll =
          proc.dice > 0 && canReroll(state, proc, attacker)
            ? [{ type: "USE_REROLL" as const, side: attacker.side, available: rerollsLeft(state, attacker.side) }]
            : [];
        return [{ type: "CHOOSE_BLOCK_DIE", side: chooser, results: proc.results! }, ...reroll, ...(proc.dice > 0 ? brawlerTemplate(proc, attacker) : [])];
      }
      case "juggernaut":
        return [{ type: "USE_SKILL", side: attacker.side, playerId: attacker.id, skill: "Juggernaut" }];
      case "wrestle": {
        const wrestler = state.players[proc.wrestlerId!]!;
        return [{ type: "USE_SKILL", side: wrestler.side, playerId: wrestler.id, skill: "Wrestle" }];
      }
      case "standFirm": {
        const pushed = state.players[proc.pushing!.playerId]!;
        return [{ type: "USE_SKILL", side: pushed.side, playerId: pushed.id, skill: "Stand Firm" }];
      }
      case "push": {
        const { side, squares } = pushChoice(state, proc);
        return [{ type: "PUSH", side, playerId: proc.pushing!.playerId, squares }];
      }
      case "followup":
        return [{ type: "FOLLOW_UP", side: attacker.side, playerId: attacker.id, square: proc.vacated! }];
      default:
        return [];
    }
  },
};

/** Pushed into the crowd: injury roll without armour; a stunned result goes to the reserves, then the throw-in. */
export const Crowd: Handler<P<"Crowd">> = {
  step(ctx, proc, action) {
    if (action === null) return "wait";
    const player = getPlayer(ctx, proc.playerId);
    const [a, b] = ctx.roll(action, [{ kind: "d6", count: 2 }], "Injury (crowd)");
    // The throw-in waits for the casualty roll and the apothecary.
    if (proc.hadBall) ctx.push({ type: "ThrowIn", from: proc.from });
    injure(ctx, player, a! + b!, { crowd: true });
    return "done";
  },
  actions(state, proc) {
    return [{ type: "ROLL", side: null, dice: [{ kind: "d6", count: 2 }], reason: `Injury (${state.players[proc.playerId]!.name} pushed into the crowd)` }];
  },
};

/** Projectile Vomit hits on 2+. */
export const VOMIT_TARGET = 2;

/** The attack in armour roll reasons. */
const attackName = (proc: P<"Vomit">) => (proc.skill === "Stab" ? "stab" : "vomit");

/**
 * Projectile Vomit or Stab, instead of a block (during a Blitz it costs a square, a Rush if needed). Projectile Vomit
 * hits the defender on 2+, the vomiting player on a failure; Stab always hits the defender. The victim rolls armour
 * without any modifier; if it breaks, they are placed prone and roll for injury (no modifier either). Not a turnover,
 * unless the moving team's ball carrier drops the ball.
 */
export const Vomit: Handler<P<"Vomit">> = {
  step(ctx, proc, action) {
    const { state } = ctx;
    const attacker = getPlayer(ctx, proc.attackerId);
    switch (proc.stage) {
      case "rush": {
        const needsRush = attacker.movesUsed >= attacker.ma;
        attacker.movesUsed += 1;
        state.lastCheck = null;
        proc.stage = "rushResult";
        if (needsRush) {
          ctx.push({ type: "Check", kind: "rush", playerId: attacker.id, target: RUSH_TARGET, modifier: weatherModifier(state, "rush"), stage: "roll", rerolled: false });
        }
        return "continue";
      }
      case "rushResult":
        if (state.lastCheck?.success === false) {
          ctx.push({ type: "KnockDown", playerId: attacker.id, turnover: true, stage: "fall" });
          return "done";
        }
        proc.stage = "roll";
        return "continue";
      case "roll":
        if (proc.skill === "Stab") {
          ctx.emit({ type: "SkillUsed", playerId: attacker.id, skill: "Stab" });
          proc.victimId = proc.defenderId;
          proc.stage = "armour";
          return "continue";
        }
        state.lastCheck = null;
        ctx.push({ type: "Check", kind: "vomit", playerId: attacker.id, target: VOMIT_TARGET, modifier: 0, stage: "roll", rerolled: false });
        proc.stage = "result";
        return "continue";
      case "result":
        ctx.emit({ type: "SkillUsed", playerId: attacker.id, skill: "Projectile Vomit" });
        proc.victimId = state.lastCheck?.success ? proc.defenderId : attacker.id;
        state.lastCheck = null;
        proc.stage = "armour";
        return "continue";
      case "armour": {
        if (action === null) return "wait";
        const victim = getPlayer(ctx, proc.victimId!);
        const [a, b] = ctx.roll(action, [{ kind: "d6", count: 2 }], `Armour ${victim.av}+ (${attackName(proc)})`);
        const roll = a! + b!;
        if (roll < victim.av) {
          ctx.emit({ type: "ArmourHeld", playerId: victim.id, roll });
          return "done";
        }
        ctx.emit({ type: "ArmourBroken", playerId: victim.id, roll });
        const carrying = ballCarrier(state)?.id === victim.id;
        victim.status = "prone";
        ctx.emit({ type: "PlayerPlacedProne", playerId: victim.id });
        if (carrying) {
          state.ball.carried = false;
          proc.dropped = true;
          if (victim.side === state.activeSide) state.turnover = true;
        }
        proc.stage = "injury";
        return "continue";
      }
      case "injury": {
        if (action === null) return "wait";
        const victim = getPlayer(ctx, proc.victimId!);
        const square = squareOf(ctx, victim);
        const [a, b] = ctx.roll(action, [{ kind: "d6", count: 2 }], "Injury");
        // The ball bounces once the injury is resolved.
        if (proc.dropped) ctx.push({ type: "Bounce", from: { ...square }, kickoff: false, receiving: null });
        injure(ctx, victim, a! + b!);
        return "done";
      }
    }
  },
  actions(state, proc) {
    if (proc.stage !== "armour" && proc.stage !== "injury") return [];
    const victim = state.players[proc.victimId!]!;
    const reason = proc.stage === "armour" ? `Armour ${victim.av}+ (${victim.name}, ${attackName(proc)})` : `Injury (${victim.name})`;
    return [{ type: "ROLL", side: null, dice: [{ kind: "d6", count: 2 }], reason }];
  },
};
