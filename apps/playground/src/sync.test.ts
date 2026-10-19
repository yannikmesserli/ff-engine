import { describe, expect, it } from "vitest";
import type { Action } from "@ff-engine/engine";
import { mergeLobby, receiveBatch, reconcile } from "./sync";

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

  it("resolves lists that disagree to home's", () => {
    expect(reconcile(list(1, 2), list(1, 3), "home")).toEqual({ batches: list(1, 3), reply: false });
    expect(reconcile(list(1, 2), list(1, 3), "away")).toEqual({ batches: list(1, 2), reply: true });
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
