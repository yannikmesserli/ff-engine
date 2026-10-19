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
async function join(port: number, game: string, side?: string) {
  const ws = new WebSocket(`ws://localhost:${port}/relay?game=${game}${side ? `&side=${side}` : ""}`);
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
    expect(home.received).toEqual([{ type: "welcome", side: "home", opponent: false }]);
    const away = await join(port, "abcd");
    await settle();
    expect(away.received).toEqual([{ type: "welcome", side: "away", opponent: true }]);
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
    expect(away.received).toEqual([{ type: "welcome", side: "away", opponent: false }]);
    await expect(join(port, "game3", "away")).rejects.toThrow(/409/);
    const back = await join(port, "game3", "home");
    expect(back.received).toEqual([{ type: "welcome", side: "home", opponent: true }]);
  });

  it("rejects bad game ids", async () => {
    const port = await start();
    await expect(join(port, "NO!")).rejects.toThrow(/400/);
  });
});
