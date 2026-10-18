import { useEffect, useRef, useState } from "react";
import { BloodBowlGame, useDownloadedArtwork } from "@bb/board-ui";
import type { Action, Side } from "@bb/engine";
import { exampleTeams } from "@bb/data";
import type { ServerMessage } from "relay/protocol";
import { TeamPicker, teamError } from "./TeamPicker";
import { ARTWORK_URL } from "./artwork";

/** What the players send each other through the relay. */
type Payload =
  /** A player is ready with this team; home also picks the dice seed both browsers use, and the pre-game shop. */
  | { kind: "team"; team: unknown; seed?: number; shop?: boolean }
  /** Actions taken in the game, applied by both browsers in the relay's order. */
  | { kind: "actions"; actions: Action[] };

type Connection = "connecting" | "open" | "full" | "closed";

const other = (side: Side): Side => (side === "home" ? "away" : "home");

/** The relay WebSocket of a game: our side, the opponent's presence, and the messages received. */
function useRelay(gameId: string, onPayload: (from: Side, data: Payload) => void, onOpponent: (present: boolean) => void) {
  const [connection, setConnection] = useState<Connection>("connecting");
  const [side, setSide] = useState<Side | null>(null);
  const socket = useRef<WebSocket | null>(null);
  // The latest handlers, so that the socket is opened once per game.
  const handlers = useRef({ onPayload, onOpponent });
  handlers.current = { onPayload, onOpponent };

  useEffect(() => {
    const protocol = location.protocol === "https:" ? "wss" : "ws";
    const ws = new WebSocket(`${protocol}://${location.host}/relay?game=${gameId}`);
    socket.current = ws;
    let welcomed = false;
    ws.onmessage = (event) => {
      const message = JSON.parse(String(event.data)) as ServerMessage;
      if (message.type === "welcome") {
        welcomed = true;
        setSide(message.side);
        setConnection("open");
        handlers.current.onOpponent(message.opponent);
      } else if (message.type === "opponent") handlers.current.onOpponent(message.present);
      else handlers.current.onPayload(message.from, message.data as Payload);
    };
    // A refused connection (the game already has two players) closes before any welcome.
    ws.onclose = () => setConnection(welcomed ? "closed" : "full");
    return () => ws.close();
  }, [gameId]);

  const send = (data: Payload) => socket.current?.send(JSON.stringify({ type: "relay", data }));
  return { connection, side, send };
}

/** The link the second player opens. */
const inviteUrl = (gameId: string) => `${location.origin}${location.pathname}?game=${gameId}`;

/**
 * An online game through the relay: the first player in is home, the second away. Both pick a team; once both are
 * ready the game starts with home's seed, and every action goes through the relay. Nothing is saved: reloading the
 * page ends the game.
 */
export function OnlineGame({ gameId }: { gameId: string }) {
  const artwork = useDownloadedArtwork(ARTWORK_URL);
  const [team, setTeam] = useState<unknown>(exampleTeams["human"]);
  const [ready, setReady] = useState<Partial<Record<Side, unknown>>>({});
  const [seed, setSeed] = useState<number | null>(null);
  const [shop, setShop] = useState(true);
  const [batches, setBatches] = useState<Action[][]>([]);
  const [opponent, setOpponent] = useState(false);
  const [opponentLeft, setOpponentLeft] = useState(false);
  const started = ready.home !== undefined && ready.away !== undefined && seed !== null;
  const mine = useRef<Payload | null>(null);

  const relay = useRelay(
    gameId,
    (from, data) => {
      if (data?.kind === "team") {
        setReady((r) => ({ ...r, [from]: data.team }));
        if (from === "home" && typeof data.seed === "number") setSeed(data.seed);
        if (from === "home") setShop(data.shop === true);
      } else if (data?.kind === "actions" && Array.isArray(data.actions)) setBatches((b) => [...b, data.actions]);
    },
    (present) => {
      setOpponent(present);
      if (present && mine.current) relay.send(mine.current);
      if (!present) {
        // Before the game, the opponent may come back and pick again; during the game, it is over.
        if (started) setOpponentLeft(true);
        else setReady((r) => (relay.side ? { [relay.side]: r[relay.side] } : {}));
      }
    },
  );
  const { connection, side } = relay;

  if (connection === "connecting") return <p>Connecting to the relay…</p>;
  if (connection === "full") return <p>This game already has two players, or the relay is not running. <a href="?">Start a new game</a></p>;
  if (connection === "closed") return <p>Lost the connection to the relay: the game is over. <a href="?">Start a new game</a></p>;
  if (!side) return null;
  if (opponentLeft) return <p>Your opponent left: the game is over. <a href="?">Start a new game</a></p>;

  if (started) {
    return (
      <BloodBowlGame
        home={ready.home}
        away={ready.away}
        seed={seed}
        shop={shop}
        assetsUrl="/img"
        artwork={artwork}
        online={{ side, actions: batches, send: (actions) => relay.send({ kind: "actions", actions }) }}
      />
    );
  }

  const error = teamError(team);
  const imReady = ready[side] !== undefined;
  const sendTeam = () => {
    const payload: Payload = side === "home" ? { kind: "team", team, seed: Math.floor(Math.random() * 2 ** 32), shop } : { kind: "team", team };
    mine.current = payload;
    relay.send(payload);
  };
  const theirs = ready[other(side)];
  return (
    <section className="pg-lobby">
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
          <input type="checkbox" checked={shop} disabled={imReady} onChange={(e) => setShop(e.target.checked)} /> Pre-game shop
        </label>
      )}
      {error && <div className="pg-error">{error}</div>}
      <button className="pg-primary" disabled={imReady || error !== null} onClick={sendTeam}>
        {imReady ? "Ready, waiting for the opponent…" : "Ready"}
      </button>
    </section>
  );
}

/** A short random game id for the invite link. */
export const newGameId = () => Array.from(crypto.getRandomValues(new Uint8Array(6)), (b) => (b % 36).toString(36)).join("");
