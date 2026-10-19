import { useEffect, useState } from "react";
import { FantasyFootballGame, useDownloadedArtwork } from "@ff-engine/board-ui";
import type { Action, GameState } from "@ff-engine/engine";
import { exampleTeams } from "@ff-engine/data";
import { GAME_ID } from "relay/protocol";
import { OnlineGame, newGameId } from "./Online";
import { TeamPicker } from "./TeamPicker";
import { load, randomSeed, save } from "./saved";
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
      <h1>Fantasy Football</h1>
      <button className="pg-primary" onClick={() => (location.search = `?game=${newGameId()}`)}>
        Create an online game
      </button>
      <p>You get a link to send to your opponent; each of you then picks a team.</p>
      <a href="?local">Or play hot-seat on this computer</a>
    </main>
  );
}

/** A hot-seat game as saved: what it was created with, and every batch of actions played (`onActions`). */
interface SavedLocalGame {
  home: unknown;
  away: unknown;
  overtime: boolean;
  shop: boolean;
  seed: number;
  batches: Action[][];
}

/** Saved per URL, so that `?seed=42` and `?local` keep separate games. */
const LOCAL_KEY = `ff-local${location.search}`;

/**
 * Hot-seat: two team pickers and a "New game" button above the game; each new game gets fresh random dice. They are
 * disabled while a game is in progress (undoing back to the first roll enables them again). The game is saved in the
 * tab (see `saved.ts`): reloading the page resumes it, undo history included.
 */
function LocalGame() {
  const artwork = useDownloadedArtwork(ARTWORK_URL);
  const [saved] = useState(() => load<SavedLocalGame>(LOCAL_KEY));
  const [home, setHome] = useState<unknown>(saved?.home ?? exampleTeams["human"]);
  const [away, setAway] = useState<unknown>(saved?.away ?? exampleTeams["orc"]);
  const [seed, setSeed] = useState(saved?.seed ?? SEED ?? randomSeed());
  const [overtime, setOvertime] = useState(saved?.overtime ?? false);
  const [shop, setShop] = useState(saved?.shop ?? true);
  const [batches, setBatches] = useState<Action[][]>(saved?.batches ?? []);
  /** The saved batches, replayed by the first game only: any change of team or option starts a new game. */
  const [resume, setResume] = useState(saved?.batches);
  const [playing, setPlaying] = useState(false);
  const locked = playing ? "Finish the game first (or reload the page)" : undefined;

  useEffect(() => save(LOCAL_KEY, { home, away, overtime, shop, seed, batches } satisfies SavedLocalGame), [home, away, overtime, shop, seed, batches]);
  /** Sets a team or an option: the game starts over. */
  const restart =
    <T,>(set: (value: T) => void) =>
    (value: T) => {
      set(value);
      setResume(undefined);
      setBatches([]);
    };

  return (
    <main>
      <header>
        <TeamPicker label="Home" value={home} disabled={playing} onChange={restart(setHome)} />
        <TeamPicker label="Away" value={away} disabled={playing} onChange={restart(setAway)} />
        <label title="Cup games: a draw after the second half is played on in a third half">
          <input type="checkbox" checked={overtime} disabled={playing} onChange={(e) => restart(setOvertime)(e.target.checked)} /> Overtime on a draw
        </label>
        <label title="Buy inducements before the game with petty cash and the treasury (otherwise the team files list them)">
          <input type="checkbox" checked={shop} disabled={playing} onChange={(e) => restart(setShop)(e.target.checked)} /> Pre-game shop
        </label>
        <button
          disabled={playing}
          title={locked}
          onClick={() => {
            restart(setSeed)(randomSeed());
            setPlaying(false);
          }}
        >
          New game
        </button>
      </header>
      <FantasyFootballGame
        home={home}
        away={away}
        assetsUrl="/img"
        artwork={artwork}
        seed={seed}
        overtime={overtime}
        shop={shop}
        resume={resume}
        onActions={setBatches}
        onChange={(state) => setPlaying(inProgress(state))}
      />
    </main>
  );
}
