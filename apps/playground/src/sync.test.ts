import { describe, expect, it } from "vitest";
import type { Action } from "@ff-engine/engine";
import { type Snapshot, SYNC_CHUNK_CHARS, chunk, mergeLobby, receiveBatch, reconcile, reconcileSnapshot, snapshotAssembler } from "./sync";

const batch = (n: number): Action[] => [{ type: "ROLL", values: [n] }];
const list = (...ns: number[]) => ns.map(batch);

describe("receiveBatch", () => {
  it("appends the next batch", () => {
    expect(receiveBatch(list(1, 2), batch(3), 2)).toEqual({ batches: list(1, 2, 3), missing: false });
  });

  it("drops a batch already applied, or sent at the same time as the one the relay passed first", () => {
    const mine = list(1, 2);
    expect(receiveBatch(mine, batch(9), 1)).toEqual({ batches: mine, missing: false });
  });

  it("asks for a sync when batches were missed", () => {
    const mine = list(1);
    expect(receiveBatch(mine, batch(3), 2)).toEqual({ batches: mine, missing: true });
  });
});

describe("reconcile", () => {
  it("adopts the opponent's longer list, keeping the batches already applied", () => {
    const mine = list(1, 2);
    const { batches, reply } = reconcile(mine, list(1, 2, 3, 4), "away");
    expect(batches).toEqual(list(1, 2, 3, 4));
    expect(batches[0]).toBe(mine[0]);
    expect(reply).toBe(false);
  });

  it("answers an opponent who is behind", () => {
    const mine = list(1, 2, 3);
    expect(reconcile(mine, list(1), "home")).toEqual({ batches: mine, reply: true });
  });

  it("changes nothing when both agree", () => {
    expect(reconcile(list(1, 2), list(1, 2), "home")).toEqual({ batches: list(1, 2), reply: false });
  });

  it("resolves lists that disagree to the longer one, then to home's, never dropping batches for a shorter list", () => {
    expect(reconcile(list(1, 2), list(1, 3), "home")).toEqual({ batches: list(1, 3), reply: false });
    expect(reconcile(list(1, 2), list(1, 3), "away")).toEqual({ batches: list(1, 2), reply: true });
    expect(reconcile(list(1, 2, 4, 5), list(1, 3), "home")).toEqual({ batches: list(1, 2, 4, 5), reply: true });
  });

  it("brings two browsers that missed different things back in step", () => {
    // Away reloaded while home played batches 2 and 3: both send a sync when they see each other again.
    let home = list(1, 2, 3);
    let away = list(1);
    const fromHome = reconcile(away, home, "home");
    away = fromHome.batches;
    const fromAway = reconcile(home, list(1), "away");
    home = fromAway.batches;
    expect(away).toEqual(home);
    expect(fromHome.reply).toBe(false);
    // Home answers away's (older) sync again; away now has everything and changes nothing.
    expect(reconcile(away, home, "home")).toEqual({ batches: home, reply: false });
  });
});

describe("mergeLobby", () => {
  it("fills in teams and home's seed that we lost, and keeps ours", () => {
    const merged = mergeLobby({ ready: { away: "orcs" }, seed: null, shop: true }, { ready: { home: "humans", away: "elves" }, seed: 42, shop: false });
    expect(merged).toEqual({ ready: { home: "humans", away: "orcs" }, seed: 42, shop: false });
  });

  it("keeps our seed and shop option once we have them", () => {
    expect(mergeLobby({ ready: {}, seed: 1, shop: true }, { ready: {}, seed: 2, shop: false })).toEqual({ ready: {}, seed: 1, shop: true });
  });
});

describe("reconcileSnapshot", () => {
  const game = (seed: number, ...ns: number[]): Snapshot => ({ ready: { home: "humans", away: "orcs" }, seed, shop: false, batches: list(...ns) });

  it("settles a game both have on the longer list of batches", () => {
    expect(reconcileSnapshot(game(7, 1), game(7, 1, 2), "home")).toEqual({ snapshot: game(7, 1, 2), reply: false });
    expect(reconcileSnapshot(game(7, 1, 2), game(7, 1), "away")).toEqual({ snapshot: game(7, 1, 2), reply: true });
  });

  it("keeps a started game over a lobby picked again after losing the tab", () => {
    // Home lost its tab and pressed Ready again (a new seed) while away was away: away's game wins, whole.
    const lobby: Snapshot = { ready: { home: "elves" }, seed: 99, shop: true, batches: [] };
    expect(reconcileSnapshot(lobby, game(7, 1, 2), "away")).toEqual({ snapshot: game(7, 1, 2), reply: false });
    expect(reconcileSnapshot(game(7, 1, 2), lobby, "home")).toEqual({ snapshot: game(7, 1, 2), reply: true });
  });

  it("never mixes the settings of two different games", () => {
    expect(reconcileSnapshot(game(1, 1), game(2, 1, 2), "away")).toEqual({ snapshot: game(2, 1, 2), reply: false });
    expect(reconcileSnapshot(game(1, 1, 2), game(2, 1), "home")).toEqual({ snapshot: game(1, 1, 2), reply: true });
    // Same length: home's game.
    expect(reconcileSnapshot(game(1, 1), game(2, 1), "home").snapshot).toEqual(game(2, 1));
    expect(reconcileSnapshot(game(1, 1), game(2, 1), "away").snapshot).toEqual(game(1, 1));
  });

  it("merges two lobbies", () => {
    const home: Snapshot = { ready: { home: "humans" }, seed: 7, shop: false, batches: [] };
    const away: Snapshot = { ready: { away: "orcs" }, seed: null, shop: true, batches: [] };
    expect(reconcileSnapshot(away, home, "home").snapshot).toEqual(game(7));
  });
});

describe("snapshot chunks", () => {
  it("cuts a big snapshot into chunks the relay accepts and puts it back together", () => {
    const text = JSON.stringify(bigGame(2.5 * SYNC_CHUNK_CHARS));
    const parts = chunk(text);
    expect(parts.length).toBe(3);
    expect(parts.every((p) => p.length <= SYNC_CHUNK_CHARS)).toBe(true);
    const assemble = snapshotAssembler();
    expect(assemble("a", 0, 3, parts[0]!)).toBeNull();
    expect(assemble("a", 2, 3, parts[2]!)).toBeNull();
    expect(assemble("a", 1, 3, parts[1]!)).toBe(text);
  });

  it("drops an unfinished snapshot when a newer one starts", () => {
    const assemble = snapshotAssembler();
    expect(assemble("old", 0, 2, "ab")).toBeNull();
    expect(assemble("new", 0, 1, "xyz")).toBe("xyz");
  });

  it("sends an empty text as one chunk", () => {
    expect(chunk("")).toEqual([""]);
  });
});

/** A started game whose snapshot JSON is about `chars` characters long. */
function bigGame(chars: number): Snapshot {
  const batches = Array.from({ length: Math.ceil(chars / 30) }, (_, i) => batch(i));
  return { ready: { home: "humans", away: "orcs" }, seed: 1, shop: false, batches };
}
