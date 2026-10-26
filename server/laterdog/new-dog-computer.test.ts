import { rmSync } from "node:fs";
import { beforeEach, describe, expect, it } from "vitest";

import { DATA_DIR } from "../config.ts";
import type { ModelSelection } from "../contracts.ts";
import { Store } from "../store.ts";
import { newDogComputer } from "./new-dog-computer.ts";

const selection = (): ModelSelection => ({ instanceId: "claude", model: "claude-sonnet-5" });
const storeOn = (cloudHome: boolean) => new Store(selection, undefined, undefined, () => newDogComputer(cloudHome));

describe("a new dog's computer", () => {
  beforeEach(() => {
    rmSync(DATA_DIR, { recursive: true, force: true });
  });

  it("is the dog's own cloud computer on a later.dog Cloud home, for the first dog and every dog after", () => {
    const store = storeOn(true);
    store.seedIfEmpty();
    const scout = store.createBot({ name: "Scout" });
    const juniper = store.createBot({ name: "Juniper" });
    expect(store.bots.map((bot) => bot.computer)).toEqual(["cloud", "cloud", "cloud"]);
    expect(storeOn(true).bot(scout.id)?.computer).toBe("cloud");
    expect(storeOn(true).bot(juniper.id)?.computer).toBe("cloud");
  });

  it("keeps a place the person picked", () => {
    const store = storeOn(true);
    const dog = store.createBot({ name: "Pip" });
    store.patchBot(dog.id, { computer: "off" });
    expect(storeOn(true).bot(dog.id)?.computer).toBe("off");
  });

  it("is given to a dog that came over without a computer when the Cloud home opens, so it can sign in and browse like a new dog", () => {
    const mac = storeOn(false);
    const old = mac.createBot({ name: "Biscuit" });
    const off = mac.createBot({ name: "Quiet" });
    mac.patchBot(off.id, { computer: "off" });
    expect(storeOn(false).bot(old.id)).not.toHaveProperty("computer");
    const home = storeOn(true);
    expect(home.bot(old.id)?.computer).toBe("cloud");
    expect(home.bot(off.id)?.computer).toBe("off");
    expect(storeOn(true).bot(old.id)?.computer).toBe("cloud");
  });

  it("is left for the Mac to decide when later.dog runs on a Mac", () => {
    const store = storeOn(false);
    expect(store.createBot({ name: "Scout" })).not.toHaveProperty("computer");
  });
});
