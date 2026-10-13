import type { Ctx, Handler } from "../context";
import { other, teamPlayers } from "../pitch";
import { INDUCEMENTS, PRAYERS, type GameState, type Inducements, type MercenaryChoice, type Procedure, type Side, type TeamSetup, type TeamState } from "../types";
import { createPlayer } from "./helpers";

type P<T extends Procedure["type"]> = Extract<Procedure, { type: T }>;

/** The underdog may add at most this much from its treasury to its petty cash. */
export const UNDERDOG_TREASURY = 50_000;

/** The underdog gets a free Prayer to Nuffle per this much Team Value difference left after the shop. */
export const FREE_PRAYER_GAP = 50_000;

/** What a team may spend in the shop: petty cash (spent first), then gold from its treasury. */
export function shopBudget(state: GameState, side: Side): { pettyCash: number; treasury: number } {
  const team = state.teams[side];
  const opponent = state.teams[other(side)];
  if (team.teamValue >= opponent.teamValue) return { pettyCash: 0, treasury: team.treasury };
  return { pettyCash: opponent.teamValue - team.teamValue + opponent.inducementsCost, treasury: Math.min(UNDERDOG_TREASURY, team.treasury) };
}

/** A team has at most this many players, star players and mercenaries included. */
export const MAX_TEAM_PLAYERS = 16;

/** How many more players the team may hire. */
const freeSlots = (state: GameState, side: Side) => Math.max(0, MAX_TEAM_PLAYERS - teamPlayers(state, side).length);

/** The team can afford at least one inducement, star player or mercenary on offer. */
function canBuy(state: GameState, team: TeamState, budget: number) {
  const hires = freeSlots(state, team.side) === 0 || !team.hires ? [] : [...team.hires.stars.map((s) => s.cost), ...team.hires.mercenaries.filter((m) => m.max > 0).map((m) => m.cost)];
  return [...Object.values(team.inducementPrices).filter((p) => p.max > 0).map((p) => p.cost), ...hires].some((cost) => cost <= budget);
}

/**
 * Star players and mercenaries a team chose, checked against its offer: at most `maxStars` star players (a pair counts
 * as one, and comes together), no more of a position than the roster allows, no more Big Guys than it may still have,
 * 16 players in all. Returns their cost and the players who join the reserves; mercenaries gain Loner (4+).
 */
function hire(ctx: Ctx, side: Side, stars: string[], mercenaries: MercenaryChoice[]) {
  const team = ctx.state.teams[side];
  const offer = team.hires;
  if (stars.length + mercenaries.length === 0) return { cost: 0, players: [] };
  if (!offer) return ctx.reject(`${team.name} cannot hire players.`);
  if (stars.length + mercenaries.length > freeSlots(ctx.state, side)) ctx.reject(`${team.name} can hire at most ${freeSlots(ctx.state, side)} players.`);
  if (new Set(stars).size !== stars.length) ctx.reject("A star player can only be hired once.");
  let cost = 0;
  let nr = Math.max(0, ...teamPlayers(ctx.state, side).map((p) => p.nr));
  const players: TeamSetup["players"] = [];
  for (const name of stars) {
    const star = offer.stars.find((s) => s.position === name);
    if (!star) return ctx.reject(`${team.name} cannot hire ${name}.`);
    const { cost: price, partner, ...stats } = star;
    if (partner && !stars.includes(partner)) ctx.reject(`${name} and ${partner} are hired together.`);
    cost += price;
    players.push({ ...stats, nr: ++nr, name, hired: "star" });
  }
  // A pair hired together counts as one star player.
  const counted = stars.filter((name) => {
    const partner = offer.stars.find((s) => s.position === name)!.partner;
    return !partner || name < partner;
  });
  if (counted.length > offer.maxStars) ctx.reject(`At most ${offer.maxStars} star players.`);
  let bigGuys = 0;
  for (const choice of mercenaries) {
    const merc = offer.mercenaries.find((m) => m.stats.position === choice.position);
    if (!merc) return ctx.reject(`${team.name} cannot hire a ${choice.position} mercenary.`);
    if (mercenaries.filter((m) => m.position === choice.position).length > merc.max) ctx.reject(`At most ${merc.max} ${choice.position} mercenaries.`);
    if (choice.skill !== undefined && !merc.skills.includes(choice.skill)) ctx.reject(`A ${choice.position} mercenary cannot gain ${choice.skill}.`);
    if (merc.bigGuy && ++bigGuys > offer.maxBigGuys) ctx.reject(`At most ${offer.maxBigGuys} more Big Guys.`);
    cost += merc.cost + (choice.skill !== undefined ? offer.mercenarySkillCost : 0);
    const loner = merc.stats.skills.some((s) => s.startsWith("Loner")) ? [] : ["Loner(4)"];
    const skills = [...merc.stats.skills, ...loner, ...(choice.skill !== undefined ? [choice.skill] : [])];
    players.push({ ...merc.stats, skills, nr: ++nr, name: `${choice.position} (mercenary)`, hired: "mercenary" });
  }
  return { cost, players };
}

/** Both teams hired the same star player: neither keeps them. */
export function hiredTwice(ctx: Ctx, side: Side) {
  const { players } = ctx.state;
  for (const star of teamPlayers(ctx.state, side).filter((p) => p.hired === "star")) {
    const twin = teamPlayers(ctx.state, other(side)).find((p) => p.hired === "star" && p.name === star.name);
    if (!twin) continue;
    delete players[star.id];
    delete players[twin.id];
    ctx.emit({ type: "StarHiredTwice", name: star.name, playerIds: [twin.id, star.id] });
  }
}

/**
 * Open the pre-game shop (a game option) when the Current Team Values differ: the team with the higher value may spend
 * its treasury first; the other team then gets petty cash, the difference plus what the first team spent, and may add
 * up to 50,000 gold pieces from its treasury. With equal values nobody buys anything.
 */
export function openShop(ctx: Ctx) {
  const { home, away } = ctx.state.teams;
  if (!ctx.state.shop || home.teamValue === away.teamValue) return;
  const overdog: Side = home.teamValue > away.teamValue ? "home" : "away";
  ctx.push({ type: "Shop", sides: [overdog, other(overdog)] });
}

/** The next team's turn in the shop; the underdog is told its petty cash. */
function nextTeam(ctx: Ctx, proc: P<"Shop">) {
  proc.sides.shift();
  const side = proc.sides[0];
  if (side !== undefined) ctx.emit({ type: "PettyCash", side, amount: shopBudget(ctx.state, side).pettyCash });
}

/**
 * The pre-game shop: each team in turn buys inducements up to the most it may buy of each, and hires star players and
 * mercenaries (see `hire`), within its budget (see `shopBudget`). Petty cash left over is lost; only the gold beyond it
 * comes out of the treasury. A team that cannot afford anything is skipped. If both teams hire the same star player,
 * neither gets them, and both have paid.
 */
export const Shop: Handler<P<"Shop">> = {
  step(ctx, proc, action) {
    const side = proc.sides[0];
    if (side === undefined) return "done";
    const team = ctx.state.teams[side];
    const budget = shopBudget(ctx.state, side);
    if (!canBuy(ctx.state, team, budget.pettyCash + budget.treasury)) {
      nextTeam(ctx, proc);
      return "continue";
    }
    if (action === null) return "wait";
    const { inducements, stars = [], mercenaries = [] } = ctx.expect(action, "BUY_INDUCEMENTS");
    let cost = 0;
    const bought: Inducements = {};
    for (const [id, count] of Object.entries(inducements)) {
      const price = (INDUCEMENTS as readonly string[]).includes(id) ? team.inducementPrices[id as keyof Inducements] : undefined;
      if (!Number.isInteger(count) || count < 0) ctx.reject(`Invalid number of ${id}.`);
      if (count === 0) continue;
      if (!price) return ctx.reject(`${team.name} cannot buy ${id}.`);
      if (count > price.max) ctx.reject(`At most ${price.max} ${id} for ${team.name}.`);
      bought[id as keyof Inducements] = count;
      cost += count * price.cost;
    }
    const hired = hire(ctx, side, stars, mercenaries);
    cost += hired.cost;
    if (cost > budget.pettyCash + budget.treasury) ctx.reject(`${team.name} cannot spend ${cost} gold pieces (${budget.pettyCash + budget.treasury} available).`);
    team.inducements = bought;
    team.bribes += bought.bribes ?? 0;
    team.inducementsCost = cost;
    team.treasurySpent = Math.max(0, cost - budget.pettyCash);
    for (const p of hired.players) {
      const player = createPlayer(side, p);
      ctx.state.players[player.id] = player;
    }
    ctx.emit({ type: "InducementsBought", side, inducements: bought, hired: hired.players.map((p) => p.name), cost, treasury: team.treasurySpent });
    hiredTwice(ctx, side);
    nextTeam(ctx, proc);
    return "continue";
  },
  actions(state, proc) {
    const side = proc.sides[0]!;
    const team = state.teams[side];
    return [{ type: "BUY_INDUCEMENTS", side, prices: team.inducementPrices, ...shopBudget(state, side), hires: team.hires, freeSlots: freeSlots(state, side) }];
  },
};

/**
 * After the shop, the team with the lower Team Value (counting the inducements bought) gets a free Prayer to Nuffle per
 * 50,000 gold pieces of difference, on top of those it bought (at most one of each prayer in all).
 */
export function freePrayers(state: GameState): { side: Side; count: number } | null {
  if (!state.shop) return null;
  const value = (side: Side) => state.teams[side].teamValue + state.teams[side].inducementsCost;
  const gap = value("home") - value("away");
  if (gap === 0) return null;
  const side: Side = gap < 0 ? "home" : "away";
  const count = Math.min(Math.floor(Math.abs(gap) / FREE_PRAYER_GAP), PRAYERS.length - (state.teams[side].inducements.prayers ?? 0));
  return count > 0 ? { side, count } : null;
}
