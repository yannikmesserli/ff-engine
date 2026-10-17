import type { Ctx, Handler, StepResult } from "../context";
import type { GameState, PlayerState, Procedure, Side, Square } from "../types";
import { adjacent, ballCarrier, chompHolds, hasTackleZone, inBounds, isOnPitch, isPinned, isRooted, playerAt, sameSquare, tackleZoneAt, tackleZones } from "../pitch";
import { BLOCK_FACES } from "../dice";
import { hatedKeywords, injure, injuryOutcome, savageMauling } from "./injury";
import { dropBall } from "./ball";
import { trapdoor } from "./prayers";
import { hasSkill, skillName, skillValue, tandemRole } from "../skills";
import { canTeamReroll, canUsePro, checkTouchdown, getPlayer, luckSkill, sneakyPair, useLuck, useOncePerGame, lonerRollTemplate, lonerTarget, mascotFailed, proTemplate, proTemplates, rerollGate, rerollsLeft, rollLoner, rushModifier, squareOf, stepPro, teamRerollTemplate, pickupModifier, useTeamReroll } from "./helpers";
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
 * `excludeIds`, and Eye Gouged players) that are not marked by any other opponent, or that have Guard (unless Defensive
 * cancels it).
 */
function assists(state: GameState, side: Side, target: Square, opponentId: string, ...excludeIds: string[]): number {
  return adjacent(target).filter((s) => {
    const helper = tackleZoneAt(state, s);
    if (!helper || helper.side !== side || excludeIds.includes(helper.id) || helper.gouged) return false;
    if (hasSkill(helper, "Guard") && !guardCancelled(state, { ...helper, at: s })) return true;
    return adjacent(s).every((n) => {
      const marker = tackleZoneAt(state, n);
      return !marker || marker.side === side || marker.id === opponentId;
    });
  }).length;
}

/** How a block is made, for its strength: during a Blitz (Horns), after a successful Dauntless roll, in a Multiple Block. */
export interface BlockContext {
  blitz?: boolean;
  dauntless?: boolean;
  /** Cheering Fans' extra assist, when it is no longer in the team state (the dice are worked out again). */
  extraAssist?: boolean;
  /** Multiple Block: the other target, who does not assist this defender. */
  multiple?: string;
  /** Indomitable: Dauntless raises the attacker's ST to double the defender's. */
  doubled?: boolean;
}

/** Multiple Block: -2 to the attacker's ST for each block (at least 1). */
export const MULTIPLE_BLOCK_PENALTY = 2;

/**
 * The attacker's strength before assists: -2 in a Multiple Block (at least 1), Dauntless raises it to the defender's
 * ST (to double it with Indomitable), then Horns +1 during a Blitz.
 */
function attackerStrength(attacker: PlayerState, defender: PlayerState, { blitz = false, dauntless = false, multiple, doubled = false }: BlockContext) {
  const st = multiple === undefined ? attacker.st : Math.max(1, attacker.st - MULTIPLE_BLOCK_PENALTY);
  const base = dauntless ? Math.max(st, doubled ? 2 * defender.st : defender.st) : st;
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
  const d = defender.st + assists(state, defender.side, attacker.at, attacker.id, defender.id, ...(context.multiple ? [context.multiple] : []));
  if (a > 2 * d) return 3;
  if (a > d) return 2;
  if (2 * a < d) return -3;
  if (a < d) return -2;
  return 1;
}

/**
 * Squares a player on `from` can be pushed to in direction `dir`:
 * the free ones among the three away from the pusher, else all three for a chain push; empty means into the crowd.
 * `forbidden` squares (where the targets of a Multiple Block stood) are never used.
 */
export function pushbackSquares(state: GameState, from: Square, dir: Square, forbidden: Square[] = []): Square[] {
  const i = COMPASS.findIndex((d) => sameSquare(d, dir));
  const squares = [-1, 0, 1].map((k) => COMPASS[(i + k + 8) % 8]!).map((d) => ({ x: from.x + d.x, y: from.y + d.y }));
  const onPitch = squares.filter(inBounds);
  const allowed = (s: Square) => !forbidden.some((f) => sameSquare(f, s));
  const free = onPitch.filter((s) => !playerAt(state, s) && allowed(s));
  if (free.length > 0) return free;
  // All three squares occupied: push into one of them (chain push). Otherwise the crowd gets them.
  return onPitch.length === 3 ? onPitch.filter(allowed) : [];
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
  // Multiple Block: nobody is pushed where its targets stood.
  const forbidden = proc.multiple?.squares ?? [];
  const open = (s: Square) => !playerAt(state, s) && !forbidden.some((f) => sameSquare(f, s));
  if (!proc.blitz && hasSkill(attacker, "Grab") && pushing.playerId === proc.defenderId && player.side !== attacker.side) {
    const usual = pushbackSquares(state, pushing.from, pushing.dir, forbidden);
    const free = adjacent(pushing.from).filter((s) => open(s) && !usual.some((u) => sameSquare(u, s)));
    return { side: attacker.side, squares: [...usual, ...free], sidestep: false, grab: free };
  }
  if (hasSkill(player, "Sidestep") && hasTackleZone(player)) {
    const free = adjacent(pushing.from).filter(open);
    if (free.length > 0) return { side: player.side, squares: free, sidestep: true };
  }
  return { side: state.players[proc.attackerId]!.side, squares: pushbackSquares(state, pushing.from, pushing.dir, forbidden), sidestep: false };
}

/** Juggernaut works during a Blitz only. */
const juggernaut = (proc: P<"Block">, attacker: PlayerState) => proc.blitz && hasSkill(attacker, "Juggernaut");

/**
 * Stand Firm: the player being pushed (defender or chain-pushed) may refuse, if they exert a tackle zone. A blitzing
 * Juggernaut cancels it for opponents. A rooted (Take Root) or chomped (Monstrous Mouth) player is never pushed.
 */
const pushStage = (state: GameState, proc: P<"Block">) => {
  const player = state.players[proc.pushing!.playerId]!;
  const attacker = state.players[proc.attackerId]!;
  if (isPinned(state, player)) return "rooted";
  if (juggernaut(proc, attacker) && player.side !== attacker.side) return "push";
  return hasSkill(player, "Stand Firm") && hasTackleZone(player) ? "standFirm" : "push";
};

/**
 * The attacker's Mighty Blow, Claws and Plague Ridden, for a knock-down of an opponent caused by the block. Knocking
 * down a standing team-mate (Ball & Chain) is a turnover. Saboteur: an opponent with the skill and a tackle zone,
 * knocked down by a Block or Blitz action (not a Ball & Chain move), may take the attacker down too. A casualty earns
 * the attacker Star Player Points, unless a Ball & Chain player hit a player already down (Violent Innovator: even then).
 */
function knockDownDefender(proc: P<"Block">, attacker: PlayerState, defender: PlayerState): P<"KnockDown"> {
  const opponent = attacker.side !== defender.side;
  const spp = opponent && (defender.status === "standing" || hasSkill(attacker, "Violent Innovator"));
  const bonus = opponent ? skillValue(attacker, "Mighty Blow", 1) : null;
  const saboteur = opponent && !proc.ballAndChain && hasSkill(defender, "Saboteur") && hasTackleZone(defender);
  return {
    type: "KnockDown",
    playerId: defender.id,
    turnover: !opponent && defender.status === "standing",
    stage: "fall",
    ...(bonus ? { mightyBlow: { playerId: attacker.id, bonus } } : {}),
    ...(opponent ? { blockerId: attacker.id } : {}),
    ...(spp ? { sppTo: [attacker.id] } : {}),
    ...(saboteur ? { saboteurTargetId: attacker.id } : {}),
  };
}

/** The attacker knocked down by their own block: a casualty earns the defender Star Player Points. */
const knockDownAttacker = (attacker: PlayerState, defender: PlayerState): P<"KnockDown"> => ({
  type: "KnockDown",
  playerId: attacker.id,
  turnover: true,
  stage: "fall",
  ...(attacker.side !== defender.side ? { sppTo: [defender.id] } : {}),
});

/**
 * Frenzy: after a Push or a dodged Stumble, a second block against the same defender if both still stand next to each
 * other; during a Blitz it costs another square of movement (a Rush if needed) and needs movement left.
 */
function frenzyBlock(state: GameState, proc: P<"Block">, attacker: PlayerState, defender: PlayerState): P<"Block"> | null {
  if (proc.second || proc.multiple || !hasSkill(attacker, "Frenzy") || state.turnover || state.touchdown !== null) return null;
  const face = BLOCK_FACES[proc.face! - 1];
  if (face !== "push" && face !== "defender_stumbles") return null;
  if (!isOnPitch(attacker) || !hasTackleZone(attacker) || !isOnPitch(defender) || defender.status !== "standing") return null;
  if (!adjacent(attacker.at).some((s) => sameSquare(s, defender.at))) return null;
  if (proc.blitz && attacker.movesUsed >= maxMoves(attacker)) return null;
  const base = blockDice(state, attacker, defender, { blitz: proc.blitz });
  // Gored by the Bull, used on the first block of the Blitz, gives the second one its extra die too.
  const dice = proc.gored && base > 0 && base < 3 ? base + 1 : base;
  return { type: "Block", attackerId: attacker.id, defenderId: defender.id, blitz: proc.blitz, second: true, stage: "appearance", dice, rerolled: false, chain: [], ...(proc.gored ? { gored: true } : {}) };
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
  bothDown(ctx, proc, attacker, defender);
  proc.stage = "end";
}

/** The face of a Push on the block dice. */
const PUSH_FACE = BLOCK_FACES.indexOf("push") + 1;

/**
 * Both Down without Wrestle: whoever lacks Block is knocked down (a defender needs a tackle zone for Block). An
 * attacker already down (the first block of a Multiple Block) does not fall again.
 */
function bothDown(ctx: Ctx, proc: P<"Block">, attacker: PlayerState, defender: PlayerState) {
  const defenderBlocks = hasSkill(defender, "Block") && hasTackleZone(defender);
  const attackerFalls = !hasSkill(attacker, "Block") && attacker.status === "standing";
  ctx.push(
    ...(defenderBlocks ? [] : [knockDownDefender(proc, attacker, defender)]),
    ...(attackerFalls ? [knockDownAttacker(attacker, defender)] : []),
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
    if (block) block.dice = blockDice(state, attacker, defender, { blitz: block.blitz, dauntless: block.dauntless, extraAssist: block.extraAssist, multiple: block.multiple?.otherId });
    const { ball } = state;
    if (carrying || !ball.square || ball.carried || !sameSquare(ball.square, to)) return "done";
    proc.square = { x: to.x, y: to.y };
    if (!a.pickUp) {
      ctx.push({ type: "Bounce", from: { ...proc.square }, kickoff: false, receiving: null });
      return "done";
    }
    state.lastCheck = null;
    ctx.push({ type: "Check", kind: "pickup", playerId: defender.id, target: defender.ag, modifier: pickupModifier(state, defender, to), stage: "roll", rerolled: false });
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
export const hates = (attacker: PlayerState, defender: PlayerState) => hatedKeywords(attacker).some((k) => defender.keywords.includes(k));

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
  canReroll(state, proc, attacker) ||
  (!proc.mascotFailed &&
    (singleDieSkills(proc, attacker, defender).length > 0 || anyDieSkills(state, proc, attacker, defender).length > 0 || savageBlow(proc, attacker, defender) || canUsePro(state, attacker, proc.rerolled)));

/**
 * Gored by the Bull: once per game, in a Blitz, the attacker may roll one more block die (up to 3) when they pick the
 * die; a Frenzy second block of the same Blitz gets it too.
 */
const goredByTheBull = (proc: P<"Block">, attacker: PlayerState) =>
  proc.blitz && proc.dice > 0 && proc.dice < 3 && hasSkill(attacker, "Gored by the Bull") && !attacker.usedThisGame?.includes("Gored by the Bull");

/** Savage Blow: once per game, when blocking an opponent, the attacker may re-roll any number of the block dice. */
const savageBlow = (proc: P<"Block">, attacker: PlayerState, defender: PlayerState) =>
  !proc.rerolled && defender.side !== attacker.side && hasSkill(attacker, "Savage Blow") && !attacker.usedThisGame?.includes("Savage Blow");

/**
 * The skills that let the attacker re-roll any one block die they pick, as the block's re-roll: Unstoppable Momentum
 * (during a Blitz), Lord of Chaos (once per game, against an opponent), Woodland Fury (once per game, when the dice would
 * knock the attacker down), Working in Tandem (the attacker's partner marks the defender too), Halfling Luck.
 */
function anyDieSkills(state: GameState, proc: P<"Block">, attacker: PlayerState, defender: PlayerState): string[] {
  if (proc.rerolled) return [];
  const unused = (skill: string) => hasSkill(attacker, skill) && !attacker.usedThisGame?.includes(skill);
  return [
    ...(proc.blitz && hasSkill(attacker, "Unstoppable Momentum") ? ["Unstoppable Momentum"] : []),
    ...(defender.side !== attacker.side && unused("Lord of Chaos") ? ["Lord of Chaos"] : []),
    ...(unused("Woodland Fury") && knocksAttackerDown(proc, attacker) ? ["Woodland Fury"] : []),
    ...(defender.side !== attacker.side && tandemRole(attacker, "block") && partnerMarks(state, attacker, defender) ? ["Working in Tandem"] : []),
    ...(luckSkill(attacker) ? [luckSkill(attacker)!] : []),
  ];
}

/** Working in Tandem: the attacker's partner (the twin who passes) marks the defender too, standing with a tackle zone. */
const partnerMarks = (state: GameState, attacker: PlayerState, defender: PlayerState & { at?: unknown }) =>
  isOnPitch(defender) &&
  adjacent(defender.at).some((s) => {
    const p = playerAt(state, s);
    return p !== undefined && p.id !== attacker.id && p.side === attacker.side && hasTackleZone(p) && tandemRole(p, "pass");
  });

/**
 * The block dice would knock the attacker down: a Skull, or a Both Down without Block (or Juggernaut in a Blitz); all the
 * dice when the attacker picks, any one when the defender does.
 */
function knocksAttackerDown(proc: P<"Block">, attacker: PlayerState) {
  const falls = (face: number) =>
    BLOCK_FACES[face - 1] === "attacker_down" || (BLOCK_FACES[face - 1] === "both_down" && !hasSkill(attacker, "Block") && !(proc.blitz && hasSkill(attacker, "Juggernaut")));
  return proc.dice > 0 ? proc.results!.every(falls) : proc.results!.some(falls);
}

/** Once-per-game re-roll skills, used up when used. */
const ONCE_PER_GAME_DIE_SKILLS = ["Lord of Chaos", "Woodland Fury"];

/** The re-roll skills offered on the block dice now, as USE_SKILL templates. */
const skillTemplates = (state: GameState, proc: P<"Block">, attacker: PlayerState, defender: PlayerState) =>
  proc.mascotFailed
    ? []
    : [
        ...singleDieTemplate(proc, attacker, defender),
        ...anyDieSkills(state, proc, attacker, defender).map((skill) => ({ type: "USE_SKILL" as const, side: attacker.side, playerId: attacker.id, skill })),
        ...(savageBlow(proc, attacker, defender) ? [{ type: "USE_SKILL" as const, side: attacker.side, playerId: attacker.id, skill: "Savage Blow" }] : []),
        ...proTemplate(state, attacker, proc.rerolled),
      ];

/** Use the re-roll skill named by the action (the only one offered when it names none): Brawler, Hatred, a skill re-rolling any die, or Pro. */
function useSkill(ctx: Ctx, proc: P<"Block">, attacker: PlayerState, defender: PlayerState, skill: string | undefined) {
  const offered = skillTemplates(ctx.state, proc, attacker, defender).map((t) => t.skill);
  const chosen = skill ?? offered[0];
  if (chosen === undefined || !offered.includes(chosen)) ctx.reject("This skill cannot be used now.");
  if (chosen === "Savage Blow") {
    useOncePerGame(ctx, attacker, chosen);
    proc.rerolled = true;
    proc.stage = "savageDice";
    return;
  }
  if (anyDieSkills(ctx.state, proc, attacker, defender).includes(chosen)) {
    // The coach picks the die, re-rolled without any roll first.
    if (chosen === luckSkill(attacker)) useLuck(ctx, attacker, chosen);
    else if (ONCE_PER_GAME_DIE_SKILLS.includes(chosen)) useOncePerGame(ctx, attacker, chosen);
    else ctx.emit({ type: "SkillUsed", playerId: attacker.id, skill: chosen });
    proc.rerolled = true;
    proc.dieSkill = chosen;
    proc.stage = "proDie";
    return;
  }
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
function useReroll(ctx: Ctx, proc: P<"Block">, attacker: PlayerState, mascot = false) {
  useTeamReroll(ctx, attacker.side, mascot);
  proc.rerolled = true;
  proc.stage = rerollGate(ctx.state, attacker) ? "loner" : "roll";
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
 * (Stand Firm, Take Root, chomped), nor against Monstrous Mouth.
 */
function strips(state: GameState, proc: P<"Block">, attacker: PlayerState, defender: PlayerState): boolean {
  if (proc.knockDefender || !hasSkill(attacker, "Strip Ball") || attacker.side === defender.side || hasSkill(defender, "Monstrous Mouth")) return false;
  if (!isOnPitch(defender) || ballCarrier(state)?.id !== defender.id || !proc.chain.some((c) => c.playerId === defender.id)) return false;
  return !(hasSkill(defender, "Sure Hands") && hasTackleZone(defender));
}

/**
 * Move every pushed player, last of the chain first, carrying the ball along; off the pitch means the crowd. Fan
 * Interaction (a prayer): a casualty from the crowd, or from a trapdoor the player was pushed into, earns the attacker
 * Star Player Points.
 */
function applyPushes(ctx: Ctx, proc: P<"Block">) {
  const { state } = ctx;
  const { ball } = state;
  const attacker = state.players[proc.attackerId]!;
  const sppTo = state.teams[attacker.side].prayers.includes("fan-interaction") ? [attacker.id] : [];
  const spp = sppTo.length > 0 ? { sppTo } : {};
  for (const { playerId, to } of [...proc.chain].reverse()) {
    const p = state.players[playerId]!;
    const from = squareOf(ctx, p);
    const carrying = ball.carried && ball.square !== null && sameSquare(ball.square, from);
    ctx.emit({ type: "PlayerPushed", playerId, from: { ...from }, to: to && { ...to } });
    if (to === null) {
      p.at = "reserves";
      if (carrying) state.ball = { square: null, carried: false };
      ctx.push({ type: "Crowd", playerId, from: { ...from }, hadBall: carrying, ...spp });
      continue;
    }
    p.at = { ...to };
    if (carrying) ball.square = { ...to };
    ctx.push(...trapdoor(state, p, to, sppTo));
  }
}

/**
 * Multiple Block (a Block action, not a Blitz): the attacker blocks two adjacent standing opponents at once, at -2 ST
 * each (at least 1), and neither target assists against the other block. Each block is prepared in turn, from Foul
 * Appearance (a failure only drops that block) to the choice of the die, then both are resolved in the same order,
 * without any follow-up, Frenzy, or push into a square where either target stood. A Pile Driver or Hit and Run may
 * follow.
 */
export const MultipleBlock: Handler<P<"MultipleBlock">> = {
  step(ctx, proc) {
    const { state } = ctx;
    const attacker = getPlayer(ctx, proc.attackerId);
    const next = proc.pending.shift();
    if (next !== undefined) {
      // A Dump-off may score, a Trickster may move away: the next block needs a standing target still next to the attacker.
      const defender = getPlayer(ctx, next);
      const otherId = proc.targetIds.find((id) => id !== next)!;
      const adjacentNow = isOnPitch(attacker) && isOnPitch(defender) && adjacent(attacker.at).some((s) => sameSquare(s, defender.at));
      if (state.touchdown !== null || attacker.status !== "standing" || defender.status !== "standing" || !adjacentNow) return "continue";
      // Cheering Fans: the extra assist goes to the first block.
      const extraAssist = proc.extraAssist === true && proc.pending.length === 1;
      const dice = blockDice(state, attacker, defender, { multiple: otherId, extraAssist });
      ctx.emit({ type: "BlockDeclared", attackerId: attacker.id, defenderId: defender.id, dice });
      ctx.push({
        type: "Block",
        attackerId: attacker.id,
        defenderId: defender.id,
        blitz: false,
        stage: "appearance",
        dice,
        ...(extraAssist ? { extraAssist } : {}),
        rerolled: false,
        chain: [],
        multiple: { stage: "prepare", otherId, squares: proc.squares.map((s) => ({ ...s })) },
      });
      return "continue";
    }
    if (state.touchdown !== null) return "done";
    ctx.push(
      ...proc.chosen.map((c): Procedure => ({
        type: "Block",
        attackerId: attacker.id,
        defenderId: c.defenderId,
        blitz: false,
        stage: "resolve",
        dice: c.dice,
        results: [...c.results],
        face: c.face,
        ...(c.extraAssist ? { extraAssist: true } : {}),
        rerolled: true,
        chain: [],
        multiple: { stage: "resolve", otherId: proc.targetIds.find((id) => id !== c.defenderId)!, squares: proc.squares.map((s) => ({ ...s })) },
      })),
    );
    return "done";
  },
  actions: () => [],
};

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
          proc.dice = blockDice(state, attacker, defender, { blitz: proc.blitz, dauntless: true, extraAssist: proc.extraAssist, multiple: proc.multiple?.otherId });
          ctx.emit({ type: "SkillUsed", playerId: attacker.id, skill: "Dauntless" });
          // Indomitable: once per game, the attacker may make their ST double the defender's instead.
          if (hasSkill(attacker, "Indomitable") && !attacker.usedThisGame?.includes("Indomitable")) {
            proc.stage = "indomitable";
            return "wait";
          }
        }
        proc.stage = "trickster";
        return "continue";
      case "indomitable":
        if (action === null) return "wait";
        if (ctx.expect(action, "USE_SKILL").use) {
          useOncePerGame(ctx, attacker, "Indomitable");
          proc.dice = blockDice(state, attacker, defender, { blitz: proc.blitz, dauntless: true, doubled: true, extraAssist: proc.extraAssist, multiple: proc.multiple?.otherId });
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
        if (proc.gored === undefined && goredByTheBull(proc, attacker)) {
          proc.stage = "gored";
          return "continue";
        }
        if (action === null) return "wait";
        proc.results = ctx.roll(action, [{ kind: "block", count: Math.abs(proc.dice) }], "Block");
        // The attacker may re-roll from the choice of die; when the defender chooses, the re-roll is decided first.
        proc.stage = proc.dice < 0 && anyReroll(state, proc, attacker, defender) ? "reroll" : "choose";
        return "continue";
      }
      case "gored": {
        if (action === null) return "wait";
        proc.gored = ctx.expect(action, "USE_SKILL").use;
        if (proc.gored) {
          useOncePerGame(ctx, attacker, "Gored by the Bull");
          proc.dice += 1;
        }
        proc.stage = "roll";
        return "continue";
      }
      case "reroll": {
        if (action === null) return "wait";
        const a = ctx.expect(action, "USE_REROLL", "DECLINE_REROLL", "USE_SKILL");
        if (a.type === "USE_SKILL" && a.use) useSkill(ctx, proc, attacker, defender, a.skill);
        else if (a.type === "USE_REROLL") {
          if (!canReroll(state, proc, attacker)) ctx.reject("No re-roll available.");
          useReroll(ctx, proc, attacker, a.mascot);
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
      case "savageDice": {
        if (action === null) return "wait";
        const { index, indexes = [index] } = ctx.expect(action, "REROLL_BLOCK_DIE");
        if (indexes.length === 0 || new Set(indexes).size !== indexes.length || indexes.some((i) => proc.results![i] === undefined)) ctx.reject("Invalid dice.");
        proc.savage = [...indexes].sort((a, b) => a - b);
        proc.stage = "savageReroll";
        return "continue";
      }
      case "savageReroll": {
        if (action === null) return "wait";
        const dice = ctx.roll(action, [{ kind: "block", count: proc.savage!.length }], "Savage Blow (re-roll block dice)");
        proc.savage!.forEach((i, n) => (proc.results![i] = dice[n]!));
        proc.stage = "choose";
        return "continue";
      }
      case "proDie": {
        if (action === null) return "wait";
        const { index } = ctx.expect(action, "REROLL_BLOCK_DIE");
        if (proc.results![index] === undefined) ctx.reject("Invalid die.");
        proc.proDie = index;
        proc.stage = proc.dieSkill ? "proReroll" : "pro";
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
        const [die] = ctx.roll(action, [{ kind: "block", count: 1 }], `${proc.dieSkill ?? "Pro"} (re-roll a block die)`);
        proc.results![proc.proDie!] = die!;
        proc.stage = "choose";
        return "continue";
      }
      case "loner":
        if (action === null) return "wait";
        // A failed Loner roll keeps the dice already rolled; a failed Team Mascot asks again.
        const gate = rollLoner(ctx, action, attacker);
        if (gate === "offer") mascotFailed(proc);
        proc.stage = gate === "reroll" ? "roll" : gate === "offer" && proc.dice < 0 ? "reroll" : "choose";
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
            useReroll(ctx, proc, attacker, a.mascot);
            return "continue";
          }
          proc.face = proc.results![a.index] ?? ctx.reject("Invalid die.");
        }
        ctx.emit({ type: "BlockResult", attackerId: attacker.id, defenderId: defender.id, face: proc.face });
        proc.stage = "resolve";
        return "continue";
      }
      case "resolve": {
        // Multiple Block: the die is kept until both blocks are rolled.
        if (proc.multiple?.stage === "prepare") {
          const parent = state.stack.findLast((p): p is P<"MultipleBlock"> => p.type === "MultipleBlock" && p.attackerId === attacker.id);
          parent?.chosen.push({ defenderId: defender.id, dice: proc.dice, results: [...proc.results!], face: proc.face!, ...(proc.extraAssist ? { extraAssist: true } : {}) });
          return "done";
        }
        const result = BLOCK_FACES[proc.face! - 1]!;
        // An attacker already down (the first block of a Multiple Block) does not fall again.
        const down = attacker.status !== "standing";
        if (result === "attacker_down") {
          if (!down) ctx.push(knockDownAttacker(attacker, defender));
          proc.stage = "end";
          return "continue";
        }
        if (result === "both_down" && down) {
          bothDown(ctx, proc, attacker, defender);
          proc.stage = "end";
          return "continue";
        }
        if (result === "both_down") {
          if (juggernaut(proc, attacker)) proc.stage = "juggernaut";
          else resolveBothDown(ctx, proc, attacker, defender);
          return "continue";
        }
        // Watch Out!: the first block by an opponent each drive, the defender counts as having Dodge.
        const watchOut = defender.side !== attacker.side && hasSkill(defender, "Watch Out!") && !defender.usedThisDrive?.includes("Watch Out!");
        if (watchOut) defender.usedThisDrive = [...(defender.usedThisDrive ?? []), "Watch Out!"];
        const dodges = result === "defender_stumbles" && (hasSkill(defender, "Dodge") || watchOut) && !hasSkill(attacker, "Tackle");
        if (dodges && watchOut && !hasSkill(defender, "Dodge")) ctx.emit({ type: "SkillUsed", playerId: defender.id, skill: "Watch Out!" });
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
        bothDown(ctx, proc, attacker, defender);
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
        const pinned = state.players[proc.pushing!.playerId]!;
        const chomper = pinned.chompedBy.find((id) => chompHolds(state, pinned, id));
        if (proc.stage === "standFirm" || isRooted(pinned) || !chomper) {
          ctx.emit({ type: "SkillUsed", playerId: pinned.id, skill: proc.stage === "standFirm" ? "Stand Firm" : "Take Root" });
        } else ctx.emit({ type: "SkillUsed", playerId: chomper, skill: "Monstrous Mouth" });
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
        const canFollow = proc.vacated !== undefined && !proc.multiple && isOnPitch(attacker) && attacker.status === "standing" && !isPinned(state, attacker) && !playerAt(state, proc.vacated) && proc.fended !== true;
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
            ctx.push(...trapdoor(state, attacker, proc.vacated!));
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
          ...(knock ? [knockDownDefender(proc, attacker, defender)] : []),
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
          ...(canReroll(state, proc, attacker) ? [teamRerollTemplate(state, attacker.side)] : []),
          ...skillTemplates(state, proc, attacker, defender),
          { type: "DECLINE_REROLL", side: attacker.side },
        ];
      case "proDie":
        return [{ type: "REROLL_BLOCK_DIE", side: attacker.side, results: proc.results!, skill: proc.dieSkill ?? "Pro" }];
      case "gored":
        return [{ type: "USE_SKILL", side: attacker.side, playerId: attacker.id, skill: "Gored by the Bull" }];
      case "indomitable":
        return [{ type: "USE_SKILL", side: attacker.side, playerId: attacker.id, skill: "Indomitable" }];
      case "savageDice":
        return [{ type: "REROLL_BLOCK_DIE", side: attacker.side, results: proc.results!, skill: "Savage Blow", multiple: true }];
      case "savageReroll":
        return [{ type: "ROLL", side: attacker.side, dice: [{ kind: "block", count: proc.savage!.length }], reason: "Savage Blow (re-roll block dice)" }];
      case "pro":
      case "proTeam":
      case "proLoner":
        return proTemplates(state, proc.stage, attacker);
      case "proReroll":
        return [{ type: "ROLL", side: attacker.side, dice: [{ kind: "block", count: 1 }], reason: `${proc.dieSkill ?? "Pro"} (re-roll a block die)` }];
      case "loner":
        return [lonerRollTemplate(state, attacker)];
      case "singleDie":
        return [{ type: "ROLL", side: attacker.side, dice: [{ kind: "block", count: 1 }], reason: singleDieReason(proc.singleDie!) }];
      case "choose": {
        const chooser = proc.dice > 0 ? attacker.side : defender.side;
        const reroll =
          proc.dice > 0 && canReroll(state, proc, attacker)
            ? [teamRerollTemplate(state, attacker.side)]
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
    injure(ctx, player, a! + b!, { crowd: true, ...(proc.sppTo ? { sppTo: proc.sppTo } : {}) });
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

/** Monstrous Mouth: a chomp works on 3+. */
export const CHOMP_TARGET = 3;

/** Monstrous Mouth: chomps that no longer hold end for good. */
export function releaseChomps(state: GameState) {
  for (const p of Object.values(state.players)) {
    if (p.chompedBy.length > 0) p.chompedBy = p.chompedBy.filter((id) => chompHolds(state, p, id));
  }
}

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
 * Monstrous Mouth (a chomp) rolls a D6 (team re-roll): on 3+ the target is chomped, which pins them as long as the
 * chomping player stays next to them with a tackle zone (see `isPinned`); a failure does nothing.
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
        } else if (proc.skill === "Monstrous Mouth") {
          ctx.push({ type: "Check", kind: "chomp", playerId: attacker.id, target: CHOMP_TARGET, modifier: 0, stage: "roll", rerolled: false });
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
        if (proc.skill === "Monstrous Mouth") {
          const defender = getPlayer(ctx, proc.defenderId);
          if (state.lastCheck?.success && !defender.chompedBy.includes(attacker.id)) {
            defender.chompedBy.push(attacker.id);
            ctx.emit({ type: "PlayerChomped", playerId: attacker.id, victimId: defender.id });
          }
          state.lastCheck = null;
          return "done";
        }
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
        let roll = a! + b! + (proc.skill === "Chainsaw" ? chainsawArmour(victim) : 0);
        // A Sneaky Pair on a Stab: +1 to the armour roll if it needs it, otherwise to the injury roll.
        proc.sneaky = proc.skill === "Stab" && sneakyPair(state, attacker, victim);
        proc.sneakyOnArmour = proc.sneaky && !hasSkill(victim, "Iron Hard Skin") && roll < victim.av;
        if (proc.sneakyOnArmour) roll += 1;
        if (!chained && roll < victim.av) {
          ctx.emit({ type: "ArmourHeld", playerId: victim.id, roll });
          if (masterAssassin(proc, attacker, victim)) {
            proc.stage = "armourReroll";
            return "wait";
          }
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
        proc.injuryRoll = a! + b! + (proc.sneaky && !proc.sneakyOnArmour ? 1 : 0);
        if (toxin(proc, attacker, victim) && injuryOutcome(victim, proc.injuryRoll + 1) !== injuryOutcome(victim, proc.injuryRoll)) {
          proc.stage = "injuryBonus";
          return "wait";
        }
        if (!proc.mauled && savageMauling(attacker, victim, proc.injuryRoll)) {
          proc.stage = "injuryReroll";
          return "wait";
        }
        // The ball bounces once the injury is resolved.
        if (proc.dropped) ctx.push(dropBall(victim, square));
        injure(ctx, victim, proc.injuryRoll, { byId: proc.attackerId, ...specialActionSpp(state, proc, victim) });
        return "done";
      }
      case "injuryBonus": {
        if (action === null) return "wait";
        const victim = getPlayer(ctx, proc.victimId!);
        if (ctx.expect(action, "USE_SKILL").use) {
          useOncePerGame(ctx, attacker, "Toxin Connoisseur");
          proc.injuryRoll! += 1;
        }
        if (proc.dropped) ctx.push(dropBall(victim, squareOf(ctx, victim)));
        injure(ctx, victim, proc.injuryRoll!, { byId: proc.attackerId, ...specialActionSpp(state, proc, victim) });
        return "done";
      }
      case "armourReroll": {
        if (action === null) return "wait";
        proc.assassin = true;
        if (!ctx.expect(action, "USE_SKILL").use) return "done";
        // Master Assassin: the armour is rolled again, and the new roll stands.
        useOncePerGame(ctx, attacker, "Master Assassin");
        proc.stage = "armour";
        return "continue";
      }
      case "injuryReroll": {
        if (action === null) return "wait";
        const victim = getPlayer(ctx, proc.victimId!);
        proc.mauled = true;
        if (ctx.expect(action, "USE_SKILL").use) {
          // Savage Mauling: the injury is rolled again, and the new roll stands.
          useOncePerGame(ctx, attacker, "Savage Mauling");
          proc.stage = "injury";
          return "continue";
        }
        if (proc.dropped) ctx.push(dropBall(victim, squareOf(ctx, victim)));
        injure(ctx, victim, proc.injuryRoll!, { byId: proc.attackerId, ...specialActionSpp(state, proc, victim) });
        return "done";
      }
    }
  },
  actions(state, proc) {
    if (proc.stage === "injuryReroll") return [{ type: "USE_SKILL", side: state.players[proc.attackerId]!.side, playerId: proc.attackerId, skill: "Savage Mauling" }];
    if (proc.stage === "injuryBonus") return [{ type: "USE_SKILL", side: state.players[proc.attackerId]!.side, playerId: proc.attackerId, skill: "Toxin Connoisseur" }];
    if (proc.stage === "armourReroll") return [{ type: "USE_SKILL", side: state.players[proc.attackerId]!.side, playerId: proc.attackerId, skill: "Master Assassin" }];
    if (proc.stage !== "armour" && proc.stage !== "injury") return [];
    const victim = state.players[proc.victimId!]!;
    const reason = proc.stage === "armour" ? `Armour ${victim.av}+ (${victim.name}, ${attackName(proc)})` : `Injury (${victim.name})`;
    return [{ type: "ROLL", side: null, dice: [{ kind: "d6", count: 2 }], reason }];
  },
};

/**
 * Violent Innovator: a casualty an opponent suffers from the player's Stab, Chainsaw or Breathe Fire earns them Star
 * Player Points (not Projectile Vomit).
 */
function specialActionSpp(state: GameState, proc: P<"Vomit">, victim: PlayerState): { sppTo?: string[] } {
  const attacker = state.players[proc.attackerId]!;
  const special = proc.skill === "Stab" || proc.skill === "Chainsaw" || proc.skill === "Breathe Fire";
  return special && victim.side !== attacker.side && hasSkill(attacker, "Violent Innovator") ? { sppTo: [attacker.id] } : {};
}

/** Toxin Connoisseur: once per game, +1 to the injury roll of a Stab against an opponent, after the roll. */
const toxin = (proc: P<"Vomit">, attacker: PlayerState, victim: PlayerState) =>
  proc.skill === "Stab" && victim.side !== attacker.side && hasSkill(attacker, "Toxin Connoisseur") && !attacker.usedThisGame?.includes("Toxin Connoisseur");

/** Master Assassin: once per game, the attacker may re-roll the armour roll of a Stab against an opponent that held. */
const masterAssassin = (proc: P<"Vomit">, attacker: PlayerState, victim: PlayerState) =>
  proc.skill === "Stab" && !proc.assassin && victim.side !== attacker.side && hasSkill(attacker, "Master Assassin") && !attacker.usedThisGame?.includes("Master Assassin");

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
    ctx.push({ type: "KnockDown", playerId: defender.id, turnover: false, stage: "fall", ...specialActionSpp(state, proc, defender) });
  } else if (roll >= BREATHE_FIRE_PRONE && hasSkill(defender, "Ball & Chain")) {
    // Placed prone, a Ball & Chain player rolls for injury.
    ctx.push({ type: "KnockDown", playerId: defender.id, turnover: false, stage: "fall", ...specialActionSpp(state, proc, defender) });
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
