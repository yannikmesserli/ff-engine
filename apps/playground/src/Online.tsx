import { useEffect, useRef, useState } from "react";
import { FantasyFootballGame, useDownloadedArtwork } from "@ff-engine/board-ui";
import type { Action, Side } from "@ff-engine/engine";
import { exampleTeams } from "@ff-engine/data";
import type { ClientMessage, ServerMessage } from "relay/protocol";
import { TeamPicker, teamError } from "./TeamPicker";
import { ARTWORK_URL } from "./artwork";
import { load, randomSeed, save } from "./saved";
import { type Snapshot, chunk, receiveBatch, reconcileSnapshot, snapshotAssembler, started as isStarted } from "./sync";

/** What the players send each other through the relay. */
type Payload =
  /** A player is ready with this team; home also picks the dice seed both browsers use, and the pre-game shop. */
  | { kind: "team"; team: unknown; seed?: number; shop?: boolean }
  /** Actions taken in the game, applied by both browsers in the relay's order; `at` is their position in the game. */
  | { kind: "actions"; actions: Action[]; at: number }
  /**
   * One chunk (`index` of `count`) of the JSON of everything the sender knows (a `Snapshot`), sent when the opponent
   * (re)connects or is behind (see `sync.ts`). `id` tells the chunks of one snapshot from the next.
   */
  | { kind: "sync"; id: string; index: number; count: number; data: string };

/** "reconnecting": the connection dropped (or the page was reloaded) and is being opened again. */
type Connection = "connecting" | "open" | "reconnecting" | "full";

/** Waits between reconnection attempts grow up to this. */
const MAX_RETRY_MS = 8000;

/** A watcher asks the players for a snapshot at most this often (the relay drops requests sent faster). */
const SYNC_REQUEST_MS = 1500;

const other = (side: Side): Side => (side === "home" ? "away" : "home");

/** Where a browser sits in a game: a side, or watching (only possible in a game a player allowed watchers in). */
type Seat = Side | "watcher";

/** What the relay tells a player or a watcher. */
interface RelayHandlers {
  /** A player is in: whether the opponent is there, and how many watch (null: the game may not be watched). */
  onWelcome(opponent: boolean, watchers: number | null): void;
  onPayload(from: Side, data: Payload): void;
  onOpponent(present: boolean): void;
  onWatchers(count: number): void;
  /** A watcher asks the players for everything they know. */
  onSyncRequest(): void;
  /** A watcher is in, and these players are there. */
  onWatching(players: Side[]): void;
  /** For a watcher: a player connected or left. */
  onPlayer(side: Side, present: boolean): void;
}

/**
 * The relay WebSocket of a game: our seat, and the messages received. `wanted` is the seat to take back (from a saved
 * game); `watchable` lets the game be watched (the creator's choice). A dropped connection is opened again, asking
 * for the same seat; only a newcomer refused at once is told the game is full.
 */
function useRelay(gameId: string, wanted: Seat | undefined, watchable: boolean, handlers: RelayHandlers) {
  const [connection, setConnection] = useState<Connection>("connecting");
  const [side, setSide] = useState<Seat | null>(null);
  const socket = useRef<WebSocket | null>(null);
  // The latest handlers, so that the socket is opened once per game.
  const current = useRef(handlers);
  current.current = handlers;

  // biome-ignore lint/correctness/useExhaustiveDependencies: one socket per game; `wanted` only matters for the first connection.
  useEffect(() => {
    const protocol = location.protocol === "https:" ? "wss" : "ws";
    let mySide = wanted;
    let stopped = false;
    let retries = 0;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const connect = () => {
      const ws = new WebSocket(`${protocol}://${location.host}/relay?game=${gameId}${mySide ? `&side=${mySide}` : ""}${watchable ? "&watchers=1" : ""}`);
      socket.current = ws;
      let welcomed = false;
      ws.onmessage = (event) => {
        const message = JSON.parse(String(event.data)) as ServerMessage;
        if (message.type === "welcome" || message.type === "watching") {
          welcomed = true;
          retries = 0;
          mySide = message.type === "welcome" ? message.side : "watcher";
          setSide(mySide);
          setConnection("open");
          if (message.type === "welcome") current.current.onWelcome(message.opponent, message.watchers);
          else current.current.onWatching(message.players);
        } else if (message.type === "opponent") current.current.onOpponent(message.present);
        else if (message.type === "watchers") current.current.onWatchers(message.count);
        else if (message.type === "sync-request") current.current.onSyncRequest();
        else if (message.type === "player") current.current.onPlayer(message.side, message.present);
        else current.current.onPayload(message.from, message.data as Payload);
      };
      ws.onclose = () => {
        if (stopped) return;
        // Refused before any welcome (the game already has two players, or the relay is not running).
        if (!welcomed && !mySide) {
          setConnection("full");
          return;
        }
        setConnection("reconnecting");
        timer = setTimeout(connect, Math.min(500 * 2 ** retries++, MAX_RETRY_MS));
      };
    };
    connect();
    return () => {
      stopped = true;
      clearTimeout(timer);
      socket.current?.close();
    };
  }, [gameId]);

  const raw = (message: ClientMessage) => {
    if (socket.current?.readyState === WebSocket.OPEN) socket.current.send(JSON.stringify(message));
  };
  const send = (data: Payload) => raw({ type: "relay", data });
  const requestSync = () => raw({ type: "sync-request" });
  return { connection, side, send, requestSync };
}

/** The link the second player opens. */
const inviteUrl = (gameId: string) => `${location.origin}${location.pathname}?game=${gameId}`;

/** An online game as saved in the tab: our seat, the team picked, whether we let it be watched, the lobby and every batch played. */
interface SavedOnlineGame extends Snapshot {
  side: Seat | null;
  team: unknown;
  watchable?: boolean;
}

/**
 * An online game through the relay: the first player in is home, the second away. Both pick a team; once both are
 * ready the game starts with home's seed, and every action goes through the relay. The game is saved in the tab
 * (`saved.ts`): after a reload, or when the connection drops, the player comes back to their side, and both browsers
 * catch up with each other (`sync.ts`). After each (re)connection the board is paused until the opponent's snapshot
 * has arrived, so that it never plays from a position the opponent has already left.
 *
 * `watchable` (the creator's choice, kept in the saved game) lets anyone who opens the link after both players watch:
 * they get every message, ask the players for a snapshot to catch up (again whenever they see a batch missing), and
 * see the board live without taking any decision.
 */
export function OnlineGame({ gameId, watchable: allow = false }: { gameId: string; watchable?: boolean }) {
  const key = `ff-online-${gameId}`;
  const [saved] = useState(() => load<SavedOnlineGame>(key));
  const watchable = allow || saved?.watchable === true;
  /** How many watch (null: the game may not be watched). */
  const [watchers, setWatchers] = useState<number | null>(null);
  /** For a watcher: the players connected. */
  const [players, setPlayers] = useState<Side[]>([]);
  const lastRequest = useRef(0);
  /** A sync request waiting for the end of the throttle window. */
  const pendingRequest = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  useEffect(() => () => clearTimeout(pendingRequest.current), []);
  const artwork = useDownloadedArtwork(ARTWORK_URL);
  const [team, setTeam] = useState<unknown>(saved?.team ?? exampleTeams["human"]);
  const [shopOption, setShopOption] = useState(saved?.shop ?? true);
  const [opponent, setOpponent] = useState(false);
  // The lobby and the batches change from relay messages that may arrive between two renders: the ref is the truth,
  // the state a copy to render.
  const initial: Snapshot = { ready: saved?.ready ?? {}, seed: saved?.seed ?? null, shop: saved?.shop ?? true, batches: saved?.batches ?? [] };
  const game = useRef(initial);
  const [view, setView] = useState(initial);
  const update = (change: (g: Snapshot) => Snapshot) => {
    game.current = change(game.current);
    setView(game.current);
  };
  const started = isStarted(view);
  /**
   * We have the opponent's snapshot since our last (re)connection: we are in step and may take decisions. For a
   * watcher: a player's snapshot arrived, so there is a game to show.
   */
  const [synced, setSynced] = useState(false);
  // One per player: a watcher may get both players' snapshots at once.
  const [assemblers] = useState(() => ({ home: snapshotAssembler(), away: snapshotAssembler() }));
  const watching = () => relay.side === "watcher";
  /**
   * A watcher asks the players for a snapshot, not more often than the relay passes on: a request too soon after the
   * last one is sent at the end of the window (once), so it is never lost.
   */
  const requestSync = () => {
    if (pendingRequest.current !== undefined) return;
    const wait = lastRequest.current + SYNC_REQUEST_MS - Date.now();
    const send = () => {
      pendingRequest.current = undefined;
      lastRequest.current = Date.now();
      relay.requestSync();
    };
    if (wait <= 0) send();
    else pendingRequest.current = setTimeout(send, wait);
  };

  /** Sends everything we know, in chunks small enough for the relay. */
  const sendSync = () => {
    const id = Math.random().toString(36).slice(2);
    const parts = chunk(JSON.stringify(game.current));
    parts.forEach((data, index) => relay.send({ kind: "sync", id, index, count: parts.length, data }));
  };
  /** The opponent's whole snapshot: settle on one snapshot with them (see `reconcileSnapshot`). */
  const receiveSnapshot = (from: Side, text: string) => {
    let theirs: Snapshot;
    try {
      theirs = JSON.parse(text);
    } catch {
      return;
    }
    if (!Array.isArray(theirs?.batches) || typeof theirs.ready !== "object" || theirs.ready === null) return;
    const { snapshot, reply } = reconcileSnapshot(game.current, theirs, from);
    update(() => snapshot);
    setSynced(true);
    // A watcher only listens: it takes the snapshot the players settle on.
    if (reply && !watching()) sendSync();
  };

  const relay = useRelay(gameId, saved?.side ?? undefined, watchable, {
    onWelcome: (present, count) => {
      setWatchers(count);
      setOpponent(present);
      // Until the opponent's snapshot arrives, they may have played on without us.
      setSynced(false);
      if (present) sendSync();
    },
    onPayload: (from, data) => {
      // A started game keeps the teams, seed and options it was created with.
      if (data?.kind === "team" && !isStarted(game.current)) {
        update((g) => ({
          ...g,
          ready: { ...g.ready, [from]: data.team },
          ...(from === "home" && typeof data.seed === "number" ? { seed: data.seed, shop: data.shop === true } : {}),
        }));
      } else if (data?.kind === "actions" && Array.isArray(data.actions) && typeof data.at === "number") {
        const { batches, missing } = receiveBatch(game.current.batches, data.actions, data.at);
        update((g) => ({ ...g, batches }));
        if (missing && watching()) requestSync();
        else if (missing) sendSync();
      } else if (data?.kind === "sync" && from !== relay.side && (from === "home" || from === "away") && typeof data.id === "string" && typeof data.data === "string") {
        const text = assemblers[from](data.id, data.index, data.count, data.data);
        if (text !== null) receiveSnapshot(from, text);
      }
    },
    onWatchers: setWatchers,
    onSyncRequest: () => sendSync(),
    onWatching: (present) => {
      setPlayers(present);
      setSynced(false);
      // The lobby may have changed while we were away (a player picked another team): only the players' snapshots
      // tell. A started game is kept: its batches are still the game's.
      if (!isStarted(game.current)) update(() => ({ ready: {}, seed: null, shop: true, batches: [] }));
      // A new connection: the relay's throttle starts over.
      clearTimeout(pendingRequest.current);
      pendingRequest.current = undefined;
      lastRequest.current = 0;
      requestSync();
    },
    onPlayer: (playerSide, present) => {
      setPlayers((ps) => (present ? [...new Set([...ps, playerSide])] : ps.filter((p) => p !== playerSide)));
      // Before the game, a player who left may come back and pick another team (the players drop it too).
      if (!present && !isStarted(game.current)) update((g) => ({ ...g, ready: Object.fromEntries(Object.entries(g.ready).filter(([s]) => s !== playerSide)) }));
      // A player who comes back may know more than the one who stayed (or be the only one there now).
      if (present) requestSync();
    },
    onOpponent: (present) => {
      setOpponent(present);
      if (present) sendSync();
      // Before the game, the opponent may come back and pick again; during the game, it waits for them.
      else if (!started) {
        const mine = relay.side === "home" || relay.side === "away" ? relay.side : null;
        update((g) => ({ ...g, ready: mine ? { [mine]: g.ready[mine] } : {} }));
      }
    },
  });
  const side = relay.side ?? saved?.side ?? null;

  useEffect(() => save(key, { side, team, watchable, ...view } satisfies SavedOnlineGame), [key, side, team, watchable, view]);

  if (relay.connection === "full") {
    return <p>This game already has two players and does not allow watchers, or the relay is not running. <a href="?">Start a new game</a></p>;
  }
  if (!side) return <p>Connecting to the relay…</p>;
  if (side === "watcher") return <WatchGame connection={relay.connection} players={players} synced={synced} view={view} artwork={artwork} />;
  const paused = relay.connection !== "open" || !synced;
  const status =
    relay.connection === "reconnecting"
      ? "Lost the connection to the relay, reconnecting…"
      : relay.connection === "connecting"
        ? "Connecting to the relay…"
        : started && !opponent && !synced
          ? "Your opponent is disconnected: the game resumes once they are back and you have caught up with each other."
          : started && !opponent
            ? "Your opponent is disconnected: waiting for them to come back."
            : started && !synced
              ? "Catching up with your opponent…"
              : null;

  const watched = watchers === null ? null : <p className="pg-watchers">Watchers allowed: {watchers === 0 ? "nobody is watching" : `${watchers} watching`}.</p>;

  if (started) {
    return (
      <>
        {status && <p className="pg-error">{status}</p>}
        {watched}
        <FantasyFootballGame
          home={view.ready.home}
          away={view.ready.away}
          seed={view.seed ?? undefined}
          shop={view.shop}
          assetsUrl="/img"
          artwork={artwork}
          online={{ side, paused, actions: view.batches, send: (actions) => relay.send({ kind: "actions", actions, at: game.current.batches.length }) }}
        />
      </>
    );
  }

  const error = teamError(team);
  const imReady = view.ready[side] !== undefined;
  const sendTeam = () => relay.send(side === "home" ? { kind: "team", team, seed: randomSeed(), shop: shopOption } : { kind: "team", team });
  const theirs = view.ready[other(side)];
  return (
    <section className="pg-lobby">
      {status && <p className="pg-error">{status}</p>}
      {watched}
      <p>
        You play <strong>{side}</strong>.{" "}
        {opponent ? (theirs ? `Your opponent is ready (${(theirs as { name?: string }).name ?? "custom team"}).` : "Your opponent is choosing a team.") : "Waiting for your opponent to join."}
      </p>
      {side === "home" && (
        <p className="pg-invite">
          Send this link to your opponent: <code>{inviteUrl(gameId)}</code>{" "}
          <button onClick={() => navigator.clipboard.writeText(inviteUrl(gameId))}>Copy</button>
        </p>
      )}
      <TeamPicker label="Your team" value={team} disabled={imReady} onChange={setTeam} />
      {side === "home" && (
        <label title="Buy inducements before the game with petty cash and the treasury (otherwise the team files list them)">
          <input type="checkbox" checked={shopOption} disabled={imReady} onChange={(e) => setShopOption(e.target.checked)} /> Pre-game shop
        </label>
      )}
      {error && <div className="pg-error">{error}</div>}
      <button className="pg-primary" disabled={imReady || error !== null || relay.connection !== "open"} onClick={sendTeam}>
        {imReady ? "Ready, waiting for the opponent…" : "Ready"}
      </button>
    </section>
  );
}

/** What a watcher sees: who is there and ready before the kick-off, then the game live, without any decision. */
function WatchGame(props: { connection: Connection; players: Side[]; synced: boolean; view: Snapshot; artwork: ReturnType<typeof useDownloadedArtwork> }) {
  const { connection, players, synced, view } = props;
  const status =
    connection !== "open"
      ? "Lost the connection to the relay, reconnecting…"
      : players.length === 0
        ? "Both players are disconnected: the game goes on once they are back."
        : !synced
          ? "Catching up with the players…"
          : players.length === 1
            ? `The ${players[0] === "home" ? "away" : "home"} player is disconnected: waiting for them to come back.`
            : null;
  if (isStarted(view)) {
    return (
      <>
        <p className="pg-watchers">You are watching this game: only the players take decisions.</p>
        {status && <p className="pg-error">{status}</p>}
        <FantasyFootballGame
          home={view.ready.home}
          away={view.ready.away}
          seed={view.seed ?? undefined}
          shop={view.shop}
          assetsUrl="/img"
          artwork={props.artwork}
          online={{ side: null, paused: !synced, actions: view.batches, send: () => {} }}
        />
      </>
    );
  }
  const player = (s: Side) => {
    const team = view.ready[s] as { name?: string } | undefined;
    return !players.includes(s) ? "not connected yet" : team ? `ready (${team.name ?? "custom team"})` : "choosing a team";
  };
  return (
    <section className="pg-lobby">
      {status && <p className="pg-error">{status}</p>}
      <p>You are watching this game. It starts once both players have picked a team.</p>
      <p>
        Home: {player("home")}. Away: {player("away")}.
      </p>
    </section>
  );
}

/** A short random game id for the invite link. */
export const newGameId = () => Array.from(crypto.getRandomValues(new Uint8Array(6)), (b) => (b % 36).toString(36)).join("");
