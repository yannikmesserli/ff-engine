import { useEffect, useRef, useState } from "react";
import { FantasyFootballGame, useDownloadedArtwork } from "@ff-engine/board-ui";
import type { Action, Side } from "@ff-engine/engine";
import { exampleTeams } from "@ff-engine/data";
import type { ServerMessage } from "relay/protocol";
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

const other = (side: Side): Side => (side === "home" ? "away" : "home");

/** What the relay tells a player. */
interface RelayHandlers {
  onWelcome(opponent: boolean): void;
  onPayload(from: Side, data: Payload): void;
  onOpponent(present: boolean): void;
}

/**
 * The relay WebSocket of a game: our side, and the messages received. `wanted` is the side to take back (from a saved
 * game). A dropped connection is opened again, asking for the same side; only a new player refused at once is told the
 * game is full.
 */
function useRelay(gameId: string, wanted: Side | undefined, handlers: RelayHandlers) {
  const [connection, setConnection] = useState<Connection>("connecting");
  const [side, setSide] = useState<Side | null>(null);
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
      const ws = new WebSocket(`${protocol}://${location.host}/relay?game=${gameId}${mySide ? `&side=${mySide}` : ""}`);
      socket.current = ws;
      let welcomed = false;
      ws.onmessage = (event) => {
        const message = JSON.parse(String(event.data)) as ServerMessage;
        if (message.type === "welcome") {
          welcomed = true;
          retries = 0;
          mySide = message.side;
          setSide(message.side);
          setConnection("open");
          current.current.onWelcome(message.opponent);
        } else if (message.type === "opponent") current.current.onOpponent(message.present);
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

  const send = (data: Payload) => {
    if (socket.current?.readyState === WebSocket.OPEN) socket.current.send(JSON.stringify({ type: "relay", data }));
  };
  return { connection, side, send };
}

/** The link the second player opens. */
const inviteUrl = (gameId: string) => `${location.origin}${location.pathname}?game=${gameId}`;

/** An online game as saved in the tab: our side, the team picked, the lobby and every batch played. */
interface SavedOnlineGame extends Snapshot {
  side: Side | null;
  team: unknown;
}

/**
 * An online game through the relay: the first player in is home, the second away. Both pick a team; once both are
 * ready the game starts with home's seed, and every action goes through the relay. The game is saved in the tab
 * (`saved.ts`): after a reload, or when the connection drops, the player comes back to their side, and both browsers
 * catch up with each other (`sync.ts`). After each (re)connection the board is paused until the opponent's snapshot
 * has arrived, so that it never plays from a position the opponent has already left.
 */
export function OnlineGame({ gameId }: { gameId: string }) {
  const key = `ff-online-${gameId}`;
  const [saved] = useState(() => load<SavedOnlineGame>(key));
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
  /** We have the opponent's snapshot since our last (re)connection: we are in step and may take decisions. */
  const [synced, setSynced] = useState(false);
  const [assemble] = useState(snapshotAssembler);

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
    if (reply) sendSync();
  };

  const relay = useRelay(gameId, saved?.side ?? undefined, {
    onWelcome: (present) => {
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
        if (missing) sendSync();
      } else if (data?.kind === "sync" && from !== relay.side && typeof data.id === "string" && typeof data.data === "string") {
        const text = assemble(data.id, data.index, data.count, data.data);
        if (text !== null) receiveSnapshot(from, text);
      }
    },
    onOpponent: (present) => {
      setOpponent(present);
      if (present) sendSync();
      // Before the game, the opponent may come back and pick again; during the game, it waits for them.
      else if (!started) update((g) => ({ ...g, ready: relay.side ? { [relay.side]: g.ready[relay.side] } : {} }));
    },
  });
  const side = relay.side ?? saved?.side ?? null;

  useEffect(() => save(key, { side, team, ...view } satisfies SavedOnlineGame), [key, side, team, view]);

  if (relay.connection === "full") return <p>This game already has two players, or the relay is not running. <a href="?">Start a new game</a></p>;
  if (!side) return <p>Connecting to the relay…</p>;
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

  if (started) {
    return (
      <>
        {status && <p className="pg-error">{status}</p>}
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

/** A short random game id for the invite link. */
export const newGameId = () => Array.from(crypto.getRandomValues(new Uint8Array(6)), (b) => (b % 36).toString(36)).join("");
