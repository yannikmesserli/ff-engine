import type { Ctx, Handler, StepResult } from "../context";
import type { GameState, PlayerState, Procedure, Side, Square } from "../types";
import { adjacent, ballCarrier, hasTackleZone, inBounds, isOnPitch, isRooted, playerAt, sameSquare, tackleZoneAt, tackleZones } from "../pitch";
import { BLOCK_FACES } from "../dice";
import { injure } from "./injury";
import { dropBall } from "./ball";
import { hasSkill, skillName, skillValue } from "../skills";
import { canTeamReroll, canUsePro, checkTouchdown, getPlayer, lonerRollTemplate, lonerTarget, rerollsLeft, rollLoner, proTemplate, proTemplates, rushModifier, squareOf, stepPro, useTeamReroll, weatherModifier } from "./helpers";
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
 * `excludeId`, and Eye Gouged players) that are not marked by any other opponent, or that have Guard (unless Defensive
 * cancels it).
 */
function assists(state: GameState, side: Side, target: Square, opponentId: string, excludeId: string): number {
  return adjacent(target).filter((s) => {
    const helper = tackleZoneAt(state, s);
    if (!helper || helper.side !== side || helper.id === excludeId || helper.gouged) return false;
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
  /** Cheering Fans' extra assist, when it is no longer in the team state (the dice are worked out again). */
  extraAssist?: boolean;
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
  // Ball & Chain into a team-mate: no assists, and the attacker's coach always picks the die.
  if (attacker.side === defender.side) {
    const [a, d] = [attackerStrength(attacker, defender, context), defender.st];
    return a > 2 * d || 2 * a < d ? 3 : a !== d ? 2 : 1;
  }
  const extra = (context.extraAssist ?? state.teams[attacker.side].extraAssist) ? 1 : 0;
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
 * Where the player being pushed can go, and which side chooses. Grab (Block actions, the defender only): the attacker
 * may also pick any free square next to the defender, and Sidestep does not work. Sidestep: the pushed player's coach
 * picks any free adjacent square (if there is one) instead of the usual three; a player without a tackle zone cannot use
 * it.
 */
export function pushChoice(state: GameState, proc: P<"Block">): { side: Side; squares: Square[]; sidestep: boolean; grab?: Square[] } {
  const pushing = proc.pushing!;
  const player = state.players[pushing.playerId]!;
  const attacker = state.players[proc.attackerId]!;
  if (!proc.blitz && hasSkill(attacker, "Grab") && pushing.playerId === proc.defenderId && player.side !== attacker.side) {
    const usual = pushbackSquares(state, pushing.from, pushing.dir);
    const free = adjacent(pushing.from).filter((s) => !playerAt(state, s) && !usual.some((u) => sameSquare(u, s)));
    return { side: attacker.side, squares: [...usual, ...free], sidestep: false, grab: free };
  }
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

/**
 * The attacker's Mighty Blow, Claws and Plague Ridden, for a knock-down of an opponent caused by the block. Knocking
 * down a standing team-mate (Ball & Chain) is a turnover.
 */
function knockDownDefender(attacker: PlayerState, defender: PlayerState): P<"KnockDown"> {
  const opponent = attacker.side !== defender.side;
  const bonus = opponent ? skillValue(attacker, "Mighty Blow", 1) : null;
  return {
    type: "KnockDown",
    playerId: defender.id,
    turnover: !opponent && defender.status === "standing",
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
  return { type: "Block", attackerId: attacker.id, defenderId: defender.id, blitz: proc.blitz, second: true, stage: "appearance", dice, rerolled: false, chain: [] };
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
    // Ball & Chain: placed prone means an injury roll (the armour breaks without a roll).
    if (hasSkill(player, "Ball & Chain")) {
      ctx.push({ type: "KnockDown", playerId: player.id, turnover: false, stage: "fall" });
      continue;
    }
    const square = squareOf(ctx, player);
    const carrying = ballCarrier(state)?.id === player.id;
    player.status = "prone";
    ctx.emit({ type: "PlayerPlacedProne", playerId: player.id });
    if (!carrying) continue;
    state.ball.carried = false;
    if (player.side === state.activeSide) state.turnover = true;
    ctx.push(dropBall(player, square));
  }
  const activation = state.stack.findLast((p): p is P<"MoveAction"> => p.type === "MoveAction" && p.playerId === attacker.id);
  if (activation) activation.finished = true;
}

/** Foul Appearance: a player who wants to block the player (or attack them instead of a block) must roll 2+. */
export const FOUL_APPEARANCE_TARGET = 2;

/**
 * Foul Appearance: push the attacker's roll if the defender has the skill (team re-roll allowed); false when there is
 * none.
 */
export function rollFoulAppearance(ctx: Ctx, attacker: PlayerState, defender: PlayerState): boolean {
  ctx.state.lastCheck = null;
  // Ball & Chain ignores Foul Appearance.
  if (!hasSkill(defender, "Foul Appearance") || hasSkill(attacker, "Ball & Chain")) return false;
  ctx.push({ type: "Check", kind: "appearance", playerId: attacker.id, target: FOUL_APPEARANCE_TARGET, modifier: 0, stage: "roll", rerolled: false });
  return true;
}

/** Trickster: the free squares next to the attacker where the defender (with a tackle zone) may move before being hit. */
export function tricksterSquares(state: GameState, attacker: PlayerState, defender: PlayerState): Square[] {
  // Ball & Chain ignores Trickster.
  if (!hasSkill(defender, "Trickster") || !hasTackleZone(defender) || !isOnPitch(attacker) || !isOnPitch(defender) || hasSkill(attacker, "Ball & Chain")) return [];
  return adjacent(attacker.at).filter((s) => !playerAt(state, s));
}

/** Trickster, pushed before the block dice or the attack roll; it checks whether it applies. */
const trickster = (attacker: PlayerState, defender: PlayerState): Procedure[] =>
  hasSkill(defender, "Trickster") ? [{ type: "Trickster", attackerId: attacker.id, defenderId: defender.id, stage: "choose" }] : [];

/**
 * Trickster: before being blocked (or hit by a special action replacing a block), after any Dump-off and Dauntless,
 * a player with a tackle zone may move to any free square next to the attacker, taking the ball with them. Onto a loose
 * ball, their coach chooses between a pick-up roll (no team re-roll: it is not their turn) and letting it bounce. The
 * block dice are then worked out again.
 */
export const Trickster: Handler<P<"Trickster">> = {
  step(ctx, proc, action) {
    const { state } = ctx;
    const attacker = getPlayer(ctx, proc.attackerId);
    const defender = getPlayer(ctx, proc.defenderId);
    if (proc.stage === "pickup") {
      if (state.lastCheck?.success) {
        state.ball.carried = true;
        ctx.emit({ type: "BallPickedUp", playerId: defender.id });
      } else ctx.push({ type: "Bounce", from: { ...proc.square! }, kickoff: false, receiving: null });
      return "done";
    }
    const squares = tricksterSquares(state, attacker, defender);
    if (action === null) return squares.length > 0 ? "wait" : "done";
    const a = ctx.expect(action, "TRICKSTER");
    if (a.square === null) return "done";
    const to = squares.find((s) => sameSquare(s, a.square!)) ?? ctx.reject("Trickster moves next to the attacker, onto a free square.");
    const from = squareOf(ctx, defender);
    const carrying = ballCarrier(state)?.id === defender.id;
    defender.at = { x: to.x, y: to.y };
    ctx.emit({ type: "SkillUsed", playerId: defender.id, skill: "Trickster" });
    ctx.emit({ type: "PlayerMoved", playerId: defender.id, from: { ...from }, to: { ...defender.at } });
    if (carrying) state.ball.square = { ...defender.at };
    const block = state.stack.findLast((p): p is P<"Block"> => p.type === "Block" && p.defenderId === defender.id);
    if (block) block.dice = blockDice(state, attacker, defender, { blitz: block.blitz, dauntless: block.dauntless, extraAssist: block.extraAssist });
    const { ball } = state;
    if (carrying || !ball.square || ball.carried || !sameSquare(ball.square, to)) return "done";
    proc.square = { x: to.x, y: to.y };
    if (!a.pickUp) {
      ctx.push({ type: "Bounce", from: { ...proc.square }, kickoff: false, receiving: null });
      return "done";
    }
    state.lastCheck = null;
    ctx.push({ type: "Check", kind: "pickup", playerId: defender.id, target: defender.ag, modifier: -tackleZones(state, defender.side, to) + weatherModifier(state, "pickup"), stage: "roll", rerolled: false });
    proc.stage = "pickup";
    return "continue";
  },
  actions(state, proc) {
    const attacker = state.players[proc.attackerId]!;
    const defender = state.players[proc.defenderId]!;
    if (proc.stage !== "choose") return [];
    const squares = tricksterSquares(state, attacker, defender);
    const { ball } = state;
    const loose = !ball.carried && ball.square ? squares.find((s) => sameSquare(s, ball.square!)) ?? null : null;
    return [{ type: "TRICKSTER", side: defender.side, playerId: defender.id, squares, ball: loose ? { ...loose } : null }];
  },
};

/** A failed Rush before a block: the attacker falls over, a turnover. */
const fall = (attacker: PlayerState): Procedure => ({ type: "KnockDown", playerId: attacker.id, turnover: true, stage: "fall", fallsOver: true });

/**
 * Dump-off, once the attacker is ready to block (not before Frenzy's second block, nor in a Blitz, where it came when
 * the Blitz was declared): it checks whether it applies.
 */
export const dumpOff = (proc: { attackerId: string; defenderId: string; second?: boolean; blitz?: boolean }): Procedure[] =>
  proc.second || proc.blitz ? [] : [{ type: "DumpOff", attackerId: proc.attackerId, defenderId: proc.defenderId }];

/** A failed Foul Appearance roll wastes the block, which ends the attacker's action (no turnover). */
export function revolted(ctx: Ctx, attacker: PlayerState): boolean {
  const { lastCheck } = ctx.state;
  if (lastCheck?.kind !== "appearance" || lastCheck.success) return false;
  const activation = ctx.state.stack.findLast((p): p is P<"MoveAction"> => p.type === "MoveAction" && p.playerId === attacker.id);
  if (activation) activation.finished = true;
  return true;
}

/** Only the attacker's team may re-roll the block dice, once. */
const canReroll = (state: GameState, proc: P<"Block">, attacker: PlayerState) => canTeamReroll(state, attacker.side, proc.rerolled);

/** The faces of a Both Down and a Skull (attacker down) on the block dice. */
const BOTH_DOWN_FACE = BLOCK_FACES.indexOf("both_down") + 1;
const SKULL_FACE = BLOCK_FACES.indexOf("attacker_down") + 1;

/** Skills that re-roll a single block die of a given face, with that face. */
const SINGLE_DIE_SKILLS = { Brawler: BOTH_DOWN_FACE, Hatred: SKULL_FACE } as const;
type SingleDieSkill = keyof typeof SINGLE_DIE_SKILLS;

/** Hatred(X): the attacker hates the defender, who has keyword X (several separated by ";"). */
export function hates(attacker: PlayerState, defender: PlayerState): boolean {
  const skill = attacker.skills.find((s) => skillName(s) === "Hatred");
  const value = skill && /\((.*)\)$/.exec(skill)?.[1];
  return !!value && value.toLowerCase().split(";").some((k) => defender.keywords.includes(k.trim()));
}

/**
 * The skills that may re-roll a single die instead of the block re-roll: Brawler a Both Down (once per activation, not
 * during a Blitz), Hatred(X) a Skull when blocking a player with keyword X.
 */
function singleDieSkills(proc: P<"Block">, attacker: PlayerState, defender: PlayerState): SingleDieSkill[] {
  if (proc.rerolled) return [];
  const brawler = !proc.blitz && hasSkill(attacker, "Brawler") && !attacker.usedSkills.includes("Brawler");
  return [
    ...(brawler && proc.results!.includes(BOTH_DOWN_FACE) ? (["Brawler"] as const) : []),
    ...(hates(attacker, defender) && proc.results!.includes(SKULL_FACE) ? (["Hatred"] as const) : []),
  ];
}

/** Any re-roll the attacker could use on the block dice now (team re-roll, Brawler, Hatred, Pro). */
const anyReroll = (state: GameState, proc: P<"Block">, attacker: PlayerState, defender: PlayerState) =>
  canReroll(state, proc, attacker) || singleDieSkills(proc, attacker, defender).length > 0 || canUsePro(state, attacker, proc.rerolled);

/** The re-roll skills offered on the block dice now, as USE_SKILL templates. */
const skillTemplates = (state: GameState, proc: P<"Block">, attacker: PlayerState, defender: PlayerState) => [
  ...singleDieTemplate(proc, attacker, defender),
  ...proTemplate(state, attacker, proc.rerolled),
];

/** Use the re-roll skill named by the action (the only one offered when it names none): Brawler, Hatred or Pro. */
function useSkill(ctx: Ctx, proc: P<"Block">, attacker: PlayerState, defender: PlayerState, skill: string | undefined) {
  const offered = skillTemplates(ctx.state, proc, attacker, defender).map((t) => t.skill);
  const chosen = skill ?? offered[0];
  if (chosen === undefined || !offered.includes(chosen)) ctx.reject("This skill cannot be used now.");
  if (chosen !== "Pro") return useSingleDie(ctx, proc, attacker, chosen as SingleDieSkill);
  // Pro: the coach picks the die, then rolls for it.
  proc.rerolled = true;
  proc.stage = "proDie";
}

/** The USE_SKILL templates offering the single-die re-roll skills that can be used. */
const singleDieTemplate = (proc: P<"Block">, attacker: PlayerState, defender: PlayerState) =>
  singleDieSkills(proc, attacker, defender).map((skill) => ({ type: "USE_SKILL" as const, side: attacker.side, playerId: attacker.id, skill }));

/** Use Brawler or Hatred: the re-roll of one die comes next. */
function useSingleDie(ctx: Ctx, proc: P<"Block">, attacker: PlayerState, skill: SingleDieSkill) {
  if (skill === "Brawler") attacker.usedSkills.push("Brawler");
  ctx.emit({ type: "SkillUsed", playerId: attacker.id, skill });
  proc.rerolled = true;
  proc.singleDie = skill;
  proc.stage = "singleDie";
}

/** Reason of the single-die re-roll. */
const singleDieReason = (skill: SingleDieSkill) => `${skill} (re-roll a ${skill === "Brawler" ? "Both Down" : "Skull"})`;

/** Spend the team re-roll; a Loner attacker must roll for it first. */
function useReroll(ctx: Ctx, proc: P<"Block">, attacker: PlayerState) {
  useTeamReroll(ctx, attacker.side);
  proc.rerolled = true;
  proc.stage = lonerTarget(attacker) === null ? "roll" : "loner";
}

/**
 * Fend: the pushed defender (with a tackle zone, even if knocked down) may stop the attacker from following up; a
 * blitzing Juggernaut ignores it.
 */
const canFend = (proc: P<"Block">, attacker: PlayerState, defender: PlayerState) =>
  isOnPitch(defender) && hasSkill(defender, "Fend") && hasTackleZone(defender) && !juggernaut(proc, attacker) && !proc.ballAndChain;

/** Taunt: a pushed defender who is not distracted may force the attacker to follow up. */
const canTaunt = (defender: PlayerState) => isOnPitch(defender) && hasSkill(defender, "Taunt") && !defender.distracted;

/**
 * Strip Ball: an opponent the attacker pushed back (Push, or a Stumble saved by Dodge) without knocking them down drops
 * the ball in the square they were pushed to, unless they have Sure Hands and a tackle zone. Not when they did not move
 * (Stand Firm, Take Root).
 */
function strips(state: GameState, proc: P<"Block">, attacker: PlayerState, defender: PlayerState): boolean {
  if (proc.knockDefender || !hasSkill(attacker, "Strip Ball") || attacker.side === defender.side) return false;
  if (!isOnPitch(defender) || ballCarrier(state)?.id !== defender.id || !proc.chain.some((c) => c.playerId === defender.id)) return false;
  return !(hasSkill(defender, "Sure Hands") && hasTackleZone(defender));
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
 * One BB2025 block or blitz block: Foul Appearance -> Dump-off (Block action) or Rush (Blitz) -> Dauntless -> Trickster
 * -> block dice -> re-roll -> choice of die -> pushback -> Fend / Taunt -> follow-up -> Strip Ball -> knock-downs ->
 * loose ball -> touchdown check.
 * Ball & Chain (a player running into another, either team): no Foul Appearance, Trickster or Fend, a forced
 * follow-up; a prone or stunned defender is pushed back and rolls armour without block dice, and no turnover.
 */
export const Block: Handler<P<"Block">> = {
  step(ctx, proc, action) {
    const { state } = ctx;
    const attacker = getPlayer(ctx, proc.attackerId);
    const defender = getPlayer(ctx, proc.defenderId);
    switch (proc.stage) {
      case "appearance":
        rollFoulAppearance(ctx, attacker, defender);
        proc.stage = "appearanceResult";
        return "continue";
      case "appearanceResult":
        if (revolted(ctx, attacker)) return "done";
        proc.stage = proc.blitz ? "rush" : "dauntless";
        ctx.push(...dumpOff(proc));
        return "continue";
      case "rush": {
        // Blocking during a Blitz costs one square of movement, which may be a Rush.
        const needsRush = attacker.movesUsed >= attacker.ma;
        attacker.movesUsed += 1;
        state.lastCheck = null;
        proc.stage = "rushResult";
        if (needsRush) {
          ctx.push({ type: "Check", kind: "rush", playerId: attacker.id, target: RUSH_TARGET, modifier: rushModifier(state, attacker), stage: "roll", rerolled: false });
        }
        return "continue";
      }
      case "rushResult":
        // The block goes on after the fall only if Steady Footing kept the attacker on their feet.
        if (state.lastCheck?.success === false) ctx.push(fall(attacker));
        proc.stage = "dauntless";
        return "continue";
      case "dauntless": {
        // A Dump-off may score a touchdown.
        if (attacker.status !== "standing" || state.touchdown !== null) return "done";
        const target = dauntlessTarget(attacker, defender);
        state.lastCheck = null;
        proc.stage = "dauntlessResult";
        if (target !== null) ctx.push({ type: "Check", kind: "dauntless", playerId: attacker.id, target, modifier: 0, stage: "roll", rerolled: false });
        return "continue";
      }
      case "dauntlessResult":
        if (state.lastCheck?.kind === "dauntless" && state.lastCheck.success) {
          proc.dauntless = true;
          proc.dice = blockDice(state, attacker, defender, { blitz: proc.blitz, dauntless: true, extraAssist: proc.extraAssist });
          ctx.emit({ type: "SkillUsed", playerId: attacker.id, skill: "Dauntless" });
        }
        proc.stage = "trickster";
        return "continue";
      case "trickster":
        // Trickster updates the block dice if the defender moves.
        ctx.push(...trickster(attacker, defender));
        proc.stage = "roll";
        return "continue";
      case "roll": {
        // Ball & Chain into a prone or stunned player: no dice, pushed back and an armour roll, no turnover.
        if (proc.ballAndChain && defender.status !== "standing") {
          proc.hitOnGround = true;
          proc.face = PUSH_FACE;
          proc.stage = "resolve";
          return "continue";
        }
        if (action === null) return "wait";
        proc.results = ctx.roll(action, [{ kind: "block", count: Math.abs(proc.dice) }], "Block");
        // The attacker may re-roll from the choice of die; when the defender chooses, the re-roll is decided first.
        proc.stage = proc.dice < 0 && anyReroll(state, proc, attacker, defender) ? "reroll" : "choose";
        return "continue";
      }
      case "reroll": {
        if (action === null) return "wait";
        const a = ctx.expect(action, "USE_REROLL", "DECLINE_REROLL", "USE_SKILL");
        if (a.type === "USE_SKILL" && a.use) useSkill(ctx, proc, attacker, defender, a.skill);
        else if (a.type === "USE_REROLL") {
          if (!canReroll(state, proc, attacker)) ctx.reject("No re-roll available.");
          useReroll(ctx, proc, attacker);
        } else proc.stage = "choose";
        return "continue";
      }
      case "singleDie": {
        if (action === null) return "wait";
        const [die] = ctx.roll(action, [{ kind: "block", count: 1 }], singleDieReason(proc.singleDie!));
        proc.results![proc.results!.indexOf(SINGLE_DIE_SKILLS[proc.singleDie!])] = die!;
        proc.stage = "choose";
        return "continue";
      }
      case "proDie": {
        if (action === null) return "wait";
        const { index } = ctx.expect(action, "REROLL_BLOCK_DIE");
        if (proc.results![index] === undefined) ctx.reject("Invalid die.");
        proc.proDie = index;
        proc.stage = "pro";
        return "continue";
      }
      case "pro":
      case "proTeam":
      case "proLoner": {
        if (action === null) return "wait";
        // A failed Pro roll keeps the dice already rolled.
        const pro = stepPro(ctx, proc, action, attacker);
        if (pro !== "wait") proc.stage = pro === "reroll" ? "proReroll" : "choose";
        return "continue";
      }
      case "proReroll": {
        if (action === null) return "wait";
        const [die] = ctx.roll(action, [{ kind: "block", count: 1 }], "Pro (re-roll a block die)");
        proc.results![proc.proDie!] = die!;
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
        if (proc.results!.length === 1 && !(proc.dice > 0 && anyReroll(state, proc, attacker, defender))) proc.face = proc.results![0]!;
        else {
          if (action === null) return "wait";
          const a = ctx.expect(action, "CHOOSE_BLOCK_DIE", "USE_REROLL", "USE_SKILL");
          if (a.type === "USE_SKILL") {
            if (proc.dice < 0) ctx.reject("The defender chooses the die.");
            if (a.use) useSkill(ctx, proc, attacker, defender, a.skill);
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
        proc.knockDefender = result === "defender_down" || (result === "defender_stumbles" && !dodges) || proc.hitOnGround === true;
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
        const { squares, sidestep, grab } = pushChoice(state, proc);
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
        if (to && grab?.some((s) => sameSquare(s, to))) ctx.emit({ type: "SkillUsed", playerId: proc.attackerId, skill: "Grab" });
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
        // A rooted attacker cannot follow up, nor one held off by Fend.
        const canFollow = proc.vacated !== undefined && isOnPitch(attacker) && attacker.status === "standing" && !isRooted(attacker) && !playerAt(state, proc.vacated) && proc.fended !== true;
        if (canFollow && proc.fended === undefined && canFend(proc, attacker, defender)) {
          proc.stage = "fend";
          return "continue";
        }
        // Frenzy and Ball & Chain: the attacker must follow up.
        const frenzy = canFollow && (hasSkill(attacker, "Frenzy") || proc.ballAndChain === true);
        // Taunt: the pushed defender's coach may make the attacker follow up.
        if (canFollow && !frenzy && proc.taunted === undefined && canTaunt(defender)) {
          proc.stage = "taunt";
          return "continue";
        }
        const forced = frenzy || proc.taunted === true;
        if (canFollow && !forced && action === null) return "wait";
        if (canFollow) {
          const follow = forced || ctx.expect(action, "FOLLOW_UP").follow;
          if (follow) {
            const from = squareOf(ctx, attacker);
            const { ball } = state;
            if (ball.carried && ball.square && sameSquare(ball.square, from)) ball.square = { ...proc.vacated! };
            attacker.at = { ...proc.vacated! };
            ctx.emit({ type: "FollowedUp", playerId: attacker.id, to: { ...proc.vacated! } });
          }
        }
        const knock = proc.knockDefender && isOnPitch(defender);
        // Eye Gouge: an opponent pushed back by the attacker cannot assist until their next activation.
        if (hasSkill(attacker, "Eye Gouge") && defender.side !== attacker.side && proc.chain.some((c) => c.playerId === defender.id)) {
          defender.gouged = true;
          ctx.emit({ type: "SkillUsed", playerId: attacker.id, skill: "Eye Gouge" });
        }
        if (strips(state, proc, attacker, defender)) {
          ctx.emit({ type: "SkillUsed", playerId: attacker.id, skill: "Strip Ball" });
          state.ball.carried = false;
          proc.bounceFrom = { ...squareOf(ctx, defender) };
        }
        // A loose ball under a pushed player (or stripped from them) bounces once the knock-downs are resolved.
        ctx.push(
          ...(knock ? [knockDownDefender(attacker, defender)] : []),
          ...(proc.bounceFrom ? [{ type: "Bounce" as const, from: proc.bounceFrom, kickoff: false, receiving: null }] : []),
        );
        proc.stage = "end";
        return "continue";
      }
      case "fend":
        if (action === null) return "wait";
        proc.fended = ctx.expect(action, "USE_SKILL").use;
        if (proc.fended) ctx.emit({ type: "SkillUsed", playerId: defender.id, skill: "Fend" });
        proc.stage = "followup";
        return "continue";
      case "taunt":
        if (action === null) return "wait";
        proc.taunted = ctx.expect(action, "USE_SKILL").use;
        if (proc.taunted) ctx.emit({ type: "SkillUsed", playerId: defender.id, skill: "Taunt" });
        proc.stage = "followup";
        return "continue";
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
          ...skillTemplates(state, proc, attacker, defender),
          { type: "DECLINE_REROLL", side: attacker.side },
        ];
      case "proDie":
        return [{ type: "REROLL_BLOCK_DIE", side: attacker.side, results: proc.results!, skill: "Pro" }];
      case "pro":
      case "proTeam":
      case "proLoner":
        return proTemplates(state, proc.stage, attacker);
      case "proReroll":
        return [{ type: "ROLL", side: attacker.side, dice: [{ kind: "block", count: 1 }], reason: "Pro (re-roll a block die)" }];
      case "loner":
        return [lonerRollTemplate(attacker)];
      case "singleDie":
        return [{ type: "ROLL", side: attacker.side, dice: [{ kind: "block", count: 1 }], reason: singleDieReason(proc.singleDie!) }];
      case "choose": {
        const chooser = proc.dice > 0 ? attacker.side : defender.side;
        const reroll =
          proc.dice > 0 && canReroll(state, proc, attacker)
            ? [{ type: "USE_REROLL" as const, side: attacker.side, available: rerollsLeft(state, attacker.side) }]
            : [];
        return [{ type: "CHOOSE_BLOCK_DIE", side: chooser, results: proc.results! }, ...reroll, ...(proc.dice > 0 ? skillTemplates(state, proc, attacker, defender) : [])];
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
      case "fend":
        return [{ type: "USE_SKILL", side: defender.side, playerId: defender.id, skill: "Fend" }];
      case "taunt":
        return [{ type: "USE_SKILL", side: defender.side, playerId: defender.id, skill: "Taunt" }];
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
const attackName = (proc: P<"Vomit">) => (proc.skill === "Stab" ? "stab" : proc.skill === "Chainsaw" ? `chainsaw +${CHAINSAW_ARMOUR}` : "vomit");

/** Chainsaw: a kick-back on a 1, +3 to the armour roll of the target (or of a knocked-down chainsaw player). */
export const CHAINSAW_TARGET = 2;
export const CHAINSAW_ARMOUR = 3;

/** Chainsaw's +3 to an armour roll against `player`; nothing against Iron Hard Skin. */
export const chainsawArmour = (player: PlayerState) => (hasSkill(player, "Iron Hard Skin") ? 0 : CHAINSAW_ARMOUR);

/** Breathe Fire avoids a turnover on 2+, knocks the target down on a natural 6 and places them prone on 4+. */
export const BREATHE_FIRE_TARGET = 2;
export const BREATHE_FIRE_PRONE = 4;

/** Breathe Fire: -1 to the roll against a target with ST 5 or more. */
export const breatheFireModifier = (target: PlayerState) => (target.st >= 5 ? -1 : 0);

/**
 * Projectile Vomit, Stab or Breathe Fire, instead of a block (Foul Appearance first; during a Blitz it costs a square,
 * a Rush if needed). Projectile Vomit hits the defender on 2+, the vomiting player on a failure; Stab always hits the
 * defender. The victim rolls armour without any modifier; if it breaks, they are placed prone and roll for injury (no
 * modifier either). Not a turnover, unless the moving team's ball carrier drops the ball.
 * Breathe Fire rolls a D6, -1 against ST 5 or more, and the coach may re-roll anything but a 6: a natural 6 knocks the
 * target down (armour and injury without modifiers), 4+ places them prone, 2+ does nothing, and a 1 knocks the
 * fire-breather down instead (armour without modifiers), a turnover.
 * Chainsaw rolls a D6 (team re-roll): on 2+ the target rolls armour with +3 (no Mighty Blow), placed prone and injured
 * if it breaks; on a 1 it kicks back: the chainsaw player is knocked down (+3 to their armour roll), a turnover.
 */
export const Vomit: Handler<P<"Vomit">> = {
  step(ctx, proc, action) {
    const { state } = ctx;
    const attacker = getPlayer(ctx, proc.attackerId);
    switch (proc.stage) {
      case "appearance":
        rollFoulAppearance(ctx, attacker, getPlayer(ctx, proc.defenderId));
        proc.stage = "appearanceResult";
        return "continue";
      case "appearanceResult":
        if (revolted(ctx, attacker)) return "done";
        proc.stage = proc.blitz ? "rush" : "trickster";
        ctx.push(...dumpOff(proc));
        return "continue";
      case "rush": {
        const needsRush = attacker.movesUsed >= attacker.ma;
        attacker.movesUsed += 1;
        state.lastCheck = null;
        proc.stage = "rushResult";
        if (needsRush) {
          ctx.push({ type: "Check", kind: "rush", playerId: attacker.id, target: RUSH_TARGET, modifier: rushModifier(state, attacker), stage: "roll", rerolled: false });
        }
        return "continue";
      }
      case "rushResult":
        if (state.lastCheck?.success === false) ctx.push(fall(attacker));
        proc.stage = "trickster";
        return "continue";
      case "trickster":
        if (attacker.status !== "standing" || state.touchdown !== null) return "done";
        ctx.push(...trickster(attacker, getPlayer(ctx, proc.defenderId)));
        proc.stage = "roll";
        return "continue";
      case "roll":
        if (attacker.status !== "standing" || state.touchdown !== null) return "done";
        if (proc.skill === "Stab") {
          ctx.emit({ type: "SkillUsed", playerId: attacker.id, skill: "Stab" });
          proc.victimId = proc.defenderId;
          proc.stage = "armour";
          return "continue";
        }
        state.lastCheck = null;
        if (proc.skill === "Chainsaw") {
          ctx.push({ type: "Check", kind: "chainsaw", playerId: attacker.id, target: CHAINSAW_TARGET, modifier: 0, stage: "roll", rerolled: false });
        } else if (proc.skill === "Breathe Fire") {
          const modifier = breatheFireModifier(getPlayer(ctx, proc.defenderId));
          ctx.push({ type: "Check", kind: "breathefire", playerId: attacker.id, target: BREATHE_FIRE_TARGET, modifier, stage: "roll", rerolled: false, rerollBelow: 6 });
        } else {
          ctx.push({ type: "Check", kind: "vomit", playerId: attacker.id, target: VOMIT_TARGET, modifier: 0, stage: "roll", rerolled: false });
        }
        proc.stage = "result";
        return "continue";
      case "result":
        ctx.emit({ type: "SkillUsed", playerId: attacker.id, skill: proc.skill });
        if (proc.skill === "Breathe Fire") return breatheFire(ctx, proc, attacker);
        if (proc.skill === "Chainsaw" && !state.lastCheck?.success) {
          // Kick-back.
          state.lastCheck = null;
          ctx.push({ type: "KnockDown", playerId: attacker.id, turnover: true, stage: "fall" });
          return "done";
        }
        proc.victimId = state.lastCheck?.success ? proc.defenderId : attacker.id;
        state.lastCheck = null;
        proc.stage = "armour";
        return "continue";
      case "armour": {
        const victim = getPlayer(ctx, proc.victimId!);
        // Ball & Chain: the armour breaks without a roll.
        const chained = hasSkill(victim, "Ball & Chain");
        if (!chained && action === null) return "wait";
        const [a, b] = chained ? [0, 0] : ctx.roll(action!, [{ kind: "d6", count: 2 }], `Armour ${victim.av}+ (${attackName(proc)})`);
        const roll = a! + b! + (proc.skill === "Chainsaw" ? chainsawArmour(victim) : 0);
        if (!chained && roll < victim.av) {
          ctx.emit({ type: "ArmourHeld", playerId: victim.id, roll });
          return "done";
        }
        ctx.emit(chained ? { type: "ArmourBroken", playerId: victim.id } : { type: "ArmourBroken", playerId: victim.id, roll });
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
        if (proc.dropped) ctx.push(dropBall(victim, square));
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

/** The Breathe Fire result, from the roll kept by the check. */
function breatheFire(ctx: Ctx, proc: P<"Vomit">, attacker: PlayerState): StepResult {
  const { state } = ctx;
  const check = state.lastCheck!;
  state.lastCheck = null;
  const defender = getPlayer(ctx, proc.defenderId);
  const natural = check.roll!;
  const roll = natural + breatheFireModifier(defender);
  if (!check.success) {
    ctx.push({ type: "KnockDown", playerId: attacker.id, turnover: true, stage: "fall" });
  } else if (natural === 6) {
    ctx.push({ type: "KnockDown", playerId: defender.id, turnover: false, stage: "fall" });
  } else if (roll >= BREATHE_FIRE_PRONE && hasSkill(defender, "Ball & Chain")) {
    // Placed prone, a Ball & Chain player rolls for injury.
    ctx.push({ type: "KnockDown", playerId: defender.id, turnover: false, stage: "fall" });
  } else if (roll >= BREATHE_FIRE_PRONE) {
    const square = squareOf(ctx, defender);
    const carrying = ballCarrier(state)?.id === defender.id;
    defender.status = "prone";
    ctx.emit({ type: "PlayerPlacedProne", playerId: defender.id });
    if (carrying) {
      state.ball.carried = false;
      ctx.push(dropBall(defender, square));
    }
  }
  return "done";
}
