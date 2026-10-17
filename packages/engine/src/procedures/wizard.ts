import type { Ctx, Handler } from "../context";
import type { GameState, PlayerState, Procedure, Side, Spell, Square } from "../types";
import { PITCH_HEIGHT, PITCH_WIDTH, isOnPitch, sameSquare } from "../pitch";
import { getPlayer, inducementsLeft, spendInducement, squareOf } from "./helpers";

type P<T extends Procedure["type"]> = Extract<Procedure, { type: T }>;

/** The wizard's spells, in the order they are offered. */
export const SPELLS: Spell[] = ["fireball", "zap"];

/** Fireball hits each player in its area on 4+. */
export const FIREBALL_TARGET = 4;

/** What a player turned into a frog by Zap! becomes until the end of the drive. */
export const FROG = { ma: 5, st: 1, ag: 2, pa: null, av: 5, skills: ["Dodge", "No Ball", "Titchy", "Stunty", "Very Long Legs", "Leap"] };

/** The wizard, if the team still has it: offered between two turns of a drive. */
export const wizardAsk = (state: GameState, side: Side): Procedure[] =>
  inducementsLeft(state.teams[side], "wizard") > 0 ? [{ type: "Wizard", side, stage: "ask" }] : [];

/** The players on the pitch in the 3x3 area centred on `square`: the square and the eight around it. */
const fireballArea = (state: GameState, square: Square) =>
  Object.values(state.players).filter(
    (p): p is PlayerState & { at: Square } => isOnPitch(p) && Math.abs(p.at.x - square.x) <= 1 && Math.abs(p.at.y - square.y) <= 1,
  );

/** Fireball: every square of the pitch with a player on it or next to it. */
function fireballSquares(state: GameState): Square[] {
  const squares: Square[] = [];
  for (let x = 0; x < PITCH_WIDTH; x++) for (let y = 0; y < PITCH_HEIGHT; y++) if (fireballArea(state, { x, y }).length > 0) squares.push({ x, y });
  return squares;
}

/** Zap!: any player on the pitch who is not a frog already. */
const zapTargets = (state: GameState) => Object.values(state.players).filter((p) => isOnPitch(p) && !p.frog);

/** Zap! works on a 6, or on a roll of 2 or more that equals or beats the target's ST. */
const zapWorks = (roll: number, st: number) => roll === 6 || (roll > 1 && roll >= st);

/**
 * Wizard (an inducement, once per game): between two turns of a drive (not after a touchdown or at the end of a half),
 * the coach may cast one spell. Fireball: centred on any square, it hits each player (of either team) in that square
 * and the eight around it on a D6 of 4+; a player hit is knocked down, with +1 to the armour roll, or to the injury
 * roll if the armour breaks without it. Zap!: a D6 against a player on the pitch; on a 6, or on 2+ that equals or beats
 * their ST, they turn into a frog (MA 5, ST 1, AG 2+, no PA, AV 5+, Dodge, No Ball, Titchy, Stunty, Very Long Legs and
 * Leap) until the end of the drive; a frog holding the ball drops it. Neither causes a turnover.
 */
export const Wizard: Handler<P<"Wizard">> = {
  step(ctx, proc, action) {
    const { state } = ctx;
    switch (proc.stage) {
      case "ask":
      case "target": {
        if (action === null) return "wait";
        const a = ctx.expect(action, "CAST_SPELL", "FIREBALL", "ZAP");
        if (a.type === "CAST_SPELL") {
          if (a.spell === null) return "done";
          if (!SPELLS.includes(a.spell)) ctx.reject("Unknown spell.");
          proc.spell = a.spell;
          proc.stage = "target";
          return "wait";
        }
        if (proc.stage !== "target" || a.type !== { fireball: "FIREBALL", zap: "ZAP" }[proc.spell!]) ctx.reject("Pick the spell first.");
        if (a.type === "FIREBALL") {
          if (!fireballSquares(state).some((s) => sameSquare(s, a.square))) ctx.reject("The Fireball must hit at least one player.");
          spendInducement(ctx, proc.side, "wizard");
          ctx.emit({ type: "SpellCast", side: proc.side, spell: "fireball", square: { ...a.square } });
          proc.hit = fireballArea(state, a.square).map((p) => p.id);
          proc.stage = "fireball";
          return "continue";
        }
        if (!zapTargets(state).some((p) => p.id === a.targetId)) ctx.reject("Zap! needs a player on the pitch who is not a frog.");
        spendInducement(ctx, proc.side, "wizard");
        ctx.emit({ type: "SpellCast", side: proc.side, spell: "zap", playerId: a.targetId });
        proc.targetId = a.targetId;
        proc.stage = "zap";
        return "wait";
      }
      case "fireball": {
        // Each player in the area in turn, the knock-down of a hit resolved before the next roll.
        const hit = proc.hit!.filter((id) => isOnPitch(state.players[id]!));
        const player = hit[0];
        if (player === undefined) return "done";
        if (action === null) return "wait";
        const [roll] = ctx.roll(action, [{ kind: "d6", count: 1 }], `Fireball ${FIREBALL_TARGET}+`);
        proc.hit = hit.slice(1);
        const hits = roll! >= FIREBALL_TARGET;
        ctx.emit({ type: "SpellRolled", spell: "fireball", playerId: player, roll: roll!, hit: hits });
        if (hits) ctx.push({ type: "KnockDown", playerId: player, turnover: false, stage: "fall", mightyBlow: { bonus: 1, skill: "Fireball" } });
        return "continue";
      }
      case "zap": {
        if (action === null) return "wait";
        const player = getPlayer(ctx, proc.targetId!);
        const [roll] = ctx.roll(action, [{ kind: "d6", count: 1 }], `Zap! (ST ${player.st})`);
        const works = zapWorks(roll!, player.st);
        ctx.emit({ type: "SpellRolled", spell: "zap", playerId: player.id, roll: roll!, hit: works });
        if (works) zap(ctx, player);
        return "done";
      }
    }
  },
  actions(state, proc) {
    const side = proc.side;
    if (proc.stage === "ask") return [{ type: "CAST_SPELL", side, spells: SPELLS }];
    if (proc.stage === "target") {
      const other = { type: "CAST_SPELL" as const, side, spells: SPELLS.filter((s) => s !== proc.spell) };
      return proc.spell === "fireball"
        ? [{ type: "FIREBALL", side, squares: fireballSquares(state) }, other]
        : [{ type: "ZAP", side, targetIds: zapTargets(state).map((p) => p.id) }, other];
    }
    if (proc.stage === "fireball") {
      const player = state.players[proc.hit!.find((id) => isOnPitch(state.players[id]!))!]!;
      return [{ type: "ROLL", side, dice: [{ kind: "d6", count: 1 }], reason: `Fireball ${FIREBALL_TARGET}+ (${player.name})` }];
    }
    const target = state.players[proc.targetId!]!;
    return [{ type: "ROLL", side, dice: [{ kind: "d6", count: 1 }], reason: `Zap! (${target.name}, ST ${target.st}): 6, or ${Math.max(2, target.st)}+` }];
  },
};

/** Turn the player into a frog; a frog cannot hold the ball, so it bounces. */
function zap(ctx: Ctx, player: PlayerState) {
  const { ball } = ctx.state;
  const { ma, st, ag, pa, av, skills } = player;
  player.frog = { ma, st, ag, pa, av, skills: [...skills] };
  Object.assign(player, { ...FROG, skills: [...FROG.skills] });
  const square = squareOf(ctx, player);
  if (ball.carried && ball.square && sameSquare(ball.square, square)) {
    ball.carried = false;
    ctx.push({ type: "Bounce", from: { ...square }, kickoff: false, receiving: null });
  }
}

/** The end of the drive: every frog turns back into the player. */
export function restoreFrogs(ctx: Ctx) {
  for (const p of Object.values(ctx.state.players)) {
    if (!p.frog) continue;
    Object.assign(p, p.frog);
    delete p.frog;
    ctx.emit({ type: "FrogRestored", playerId: p.id });
  }
}

