import type { Ctx, Handler } from "../context";
import { other } from "../pitch";
import { INDUCEMENTS, PRAYERS, type GameState, type Inducements, type Procedure, type Side, type TeamState } from "../types";

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

/** The team can afford at least one inducement on offer. */
const canBuy = (team: TeamState, budget: number) => Object.values(team.inducementPrices).some((p) => p.max > 0 && p.cost <= budget);

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
 * The pre-game shop: each team in turn buys inducements up to the most it may buy of each, within its budget (see
 * `shopBudget`). Petty cash left over is lost; only the gold beyond it comes out of the treasury. A team that cannot
 * afford anything is skipped.
 */
export const Shop: Handler<P<"Shop">> = {
  step(ctx, proc, action) {
    const side = proc.sides[0];
    if (side === undefined) return "done";
    const team = ctx.state.teams[side];
    const budget = shopBudget(ctx.state, side);
    if (!canBuy(team, budget.pettyCash + budget.treasury)) {
      nextTeam(ctx, proc);
      return "continue";
    }
    if (action === null) return "wait";
    const { inducements } = ctx.expect(action, "BUY_INDUCEMENTS");
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
    if (cost > budget.pettyCash + budget.treasury) ctx.reject(`${team.name} cannot spend ${cost} gold pieces (${budget.pettyCash + budget.treasury} available).`);
    team.inducements = bought;
    team.bribes += bought.bribes ?? 0;
    team.inducementsCost = cost;
    team.treasurySpent = Math.max(0, cost - budget.pettyCash);
    ctx.emit({ type: "InducementsBought", side, inducements: bought, cost, treasury: team.treasurySpent });
    nextTeam(ctx, proc);
    return "continue";
  },
  actions(state, proc) {
    const side = proc.sides[0]!;
    return [{ type: "BUY_INDUCEMENTS", side, prices: state.teams[side].inducementPrices, ...shopBudget(state, side) }];
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
