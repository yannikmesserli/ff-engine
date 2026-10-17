import type { Ctx } from "../context";
import type { Action, ActionTemplate, GameState, InducementId, PlayerState, Side, Square, SppRecord, TeamSetup, TeamState, Weather } from "../types";
import { hasSkill, skillName } from "../skills";
import { adjacent, hasTackleZone, inBounds, inHalf, isOnPitch, other, playerAt, sameSquare, scoringEndZoneX, tackleZones, teamPlayers } from "../pitch";

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
    primary: [...(p.primary ?? [])],
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
    gouged: false,
    chompedBy: [],
    advancements: p.advancements ?? 0,
    ...(p.hired ? { hired: p.hired } : {}),
    spp: { touchdowns: 0, casualties: 0, completions: 0, interceptions: 0, landings: 0, catches: 0, mvp: 0 },
  };
}

/** The Ballista: once per game, the player may re-roll a failed pass or team-mate throw, instead of a team re-roll. */
export const ballista = (player: PlayerState, rerolled: boolean) => !rerolled && hasSkill(player, "The Ballista") && !player.usedThisGame?.includes("The Ballista");

/** Use up a once-per-game skill. */
export function useOncePerGame(ctx: Ctx, player: PlayerState, skill: string) {
  player.usedThisGame = [...(player.usedThisGame ?? []), skill];
  ctx.emit({ type: "SkillUsed", playerId: player.id, skill });
}

/**
 * A Sneaky Pair: the attacker (one of the pair) fouls or stabs an opponent both of the pair mark (standing next to them
 * with a tackle zone): +1 to the armour roll if it needs it, otherwise to the injury roll.
 */
export const sneakyPair = (state: GameState, attacker: PlayerState, victim: PlayerState) =>
  hasSkill(attacker, "A Sneaky Pair") &&
  victim.side !== attacker.side &&
  isOnPitch(victim) &&
  adjacent(victim.at).filter((s) => {
    const p = playerAt(state, s);
    return p !== undefined && p.side === attacker.side && hasTackleZone(p) && hasSkill(p, "A Sneaky Pair");
  }).length >= 2;

/** Count one more of `kind` towards the player's Star Player Points. */
export function earnSpp(state: GameState, playerId: string, kind: keyof SppRecord) {
  const player = state.players[playerId];
  if (player) player.spp[kind] += 1;
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
  /** A kick, pass or throw-in (not a bounce): players with Diving Catch next to the square may try to catch it. */
  divingCatch?: boolean;
  /** An accurate pass: +1 to catch it with Diving Catch. */
  accurate?: boolean;
  /** A pass thrown by this player: a catch may earn Star Player Points. */
  passerId?: string;
}

/** Diving Catch: standing, undistracted players with the skill next to the square where the ball comes down. */
export function divingCatchers(state: GameState, square: Square): PlayerState[] {
  return adjacent(square).flatMap((s) => {
    const p = playerAt(state, s);
    return p && p.status === "standing" && !p.distracted && hasSkill(p, "Diving Catch") ? [p] : [];
  });
}

/**
 * The ball arrives on a square after a kick, bounce or throw-in: touchback, throw-in from `from` when it left the
 * pitch, Diving Catch from a next square, a catch by a standing player, or a bounce.
 */
export function landBall(ctx: Ctx, square: Square, from: Square, { kickoff, receiving, bounceIfEmpty, scattered, divingCatch = false, accurate = false, passerId }: Landing) {
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
  if (divingCatch && divingCatchers(state, square).length > 0) {
    ctx.push({ type: "DivingCatch", square: { ...square }, landing: { kickoff, receiving, scattered, accurate, ...(passerId ? { passerId } : {}) }, stage: "first" });
    return;
  }
  const player = playerAt(state, square);
  if (player?.status === "standing") {
    ctx.push({ type: "Catch", playerId: player.id, kickoff, scattered, stage: "check", ...(accurate ? { accurate } : {}), ...passCatch(passerId, accurate) });
  } else if (player || bounceIfEmpty) {
    ctx.push({ type: "Bounce", from: square, kickoff, receiving });
  }
}

/** A thrown pass being caught: who threw it, and whether it is a completion if a team-mate catches it in the target square. */
export const passCatch = (passerId: string | undefined, completion: boolean) => (passerId ? { passerId, ...(completion ? { completion } : {}) } : {});

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
  player.spp.touchdowns += 1;
  ctx.emit({ type: "Touchdown", side: player.side, playerId: player.id });
  // Star of the Show: once per game, scoring gives the team a team re-roll for the next drive.
  if (hasSkill(player, "Star of the Show") && !player.usedThisGame?.includes("Star of the Show")) {
    useOncePerGame(ctx, player, "Star of the Show");
    const team = state.teams[player.side];
    team.nextDriveRerolls = (team.nextDriveRerolls ?? 0) + 1;
  }
}

/** End of a drive: drive-long effects expire (exhaustion from the previous drive, Dodgy Snack, kick-off bonuses). */
export function endDrive(ctx: Ctx) {
  const { state } = ctx;
  for (const p of Object.values(state.players)) {
    p.exhausted = false;
    delete p.usedThisDrive;
    if (p.snack) {
      p.ma = p.snack.ma;
      p.av = p.snack.av;
      p.snack = null;
    }
  }
  for (const team of Object.values(state.teams)) {
    // Star of the Show: the re-roll earned in the drive is for the next one.
    team.driveRerolls = team.nextDriveRerolls ?? 0;
    delete team.nextDriveRerolls;
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

/**
 * Pick-up roll modifier on `square`: -1 per opponent's tackle zone, the weather (Pouring Rain), both ignored with Big
 * Hand; +1 with Extra Arms.
 */
export const pickupModifier = (state: GameState, player: PlayerState, square: Square) =>
  (hasSkill(player, "Big Hand") ? 0 : -tackleZones(state, player.side, square) + weatherModifier(state, "pickup")) +
  (hasSkill(player, "Extra Arms") ? 1 : 0);

/** Rush roll modifier: the weather (Blizzard), -1 for a Drunkard, -1 when the opponents prayed for Moles under the Pitch. */
export const rushModifier = (state: GameState, player: PlayerState) =>
  weatherModifier(state, "rush") -
  (hasSkill(player, "Drunkard") ? 1 : 0) -
  (state.teams[other(player.side)].prayers.includes("moles-under-the-pitch") ? 1 : 0);

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
    p.gouged = false;
    p.chompedBy = [];
  }
  state.ball = { square: null, carried: false };
  state.activeSide = null;
  state.activePlayerId = null;
  state.turnover = false;
  state.touchdown = null;
}

/**
 * Leader: the team's Leader re-roll can be used, i.e. it is not spent and one of the half's Leader players is on the
 * pitch (even prone or stunned). Returns that player.
 */
export function leaderReroll(state: GameState, side: Side): PlayerState | undefined {
  const team = state.teams[side];
  if (team.leaderUsed) return undefined;
  return team.leaders.map((id) => state.players[id]!).find((p) => isOnPitch(p));
}

/** Team re-rolls left for the drive (Brilliant Coaching) and the half, the Leader re-roll included. */
export const rerollsLeft = (state: GameState, side: Side) =>
  state.teams[side].rerolls + state.teams[side].driveRerolls + (leaderReroll(state, side) ? 1 : 0);

/**
 * BB2025: any number of team re-rolls per turn, only in the team's own turn (or while a receiving player makes an On the
 * Ball move at the kick-off), each roll at most once.
 */
export const canTeamReroll = (state: GameState, side: Side, rerolled: boolean) =>
  !rerolled && (state.activeSide === side || movingAtKickoff(state, side)) && (rerollsLeft(state, side) > 0 || mascotAvailable(state, side));

/** How many uses of an inducement the team has left. */
export const inducementsLeft = (team: TeamState, id: InducementId) => (team.inducements[id] ?? 0) - (team.inducementsUsed[id] ?? 0);

/** Use up one of the team's inducements. */
export function spendInducement(ctx: Ctx, side: Side, id: InducementId) {
  const team = ctx.state.teams[side];
  team.inducementsUsed[id] = (team.inducementsUsed[id] ?? 0) + 1;
  ctx.emit({ type: "InducementUsed", side, inducement: id });
}

/** Team Mascot: once per half, in the team's own turn, even without team re-rolls left. */
export const mascotAvailable = (state: GameState, side: Side) => {
  const team = state.teams[side];
  return (team.inducements.teamMascot ?? 0) > 0 && !team.mascotUsed && state.activeSide === side;
};

/** The USE_REROLL template of a team re-roll, offering the Team Mascot when it can be tried. */
export const teamRerollTemplate = (state: GameState, side: Side): Extract<ActionTemplate, { type: "USE_REROLL" }> => ({
  type: "USE_REROLL",
  side,
  available: rerollsLeft(state, side),
  ...(mascotAvailable(state, side) ? { mascot: true } : {}),
});

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
export const proTemplate = (state: GameState, player: PlayerState, rerolled: boolean): Array<Extract<ActionTemplate, { type: "USE_SKILL" }>> =>
  canUsePro(state, player, rerolled) ? [{ type: "USE_SKILL", side: player.side, playerId: player.id, skill: "Pro" }] : [];

/** Use Pro: roll the D6 that decides whether the re-roll happens. */
function rollPro(ctx: Ctx, action: Action, player: PlayerState): boolean {
  if (!player.usedSkills.includes("Pro")) {
    player.usedSkills.push("Pro");
    ctx.emit({ type: "SkillUsed", playerId: player.id, skill: "Pro" });
  }
  const [roll] = ctx.roll(action, [{ kind: "d6", count: 1 }], `Pro ${PRO_TARGET}+`);
  const success = roll! >= PRO_TARGET;
  ctx.emit({ type: "CheckResult", kind: "pro", playerId: player.id, success, roll: roll!, target: PRO_TARGET });
  return success;
}

/** The stages of a Pro re-roll, in the procedures that offer it. */
export type ProStage = "pro" | "proTeam" | "proLoner";

/**
 * Pro's stages, shared by the procedures that offer it: "pro" rolls the Pro D6. After a failure the coach may spend a
 * team re-roll, or try the Team Mascot, once, to roll it again ("proTeam", then "proLoner" for the Mascot, Team Captain
 * and Loner rolls; a failed Mascot still leaves the team re-roll).
 * Returns "reroll" when the die may be re-rolled, "stands" when the first result stays, "wait" for the next decision.
 */
export function stepPro(ctx: Ctx, proc: { stage: string; proRetried?: boolean }, action: Action, player: PlayerState): "reroll" | "stands" | "wait" {
  const { state } = ctx;
  if (proc.stage === "proTeam") {
    const a = ctx.expect(action, "USE_REROLL", "DECLINE_REROLL");
    if (a.type === "DECLINE_REROLL") return "stands";
    useTeamReroll(ctx, player.side, a.mascot);
    proc.proRetried = true;
    proc.stage = rerollGate(state, player) ? "proLoner" : "pro";
    return "wait";
  }
  if (proc.stage === "proLoner") {
    const result = rollLoner(ctx, action, player);
    // The Team Mascot failed: a team re-roll may still be spent on the Pro roll.
    if (result === "offer") {
      proc.stage = "proTeam";
      return "wait";
    }
    if (result !== "reroll") return "stands";
    proc.stage = "pro";
    return "wait";
  }
  if (rollPro(ctx, action, player)) return "reroll";
  if (proc.proRetried || !canTeamReroll(state, player.side, false)) return "stands";
  proc.stage = "proTeam";
  return "wait";
}

/** The templates of Pro's stages: the Pro roll, the team re-roll (or Mascot) of a failed one, or the rolls before it. */
export function proTemplates(state: GameState, stage: ProStage, player: PlayerState): ActionTemplate[] {
  if (stage === "proLoner") return [lonerRollTemplate(state, player)];
  if (stage === "proTeam") return [teamRerollTemplate(state, player.side), { type: "DECLINE_REROLL", side: player.side }];
  return [{ type: "ROLL", side: player.side, dice: [{ kind: "d6", count: 1 }], reason: `Pro ${PRO_TARGET}+ (${player.name})` }];
}

/** Team Captain: the team's player with the trait, while they are on the pitch. */
export const teamCaptain = (state: GameState, side: Side) => teamPlayers(state, side).find((p) => isOnPitch(p) && hasSkill(p, "Team Captain"));

/** Team Captain: a 6 saves the team re-roll just used. */
export const CAPTAIN_TARGET = 6;

/**
 * Spend a team re-roll, drive re-rolls first, then the Leader re-roll (it may not last); or (`mascot`) try the Team Mascot, whose 4+ roll comes with the Loner
 * roll (see `rerollGate`). After a failed Mascot roll the coach is asked again, for a team re-roll only. With its
 * Team Captain on the pitch, the team also rolls to save the re-roll.
 */
export function useTeamReroll(ctx: Ctx, side: Side, mascot = false) {
  const team = ctx.state.teams[side];
  team.captainRolling = teamCaptain(ctx.state, side) !== undefined;
  if (mascot) {
    if (!mascotAvailable(ctx.state, side)) ctx.reject("The Team Mascot cannot be used now.");
    team.mascotUsed = true;
    team.mascotRolling = true;
    ctx.emit({ type: "InducementUsed", side, inducement: "teamMascot" });
    return;
  }
  if (rerollsLeft(ctx.state, side) === 0) ctx.reject("No re-roll available.");
  const leader = leaderReroll(ctx.state, side);
  if (team.driveRerolls > 0) team.driveRerolls -= 1;
  else if (leader) {
    team.leaderUsed = true;
    ctx.emit({ type: "SkillUsed", playerId: leader.id, skill: "Leader" });
  } else team.rerolls -= 1;
  ctx.emit({ type: "RerollUsed", side });
}

/** The Team Mascot failed: the roll may be re-rolled again, with a team re-roll only (no Mascot, Pro or skill). */
export function mascotFailed(proc: { rerolled: boolean; mascotFailed?: boolean }) {
  proc.rerolled = false;
  proc.mascotFailed = true;
}

/** A roll is due before a team re-roll happens: the Team Mascot's 4+, the Team Captain's 6+, and Loner's. */
export const rerollGate = (state: GameState, player: PlayerState) =>
  state.teams[player.side].mascotRolling || state.teams[player.side].captainRolling || lonerTarget(player) !== null;

/** Team Mascot: the re-roll happens on 4+. */
export const MASCOT_TARGET = 4;

/** Loner(X): the D6 roll a player needs to use a team re-roll, or null without Loner. */
export function lonerTarget(player: PlayerState): number | null {
  const loner = player.skills.find((s) => skillName(s) === "Loner");
  if (!loner) return null;
  return Number(/\((\d)\+?\)/.exec(loner)?.[1] ?? 4);
}

/** The reason of the rolls due before a team re-roll: the Team Mascot's, the Team Captain's, then Loner's. */
function gateReason(state: GameState, player: PlayerState) {
  const parts = [
    ...(state.teams[player.side].mascotRolling ? [`Team Mascot ${MASCOT_TARGET}+`] : []),
    ...(state.teams[player.side].captainRolling ? [`Team Captain ${CAPTAIN_TARGET}+`] : []),
    ...(lonerTarget(player) !== null ? [`Loner ${lonerTarget(player)}+`] : []),
  ];
  return `${parts.join(", ")} (${player.name})`;
}

/** The dice of the rolls due before a team re-roll: one for the Team Mascot, one for the Team Captain, one for Loner. */
const gateDice = (state: GameState, player: PlayerState) => {
  const team = state.teams[player.side];
  return [{ kind: "d6" as const, count: (team.mascotRolling ? 1 : 0) + (team.captainRolling ? 1 : 0) + (lonerTarget(player) !== null ? 1 : 0) }];
};

/** The ROLL template of the rolls due before a team re-roll (Team Mascot, Loner). */
export const lonerRollTemplate = (state: GameState, player: PlayerState): ActionTemplate => ({
  type: "ROLL",
  side: player.side,
  dice: gateDice(state, player),
  reason: gateReason(state, player),
});

/**
 * The rolls due before a team re-roll, in one throw: the Team Mascot (4+), the Team Captain (6: the re-roll, or the
 * Mascot, is not used up; a saved re-roll comes back as a normal team re-roll), then Loner (a failure loses the
 * re-roll). "reroll": the die is re-rolled; "stands": the first result stands; "offer": the Mascot failed, and the
 * coach may still spend a team re-roll (the other dice, if any, are not read).
 */
export function rollLoner(ctx: Ctx, action: Action, player: PlayerState): "reroll" | "stands" | "offer" {
  const { state } = ctx;
  const team = state.teams[player.side];
  const rolls = ctx.roll(action, gateDice(state, player), gateReason(state, player));
  const mascot = team.mascotRolling;
  if (team.mascotRolling) {
    team.mascotRolling = false;
    const roll = rolls.shift()!;
    const success = roll >= MASCOT_TARGET;
    ctx.emit({ type: "CheckResult", kind: "mascot", playerId: player.id, success, roll, target: MASCOT_TARGET });
    if (!success) {
      team.captainRolling = false;
      return rerollsLeft(state, player.side) > 0 ? "offer" : "stands";
    }
  }
  if (team.captainRolling) {
    team.captainRolling = false;
    const roll = rolls.shift()!;
    const success = roll >= CAPTAIN_TARGET;
    const captain = teamCaptain(state, player.side);
    ctx.emit({ type: "CheckResult", kind: "captain", playerId: captain?.id ?? player.id, success, roll, target: CAPTAIN_TARGET });
    if (success && mascot) team.mascotUsed = false;
    else if (success) team.rerolls += 1;
  }
  const target = lonerTarget(player);
  if (target === null) return "reroll";
  const roll = rolls.shift()!;
  const success = roll >= target;
  ctx.emit({ type: "CheckResult", kind: "loner", playerId: player.id, success, roll, target });
  return success ? "reroll" : "stands";
}
