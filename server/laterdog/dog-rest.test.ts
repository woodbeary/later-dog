import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import { DOG_PURGE_AFTER_MS, DogRestStore, findRest, purgeDue, restRefusal, type DogRest } from "./dog-rest.ts";

const dirs: string[] = [];
afterEach(() => { for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }); });
const fresh = () => { const dir = mkdtempSync(join(tmpdir(), "dog-rest-")); dirs.push(dir); return join(dir, "dog-rests.json"); };
const rest = (botId: string, name: string, at: number): DogRest => ({ botId, name, at, by: "caller", hiddenBefore: false, routines: ["r1"], webhooks: ["w1"] });

describe("a dog another dog deletes", () => {
  it("keeps the main dog, the caller and a dog already resting out of reach", () => {
    expect(restRefusal({ target: { id: "main" }, caller: "a", main: "main", resting: false })).toBe("main");
    expect(restRefusal({ target: { id: "a" }, caller: "a", main: "main", resting: false })).toBe("self");
    expect(restRefusal({ target: { id: "b" }, caller: "a", main: "main", resting: true })).toBe("resting");
    expect(restRefusal({ target: null, caller: "a", main: "main", resting: false })).toBe("missing");
    expect(restRefusal({ target: { id: "b" }, caller: "a", main: "main", resting: false })).toBeNull();
  });

  it("remembers what it switched off and survives a restart, then gives it back once on restore", () => {
    const file = fresh();
    const store = new DogRestStore(file);
    store.put(rest("b", "Ledger", 10));
    expect(new DogRestStore(file).get("b")).toEqual(rest("b", "Ledger", 10));
    expect(findRest(store.list(), "ledger")?.botId).toBe("b");
    expect(findRest(store.list(), "b")?.name).toBe("Ledger");
    expect(store.take("b")).toEqual(rest("b", "Ledger", 10));
    expect(store.take("b")).toBeNull();
    expect(new DogRestStore(file).list()).toEqual([]);
  });

  it("is deleted for good only after 30 days", () => {
    const now = 100 * DOG_PURGE_AFTER_MS;
    const rests = [rest("old", "Old", now - DOG_PURGE_AFTER_MS), rest("new", "New", now - DOG_PURGE_AFTER_MS + 1)];
    expect(purgeDue(rests, now).map((entry) => entry.botId)).toEqual(["old"]);
  });
});
