import type { IncomingMessage, Server } from "node:http";
import { WebSocketServer, type WebSocket } from "ws";
import { GAME_ID, SIDES, type ClientMessage, type ServerMessage, type Side } from "./protocol.ts";

/** Biggest message accepted: a team file is a few KB. */
const MAX_MESSAGE_BYTES = 256 * 1024;
/** Dead connections are dropped after missing a ping. */
const PING_INTERVAL_MS = 30_000;
/** A watcher's sync requests reach the players at most this often. */
const SYNC_REQUEST_INTERVAL_MS = 1000;

/**
 * One game: its players by side (null while the handshake is in progress), its watchers, and whether a player let it
 * be watched. Nothing else is kept.
 */
interface Room {
  players: Map<Side, WebSocket | null>;
  watchers: Set<WebSocket>;
  watchable: boolean;
}

const send = (socket: WebSocket | null | undefined, message: ServerMessage) => socket?.send(JSON.stringify(message));

/** The game id of a `/relay?game=<id>` request (null for any other request), the seat asked for, and `&watchers=1`. */
function parse(request: IncomingMessage): { id: string | null; wanted: Side | "watcher" | undefined; watchable: boolean } {
  const url = new URL(request.url ?? "", "http://relay");
  const id = url.searchParams.get("game");
  const side = url.searchParams.get("side");
  const wanted = side === "watcher" ? "watcher" : SIDES.find((s) => s === side);
  return { id: url.pathname === "/relay" && id && GAME_ID.test(id) ? id : null, wanted, watchable: url.searchParams.get("watchers") === "1" };
}

/**
 * Relay WebSockets on `/relay?game=<id>`: up to two players per game (first home, then away; `&side=` asks for a side,
 * to come back to it after a reload). Every message from a player goes to both players in the order received, so both
 * apply the same sequence. Once home (the creator) connected with `&watchers=1`, anyone else who opens the game while both sides
 * are taken (or asks for `&side=watcher`) watches: they get every player message too, and may ask the players for a
 * snapshot to catch up. Nothing is stored: a game disappears when everyone leaves, and players who come back catch up
 * from each other.
 */
export function attachRelay(server: Server) {
  const rooms = new Map<string, Room>();
  const alive = new WeakSet<WebSocket>();
  const wss = new WebSocketServer({ noServer: true, maxPayload: MAX_MESSAGE_BYTES });

  const forget = (id: string, room: Room) => {
    if (room.players.size === 0 && room.watchers.size === 0) rooms.delete(id);
  };
  const toPlayers = (room: Room, message: ServerMessage) => {
    for (const player of room.players.values()) send(player, message);
  };
  const toWatchers = (room: Room, message: ServerMessage) => {
    for (const watcher of room.watchers) send(watcher, message);
  };
  const connected = (room: Room) => SIDES.filter((s) => room.players.get(s));

  server.on("upgrade", (request, socket, head) => {
    const { id, wanted, watchable } = parse(request);
    const room = id ? (rooms.get(id) ?? { players: new Map(), watchers: new Set<WebSocket>(), watchable: false }) : null;
    const side = room && wanted !== "watcher" ? (wanted ? [wanted] : SIDES).find((s) => !room.players.has(s)) : undefined;
    // A watcher: asked for, or nobody asked for a side and both are taken, in a game that may be watched.
    const watcher = room?.watchable === true && !side && (wanted === "watcher" || wanted === undefined);
    if (!id || !room || (!side && !watcher)) {
      // Unknown path, bad id, a game that already has two players (and no watchers), or a side asked for that is taken.
      socket.end(`HTTP/1.1 ${id ? "409 Conflict" : "400 Bad Request"}\r\n\r\n`);
      return;
    }
    rooms.set(id, room);
    if (watcher) {
      wss.handleUpgrade(request, socket, head, (ws) => {
        room.watchers.add(ws);
        alive.add(ws);
        send(ws, { type: "watching", players: connected(room) });
        toPlayers(room, { type: "watchers", count: room.watchers.size });
        let lastRequest = 0;
        ws.on("pong", () => alive.add(ws));
        ws.on("message", (raw) => {
          let message: ClientMessage;
          try {
            message = JSON.parse(raw.toString());
          } catch {
            return;
          }
          if (message?.type !== "sync-request" || Date.now() - lastRequest < SYNC_REQUEST_INTERVAL_MS) return;
          lastRequest = Date.now();
          toPlayers(room, { type: "sync-request" });
        });
        ws.on("close", () => {
          room.watchers.delete(ws);
          forget(id, room);
          toPlayers(room, { type: "watchers", count: room.watchers.size });
        });
      });
      return;
    }
    const seat = side!;
    // Reserve the side before the handshake, so that two players joining at once get different sides.
    room.players.set(seat, null);
    socket.on("close", () => {
      if (room.players.get(seat) !== null) return;
      room.players.delete(seat);
      forget(id, room);
    });
    wss.handleUpgrade(request, socket, head, (ws) => {
      room.players.set(seat, ws);
      alive.add(ws);
      // Only the creator (home) chooses to let the game be watched, again after each reconnection.
      const opening = watchable && seat === "home" && !room.watchable;
      if (opening) room.watchable = true;
      const opponent = room.players.get(seat === "home" ? "away" : "home");
      send(ws, { type: "welcome", side: seat, opponent: Boolean(opponent), watchers: room.watchable ? room.watchers.size : null });
      if (opponent) {
        send(opponent, { type: "opponent", present: true });
        if (opening) send(opponent, { type: "watchers", count: room.watchers.size });
      }
      toWatchers(room, { type: "player", side: seat, present: true });

      ws.on("pong", () => alive.add(ws));
      ws.on("message", (raw) => {
        let message: ClientMessage;
        try {
          message = JSON.parse(raw.toString());
        } catch {
          return;
        }
        if (message?.type !== "relay") return;
        const relayed: ServerMessage = { type: "relay", from: seat, data: message.data };
        toPlayers(room, relayed);
        toWatchers(room, relayed);
      });
      ws.on("close", () => {
        room.players.delete(seat);
        forget(id, room);
        toPlayers(room, { type: "opponent", present: false });
        toWatchers(room, { type: "player", side: seat, present: false });
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
