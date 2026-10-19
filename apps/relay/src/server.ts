import type { IncomingMessage, Server } from "node:http";
import { WebSocketServer, type WebSocket } from "ws";
import { GAME_ID, SIDES, type ClientMessage, type ServerMessage, type Side } from "./protocol.ts";

/** Biggest message accepted: a team file is a few KB. */
const MAX_MESSAGE_BYTES = 256 * 1024;
/** Dead connections are dropped after missing a ping. */
const PING_INTERVAL_MS = 30_000;

/** The players of one game, by side (null while the handshake is in progress). Nothing else is kept. */
type Room = Map<Side, WebSocket | null>;

const send = (socket: WebSocket | null | undefined, message: ServerMessage) => socket?.send(JSON.stringify(message));

/** The game id of a `/relay?game=<id>` request (null for any other request), and the side asked for, if any. */
function parse(request: IncomingMessage): { id: string | null; wanted: Side | undefined } {
  const url = new URL(request.url ?? "", "http://relay");
  const id = url.searchParams.get("game");
  const wanted = SIDES.find((s) => s === url.searchParams.get("side"));
  return { id: url.pathname === "/relay" && id && GAME_ID.test(id) ? id : null, wanted };
}

/**
 * Relay WebSockets on `/relay?game=<id>`: up to two players per game (first home, then away; `&side=` asks for a side,
 * to come back to it after a reload). Every message from a player goes to both players in the order received, so both
 * apply the same sequence. Nothing is stored: a game disappears when its players leave, and players who come back
 * catch up from each other.
 */
export function attachRelay(server: Server) {
  const rooms = new Map<string, Room>();
  const alive = new WeakSet<WebSocket>();
  const wss = new WebSocketServer({ noServer: true, maxPayload: MAX_MESSAGE_BYTES });

  server.on("upgrade", (request, socket, head) => {
    const { id, wanted } = parse(request);
    const room = id ? (rooms.get(id) ?? new Map<Side, WebSocket | null>()) : null;
    const side = room ? (wanted ? [wanted] : SIDES).find((s) => !room.has(s)) : undefined;
    if (!id || !room || !side) {
      // Unknown path, bad id, a game that already has two players, or a side asked for that is taken.
      socket.end(`HTTP/1.1 ${id ? "409 Conflict" : "400 Bad Request"}\r\n\r\n`);
      return;
    }
    // Reserve the side before the handshake, so that two players joining at once get different sides.
    rooms.set(id, room);
    room.set(side, null);
    socket.on("close", () => {
      if (room.get(side) !== null) return;
      room.delete(side);
      if (room.size === 0) rooms.delete(id);
    });
    wss.handleUpgrade(request, socket, head, (ws) => {
      room.set(side, ws);
      alive.add(ws);
      const opponent = room.get(side === "home" ? "away" : "home");
      send(ws, { type: "welcome", side, opponent: Boolean(opponent) });
      if (opponent) send(opponent, { type: "opponent", present: true });

      ws.on("pong", () => alive.add(ws));
      ws.on("message", (raw) => {
        let message: ClientMessage;
        try {
          message = JSON.parse(raw.toString());
        } catch {
          return;
        }
        if (message?.type !== "relay") return;
        for (const player of room.values()) send(player, { type: "relay", from: side, data: message.data });
      });
      ws.on("close", () => {
        room.delete(side);
        if (room.size === 0) rooms.delete(id);
        for (const player of room.values()) send(player, { type: "opponent", present: false });
      });
    });
  });

  const ping = setInterval(() => {
    for (const ws of wss.clients) {
      if (!alive.has(ws)) ws.terminate();
      else {
        alive.delete(ws);
        ws.ping();
      }
    }
  }, PING_INTERVAL_MS);
  server.on("close", () => clearInterval(ping));
  return { rooms };
}
