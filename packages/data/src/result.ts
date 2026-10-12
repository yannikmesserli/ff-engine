import { starPlayerPoints, type GameState, type Side } from "@bb/engine";
import { MAX_PLAYERS, TeamFileSchema, type TeamFile, type TeamPlayer } from "./schemas";

/** BB2025 limits of Dedicated Fans. */
const MIN_FANS = 1;
const MAX_FANS = 7;

/**
 * The team file after a finished game, for the team that played `side`: Star Player Points earned, casualties (a
 * Seriously Hurt, Serious Injury or Lasting Injury misses the next game; a Serious Injury adds a Niggling Injury, a
 * Lasting Injury a -1; the dead and the players who left after a concession are removed), players who sat this game out
 * are back, an opponent raised by Plague Ridden joins (if there is room), winnings go to the treasury and Dedicated Fans
 * change. Journeymen and Riotous Rookies are not kept; the inducements bought for the game are used up.
 */
export function teamAfterGame(input: unknown, state: GameState, side: Side): TeamFile {
  const team = TeamFileSchema.parse(input);
  const result = state.result;
  if (!state.finished || !result) throw new Error("The game is not over.");
  const players: TeamPlayer[] = team.players.flatMap((p) => {
    const played = state.players[`${side}-${p.number}`];
    // Missed this game: back for the next one.
    if (!played || p.missNextGame) return [{ ...p, missNextGame: false }];
    if (played.casualty?.result === "dead" || result.leaving.includes(played.id)) return [];
    const casualty = played.casualty?.result;
    const injuries = [
      ...p.injuries,
      ...(casualty === "serious-injury" ? (["niggling"] as const) : []),
      ...(casualty === "lasting-injury" && played.casualty?.lasting ? [played.casualty.lasting] : []),
    ];
    const missNextGame = casualty === "seriously-hurt" || casualty === "serious-injury" || casualty === "lasting-injury";
    return [{ ...p, injuries, missNextGame, spp: p.spp + starPlayerPoints(state, played) }];
  });
  const raisePosition = state.teams[side].raisePosition?.position;
  for (const raised of Object.values(state.players)) {
    if (raised.side !== side || !raised.raised || !raisePosition || players.length >= MAX_PLAYERS) continue;
    if (raised.casualty?.result === "dead") continue;
    const number = players.some((p) => p.number === raised.nr) ? Math.max(...players.map((p) => p.number)) + 1 : raised.nr;
    players.push({ number, name: raised.name, position: raisePosition, skills: [], improvements: {}, injuries: [], missNextGame: false, spp: starPlayerPoints(state, raised) });
  }
  return {
    ...team,
    dedicatedFans: Math.min(MAX_FANS, Math.max(MIN_FANS, team.dedicatedFans + result.dedicatedFans[side])),
    treasury: team.treasury + result.winnings[side],
    inducements: {},
    players,
  };
}
