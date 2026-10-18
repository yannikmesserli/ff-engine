import { useState } from "react";
import { BloodBowlGame, useDownloadedArtwork } from "@bb/board-ui";
import type { GameState } from "@bb/engine";
import { exampleTeams } from "@bb/data";
import { GAME_ID } from "relay/protocol";
import { OnlineGame, newGameId } from "./Online";
import { TeamPicker } from "./TeamPicker";
import { ARTWORK_URL } from "./artwork";

const PARAMS = new URLSearchParams(location.search);

/** `?seed=42` replays the same dice for the first game (handy to reproduce a bug); anything non-numeric is ignored. */
const SEED = parseSeed(PARAMS.get("seed"));

function parseSeed(param: string | null): number | undefined {
  const seed = param?.trim() ? Number(param) : NaN;
  return Number.isFinite(seed) ? seed : undefined;
}

/** The game has started (the first roll, the fan factor, is made) and is not over yet. */
const inProgress = (state: GameState) => !state.finished && state.log.some((e) => e.type === "DiceRolled");

/**
 * `?game=<id>`: an online game through the relay; `?local`: hot-seat on this computer; otherwise a page to choose.
 */
export function App() {
  const game = PARAMS.get("game");
  if (game !== null) {
    return (
      <main>
        {GAME_ID.test(game) ? <OnlineGame gameId={game} /> : <p>Invalid game link. <a href="?">Start a new game</a></p>}
      </main>
    );
  }
  if (PARAMS.has("local") || PARAMS.has("seed")) return <LocalGame />;
  return (
    <main className="pg-home">
      <h1>Blood Bowl</h1>
      <button className="pg-primary" onClick={() => (location.search = `?game=${newGameId()}`)}>
        Create an online game
      </button>
      <p>You get a link to send to your opponent; each of you then picks a team.</p>
      <a href="?local">Or play hot-seat on this computer</a>
    </main>
  );
}

/**
 * Hot-seat: two team pickers and a "New game" button above the game; each new game gets fresh random dice. They are
 * disabled while a game is in progress (undoing back to the first roll enables them again).
 */
function LocalGame() {
  const artwork = useDownloadedArtwork(ARTWORK_URL);
  const [home, setHome] = useState<unknown>(exampleTeams["human"]);
  const [away, setAway] = useState<unknown>(exampleTeams["orc"]);
  const [gameId, setGameId] = useState(0);
  const [playing, setPlaying] = useState(false);
  const [overtime, setOvertime] = useState(false);
  const [shop, setShop] = useState(true);
  const locked = playing ? "Finish the game first (or reload the page)" : undefined;
  return (
    <main>
      <header>
        <TeamPicker label="Home" value={home} disabled={playing} onChange={setHome} />
        <TeamPicker label="Away" value={away} disabled={playing} onChange={setAway} />
        <label title="Cup games: a draw after the second half is played on in a third half">
          <input type="checkbox" checked={overtime} disabled={playing} onChange={(e) => setOvertime(e.target.checked)} /> Overtime on a draw
        </label>
        <label title="Buy inducements before the game with petty cash and the treasury (otherwise the team files list them)">
          <input type="checkbox" checked={shop} disabled={playing} onChange={(e) => setShop(e.target.checked)} /> Pre-game shop
        </label>
        <button
          disabled={playing}
          title={locked}
          onClick={() => {
            setGameId((n) => n + 1);
            setPlaying(false);
          }}
        >
          New game
        </button>
      </header>
      <BloodBowlGame
        key={gameId}
        home={home}
        away={away}
        assetsUrl="/img"
        artwork={artwork}
        seed={gameId === 0 ? SEED : undefined}
        overtime={overtime}
        shop={shop}
        onChange={(state) => setPlaying(inProgress(state))}
      />
    </main>
  );
}
