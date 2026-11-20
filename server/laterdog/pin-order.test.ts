import { rmSync } from "node:fs";
import { beforeEach, describe, expect, it } from "vitest";

import { DATA_DIR } from "../config.ts";
import type { ModelSelection } from "../contracts.ts";
import { Store } from "../store.ts";
import { loosePinRanks, nextPinRank, pinnedInOrder, pinRankChange, rankedPins } from "./pin-order.ts";

const selection = (): ModelSelection => ({ instanceId: "claude", model: "claude-sonnet-5" });

function pin(store: Store, id: string, pinned: boolean) {
  store.patchBot(id, { pinned, ...store.pinRankFor(id, pinned) });
}

describe("the order of pinned dogs", () => {
  it("ranks pins by their place, puts pins without one after them in list order, and leaves unpinned dogs out", () => {
    const bots = [{ id: "a", pinned: true }, { id: "b", pinned: true, pinRank: 2 }, { id: "c" }, { id: "d", pinned: true, pinRank: 1 }];
    expect(pinnedInOrder(bots).map((bot) => bot.id)).toEqual(["d", "b", "a"]);
    expect(nextPinRank(bots)).toBe(3);
    expect(nextPinRank([{ id: "a", pinned: true }])).toBe(1);
    expect(loosePinRanks(bots)).toEqual(new Map([["a", 3]]));
  });

  it("gives a newly pinned dog the next place, clears it on unpin, and leaves other changes alone", () => {
    const bots = [{ id: "a", pinned: true, pinRank: 4 }, { id: "b" }];
    expect(pinRankChange(bots[1], true, bots)).toEqual({ pinRank: 5 });
    expect(pinRankChange(bots[0], false, bots)).toEqual({ pinRank: undefined });
    expect(pinRankChange(bots[0], true, bots)).toEqual({});
    expect(pinRankChange(bots[0], undefined, bots)).toEqual({});
    expect(pinRankChange(undefined, true, bots)).toEqual({});
  });

  it("orders exactly the pins it is given, once each, and keeps any it was not told about after them", () => {
    const bots = [{ id: "a", pinned: true, pinRank: 1 }, { id: "b", pinned: true, pinRank: 2 }, { id: "c", pinned: true, pinRank: 3 }, { id: "d" }];
    expect([...rankedPins(bots, ["c", "d", "c", "ghost", "a"])]).toEqual([["c", 1], ["a", 2], ["b", 3]]);
  });
});

describe("pinned dogs kept by the home", () => {
  beforeEach(() => {
    rmSync(DATA_DIR, { recursive: true, force: true });
  });

  it("keeps pins in the order they were pinned, across a restart, and forgets the place of an unpinned dog", () => {
    const store = new Store(selection);
    const [rex, ivy, max] = ["Rex", "Ivy", "Max"].map((name) => store.createBot({ name }));
    pin(store, ivy!.id, true);
    pin(store, rex!.id, true);
    pin(store, max!.id, true);
    expect(pinnedInOrder(new Store(selection).bots).map((bot) => bot.name)).toEqual(["Ivy", "Rex", "Max"]);
    pin(store, rex!.id, false);
    expect(new Store(selection).bot(rex!.id)).not.toHaveProperty("pinRank");
    expect(pinnedInOrder(store.bots).map((bot) => bot.name)).toEqual(["Ivy", "Max"]);
  });

  it("saves a new order for everyone, and gives pins from before ranks their places ahead of a new pin", () => {
    const store = new Store(selection);
    const [rex, ivy, max, zed] = ["Rex", "Ivy", "Max", "Zed"].map((name) => store.createBot({ name }));
    store.patchBot(rex!.id, { pinned: true });
    store.patchBot(ivy!.id, { pinned: true });
    pin(store, max!.id, true);
    expect(pinnedInOrder(store.bots).map((bot) => bot.name).at(-1)).toBe("Max");
    expect(store.orderPins([max!.id, zed!.id, rex!.id]).map((id) => store.bot(id)!.name)).toEqual(["Max", "Rex", "Ivy"]);
    expect(pinnedInOrder(new Store(selection).bots).map((bot) => [bot.name, bot.pinRank])).toEqual([["Max", 1], ["Rex", 2], ["Ivy", 3]]);
  });
});
