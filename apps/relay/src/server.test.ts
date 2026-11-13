import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { afterEach, describe, expect, it } from "vitest";
import { WebSocket } from "ws";
import type { ServerMessage } from "./protocol.ts";
import { attachRelay } from "./server.ts";

let server: Server;
let relay: ReturnType<typeof attachRelay>;
const sockets: WebSocket[] = [];

async function start() {
  server = createServer();
  relay = attachRelay(server);
  await new Promise<void>((done) => server.listen(0, done));
  return (server.address() as AddressInfo).port;
}

/** A player connected to a game, with the messages it received so far. */
async function join(port: number, game: string, side?: string, query = "") {
  const ws = new WebSocket(`ws://localhost:${port}/relay?game=${game}${side ? `&side=${side}` : ""}${query}`);
  sockets.push(ws);
  const received: ServerMessage[] = [];
  ws.on("message", (raw) => received.push(JSON.parse(raw.toString())));
  await new Promise((done, fail) => {
    ws.once("message", done);
    ws.once("error", fail);
  });
  return { ws, received };
}

const settle = () => new Promise((done) => setTimeout(done, 50));

afterEach(async () => {
  for (const ws of sockets.splice(0)) ws.close();
  await new Promise((done) => server.close(done));
});

describe("relay", () => {
  it("seats the first player home, the second away, and refuses a third", async () => {
    const port = await start();
    const home = await join(port, "abcd");
    expect(home.received).toEqual([{ type: "welcome", side: "home", opponent: false, watchers: null }]);
    const away = await join(port, "abcd");
    await settle();
    expect(away.received).toEqual([{ type: "welcome", side: "away", opponent: true, watchers: null }]);
    expect(home.received.at(-1)).toEqual({ type: "opponent", present: true });
    await expect(join(port, "abcd")).rejects.toThrow(/409/);
  });

  it("forwards every message to both players, in the same order", async () => {
    const port = await start();
    const home = await join(port, "game1");
    const away = await join(port, "game1");
    home.ws.send(JSON.stringify({ type: "relay", data: { n: 1 } }));
    away.ws.send(JSON.stringify({ type: "relay", data: { n: 2 } }));
    await settle();
    const relayed = (r: ServerMessage[]) => r.filter((m) => m.type === "relay");
    expect(relayed(home.received)).toEqual(relayed(away.received));
    expect(relayed(home.received).map((m) => m.type === "relay" && m.from).sort()).toEqual(["away", "home"]);
  });

  it("tells the remaining player when the opponent leaves, and forgets empty games", async () => {
    const port = await start();
    const home = await join(port, "game2");
    const away = await join(port, "game2");
    away.ws.close();
    await settle();
    expect(home.received.at(-1)).toEqual({ type: "opponent", present: false });
    home.ws.close();
    await settle();
    expect(relay.rooms.has("game2")).toBe(false);
  });

  it("gives a player who comes back the side they ask for", async () => {
    const port = await start();
    const home = await join(port, "game3");
    home.ws.close();
    await settle();
    // Away comes first after both reloaded: it takes away back, and home is still free.
    const away = await join(port, "game3", "away");
    expect(away.received).toEqual([{ type: "welcome", side: "away", opponent: false, watchers: null }]);
    await expect(join(port, "game3", "away")).rejects.toThrow(/409/);
    const back = await join(port, "game3", "home");
    expect(back.received).toEqual([{ type: "welcome", side: "home", opponent: true, watchers: null }]);
  });

  describe("watchers", () => {
    /** A game home opened with `&watchers=1`, both players in. */
    async function watched(port: number, game: string) {
      const home = await join(port, game, undefined, "&watchers=1");
      const away = await join(port, game);
      return { home, away };
    }

    it("seats anyone after the two players as a watcher, once home allowed it", async () => {
      const port = await start();
      const { home, away } = await watched(port, "watch1");
      expect(home.received[0]).toEqual({ type: "welcome", side: "home", opponent: false, watchers: 0 });
      expect(away.received[0]).toEqual({ type: "welcome", side: "away", opponent: true, watchers: 0 });
      const watcher = await join(port, "watch1");
      await settle();
      expect(watcher.received).toEqual([{ type: "watching", players: ["home", "away"] }]);
      expect(home.received.at(-1)).toEqual({ type: "watchers", count: 1 });
      expect(away.received.at(-1)).toEqual({ type: "watchers", count: 1 });
    });

    it("sends watchers every player message, and nothing of theirs but throttled sync requests", async () => {
      const port = await start();
      const { home, away } = await watched(port, "watch2");
      const watcher = await join(port, "watch2");
      home.ws.send(JSON.stringify({ type: "relay", data: { n: 1 } }));
      watcher.ws.send(JSON.stringify({ type: "relay", data: { n: 2 } }));
      watcher.ws.send(JSON.stringify({ type: "sync-request" }));
      watcher.ws.send(JSON.stringify({ type: "sync-request" }));
      await settle();
      expect(watcher.received.filter((m) => m.type === "relay")).toEqual([{ type: "relay", from: "home", data: { n: 1 } }]);
      expect(away.received.filter((m) => m.type === "relay")).toEqual([{ type: "relay", from: "home", data: { n: 1 } }]);
      expect(away.received.filter((m) => m.type === "sync-request")).toHaveLength(1);
      expect(home.received.filter((m) => m.type === "sync-request")).toHaveLength(1);
    });

    it("tells watchers when a player leaves; a free side still goes to a new player, a watcher who comes back watches", async () => {
      const port = await start();
      const { away } = await watched(port, "watch3");
      const watcher = await join(port, "watch3");
      away.ws.close();
      await settle();
      expect(watcher.received.at(-1)).toEqual({ type: "player", side: "away", present: false });
      expect((await join(port, "watch3", "watcher")).received).toEqual([{ type: "watching", players: ["home"] }]);
      expect((await join(port, "watch3")).received[0]).toMatchObject({ type: "welcome", side: "away" });
    });

    it("only home, the creator, can let the game be watched", async () => {
      const port = await start();
      await join(port, "watch6");
      const away = await join(port, "watch6", undefined, "&watchers=1");
      expect(away.received[0]).toEqual({ type: "welcome", side: "away", opponent: true, watchers: null });
      await expect(join(port, "watch6")).rejects.toThrow(/409/);
    });

    it("refuses a third person when home did not allow watchers", async () => {
      const port = await start();
      await join(port, "watch4");
      await join(port, "watch4");
      await expect(join(port, "watch4")).rejects.toThrow(/409/);
      await expect(join(port, "watch4", "watcher")).rejects.toThrow(/409/);
    });

    it("tells the opponent when a player who comes back allows watchers", async () => {
      const port = await start();
      const away = await join(port, "watch5", "away");
      expect(away.received[0]).toEqual({ type: "welcome", side: "away", opponent: false, watchers: null });
      await join(port, "watch5", "home", "&watchers=1");
      await settle();
      expect(away.received.slice(1)).toEqual([{ type: "opponent", present: true }, { type: "watchers", count: 0 }]);
    });
  });

  it("rejects bad game ids", async () => {
    const port = await start();
    await expect(join(port, "NO!")).rejects.toThrow(/400/);
  });
});
